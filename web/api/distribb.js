/* /api/distribb: Distribb's "API Webhook" posts each article here.
 *
 * WHY IT EXISTS: blog.interndoor.com is a static site built on the Mac from
 * blog/content and committed (blog/README.md). Distribb can only publish to a
 * CMS it knows or to a webhook, so this endpoint is the hand-off: it checks
 * the token, keeps the article exactly as sent, and answers 2xx. The Mac
 * (bin/distribb-import.js, every scan tick) reads the list, turns each article
 * into a blog post, builds, commits and pushes. Nothing here renders anything.
 *
 * THE TOKEN IS DERIVED, NOT CONFIGURED: sha256 of a fixed label and the Redis
 * token Vercel and the Mac already both hold (the owner AI pass's precedent in
 * /api/ai), so no Vercel setting was added for it. Rotating the Redis token
 * rotates this one. `node bin/distribb-import.js --token` copies it to the
 * clipboard for the Distribb form; it is never printed.
 *
 * Distribb sends the token three ways (Authorization: Bearer, X-API-Key and
 * x-make-apikey); any one is enough. Its connection check sends HEAD, then
 * OPTIONS, with no body: both answer without the token, and reveal nothing.
 *
 * NOTHING FROM THE BODY IS EVER LOGGED. Failures log a status only.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const LIST_KEY = 'distribb:inbox';
export const KEEP = 100;
/* Upstash's REST API refuses a request over 1 MB on the free plan. An article
   of 2,800 words is ~20 KB of HTML; anything near the limit is images inlined
   as data, which the blog would drop anyway. */
export const MAX_BODY = 900_000;
const STORE_TIMEOUT_MS = 8000;
const BLOG = 'https://blog.interndoor.com';

export function store(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export function webhookToken(env = process.env) {
  const t = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return t ? createHash('sha256').update(`interndoor-distribb-webhook|${t}`).digest('hex') : null;
}

/** The token from whichever of the three headers carries it. */
export function presentedToken(headers = {}) {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    if (m) return m[1];
  }
  for (const h of ['x-api-key', 'x-make-apikey']) {
    if (typeof headers[h] === 'string' && headers[h]) return headers[h].trim();
  }
  return null;
}

export function authorised(req, env = process.env) {
  const want = webhookToken(env);
  const got = presentedToken(req.headers);
  if (!want || typeof got !== 'string' || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Vercel hands a JSON body over parsed; a local server or a mislabelled request may not. */
export function readBody(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof s !== 'string' || !s.trim()) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/* The article may arrive bare or inside an envelope; only the shape is
   checked here, the importer does the reading. */
export function articleOf(body) {
  for (const a of [body, body?.article, body?.data, body?.data?.article, body?.post]) {
    if (a && typeof a === 'object' && (typeof a.title === 'string' || typeof a.content === 'string' || typeof a.html === 'string')) return a;
  }
  return null;
}

export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}

/** Where the post will live once the Mac has imported it (within one scan tick). */
export function expectedUrl(article) {
  const slug = typeof article.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) ? article.slug : slugify(article.title);
  return slug ? `${BLOG}/${slug}` : `${BLOG}/`;
}

export async function save(entry, { url, token }, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout?.(STORE_TIMEOUT_MS),
      body: JSON.stringify([
        ['LPUSH', LIST_KEY, JSON.stringify(entry)],
        ['LTRIM', LIST_KEY, 0, KEEP - 1],
      ]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function respond(req, { env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (req.method === 'HEAD') return { status: 200, headers: { Allow: 'POST, HEAD, OPTIONS' } };
  if (req.method === 'OPTIONS') return { status: 204, headers: { Allow: 'POST, HEAD, OPTIONS' } };
  if (req.method !== 'POST') return { status: 405, headers: { Allow: 'POST, HEAD, OPTIONS' }, body: { ok: false, error: 'POST an article.' } };

  const target = store(env);
  if (!target) return { status: 503, body: { ok: false, error: 'This endpoint has no store configured.' } };
  if (!authorised(req, env)) return { status: 401, body: { ok: false, error: 'Missing or wrong access token.' } };

  const body = readBody(req.body);
  if (!body) return { status: 400, body: { ok: false, error: 'The body is not a JSON object.' } };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > MAX_BODY) return { status: 413, body: { ok: false, error: `The article is ${size} bytes; the limit is ${MAX_BODY}.` } };
  const article = articleOf(body);
  if (!article) return { status: 400, body: { ok: false, error: 'No article (title or content) in the body.' } };

  const entry = { id: randomBytes(6).toString('hex'), at: now().toISOString(), body };
  if (!(await save(entry, target, fetchImpl))) {
    console.error('distribb: store write failed');
    return { status: 502, body: { ok: false, error: 'Could not store the article. Please retry.' } };
  }
  const url = expectedUrl(article);
  return { status: 200, body: { ok: true, id: entry.id, url, link: url } };
}

export default async function handler(req, res) {
  const out = await respond(req);
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.body === undefined) return res.status(out.status).end();
  return res.status(out.status).json(out.body);
}
