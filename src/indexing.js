/**
 * Google Indexing API — tell Google about a job page instead of waiting to be
 * crawled.
 *
 * The problem, measured 28 Aug: a live `site:interndoor.com` search returned
 * only the PREVIOUS owner's pages, every one of them a 404, and not one of the
 * 792 job pages this site publishes. On a four-day-old deployment of a domain
 * with no inbound links that is the expected state, and it is fatal to the
 * product rather than merely slow: a LinkedIn job page lives 30 days here by
 * design, so a page that waits weeks for a first crawl is a page whose whole
 * useful life passes before Google ever sees it.
 *
 * The Indexing API is the documented fix and this is exactly what it exists
 * for. It supports only two structured-data types and JobPosting is one of
 * them, which is why this module is deliberately incapable of submitting
 * anything else — see `isJobPageUrl`.
 *
 * DO NOT point this at company hubs, the directories or a board homepage.
 * They carry no JobPosting markup (`pages.js` withholds it on purpose: marking
 * up a closed posting is what earns a structured-data manual action), so
 * submitting them is using the API for an unsupported page type, which Google
 * warns can cost the project its API access. The filter is structural rather
 * than a convention so a future caller cannot get it wrong.
 *
 * Everything here fails soft. This is a hint to a search engine, not part of
 * publishing — it runs after the push, in its own try/catch, and a network
 * failure must never turn a good publish into a failed one.
 *
 * SETUP, once (nothing works until all four are done):
 *   1. Google Cloud console: create/pick a project and ENABLE the Indexing API.
 *   2. Create a service account in that project, add a JSON key, download it.
 *   3. Save the key at ~/Library/Application Support/interndoor/
 *      google-indexing-key.json  (or set GOOGLE_INDEXING_KEY_FILE). It is a
 *      credential and app/ is a public repo — it must not go in the project.
 *   4. Search Console -> the interndoor.com property -> Settings -> Users and
 *      permissions -> add the service account's `client_email` as an OWNER.
 *      Anything less than Owner returns 403 on every call. This step is the
 *      one people miss, and its error does not mention Search Console.
 *
 * QUOTA is 200 URLs per rolling 24h by default, counted per URL even inside a
 * batch. This board runs ~110 new job pages a day plus about as many expiries,
 * so it sits just under the ceiling and `indexing.dailyCap` keeps it there.
 * A QUOTA INCREASE IS NOT AVAILABLE FROM THE CONSOLE, WHICH IS WHERE THIS NOTE
 * USED TO SEND YOU. The quotas page reports the limit as `Adjustable: Yes` and
 * its own inline editor then answers "For a value above 200, apply for higher
 * quota" — 200 is the ceiling and Google's application form is the only way
 * past it. Filed 5 Sep 2026 for 500/day, from `internzoin@gmail.com` (the
 * CLOUD PROJECT's owner, not the Search Console account), project number
 * 254473346824. Two to three weeks, and the decision is never communicated:
 * no visible increase by then means refused.
 */
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { PATHS } from './paths.js';
import { log } from './logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/* The colon is not a typo and not a path separator — the method is
   `urlNotifications.publish` in Google's custom-method style. `/v3/
   urlNotifications/publish` returns 404, which reads like a dead endpoint. */
const PUBLISH_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';

/**
 * Google's default allowance, per rolling 24h, per project.
 *
 * IT IS THE CEILING `dailyCap` IS CLAMPED TO, so the day a quota increase is
 * granted BOTH numbers have to move — raising `indexing.dailyCap` alone is
 * silently a no-op, and the symptom is a queue that still drains at 190 with
 * nothing in any log to say why.
 */
export const DAILY_QUOTA = 200;

export const UPDATED = 'URL_UPDATED';
export const DELETED = 'URL_DELETED';

export function keyPath() {
  return process.env.GOOGLE_INDEXING_KEY_FILE || PATHS.indexingKey;
}

export function indexingConfigured() {
  return existsSync(keyPath());
}

/**
 * Only a job page may be submitted. See the header — this is the rule that
 * keeps the project's API access, not a tidiness check.
 *
 * Matches /jobs/<slug> at the root or under any region prefix, and nothing
 * else: not /jobs/ itself, not a nested path, not a hub, not a query string.
 */
export function isJobPageUrl(url, site = 'https://interndoor.com') {
  if (typeof url !== 'string' || !url.startsWith(`${site}/`)) return false;
  return /^(?:\/[a-z]{2})?\/jobs\/[^/?#]+$/.test(url.slice(site.length));
}

export function loadServiceAccount(file = keyPath()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read the indexing key at ${file}: ${err.message}`);
  }
  if (!raw.client_email || !raw.private_key) {
    throw new Error(`${file} is not a service-account key — it has no client_email/private_key`);
  }
  return raw;
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A service-account assertion, signed locally.
 *
 * Google's own client libraries are the usual way to do this and would be the
 * project's second runtime dependency for one RS256 signature. node:crypto
 * does it in four lines, so this stays dependency-free like the rest of the
 * repo. Exported so a test can check the claim set without a network call or a
 * real key.
 */
export function signJwt(sa, { now = Math.floor(Date.now() / 1000), lifetimeSec = 3600 } = {}) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + lifetimeSec,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(signingInput).end().sign(sa.private_key);
  return `${signingInput}.${b64url(sig)}`;
}

/* One token per process, reused until it is nearly expired. A token lasts an
   hour and a sweep sends at most a couple of dozen URLs, so minting one per
   call would double the request count for nothing. */
let cachedToken = null;

export function _resetTokenCache() { cachedToken = null; }

export async function accessToken(sa, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(sa, { now: Math.floor(now / 1000) }),
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (!body.access_token) throw new Error('token response carried no access_token');
  cachedToken = {
    email: sa.client_email,
    token: body.access_token,
    expiresAt: now + (Number(body.expires_in) || 3600) * 1000,
  };
  return cachedToken.token;
}

/**
 * Announce one URL. Throws with `.status` set so the caller can tell a
 * permanent refusal from a transient one.
 */
export async function notify(url, type, token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(PUBLISH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, type }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(explain(res.status, text));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Google's errors here are accurate and unhelpful — a 403 says the URL is not
 * owned, and never mentions that the fix is in Search Console rather than in
 * Google Cloud. Naming the actual remedy is the difference between a five
 * minute fix and an afternoon.
 */
function explain(status, body) {
  const detail = String(body).slice(0, 300);
  if (status === 403) {
    return `403 — the service account is not an OWNER of this property in Search Console (Settings -> Users and permissions), or the Indexing API is not enabled on the project. ${detail}`;
  }
  if (status === 429) return `429 — daily quota spent; it refills on a rolling 24h. ${detail}`;
  if (status === 401) return `401 — the key was rejected. Check the clock on this Mac and that the key has not been revoked. ${detail}`;
  return `${status} — ${detail}`;
}

/**
 * Take the pending queue down to the caps and send it.
 *
 * The two caps do different jobs. `dailyCap` is the platform's, measured over a
 * rolling 24h against what has already gone out, and it is clamped to Google's
 * real 200 in code because a bigger number is not a bigger allowance — it is
 * the same allowance plus refusals. `perRun` bounds the wall-clock this adds to
 * a scan; the queue drains over days either way, so there is nothing to gain by
 * spending a whole day's budget in one publish.
 */
export async function runIndexingSweep(store, cfg, {
  fetchImpl = fetch, now = Date.now(), dryRun = false, limit = null, force = false,
} = {}) {
  const c = cfg?.indexing ?? {};
  if (c.enabled === false) return { sent: 0, skipped: 'disabled' };
  if (!indexingConfigured()) return { sent: 0, skipped: 'no-key' };

  const dailyCap = Math.min(Number(c.dailyCap) || 190, DAILY_QUOTA);
  const maxAttempts = Number(c.maxAttempts) || 3;
  const minAgeMs = force ? 0 : (Number(c.minAgeMinutes) ?? 5) * 60_000;
  const spent = store.indexCountSince(now - 86_400_000);
  const room = Math.max(0, dailyCap - spent);
  if (!room) return { sent: 0, spent, cap: dailyCap, skipped: 'daily-cap' };

  const batch = store.indexDue({
    limit: Math.min(room, limit ?? Number(c.perRun) ?? 25),
    minAgeMs,
    maxAttempts,
    now,
  });
  if (!batch.length) {
    /* An empty batch has two very different causes and reporting both as
       "queue-empty" sends you looking for a bug in the seeding. Right after a
       seed EVERYTHING is held back by minAgeMinutes, which is the guard doing
       its job, not an empty queue. */
    const { pendingUpdate, pendingDelete } = store.indexStats({ now, maxAttempts });
    return {
      sent: 0,
      spent,
      cap: dailyCap,
      skipped: (pendingUpdate + pendingDelete) ? 'nothing-due-yet' : 'queue-empty',
    };
  }

  if (dryRun) return { sent: 0, spent, cap: dailyCap, wouldSend: batch };

  const sa = loadServiceAccount();
  const token = await accessToken(sa, { fetchImpl, now });

  let sent = 0;
  let failed = 0;
  for (const row of batch) {
    /* Belt and braces: the queue is filtered on the way in, but this is the
       last point before a URL reaches Google and the cost of being wrong is
       the project's API access, not a bad row. */
    if (!isJobPageUrl(row.url)) {
      store.indexMarkFailed(row.url, 'not a job page — refused before sending');
      continue;
    }
    try {
      await notify(row.url, row.type, token, { fetchImpl });
      store.indexMarkDone(row.url, row.type, now);
      sent++;
    } catch (err) {
      store.indexMarkFailed(row.url, err.message);
      failed++;
      /* A spent quota or a revoked key fails identically for every remaining
         URL, so walking the rest of the batch just burns attempts on rows that
         deserve a retry later. Stop and leave them queued. */
      if (err.status === 429 || err.status === 403 || err.status === 401) {
        log.warn(`Indexing API stopped after ${sent} sent: ${err.message}`);
        break;
      }
    }
  }
  return { sent, failed, spent: spent + sent, cap: dailyCap };
}

/**
 * Put a publish's job pages into the queue.
 *
 * Called with what `writeSite` actually wrote, not with a fresh query, for the
 * same reason `publishedIds` exists: the set that got a page and the set we
 * announce must be the same set or they drift.
 */
export function queueForIndexing(store, { indexUrls = [], removedUrls = [], redirectUrls = [] } = {}, now = Date.now()) {
  const live = indexUrls.filter((u) => isJobPageUrl(u));
  const gone = removedUrls.filter((u) => isJobPageUrl(u));
  /* A SLUG THAT HAS BECOME A REDIRECT STUB IS NEITHER, and `isJobPageUrl`
     cannot tell — a stub lives at `/jobs/<slug>` and is structurally a job URL,
     which is exactly why the guard below it never caught this. Five were sitting
     in the queue owed an UPDATE when it was found, and a stub carries no
     JobPosting markup at all: submitting one is the unsupported page type
     Google warns can cost the project its API access. It answers 200, so a
     DELETE would be wrong too. Say nothing; the stub's own canonical does the
     consolidating. Cleared FIRST so a slug that is a stub this run cannot be
     re-queued by the two calls below. */
  const stubs = new Set(redirectUrls.filter((u) => isJobPageUrl(u)));
  const cleared = store.indexClearPending(stubs);
  /* And a stub is excluded from the other two lists rather than trusted not to
     appear in them. `writePages` already skips a redirect whose slug is still
     live, so this cannot fire today — but the cost of being wrong here is the
     project's API access, and a function that is only safe because of what its
     caller happens to do is one refactor from not being safe at all. */
  return {
    cleared,
    queuedUpdate: store.indexQueue(live.filter((u) => !stubs.has(u)), UPDATED, now),
    queuedDelete: store.indexQueue(gone.filter((u) => !stubs.has(u)), DELETED, now),
  };
}
