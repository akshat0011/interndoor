/* /api/post-job — an employer asking for a role to go on the board.
 *
 * WHY IT EXISTS: until 9 Oct 2026 the only way onto the board was the
 * watchlist, which a startup cannot ask to join. This takes a request; it does
 * NOT publish anything. Every submission is reviewed by hand on the Mac
 * (`npm run submissions`), and only an approval adds the company to the
 * watchlist and the role to the store — so the board's promise ("a list of
 * real employers, nothing else gets on") holds for direct posts too.
 *
 * WHAT IT KEEPS: company, website, a work address, the link to the role, the
 * kind, the stated pay and an optional note. Nothing else — no IP, no user
 * agent. Same Upstash Redis as /api/feedback, its own list, newest first,
 * trimmed in the same pipeline as the push.
 *
 * THE GATE IS HERE BECAUSE THE QUEUE IS READ BY ONE PERSON. In the 30 days to
 * 9 Oct the scan turned away 17,335 different India employers, most of them
 * intern mills and course sellers; an open form is where they would arrive
 * next. So the cheap refusals happen before anything is stored: a free-mail
 * address, an address that is not at the company's own domain, an unpaid role,
 * a shortened link. What survives still waits for a human.
 *
 * WITH NO STORE IT REFUSES HONESTLY (503) and names the email address, exactly
 * as /api/feedback does. NOTHING PERSONAL IS EVER LOGGED — Vercel keeps
 * function logs, so a console line naming the sender IS storage.
 */
import { normaliseEmail } from './subscribe.js';

export const LIST_KEY = 'job-submissions';
export const KEEP = 500;
export const MAX_NOTES = 1000;
export const STORE_TIMEOUT_MS = 6_000;

/* Personal mailboxes. A work address at the company's own domain is the one
   check a form can make that a mill cannot fake cheaply, so these are refused
   outright rather than reviewed. */
export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com',
  'outlook.com', 'outlook.in', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zohomail.in', 'zohomail.com',
  'gmx.com', 'mail.com', 'yandex.com', 'tutanota.com',
]);

/* A shortened link hides where it goes, and the review is mostly reading
   where it goes. */
export const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'rb.gy', 'cutt.ly', 'shorturl.at', 'lnkd.in',
  'is.gd', 'ow.ly', 'tiny.cc', 'buff.ly', 'rebrand.ly',
]);

export const KINDS = new Set(['intern', 'fulltime']);
export const PERIODS = { month: 10_00_000, year: 1_00_00_000 };

/* An employer may send a few roles in a row; a script filling the queue is
   the thing to stop. Same speed bump as /api/feedback. */
const PER_IP_PER_MINUTE = 5;
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

/** One line of text: control characters out, whitespace collapsed. */
export function cleanLine(raw, max) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? '' : s;
}

/** Prose: newlines kept as paragraph breaks, every other control character out. */
export function cleanNotes(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A public web address, or null. `http` is accepted and upgraded — plenty of
 * real careers pages are typed without the s — but the host must be a real
 * name: no IP address, no localhost, no single-label host, no credentials.
 */
export function cleanUrl(raw, max = 600) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > max || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  /* No dot refuses localhost, a single-label intranet name and every IPv6
     literal (the URL parser writes those with colons only); the digits test
     refuses an IPv4 address. */
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null;
  u.protocol = 'https:';
  u.hash = '';
  return u.toString();
}

/** The site's host without a leading `www.`, lower-cased. */
export function siteHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Whether an email domain belongs to the same organisation as a website host.
 * Equal, or one is a subdomain of the other — `careers.razorpay.com` and
 * `razorpay.com` agree, `razorpay.com` and `razorpay.com.evil.example` do not
 * (the dot before the suffix is what refuses a lookalike).
 */
export function sameOrg(emailDomain, host) {
  const a = String(emailDomain ?? '').toLowerCase();
  const b = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * The submission a body describes, or an { error } a person can read.
 * Pure and tested by name; the handler only does transport.
 */
export function parseJobSubmission(body) {
  let b = body;
  if (typeof b === 'string') {
    if (b.length > 8000) return { error: 'That is too long. Please shorten the note.' };
    try { b = JSON.parse(b); } catch { return { error: 'Could not read that. Please try again.' }; }
  }
  if (!b || typeof b !== 'object') return { error: 'Could not read that. Please try again.' };

  /* The honeypot. Not `company` (subscribe.js and feedback.js use that name)
     because here company is a real field. A filled one is answered with a
     plain success, never an error, or the bot learns which field gave it away. */
  if (typeof b.fax === 'string' && b.fax.trim()) return { accepted: false };

  const company = cleanLine(b.company, 120);
  if (company.length < 2) return { error: 'Enter your company’s name.' };

  const website = cleanUrl(b.website, 300);
  if (!website) return { error: 'Enter your company’s website, like https://yourcompany.com.' };
  const host = siteHost(website);

  const email = normaliseEmail(typeof b.email === 'string' ? b.email : '');
  if (!email) return { error: 'That does not look like an email address.' };
  const domain = email.split('@')[1];
  if (FREE_MAIL.has(domain)) return { error: 'Please use your work email at your company’s own domain, not a personal mailbox.' };
  if (!sameOrg(domain, host)) {
    return { error: `Please use an email address at ${host}, the same domain as the website you entered.` };
  }

  const link = cleanUrl(b.link);
  if (!link) return { error: 'Enter the link to the role — on your careers page, your job board, or LinkedIn.' };
  if (SHORTENERS.has(siteHost(link))) return { error: 'Please send the full link to the role, not a shortened one.' };

  const kind = String(b.kind ?? '');
  if (!KINDS.has(kind)) return { error: 'Choose whether this is an internship or an entry-level job.' };

  const period = String(b.period ?? '');
  if (!Object.hasOwn(PERIODS, period)) return { error: 'Choose whether the pay is per month or per year.' };
  const pay = Number(String(b.pay ?? '').replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(pay) || pay <= 0) {
    return { error: 'InternDoor lists paid roles only. Enter the stipend or salary in rupees.' };
  }
  if (!Number.isInteger(pay)) return { error: 'Enter the pay as a whole number of rupees.' };
  if (pay > PERIODS[period]) return { error: `That is more than ₹${PERIODS[period].toLocaleString('en-IN')} a ${period}. Check the figure, and whether it is per month or per year.` };

  const notes = cleanNotes(b.notes);
  if (notes.length > MAX_NOTES) return { error: `Please keep the note under ${MAX_NOTES} characters.` };

  return { accepted: true, entry: { company, website, email, link, kind, pay, period, notes: notes || null } };
}

export function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** A short id he can type: `npm run submissions -- --approve k3x9q2`. */
export function newId(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(rand() * 31)];
  return s;
}

/** Newest first, trimmed in the SAME pipeline as the push (/api/feedback's rule). */
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Send the form with POST.' });
  }

  const parsed = parseJobSubmission(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  if (!parsed.accepted) return res.status(200).json({ ok: true });

  if (rateLimited(clientIp(req), Date.now())) {
    return res.status(429).json({ ok: false, error: 'That is a lot of submissions at once. Please try again in a minute.' });
  }

  const target = store();
  if (!target) {
    return res.status(503).json({
      ok: false,
      error: 'Submissions are not set up on this site yet, so that was not sent. Please email the link to akshat@interndoor.com instead.',
    });
  }

  const entry = { id: newId(), at: new Date().toISOString(), ...parsed.entry };
  if (!(await save(entry, target))) {
    console.error('post-job: store write failed');
    return res.status(502).json({ ok: false, error: 'That did not send. Please try again in a moment.' });
  }
  return res.status(200).json({ ok: true });
}
