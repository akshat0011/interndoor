/* /api/feedback — the reader's own words, sent to us.
 *
 * WHY IT EXISTS: every other signal this site has is a number. The counters in
 * /api/count say a prompt was dismissed; they cannot say the listing was stale,
 * the apply link was dead, or the board was missing the one employer somebody
 * came for. This is the only surface where a reader can say that in their own
 * words, and `npm run feedback` is where it is read back.
 *
 * WHAT IT KEEPS: the message, an optional reply address, the board, and the
 * page the reader was on. Nothing else — no id, no user agent, no IP. The IP is
 * used for rate limiting inside this one request and never written anywhere.
 *
 * WHAT IT NEEDS: the same Upstash Redis the counter uses (KV_REST_API_URL /
 * KV_REST_API_TOKEN, or Upstash's own UPSTASH_REDIS_REST_* pair).
 *
 * WITH NO STORE IT REFUSES HONESTLY — 503 and a message the page shows
 * verbatim. It does NOT answer 204 the way /api/count does, and the difference
 * is deliberate: the counter is a fire-and-forget beacon nobody is waiting on,
 * while this is a person who has just typed something and is watching for an
 * answer. Telling them it sent when it did not is the failure /api/subscribe's
 * own comment calls worse than having no box at all, and an application-shaped
 * one is worse again. Same rule, same shape as APPLY_FORWARD_URL being unset.
 *
 * NOTHING PERSONAL IS EVER LOGGED. Vercel keeps function logs, so a console
 * line naming the reader or quoting their message IS storage — the rule
 * /api/apply already states. Failures log a status, never a body.
 */
import { normaliseEmail } from './subscribe.js';

export const REGIONS = new Set(['IN', 'US', 'GB']);

/* The Redis list. One list, newest first, trimmed to KEEP — bounded storage
   with no expiry, because feedback is worth reading weeks later and a TTL that
   quietly deletes it is a worse failure than a full list. */
export const LIST_KEY = 'feedback';
export const KEEP = 500;

/* Long enough for a real report ("the apply link on the Siemens page 404s and
   the role closed last week"), short enough that the list cannot be filled with
   one paste. Measured against nothing — it is a judgement, and the floor is the
   part that matters: three characters is not feedback. */
export const MIN_MESSAGE = 4;
export const MAX_MESSAGE = 2000;
export const MAX_PATH = 300;

/* A speed bump, not a vault, exactly as /api/count's own note says. Feedback is
   typed by hand, so the honest rate is single digits an hour; six a minute
   leaves room for someone sending two or three in a row and still stops a
   script filling the list. */
const PER_IP_PER_MINUTE = 6;
const hits = new Map();

export function rateLimited(ip, now, store = hits) {
  if (store.size > 5000) store.clear();
  const times = (store.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= PER_IP_PER_MINUTE) return true;
  times.push(now);
  store.set(ip, times);
  return false;
}

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Control characters out, whitespace collapsed at the ends only.
 *
 * NEWLINES SURVIVE, unlike every other cleaner here. An address becomes extra
 * mail headers when it carries one, which is why normaliseEmail refuses them
 * outright — but this is prose going into a JSON string in a Redis list, where
 * a newline is just a paragraph break and deleting it would mangle the one
 * thing the reader actually wrote. Everything else in the C0/C1 range goes.
 */
export function cleanMessage(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The path the reader was on, or null.
 *
 * SAME-SITE PATH ONLY, AND THE QUERY IS DROPPED. A reader can be on
 * `/?q=<whatever they typed>`, and the site's own rule is that personal data
 * never goes in a query string — so keeping one here would write it into the
 * store by the back door. An absolute URL is refused rather than trimmed: the
 * field exists to say which of OUR pages this is about.
 */
export function cleanPath(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('/') || s.startsWith('//')) return null;
  const path = s.split(/[?#]/)[0];
  if (!path || path.length > MAX_PATH) return null;
  if (/[\u0000-\u001F\u007F]/.test(path)) return null;
  return path;
}

/**
 * The submission a body describes, or an { error } a reader can read.
 *
 * Pure, and tested by name. The handler does transport; everything that decides
 * whether this is a real submission happens here.
 */
export function parseFeedback(body) {
  let b = body;
  if (typeof b === 'string') {
    if (b.length > 8000) return { error: 'That message is too long.' };
    try { b = JSON.parse(b); } catch { return { error: 'Could not read that. Please try again.' }; }
  }
  if (!b || typeof b !== 'object') return { error: 'Could not read that. Please try again.' };

  /* The honeypot. A real reader never sees this field, so anything in it is a
     bot — and the answer is a plain success, never an error, or the bot learns
     which field gave it away. `accepted: false` is what tells the handler to
     store nothing. */
  if (typeof b.company === 'string' && b.company.trim()) return { accepted: false };

  const message = cleanMessage(b.message);
  if (message.length < MIN_MESSAGE) return { error: 'Please write a little more so we can act on it.' };
  if (message.length > MAX_MESSAGE) return { error: `Please keep it under ${MAX_MESSAGE} characters.` };

  /* Optional, and the only reason to give one is wanting an answer. An address
     that does not parse is refused rather than dropped: silently discarding it
     would promise a reply that can never arrive. */
  let email = null;
  if (typeof b.email === 'string' && b.email.trim()) {
    email = normaliseEmail(b.email);
    if (!email) return { error: 'That does not look like an email address. Leave it blank if you do not want a reply.' };
  }

  const region = REGIONS.has(b.region) ? b.region : 'XX';
  return { accepted: true, entry: { message, email, region, path: cleanPath(b.path) } };
}

export function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/**
 * Newest first, and the list is trimmed in the SAME pipeline as the push.
 *
 * Two round trips would leave a window where the list is over KEEP, and — far
 * worse — a trim that fails on its own leaves it growing for ever with nothing
 * reporting it. One pipeline, one outcome.
 */
/* THE STORE CALL IS BOUNDED. Without this it inherits the platform's own
   limit, and while it waits the reader's browser sits on "Sending…" behind it
   with nothing to show for the wait. A feedback box that hangs is worse than
   one that fails: the reader has typed something and cannot tell whether it
   landed. Measured warm, the whole round trip is ~0.35s, so six seconds is
   generous for a slow day and still short enough to answer inside it. */
export const STORE_TIMEOUT_MS = 6_000;

export async function save(entry, { url, token }, at, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // AbortSignal.timeout is absent on older runtimes; no signal is still
      // better than throwing on the way in.
      signal: AbortSignal.timeout?.(STORE_TIMEOUT_MS),
      body: JSON.stringify([
        ['LPUSH', LIST_KEY, JSON.stringify({ ...entry, at })],
        ['LTRIM', LIST_KEY, 0, KEEP - 1],
      ]),
    });
    return res.ok;
  } catch {
    // A timeout lands here like any other transport failure, and the handler
    // turns it into the same honest 502. Nothing personal is logged, ever.
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Send feedback with POST.' });
  }

  const parsed = parseFeedback(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  /* The honeypot path. Indistinguishable from success on the wire, by design. */
  if (!parsed.accepted) return res.status(200).json({ ok: true });

  if (rateLimited(clientIp(req), Date.now())) {
    return res.status(429).json({ ok: false, error: 'That is a lot of feedback at once. Please try again in a minute.' });
  }

  const target = store();
  if (!target) {
    /* The honest refusal. Nothing is stored and the reader is told so, rather
       than being thanked for a message that went nowhere. */
    return res.status(503).json({
      ok: false,
      error: 'Feedback is not set up on this site yet, so that was not sent. Please email akshat@interndoor.com instead.',
    });
  }

  /* Awaited, not fire-and-forget: a serverless function may be frozen the
     moment it answers, and an un-awaited request is then simply lost — the
     lesson /api/count already carries. */
  const ok = await save(parsed.entry, target, new Date().toISOString());
  if (!ok) {
    /* A real transport failure, and genuinely worth retrying — unlike the
       no-store case above, which no amount of retrying fixes. The status is
       logged and the message never is. */
    console.error('feedback: store write failed');
    return res.status(502).json({ ok: false, error: 'That did not send. Please try again in a moment.' });
  }

  return res.status(200).json({ ok: true });
}
