/**
 * POST /api/subscribe
 *
 * Takes an email address and puts it on the internship alert list for one
 * region. That is the whole endpoint.
 *
 * WHY THIS EXISTS. Every other channel this site has is rented. Google decides
 * who sees a job page, Instagram decides who sees a reel, and Telegram reaches
 * only the people already on Telegram. An address is the one thing a reader can
 * give us that nobody else controls, and until this endpoint existed a visitor
 * who liked the board had no way to hear from it again — so every listing the
 * SEO work wins leaks straight back out.
 *
 * IT DOES NOT STORE THE LIST ITSELF, AND THAT IS DELIBERATE.
 * ---------------------------------------------------------
 * Holding addresses means holding personal data, and the obligations that come
 * with it are not the interesting part of this project: a working unsubscribe
 * in every send, deletion on request, SPF/DKIM so the mail is not filed as
 * spam, and bounce handling so a dead address does not quietly poison the
 * sending reputation of the domain. The site publishes a GB board (GDPR) and an
 * India board (DPDP), so those are real duties and not paperwork.
 *
 * A newsletter provider does all of that as its product. We hand it an address
 * and a tag and keep nothing. If the provider is ever swapped, `addSubscriber`
 * is the only function that changes.
 *
 * IT NEEDS A KEY AND SAYS SO WHEN IT HAS NONE. Same rule as src/websearch.js:
 * a missing key is a clear refusal the reader can see, never a form that
 * appears to work and drops the address on the floor. A signup that silently
 * fails is worse than no signup box, because the reader believes they are on
 * the list.
 */

/* Buttondown is the default because its free tier covers the whole of the
   period this site is likely to be small, its API is one POST, and unsubscribe
   and GDPR export are handled by it rather than by us. Swapping provider means
   rewriting addSubscriber and nothing else. */
const API = 'https://api.buttondown.email/v1/subscribers';

/** RFC 5321 caps a whole address at 254 characters. */
const MAX_EMAIL = 254;

/* Signing up is a once-per-person act, so these are deliberately tight. They
   are a speed bump against a script pointing a list of addresses at us — which
   would both poison the list and burn the provider's quota — not a vault:
   serverless instances recycle and take the counters with them. Same caveat
   the tailor endpoint carries. */
const PER_IP_PER_HOUR = Number(process.env.SUBSCRIBE_PER_IP_HOURLY || 5);
const PER_IP_PER_DAY = Number(process.env.SUBSCRIBE_PER_IP_DAILY || 20);
const GLOBAL_PER_DAY = Number(process.env.SUBSCRIBE_GLOBAL_DAILY || 500);

/** Boards a reader can actually subscribe to. Anything else is a bad request. */
export const REGIONS = ['IN', 'US', 'GB'];

/**
 * The address, cleaned up, or null if it is not one.
 *
 * DELIBERATELY PERMISSIVE. Every regex that tries to be clever about what an
 * address may contain ends up refusing real ones — plus-addressing, apostrophes
 * in Irish surnames, and every new TLD. The provider verifies for real by
 * sending to it, so the only job here is to reject what cannot possibly work
 * and to stop the two things that are actually dangerous.
 *
 * THE NEWLINE CHECK IS THE ONE THAT MATTERS. An address carrying \r or \n is a
 * header-injection attempt: it is how a submitted field becomes extra headers
 * in whatever the downstream system sends. It can never be a real address, so
 * it is refused outright rather than stripped.
 *
 * The case is lowered because a reader who signs up twice in different case is
 * one person, but NOTHING ELSE IS CANONICALISED — stripping dots or +tags is a
 * Gmail-specific habit, it is wrong at most other providers, and somebody's
 * address is theirs to write, not ours to rewrite.
 */
export function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > MAX_EMAIL) return null;
  if (/[\r\n\t]/.test(e)) return null;
  if (/\s/.test(e)) return null;
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@')) return null;
  const domain = e.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  if (domain.includes('..')) return null;
  return e;
}

/** The board this address asked for. Unknown or missing means India. */
export function normaliseRegion(raw) {
  const r = String(raw ?? 'IN').toUpperCase();
  return REGIONS.includes(r) ? r : null;
}

/**
 * Bots fill in every field they can see. `company` is rendered off-screen and
 * left empty by any human, so anything in it is automated — refused with a 200
 * rather than an error, because telling a bot which check it failed is how it
 * learns to pass.
 */
export function looksAutomated(body) {
  return typeof body?.company === 'string' && body.company.trim() !== '';
}

const hits = new Map();

function sweep(now) {
  for (const [key, times] of hits) {
    const live = times.filter((t) => now - t < 86_400_000);
    if (live.length) hits.set(key, live);
    else hits.delete(key);
  }
}

export function rateLimit(ip, now, store = hits) {
  if (store.size > 5000) sweep(now);

  const global = (store.get('__global__') ?? []).filter((t) => now - t < 86_400_000);
  if (global.length >= GLOBAL_PER_DAY) {
    return { ok: false, status: 503, message: 'Too many signups right now. Please try again later.' };
  }

  const times = (store.get(ip) ?? []).filter((t) => now - t < 86_400_000);
  if (times.filter((t) => now - t < 3_600_000).length >= PER_IP_PER_HOUR) {
    return { ok: false, status: 429, message: 'Too many signups from here. Try again in an hour.' };
  }
  if (times.length >= PER_IP_PER_DAY) {
    return { ok: false, status: 429, message: 'Too many signups from here today. Try again tomorrow.' };
  }

  store.set(ip, [...times, now]);
  store.set('__global__', [...global, now]);
  return { ok: true };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Hand the address to the provider.
 *
 * ALREADY-SUBSCRIBED IS A SUCCESS, not an error. The provider answers 400 with
 * a duplicate code, and surfacing that would turn this endpoint into an oracle
 * for whether a given address is on the list — which is a disclosure about a
 * person, made to whoever typed their address in. The reader is told the same
 * thing either way.
 */
export async function addSubscriber(email, region, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email_address: email, tags: [`region:${region}`], referrer_url: 'https://interndoor.com' }),
  });

  if (res.ok) return { ok: true, created: true };

  let detail = '';
  try { detail = JSON.stringify(await res.json()); } catch { /* body is not JSON; the status is enough */ }

  if (res.status === 400 && /already|exists|duplicate/i.test(detail)) return { ok: true, created: false };
  return { ok: false, status: res.status, detail };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const body = req.body ?? {};

  /* Answered before anything else, and with the ordinary success message, so a
     bot cannot tell this apart from a real signup. Nothing is sent onward. */
  if (looksAutomated(body)) return res.status(200).json({ ok: true });

  const email = normaliseEmail(body.email);
  if (!email) return res.status(400).json({ error: "That does not look like an email address." });

  const region = normaliseRegion(body.region);
  if (!region) return res.status(400).json({ error: 'Unknown board.' });

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  if (!apiKey) {
    /* Visible, not silent. The reader must never be told they are on a list
       that does not exist. */
    console.error('subscribe: BUTTONDOWN_API_KEY is not set — the signup form is live with no list behind it');
    return res.status(503).json({ error: 'Email alerts are not switched on yet. Follow the Telegram channel in the meantime.' });
  }

  const limit = rateLimit(clientIp(req), Date.now());
  if (!limit.ok) return res.status(limit.status).json({ error: limit.message });

  try {
    const result = await addSubscriber(email, region, apiKey);
    if (!result.ok) {
      /* The ADDRESS is never logged. It is the one piece of personal data this
         endpoint touches, and a log line is a place it would outlive the
         request. The status and the provider's own message are enough to
         diagnose with. */
      console.error(`subscribe: provider returned ${result.status} ${result.detail}`);

      /* A REJECTED KEY IS NOT A TRANSIENT FAULT, and telling the reader to try
         again in a minute is a promise that will never come true — they will
         retry, fail, and be no more subscribed than before. 401/403 means the
         key is missing, mistyped, or not entitled to the API, which is a
         misconfiguration only we can fix. Functionally the list is not
         switched on, so it says exactly what the no-key branch above says. */
      if (result.status === 401 || result.status === 403) {
        return res.status(503).json({ error: 'Email alerts are not switched on yet. Follow the Telegram channel in the meantime.' });
      }
      return res.status(502).json({ error: 'Could not add you just now. Please try again in a minute.' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`subscribe: ${err.message}`);
    return res.status(502).json({ error: 'Could not add you just now. Please try again in a minute.' });
  }
}
