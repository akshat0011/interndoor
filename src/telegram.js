/**
 * Post new listings to a Telegram channel — ONE MESSAGE PER ROLE.
 *
 * Why Telegram and not WhatsApp: WhatsApp has no public API for posting to a
 * channel, so the only way to automate it is to drive WhatsApp Web in a browser
 * — which is against their Acceptable Use policy and gets the *number* banned,
 * not the browser. Telegram publishes a Bot API, so this is a plain HTTPS call
 * that breaks only if Telegram changes their API rather than their markup.
 *
 * IT USED TO BATCH A WHOLE RUN INTO ONE MESSAGE, on the reasoning that six
 * notifications is how a channel gets muted. That was the wrong trade. A batch
 * gives every role the same three lines, no image, and no apply link — the
 * reader has to open the site and find the role again before they can do
 * anything, and Telegram renders one preview for the whole message, so twelve
 * roles shared one generic picture. A role per message means each one arrives
 * with its own card, its own facts and a link that applies.
 *
 * THE CAPTION IS COMPOSED SEPARATELY FROM THE SENDING (`composeJob`) so the
 * WhatsApp channel, when it exists, reuses the wording rather than growing a
 * second copy of it that drifts.
 *
 * Everything here fails soft. A channel post is the least important thing a run
 * does; it must never be the reason a scrape is recorded as failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { jobSlug, SITE, stipendText, durationText, modeText, clampWords } from './pages.js';
import { resolveRowRegion, regionOf, regionPath, publishedRegions } from './regions.js';
import { PATHS } from './paths.js';
import { renderCards } from './ogcard.js';

const API = 'https://api.telegram.org';

/** Telegram hard-limits a photo caption to 1024 characters. Stay clear of it. */
const MAX_CAPTION = 950;

/**
 * Between messages.
 *
 * A run can find forty-five new roles — 29 Aug did — and forty-five sends in a
 * tight loop is what a rate limiter is for. At this pace the worst run costs
 * about eighteen seconds and Telegram never has to say no.
 */
const SEND_GAP_MS = 400;

/**
 * A 429 is Telegram telling us exactly how long to wait, and it was thrown away.
 *
 * `SEND_GAP_MS` paces a run at 150 messages a minute, which is comfortably over
 * what a channel is allowed, so a burst trips the limiter — and `postOne` logged
 * the refusal and moved on, dropping the listing for good. Measured across the
 * logs: 100 posts lost to 429 in three days (26 on 31 Aug, 61 on 1 Sep, 13 on
 * 2 Sep), every one of them a role that went live on the site and was never
 * announced to the channel it was meant for.
 *
 * The fix is not a wider gap. A fixed gap is a guess at an undocumented limit
 * and would slow every ordinary run to pay for the rare burst; `retry_after` is
 * the real number, sent by the server, and honouring it throttles to exactly
 * what the channel allows exactly when it matters.
 *
 * Bounded on both axes so a bad afternoon cannot stall the posting phase:
 * observed waits run 9–28s, the cap is well clear of that, and a role that
 * cannot get through in three attempts is logged and left rather than retried
 * for ever.
 */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_SEND_ATTEMPTS = 3;

/**
 * And a budget for the WHOLE batch, because per-message bounds do not compose.
 *
 * Three attempts at up to 60s each is two minutes a message, and a run can find
 * forty-five roles — so a deeply throttled afternoon could sit here for over an
 * hour, past the 30-minute interval the scheduler measures from the START of a
 * run. `finishRun` is already written before the posting phase so the run row
 * stays honest, but the next scan would still be queued behind this one.
 *
 * Five minutes is comfortably more than any observed burst needs (the worst was
 * 61 messages against waits of 9–28s, and honouring the first few waits is what
 * clears the rest) and is a small fraction of the interval. Past it, sends stop
 * waiting and fail the way they used to — which is no worse than today.
 */
const MAX_TOTAL_RETRY_MS = 300_000;

/**
 * The wait to actually take: what Telegram asked for, if the batch can afford it.
 *
 * Separated from `retryAfterMs` so both halves are testable without a network —
 * this is the whole decision, and a partial wait is refused rather than
 * truncated. Sleeping less than Telegram asked for is not a shorter wait, it is
 * a wasted one: the retry lands inside the same window and is refused again.
 */
export function plannedWait(status, data, budgetLeftMs) {
  const wait = retryAfterMs(status, data);
  if (!wait) return 0;
  return wait <= budgetLeftMs ? wait : 0;
}

/**
 * How long Telegram asked us to wait, in milliseconds — 0 when it did not ask.
 *
 * The number lives at `parameters.retry_after`; older replies and some proxies
 * put it at the top level, so both are read. A quarter second is added because
 * waiting exactly the stated window lands on the boundary and is refused again.
 * Anything absent, unparseable or non-positive means "this is not a wait we
 * were told to take", and the caller gives up rather than inventing one.
 */
export function retryAfterMs(status, data) {
  if (status !== 429) return 0;
  const secs = Number(data?.parameters?.retry_after ?? data?.retry_after);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(Math.ceil(secs) * 1000 + 250, MAX_RETRY_WAIT_MS);
}

/**
 * Above this the applicant count is left out, exactly as the board and the
 * LinkedIn post already do. The number exists to prove the reader is EARLY; on
 * a crowded role, printed next to an apply link, it argues against clicking.
 */
const APPLICANTS_SHOW_MAX = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTML-escape for Telegram's parse_mode=HTML.
 *
 * Company names and titles come from LinkedIn and are not trusted. An
 * unescaped "&" or "<" makes Telegram reject the whole message with a 400,
 * which would silently drop that listing.
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** "2h ago", "just now" — a live message, so relative reads correctly here. */
function ago(ms) {
  if (!ms) return '';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/** "47 people clicked apply" -> 47. Only a real number is ever used. */
export function applicantCount(text) {
  const m = String(text ?? '').match(/\b(\d[\d,]*)\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  // "Over 100" is MORE than 100 and must never read as a low number.
  return /\bover\b/i.test(String(text)) ? n + 1 : n;
}

/**
 * One role, as a channel message.
 *
 * EMOJI CARRY THE STRUCTURE so the eye can skip to the line it wants without
 * reading labels, and every line is a stored fact. Nothing is generated and
 * nothing is padded: a line with no value is simply absent, which is why a
 * sparse posting reads as short rather than as a column of blanks.
 *
 * TWO LINKS AND NO MORE. The title links to the job page — the details, and the
 * only thing that brings a reader onto the site — and "Apply" goes straight to
 * the employer wherever we recovered it. A third link would only compete with
 * those two.
 *
 * Exported so the WhatsApp channel reuses this wording instead of growing a
 * second copy that drifts out of step.
 */
/**
 * The facts of one posting, and their order, with no markup on them.
 *
 * Extracted so Telegram and WhatsApp say the SAME thing from one source rather
 * than growing a second copy that drifts — which is the reason composeJob was
 * exported in the first place. They cannot share a finished string: Telegram
 * takes HTML and real hyperlinks, WhatsApp takes *bold* and bare URLs and has
 * no anchor at all. What they can share is this.
 */
export function jobParts(job, region = regionOf('IN')) {
  const prefix = regionPath(region.code);
  const page = `${SITE}${prefix}/jobs/${jobSlug({ company: job.company, title: job.title, id: job.id ?? job.job_id })}`;
  const apply = job.applyUrl || job.url || page;
  const title = clampWords(String(job.title ?? ''), 110);

  const facts = [];
  const where = [job.location, modeText(job)].filter(Boolean).join(' · ');
  if (where) facts.push(`📍 ${where}`);
  const money = stipendText(job);
  if (money) facts.push(`💰 ${money}`);
  const dur = durationText(job);
  if (dur) facts.push(`⏳ ${dur}`);
  if (job.degreeText) facts.push(`🎓 ${job.degreeText}`);
  const posted = ago(job.postedAt ?? job.firstSeenAt);
  if (posted) facts.push(`🕐 Posted ${posted}`);

  const n = applicantCount(job.applicants);
  if (n === 0) {
    // The strongest line the channel has, and "Only 0 applicants so far" threw
    // it away on a phrasing.
    facts.push('👥 No applicants yet — be the first');
  } else if (n != null && n < APPLICANTS_SHOW_MAX) {
    facts.push(`👥 Only ${n} applicant${n === 1 ? '' : 's'} so far`);
  }

  return { company: String(job.company ?? ''), title, page, apply, facts, board: `${SITE}${prefix}/` };
}

export function composeJob(job, region = regionOf('IN')) {
  const prefix = regionPath(region.code);
  const page = `${SITE}${prefix}/jobs/${jobSlug({ company: job.company, title: job.title, id: job.id ?? job.job_id })}`;
  const apply = job.applyUrl || job.url || page;

  /* THE TITLE IS CLAMPED FIRST, and dropping fact lines is only a backstop.
     Real titles run to 172 characters — one employer names fifteen cities in
     one — and a title that long blows past Telegram's 1024-character caption
     limit on its own, at which point no amount of dropping facts recovers it
     and Telegram rejects the whole message with a 400. Measured before this:
     a 700-character title produced an 1139-character caption. clampWords is
     the site's own trimmer, already used for every meta description. */
  const title = clampWords(String(job.title ?? ''), 110);

  /* COMPANY FIRST, THEN THE ROLE. The board's own cards invert this — the role
     is the heading there, because nobody scans a job BOARD for "NoBroker" —
     but a channel is a feed of single messages, and what stops a thumb is the
     employer's name. It also matches the card sitting directly above it, which
     already leads with the company as its eyebrow. */
  const lines = [
    `🏢 <b>${esc(job.company)}</b>`,
    `🚀 <b><a href="${page}">${esc(title)}</a></b>`,
    '',
  ];

  const where = [job.location, modeText(job)].filter(Boolean).join(' · ');
  if (where) lines.push(`📍 ${esc(where)}`);
  const money = stipendText(job);
  if (money) lines.push(`💰 ${esc(money)}`);
  const dur = durationText(job);
  if (dur) lines.push(`⏳ ${esc(dur)}`);
  if (job.degreeText) lines.push(`🎓 ${esc(job.degreeText)}`);

  const posted = ago(job.postedAt ?? job.firstSeenAt);
  if (posted) lines.push(`🕐 Posted ${posted}`);

  const n = applicantCount(job.applicants);
  if (n === 0) {
    // The strongest line the channel has, and "Only 0 applicants so far" threw
    // it away on a phrasing.
    lines.push('👥 No applicants yet — be the first');
  } else if (n != null && n < APPLICANTS_SHOW_MAX) {
    lines.push(`👥 Only ${n} applicant${n === 1 ? '' : 's'} so far`);
  }

  lines.push('', `👉 <a href="${apply}"><b>Apply now</b></a>`);
  lines.push(`🌐 <a href="${SITE}${prefix}/">More internships</a>`);

  // Drop optional facts from the end rather than slicing, which would cut a
  // link in half and make Telegram reject the whole message with a 400.
  let out = lines.join('\n');
  while (out.length > MAX_CAPTION && lines.length > 6) {
    lines.splice(lines.length - 3, 1);
    out = lines.join('\n');
  }
  return out;
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
 * The published rows for a region, indexed by id.
 *
 * The SITE's shape, not the database row — the same rule the reel pipeline
 * follows. stipendText and modeText read the public projection, and it is the
 * projection that has already been through every cleaning rule the site uses,
 * so a message cannot state something the job page does not.
 */
export function publishedIndex(code) {
  const prefix = regionPath(code);
  const file = join(PATHS.root, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
  const index = new Map();
  if (!existsSync(file)) return index;
  try {
    for (const j of JSON.parse(readFileSync(file, 'utf8')).jobs ?? []) index.set(String(j.id), j);
  } catch { /* a half-written file is not worth failing a run over */ }
  return index;
}

/**
 * @param {object[]} jobs rows from store.jobsForRun(), already filtered to
 *   what publish actually wrote — see the caller in src/index.js.
 * @param {object} cfg loaded config
 * @returns {Promise<boolean>} true if at least one message was sent
 */
export async function postNewJobs(jobs, cfg) {
  const conf = cfg.notifications?.telegram ?? {};
  if (!conf.enabled || !jobs.length) return false;

  const token = process.env.TELEGRAM_BOT_TOKEN;
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

    const index = publishedIndex(code);
    const public_ = group.map((r) => index.get(String(r.job_id))).filter(Boolean);
    if (!public_.length) continue;

    /* Cards go to the STATE directory, not the repo: Telegram uploads the file
       itself, so it never has to be served, and ~110 a day would otherwise land
       in a public repo Vercel clones on all 48 deploys a day. */
    const cards = await renderCards(public_, PATHS.ogCards).catch(() => new Map());

    let ok = 0;
    /* ONE budget for the whole board, not one per message — see
       MAX_TOTAL_RETRY_MS. Per-message bounds do not compose. */
    const budget = { left: MAX_TOTAL_RETRY_MS };
    for (const job of public_) {
      if (await postOne(token, chatId, job, regionOf(code), cards.get(String(job.id)), budget)) ok++;
      await sleep(SEND_GAP_MS);
    }
    if (ok) {
      sent = true;
      log.ok(`Posted ${ok} ${regionOf(code).name} listing${ok === 1 ? '' : 's'} to ${chatId}.`);
    }
  }
  return sent;
}

/**
 * One role, one message, with its own card.
 *
 * sendPhoto rather than a link preview: the card is uploaded from disk, so it
 * does not have to exist on the website and Telegram renders it full width
 * above the caption. Without a card it degrades to sendMessage — a listing
 * still goes out, which is the whole point of failing soft.
 */
async function postOne(token, chatId, job, region, cardPath, budget = { left: MAX_TOTAL_RETRY_MS }) {
  const caption = composeJob(job, region);

  /* Rebuilt per attempt rather than hoisted: a FormData carrying a Blob has
     already been consumed once it is sent, so a retry that reuses it posts an
     empty body and fails in a way that looks like a Telegram fault. */
  const send = () => {
    if (cardPath && existsSync(cardPath)) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('caption', caption);
      form.set('parse_mode', 'HTML');
      form.set('photo', new Blob([readFileSync(cardPath)], { type: 'image/jpeg' }), 'card.jpg');
      return fetch(`${API}/bot${token}/sendPhoto`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
      });
    }
    return fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text: caption, parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  };

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const res = await send();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) return true;

      /* ONLY a 429 carrying a wait is retried. A 400 is our own malformed
         markup and will be malformed again next time; retrying it would turn
         one bad caption into three identical failures in the log. */
      const wait = plannedWait(res.status, data, budget.left);
      if (wait && attempt < MAX_SEND_ATTEMPTS) {
        budget.left -= wait;
        log.info(`Telegram asked for ${Math.round(wait / 1000)}s before ${job.id} — waiting (attempt ${attempt} of ${MAX_SEND_ATTEMPTS}, ${Math.round(budget.left / 1000)}s of batch budget left).`);
        await sleep(wait);
        continue;
      }
      log.warn(`Telegram post failed for ${job.id} (${res.status}): ${data.description ?? 'no detail'}`);
      return false;
    } catch (err) {
      log.warn(`Telegram post skipped for ${job.id} — ${String(err?.message ?? err).split('\n')[0]}`);
      return false;
    }
  }
  return false;
}
