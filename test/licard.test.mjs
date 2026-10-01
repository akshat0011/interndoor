/* ============================================================
   The LinkedIn post image.

   WHY THIS FILE EXISTS. The fit loop has been wrong twice
   already, in both directions, and both times it LOOKED right:

     - measuring a container's scrollHeight against its own
       clientHeight is a tautology on an auto-height block, and
       the other card shipped every headline at its 40px floor
       for weeks because of it;
     - measuring against the CARD instead of the container said
       "fits" while the employer name was clipped by the lime
       band, because the left column is 531px of a 627px card.

   So the render assertion below draws the worst case through
   the REAL drawCard (src/licard.js) — not a copy of its loop —
   and checks the fixture actually shrank. A fit test whose
   fixture never reaches the cap tests nothing.

   Since 1 Oct 2026 the card is a COMPANY SNAPSHOT (portrait,
   src/companysnapshot.js): every figure on it is counted from
   the employer's own tracked postings.
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liCardModel, drawCard, CARD_W, CARD_H } from '../src/licard.js';
import { companySnapshot, statedPay } from '../src/companysnapshot.js';
import { logoOnDisk } from '../src/logos.js';
import { chromiumPath } from '../src/ogcard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const tpl = readFileSync(join(ROOT, 'web', 'li-card.html'), 'utf8');

console.log('\n== the template ==');
const flat = tpl.replace(/\s/g, '');
check('LinkedIn portrait 4:5, 1080x1350', /width:1080px;height:1350px/.test(flat) && [CARD_W, CARD_H].join('x') === '1080x1350', true);
check('the logo is CONTAINED, never cover', /object-fit:contain/.test(flat), true);
check('and cover appears nowhere', /object-fit:\s*cover/.test(tpl), false);
check('the band carries the call to action', /APPLY FREE/.test(tpl), true);
check('the band uses the live token, not a literal', /\.band\{[^}]*background:var\(--live\)/.test(flat), true);
check('the template ships no logo src of its own', /<img[^>]*src=/.test(tpl), false);
const src = readFileSync(join(ROOT, 'src', 'licard.js'), 'utf8');
/* Scraped employer names and titles go into a real browser: textContent only. */
check('the renderer never writes innerHTML', /innerHTML/.test(src), false);

console.log('\n== the snapshot counts the employer, and only what it stated ==');
const NOW = Date.UTC(2026, 9, 1, 6, 0);          // 1 Oct 2026, 11:30 IST
const rows = [
  { posted_at: Date.UTC(2026, 7, 20), key_skills: '["python","sql"]', location: 'Bangalore, Karnataka, India', stipend_min: 20000, stipend_max: 20000, stipend_currency: 'INR', stipend_period: 'month' },
  { posted_at: Date.UTC(2026, 8, 5), key_skills: '["python","aws"]', location: 'Bengaluru, Karnataka, India', stipend_min: 30000, stipend_max: 40000, stipend_currency: 'INR', stipend_period: 'month' },
  { posted_at: Date.UTC(2026, 8, 25), key_skills: '["python"]', location: 'Pune, Maharashtra, India', stipend_min: 900000, stipend_max: 900000, stipend_currency: 'INR', stipend_period: 'year' },
  { posted_at: NOW - 2 * 3_600_000, key_skills: '["sql"]', location: 'Bengaluru, Karnataka, India', salary_text: '₹0' },
];
const job = { company: 'Acme', title: 'Data Engineer Intern', location: 'Bengaluru, Karnataka, India', employment_type: 'internship' };
const snap = companySnapshot(job, rows, [{}, {}], NOW);
check('months run from the first one seen, zeros kept', snap.months.map((m) => `${m.label}${m.n}`), ['Aug1', 'Sep2', 'Oct1']);
check('the current month is marked', snap.months.at(-1).current, true);
check('tracked and open now', [snap.tracked, snap.openNow], [4, 2]);
check('skills ranked by how many postings name them', snap.skills.slice(0, 2), ['Python', 'SQL']);
check('cities are folded (Bangalore is Bengaluru)', snap.cities[0], { name: 'Bengaluru', n: 3 });
check('a ₹0 is never stated pay', statedPay(rows[3]), '');
check('the pay range uses ONE currency and period, never mixing month and year', snap.payRange?.text, '₹20,000 – ₹40,000 / month');
check('and says how many postings it rests on', snap.payRange?.n, 2);
check('one stating posting is no range', companySnapshot(job, [rows[0], rows[3]], [], NOW).payRange, null);
check('this role states nothing, so no pay of its own', snap.pay, '');

console.log('\n== the model picks the strongest true fact first ==');
const first = (o) => liCardModel({ snapshot: { ...snap, ...o } }).stats[0];
check('this role\'s own pay leads when stated', first({ pay: '₹25,000 / month' }).value, '₹25,000 / month');
check('else the employer\'s stated range', first({}).value, '₹20,000 – ₹40,000 / month');
check('else where most of its roles are', first({ payRange: null }).value, 'Bengaluru');
check('never a "0 of N state pay" tile', liCardModel({ snapshot: { ...snap, payRange: null, paid: 0 } }).stats.some((t) => /^0 of/.test(t.value)), false);
check('interns or freshers, by the posting\'s kind', [liCardModel({ snapshot: snap }).kicker.split(' · ')[0], liCardModel({ snapshot: { ...snap, kind: 'fulltime' } }).kicker.split(' · ')[0]], ['IS HIRING INTERNS', 'IS HIRING FRESHERS']);
check('a first-ever posting gets a sentence, not a one-bar chart', [liCardModel({ snapshot: { ...snap, tracked: 1 } }).months.length, /^The first Acme role/.test(liCardModel({ snapshot: { ...snap, tracked: 1 } }).first)], [0, true]);
check('a job with nothing still draws', Object.keys(liCardModel({ company: 'X', title: 'Y' })).includes('stats'), true);

console.log('\n== the caller resolves the logo from the PUBLISHED projection ==');
/* The first version built `/logos/${row.logo_url}`. That column holds the
   REMOTE LinkedIn CDN URL the logo was fetched from, so the path resolved to
   nothing and every card shipped a blank white plate — which reads as a broken
   design rather than a wrong field. The published projection's `logo` is the
   site path (/logos/nvidia.jpg), and it is what src/telegram.js already feeds
   the OG card. */
const qs = readFileSync(join(ROOT, 'bin', 'queue-server.js'), 'utf8');
// Generous window: the call carries an explanatory comment, and a tight one
// matched nothing — which fails LOUD here, but a laxer regex would have matched
// an empty string and passed against anything.
const at = qs.indexOf('renderLiCards(');
const call = at < 0 ? '' : qs.slice(at, at + 1400);
if (!call) { console.log('  FAIL  renderLiCards call not found in queue-server'); process.exit(1); }
// The `logo:` PROPERTY only. Asserting over the whole call matched the word
// logo_url inside the comment that explains why not to use it — the
// regex-matches-its-own-comment trap, for the second time in this repo.
const logoLine = (call.match(/^\s*logo:.*$/m) || [''])[0];
check('a logo property is passed at all', logoLine.length > 0, true);
check('it takes the logo from publicJob()', /publicJob\([^)]*\)\?\.logo/.test(logoLine), true);
check('and never builds a path out of logo_url', /logo_url/.test(logoLine), false);
/* THE PROJECTION IS NOT ENOUGH ON ITS OWN, and this is the common case rather
   than an edge. publicJob is a per-JOB lookup for a per-COMPANY file: a posting
   scraped at 18:26 is in the store immediately and does not reach jobs.json
   until the next publish, so for up to half an hour the lookup is null and the
   card ships the blank plate the comment above says it exists to prevent —
   observed live on HARMAN India, whose logo had been on disk since July. */
check('it falls back to the logo on disk', /logoOnDisk\(/.test(logoLine), true);
check('the fallback is keyed on the company, not the job id',
  /logoOnDisk\(\s*[^)]*compan/i.test(logoLine), true);

check('the caller passes the employer snapshot', /snapshot: companySnapshot\(row, employerRows\(row\), publishedJobs\(\)\.filter\(\(j\) => j\.company === row\.company\)\)/.test(qs), true);

console.log('\n== logoOnDisk reads the logo directory, with no network ==');
// Real files in web/public/logos, so a rename of the slug rule fails here.
check('resolves a company that has one', logoOnDisk('HARMAN India'), '/logos/harman-india.jpg');
check('the slug is case and space insensitive', logoOnDisk('harman   india'), '/logos/harman-india.jpg');
check('an unknown company is null, never a guessed path', logoOnDisk('No Such Company Zzz'), null);
check('a blank company is null', logoOnDisk(''), null);
check('undefined is null', logoOnDisk(undefined), null);

const exe = chromiumPath();
if (!exe) {
  console.log('\n  (no Playwright Chromium — render assertions skipped)');
} else {
  console.log('\n== the worst case, drawn by the REAL drawCard, still fits ==');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: CARD_W, height: CARD_H } });
  const worst = liCardModel({ snapshot: {
    ...snap,
    company: 'Jupiter Business Systems FZC International',
    title: 'Interim Engineering Intern — Systems Software, Platform Reliability and Developer Productivity, Summer 2027',
    city: 'Thiruvananthapuram', mode: 'Hybrid',
    pay: '₹1,25,000 – ₹1,75,000 / month',
    skills: ['Distributed Systems', 'Kubernetes', 'Infrastructure as Code', 'Observability', 'Python', 'Golang'],
  } });
  await drawCard(page, tpl, worst, '');
  const r = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const band = box(document.querySelector('.band'));
    const co = document.getElementById('co');
    const ttl = document.getElementById('ttl');
    const chips = [...document.querySelectorAll('.skills .chip')];
    return {
      nameFits: co.scrollWidth <= co.clientWidth + 0.5,
      nameShrank: parseFloat(getComputedStyle(co).fontSize) < 76,
      titleFits: ttl.scrollHeight <= ttl.parentElement.clientHeight + 0.5,
      statsFit: [...document.querySelectorAll('.stat b')].every((b) => b.scrollWidth <= b.clientWidth + 0.5),
      oneChipRow: chips.length > 0 && chips.every((c) => c.offsetTop === chips[0].offsetTop),
      chipsKept: chips.length,
      clearsBand: box(document.querySelector('.main')).bottom <= band.top + 0.5
        && [...document.querySelectorAll('.main > *')].every((el) => box(el).bottom <= band.top + 0.5),
    };
  });
  /* A figure that fits only once SHRUNK. The pay range above wraps whether or
     not the tile shrinks, so it cannot tell the shrink from its absence. */
  const city = liCardModel({ snapshot: { ...snap, pay: '', payRange: null, cities: [{ name: 'Visakhapatnam', n: 3 }] } });
  await drawCard(page, tpl, city, '');
  const t = await page.evaluate(() => {
    const b = document.querySelector('.stat b');
    return { text: b.textContent, size: parseFloat(getComputedStyle(b).fontSize), wrapped: b.style.whiteSpace === 'normal', fits: b.scrollWidth <= b.clientWidth + 0.5 };
  });
  await browser.close();
  check('a long city shrinks to its tile', [t.text, t.size < 46, t.fits], ['Visakhapatnam', true, true]);
  check('and stays on one line', t.wrapped, false);
  check('the long employer name fits its line', r.nameFits, true);
  check('and the fixture actually REACHED the cap (it shrank)', r.nameShrank, true);
  check('the long title fits its box', r.titleFits, true);
  check('every stat figure fits its tile', r.statsFit, true);
  check('skills are one row, never clipped', r.oneChipRow, true);
  check('and some survive', r.chipsKept > 0, true);
  check('nothing runs into the lime band', r.clearsBand, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
