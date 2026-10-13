/**
 * THE CHECKER: which live jobs to look at this tick, the look itself, and
 * what it leaves behind — one `job_checks` row per look, and the job's
 * status, confidence, reason and next check on its row. src/jobstatus.js
 * decides; this fetches and stores. bin/job-check.js runs it after every scan.
 *
 * MODES (config.json jobStatus.mode):
 *  - 'shadow' — what shipped first. Every look is recorded and the new status
 *    is computed and stored, but a job is CLOSED only by the old link sweep's
 *    rules (a 404/410 or a redirect away seen twice a few seconds apart,
 *    LinkedIn saying "no longer accepting" or 404ing twice) and nothing on
 *    the site reads the status. It replaces bin/link-sweep.js --daily, so
 *    nothing is checked twice.
 *  - 'on' — the status decides: closed closes, possibly closed is shown with
 *    a label and kept off the channels (publish reads it), and a job closed
 *    on medium evidence is looked at once more two days later.
 *
 * BUDGETS. Employer pages: EMPLOYER_PER_TICK a tick, HOST_GAP_MS apart per
 * host. LinkedIn's public posting page shares one per-IP limit with the
 * scans' discovery, so routine LinkedIn checks run only at night IST
 * (linkedinNight), LINKEDIN_PER_TICK_NIGHT a tick; by day only jobs that are
 * on the channels or possibly closed, LINKEDIN_PER_TICK_DAY. The first 429
 * pauses LinkedIn checks for LINKEDIN_PAUSE_MS. The whole tick stops at
 * TICK_BUDGET_MS so the next scan is never late.
 */
import { classifyPage, linkedinSignal, decideStatus, nextCheckAt, linkedinNight, SIGNALS } from './jobstatus.js';
import { UA, hostOf, checkPosting, HOST_GAP_MS, HOST_CLOSE_CAP, CONFIRM_GAP_MS } from './linksweep.js';
import { parsePublicPosting } from './guestsearch.js';

export const EMPLOYER_PER_TICK = 60;
export const LINKEDIN_PER_TICK_NIGHT = 12;   // 8 until 13 Oct 2026; blind employer pages now share it
export const LINKEDIN_PER_TICK_DAY = 2;
export const LINKEDIN_GAP_MS = 6_000;
export const LINKEDIN_PAUSE_MS = 2 * 3_600_000;
export const TICK_BUDGET_MS = 4.5 * 60_000;
export const MAX_PAGE_BYTES = 400_000;
export const TIMEOUT_MS = 20_000;
export const KEEP_CHECKS_MS = 60 * 86_400_000;
const PAUSE_KEY = 'jobCheckLinkedinPausedUntil';
const HOST_KEY = 'jobCheckHostCloses';

/* ------------------------------------------------------------------ storage */

export function ensureJobChecks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_checks (
      job_id      TEXT NOT NULL,
      checked_at  INTEGER NOT NULL,
      source      TEXT NOT NULL,   -- 'employer' | 'linkedin'
      signal      TEXT NOT NULL,   -- a key of SIGNALS (src/jobstatus.js)
      http_status INTEGER,
      detail      TEXT             -- what was seen: a phrase, a status, where a redirect went
    );
    CREATE INDEX IF NOT EXISTS idx_job_checks_job ON job_checks(job_id, checked_at);
  `);
}

export function recordCheck(db, { jobId, at, source, signal, httpStatus = null, detail = null }) {
  db.prepare('INSERT INTO job_checks (job_id, checked_at, source, signal, http_status, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(jobId), at, source, signal, httpStatus, detail == null ? null : String(detail).slice(0, 300));
}

export function checksFor(db, jobId, sinceMs = 0) {
  return db.prepare('SELECT checked_at AS at, source, signal, http_status, detail FROM job_checks WHERE job_id = ? AND checked_at >= ? ORDER BY checked_at')
    .all(String(jobId), sinceMs);
}

export function saveStatus(db, jobId, { status, confidence, reason, at, next }) {
  db.prepare('UPDATE jobs SET status = ?, status_confidence = ?, status_reason = ?, status_at = ?, next_check_at = ? WHERE job_id = ?')
    .run(status, confidence, String(reason ?? '').slice(0, 200), at, next ?? null, String(jobId));
}

/** Checks older than KEEP_CHECKS_MS go: a job is off the board long before. */
export function pruneChecks(db, now = Date.now()) {
  return db.prepare('DELETE FROM job_checks WHERE checked_at < ?').run(now - KEEP_CHECKS_MS).changes;
}

/* ----------------------------------------------------------------- fetching */

/**
 * GET a page, following redirects, keeping at most MAX_PAGE_BYTES of an HTML
 * body and releasing the rest (an unread body held bin/run.sh for five hours
 * once — linksweep.checkLink). Never throws.
 */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES } = {}) {
  try {
    const res = await fetchImpl(String(url), {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    let html = '';
    const type = String(res.headers?.get?.('content-type') ?? '');
    if (res.ok && res.body?.getReader && /html|text/i.test(type)) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let n = 0;
      while (n < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        html += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch { /* already released */ }
    } else {
      try { res.body?.cancel?.()?.catch?.(() => {}); } catch { /* already released */ }
    }
    return { status: res.status, html, finalUrl: res.url || String(url), redirected: Boolean(res.redirected) };
  } catch (e) {
    return { status: null, error: e?.name ?? 'error' };
  }
}

/* ----------------------------------------------------------------- planning */

const isLinkedInId = (id) => /^\d{6,}$/.test(String(id));
const isLinkedInUrl = (u) => /linkedin\.com/i.test(String(u ?? ''));

/** 'employer' | 'linkedin' | null — which page tells us about this job.
 *  An employer page whose last look could not see the job (a bot wall, a
 *  timeout: Cognizant, GlobalLogic, NatWest refused every check) is asked on
 *  LinkedIn's public posting instead, when the job has a LinkedIn id: a page
 *  we can never confirm would otherwise go noindex however open it is
 *  (13 Oct 2026, 116 such rows). `employerBlind` is set by bin/job-check.js. */
export function kindOf(job) {
  const id = String(job?.id ?? job?.job_id ?? '');
  if (id.startsWith('ats:')) return null;   // its own board, re-read every poll, is the evidence
  const url = job?.applyUrl ?? job?.apply_url;
  if (url && !isLinkedInUrl(url)) return job?.employerBlind && isLinkedInId(id) ? 'linkedin' : 'employer';
  return isLinkedInId(id) ? 'linkedin' : null;
}

/**
 * Pure: the jobs to look at this tick, in order. `jobs` are published rows
 * (jobs.json) joined with their store columns: { id, applyUrl, title, company,
 * firstSeenAt, status, nextCheckAt, linkCheckedAt, closedAt }. `extra` are
 * closed rows owed their one recheck. Possibly closed first, then jobs on the
 * channels, then everything else by how overdue it is.
 */
export function planTick({ jobs = [], extra = [], hot = new Set(), now = Date.now(), linkedinPausedUntil = 0,
  employerPerTick = EMPLOYER_PER_TICK, linkedinPerTickNight = LINKEDIN_PER_TICK_NIGHT, linkedinPerTickDay = LINKEDIN_PER_TICK_DAY } = {}) {
  const due = [];
  for (const j of [...jobs, ...extra]) {
    const kind = kindOf(j);
    if (!kind) continue;
    if (j.closedAt != null && !j.recheck) continue;
    const isHot = hot.has(String(j.id));
    /* A blind employer page never asked on LinkedIn is due now: its stored
       next look was set for (and backed off on) the page that refuses us. */
    const switched = j.employerBlind && kind === 'linkedin' && j.applyUrl && !isLinkedInUrl(j.applyUrl) && j.linkedinCheckedAt == null;
    const at = switched ? now : (j.nextCheckAt ?? nextCheckAt({ status: j.status, kind, hot: isHot, firstSeenAt: j.firstSeenAt, lastCheckAt: j.linkCheckedAt ?? null, now }));
    if (at == null || at > now) continue;
    const rank = j.status === 'possibly_closed' ? 0 : j.recheck ? 1 : isHot ? 2 : 3;
    due.push({ ...j, kind, hot: isHot, dueAt: at, rank });
  }
  due.sort((a, b) => a.rank - b.rank || a.dueAt - b.dueAt);
  const night = linkedinNight(now);
  const liAllowed = now >= linkedinPausedUntil;
  const liCap = night ? linkedinPerTickNight : linkedinPerTickDay;
  const employer = due.filter((j) => j.kind === 'employer').slice(0, employerPerTick);
  const linkedin = liAllowed
    ? due.filter((j) => j.kind === 'linkedin' && (night || j.rank <= 2)).slice(0, liCap)
    : [];
  return { employer, linkedin, due: due.length };
}

/* ------------------------------------------------------------------ the tick */

const CLOSING = new Set(['gone_404', 'gone_410', 'redirect_away']);
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Look at the planned jobs and act. Everything external is injected, so the
 * whole decision is tested without the network. Returns a summary for the log.
 */
export async function runTick(store, {
  plan,
  mode = 'shadow',
  now = () => Date.now(),
  page = (url) => fetchPage(url),
  linkedin = (id) => checkPosting(id, { parse: parsePublicPosting }),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  budgetMs = TICK_BUDGET_MS,
  hostGapMs = HOST_GAP_MS,
  linkedinGapMs = LINKEDIN_GAP_MS,
  confirmGapMs = CONFIRM_GAP_MS,
  hostCloseCap = HOST_CLOSE_CAP,
  log = null,
} = {}) {
  const db = store.db;
  ensureJobChecks(db);
  const started = now();
  const out = { checked: 0, open: 0, possibly: 0, closed: 0, unknown: 0, held: 0, reopened: 0, shadowWouldClose: 0, linkedinBlocked: false, outOfTime: false, bySignal: {} };
  const lastHit = new Map();
  const hostCloses = readHostCloses(store, started);

  const settle = (job, source, res, at) => {
    recordCheck(db, { jobId: job.id, at, source, signal: res.signal, httpStatus: res.httpStatus ?? null, detail: res.detail });
    out.checked += 1;
    out.bySignal[res.signal] = (out.bySignal[res.signal] ?? 0) + 1;
    const dir = SIGNALS[res.signal]?.dir;
    /* link_ok_at keeps meaning what it always meant — the last POSITIVE look —
       so the job page's "checked" line and indexability are unchanged. */
    store.markLinkChecked([job.id], at, { ok: dir === 'open' });
    const history = checksFor(db, job.id, at - 14 * 86_400_000);
    const st = decideStatus({ checks: history, firstSeenAt: job.firstSeenAt, now: at });
    return { st, history };
  };

  const close = (job, reason, at, host) => {
    const n = hostCloses.get(host) ?? 0;
    if (n >= hostCloseCap) {
      if (n === hostCloseCap) log?.warn?.(`Job checks: ${host} — ${hostCloseCap} closed today and more look closed; holding the rest. A whole site at once is a restructure until someone looks.`);
      hostCloses.set(host, n + 1);
      out.held += 1;
      return false;
    }
    hostCloses.set(host, n + 1);
    const changed = store.markClosed(job.id, reason, at);
    if (changed) { out.closed += 1; log?.info?.(`Job checks: ${job.company} — "${job.title}" closed (${reason}).`); }
    return Boolean(changed);
  };

  const apply = (job, { st, history }, at, legacyClose, host) => {
    const signals = history.map((c) => c.signal);
    if (job.recheck) {
      /* The one look back at a job closed on medium evidence. */
      const latest = SIGNALS[signals[signals.length - 1]]?.dir;
      if (latest === 'open' && mode === 'on') {
        store.reopenJob(job.id);
        out.reopened += 1;
        log?.warn?.(`Job checks: ${job.company} — "${job.title}" reopened: ${st.reason}.`);
        saveStatus(db, job.id, { ...st, at, next: nextCheckAt({ status: st.status, kind: job.kind, hot: job.hot, firstSeenAt: job.firstSeenAt, lastCheckAt: at, recentSignals: signals, now: at }) });
      } else {
        saveStatus(db, job.id, { status: 'closed', confidence: job.statusConfidence ?? st.confidence, reason: job.statusReason ?? st.reason, at, next: null });
      }
      return;
    }
    let closedNow = false;
    if (mode === 'on' && st.status === 'closed') {
      closedNow = close(job, `status: ${st.reason} (${day(at)})`, at, host);
    } else if (mode !== 'on' && legacyClose) {
      closedNow = close(job, `${legacyClose} (${day(at)})`, at, host);
    }
    if (mode !== 'on' && st.status === 'closed' && !legacyClose) out.shadowWouldClose += 1;
    if (st.status === 'possibly_closed') out.possibly += 1;
    else if (st.status === 'open' || st.status === 'likely_open') out.open += 1;
    if (SIGNALS[signals[signals.length - 1]]?.dir === 'none') out.unknown += 1;
    const strong = history.some((c) => SIGNALS[c.signal]?.weight >= 0.95 && SIGNALS[c.signal]?.dir === 'closed');
    const next = closedNow
      ? (mode === 'on' && !strong ? at + 2 * 86_400_000 : null)
      : nextCheckAt({ status: st.status === 'closed' ? 'possibly_closed' : st.status, kind: job.kind, hot: job.hot, firstSeenAt: job.firstSeenAt, lastCheckAt: at, recentSignals: signals, now: at });
    saveStatus(db, job.id, { ...st, at, next });
  };

  /* Employer pages. */
  for (const job of plan.employer ?? []) {
    if (now() - started > budgetMs) { out.outOfTime = true; break; }
    const url = job.applyUrl;
    const host = hostOf(url);
    const wait = hostGapMs - (now() - (lastHit.get(host) ?? -Infinity));
    if (host && wait > 0) await sleep(wait);
    let p = await page(url);
    lastHit.set(host, now());
    let res = { ...classifyPage({ ...p, requestedUrl: url, title: job.title }), httpStatus: p.status ?? null };
    /* Shadow keeps the old rule exactly: a closing status is asked a second
       time a moment later, and only two agreeing answers close. */
    let legacy = null;
    if (mode !== 'on' && CLOSING.has(res.signal)) {
      await sleep(confirmGapMs);
      const again = await page(url);
      lastHit.set(host, now());
      const res2 = { ...classifyPage({ ...again, requestedUrl: url, title: job.title }), httpStatus: again.status ?? null };
      if (CLOSING.has(res2.signal)) legacy = `apply link dead: ${res.detail}`;
      else res = res2;
    }
    const at = now();
    apply(job, settle(job, 'employer', res, at), at, legacy, host);
  }

  /* LinkedIn's own posting pages. */
  for (const [i, job] of (plan.linkedin ?? []).entries()) {
    if (now() - started > budgetMs) { out.outOfTime = true; break; }
    if (i > 0) await sleep(linkedinGapMs);
    let r = await linkedin(job.id);
    let legacy = null;
    if (r?.verdict === 'gone') {
      await sleep(confirmGapMs);
      const again = await linkedin(job.id);
      if (again?.verdict === 'gone') legacy = `LinkedIn: ${r.note}`;
      else r = again;
    } else if (r?.verdict === 'closed') legacy = `LinkedIn: ${r.note}`;
    const res = linkedinSignal(r);
    if (res.signal === 'rate_limited') {
      out.linkedinBlocked = true;
      store.setSetting(PAUSE_KEY, String(now() + LINKEDIN_PAUSE_MS));
      log?.warn?.(`Job checks: LinkedIn answered ${r?.note ?? 'a rate limit'} — pausing LinkedIn checks for ${LINKEDIN_PAUSE_MS / 3_600_000}h; the scans' discovery shares that limit.`);
      break;
    }
    const at = now();
    apply(job, settle(job, 'linkedin', res, at), at, legacy, 'linkedin.com');
  }

  writeHostCloses(store, started, hostCloses);
  return out;
}

/* Per-host closes per DAY, so the cap means the same thing however many
   ticks a day the checker runs. */
function readHostCloses(store, now) {
  try {
    const v = JSON.parse(store.getSetting(HOST_KEY) ?? '{}');
    return new Map(v.day === day(now) ? Object.entries(v.hosts ?? {}) : []);
  } catch { return new Map(); }
}
function writeHostCloses(store, now, map) {
  store.setSetting(HOST_KEY, JSON.stringify({ day: day(now), hosts: Object.fromEntries(map) }));
}

export const linkedinPausedUntil = (store) => Number(store.getSetting(PAUSE_KEY) ?? 0) || 0;
