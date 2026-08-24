/**
 * Where the post-queue helper listens, and whether it is up.
 *
 * Shared by src/index.js (which decides how to open the report) and
 * bin/queue-server.js (which is the thing being described), so the port cannot
 * drift between the two.
 *
 * WHY THERE IS A SERVER AT ALL. The run report is a file on disk opened with
 * `open`, so it renders under `file://` — an origin that cannot write to disk,
 * cannot reach SQLite, and cannot start a local model. A button in that page
 * has nowhere to send a click. Serving the very same report over
 * http://127.0.0.1 gives it a same-origin API to talk to and costs one small
 * long-lived process.
 *
 * Same-origin is the security model, and it is deliberate. There are no CORS
 * headers anywhere in the server, so a web page on any other origin cannot read
 * a response from it; the POST routes additionally require a JSON content type
 * and an Origin header that is either absent or this server's own, which is
 * what stops a page elsewhere firing a no-preflight form POST at it. The socket
 * is bound to the loopback address, so nothing off this machine can reach it in
 * the first place.
 */

export const DEFAULT_PORT = 4322;

export function queuePort(cfg = {}) {
  return Number(process.env.QUEUE_PORT || cfg.postQueue?.port || DEFAULT_PORT);
}

export function queueBase(cfg = {}) {
  return `http://127.0.0.1:${queuePort(cfg)}`;
}

/**
 * Is the helper listening?
 *
 * Short timeout on purpose: this is asked in the middle of a scan that has
 * already done the expensive work, and the only consequence of a wrong answer
 * is that the report opens as a file instead of a page.
 */
export async function queueServerUp(cfg = {}, timeoutMs = 1500) {
  try {
    const res = await fetch(`${queueBase(cfg)}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Where to open this run's report.
 *
 * The http URL when the helper is up, so the queue buttons work; otherwise the
 * file path, which still renders the whole report and simply says the queue
 * needs the helper. The report is never withheld because a convenience is down.
 */
export async function reportTarget(runId, filePath, cfg = {}) {
  if (cfg.postQueue?.enabled === false) return filePath;
  if (!(await queueServerUp(cfg))) return filePath;
  return `${queueBase(cfg)}/report/${encodeURIComponent(runId)}`;
}
