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
      visitors opened. This asks once, at that moment, and then leaves them
      alone: accepted means never again, dismissed means not for a fortnight,
      and never more than once in a session either way.

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
   * states). A generated page carries no sameAs; it offers the alerts page it
   * already links in its own footer, which is region-localised the same way.
   * Instagram is left out on purpose — the reels are not an alert feed.
   */
  function channelsFromPage(ldTexts, alertsHref) {
    var out = [];
    var seen = {};
    var push = function (kind, label, url) {
      if (!url || seen[kind]) return;
      seen[kind] = true;
      out.push({ kind: kind, label: label, url: url });
    };
    (ldTexts || []).forEach(function (text) {
      var doc;
      try { doc = JSON.parse(text); } catch (e) { return; }
      var nodes = doc && doc['@graph'] ? doc['@graph'] : [doc];
      nodes.forEach(function (n) {
        if (!n || !Array.isArray(n.sameAs)) return;
        n.sameAs.forEach(function (u) {
          var s = String(u);
          if (/^https:\/\/(www\.)?whatsapp\.com\/channel\//i.test(s)) push('whatsapp', 'WhatsApp', s);
          else if (/^https:\/\/t\.me\//i.test(s)) push('telegram', 'Telegram', s);
        });
      });
    });
    if (alertsHref) push('email', 'Email', alertsHref);
    return out;
  }

  function channels() {
    var lds = [].slice.call(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(function (s) { return s.textContent || ''; });
    var alerts = document.querySelector('a[href$="/alerts"]');
    /* The board has its own signup band; prefer scrolling to it over leaving. */
    var band = document.querySelector('.signup-band');
    return channelsFromPage(lds, band ? '#signup' : (alerts ? alerts.getAttribute('href') : null));
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

  function hide(box) {
    box.classList.remove('is-up');
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 300);
  }

  function show() {
    if (document.querySelector('.nudge')) return;
    var list = channels();
    if (!list.length) return;

    var box = el('aside', 'nudge');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Get new roles as they are listed');

    var text = el('div', 'nudge-t');
    text.append(el('b', null, 'Tomorrow’s roles, the moment they are listed.'));
    text.append(el('span', null, 'Pick where you want them.'));
    box.append(text);

    var acts = el('div', 'nudge-acts');
    list.forEach(function (c) {
      var a = el('a', 'nudge-a nudge-' + c.kind, c.label);
      a.href = c.url;
      if (c.kind !== 'email' || !/^#/.test(c.url)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.addEventListener('click', function (e) {
        remember('accepted');
        count('nudge-' + c.kind);
        if (/^#/.test(c.url)) {
          e.preventDefault();
          var band = document.querySelector('.signup-band');
          if (band) band.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var input = band && band.querySelector('input[type="email"]');
          if (input) setTimeout(function () { input.focus(); }, 400);
        }
        hide(box);
      });
      acts.append(a);
    });
    box.append(acts);

    var x = el('button', 'nudge-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Not now');
    x.textContent = '×';
    x.addEventListener('click', function () {
      remember('dismissed');
      count('nudge-dismiss');
      hide(box);
    });
    box.append(x);

    document.body.append(box);
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* fine */ }
    count('nudge-shown');
    /* Commit the "down" state before "up", the same flush the toast uses, or
       the two style changes coalesce and the sheet just appears. */
    void box.offsetWidth;
    box.classList.add('is-up');
  }

  /** Called by the board and the job page on every Apply click. */
  function onApply() {
    count('apply');
    var shownThisSession = false;
    try { shownThisSession = sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { /* fine */ }
    if (shownThisSession) return;
    if (!nudgeDue(storage.get(NUDGE_KEY), Date.now())) return;
    setTimeout(show, SHOW_DELAY_MS);
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
