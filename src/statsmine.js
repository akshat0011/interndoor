/**
 * Facts about the board, mined from the store.
 *
 * A reel about ONE job is Format A and it is built. The other formats need
 * something to be about, and the only material nobody else has is what this
 * scraper has been quietly accumulating: 2,000 postings, 27,000 refused cards
 * and 1,400 runs. "Only 47 of 398 engineering internships said what they pay"
 * is a fact no other account in this space can state, because no other account
 * has the denominator.
 *
 * WHAT THIS IS FOR: handing the model a FACT, not a topic. A model asked to
 * write about "internships in India" produces slop at any volume; a model
 * handed "47 of 398, and 48 of them are explicitly unpaid" writes something
 * only this account could. That distinction is the whole reason this file
 * exists rather than a prompt.
 *
 * FOUR RULES, and each of them is a bug that would otherwise ship:
 *
 * 1. **EVERY FACT CARRIES ITS DENOMINATOR.** "23 roles have no applicants" is
 *    not a fact, it is a number. Of 274 it is reassuring; of 30 it is a
 *    warning. `of` is not optional and `headline` must name it.
 * 2. **A FACT BELOW ITS MINIMUM SAMPLE IS DROPPED, NOT WEAKENED.** The company
 *    hubs already learned this: 123 of 242 employers have exactly one posting,
 *    and "typically" at n=1 is a lie. A thin stat is not a softer stat, it is a
 *    false one.
 * 3. **`applicants` IS TEXT.** It holds "47 people clicked apply", "0
 *    applicants" and "Over 100 applicants", and `CAST('Over 100…' AS INTEGER)`
 *    is 0. Every comparison here parses first. This has already produced one
 *    confident wrong answer in this project.
 * 4. **NOTHING HERE IS GENERATED.** Every number is a query result with the
 *    window it was measured over. `asOf` travels with it, because a fact about
 *    "this month" read out three weeks later is no longer true.
 */
import { resolveRowRegion } from './regions.js';

/** Windows a fact can be measured over. */
export const DEFAULT_DAYS = 30;

/**
 * Parse the applicants column.
 *
 * "Over 100" is treated as 101 — more than 100, which is what it says. Shared
 * with src/reelcaption.js by copy rather than by import because that module is
 * about one posting and this one is about the board; the rule is small and the
 * duplication is visible. Keep them in step.
 */
export function applicantCount(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^over\s+\d+/i.test(s)) return Number(s.match(/\d+/)[0]) + 1;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/** "On-site" and "onsite" are the same thing and both occur. */
export function normaliseMode(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  if (/^on-?site$/i.test(raw)) return 'On-site';
  return raw[0].toUpperCase() + raw.slice(1).toLowerCase();
}

const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Every fact this file knows how to mine.
 *
 * One entry per fact, each a pure function of the rows it is given, so adding
 * a fact is local and testing one does not need a database. `minSample` is the
 * smallest denominator the fact is honest at — below it the fact is dropped.
 */
const FACTS = [
  {
    id: 'pay-transparency',
    minSample: 40,
    /** Of the postings we hold, how many say what they pay. */
    mine(rows) {
      const of = rows.length;
      const paid = rows.filter((r) => r.stipend_status === 'paid').length;
      const unpaid = rows.filter((r) => r.stipend_status === 'unpaid').length;
      if (!paid && !unpaid) return null;
      return {
        value: paid, of,
        headline: `Only ${paid} of ${of} engineering internships said what they pay`,
        detail: unpaid
          ? `${unpaid} of them are explicitly unpaid, and ${of - paid - unpaid} say nothing at all`
          : `${of - paid} say nothing at all`,
      };
    },
  },
  {
    id: 'no-applicants',
    minSample: 60,
    /** Roles nobody has applied to — the strongest thing a job board can say. */
    mine(rows) {
      const withData = rows.filter((r) => applicantCount(r.applicants) !== null);
      if (!withData.length) return null;
      const zero = withData.filter((r) => applicantCount(r.applicants) === 0).length;
      const under10 = withData.filter((r) => {
        const n = applicantCount(r.applicants);
        return n !== null && n > 0 && n < 10;
      }).length;
      return {
        value: zero, of: withData.length,
        headline: `${plural(zero, 'internship has', 'internships had')} zero applicants when we found ${zero === 1 ? 'it' : 'them'}`,
        detail: `out of ${withData.length} that reported a count, and another ${under10} had fewer than ten`,
      };
    },
  },
  {
    id: 'crowded',
    minSample: 60,
    /**
     * The threshold travels WITH the fact rather than living in the sentence.
     *
     * "over 100 applicants" puts a number in the headline that is not derivable
     * from value or of, and a consumer checking the sentence against the data
     * cannot tell a threshold from a miscount. Naming it makes the check
     * possible and tells a model what the bar was.
     */
    mine(rows) {
      const threshold = 100;
      const withData = rows.filter((r) => applicantCount(r.applicants) !== null);
      if (!withData.length) return null;
      const crowded = withData.filter((r) => (applicantCount(r.applicants) ?? 0) > threshold).length;
      return {
        value: crowded, of: withData.length, threshold,
        headline: `${pct(crowded, withData.length)}% of internships already had over ${threshold} applicants`,
        detail: `${crowded} of ${withData.length} that reported a count — applying late is applying to a queue`,
      };
    },
  },
  {
    id: 'speed',
    minSample: 40,
    /**
     * How old a posting is when the board picks it up.
     *
     * The median, not the mean: one posting scraped days late from a backfill
     * drags a mean into meaninglessness, and this number is the site's central
     * promise so it has to be the one that is defensible.
     */
    mine(rows) {
      const ages = rows
        .filter((r) => r.posted_at && r.first_seen_at && r.first_seen_at >= r.posted_at)
        .map((r) => (r.first_seen_at - r.posted_at) / 60000)
        .sort((a, b) => a - b);
      if (ages.length < 20) return null;
      const median = Math.round(ages[Math.floor(ages.length / 2)]);
      return {
        value: median, of: ages.length,
        headline: median < 90
          ? `We list a new internship about ${median} minutes after it goes up`
          : `We list a new internship about ${Math.round(median / 60)} hours after it goes up`,
        detail: `median across ${ages.length} postings that carried a timestamp`,
      };
    },
  },
  {
    id: 'employers',
    minSample: 30,
    mine(rows) {
      const by = new Map();
      for (const r of rows) {
        const k = r.company_matched || r.company;
        if (k) by.set(k, (by.get(k) ?? 0) + 1);
      }
      if (!by.size) return null;
      const [topName, topCount] = [...by].sort((a, b) => b[1] - a[1])[0];
      return {
        value: by.size, of: rows.length,
        headline: `${by.size} companies posted engineering internships`,
        detail: `across ${rows.length} listings — the busiest was ${topName} with ${topCount}`,
      };
    },
  },
  {
    id: 'skills',
    minSample: 40,
    /** What the postings actually ask for, counted across their own text. */
    mine(rows) {
      const by = new Map();
      for (const r of rows) {
        const seen = new Set();
        for (const s of parseList(r.key_skills).concat(parseList(r.skills))) {
          const k = String(s).toLowerCase().trim();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          by.set(k, (by.get(k) ?? 0) + 1);
        }
      }
      const top = [...by].sort((a, b) => b[1] - a[1])[0];
      if (!top) return null;
      const [name, n] = top;
      return {
        value: n, of: rows.length,
        headline: `${titleSkill(name)} was asked for in ${pct(n, rows.length)}% of engineering internships`,
        detail: `${n} of ${rows.length} listings named it${runnersUp(by, name)}`,
      };
    },
  },
  {
    id: 'remote',
    minSample: 40,
    mine(rows) {
      const withMode = rows.map((r) => normaliseMode(r.workplace_type)).filter(Boolean);
      if (withMode.length < 30) return null;
      const remote = withMode.filter((m) => m === 'Remote').length;
      return {
        value: remote, of: withMode.length,
        headline: `Only ${pct(remote, withMode.length)}% of engineering internships are remote`,
        detail: `${remote} of ${withMode.length} that stated a mode — ${withMode.filter((m) => m === 'On-site').length} are on-site`,
      };
    },
  },
];

/**
 * A fact about the GATE, mined from refused cards rather than kept ones.
 *
 * Separate because it reads `seen_cards`, not `jobs`, and because it is the
 * single most surprising number this project holds: the watchlist turns away
 * roughly sixty cards for every one it keeps, and almost all of them are
 * course sellers and intern mills. That is the site's actual product — the
 * refusing, not the listing — and nothing else in the file needs the table.
 */
function gateFact(store, sinceMs, minSample, kept, minKept) {
  /* THE RATIO NEEDS BOTH SIDES TO BE SOLID. Refused cards pile up fast enough
     that this fact clears its own floor on a single day, while the kept side
     is a handful — and dividing by a handful gave "about 100 listings for
     every one" over one day against "about 60" over thirty. Same board, same
     week, two different claims. Rule 2 applies to the denominator too. */
  if (kept < minKept) return null;
  const row = store.db.prepare(`
    SELECT
      SUM(CASE WHEN reason = 'company not on watchlist' THEN 1 ELSE 0 END) AS refused,
      COUNT(*) AS seen
    FROM seen_cards WHERE last_seen_at > ?
  `).get(sinceMs);
  if (!row || (row.refused ?? 0) < minSample) return null;
  /* THE RATIO, not the raw count. The first version read "23,740 listings were
     turned away for every one we kept", which states a ratio of 23,740:1 when
     the truth is about 60:1 — the raw total dressed up as a rate, wrong by the
     size of the board. A number that will be read aloud has to survive being
     read literally. */
  const ratio = kept > 0 ? Math.round(row.refused / kept) : null;
  return {
    id: 'the-gate', value: row.refused, of: row.seen, ratio,
    headline: ratio && ratio > 1
      ? `We turn away about ${ratio} listings for every one we put on the board`
      : `${row.refused.toLocaleString('en-IN')} listings were turned away`,
    detail: `${row.refused.toLocaleString('en-IN')} refused of ${row.seen.toLocaleString('en-IN')} cards seen`
      + ` — most are course sellers and unpaid "intern" schemes`,
  };
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(v ?? '[]');
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

/** Acronyms stay upper, everything else gets its first letter raised. */
const UPPER = new Set(['sql', 'aws', 'gcp', 'api', 'css', 'html', 'ci/cd', 'ml', 'ai', 'nlp', 'ui', 'ux', 'rtos', 'fpga']);
function titleSkill(s) {
  if (UPPER.has(s)) return s.toUpperCase();
  if (/[A-Z0-9+.#]/.test(s.slice(1))) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function runnersUp(by, exclude) {
  const rest = [...by].filter(([k]) => k !== exclude).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return rest.length ? `, ahead of ${rest.map(([k, n]) => `${titleSkill(k)} (${n})`).join(' and ')}` : '';
}

/**
 * Mine every fact that holds for this region and window.
 *
 * Returns only facts that PASS their minimum sample. A caller gets a shorter
 * list on a thin window rather than a full list of weak claims, which is the
 * behaviour that makes it safe to hand the result straight to a model.
 *
 * The region is RE-DERIVED from the location, never read off `jobs.region` —
 * the same rule publish follows, because a row captured before a gazetteer fix
 * carries the old answer.
 */
export function mineStats(store, { region = 'IN', days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const sinceMs = now - days * 86_400_000;
  const rows = store.db.prepare(`
    SELECT * FROM jobs WHERE is_tech = 1 AND first_seen_at > ?
  `).all(sinceMs).filter((r) => resolveRowRegion(r) === region);

  const out = [];
  for (const f of FACTS) {
    if (rows.length < f.minSample) continue;
    const got = f.mine(rows);
    if (got) out.push({ id: f.id, ...got, region, days, asOf: now, sample: rows.length });
  }
  const gate = gateFact(store, sinceMs, 500, rows.length, 40);
  if (gate) out.push({ ...gate, region, days, asOf: now, sample: gate.of });
  return out;
}
