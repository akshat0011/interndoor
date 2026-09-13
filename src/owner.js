/**
 * Owner controls on interndoor.com — the part that decides who may use them.
 *
 * The site is static files on Vercel and everything an owner action needs — the
 * store, the local model, the publisher — lives on this Mac. So the controls on
 * the live site call the post-queue helper at 127.0.0.1 straight from HIS
 * browser: nothing new is exposed on the internet, and a visitor's browser never
 * loads the owner script at all (the loaders in app.js and page.js gate on a
 * stored pairing token).
 *
 * THAT MAKES 127.0.0.1 REACHABLE FROM A PUBLIC ORIGIN, AND THREE GUARDS HOLD IT:
 *
 *   1. A PAIRED TOKEN. Generated once, kept 0600 in the state directory, handed
 *      to the site only by a page served FROM 127.0.0.1 — which no other origin
 *      can read. Every owner call carries it in a header.
 *   2. AN ORIGIN ALLOWLIST. Any page he visits can fire a request at 127.0.0.1;
 *      only interndoor.com (and the local preview) is answered with CORS
 *      headers, so no other page can read a reply, and a POST from anywhere else
 *      is refused before its body is read.
 *   3. A HOST CHECK. DNS rebinding points an attacker's hostname at 127.0.0.1
 *      and makes their page same-origin with this server; the Host header then
 *      names their domain, not ours, and the request is refused.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

/** Pages allowed to drive the owner API: the live site and `npm run web`. */
export const OWNER_ORIGINS = Object.freeze([
  'https://interndoor.com',
  'https://www.interndoor.com',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
]);

export const TOKEN_HEADER = 'x-owner-token';

/** Read the pairing token, creating it on first use. */
export function ownerToken(file) {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48}$/.test(t)) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return t;
}

/** Is this request addressed to US, and not to a rebound hostname? */
export function localHost(req, port) {
  const host = String(req.headers?.host ?? '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(req) {
  const origin = req.headers?.origin;
  return typeof origin === 'string' && OWNER_ORIGINS.includes(origin) ? origin : null;
}

/**
 * CORS headers for an allowed origin, or null.
 *
 * `Access-Control-Allow-Private-Network` answers Chrome's Private Network
 * Access preflight, which a public page reaching 127.0.0.1 triggers. Newer
 * Chrome additionally asks HIM once whether interndoor.com may reach this
 * device; that prompt is the browser's, not something this server can answer.
 */
export function corsHeaders(req) {
  const origin = allowedOrigin(req);
  if (!origin) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * May this request act as the owner?
 *
 * An Origin is REQUIRED, not merely checked when present. A browser always sends
 * one on a cross-origin fetch, and interndoor.com is always cross-origin to
 * 127.0.0.1 — so a missing Origin means something that is not his browser on
 * the site, and the token alone is not allowed to stand in for it.
 */
export function ownerAuth(req, { port, token }) {
  if (!localHost(req, port)) return { ok: false, status: 403, error: 'wrong host' };
  if (!allowedOrigin(req)) return { ok: false, status: 403, error: 'origin not allowed' };
  if (!sameToken(req.headers?.[TOKEN_HEADER], token)) return { ok: false, status: 401, error: 'not paired' };
  return { ok: true };
}

/* ------------------------------------------------------------------- edits */

const EDIT_LIMITS = { title: 160, location: 160, stipend: 80 };

/**
 * The three fields he may correct, cleaned.
 *
 * An EMPTY string clears that field's override — the posting's own value comes
 * back. A field left out of the body is left as it was. Control characters are
 * refused rather than stripped: a title with a newline in it is a paste gone
 * wrong, and publishing a silently repaired version of it hides that.
 */
export function parseEdit(body) {
  const out = {};
  for (const [field, max] of Object.entries(EDIT_LIMITS)) {
    if (!(field in (body ?? {}))) continue;
    const v = body[field];
    if (v !== null && typeof v !== 'string') return { error: `${field} must be text` };
    const s = (v ?? '').trim().replace(/\s+/g, ' ');
    if (/[\u0000-\u001f\u007f]/.test(v ?? '')) return { error: `${field} contains a control character` };
    if (s.length > max) return { error: `${field} is longer than ${max} characters` };
    out[field] = s || null;
  }
  if (!Object.keys(out).length) return { error: 'nothing to change' };
  return { edit: out };
}

/**
 * A stored row with his corrections laid over it.
 *
 * Applied where rows are READ for publishing and for writing posts, never
 * written back into `jobs`: the posting's own values stay, so an override can
 * be cleared, and the original title is still there to redirect the old URL
 * from — the title is part of the job's slug.
 *
 * PAY IS DISPLAY TEXT, SO THE STRUCTURED FIGURES GO WITH IT. `stipend` is built
 * from `stipend_min/max/currency/period` before `salary_text`; an override has
 * to clear those or the old figure wins, and it has to clear them for the
 * JobPosting markup too — `safeBaseSalary` would otherwise go on stating a
 * number he has just said is wrong.
 */
export function applyJobEdit(row, edit) {
  if (!row || !edit) return row;
  const out = { ...row };
  if (edit.title) { out.title = edit.title; out.original_title = row.title; }
  if (edit.location) out.location = edit.location;
  if (edit.stipend) {
    out.salary_text = edit.stipend;
    out.stipend_min = null;
    out.stipend_max = null;
    out.stipend_currency = null;
    out.stipend_period = null;
  }
  return out;
}

export function applyJobEdits(rows, edits) {
  if (!edits?.size) return rows;
  return rows.map((r) => applyJobEdit(r, edits.get(String(r.job_id))));
}

/** "/us/jobs/acme-intern-123" → "acme-intern-123"; anything else → null. */
export function slugFromPath(pathname) {
  const m = String(pathname ?? '').match(/^\/(?:[a-z]{2}\/)?jobs\/([a-z0-9-]+?)(?:\.html)?\/?$/);
  return m ? m[1] : null;
}
