/**
 * POST /api/tailor — retired 23 Sep 2026.
 *
 * Resume tailoring now runs entirely in the reader's browser against their own
 * Google AI key (web/public/resumeai.js). Nothing about a resume touches this
 * server any more, which is a stronger promise than the one this endpoint used
 * to make: it held the text in memory for the length of a request, but it held
 * it. Now it never arrives.
 *
 * WHY THIS FILE STILL EXISTS RATHER THAN BEING DELETED. `app.js` is served
 * `max-age=600, stale-while-revalidate=86400` with no `?v=`, so for up to a day
 * after the deploy some readers are still running the build that POSTs here. A
 * deleted route answers 404 with no body, and that client renders the generic
 * "the service is unavailable" — which tells them nothing and invites a retry
 * that can never work. It answers honestly instead, and the old client shows
 * this message verbatim in its error panel.
 *
 * Delete the file once the caching window has long passed and the logs show no
 * traffic on it.
 *
 * The site's own GEMINI_API_KEY is gone from this path deliberately. It was the
 * whole site's free-tier allowance — 200 tailors a day shared by everyone, and
 * a quota nobody could see until it ran out mid-afternoon.
 */

const GONE = {
  error:
    'Resume tailoring now runs in your own browser with your own Google AI key — nothing is sent to InternDoor. '
    + 'Reload this page to pick up the new version (Cmd+Shift+R, or Ctrl+Shift+R on Windows), then add your key in the "AI features" panel.',
};

export default function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }
  /* 410, not 404: the route existed and is deliberately retired. Nothing in the
     request body is read, parsed or logged — a resume arriving here after the
     switch is discarded unexamined, which is the only correct thing to do with
     personal data sent to an endpoint that no longer wants it. */
  return res.status(410).json(GONE);
}
