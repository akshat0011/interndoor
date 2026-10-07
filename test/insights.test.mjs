/**
 * The frozen monthly reports: src/insights.js and its pages.
 *
 * The properties that matter, each asserted:
 *  - a month is exactly [1st 00:00, next 1st 00:00) in the board's own zone;
 *  - a month is compiled only once it is fully tracked AND settled;
 *  - a stored snapshot is NEVER recompiled (a quoted figure must not move);
 *  - a thin month is remembered as thin;
 *  - the page is a pure function of the snapshot, carries no inline style,
 *    names no listing source, and every number in a finding is a count;
 *  - it is published, in the sitemap, and linked from the footer and the
 *    homepage.
 */
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import {
  monthBounds, completedMonths, compileMonth, ensureInsights, monthLabel, SETTLE_MS, MIN_SECTIONS,
} from '../src/insights.js';
import { renderInsightPage, renderInsightsIndex, insightLede, writePages, DEFAULT_REGION } from '../src/pages.js';
import { publishedPaths } from '../src/publish.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const cfg = loadConfig();
const D = 86_400_000, H = 3_600_000;
const IST = 'Asia/Kolkata';

/* ---- month arithmetic ---- */
{
  const [s, e] = monthBounds('2026-09', IST);
  ok('September in IST starts 31 Aug 18:30 UTC', new Date(s).toISOString() === '2026-08-31T18:30:00.000Z', new Date(s).toISOString());
  ok('…and ends 30 Sep 18:30 UTC', new Date(e).toISOString() === '2026-09-30T18:30:00.000Z', new Date(e).toISOString());
  const [ds, de] = monthBounds('2026-11', 'America/New_York');
  ok('a DST month in New York starts at local midnight (EDT)', new Date(ds).toISOString() === '2026-11-01T04:00:00.000Z', new Date(ds).toISOString());
  ok('…and ends at local midnight (EST)', new Date(de).toISOString() === '2026-12-01T05:00:00.000Z', new Date(de).toISOString());
  const [js] = monthBounds('2027-01', IST);
  ok('December rolls into January', new Date(monthBounds('2026-12', IST)[1]).getTime() === js);
  ok('label', monthLabel('2026-09') === 'September 2026');
}
{
  const tracked = Date.parse('2026-07-26T10:00:00Z');
  const [, sepEnd] = monthBounds('2026-09', IST);
  ok('a partly tracked month is never a report', !completedMonths(tracked, Date.parse('2026-12-01'), IST).includes('2026-07'));
  ok('settled months are listed', completedMonths(tracked, sepEnd + SETTLE_MS, IST).join() === '2026-08,2026-09');
  ok('a month inside its settling window is not', !completedMonths(tracked, sepEnd + SETTLE_MS - 1, IST).includes('2026-09'));
  ok('no tracking, no months', completedMonths(null, Date.now(), IST).length === 0);
}

/* ---- a board in memory: rows across September 2026, IST ---- */
const store = new Store(':memory:');
const [SEP0, SEP1] = monthBounds('2026-09', IST);
let seq = 0;
function put(o) {
  seq += 1;
  const id = o.id ?? String(4400000000 + seq);
  const firstSeen = o.firstSeen;
  store.db.prepare(`INSERT INTO jobs (job_id, title, company, location, first_seen_at, last_seen_at, first_run_id, posted_at,
      is_tech, suppressed_reason, employment_type, workplace_type, applicants, stipend_min, stipend_max, stipend_currency, stipend_period, salary_text, skills, region)
    VALUES (?, ?, ?, ?, ?, ?, 'r', ?, 1, NULL, 'intern', ?, ?, ?, ?, ?, ?, ?, ?, 'IN')`).run(
    id, o.title ?? `Software Engineer Intern ${seq}`, o.company, o.location ?? 'Bengaluru, Karnataka, India',
    firstSeen, firstSeen, firstSeen - 2 * H, o.mode ?? 'On-site', o.applicants ?? '10 applicants',
    o.min ?? null, o.max ?? null, o.currency ?? null, o.period ?? null, o.salaryText ?? null,
    JSON.stringify(o.skills ?? ['python', 'sql']));
  return id;
}
const COS = ['Siemens', 'Microsoft', 'Google', 'Valeo', 'Nvidia', 'Qualcomm'];
for (let i = 0; i < 60; i++) {
  put({
    company: COS[i % COS.length], firstSeen: SEP0 + 6 * H + i * 11 * H,
    location: i % 3 ? 'Bengaluru, Karnataka, India' : 'Hyderabad, Telangana, India',
    applicants: i % 5 ? '12 applicants' : 'Over 100 applicants',
    ...(i % 10 === 0 ? { min: 30000, max: 30000, currency: 'INR', period: 'month', salaryText: '₹30,000/month' } : {}),
  });
}
/* Tracking began in July, so September is fully tracked. */
put({ company: 'Siemens', firstSeen: Date.parse('2026-07-20T06:00:00Z') });
/* Edges: exactly the first instant is IN, exactly the end is OUT. */
const edgeIn = put({ company: 'Google', firstSeen: SEP0 });
const edgeOut = put({ company: 'Google', firstSeen: SEP1 });

const NOW = SEP1 + SETTLE_MS + H;
const snap = compileMonth(store, cfg, '2026-09', { region: 'IN', now: NOW });
ok('a 61-row month compiles', snap && snap.rows === 61, snap && snap.rows);
ok('the first instant of the month is counted, the end is not', snap.rows === 61 && edgeIn && edgeOut);
ok('employers counted', snap.employers === 6, snap.employers);
ok('stated stipends carried', snap.stated === 6, snap.stated);
ok(`at least ${MIN_SECTIONS} sections`, snap.sections.length >= MIN_SECTIONS, snap.sections.length);
ok('no newcomers section (it measures the watchlist, not the market)', !snap.sections.some((s) => s.id === 'newcomers'));
ok('compiledAt is the time passed in', snap.compiledAt === NOW);
ok('no section has a bar outside [0,1]', snap.sections.every((s) => s.bars.every((b) => b.share >= 0 && b.share <= 1)));
const emp = snap.sections.find((s) => s.id === 'employers');
ok('the busiest employer leads with its count of the month total', /: \d+ of 61\.$/.test(emp.finding), emp.finding);
ok('a thin month is null', compileMonth(store, cfg, '2026-08', { region: 'IN', now: NOW }) === null);

/* ---- ensureInsights: compile once, never again ---- */
{
  const fresh = ensureInsights(store, cfg, 'IN', NOW);
  ok('September is returned', fresh.length === 1 && fresh[0].month === '2026-09', fresh.map((s) => s.month).join());
  ok('August is remembered as thin', store.getSetting('insight:IN:2026-08') === 'thin');
  ok('September is stored', JSON.parse(store.getSetting('insight:IN:2026-09')).rows === 61);
  /* Add rows to September AFTER compiling: a frozen month must not move. */
  for (let i = 0; i < 5; i++) put({ company: 'Siemens', firstSeen: SEP0 + 2 * D + i * H });
  const again = ensureInsights(store, cfg, 'IN', NOW + 30 * D);
  const sep = again.find((s) => s.month === '2026-09');
  ok('a stored month is never recompiled', sep.rows === 61 && sep.compiledAt === NOW, `${sep.rows} @ ${sep.compiledAt}`);
  ok('…and a thin month is not re-mined', store.getSetting('insight:IN:2026-08') === 'thin');
  ok('newest first', again.map((s) => s.month).join() === [...again.map((s) => s.month)].sort().reverse().join());
  let threw = null;
  try { ensureInsights({ getSetting: () => null, setSetting() {}, db: { prepare: () => ({ get: () => ({ t: Date.parse('2026-07-01') }) }) } }, cfg, 'IN', NOW, { warn: (m) => { threw = m; } }); } catch (e) { threw = `THREW ${e.message}`; }
  ok('a compile failure warns and does not throw', threw && !threw.startsWith('THREW'), threw);
}

/* ---- the page ---- */
const html = renderInsightPage(snap, { region: DEFAULT_REGION });
ok('byte-stable for the same snapshot', html === renderInsightPage(JSON.parse(JSON.stringify(snap)), { region: DEFAULT_REGION }));
ok('canonical is /insights/2026-09', html.includes('<link rel="canonical" href="https://interndoor.com/insights/2026-09">'));
ok('indexable', !/name="robots" content="noindex/.test(html));
ok('no style= attribute (CSP)', !/\sstyle=/.test(html));
const bodyText = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
ok('names no listing source', !/linkedin|greenhouse|lever\b|ashby|workday|smartrecruiters|scrap/i.test(bodyText), (bodyText.match(/linkedin|greenhouse|workday|scrap/i) || [])[0]);
ok('the lede is the description', html.includes(`content="${insightLede(snap).replace(/&/g, '&amp;')}`) || html.includes(insightLede(snap)));
ok('says the figures are frozen', html.includes('These figures will not change.'));
ok('carries Article and Dataset markup', html.includes('"@type":"Article"') && html.includes('"@type":"Dataset"'));
ok('temporal coverage is the month', html.includes('"temporalCoverage":"2026-09-01/2026-09-30"'));
ok('a suggested citation with the URL', /Suggested citation:.*https:\/\/interndoor\.com\/insights\/2026-09/.test(html));
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? '';
ok('title ≤ 60 rendered chars', title.length > 0 && title.replace(/&amp;/g, '&').length <= 60, title);
ok('every bar is an SVG width attribute', (html.match(/class="ins-fill" width="\d+(\.\d)?"/g) || []).length === snap.sections.reduce((n, s) => n + s.bars.length, 0));
ok('older/newer links render', renderInsightPage(snap, { older: { month: '2026-08', label: 'August 2026' } }).includes('href="/insights/2026-08"'));
const idx = renderInsightsIndex([snap]);
ok('index links the month', idx.includes('href="/insights/2026-09"'));
ok('an empty index is noindex', /noindex/.test(renderInsightsIndex([])));

/* ---- written, mapped, linked, published ---- */
{
  const dir = mkdtempSync(join(tmpdir(), 'insights-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8'));
    writePages([], dir, [], { region: DEFAULT_REGION, insights: [snap] });
    ok('the month page is written', existsSync(join(dir, 'insights', '2026-09.html')));
    ok('the index is written', existsSync(join(dir, 'insights', 'index.html')));
    const sm = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
    ok('the month is in the sitemap', sm.includes('<loc>https://interndoor.com/insights/2026-09</loc>'));
    ok('…with its compiled day as lastmod', /insights\/2026-09<\/loc>\s*<lastmod>2026-10-0[23]<\/lastmod>/.test(sm), (sm.match(/insights\/2026-09<\/loc>\s*<lastmod>[^<]*/) || [])[0]);
    ok('the index is in the sitemap', sm.includes('<loc>https://interndoor.com/insights</loc>'));
    const home = readFileSync(join(dir, 'index.html'), 'utf8');
    ok('the homepage links the month', home.includes('href="/insights/2026-09"'));
    const page = readFileSync(join(dir, 'insights', '2026-09.html'), 'utf8');
    ok('foot() links the reports', page.includes('>The numbers</a> · <a href="/insights">Monthly reports</a>'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
ok('web/public/insights is published', publishedPaths().includes('web/public/insights'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
