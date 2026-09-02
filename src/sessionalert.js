/**
 * Tell him the LinkedIn session has died — ON HIS PHONE, and once.
 *
 * guard.js already fires a Mac banner and an alarm the moment it sees the
 * logged-out state. That reached nobody on 2 Sep 2026: the session expired at
 * 04:35 IST and ELEVEN consecutive runs aborted with `Session expired` until
 * 09:35 — five hours of zero LinkedIn collection — while the banners went to a
 * sleeping Mac. The comment on the new-jobs push in src/index.js already says
 * why that is the wrong channel ("a banner on a sleeping Mac is a notification
 * nobody sees"), and a dead session is more urgent than a new listing: nothing
 * at all is collected until a human runs `npm run login`.
 *
 * NOT SCOPED TO THE HOME REGION, deliberately, like every other scraper-health
 * alert. An expired session stops every board at once — it is about the
 * collector, not about a listing.
 *
 * Its own module rather than a function inside src/index.js because THAT FILE
 * EXECUTES ON IMPORT — importing it to test anything runs a full scrape and
 * publish — so a function living there cannot be tested at all.
 */
import { pushToPhone } from './notify.js';
import { log } from './logger.js';

export const SESSION_ALERT_KEY = 'session_alert_at';

/**
 * Six hours between pushes for one continuous outage.
 *
 * THE THROTTLE IS THE POINT. The failure repeats on every 30-minute tick, so
 * the 2 Sep outage would have sent eleven identical pushes — which is how an
 * alert stops being read. Six hours is long enough that a night-time outage
 * does not buzz repeatedly, and short enough that a single missed push is not
 * the only one he gets.
 */
export const SESSION_ALERT_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * @param store            anything with getSetting/setSetting
 * @param healthy          the run collected something, so the session works
 * @param sessionExpired   the run aborted specifically on a logged-out session
 * @param enabled          notifications.onError
 * @param push             injected for tests; defaults to the real ntfy push
 * @param now              injected for tests
 * @returns {Promise<'sent'|'throttled'|'rearmed'|'skipped'>}
 */
export async function alertOnSessionLoss(store, {
  healthy = false, sessionExpired = false, enabled = true,
  push = pushToPhone, now = Date.now,
} = {}) {
  try {
    /* A run that got as far as collecting proves the session works again, so
       the marker is cleared and the NEXT outage alerts immediately rather than
       waiting out a stale six-hour window. */
    if (healthy) {
      if (store.getSetting(SESSION_ALERT_KEY)) {
        store.setSetting(SESSION_ALERT_KEY, '');
        log.info('LinkedIn session is healthy again — session alert re-armed.');
        return 'rearmed';
      }
      return 'skipped';
    }

    if (!sessionExpired || !enabled) return 'skipped';

    const last = Number(store.getSetting(SESSION_ALERT_KEY) || 0);
    const since = now() - last;
    if (last && since < SESSION_ALERT_GAP_MS) {
      log.info(`LinkedIn session still expired — already alerted ${Math.round(since / 60000)} min ago.`);
      return 'throttled';
    }
    store.setSetting(SESSION_ALERT_KEY, now());

    /* priority 5 and rotating_light: ntfy breaks a 5 through a silent phone,
       and this is the one alert that warrants it — every board has stopped. */
    const sent = await push(
      'InternDoor: LinkedIn session expired',
      'Collection has stopped on every board. Run `npm run login` on the Mac to sign in again.',
      { tags: ['rotating_light'], priority: 5 },
    );
    log.error(sent
      ? 'LinkedIn session expired — pushed to phone. Run `npm run login`.'
      : 'LinkedIn session expired and the phone push did not send. Run `npm run login`.');
    return 'sent';
  } catch (err) {
    // An alert that throws must never change how a run is recorded.
    log.warn(`Session alert failed (${err.message.split('\n')[0]}) — the run is unaffected.`);
    return 'skipped';
  }
}
