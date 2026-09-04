/**
 * The daily digest — one email a day, per board.
 *
 * WHY ONE A DAY AND NOT ONE PER ROLE. Per-role alerts were the first plan and
 * the arithmetic killed it: India alone averages 11.6 new tech postings a day
 * and peaks at 30, so a subscriber would get thirty emails on a Tuesday. The
 * complaint rate that produces is what decides whether ANY of this mail reaches
 * an inbox again. It is also what the signup box already promises — "one
 * message, no spam" — and Buttondown's own pricing assumes at most one send a
 * day to the whole list, so a digest keeps the free tier honest too. A per-role
 * feed is what Telegram and WhatsApp are for, and both already run.
 *
 * This module is PURE. It reads rows and returns an email, or null. Sending
 * lives behind `sendDigest` in bin/digest.js so the provider can be swapped the
 * way `addSubscriber` is — see web/api/subscribe.js.
 */
import { SITE, stipendText, durationText, modeText, jobSlug } from './pages.js';
import { utmUrl } from './postgen.js';
import { regionOf, regionPath } from './regions.js';

/* `regionUrl` is module-private in pages.js, so the path is composed here the
   way weekly.js does it. `regionPath` returns '' for India — the board is at
   the root, permanently — so this concatenates safely for every region. */
const boardUrlFor = (code, path = '/') => `${SITE}${regionPath(code)}${path}`;

/**
 * The Buttondown status for a configured mode.
 *
 * THE ONLY LINE HERE THAT CAN MAIL A STRANGER BY ACCIDENT, so it is a named
 * function with a test rather than a ternary inside the runner. `about_to_send`
 * is what actually delivers; EVERYTHING else — a typo, an empty string, a
 * missing key, "sending", undefined — must come back a draft. Fail toward the
 * outcome that can be undone.
 */
export function sendStatus(mode) {
  return mode === 'send' ? 'about_to_send' : 'draft';
}

/** How many roles the mail lists in full before it starts counting. */
const MAX_ROLES = 25;

/** Bullets per role. The mail is a nudge to click, not the job page. */
const MAX_BULLETS = 2;

/**
 * The calendar day, in the board's OWN zone.
 *
 * The same rule `roundupDue` follows: "today" for an Indian reader is not
 * today in UTC, and a digest keyed on UTC would fire twice on some days and
 * not at all on others.
 */
export function dayKey(now = Date.now(), zone = 'Asia/Kolkata') {
  const d = new Date(new Date(now).toLocaleString('en-US', { timeZone: zone }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Is today's digest owed?
 *
 * "On or after" the hour, never "at" it — this Mac sleeps, and a job that fires
 * only at 09:00 exactly is simply missed. Same reason the weekly roundup is
 * asked on every scan rather than scheduled.
 */
export function digestDue(cfg, lastKey, now = Date.now(), region = 'IN') {
  const conf = cfg.digest ?? {};
  if (conf.enabled === false) return false;
  const zone = regionOf(region)?.timeZone ?? 'Asia/Kolkata';
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: zone }));
  if (local.getHours() < (conf.hour ?? 9)) return false;
  return lastKey !== dayKey(now, zone);
}

/** The roles a digest may talk about: new since the cutoff, tech, and PUBLISHED. */
export function digestRoles(rows, { sinceMs, publishedIds = null }) {
  return (rows ?? [])
    .filter((r) => r.is_tech === 1 && !r.suppressed_reason)
    .filter((r) => (r.first_seen_at ?? 0) >= sinceMs)
    /* THE SAME GUARD THE CHANNELS LEARNED THE HARD WAY. Telegram posted rows
       publish had held back — non-tech, off-watchlist, losing halves of a
       duplicate — and 40% of a week's links were 404s. A null set means we do
       not know what is on the site, so nothing is claimed. */
    .filter((r) => !publishedIds || publishedIds.has(String(r.job_id)))
    .sort((a, b) => (b.first_seen_at ?? 0) - (a.first_seen_at ?? 0));
}

/** One role, as markdown. */
function roleBlock(row, cfg, code) {
  /* jobSlug takes `id ?? job_id`, so a store row is safe — but only because it
     throws on neither being present. It used to fall back to slugifying an
     empty id, which is how WhatsApp sent a fortnight of links ending `-role`
     that all 404'd while composing and sending perfectly. */
  const url = utmUrl(boardUrlFor(code, `/jobs/${jobSlug(row)}`), {
    campaign: 'digest', content: 'role', source: 'email', medium: 'email',
  }, cfg);

  /* Imported, never re-implemented. `stipend` holds "₹0", "2,026" and
     "AUD 2,018"; `duration` holds "0 to 3 years". Both the reel caption and the
     OG card broke by guessing at these fields (§15). */
  const facts = [row.location, modeText(row), stipendText(row), durationText(row)]
    .filter(Boolean).join(' · ');

  /* `bullets` is an array on a hydrated row and a JSON string on a raw one.
     Accepting both keeps this callable from either side rather than making the
     caller remember which shape it holds. */
  let list = row.bullets;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  const bullets = (Array.isArray(list) ? list : [])
    .slice(0, MAX_BULLETS).map((b) => `  - ${b}`).join('\n');

  return [
    `**${row.company}** — [${row.title}](${url})`,
    facts ? `${facts}` : '',
    bullets,
  ].filter(Boolean).join('\n');
}

/**
 * The day's email, or null when there is nothing worth sending.
 *
 * NULL IS A REAL ANSWER. A weekend morning in India genuinely produces zero new
 * roles, and "0 new internships today" is the message that teaches somebody to
 * unsubscribe. No roles, no mail, and the day is still marked done.
 */
export function buildDigest(rows, cfg, { region: code = 'IN', publishedIds = null, now = Date.now() } = {}) {
  const region = regionOf(code);
  const conf = cfg.digest ?? {};
  const sinceMs = now - (conf.windowHours ?? 24) * 3_600_000;
  const roles = digestRoles(rows, { sinceMs, publishedIds });
  if (!roles.length) return null;

  const shown = roles.slice(0, MAX_ROLES);
  const rest = roles.length - shown.length;
  const where = region.inName.replace(/^in /, '');

  /* A COUNT LEADS. The weekly roundup found the same thing: with no model in
     the loop the strongest opening line available is a number, and it is the
     one fact the reader can act on from the subject line alone. */
  const subject = `${roles.length} new engineering internship${roles.length === 1 ? '' : 's'} in ${where}`;

  const boardUrl = utmUrl(boardUrlFor(code), {
    campaign: 'digest', content: 'board', source: 'email', medium: 'email',
  }, cfg);

  const body = [
    `${roles.length} new engineering internship${roles.length === 1 ? '' : 's'} ${region.inName} since yesterday.`,
    '',
    shown.map((r) => roleBlock(r, cfg, code)).join('\n\n'),
    '',
    rest > 0 ? `— and ${rest} more on [the board](${boardUrl}).\n` : `[See the whole board](${boardUrl}).\n`,
  ].join('\n');

  return { subject, body, count: roles.length, shown: shown.length, roles: shown };
}
