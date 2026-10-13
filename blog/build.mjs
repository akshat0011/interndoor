#!/usr/bin/env node
/* Builds blog.interndoor.com into blog/public.

     node blog/build.mjs                 build, draw changed share images, verify
     node blog/build.mjs --check-links   also ask interndoor.com for every page a post links to
     node blog/build.mjs --drafts        include drafts and scheduled posts (never commit that output)

   The output is committed and served as static files by the blog's own Vercel
   project (root directory `blog`). The build reads no database and no network
   (bar the optional link check): every figure a post shows is in
   content/data, written there by scripts/export-data.mjs. */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMarkdown, MarkdownError } from './lib/markdown.mjs';
import { parseFrontmatter, loadPosts, readingMinutes, validDate, ContentError } from './lib/content.mjs';
import { loadDatasets, renderChart } from './lib/charts.mjs';
import {
  articlePage, homePage, categoryPage, searchPage, prosePage, notFoundPage, postPath, catPath,
} from './lib/templates.mjs';
import { sitemapXml, feedXml, robotsTxt, vercelJson } from './lib/seo.mjs';
import { renderOgImages, ogHash } from './lib/og.mjs';
import { verifySite } from './lib/verify.mjs';
import { CATEGORIES, PER_PAGE, SITE, MAIN, STATIC_PAGES } from './lib/site.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  contentDir: join(ROOT, 'content'),
  srcDir: join(ROOT, 'src'),
  staticDir: join(ROOT, 'static'),
  outDir: join(ROOT, 'public'),
  vercelFile: join(ROOT, 'vercel.json'),
  ogManifest: join(ROOT, 'og-manifest.json'),
  fontsDir: join(ROOT, '..', 'web', 'api', 'assets'),
};

const hash10 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** Today in India, as YYYY-MM-DD. Decides only which scheduled posts are due. */
export function indiaToday(now = Date.now()) {
  return new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
}

function write(outDir, rel, body) {
  const file = join(outDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return rel;
}

/** Score other posts for "read next": shared tags count double, the same category once, newer first. */
export function relatedFor(post, posts, n = 3) {
  const chosen = post.related.map((s) => posts.find((p) => p.slug === s)).filter(Boolean);
  const rest = posts
    .filter((p) => p !== post && !chosen.includes(p))
    .map((p) => ({ p, score: 2 * p.tags.filter((tg) => post.tags.includes(tg)).length + (p.category === post.category ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || b.p.published.localeCompare(a.p.published) || a.p.title.localeCompare(b.p.title))
    .map((x) => x.p);
  return [...chosen, ...rest].slice(0, n);
}

function readPage(contentDir, name) {
  const { data, body } = parseFrontmatter(readFileSync(join(contentDir, 'pages', `${name}.md`), 'utf8'), `pages/${name}.md`);
  for (const k of ['title', 'description', 'lede', 'updated']) {
    if (!data[k]) throw new ContentError(`pages/${name}.md: "${k}" is required.`);
  }
  if (!validDate(data.updated)) throw new ContentError(`pages/${name}.md: updated must be YYYY-MM-DD.`);
  return { data, body };
}

export async function build(opts = {}) {
  const o = { ...DEFAULTS, today: indiaToday(), og: true, drafts: false, log: () => {}, ...opts };
  const datasets = loadDatasets(join(o.contentDir, 'data'));
  const { posts, skipped } = loadPosts(join(o.contentDir, 'posts'), { today: o.today, includeDrafts: o.drafts });
  for (const s of skipped) o.log(`skipped ${s.file} (${s.why})`);
  if (!posts.length) throw new ContentError('No published posts: the blog would be empty.');

  /* Render every body first: the citations, outline and word counts feed the
     pages around them. */
  const mainLinks = new Set();
  const rendered = new Map();
  for (const p of posts) {
    const sourceIds = new Set(p.sources.map((s) => s.id));
    const citations = [];
    const seen = new Map();
    const ctx = {
      chart: (ref) => renderChart(datasets, ref),
      cite: (id) => {
        if (!sourceIds.has(id)) throw new MarkdownError(`${p.file}: [^${id}] cites a source that is not in its front matter.`);
        if (!citations.includes(id)) citations.push(id);
        const k = (seen.get(id) ?? 0) + 1;
        seen.set(id, k);
        const n = citations.indexOf(id) + 1;
        return `<sup class="cite"><a href="#src-${id}" id="cite-${id}-${k}" aria-label="Source ${n}">${n}</a></sup>`;
      },
      checkLink: (href) => { if (href.startsWith(MAIN)) mainLinks.add(href.split('#')[0]); },
      reservedIds: ['main', 'sources', 'further-h', 'related-h', 'toc-h', 'sub-post-h', 'sub-post-email', 'sub-post-msg', 'sub-post-fine'],
    };
    let r;
    try { r = renderMarkdown(p.body, ctx); } catch (e) { throw new MarkdownError(`${p.file}: ${e.message}`); }
    for (const s of p.sources) if (s.url.startsWith(MAIN)) mainLinks.add(s.url);
    for (const f of p.further) if (f.url.startsWith(MAIN)) mainLinks.add(f.url);
    rendered.set(p.slug, { ...r, citations, minutes: readingMinutes(r.words) });
  }
  const minutesOf = (p) => rendered.get(p.slug).minutes;

  /* Assets, versioned by content so a reader's cache can keep them a year. */
  const css = readFileSync(join(o.srcDir, 'blog.css'), 'utf8');
  const js = readFileSync(join(o.srcDir, 'blog.js'), 'utf8');
  const assets = { css: hash10(css), js: hash10(js) };

  /* Start from an empty directory every time, so a deleted post leaves no page
     behind. Share images survive: they are expensive to draw. */
  mkdirSync(o.outDir, { recursive: true });
  for (const f of readdirSync(o.outDir)) if (f !== 'og') rmSync(join(o.outDir, f), { recursive: true, force: true });
  if (existsSync(o.staticDir)) cpSync(o.staticDir, o.outDir, { recursive: true });
  write(o.outDir, 'blog.css', css);
  write(o.outDir, 'blog.js', js);

  /* Share cards. Without them (tests, or no browser) every page uses the
     blog's default card, which is honest but generic. */
  const cards = [
    { slug: 'default', kicker: 'InternDoor Blog', title: 'What the postings say about engineering internships in India', figure: null, figureLabel: null },
    ...posts.map((p) => ({ slug: p.slug, kicker: CATEGORIES[p.category].singular, title: p.title, figure: p.figure ?? null, figureLabel: p.figureLabel ?? null })),
  ];
  let ogMap = null;
  if (o.og) ogMap = await renderOgImages(cards, join(o.outDir, 'og'), o.fontsDir, { manifestFile: o.ogManifest, log: o.log });
  const ogFor = (slug) => (ogMap?.[slug] ? `${SITE}/og/${slug}.png?v=${ogMap[slug]}` : null);
  const defaultImage = ogFor('default') ?? `${MAIN}/og.jpg?v=6`;
  const imageFor = (p) => ogFor(p.slug) ?? defaultImage;
  if (!o.og) rmSync(join(o.outDir, 'og'), { recursive: true, force: true });

  const cats = Object.values(CATEGORIES).filter((c) => posts.some((p) => p.category === c.slug));
  const written = [];
  const sitemap = [];
  const newest = (list) => list.map((p) => p.updated ?? p.published).sort().at(-1);

  /* Posts. Ordered newest first, so the "older" neighbour is the next one. */
  posts.forEach((p, k) => {
    const r = rendered.get(p.slug);
    const related = relatedFor(p, posts).map((rp) => ({ post: rp, minutes: minutesOf(rp) }));
    written.push(write(o.outDir, `${p.slug}.html`, articlePage(p, {
      ...r, related, prev: posts[k + 1] ?? null, next: posts[k - 1] ?? null, image: imageFor(p), cats, assets,
    })));
    if (!p.noindex) sitemap.push({ path: postPath(p), lastmod: p.updated ?? p.published });
  });

  /* Home. The lead is the featured post, else the newest report. */
  const lead = posts.find((p) => p.featured) ?? posts.find((p) => p.category === 'reports') ?? posts[0];
  const leadChart = lead.lead ? renderChart(datasets, lead.lead, { variant: 'mini', limit: 6 }) : null;
  const monthsFile = join(o.contentDir, 'months.json');
  const months = existsSync(monthsFile) ? JSON.parse(readFileSync(monthsFile, 'utf8')) : [];
  written.push(write(o.outDir, 'index.html', homePage({ posts, minutesOf, lead, leadChart, months, cats, assets, image: defaultImage })));
  sitemap.unshift({ path: '/', lastmod: newest(posts) });

  /* Categories, paginated. Page 1 is /reports; later pages /reports/page/N. */
  for (const cat of cats) {
    const list = posts.filter((p) => p.category === cat.slug);
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    for (let n = 1; n <= pages; n++) {
      const slice = list.slice((n - 1) * PER_PAGE, n * PER_PAGE);
      const rel = n === 1 ? `${cat.slug}/index.html` : `${cat.slug}/page/${n}.html`;
      written.push(write(o.outDir, rel, categoryPage({ cat, posts: slice, minutesOf, page: n, pages, cats, assets, image: defaultImage })));
      sitemap.push({ path: catPath(cat.slug, n), lastmod: newest(slice) });
    }
  }

  /* The plain pages, from content/pages. */
  for (const [name, def] of Object.entries(STATIC_PAGES)) {
    if (name === 'search') continue;
    const { data, body } = readPage(o.contentDir, name);
    const r = renderMarkdown(body, { chart: (ref) => renderChart(datasets, ref), checkLink: (h) => { if (h.startsWith(MAIN)) mainLinks.add(h); } });
    written.push(write(o.outDir, `${name}.html`, prosePage({
      path: def.path, title: data.title, seoTitle: data.seoTitle, description: data.description, lede: data.lede, html: r.html,
      current: name === 'about' ? 'about' : '', cats, assets, image: defaultImage, ldType: name === 'about' ? 'AboutPage' : 'WebPage',
    })));
    if (def.index) sitemap.push({ path: def.path, lastmod: data.updated });
  }

  const headingsOf = (p) => rendered.get(p.slug).headings.map((h) => h.text);
  written.push(write(o.outDir, 'search.html', searchPage({ posts, minutesOf, headingsOf, cats, assets, image: defaultImage })));
  written.push(write(o.outDir, '404.html', notFoundPage({ posts, minutesOf, cats, assets, image: defaultImage })));

  write(o.outDir, 'sitemap.xml', sitemapXml(sitemap));
  write(o.outDir, 'feed.xml', feedXml(posts, CATEGORIES));
  write(o.outDir, 'robots.txt', robotsTxt());
  if (o.vercelFile) writeFileSync(o.vercelFile, vercelJson());

  const check = verifySite(o.outDir);
  return { posts, skipped, written, sitemap, mainLinks: [...mainLinks].sort(), check, assets };
}

/** Ask the main site for every page a post links to; a link into a 404 is a broken promise. */
export async function checkMainLinks(urls, fetchImpl = fetch) {
  const bad = [];
  for (const u of urls) {
    let status = 0;
    for (let attempt = 0; attempt < 3 && status !== 200; attempt++) {
      try { status = (await fetchImpl(u, { redirect: 'manual' })).status; } catch { status = -1; }
    }
    if (status !== 200) bad.push(`${u} answered ${status}`);
  }
  return bad;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Set(process.argv.slice(2));
  try {
    const res = await build({ drafts: args.has('--drafts'), log: (m) => console.log(`  ${m}`) });
    console.log(`Built ${res.written.length} pages from ${res.posts.length} posts; ${res.sitemap.length} in the sitemap; ${res.check.indexable} indexable.`);
    if (res.check.errors.length) {
      console.error(`\n${res.check.errors.length} problem(s) in the output:\n  ${res.check.errors.join('\n  ')}`);
      process.exitCode = 1;
    }
    if (args.has('--check-links')) {
      const bad = await checkMainLinks(res.mainLinks);
      console.log(`Checked ${res.mainLinks.length} links into interndoor.com: ${bad.length ? `${bad.length} bad` : 'all 200'}.`);
      for (const b of bad) console.error(`  ${b}`);
      if (bad.length) process.exitCode = 1;
    }
    if (args.has('--drafts')) console.warn('\nBuilt WITH drafts. Do not commit this output.');
  } catch (e) {
    if (e instanceof ContentError || e instanceof MarkdownError || e.name === 'ChartError') {
      console.error(`Build refused: ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  }
}
