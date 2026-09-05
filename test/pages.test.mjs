import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regionOf } from '../src/regions.js';
import { jobSlug, slugify, renderJobPage, renderCompanyPage, renderCompanyIndex, writePages, buildTitle, saysIntern, clampWords, companyProfile, placeSuffix, stipendText, verifiedAt, startDate, degreeLabel, placesOf, payRange, eligibilityCounts, ogCardName
} from '../src/pages.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const ats = { id: 'ats:greenhouse:alphagrepsecurities:8622004002', company: 'AlphaGrep Securities', title: 'Software Development Intern' };
const linkedin = { id: '4441247638', company: 'Adobe', title: 'AI Engineer Apprentice' };

console.log('\n== job slugs ==');
// A colon in the filename is what makes a Windows checkout of this repo fail.
check('ats id carries no colon', jobSlug(ats).includes(':'), false);
check('ats id is fully slugified', jobSlug(ats),
  'alphagrep-securities-software-development-intern-ats-greenhouse-alphagrepsecurities-8622004002');
// A numeric id survives slugify untouched, so no existing LinkedIn URL moves.
check('linkedin url is unchanged', jobSlug(linkedin), 'adobe-ai-engineer-apprentice-4441247638');
check('slug is filesystem-safe', /^[a-z0-9-]+$/.test(jobSlug(ats)), true);
/* SUPERSEDED 31 Aug. This pinned jobSlug({id:null}) === 'x-y-role', on the
   reasoning that a missing id should not leave a trailing dash. The reasoning
   was sound and the remedy was worse than the problem: a trailing dash is an
   obviously broken URL nobody would ship, while 'x-y-role' is a PLAUSIBLE one
   — and it shipped, as every link the WhatsApp channel sent for a day, each a
   404 whose preview card could not render either. A caller with no id has
   nothing to link to, so refusing is the only honest answer. */
check('a missing id throws rather than inventing a URL',
  (() => { try { jobSlug({ id: null, company: 'X', title: 'Y' }); return 'returned a slug'; } catch { return 'threw'; } })(),
  'threw');
/* Two Workday requisitions from one tenant differing only in their last
   characters. Capping the id at slugify's 70 would collide them onto one page.

   THE FIXTURE HAS TO EXCEED 70, AND THE OLD ONE DID NOT. It used a Piramal id
   whose slug is 66 characters, so a cap of 70 could never have touched it and
   both assertions below passed just as loudly against a truncating slugify —
   the limit they claim to pin was never reached. Caught by mutation on 2 Sep
   2026. This Rockwell shape slugs to 72 and its two variants differ only at
   characters 71-72, so a cap collides them: `slugify(a, 70) === slugify(b, 70)`
   is verified false-when-fixed, true-when-broken. Four real ids on the live
   boards are over 70, so this is a shipping shape, not a hypothetical. */
const wd = (n) => ({ company: 'Rockwell Automation', title: 'Intern', id: `ats:workday:rockwellautomation:wd1:External:ROCKWELL_AUTOMATION:R26-504${n}` });
check('the fixture actually reaches the cap', slugify(wd(2).id, Infinity).length > 70, true);
check('long ids are not truncated', jobSlug(wd(2)) !== jobSlug(wd(3)), true);
check('long id survives in full', jobSlug(wd(2)).endsWith('r26-5042'), true);

console.log('\n== slug parity with the browser copies ==');
// app.js and page.js each duplicate this function to link to the generated
// pages. If any copy drifts the site links to a 404, so all three are pinned.
function slugFrom(file) {
  const src = readFileSync(join(ROOT, 'web', 'public', file), 'utf8');
  const start = src.indexOf('function jobPageSlug(job) {');
  const end = src.indexOf('\n}', start);
  return new Function(`${src.slice(start, end + 2)}; return jobPageSlug;`)();
}

for (const file of ['app.js', 'page.js']) {
  const browserSlug = slugFrom(file);
  for (const job of [ats, linkedin, { id: 'x', company: 'Ford & Co', title: 'Intern — Data' }]) {
    check(`parity ${file}: ${job.company}`, browserSlug(job), jobSlug(job));
  }
}

/* applications.js IS THE FOURTH COPY and was not pinned here.
   It builds the slug from its own `slugPart` rather than an inline helper, so
   the extractor above cannot reach it — which is exactly why it was missed:
   the loop looked complete. Its shape differs too (an explicit `Infinity`
   branch instead of relying on `slice(0, Infinity)`), so it is the copy most
   likely to drift on an edit. A drift here breaks the "Posting" link on every
   tracked application, which is the one place a reader returns to weeks later. */
const appsSlug = (() => {
  const src = readFileSync(join(ROOT, 'web', 'public', 'applications.js'), 'utf8');
  const cut = (needle) => {
    const start = src.indexOf(needle);
    let i = src.indexOf('{', start), depth = 0, end = i;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}') { depth--; if (!depth) { end++; break; } }
    }
    return src.slice(start, end);
  };
  return new Function(`${cut('function slugPart(s, max) {')}; ${cut('function jobPageSlug(row) {')}; return jobPageSlug;`)();
})();
for (const job of [ats, linkedin, { id: 'x', company: 'Ford & Co', title: 'Intern — Data' },
  { id: 'y', company: '', title: '---' }, { id: 8, company: 'Numeric Id', title: 'Intern' }]) {
  check(`parity applications.js: ${job.company || '(empty)'}`, appsSlug(job), jobSlug(job));
}
// The id must survive whole here too, or a Workday pair collides on the tracker.
check('parity applications.js: long id not truncated',
  appsSlug(wd(2)) !== appsSlug(wd(3)), true);
check('parity applications.js: and matches the server slug',
  appsSlug(wd(2)), jobSlug(wd(2)));

console.log('\n== slugify ==');
check('ampersand becomes and', slugify('Ford & Co'), 'ford-and-co');
check('collapses punctuation', slugify('Intern — Data (Remote)'), 'intern-data-remote');
check('empty falls back', slugify(''), 'role');
check('caps length', slugify('a'.repeat(200)).length, 70);

console.log('\n== apply links ==');
const page = { ...linkedin, postedAt: Date.UTC(2026, 6, 1), firstSeenAt: Date.UTC(2026, 6, 1), bullets: ['a', 'b'] };
const withJs = renderJobPage({ ...page, applyUrl: 'javascript:alert(1)' });
check('javascript: url is not rendered', withJs.includes('javascript:alert(1)'), false);
check('no empty apply href', withJs.includes('href=""'), false);
const withHttps = renderJobPage({ ...page, applyUrl: 'https://www.linkedin.com/jobs/view/1' });
check('https url is rendered', withHttps.includes('href="https://www.linkedin.com/jobs/view/1"'), true);
// Checked on the machine-readable attribute, not the visible string: the
// visible one is a human date ("1 Jul 2026") and page.js rewrites the pill
// above it to a relative age, so pinning display text pins the design.
check('posted date is rendered', withHttps.includes('datetime="2026-07-01"'), true);
// The trap this whole file exists downstream of: postedText is frozen at scrape
// time and never ages, so a day-old posting kept reading "4 minutes ago".
check('postedText never reaches the page',
  renderJobPage({ ...page, postedText: '4 minutes ago' }).includes('4 minutes ago'), false);
// A row with no dates at all must not abort the whole publish step.
check('undated job still renders', typeof renderJobPage({ ...linkedin, bullets: [] }), 'string');

// ONE apply button, in the rail, plus the mobile dock's copy of it — and that
// is all. The rail is sticky on a desktop and the dock catches a phone reader
// who has scrolled past it, so a third copy in the how-to-apply band was never
// reachable at a moment neither of these was. Two identical primary buttons in
// the same column also cost the first one its weight.
check('exactly two apply buttons: the rail and the dock',
  withHttps.split('class="btn-apply"').length - 1, 2);
// Bounded at the rail, because both surviving buttons sit after the band in
// source order and an open-ended slice catches them.
const band = withHttps.slice(withHttps.indexOf('apply-band'), withHttps.indexOf('<aside class="jp-side"'));
check('the how-to-apply band carries no button', band.includes('btn-apply'), false);
check('but it still gives the advice', band.includes('applying early matters'), true);

// The label is just "Apply" — it used to name the destination.
check('the button says only Apply', withHttps.includes('<span>Apply</span>'), true);

// ...but naming the destination was not decoration. applyTarget() exists so
// nobody is told LinkedIn and sent to Workday, and dropping it from the label
// only moved that obligation to the line underneath. If this ever stops being
// true the page is quietly lying on the one click that matters.
check('the destination is still named on the page',
  withHttps.includes('Opens LinkedIn in a new tab'), true);
const offsite = renderJobPage({ ...page, applyUrl: 'https://boards.greenhouse.io/x/jobs/1' });
check('and it is the right destination for an off-site apply',
  // A plain ASCII apostrophe: applyTarget()'s strings are our own constants, not
  // scraped copy, so they go in unescaped and untouched.
  offsite.includes("Opens the company's site in a new tab"), true);

// The halo needs a wrapper to escape the button's own overflow:hidden, which
// the sheen requires. Only the rail gets one; the dock button stays plain.
check('the rail button is wrapped for its halo',
  withHttps.includes('<span class="apply-glow"><a class="btn-apply"'), true);
check('exactly one halo wrapper', withHttps.split('apply-glow').length - 1, 1);

console.log('\n== the page shows our summary, and only clean facts ==');

// The summary is our own writing about the posting — the field was in the data
// and unused, and it is the paragraph that decides whether anyone reads on.
const summarised = renderJobPage({ ...page, summary: 'Builds the payments API.' });
check('the summary is rendered', summarised.includes('Builds the payments API.'), true);
check('and it is escaped', renderJobPage({ ...page, summary: '<img src=x onerror=1>' })
  .includes('<img src=x'), false);

// Both fields carry mis-parsed values: "2,026" is a year that reached the money
// slot, and "0 to 3 years" is an experience requirement that reached the
// duration slot. Neither belongs in front of a student.
check('a stipend with no currency is dropped',
  renderJobPage({ ...page, stipend: '2,026' }).includes('2,026'), false);
check('a real stipend is kept',
  renderJobPage({ ...page, stipend: '\u20b925,000 / month' }).includes('25,000 / month'), true);
check('an experience range is not shown as a duration',
  renderJobPage({ ...page, duration: '0 to 3 years' }).includes('0 to 3 years'), false);
check('a real duration is kept',
  renderJobPage({ ...page, duration: '6 months' }).includes('6 months'), true);

console.log('\n== a job page offers somewhere else to go ==');

// The reason this exists: somebody arriving from a search has either applied or
// decided not to, and in both cases the next useful thing is another role.
const sibling = { id: '999', company: 'Adobe', title: 'Data Intern', bullets: ['a', 'b'],
  postedAt: Date.UTC(2026, 6, 2), firstSeenAt: Date.UTC(2026, 6, 2) };
const withSiblings = renderJobPage(page, [page, sibling]);
check('the employer\u2019s other role is linked',
  withSiblings.includes(`/jobs/${jobSlug(sibling)}`), true);
check('the page does not link to itself in that strip',
  withSiblings.split(`href="/jobs/${jobSlug(page)}"`).length - 1, 0);
check('the hub is always linked', withSiblings.includes('/companies/adobe'), true);
// The default has to keep working: the tests above all call it with one arg.
check('siblings are optional', typeof renderJobPage(page), 'string');

console.log('\n== every inline script is allowed by the CSP ==');

//==============================================================================
// The site ships a strict Content-Security-Policy with a `script-src` hash
// allowlist and no 'unsafe-inline'. An inline <script> whose hash is not in
// web/vercel.json is silently BLOCKED in production and works perfectly on
// every local server, because none of them send the header.
//
// That is exactly what happened on 21 Aug: the no-flash theme read was added
// to the generated pages' <head> and blocked on the live site, so a reader who
// chose light mode on the homepage got dark mode on every job page. Nothing in
// the local preview showed it.
//
// This computes the hash of what actually renders and checks it against the
// real vercel.json, so editing that one-liner by a single character fails here
// rather than in front of a user.
//==============================================================================
const csp = readFileSync(join(ROOT, 'web', 'vercel.json'), 'utf8');
const inlineScripts = [...renderJobPage(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

check('the page carries the inline scripts we expect', inlineScripts.length, 1);
for (const body of inlineScripts) {
  const hash = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
  check(`csp allows ${body.slice(0, 28)}\u2026`, csp.includes(hash), true);
}
// The hub and the directory share head(), so they must not drift from it.
// `live()` is declared further down, so this uses its own row.
const aRole = { id: 'a1', company: 'Adobe', title: 'AI Intern', bullets: ['a', 'b'],
  postedAt: Date.UTC(2026, 7, 1), firstSeenAt: Date.UTC(2026, 7, 1) };
for (const [name, html] of [['hub', renderCompanyPage('Adobe', [aRole], [])],
  ['directory', renderCompanyIndex(new Map([['Adobe', [aRole]]]))]]) {
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const allowed = bodies.every((b) => csp.includes(`sha256-${createHash('sha256').update(b, 'utf8').digest('base64')}`));
  check(`csp allows every inline script on the ${name}`, allowed, true);
}

/* THE BOARD'S OWN INLINE SCRIPTS WERE NEVER CHECKED. The block above covers
   the GENERATED pages, which is where the 21 Aug breakage happened — but
   web/public/index.html carries inline scripts too (the analytics stub, and
   the pre-paint gate that decides whether the intro plays), and nothing
   verified their hashes. A blocked script there is silent in exactly the same
   way: it works on every local server, because none of them send the header. */
const boardHtml = readFileSync(join(ROOT, 'web', 'public', 'index.html'), 'utf8');
const boardScripts = [...boardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('the board carries inline scripts to check', boardScripts.length >= 1, true);
for (const body of boardScripts) {
  const hash = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
  check(`csp allows the board's ${body.slice(0, 26).replace(/\s+/g, ' ')}\u2026`, csp.includes(hash), true);
}

/* INLINE STYLES WERE NEVER CHECKED, AND THAT COST THE WHOLE 404 PAGE.
   The block above hashes inline SCRIPTS. `style-src` is just as strict —
   'self' plus fonts.googleapis.com, no 'unsafe-inline' — and web/public/404.html
   shipped an inline <style> whose hash was never added. From 30 Aug the live
   404 rendered with NO layout: `.nf` was `block` instead of `flex`, the h1 fell
   back to the browser's 30px, and `.nf-go` had no background or padding, so the
   primary button was plain text. It worked in every preview, because no local
   server sends the header.
   This walks every HTML file the site actually ships. A `style=` attribute is
   blocked by the same directive, so those are refused outright rather than
   hashed — a hash has to be regenerated byte-exactly on every edit and its
   failure mode is silence. Put the rules in a stylesheet instead. */
console.log('\n== no shipped page carries an unallowlisted inline style ==');
{
  const styleSrc = (csp.match(/style-src ([^;]+)/) || [, ''])[1];
  check('style-src still has no unsafe-inline', styleSrc.includes("'unsafe-inline'"), false);

  const pub = join(ROOT, 'web', 'public');
  const htmlFiles = [];
  const walk = (dir, depth = 0) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      // The generated trees are enormous and all come from head(); one sample
      // of each is enough, and the hand-written root files are the real risk.
      if (e.isDirectory() && depth < 1 && !['logos', 'data', 'vendor', 'og'].includes(e.name)) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(pub);
  check('found shipped HTML to scan', htmlFiles.length > 0, true);

  const offenders = [];
  for (const f of htmlFiles) {
    const html = readFileSync(f, 'utf8');
    const rel = f.slice(pub.length + 1);
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const hash = `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`;
      if (!styleSrc.includes(hash)) offenders.push(`${rel} <style> ${hash}`);
    }
    if (/\sstyle="/.test(html)) offenders.push(`${rel} has a style= attribute`);
  }
  check('every inline style is allowed by the CSP', offenders.slice(0, 6), []);
}

/* THE INTRO OVERLAY MUST NOT SHARE A CLASS WITH THE FEED. app.js puts `intro`
   on the job list for its row entrance (.feed.intro .row), so an overlay class
   of `intro` matched the list as well — position:fixed and display:grid landed
   on it, and the cards laid out full-width down the middle of the screen. It
   settled correctly the moment the overlay finished, which is what made it
   invisible in a still and obvious only in a measurement. */
const boardCss = readFileSync(join(ROOT, 'web', 'public', 'styles.css'), 'utf8');
check('the overlay does not reuse the feed\'s class',
  /\[data-boot\][^{]*\.intro[\s{]/.test(boardCss), false);
check('and the feed keeps its own', boardCss.includes('.feed.intro .row'), true);

//==============================================================================
// Company hubs are PERMANENT.
//
// They used to be built only from live jobs and deleted the moment an
// employer's last posting aged out. 198 distinct hubs had been deleted against
// 83 live, and several flapped — piramal-pharma and bain-and-company were each
// deleted four times and rebuilt five. Every cycle 404s a URL Google has
// indexed and discards the ranking it had accrued.
//
// Job pages still expire; Google's JobPosting rules require that. Only the hub
// survives, carrying past roles so an empty one is not thin content.
//==============================================================================
console.log('\n== company hubs survive their postings ==');

const live = (title) => ({ id: `${title}-1`, company: 'Qualcomm', title, bullets: ['a', 'b'],
  postedAt: Date.UTC(2026, 7, 1), firstSeenAt: Date.UTC(2026, 7, 1) });
const past = (title, y, m) => ({ company: 'Qualcomm', title, roleLabel: '', postedAt: Date.UTC(y, m, 3) });

const emptyHub = renderCompanyPage('Qualcomm', [], [past('Systems Intern', 2026, 6), past('SW Intern', 2026, 5)]);
check('a hub with no live roles still renders', typeof emptyHub, 'string');
check('and names the employer', emptyHub.includes('Qualcomm internships in India'), true);
check('and shows what they have posted before', emptyHub.includes('Previously posted'), true);
check('and lists the past titles', emptyHub.includes('Systems Intern'), true);
check('and dates them to the month', emptyHub.includes('Jul 2026'), true);

// The whole point of keeping the page: it must still be indexable, or Google
// drops it just as surely as a 404 did.
check('two past roles is enough to index', emptyHub.includes('noindex'), false);
// ...but a hub with nothing behind it is thin, and thin is its own penalty.
const thinHub = renderCompanyPage('Qualcomm', [], [past('Systems Intern', 2026, 6)]);
check('a single past role is not', thinHub.includes('noindex'), true);
check('and neither is nothing at all', renderCompanyPage('Qualcomm', [], []).includes('noindex'), true);

console.log('\n== expired roles carry no JobPosting markup ==');
// Marking up a closed posting as a JobPosting is what earns a structured-data
// manual action, and that lands on the whole domain.
check('no JobPosting on a history-only hub', /JobPosting/.test(emptyHub), false);
check('past roles are not linked', /href="\/jobs\//.test(emptyHub), false);
// ItemList is only emitted for live roles.
check('no ItemList without live roles', /ItemList/.test(emptyHub), false);

console.log('\n== live and past do not duplicate ==');
const mixed = renderCompanyPage('Qualcomm', [live('Systems Intern')],
  [past('Systems Intern', 2026, 6), past('Older Intern', 2026, 4)]);
// Compare only the "Previously posted" section — the live title legitimately
// appears several times above it, in the list, the ItemList and the meta tags.
const pastSection = mixed.slice(mixed.indexOf('Previously posted'));
check('a title that is live is not repeated as past', pastSection.includes('Systems Intern'), false);
check('a genuinely past title still shows', pastSection.includes('Older Intern'), true);
check('a live hub does carry ItemList', /ItemList/.test(mixed), true);

console.log('\n== the index lists employers that are not hiring today ==');
const idx = renderCompanyIndex(
  new Map([['Adobe', [live('AI Intern')]]]),
  new Map([['Qualcomm', [past('a', 2026, 6), past('b', 2026, 5)]]]),
);
check('the hiring employer is listed', idx.includes('Adobe'), true);
check('so is the quiet one', idx.includes('Qualcomm'), true);
check('and it is labelled honestly', idx.includes('no live roles'), true);

console.log('\n== writePages keeps a hub whose jobs have all expired ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-pages-'));
  // Sweep one: the employer is hiring.
  writePages([live('Systems Intern')], dir, [past('Systems Intern', 2026, 6), past('Older', 2026, 4)]);
  const hub = join(dir, 'companies', 'qualcomm.html');
  check('hub written while hiring', existsSync(hub), true);

  // Sweep two: every posting has aged out of the live set. This is the exact
  // moment the file used to be deleted.
  writePages([], dir, [past('Systems Intern', 2026, 6), past('Older', 2026, 4)]);
  check('hub survives when nothing is live', existsSync(hub), true);
  check('and the expired job page is gone', existsSync(join(dir, 'jobs', 'qualcomm-systems-intern-systems-intern-1.html')), false);
  check('sitemap still carries the hub',
    readFileSync(join(dir, 'sitemap.xml'), 'utf8').includes('/companies/qualcomm'), true);

  // A company we have never published must not gain a page.
  check('no hub for an employer with no history', existsSync(join(dir, 'companies', 'adobe.html')), false);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== titles fit the SERP and do not repeat themselves ==');
// "Airmeet Outreach Campaign Intern Internship 2026 - India | InternDoor" was a
// real rendered title: 71 characters, with the word Internship in it twice.
check('a title already saying Intern is not given the word again',
  saysIntern('Outreach Campaign Intern'), true);
check('a title saying Internship is caught too', saysIntern('Golang Developer Internship in Noida'), true);
check('Trainee counts', saysIntern('Young Graduate Trainee'), true);
check('Apprentice counts', saysIntern('AI Engineer Apprentice'), true);
check('Co-op counts', saysIntern('Co-op/ Intern'), true);
check('a plain role does not', saysIntern('Software Engineer'), false);
// The head is what people search; it must never be the part that gets cut.
check('short title keeps every part and the brand',
  buildTitle(['Adobe Apprentice Tech Internship', 2026]),
  'Adobe Apprentice Tech Internship 2026 | InternDoor');
check('the year is dropped before the brand is',
  buildTitle(['AppVersal Golang Developer Internship in Noida', 2026]).endsWith('| InternDoor'), true);
check('nothing rendered exceeds the 60-character budget',
  buildTitle(['AppVersal Golang Developer Internship in Noida', 2026]).length <= 60, true);
// Real employer titles run to 112 characters. Cap them at a word boundary so
// the tail is our choice rather than Google's mid-word ellipsis.
check('an over-long head is capped at the budget',
  buildTitle(['American Express Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year (2026)', 2026]).length <= 60, true);
check('the cap lands on a word boundary',
  buildTitle(['American Express Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year (2026)', 2026]).endsWith(' '), false);
check('the company survives the cap',
  buildTitle(['American Express Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year (2026)', 2026]).startsWith('American Express'), true);
check('an unbroken over-long head is still cut to the budget',
  buildTitle(['A'.repeat(80), 2026]).length, 60);
check('falsy parts are skipped, not printed', buildTitle(['Zoho Internships', null, 2026]),
  'Zoho Internships 2026 | InternDoor');

console.log('\n== meta descriptions end on a whole word ==');
check('short text is returned untouched', clampWords('Adobe is hiring.', 155), 'Adobe is hiring.');
check('a long string is cut at a space, not mid-word',
  clampWords('Maintain GRC policies, documentation, and internal controls', 40).endsWith('internal'), false);
check('no dangling punctuation after the cut',
  /[,;:\\-]$/.test(clampWords('Bengaluru, Karnataka, India On-site, six months', 30)), false);
check('the result never exceeds the budget',
  clampWords('a'.repeat(200), 155).length <= 155, true);

console.log('\n== company profile aggregates an employer\'s whole history ==');
const hist = [
  { title: 'SDE Intern', postedAt: 1_700_000_000_000, location: 'Bengaluru, Karnataka, India',
    keySkills: ['Python', 'SQL'], degreeLevel: 'B.Tech', workplaceType: 'On-site', duration: '6 months', applicants: 40 },
  { title: 'Data Intern', postedAt: 1_702_000_000_000, location: 'Hyderabad, Telangana, India',
    keySkills: ['Python', 'Pandas'], degreeLevel: 'B.Tech', workplaceType: 'Hybrid', applicants: 100 },
  { title: 'ML Intern', postedAt: 1_704_000_000_000, location: 'Bengaluru, Karnataka, India',
    skills: ['Python'], degreeLevel: 'M.Tech', workplaceType: 'On-site', applicants: 10 },
];
const prof = companyProfile(hist);
check('counts every posting', prof.n, 3);
// keySkills is preferred over skills, or one verbose posting swamps the tally.
check('skills are ranked by how often they are asked for', prof.skills[0], { value: 'Python', count: 3 });
check('cities are ranked and de-duplicated', prof.cities[0], { value: 'Bengaluru', count: 2 });
check('a second city is still counted', prof.cities.length, 2);
check('degree levels are tallied', prof.degrees.map((d) => d.value).sort(), ['B.Tech', 'M.Tech']);
check('applicants use the median, not the mean', prof.medianApplicants, 40);
check('the earliest posting sets the start date', prof.firstPostedAt, 1_700_000_000_000);
// n=1 is the common case: 123 of 242 employers. It must not throw or invent.
const solo = companyProfile([{ title: 'Intern', postedAt: 1, location: 'Pune, India', keySkills: ['Go'] }]);
check('a single posting still profiles cleanly', solo.n, 1);
check('a single posting yields one city', solo.cities, [{ value: 'Pune', count: 1 }]);
check('an empty employer does not throw', companyProfile([]).n, 0);
check('null input does not throw', companyProfile(null).n, 0);
check('medianApplicants is null when nobody reported one', solo.medianApplicants, null);
// A real Infineon tally read "python 4 ... python programming 2" — one skill
// printed twice. The more-common phrase wins and the longer one is dropped.
const dup = companyProfile([
  { keySkills: ['python', 'python programming'], postedAt: 1 },
  { keySkills: ['python'], postedAt: 2 },
  { keySkills: ['python', 'sql'], postedAt: 3 },
]);
check('a phrase already covered by a commoner skill is dropped',
  dup.skills.map((x) => x.value), ['Python', 'SQL']);
check('acronyms are upper-cased, not Title-Cased',
  companyProfile([{ keySkills: ['sql', 'aws', 'fpga'], postedAt: 1 }]).skills.map((x) => x.value),
  ['AWS', 'FPGA', 'SQL']);
check('c++ gets its capital without losing its plusses',
  companyProfile([{ keySkills: ['c++'], postedAt: 1 }]).skills[0].value, 'C++');
// "HARMAN India in India" and "Accenture in India in India" were both rendered.
check('the region is not repeated when the name already carries it',
  placeSuffix('HARMAN India', { inName: 'in India' }), '');
check('and not repeated for "Accenture in India" either',
  placeSuffix('Accenture in India', { inName: 'in India' }), '');
check('an ordinary employer still gets the region',
  placeSuffix('Adobe', { inName: 'in India' }), ' in India');
check('mixed-case technology names survive intact',
  companyProfile([{ keySkills: ['Node.js', 'C++'], postedAt: 1 }]).skills.map((x) => x.value).sort(),
  ['C++', 'Node.js']);


console.log('\n== a role in many cities does not make many identical titles ==');
// Measured before this: 109 of 445 job pages shared a <title> with another,
// across 37 distinct titles — Procter & Gamble had TWENTY-TWO pages reading
// "Procter & Gamble Engineering Internship, Summer 2027". Search Console
// reports duplicate titles directly, and Google's response to a set of
// near-identical pages is to pick one and treat the rest as duplicates.
const titleOf = (html) => (html.match(/<title>(.*?)<\/title>/s) ?? [])[1]?.trim() ?? '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const mk = (id, title, location, company = 'Procter & Gamble') =>
  ({ id, company, title, location, postedAt: Date.UTC(2026, 7, 25), firstSeenAt: Date.UTC(2026, 7, 25), bullets: ['a', 'b'] });

const pgA = mk('1', 'Engineering Internship, Summer 2027', 'Mason, OH');
const pgB = mk('2', 'Engineering Internship, Summer 2027', 'Boston, MA');
const pgFam = [pgA, pgB];
check('twins get different titles', titleOf(renderJobPage(pgA, pgFam)) !== titleOf(renderJobPage(pgB, pgFam)), true);
check('and the city is what distinguishes them', titleOf(renderJobPage(pgA, pgFam)).includes('in Mason'), true);

// The 336 pages that were already unique must NOT change: a title rewrite on a
// page Google has settled on is churn for nothing, and `<company> <role>` is
// the part that matches what people search.
const lone = mk('3', 'Data Science Intern', 'Pune, Maharashtra, India', 'Zoho');
check('a role with no twin keeps its title', titleOf(renderJobPage(lone, [lone])).includes(' in '), false);

// A posting whose location is only the country resolves to the country, and
// "… in India" on the India board disambiguates nothing.
const countryOnly = [mk('4', 'Research Sciences INTERN', 'India', 'Microsoft'), mk('5', 'Research Sciences INTERN', 'India', 'Microsoft')];
check('the region name is not used as a city', titleOf(renderJobPage(countryOnly[0], countryOnly)).includes('in India'), false);

// The city is reserved room rather than appended, because buildTitle keeps the
// longest prefix that fits the BRAND and would drop a part added after a long
// head — which is exactly the part making the title unique.
const longFam = [
  mk('6', 'Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year', 'Mason, OH'),
  mk('7', 'Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year', 'Boston, MA'),
];
check('a very long title still gets its city', titleOf(renderJobPage(longFam[0], longFam)).includes('in Mason'), true);
check('and still fits the 60-char budget', decode(titleOf(renderJobPage(longFam[0], longFam))).length <= 60, true);

// A city cannot disambiguate postings that already share one, and making room
// for it costs title text. AbbVie files two long, DIFFERENT titles both in
// South San Francisco; clamping the head to fit " in South San Francisco" cut
// it to "AbbVie 2027 Business Technology" and turned two distinct titles into
// four identical ones.
const abbA = mk('10', '2027 Business Technology Solutions Intern - Cloud Engineering (Undergraduate)', 'South San Francisco, CA', 'AbbVie');
const abbB = mk('11', '2027 Business Technology Solutions Intern - Cloud Engineering (Undergraduate)', 'South San Francisco, CA', 'AbbVie');
const abbC = mk('12', '2027 Business Technology Solutions Intern - Data & Software Engineering (Undergraduate)', 'South San Francisco, CA', 'AbbVie');
const abbFam = [abbA, abbB, abbC];
check('same title in the SAME city gets no city suffix', titleOf(renderJobPage(abbA, abbFam)).includes('in South San Francisco'), false);
check('so the differing titles stay differing',
  titleOf(renderJobPage(abbA, abbFam)) !== titleOf(renderJobPage(abbC, abbFam)), true);

console.log('\n== a hub lists roles, not postings ==');
// The hub is the page Google serves for "<company> internships" and the only
// asset here that accumulates authority over years, since job pages expire.
// P&G's repeated one title 42 times.
const many = Array.from({ length: 22 }, (_, i) =>
  ({ ...mk(String(100 + i), 'Engineering Internship, Summer 2027', `City${i}, OH`), roleFingerprint: 'samehash11', bullets: ['a', 'b'], summary: 's' }));
const hub = renderCompanyPage('Procter & Gamble', many, [], '');
check('one card, not twenty-two', (hub.match(/class="role-card[ "]/g) ?? []).length, 1);
check('and it says how many cities', hub.includes('22 locations'), true);

// Different jobs filed under one title must stay apart — Emerson has seven
// "Graduate Engineer Trainee" postings that are five different roles.
const distinct = [
  { ...mk('200', 'Graduate Engineer Trainee', 'Pune, India', 'Emerson'), roleFingerprint: 'aaa', summary: 's' },
  { ...mk('201', 'Graduate Engineer Trainee', 'Pune, India', 'Emerson'), roleFingerprint: 'bbb', summary: 's' },
];
check('different roles under one title stay apart', (renderCompanyPage('Emerson', distinct, [], '').match(/class="role-card[ "]/g) ?? []).length, 2);


console.log('\n== a <title> is unique across BOARDS, not just within one ==');
// Jump Trading runs the same six campus roles in Chicago and in London, so
// /us/jobs/... and /uk/jobs/... rendered byte-identical titles: each page's
// collision check only ever saw the siblings on its own board. Seven pairs
// were colliding this way on the live site.
const US = regionOf('US'), GB = regionOf('GB');
const jtUs = mk('10', 'Campus Systems Engineer (Intern)', 'Chicago', 'Jump Trading');
const jtGb = mk('11', 'Campus Systems Engineer (Intern)', 'London', 'Jump Trading');
const jtUsPage = renderJobPage(jtUs, [jtUs], { region: US, foreign: [{ job: jtGb, region: GB }] });
const jtGbPage = renderJobPage(jtGb, [jtGb], { region: GB, foreign: [{ job: jtUs, region: US }] });
check('cross-region twins get different titles', titleOf(jtUsPage) !== titleOf(jtGbPage), true);
check('the US page names its city', titleOf(jtUsPage).includes('in Chicago'), true);
check('the UK page names its city', titleOf(jtGbPage).includes('in London'), true);
check('both still fit the budget',
  Math.max(decode(titleOf(jtUsPage)).length, decode(titleOf(jtGbPage)).length) <= 60, true);

// No rival anywhere must mean no change at all. Rewriting the title of a page
// Google has already settled on is churn for nothing, so the foreign list must
// not disturb the pages that were always unique.
const jtSolo = mk('12', 'Campus FPGA Engineer (Intern)', 'Chicago', 'Jump Trading');
check('a role with no rival on any board is untouched',
  titleOf(renderJobPage(jtSolo, [jtSolo], { region: US, foreign: [] })),
  titleOf(renderJobPage(jtSolo, [jtSolo], { region: US })));
check('and it carries no city', titleOf(renderJobPage(jtSolo, [jtSolo], { region: US })).includes(' in '), false);

// Each rival is judged in ITS OWN region, because the city suffix is dropped
// when it equals that region's name: "United Kingdom" is a city on the US board
// and is not one on the UK board. Judging a foreign rival in the local region
// would compare a title neither page will ever render.
const cfUs = mk('13', 'Network Strategy Intern', 'Austin, TX', 'Cloudflare');
const cfGb = mk('14', 'Network Strategy Intern', 'United Kingdom', 'Cloudflare');
check('the region name is still not used as a city on its own board',
  titleOf(renderJobPage(cfGb, [cfGb], { region: GB, foreign: [{ job: cfUs, region: US }] })).includes('in United Kingdom'), false);
check('while the other board still gets its city',
  titleOf(renderJobPage(cfUs, [cfUs], { region: US, foreign: [{ job: cfGb, region: GB }] })).includes('in Austin'), true);


// One role in two offices arrives as a single string. The second city is room
// the role text needs more than the title does.
const jtMulti = mk('15', 'Campus Quantitative Trader (Full-Time)', 'Chicago; New York', 'Jump Trading');
const jtMultiGb = mk('16', 'Campus Quantitative Trader (Full-Time)', 'London; Amsterdam', 'Jump Trading');
const multiUs = titleOf(renderJobPage(jtMulti, [jtMulti], { region: US, foreign: [{ job: jtMultiGb, region: GB }] }));
const multiGb = titleOf(renderJobPage(jtMultiGb, [jtMultiGb], { region: GB, foreign: [{ job: jtMulti, region: US }] }));
check('only the first city reaches the title', multiUs.includes('New York'), false);
check('and the role text survives', multiUs.includes('Quantitative Trader'), true);
check('the two boards still differ', multiUs !== multiGb, true);
check('each names its own first city', [multiUs.includes('in Chicago'), multiGb.includes('in London')], [true, true]);

console.log('\n== a "verified" badge is a claim we made a check ==');
// THE COLLECTOR DECIDES THIS. bin/poll-ats.js re-reads every ATS board every
// 30 minutes, so lastSeenAt on an ATS row genuinely means "seen on their board,
// then". A LinkedIn card falls out of the time-windowed search in ~90 minutes
// and is almost never re-encountered: measured on the live boards the median
// LinkedIn row has lastSeenAt === firstSeenAt and is 21h stale in the US, 293h
// in India. Saying "confirmed open" over that is not a stale number, it is a
// false statement about a check that never happened.
const HOUR = 3600000;
const atsFresh = { id: 'ats:greenhouse:x:1', lastSeenAt: Date.now() - 20 * 60000 };
const atsStale = { id: 'ats:greenhouse:x:2', lastSeenAt: Date.now() - 30 * HOUR };
const liFresh  = { id: '4441247638', lastSeenAt: Date.now() - 20 * 60000 };
check('a freshly-read ATS row can be confirmed', verifiedAt(atsFresh) !== null, true);
check('a LinkedIn row NEVER can, however recent', verifiedAt(liFresh), null);
check('a stale ATS reading is not a confirmation either', verifiedAt(atsStale), null);
check('a row with no reading at all is not', verifiedAt({ id: 'ats:greenhouse:x:3' }), null);

// And the rule has to survive into the rendered page, not just the helper.
const liveLi = { id: '999', company: 'Adobe', title: 'Backend Intern', location: 'Pune, India',
  postedAt: Date.UTC(2026, 7, 25), firstSeenAt: Date.UTC(2026, 7, 25), lastSeenAt: Date.now(),
  bullets: ['a', 'b'], summary: 's' };
/* PINNED ON THE CLASS, NOT THE WORDING. Every role card now carries an open
   state — an unverifiable row says "Likely open" rather than nothing — so
   asserting on the visible copy would pass for the wrong reason the moment
   either tier is reworded, and the negative assertion in particular would go
   quietly weak. The class is the contract: is-verified means we checked, and
   only an ATS row may ever carry it. */
const liHub = renderCompanyPage('Adobe', [liveLi], [], '');
check('a LinkedIn hub is never marked as confirmed', liHub.includes('vfy is-verified'), false);
check('but it does say the role is likely open', liHub.includes('vfy is-likely'), true);
const liveAts = { ...liveLi, id: 'ats:greenhouse:adobe:1' };
const atsHub = renderCompanyPage('Adobe', [liveAts], [], '');
check('a freshly-read ATS hub is marked confirmed', atsHub.includes('vfy is-verified'), true);
check('and is not double-marked as merely likely', atsHub.includes('vfy is-likely'), false);

console.log('\n== a US salary is not grouped the Indian way ==');
// The extractor groups lakh-first because that is right for the board it was
// written for. On the live US board 103 of 272 printable stipends carried it,
// and "$1,75,000" reads as a typo or as $1.75 — on the one figure most likely
// to decide whether somebody applies.
check('lakh grouping is regrouped on a dollar amount', stipendText({ stipend: '$1,75,000 – $2,50,000' }), '$175,000 – $250,000');
check('a plain dollar amount is untouched', stipendText({ stipend: '$85,000 / year' }), '$85,000 / year');
check('western millions are not mangled', stipendText({ stipend: '$1,000,000 / year' }), '$1,000,000 / year');
// Rupees are LEFT ALONE: lakh grouping is correct there and "12,00,000" is
// what an Indian posting means to write.
check('rupees keep Indian grouping', stipendText({ stipend: '₹12,00,000 / year' }), '₹12,00,000 / year');
check('an LPA figure is untouched', stipendText({ stipend: '4,50,000 LPA' }), '4,50,000 LPA');
check('a bare number is still refused', stipendText({ stipend: '2,026' }), '');
// 68 live rows held "₹0", 30 of them on the US board. Zero is missing data, not
// a wage — an employer that really pays nothing is recorded in stipendStatus.
check('a zero stipend is not an amount', stipendText({ stipend: '₹0' }), '');
check('nor is it with trailing space', stipendText({ stipend: '₹0 ' }), '');
check('nor "$0 / month"', stipendText({ stipend: '$0 / month' }), '');
check('but a real figure containing a zero survives', stipendText({ stipend: '₹20,000 / month' }), '₹20,000 / month');
// A range whose low bound is zero says "somewhere between nothing and X".
check('a range opening at zero is refused', stipendText({ stipend: '$0 – $1,000 / hour' }), '');
check('a zero-floor rupee range too', stipendText({ stipend: '₹0 - ₹15,000 / month' }), '');

console.log('\n== every office on a role, not the first comma-segment ==');
// "Chicago, IL or New York, NY" read as "Chicago", so a hub claimed one office
// while a role was genuinely open in two.
check('both offices survive', placesOf('Chicago, IL or New York, NY'), ['Chicago', 'New York']);
check('a plain location is unchanged', placesOf('Bengaluru, Karnataka, India'), ['Bengaluru']);
check('a slash-separated pair splits too', placesOf('London / Dublin'), ['London', 'Dublin']);
check('the comma does NOT split a city from its state', placesOf('Austin, TX'), ['Austin']);
check('an empty location yields nothing', placesOf(''), []);

console.log('\n== a start date is read from the title or not at all ==');
check('an explicit start is read', startDate({ title: 'Software Engineer – 2027 Internship Program (June Start)' }), 'Jun 2027');
check('and another', startDate({ title: 'Quantitative Trader – 2027 Graduate Program (February Start)' }), 'Feb 2027');
check('a title with no start says nothing', startDate({ title: 'Engineering Internship, Summer 2027' }), '');
check('a season is not treated as a month', startDate({ title: 'Summer Analyst 2027' }), '');

console.log('\n== a pay range is refused when it would be arithmetic on two questions ==');
const inr = { stipend: '₹25,000 / month' }, usd = { stipend: '$150,000 / year' };
check('mixed currencies produce no range', payRange([inr, usd]), null);
check('mixed periods produce no range', payRange([{ stipend: '$5,000 / month' }, usd]), null);
check('one currency and one period does', payRange([usd, { stipend: '$200,000 / year' }]).text, '$150k – $200k');
check('a single figure is not rendered as a range', payRange([usd]).text, '$150k');
check('nothing stated is null', payRange([{ stipend: '' }]), null);

console.log('\n== silence is not a refusal ==');
// A level no posting mentioned must never render as a cross. The postings did
// not exclude undergraduates; they said nothing, and turning that into a "no"
// talks somebody out of an application they were entitled to make.
const eg = eligibilityCounts([
  { degreeLevel: 'UG', degreeText: '' },
  { degreeLevel: 'UG/PG', degreeText: '' },
  { degreeLevel: 'PG', degreeText: 'Ph.D./Masters' },
]);
check('undergrad roles are counted', eg.ug, 2);
check('postgrad roles are counted', eg.pg, 2);
check('PhD is counted only where a posting says so', eg.phd, 1);
check('a bare PG does not become a PhD', eligibilityCounts([{ degreeLevel: 'PG', degreeText: '' }]).phd, 0);
const quiet = renderCompanyPage('Zoho', [{ id: '1', company: 'Zoho', title: 'Intern', location: 'Chennai, India',
  degreeLevel: 'UG', postedAt: Date.UTC(2026, 7, 25), firstSeenAt: Date.UTC(2026, 7, 25), bullets: ['a', 'b'], summary: 's' }], [], '');
check('an unstated level reads "Not stated", never a cross', quiet.includes('Not stated'), true);
check('and no cross is drawn anywhere', quiet.includes('✗'), false);

console.log('\n== the hub still says what it always said ==');
// The tracking sentence MOVED out of the hero; it must not have been dropped.
// It is the authority this page accumulates and the reason a hub outranks a
// job board's own listing page.
const tracked = Array.from({ length: 4 }, (_, i) => ({
  id: `ats:greenhouse:omc:${i}`, company: 'Old Mission Capital', title: `Role ${i}`,
  location: 'Chicago, IL', postedAt: Date.UTC(2026, 6, 1) + i * 86400000,
  firstSeenAt: Date.UTC(2026, 6, 1), lastSeenAt: Date.now(), bullets: ['a', 'b'], summary: 's',
  degreeLevel: 'UG', stipend: '$1,75,000 – $2,50,000',
}));
const omc = renderCompanyPage('Old Mission Capital', tracked, [], '');
check('the tracking sentence survives the move', omc.includes('We have tracked'), true);
check('the regrouped salary reaches the page', omc.includes('$175,000'), true);
check('and the lakh form does not', omc.includes('$1,75,000'), false);
check('breadcrumb markup is emitted', omc.includes('"BreadcrumbList"'), true);
// A bare Organization would assert this page IS the employer's. It is not.
check('the hub is a CollectionPage about them', omc.includes('"CollectionPage"'), true);
check('and never a bare Organization node', /"@type"\s*:\s*"Organization"\s*,\s*"name"[^}]*}\s*}\s*<\/script>/.test(omc) || omc.includes('"about"'), true);

console.log('\n== validThrough expires the day the page stops being served ==');
/* THE BUG THIS PINS. `validThrough` and the publish retention window were two
   separate hardcoded 14s. On 24 Aug publish.maxAgeDays was raised to 30 and
   pages.js's VALID_DAYS was not, so for the last sixteen days of its life every
   LinkedIn page served JobPosting markup saying it had ALREADY EXPIRED while
   staying indexable and in the sitemap — 99 pages were in that state when it
   was found, and an expired posting still being served is precisely what earns
   a structured-data manual action across the whole domain.

   So the window is passed in, and the number the site actually ships is the one
   in config.json. Asserting the default alone would pass again the next time
   only the config moves. */
const cfgJson = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const shipDays = cfgJson.publish?.maxAgeDays ?? 14;
const DAY = 86_400_000;
const vtOf = (html) => JSON.parse(
  html.match(/<script type="application\/ld\+json">(\{[\s\S]*?"@type": ?"JobPosting"[\s\S]*?)<\/script>/)[1]).validThrough;

const postedMs = Date.UTC(2026, 7, 1);
const vtJob = { ...linkedin, postedAt: postedMs, firstSeenAt: postedMs, lastSeenAt: postedMs,
  location: 'Bengaluru, Karnataka, India', bullets: ['One', 'Two'] };

/* The date is rounded to the END of its day (30 Aug) so an ATS row, whose
   lastSeenAt is refreshed every 30 minutes, stops rewriting its own JSON-LD on
   every publish. The DECISION this block pins is unchanged and is the one that
   matters — the window equals the retention window — so it is asserted on the
   DAY the page expires rather than the millisecond, plus the direction of the
   rounding, which is the half that carries the manual-action risk. */
const dayOf = (iso) => String(iso).slice(0, 10);

const vtDefault = vtOf(renderJobPage(vtJob));
check('the default window is the retention window',
  dayOf(vtDefault), dayOf(new Date(postedMs + shipDays * DAY).toISOString()));
check('and that is 30 days, not the old 14',
  dayOf(vtDefault), dayOf(new Date(postedMs + 30 * DAY).toISOString()));

/* CEIL, NEVER FLOOR. Flooring would claim the posting expired up to 24h before
   the page actually stops being served, which is precisely the 27 Aug bug: a
   served page whose validThrough has passed is what earns a structured-data
   manual action across the whole domain. */
check('it never expires before the page stops being served',
  Date.parse(vtDefault) >= postedMs + shipDays * DAY, true);
check('and not more than a day after it',
  Date.parse(vtDefault) - (postedMs + shipDays * DAY) < DAY, true);

// The caller decides, so a config change reaches the markup with no code edit.
check('an explicit window is honoured',
  dayOf(vtOf(renderJobPage(vtJob, [], { validDays: 45 }))),
  dayOf(new Date(postedMs + 45 * DAY).toISOString()));

/* An ATS row is anchored to lastSeenAt so its date moves with the board. A row
   still being polled must never advertise a date in the past. */
const seen = Date.now();
const atsLive = vtOf(renderJobPage({ ...ats, postedAt: postedMs, firstSeenAt: postedMs,
  lastSeenAt: seen, location: 'Bengaluru, Karnataka, India', bullets: ['One', 'Two'] }));
check('a still-listed ATS row expires in the future', Date.parse(atsLive) > Date.now(), true);

console.log('\n== a 30-minute ATS re-poll does not rewrite the page ==');
/* THE BUG THIS PINS, found 30 Aug. An ATS row is anchored to `lastSeenAt`,
   which the poller refreshes every 30 minutes. Three fields shipped that value
   at millisecond precision — `validThrough`, the job page's "checked <time>"
   (which also baked a RELATIVE label, "checked 3 minutes ago"), and a data-ago
   on both of the hub's verified elements — so a publish that changed nothing
   rewrote them anyway.

   Measured on a real publish commit: 206 of 217 changed job pages differed by
   NOTHING except those timestamps. At 48 publishes a day that is ~9,900 
   pointless page rewrites, 48 noise commits into a public repo, and ~13,000
   daily IndexNow announcements to Bing of pages that had not changed — which
   is the abuse that protocol asks you not to commit, and the opposite of what
   `writeIfChanged` returning a changed-set was built for.

   Nothing about the content changed between these two renders, so nothing
   about the bytes may either. This is the assertion the whole change exists
   to make true, and the one that will catch the next field that forgets. */
const pollT1 = Date.now();
/* Both reads must land in the same UTC day (the date legitimately rolls over
   once a day) and inside verifiedAt's 6h window, or this goes flaky at
   midnight. Clamping the earlier read to the start of today does both. */
const pollT0 = Math.max(pollT1 - 30 * 60_000,
  Date.parse(`${new Date(pollT1).toISOString().slice(0, 10)}T00:00:00.000Z`));
const polled = (seen) => ({ ...ats, postedAt: postedMs, firstSeenAt: postedMs, lastSeenAt: seen,
  location: 'Bengaluru, Karnataka, India', bullets: ['One', 'Two'], summary: 's' });

check('the job page is byte-identical across a re-poll',
  renderJobPage(polled(pollT0)) === renderJobPage(polled(pollT1)), true);
check('and so is the company hub',
  renderCompanyPage('AlphaGrep Securities', [polled(pollT0)], [], '')
  === renderCompanyPage('AlphaGrep Securities', [polled(pollT1)], [], ''), true);

/* The row is still genuinely confirmed — this must not pass by accident
   because the verified tier stopped rendering at all. */
check('and it still says it was confirmed',
  renderJobPage(polled(pollT1)).includes('jp-open is-verified'), true);

/* The three fields, pinned individually so a failure says WHICH one regressed
   rather than only that two blobs differ. */
const polledHtml = renderJobPage(polled(pollT1));
check('validThrough is rounded to the end of its day',
  /"validThrough":"[\d-]{10}T23:59:59\.000Z"/.test(polledHtml), true);
check('the checked date is a day, not a millisecond timestamp',
  /checked <time datetime="[\d-]{10}">/.test(polledHtml), true);
check('and carries no data-ago for page.js to rewrite',
  /checked <time[^>]*data-ago/.test(polledHtml), false);
check('the hub verified chip carries no data-ago',
  /vfy is-verified" data-ago/.test(
    renderCompanyPage('AlphaGrep Securities', [polled(pollT1)], [], '')), false);

console.log('\n== the sitemap dates content, not the clock ==');
/* THE BUG. lastmod was new Date() for the board, /companies, /alerts, /report
   and EVERY company hub — ~159 URLs a region — so all of them claimed to have
   changed at the moment of writing, on all 48 publishes a day. Three sitemaps
   rewritten in full every run into a public repo, and worse: GOOGLE ACTS ON
   LASTMOD only while it is accurate, so a site whose every URL claims it
   changed thirty minutes ago teaches crawlers to ignore the field site-wide —
   including on the job pages where it IS true and freshness is the product. */
const smDir = mkdtempSync(join(tmpdir(), 'sitemap-'));
const smJob = (over) => ({ ...linkedin, location: 'Bengaluru, Karnataka, India',
  bullets: ['One', 'Two'], summary: 's', ...over });
const smJobs = [
  smJob({ id: '1', company: 'Adobe', title: 'A', postedAt: Date.UTC(2026, 7, 20) }),
  smJob({ id: '2', company: 'Adobe', title: 'B', postedAt: Date.UTC(2026, 7, 28) }),
  smJob({ id: '3', company: 'Zoho', title: 'C', postedAt: Date.UTC(2026, 7, 11) }),
];
writePages(smJobs, smDir, [], {});
const sm = readFileSync(join(smDir, 'sitemap.xml'), 'utf8');

// Every date is a plain day. A minute in a sitemap is precision nobody uses
// and is the thing that made it move.
const stamps = [...sm.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
check('every lastmod is day-granular', stamps.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), true);
check('and there are dates to check', stamps.length >= 4, true);

// None of them is today-by-default: they come from the postings.
check('the board is dated by its freshest role',
  /<loc>https:\/\/interndoor\.com\/<\/loc><lastmod>2026-08-28</.test(sm), true);
check("a hub is dated by that employer's freshest role",
  /companies\/adobe<\/loc><lastmod>2026-08-28</.test(sm), true);
check('and a quieter employer keeps its own older date',
  /companies\/zoho<\/loc><lastmod>2026-08-11</.test(sm), true);

/* THE INVARIANT: two publishes with the same content produce the same bytes.
   This is the assertion the whole change exists to make true. */
const smDir2 = mkdtempSync(join(tmpdir(), 'sitemap-'));
writePages(smJobs, smDir2, [], {});
check('an unchanged board rewrites an identical sitemap',
  readFileSync(join(smDir2, 'sitemap.xml'), 'utf8') === sm, true);

console.log('\n== each posting carries its own preview image ==');
/* WHY. Every job page served the same generic og.jpg, so every share of every
   role looked identical — on the one element a reader sees before any text.

   IT IS A URL, NOT A FILE, and that is a storage decision rather than a
   preference: a committed card is ~46KB and will not compress further
   (measured at four quality levels and with the film grain removed), which is
   +44MB for today's board and ~1.7GB a YEAR of git history that cannot be
   pruned without rewriting a public repo. web/api/og.js draws it on request. */
const ogOf = (html) => (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
const twOf = (html) => (html.match(/<meta name="twitter:image" content="([^"]+)"/) || [])[1];

const carded = renderJobPage(vtJob);
/* The ampersand is written &amp; and that is CORRECT: a bare & in an HTML
   attribute is invalid markup, and every crawler decodes the entity before
   fetching. Asserting the raw form would be asserting broken HTML. */
check('the card is this posting\'s own', ogOf(carded),
  `https://interndoor.com/api/og?id=${vtJob.id}&amp;r=IN`);
// Two tags, one image: a preview that disagrees with itself between networks
// is worse than a generic one.
check('and twitter agrees with open graph', twOf(carded), ogOf(carded));
// EVERY posting, with nothing to check on disk first — the point of generating
// rather than committing.
check('no page falls back to the generic card', /og\.jpg/.test(carded), false);

/* The region travels with the id: the function reads that board's own
   jobs.json, and a card drawn from the wrong board is worse than none. */
check('a US page asks for the US board',
  ogOf(renderJobPage(vtJob, [], { region: regionOf('US') })),
  `https://interndoor.com/api/og?id=${vtJob.id}&amp;r=US`);

// An ats: id carries colons; it is a query parameter and has to survive as one.
check('the id is url-encoded',
  ogOf(renderJobPage({ ...vtJob, id: 'ats:greenhouse:x:1' })),
  'https://interndoor.com/api/og?id=ats%3Agreenhouse%3Ax%3A1&amp;r=IN');

/* ogCardName still exists for src/ogcard.js, which draws TELEGRAM's copies
   locally — the generator cannot see a posting until Vercel redeploys, about a
   minute, and that is exactly the window the channel exists for. */
check('a colon never reaches a filename',
  ogCardName('ats:greenhouse:towerresearchcapital:8143756'),
  'ats-greenhouse-towerresearchcapital-8143756.jpg');
check('the name never escapes its directory',
  /^[A-Za-z0-9_-]+\.jpg$/.test(ogCardName('../../etc/passwd')), true);

console.log('\n== the email signup is on every generated page ==');
/* It is on the GENERATED pages, not only the homepage, because that is where
   the traffic lands: somebody arriving from Google arrives on a job page. */
const subJob = renderJobPage(vtJob, [], { region: regionOf('US') });
const subHub = renderCompanyPage('Adobe', [vtJob], [], '');
check('the job page carries the form', subJob.includes('<form class="sub"'), true);
check('and so does the company hub', subHub.includes('<form class="sub"'), true);

/* The API is NOT region-prefixed. REGION_LINKS localises /jobs/ and /companies/
   and must never touch this, or the US board would post to /us/api/subscribe
   and 404. */
check('the action is the bare endpoint on a US page',
  /action="\/api\/subscribe"/.test(subJob), true);
check('and is not localised', subJob.includes('/us/api/subscribe'), false);

// The board is baked in at build time, not inferred at runtime.
check('the US page tags itself US', /data-region="US"/.test(subJob), true);
check('an India page tags itself IN',
  /data-region="IN"/.test(renderJobPage(vtJob, [], { region: regionOf('IN') })), true);

/* A real method and action, so a reader with no JavaScript still reaches the
   list rather than pressing a dead button. */
check('it degrades to a real POST', /method="post"/.test(subJob), true);

// The honeypot must stay out of the tab order and out of the a11y tree.
check('the honeypot is aria-hidden', /class="sub-hp" aria-hidden="true"/.test(subJob), true);
check('and is not tabbable', /name="company" tabindex="-1"/.test(subJob), true);
// The status line is announced, or a screen-reader user never learns it worked.
check('the reply is a live region', /class="sub-msg" role="status" aria-live="polite"/.test(subJob), true);

//==============================================================================
console.log('\n== the feed is dated by its newest item, not by the clock ==');
//==============================================================================
/* lastBuildDate was `new Date()`, so the feed was rewritten and committed on
   every 30-minute publish whether or not a posting had arrived. Measured over
   the last 40 commits that touched web/public/feed.xml: it changed in all 40,
   and in 20 of them that line was the only difference.
   The fixture is dated in the PAST on purpose. With a `new Date()` build stamp
   the two values differ by however long the suite has been running, so this
   fails immediately and deterministically rather than only when a render
   happens to straddle a second boundary. */
const feedDir = mkdtempSync(join(tmpdir(), 'interndoor-feed-'));
const feedAt = Date.UTC(2026, 6, 15, 9, 30, 0);
writePages([
  { id: 'f1', company: 'Acme', title: 'Newer Intern', location: 'Pune, India', bullets: ['a', 'b'], postedAt: feedAt },
  { id: 'f2', company: 'Acme', title: 'Older Intern', location: 'Pune, India', bullets: ['a', 'b'], postedAt: feedAt - 86_400_000 },
], feedDir, [], {});
const feedXml = readFileSync(join(feedDir, 'feed.xml'), 'utf8');
const builtAt = (feedXml.match(/<lastBuildDate>([^<]*)<\/lastBuildDate>/) || [])[1];
const firstPub = (feedXml.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1];
check('lastBuildDate is present', typeof builtAt, 'string');
check('and equals the newest item’s own pubDate', builtAt, firstPub);
check('which is the fixture date, not now', builtAt, new Date(feedAt).toUTCString());
// Nothing to date is said with silence rather than with a guess.
const emptyFeedDir = mkdtempSync(join(tmpdir(), 'interndoor-feed-empty-'));
writePages([], emptyFeedDir, [], {});
check('an empty feed carries no lastBuildDate at all',
  /<lastBuildDate>/.test(readFileSync(join(emptyFeedDir, 'feed.xml'), 'utf8')), false);
rmSync(feedDir, { recursive: true, force: true });
rmSync(emptyFeedDir, { recursive: true, force: true });

//==============================================================================
console.log('\n== the hub answer bar is a well-formed definition list ==');
//==============================================================================
/* A <div> inside a <dl> may contain ONLY <dt> and <dd>. The sub-line under
   each answer was a sibling <p>, which made the list malformed on all 319 hubs
   that render one — axe flags it `definition-list`, serious. It is inside the
   <dd> now.
   Asserted on the RENDERED HTML rather than on a helper, because answerBar is
   module-private and the bug was in the markup it emits, not in what it
   chooses to say. */
const dlHub = renderCompanyPage('Qualcomm', [
  { ...live('Systems Intern'), location: 'Bengaluru, Karnataka, India', workplaceType: 'On-site', degreeLevel: 'UG' },
  { ...live('SW Intern'), location: 'Bengaluru, Karnataka, India', workplaceType: 'On-site', degreeLevel: 'PG' },
], []);
const answerBarHtml = (dlHub.match(/<dl class="hub-answer">[\s\S]*?<\/dl>/) || [''])[0];
check('the answer bar renders at all', answerBarHtml.length > 0, true);
// The fixture has to actually produce sub-lines, or this pins nothing: a cell
// with no sub never emitted a <p> and passed just as loudly when it was broken.
check('and the fixture really produces sub-lines', /<p>/.test(answerBarHtml), true);
check('no <p> is a sibling of a <dd>', /<\/dd>\s*<p>/.test(answerBarHtml), false);
check('every sub-line sits inside its <dd>', /<p>[^<]*<\/p><\/dd>/.test(answerBarHtml), true);
// Nothing but <dt> and <dd> may be a direct child of the wrapping <div>.
check('each cell is exactly dt + dd',
  answerBarHtml.split('<div class="ans').slice(1)
    .every((c) => /^[^>]*>\s*<dt>[\s\S]*?<\/dt><dd>[\s\S]*?<\/dd><\/div>$/.test(c.replace(/<\/dl>$/, ''))), true);


console.log('\n== the hub role panel ==');
/* A role with pay and eligibility, and one with neither, because the panel is
   built by WITHHOLDING rows and a fixture that fills every row cannot show a
   row being withheld. */
const rich = {
  id: '991', company: 'Foo', title: 'Data Intern', roleLabel: 'Data Engineering',
  location: 'Bengaluru, Karnataka, India', workplaceType: 'On-site',
  stipend: '₹50,000/month', degreeText: 'Bachelor’s',
  bullets: ['Build pipelines', 'Write SQL', 'Ship dashboards', 'A fourth one'],
  keySkills: ['python', 'rest api'], postedAt: Date.UTC(2026, 7, 27),
};
const bare = { ...rich, id: '992', stipend: null, degreeText: null, keySkills: [] };

const panel = renderCompanyPage('Foo', [rich], [], '', { skillPages: new Set(['python']) });
const barePanel = renderCompanyPage('Foo', [bare], [], '', { skillPages: new Set() });

check('the panel is not one big anchor', /<a class="role-card"/.test(panel), false);
/* THE PAIRING. A chip is a link only where the facet page exists; everything
   else goes to the board search. Pointing every skill at /skills/<slug> ships
   a 404 for each of the ~1,900 skills with no page, which is the whole reason
   this check exists. */
check('a skill WITH a facet page links to it', panel.includes('/skills/python"'), true);
check('a skill WITHOUT one falls back to the board', /\/\?q=rest(%20|\+)api/.test(panel), true);
check('and never invents a facet URL for it', panel.includes('/skills/rest-api'), false);
check('chips are cased like every other surface', panel.includes('>Python</a>'), true);
check('duties are capped at three', (panel.match(/<li>[^<]*<\/li>/g) ?? [])
  .filter((l) => l.includes('Build pipelines') || l.includes('Write SQL')
    || l.includes('Ship dashboards') || l.includes('A fourth one')).length, 3);

console.log('\n== a fact is withheld, never guessed ==');
check('a stated stipend shows a row', panel.includes('<dt>Stipend</dt>'), true);
check('an absent one shows NO row', barePanel.includes('<dt>Stipend</dt>'), false);
check('an absent eligibility shows no row', barePanel.includes('<dt>Eligibility</dt>'), false);
check('but status and location always do',
  barePanel.includes('<dt>Status</dt>') && barePanel.includes('<dt>Location</dt>'), true);
check('no chip list at all when the role names no skills', barePanel.includes('rc-chips'), false);

console.log('\n== the masthead nav marks, and never drops, the current section ==');
const navBoard = readFileSync(join(ROOT, 'web', 'public', 'index.html'), 'utf8');
const navBoardOK = () => ['"/companies"', '"/skills"'].every((h) => navBoard.includes(h));
check('all three items are on a company hub',
  ['>Internships<', '>Companies<', '>Skills<'].every((x) => panel.includes(x)), true);
/* `true`, NOT `page`: a hub lives INSIDE the Companies section but is not
   /companies, so "current page" would be a lie — and the region switcher on a
   multi-region hub already emits an aria-current="page" of its own, so saying
   it here had two links both claiming to be this page. */
check('a hub marks the section as current, not as the page',
  /<a href="[^"]*\/companies" aria-current="true">Companies</.test(panel), true);
check('and never claims to BE the page', panel.includes('aria-current="page">Companies'), false);
check('while the directory itself does claim it',
  /<a href="[^"]*\/companies" aria-current="page">Companies</
    .test(renderCompanyIndex(new Map(), new Map(), new Map(), {})), true);
/* regionHref TRIMS the trailing slash (vercel.json sets trailingSlash:false),
   so the emitted href is /companies and not /companies/. That matters beyond
   cosmetics: localiseLinks matches REGION_LINKS as a quoted literal, so a
   trailing slash in the board template silently fails to localise and every
   /us and /uk masthead links at India's page. */
check('the nav href carries no trailing slash', panel.includes('href="/companies/"'), false);
check('so the board template can be localised at all',
  navBoardOK(), true);
check('exactly one nav item is current', (panel.match(/aria-current="(page|true)"/g) ?? []).length, 1);
check('the board template carries the same three',
  ['>Internships<', '>Companies<', '>Skills<'].every((x) => navBoard.includes(x)), true);
/* The board IS the internships list, so it marks that item rather than
   dropping it: a nav that loses an item on one page moves every other link. */
check('and the board marks Internships',
  /<a href="\/" aria-current="page">Internships</.test(navBoard), true);

console.log('\n== the answer sentence ==');
check('it answers the query before the list', /Yes, Foo is hiring interns/.test(panel), true);
check('and a hub with nothing open says so, without claiming otherwise',
  /no engineering internship open|is not advertising/.test(emptyHub), true);


console.log('\n== an ATS location code never reaches a reader ==');
/* Every fixture below is a REAL string off the live boards, which is the only
   reason the thresholds mean anything. The rule lives in placesOf, so the card
   cell, the answer grid and the sentence all get it from one place. */

/* TWO BULLETS OR THE ROW IS NOT INDEXABLE AND hubLive DROPS IT, which sends
   answerLine down its no-roles branch. The first draft of this fixture had
   none: every check below passed, and passed for the wrong reason, because no
   sentence ever named a place at all. */
const atPlace = (loc) => renderCompanyPage('Co', [{
  id: 'p1', company: 'Co', title: 'Intern', location: loc, workplaceType: null,
  bullets: ['Do the work', 'Do more of it'], postedAt: Date.UTC(2026, 7, 27),
}], [], '', {}).match(/<p class="hub-answer-line">([\s\S]*?)<\/p>/)[1].replace(/<[^>]*>/g, '');
check('the fixture is live enough to name a place',
  atPlace('Bengaluru, Karnataka, India').includes('is open'), true);

/* RECOVERED, not dropped. These are hierarchies with the settlement inside
   them, so refusing them throws away a real city the reader wants. */
for (const [raw, city] of [
  ['US-WA-Bellevue', 'Bellevue'],
  ['IN-INDIANAPOLIS', 'Indianapolis'],
  ['US - North Carolina - Holly Springs', 'Holly Springs'],
  ['Corporate 412 West - Springdale', 'Springdale'],
  ['GB-NU-CRAMLINGTON-ATLEY WAY NORTH NELSON INDUSTRIAL ESTATE', 'Cramlington'],
]) {
  const line = atPlace(raw);
  check(`recovered: ${raw.slice(0, 30)} -> ${city}`, line.includes(`based in ${city}`), true);
  check(`  and the raw code never appears`, line.includes(raw), false);
}

/* WITHHELD, because there is no settlement in there to find. A single segment
   is never mined: an earlier draft title-cased STORE SUPPORT CENTER into
   "Store Support Center" and printed a warehouse as a city. */
for (const junk of ['STORE SUPPORT CENTER', 'Remote Opportunity - United States',
  'Northern Regional Distribution Centre Annexe']) {
  check(`withheld: ${junk.slice(0, 34)}`, atPlace(junk).includes('based in'), false);
}
check('and a withheld place still leaves a correct sentence',
  /One engineering internship is open\./.test(atPlace('STORE SUPPORT CENTER')), true);

/* THE TRAILING CODE SEGMENT, pinned separately because NO LIVE STRING HAS THIS
   SHAPE TODAY: dropping the isCodeSegment filter left the suite green, since
   every real hierarchy on the boards puts its codes at the FRONT and the rule
   keeps the last survivor either way. It is still load-bearing. Without it
   "US - Cambridge - MA" resolves to "Ma", a title-cased state code printed as
   a city, which is the exact class of thing this whole cleaner exists to stop. */
check('a hierarchy ENDING in a code still yields the city',
  placesOf('US - Cambridge - MA'), ['Cambridge']);
check('and the same without spaces', placesOf('US-BELLEVUE-WA'), ['Bellevue']);

/* THE OTHER HALF, and the half that fails silently: a cleaner that refuses or
   rewrites everything passes all of the above. These must pass through
   COMPLETELY UNTOUCHED. `park` is the one that bit - University Park, Florham
   Park and Villa Park are real US towns, and an early facility-word list
   deleted every one of them. */
for (const town of ['Bengaluru', 'University Park', 'Florham Park', 'Villa Park',
  'Research Park', 'San Francisco Bay Area', 'Denver Metropolitan Area',
  'Mumbai Metropolitan Region', 'Greater Minneapolis-St. Paul Area']) {
  check(`untouched: ${town}`, placesOf(town), [town]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
