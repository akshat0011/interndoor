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

  /* Which rows have their notes panel open.
   *
   * HELD ACROSS RENDERS ON PURPOSE. Saving a note writes to the store, the
   * store emits, and render() rebuilds the whole tbody — so without this the
   * panel would slam shut the moment somebody finished typing in it, which
   * reads as the note having been thrown away. */
  var expanded = new Set();

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

  /**
   * How a follow-up date reads, and how urgent it is.
   *
   * Compared as STRINGS. Both sides are 'YYYY-MM-DD', so `<=` is exact for
   * ISO dates and involves no timezone at all — parsing either into a Date
   * would reintroduce the UTC-midnight off-by-one that track.js's setReminder
   * exists to avoid.
   */
  function dueState(row) {
    if (!row.remindAt) return null;
    var today = T.today();
    var done = T.statusMeta(row.status).done;
    if (done) return { cls: 'is-past', text: 'Follow-up ' + humanDate(row.remindAt) };
    if (row.remindAt < today) return { cls: 'is-over', text: 'Overdue — ' + humanDate(row.remindAt) };
    if (row.remindAt === today) return { cls: 'is-now', text: 'Follow up today' };
    return { cls: 'is-soon', text: 'Follow up ' + humanDate(row.remindAt) };
  }

  /** '2026-09-05' -> '5 Sep'. Built from the parts, never through Date. */
  function humanDate(iso) {
    var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p = String(iso).split('-');
    if (p.length !== 3) return String(iso);
    var m = M[Number(p[1]) - 1];
    if (!m) return String(iso);
    return Number(p[2]) + ' ' + m;
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

    var live = 0, interviews = 0, offers = 0, due = 0;
    for (var i = 0; i < rows.length; i++) {
      var meta = T.statusMeta(rows[i].status);
      if (!meta.done) live++;
      if (rows[i].status === 'interview' || rows[i].status === 'oa') interviews++;
      if (rows[i].status === 'selected') offers++;
      if (T.isDue(rows[i])) due++;
    }

    /* "Waiting to hear" leads because it is the one somebody opens this page to
       see. The total is second: it is the number that makes a slow month look
       like work rather than like nothing.

       THE DUE TILE ONLY APPEARS WHEN SOMETHING IS DUE. A permanent "0 to follow
       up" is a tile that is right 90% of the time and therefore never read; one
       that shows up only when it has something to say is the opposite. */
    var tiles = [];
    if (due) tiles.push(['to follow up', due, 'is-due']);
    tiles.push(['waiting to hear', live]);
    tiles.push(['applications', rows.length]);
    tiles.push(['OA or interview', interviews]);
    tiles.push(['offers', offers]);

    for (var t = 0; t < tiles.length; t++) {
      var tile = el('div', 'trk-tile' + (tiles[t][2] ? ' ' + tiles[t][2] : ''));
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
    var due = 0;
    for (var i = 0; i < rows.length; i++) {
      counts[rows[i].status] = (counts[rows[i].status] || 0) + 1;
      if (T.isDue(rows[i])) due++;
    }

    var opts = [{ id: 'all', label: 'All', n: rows.length }];
    // Straight after All, because it is the shortlist somebody came to act on.
    if (due) opts.push({ id: 'due', label: 'To follow up', n: due });
    for (var s = 0; s < T.STATUSES.length; s++) {
      var st = T.STATUSES[s];
      /* A chip for a status nobody is at filters to an empty table, which reads
         as a fault. Only statuses actually in the data get one. */
      if (counts[st.id]) opts.push({ id: st.id, label: st.short, n: counts[st.id] });
    }
    // A filter that no longer matches anything would leave the table empty —
    // including 'due', which empties itself the moment the last one is dealt
    // with, and which is not a status so it cannot be looked up in `counts`.
    if (filter === 'due') { if (!due) filter = 'all'; }
    else if (filter !== 'all' && !counts[filter]) filter = 'all';

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

    /* The follow-up flag sits with the facts, not in a column of its own: most
       rows never carry one, and a fifth column blank on 90% of them would
       teach the eye to skip the whole line. */
    var due = dueState(row);
    if (due) sub.append(el('i', 'trk-due ' + due.cls, due.text));
    td.append(sub);

    // The note, read-only here. Editing is in the panel below the row.
    if (row.note) td.append(el('span', 'trk-note-r', row.note));
    return td;
  }

  /**
   * The notes and follow-up panel, as its own row spanning the table.
   *
   * A ROW RATHER THAN TWO MORE COLUMNS. A textarea and a date input cannot fit
   * beside four existing columns at any width this site supports, and the
   * fields are blank on most applications — putting them in columns would cost
   * every row the space so that a few could use it.
   */
  function notesRow(row) {
    var tr = el('tr', 'trk-more');
    tr.setAttribute('role', 'row');
    var td = el('td');
    td.colSpan = 4;

    var box = el('div', 'trk-more-in');

    var nl = el('label', 'trk-f');
    nl.append(el('span', null, 'Notes'));
    var note = el('textarea', 'trk-note');
    note.rows = 3;
    note.value = row.note || '';
    note.placeholder = 'Recruiter name, referral, what the OA covered…';
    note.setAttribute('aria-label', 'Notes on ' + row.title + ' at ' + row.company);
    /* SAVED ON `change`, WHICH FIRES ON BLUR — never on `input`.
       Every write emits, and every emit rebuilds this tbody, so saving per
       keystroke would tear the textarea out from under the cursor on the first
       character typed. */
    note.addEventListener('change', function () {
      T.setNote(row.id, note.value);
      var err = T.error();
      if (err) say(err, true);
    });
    nl.append(note);
    box.append(nl);

    var dl = el('label', 'trk-f trk-f-date');
    dl.append(el('span', null, 'Follow up on'));
    var date = el('input', 'trk-date-in');
    date.type = 'date';
    date.value = row.remindAt || '';
    date.setAttribute('aria-label', 'Follow-up date for ' + row.title + ' at ' + row.company);
    date.addEventListener('change', function () {
      if (!T.setReminder(row.id, date.value)) {
        // Refused rather than stored: setReminder takes a bare ISO date only.
        say('That date could not be read.', true);
        date.value = T.get(row.id) ? (T.get(row.id).remindAt || '') : '';
        return;
      }
      var err = T.error();
      if (err) say(err, true);
      render();
    });
    dl.append(date);
    /* NOTHING NOTIFIES YOU, and the page has to say so where the control is.
       This is a static site with no account and no server that knows the date
       exists; a field called "reminder" that never reminds is a promise the
       page cannot keep. It flags the row and counts it at the top instead. */
    dl.append(el('span', 'trk-f-hint', 'Flagged here when it arrives. Nothing emails you.'));
    box.append(dl);

    td.append(box);
    tr.append(td);
    return tr;
  }

  function renderTable(rows) {
    var body = $('trk-body');
    var table = $('trk-table');
    var none = $('trk-none');
    body.replaceChildren();

    var shown = rows.filter(function (r) {
      if (filter === 'all') return true;
      if (filter === 'due') return T.isDue(r);
      return r.status === filter;
    });
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
        if (T.isDue(row)) tr.classList.add('is-due');
        // Marks the row whose panel is open, so the read-only copy of the note
        // under the role can hide — the textarea below it is showing the same
        // text, and printing it twice reads as a rendering fault.
        if (expanded.has(row.id)) tr.classList.add('is-open');

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
        /* The notes toggle. Marked when the row already carries something, so
           a note is discoverable without opening every row in turn. */
        var open = expanded.has(row.id);
        var more = el('button', 'trk-more-b' + (row.note || row.remindAt ? ' has' : ''));
        more.type = 'button';
        more.textContent = open ? 'Close' : 'Notes';
        more.setAttribute('aria-expanded', String(open));
        more.setAttribute('aria-label',
          (open ? 'Hide' : 'Show') + ' notes and follow-up for ' + row.title + ' at ' + row.company);
        more.addEventListener('click', function () {
          if (expanded.has(row.id)) expanded.delete(row.id);
          else expanded.add(row.id);
          render();
        });
        actTd.append(more);

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
          // Or the id lingers and the panel springs open by itself if the same
          // role is ever tracked again.
          expanded.delete(row.id);
          render();
        });
        actTd.append(del);
        tr.append(actTd);

        body.append(tr);
        if (open) body.append(notesRow(row));
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

  /* Is the reader typing inside the table right now?
   *
   * NEVER REBUILD UNDER SOMEBODY'S CURSOR. render() runs on any store write —
   * including one made in ANOTHER TAB, which the store broadcasts — and
   * renderTable() calls replaceChildren() on the whole tbody. Mid-sentence in a
   * note that tears the textarea out of the document: the caret vanishes and
   * so does the half-typed sentence, because the node it was typed into is no
   * longer attached. IDTrack.strip has the same guard for the same reason; this
   * is the table's copy, because the table has its own render path.
   */
  var pendingRender = false;
  function editingInTable() {
    var a = document.activeElement;
    /* A TEXTAREA ONLY, and the narrowness is the point. A button, a select or
       the date input has no uncommitted draft to lose — each commits on the
       event that triggers the render in the first place, and deferring for
       them would mean the notes toggle sets a pending render and then returns
       without ever opening the panel. The textarea is the one control here
       holding text the store has not seen yet. */
    return !!a && a.tagName === 'TEXTAREA' && $('trk-body').contains(a);
  }

  /* Once focus leaves the table, do the render that was held back. Deferred a
     tick because focusout fires BEFORE the new activeElement is set, so
     checking immediately would see <body> and run a render while the reader is
     merely moving from the note to the date field beside it. */
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      if (pendingRender && !editingInTable()) render();
    }, 0);
  });

  function render() {
    if (editingInTable()) { pendingRender = true; return; }
    pendingRender = false;
    var rows = T.all();

    /* Anything due first, then live rows, then the closed ones, and
       most-recently-touched first within each band.
       A tracker sorted purely by date buries the interview you have on
       Thursday under six rejections from last week — and a follow-up the
       reader set for today is, by definition, the thing they came to do, so it
       outranks recency rather than competing with it. Among the due ones the
       longest overdue leads. */
    rows.sort(function (a, b) {
      var ra = T.isDue(a) ? 0 : T.statusMeta(a.status).done ? 2 : 1;
      var rb = T.isDue(b) ? 0 : T.statusMeta(b.status).done ? 2 : 1;
      if (ra !== rb) return ra - rb;
      // Both due: the older follow-up date first. ISO strings compare exactly.
      if (ra === 0 && a.remindAt !== b.remindAt) return a.remindAt < b.remindAt ? -1 : 1;
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
