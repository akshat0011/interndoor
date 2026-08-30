/**
 * The Sunday roundup: one post for everything the board picked up this week.
 *
 * Different job from the single-role post, and the difference decides the
 * format. A single post earns a CLICK on one vacancy; this one earns a FOLLOW,
 * by showing that the board is worth coming back to. So it leads with the
 * number of employers, groups by company rather than listing 79 titles flat,
 * and carries one link — to the board, not to any one role.
 *
 * NO MODEL. The strongest opening line here is a count, which is a fact, and
 * every line under it is a company name. There is nothing for a model to write
 * that would not be an invented adjective, and skipping it means the Sunday
 * page never waits on Ollama and can never be delayed by it.
 *
 * IT IS A SHORTLIST, NOT AN INDEX (30 Aug). It used to name every employer of
 * the week — 51 of them — and carry ONE link, to the board, with the apply
 * links pushed into follow-up comments. The complaint that changed it is the
 * obvious one: a reader who wants a role has to leave, land on the board, and
 * find it again. Nobody opens the comments.
 *
 * A LINK UNDER EVERY ROLE IS ARITHMETICALLY IMPOSSIBLE, which is what decided
 * the shape. Measured on the real week of 23-30 Aug: 106 roles, and a line per
 * role with its own apply URL is 16,372 characters against LinkedIn's 3,000 —
 * five and a half times over. Stripping the UTM parameters still only buys
 * about fifteen roles. So the choice was never "all of them with links", it was
 * breadth OR clickability, and clickability won: a handful of roles a reader
 * can act on beats fifty they cannot.
 *
 * So the body carries `featured` roles from the employers hiring hardest, each
 * with its own apply link, and everything else is a count pointing at the
 * board. WHAT DID NOT FIT IS STILL SAID OUT LOUD — a roundup that quietly drops
 * ninety roles reads as though the week were a tenth as good as it was.
 */
import { resolveRowRegion, regionOf } from './regions.js';
import { normaliseCompany } from './config.js';
import {
  boldSans, utmUrl, telegramFor, cityOf, tidyTech,
  MAX_POST_CHARS,
} from './postgen.js';
import { SITE, jobSlug, clampWords } from './pages.js';

const B = boldSans;

/**
 * How many roles get a link of their own.
 *
 * Six, and the ceiling is attention rather than characters — six blocks with a
 * URL each is about 950 characters, comfortably inside the 3,000. A LinkedIn
 * reader scans a handful of lines before deciding to scroll on, and a body of
 * fifteen raw URLs reads as a link dump, which is the thing this format is
 * trying not to be.
 */
const DEFAULT_FEATURED = 6;

function dayLabel(ms, zone) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone });
}

/**
 * The internships collected for one region in a window.
 *
 * Region is RE-DERIVED from the location rather than read from the column, for
 * the same reason publish re-derives it: a row captured before a gazetteer fix
 * carries the old answer, and a corrected location is the documented remedy for
 * a bad geocode.
 */
export function weekRoles(store, { region = 'IN', sinceMs, untilMs = Date.now(), publishedIds = null } = {}) {
  return store.recentJobs(sinceMs)
    .filter((row) => row.is_tech === 1)
    .filter((row) => (row.employment_type ?? 'intern') === 'intern')
    .filter((row) => row.first_seen_at <= untilMs)
    .filter((row) => resolveRowRegion(row) === region)
    /* EVERY ROLE HERE IS LINKED TO, so every one must have a page.
       The store holds far more than the site publishes: rows whose employer has
       since been dropped from the watchlist, the losing half of a
       cross-collector duplicate, anything past the retention window. Selecting
       from the store and linking to /jobs/<slug> anyway is exactly the bug that
       sent 40% of a week's Telegram links to 404s on 28 Aug, and it bit here
       too — the first render of this format featured STEMpedia at number one,
       two days after it was removed from the watchlist as spam. It also made
       the post overstate the week by half: 106 claimed against 71 published.
       The caller passes the ids the published jobs.json actually carries; with
       none passed nothing is filtered, which is what keeps the unit tests free
       of a fixture file. */
    .filter((row) => (publishedIds ? publishedIds.has(String(row.job_id)) : true));
}

/** Roles grouped by employer, the employers hiring most first. */
export function byCompany(roles) {
  const groups = new Map();
  for (const row of roles) {
    const name = row.company || row.company_matched || 'Unknown company';
    if (!groups.has(name)) groups.set(name, { company: name, roles: [], cities: new Set() });
    const g = groups.get(name);
    g.roles.push(row);
    if (row.location) g.cities.add(cityOf(row.location));
  }
  return [...groups.values()].sort((a, b) => b.roles.length - a.roles.length || a.company.localeCompare(b.company));
}

/**
 * "Bengaluru", "Bengaluru & Pune", "4 cities".
 *
 * Two things have to be cleaned up first, both seen in a real run:
 *
 * - LinkedIn writes the same city in different cases on different postings, so
 *   Tower Research came out as "Gurgaon & gurgaon". Deduped case-insensitively,
 *   keeping the better-capitalised spelling.
 * - The country reaches the city slot. Microsoft read "Bengaluru & India" and
 *   Pearson "India & Bengaluru East", because some postings are located at the
 *   country and `cityOf` takes whatever is before the first comma. A country is
 *   not a city and adds nothing to a line that already says which board this is.
 */
function placeOf(group, region) {
  const country = String(regionOf(region)?.name ?? '').toLowerCase();
  const best = new Map();
  for (const raw of group.cities) {
    const city = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const key = city.toLowerCase();
    if (!city || key === country) continue;
    // Prefer the spelling that looks like a proper noun over a lower-cased one.
    const better = (a, b) => ((b.match(/[A-Z]/g) ?? []).length > (a.match(/[A-Z]/g) ?? []).length ? b : a);
    best.set(key, best.has(key) ? better(best.get(key), city) : city);
  }
  const cities = [...best.values()];
  if (!cities.length) return '';
  if (cities.length === 1) return cities[0];
  if (cities.length === 2) return `${cities[0]} & ${cities[1]}`;
  return `${cities.length} cities`;
}

/**
 * How the six featured employers are chosen.
 *
 * IT WAS ROLE COUNT AND THAT WAS WRONG. `byCompany` sorts by how many postings
 * an employer filed this week, and the first version of this format used that
 * order directly on the strength of ONE week that happened to read well (IBM,
 * American Express, Qualcomm). Checked across four weeks it does not hold:
 *
 *   week -1  Silicon Labs, HARMAN, Valeo, Amex, Arctic Wolf, ARGMAC
 *   week -2  HARMAN, Marmon Technologies India Pvt Ltd, FanCode, HighLevel
 *   week -3  Siemens, Emerson, Microsoft, Siemens Healthineers, Citi, GBJ BUZZ
 *
 * Role count measures MULTI-CITY BLASTING, not the employer — IBM's seven are
 * seven city-copies of one opening, which the board itself collapses onto a
 * single card. It is the same trap this project already wrote down for the
 * watchlist: "the employers posting the most internships are overwhelmingly
 * the worst ones; genuine companies post once or twice."
 *
 * NO SIGNAL IN THE DATA MEASURES RECOGNISABILITY, which is what actually earns
 * the click. Ranking by sustained footprint is a real improvement and was
 * measured — it removes STEMpedia and GBJ BUZZ outright — but it surfaces
 * Valeo, HARMAN and Micron: entirely real, and not names a student reacts to.
 * So the judgment lives in config where it can be edited, exactly as the
 * deleted MARQUEE list did for the vetting panel: the LIST decides which names
 * are recognised, and the BOARD decides which of them are hiring today.
 *
 * Membership only, not order — within the list the footprint decides, so there
 * is no priority ranking to maintain. Off-list employers are ranked by the same
 * footprint, so an empty list degrades to that rather than to nothing.
 *
 * Ordering is the ONLY thing this affects. Every employer here is already
 * through the watchlist gate and already published, so a wrong entry costs a
 * slot, never a bad listing.
 */
function recognisedMatcher(names) {
  const norms = (names ?? []).map((n) => normaliseCompany(n)).filter(Boolean);
  return (company) => {
    const c = normaliseCompany(company);
    if (!c) return false;
    /* Deliberately NOT matchCompany. That matches in both directions and its
       own notes record it admitting "HR" and "India (Remote)" — fine for a gate
       that is checked by hand, wrong for something that silently reorders a
       post. A prefix either way covers "HARMAN India" against "HARMAN" and
       stops there. */
    return norms.some((n) => c === n || c.startsWith(`${n} `) || n.startsWith(`${c} `));
  };
}

/**
 * Distinct roles x distinct days seen, over a bounded window.
 *
 * Distinct ROLES rather than postings, so twenty-two copies of one opening in
 * twenty-two cities count once — the same collapse the board makes. Times the
 * number of separate days we have seen them, so a single burst scores below a
 * quiet employer who keeps coming back. Bounded to 90 days because this runs
 * inside a post composer and the whole table is not needed to tell an
 * established hirer from a one-off.
 */
function footprintScorer(store, now) {
  const seen = new Map();
  for (const r of store.recentJobs(now - 90 * 86_400_000)) {
    if (r.is_tech !== 1) continue;
    const c = r.company || '';
    if (!seen.has(c)) seen.set(c, { titles: new Set(), days: new Set() });
    const f = seen.get(c);
    f.titles.add(String(r.title ?? '').toLowerCase().trim());
    f.days.add(Math.floor((r.first_seen_at ?? 0) / 86_400_000));
  }
  return (company) => {
    const f = seen.get(company);
    return f ? f.titles.size * f.days.size : 0;
  };
}

/** Recognised first, then by footprint, then by this week's role count. */
export function rankForFeature(groups, { isRecognised, score }) {
  return [...groups].sort((a, b) =>
    (isRecognised(b.company) ? 1 : 0) - (isRecognised(a.company) ? 1 : 0)
    || score(b.company) - score(a.company)
    || b.roles.length - a.roles.length
    || a.company.localeCompare(b.company));
}

/** The freshest role an employer opened this week — the one worth linking to. */
function newestRole(group) {
  return [...group.roles].sort(
    (a, b) => (b.posted_at ?? b.first_seen_at ?? 0) - (a.posted_at ?? a.first_seen_at ?? 0),
  )[0];
}

/**
 * One employer, one role, one apply link.
 *
 * The place is the COMPANY's for the week rather than that one posting's, and
 * that is deliberate: "IBM — 7 cities" is a truer thing to tell a reader than
 * the single city whose posting the link happens to point at, and placeOf is
 * where the real-data cleanup lives (LinkedIn writes the same city in two
 * cases, and the country reaches the city slot).
 */
function featuredBlock(group, region, cfg) {
  const row = newestRole(group);
  const where = placeOf(group, region);
  const url = utmUrl(
    `${SITE}/jobs/${jobSlug({ company: row.company, title: row.title, id: row.job_id })}`,
    { campaign: 'weekly', content: 'featured' }, cfg,
  );
  /* One real title runs 172 characters — an employer naming fifteen cities in
     it — which turns a three-line block into a paragraph. clampWords is the
     site's own trimmer, already used for every meta description, so this is not
     a second implementation of the same idea. */
  const title = clampWords(tidyTech(row.title), 72);
  return `▪️ ${B(group.company)}${where ? ` — ${where}` : ''}\n   ${title}\n   👉 ${url}`;
}

/**
 * @param {Store}  store
 * @param {object} cfg
 * @param {{now?: number, days?: number}} [opts]
 */
export function weeklyRoundup(store, cfg, { now = Date.now(), days = 7, publishedIds = null } = {}) {
  const conf = cfg.postQueue?.weekly ?? {};
  const region = conf.region || 'IN';
  const zone = regionOf(region)?.timeZone ?? 'Asia/Kolkata';
  const sinceMs = now - days * 86_400_000;

  const roles = weekRoles(store, { region, sinceMs, untilMs: now, publishedIds });
  const groups = byCompany(roles);

  const span = `${dayLabel(sinceMs, zone)} – ${dayLabel(now, zone)}`;

  /* THE ROLE COUNT LEADS, not the employer count. Both are true and the roles
     number is the bigger one — 71 against 49 on the week this changed — and
     LinkedIn shows about two lines before "see more", so the first line is the
     only one guaranteed to be read. */
  const head = roles.length === 1
    ? `🗓️ ${B('1 engineering internship')} ${B('opened this week')} 📌`
    : `🗓️ ${B(String(roles.length))} ${B('engineering internships opened this week')} 📌`;

  const lede = `${span} · ${groups.length} compan${groups.length === 1 ? 'y' : 'ies'}`
    + ` · every one live on the board when I wrote this.`;

  const boardUrl = utmUrl(`${SITE}/`, { campaign: 'weekly', content: 'roundup' }, cfg);
  const telegram = telegramFor(cfg, region);

  /* One role EACH rather than the top six roles outright, or a single employer
     running six postings would take the whole shortlist and the post would name
     one company. See rankForFeature for how the six are chosen. */
  const wanted = Math.max(1, Number(conf.featured ?? DEFAULT_FEATURED));
  const ranked = rankForFeature(groups, {
    isRecognised: recognisedMatcher(conf.featureFirst),
    score: footprintScorer(store, now),
  });
  let featured = ranked.slice(0, wanted);

  const compose = (picked) => {
    const moreRoles = roles.length - picked.length;
    const moreCos = groups.length - picked.length;
    const more = moreRoles > 0
      ? (moreCos > 0
        ? `…and ${B(String(moreRoles))} more roles from ${moreCos} more compan${moreCos === 1 ? 'y' : 'ies'} on the board 👇`
        : `…and ${B(String(moreRoles))} more roles on the board 👇`)
      : '';
    const tail = [
      more,
      `👉 ${B('Every role, with apply links')}: ${boardUrl}`,
      telegram ? `📢 I list them the minute they open: ${telegram.handle} on Telegram.` : '',
      `Graduating soon, or know someone who is? ${B('Share this')} 🚀`,
      `Follow me for more ${B('Jobs')}, ${B('Internships')} & ${B('Career Opportunities')} 🔥`,
      '#internship #hiring #techjobs #engineering #interndoor #freshers',
    ].filter(Boolean);
    return [
      head,
      lede,
      picked.length ? `⚡ ${B('Apply now')} — this week's biggest openings:` : '',
      ...picked.map((g) => featuredBlock(g, region, cfg)),
      ...tail,
    ].filter(Boolean).join('\n\n');
  };

  /* Drop featured roles from the END until it fits. Six blocks is ~950
     characters so this never fires in practice, but a long title and a long
     slug are both real, and the alternative is slicing the post through one of
     its own apply URLs. */
  let post = compose(featured);
  while (post.length > MAX_POST_CHARS && featured.length > 1) {
    featured = featured.slice(0, -1);
    post = compose(featured);
  }

  return {
    post: post.slice(0, MAX_POST_CHARS),
    comments: [
      telegram
        ? `Every live engineering internship, updated as they open 👉 ${boardUrl}\n\nNew roles the minute they go up, on Telegram 👉 ${telegram.url}`
        : `Every live engineering internship, updated as they open 👉 ${boardUrl}`,
    ],
    stats: {
      span,
      region,
      roles: roles.length,
      companies: groups.length,
      companiesListed: featured.length,
      companiesDropped: groups.length - featured.length,
      rolesFeatured: featured.length,
      rolesRemaining: roles.length - featured.length,
    },
  };
}

/** `2026-W34`, in the region's own calendar — the key that stops a repeat. */
export function weekKey(ms, zone = 'Asia/Kolkata') {
  const local = new Date(new Date(ms).toLocaleString('en-US', { timeZone: zone }));
  const target = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  // ISO week: Thursday of this week decides the year and the number.
  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Is the roundup due?
 *
 * True on or after `hour` on `weekday`, once per calendar week. The "once" is
 * what makes this safe to call from every scan: bin/run.sh asks 48 times a day
 * and the answer is yes exactly once.
 *
 * Deliberately "on or after", not "at". A Mac that was asleep at 10:00 on
 * Sunday still gets its roundup when it wakes — which is the normal case here,
 * and the reason this is not a cron entry.
 */
export function roundupDue(cfg, lastKey, now = Date.now()) {
  const conf = cfg.postQueue?.weekly ?? {};
  if (conf.enabled === false) return false;
  const zone = regionOf(conf.region || 'IN')?.timeZone ?? 'Asia/Kolkata';
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: zone }));

  if (local.getDay() !== (conf.weekday ?? 0)) return false;
  if (local.getHours() < (conf.hour ?? 10)) return false;
  return lastKey !== weekKey(now, zone);
}
