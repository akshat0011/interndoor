/**
 * ATS boards read off the apply links we already have.
 *
 * Slug discovery guesses a board from the company's NAME, and a Workday or
 * Oracle tenant cannot be guessed at all (`otis:wd504:REC_Ext_Gateway`,
 * `egug.fa.us2.oraclecloud.com`). But every LinkedIn posting we open records
 * where its Apply button goes, and for most employers that IS the board. On
 * 13 Sep 2026, 85 watchlist companies had a readable board named in their own
 * apply links and none in company_ats — American Express, Honeywell, Otis,
 * Salesforce, NewSpace Research — so the poller had never read them.
 *
 * THE LINK IS EVIDENCE ABOUT THE POSTING'S EMPLOYER, NOT THE WATCHLIST ENTRY'S.
 * `matchCompany` matches loosely, so postings by "Pine Rest Christian Mental
 * Health Services", "Mercury Marine" and "Titan Electric Companies" are all in
 * the store filed under Pine Labs, Mercury Technologies and Titan Company — and
 * their links name Pine Rest's Workday, Brunswick's and Titan Electric's Lever.
 * Seeding those would publish one employer's whole board under another's name,
 * the worst error this site can make.
 *
 * WHOLE-WORD CONTAINMENT IS NOT ENOUGH, and the first version of this trusted
 * it: normaliseCompany reduces "Pine Labs" to the bare word `pine`, which every
 * one of those names contains. So a link counts only on one of two stronger
 * grounds:
 *   1. the posting's normalised name EQUALS a term of the entry — "American
 *      Express" posting as American Express. This is what admits the opaque
 *      tokens (`egug.fa.us2.oraclecloud.com`, `mpc:wd1:MPCCareers`), which
 *      carry no name to check.
 *   2. the posting's name carries EVERY word of the company's own name —
 *      "NewSpace Research and Technologies" for NewSpace Research, "Otis
 *      Elevator Co." for Otis Elevator — for a posting filed under a longer
 *      legal name. "Pine Rest…" lacks `labs`, "Mercury Marine" lacks
 *      `technologies`, "Wonder" lacks `cement`.
 * A check on the BOARD's name was tried for (2) and is wrong: `wonder:wd1:WG`
 * contains `wonder` exactly as Wonder Cement does, and it is the US Wonder's.
 * The board name says nothing about whose posting the link came from.
 * The provider's own `verify` still runs on top of this, in bin/discover-ats.js.
 */
import { normaliseCompany, matchCompany } from './config.js';
import { parseAtsLink } from './ats.js';

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Does the posting's employer name carry every word of the company's name? */
function namesEveryWord(posted, display) {
  const have = new Set(wordsOf(posted));
  const need = wordsOf(display);
  return need.every((w) => have.has(w));
}

/**
 * @param {{company: string, apply_url: string, first_seen_at?: number}[]} rows
 * @param {{display: string, term: string}[]} watchlist
 * @returns {{company: string, provider: string, token: string, postings: number, lastSeen: number}[]}
 *   One board per watchlist company: the one its postings link to most often.
 */
export function boardsFromApplyLinks(rows, watchlist) {
  const termsOf = new Map();
  for (const { display, term } of watchlist) {
    if (!termsOf.has(display)) termsOf.set(display, []);
    termsOf.get(display).push(term);
  }

  const tally = new Map(); // display -> Map(provider|token -> {provider, token, postings, lastSeen})
  for (const row of rows ?? []) {
    const hit = parseAtsLink(row?.apply_url);
    if (!hit) continue;
    const display = matchCompany(row.company, watchlist);
    if (!display) continue;
    const posted = normaliseCompany(row.company);
    const exact = (termsOf.get(display) ?? []).includes(posted);
    if (!exact && !namesEveryWord(row.company, display)) continue;

    if (!tally.has(display)) tally.set(display, new Map());
    const key = `${hit.provider}|${hit.token}`;
    const e = tally.get(display).get(key) ?? { ...hit, postings: 0, lastSeen: 0 };
    e.postings++;
    e.lastSeen = Math.max(e.lastSeen, Number(row.first_seen_at ?? 0));
    tally.get(display).set(key, e);
  }

  return [...tally.entries()].map(([company, boards]) => {
    const best = [...boards.values()].sort((a, b) => b.postings - a.postings || b.lastSeen - a.lastSeen)[0];
    return { company, ...best };
  }).sort((a, b) => b.postings - a.postings || a.company.localeCompare(b.company));
}
