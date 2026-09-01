/* InternDoor — /applications, the tracker dashboard.
 *
 * Loaded ONLY by this page, not by every generated page: the board and the ~790
 * job pages need `track.js` (the store, so they can mark a role and show a
 * count) and none of them needs the table. src/pages.js adds this script to
 * this page alone.
 *
 * NOT in publish.js's PUBLISHED allowlist — stage it by hand.
 *
 * THE SERVER-RENDERED STATE IS THE EMPTY ONE, and that is deliberate. The table
 * is built here from localStorage, so a crawler and a first-time reader both
 * get the explanation of what the page is rather than an empty grid. The page
 * is noindex for the same reason it has nothing to render: there is no content
 * here that is the same for two people.
 */
(function () {
  'use strict';

  var T = window.IDTrack;
  if (!T) return;

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    // See the note on role="row" in renderTable: the mobile card layout
    // sets `display` on these, which strips their implicit roles.
    if (tag === 'td') n.setAttribute('role', 'cell');
    return n;
  };

  /* This page's own board. Read from the meta tag src/pages.js writes rather
     than parsed out of location.pathname, for the reason app.js gives: a
     rewrite can serve one file from more than one path, and a page that infers
     its identity from the address bar gets it wrong when routing changes.
     Used only to decide whether a row's board is worth labelling. */
  var REGION = (document.querySelector('meta[name="interndoor-region"]') || {}).content || 'IN';

  var filter = 'all';

  function slugPart(s, max) {
    var out = String(s == null ? '' : s)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (max !== Infinity) out = out.slice(0, max);
    return out || 'role';
  }

  /* Mirrors jobPageSlug in src/pages.js, web/public/app.js and page.js.
     test/tracker.test.mjs pins this copy against the others — a drift here
     links a tracked application to a 404. */
  function jobPageSlug(row) {
    return slugPart(row.company, 70) + '-' + slugPart(row.title, 70) + '-' + slugPart(row.id, Infinity);
  }

  /* The InternDoor page for a tracked role, or null.
   *
   * NULL IS A REAL ANSWER AND IS COMMON. Job pages are deleted 30 days after
   * the posting was first seen, so an application from five weeks ago — the one
   * most likely still open on this page — no longer has a page to link to. The
   * row still renders in full from its own snapshot; it simply does not
   * pretend to link somewhere. A dead link on a page somebody is using to
   * chase real applications is worse than no link. */
  function pageHref(row) {
    if (!row.company || !row.title || !row.id) return null;
    // row.path is the board's URL prefix, stored when the role was marked —
    // '' for India, '/us', '/uk'. See the note in track.js's snapshot().
    return (row.path || '') + '/jobs/' + (row.slug || jobPageSlug(row));
  }

  function safeUrl(url) {
    if (!url) return '';
    return /^https:\/\//i.test(url) || /^http:\/\//i.test(url) ? url : '';
  }

  function dayStamp(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** "12 days ago" — how long this application has been sitting. */
  function since(ms) {
    if (!ms) return '';
    var days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    var months = Math.round(days / 30);
    return months === 1 ? 'a month ago' : months + ' months ago';
  }

  /* ---------------- the summary ---------------- */

  function renderSummary(rows) {
    var box = $('trk-sum');
    box.replaceChildren();
    if (!rows.length) { box.hidden = true; return; }
    box.hidden = false;

    var live = 0, interviews = 0, offers = 0;
    for (var i = 0; i < rows.length; i++) {
      var meta = T.statusMeta(rows[i].status);
      if (!meta.done) live++;
      if (rows[i].status === 'interview' || rows[i].status === 'oa') interviews++;
      if (rows[i].status === 'selected') offers++;
    }

    /* Four figures, and "waiting to hear" leads because it is the one somebody
       opens this page to see. The total is second: it is the number that makes
       a slow month look like work rather than like nothing. */
    var tiles = [
      ['waiting to hear', live],
      ['applications', rows.length],
      ['OA or interview', interviews],
      ['offers', offers],
    ];
    for (var t = 0; t < tiles.length; t++) {
      var tile = el('div', 'trk-tile');
      tile.append(el('b', null, String(tiles[t][1])));
      tile.append(el('span', null, tiles[t][0]));
      box.append(tile);
    }
  }

  /* ---------------- the status filter ---------------- */

  function renderTabs(rows) {
    var box = $('trk-tabs');
    box.replaceChildren();
    if (!rows.length) { box.hidden = true; return; }
    box.hidden = false;

    var counts = {};
    for (var i = 0; i < rows.length; i++) {
      counts[rows[i].status] = (counts[rows[i].status] || 0) + 1;
    }

    var opts = [{ id: 'all', label: 'All', n: rows.length }];
    for (var s = 0; s < T.STATUSES.length; s++) {
      var st = T.STATUSES[s];
      /* A chip for a status nobody is at filters to an empty table, which reads
         as a fault. Only statuses actually in the data get one. */
      if (counts[st.id]) opts.push({ id: st.id, label: st.short, n: counts[st.id] });
    }
    // A filter that no longer matches anything would leave the table empty.
    if (filter !== 'all' && !counts[filter]) filter = 'all';

    for (var o = 0; o < opts.length; o++) {
      (function (opt) {
        var b = el('button', 'trk-tab');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(filter === opt.id));
        b.append(document.createTextNode(opt.label));
        b.append(el('b', null, String(opt.n)));
        b.addEventListener('click', function () { filter = opt.id; render(); });
        box.append(b);
      }(opts[o]));
    }
  }

  /* ---------------- the table ---------------- */

  function statusSelect(row) {
    var sel = el('select', 'trk-sel');
    sel.setAttribute('aria-label', 'Status for ' + row.title + ' at ' + row.company);
    var known = false;
    for (var i = 0; i < T.STATUSES.length; i++) {
      var st = T.STATUSES[i];
      var opt = el('option', null, st.label);
      opt.value = st.id;
      if (st.id === row.status) { opt.selected = true; known = true; }
      sel.append(opt);
    }
    /* A status this build does not know can only come from a file exported by a
       newer one. It is offered back as its own option rather than silently
       snapping to Applied, so opening this page cannot rewrite what somebody
       recorded. */
    if (!known) {
      var raw = el('option', null, T.statusMeta(row.status).label);
      raw.value = row.status;
      raw.selected = true;
      sel.append(raw);
    }
    sel.addEventListener('change', function () {
      T.track(row, sel.value);
      render();
    });
    return sel;
  }

  function roleCell(row) {
    var td = el('td', 'trk-role');
    td.append(el('span', 'trk-co', row.company || 'Unknown company'));

    var href = pageHref(row);
    if (href) {
      var a = el('a', 'trk-t', row.title || 'Untitled role');
      a.href = href;
      td.append(a);
    } else {
      td.append(el('span', 'trk-t', row.title || 'Untitled role'));
    }

    var sub = el('span', 'trk-sub');
    if (row.location) sub.append(el('i', null, row.location));
    /* The applied date, repeated here for the narrow layout — the date COLUMN
       is hidden below 760px, where four columns cannot fit without the page
       scrolling sideways. CSS shows exactly one of the two at any width. */
    sub.append(el('i', 'trk-when', 'Applied ' + since(row.at)));
    if (row.region && row.region !== REGION) sub.append(el('i', 'trk-rg', row.region));
    td.append(sub);
    return td;
  }

  function renderTable(rows) {
    var body = $('trk-body');
    var table = $('trk-table');
    var none = $('trk-none');
    body.replaceChildren();

    var shown = rows.filter(function (r) { return filter === 'all' || r.status === filter; });
    table.hidden = !shown.length;
    none.hidden = !!shown.length || !rows.length;

    for (var i = 0; i < shown.length; i++) {
      (function (row) {
        /* EXPLICIT ROLES. Below 760px page.css lays each row out as a card,
           and setting `display` on a table element removes its table
           semantics from the accessibility tree — so a screen reader would
           stop announcing rows and cells at exactly the width most of this
           traffic arrives at. Declaring them keeps the table a table at
           every width. test/tracker.test.mjs pins them. */
        var tr = el('tr');
        tr.setAttribute('role', 'row');
        var meta = T.statusMeta(row.status);
        if (meta.done) tr.className = 'is-done';

        tr.append(roleCell(row));

        /* ONE control, not a pill and a select saying the same word.
           The select already names the status and is how it is changed; the dot
           beside it carries the colour, which is what makes a column of twenty
           rows scannable for "which of these are at interview stage". */
        var stTd = el('td', 'trk-c-st');
        /* The flex lives on a wrapper, NOT on the <td>. `display: flex` on a
           table cell replaces its table-cell display outright, so the browser
           stops sizing it as a column and the control collapses to nothing. */
        var stBox = el('div', 'trk-st');
        var dot = el('i', 'trk-dot' + (meta.good ? ' is-good' : meta.bad ? ' is-bad' : ''));
        dot.setAttribute('aria-hidden', 'true');
        stBox.append(dot);
        stBox.append(statusSelect(row));
        stTd.append(stBox);
        tr.append(stTd);

        var dateTd = el('td', 'trk-c-date');
        var when = el('span', 'trk-date');
        when.append(el('b', null, since(row.at)));
        when.append(el('i', null, dayStamp(row.at)));
        dateTd.append(when);
        tr.append(dateTd);

        var actTd = el('td', 'trk-c-act');
        var applyHref = safeUrl(row.applyUrl) || safeUrl(row.url);
        if (applyHref) {
          var go = el('a', 'trk-go', 'Posting ↗');
          go.href = applyHref;
          go.target = '_blank';
          go.rel = 'noopener noreferrer';
          go.setAttribute('aria-label', 'Open the posting for ' + row.title + ' at ' + row.company);
          actTd.append(go);
        }
        var del = el('button', 'trk-x');
        del.type = 'button';
        del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
          + ' stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        del.setAttribute('aria-label', 'Remove ' + row.title + ' at ' + row.company + ' from the tracker');
        del.addEventListener('click', function () {
          /* Confirmed, because it deletes the only copy. Nothing here is on a
             server, so a mis-click cannot be undone by reloading. */
          if (!confirm('Remove this application from your tracker?\n\n' + row.company + ' — ' + row.title)) return;
          T.remove(row.id);
          render();
        });
        actTd.append(del);
        tr.append(actTd);

        body.append(tr);
      }(shown[i]));
    }
  }

  /* ---------------- backup ---------------- */

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function wireData() {
    $('trk-export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(T.exportData(), null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'interndoor-applications-' + stamp() + '.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    var input = $('trk-file');
    $('trk-import').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var result;
        try { result = T.importData(JSON.parse(String(reader.result))); }
        catch (e) { result = { ok: false, error: 'That file could not be read as JSON.' }; }
        say(result.ok
          ? 'Restored — ' + result.added + ' added, ' + result.updated + ' updated.'
          : result.error, !result.ok);
        input.value = '';
        render();
      };
      reader.onerror = function () { say('That file could not be read.', true); input.value = ''; };
      reader.readAsText(file);
    });
  }

  function say(text, bad) {
    var msg = $('trk-msg');
    msg.textContent = text;
    msg.classList.toggle('is-bad', !!bad);
  }

  /* ---------------- render ---------------- */

  function render() {
    var rows = T.all();

    /* Live rows first, then the closed ones, and most-recently-touched first
       within each. A tracker sorted purely by date buries the interview you
       have on Thursday under six rejections from last week. */
    rows.sort(function (a, b) {
      var da = T.statusMeta(a.status).done ? 1 : 0;
      var db = T.statusMeta(b.status).done ? 1 : 0;
      if (da !== db) return da - db;
      return (b.updated || 0) - (a.updated || 0);
    });

    $('trk-void').hidden = !!rows.length;
    /* Backup and restore stay available with an EMPTY list. Restoring a backup
       onto a new device is precisely the empty case, so hiding the control
       until there is something to back up would hide it exactly when it is
       needed. */
    renderSummary(rows);
    renderTabs(rows);
    renderTable(rows);

    var err = T.error();
    if (err) say(err, true);
  }

  /* Refresh the stored snapshots against the live board, so a tracked role
     picks up a corrected title or a newly-recovered apply URL. Best effort:
     the page is complete without it, because every row already carries its own
     copy of everything it needs to render. */
  (function refresh() {
    /* The board's data file, carried on the page by src/pages.js — the same
       way #fresh carries data-feed on a job page. head() emits an
       interndoor-region meta on every generated page but not a data one, so
       the attribute is where this lives. */
    var feed = ($('trk-root') || {}).dataset && $('trk-root').dataset.feed;
    if (!feed || !T.count()) return;
    fetch(feed, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var jobs = Array.isArray(data) ? data : (data.jobs || data.items || []);
        if (T.refresh(jobs)) render();
      })
      .catch(function () { /* a stale snapshot is still a complete row */ });
  }());

  wireData();
  T.on(render);
  render();
}());
