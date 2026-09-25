/* ============================================================
   engage.js — the return-visit layer, shared by the board and every
   generated page.

   Loaded by app.js and page.js by injecting a <script> tag, the way owner.js
   is, so neither the board template (published every 30 minutes) nor the
   pages.js head needs an edit. Hand-committed, never in the publish allowlist.

   Two jobs, and both degrade to nothing:

   1. THE CHANNEL PROMPT. The site owns three ways to hear about tomorrow's
      roles — the WhatsApp channel, Telegram and the email digest — and a
      reader who has just pressed Apply is the reader most likely to want
      them. /alerts asks on its own page, which 45 of last week's 1,417
      visitors opened. This asks once, at that moment, as a centred dialog
      the reader has to answer — a channel, or the close button; the backdrop
      does nothing — and then leaves them alone: accepted means never again,
      dismissed means not for a fortnight, and never more than once in a
      session either way. Email is a one-field form inside the dialog that
      posts to /api/subscribe, so no channel costs a second page.

   2. THE COUNTER. Vercel's custom events are not on the Hobby plan, so the
      only way to know whether any of this moves anything is a first-party
      beacon to /api/count — a fixed vocabulary of event names, the region,
      and nothing else. No id, no cookie, no address.

   Storage may be unavailable (private mode): every read and write is wrapped,
   and a page with no storage simply never shows the prompt.
   ============================================================ */
(function () {
  'use strict';

  var NUDGE_KEY = 'interndoor-nudge';
  var SESSION_KEY = 'interndoor-nudge-shown';
  /* A dismissal is respected for a fortnight — long enough that the prompt is
     not the thing a daily reader sees every day, short enough that somebody
     who dismissed it in week one is asked once more once they are a regular. */
  var NUDGE_AGAIN_MS = 14 * 24 * 60 * 60 * 1000;
  /* After the Apply click, not on it. The new tab is opening; the prompt should
     be what is waiting when the reader comes back to this one. */
  var SHOW_DELAY_MS = 700;

  var storage = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  function region() {
    var m = document.querySelector('meta[name="interndoor-region"]');
    return (m && m.content ? String(m.content) : 'xx').toUpperCase();
  }

  /* ---------------- the counter ---------------- */

  /* Fire and forget. sendBeacon survives the page being closed, which is the
     common case right after an Apply click; the fetch fallback carries
     keepalive for the same reason. Nothing here can throw into the page. */
  function count(name) {
    try {
      var body = JSON.stringify({ name: String(name), region: region() });
      if (navigator.sendBeacon && navigator.sendBeacon('/api/count', body)) return;
      fetch('/api/count', { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* a counter must never cost the reader anything */ }
  }

  /* ---------------- the channel prompt ---------------- */

  /**
   * Whether to show the prompt now, given what was stored and the clock.
   * Pure — lifted into test/engage.test.mjs by name.
   */
  function nudgeDue(stored, now) {
    if (!stored) return true;
    var rec;
    try { rec = JSON.parse(stored); } catch (e) { return true; }
    if (!rec || typeof rec !== 'object') return true;
    if (rec.outcome === 'accepted') return false;
    var at = Number(rec.at);
    if (!isFinite(at)) return true;
    return now - at >= NUDGE_AGAIN_MS;
  }

  /**
   * The channels this page knows about, read off the page itself.
   *
   * The board carries the region's WhatsApp, Telegram and Instagram URLs in
   * its Organization JSON-LD `sameAs`, written per region at publish time, so
   * the US board never offers India's channel (the rule src/channels.js
   * states). A generated page carries no sameAs; its channels are read off
   * the region's alerts page (see resolveChannels) and arrive as `extraUrls`.
   * Instagram is left out on purpose — the reels are not an alert feed.
   */
  function channelsFromPage(ldTexts, alertsHref, extraUrls) {
    var out = [];
    var seen = {};
    var push = function (kind, label, url) {
      if (!url || seen[kind]) return;
      seen[kind] = true;
      out.push({ kind: kind, label: label, url: url });
    };
    /* Every candidate — a sameAs entry or a link read off the alerts page —
       passes the same anchored host test. A lookalike host, a path that
       merely contains the host, or plain http is refused whichever way it
       arrived. */
    var consider = function (u) {
      var s = String(u);
      if (/^https:\/\/(www\.)?whatsapp\.com\/channel\//i.test(s)) push('whatsapp', 'WhatsApp', s);
      else if (/^https:\/\/t\.me\//i.test(s)) push('telegram', 'Telegram', s);
    };
    (ldTexts || []).forEach(function (text) {
      var doc;
      try { doc = JSON.parse(text); } catch (e) { return; }
      var nodes = doc && doc['@graph'] ? doc['@graph'] : [doc];
      nodes.forEach(function (n) {
        if (!n || !Array.isArray(n.sameAs)) return;
        n.sameAs.forEach(consider);
      });
    });
    (extraUrls || []).forEach(consider);
    if (alertsHref) push('email', 'Email', alertsHref);
    /* The order is the dialog's, not the source's: WhatsApp leads where it
       exists (it is the lime button), then Telegram, then email. */
    var rank = { whatsapp: 0, telegram: 1, email: 2 };
    out.sort(function (a, b) { return rank[a.kind] - rank[b.kind]; });
    return out;
  }

  var SUBSCRIBE_URL = '/api/subscribe';
  /* How long a generated page waits for its channels before asking with
     email alone. The alerts page is a few KB on the same origin; this is a
     ceiling for a bad connection, not the expected wait. */
  var CHANNELS_FETCH_MS = 2500;

  function ldTexts() {
    return [].slice.call(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(function (s) { return s.textContent || ''; });
  }

  /* The board carries its channels in its own markup. A generated page does
     not — but it links the region's alerts page, which src/channels.js
     renders for exactly this purpose, so the links are read off THAT page:
     one same-origin request, only after an Apply, only where the markup
     said nothing. Any failure degrades to email alone, which is what every
     generated page offered before. */
  var pageChannels = null;
  /* A generated page links the WhatsApp channel itself since 19 Sep 2026 —
     the header pill, the job page's alert box, the outro — so its channels
     can be read off its own anchors before any fetch. Only channel hosts are
     considered; channelsFromPage applies the same anchored test again. */
  function pageChannelLinks() {
    return [].slice.call(document.querySelectorAll('a[href^="https://whatsapp.com/channel/"], a[href^="https://www.whatsapp.com/channel/"], a[href^="https://t.me/"]'))
      .map(function (a) { return a.getAttribute('href'); });
  }
  function resolveChannels() {
    if (pageChannels) return pageChannels;
    var lds = ldTexts();
    var direct = channelsFromPage(lds, SUBSCRIBE_URL, pageChannelLinks());
    if (direct.length > 1) { pageChannels = Promise.resolve(direct); return pageChannels; }
    var alerts = document.querySelector('a[href$="/alerts"]');
    var href = alerts ? alerts.getAttribute('href') : null;
    if (!href || typeof fetch !== 'function' || typeof DOMParser !== 'function') {
      pageChannels = Promise.resolve(direct); return pageChannels;
    }
    var fetched = fetch(href, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        return [].slice.call(doc.querySelectorAll('a.chan[href]')).map(function (a) { return a.getAttribute('href'); });
      })
      .catch(function () { return []; });
    var deadline = new Promise(function (resolve) { setTimeout(function () { resolve([]); }, CHANNELS_FETCH_MS); });
    pageChannels = Promise.race([fetched, deadline]).then(function (urls) {
      return channelsFromPage(lds, SUBSCRIBE_URL, urls);
    });
    return pageChannels;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function remember(outcome) {
    storage.set(NUDGE_KEY, JSON.stringify({ at: Date.now(), outcome: outcome }));
  }

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled])';
  var COPY = {
    whatsapp: { label: 'WhatsApp channel', note: 'Fastest · no signup', tag: 'WA' },
    telegram: { label: 'Telegram', note: 'Channel · no signup', tag: 'TG' },
    email: { label: 'Email', note: 'One digest a day', tag: '@' },
  };

  /* The subline names only the channels this page offers: the US board has
     no WhatsApp and the UK has neither, and naming one that is not on the
     list below would be the first false sentence on the site. */
  function subline(list) {
    var free = list.filter(function (c) { return c.kind !== 'email'; })
      .map(function (c) { return c.kind === 'whatsapp' ? 'WhatsApp' : 'Telegram'; });
    var base = 'Roles are listed here within minutes. Get them where you’ll actually see them';
    return free.length ? base + ', with no signup for ' + free.join(' or ') + '.' : base + '.';
  }

  var open = null; /* { box, veil, keydown, returnTo } while the dialog is up */

  function hide() {
    if (!open) return;
    var o = open; open = null;
    document.removeEventListener('keydown', o.keydown, true);
    document.documentElement.classList.remove('nudge-open');
    o.box.classList.remove('is-up');
    o.veil.classList.remove('is-up');
    setTimeout(function () {
      if (o.box.parentNode) o.box.parentNode.removeChild(o.box);
      if (o.veil.parentNode) o.veil.parentNode.removeChild(o.veil);
    }, 300);
    if (o.returnTo && typeof o.returnTo.focus === 'function') { try { o.returnTo.focus(); } catch (e) { /* gone */ } }
  }

  function dismiss() {
    remember('dismissed');
    count('nudge-dismiss');
    hide();
  }

  /* Tab stays inside the dialog and Escape is the close button. The backdrop
     is deliberately NOT a way out — this is asked once, and the answer is a
     channel or the cross, never a stray click. */
  function keydown(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
    if (e.key !== 'Tab') return;
    var items = [].slice.call(open.box.querySelectorAll(FOCUSABLE)).filter(function (n) { return !n.hidden && n.offsetParent !== null; });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!open.box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  function action(c) {
    var copy = COPY[c.kind];
    var a = el(c.kind === 'email' ? 'button' : 'a', 'nudge-a nudge-' + c.kind);
    var k = el('span', 'nudge-k');
    k.append(el('i', null, copy.tag), document.createTextNode(copy.label));
    a.append(k, el('small', null, copy.note));
    if (c.kind === 'email') {
      a.type = 'button';
    } else {
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  /* The email row: the Email card gives way to one field and one button in
     the same slot. Posts exactly what the signup band posts — the address,
     the board, and the empty honeypot the endpoint expects — and reads the
     endpoint's own words back on failure. */
  function emailForm(c) {
    var form = el('form', 'nudge-form');
    form.hidden = true;
    form.setAttribute('action', c.url);
    form.setAttribute('method', 'post');
    form.noValidate = false;
    var input = el('input');
    input.type = 'email'; input.name = 'email'; input.required = true;
    input.placeholder = 'you@college.edu'; input.autocomplete = 'email';
    input.setAttribute('aria-label', 'Email address');
    var btn = el('button', 'nudge-send', 'Send me the digest');
    btn.type = 'submit';
    var msg = el('p', 'nudge-msg');
    msg.setAttribute('aria-live', 'polite');
    form.append(input, btn, msg);
    var busy = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var email = String(input.value || '').trim();
      if (!email) { input.focus(); return; }
      busy = true; btn.disabled = true;
      var label = btn.textContent; btn.textContent = 'Adding…';
      msg.textContent = ''; msg.className = 'nudge-msg';
      fetch(c.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email, region: region(), company: '' }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok && data.ok, error: data.error }; });
      }).catch(function () {
        return { ok: false, error: 'No connection. Please try again.' };
      }).then(function (r) {
        busy = false; btn.disabled = false; btn.textContent = label;
        if (r.ok) {
          /* The same acknowledgement the signup band gives: the subscriber is
             created as regular, nothing is sent to confirm, so this line is
             the only one the reader gets. */
          msg.textContent = 'Done, you’re on the list. New roles will land in your inbox.';
          msg.className = 'nudge-msg is-good';
          input.disabled = true; btn.hidden = true;
          remember('accepted');
          count('nudge-' + c.kind);
          setTimeout(hide, 1600);
          return;
        }
        msg.textContent = r.error || 'Could not add you just now. Please try again.';
        msg.className = 'nudge-msg is-bad';
      });
    });
    return form;
  }

  function show(list) {
    if (open || document.querySelector('.nudge')) return;
    if (!list || !list.length) return;

    var veil = el('div', 'nudge-veil');
    var box = el('aside', 'nudge');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'nudge-h');

    var x = el('button', 'nudge-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Not now');
    x.textContent = '×';
    x.addEventListener('click', dismiss);
    box.append(x);

    var h = el('h2', 'nudge-h');
    h.id = 'nudge-h';
    h.append(document.createTextNode('Next time, '), el('em', null, 'beat the queue.'));
    box.append(h, el('p', 'nudge-p', subline(list)));

    var acts = el('div', 'nudge-acts');
    /* One action. Where the page offers a channel the email card steps back to
       a text line under it — three equal cards read as a choice to make, and
       the counter says only the channel converts. */
    var hasChannel = list.some(function (c) { return c.kind !== 'email'; });
    list.forEach(function (c) {
      var a = action(c);
      if (c.kind === 'email') {
        if (hasChannel) {
          a.classList.add('is-minor');
          a.querySelector('.nudge-k').lastChild.textContent = 'Or one email a day';
        }
        var form = emailForm(c);
        a.addEventListener('click', function () {
          a.hidden = true;
          form.hidden = false;
          form.querySelector('input').focus();
        });
        acts.append(a, form);
        return;
      }
      a.addEventListener('click', function () {
        remember('accepted');
        count('nudge-' + c.kind);
        hide();
      });
      acts.append(a);
    });
    box.append(acts);

    open = { box: box, veil: veil, keydown: keydown, returnTo: document.activeElement };
    document.body.append(veil, box);
    document.documentElement.classList.add('nudge-open');
    document.addEventListener('keydown', keydown, true);
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* fine */ }
    count('nudge-shown');
    /* Commit the "down" state before "up", the same flush the toast uses, or
       the two style changes coalesce and the sheet just appears. */
    void box.offsetWidth;
    veil.classList.add('is-up');
    box.classList.add('is-up');
    var first = box.querySelector('.nudge-a');
    if (first) first.focus();
  }

  /** Called by the board and the job page on every Apply click. */
  function onApply() {
    count('apply');
    var shownThisSession = false;
    try { shownThisSession = sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { /* fine */ }
    if (shownThisSession) return;
    if (!nudgeDue(storage.get(NUDGE_KEY), Date.now())) return;
    /* The channels resolve while the delay runs, so a page that already knows
       them waits exactly SHOW_DELAY_MS and one that has to ask waits no
       longer than it must. */
    var started = Date.now();
    resolveChannels().then(function (list) {
      var wait = Math.max(0, SHOW_DELAY_MS - (Date.now() - started));
      setTimeout(function () { show(list); }, wait);
    });
  }

  /* The board decides whether this is a first or a return visit and how many
     roles are new since the last one BEFORE this file loads (it must render
     without waiting for a network fetch), and leaves the answer on <html>.
     The count is sent from here so there is exactly one sender. */
  function reportVisit() {
    var d = document.documentElement.dataset;
    if (d.visit === 'new' || d.visit === 'return') count('visit-' + d.visit);
    if (Number(d.newsince) > 0) count('newsince-shown');
  }

  window.IDEngage = { count: count, onApply: onApply, nudgeDue: nudgeDue, channelsFromPage: channelsFromPage };
  reportVisit();
}());
