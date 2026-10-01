/**
 * What the LinkedIn post image says about the EMPLOYER — 1 Oct 2026.
 *
 * Two facts, both counted from postings we tracked and nothing looked up:
 *   openNow   the employer's roles on the board right now ("12 more open at
 *             Google"), which tells a reader this one is not the only door;
 *   payRange  the range the employer's own postings state, in the ONE
 *             currency and period most of them use, from 2+ postings — what
 *             the card shows when this role states no pay of its own.
 *
 * Pure: the caller hands over the employer's stored rows and its live rows.
 */
import { formatStipend } from './extract.js';
import { isZeroPay } from './postgen.js';

/** A stated pay figure for a stored row, or '' — never a zero. */
export function statedPay(row) {
  const text = formatStipend({
    min: row.stipend_min, max: row.stipend_max, currency: row.stipend_currency, period: row.stipend_period,
  }) || row.salary_text || '';
  return text && /\d/.test(text) && !isZeroPay(text) ? text : '';
}

/**
 * @param {object}   job   the stored row the post is about
 * @param {object[]} rows  the employer's stored engineering rows on this board
 * @param {object[]} live  the employer's rows in the published jobs.json
 */
export function companySnapshot(job, rows = [], live = []) {
  /* Never mixing a monthly stipend with an annual salary: the unit most of
     the stating postings share, and only those. */
  const priced = rows.filter((r) => Number(r.stipend_min) > 0 && r.stipend_currency && r.stipend_period && statedPay(r));
  const units = new Map();
  for (const r of priced) { const k = `${r.stipend_currency}|${r.stipend_period}`; units.set(k, (units.get(k) ?? 0) + 1); }
  const unit = [...units].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  let payRange = null;
  if (unit && unit[1] >= 2) {
    const [currency, period] = unit[0].split('|');
    const same = priced.filter((r) => r.stipend_currency === currency && r.stipend_period === period);
    const lo = Math.min(...same.map((r) => Number(r.stipend_min)));
    const hi = Math.max(...same.map((r) => Number(r.stipend_max) || Number(r.stipend_min)));
    const text = formatStipend({ min: lo, max: hi, currency, period });
    if (text) payRange = { text, n: same.length };
  }
  return { company: job.company ?? '', tracked: rows.length, openNow: live.length, payRange };
}
