/* Posts: reading them, and refusing the ones that are not ready.

   Every check here exists so a mistake fails the BUILD, where it costs a
   minute, rather than shipping, where a wrong date or a duplicate slug is a
   live URL Google may already hold. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, STATIC_PAGES, WORDS_PER_MINUTE, MAIN, SITE } from './site.mjs';

export class ContentError extends Error {}

/* ------------------------------------------------------------ frontmatter */

/* A YAML subset, and only that: `key: value`, `key: [a, b]`, and a block list
   of scalars or of small maps. Anything else is an error rather than a guess,
   because a front matter typo that parses as something else is a silent
   wrong page. */
export function parseFrontmatter(src, file = 'post') {
  const m = String(src).replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new ContentError(`${file}: a post starts with --- front matter ---`);
  const lines = m[1].split('\n');
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const kv = line.match(/^([a-zA-Z][\w]*):(?:\s+(.*))?$/);
    if (!kv) throw new ContentError(`${file}: cannot read front matter line "${line}"`);
    const [, key, rest] = kv;
    if (key in data) throw new ContentError(`${file}: "${key}" is set twice.`);
    if (rest !== undefined && rest.trim() !== '') {
      data[key] = scalarOrList(rest.trim(), file, key);
      i++;
      continue;
    }
    const items = [];
    i++;
    while (i < lines.length && /^\s+-\s/.test(lines[i])) {
      const first = lines[i].replace(/^\s+-\s+/, '');
      const pair = first.match(/^([a-zA-Z]\w*):\s+(.*)$/);
      if (!pair) { items.push(scalar(first.trim(), file, key)); i++; continue; }
      const obj = { [pair[1]]: scalar(pair[2].trim(), file, key) };
      i++;
      while (i < lines.length && /^\s{4,}[a-zA-Z]\w*:\s/.test(lines[i]) && !/^\s+-\s/.test(lines[i])) {
        const p = lines[i].trim().match(/^([a-zA-Z]\w*):\s+(.*)$/);
        if (p[1] in obj) throw new ContentError(`${file}: "${key}.${p[1]}" is set twice in one item.`);
        obj[p[1]] = scalar(p[2].trim(), file, key);
        i++;
      }
      items.push(obj);
    }
    if (!items.length) throw new ContentError(`${file}: "${key}:" has no value and no list under it.`);
    data[key] = items;
  }
  return { data, body: m[2] };
}

function scalarOrList(s, file, key) {
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new ContentError(`${file}: "${key}" opens a [list] it never closes.`);
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x.trim(), file, key)) : [];
  }
  return scalar(s, file, key);
}

function scalar(s, file, key) {
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { throw new ContentError(`${file}: "${key}" has a broken quoted string: ${s}`); }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^["']|:\s|\s#/.test(s)) throw new ContentError(`${file}: quote the value of "${key}" (it contains ": " or " #"): ${s}`);
  return s;
}

/* ------------------------------------------------------------ validation */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/* A post slug sits at the root beside every other page, so it may not take a
   name the site already uses for something else. */
export const RESERVED_SLUGS = new Set([
  ...Object.keys(STATIC_PAGES), ...Object.keys(CATEGORIES),
  'page', 'feed', 'feed.xml', 'sitemap', 'sitemap.xml', 'robots', 'og', 'assets', 'index', '404', 'tags', 'authors', 'api', 'search.json',
]);

export function validDate(s) {
  if (!DATE.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const DASH = /[\u2014\u2013]/;

/**
 * Check one post's metadata. Returns the normalised record; throws a
 * ContentError naming the file and the field otherwise.
 */
export function validatePost(data, file) {
  const fail = (msg) => { throw new ContentError(`${file}: ${msg}`); };
  for (const [k, v] of Object.entries(data)) {
    if (DASH.test(JSON.stringify(v))) fail(`an em or en dash in "${k}". Use a colon, a comma or a hyphen.`);
  }
  const known = new Set(['title', 'seoTitle', 'slug', 'description', 'dek', 'category', 'tags', 'published', 'updated',
    'draft', 'noindex', 'featured', 'figure', 'figureLabel', 'lead', 'sources', 'related', 'further', 'toc',
    'image', 'imageAlt', 'imageWidth', 'imageHeight', 'origin', 'originId']);
  for (const k of Object.keys(data)) if (!known.has(k)) fail(`unknown field "${k}".`);

  if (!isText(data.title) || data.title.length > 110) fail('a title of 1 to 110 characters is required.');
  if (data.seoTitle !== undefined && (!isText(data.seoTitle) || data.seoTitle.length > 62)) fail('seoTitle is at most 62 characters.');
  if (!SLUG.test(data.slug ?? '') || data.slug.length > 80) fail('slug must be lowercase words joined by hyphens, at most 80 characters.');
  if (RESERVED_SLUGS.has(data.slug)) fail(`slug "${data.slug}" is a reserved path.`);
  if (!isText(data.description) || data.description.length < 70 || data.description.length > 165) {
    fail(`description must be 70 to 165 characters (it is the search snippet); it is ${String(data.description ?? '').length}.`);
  }
  if (!isText(data.dek) || data.dek.length < 40 || data.dek.length > 280) fail('dek (the standfirst under the title) must be 40 to 280 characters.');
  if (!CATEGORIES[data.category]) fail(`category must be one of ${Object.keys(CATEGORIES).join(', ')}.`);
  if (!validDate(data.published)) fail(`published must be a real YYYY-MM-DD date, not "${data.published}".`);
  if (data.updated !== undefined) {
    if (!validDate(data.updated)) fail(`updated must be a real YYYY-MM-DD date, not "${data.updated}".`);
    if (data.updated < data.published) fail('updated cannot be before published.');
  }
  const tags = data.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((t) => /^[a-z0-9]+(?: [a-z0-9]+)*$/.test(t))) fail('tags are lowercase words, in a [list].');
  if ((data.figure === undefined) !== (data.figureLabel === undefined)) fail('figure and figureLabel go together.');
  for (const k of ['draft', 'noindex', 'featured', 'toc']) {
    if (data[k] !== undefined && typeof data[k] !== 'boolean') fail(`${k} must be true or false.`);
  }

  /* A lead image is a file this site serves (img-src is 'self'), with words
     saying what it shows. Imported posts carry one; hand-written posts may. */
  if (data.image !== undefined) {
    if (!/^\/media\/[a-z0-9][a-z0-9/_.-]*\.(?:png|jpe?g|webp|gif|avif)$/.test(String(data.image)) || String(data.image).includes('..')) {
      fail('image must be a /media/... path to a png, jpg, webp, gif or avif file.');
    }
    if (!isText(data.imageAlt)) fail('an image needs imageAlt: words saying what it shows.');
  } else if (data.imageAlt !== undefined) fail('imageAlt without an image.');
  for (const k of ['imageWidth', 'imageHeight']) {
    if (data[k] !== undefined && !/^[1-9]\d{0,4}$/.test(String(data[k]))) fail(`${k} must be a whole number of pixels.`);
  }
  if (data.origin !== undefined && data.origin !== 'distribb') fail('origin, when set, is "distribb".');
  if (data.originId !== undefined && !/^[\w.:-]{1,80}$/.test(String(data.originId))) fail('originId is a short id.');

  const sources = data.sources ?? [];
  if (!Array.isArray(sources)) fail('sources must be a list.');
  const ids = new Set();
  for (const s of sources) {
    if (typeof s !== 'object' || !/^[a-z0-9-]+$/.test(s.id ?? '')) fail('every source needs an id of lowercase letters, digits and hyphens.');
    if (ids.has(s.id)) fail(`source id "${s.id}" is used twice.`);
    ids.add(s.id);
    if (!isText(s.title) || !isText(s.publisher)) fail(`source "${s.id}" needs a title and a publisher.`);
    if (!/^https:\/\/\S+$/.test(s.url ?? '')) fail(`source "${s.id}" needs an https url.`);
    if (s.date !== undefined && !validDate(s.date)) fail(`source "${s.id}" has a bad date.`);
  }
  const further = data.further ?? [];
  for (const f of further) {
    if (!isText(f.label) || !(f.url?.startsWith(`${MAIN}/`) || f.url === MAIN || f.url?.startsWith(`${SITE}/`))) {
      fail('a "further" link needs a label and an interndoor.com url.');
    }
  }
  return {
    ...data,
    tags,
    sources,
    related: data.related ?? [],
    further,
    draft: data.draft === true,
    noindex: data.noindex === true,
    featured: data.featured === true,
    toc: data.toc !== false,
  };
}

export function readingMinutes(words) {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * Every post in a directory, validated and sorted newest first. Drafts and
 * posts dated after `today` are left out (and reported), never published.
 */
export function loadPosts(dir, { today, includeDrafts = false } = {}) {
  const posts = [];
  const skipped = [];
  const slugs = new Map();
  /* .md is hand-written Markdown; .html is an imported article (front matter
     plus a body lib/htmlpost.mjs cleans on every build). */
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') || x.endsWith('.html')).sort()) {
    const { data, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'), f);
    const post = validatePost(data, f);
    if (slugs.has(post.slug)) throw new ContentError(`${f}: slug "${post.slug}" is already used by ${slugs.get(post.slug)}.`);
    slugs.set(post.slug, f);
    if (!includeDrafts && (post.draft || (today && post.published > today))) { skipped.push({ file: f, why: post.draft ? 'draft' : 'scheduled' }); continue; }
    posts.push({ ...post, file: f, body, format: f.endsWith('.html') ? 'html' : 'md' });
  }
  posts.sort((a, b) => (b.published.localeCompare(a.published)) || a.title.localeCompare(b.title));
  /* Against the PUBLISHED set: a related link to a draft would be a link to a
     page this build does not write. */
  const live = new Set(posts.map((p) => p.slug));
  for (const p of posts) {
    for (const r of p.related) if (!live.has(r)) throw new ContentError(`${p.file}: related "${r}" is not a published post.`);
  }
  return { posts, skipped };
}
