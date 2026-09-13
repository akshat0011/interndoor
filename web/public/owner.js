/* ============================================================
   Owner controls — write a posting's LinkedIn post, correct it,
   hide it, block its employer.

   LOADED ONLY IN A PAIRED BROWSER. app.js and page.js add this
   script when localStorage holds the pairing token (or the URL
   carries one to store). A visitor never downloads it and never
   makes a request to 127.0.0.1, so nobody but the owner ever sees
   Chrome's "reach apps on this device" prompt.

   Every action is performed by the post-queue helper on his Mac
   (bin/queue-server.js, http://127.0.0.1:4322). This file holds
   no power of its own: without the helper and the token it can
   do nothing, which is why it is safe to serve publicly.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'interndoor-owner';
  var HELPER = 'http://127.0.0.1:4322';
  var token = null;

  try {
    var m = location.hash.match(/^#owner-pair=([a-f0-9]{48})$/);
    if (m) {
      localStorage.setItem(KEY, m[1]);
      // The token must not stay in the address bar, the history or a copied link.
      history.replaceState(null, '', location.pathname + location.search);
    }
    token = localStorage.getItem(KEY);
  } catch (e) { return; }
  if (!token) return;

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/owner.css';
  document.head.appendChild(css);

  /* ---------------- talking to the helper ---------------- */

  function call(path, body) {
    return fetch(HELPER + path, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'x-owner-token': token, 'content-type': 'application/json' }
        : { 'x-owner-token': token },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('the helper answered ' + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error('The helper is not running on this Mac — start it with npm run queue.');
      err.status = 0;
      throw err;
    });
  }

  function explain(err) {
    if (err.status === 401) return 'This browser is not paired any more — open ' + HELPER + '/owner and pair again.';
    return err.message;
  }

  /* ---------------- a small toast ---------------- */

  var toastEl = null;
  function toast(text, link) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'owner-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.replaceChildren(document.createTextNode(text));
    if (link) {
      var a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.text;
      toastEl.appendChild(a);
    }
    toastEl.hidden = false;
  }

  /* Follow a change until it is on the site. The helper publishes after a short
     batching wait; Vercel then takes about a minute to serve it. */
  var PUBLISH_WORDS = {
    waiting: 'Saved. Publishing in a few seconds…',
    publishing: 'Publishing the site…',
    'behind-scan': 'Saved. A scan is running — the change goes live when it publishes.',
    live: 'Published. Live on the site in about a minute.',
    failed: 'Saved, but publishing failed — it will go out with the next scan.',
  };
  function followPublish(startedAt) {
    var tries = 0;
    (function tick() {
      call('/api/owner/status').then(function (s) {
        var p = s.publish || {};
        toast(PUBLISH_WORDS[p.state] || 'Saved.');
        var settled = (p.state === 'live' || p.state === 'failed') && p.at >= startedAt;
        if (!settled && tries++ < 120) setTimeout(tick, 5000);
      }, function (err) { toast(explain(err)); });
    })();
  }

  function followPost() {
    var tries = 0;
    (function tick() {
      call('/api/owner/status').then(function (s) {
        if (s.generating && tries++ < 240) {
          var g = s.generation || {};
          toast('Writing the LinkedIn post' + (g.total ? ' (' + g.done + '/' + g.total + ')' : '') + '…');
          setTimeout(tick, 3000);
          return;
        }
        if (s.generation && s.generation.error) { toast('The post could not be written: ' + s.generation.error); return; }
        toast('Post ready. ', { href: s.postsUrl, text: 'Open the posts page' });
      }, function (err) { toast(explain(err)); });
    })();
  }

  /* ---------------- the edit dialog ---------------- */

  function field(form, name, label, value, placeholder) {
    var wrap = document.createElement('label');
    wrap.className = 'owner-field';
    var span = document.createElement('span');
    span.textContent = label;
    var input = document.createElement('input');
    input.name = name;
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.maxLength = name === 'stipend' ? 80 : 160;
    wrap.appendChild(span);
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  }

  function editDialog(ref, view) {
    var dlg = document.createElement('dialog');
    dlg.className = 'owner-dialog';
    var form = document.createElement('form');
    form.method = 'dialog';
    var h = document.createElement('h2');
    h.textContent = 'Correct this posting';
    form.appendChild(h);
    var note = document.createElement('p');
    note.textContent = 'Leave a field as it was to keep the posting’s own value. Changing the title changes the page address; the old one redirects.';
    form.appendChild(note);

    var o = view.original || {};
    var e = view.edit || {};
    var inputs = {
      title: field(form, 'title', 'Title', e.title || o.title, o.title),
      location: field(form, 'location', 'Location', e.location || o.location, o.location),
      stipend: field(form, 'stipend', 'Pay (as it should read)', e.stipend || o.stipend, o.stipend || 'e.g. ₹25,000 / month'),
    };

    var row = document.createElement('div');
    row.className = 'owner-row';
    function button(text, value, cls) {
      var b = document.createElement('button');
      b.type = 'submit';
      b.value = value;
      b.textContent = text;
      if (cls) b.className = cls;
      row.appendChild(b);
    }
    button('Cancel', 'cancel');
    if (view.edit) button('Revert all', 'revert');
    button('Save', 'save', 'owner-primary');
    form.appendChild(row);
    dlg.appendChild(form);
    document.body.appendChild(dlg);

    dlg.addEventListener('close', function () {
      var choice = dlg.returnValue;
      dlg.remove();
      if (choice !== 'save' && choice !== 'revert') return;
      var body = { jobId: view.id };
      Object.keys(inputs).forEach(function (k) {
        var v = inputs[k].value.trim();
        // Unchanged from the posting's own value, or a revert: clear the override.
        body[k] = choice === 'revert' || v === (o[k] || '') ? '' : v;
      });
      var started = Date.now();
      toast('Saving…');
      call('/api/owner/edit', body).then(function () { followPublish(started); }, function (err) { toast(explain(err)); });
    });
    dlg.showModal();
  }

  /* ---------------- the bar ---------------- */

  function button(bar, text, onClick, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'owner-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  }

  function buildBar(ref) {
    var bar = document.createElement('div');
    bar.className = 'owner-bar';
    bar.setAttribute('data-owner-ref', ref.jobId || ref.path);
    var label = document.createElement('span');
    label.className = 'owner-label';
    label.textContent = 'OWNER';
    bar.appendChild(label);
    var state = document.createElement('span');
    state.className = 'owner-state';
    state.textContent = 'connecting…';
    bar.appendChild(state);

    call('/api/owner/job', ref).then(function (view) {
      state.textContent = view.hidden ? 'hidden from the site' : view.edit ? 'corrected' : '';

      var post = button(bar, 'LinkedIn post', function () {
        call('/api/owner/post', { jobId: view.id }).then(followPost, function (err) { toast(explain(err)); });
        toast('Writing the LinkedIn post…');
      });
      if (!view.postable) { post.disabled = true; post.title = 'This board has no LinkedIn account to post from.'; }

      button(bar, 'Edit', function () { editDialog(ref, view); });

      if (!view.hidden) {
        button(bar, 'Hide', function () {
          var reason = window.prompt('Hide "' + (view.original.title || 'this posting') + '" from the site?\n\nWhy? (optional, kept with the posting)', '');
          if (reason === null) return;
          var started = Date.now();
          toast('Hiding…');
          call('/api/owner/hide', { jobId: view.id, reason: reason }).then(function () {
            state.textContent = 'hidden from the site';
            followPublish(started);
          }, function (err) { toast(explain(err)); });
        }, 'owner-warn');
      }

      button(bar, 'Block employer', function () {
        if (!window.confirm('Block ' + view.company + '?\n\nEvery posting from them comes off the site, they leave the watchlist, and they are blocklisted so they cannot come back.')) return;
        var started = Date.now();
        toast('Blocking ' + view.company + '…');
        call('/api/owner/block', { jobId: view.id }).then(function () {
          state.textContent = 'employer blocked';
          followPublish(started);
        }, function (err) { toast(explain(err)); });
      }, 'owner-danger');
    }, function (err) {
      state.textContent = explain(err);
    });

    button(bar, 'Owner off', function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* nothing stored */ }
      document.querySelectorAll('.owner-bar').forEach(function (b) { b.remove(); });
      toast('Owner controls are off in this browser.');
    }, 'owner-quiet');

    return bar;
  }

  /* The board: the detail pane is rebuilt on every selection, so watch it and
     put a bar back whenever the role shown changes. */
  var detail = document.getElementById('detail');
  if (detail) {
    var sync = function () {
      var id = detail.getAttribute('data-job-id');
      if (!id || detail.hidden) return;
      if (detail.querySelector('.owner-bar[data-owner-ref="' + CSS.escape(id) + '"]')) return;
      var old = detail.querySelector('.owner-bar');
      if (old) old.remove();
      var bar = buildBar({ jobId: id });
      var back = detail.querySelector('.back');
      if (back) back.after(bar); else detail.prepend(bar);
    };
    new MutationObserver(sync).observe(detail, { childList: true, attributes: true, attributeFilter: ['data-job-id', 'hidden'] });
    sync();
  }

  /* A job page: the helper resolves the page's own address to the posting. */
  if (/^\/(?:[a-z]{2}\/)?jobs\/[a-z0-9-]+\/?$/.test(location.pathname)) {
    var crumbs = document.querySelector('main .crumbs');
    var jobBar = buildBar({ path: location.pathname });
    if (crumbs) crumbs.after(jobBar);
    else document.body.prepend(jobBar);
  }
})();
