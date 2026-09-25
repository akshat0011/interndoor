/* InternDoor — the application tracker's store.
 *
 * Loaded by BOTH the board (app.js, a module) and every generated page
 * (page.js, a classic deferred script), so it is a classic script that hangs
 * one object off window rather than an ES module. Classic `defer` scripts and
 * modules run in document order, so a `<script defer src="/track.js">` placed
 * above them is guaranteed to have executed first.
 *
 * ONE FILE, not a copy per surface. jobPageSlug already exists in three places
 * and needed a test to stop the copies drifting; a store whose shape drifted
 * between the board and a job page would silently write records the tracker
 * cannot read back.
 *
 * NOTE: like app.js, page.js and styles.css this file is NOT in publish.js's
 * PUBLISHED allowlist, so the scheduler never commits it. Stage it by hand.
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage AND NOT AN ACCOUNT
 *
 * This site has no authentication and no user database, deliberately: /api/
 * subscribe stores nothing itself precisely so the project owes nobody a
 * working unsubscribe, a deletion path, or a bounce policy. A tracker with
 * accounts would need all of that plus a password reset, and the site publishes
 * a GB board (GDPR) and an India board (DPDP), so those are real duties rather
 * than a nicety.
 *
 * localStorage keeps the whole feature on the reader's own device: nothing is
 * transmitted, nothing is stored by us, and there is no account to create
 * before a student can use it. The cost is real and must not be hidden — the
 * list does not follow them to another browser or survive clearing site data —
 * which is why export/import exists below and why the page says so in plain
 * words rather than in a footnote.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var KEY = 'interndoor:apps:v1';
  var VERSION = 1;

  /* The statuses, in the order an application actually moves through.
   *
   * `order` is what the tracker sorts and groups by, and it is deliberately NOT
   * the array index: `rejected` and `selected` are both endings and neither
   * follows the other, so they share the last rank and sort together at the
   * foot of the board under "closed".
   *
   * `done` marks an outcome — a row that needs nothing further from the
   * reader. It is what lets the dashboard count "live" applications, which is
   * the number somebody actually wants when they open this page.
   */
  var STATUSES = [
    { id: 'applied', label: 'Applied', short: 'Applied', order: 0 },
    { id: 'review', label: 'Application under review', short: 'Under review', order: 1 },
    { id: 'shortlisted', label: 'Shortlisted', short: 'Shortlisted', order: 2 },
    { id: 'oa', label: 'OA received', short: 'OA', order: 3 },
    { id: 'interview', label: 'Interview scheduled', short: 'Interview', order: 4 },
    { id: 'selected', label: 'Selected', short: 'Selected', order: 5, done: true, good: true },
    { id: 'rejected', label: 'Rejected', short: 'Rejected', order: 5, done: true, bad: true },
  ];

  var BY_ID = {};
  for (var i = 0; i < STATUSES.length; i++) BY_ID[STATUSES[i].id] = STATUSES[i];

  /* An unknown status is KEPT, never rewritten.
   *
   * It can only arrive from a file exported by a newer build of this page, and
   * silently coercing it to "Applied" would overwrite something the reader
   * recorded with something they did not. So it is preserved verbatim and
   * rendered as its own raw text, sorted with the live rows. */
  function statusMeta(id) {
    return BY_ID[id] || { id: id, label: String(id), short: String(id), order: 1, unknown: true };
  }

  var listeners = [];
  var lastError = null;

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* one bad listener must not stop the rest */ }
    }
  }

  function read() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return []; }
    if (!raw) return [];
    var data;
    try { data = JSON.parse(raw); } catch (e) { return []; }
    if (!data || data.v !== VERSION || !Array.isArray(data.items)) return [];
    return data.items.filter(function (r) { return r && r.id; });
  }

  /* A write that fails is REPORTED, never swallowed.
   *
   * localStorage throws on a full quota and in some private-browsing modes, and
   * a tracker that appears to save and does not is worse than no tracker at
   * all — the reader stops keeping their own list because they believe this one
   * is keeping it. Callers surface `lastError`; nothing here fails silently. */
  function write(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VERSION, items: items }));
      lastError = null;
      emit();
      return true;
    } catch (e) {
      lastError = (e && e.name === 'QuotaExceededError')
        ? 'There is no room left in this browser’s storage.'
        : 'This browser is not allowing sites to save data — private windows often block it.';
      emit();
      return false;
    }
  }

  /* What is kept about a job, and why it is a SNAPSHOT rather than an id.
   *
   * Job pages are deleted 30 days after the posting is first seen, and
   * jobs.json only ever carries what is live. Storing an id alone would mean
   * that an application made five weeks ago — exactly the one still waiting on
   * an answer, and the single most important row on this page — renders as a
   * blank line the day its listing ages off the board.
   *
   * So enough to redraw the row is copied in at the moment of tracking. Live
   * data still wins where it exists (refresh() below), so a corrected title or
   * a new apply URL reaches an already-tracked row. */
  function snapshot(job) {
    return {
      id: String(job.id),
      company: job.company || '',
      title: job.title || '',
      location: job.location || '',
      url: job.url || '',
      applyUrl: job.applyUrl || '',
      slug: job.slug || '',
      /* The board this role was on, and that board's URL prefix — '' for
         India, '/us', '/uk'. The PREFIX is stored rather than derived from the
         code, because deriving it would mean the tracker carried its own copy
         of the region→path map that src/regions.js owns, and a fourth copy of
         a mapping is how the three copies of jobPageSlug earned their test.
         Whichever surface marked the role already knew its own prefix. */
      region: job.region || '',
      path: job.path || '',
      postedAt: job.postedAt || null,
    };
  }

  function findIndex(items, id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === String(id)) return i;
    return -1;
  }

  /**
   * Coerce one row from a backup FILE into the shape the rest of this store
   * assumes. Returns null for a row with nothing usable in it.
   *
   * A BACKUP IS UNTRUSTED INPUT. It is a file the reader picked off their own
   * disk, so it can be corrupt, truncated, hand-edited, or written by something
   * else entirely — and until this existed every field went in verbatim. That
   * was not a script-injection risk (everything is rendered with textContent),
   * but it was a data-corruption one: a `history` that arrived as a STRING
   * survived import, and the next status change ran
   * `"not-an-array".concat([{...}])`, permanently turning the row's history
   * into "not-an-array[object Object]". Nothing threw, so nothing said so.
   *
   * Types only. An UNKNOWN STATUS IS STILL KEPT — it is the documented way a
   * backup from a newer build round-trips — this just guarantees it is a string.
   */
  function clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var id = raw.id == null ? '' : String(raw.id);
    if (!id) return null;

    var str = function (v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); };
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };

    var row = {
      id: id,
      company: str(raw.company),
      title: str(raw.title),
      location: str(raw.location),
      url: str(raw.url),
      applyUrl: str(raw.applyUrl),
      slug: str(raw.slug),
      region: str(raw.region),
      path: str(raw.path),
      postedAt: typeof raw.postedAt === 'number' ? raw.postedAt : null,
      status: str(raw.status) || 'applied',
      note: str(raw.note),
      remindAt: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.remindAt)) ? str(raw.remindAt) : '',
      at: num(raw.at),
      updated: num(raw.updated),
    };

    /* A history that is not a list of {s, at} is rebuilt from the status rather
       than dropped: the row is still a real application and losing it entirely
       would be worse than losing when its steps happened. */
    var hist = [];
    if (Array.isArray(raw.history)) {
      for (var i = 0; i < raw.history.length; i++) {
        var h = raw.history[i];
        if (h && typeof h === 'object' && !Array.isArray(h)) {
          hist.push({ s: str(h.s), at: num(h.at) });
        }
      }
    }
    row.history = hist.length ? hist : [{ s: row.status, at: row.at || row.updated }];
    if (!row.at) row.at = row.history[0].at || row.updated;
    return row;
  }

  var api = {
    KEY: KEY,
    STATUSES: STATUSES,
    statusMeta: statusMeta,

    /** Every tracked application, newest first by when it was last touched. */
    all: function () {
      return read().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    },

    get: function (id) {
      var items = read();
      var at = findIndex(items, id);
      return at === -1 ? null : items[at];
    },

    has: function (id) { return findIndex(read(), id) !== -1; },

    count: function () { return read().length; },

    /** Applications still waiting on somebody — the number the page leads with. */
    openCount: function () {
      return read().filter(function (r) { return !statusMeta(r.status).done; }).length;
    },

    /** The last write error, or null. Callers show it; it is never swallowed. */
    error: function () { return lastError; },

    /**
     * Start tracking a job, or move one that is already tracked to `status`.
     *
     * Idempotent on the initial mark: pressing "Applied" twice on a role that
     * is already at Applied does not reset its date or append a second history
     * entry, so a double click cannot rewrite when somebody applied.
     */
    track: function (job, status) {
      var next = status || 'applied';
      var items = read();
      var at = findIndex(items, job.id);
      var now = Date.now();

      if (at === -1) {
        var row = snapshot(job);
        row.status = next;
        row.at = now;
        row.updated = now;
        row.history = [{ s: next, at: now }];
        // The reader's own two fields. Initialised here rather than in
        // snapshot(), which describes the POSTING — these describe nothing the
        // board knows, which is exactly why refresh() cannot touch them.
        row.note = '';
        row.remindAt = '';
        items.push(row);
      } else {
        var cur = items[at];
        if (cur.status === next) return true;
        cur.status = next;
        cur.updated = now;
        /* THE HISTORY IS THE POINT, and it cannot be reconstructed later.
         *
         * "I applied three weeks ago and heard nothing" and "the OA came two
         * days after applying" are the two things a tracker is actually for,
         * and a single current-status field answers neither. Appending costs a
         * few bytes; recovering it after the fact is impossible. */
        cur.history = (Array.isArray(cur.history) ? cur.history : [])
          .concat([{ s: next, at: now }]);
      }
      return write(items);
    },

    /**
     * A free-text note on one application.
     *
     * NOT part of the status history — that records what happened to the
     * application, and an edited note is not an event. `updated` does move, so
     * the row sorts as recently touched and wins an import merge against an
     * older copy of itself.
     *
     * Stored verbatim and rendered with textContent everywhere, never innerHTML.
     */
    setNote: function (id, text) {
      var items = read();
      var at = findIndex(items, id);
      if (at === -1) return false;
      var next = String(text == null ? '' : text);
      if (items[at].note === next) return true;   // a blur with no edit
      items[at].note = next;
      items[at].updated = Date.now();
      return write(items);
    },

    /**
     * The follow-up date, as a plain 'YYYY-MM-DD' string.
     *
     * A DATE, NOT A TIMESTAMP, and the distinction is the whole reason this is
     * not stored in milliseconds. `new Date('2026-09-05')` parses as UTC
     * midnight, so west of Greenwich it renders as the 4th — an off-by-one that
     * would show somebody a follow-up a day early on the US board and be
     * invisible while testing from India. Kept as the string an
     * `<input type="date">` already produces and compared lexicographically
     * against today's, which is exact for ISO dates and touches no timezone at
     * all.
     *
     * '' clears it.
     */
    setReminder: function (id, date) {
      var items = read();
      var at = findIndex(items, id);
      if (at === -1) return false;
      var next = String(date == null ? '' : date);
      // Anything that is not a bare ISO date is refused rather than stored, or
      // the lexicographic comparison below silently stops meaning anything.
      if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) return false;
      if (items[at].remindAt === next) return true;
      items[at].remindAt = next;
      items[at].updated = Date.now();
      return write(items);
    },

    /** Today, in the reader's own timezone, as 'YYYY-MM-DD'. */
    today: function () {
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },

    /**
     * Is this row asking for something today?
     *
     * A follow-up on a CLOSED application is not due — it is a leftover from
     * before the rejection came in, and flagging it would send somebody to
     * chase an answer they already have.
     */
    isDue: function (row) {
      if (!row || !row.remindAt) return false;
      if (statusMeta(row.status).done) return false;
      return row.remindAt <= api.today();
    },

    /** How many open applications are due a follow-up today or are overdue. */
    dueCount: function () {
      return read().filter(function (r) { return api.isDue(r); }).length;
    },

    remove: function (id) {
      var items = read();
      var at = findIndex(items, id);
      if (at === -1) return true;
      items.splice(at, 1);
      return write(items);
    },

    /**
     * Refresh the stored snapshots from live board data.
     *
     * Only fields that describe the POSTING are updated, never the status, the
     * dates or the history — those are the reader's, not the board's. A row
     * whose job has aged off the board is left exactly as it was.
     */
    refresh: function (jobs) {
      var byId = {};
      for (var i = 0; i < jobs.length; i++) byId[String(jobs[i].id)] = jobs[i];
      var items = read();
      var changed = false;
      for (var j = 0; j < items.length; j++) {
        var live = byId[items[j].id];
        if (!live) continue;
        var fresh = snapshot(live);
        for (var k in fresh) {
          if (!Object.prototype.hasOwnProperty.call(fresh, k)) continue;
          if (fresh[k] && items[j][k] !== fresh[k]) { items[j][k] = fresh[k]; changed = true; }
        }
      }
      if (changed) write(items);
      return changed;
    },

    /** Everything, as the object an export file contains. */
    exportData: function () {
      return { v: VERSION, exportedAt: Date.now(), items: read() };
    },

    /**
     * Merge an exported file back in.
     *
     * MERGE, NOT REPLACE, and the newer `updated` wins per row. Importing a
     * backup onto a device that has since tracked more roles must not throw the
     * newer ones away — that is a data loss the reader cannot undo and would
     * not expect from something called "restore".
     */
    importData: function (data) {
      if (!data || data.v !== VERSION || !Array.isArray(data.items)) {
        return { ok: false, error: 'That file is not an InternDoor backup.' };
      }
      var items = read();
      var added = 0, updated = 0, skipped = 0;
      for (var i = 0; i < data.items.length; i++) {
        var row = clean(data.items[i]);
        if (!row) { skipped++; continue; }
        var at = findIndex(items, row.id);
        if (at === -1) { items.push(row); added++; }
        else if (row.updated > (items[at].updated || 0)) { items[at] = row; updated++; }
      }
      if (!write(items)) return { ok: false, error: lastError };
      return { ok: true, added: added, updated: updated, skipped: skipped };
    },

    /** Fires on every local change, and on a change made in another tab. */
    on: function (fn) { listeners.push(fn); },

    /**
     * The status strip: one control, rendered identically wherever a single
     * role is on screen — the board's detail pane and a job page's side rail.
     *
     * IT LIVES IN THE STORE'S FILE because the alternative was a third copy.
     * app.js and page.js were already carrying the same forty lines of select,
     * link and remove button; adding notes and a follow-up date to both would
     * have made it ninety, in two files that cannot import from each other.
     * jobPageSlug already needed a test to stop three copies drifting. This is
     * the tracker's own control, and track.js is the only file every surface
     * that shows it already loads.
     *
     * Returns an element with a `repaint()` on it. It does NOT subscribe to the
     * store itself: the pane rebuilds this element on every role selection, so
     * a self-registered listener would leak one dead closure per click and
     * every one of them would fire on every later change. The caller owns the
     * subscription it already has.
     */
    strip: function (job, opts) {
      var o = opts || {};
      var root = document.createElement('div');
      root.className = o.className || 'trk-bar';

      var el = function (tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      function paint() {
        /* NEVER REDRAW UNDER SOMEBODY'S CURSOR. A repaint is triggered by any
           store write, including one from another tab, and blowing away a
           textarea mid-sentence would look exactly like the note being lost. */
        if (root.contains(document.activeElement) && document.activeElement !== document.body) return;

        var row = api.get(job.id);
        root.replaceChildren();
        root.classList.toggle('is-on', !!row);

        if (!row) {
          var add = el('button', 'trk-add', o.addLabel || 'Track this application');
          add.type = 'button';
          add.addEventListener('click', function () {
            api.track(job, 'applied');
            paint();
            if (o.onChange) o.onChange();
          });
          root.append(add);
          root.append(el('p', 'trk-hint',
            'Kept on this device only. No account, nothing sent to us.'));
          return;
        }

        var lab = el('label', 'trk-lab');
        lab.append(el('span', null, 'Status'));
        var sel = el('select', 'trk-sel');
        sel.setAttribute('aria-label', 'Application status for ' + job.title + ' at ' + job.company);
        var known = false;
        for (var i = 0; i < STATUSES.length; i++) {
          var opt = el('option', null, STATUSES[i].label);
          opt.value = STATUSES[i].id;
          if (STATUSES[i].id === row.status) { opt.selected = true; known = true; }
          sel.append(opt);
        }
        /* A status this build does not know can only have come from a backup
           written by a newer one. Offered back rather than snapped to Applied,
           so merely opening a page cannot rewrite what the reader recorded. */
        if (!known) {
          var raw = el('option', null, statusMeta(row.status).label);
          raw.value = row.status;
          raw.selected = true;
          sel.append(raw);
        }
        sel.addEventListener('change', function () {
          api.track(job, sel.value);
          paint();
          if (o.onChange) o.onChange();
        });
        lab.append(sel);
        root.append(lab);

        var nl = el('label', 'trk-lab');
        nl.append(el('span', null, 'Notes'));
        var note = el('textarea', 'trk-note');
        note.rows = 2;
        note.value = row.note || '';
        note.placeholder = 'Recruiter, referral, what the OA covered…';
        note.setAttribute('aria-label', 'Notes on ' + job.title + ' at ' + job.company);
        /* `change`, which fires on blur — never `input`. Every write emits and
           every emit repaints, so saving per keystroke would tear the textarea
           out from under the cursor on the first character. */
        note.addEventListener('change', function () {
          api.setNote(job.id, note.value);
          if (o.onChange) o.onChange();
        });
        nl.append(note);
        root.append(nl);

        var dl = el('label', 'trk-lab');
        dl.append(el('span', null, 'Follow up on'));
        var date = el('input', 'trk-date-in');
        date.type = 'date';
        date.value = row.remindAt || '';
        date.setAttribute('aria-label', 'Follow-up date for ' + job.title + ' at ' + job.company);
        date.addEventListener('change', function () {
          if (!api.setReminder(job.id, date.value)) {
            var back = api.get(job.id);
            date.value = back ? (back.remindAt || '') : '';
          }
          paint();
          if (o.onChange) o.onChange();
        });
        dl.append(date);
        /* NOTHING NOTIFIES YOU, and the control has to say so. This is a static
           site with no account and no server that knows the date exists; a
           field called "reminder" that never reminds is a promise the page
           cannot keep. It flags the row on the tracker instead. */
        dl.append(el('span', 'trk-f-hint', 'Flagged on your applications page. Nothing emails you.'));
        root.append(dl);

        var acts = el('div', 'trk-bar-acts');
        var open = el('a', 'trk-link', 'All my applications →');
        open.href = o.appsHref || '/applications';
        acts.append(open);

        var drop = el('button', 'trk-drop', 'Remove');
        drop.type = 'button';
        drop.addEventListener('click', function () {
          /* Confirmed: by this point the row can carry a status history and a
             note, and this is the only copy of either. */
          if (!window.confirm('Remove this from your applications?\n\n'
            + job.company + ' — ' + job.title)) return;
          api.remove(job.id);
          paint();
          if (o.onChange) o.onChange();
        });
        acts.append(drop);
        root.append(acts);
      }

      root.repaint = paint;
      paint();
      return root;
    },
  };

  /* Two tabs open on the board is ordinary — one to browse, one on the
     tracker. Without this the second tab shows a stale list and overwrites the
     first tab's work on its next write. */
  try {
    window.addEventListener('storage', function (e) { if (e.key === KEY) emit(); });
  } catch (e) { /* no storage events is survivable; the page is just not live */ }

  window.IDTrack = api;
}());
