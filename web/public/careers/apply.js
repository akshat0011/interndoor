/**
 * The application form on /careers/software-engineering-intern.
 *
 * AN EXTERNAL FILE, NOT AN INLINE SCRIPT. vercel.json ships
 * `script-src 'self'` plus a fixed list of sha256 hashes and no
 * 'unsafe-inline', so an inline handler here would be silently blocked in
 * production and work perfectly in every local preview — the failure mode this
 * repo has already shipped twice.
 *
 * IT POSTS TO OUR OWN ORIGIN, and it has to: the CSP also carries
 * `form-action 'self'` and `connect-src 'self'`, so a form aimed at Formspree,
 * Google Forms or any other third party would be refused by the browser with
 * nothing visibly wrong on the page.
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

    /* Checked here as well as by the browser: `novalidate` is on the form so
       the messages read in our own voice rather than the browser's, which means
       nothing else is enforcing required-ness. */
    var data = {};
    var missing = null;
    ['name', 'email', 'resume'].forEach(function (k) {
      var el = form.elements[k];
      data[k] = (el.value || '').trim();
      if (!data[k] && !missing) missing = el;
    });
    if (missing) {
      say('Name, email and a link to your CV are needed.', 'bad');
      missing.focus();
      return;
    }
    if (data.email.indexOf('@') < 1) {
      say('That email address does not look right.', 'bad');
      form.elements.email.focus();
      return;
    }
    ['links', 'note'].forEach(function (k) { data[k] = (form.elements[k].value || '').trim(); });

    btn.disabled = true;
    say('Sending…');

    fetch('/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (res.ok) {
        form.reset();
        say(res.d.message || 'Thanks — your application is in. We read every one.', 'good');
        return;
      }
      /* THE ENDPOINT IS ALLOWED TO SAY IT IS NOT TAKING APPLICATIONS YET, and
         when it does, that message is shown verbatim. A form that pretends to
         have filed something it dropped is worse than one that admits it. */
      say(res.d.error || 'That did not send. Please try again in a moment.', 'bad');
    }).catch(function () {
      say('That did not send — check your connection and try again.', 'bad');
    }).then(function () {
      btn.disabled = false;
    });
  });
})();
