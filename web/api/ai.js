/* /api/ai — the resume AI, on the site's own Gemini key, free up to a daily
   allowance. Added 11 Oct 2026 to replace "bring your own key", which stopped
   nearly every student at the point of creating a Google key.

   WHAT IT DOES: takes a resume plus one role (tailor) or up to RANK_BATCH role
   digests (rank), builds the prompt ITSELF from ./_prompts.js, asks
   Gemini, and hands back the model's JSON. A browser never supplies a prompt,
   so the key cannot be borrowed as a general-purpose model: the most anyone
   gets out of it is a score list or a resume.

   WHAT IT COUNTS, in Upstash Redis (the counter's store), per India day:
     - FREE_PER_DAY uses per browser (a random id the browser keeps),
     - PER_IP_PER_DAY per network, so clearing site data over and over is
       bounded — wide enough for a college wifi or a mobile carrier's shared
       address,
     - a whole-site DAILY BUDGET in paise (AI_MONTHLY_BUDGET_INR, default
       MONTHLY_BUDGET_INR, over 31 days), each call charged what it costs
       (COST_PAISE: a tailor about seven ranks). It spreads the month evenly:
       AI Studio's own monthly spend cap stops EVERY call the moment it is
       reached, for the rest of the month, so this is what keeps the feature
       working on the 30th.
   Ids and addresses are hashed with the day and a secret before they become
   keys, and every key expires after two days.

   A FAILED CALL GIVES THE BROWSER ITS USE BACK, but the network and site
   counts keep it: those bound what Google is actually paid for, and a call
   that failed was still made.

   WHAT IT NEEDS: GEMINI_API_KEY (a key on the billed Google project) and the
   Redis pair. With either missing it answers 503 and calls nothing — spending
   without a limit is the one failure this file exists to rule out.

   NOTHING PERSONAL IS EVER LOGGED. A resume is personal data and Vercel keeps
   function logs, so a console line quoting it IS storage. Failures log a
   status code and nothing else (the /api/apply and /api/feedback rule). */

import { createHash } from 'node:crypto';
import {
  RANK_MODEL, TAILOR_MODEL, TAILOR_THINKING, RANK_SYSTEM, RANK_SCHEMA, TAILOR_SYSTEM, TAILOR_SCHEMA,
  buildRankPrompt, buildTailorPrompt,
} from './_prompts.js';
import {
  FREE_PER_DAY, MIN_RESUME_CHARS, MAX_RESUME_CHARS, RANK_BATCH, DEVICE_SHAPE, istDay,
} from '../public/resumeai.js';
import { REGIONS, keyFor as countKey, utcDay, TTL_SECONDS as COUNT_TTL } from './count.js';

export const PER_IP_PER_DAY = 25;
/* WHAT A CALL COSTS, in paise BEFORE GST, measured on billed calls on 11 Oct
   2026 at about Rs 96 to the dollar. AI Studio's spend cap counts before GST;
   the prepaid credit is charged the cost plus 18% GST.
     rank    3.1 Flash-Lite, 25 roles: ~2,400 tokens in, ~850 out   ~$0.0018
     tailor  2.5 Flash, thinking capped at 1,024: ~2,200-3,500 in,
             ~3,700-5,500 out with thinking                       $0.012-0.018
   Rounded UP, so the budget runs out before the money does. Re-measure when a
   model or a price changes (usageMetadata on any response gives the tokens). */
export const COST_PAISE = { rank: 25, tailor: 180 };
/* His ceiling, 11 Oct 2026: "i can spend a max of 1100 inr / month". */
export const MONTHLY_BUDGET_INR = 1100;
const LIMIT_TTL_SECONDS = 2 * 24 * 60 * 60;
/* A full tailor request is a resume (18k) and one clamped posting (two 12k
   fields) plus small change. Anything much past that is not this page. */
export const MAX_BODY_CHARS = 60_000;

/* gemini-2.5-flash is a THINKING model and its reasoning tokens count against
   maxOutputTokens. Measured on a 40-role shortlist: 4,000 went entirely on
   thinking and returned truncated JSON; 8,000 and 16,000 both finished and
   cost the same, because billing is on tokens used, not on the ceiling. */
export const MAX_OUTPUT_TOKENS = 16_000;

/* Google 503s often and the next attempt usually works (4 of 7 in a row on
   23 Sep 2026). A 4xx is never retried: retrying fixes neither a bad key nor
   a spent quota. Every attempt must fit inside the function's own time, so
   the budget is checked before each one. */
const RETRY_STATUSES = new Set([500, 502, 503, 504]);
export const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1_500;
/* A tailor returns the parsed original AND the rewrite since 11 Oct 2026, and
   measured 23-27s on a one-page resume; a long two-page one needs headroom. */
export const BUDGET_MS = 80_000;      // vercel.json gives the function 90s
const MIN_ATTEMPT_MS = 8_000;

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/** The only host the key is ever sent to. Compared on the ORIGIN, so a
 *  lookalike such as generativelanguage.googleapis.com.evil.example cannot pass
 *  a prefix test (the shape utmUrl and engage.js were both fixed for). */
const ALLOWED_ORIGIN = 'https://generativelanguage.googleapis.com';
export function endpointFor(model, base = API_BASE) {
  const url = new URL(`${base}/${encodeURIComponent(model)}:generateContent`);
  if (url.origin !== ALLOWED_ORIGIN) throw new Error('refusing to call an unexpected host');
  return url.toString();
}

/* Every message here is shown to a reader verbatim, so none of them names the
   model's provider: to a reader this is InternDoor's AI (his call, 11 Oct
   2026). The codes and the one log line still say exactly what happened. */
const OFF = 'The AI features are switched off right now. Ranking by skills still works.';

/** Today's budget for the whole site, in paise: the month's budget (from
 *  AI_MONTHLY_BUDGET_INR when it is a positive number) over 31 days, so even
 *  the longest month never reaches AI Studio's monthly cap. */
export function siteCap(env = process.env) {
  const n = Number(env.AI_MONTHLY_BUDGET_INR);
  const inr = Number.isFinite(n) && n > 0 ? n : MONTHLY_BUDGET_INR;
  return Math.floor((inr * 100) / 31);
}

/**
 * The request a body describes, or { error }. On Vercel a JSON body arrives
 * parsed; anything else is read as a string. Pure — tested by name. Fields the
 * endpoint does not use (a `prompt`, a `model`) are dropped here and never
 * reach Google.
 */
export function parseRequest(body) {
  let b = body;
  if (typeof b === 'string') {
    if (b.length > MAX_BODY_CHARS) return { error: 'That was too much to send at once. Try a shorter resume.' };
    try { b = JSON.parse(b); } catch { return { error: 'That request could not be read.' }; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'That request could not be read.' };
  if (JSON.stringify(b).length > MAX_BODY_CHARS) return { error: 'That was too much to send at once. Try a shorter resume.' };

  const task = b.task;
  if (task !== 'rank' && task !== 'tailor') return { error: 'That request could not be read.' };
  const device = typeof b.device === 'string' && DEVICE_SHAPE.test(b.device) ? b.device : null;
  if (!device) return { error: 'Please reload the page and try again.' };
  const resume = typeof b.resume === 'string' ? b.resume.trim().slice(0, MAX_RESUME_CHARS) : '';
  if (resume.length < MIN_RESUME_CHARS) {
    return { error: 'Please provide a bit more of your resume, at least a couple of hundred characters.' };
  }
  const code = String(b.region ?? '').toUpperCase();
  const region = REGIONS.has(code) ? code : 'XX';

  if (task === 'rank') {
    const jobs = Array.isArray(b.jobs) ? b.jobs : [];
    if (!jobs.length || jobs.length > RANK_BATCH || !jobs.every((j) => j && typeof j === 'object' && !Array.isArray(j))) {
      return { error: `Pick between 1 and ${RANK_BATCH} roles to read.` };
    }
    return { task, device, resume, region, jobs };
  }
  if (!b.job || typeof b.job !== 'object' || Array.isArray(b.job)) return { error: 'Which role is this for?' };
  return { task, device, resume, region, job: b.job };
}

/** The model and the request body for Google, built from our own prompts. */
export function geminiRequest(req) {
  const rank = req.task === 'rank';
  return {
    model: rank ? RANK_MODEL : TAILOR_MODEL,
    body: {
      systemInstruction: { parts: [{ text: rank ? RANK_SYSTEM : TAILOR_SYSTEM }] },
      contents: [{
        role: 'user',
        parts: [{ text: rank ? buildRankPrompt(req.resume, req.jobs) : buildTailorPrompt(req.resume, req.job) }],
      }],
      generationConfig: {
        temperature: rank ? 0.2 : 0.4,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // The tailor's thinking is most of its cost; 1,024 measured as good as unlimited.
        ...(rank ? {} : { thinkingConfig: { thinkingBudget: TAILOR_THINKING } }),
        responseMimeType: 'application/json',
        responseSchema: rank ? RANK_SCHEMA : TAILOR_SCHEMA,
      },
    },
  };
}

/** Redis keys for one request's allowance. Nothing raw goes in: the browser id
 *  and the address are hashed with the day and a secret, so a key names no
 *  one and tomorrow's keys cannot be joined to today's. */
export function limitKeys(day, device, ip, salt) {
  const h = (v) => createHash('sha256').update(`${salt}|${day}|${v}`).digest('hex').slice(0, 32);
  return { dev: `ai:${day}:d:${h(`d:${device}`)}`, ip: `ai:${day}:i:${h(`i:${ip}`)}`, all: `ai:${day}:all` };
}

/** Which limit a request is over, most specific first, or null. */
export function overLimit(used, cap) {
  if (used.dev > FREE_PER_DAY) return 'device';
  if (used.ip > PER_IP_PER_DAY) return 'ip';
  if (used.all > cap) return 'site';
  return null;
}

const LIMITS = {
  device: () => ({
    status: 429,
    body: {
      code: 'limit', remaining: 0, limit: FREE_PER_DAY,
      error: `You have used today's ${FREE_PER_DAY} free AI uses. They come back at midnight. Ranking by skills still works.`,
    },
  }),
  ip: () => ({
    status: 429,
    body: { code: 'ip-limit', error: 'This network has used its free AI allowance for today. It comes back at midnight.' },
  }),
  site: () => ({
    status: 503,
    body: { code: 'site-limit', error: "Today's free AI allowance for the whole site has run out. It comes back at midnight." },
  }),
};

const FAILURES = {
  quota: { status: 503, error: 'The AI is busy right now. Please try again in a few minutes.' },
  refused: { status: 503, error: 'The AI is not available right now. Please try again later.' },
  trouble: { status: 502, error: 'The AI is having trouble right now. Please try again shortly.' },
  timeout: { status: 504, error: 'That took too long. Please try again.' },
  filter: { status: 422, error: 'This resume could not be processed. If it contains anything unusual, try removing it.' },
  'too-long': { status: 422, error: 'That was too long to handle in one pass. Try trimming the resume to its most relevant two pages.' },
  empty: { status: 502, error: 'The AI returned no answer. Please try again, or shorten the resume.' },
  unreadable: { status: 502, error: 'The AI returned something unreadable. Please try again.' },
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to Gemini, retried on Google's own overload. Never throws: the
 * answer is { ok: true, data } or { ok: false, reason, status? }.
 */
export async function askGemini({ key, model, body, fetchImpl = fetch, now = Date.now, sleep = pause, budgetMs = BUDGET_MS }) {
  const start = now();
  const payload = JSON.stringify(body);
  let res = null;
  for (let attempt = 1; ; attempt += 1) {
    const left = budgetMs - (now() - start);
    if (left < MIN_ATTEMPT_MS) return { ok: false, reason: res ? 'trouble' : 'timeout' };
    try {
      res = await fetchImpl(endpointFor(model), {
        method: 'POST',
        // The header, never the query string — a URL is logged, a header is not.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: payload,
        signal: AbortSignal.timeout(left),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, reason: 'timeout' };
      res = null;
      if (attempt >= ATTEMPTS) return { ok: false, reason: 'trouble' };
      await sleep(RETRY_PAUSE_MS);
      continue;
    }
    if (res.ok || !RETRY_STATUSES.has(res.status) || attempt >= ATTEMPTS) break;
    await sleep(RETRY_PAUSE_MS);
  }

  if (!res.ok) {
    const reason = res.status === 429 ? 'quota' : RETRY_STATUSES.has(res.status) ? 'trouble' : 'refused';
    return { ok: false, reason, status: res.status };
  }
  let data;
  try { data = await res.json(); } catch { return { ok: false, reason: 'unreadable' }; }
  if (data?.promptFeedback?.blockReason) return { ok: false, reason: 'filter' };
  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') return { ok: false, reason: 'too-long' };
  const raw = (candidate?.content?.parts ?? []).map((p) => p?.text).filter(Boolean).join('').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function store(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** The secret the ids are hashed with. Its own variable when set, else the
 *  store's token, which is already secret and already present. */
function saltFrom(env) {
  return env.AI_SALT || env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || 'interndoor-ai';
}

/* Vercel sets x-real-ip itself and overwrites x-forwarded-for, so neither can
   be supplied by the caller in production. */
function clientIp(req) {
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** One Upstash pipeline. The list of results, or null on any failure. */
async function pipeline(commands, { url, token }, fetchImpl) {
  try {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    const out = await res.json();
    if (!Array.isArray(out) || out.some((r) => !r || 'error' in r)) return null;
    return out.map((r) => r.result);
  } catch {
    return null;
  }
}

function countCommands(name, region, now) {
  const key = countKey(utcDay(now), name, region);
  return [['INCR', key], ['EXPIRE', key, COUNT_TTL]];
}

/**
 * The whole decision for one request, as { status, body?, allow? }. Every
 * dependency is passed in so the tests run it with no network.
 */
export async function respond(req, { env = process.env, fetchImpl = fetch, now = Date.now, sleep = pause } = {}) {
  if (req.method === 'OPTIONS') return { status: 204, allow: 'POST' };
  if (req.method !== 'POST') return { status: 405, allow: 'POST', body: { error: 'Use POST.' } };

  const key = env.GEMINI_API_KEY;
  const target = store(env);
  if (!key || !target) return { status: 503, body: { code: 'off', error: OFF } };

  const ask = parseRequest(req.body);
  if (ask.error) return { status: 400, body: { error: ask.error } };

  const t = now();
  const keys = limitKeys(istDay(t), ask.device, clientIp(req), saltFrom(env));
  const cost = COST_PAISE[ask.task];
  const counts = await pipeline([
    ['INCR', keys.dev], ['EXPIRE', keys.dev, LIMIT_TTL_SECONDS],
    ['INCR', keys.ip], ['EXPIRE', keys.ip, LIMIT_TTL_SECONDS],
    ['INCRBY', keys.all, cost], ['EXPIRE', keys.all, LIMIT_TTL_SECONDS],
  ], target, fetchImpl);
  if (!counts) {
    // No count, no call: an allowance that cannot be checked is not enforced.
    return { status: 502, body: { code: 'store', error: 'Could not check the free allowance just now. Please try again in a moment.' } };
  }
  const used = { dev: Number(counts[0]), ip: Number(counts[2]), all: Number(counts[4]) };

  const over = overLimit(used, siteCap(env));
  if (over) {
    // Refused before anything was spent, so all three counts go back.
    await pipeline([
      ['DECR', keys.dev], ['DECR', keys.ip], ['DECRBY', keys.all, cost],
      ...countCommands('ai-limit', ask.region, t),
    ], target, fetchImpl);
    return LIMITS[over]();
  }

  const { model, body } = geminiRequest(ask);
  const out = await askGemini({ key, model, body, fetchImpl, now, sleep });
  const remaining = Math.max(0, FREE_PER_DAY - used.dev);

  if (!out.ok) {
    if (out.status) console.warn(`ai: Google answered ${out.status}`);
    await pipeline([['DECR', keys.dev]], target, fetchImpl);
    const fail = FAILURES[out.reason] ?? FAILURES.trouble;
    return { status: fail.status, body: { code: out.reason, error: fail.error, remaining: Math.min(FREE_PER_DAY, remaining + 1) } };
  }

  await pipeline(countCommands(ask.task === 'rank' ? 'ai-rank' : 'ai-tailor', ask.region, t), target, fetchImpl);
  return { status: 200, body: { result: out.data, remaining, limit: FREE_PER_DAY } };
}

export default async function handler(req, res) {
  const out = await respond(req);
  if (out.allow) res.setHeader('Allow', out.allow);
  res.setHeader('Cache-Control', 'no-store');
  if (!out.body) return res.status(out.status).end();
  return res.status(out.status).json(out.body);
}
