/* /api/count — the site's own event counter, because Vercel's custom events
   are not on the Hobby plan (docs, "Custom Events: –") and there is no other
   way to know whether a return-visit feature moved anything.

   WHAT IT KEEPS: one integer per (UTC day, event name, board), incremented in
   Upstash Redis over its REST API. Nothing else — no address, no id, no user
   agent, no path. The vocabulary is closed (EVENTS), so a stranger POSTing
   junk can at most bump a counter that exists.

   WHAT IT NEEDS: the Upstash Redis integration on the Vercel project, which
   injects KV_REST_API_URL / KV_REST_API_TOKEN (the Vercel Marketplace names;
   Upstash's own UPSTASH_REDIS_REST_* pair is accepted too). Until those exist
   this answers 204 and counts nothing — the same honest shape as the apply
   endpoint with no forward target: it never pretends. The client sends with
   sendBeacon and does not read the answer, so 204 is the only status here.

   Read it back with `npm run counts` (bin/counts.js), which needs the same
   two values in the local .env. */

export const EVENTS = new Set([
  'visit-new', 'visit-return', 'newsince-shown',
  'apply',
  'nudge-shown', 'nudge-whatsapp', 'nudge-telegram', 'nudge-email', 'nudge-dismiss',
]);
export const REGIONS = new Set(['IN', 'US', 'GB']);

/* 100 days, so a fortnight's before-and-after is readable well after the
   change, and a key nobody reads still goes away on its own. */
export const TTL_SECONDS = 100 * 24 * 60 * 60;

/* A speed bump, not a vault: instances recycle and take the map with them.
   Sixty a minute from one address is far above any reader's rate and far
   below what would matter if somebody wanted to skew a daily count. */
const PER_IP_PER_MINUTE = 60;
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
 * The event a body describes, or null. sendBeacon posts text/plain, so on
 * Vercel `req.body` is the raw string; the local server hands over an object.
 * Both are accepted; anything else is nothing. Pure — tested by name.
 */
export function parseEvent(body) {
  let b = body;
  if (typeof b === 'string') {
    if (b.length > 200) return null;
    try { b = JSON.parse(b); } catch { return null; }
  }
  if (!b || typeof b !== 'object') return null;
  const name = typeof b.name === 'string' ? b.name : '';
  if (!EVENTS.has(name)) return null;
  const region = String(b.region ?? '').toUpperCase();
  return { name, region: REGIONS.has(region) ? region : 'XX' };
}

/** `count:2026-09-17:apply:IN` — day first so a range is a prefix scan. */
export function keyFor(day, name, region) {
  return `count:${day}:${name}:${region}`;
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** One pipeline: INCR the key and (re)arm its expiry. Never throws. */
export async function bump(key, { url, token }, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, TTL_SECONDS]]),
    });
    return res.ok;
  } catch {
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
    return res.status(405).end();
  }

  const event = parseEvent(req.body);
  const target = store();
  if (event && target && !rateLimited(clientIp(req), Date.now())) {
    /* Awaited, not fire-and-forget: a serverless function may be frozen the
       moment it answers, and an un-awaited request is then simply lost. */
    await bump(keyFor(utcDay(), event.name, event.region), target);
  }
  return res.status(204).end();
}
