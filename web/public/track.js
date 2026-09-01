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
        cur.history = (cur.history || []).concat([{ s: next, at: now }]);
      }
      return write(items);
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
      var added = 0, updated = 0;
      for (var i = 0; i < data.items.length; i++) {
        var row = data.items[i];
        if (!row || !row.id) continue;
        row.id = String(row.id);
        var at = findIndex(items, row.id);
        if (at === -1) { items.push(row); added++; }
        else if ((row.updated || 0) > (items[at].updated || 0)) { items[at] = row; updated++; }
      }
      if (!write(items)) return { ok: false, error: lastError };
      return { ok: true, added: added, updated: updated };
    },

    /** Fires on every local change, and on a change made in another tab. */
    on: function (fn) { listeners.push(fn); },
  };

  /* Two tabs open on the board is ordinary — one to browse, one on the
     tracker. Without this the second tab shows a stale list and overwrites the
     first tab's work on its next write. */
  try {
    window.addEventListener('storage', function (e) { if (e.key === KEY) emit(); });
  } catch (e) { /* no storage events is survivable; the page is just not live */ }

  window.IDTrack = api;
}());
