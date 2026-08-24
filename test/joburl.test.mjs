import { parseAmazonPage, resolveJobUrl } from '../src/joburl.js';
import { resolveRegion } from '../src/regions.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

/**
 * The landmarks of a real amazon.jobs page, copied verbatim from job 10506481
 * on 24 Aug 2026 — the same discipline as test/cards.test.mjs. The point is
 * that a layout change fails the suite instead of a scheduled run.
 */
const PAGE = `<!DOCTYPE html><html><head>
<meta property="og:title" content="SDE I Intern , Amazon University Talent Acquisition" />
</head><body>
<h1 class="title" title="SDE I Intern , Amazon University Talent Acquisition">SDE I Intern , Amazon Universi…</h1>
<div class="meta">Job ID: 10506481 | ADCI - Karnataka</div>
<div class="container" id="job-detail-body"><div class="row">
<div class="col-12 col-md-7 col-lg-8 col-xl-9"><div class="content">
<div class="section description"></div>
<div class="section"><h2>Description</h2><p>Software Development Engineer 6 months Internship &#8211; 2027 (In-Person)<br/><br/>Introduction<br/>Our interns write real software with AWS &amp; distributed systems.</p></div>
<div class="section"><h2>Basic Qualifications</h2><p>- Enrolled in a Bachelor's or Master's degree.<br/>- Knowledge of data structures.</p></div>
<div class="section"><h2>Preferred Qualifications</h2><p>- Previous technical internship(s).</p></div>
</div></div>
<div class="col-12 col-md-5 col-lg-4 col-xl-3"><div class="sidebar"><div class="row">
<div class="col-12"><h2 class="job-details-title">Job details</h2></div>
<ul class="associations col-12"><li class="association-wrapper">
<div class="association location-icon"><span aria-label="location" role="img"></span>
<ul class="association-content"><li>IND, KA, Bengaluru</li><li>IND, TS, Hyderabad</li><li>IND, New Delhi</li></ul>
</div></li></ul>
</div></div></div>
</div></div></body></html>`;

const URL = 'https://www.amazon.jobs/en-gb/jobs/10506481/sde-i-intern-amazon-university-talent-acquisition';

console.log('\n== an amazon.jobs page ==');
const r = parseAmazonPage(PAGE, URL);
ok('reads the id out of the URL', r.job.id === '10506481');
// The heading text is clipped with an ellipsis on long titles; the attribute is not.
ok('takes the untruncated title from the attribute', r.job.title === 'SDE I Intern , Amazon University Talent Acquisition');
ok('the company is Amazon, not the legal entity on the page', r.company === 'Amazon');
// Same token the poller uses, so a page fetched by hand and the same posting off
// the board can never be stored twice under different ids.
ok('the token matches the board collector', r.provider === 'amazon' && r.token === 'IND');

console.log('\n== locations are reversed into a readable place ==');
// Amazon writes country-first, which is backwards from every other source.
ok('city first', r.job.location === 'Bengaluru, KA, India');
ok('the ISO-3 country gets its name back', !r.job.location.includes('IND'));
ok('the rest become alternates', r.job.locationAlt.length === 2);
ok('a two-part location still works', r.job.locationAlt.includes('New Delhi, India'));
// The whole reason for reversing: the gazetteer resolves city-first strings.
ok('the gazetteer can place it', resolveRegion(r.job.location, {}) === 'IN');

console.log('\n== the description ==');
ok('carries all three sections', /Introduction/.test(r.job.description)
  && /data structures/.test(r.job.description)
  && /Previous technical internship/.test(r.job.description));
// The sidebar is a sibling column; without cutting there the last section
// swallows "Job details" and every location.
ok('stops before the sidebar', !/Job details/.test(r.job.description));
ok('tags are stripped', !/<p>|<br/.test(r.job.description));
ok('entities are decoded', r.job.description.includes('AWS & distributed') && !r.job.description.includes('&amp;'));
// There is no posted date anywhere on an amazon.jobs page — checked against the
// live one. A posting with no date is kept, as the poller already does.
ok('no invented posted date', r.job.postedAt === null);

console.log('\n== a layout change fails loudly rather than storing junk ==');
let threw = null;
try { parseAmazonPage(PAGE.replace(/<h1[\s\S]*?<\/h1>/, ''), URL); } catch (e) { threw = e.message; }
ok('a missing title throws', /title/.test(threw ?? ''), String(threw));
threw = null;
const noSections = PAGE.replace(/<h2>(Description|Basic Qualifications|Preferred Qualifications)<\/h2>/g, '<h2>Something Else</h2>');
try { parseAmazonPage(noSections, URL); } catch (e) { threw = e.message; }
ok('losing every section throws', /description/.test(threw ?? ''), String(threw));
// Partial IS acceptable: Amazon does not always write both qualifications
// blocks, and one real section is a real description.
const onlyDesc = PAGE.replace(/<h2>(Basic|Preferred) Qualifications<\/h2>/g, '<h2>Something Else</h2>');
ok('one section is still enough', parseAmazonPage(onlyDesc, URL).job.description.includes('Introduction'));
ok('a non-amazon URL is not claimed', parseAmazonPage(PAGE, 'https://example.com/jobs/1') === null);

console.log('\n== dispatch, without touching the network ==');
const li = await resolveJobUrl('https://www.linkedin.com/jobs/view/4449259269/');
ok('a LinkedIn URL is refused', !!li.error);
// It needs a signed-in browser, which this tool deliberately does not open.
ok('and points at the tool that can do it', /add-job/.test(li.hint ?? ''));

const junk = await resolveJobUrl('https://careers.example.com/jobs/1');
ok('an unknown careers site is refused', junk.error === 'unrecognised careers site');
ok('and says what it does know', /amazon\.jobs/.test(junk.hint ?? '') && /greenhouse/.test(junk.hint ?? ''));
ok('a non-URL is refused', (await resolveJobUrl('not a url')).error === 'not a URL');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
