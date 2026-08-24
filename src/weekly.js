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
 * Measured on real weeks: ~79 India engineering internships from ~52 employers.
 * Listing those with a link each is roughly 8,000 characters against LinkedIn's
 * 3,000, so what fits is decided by budget and what does not is SAID OUT LOUD —
 * on the page and in the post itself. A roundup that silently drops half the
 * week reads as though the week were half as good.
 */
import { resolveRowRegion, regionOf } from './regions.js';
import {
  boldSans, utmUrl, telegramFor, cityOf, tidyTech,
  MAX_POST_CHARS, MAX_COMMENT_CHARS,
} from './postgen.js';
import { SITE, jobSlug } from './pages.js';

const B = boldSans;

/** Room kept for the closing block that is appended after the listing is built. */
const TAIL_BUDGET = 620;

/**
 * How many follow-up comments of apply links are worth posting.
 *
 * Four is already a lot. At ~8 roles a comment that covers about 32 of the 79,
 * and past that a thread of link comments reads as spam rather than as service
 * — the board is one click away and holds all of them.
 */
const DEFAULT_MAX_COMMENTS = 4;

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
export function weekRoles(store, { region = 'IN', sinceMs, untilMs = Date.now() } = {}) {
  return store.recentJobs(sinceMs)
    .filter((row) => row.is_tech === 1)
    .filter((row) => (row.employment_type ?? 'intern') === 'intern')
    .filter((row) => row.first_seen_at <= untilMs)
    .filter((row) => resolveRowRegion(row) === region);
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

function companyBlock(group, region) {
  const where = placeOf(group, region);
  const titles = [...new Set(group.roles.map((r) => tidyTech(r.title)))];
  const shown = titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ` · +${titles.length - 3} more` : '');
  return `▪️ ${B(group.company)}${where ? ` — ${where}` : ''}\n   ${shown}`;
}

/**
 * The apply links, as follow-up comments.
 *
 * Split on whole roles so a comment can never end mid-URL, and each one says
 * which part of the set it is — a bare list of links posted three times under
 * one post looks like it went wrong.
 */
export function applyComments(roles, cfg, { max = DEFAULT_MAX_COMMENTS } = {}) {
  const entries = roles.map((row) => {
    const url = utmUrl(
      `${SITE}/jobs/${jobSlug({ company: row.company, title: row.title, id: row.job_id })}`,
      { campaign: 'weekly' }, cfg,
    );
    return `${row.company} · ${tidyTech(row.title)}\n${url}`;
  });

  const comments = [];
  let current = [];
  const header = () => `${B('Apply links')} — part ${comments.length + 1}\n`;

  for (const entry of entries) {
    const next = [...current, entry];
    if (`${header()}\n${next.join('\n\n')}`.length > MAX_COMMENT_CHARS) {
      if (current.length) comments.push(current);
      current = [entry];
      if (comments.length >= max) break;
    } else {
      current = next;
    }
  }
  if (current.length && comments.length < max) comments.push(current);

  const used = comments.flat().length;
  return {
    comments: comments.map((group, i) => `${B('Apply links')} — part ${i + 1}\n\n${group.join('\n\n')}`),
    covered: used,
    omitted: roles.length - used,
  };
}

/**
 * @param {Store}  store
 * @param {object} cfg
 * @param {{now?: number, days?: number}} [opts]
 */
export function weeklyRoundup(store, cfg, { now = Date.now(), days = 7 } = {}) {
  const conf = cfg.postQueue?.weekly ?? {};
  const region = conf.region || 'IN';
  const zone = regionOf(region)?.timeZone ?? 'Asia/Kolkata';
  const sinceMs = now - days * 86_400_000;

  const roles = weekRoles(store, { region, sinceMs, untilMs: now });
  const groups = byCompany(roles);

  const span = `${dayLabel(sinceMs, zone)} – ${dayLabel(now, zone)}`;
  const head = groups.length === 1
    ? `🗓️ ${B('1 company')} ${B('opened engineering internships this week')} 📌`
    : `🗓️ ${B(String(groups.length))} ${B('companies opened engineering internships this week')} 📌`;

  const lede = `${span} · ${roles.length} role${roles.length === 1 ? '' : 's'}, every one of them live on the board when I wrote this.`;

  const boardUrl = utmUrl(`${SITE}/`, { campaign: 'weekly', content: 'roundup' }, cfg);
  const telegram = telegramFor(cfg, region);

  // Fill until the listing would push the finished post over the limit. The
  // tail is built after this, so its length is reserved rather than measured.
  const listed = [];
  let used = `${head}\n\n${lede}\n\n`.length + TAIL_BUDGET;
  for (const group of groups) {
    const block = companyBlock(group, region);
    if (used + block.length + 2 > MAX_POST_CHARS) break;
    listed.push(group);
    used += block.length + 2;
  }
  const dropped = groups.length - listed.length;

  const tail = [
    dropped ? `…and ${dropped} more compan${dropped === 1 ? 'y' : 'ies'} on the board.` : '',
    `👉 ${B('Every role, with apply links')}: ${boardUrl}`,
    telegram ? `📢 I list them the minute they open: ${telegram.handle} on Telegram.` : '',
    `Graduating soon, or know someone who is? ${B('Share this')} 🚀`,
    `Follow me for more ${B('Jobs')}, ${B('Internships')} & ${B('Career Opportunities')} 🔥`,
    '#internship #hiring #techjobs #engineering #interndoor #freshers',
  ].filter(Boolean);

  const post = [head, lede, listed.map((g) => companyBlock(g, region)).join('\n\n'), ...tail]
    .filter(Boolean).join('\n\n').slice(0, MAX_POST_CHARS);

  const links = applyComments(roles, cfg, { max: conf.maxComments ?? DEFAULT_MAX_COMMENTS });

  return {
    post,
    comments: [
      telegram
        ? `Every live engineering internship, updated as they open 👉 ${boardUrl}\n\nNew roles the minute they go up, on Telegram 👉 ${telegram.url}`
        : `Every live engineering internship, updated as they open 👉 ${boardUrl}`,
      ...links.comments,
    ],
    stats: {
      span,
      region,
      roles: roles.length,
      companies: groups.length,
      companiesListed: listed.length,
      companiesDropped: dropped,
      linksCovered: links.covered,
      linksOmitted: links.omitted,
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
