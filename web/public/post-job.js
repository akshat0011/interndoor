/* ============================================================
   /post-a-job — the employer form, sent to /api/post-job.

   THE FORM SHIPS `hidden` AND THIS REVEALS IT, the feedback box's
   rule: the form has no action, so without this script a submit
   would go nowhere a person could read. A reader with no script
   sees the page's own email fallback instead of a dead control.

   The server decides. The checks here only catch what is plainly
   missing or malformed before a request is spent, and they are
   looser than the endpoint's (a bare "razorpay.com" is a website
   here and there). Anything the endpoint refuses comes back in its
   own words (subscribe.js's rule) and is pinned to the field it is
   about, so the employer sees where to look.

   Hand-committed, NOT in publish.js's PUBLISHED allowlist, like
   every other script on the site.
   ============================================================ */
(function postJob() {
  var form = document.getElementById('pj-form');
  if (!form) return;
  var msg = form.querySelector('.pj-msg');
  var btn = form.querySelector('.pj-send');
  var label = form.querySelector('.pj-send-t');
  var done = document.getElementById('pj-done');
  var busy = false;

  form.hidden = false;
  var off = document.getElementById('pj-noscript');
  if (off) off.hidden = true;

  function say(text, kind) {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  /* A web address as an employer types it: with or without https://,
     a real host with a dot in it. */
  function looksLikeUrl(v) {
    if (!v) return false;
    try {
      var u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v);
      return /^https?:$/.test(u.protocol) && u.hostname.indexOf('.') > 0;
    } catch (e) {
      return false;
    }
  }

  var CHECKS = {
    company: function (v) { return v.length >= 2 ? '' : 'Enter your company’s name.'; },
    website: function (v) { return looksLikeUrl(v) ? '' : 'Enter your company’s website, like https://yourcompany.com.'; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Enter your work email, like you@yourcompany.com.'; },
    link: function (v) { return looksLikeUrl(v) ? '' : 'Enter the full link to the role.'; },
    pay: function (v) {
      var n = v.replace(/[₹,\s]/g, '');
      if (!n) return 'InternDoor lists paid roles only. Enter the stipend or salary in rupees.';
      if (!/^\d+$/.test(n) || Number(n) <= 0) return 'Enter the pay as a whole number of rupees.';
      return '';
    },
  };

  function el(name) { return form.elements[name]; }

  function setError(name, text) {
    var input = el(name);
    var line = document.getElementById('pj-' + name + '-e');
    if (!input) return;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (line) line.textContent = text || '';
  }

  function check(name) {
    var input = el(name);
    var text = CHECKS[name](String(input.value || '').trim());
    setError(name, text);
    return !text;
  }

  /* Inline, as the employer goes: a field is judged when they leave it with
     something in it, and re-judged as they type once it has been flagged, so
     an error clears the moment it is fixed and never appears mid-word. */
  Object.keys(CHECKS).forEach(function (name) {
    var input = el(name);
    if (!input) return;
    input.addEventListener('blur', function () {
      if (String(input.value || '').trim()) check(name);
    });
    input.addEventListener('input', function () {
      if (input.getAttribute('aria-invalid') === 'true') check(name);
    });
  });

  /* The endpoint's refusal names the field it is about in words; this finds
     which one, so the message can sit under it. */
  function fieldFor(text) {
    if (/email|mailbox/i.test(text)) return 'email';
    if (/website/i.test(text)) return 'website';
    if (/link|shortened/i.test(text)) return 'link';
    if (/stipend|salary|rupees|paid roles|per month|per year|figure/i.test(text)) return 'pay';
    if (/company’s name/i.test(text)) return 'company';
    if (/note/i.test(text)) return 'notes';
    return null;
  }

  function setBusy(on) {
    busy = on;
    btn.disabled = on;
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
    form.dataset.state = on ? 'busy' : '';
    if (label) label.textContent = on ? 'Sending…' : 'Submit role';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var first = null;
    Object.keys(CHECKS).forEach(function (name) {
      if (!check(name) && !first) first = el(name);
    });
    if (first) {
      /* The first wrong field gives a short sideways nudge, the way a
         refused password does. Feedback, so it plays once per submit;
         never under reduced motion. */
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var box = first.closest('.pj-f');
      if (!calm && box && box.animate) {
        box.animate([
          { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' },
          { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' },
        ], { duration: 320, easing: 'cubic-bezier(.23, 1, .32, 1)' });
      }
      say('Please check the highlighted field' + (form.querySelectorAll('[aria-invalid="true"]').length > 1 ? 's.' : '.'), 'bad');
      first.focus();
      return;
    }
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = typeof v === 'string' ? v : ''; });
    setBusy(true);
    say('', '');
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
        var name = body.error ? fieldFor(body.error) : null;
        if (name && el(name)) {
          el(name).setAttribute('aria-invalid', 'true');
          el(name).focus();
        }
      });
    }).catch(function () {
      say('That did not send. Check your connection and try again.', 'bad');
    }).then(function () {
      setBusy(false);
    });
  });
})();
