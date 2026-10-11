/**
 * IS THIS JOB STILL OPEN? — every check is a SIGNAL with a weight, and the
 * status is decided from all of them together, with a confidence. Pure: no
 * network, no database. src/jobchecks.js fetches and stores; this decides.
 *
 * WHY (11 Oct 2026, his ask). Until now each checker closed a job on its own
 * rule — a 404 seen twice a few seconds apart, a redirect to a listing page,
 * LinkedIn saying "no longer accepting" — recorded nothing about WHY, and had
 * no way to say "unsure". An employer link answering 200 counted as alive even
 * when the page was a generic careers page (Salesforce, 8 Oct). Now:
 *
 *  - every check is stored (job_checks), so a status can be explained;
 *  - a strong signal closes on its own, a medium one makes the job POSSIBLY
 *    CLOSED (still on the board, labelled, off the channels, rechecked in 6h),
 *    and two medium ones from separate checks close it;
 *  - a check that could not see the job — 403, 429, a CAPTCHA, a sign-in
 *    page, a timeout, a server error — is recorded and moves nothing.
 *
 * CONFIDENCE is the probability of the status SHOWN: for closed and possibly
 * closed it is how sure we are the job is gone, for open how sure it is open.
 * Separate checks combine as independent evidence (1 − Π(1 − w)); repeats of
 * the same source inside OCCASION_MS are one occasion, not two — a CDN that
 * 404s twice in three seconds has said one thing once.
 */
import { redirectedAway, postingToken } from './linksweep.js';

export const SIGNALS = {
  closed_text:    { dir: 'closed', weight: 0.95, label: 'the page says it is no longer accepting applications' },
  gone_410:       { dir: 'closed', weight: 0.85, label: 'the application page answered 410 Gone' },
  gone_404:       { dir: 'closed', weight: 0.65, label: 'the application page answered 404' },
  redirect_away:  { dir: 'closed', weight: 0.65, label: 'the application link now lands on a listing or home page' },
  /* RECORDED, NOT WEIGHED. Measured 11 Oct 2026 on 160 live employer pages:
     5 answered 200 with plenty of text and no sign of the job — Accenture,
     Capgemini, Wipro's tracker, a Greenhouse embed — and all 5 were live; the
     job is drawn by JavaScript after the page loads. Until a host is known to
     render its jobs on the server, a page without the job proves nothing. */
  page_lost_job:  { dir: 'none', label: 'the application page does not show the job (it may be drawn by script)' },
  open_accepting: { dir: 'open', weight: 0.9, label: 'LinkedIn still takes applications' },
  open_names_job: { dir: 'open', weight: 0.8, label: 'the application page still shows the job' },
  open_page:      { dir: 'open', weight: 0.6, label: 'the application page answered' },
  blocked:        { dir: 'none', label: 'blocked (403 or a bot check)' },
  rate_limited:   { dir: 'none', label: 'rate limited (429)' },
  login_wall:     { dir: 'none', label: 'a sign-in page' },
  unreachable:    { dir: 'none', label: 'timed out or unreachable' },
  server_error:   { dir: 'none', label: 'a server error' },
  unreadable:     { dir: 'none', label: 'a page we could not read' },
};

export const STATUSES = ['open', 'likely_open', 'possibly_closed', 'closed'];
export const CLOSE_AT = 0.8;                       // combined closed confidence that closes
export const OCCASION_MS = 6 * 3_600_000;          // same-source repeats inside this are one
export const WINDOW_MS = 14 * 86_400_000;          // checks older than this are not read
export const OPEN_FRESH_MS = 3 * 86_400_000;       // an open signal this recent is "open"
export const LISTED_FRESH_MS = 3 * 86_400_000;     // pages.js LISTED_FRESH_MS — first seen this recently is open
export const MIN_READABLE = 500;                   // visible characters below which a page is a JS shell

const H = 3_600_000;
const D = 24 * H;
export const INTERVALS = {
  possiblyClosed: 6 * H,
  hotEmployer: 3 * H,
  hotLinkedin: 6 * H,
  employer: 24 * H,
  employerOld: 48 * H,     // first seen more than OLD_AFTER ago
  linkedin: 48 * H,
  firstCheck: 2 * D,       // a job found in the last two days was in the results that recently
  closedRecheck: 2 * D,    // one look back at a job closed on medium evidence
  maxBackoff: 4 * D,
};
export const OLD_AFTER = 14 * D;

/* ------------------------------------------------------------- reading a page */

const decode = (s) => String(s ?? '')
  .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
  .replace(/&quot;|&#34;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&ndash;|&mdash;|&#821[12];/gi, '-');

/** What a reader would see: scripts, styles and markup removed. */
export function visibleText(html) {
  return decode(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

/** Lower case, every run of non-letters and non-digits one space. */
export const normalise = (s) => decode(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* THE CLOSED WORDING, read from VISIBLE text only. Raw HTML is the wrong place:
   Workday and Phenom pages carry their whole message catalogue in script
   blocks, "This job is no longer available" included, on every open job. */
const CLOSED_PHRASES = [
  /no longer accepting applications/,
  /\b(?:this|the) (?:job|position|role|posting|vacancy|opening|requisition|job posting|job opening)(?: you(?:'re| are) looking for)? (?:is|has been) (?:no longer (?:available|active|open|accepting)|closed|filled|expired|removed)\b/,
  /\b(?:position|job|role|vacancy) has been filled\b/,
  /\b(?:job|posting|vacancy|position) (?:has )?expired\b/,
  /\bno longer (?:available|open) for applications\b/,
  /\bapplications? (?:for this (?:job|role|position) )?(?:are|is|has been) (?:now )?closed\b/,
  /\b(?:job|position|posting|role) (?:is )?no longer (?:available|active|open)\b/,
  /\bthe job you are (?:looking for|trying to (?:view|apply for)) (?:is no longer|no longer exists|has been)\b/,
  /\bcustom job error\b/,   // Phenom's retired-requisition page
];

/* PHENOM SHIPS ITS EXPIRED-JOB VIEW ON EVERY JOB PAGE. "We're sorry… the job
   you are trying to apply for has been filled." sits in the HTML of live jobs
   (a hidden job-expire-view component): measured 11 Oct 2026, 18 of 160 live
   employer pages matched the closed wording and every Phenom one was a job
   posted days earlier, its own job data on the page (jobDetail status 200).
   On a Phenom page the job data decides, never the wording. */
export function phenomJob(html) {
  const s = String(html ?? '');
  if (!/\bphApp\b/.test(s) || !s.includes('"jobDetail"')) return null;
  const m = s.match(/"jobDetail"\s*:\s*\{\s*"status"\s*:\s*(\d+)\s*,\s*"hits"\s*:\s*(\d+)/);
  if (m && Number(m[1]) === 200 && Number(m[2]) > 0 && /"jobDetail"[\s\S]{0,200}"data"\s*:\s*\{\s*"job"\s*:\s*\{/.test(s)) return 'live';
  return 'unknown';
}

const BOT_CHECK = /verify you are (?:a )?human|are you a robot|just a moment\.\.\.|enable javascript and cookies to continue|attention required|unusual traffic|access denied/;
const LOGIN_PATH = /(?:^|\/)(?:login|signin|sign-in|logon|sso|oauth2?|authorize)(?:\/|$)/i;
/* Not okta.com: www.okta.com is Okta's own careers site (grnh.se lands there). */
const LOGIN_HOST = /^(?:login\.microsoftonline\.com|accounts\.google\.com)$/i;

/** The phrase a closed page says, or null. */
export function closedPhrase(text) {
  const t = String(text ?? '').toLowerCase();
  for (const re of CLOSED_PHRASES) { const m = t.match(re); if (m) return m[0]; }
  return null;
}

/**
 * Does the page still show THIS job? Its full title as a phrase, the title up
 * to its first separator ("Software Engineer I - Backend" → "software engineer
 * i"), or the posting's id from the URL (5+ digits, or a requisition code such
 * as JR10041) — anywhere in the HTML, scripts included: a page that carries the
 * job's data in JSON still knows the job.
 */
export function namesJob(html, title, url) {
  const raw = ` ${normalise(html)} `;
  const full = normalise(title);
  if (full.length >= 8 && raw.includes(` ${full} `)) return true;
  const head = normalise(String(title ?? '').split(/\s[-–|(,:]\s?|,|\(/)[0]);
  if (head.length >= 8 && head.split(' ').length >= 2 && raw.includes(` ${head} `)) return true;
  const tok = postingToken(url);
  const ids = String(tok).match(/[A-Za-z]{0,4}\d{5,}/g) ?? [];
  return ids.some((id) => raw.includes(id.toLowerCase()));
}

/**
 * One fetched page → one signal, with what was seen. The order is the point:
 * a refusal (403/429/CAPTCHA/sign-in) is never read as closed; an explicit
 * closed status or wording beats everything; a page too thin to read (a
 * JavaScript shell) is only "answered", as a 200 always was before.
 */
export function classifyPage({ status, html = '', requestedUrl = '', finalUrl = '', redirected = false, title = '', error = null } = {}) {
  if (error || status == null) return { signal: 'unreachable', detail: String(error ?? 'no answer').slice(0, 120) };
  if (status === 429) return { signal: 'rate_limited', detail: 'HTTP 429' };
  if (status === 401 || status === 403 || status === 407) return { signal: 'blocked', detail: `HTTP ${status}` };
  if (status === 410) return { signal: 'gone_410', detail: 'HTTP 410' };
  if (status === 404) return { signal: 'gone_404', detail: 'HTTP 404' };
  if (status >= 500) return { signal: 'server_error', detail: `HTTP ${status}` };
  if (status < 200 || status >= 300) return { signal: 'unreadable', detail: `HTTP ${status}` };

  let finalPath = '', finalHost = '';
  try { const f = new URL(String(finalUrl || requestedUrl)); finalPath = f.pathname; finalHost = f.host; } catch { /* keep blanks */ }
  if (redirected && redirectedAway(requestedUrl, finalUrl)) return { signal: 'redirect_away', detail: `to ${finalHost}${finalPath}`.slice(0, 160) };
  if (redirected && (LOGIN_PATH.test(finalPath) || LOGIN_HOST.test(finalHost))) return { signal: 'login_wall', detail: `to ${finalHost}${finalPath}`.slice(0, 160) };

  const text = visibleText(html);
  const lower = text.toLowerCase();
  if (text.length < 2500 && BOT_CHECK.test(lower)) return { signal: 'blocked', detail: 'a bot check page' };
  const phenom = phenomJob(html);
  if (phenom === 'live') return { signal: 'open_names_job', detail: "HTTP 200, the careers site's own data still has the job" };
  if (phenom === 'unknown') return { signal: 'unreadable', detail: 'a Phenom page without its job data' };
  const phrase = closedPhrase(lower);
  /* No "closed wording beside the job's text means a template" rule: tried
     11 Oct 2026, and all 4 pages it held back were really closed —
     SuccessFactors keeps the title in the page head after the job goes,
     SmartRecruiters keeps the description and disables Apply ("Sorry, this job
     has expired"). The one real template, Phenom's, is decided above. */
  if (phrase) return { signal: 'closed_text', detail: phrase.slice(0, 120) };
  if (text.length < MIN_READABLE) return { signal: 'open_page', detail: 'HTTP 200, little readable text' };
  if (namesJob(html, title, requestedUrl)) return { signal: 'open_names_job', detail: 'HTTP 200, the job is on the page' };
  return { signal: 'page_lost_job', detail: 'HTTP 200, the job is not on the page' };
}

/** LinkedIn's public posting check (linksweep.checkPosting) → a signal. */
export function linkedinSignal(r) {
  const v = r?.verdict;
  const note = String(r?.note ?? '');
  if (v === 'open') return { signal: 'open_accepting', detail: 'accepting applications' };
  if (v === 'closed') return { signal: 'closed_text', detail: 'no longer accepting applications' };
  if (v === 'gone') return { signal: note.includes('410') ? 'gone_410' : 'gone_404', detail: note };
  if (v === 'blocked') return { signal: 'rate_limited', detail: note };
  if (/network/i.test(note)) return { signal: 'unreachable', detail: note.slice(0, 120) };
  if (/^HTTP 5/.test(note)) return { signal: 'server_error', detail: note };
  return { signal: 'unreadable', detail: note.slice(0, 120) };
}

/* ---------------------------------------------------------- deciding a status */

/**
 * The status from the checks (newest or oldest first, either), plus what is
 * known without a request: when the job was first seen.
 *
 *   closed           combined closed evidence since the last open signal ≥ CLOSE_AT
 *   possibly_closed  some closed evidence since the last open signal, below that
 *   open             an open signal in the last OPEN_FRESH_MS, or first seen
 *                    within LISTED_FRESH_MS with nothing against it
 *   likely_open      everything else — nothing recent either way
 *
 * Returns { status, confidence, reason }.
 */
export function decideStatus({ checks = [], firstSeenAt = null, now = Date.now() } = {}) {
  const recent = checks
    .filter((c) => SIGNALS[c.signal] && Number(c.at) <= now && now - Number(c.at) <= WINDOW_MS)
    .sort((a, b) => Number(a.at) - Number(b.at));
  const opens = recent.filter((c) => SIGNALS[c.signal].dir === 'open');
  const lastOpen = opens[opens.length - 1] ?? null;
  const after = recent.filter((c) => SIGNALS[c.signal].dir === 'closed' && (!lastOpen || Number(c.at) > Number(lastOpen.at)));

  if (after.length) {
    /* Occasions: one per source per OCCASION_MS, carrying its strongest weight. */
    const occasions = [];
    for (const c of after) {
      const w = SIGNALS[c.signal].weight;
      const same = occasions.find((o) => o.source === c.source && Number(c.at) - o.start < OCCASION_MS);
      if (same) { if (w > same.weight) { same.weight = w; same.signal = c.signal; } }
      else occasions.push({ source: c.source, start: Number(c.at), weight: w, signal: c.signal });
    }
    const confidence = 1 - occasions.reduce((p, o) => p * (1 - o.weight), 1);
    const strongest = [...occasions].sort((a, b) => b.weight - a.weight)[0];
    const reason = SIGNALS[strongest.signal].label + (occasions.length > 1 ? ` (seen on ${occasions.length} separate checks)` : '');
    return { status: confidence >= CLOSE_AT ? 'closed' : 'possibly_closed', confidence: round(confidence), reason };
  }
  if (lastOpen && now - Number(lastOpen.at) <= OPEN_FRESH_MS) {
    return { status: 'open', confidence: SIGNALS[lastOpen.signal].weight, reason: SIGNALS[lastOpen.signal].label };
  }
  const first = Number(firstSeenAt);
  if (Number.isFinite(first) && first > 0 && now - first <= LISTED_FRESH_MS) {
    return { status: 'open', confidence: 0.7, reason: 'listed in the last 3 days' };
  }
  return { status: 'likely_open', confidence: 0.5, reason: lastOpen ? 'last confirmed more than 3 days ago' : 'not confirmed yet' };
}

const round = (n) => Math.round(n * 100) / 100;

/**
 * When to look again. `kind` is 'employer' (an employer application page) or
 * 'linkedin' (LinkedIn's own posting page). `hot` = on the channels recently.
 * Three checks in a row that could not see the job double the wait (to
 * INTERVALS.maxBackoff): a site that always blocks us should not eat the
 * budget. Returns a time in ms, or null for "do not schedule".
 */
export function nextCheckAt({ status, kind = 'employer', hot = false, firstSeenAt = null, lastCheckAt = null, recentSignals = [], closedAt = null, rechecked = false, now = Date.now() } = {}) {
  if (status === 'closed') {
    if (closedAt == null || rechecked) return null;
    return Number(closedAt) + INTERVALS.closedRecheck;
  }
  if (status === 'possibly_closed') return Number(lastCheckAt ?? now) + INTERVALS.possiblyClosed;
  const age = now - Number(firstSeenAt ?? now);
  let gap = hot
    ? (kind === 'linkedin' ? INTERVALS.hotLinkedin : INTERVALS.hotEmployer)
    : kind === 'linkedin' ? INTERVALS.linkedin : age > OLD_AFTER ? INTERVALS.employerOld : INTERVALS.employer;
  const last3 = recentSignals.slice(-3);
  if (last3.length === 3 && last3.every((s) => SIGNALS[s]?.dir === 'none')) gap = Math.min(gap * 2, INTERVALS.maxBackoff);
  if (lastCheckAt == null) {
    /* Never checked: a job found in the last two days was in the results that
       recently, so its first look waits — unless it is on the channels. */
    return hot ? Number(firstSeenAt ?? now) + gap : Number(firstSeenAt ?? now) + INTERVALS.firstCheck;
  }
  return Number(lastCheckAt) + gap;
}

/** LinkedIn's limit tightens with India's daytime (45 of 61 first 429s fell
 *  10:30-18:30 IST, 30 Sep 2026): its routine checks run 00:00-09:30 IST. */
export function linkedinNight(now = Date.now()) {
  const ist = new Date(now + 5.5 * H);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m < 9 * 60 + 30;
}

/** A published row the site should treat as unsure: labelled, off the channels, not indexed. */
export const isUnsure = (job) => job?.status === 'possibly_closed';
