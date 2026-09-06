/**
 * The application form on /careers/software-engineering-intern.
 *
 * RIGHT NOW THIS IS A DUMMY. Submitting sends nothing, stores nothing and
 * navigates to the homepage. That is deliberate and temporary: the role is not
 * being advertised yet and no real applications are wanted while it is tested.
 *
 * TWO THINGS MUST BE UNDONE TOGETHER WHEN IT GOES LIVE, and undoing one alone
 * is the failure worth naming:
 *   1. the `send()` call below, restored to the POST kept beneath it, and
 *   2. `<meta name="robots" content="noindex">` on the job page.
 * A dummy that Google has indexed is a JobPosting whose apply flow goes
 * nowhere, which is the shape that earns a manual action across the whole
 * domain. A live form on a noindex page is merely invisible. So while it is a
 * dummy the page stays noindex, and the day the POST comes back the meta goes.
 *
 * AN EXTERNAL FILE, NOT AN INLINE SCRIPT. vercel.json ships
 * `script-src 'self'` plus a fixed list of sha256 hashes and no
 * 'unsafe-inline', so an inline handler here would be silently blocked in
 * production and work perfectly in every local preview — the failure mode this
 * repo has already shipped twice.
 *
 * THE REAL ENDPOINT IS STILL THERE AND STILL TESTED (`web/api/apply.js`). It
 * has to be same-origin: the CSP also carries `form-action 'self'` and
 * `connect-src 'self'`, so a form aimed at Formspree, Google Forms or any
 * other third party would be refused by the browser with nothing visibly wrong
 * on the page. The form element keeps `method="post" action="/api/apply"` as
 * its no-JavaScript fallback, which answers honestly rather than pretending.
 */
(function () {
  var form = document.getElementById('apply-form');
  var msg = document.getElementById('apply-msg');
  if (!form || !msg) return;

  var btn = form.querySelector('.ap-send');

  function say(text, kind) {
    msg.textContent = text;
    msg.className = 'ap-msg' + (kind ? ' is-' + kind : '');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    /* The checks stay while this is a dummy, so what is being tested is the
       form people will actually meet. `novalidate` is on the form so the
       messages read in our own voice, which means nothing else enforces
       required-ness. */
    var missing = null;
    ['name', 'email', 'resume'].forEach(function (k) {
      var el = form.elements[k];
      if (!(el.value || '').trim() && !missing) missing = el;
    });
    if (missing) {
      say('Name, email and a link to your CV are needed.', 'bad');
      missing.focus();
      return;
    }
    if ((form.elements.email.value || '').indexOf('@') < 1) {
      say('That email address does not look right.', 'bad');
      form.elements.email.focus();
      return;
    }

    btn.disabled = true;

    /* THE DUMMY. A scripted navigation, never a GET form: letting the browser
       submit would put a name, an email address and a CV link into the query
       string, and personal data does not belong in a URL — it lands in history,
       in referers and in every log between here and the server. Nothing is
       read out of the fields here at all. */
    window.location.href = '/';
  });
})();
