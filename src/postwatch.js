/**
 * THE JOBS HE POSTS TO LINKEDIN ARE RE-CHECKED EVERY FEW HOURS FOR A WEEK.
 *
 * WHY (8 Oct 2026). Readers arrive from his LinkedIn posts, press Apply, and
 * find the role closed while InternDoor still says "Likely open". The worked
 * case: Salesforce "Software Engineering AMTS" — posted 14:48, 117 applicants
 * by 15:30, drafted at 17:00, and its LinkedIn posting answered 404 the next
 * day. The daily link sweep would have reached it a day or two later, and could
 * not have caught it at all: its employer link answers 200 with a generic page
 * either way. The posts are where the traffic is, so those few jobs get the
 * tight loop: every `WATCH_EVERY_MS`, for `WATCH_DAYS`, from the moment one is
 * added to the post queue.
 *
 * TWO CHECKS, EITHER CLOSES IT:
 *  - LinkedIn's PUBLIC posting page (never the account) for a LinkedIn id —
 *    "No longer accepting applications", or a 404/410 seen twice;
 *  - the employer's application link — a 404/410 seen twice, or a redirect
 *    away to a listing (the link sweep's own `checkLink` rule).
 * A positive answer stamps `link_ok_at` (the page's "checked" line and its
 * indexability rest on it). A 429/999 from LinkedIn pauses the whole watch for
 * `PAUSE_MS` — the scans' discovery shares that per-IP limit and matters more.
 *
 * ONE JOB PER TICK. The queue server ticks every minute; a handful of watched
 * jobs × one check every three hours is a few requests an hour, never a burst.
 * State is one settings row (`postedWatch`), so a restart loses nothing.
 */
import { checkPosting, checkLink } from './linksweep.js';
import { parsePublicPosting } from './guestsearch.js';

export const KEY = 'postedWatch';
export const WATCH_DAYS = 7;
export const WATCH_EVERY_MS = 3 * 3_600_000;
export const PAUSE_MS = 30 * 60_000;
export const CONFIRM_GAP_MS = 3_000;

export function readWatch(store) {
  try {
    const w = JSON.parse(store.getSetting(KEY) ?? '{}');
    return w && typeof w === 'object' && w.jobs && typeof w.jobs === 'object' ? w : { jobs: {} };
  } catch { return { jobs: {} }; }
}
function saveWatch(store, w) { store.setSetting(KEY, JSON.stringify(w)); }

/** Start watching a job (idempotent: a re-queue does not restart its week). */
export function watchJob(store, jobId, now = Date.now()) {
  const w = readWatch(store);
  const id = String(jobId);
  if (!w.jobs[id]) w.jobs[id] = { added: now, checked: 0 };
  saveWatch(store, w);
}

/** The next job due, least recently checked first; null when none is. Drops expired entries. */
export function nextDue(w, now = Date.now()) {
  let best = null;
  for (const [id, e] of Object.entries(w.jobs)) {
    if (now - Number(e.added) > WATCH_DAYS * 86_400_000) { delete w.jobs[id]; continue; }
    if (now - Number(e.checked || 0) < WATCH_EVERY_MS) continue;
    if (!best || Number(e.checked || 0) < Number(w.jobs[best].checked || 0)) best = id;
  }
  return best;
}

const isLinkedInId = (id) => /^\d{6,}$/.test(String(id));
const isLinkedInUrl = (u) => !u || /linkedin\.com/i.test(String(u));

/**
 * One tick: check the job most overdue, close it on evidence, record the check.
 * Returns what happened, for the log; `closed` true means a publish is owed.
 */
export async function postWatchTick(store, {
  now = Date.now(),
  checkLi = (id) => checkPosting(id, { parse: parsePublicPosting }),
  checkEmp = (url) => checkLink(url),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const w = readWatch(store);
  if (Number(w.pausedUntil || 0) > now) return { state: 'paused' };
  const id = nextDue(w, now);
  if (!id) { saveWatch(store, w); return { state: 'idle' }; }

  const row = store.db.prepare('SELECT job_id, company, title, apply_url, is_tech, closed_at, suppressed_reason FROM jobs WHERE job_id = ?').get(id);
  if (!row || row.closed_at != null || row.is_tech !== 1 || row.suppressed_reason) {
    delete w.jobs[id];
    saveWatch(store, w);
    return { state: 'dropped', id };
  }

  let closeNote = null;
  let alive = false;

  if (isLinkedInId(id)) {
    let r = await checkLi(id);
    if (r.verdict === 'gone') { await sleep(CONFIRM_GAP_MS); const again = await checkLi(id); if (again.verdict !== 'gone') r = again; }
    if (r.verdict === 'blocked') {
      w.pausedUntil = now + PAUSE_MS;
      saveWatch(store, w);
      return { state: 'blocked', id, note: r.note };
    }
    if (r.verdict === 'closed' || r.verdict === 'gone') closeNote = `LinkedIn: ${r.note}`;
    else if (r.verdict === 'open') alive = true;
  }

  if (!closeNote && !isLinkedInUrl(row.apply_url)) {
    let r = await checkEmp(row.apply_url);
    if (r.dead) { await sleep(CONFIRM_GAP_MS); const again = await checkEmp(row.apply_url); if (!again.dead) r = again; }
    if (r.dead) closeNote = `apply link dead: ${r.note}`;
    else if (String(r.note ?? '').startsWith('HTTP 200')) alive = true;
  }

  const day = new Date(now).toISOString().slice(0, 10);
  if (closeNote) {
    store.markClosed(id, `${closeNote} (${day}, posted-job watch)`, now);
    delete w.jobs[id];
  } else {
    store.markLinkChecked([id], now, { ok: alive });
    w.jobs[id].checked = now;
  }
  saveWatch(store, w);
  return { state: closeNote ? 'closed' : alive ? 'open' : 'unknown', id, company: row.company, title: row.title, note: closeNote, closed: !!closeNote };
}
