/* Distribb -> blog.interndoor.com: the webhook endpoint, the HTML cleaner,
   the article mapping, and one real build with an imported post in it.
   Builds go into temporary directories, never blog/public. */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond, webhookToken, presentedToken, expectedUrl, LIST_KEY, KEEP, MAX_BODY } from '../web/api/distribb.js';
import { cleanArticleHtml, cleanHref, undash, plainText } from '../blog/lib/htmlpost.mjs';
import { mapArticle, isTestPayload, eventOf, descriptionFrom, dekFrom, buildPost, postFile, imageInfo, dropLeadingTitle, tagsFrom, istDay, clip } from '../src/distribbimport.js';
import { parseFrontmatter, validatePost } from '../blog/lib/content.mjs';
import { build } from '../blog/build.mjs';
import { vercelJson } from '../blog/lib/seo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

/* ------------------------------------------------------------- endpoint */
console.log('\n== /api/distribb: who may post, and what is kept ==');
const env = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'kv-secret' };
const token = webhookToken(env);
const calls = [];
const okFetch = async (url, init) => { await new Promise((r) => setTimeout(r, 5)); calls.push({ url, init }); return { ok: true }; };
const article = { id: 42, title: 'How to read an internship posting', slug: 'read-an-internship-posting', content: '<p>Body</p>' };
const post = (headers, body) => respond({ method: 'POST', headers, body }, { env, fetchImpl: okFetch, now: () => new Date('2026-10-14T05:00:00Z') });

check('the token is derived from the store token, 64 hex', /^[0-9a-f]{64}$/.test(token), true);
check('a different store token gives a different webhook token', webhookToken({ KV_REST_API_TOKEN: 'other' }) === token, false);
check('no store token, no webhook token', webhookToken({}), null);
check('HEAD answers 200 without a token (the connection check)', (await respond({ method: 'HEAD', headers: {} }, { env })).status, 200);
check('OPTIONS answers 204', (await respond({ method: 'OPTIONS', headers: {} }, { env })).status, 204);
check('GET is 405', (await respond({ method: 'GET', headers: {} }, { env })).status, 405);
check('no store configured: 503, and nothing is checked or saved', (await respond({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: article }, { env: {}, fetchImpl: okFetch })).status, 503);
check('no token: 401', (await post({}, article)).status, 401);
check('a wrong token: 401', (await post({ authorization: `Bearer ${'0'.repeat(64)}` }, article)).status, 401);
check('a token of the wrong length: 401 (no throw)', (await post({ authorization: 'Bearer short' }, article)).status, 401);
check('Bearer is read', presentedToken({ authorization: `Bearer ${token}` }), token);
check('X-API-Key is read', presentedToken({ 'x-api-key': token }), token);
check('x-make-apikey is read', presentedToken({ 'x-make-apikey': token }), token);
calls.length = 0;
const good = await post({ authorization: `Bearer ${token}` }, article);
check('a good delivery: 200', good.status, 200);
check('it answers with where the post will live', good.body.url, 'https://blog.interndoor.com/read-an-internship-posting');
check('one request to the store', calls.length, 1);
const sent = JSON.parse(calls[0]?.init.body ?? '[]');
check('LPUSH and LTRIM in the SAME pipeline', sent.map((c) => c[0]), ['LPUSH', 'LTRIM']);
check('to the inbox key', sent[0]?.[1], LIST_KEY);
check('trimmed to KEEP', sent[1]?.slice(2), [0, KEEP - 1]);
check('the body is kept exactly as sent', JSON.parse(sent[0]?.[2] ?? '{}').body, article);
check('the store is asked with the store token, not the webhook token', calls[0]?.init.headers.authorization, 'Bearer kv-secret');
check('X-API-Key alone is enough', (await post({ 'x-api-key': token }, article)).status, 200);
check('a JSON string body is parsed', (await post({ authorization: `Bearer ${token}` }, JSON.stringify(article))).status, 200);
check('not JSON: 400', (await post({ authorization: `Bearer ${token}` }, 'not json')).status, 400);
check('JSON with no article: 400', (await post({ authorization: `Bearer ${token}` }, { hello: 1 })).status, 400);
check('an article in an envelope is accepted', (await post({ authorization: `Bearer ${token}` }, { event: 'article.published', data: article })).status, 200);
check('too big: 413', (await post({ authorization: `Bearer ${token}` }, { title: 't', content: 'x'.repeat(MAX_BODY) })).status, 413);
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const r = await respond({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { ...article, content: 'SECRET-BODY' } }, { env, fetchImpl: async () => ({ ok: false }) });
  console.error = orig;
  check('a failed store write: 502', r.status, 502);
  check('the failure log names no part of the body', errs.some((l) => l.includes('SECRET-BODY') || l.includes('How to read')), false);
}
check('an unusable slug falls back to the title', expectedUrl({ title: 'Stipend: what to ask', slug: 'Bad Slug!' }), 'https://blog.interndoor.com/stipend-what-to-ask');

/* ------------------------------------------------------------- cleaner */
console.log('\n== the cleaner: nothing the CSP or the verifier would refuse ==');
const messy = `<h1 id="top">Big title</h1><h2>Table of Contents</h2><ul><li><a href="#intro">Intro</a></li><li><a href="#faq">FAQ</a></li></ul>`
  + `<h2 id="intro" style="color:red">Intro ${EM} why</h2><p onclick="x()">Pay is 10${EN}20k <b>bold</b> <a href="javascript:alert(1)">bad</a> `
  + `<a href="http://example.com/x" rel="nofollow evil">good</a> <a href="#faq">see faq</a> <a href="#nope">gone</a></p>`
  + `<script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><svg><script>y</script></svg>`
  + `<div><img src="https://cdn.example/a.png" alt="A chart" onerror="x"><img src="data:image/png;base64,AAA" alt=""></div>`
  + `<table><tr><th>A</th><td colspan="2" style="x">B</td></tr></table><h2 id="faq">FAQ</h2><h3 id="main">Q?</h3><p>A &amp; B < C &copy;</p><p></p>`;
const c = cleanArticleHtml(messy, { images: (u) => (u === 'https://cdn.example/a.png' ? { src: '/media/p/a.png', width: 800, height: 600 } : null), reservedIds: ['main'] });
check('no script, style, iframe or svg survives', /<(script|style|iframe|svg)\b/i.test(c.html), false);
check('no style= or on*= attribute survives', /\s(style|on[a-z]+)=/i.test(c.html), false);
check('no em or en dash survives', /[\u2013\u2014]/.test(c.html), false);
check('a range keeps a hyphen', c.html.includes('10-20k'), true);
check('h1 becomes h2', /<h1\b/.test(c.html), false);
check('javascript: is unwrapped to its text', c.html.includes('javascript') || !c.html.includes(' bad '), false);
check('http is upgraded to https', c.html.includes('href="https://example.com/x"'), true);
check('rel keeps only known tokens', c.html.includes('rel="nofollow"'), true);
check('the article’s own contents list is gone', c.html.includes('Table of Contents'), false);
check('an anchor to a real heading stays', c.html.includes('<a href="#faq">see faq</a>'), true);
check('an anchor to nothing is unwrapped', c.html.includes('#nope'), false);
check('an allowed image is rewritten to /media with its size', c.html.includes('<img src="/media/p/a.png" alt="A chart" width="800" height="600"'), true);
check('an image with no mapping is dropped', c.html.includes('data:image'), false);
check('a table is wrapped for scrolling', c.html.includes('<div class="table-wrap" role="region" tabindex="0" aria-label="Table"><table>'), true);
check('colspan survives, scoped to a number', c.html.includes('<td colspan="2">'), true);
check('a reserved id is not reused', c.html.includes('id="main"'), false);
check('ids are unique', (() => { const ids = [...c.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]); return new Set(ids).size === ids.length; })(), true);
check('a stray < is escaped and a real entity kept', c.html.includes('A &amp; B &lt; C &copy;'), true);
check('empty paragraphs go', c.html.includes('<p></p>'), false);
check('headings feed the contents list (h2 and h3 only)', c.headings.map((h) => h.level), [2, 2, 2, 3]);
check('it reports the images it saw', c.images, ['https://cdn.example/a.png', 'data:image/png;base64,AAA']);
check('without an image map, only /media images stay', cleanArticleHtml('<p>x<img src="https://cdn.example/a.png" alt="a"><img src="/media/s/b.png" alt="b"></p>').html, '<p>x<img src="/media/s/b.png" alt="b" loading="lazy" decoding="async"></p>');
check('a /media path that climbs out is dropped', cleanArticleHtml('<p><img src="/media/../x.png" alt="a"></p>').html.includes('img'), false);
check('cleaning is idempotent (the build re-cleans the stored body)', cleanArticleHtml(c.html, { reservedIds: ['main'] }).html, c.html);
check('cleanHref refuses data:', cleanHref('data:text/html,x'), null);
check('cleanHref refuses credentials in a URL', cleanHref('https://u:p@example.com/'), null);
check('cleanHref keeps mailto', cleanHref('mailto:akshat@interndoor.com'), 'mailto:akshat@interndoor.com');
check('a dead interndoor.com link is unwrapped', cleanArticleHtml('<p>See <a href="https://interndoor.com/jobs/x">this role</a>.</p>', { deadLinks: new Set(['https://interndoor.com/jobs/x']) }).html, '<p>See this role.</p>');
check('nested links collapse to one', (cleanArticleHtml('<p><a href="https://a.example/">x <a href="https://b.example/">y</a> z</a></p>').html.match(/<a /g) ?? []).length, 1);
check('undash at the start of a line drops the dash', undash(`${EM} Name`), 'Name');
check('plainText decodes entities', plainText('<p>A &amp; B</p>'), 'A & B');

/* ------------------------------------------------------------- mapping */
console.log('\n== mapping a delivery to a post ==');
const p = 'Engineering internships in India ask for skills that a posting rarely spells out. '.repeat(3);
const longBody = `<h1>Internship stipends in India</h1>${Array.from({ length: 8 }, (_, k) => `<h2>Part ${k + 1}</h2><p>${p}</p><p>${p}</p>`).join('')}`;
const delivery = {
  event: 'article.published',
  data: {
    id: 991, title: `Internship stipends in India ${EM} what to ask`, slug: 'internship-stipends-india', content: longBody,
    meta_description: 'What engineering internships in India pay, how to read a stipend line, and the questions to ask before you accept an offer.',
    feature_image: 'https://cdn.example/hero.png', feature_image_alt: 'A student reading an offer letter', keyword: 'internship stipend India',
    published_at: '2026-10-14T03:30:00Z',
  },
};
const m = mapArticle(delivery);
check('the article is found inside the envelope', m.title, `Internship stipends in India ${EM} what to ask`);
check('the slug is kept when it is clean', m.slug, 'internship-stipends-india');
check('the image and its alt are read', [m.image, m.imageAlt], ['https://cdn.example/hero.png', 'A student reading an offer letter']);
check('the id is a string', m.id, '991');
check('a publish event', m.event, 'publish');
check('an update event', eventOf({ event: 'article.updated' }), 'update');
check('a delete event', eventOf({ type: 'article.deleted' }), 'remove');
check('feature_image as an object', mapArticle({ title: 't', content: 'c', featured_image: { url: 'https://x/y.png', alt: 'y' } }).image, 'https://x/y.png');
check('a test flag is a test', isTestPayload({ test: true, title: 'Real title' }), true);
check('a test event is a test', isTestPayload({ event: 'webhook.test', data: { title: 'x', content: 'y' } }), true);
check('a "Test" title is a test', isTestPayload({ title: 'Test article from Distribb', content: 'x' }), true);
check('an ordinary article is not a test', isTestPayload(delivery), false);
check('a meta description in range is used as it is', descriptionFrom(delivery.data.meta_description, ''), delivery.data.meta_description);
check('a long meta description is cut under 165', descriptionFrom('word '.repeat(60), '').length <= 165, true);
check('a missing one is made from the opening, 70 to 165', (() => { const d = descriptionFrom('', `<p>${p}</p>`); return d.length >= 70 && d.length <= 165; })(), true);
check('too little text for a description: null', descriptionFrom('', '<p>Short.</p>'), null);
check('dek from a short meta falls back to the opening', dekFrom('Too short', `<p>${p}</p>`).length >= 40, true);
check('clip ends on a full stop', clip('One two three. Four five six seven eight nine ten.', 30).endsWith('.'), true);
check('a leading heading that repeats the title is dropped', dropLeadingTitle('<h1>Internship Stipends, India</h1><p>x</p>', 'Internship stipends India'), '<p>x</p>');
check('a different leading heading stays', dropLeadingTitle('<h2>Why it matters</h2><p>x</p>', 'Stipends'), '<h2>Why it matters</h2><p>x</p>');
check('a tag from the keyword', tagsFrom('Internship Stipend, India!'), ['internship stipend india']);
check('IST day', istDay('2026-10-13T19:00:00Z'), '2026-10-14');

const built = buildPost(m, { images: (u) => null, hero: { src: '/media/internship-stipends-india/abc.png', width: 1200, height: 630 }, today: '2026-10-14' });
check('a good article builds', built.error ?? 'ok', 'ok');
check('the title loses its dash', built.post?.title, 'Internship stipends in India, what to ask');
check('published is the delivery day (IST)', built.post?.published, '2026-10-14');
check('a delivery dated in the future is published today', buildPost({ ...m, publishedAt: '2026-12-01T00:00:00Z' }, { today: '2026-10-14' }).post?.published, '2026-10-14');
check('an update keeps the first published day and adds updated', [buildPost(m, { today: '2026-10-20', existing: { published: '2026-10-14' } }).post?.published, buildPost(m, { today: '2026-10-20', existing: { published: '2026-10-14' } }).post?.updated], ['2026-10-14', '2026-10-20']);
check('no body: refused', buildPost({ ...m, html: '<p>tiny</p>' }, { today: '2026-10-14' }).error, 'no article body (under 500 characters)');
check('a title over 110: refused', /110/.test(buildPost({ ...m, title: 'x'.repeat(120) }, { today: '2026-10-14' }).error ?? ''), true);
check('too few words after cleaning: refused', /words survived/.test(buildPost({ ...m, html: `<script>${'x '.repeat(400)}</script><p>${'word '.repeat(50)}</p>` }, { today: '2026-10-14' }).error ?? ''), true);
check('a remove event makes a draft', buildPost({ ...m, event: 'remove' }, { today: '2026-10-14' }).post?.draft, true);

const file = postFile(built.post);
const fm = parseFrontmatter(file, 'x.html');
let valid;
try { valid = validatePost(fm.data, 'x.html'); } catch (e) { valid = e.message; }
check('the file’s front matter passes the blog’s own rules', typeof valid === 'object', true);
check('origin is distribb', fm.data.origin, 'distribb');
{
  const noAlt = { ...fm.data };
  delete noAlt.imageAlt;
  let msg = '';
  try { validatePost(noAlt, 'x.html'); } catch (e) { msg = e.message; }
  check('an image with no alt text is refused', /imageAlt/.test(msg), true);
  let msg2 = '';
  try { validatePost({ ...fm.data, image: 'https://cdn.example/x.png' }, 'x.html'); } catch (e) { msg2 = e.message; }
  check('an image that is not a /media path is refused', /\/media/.test(msg2), true);
}
check('the image fields round-trip', [fm.data.image, fm.data.imageWidth, fm.data.imageHeight], ['/media/internship-stipends-india/abc.png', '1200', '630']);
check('no dash anywhere in the file', /[\u2013\u2014]/.test(file), false);

/* ------------------------------------------------------------- image sizes */
console.log('\n== image sizes from the file header ==');
const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1200, 16); png.writeUInt32BE(630, 20);
check('png', imageInfo(png), { ext: 'png', width: 1200, height: 630 });
const gif = Buffer.alloc(32); gif.write('GIF89a', 0, 'ascii'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
check('gif', imageInfo(gif), { ext: 'gif', width: 320, height: 200 });
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x03, 0x01, 0x22, 0x00, 0, 0, 0, 0, 0, 0]);
check('jpeg (skips an APP0 segment to reach SOF0)', imageInfo(jpg), { ext: 'jpg', width: 1200, height: 630 });
const webp = Buffer.alloc(32); webp.write('RIFF', 0, 'ascii'); webp.write('WEBPVP8X', 8, 'ascii'); webp.writeUIntLE(1199, 24, 3); webp.writeUIntLE(629, 27, 3);
check('webp (VP8X)', imageInfo(webp), { ext: 'webp', width: 1200, height: 630 });
check('not an image', imageInfo(Buffer.from('<html>not an image at all</html>')), null);

/* ------------------------------------------------------------- a real build */
console.log('\n== a build with an imported post in it ==');
const content = mkdtempSync(join(tmpdir(), 'distribb-content-'));
const out = mkdtempSync(join(tmpdir(), 'distribb-out-'));
cpSync(join(ROOT, 'blog', 'content'), content, { recursive: true });
const withLinks = buildPost({ ...m, html: `${longBody}<p>Read <a href="https://interndoor.com/roles/distribb-fixture">the role pages</a> and <a href="https://partner.example/guide">a partner guide</a>.</p><figure><img src="https://cdn.example/b.png" alt="A chart of stipends"><figcaption>Stipends stated</figcaption></figure>` }, {
  images: (u) => (u === 'https://cdn.example/b.png' ? { src: '/media/internship-stipends-india/b.png', width: 800, height: 500 } : null),
  hero: { src: '/media/internship-stipends-india/abc.png', width: 1200, height: 630 }, today: '2026-10-14',
});
writeFileSync(join(content, 'posts', 'internship-stipends-india.html'), postFile(withLinks.post));
mkdirSync(join(content, 'media', 'internship-stipends-india'), { recursive: true });
writeFileSync(join(content, 'media', 'internship-stipends-india', 'abc.png'), png);
writeFileSync(join(content, 'media', 'internship-stipends-india', 'b.png'), png);
const res = await build({ contentDir: content, outDir: out, og: false, vercelFile: null, today: '2026-10-14' });
check('the build passes its own verifier', res.check.errors, []);
check('the imported post is published', res.posts.some((x) => x.slug === 'internship-stipends-india'), true);
const page = readFileSync(join(out, 'internship-stipends-india.html'), 'utf8');
check('one <h1>, the template’s', (page.match(/<h1[\s>]/g) ?? []).length, 1);
check('the lead image is drawn with its size', page.includes('<figure class="post-hero"><img src="/media/internship-stipends-india/abc.png" alt="A student reading an offer letter" width="1200" height="630"'), true);
check('the body image is local', page.includes('src="/media/internship-stipends-india/b.png"'), true);
check('the media is copied into the output', readFileSync(join(out, 'media', 'internship-stipends-india', 'abc.png')).length, png.length);
check('the post is in the sitemap', readFileSync(join(out, 'sitemap.xml'), 'utf8').includes('https://blog.interndoor.com/internship-stipends-india'), true);
check('its contents list is drawn from its headings', page.includes('class="toc"'), true);
check('the interndoor.com link is counted for the link check', res.mainLinks.includes('https://interndoor.com/roles/distribb-fixture'), true);
check('the partner link is kept', page.includes('href="https://partner.example/guide"'), true);
rmSync(content, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });

/* ------------------------------------------------------------- deploy step */
console.log('\n== the blog deploys whenever blog/ changed since the last deploy ==');
const ic = JSON.parse(vercelJson()).ignoreCommand;
check('it compares with the last deployed commit', ic.includes('git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .'), true);
check('it falls back to the previous commit when that sha is unknown', ic.includes('else git diff --quiet HEAD^ HEAD -- .'), true);
check('it fits Vercel’s 256-character limit', ic.length <= 256, true);
/* The command line, not the comment above it: a comment naming the script
   passed this check with the call deleted. */
check('run.sh runs the importer between the scan phases', /^"\$NODE" [^\n]*"\$HERE\/bin\/distribb-import\.js"/m.test(readFileSync(join(ROOT, 'bin', 'run.sh'), 'utf8')), true);
check('serve.js routes the endpoint locally', readFileSync(join(ROOT, 'web', 'serve.js'), 'utf8').includes("'/api/distribb': './api/distribb.js'"), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
