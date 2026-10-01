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
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { liCardModel, drawCard, drawDesign, renderLiCards, cardFile, cardDay, DESIGNS, CARD_W, CARD_H } from '../src/licard.js';
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
check('a country-first location names the city', liCardModel({ facts: { ...facts, location: 'India, Pune' } }).facts[0].value, 'Pune');
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
check('an experience range is not a duration on the card', liCardModel({ facts: { ...facts, duration: '1–4 years' } }).facts[1].small, '');
check('nor a zero-start range (the site\'s own filter)', liCardModel({ facts: { ...facts, duration: '0–6 months' } }).facts[1].small, '');
check('a real length is', liCardModel({ facts: { ...facts, duration: '1-6 months' } }).facts[1].small, '1-6 months');
check('spaced and dotted skill names are one name each',
  liCardModel({ facts: { ...facts, keySkills: ['React js', 'Next Js', 'Node.JS', 'AWS lambdas'] }, skills: '[]' }).skills,
  ['React', 'Next.js', 'Node.js', 'AWS Lambda']);
check('at most six facts', liCardModel({ facts: { ...facts, batch: '2027' }, experience: '0–1 years' }).facts.length <= 6, true);
/* India's labels write "30 Sept"; a three-letter month pattern dropped every
   September posting's day — the card said nothing and design #4 said "saved". */
check('a September posting keeps its day', liCardModel({ facts: { ...facts, postedLabel: 'Wed, 30 Sept, 11:14 pm' } }).facts.find((f) => f.label === 'Posted')?.value, '30 Sept');
check('the plain facts the other designs lay out', m.info,
  { city: 'Bengaluru', mode: 'Hybrid', kind: 'Internship', fullTime: false, batch: '', degree: '', experience: '', stipend: '', posted: '1 Oct' });
check('a card day in India\'s calendar, en-US month', cardDay(Date.UTC(2026, 8, 30, 20)), '1 Oct');

console.log('\n== four designs, and a file name the image route accepts ==');
/* 1 Oct 2026: "the current one is #1, others are #2, #3 and #4, i should have
   the full authority to choose anyone in the post generator page". */
check('four designs, numbered 1 to 4', DESIGNS.map((d) => d.n), [1, 2, 3, 4]);
check('the current cheat sheet is #1', DESIGNS[0].template, 'li-card.html');
check('every template is on disk', DESIGNS.every((d) => existsSync(join(ROOT, 'web', d.template))), true);
check('#1 keeps the name every card has had', cardFile('4474154255'), '4474154255.png');
check('the others take a suffix', [cardFile('4474154255', 2), cardFile('4474154255', 4)], ['4474154255-2.png', '4474154255-4.png']);
/* Careers-board ids carry colons, spaces, commas and even slashes, which the
   route refused and a filename cannot hold — so those posts showed no image. */
const routeGuard = new RegExp((readFileSync(join(ROOT, 'bin', 'queue-server.js'), 'utf8').match(/const SAFE_ID = \/(.+)\/;/) ?? [])[1] ?? '^$');
const odd = ['ats:workday:nvidia:wd5:NVIDIAExternalCareerSite:JR2025833', 'ats:x:Bengaluru, India (Hybrid)/12', '4474154255'];
check('the route guard was read out of the server', routeGuard.source.length > 3, true);
check('every name passes the /li/ route guard', odd.flatMap((id) => DESIGNS.map((d) => cardFile(id, d.n))).every((f) => routeGuard.test(f.replace(/\.png$/, ''))), true);
check('no name holds a slash', odd.every((id) => !cardFile(id, 3).includes('/')), true);
check('two ids never share a name', cardFile(odd[0], 2) !== cardFile(odd[1], 2), true);
check('and one id always gets the same one', cardFile(odd[0], 2) === cardFile(odd[0], 2), true);
for (const d of DESIGNS.slice(1)) {
  const t = readFileSync(join(ROOT, 'web', d.template), 'utf8');
  const mk = t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check(`#${d.n} ${d.name}: LinkedIn portrait 1080x1350`, /width:1080px;height:1350px/.test(mk.replace(/\s/g, '')), true);
  check(`#${d.n} ${d.name}: no InternDoor name, lime, radar or dark board`, /interndoor|#c8ff00|radar|#0a0a0b/i.test(mk), false);
  check(`#${d.n} ${d.name}: scraped text never goes in as HTML`, /innerHTML|insertAdjacentHTML|outerHTML/.test(mk), false);
  check(`#${d.n} ${d.name}: fill and fit are separate steps`, /window\.fill = /.test(mk) && /window\.fit = /.test(mk), true);
}

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
check('the draft saves its tip for the card', /saveDraft\([^)]*tip: built\.ai\.tip[,}]/.test(qs), true);
check('and the company\'s LinkedIn page for the @mention step', /saveDraft\([^)]*companyUrl \}\)/.test(qs) && /const companyUrl = await companyPageFor\(row\);/.test(qs), true);

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

  console.log('\n== designs #2-#4, drawn by the REAL drawDesign ==');
  const plain = liCardModel({ facts, tip: 'Lead with a Go project.' });
  const worstAll = liCardModel({
    facts: { ...facts, company: 'Jupiter Business Systems FZC International Private Limited',
      title: 'Interim Engineering Intern — Systems Software, Platform Reliability and Developer Productivity, Summer 2027',
      stipend: '₹1,25,000 – ₹1,75,000 / month', batch: '2026 / 2027', degreeText: 'B.Tech/M.Tech/MCA/M.Sc', bullets: [long, long, long],
      keySkills: ['Distributed Systems', 'Kubernetes', 'Infrastructure as Code', 'Observability', 'Python', 'Golang', 'Terraform', 'PostgreSQL'] },
    experience: '0–1 years',
    tip: 'A long tip that takes three lines: lead with the one project that shows the exact stack this posting names, and put its link in the first line of the resume.',
  });
  const measure = () => page.evaluate(() => {
    const card = document.getElementById('card');
    const right = card.getBoundingClientRect().right;
    return {
      fits: card.scrollHeight <= card.clientHeight + 0.5,
      wide: [...card.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > right + 1).map((e) => e.id || e.className || e.tagName),
      /* Marked has no #h1: "?." alone gives undefined, which is !== '' and
         reported every #4 card as shrunk. */
      shrank: card.style.getPropertyValue('--k') !== '' || (document.getElementById('h1')?.style.fontSize ?? '') !== '',
      sections: [...card.querySelectorAll('[id$="-sec"], #tip, #stand, #does')].map((e) => e.id),
      duties: card.querySelectorAll('#does li, #dek').length,
      k: parseFloat(card.style.getPropertyValue('--k') || '1'),
      tip: !!(document.getElementById('tip-sec') || document.getElementById('stand') || document.getElementById('tip')),
      imgs: card.querySelectorAll('img').length,
      text: card.textContent,
    };
  });
  for (const d of DESIGNS.slice(1)) {
    const t = readFileSync(join(ROOT, 'web', d.template), 'utf8');
    const okPlain = await drawDesign(page, t, plain, { today: '1 Oct' });
    const p = await measure();
    check(`#${d.n} an ordinary posting fits, and says it does`, [okPlain, p.fits, p.wide], [true, true, []]);
    check(`#${d.n} and keeps every section — nothing dropped that did not need to be`, p.shrank === false && /Lead with a Go project/.test(p.text), true);
    check(`#${d.n} all three duties are on it`, p.duties, 3);
    const okWorst = await drawDesign(page, t, worstAll, { today: '1 Oct' });
    const w = await measure();
    check(`#${d.n} the worst case fits, nothing past the edge`, [okWorst, w.fits, w.wide], [true, true, []]);
    check(`#${d.n} and the fixture actually REACHED the cap`, w.shrank || !/three lines/.test(w.text), true);
    check(`#${d.n} the employer and the role are still on it`, w.text.includes('Jupiter Business Systems') && w.text.includes('Interim Engineering Intern'), true);
    /* THE ORDER OF WHAT A CARD GIVES UP, which "it fits" alone never pinned:
       the text shrinks first, then the tip goes, and the work stays longest.
       Without these, deleting any one fit step still "fit" by giving up
       something else. */
    const longish = liCardModel({ facts: { ...facts, company: worstAll.company, title: 'Platform Reliability Engineering Intern',
      stipend: '₹1,25,000 – ₹1,75,000 / month', batch: '2026 / 2027', degreeText: 'B.Tech/M.Tech/MCA/M.Sc', bullets: [long, long, long],
      keySkills: ['Distributed Systems', 'Kubernetes', 'Infrastructure as Code', 'Observability', 'Python', 'Golang', 'Terraform', 'PostgreSQL'] },
      experience: '0–1 years', tip: 'Lead with a Go project that shows the exact stack this posting names.' });
    await drawDesign(page, t, longish, { today: '1 Oct' });
    const lg = await measure();
    check(`#${d.n} a long posting shrinks its text and keeps the tip`, [lg.fits, lg.k < 1, lg.tip], [true, true, true]);
    check(`#${d.n} the worst case gives up the tip before the work`, [w.tip, w.duties >= 2], [false, true]);
    const extreme = liCardModel({ facts: { ...facts, company: worstAll.company,
      title: 'Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year (2027) — Platform Reliability, Developer Productivity and Infrastructure Tools',
      stipend: '₹1,25,000 – ₹1,75,000 / month', batch: '2026 / 2027', degreeText: 'B.Tech/M.Tech/MCA/M.Sc', bullets: [1, 2, 3].map(() => long + ' and then some more words about it'),
      keySkills: ['Distributed Systems', 'Kubernetes', 'Infrastructure as Code', 'Observability', 'Python', 'Golang', 'Terraform', 'PostgreSQL'] },
      experience: '0–1 years', tip: 'A long tip that takes three lines: lead with the one project that shows the exact stack this posting names, and put its link in the first line of the resume.' });
    const okX = await drawDesign(page, t, extreme, { today: '1 Oct' });
    const x = await measure();
    /* The 172-character title the store really holds drives #2 and #3 to their
       last headline step; #4 gives up its duties instead (measured). */
    check(`#${d.n} the extreme case (a 170-character title) still fits`, [okX, x.fits, x.wide], [true, true, []]);
    if (d.n !== 4) check(`#${d.n} and still says what the work is`, x.duties >= 2, true);
    await drawDesign(page, t, liCardModel({ facts: { ...facts, company: '<img src=x onerror=alert(1)>' } }), { today: '1 Oct' });
    const h = await measure();
    check(`#${d.n} a hostile employer name is text, never markup`, [h.imgs, h.text.includes('<img src=x')], [0, true]);
  }
  /* A posting with no duties, no skills and no tip loses those HEADINGS too:
     a bare "what you'd actually do" over nothing reads as a broken card. */
  const bare = liCardModel({ facts: { ...facts, bullets: [], keySkills: [], tipFallback: '' }, skills: '[]', tip: '' });
  for (const d of DESIGNS.slice(1)) {
    await drawDesign(page, readFileSync(join(ROOT, 'web', d.template), 'utf8'), bare, { today: '1 Oct' });
    const left = await page.evaluate(() => document.getElementById('card').textContent.toLowerCase());
    check(`#${d.n} an empty section leaves no heading behind`, /what you.d|the work|put these|bring|skills|stand out|tip:/.test(left), false);
  }
  /* #4 claims only what is true of every card: a stated stipend was stated; an
     unstated one is ringed with no note — "not in the posting" would be a claim
     about text we may simply not have parsed. */
  const marked = readFileSync(join(ROOT, 'web', 'li-card-marked.html'), 'utf8');
  await drawDesign(page, marked, plain, { today: '1 Oct' });
  const unpaid = await page.evaluate(() => ({ ring: document.querySelector('.ring')?.textContent, notes: [...document.querySelectorAll('.note')].map((n) => n.textContent).join('|') }));
  check('#4 unstated pay is ringed "not disclosed"', unpaid.ring, 'not disclosed');
  check('#4 and carries no note claiming the posting omits it', /posting/.test(unpaid.notes), false);
  await drawDesign(page, marked, liCardModel({ facts: { ...facts, stipend: '₹25,000 / month' } }), { today: '1 Oct' });
  check('#4 stated pay is marked as stated', await page.evaluate(() => [...document.querySelectorAll('.note')].some((n) => n.textContent === '← stated in the posting')), true);
  check('#4 a posting date says "posted", a card with none says "saved"', [
    await page.evaluate(() => document.getElementById('hdr').textContent),
    (await drawDesign(page, marked, liCardModel({ facts: { ...facts, postedLabel: '' } }), { today: '3 Oct' }), await page.evaluate(() => document.getElementById('hdr').textContent)),
  ], ['Job description · posted 1 Oct', 'Job description · saved 3 Oct']);
  const clip = readFileSync(join(ROOT, 'web', 'li-card-clipping.html'), 'utf8');
  await drawDesign(page, clip, plain, { today: '1 Oct' });
  check('#3 reads an all-capitals word letter by letter', await page.evaluate(() => ['SDE Intern', 'JJT Intern', 'AI Engineer', 'Intern', 'University Intern', 'Backend Intern'].map((w) => window.article(w))),
    ['an', 'a', 'an', 'an', 'a', 'a']);
  check('#3 the headline is one sentence', await page.evaluate(() => document.getElementById('h1').textContent), 'Acme Labs is hiring a Backend Engineer Intern in Bengaluru.');

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

if (exe) {
  console.log('\n== renderLiCards writes every design, under the names the page asks for ==');
  const dir = mkdtempSync(join(tmpdir(), 'licards-'));
  try {
    const jobs = [{ id: '4470000001', facts }, { id: 'ats:workday:acme:wd1:Careers:JR1', facts }];
    const first = await renderLiCards(jobs, dir, { now: Date.UTC(2026, 9, 1, 6) });
    const want = jobs.flatMap((j) => DESIGNS.map((d) => cardFile(j.id, d.n))).sort();
    check('eight files, named by cardFile', readdirSync(dir).sort(), want);
    check('it returns each posting\'s #1', [...first.keys()], jobs.map((j) => j.id));
    const before = statSync(join(dir, cardFile(jobs[0].id, 3))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const again = await renderLiCards(jobs, dir);
    check('a file on disk is not drawn again', statSync(join(dir, cardFile(jobs[0].id, 3))).mtimeMs, before);
    check('and is still returned as that posting\'s #1', [...again.entries()].map(([k, v]) => [k, v.endsWith(cardFile(k, 1))]), jobs.map((j) => [j.id, true]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
