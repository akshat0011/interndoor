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

   Since 1 Oct 2026 the card is a JOB CHEAT SHEET: light, in the
   employer's own colour, with no InternDoor theme or element on
   it — his brief, after a branded first design.
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

console.log('\n== the template is not an InternDoor product ==');
/* Comments describe the history and name the brand; only markup and CSS count. */
const markup = tpl.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = markup.replace(/\s/g, '');
check('LinkedIn portrait 4:5, 1080x1350', /width:1080px;height:1350px/.test(flat) && [CARD_W, CARD_H].join('x') === '1080x1350', true);
check('no InternDoor name anywhere on it', /interndoor|intern<em>|INTERN/i.test(markup), false);
check('no board lime', /#c8ff00/i.test(markup), false);
check('no radar', /radar|sweep|ring/i.test(markup), false);
check('no dark board ground', /#0a0a0b/i.test(markup), false);
check('the logo is CONTAINED, never cover', /object-fit:contain/.test(flat) && !/object-fit:\s*cover/.test(markup), true);
check('the template ships no logo src of its own', /<img[^>]*src=/.test(markup), false);
check('sections never shrink (the title box once collapsed to 13px)', /\.main>\*\{flex:none\}/.test(flat), true);
const src = readFileSync(join(ROOT, 'src', 'licard.js'), 'utf8');
check('the renderer never writes innerHTML', /innerHTML/.test(src), false);

console.log('\n== what the card says ==');
const facts = { company: 'Acme Labs', title: 'Backend Engineer Intern', location: 'Bengaluru East, Karnataka, India',
  workplaceType: 'Hybrid', fullTime: false, duration: '6 months', postedLabel: 'Thu, 1 Oct, 8:36 am',
  keySkills: ['html5', 'javascript', 'Unix/Linux'], bullets: ['Build APIs', 'Write tests', 'Ship features', 'A fourth'],
  tipFallback: 'Keep a one-page PDF ready.' };
const m = liCardModel({ facts, skills: '["linux","css3","nodejs"]', tip: 'Lead with a Go project.', snapshot: { openNow: 5, payRange: null } });
check('interns pill', m.pill, 'Hiring interns');
check('the city is folded (Bengaluru East is Bengaluru)', m.facts[0], { label: 'Location', value: 'Bengaluru', small: 'Hybrid' });
check('the kind, with the duration', m.facts[1], { label: 'Type', value: 'Internship', small: '6 months' });
check('no stated pay says so — never "unpaid"', m.facts[2], { label: 'Stipend', value: 'Not disclosed' });
check('the posted day, not the clock', m.facts.find((f) => f.label === 'Posted')?.value, '1 Oct');
check('skills cased as the projects write them', m.skills.slice(0, 2), ['HTML5', 'JavaScript']);
check('and one skill a longer one already names is dropped', m.skills.includes('Linux') || m.skills.includes('linux'), false);
check('the extractor\'s skills follow', m.skills.includes('CSS3') && m.skills.includes('Node.js'), true);
check('at most three duties', m.does.length, 3);
check('the post\'s own tip', m.tip, 'Lead with a Go project.');
check('else the fallback tip', liCardModel({ facts }).tip, 'Keep a one-page PDF ready.');
check('the other roles open', m.more, '4 more open at Acme Labs');
check('one open role is no "more" line', liCardModel({ facts, snapshot: { openNow: 1 } }).more, '');
const paid = liCardModel({ facts: { ...facts, stipend: '₹25,000 / month' } });
check('a stated stipend is the pay fact, marked', paid.facts[2], { label: 'Stipend', value: '₹25,000 / month', pay: true });
const range = liCardModel({ facts, snapshot: { openNow: 0, payRange: { text: '₹20,000 – ₹40,000 / month', n: 2 } } });
check('else what the employer\'s other roles state', range.facts[2], { label: 'Stipend', value: 'Not stated', small: 'Other Acme Labs roles state ₹20,000 – ₹40,000 / month' });
const ft = liCardModel({ facts: { ...facts, fullTime: true }, experience: '0–1 years' });
check('freshers pill and a salary label', [ft.pill, ft.facts[2].label], ['Hiring freshers', 'Salary']);
check('stated experience is shown', ft.facts.find((f) => f.label === 'Experience')?.value, '0–1 years');
check('the site\'s clean title wins over the stored one', liCardModel({ facts: { ...facts, title: 'System Software Intern 2027 (Evergreen)' }, title: 'System Software Intern' }).title, 'System Software Intern');
check('ATS underscores become spaces, the words stay', liCardModel({ facts: { ...facts, title: 'DX S2R_Full Stack Developer_FY27Q2' } }).title, 'DX S2R Full Stack Developer FY27Q2');
check('a range from zero reads "Up to"', liCardModel({ facts: { ...facts, duration: '0–6 months' } }).facts[1].small, 'Up to 6 months');
check('a range from one is left alone', liCardModel({ facts: { ...facts, duration: '1-6 months' } }).facts[1].small, '1-6 months');
check('spaced and dotted skill names are one name each',
  liCardModel({ facts: { ...facts, keySkills: ['React js', 'Next Js', 'Node.JS', 'AWS lambdas'] }, skills: '[]' }).skills,
  ['React', 'Next.js', 'Node.js', 'AWS Lambda']);
check('at most six facts', liCardModel({ facts: { ...facts, batch: '2027' }, experience: '0–1 years' }).facts.length <= 6, true);

console.log('\n== the employer\'s pay range is honest ==');
const rows = [
  { stipend_min: 20000, stipend_max: 20000, stipend_currency: 'INR', stipend_period: 'month' },
  { stipend_min: 30000, stipend_max: 40000, stipend_currency: 'INR', stipend_period: 'month' },
  { stipend_min: 900000, stipend_max: 900000, stipend_currency: 'INR', stipend_period: 'year' },
  { salary_text: '₹0' },
];
const snap = companySnapshot({ company: 'Acme' }, rows, [{}, {}]);
check('one currency and period, never month mixed with year', snap.payRange, { text: '₹20,000 – ₹40,000 / month', n: 2 });
check('one stating posting is no range', companySnapshot({}, [rows[0], rows[3]]).payRange, null);
check('a ₹0 is never stated pay', statedPay(rows[3]), '');
check('roles open now', snap.openNow, 2);

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
const call = at < 0 ? '' : qs.slice(at, at + 3000);
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
check('the caller hands over the site\'s title, not the stored one', /\n\s*title: publishedTitle\(row\),\n/.test(qs), true);
check('and the post\'s facts, skills, experience and tip', /\n\s*facts,\n\s*skills: row\.skills,\n\s*experience: row\.experience,\n\s*tip: meta\?\.tip \?\? facts\.tipFallback,/.test(qs), true);
check('the draft saves its tip for the card', /saveDraft\([^)]*tip: built\.ai\.tip \}\)/.test(qs), true);

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
  console.log('\n== the worst case, drawn by the REAL drawCard, fits without clipping ==');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: CARD_W, height: CARD_H } });
  const long = 'A deliberately long duty about the work that runs past one line on the card';
  const worst = liCardModel({
    facts: { ...facts, company: 'Jupiter Business Systems FZC International Private Limited',
      title: 'Interim Engineering Intern — Systems Software, Platform Reliability and Developer Productivity, Summer 2027',
      stipend: '₹1,25,000 – ₹1,75,000 / month', batch: '2026 / 2027', bullets: [long, long, long],
      keySkills: ['Distributed Systems', 'Kubernetes', 'Infrastructure as Code', 'Observability', 'Python', 'Golang', 'Terraform', 'PostgreSQL'] },
    experience: '0–1 years',
    tip: 'A long tip that takes three lines: lead with the one project that shows the exact stack this posting names, and put its link in the first line of the resume.',
    snapshot: { openNow: 40, payRange: null },
  });
  /* A TWO-LINE TITLE KEEPS ITS SIZE. Measured against its own auto-height
     box, every multi-line title shrank to the floor. */
  await drawCard(page, tpl, liCardModel({ facts: { ...facts, title: 'Software Development Engineer Intern, Payments Platform' } }), '');
  const two = await page.evaluate(() => { const t = document.getElementById('ttl'); return { size: parseFloat(getComputedStyle(t).fontSize), lines: Math.round(t.getBoundingClientRect().height / (parseFloat(getComputedStyle(t).fontSize) * 1.04)) }; });
  check('a two-line title keeps its full size', [two.lines >= 2, two.size], [true, 74]);
  /* A flat YELLOW logo: the colour must be darkened until its text is readable. */
  const yellow = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ffd400"/></svg>').toString('base64');
  await drawCard(page, tpl, worst, yellow);
  const r = await page.evaluate(() => {
    const main = document.getElementById('main');
    const co = document.getElementById('co');
    const ttl = document.getElementById('ttl');
    const css = getComputedStyle(document.documentElement);
    const rgb = (v) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const text = rgb(css.getPropertyValue('--accent-text'));
    const paper = [251, 250, 247];
    const [x, y] = [lum(text), lum(paper)].sort((p, q) => q - p);
    return {
      fits: main.scrollHeight <= main.clientHeight + 0.5,
      nameFits: co.scrollWidth <= co.clientWidth + 0.5,
      nameShrank: parseFloat(getComputedStyle(co).fontSize) < 40,
      titleFits: ttl.getBoundingClientRect().height <= parseFloat(getComputedStyle(ttl.parentElement).maxHeight) + 0.5,
      titleBoxReal: ttl.parentElement.clientHeight >= parseFloat(getComputedStyle(ttl).fontSize),
      accent: css.getPropertyValue('--accent').trim(),
      textContrast: (x + 0.05) / (y + 0.05),
      checks: [...document.querySelectorAll('.check')].length,
      sections: ['skills-sec', 'does-sec', 'tip-sec'].filter((id) => document.getElementById(id)),
    };
  });
  await browser.close();
  check('the whole card fits — nothing past its foot', r.fits, true);
  check('the long employer name fits its line', r.nameFits, true);
  check('and the fixture actually REACHED the cap (it shrank)', r.nameShrank, true);
  check('the long title fits its box', r.titleFits, true);
  check('and the box is a real box, not a collapsed sliver', r.titleBoxReal, true);
  check('the accent is read off the logo, not the default blue', r.accent !== '#1f4fd8' && /255,\s*212,\s*0/.test(r.accent), true);
  check('and a yellow logo still gives readable text (4.5:1)', r.textContrast >= 4.5, true);
  check('the skills checklist survives', r.checks >= 4, true);
  check('what did not fit was DROPPED as whole sections', r.sections.includes('skills-sec'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
