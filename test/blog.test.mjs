/* blog.interndoor.com: the Markdown subset, the front matter, the post rules,
   the charts, the built site, and the drift guards that tie the blog to the
   main site. Builds go into temporary directories, never blog/public. */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderMarkdown, inline, slugify, smartQuotes, MarkdownError } from '../blog/lib/markdown.mjs';
import { parseFrontmatter, validatePost, loadPosts, validDate, readingMinutes, ContentError, RESERVED_SLUGS } from '../blog/lib/content.mjs';
import { loadDatasets, renderChart, validateChart, barWidth, ChartError } from '../blog/lib/charts.mjs';
import { build, relatedFor } from '../blog/build.mjs';
import { verifySite, urlPathOf } from '../blog/lib/verify.mjs';
import { vercelJson, csp, sitemapXml, rfc822 } from '../blog/lib/seo.mjs';
import { THEME_SCRIPT, longDate } from '../blog/lib/templates.mjs';
import { SITE, WHATSAPP_URL, SUBSCRIBE_ENDPOINT, CATEGORIES } from '../blog/lib/site.mjs';
import { BLOG_ORIGIN } from '../web/api/subscribe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function throws(label, fn, ErrorType, pattern) {
  try { fn(); fail++; console.log(`  FAIL ${label}\n         did not throw`); }
  catch (e) {
    const ok = (!ErrorType || e instanceof ErrorType) && (!pattern || pattern.test(e.message));
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         threw: ${e.constructor.name}: ${e.message}`); }
  }
}
const tmp = (p) => mkdtempSync(join(tmpdir(), `blogtest-${p}-`));

console.log('\n== markdown: text is escaped, never markup ==');
check('angle brackets escaped', renderMarkdown('A <script>x</script> b').html, '<p>A &lt;script&gt;x&lt;/script&gt; b</p>');
check('ampersand escaped', inline('R&D'), 'R&amp;D');
check('bold and italic', inline('**a** and *b*'), '<strong>a</strong> and <em>b</em>');
check('snake_case is not italic', inline('a_b_c'), 'a_b_c');
check('code span escaped, not formatted', inline('`<b>**x**</b>`'), '<code>&lt;b&gt;**x**&lt;/b&gt;</code>');
check('apostrophe curled', smartQuotes("it's"), 'it’s');
check('quotes curled', smartQuotes('"a" said'), '“a” said');
check('link rendered', inline('[x](/a)'), '<a href="/a">x</a>');
check('https link rendered', inline('[x](https://interndoor.com/)'), '<a href="https://interndoor.com/">x</a>');
throws('javascript: link refused', () => inline('[x](javascript:alert(1))'), MarkdownError, /Refused link/);
throws('data: link refused', () => inline('[x](data:text/html,hi)'), MarkdownError, /Refused link/);
throws('protocol-relative link refused', () => inline('[x](//evil.example)'), MarkdownError);
throws('unclosed bold refused', () => inline('**a'), MarkdownError, /unclosed/);
throws('em dash refused', () => renderMarkdown('one \u2014 two'), MarkdownError, /dash/);
throws('en dash refused', () => renderMarkdown('10\u201320'), MarkdownError, /dash/);
throws('h1 in a body refused', () => renderMarkdown('# Title'), MarkdownError, /##/);
throws('h4 refused', () => renderMarkdown('#### Deep'), MarkdownError, /##/);
throws('nested list refused', () => renderMarkdown('- a\n  - b'), MarkdownError, /Nested/);
throws('unknown directive refused', () => renderMarkdown('::: banner\nx\n:::'), MarkdownError, /Unknown directive/);
throws('unclosed container refused', () => renderMarkdown('::: note\nx'), MarkdownError, /never closed/);
throws('findings without a list refused', () => renderMarkdown('::: findings\nplain\n:::'), MarkdownError, /single list/);
throws('table row with the wrong cell count refused', () => renderMarkdown('| a | b |\n|---|---|\n| 1 |'), MarkdownError, /cells/);
throws('table without separator refused', () => renderMarkdown('| a | b |\n| 1 | 2 |\n| 3 | 4 |'), MarkdownError, /separators/);
throws('caption with no table refused', () => renderMarkdown('Table: x\n\nplain'), MarkdownError, /not followed/);
throws('citation without a source list refused', () => renderMarkdown('a[^x]'), MarkdownError, /none are allowed/);

const doc = renderMarkdown('## Same\n\ntext\n\n## Same\n\n### Sub\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---\n\n| City | Share |\n|---|---:|\n| Pune | 6% |');
check('duplicate headings get unique ids', doc.headings.map((h) => h.id), ['same', 'same-2', 'sub']);
check('outline levels', doc.headings.map((h) => h.level), [2, 2, 3]);
check('lists, quote, rule and table render', ['<ul>', '<ol>', '<blockquote>', '<hr>', '<table>', 'class="a-right"', 'scope="row"', 'scope="col"'].every((x) => doc.html.includes(x)), true);
check('a scrollable table can be reached by keyboard', /class="table-wrap" role="region" tabindex="0"/.test(doc.html), true);
check('words counted', renderMarkdown('one two three\n\n## four five').words, 5);
check('slugify', slugify('Pay: 18 postings out of 425'), 'pay-18-postings-out-of-425');
check('findings become a labelled section in the outline', renderMarkdown('::: findings\n1. **4%** x\n:::').headings[0].text, 'Key findings');
check('method becomes a labelled section in the outline', renderMarkdown('::: method\nx\n:::').headings[0].id, 'how-this-was-counted');

console.log('\n== front matter: a strict subset, or an error ==');
const fm = parseFrontmatter('---\ntitle: "A: b"\ntags: [x, y z]\nflag: true\nsources:\n  - id: a\n    url: https://x.org\n  - id: b\n    url: https://y.org\nlist:\n  - one\n  - two\n---\nBody');
check('quoted value with a colon', fm.data.title, 'A: b');
check('inline list', fm.data.tags, ['x', 'y z']);
check('boolean', fm.data.flag, true);
check('list of maps', fm.data.sources, [{ id: 'a', url: 'https://x.org' }, { id: 'b', url: 'https://y.org' }]);
check('list of scalars', fm.data.list, ['one', 'two']);
check('body after the fence', fm.body, 'Body');
throws('missing fence refused', () => parseFrontmatter('title: x'), ContentError, /front matter/);
throws('duplicate key refused', () => parseFrontmatter('---\na: 1\na: 2\n---\n'), ContentError, /twice/);
throws('unquoted ": " refused', () => parseFrontmatter('---\ntitle: a: b\n---\n'), ContentError, /quote/);
throws('unclosed list refused', () => parseFrontmatter('---\ntags: [a, b\n---\n'), ContentError, /never closes/);

console.log('\n== post rules ==');
const good = {
  title: 'A good title for a post', slug: 'a-good-post', category: 'guides', published: '2026-10-14',
  description: 'A description long enough to be a search snippet, which needs at least seventy characters.',
  dek: 'A standfirst that says what the post is about in a sentence or two.',
};
check('a good post passes', validatePost(good, 'f').slug, 'a-good-post');
throws('no title', () => validatePost({ ...good, title: '' }, 'f'), ContentError, /title/);
throws('slug with capitals', () => validatePost({ ...good, slug: 'A-Post' }, 'f'), ContentError, /slug/);
throws('slug that is a reserved path', () => validatePost({ ...good, slug: 'reports' }, 'f'), ContentError, /reserved/);
check('every static page and category is reserved', ['about', 'methodology', 'privacy', 'search', 'reports', 'guides', 'feed.xml', 'sitemap.xml', 'og'].every((s) => RESERVED_SLUGS.has(s)), true);
throws('description too short for a snippet', () => validatePost({ ...good, description: 'Short.' }, 'f'), ContentError, /description/);
throws('description too long for a snippet', () => validatePost({ ...good, description: 'x'.repeat(170) }, 'f'), ContentError, /description/);
throws('unknown category', () => validatePost({ ...good, category: 'news' }, 'f'), ContentError, /category/);
throws('impossible date', () => validatePost({ ...good, published: '2026-02-30' }, 'f'), ContentError, /published/);
throws('updated before published', () => validatePost({ ...good, updated: '2026-10-01' }, 'f'), ContentError, /before/);
throws('unknown field', () => validatePost({ ...good, autor: 'x' }, 'f'), ContentError, /unknown field/);
throws('dash in a field', () => validatePost({ ...good, dek: `${good.dek} \u2014 more` }, 'f'), ContentError, /dash/);
throws('source without https', () => validatePost({ ...good, sources: [{ id: 'a', title: 't', publisher: 'p', url: 'http://x.org' }] }, 'f'), ContentError, /https/);
throws('duplicate source id', () => validatePost({ ...good, sources: [{ id: 'a', title: 't', publisher: 'p', url: 'https://x.org' }, { id: 'a', title: 't', publisher: 'p', url: 'https://y.org' }] }, 'f'), ContentError, /twice/);
throws('figure without its label', () => validatePost({ ...good, figure: '4%' }, 'f'), ContentError, /together/);
throws('"further" link off InternDoor', () => validatePost({ ...good, further: [{ label: 'x', url: 'https://example.com/' }] }, 'f'), ContentError, /interndoor/);
check('real dates', [validDate('2026-10-14'), validDate('2026-02-29'), validDate('2028-02-29'), validDate('14-10-2026')], [true, false, true, false]);
check('reading time rounds up, at least one minute', [readingMinutes(1), readingMinutes(231), readingMinutes(460)], [1, 2, 2]);

const postFile = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : JSON.stringify(v)}`).join('\n')}\n---\nBody text.\n`;
{
  const d = tmp('posts');
  writeFileSync(join(d, 'a.md'), postFile({ ...good, slug: 'post-a' }));
  writeFileSync(join(d, 'b.md'), postFile({ ...good, slug: 'post-b', draft: true }));
  writeFileSync(join(d, 'c.md'), postFile({ ...good, slug: 'post-c', published: '2026-12-01' }));
  const { posts, skipped } = loadPosts(d, { today: '2026-10-14' });
  check('drafts and future posts are not published', posts.map((p) => p.slug), ['post-a']);
  check('and are reported', skipped.map((s) => s.why).sort(), ['draft', 'scheduled']);
  check('--drafts includes them', loadPosts(d, { today: '2026-10-14', includeDrafts: true }).posts.length, 3);
  writeFileSync(join(d, 'd.md'), postFile({ ...good, slug: 'post-a' }));
  throws('duplicate slug refused', () => loadPosts(d, { today: '2026-10-14' }), ContentError, /already used/);
  rmSync(join(d, 'd.md'));
  writeFileSync(join(d, 'e.md'), postFile({ ...good, slug: 'post-e', related: ['post-b'] }));
  throws('related to a draft refused', () => loadPosts(d, { today: '2026-10-14' }), ContentError, /not a published post/);
  rmSync(d, { recursive: true, force: true });
}

console.log('\n== charts ==');
const src = { label: 'S', url: 'https://interndoor.com/x' };
const chart = { title: 'T', subtitle: 'S', unit: 'count', rows: [{ label: 'A', value: 10 }, { label: 'B', value: 5 }], highlight: ['A'], source: src };
check('a good chart passes', validateChart('x.y', chart), true);
throws('no source', () => validateChart('x.y', { ...chart, source: undefined }), ChartError, /source/);
throws('source over http', () => validateChart('x.y', { ...chart, source: { label: 'S', url: 'http://x' } }), ChartError, /source/);
throws('highlight that is not a row', () => validateChart('x.y', { ...chart, highlight: ['Z'] }), ChartError, /highlight/);
throws('a value above max', () => validateChart('x.y', { ...chart, max: 8 }), ChartError, /max/);
throws('a negative value', () => validateChart('x.y', { ...chart, rows: [{ label: 'A', value: -1 }, { label: 'B', value: 1 }] }), ChartError, /non-negative/);
throws('one row is not a chart', () => validateChart('x.y', { ...chart, rows: [{ label: 'A', value: 1 }] }), ChartError, /rows/);
check('bar widths are proportional and rounded', [barWidth(50, 100), barWidth(1, 3), barWidth(0, 10)], [50, 33.3, 0]);
check('a tiny non-zero value still draws', barWidth(1, 10000), 0.6);
{
  const html = renderChart(new Map([['x', { id: 'x', source: src, charts: { y: chart } }]]), 'x.y');
  check('chart is a table with row headers', /<table class="bars">/.test(html) && /<th scope="row">A<\/th>/.test(html), true);
  check('the bar is a width attribute, never a style', /<svg class="cbar is-key" width="100%"/.test(html) && !/style=/.test(html), true);
  check('the second bar is half', /<svg class="cbar" width="50%"/.test(html), true);
  check('the key row is marked', /<tr class="is-key">/.test(html), true);
  check('the source is linked', html.includes('Source: <a href="https://interndoor.com/x">S</a>'), true);
  throws('an unknown chart is refused', () => renderChart(new Map(), 'x.z'), ChartError, /Unknown chart/);
}
{
  const sets = loadDatasets(join(ROOT, 'blog', 'content', 'data'));
  check('every committed dataset loads and validates', sets.size >= 5, true);
  /* The frozen figures must match the monthly report the main site serves.
     Read off the committed page, so this needs no database. */
  const ins = readFileSync(join(ROOT, 'web', 'public', 'insights', '2026-09.html'), 'utf8');
  const sep = sets.get('sep2026');
  check('September rows match the frozen report', ins.includes(`${sep.rows} postings`) && ins.includes(`${sep.employers} employers`), true);
  const emp = sep.charts.employers.rows.map((r) => `${r.label} ${r.value}`);
  const text = ins.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  check('the top-employer counts match the frozen report', emp.every((e) => text.includes(e)), true);
  check('the lead post leads with the frozen total', readFileSync(join(ROOT, 'blog', 'content', 'posts', 'engineering-internships-india-september-2026.md'), 'utf8').includes(`figure: "${sep.rows}"`), true);
}

console.log('\n== the built site ==');
const outA = tmp('outA');
const outB = tmp('outB');
const res = await build({ outDir: outA, og: false, vercelFile: null, today: '2026-10-14' });
await build({ outDir: outB, og: false, vercelFile: null, today: '2026-10-14' });
check('the build verifies clean', res.check.errors, []);
check('five posts', res.posts.length, 5);
const list = (d) => readdirSync(d, { recursive: true }).map(String).filter((f) => /\.\w+$/.test(f)).sort();
check('two builds write the same files', list(outA), list(outB));
check('two builds write the same bytes', list(outA).every((f) => readFileSync(join(outA, f)).equals(readFileSync(join(outB, f)))), true);
const read = (rel) => readFileSync(join(outA, rel), 'utf8');
const sm = read('sitemap.xml');
check('sitemap lists every post', res.posts.every((p) => sm.includes(`<loc>${SITE}/${p.slug}</loc>`)), true);
check('sitemap leaves out search and the 404', !sm.includes('/search<') && !sm.includes('/404'), true);
check('search is noindex', read('search.html').includes('content="noindex,follow"'), true);
check('the 404 page claims no canonical', !read('404.html').includes('rel="canonical"'), true);
check('robots names the sitemap', read('robots.txt').includes(`Sitemap: ${SITE}/sitemap.xml`), true);
const art = read('engineering-internships-india-september-2026.html');
const ld = JSON.parse(art.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const post = ld['@graph'].find((n) => n['@type'] === 'BlogPosting');
check('BlogPosting carries the dates', [post.datePublished, post.dateModified], ['2026-10-14', '2026-10-14']);
check('BlogPosting is by the organisation, not an invented person', post.author, { '@id': 'https://interndoor.com/#organization' });
check('BlogPosting cites its sources', post.citation.includes('https://interndoor.com/insights/2026-09'), true);
check('a breadcrumb trail is marked up', ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), true);
check('no JobPosting markup on an article', !art.includes('JobPosting'), true);
check('citations are numbered in order of first use', [...art.matchAll(/aria-label="Source (\d)"/g)].map((m) => m[1])[0], '1');
check('every citation lands on a source', [...art.matchAll(/href="#src-([a-z0-9-]+)"/g)].every((m) => art.includes(`id="src-${m[1]}"`)), true);
check('a post has one <h1>', (art.match(/<h1[\s>]/g) ?? []).length, 1);
check('the article text is in the HTML, not fetched', art.includes('A long tail of employers') && art.includes('<table class="bars">'), true);
check('the only inline script is the theme script', [...art.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]), [THEME_SCRIPT]);
check('the RSS feed lists every post', res.posts.every((p) => read('feed.xml').includes(`<link>${SITE}/${p.slug}</link>`)), true);
check('RSS dates are Indian midnight', rfc822('2026-10-14'), 'Wed, 14 Oct 2026 00:00:00 +0530');
check('long dates', longDate('2026-10-14'), '14 October 2026');
check('a category page exists for each category with posts', ['reports/index.html', 'guides/index.html'].every((f) => existsSync(join(outA, f))), true);
check('urls are clean', [urlPathOf(outA, join(outA, 'reports/index.html')), urlPathOf(outA, join(outA, 'a.html')), urlPathOf(outA, join(outA, 'index.html'))], ['/reports', '/a', '/']);

{
  /* A fixture content tree: the real one plus a noindex post, built into a
     directory that already holds a page for a post that no longer exists. */
  const content = tmp('content');
  cpSync(join(ROOT, 'blog', 'content'), content, { recursive: true });
  writeFileSync(join(content, 'posts', 'zz-hidden.md'), postFile({ ...good, slug: 'zz-hidden', noindex: true }));
  const out = tmp('outC');
  writeFileSync(join(out, 'a-deleted-post.html'), '<h1>old</h1>');
  const r = await build({ contentDir: content, outDir: out, og: false, vercelFile: null, today: '2026-10-14' });
  const map = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  check('a noindex post is written', existsSync(join(out, 'zz-hidden.html')), true);
  check('a noindex post says so', readFileSync(join(out, 'zz-hidden.html'), 'utf8').includes('content="noindex,follow"'), true);
  check('a noindex post is not in the sitemap', map.includes('/zz-hidden<'), false);
  check('and the site still verifies', r.check.errors, []);
  check('a page whose post is gone is removed', existsSync(join(out, 'a-deleted-post.html')), false);
  rmSync(content, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}

console.log('\n== the verifier catches what it exists to catch ==');
function broken(rel, from, to) {
  const d = tmp('broken');
  cpSync(outA, d, { recursive: true });
  const f = join(d, rel);
  writeFileSync(f, readFileSync(f, 'utf8').replace(from, to));
  const errs = verifySite(d).errors;
  rmSync(d, { recursive: true, force: true });
  return errs;
}
check('an inline style is caught', broken('about.html', '<main id="main"', '<main style="color:red" id="main"').some((e) => /inline style/.test(e)), true);
check('a second inline script is caught', broken('about.html', '</head>', '<script>alert(1)</script></head>').some((e) => /inline script/.test(e)), true);
check('a broken internal link is caught', broken('about.html', 'href="/methodology"', 'href="/methodolgy"').some((e) => /broken internal link/.test(e)), true);
check('a wrong canonical is caught', broken('about.html', `href="${SITE}/about"`, `href="${SITE}/about-us"`).some((e) => /canonical/.test(e)), true);
check('a noindex page in the sitemap is caught', broken('about.html', 'content="index,follow,max-image-preview:large"', 'content="noindex,follow"').some((e) => /not an indexable page/.test(e)), true);
check('a second <h1> is caught', broken('about.html', '</main>', '<h1>x</h1></main>').some((e) => /<h1>/.test(e)), true);
check('an em dash is caught', broken('about.html', '</main>', '<p>a \u2014 b</p></main>').some((e) => /dash/.test(e)), true);
check('a missing fragment is caught', broken('about.html', '</main>', '<a href="#nowhere">x</a></main>').some((e) => /not on the page/.test(e)), true);
check('a sitemap URL with no page is caught', broken('sitemap.xml', '</urlset>', `<url><loc>${SITE}/ghost</loc></url></urlset>`).some((e) => /has no page/.test(e)), true);
check('an indexable page missing from the sitemap is caught', broken('sitemap.xml', `<url><loc>${SITE}/privacy</loc><lastmod>2026-10-14</lastmod></url>`, '').some((e) => /missing from the sitemap/.test(e)), true);
check('a duplicate id is caught', broken('about.html', '</main>', '<i id="main"></i></main>').some((e) => /duplicate ids/.test(e)), true);

console.log('\n== hosting config ==');
const vj = JSON.parse(vercelJson());
check('vercel.json carries only keys its schema allows', Object.keys(vj).sort(), ['$schema', 'cleanUrls', 'framework', 'headers', 'ignoreCommand', 'outputDirectory', 'trailingSlash']);
check('clean urls, no trailing slash', [vj.cleanUrls, vj.trailingSlash], [true, false]);
const policy = vj.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const hash = createHash('sha256').update(THEME_SCRIPT).digest('base64');
check('the CSP allows the theme script by its hash, and nothing inline else', policy.includes(`'sha256-${hash}'`) && !policy.includes('unsafe-inline'), true);
check('the CSP lets the form reach the main site and nothing else', /connect-src 'self' https:\/\/interndoor\.com(;|$)/.test(policy) && /form-action 'self' https:\/\/interndoor\.com(;|$)/.test(policy), true);
check('the committed vercel.json is the one the build writes', readFileSync(join(ROOT, 'blog', 'vercel.json'), 'utf8'), vercelJson());
check('csp() is what vercel.json carries', policy, csp());
check('sitemap refuses a duplicate URL', (() => { try { sitemapXml([{ path: '/a' }, { path: '/a' }]); return false; } catch { return true; } })(), true);

console.log('\n== drift guards ==');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const waIn = JSON.stringify(cfg).match(/"IN":\s*"(https:\/\/whatsapp\.com\/channel\/[^"]+)"/)?.[1];
check('the WhatsApp link is the channel in config.json', WHATSAPP_URL, waIn);
check('the email form posts to the endpoint that allows this origin', [SUBSCRIBE_ENDPOINT, BLOG_ORIGIN], ['https://interndoor.com/api/subscribe', SITE]);
check('the theme key is the board’s', /localStorage\.getItem\('theme'\)/.test(THEME_SCRIPT) && readFileSync(join(ROOT, 'src', 'pages.js'), 'utf8').includes(THEME_SCRIPT), true);
/* Hand-written posts only: imported (.html) articles are written to the AI
   instructions in Distribb, which carry the same rule, and a test that read
   them would fail the suite on content nobody here wrote. */
check('the posts name no listing source', readdirSync(join(ROOT, 'blog', 'content', 'posts')).filter((f) => f.endsWith('.md')).every((f) => !/\b(linkedin|greenhouse|lever\.co|ashby|workday|smartrecruiters|naukri|scrap(e|ed|ing|er))\b/i.test(readFileSync(join(ROOT, 'blog', 'content', 'posts', f), 'utf8'))), true);
check('the pages name no listing source', ['about', 'methodology'].every((f) => !/\b(linkedin|greenhouse|lever|ashby|workday|smartrecruiters|scrap(e|ed|ing|er))\b/i.test(readFileSync(join(ROOT, 'blog', 'content', 'pages', `${f}.md`), 'utf8'))), true);
check('a category is written for every category that has posts', Object.keys(CATEGORIES).every((c) => !res.posts.some((p) => p.category === c) || existsSync(join(outA, c, 'index.html'))), true);
{
  const posts = res.posts;
  const r = relatedFor(posts[0], posts);
  check('read next never offers the post itself', r.includes(posts[0]), false);
  check('read next honours the post’s own picks first', r[0].slug, posts[0].related[0] ?? r[0].slug);
}

rmSync(outA, { recursive: true, force: true });
rmSync(outB, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
