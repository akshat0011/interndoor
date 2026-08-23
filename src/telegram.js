/**
 * Post new listings to a Telegram channel.
 *
 * Why Telegram and not WhatsApp: WhatsApp has no public API for posting to a
 * channel, so the only way to automate it is to drive WhatsApp Web in a browser
 * — which is against their Acceptable Use policy and gets the *number* banned,
 * not the browser. Telegram publishes a Bot API, so this is a plain HTTPS call
 * that breaks only if Telegram changes their API rather than their markup.
 *
 * Everything here fails soft. A channel post is the least important thing a run
 * does; it must never be the reason a scrape is recorded as failed.
 */
import { log } from './logger.js';
import { jobSlug, SITE } from './pages.js';
import { resolveRowRegion, regionOf, regionPath, publishedRegions } from './regions.js';

const API = 'https://api.telegram.org';

/** Telegram hard-limits a message to 4096 characters. Stay clear of it. */
const MAX_CHARS = 3800;

/** Listings named individually before the rest become "+N more". */
const MAX_LISTED = 8;

/**
 * HTML-escape for Telegram's parse_mode=HTML.
 *
 * Company names and titles come from LinkedIn and are not trusted. An
 * unescaped "&" or "<" makes Telegram reject the whole message with a 400,
 * which would silently drop the post for every job in that batch.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * One message for the whole run, not one per job.
 *
 * A run that finds six roles firing six notifications is how a channel gets
 * muted. The site's own promise is the lead: these are minutes old.
 */
export function compose(jobs, region = regionOf('IN')) {
  const prefix = regionPath(region.code);
  const n = jobs.length;
  const head = n === 1
    ? '<b>1 new internship</b>'
    : `<b>${n} new internships</b>`;

  const lines = [];
  for (const j of jobs.slice(0, MAX_LISTED)) {
    const url = `${SITE}${prefix}/jobs/${jobSlug({ company: j.company, title: j.title, id: j.job_id })}`;
    const where = [j.location, j.workplace_type].filter(Boolean).join(' · ');
    lines.push(
      `\n<a href="${url}"><b>${esc(j.title)}</b></a>\n`
      + `${esc(j.company)}${where ? ` — ${esc(where)}` : ''}`,
    );
  }

  let body = `${head}\n${lines.join('\n')}`;
  if (n > MAX_LISTED) body += `\n\n…and ${n - MAX_LISTED} more on the site.`;
  body += `\n\n<a href="${SITE}${prefix}/">See every live role →</a>`;

  // Truncating mid-tag would produce invalid HTML and a 400 from Telegram, so
  // drop whole listings until it fits rather than slicing the string.
  while (body.length > MAX_CHARS && lines.length > 1) {
    lines.pop();
    body = `${head}\n${lines.join('\n')}\n\n…and ${n - lines.length} more on the site.`
      + `\n\n<a href="${SITE}${prefix}/">See every live role →</a>`;
  }
  return body;
}

/**
 * Which channel a region's listings go to.
 *
 * `chatId` predates regions and is India's channel; it is kept as the fallback
 * for India alone, so nothing about the existing setup changes. Every other
 * region must be named explicitly in `channels`, and a region with no channel
 * gets no post — because the alternative is posting US listings to people who
 * subscribed for internships in India, which is how a channel gets muted.
 */
function channelFor(conf, code) {
  const explicit = conf.channels?.[code];
  if (explicit) return explicit;
  return code === 'IN' ? (conf.chatId ?? null) : null;
}

/**
 * One message per region per run.
 *
 * Grouped by region because every listing links to its page on the site, and
 * those pages live under the region's own prefix — a US role posted with an
 * India link is a 404 sent to a subscriber.
 *
 * Only PUBLISHED regions are posted at all. A region that is collected but not
 * published has no pages written for it, so every link would 404 no matter
 * which channel it went to.
 *
 * @param {object[]} jobs rows from store.jobsForRun()
 * @param {object} cfg loaded config
 * @returns {Promise<boolean>} true if at least one message was sent
 */
export async function postNewJobs(jobs, cfg) {
  const conf = cfg.notifications?.telegram ?? {};
  if (!conf.enabled || !jobs.length) return false;

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // A missing token is a setup mistake, not a runtime error — say so once,
  // clearly, rather than throwing into the middle of a successful run.
  if (!token) {
    log.warn('Telegram is enabled but TELEGRAM_BOT_TOKEN is not set — skipping the channel post.');
    return false;
  }

  const live = new Set(publishedRegions(cfg).map((r) => r.code));
  const byRegion = new Map();
  for (const job of jobs) {
    const code = resolveRowRegion(job);
    if (!live.has(code)) continue;
    if (!byRegion.has(code)) byRegion.set(code, []);
    byRegion.get(code).push(job);
  }
  if (!byRegion.size) return false;

  let sent = false;
  for (const [code, group] of byRegion) {
    const chatId = channelFor(conf, code);
    if (!chatId) {
      log.info(`No Telegram channel configured for ${code} — ${group.length} listing${group.length === 1 ? '' : 's'} not posted. Add notifications.telegram.channels.${code}.`);
      continue;
    }
    if (await postGroup(token, chatId, group, regionOf(code))) sent = true;
  }
  return sent;
}

async function postGroup(token, chatId, jobs, region) {
  const text = compose(jobs, region);

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // The listings carry their own links; Telegram's link preview would
        // add a large card for whichever it picked first and bury the rest.
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      log.warn(`Telegram post failed (${res.status}): ${data.description ?? 'no detail'}`);
      return false;
    }
    log.ok(`Posted ${jobs.length} ${region.name} listing${jobs.length === 1 ? '' : 's'} to ${chatId}.`);
    return true;
  } catch (err) {
    // Network flake, timeout, Telegram down — none of it should mark the run bad.
    log.warn(`Telegram post skipped — ${String(err?.message ?? err).split('\n')[0]}`);
    return false;
  }
}
