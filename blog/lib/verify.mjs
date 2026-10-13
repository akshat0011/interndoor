/* Read the built site back and check it the way a crawler and a reader would.
   The build runs this and refuses to finish on any error; the tests run it on
   fixtures with each rule broken on purpose.

   It reads the OUTPUT, not the templates, because the bugs that cost this
   project the most were the ones every source looked right for: a page
   written and never linked, a canonical pointing at a redirect, a sitemap
   listing a noindex URL. */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SITE } from './site.mjs';
import { THEME_SCRIPT } from './templates.mjs';

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** The URL a file is served at under cleanUrls + trailingSlash:false. */
export function urlPathOf(outDir, file) {
  const rel = relative(outDir, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'/index.html'.length)}`;
  if (rel.endsWith('.html')) return `/${rel.slice(0, -5)}`;
  return `/${rel}`;
}

/** The file a URL path is served from, or null. */
export function fileFor(outDir, path) {
  const clean = decodeURIComponent(path.split('#')[0].split('?')[0]);
  if (clean === '/') return join(outDir, 'index.html');
  const base = join(outDir, clean.slice(1));
  for (const f of [base, `${base}.html`, join(base, 'index.html')]) {
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const metaContent = (html, key, val) => {
  const m = html.match(new RegExp(`<meta ${key}="${val}" content="([^"]*)"`));
  return m ? m[1] : null;
};
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function verifySite(outDir) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const files = walk(outDir);
  const pages = new Map();
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const path = urlPathOf(outDir, f);
    pages.set(path, { file: f, html: readFileSync(f, 'utf8') });
  }

  const indexable = new Set();
  for (const [path, { html }] of pages) {
    const isErrorPage = path === '/404';
    const h1 = (html.match(/<h1[\s>]/g) ?? []).length;
    if (h1 !== 1) err(path, `${h1} <h1> elements, want exactly 1`);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    if (!title?.trim()) err(path, 'no <title>');
    if ((html.match(/<title>/g) ?? []).length > 1) err(path, 'more than one <title>');
    if (!metaContent(html, 'name', 'description')) err(path, 'no meta description');
    const robots = metaContent(html, 'name', 'robots');
    if (!robots) err(path, 'no robots meta');
    const canon = html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];
    if (isErrorPage) {
      if (canon) err(path, 'the 404 page must not claim a canonical URL');
      if (!/noindex/.test(robots ?? '')) err(path, 'the 404 page must be noindex');
    } else {
      const want = `${SITE}${path === '/' ? '/' : path}`;
      if (canon !== want) err(path, `canonical is ${canon}, want ${want}`);
      const og = metaContent(html, 'property', 'og:url');
      if (og !== canon) err(path, `og:url ${og} does not match the canonical`);
      if (/^index/.test(robots ?? '')) indexable.add(path);
    }
    if (/\sstyle="/.test(html) || /<style[\s>]/.test(html)) err(path, 'an inline style (the CSP refuses it)');
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      const [, attrs, body] = m;
      if (/\bsrc="/.test(attrs)) continue;
      if (/type="application\/ld\+json"/.test(attrs)) {
        try { JSON.parse(body); } catch (e) { err(path, `JSON-LD does not parse: ${e.message}`); }
        continue;
      }
      if (body !== THEME_SCRIPT) err(path, 'an inline script that is not the theme script (the CSP hash would not match)');
    }
    if (/[\u2014\u2013]/.test(html)) err(path, 'an em or en dash in the page');

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length) err(path, `duplicate ids: ${ids.filter((x, k) => ids.indexOf(x) !== k).join(', ')}`);

    for (const m of html.matchAll(/<a\b[^>]*>/g)) {
      const href = attr(m[0], 'href');
      if (href == null) { err(path, `an <a> without href: ${m[0]}`); continue; }
      const h = unesc(href);
      if (h.startsWith('#')) {
        if (!idSet.has(h.slice(1))) err(path, `link to #${h.slice(1)}, which is not on the page`);
      } else if (h.startsWith('/') && !h.startsWith('//')) {
        const target = fileFor(outDir, h);
        if (!target) { err(path, `broken internal link ${h}`); continue; }
        const frag = h.split('#')[1];
        if (frag && target.endsWith('.html') && !readFileSync(target, 'utf8').includes(`id="${frag}"`)) err(path, `link to ${h}: no such fragment`);
      } else if (!/^(https:\/\/|mailto:)/.test(h)) {
        err(path, `link ${h} is neither internal nor https`);
      }
    }
    for (const m of html.matchAll(/<img\b[^>]*>/g)) {
      if (attr(m[0], 'alt') == null) err(path, 'an <img> with no alt');
    }
  }

  /* The sitemap lists exactly the indexable pages, and nothing else. */
  const smFile = join(outDir, 'sitemap.xml');
  if (!existsSync(smFile)) err('sitemap.xml', 'missing');
  else {
    const locs = [...readFileSync(smFile, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => unesc(x[1]));
    const listed = new Set();
    for (const loc of locs) {
      if (!loc.startsWith(SITE)) { err('sitemap.xml', `${loc} is not on ${SITE}`); continue; }
      const path = loc.slice(SITE.length) || '/';
      listed.add(path);
      if (!pages.has(path)) err('sitemap.xml', `${loc} has no page`);
      else if (!indexable.has(path)) err('sitemap.xml', `${loc} is not an indexable page`);
    }
    for (const p of indexable) if (!listed.has(p)) err('sitemap.xml', `indexable page ${p} is missing from the sitemap`);
  }

  const feedFile = join(outDir, 'feed.xml');
  if (existsSync(feedFile)) {
    for (const m of readFileSync(feedFile, 'utf8').matchAll(/<link>([^<]+)<\/link>/g)) {
      const path = m[1].slice(SITE.length) || '/';
      if (!m[1].startsWith(SITE) || !pages.has(path)) err('feed.xml', `item link ${m[1]} has no page`);
    }
  } else err('feed.xml', 'missing');

  if (!existsSync(join(outDir, 'robots.txt'))) err('robots.txt', 'missing');
  return { pages: pages.size, indexable: indexable.size, errors };
}
