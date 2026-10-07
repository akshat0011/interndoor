/**
 * The monthly reports — /insights/<YYYY-MM>, one permanent page per month.
 *
 * WHY. The site has 41 external links and Google crawls almost nothing new
 * (§17, 7 Oct 2026). Job pages expire in 30 days and /report moves daily, so
 * neither is something another site can link to and still find a month
 * later. A month that is OVER does not change, so its page can be cited:
 * "425 engineering internships in India in September 2026, 15 of which stated
 * a stipend" is a sentence a journalist or a placement cell can quote, and
 * the link behind it stays true for ever.
 *
 * FROZEN, AND THAT IS THE WHOLE DESIGN. A month is computed ONCE, two days
 * after it ends in the board's own time zone, and stored in `settings`
 * (`insight:<CODE>:<YYYY-MM>`). Every publish after that renders from the
 * stored snapshot and never re-mines it. Re-mining would let a later watchlist
 * edit, a suppression or a demotion silently change a figure somebody has
 * already quoted — and would rewrite the page, which is churn on the one kind
 * of URL meant to look permanent. The page says when it was compiled.
 *
 * THE RULES ARE /report's AND THE DATA POSTS' (§11, §12): every figure is a
 * count from the store with its denominator, a section too thin to say
 * anything is DROPPED rather than weakened, nothing is written by a model, and
 * the sources are never named. The cuts themselves are datapost.js's — the
 * same functions, handed a calendar month instead of the last 30 days — so a
 * number on this page and a number in a LinkedIn data post are counted the
 * same way.
 *
 * Pure apart from `ensureInsights`, which reads and writes the store.
 */
import {
  dataRows, employersPost, queuePost, stipendsPost, timingPost,
  citiesPost, skillsPost,
} from './datapost.js';
import { regionOf } from './regions.js';

export const INSIGHT_VERSION = 1;
/* A month is compiled this long after it ends: a posting first seen at 23:50
   on the last day is classified and enriched by the scans that follow. */
export const SETTLE_MS = 2 * 86_400_000;
/* Fewer sections than this and the month is not a report. */
export const MIN_SECTIONS = 4;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);

/** The zone's UTC offset at an instant, in ms (positive east of Greenwich). */
export function zoneOffsetMs(zone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** [start, end) of a 'YYYY-MM' month in a zone, as epoch ms. */
export function monthBounds(key, zone) {
  const [y, m] = key.split('-').map(Number);
  const local = (yy, mm) => {
    const guess = Date.UTC(yy, mm - 1, 1);
    return guess - zoneOffsetMs(zone, guess - zoneOffsetMs(zone, guess));
  };
  return [local(y, m), m === 12 ? local(y + 1, 1) : local(y, m + 1)];
}

export function monthKeyAt(ms, zone) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: zone }).slice(0, 7);
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/**
 * Every month that is fully tracked (tracking began on or before its first
 * day) and settled (ended at least SETTLE_MS ago). Oldest first.
 */
export function completedMonths(trackedSince, now, zone) {
  if (!trackedSince) return [];
  const out = [];
  let key = monthKeyAt(trackedSince, zone);
  for (let guard = 0; guard < 240; guard++) {
    const [start, end] = monthBounds(key, zone);
    if (end + SETTLE_MS > now) break;
    if (start >= trackedSince) out.push(key);
    const [y, m] = key.split('-').map(Number);
    key = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}

/* ------------------------------------------------------------- sections */

const bar = (label, value, share) => ({ label: String(label), value: String(value), share: Math.max(0, Math.min(1, Number(share) || 0)) });

function employersSection(p, n) {
  const s = p.stats;
  const top = s.top[0];
  return {
    id: 'employers',
    heading: 'Who posted the most',
    finding: `${top.employer} posted the most engineering internships: ${top.postings} of ${n}.`,
    detail: `${s.employers} employers posted at least one. The ten busiest posted ${s.top.reduce((a, t) => a + t.postings, 0)} between them. Some post one role in several cities, so a count of postings is not a count of different jobs.`,
    bars: s.top.map((t) => bar(t.employer, t.postings, t.postings / top.postings)),
  };
}

function stipendsSection(p) {
  const s = p.stats;
  return {
    id: 'stipends',
    heading: 'Who said what they pay',
    finding: `Only ${s.stated} of ${s.rows} postings stated a stipend.`,
    detail: `${s.topStated === 0 ? `None of the ${s.top} busiest employers stated one on any posting.` : `${s.topStated} of the ${s.top} busiest employers stated one on at least one posting.`}${s.medianMonthlyInr ? ` Where a monthly figure in rupees was stated (${s.monthlyFigures} postings), the middle one was ₹${s.medianMonthlyInr.toLocaleString('en-IN')}.` : ''} A posting that states no figure is not necessarily unpaid; it means the pay was not on the listing.`,
    bars: [
      bar('Stated a stipend', `${pct(s.stated, s.rows)}%`, s.stated / s.rows),
      bar('Did not', `${pct(s.rows - s.stated, s.rows)}%`, (s.rows - s.stated) / s.rows),
    ],
  };
}

function queueSection(p) {
  const s = p.stats;
  return {
    id: 'queue',
    heading: 'How fast the applicant queue forms',
    finding: s.oneIn
      ? `About 1 in ${s.oneIn} already had 100 or more applicants when we found it.`
      : `Almost none had 100 or more applicants when we found them.`,
    detail: `Counted over the ${s.counted} postings that reported an applicant count, at the moment we first saw each one — usually within a few hours of it going up. ${s.pct.under25}% had fewer than 25.`,
    bars: [
      bar('100 or more', `${s.pct.many}%`, s.bands.many / s.counted),
      bar('25 to 99', `${s.pct.some}%`, s.bands.some / s.counted),
      bar('1 to 24', `${s.pct.few}%`, s.bands.few / s.counted),
      bar('Nobody yet', `${s.pct.none}%`, s.bands.none / s.counted),
    ],
  };
}

function citiesSection(p) {
  const s = p.stats;
  const first = s.cities[0];
  return {
    id: 'cities',
    heading: 'Where the internships were',
    finding: `${first.city} had ${first.pct}% of them: ${first.postings} of ${s.rows}.`,
    detail: `By how the work is done: on-site ${s.modePct.onsite}%, hybrid ${s.modePct.hybrid}%, remote ${s.modePct.remote}%, out of all ${s.rows}; ${s.rows - s.modeStated} postings did not say.`,
    bars: s.cities.map((c) => bar(c.city, `${c.pct}%`, c.postings / first.postings)),
  };
}

function skillsSection(p, n) {
  const s = p.stats;
  const first = s.top[0];
  const card = p.card.rows;
  return {
    id: 'skills',
    heading: 'The skills postings asked for',
    finding: `${card[0].label} was named in ${first.pct}% of postings that named any skill.`,
    detail: `Over ${s.rows} of the ${n} postings, the ones where we could read at least one skill; a skill counts once per posting.`,
    bars: s.top.map((t, i) => bar(card[i].label, `${t.pct}%`, t.postings / first.postings)),
  };
}

function timingSection(p) {
  const s = p.stats;
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const max = Math.max(...DAYS.map((d) => s.byDay[d]));
  const best = DAYS.filter((d) => s.byDay[d] === max)[0];
  return {
    id: 'timing',
    heading: 'Which day they went up',
    finding: `${best} had the most: ${max} of ${s.counted}. Saturday and Sunday together had ${s.weekend}.`,
    detail: `By the posting's own date, over the ${s.counted} postings we found within hours of them going up.`,
    bars: DAYS.map((d) => bar(d, s.byDay[d], max ? s.byDay[d] / max : 0)),
  };
}

/**
 * Compile one month. Null when it is too thin to be a report. `cfg` is the
 * config the data posts take; the links they build are not used here.
 */
export function compileMonth(store, cfg, key, { region = 'IN', now = Date.now() } = {}) {
  const code = String(region).toUpperCase();
  const zone = regionOf(code)?.timeZone ?? 'Asia/Kolkata';
  const [start, end] = monthBounds(key, zone);
  const days = (end - start) / 86_400_000;
  const data = dataRows(store, cfg, { region: code, now: end, days });
  /* The month exactly, [start, end), from the full history — dataRows' own
     window is (since, now], which is off by one instant at each edge. */
  data.rows = data.history.filter((r) => r.firstSeen >= start && r.firstSeen < end);
  data.since = start - 1;
  const n = data.rows.length;
  if (!n) return null;
  const employers = new Set(data.rows.map((r) => r.employer)).size;

  const sections = [];
  let stated = null;
  const add = (post, build) => { if (post) sections.push(build(post)); };
  add(employersPost(data, cfg), (p) => employersSection(p, n));
  add(stipendsPost(data, cfg), (p) => { stated = p.stats.stated; return stipendsSection(p); });
  add(queuePost(data, cfg), queueSection);
  add(citiesPost(data, cfg), citiesSection);
  add(skillsPost(data, cfg), (p) => skillsSection(p, n));
  add(timingPost(data, cfg), timingSection);
  /* NO "employers new to the board" section, on purpose. It was built and
     measured: September's 84 "newcomers" were mostly employers added to the
     WATCHLIST that month (Kaleris went on the list on 13 Sep), so the figure
     describes our list, not the market — and a page meant to be quoted must
     not carry a number that reads as "84 companies started hiring interns". */
  if (sections.length < MIN_SECTIONS) return null;

  return {
    v: INSIGHT_VERSION,
    region: code,
    month: key,
    label: monthLabel(key),
    start,
    end,
    compiledAt: now,
    trackedSince: data.trackedSince,
    rows: n,
    employers,
    stated,
    sections,
  };
}

/**
 * Every settled month's snapshot for a region, compiling (and storing) any
 * that are missing. A stored snapshot is NEVER recompiled. Newest first.
 */
export function ensureInsights(store, cfg, region = 'IN', now = Date.now(), log = null) {
  const code = String(region).toUpperCase();
  const zone = regionOf(code)?.timeZone ?? 'Asia/Kolkata';
  const first = store.db.prepare('SELECT MIN(first_seen_at) AS t FROM jobs').get()?.t;
  /* Tracking for the BOARD began with its first engineering row; dataRows
     knows that, but asking it costs a full scan per publish. The cheap
     MIN above bounds the candidate months and compileMonth re-checks. */
  const out = [];
  for (const key of completedMonths(Number(first) || null, now, zone)) {
    const setting = `insight:${code}:${key}`;
    let snap = null;
    try { snap = JSON.parse(store.getSetting(setting) ?? 'null'); } catch { snap = null; }
    if (snap === null && store.getSetting(setting) !== 'thin') {
      try {
        snap = compileMonth(store, cfg, key, { region: code, now });
      } catch (err) {
        log?.warn?.(`Could not compile the ${key} report for ${code}: ${err.message}`);
        continue;
      }
      /* A thin month is remembered as thin, so it is not re-mined 48 times a
         day — and so it cannot quietly appear later from rows added after. */
      if (!snap || (snap.trackedSince != null && snap.trackedSince > snap.start)) {
        store.setSetting(setting, 'thin');
        snap = null;
      } else {
        store.setSetting(setting, JSON.stringify(snap));
        log?.info?.(`Compiled the ${snap.label} report for ${code}: ${snap.rows} postings, ${snap.sections.length} sections.`);
      }
    }
    if (snap && snap.v === INSIGHT_VERSION) out.push(snap);
  }
  return out.sort((a, b) => b.month.localeCompare(a.month));
}
