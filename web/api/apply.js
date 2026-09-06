/**
 * POST /api/apply
 *
 * Takes an application for InternDoor's own opening at
 * /careers/software-engineering-intern and hands it to wherever applications
 * are actually read. That is the whole endpoint.
 *
 * IT EXISTS BECAUSE OF THE CSP, NOT BECAUSE WE WANTED A BACKEND.
 * -------------------------------------------------------------
 * web/vercel.json ships `form-action 'self'` and `connect-src 'self'`, so the
 * form on that page CANNOT post to Formspree, a Google Form or any other third
 * party — the browser refuses it, and nothing on the page looks wrong. A
 * same-origin endpoint is the only shape a working form can take here. The
 * outbound hop is made from the SERVER, where no CSP applies, so the forwarding
 * target below can be any provider at all.
 *
 * IT STORES NOTHING, DELIBERATELY, for the reason web/api/subscribe.js already
 * gives at length: an application carries a name, an email and a link to
 * someone's CV, which is personal data, and holding it means deletion on
 * request, a retention policy and a lawful basis under both GDPR (the GB board)
 * and the DPDP Act (India). Forwarding to an inbox or a form provider that
 * already does all of that is the right amount of machinery for one opening.
 *
 * IT REFUSES LOUDLY WHEN IT HAS NOWHERE TO SEND, which is the rule the signup
 * endpoint states: "a signup that silently fails is worse than no signup box,
 * because the reader believes they are on the list." An application form is
 * worse again — a student who submits a CV and a covering note has spent real
 * effort and believes a human will read it. With APPLY_FORWARD_URL unset this
 * says so plainly and the page shows that message verbatim. It never returns
 * success over a dropped application.
 *
 * THIS IS THE ONE THING THAT MUST BE SET BEFORE THE ROLE GOES ON LINKEDIN. A
 * live LinkedIn job whose apply link drops applications is a ghost job by
 * LinkedIn's own definition and removable on those grounds, quite apart from
 * what it does to the people who applied.
 */

/**
 * THE ADDRESS RULE IS BORROWED, NOT REWRITTEN, and the first version of this
 * file proves why. It cleaned control characters into spaces and THEN tested
 * for a newline — so `a@b.com\nBcc: x@y.com` arrived as
 * `a@b.com Bcc: x@y.com`, the newline check could never once fire, and the
 * comment above it claimed that check was the one that mattered. A guard that
 * runs after the thing it guards against has been rewritten is not a guard.
 *
 * `normaliseEmail` tests the RAW string, refuses all whitespace rather than
 * only newlines, and insists on exactly one `@` and a sane domain. It is
 * already covered by 26 assertions in test/subscribe.test.mjs, and one rule
 * for one thing is the point — two copies of address validation is two
 * copies that drift.
 */
import { normaliseEmail } from './subscribe.js';

/** Anything that accepts a POST: a Formspree form, a Zapier or Make hook, an
 *  Apps Script web app, or our own later handler. Server-side, so no CSP. */
const FORWARD = process.env.APPLY_FORWARD_URL || '';

/** Said by BOTH paths that mean "there is nowhere to send": nothing configured,
 *  and a target that turns the request away at the door. */
const NOT_LIVE = 'Applications are not switched on yet — please check back shortly.';

/**
 * A target answering one of these is not FAILING, it is not an application
 * endpoint at all — a static host, a deleted form, a placeholder someone set
 * meaning to come back to it. `interndoor.com` itself answers 405, because
 * Vercel refuses POST to a static file.
 *
 * Retrying cannot fix any of them, so "please try again in a moment" is a lie
 * in the same family as returning success: it sends someone who has written a
 * covering note back to a door that is nailed shut, and it will do that for as
 * long as the setting stays wrong. Say the true thing instead — the same thing
 * we say when nothing is configured at all, because it is the same situation.
 */
const REFUSES_POST = new Set([404, 405, 410, 501]);

const MAX = { name: 120, resume: 500, links: 500, note: 1200 };

/** Control characters out, then trim, then cap. */
function clean(value, cap) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, cap);
}

/** Only http(s). A `javascript:` or `data:` CV link is not a CV link. */
function validUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const email = normaliseEmail(body.email);
  const application = {
    name: clean(body.name, MAX.name),
    email: email ?? '',
    resume: clean(body.resume, MAX.resume),
    links: clean(body.links, MAX.links),
    note: clean(body.note, MAX.note),
    role: 'Software Engineering Intern',
  };

  if (!application.name) return res.status(400).json({ error: 'Your name is needed.' });
  if (!email) return res.status(400).json({ error: 'That email address does not look right.' });
  if (!validUrl(application.resume)) return res.status(400).json({ error: 'The CV link needs to be a full https:// address.' });
  if (application.links && !validUrl(application.links)) {
    return res.status(400).json({ error: 'The portfolio link needs to be a full https:// address.' });
  }

  if (!FORWARD) {
    /* Visible, never silent. Nothing personal is logged — the point of storing
       nothing is that this request leaves no trace of the applicant. */
    console.error('apply: APPLY_FORWARD_URL is not set — the application form is live with nowhere to send');
    return res.status(503).json({ error: NOT_LIVE });
  }

  try {
    const upstream = await fetch(FORWARD, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(application),
    });
    if (!upstream.ok) {
      if (REFUSES_POST.has(upstream.status)) {
        /* The URL is a webhook and a webhook is a credential, so the status is
           named and the target never is. */
        console.error(`apply: the APPLY_FORWARD_URL target answered ${upstream.status} — it does not accept applications, so nothing is being delivered; check the setting`);
        return res.status(503).json({ error: NOT_LIVE });
      }
      console.error(`apply: forwarding failed with ${upstream.status}`);
      return res.status(502).json({ error: 'That did not send. Please try again in a moment.' });
    }
    return res.status(200).json({ ok: true, message: 'Thanks — your application is in. We read every one.' });
  } catch (err) {
    console.error(`apply: forwarding threw (${err.name})`);
    return res.status(502).json({ error: 'That did not send. Please try again in a moment.' });
  }
}
