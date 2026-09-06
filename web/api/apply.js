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

/** Anything that accepts a POST: a Formspree form, a Zapier or Make hook, an
 *  Apps Script web app, or our own later handler. Server-side, so no CSP. */
const FORWARD = process.env.APPLY_FORWARD_URL || '';

const MAX = { name: 120, email: 160, resume: 500, links: 500, note: 1200 };

/** Control characters out, then trim, then cap. */
function clean(value, cap) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, cap);
}

/**
 * Deliberately permissive, like the signup endpoint's: clever address regexes
 * refuse real addresses. The check that matters is the newline, which is how a
 * field becomes extra headers wherever this is forwarded.
 */
function validEmail(value) {
  return value.length > 2 && value.indexOf('@') > 0 && !/[\r\n]/.test(value);
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
  const application = {
    name: clean(body.name, MAX.name),
    email: clean(body.email, MAX.email),
    resume: clean(body.resume, MAX.resume),
    links: clean(body.links, MAX.links),
    note: clean(body.note, MAX.note),
    role: 'Software Engineering Intern',
  };

  if (!application.name) return res.status(400).json({ error: 'Your name is needed.' });
  if (!validEmail(application.email)) return res.status(400).json({ error: 'That email address does not look right.' });
  if (!validUrl(application.resume)) return res.status(400).json({ error: 'The CV link needs to be a full https:// address.' });
  if (application.links && !validUrl(application.links)) {
    return res.status(400).json({ error: 'The portfolio link needs to be a full https:// address.' });
  }

  if (!FORWARD) {
    /* Visible, never silent. Nothing personal is logged — the point of storing
       nothing is that this request leaves no trace of the applicant. */
    console.error('apply: APPLY_FORWARD_URL is not set — the application form is live with nowhere to send');
    return res.status(503).json({
      error: 'Applications are not switched on yet — please check back shortly.',
    });
  }

  try {
    const upstream = await fetch(FORWARD, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(application),
    });
    if (!upstream.ok) {
      console.error(`apply: forwarding failed with ${upstream.status}`);
      return res.status(502).json({ error: 'That did not send. Please try again in a moment.' });
    }
    return res.status(200).json({ ok: true, message: 'Thanks — your application is in. We read every one.' });
  } catch (err) {
    console.error(`apply: forwarding threw (${err.name})`);
    return res.status(502).json({ error: 'That did not send. Please try again in a moment.' });
  }
}
