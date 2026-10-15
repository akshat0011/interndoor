/**
 * A finished script must END, even when something it used is still open.
 *
 * Node exits only once nothing holds the event loop. A socket left open, a
 * browser launch that died half way, a timer nobody cleared: any of them keeps
 * the process alive after its work is done. bin/run.sh runs every step one
 * after another and bin/loop.sh waits for run.sh, so one process that never
 * ends stops every later scan. On 16 Oct 2026 the scan finished at 00:40 IST
 * (lock cleared, run recorded ok), WhatsApp had failed to launch on a dead
 * network, and the process sat at 0 CPU with no sockets until it was killed
 * by hand 14 minutes later. The link sweep did the same for five hours on
 * 5 Oct.
 *
 * Call this once the work is done. The timer is unref'd, so a clean process
 * still exits the moment it is idle, exactly as before; only a process that is
 * still alive after the grace period is ended, with the exit code it already
 * set (75 must reach bin/loop.sh unchanged). The grace leaves room for
 * anything legitimately still finishing.
 */

export const EXIT_GRACE_MS = 30_000;

export function forceExitSoon({
  graceMs = EXIT_GRACE_MS,
  say = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const timer = setTimeout(() => {
    say(`Still running ${Math.round(graceMs / 1000)}s after finishing — something was left open; exiting with code ${process.exitCode ?? 0}.`);
    process.exit();
  }, graceMs);
  timer.unref();
  return timer;
}
