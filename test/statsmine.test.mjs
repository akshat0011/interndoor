/**
 * Facts about the board, mined from the store.
 *
 * These numbers get read ALOUD to strangers under the site's name, so the bar
 * is not "the query runs" — it is that the sentence survives being taken
 * literally. The first version of the gate fact read "23,740 listings were
 * turned away for every one we kept", which states a ratio of 23,740:1 when the
 * truth is 60:1: the raw total dressed up as a rate, wrong by the size of the
 * board, and perfectly plausible to anyone not checking.
 */
import { readFileSync } from 'node:fs';
import { mineStats, applicantCount, normaliseMode, DEFAULT_DAYS } from '../src/statsmine.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const ok = (label, cond) => check(label, !!cond, true);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 26, 12);

/** One posting, shaped as the jobs table stores it. */
const row = (over = {}) => ({
  job_id: String(Math.random()).slice(2), company: 'Acme', company_matched: 'Acme',
  title: 'Software Intern', location: 'Bengaluru, Karnataka, India', region: 'IN',
  is_tech: 1, workplace_type: 'On-site', stipend_status: 'unknown', applicants: null,
  key_skills: '["python"]', skills: '[]',
  posted_at: NOW - 2 * DAY, first_seen_at: NOW - 2 * DAY + 1800_000, ...over,
});

/** A store stub: mineStats only ever calls db.prepare(...).all/get. */
function stubStore(rows, cards = { refused: 0, seen: 0 }) {
  return {
    db: {
      prepare(sql) {
        if (sql.includes('FROM seen_cards')) return { get: () => cards, all: () => [] };
        return { all: () => rows, get: () => rows[0] ?? null };
      },
    },
  };
}

console.log('\n== the applicants column is TEXT ==');
// Documented trap: CAST('Over 100 applicants' AS INTEGER) is 0, so a naive
// comparison reports the most competitive listings as the least.
check('a plain count', applicantCount('7 applicants'), 7);
check('the clicked-apply phrasing', applicantCount('47 people clicked apply'), 47);
check('zero is zero, not missing', applicantCount('0 applicants'), 0);
check('"over 100" is MORE than 100', applicantCount('Over 100 applicants'), 101);
check('missing is null, not zero', applicantCount(null), null);

console.log('\n== every fact carries its denominator ==');
const many = Array.from({ length: 200 }, (_, i) => row({
  // 20 state a real figure. 20 more are MARKED unpaid by the model while
  // stating nothing — the case the pay fact must not repeat as a claim.
  ...(i < 20 ? { stipend_min: 20000, stipend_max: 20000, stipend_currency: 'INR', stipend_period: 'month' } : {}),
  stipend_status: i < 20 ? 'paid' : i < 40 ? 'unpaid' : 'unknown',
  applicants: i < 10 ? '0 applicants' : i < 30 ? '5 applicants' : `${100 + i} applicants`,
}));
const facts = mineStats(stubStore(many), { now: NOW });
check('facts were produced', facts.length > 0, true);
check('every fact has an `of`', facts.every((f) => Number.isFinite(f.of) && f.of > 0), true);
check('every fact names its window', facts.every((f) => f.days === DEFAULT_DAYS), true);
check('every fact is stamped', facts.every((f) => f.asOf === NOW), true);
// A number read three weeks later is no longer "this month".
check('and carries the region', facts.every((f) => f.region === 'IN'), true);

console.log('\n== a thin sample is DROPPED, not weakened ==');
// The company hubs already learned this: "typically" at n=1 is a lie, and a
// thin stat is not a softer stat but a false one.
check('nothing is claimed from 5 postings', mineStats(stubStore([row(), row(), row(), row(), row()]), { now: NOW }).length, 0);
check('nothing is claimed from an empty store', mineStats(stubStore([]), { now: NOW }).length, 0);

console.log('\n== pay transparency: what a POSTING SAYS, never what an employer pays ==');
/* These assertions used to pin the opposite — `stipend_status === 'paid'` for
   the count, and a sentence reading "20 of them are explicitly unpaid". That
   pin documented a DECISION, and the decision was wrong: measured on the live
   store, 58 India rows were marked `unpaid` over 30 days and 8 contained any
   unpaid phrasing at all. pages.js stopped rendering the field on 27 Aug;
   statsmine had not caught up, so `npm run stats` was still printing a
   first-person claim that named employers do not pay their interns. Re-pointed
   rather than deleted, and now pinned in BOTH directions. */
const pay = facts.find((f) => f.id === 'pay-transparency');
check('it counts postings that STATE a figure', pay.value, 20);
check('against the whole sample', pay.of, 200);
check('and names both numbers in the sentence', pay.headline.includes('20') && pay.headline.includes('200'), true);
ok('the other 180 are "said nothing", not "unpaid"', pay.detail.includes('180') && pay.detail.includes('nothing'));
ok('the word unpaid appears NOWHERE in the fact',
  !/unpaid/i.test(`${pay.headline} ${pay.detail}`));

/* A model-generated verdict must never reach the sentence. 60 rows marked
   `unpaid` and 60 marked `paid`, none stating a figure: the honest answer is
   that NOTHING is claimed, not that 60 employers pay nothing. */
const marked = Array.from({ length: 120 }, (_, i) => row({
  stipend_status: i < 60 ? 'unpaid' : 'paid',
}));
check('a store where only the MODEL says so claims nothing about pay',
  mineStats(stubStore(marked), { now: NOW }).some((f) => f.id === 'pay-transparency'), false);

/* ₹0 is missing data, not a wage — 68 live rows hold it. stipendText already
   refuses it, which is the whole reason the fact routes through that gate. */
const zeroes = Array.from({ length: 120 }, () => row({
  stipend_min: 0, stipend_max: 0, stipend_currency: 'INR', stipend_period: 'month',
  stipend_status: 'paid',
}));
check('a board of ₹0 rows states no pay fact',
  mineStats(stubStore(zeroes), { now: NOW }).some((f) => f.id === 'pay-transparency'), false);

/* Structural, so the field cannot creep back in via a new fact either.
   COMMENTS ARE STRIPPED FIRST: the module explains at length why it does not
   use this column, and that explanation is the thing most worth keeping — the
   assertion is that the field is never READ, not that it is never named. */
const statsSrc = readFileSync('src/statsmine.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
ok('src/statsmine.js never reads stipend_status in code', !statsSrc.includes('stipend_status'));
ok('…and the module still explains why, in prose',
  readFileSync('src/statsmine.js', 'utf8').includes('stipend_status'));

console.log('\n== the applicant facts parse before comparing ==');
const zero = facts.find((f) => f.id === 'no-applicants');
check('zero-applicant roles are counted', zero.value, 10);
check('against only the rows that REPORTED a count', zero.of, 200);
const crowded = facts.find((f) => f.id === 'crowded');
// 170 rows are "100+i applicants" for i >= 30, i.e. 130..299 — all over 100.
check('over-100 is counted correctly', crowded.value, 170);

console.log('\n== the gate states a RATIO, not a raw total ==');
// The bug this test exists for.
const gated = mineStats(stubStore(many, { refused: 12000, seen: 12400 }), { now: NOW });
const gate = gated.find((f) => f.id === 'the-gate');
check('the gate fact appears', !!gate, true);
check('the ratio is refused-per-kept', gate.ratio, 60);          // 12000 / 200
check('the headline states the ratio', gate.headline.includes('60'), true);
check('and NOT the raw total as a rate',
  /12,?000 listings were turned away for every/.test(gate.headline), false);
check('the raw total survives in the detail', gate.detail.includes('12,000'), true);
// Below the floor there is no story, only noise.
check('a quiet window produces no gate fact',
  mineStats(stubStore(many, { refused: 12, seen: 40 }), { now: NOW }).some((f) => f.id === 'the-gate'), false);
// BOTH sides of the ratio have to be solid. Refused cards pile up fast enough
// to clear their own floor in a single day while the kept side is a handful,
// and dividing by a handful gave "about 100 for every one" over one day
// against "about 60" over thirty — same board, two different claims.
const thinKept = Array.from({ length: 12 }, () => row());
check('a fat refused count against a thin kept count is dropped',
  mineStats(stubStore(thinKept, { refused: 12000, seen: 12400 }), { now: NOW }).some((f) => f.id === 'the-gate'), false);

console.log('\n== speed uses the median, not the mean ==');
// One posting scraped days late from a backfill drags a mean into
// meaninglessness, and this number is the site's central promise.
const skewed = Array.from({ length: 100 }, (_, i) => row({
  posted_at: NOW - DAY,
  first_seen_at: NOW - DAY + (i === 99 ? 40 * 3600_000 : 20 * 60_000),
}));
const speed = mineStats(stubStore(skewed), { now: NOW }).find((f) => f.id === 'speed');
check('one 40-hour outlier does not move it', speed.value, 20);
check('and it reads as minutes under 90', speed.headline.includes('20 minutes'), true);

console.log('\n== modes are normalised before counting ==');
check('On-site', normaliseMode('On-site'), 'On-site');
check('onsite is the same thing', normaliseMode('onsite'), 'On-site');
check('Remote', normaliseMode('remote'), 'Remote');
check('blank is null, not a category', normaliseMode(''), null);
const modes = Array.from({ length: 100 }, (_, i) => row({ workplace_type: i < 50 ? 'onsite' : i < 90 ? 'On-site' : 'Remote' }));
const rem = mineStats(stubStore(modes), { now: NOW }).find((f) => f.id === 'remote');
check('the two on-site spellings are one bucket', rem.detail.includes('90 are on-site'), true);
check('and remote is the 10%', rem.headline.includes('10%'), true);

console.log('\n== nothing is invented ==');
// Every headline must be reconstructible from value/of. A sentence carrying a
// number that is in neither is a number a model would have to trust blind.
for (const f of facts) {
  const nums = (f.headline.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
  // value, denominator, ratio, the percentage of the two, and any threshold the
  // fact declares. A number outside that set is one nobody can check.
  const known = new Set([f.value, f.of, f.ratio, f.threshold,
    Math.round((f.value / f.of) * 100)].filter((n) => n != null));
  check(`${f.id}: every number in the headline is derived`, nums.every((n) => known.has(n)), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
