/* The files a crawler reads before any page: the sitemap, the feed, robots,
   and the hosting config whose CSP every page runs under. */

import { createHash } from 'node:crypto';
import { esc } from './markdown.mjs';
import { SITE, NAME, DESCRIPTION } from './site.mjs';
import { THEME_SCRIPT } from './templates.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 822 for RSS, at the start of the day in India (the posts carry a date, not a time). */
export function rfc822(iso) {
  const d = new Date(`${iso}T00:00:00+05:30`);
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${DAYS[ist.getUTCDay()]}, ${pad(ist.getUTCDate())} ${MON[ist.getUTCMonth()]} ${ist.getUTCFullYear()} 00:00:00 +0530`;
}

/**
 * Only canonical, indexable, written pages. Each entry is { path, lastmod };
 * the caller passes exactly the set it wrote and marked indexable, so a
 * noindex page cannot slip in here by being forgotten somewhere else.
 */
export function sitemapXml(entries) {
  const seen = new Set();
  const urls = entries.map((e) => {
    if (seen.has(e.path)) throw new Error(`sitemap: ${e.path} listed twice`);
    seen.add(e.path);
    const loc = `${SITE}${e.path === '/' ? '/' : e.path}`;
    return `<url><loc>${esc(loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function feedXml(posts, categories) {
  const items = posts.slice(0, 30).map((p) => `<item>
<title>${esc(p.title)}</title>
<link>${SITE}/${p.slug}</link>
<guid isPermaLink="true">${SITE}/${p.slug}</guid>
<pubDate>${rfc822(p.published)}</pubDate>
<category>${esc(categories[p.category].name)}</category>
<description>${esc(p.dek)}</description>
</item>`);
  const newest = posts[0]?.updated ?? posts[0]?.published;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(NAME)}</title>
<link>${SITE}/</link>
<atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
<description>${esc(DESCRIPTION)}</description>
<language>en-in</language>
${newest ? `<lastBuildDate>${rfc822(newest)}</lastBuildDate>\n` : ''}${items.join('\n')}
</channel>
</rss>
`;
}

export function robotsTxt() {
  return `User-agent: *
Allow: /
Disallow: /_vercel/

Sitemap: ${SITE}/sitemap.xml
`;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('base64');

/* The CSP is BUILT, not hand-kept, because its one hash must match the one
   inline script byte for byte, and a hash typed by hand is a hash that drifts
   (the main site's §5 has the history). JSON-LD blocks are data, not script,
   and need no hash. */
export function csp() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://interndoor.com",
    "img-src 'self' data:",
    "font-src https://fonts.gstatic.com",
    "style-src 'self' https://fonts.googleapis.com",
    `script-src 'self' 'sha256-${sha256(THEME_SCRIPT)}'`,
    "connect-src 'self' https://interndoor.com",
  ].join('; ');
}

/* Vercel's config for the blog project (root directory `blog`). It takes NO
   comment keys: the schema is additionalProperties false and one stray key
   fails every deploy while git accepts the commit (main site §5). */
export function vercelJson() {
  const immutable = 'public, max-age=31536000, immutable';
  return `${JSON.stringify({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    outputDirectory: 'public',
    /* Skip the build only when nothing under blog/ changed since the LAST
       DEPLOYED commit. Comparing HEAD with HEAD^ alone skipped an imported post
       whenever a scheduler publish landed on top of it in the same push. The
       previous sha can be missing from Vercel's shallow clone; then fall back. */
    ignoreCommand: 'if git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null; then git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .; else git diff --quiet HEAD^ HEAD -- .; fi',
    cleanUrls: true,
    trailingSlash: false,
    headers: [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Content-Security-Policy', value: csp() },
        ],
      },
      { source: '/blog.css', headers: [{ key: 'Cache-Control', value: immutable }] },
      { source: '/blog.js', headers: [{ key: 'Cache-Control', value: immutable }] },
      { source: '/og/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
      { source: '/feed.xml', headers: [{ key: 'Content-Type', value: 'application/rss+xml; charset=utf-8' }] },
    ],
  }, null, 2)}\n`;
}
