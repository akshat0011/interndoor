import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT } from './paths.js';
import { log } from './logger.js';
import { formatStipend } from './extract.js';
import { matchCompany, isBlockedCompany } from './config.js';
import { syncLogos, logoPathFor, logoDirSize } from './logos.js';
import { writeSite, cardFacts, jobSlug } from './pages.js';
import { queueForIndexing, runIndexingSweep, indexingConfigured } from './indexing.js';
import { mineStats, DEFAULT_DAYS } from './statsmine.js';
import { submitUrls, indexNowConfigured } from './indexnow.js';
import { channelsFor } from './channels.js';
import { publishedRegions, resolveRowRegion, ALL_REGIONS } from './regions.js';

const PUBLIC_DIR = join(ROOT, 'web', 'public');

/**
 * Where a region's board is written.
 *
 * India keeps `/data/jobs.json` exactly where it has always been — that path is
 * in vercel.json's cache rules and is what the live app.js fetches — and every
 * other region gets the same filename under its own prefix.
 */
function jobsFileFor(region) {
  return join(PUBLIC_DIR, ...(region.slug ? [region.slug] : []), 'data', 'jobs.json');
}

/**
 * Shape a stored job into what the public site shows.
 *
 * Full descriptions are deliberately left out by default. They are the posting
 * company's copyrighted text, and republishing them wholesale is a far bigger
 * exposure than showing our own summary and linking to the source. Students get
 * the summary plus every hard fact they need to decide; the Apply link takes
 * them to the real posting.
 */
/** Stored as a JSON string; a row written before enrichment existed has null. */
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
}

function toPublicJob(row, { includeFullDescription, matchedNow, logoIndex }) {
  const stipend = formatStipend({
    min: row.stipend_min, max: row.stipend_max,
    currency: row.stipend_currency, period: row.stipend_period,
  }) || row.salary_text || null;

  const job = {
    id: row.job_id,
    // The company shown publicly is the one on the posting, not our watchlist
    // label. A mislabelled employer on a public site is worse than no label.
    title: row.title,
    company: row.company || matchedNow || 'Unknown',
    matchedWatchlist: matchedNow,
    // null means the verdict pass has not run for this row yet; the site treats
    // an unknown verdict as non-tech rather than hiding the job.
    isTech: row.is_tech == null ? null : !!row.is_tech,
    roleSource: row.role_source ?? null,
    // 'intern' | 'fulltime'. NULL on rows written before the split, and the
    // site was internships only then, so NULL means intern.
    employmentType: row.employment_type || 'intern',
    // Local path, never LinkedIn's CDN — see src/logos.js for why.
    logo: logoPathFor(row.company || matchedNow || '', logoIndex),
    location: row.location || null,
    workplaceType: row.workplace_type || null,
    stipend,
    duration: row.duration || null,
    applicants: row.applicants || null,
    easyApply: !!row.easy_apply,
    skills: row.skills || [],
    summary: row.summary || null,
    // Gemini enrichment. bullets is the card's primary body; an empty array means
    // the posting has not been enriched yet and the card falls back to summary.
    bullets: parseJsonArray(row.bullets),
    roleLabel: row.role_label || null,
    degreeLevel: row.degree_level || null,
    degreeText: row.degree_text || null,
    keySkills: parseJsonArray(row.key_skills),
    stipendStatus: row.stipend_status || (stipend ? 'paid' : 'unknown'),
    postedText: row.posted_text || null,
    postedAt: row.posted_at || row.first_seen_at,
    firstSeenAt: row.first_seen_at,
    // The last poll that saw this on its board. Drives validThrough in the
    // JSON-LD: a role still being listed must not advertise a date in the past.
    lastSeenAt: row.last_seen_at,
    url: row.job_url,
    applyUrl: row.apply_url || row.job_url,
    // Only carried when explicitly enabled; the tailor endpoint works fine
    // from the summary and skills alone.
    description: includeFullDescription ? row.description : null,
    // Which postings are the SAME role advertised in different cities.
    //
    // The board collapses those into one card, and it needs a way to tell them
    // from several different jobs an employer has filed under one title. None
    // of the model-generated fields can do it, measured both ways: Siemens
    // posted one role in 13 cities and the local model gave it three different
    // roleLabels, while Procter & Gamble's single 24-city opening produced four
    // different summaries and eight different skill sets. Grouping on any of
    // those would both split real duplicates and merge real jobs.
    //
    // The posting's own text settles it, because a multi-city blast is
    // literally the same description filed against several locations. Measured
    // over 30 days: P&G 24 postings / 1 description, Siemens 13 / 1, IBM 7 / 1
    // — against Emerson 7 postings / 5 descriptions and Valeo 6 / 6, which are
    // genuinely different jobs and must stay apart.
    //
    // A hash rather than the text: the full description is deliberately kept
    // out of this file for size, and ten hex characters answers the only
    // question the board actually asks. Hashed over the WHOLE description, not
    // a prefix — Marmon's four postings share their first 400 characters and
    // diverge after.
    roleFingerprint: row.description ? fingerprint(row.description) : null,
  };
  /* The card's three facts, decided by the site's own display filters and
     baked in here because the edge function that draws the card cannot import
     them. See cardFacts in pages.js. */
  job.cardFacts = cardFacts(job);
  return job;
}

/**
 * A stable short hash of a posting's text, for grouping identical postings.
 *
 * Whitespace-normalised first, so a description that differs only in line
 * wrapping between two scrapes still groups. Not security-sensitive — sha1 is
 * used for its speed and short digest, and a collision would merge two cards.
 */
function fingerprint(text) {
  return createHash('sha1')
    .update(String(text).replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex')
    .slice(0, 10);
}

/**
 * One posting per role per place, however many collectors found it.
 *
 * Pulled out of writeJobsFile so it can be tested directly: it decides what
 * the site shows, and the only alternative was driving a whole publish.
 *
 * @param {{row: object, region: string}[]} jobs live rows, region already resolved.
 * @returns {{row: object, region: string}[]} the survivors, in no useful order.
 */
/* `superseded`, when given an array, is filled with { loser, winner } for every
   row this drops in favour of another. It exists for one reason: when an
   employer REPOSTS a role under a new id, the winner gets a new URL and the
   loser's page is deleted — so a URL Google has already indexed starts 404ing
   and a near-identical page appears somewhere else. Measured over 30 days: 71
   role groups reposted, orphaning 123 indexed URLs, 6.5 days apart on average.

   This file's own history says what that costs. The company hubs used to be
   rebuilt and deleted the same way, and the note there is explicit: "each cycle
   404s a URL Google has indexed and discards its accumulated ranking; the churn
   costs more than the absence, because URL instability burns crawl budget and
   suppresses the page." Hubs were made permanent on 18 Aug. Reposted roles were
   not, and they churn faster. */
export function dedupePostings(jobs, superseded = null) {
  // ---- one posting, two collectors -----------------------------------------
  // The scraper and the ATS poller find the same role independently: a company
  // posts to its ATS, and the LinkedIn copy appears later. Both are stored,
  // because each is the truth about where it was seen — but the site must show
  // it once.
  //
  // The ATS row wins on a tie. It carries the employer's real apply URL rather
  // than a LinkedIn redirect, and its posted date is the actual publish time
  // rather than "3 days ago" parsed from a card.
  //
  // But only when the two are plausibly the SAME posting. That preference used
  // to be unconditional, and it is a preference between collectors, not between
  // postings — so a months-old ATS row silently suppressed a fresh relisting of
  // the same role. Stripe's "Software Engineer, Intern" was scraped 11 minutes
  // after going up on 14 Aug and did not reach the site for 9h46m: a Greenhouse
  // row for the same role, posted 22 Jul, held the slot. It was not fixed, it
  // expired — the ATS row left the 14-day window at 05:21 on 15 Aug and the
  // next run published the LinkedIn one at 05:50.
  //
  // Beyond this gap they are two postings, not two views of one, and the newer
  // is the one still open. Three days is deliberately generous: the ATS copy
  // goes up first and LinkedIn's follows within hours, so a genuine pair stays
  // well inside it and keeps the better apply URL.
  const SAME_POSTING_MS = 3 * 24 * 3_600_000;
  //
  // Where neither is from an ATS, the NEWEST posting wins. This used to keep the
  // row we saw first, on the reasoning that the freshness label stays honest —
  // but the duplicates it actually meets are LinkedIn reposts of one role under
  // a new job_id, and keeping the earliest inverted the thing it was protecting.
  // Intuit reposted "Intern, Software Engineering" in Bengaluru on 9 Aug; the
  // site went on showing the 4 Aug copy, six days stale, while the fresh row sat
  // in the table unpublished. Fourteen live cards were doing this at once.
  //
  // Company and title alone are not enough to call two rows the same job.
  // Bajaj Finserv lists "Functional Trainee" in Ranchi, Sandila, Rasulpur,
  // Lucknow, Pune, Bareilly, Bengaluru and Bhopal — eight real vacancies a
  // student would choose between, and keying on company+title would silently
  // publish one and throw seven away.
  //
  // But the city has to be compared loosely, because the two collectors write it
  // differently: the ATS says "Bangalore" where LinkedIn says "Bengaluru,
  // Karnataka, India". So the key uses a canonical city rather than the raw
  // string, and falls back to the whole normalised location when the city is not
  // one we recognise.
  const CITY_ALIASES = new Map(Object.entries({
    bangalore: 'bengaluru', bengaluru: 'bengaluru',
    gurgaon: 'gurugram', gurugram: 'gurugram',
    bombay: 'mumbai', mumbai: 'mumbai',
    'new delhi': 'delhi', delhi: 'delhi', noida: 'noida',
    calcutta: 'kolkata', kolkata: 'kolkata',
    madras: 'chennai', chennai: 'chennai',
    hyderabad: 'hyderabad', pune: 'pune', ahmedabad: 'ahmedabad',
    jaipur: 'jaipur', indore: 'indore', kochi: 'kochi', chandigarh: 'chandigarh',
    mysore: 'mysuru', mysuru: 'mysuru',
    trivandrum: 'thiruvananthapuram', thiruvananthapuram: 'thiruvananthapuram',
    vizag: 'visakhapatnam', visakhapatnam: 'visakhapatnam',
    coimbatore: 'coimbatore', nagpur: 'nagpur', bhopal: 'bhopal',
    lucknow: 'lucknow', ranchi: 'ranchi', bareilly: 'bareilly',
    bhubaneswar: 'bhubaneswar', remote: 'remote',
  }));

  // A location that names nothing more specific than the country. It cannot be
  // keyed on a city, and inventing one from it is what published a role twice:
  // Microsoft's India board writes "India, Karnataka, Bangalore" while LinkedIn
  // writes plain "India" for the same vacancy, so the pair keyed `bengaluru`
  // and `india` and got two pages. '' marks the city UNKNOWN instead, and the
  // reconciliation pass below folds it into the specific row.
  //
  // Singapore is deliberately absent: it is a city as much as a country, so
  // "Singapore" IS the most specific location there is, and Jump Trading's
  // Singapore internships have to keep a key of their own.
  const CITY_STATES = new Set(['singapore']);
  const BARE_COUNTRY = new Set([
    ...ALL_REGIONS.map((r) => r.name.toLowerCase()),
    'usa', 'u s a', 'us', 'united states of america',
    'uk', 'u k', 'britain', 'great britain',
  ].filter((n) => !CITY_STATES.has(n)));

  const cityOf = (location) => {
    const flat = String(location ?? '').toLowerCase();
    if (!flat.trim()) return '';
    if (BARE_COUNTRY.has(flat.replace(/[^a-z0-9]+/g, ' ').trim())) return '';
    for (const [alias, canonical] of CITY_ALIASES) {
      if (new RegExp(`\\b${alias}\\b`).test(flat)) return canonical;
    }
    // Only the CITY, not the whole string.
    //
    // The aliases above are Indian, so before regions existed every location
    // that mattered hit one and this fallback was nearly dead code. It became
    // live with the US board, and it kept the state or country — which the two
    // collectors write differently for the same place. AbbVie's
    // "2027 Business Technology Solutions Intern - Cloud Engineering" is
    // "South San Francisco, us" from SmartRecruiters and "South San Francisco,
    // CA" from LinkedIn, so the pair produced different keys and was published
    // twice. Measured across 30 days: 19 rows collapse once this is the city
    // alone, every one of them a genuine ATS+LinkedIn twin, and nothing else
    // merges.
    //
    // Dropping the state does mean two same-named cities in different states
    // share a key. That risk is already taken for India, where the alias path
    // returns a bare city name, and it needs the same employer to run the same
    // title in both — none exist in the store today.
    return flat.split(',')[0].replace(/[^a-z0-9]+/g, ' ').trim();
  };

  const dedupeKey = (row) => {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `${norm(row.company_matched || row.company)}|${norm(row.title)}|${cityOf(row.location)}`;
  };
  const isAts = (row) => String(row.job_id ?? '').startsWith('ats:');
  // Same fallback the public card uses, so the row that wins here is the row
  // carrying the date the site will actually print.
  const postedAtOf = (row) => row.posted_at || row.first_seen_at || 0;

  // ATS wins a cross-collector tie because it carries the real apply URL, but
  // only for two postings close enough in time to be the same one; otherwise
  // the newest wins. Shared by both passes below so they cannot drift.
  const challengerWins = (challenger, holder) => {
    const gap = Math.abs(postedAtOf(challenger.row) - postedAtOf(holder.row));
    return isAts(challenger.row) !== isAts(holder.row) && gap <= SAME_POSTING_MS
      ? isAts(challenger.row)
      : postedAtOf(challenger.row) > postedAtOf(holder.row);
  };

  const bestByKey = new Map();
  /* Loser -> the KEY it lost at, not the row that beat it. Reposts chain: A is
     beaten by B, then B by C, and recording the row would leave A pointing at a
     page that no longer exists. Resolving the key at the end always lands on
     whoever finally holds it. */
  const lostAtKey = new Map();
  for (const entry of jobs) {
    const key = dedupeKey(entry.row);
    const existing = bestByKey.get(key);
    if (!existing) { bestByKey.set(key, entry); continue; }
    if (challengerWins(entry, existing)) { lostAtKey.set(existing, key); bestByKey.set(key, entry); }
    else lostAtKey.set(entry, key);
  }

  // Fold a country-only row into the same role filed against a real city.
  //
  // The pass above cannot: an unknown city keys as '' and never matches
  // `bengaluru`, however obviously the two are one vacancy. So look them up by
  // employer, title and region instead — but ONLY when that role runs in
  // exactly one city there. An employer advertising one title in several cities
  // is the case `dedupeKey` exists to protect (Bajaj Finserv files "Functional
  // Trainee" in eight), and merging a nationally-advertised row into an
  // arbitrary one of them would drop a vacancy a student could have chosen.
  const roleOf = (entry) => {
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return `${norm(entry.row.company_matched || entry.row.company)}|${norm(entry.row.title)}|${entry.region}`;
  };
  const placedByRole = new Map();
  for (const [key, entry] of bestByKey) {
    if (!cityOf(entry.row.location)) continue;
    const role = roleOf(entry);
    if (!placedByRole.has(role)) placedByRole.set(role, []);
    placedByRole.get(role).push({ key, entry });
  }
  for (const [bareKey, bare] of [...bestByKey]) {
    if (cityOf(bare.row.location)) continue;
    const placed = placedByRole.get(roleOf(bare)) ?? [];
    if (placed.length !== 1) continue;
    bestByKey.delete(bareKey);
    const target = placed[0].key;
    if (challengerWins(bare, placed[0].entry)) {
      lostAtKey.set(placed[0].entry, target);
      bestByKey.set(target, bare);
    } else {
      lostAtKey.set(bare, target);
    }
    // Anything that had already lost at the bare key now belongs to the folded
    // one, or it would resolve to a key nobody holds.
    for (const [loser, key] of lostAtKey) if (key === bareKey) lostAtKey.set(loser, target);
  }

  if (superseded) {
    for (const [loser, key] of lostAtKey) {
      const winner = bestByKey.get(key);
      if (winner && winner !== loser) superseded.push({ loser, winner });
    }
  }

  return [...bestByKey.values()];
}

/** Write the public jobs payload. Returns { count, path, changed }. */
/**
 * The numbers behind /report, mined ONCE A DAY per region and cached.
 *
 * Not once a publish, and the reason is not cost — mining is three queries. It
 * is that `publish` runs 48 times a day into a PUBLIC git repo, and a page
 * whose figures move every half hour is 48 HTML diffs a day on the one URL that
 * is meant to look permanent to Google. Cached, the rendered page is
 * byte-identical between runs and `writeIfChanged` writes nothing at all.
 *
 * It is also what makes the page citable. Somebody quoting "36 of 403" has to
 * still find it there when a reader clicks through; a figure that changes
 * hourly cannot be quoted at all. Once a day, stamped with the day it was
 * measured, is the smallest thing that gives both.
 *
 * Keyed on the REGION'S OWN calendar day, not UTC — the same rule the rest of
 * the site stamps dates by, so "measured on 28 August" means the 28th where the
 * reader is rather than wherever the server thinks it is.
 */
function dailyStats(store, regions, now = Date.now()) {
  const out = new Map();
  for (const region of regions) {
    const key = `statsFacts:${region.code}`;
    // en-CA renders YYYY-MM-DD, which sorts and compares as a plain string.
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: region.timeZone });
    let cached = null;
    try { cached = JSON.parse(store.getSetting(key) ?? 'null'); } catch { cached = null; }
    if (cached?.day === today && cached?.days === DEFAULT_DAYS && Array.isArray(cached.facts)) {
      out.set(region.code, cached);
      continue;
    }
    let facts = [];
    try {
      facts = mineStats(store, { region: region.code, days: DEFAULT_DAYS, now });
    } catch (err) {
      /* A page of statistics is the least important thing publish does. Fall
         back to yesterday's rather than failing the run or, worse, rendering an
         empty report over a good one. */
      log.warn(`Could not mine statistics for ${region.code}: ${err.message}`);
      if (cached) { out.set(region.code, cached); continue; }
    }
    const fresh = { day: today, asOf: now, days: DEFAULT_DAYS, facts };
    store.setSetting(key, JSON.stringify(fresh));
    out.set(region.code, fresh);
  }
  return out;
}

export async function writeJobsFile(store, cfg) {
  /* ONE window, two consumers. The JSON-LD's `validThrough` has to expire on
     the same day publish stops writing the page: a page that outlives its own
     validThrough is an expired JobPosting still sitting in the sitemap, which
     is what earns a structured-data manual action across the whole domain.
     These were separate constants and drifted — see validThrough in pages.js. */
  const maxAgeDays = cfg.publish?.maxAgeDays ?? 14;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const includeFullDescription = !!cfg.publish?.includeFullDescription;

  const techOnly = cfg.publish?.techRolesOnly !== false;

  /**
   * An ATS row counts as live while it is still on the board.
   *
   * Two days of slack on `last_seen_at`: polls run every 30 minutes, but a
   * provider can fail for a few consecutive polls (Workday is read on rotation,
   * four tenants a run) and a role must not vanish from the site because one
   * fetch 500'd.
   */
  const atsWindow = {
    seenSinceMs: Date.now() - 2 * 86_400_000,
    postedFloorMs: Date.now() - (cfg.ats?.maxPostingAgeDays ?? 60) * 86_400_000,
  };

  const regions = publishedRegions(cfg);
  const wanted = new Set(regions.map((r) => r.code));

  let dropped = 0;
  let droppedForeign = 0;
  let droppedNonTech = 0;
  const droppedByRegion = {};
  const jobs = store
    .recentJobs(Date.now() - maxAgeMs, atsWindow)
    // Re-run the company match at publish time instead of trusting what was
    // stored. Rows captured before a matcher fix can carry a stale, wrong
    // label — an early bug filed "SolarSquare" under "Ola" — and publishing
    // that to students would be worse than dropping it.
    .map((row) => ({ row, matchedNow: matchCompany(row.company, cfg.watchlist) }))
    // A blocked employer never reaches the site, however it got into the table.
    // This is the last line rather than the only one — the scan refuses them too
    // — but it is the line that matters, because it also catches rows captured
    // before a name was blocked. Checked explicitly and not via matchCompany,
    // which returns null for "unknown" and "banned" alike.
    .filter(({ row }) => {
      if (!isBlockedCompany(row.company)) return true;
      dropped++;
      log.warn(`Not publishing "${row.title}" — "${row.company}" is on the blocklist.`);
      return false;
    })
    .filter(({ row, matchedNow }) => {
      if (!cfg.matching?.requireCompanyMatch) return true;
      if (matchedNow) return true;
      dropped++;
      log.debug(`Not publishing "${row.title}" — "${row.company}" no longer matches the watchlist.`);
      return false;
    })
    // Published regions only, enforced HERE and not just at collection. The
    // collectors decide what is STORED; this decides what is shown. Everything
    // is collected now and only the regions in `regions.publish` are shown, so
    // a region fills up quietly and goes live by adding one code to a list —
    // nothing is deleted either way, and nothing has to be re-collected.
    //
    // The region is re-derived from the location rather than read off the
    // stored column, for the same reason matchCompany is re-run above: a row
    // captured before a gazetteer fix carries the old answer. It is also what
    // keeps the documented remedy for a bad geocode working —
    // `UPDATE jobs SET location=…` still moves a posting off the board.
    .map((entry) => ({ ...entry, region: resolveRowRegion(entry.row) }))
    .filter(({ region }) => {
      if (wanted.has(region)) return true;
      droppedForeign++;
      droppedByRegion[region] = (droppedByRegion[region] ?? 0) + 1;
      return false;
    })
    // Engineering only. Applied here rather than in the SQL so that older rows
    // stored back when the site carried every role simply stop appearing, with
    // no migration and nothing deleted — flip techRolesOnly to false and they
    // all come back.
    //
    // Note the test is `=== 1`, not truthiness: is_tech is NULL for a row whose
    // verdict pass has not run yet, and an unclassified job must not be
    // published on the assumption that it might be technical.
    .filter(({ row }) => {
      if (!techOnly) return true;
      if (row.is_tech === 1) return true;
      droppedNonTech++;
      return false;
    })
    .map(({ row, matchedNow, region }) => ({ row, matchedNow, region }));

  const supersededPairs = [];
  const deduped = dedupePostings(jobs, supersededPairs);
  const collapsed = jobs.length - deduped.length;
  if (collapsed) {
    log.info(`Collapsed ${collapsed} duplicate posting${collapsed === 1 ? '' : 's'} found by both collectors.`);
  }
  jobs.length = 0;
  jobs.push(...deduped);

  // Fetch any logo we do not already hold, then resolve every job to a local path.
  const logoIndex = await syncLogos(
    jobs.map(({ row, matchedNow }) => ({ company: row.company || matchedNow || '', logoUrl: row.logo_url })),
  );

  const publicJobs = jobs
    .map(({ row, matchedNow, region }) => ({ ...toPublicJob(row, { includeFullDescription, matchedNow, logoIndex }), region }))
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));

  /* Superseded URLs -> the page that replaced them, per region.
     Both sides go through toPublicJob and jobSlug, the very functions the real
     pages are written with, so the stub cannot land on a slug that was never
     served. A cross-region pair is dropped: dedupeKey is company|title|city and
     carries no region, so two boards can in principle collapse, and redirecting
     a US URL onto an India page would be worse than the 404. */
  const redirectsByRegion = new Map();
  for (const { loser, winner } of supersededPairs) {
    if (loser.region !== winner.region) continue;
    const from = toPublicJob(loser.row, { matchedNow: loser.matchedNow, logoIndex });
    const to = toPublicJob(winner.row, { matchedNow: winner.matchedNow, logoIndex });
    let fromSlug; let toSlug;
    try { fromSlug = jobSlug(from); toSlug = jobSlug(to); } catch { continue; }
    if (fromSlug === toSlug) continue;
    if (!redirectsByRegion.has(loser.region)) redirectsByRegion.set(loser.region, []);
    redirectsByRegion.get(loser.region).push({ slug: fromSlug, target: toSlug });
  }
  if (redirectsByRegion.size) {
    const n = [...redirectsByRegion.values()].reduce((a, v) => a + v.length, 0);
    log.info(`Redirecting ${n} superseded posting URL${n === 1 ? '' : 's'} to the reposted role.`);
  }

  if (droppedForeign) {
    const detail = Object.entries(droppedByRegion).sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`).join(' · ');
    log.info(`Held back ${droppedForeign} posting${droppedForeign === 1 ? '' : 's'} outside the published regions (${detail}).`);
  }

  if (droppedNonTech) {
    log.info(`Held back ${droppedNonTech} non-engineering posting${droppedNonTech === 1 ? '' : 's'} — the site is engineering-only.`);
  }

  if (dropped) {
    log.warn(`Held back ${dropped} stored job${dropped === 1 ? '' : 's'} whose company no longer matches the watchlist.`);
  }

  // Every posting this employer has ever run, not just the live ones.
  //
  // A company hub is evergreen — it ranks for "<company> internship" over
  // months — but it used to be built only from live jobs, so the moment an
  // employer's last posting aged out the page was DELETED. 198 distinct company
  // pages had been deleted that way, against 83 live, and several flapped:
  // piramal-pharma and bain-and-company were each deleted four times and
  // rebuilt five. Every cycle 404s a URL Google has indexed and throws away the
  // ranking it had accumulated; the instability itself costs more than the
  // missing page, because it burns crawl budget and suppresses the URL.
  //
  // Passing history separately keeps job-page expiry exactly as it was —
  // Google's JobPosting rules require an expired posting to stop being served,
  // and that is still what happens. Only the hub survives.
  //
  // Filtered through the same gates as the live set, and deliberately re-run
  // against the CURRENT watchlist, so an employer removed from it (TAXOSMART,
  // VAYUZ) does not keep a permanent page.
  // Grouped on row.company, exactly as the live pages are — the display name on
  // the posting, NOT company_matched. Using the watchlist label here would slug
  // to a different URL and quietly fork every hub in two.
  const history = store.recentJobs(0)
    .map((row) => ({ row, matchedNow: matchCompany(row.company, cfg.watchlist), region: resolveRowRegion(row) }))
    .filter(({ row, matchedNow, region }) => row.is_tech === 1
      && !isBlockedCompany(row.company)
      && (!cfg.matching?.requireCompanyMatch || matchedNow)
      && wanted.has(region))
    // Widened 24 Aug. This used to carry title/roleLabel/postedAt only, which
    // was enough to LIST past roles but not to say anything about them. The
    // company hub now aggregates over an employer's whole tracked history —
    // the skills they ask for, who is eligible, which cities they hire in —
    // and that is the only unique, evergreen content a hub has. The rows are
    // already in memory here; carrying six more fields costs nothing.
    .map(({ row, matchedNow, region }) => ({
      company: row.company || matchedNow || 'Unknown',
      title: row.title,
      roleLabel: row.role_label ?? '',
      postedAt: row.posted_at || row.first_seen_at || 0,
      location: row.location || null,
      workplaceType: row.workplace_type || null,
      duration: row.duration || null,
      applicants: row.applicants || null,
      degreeLevel: row.degree_level || null,
      skills: row.skills || [],
      keySkills: parseJsonArray(row.key_skills),
      stipend: formatStipend({
        min: row.stipend_min, max: row.stipend_max,
        currency: row.stipend_currency, period: row.stipend_period,
      }),
      region,
    }));

  // ---- one board per published region ---------------------------------------
  // Partitioned here rather than in SQL, exactly like techRolesOnly above: a
  // region that is switched off simply stops appearing, nothing is deleted, and
  // switching it on shows everything already collected for it.
  const groupBy = (rows) => {
    const map = new Map(regions.map((r) => [r.code, []]));
    for (const row of rows) map.get(row.region)?.push(row);
    return map;
  };
  const jobsByRegion = groupBy(publicJobs);
  const historyByRegion = groupBy(history);

  const written = [];
  for (const region of regions) {
    const regionJobs = jobsByRegion.get(region.code) ?? [];
    const techCount = regionJobs.filter((j) => j.isTech).length;
    const payload = {
      generatedAt: Date.now(),
      region: region.code,
      regionName: region.name,
      count: regionJobs.length,
      techCount,
      otherCount: regionJobs.length - techCount,
      companies: [...new Set(regionJobs.map((j) => j.company))].sort(),
      locations: [...new Set(regionJobs.map((j) => j.location).filter(Boolean))].sort(),
      jobs: regionJobs,
    };

    const file = jobsFileFor(region);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 1)}\n`);
    written.push({ region, count: regionJobs.length, techCount, path: file });
  }

  // Static pages for search engines. The JSON above serves the app; these serve
  // crawlers, which cannot run the JavaScript that turns it into listings.
  /* Which alert channels each board actually has. Computed here because
     pages.js takes no config on purpose; src/channels.js decides, and its rule
     is that a region with no channel gets no link rather than another
     region's. */
  const channelsByRegion = new Map(regions.map((r) => [r.code, channelsFor(r.code, cfg)]));
  const pages = writeSite(jobsByRegion, PUBLIC_DIR, historyByRegion, regions,
    { validDays: maxAgeDays, channelsByRegion, statsByRegion: dailyStats(store, regions), redirectsByRegion });

  const withLogo = publicJobs.filter((j) => j.logo).length;
  const techCount = publicJobs.filter((j) => j.isTech).length;
  return {
    count: publicJobs.length, techCount, withLogo, logoBytes: logoDirSize(), pages, written,
    path: written[0]?.path ?? jobsFileFor(regions[0]),
    /* THE IDS THAT ACTUALLY GOT A PAGE. The Telegram post links to one page
       per listing, and it was being handed everything the scan collected —
       which is not the same set. Anything held back here (non-tech, off the
       watchlist, deduped away, outside a published region) has no page, so the
       link 404s. Returning the set is the only way the two cannot drift: it is
       the very array the files were written from. */
    publishedIds: new Set(publicJobs.map((j) => String(j.id))),
  };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).toString().split('\n')[0]}`);
  }
}

/** Block the run for a moment. pushToSite is synchronous all the way down. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Push, retrying a network failure.
 *
 * The push is one HTTPS round trip, and a few seconds of dead network is enough
 * to lose it. On 10 Aug a HARMAN internship was scraped, classified, enriched
 * and written — and then the push hit seven seconds of no route to github.com.
 * The listing did not reach the site for another thirteen minutes, by which time
 * the Telegram channel, the phone push and the opened report had all announced
 * it. Somebody applied from an announcement for a job the site did not show.
 *
 * Only connectivity errors are retried. A rejected non-fast-forward or a
 * credential failure will not fix itself, and retrying those just burns the
 * remaining run budget.
 */
function pushWithRetry(branch, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(['push', 'origin', branch]);
      if (attempt > 1) log.ok(`Push succeeded on attempt ${attempt}.`);
      return;
    } catch (err) {
      const transient = /could not resolve host|failed to connect|couldn't connect|timed out|connection reset|network is unreachable|unable to access/i
        .test(err.message);
      if (!transient || attempt >= attempts) throw err;
      const wait = attempt * 5;
      log.warn(`Push attempt ${attempt} failed on the network — retrying in ${wait}s.`);
      sleepSync(wait * 1000);
    }
  }
}

/**
 * Commit and push the jobs file. Vercel is watching the repo, so the push is
 * what makes the site update — usually live within a minute.
 */
/**
 * The region trees publish owns, India excluded.
 *
 * Read from the registry rather than from config, deliberately: a region that
 * was published yesterday and switched off today still has a tree to REMOVE,
 * and leaving it out of the allowlist would mean the deletion never got
 * committed — the pages would go on being served.
 *
 * **Filtered to paths git can actually resolve, and that is not tidiness.**
 * `git add` fails hard on a pathspec matching nothing:
 *
 *     fatal: pathspec 'web/public/us' did not match any files
 *
 * The registry knows ten regions and only the published ones have a directory,
 * so passing all ten aborted `git add` — which aborted the commit, which meant
 * publish wrote every file correctly and then pushed NOTHING. The site froze
 * while the scan, the enrichment and the Telegram post all reported success.
 *
 * A path counts if it exists on disk OR is tracked in git. The second half is
 * what lets a switched-off region's deletion be staged: the directory is gone
 * from the working tree, but git still knows the files and resolves the
 * pathspec against the index.
 */
function regionPaths() {
  return ALL_REGIONS
    .map((r) => r.slug)
    .filter(Boolean)
    .map((slug) => `web/public/${slug}`)
    .filter((rel) => existsSync(join(ROOT, rel))
      || !!git(['ls-files', '--', rel], { allowFail: true }));
}

/**
 * Exactly the paths the scheduler commits.
 *
 * A GENERATED PAGE MISSING FROM HERE IS WRITTEN EVERY RUN AND PUSHED NEVER,
 * which looks exactly like a page that renders wrong. That has now happened
 * three times - /alerts, /report, and the /skills and /locations facet pages,
 * whose US and UK copies served 200 the whole time because those regions are
 * allowlisted by DIRECTORY while India is enumerated file by file.
 * `test/published.test.mjs` renders India and fails if anything it creates at
 * the root is not covered here.
 */
export function publishedPaths() {
  return ['web/public/data', 'web/public/logos', 'web/public/jobs',
    'web/public/companies', 'web/public/sitemap.xml', 'web/public/robots.txt',
    'web/public/feed.xml', 'web/public/feed.json', 'web/public/index.html',
    // India's /alerts and /report. Every other region's is inside its own tree
    // below, covered by regionPaths() — India is the one that has to be named,
    // because its board lives at the root beside files that are NOT published.
    // A generated page missing from this list is written every run and pushed
    // never, which looks exactly like a page that renders wrong.
    'web/public/alerts.html',
    /* The 404. Vercel serves its own raw error screen - complete with an
       internal error id - for any unmatched path unless the deployment carries
       one, and that page is where a site reads as maintained or generated. */
    'web/public/404.html',
    'web/public/report.html',
    /* India's skill and city facet pages. Named here for the same reason
       /alerts and /report are: every other region's live inside its own tree
       and are covered by regionPaths(), while India's sit at the root. Missing
       them cost a live 404 on 47 URLs that were already in India's sitemap —
       /us/skills/python and /uk/skills served 200 the whole time, because
       those trees are allowlisted by directory. */
    'web/public/skills',
    'web/public/locations',
    /* The IndexNow key file. It MUST be live at the domain root or every
       submission is refused 403 — and nothing on the site would look wrong.
       The filename is the key itself and must match indexing.indexNow.key. */
    'web/public/96d97088a61babe560d257ceb8408820.txt',
    // Every non-India region writes a whole tree under its own slug — data,
    // jobs, companies, sitemap, feeds and its homepage. Listed by directory so
    // switching a region on in config.json needs no change here; India stays
    // enumerated above because it lives at the root beside files that are NOT
    // published (styles.css, app.js, page.css, page.js, vercel.json).
    ...regionPaths()];
}

export function pushToSite(newJobCount) {
  if (!existsSync(join(ROOT, '.git'))) {
    log.warn('Not a git repository — skipping publish. Run `git init` and connect the GitHub remote first.');
    return false;
  }

  // Everything publish regenerates. Narrow on purpose — never `git add .`, or an
  // unattended run would commit whatever source edit happened to be in progress.
  // index.html is here because publish now writes the listings into it — only
  // the region between the LISTINGS markers, everything else is hand-authored.
  const PUBLISHED = publishedPaths();

  const status = git(['status', '--porcelain', ...PUBLISHED], { allowFail: true });
  if (!status) {
    log.info('Job list is unchanged — nothing to publish.');
    return false;
  }

  const remote = git(['remote'], { allowFail: true });
  if (!remote) {
    log.warn('No git remote configured — the jobs file was written but not published.');
    return false;
  }

  try {
    git(['add', ...PUBLISHED]);
    const message = newJobCount > 0
      ? `Add ${newJobCount} new internship${newJobCount === 1 ? '' : 's'}`
      : 'Refresh job listings';
    // The pathspec is the point. `git add` is narrow, but a bare `git commit`
    // takes the whole index with it — so anything already staged when the timer
    // fired (a half-finished source edit, staged and left) rode along into an
    // unattended commit and got pushed. With the pathspec, only these paths are
    // committed and the rest of the index is left exactly as it was.
    git(['commit', '-m', message, '--', ...PUBLISHED]);

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    pushWithRetry(branch);
    log.ok(`Published to the site — Vercel will redeploy within a minute.`);
    return true;
  } catch (err) {
    // A publish failure must never fail the scrape; the data is safe locally.
    log.warn(`Could not publish: ${err.message}`);
    // Say what this costs, because the alerts have already gone out by now and
    // the gap between them and the site is the part that misleads somebody.
    log.warn('The commit is local and unpushed. Alerts for these jobs have already been sent, '
      + 'so the site is behind them until the next run pushes — `git push` now to close the gap.');
    return false;
  }
}

/** Full publish step, called at the end of a run. */
/**
 * Queue this publish's job pages for the Indexing API and drain what is due.
 *
 * Split out so the noisy part — deciding whether to say anything at all — does
 * not sit in the middle of publish(). A missing key is not a warning: the
 * feature ships switched off and says so once, the same call src/websearch.js
 * makes, because a line every 30 minutes about a key nobody has set is noise
 * that trains you to stop reading the log.
 */
async function indexStep(store, cfg, pages) {
  if (cfg.indexing?.enabled === false) return;
  if (!indexingConfigured()) {
    /* Once a day, not once a scan. bin/run.sh fires 48 times a day and a line
       every 30 minutes about a key nobody has set is how you learn to stop
       reading the log. Same call src/websearch.js makes for its missing key —
       and note this throttles only the NOTICE: there is no "done for today"
       gate, so adding the key at noon starts announcing on the very next run
       rather than waiting for tomorrow. */
    const today = new Date().toISOString().slice(0, 10);
    if (store.getSetting('indexingNoKeyNoticeDay') !== today) {
      store.setSetting('indexingNoKeyNoticeDay', today);
      log.info('Indexing API: no service-account key — job pages are not being announced to Google. See src/indexing.js for the four setup steps.');
    }
    return;
  }
  const { queuedUpdate, queuedDelete } = queueForIndexing(store, pages);
  const res = await runIndexingSweep(store, cfg);
  if (queuedUpdate || queuedDelete || res.sent) {
    log.info(`Indexing API: queued ${queuedUpdate} new and ${queuedDelete} removed, sent ${res.sent}${res.failed ? `, ${res.failed} failed` : ''} (${res.spent ?? 0}/${res.cap ?? '?'} used in 24h).`);
  }
}

export async function publish(store, cfg, newJobCount) {
  if (cfg.publish?.enabled === false) return;

  try {
    const { count, techCount, withLogo, logoBytes, pages, written, publishedIds } = await writeJobsFile(store, cfg);
    log.info(`Wrote ${count} jobs (${techCount} tech, ${count - techCount} other) — ${withLogo} with a logo, ${Math.round(logoBytes / 1024)} KB stored`);
    // One line per board. A single total hides the thing worth watching once
    // more than one region is live: whether any of them is empty.
    for (const w of written) {
      log.info(`  ${w.region.name}: ${w.count} live → ${w.path.replace(ROOT, '.')}`);
    }
    log.info(`Generated ${pages.jobPages} job pages and ${pages.companyPages} company pages (${pages.indexable} indexable${pages.removed ? `, ${pages.removed} stale removed` : ''}).`);
    log.info(`Homepages carry ${pages.homeLinks} crawlable listing link${pages.homeLinks === 1 ? '' : 's'}.`);
    if (cfg.publish?.autoPush !== false) pushToSite(newJobCount);

    /* Announce the job pages to Google AFTER the push, and in a try/catch of
       its own.
       After, because the API makes Google fetch the URL — announcing a page
       that is still building on Vercel invites a crawl of the previous build.
       (`indexing.minAgeMinutes` is the real guard: a URL queued now is not
       eligible to be sent until the next publish, by which time the deploy has
       long landed. This ordering is the cheap half of the same argument.)
       Its own try/catch, because publish()'s catch returns null, and null is
       how the caller is told "we do not know what is on the site" — which stops
       Telegram posting. A search-engine hint failing must not do that. */
    try {
      await indexStep(store, cfg, pages);
    } catch (err) {
      log.warn(`Indexing step failed: ${err.message}`);
    }

    /* IndexNow, in its own try/catch for the same reason: a search engine being
       unreachable must not turn a good publish into the `null` that stops
       Telegram posting. Separate from indexStep because they are different
       engines with different rules — Google takes job pages only, this takes
       everything that changed. */
    try {
      if (indexNowConfigured(cfg)) {
        const res = await submitUrls(pages.changedUrls ?? [], cfg);
        if (res.sent) log.info(`IndexNow: announced ${res.sent} changed page${res.sent === 1 ? '' : 's'} to Bing.`);
        else if (res.error) log.warn(`IndexNow: ${res.error}`);
      }
    } catch (err) {
      log.warn(`IndexNow step failed: ${err.message}`);
    }
    return publishedIds;
  } catch (err) {
    log.warn(`Publish step failed: ${err.message}`);
    /* null, not an empty set, and the caller tells them apart: an empty set
       means "publish ran and published nothing", while null means "we do not
       know what is on the site". The Telegram post treats the second as a
       reason not to post at all — a link is only worth sending once we know a
       page is behind it. */
    return null;
  }
}
