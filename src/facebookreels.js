/**
 * Cross-post a published reel to the region's Facebook Page.
 *
 * WHY THIS EXISTS. On 12 Sep 2026 the Page was linked and Instagram's "share
 * reels to Facebook" toggle turned on, on the advice that it would mirror every
 * reel with no code. Five days later NO API-published reel had reached either
 * Page. The Instagram REELS container carries `share_to_feed` — the Instagram
 * FEED flag — and nothing about Facebook, and Meta's reference lists no
 * cross-post parameter at all. The one route that demonstrably reaches a Page
 * is the Facebook Reels API, which is this file.
 *
 * THE SHAPE, from Meta's "Reels Publishing" guide (read 17 Sep 2026):
 *
 *   1. POST /{page-id}/video_reels   upload_phase=start        → video_id, upload_url
 *   2. POST rupload.facebook.com/video-upload/v25.0/{video-id}
 *        Authorization: OAuth <page token> · offset: 0 · file_size: <bytes> · body: the file
 *   3. POST /{page-id}/video_reels   upload_phase=finish, video_id, video_state=PUBLISHED, description
 *   4. GET  /{video-id}?fields=status,permalink_url   until publishing_phase.status is complete
 *
 * It needs a PAGE access token — `pages_show_list`, `pages_read_engagement`,
 * `pages_manage_posts` — which is a different token from the two `IGAA…`
 * Instagram Login tokens the reels already use. One per region, in .env as
 * FB_PAGE_ID_<REGION> / FB_PAGE_TOKEN_<REGION>, put there by `npm run fb-token`.
 *
 * FAILS SOFT, ALWAYS. This runs AFTER the Instagram publish has succeeded and
 * been recorded, inside its own try/catch in the caller, and a refusal here is
 * written to the row's own fb_* columns — it can never mark the reel failed,
 * never trip the Instagram breaker, and never re-render anything.
 *
 * THE TOKEN GOES IN A HEADER AND NOWHERE ELSE. Never in a URL (URLs are
 * logged), never in a form body (bodies get echoed by error handlers), never
 * in a thrown message.
 */
import { readFileSync, statSync } from 'node:fs';

export const GRAPH = 'https://graph.facebook.com/v25.0';
export const UPLOAD = 'https://rupload.facebook.com/video-upload/v25.0';

/* Meta's own limit on POST /{page_id}/video_reels: 30 API-published posts in a
   rolling 24 hours. The auto sweep does 8 a region; this is a guard, not a
   target. */
export const DAILY_CAP = 30;
/* How long to wait for Facebook to say "published" after `finish`. The finish
   call already answered success; past this the reel is recorded with its id
   and the permalink Facebook uses for every reel, and left to finish alone. */
export const STATUS_DEADLINE_MS = 180_000;
export const STATUS_POLL_MS = 5_000;
/* A failed cross-post is retried from the queue server's tick: not before this
   gap, not more than this many times, and never for a reel older than this. */
export const RETRY_GAP_MS = 30 * 60_000;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_MAX_AGE_MS = 24 * 3_600_000;

/** The env var names holding one region's Page credentials. */
export function fbEnvNames(region) {
  const r = String(region || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) throw new Error(`bad region for Facebook credentials: ${region}`);
  return { page: `FB_PAGE_ID_${r}`, token: `FB_PAGE_TOKEN_${r}` };
}

/** Off unless config says so in terms — a missing block is off. */
export function facebookEnabled(cfg = {}) {
  return cfg.reels?.facebook?.enabled === true && facebookRegions(cfg).length > 0;
}

/** Regions whose reels are cross-posted, in config order. */
export function facebookRegions(cfg = {}) {
  return (cfg.reels?.facebook?.regions ?? []).map((r) => String(r).toUpperCase());
}

/**
 * The Page id and token for a region, or null when EITHER is missing — a
 * token with no id, or an id with no token, is not half a credential, it is
 * none, and null here is what makes the whole feature a no-op until
 * `npm run fb-token` has run for that region.
 */
export function pageCreds(region, env = process.env) {
  const names = fbEnvNames(region);
  const pageId = String(env[names.page] ?? '').trim();
  const token = String(env[names.token] ?? '').trim();
  if (!pageId || !token) return null;
  return { pageId, token };
}

/**
 * Where the reel lives. Facebook answers `permalink_url` as a site-relative
 * path (`/reel/123…`); absent, every reel is reachable at /reel/{video_id}.
 */
export function permalinkFor(videoId, permalinkUrl = null) {
  const p = String(permalinkUrl ?? '').trim();
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith('/')) return `https://www.facebook.com${p}`;
  return `https://www.facebook.com/reel/${encodeURIComponent(String(videoId))}`;
}

/**
 * Read Facebook's status object into one of three answers. Pure, so the
 * shapes Meta documents — and the ones it does not — are pinned by name.
 */
export function interpretStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  const phases = ['uploading_phase', 'processing_phase', 'publishing_phase'];
  for (const name of phases) {
    const ph = s[name];
    if (ph && typeof ph === 'object' && String(ph.status).toLowerCase() === 'error') {
      const msg = ph.error?.message ?? (Array.isArray(ph.errors) ? ph.errors.map((e) => e?.message).filter(Boolean).join('; ') : '');
      return { done: false, failed: true, reason: `${name.replace('_phase', '')}: ${msg || 'error'}` };
    }
  }
  const vs = String(s.video_status ?? '').toLowerCase();
  if (['error', 'expired', 'upload_failed'].includes(vs)) return { done: false, failed: true, reason: `video_status ${vs}` };
  const pub = String(s.publishing_phase?.status ?? '').toLowerCase();
  if (pub === 'complete' || pub === 'completed' || vs === 'ready') return { done: true, failed: false, reason: null };
  return { done: false, failed: false, reason: null };
}

/** Graph's error envelope, reduced to a sentence that carries no secret. */
function graphError(body, fallback) {
  const e = body?.error;
  if (!e) return fallback;
  const code = [e.code, e.error_subcode].filter((x) => x != null).join('/');
  return `facebook ${code ? code + ' ' : ''}${e.message ?? fallback}`;
}

/**
 * Publish one rendered file to one Page. Resolves `{ ok, videoId, permalink,
 * pending }`; throws with a plain message on any refusal. Every network call is
 * injectable so the whole sequence is tested without Facebook.
 */
export async function publishFacebookReel({
  pageId, token, videoPath, description = '',
  fetchImpl = fetch,
  readFile = readFileSync,
  fileSize = (p) => statSync(p).size,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  deadlineMs = STATUS_DEADLINE_MS,
  pollMs = STATUS_POLL_MS,
} = {}) {
  if (!pageId || !token) throw new Error('no Facebook Page credentials');
  if (!videoPath) throw new Error('no video to upload');
  const auth = { authorization: `Bearer ${token}` };
  const form = (fields) => new URLSearchParams(fields).toString();
  const call = async (url, init, what) => {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw new Error(`${what}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw new Error(graphError(body, `${what}: HTTP ${res.status}`));
    return body;
  };

  /* 1. start */
  const start = await call(`${GRAPH}/${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ upload_phase: 'start' }),
  }, 'start');
  const videoId = String(start.video_id ?? '');
  if (!videoId) throw new Error('start: no video_id in the answer');

  /* 2. upload — the whole file in one request. The docs' resumable variant
     (offset = bytes_transferred) exists for files far larger than a 20 MB
     reel; a failure here is retried whole from the tick. */
  const size = fileSize(videoPath);
  const uploadUrl = /^https:\/\/rupload\.facebook\.com\//.test(String(start.upload_url ?? ''))
    ? String(start.upload_url)
    : `${UPLOAD}/${encodeURIComponent(videoId)}`;
  await call(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(size),
      'content-type': 'application/octet-stream',
    },
    body: readFile(videoPath),
  }, 'upload');

  /* 3. finish */
  await call(`${GRAPH}/${encodeURIComponent(pageId)}/video_reels`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: String(description ?? '') }),
  }, 'finish');

  /* 4. wait for "published", bounded. */
  const started = now();
  let permalinkUrl = null;
  while (now() - started < deadlineMs) {
    const st = await call(`${GRAPH}/${encodeURIComponent(videoId)}?fields=status,permalink_url`, { headers: auth }, 'status');
    permalinkUrl = st.permalink_url ?? permalinkUrl;
    const v = interpretStatus(st.status);
    if (v.failed) throw new Error(`publish ${v.reason}`);
    if (v.done) return { ok: true, videoId, permalink: permalinkFor(videoId, permalinkUrl), pending: false };
    await sleep(pollMs);
  }
  return { ok: true, videoId, permalink: permalinkFor(videoId, permalinkUrl), pending: true };
}
