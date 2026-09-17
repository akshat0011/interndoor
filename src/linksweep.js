/**
 * The dead-apply-link sweep — decide which live postings' apply links have
 * gone, so the closed state (store.markClosed → publish stubs the URL, keeps
 * the row in the record) can be set the DAY a posting dies rather than the day
 * someone notices.
 *
 * WHY. On 17 Sep 2026 twenty S&P Global "Apprentice" postings were live on the
 * India board, each linking `careers.spglobal.com/jobs/NNN`, and every one of
 * those pages 404ed — "no longer available". They had been dead for up to six
 * days; the site only learned when a reader complained under a LinkedIn post
 * that the hub still said "N open". A row is not re-encountered once it falls
 * out of LinkedIn's window and its ATS board drops it, so nothing here notices
 * on its own. This checks the links.
 *
 * WHAT IS AND IS NOT EVIDENCE (bin/recheck-tech.js learned this the hard way):
 * a hard 404/410 is the only status that means gone. A 403 is a WAF bot-block
 * (22 of 30 "dead" links in one 2 Sep sweep were 403s that a browser opened);
 * a 5xx, a timeout or a DNS failure is transient. Only 404/410 closes, and only
 * when TWO checks a moment apart agree — a CDN can 404 a page for one request
 * and serve it the next.
 *
 * LINKEDIN IS NEVER CHECKED. A LinkedIn apply URL says "no longer accepting"
 * only in JS the fetch cannot run, and we do not add load to the account that
 * gets throttled. store.applyLinksToCheck already excludes them; this only ever
 * sees employer / ATS links.
 *
 * GENTLE. Requests to one host are spaced (`HOST_GAP_MS`); the run is capped
 * (`PER_RUN`) so a big backlog drains over days rather than hammering everyone
 * at once, and it shrinks on its own as dead links close.
 *
 * THE CAP ONLY WORKS BECAUSE THE ORDER ROTATES. `store.applyLinksToCheck`
 * hands back the LEAST RECENTLY CHECKED rows, and `onChecked` stamps every row
 * the sweep looks at. Ordered by age instead — as it was until 17 Sep 2026 —
 * the daily 400 re-reads the newest rows for ever and never reaches the rest:
 * 3,440 of 3,840 rows were unreachable, and all 115 dead links a full pass
 * found were outside the window. A cap without a rotation is not a backlog
 * draining slowly, it is a backlog never touched.
 */

export const CONFIRM = 2;              // consecutive 404/410 before closing
export const CONFIRM_GAP_MS = 3_000;   // between the two checks of one link
export const HOST_GAP_MS = 1_200;      // between requests to the same host
export const PER_RUN = 800;            // links checked per run — see the note below
export const TIMEOUT_MS = 20_000;
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/** Only a hard 404/410 is a dead posting. Everything else is "not gone". */
export function deadFromStatus(status) {
  return status === 404 || status === 410;
}

/** The host of a URL, or '' — for per-host pacing. Never throws. */
export function hostOf(url) {
  try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; }
}

/**
 * One HEAD/GET check. Returns { status, dead, note }; never throws, and a
 * network-level failure is 'unknown', never dead.
 */
export async function checkLink(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) return { status: null, dead: false, note: 'no link' };
  try {
    const res = await fetchImpl(String(url), {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA },
    });
    return { status: res.status, dead: deadFromStatus(res.status),
      note: res.status === 404 || res.status === 410 ? `HTTP ${res.status}` : (res.ok ? 'HTTP 200' : `HTTP ${res.status} — not gone (a 403 is a bot block)`) };
  } catch (e) {
    return { status: null, dead: false, note: `unreachable (${e?.name ?? 'error'}) — not gone` };
  }
}

/**
 * Sweep a list of rows ({ job_id, apply_url, company, title }).
 *
 * For each, check the link; on a dead status check a SECOND time after a gap,
 * and only if that also says dead call `onClose(row, note)`. Requests to the
 * same host are spaced by `hostGapMs`. Pure but for the injected `check`,
 * `onClose`, `sleep` — so the whole decision is tested without the network.
 *
 * Returns { checked, closed, alive, unknown, closures: [{job_id, note}] }.
 */
export async function sweepApplyLinks(rows, {
  check = (url) => checkLink(url),
  onClose = () => {},
  onChecked = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  confirm = CONFIRM,
  confirmGapMs = CONFIRM_GAP_MS,
  hostGapMs = HOST_GAP_MS,
  perRun = PER_RUN,
  log = null,
} = {}) {
  const list = (rows ?? []).slice(0, perRun);
  const lastHit = new Map();
  let checked = 0, closed = 0, alive = 0, unknown = 0;
  const closures = [];

  for (const row of list) {
    const host = hostOf(row.apply_url);
    const since = Date.now() - (lastHit.get(host) ?? -Infinity);
    if (host && since < hostGapMs) await sleep(hostGapMs - since);

    let dead = 0, lastNote = '';
    for (let i = 0; i < Math.max(1, confirm); i++) {
      if (i > 0) await sleep(confirmGapMs);
      const r = await check(row.apply_url);
      lastHit.set(host, Date.now());
      lastNote = r.note;
      if (r.dead) dead += 1;
      else break;   // one "not gone" is enough to spare it; no need to re-poll
    }
    checked += 1;
    /* Recorded per row, not once at the end: a run killed half way through
       must not re-check the same rows tomorrow and stall the rotation. */
    onChecked(row);

    if (dead >= Math.max(1, confirm)) {
      closed += 1;
      closures.push({ job_id: row.job_id, note: lastNote });
      onClose(row, lastNote);
      log?.info?.(`Link sweep: ${row.company} — "${row.title}" closed (${lastNote}).`);
    } else if (lastNote.startsWith('HTTP 200')) {
      alive += 1;
    } else {
      unknown += 1;
    }
  }
  return { checked, closed, alive, unknown, closures };
}
