/* Distribb article -> blog post. Pure: no network, no disk, no git.
 * bin/distribb-import.js does the I/O around it.
 *
 * Distribb's webhook body has not been seen yet when this was written (its
 * form shows the shape only inside the logged-in setup wizard), so every field
 * is read from the names its own API uses (title, slug, content,
 * meta_description, feature_image, keyword, id) with the usual alternatives,
 * and the article may sit at the top level or inside an envelope. The first
 * real delivery (the form's "Send Test Payload") is the check:
 * `node bin/distribb-import.js --show` prints its field names.
 */
import { createHash } from 'node:crypto';
import { cleanArticleHtml, plainText, slugify, undash } from '../blog/lib/htmlpost.mjs';

const firstString = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The article object inside whatever envelope it came in. */
export function unwrap(body) {
  for (const a of [body?.article, body?.data?.article, body?.data, body?.post, body]) {
    if (a && typeof a === 'object' && (typeof a.title === 'string' || typeof a.content === 'string' || typeof a.html === 'string')) return a;
  }
  return null;
}

/** A test delivery from the connect form. It must never become a post. */
export function isTestPayload(body) {
  const a = unwrap(body) ?? {};
  for (const v of [body?.test, body?.is_test, body?.isTest, a.test, a.is_test, a.isTest]) {
    if (v === true || v === 'true' || v === 1) return true;
  }
  const ev = String(body?.event ?? body?.type ?? body?.action ?? '').toLowerCase();
  if (/\btest\b/.test(ev)) return true;
  return /^\s*(?:distribb\s+)?test\b/i.test(String(a.title ?? ''));
}

export function eventOf(body) {
  const ev = String(body?.event ?? body?.type ?? body?.action ?? '').toLowerCase();
  if (/delete|unpublish|remove|trash/.test(ev)) return 'remove';
  if (/update|edit|sync|optimi[sz]/.test(ev)) return 'update';
  return 'publish';
}

function imageField(a) {
  const v = a.feature_image ?? a.featured_image ?? a.featureImage ?? a.featuredImage ?? a.image ?? a.image_url ?? a.cover_image ?? a.thumbnail;
  if (typeof v === 'string') return { url: v.trim(), alt: null };
  if (v && typeof v === 'object') return { url: firstString(v.url, v.src), alt: firstString(v.alt, v.alt_text, v.altText, v.description) };
  return { url: null, alt: null };
}

export function mapArticle(body) {
  const a = unwrap(body);
  if (!a) return null;
  const title = firstString(a.title, a.name);
  const slugIn = firstString(a.slug, a.handle);
  const img = imageField(a);
  return {
    id: firstString(String(a.id ?? ''), String(a.article_id ?? ''), String(a.articleId ?? ''), String(body?.id ?? '')),
    event: eventOf(body),
    test: isTestPayload(body),
    title,
    slug: slugIn && SLUG.test(slugIn) && slugIn.length <= 80 ? slugIn : slugify(slugIn || title),
    html: firstString(a.content, a.html, a.content_html, a.body_html, a.body),
    meta: firstString(a.meta_description, a.metaDescription, a.seo_description, a.description, a.excerpt),
    seoTitle: firstString(a.seo_title, a.meta_title, a.seoTitle, a.metaTitle),
    keyword: firstString(a.keyword, a.focus_keyword, a.primary_keyword),
    image: img.url,
    imageAlt: firstString(img.alt, a.feature_image_alt, a.featured_image_alt, a.image_alt, a.imageAlt),
    publishedAt: firstString(a.published_at, a.publishedAt, a.publish_date, a.scheduled_date, a.date),
  };
}

const squash = (s) => undash(String(s ?? '')).replace(/\s+/g, ' ').trim();

/** Cut at a word boundary to at most `max` characters, ending on a full stop where one is near. */
export function clip(s, max) {
  const t = squash(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const stop = cut.lastIndexOf('. ');
  if (stop >= max * 0.6) return cut.slice(0, stop + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,:;\s]+$/, '')}.`;
}

/** Text from the body's opening paragraphs, for when the meta description does not fit. */
function openingText(html) {
  return [...String(html ?? '').matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plainText(m[1])).filter(Boolean).join(' ');
}

/** The search snippet: 70 to 165 characters (blog/lib/content.mjs refuses anything else). */
export function descriptionFrom(meta, html) {
  const m = squash(meta);
  if (m.length >= 70 && m.length <= 165) return m;
  if (m.length > 165) return clip(m, 160);
  const t = clip(openingText(html), 160);
  return t.length >= 70 ? t : null;
}

/** The standfirst under the title: 40 to 280 characters. */
export function dekFrom(meta, html) {
  const m = squash(meta);
  if (m.length >= 40 && m.length <= 280) return m;
  const t = clip(openingText(html), 270);
  return t.length >= 40 ? t : null;
}

/** One lowercase tag from the keyword, in the shape content.mjs accepts. */
export function tagsFrom(keyword) {
  const k = String(keyword ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  return k ? [k] : [];
}

/** The IST calendar day of an instant (or of now), as YYYY-MM-DD. */
export function istDay(when = Date.now()) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  return Number.isFinite(t) ? new Date(t + 5.5 * 3600000).toISOString().slice(0, 10) : null;
}

/** A leading heading that only repeats the title goes: the page already has it as its <h1>. */
export function dropLeadingTitle(html, title) {
  const norm = (s) => plainText(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const m = String(html ?? '').match(/^\s*<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  return m && norm(m[2]) === norm(title) ? String(html).slice(m[0].length) : String(html ?? '');
}

/** Width, height and file type from an image's own header. Null for anything else. */
export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { ext: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ext: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** Content-addressed, so a re-delivered article reuses its files. */
export function mediaName(buf, ext) {
  return `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
}

const q = (s) => JSON.stringify(String(s));

/** The post file: front matter in content.mjs's YAML subset, then the cleaned body. */
export function postFile(p) {
  const lines = [
    '---',
    `title: ${q(p.title)}`,
    ...(p.seoTitle ? [`seoTitle: ${q(p.seoTitle)}`] : []),
    `slug: ${p.slug}`,
    `description: ${q(p.description)}`,
    `dek: ${q(p.dek)}`,
    'category: guides',
    `tags: [${p.tags.join(', ')}]`,
    `published: ${p.published}`,
    ...(p.updated && p.updated > p.published ? [`updated: ${p.updated}`] : []),
    ...(p.image ? [`image: ${p.image}`, `imageAlt: ${q(p.imageAlt)}`] : []),
    ...(p.image && p.imageWidth && p.imageHeight ? [`imageWidth: ${p.imageWidth}`, `imageHeight: ${p.imageHeight}`] : []),
    ...(p.draft ? ['draft: true'] : []),
    'origin: distribb',
    ...(p.originId ? [`originId: ${q(p.originId)}`] : []),
    '---',
    '',
  ];
  return `${lines.join('\n')}${p.html.trim()}\n`;
}

/**
 * Everything the post needs except the downloads. `images` maps an original
 * image URL to { src, width, height } (null drops it); `deadLinks` are
 * interndoor.com links that did not answer 200 and are unwrapped.
 * Returns { post } or { error } naming what is wrong.
 */
export function buildPost(a, { images = () => null, deadLinks = new Set(), hero = null, today, existing = null } = {}) {
  if (!a?.title) return { error: 'no title' };
  if (!a.html || a.html.length < 500) return { error: 'no article body (under 500 characters)' };
  const title = squash(a.title);
  if (title.length > 110) return { error: `the title is ${title.length} characters; the blog allows 110` };
  if (!a.slug || !SLUG.test(a.slug) || a.slug.length > 80) return { error: `no usable slug (from "${a.slug ?? ''}")` };

  const body = cleanArticleHtml(dropLeadingTitle(a.html, a.title), {
    images, deadLinks, reservedIds: ['main', 'sources', 'further-h', 'related-h', 'toc-h', 'sub-post-h', 'sub-post-email', 'sub-post-msg', 'sub-post-fine'],
  });
  if (body.words < 300) return { error: `only ${body.words} words survived cleaning` };
  const description = descriptionFrom(a.meta, body.html);
  if (!description) return { error: 'no meta description of 70 to 165 characters, and the opening is too short to make one' };
  const dek = dekFrom(a.meta, body.html);
  if (!dek) return { error: 'no standfirst of 40 to 280 characters' };

  const payloadDay = a.publishedAt ? istDay(a.publishedAt) : null;
  const published = existing?.published ?? (payloadDay && payloadDay <= today ? payloadDay : today);
  const seoTitle = a.seoTitle ? squash(a.seoTitle) : null;
  return {
    post: {
      title,
      seoTitle: seoTitle && seoTitle.length <= 62 && seoTitle !== title ? seoTitle : null,
      slug: a.slug,
      description,
      dek,
      tags: tagsFrom(a.keyword),
      published,
      updated: existing ? today : null,
      image: hero?.src ?? null,
      imageAlt: hero ? squash(a.imageAlt || title) : null,
      imageWidth: hero?.width ?? null,
      imageHeight: hero?.height ?? null,
      draft: a.event === 'remove',
      originId: a.id || null,
      html: body.html,
      words: body.words,
      links: body.links,
    },
  };
}
