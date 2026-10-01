/**
 * The company snapshot drawn on a LinkedIn post's image — 1 Oct 2026.
 *
 * His ask: "each post should have some eye catching image specifically for that
 * company like its hq, its salary breakdown or something like that". The card
 * now shows that EMPLOYER, not just the role: its hiring record by month, how
 * many roles it has open, what pay its postings state, the skills it asks for
 * and where it hires.
 *
 * EVERY FIGURE IS OURS, counted from the postings we have tracked. Nothing is
 * looked up and nothing is estimated. An HQ photograph was deliberately NOT
 * used: it belongs to a photographer or to the company, and a post under his
 * name is the wrong place to borrow one.
 *
 * Pure: the caller hands over the employer's stored rows and its live rows.
 */
import { formatStipend } from './extract.js';
import { canonicalCity } from './facets.js';
import { isZeroPay } from './postgen.js';

const MONTHS = 6;
/* IST, the board's zone: a posting at 01:00 IST on the 1st belongs to the new month. */
const IST_MS = 330 * 60_000;

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};

const SKILL_UPPER = new Set(['sql', 'aws', 'gcp', 'api', 'apis', 'css', 'html', 'ml', 'ai', 'nlp', 'ui', 'ux', 'etl', 'llm', 'llms', 'ci/cd', 'qa', 'os', 'iot', 'rtl', 'fpga', 'vlsi', 'oops', 'dsa', 'rest']);
function skillName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (SKILL_UPPER.has(s.toLowerCase())) return s.toUpperCase();
  return s.replace(/(^|[\s/-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}

/** A stated pay figure for a stored row, or '' — never a zero. */
export function statedPay(row) {
  const text = formatStipend({
    min: row.stipend_min, max: row.stipend_max, currency: row.stipend_currency, period: row.stipend_period,
  }) || row.salary_text || '';
  return text && /\d/.test(text) && !isZeroPay(text) ? text : '';
}

/**
 * @param {object}   job       the stored row the post is about
 * @param {object[]} rows      the employer's stored engineering rows on this board
 * @param {object[]} live      the employer's rows in the published jobs.json
 * @param {number}   now
 */
export function companySnapshot(job, rows = [], live = [], now = Date.now()) {
  const at = (r) => Number(r.posted_at ?? r.postedAt ?? r.first_seen_at ?? r.firstSeenAt ?? 0);
  const monthOf = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const thisMonth = monthOf(now);
  const label = (m) => new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });

  const counts = new Map();
  for (const r of rows) {
    const t = at(r);
    if (!t) continue;
    const m = monthOf(t);
    if (m > thisMonth - MONTHS && m <= thisMonth) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  /* From the first month we saw them in, so an employer new this month is not
     drawn as five empty months and one bar. */
  const firstSeen = rows.reduce((min, r) => (at(r) && at(r) < min ? at(r) : min), Infinity);
  const start = Math.max(thisMonth - MONTHS + 1, Number.isFinite(firstSeen) ? monthOf(firstSeen) : thisMonth);
  const months = [];
  for (let m = start; m <= thisMonth; m++) months.push({ label: label(m), n: counts.get(m) ?? 0, current: m === thisMonth });

  const skills = new Map();
  for (const r of rows) {
    for (const s of new Set(parseList(r.key_skills ?? r.keySkills).map((x) => String(x).toLowerCase().trim()).filter(Boolean))) {
      skills.set(s, (skills.get(s) ?? 0) + 1);
    }
  }
  const cities = new Map();
  for (const r of rows) {
    const c = canonicalCity(r.location);
    if (c) cities.set(c, (cities.get(c) ?? 0) + 1);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

  const paid = rows.filter((r) => statedPay(r)).length;
  /* THE PAY BREAKDOWN: the range the employer's own postings state, in the one
     currency-and-period most of them use — never mixing a monthly stipend with
     an annual salary. Two or more stating postings, or nothing. */
  const priced = rows.filter((r) => Number(r.stipend_min) > 0 && r.stipend_currency && r.stipend_period && !isZeroPay(statedPay(r)));
  const unit = top(new Map(Object.entries(priced.reduce((a, r) => { const k = `${r.stipend_currency}|${r.stipend_period}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}))), 1)[0];
  let payRange = null;
  if (unit && unit[1] >= 2) {
    const [currency, period] = unit[0].split('|');
    const same = priced.filter((r) => r.stipend_currency === currency && r.stipend_period === period);
    const lo = Math.min(...same.map((r) => Number(r.stipend_min)));
    const hi = Math.max(...same.map((r) => Number(r.stipend_max) || Number(r.stipend_min)));
    const text = formatStipend({ min: lo, max: hi, currency, period });
    if (text) payRange = { text, n: same.length };
  }
  const kind = job.employment_type === 'fulltime' ? 'fulltime' : 'intern';
  return {
    company: job.company ?? '',
    title: job.title ?? '',
    kind,
    city: canonicalCity(job.location) || '',
    mode: job.workplace_type || '',
    pay: statedPay(job),
    months,
    tracked: rows.length,
    since: months.length ? months[0].label : '',
    openNow: live.length,
    paid,
    payRange,
    skills: top(skills, 6).map(([s]) => skillName(s)),
    cities: top(cities, 3).map(([c, n]) => ({ name: c, n })),
    oneOff: rows.length <= 1,
  };
}

