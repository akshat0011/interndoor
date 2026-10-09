/* ============================================================
   /post-a-job — the employer form, sent to /api/post-job.

   THE FORM SHIPS `hidden` AND THIS REVEALS IT, the feedback box's
   rule: the form has no action, so without this script a submit
   would go nowhere a person could read. A reader with no script
   sees the page's own email fallback instead of a dead control.

   The messages shown are the SERVER'S (subscribe.js's rule) —
   written for people, and one wording to keep. Only the transport
   failure, where there is no server message, is worded here.

   Hand-committed, NOT in publish.js's PUBLISHED allowlist, like
   every other script on the site.
   ============================================================ */
(function postJob() {
  var form = document.getElementById('pj-form');
  if (!form) return;
  var msg = form.querySelector('.pj-msg');
  var btn = form.querySelector('.pj-send');
  var done = document.getElementById('pj-done');
  var busy = false;

  form.hidden = false;
  var off = document.getElementById('pj-noscript');
  if (off) off.hidden = true;

  function say(text, kind) {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = typeof v === 'string' ? v : ''; });
    busy = true;
    btn.disabled = true;
    say('Sending…', 'busy');
    fetch('/api/post-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok && body.ok) {
          form.hidden = true;
          if (done) { done.hidden = false; done.focus(); }
          return;
        }
        say(body.error || 'That did not send. Please try again in a moment.', 'bad');
      });
    }).catch(function () {
      say('That did not send — check your connection and try again.', 'bad');
    }).then(function () {
      busy = false;
      btn.disabled = false;
    });
  });
})();
