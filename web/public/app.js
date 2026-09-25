/* InternDoor — listings browser + resume tailoring */

// pdf.js is served from this origin, not a CDN.
//
// It runs on the one page where students hand over a resume, and the site
// promises that file never leaves their device. A script fetched from someone
// else's server at page load is the one thing that could quietly break that
// promise: whoever controls that host controls code running next to the file.
// Vendored at 4.6.82, verified byte-identical to the CDN copy at the time.
/**
 * Which board this page is, and where its data lives.
 *
 * Read from the meta tags src/pages.js writes into the head rather than parsed
 * out of location.pathname. The region IS in the URL, but a Vercel rewrite can
 * serve one file from more than one path, and a page that infers its identity
 * from the address bar gets it wrong the moment routing changes. The document
 * states what it is.
 *
 * Both fall back to India at the root, so an older cached index.html with no
 * meta tags behaves exactly as it did before.
 */
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
// The gradkite-/internzo- names are what these tags were called under the two
// previous brands. Read as fallbacks so this script still resolves its region
// against an older cached index.html. src/pages.js no longer EMITS them — a new
// origin cannot serve a stale script, so nothing needs the alias — but the read
// side is kept because it costs two || branches and fails silently if dropped.
const REGION = meta('interndoor-region') || meta('gradkite-region') || meta('internzo-region') || 'IN';

/**
 * Remember which board this reader CHOSE, for the edge redirect.
 *
 * `web/vercel.json` sends a US or GB visitor from the apex to their own board
 * while this cookie is absent. It records a CHOICE, so it is written only when
 * the reader picks a region from the switcher — never on an ordinary page view.
 *
 * WRITING IT ON EVERY VIEW IS WHAT BROKE THIS, and it broke it completely. The
 * first version read the page's own region meta and set the cookie on load, so
 * the first India page anyone opened — a job page off Google, a link from
 * Telegram, the apex itself — pinned them to India for a year and the nudge
 * never fired again. A US reader typing interndoor.com landed on the India
 * board with no way out short of clearing cookies. The redirect was correct the
 * whole time; this line was disarming it.
 *
 * THE NAME CHANGED WITH THE FIX (`board` -> `boardpick`) ON PURPOSE. Dropping
 * the write does not clear a cookie already set, and the old one carries a
 * one-year max-age — every reader who had ever loaded the site would have gone
 * on being suppressed for another year. A new name makes all of them inert at
 * once. `web/vercel.json`'s `missing` rule reads the new name; the two must be
 * changed together or the redirect fires for a reader who did choose.
 */
document.addEventListener('click', function (e) {
  var opt = e.target && e.target.closest && e.target.closest('.rg-opt[data-region]');
  if (!opt) return;
  try {
    document.cookie = 'boardpick=' + opt.getAttribute('data-region')
      + ';path=/;max-age=31536000;samesite=lax';
  } catch (err) { /* a blocked cookie just means the reader is nudged again */ }
});
const DATA_URL = meta('interndoor-data') || meta('gradkite-data') || meta('internzo-data') || '/data/jobs.json';
/** '' for India, '/us' and so on for the rest — the prefix every internal link needs. */
const REGION_PATH = DATA_URL.replace(/\/data\/jobs\.json$/, '');

/* The resume AI, and the skill vocabulary the local ranker scores with.
 *
 * A STATIC IMPORT, so a cached app.js and a fresh resumeai.js can never be half
 * applied: if the module is missing the board does not boot at all, which is
 * loud, rather than silently ranking with no aliases, which is not. Both files
 * are hand-committed and ship in one commit for the same reason §5 gives —
 * the scheduler pushes index.html on its own timer and would otherwise carry
 * half a change. */
import {
  resumeNames, shortlist, rankWithAI, tailorWithAI,
  getKey, setKey, forgetKey, hasKey, looksLikeKey, RANK_BATCH,
} from './resumeai.js';

const PDFJS_BASE = '/vendor/pdfjs';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HOT_MS = 60 * 60 * 1000;      // "just posted"
const FRESH_MS = 24 * 60 * 60 * 1000; // "new"

/* The width at or below which the detail pane is a full-screen overlay rather
   than a sticky right-hand column. IT IS A COPY OF THE MEDIA QUERY IN
   styles.css THAT OWNS .pane-col, and the two must not drift — see the note in
   selectJob for what happened when they did. Pinned by
   test/breakpoint.test.mjs, which reads the number out of both files. */
const PANE_OVERLAY_MAX_PX = 1024;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  jobs: [],
  // Which tab is showing: 'intern' or 'fulltime'. Internships are the default
  // because that is what this site is for; full-time is US campus hiring —
  // "New Grad", "Early Career" — which is aimed at the same people but is not
  // an internship and must not be presented as one.
  kind: 'intern',
  // Which shelf inside the tab: 'software' | 'hardware' | 'misc' (publish
  // writes `category` on every row — src/rolefocus.js). Software is the
  // default because it is what the board is for; Misc holds the core
  // engineering, research, IT and design roles he chose to keep on the site
  // but not lead with (25 Sep 2026).
  cat: 'software',
  filtered: [],
  // roleKey -> every posting of that role currently on screen, so the detail
  // pane can list a collapsed card's other cities. Rebuilt by renderList.
  groups: new Map(),
  selectedId: null,
  resumeText: '',
  // What the resume screen calls it: the file name, or "Pasted text".
  resumeLabel: '',
  tailored: null,
  generatedAt: null,
  // The high-water mark of the reader's PREVIOUS visit, or null on a first
  // visit. A role first seen on the board after it is "new since you were
  // here". Set once by init() and never advanced during the session, so a
  // refresh keeps counting rows that arrive while the tab is open.
  since: null,
};

/**
 * One role at one employer, however many cities it is advertised in.
 *
 * Some employers post a single opening separately for every location: Procter &
 * Gamble ran 21 copies of "Engineering Internship, Summer 2027" on the US board,
 * one per city, and IBM three of "Cybersecurity Analyst Apprentice". Each really
 * is a distinct vacancy with its own job id and its own page — `card_keys` keys
 * on location precisely so they are not collapsed during collection, because
 * collapsing them there would lose every city but the first.
 *
 * That is right for the STORE and wrong for the FEED, where twenty-one identical
 * headlines read as a fault. So they are collapsed here, at render time only:
 * jobs.json still carries every posting, every posting still has its own page,
 * and the crawlable list on the homepage still links to all of them.
 *
 * Company and title alone are NOT enough, and getting this wrong in either
 * direction is bad. Employers also file several genuinely different jobs under
 * one title — Emerson has seven "Graduate Engineer Trainee" postings that are
 * five different roles, Valeo six "Intern" that are six — and merging those
 * would hide real openings behind one card.
 *
 * `roleFingerprint` is a hash of the posting's own text, written by publish.js,
 * and it is the only field that separates the two cases. None of the
 * model-generated ones can: Siemens posted ONE role in 13 cities and the local
 * model gave it three different roleLabels, while P&G's single 24-city opening
 * produced four different summaries. A row with no fingerprint — nothing was
 * scraped for it — falls back to its own id, so it stands alone rather than
 * being merged on a guess. That is the safe direction: an extra card costs a
 * little repetition, a wrongly merged one costs somebody a job.
 */
const roleKey = (j) => [
  String(j.company ?? '').toLowerCase().trim(),
  String(j.title ?? '').toLowerCase().trim(),
  j.roleFingerprint || `id:${j.id}`,
].join('|');

/**
 * Group an already-filtered, already-sorted list into one entry per role.
 *
 * A Map keeps insertion order, so the groups come out in the order the sort put
 * them and the first posting in each is the representative — the newest under
 * the default sort. Grouping AFTER filtering is what makes a city filter behave:
 * pick one city and the group collapses to the postings in it.
 */
function groupByRole(list) {
  const groups = new Map();
  for (const j of list) {
    const key = roleKey(j);
    const g = groups.get(key);
    if (g) g.push(j);
    else groups.set(key, [j]);
  }
  return groups;
}

/** "Cincinnati, OH" -> "Cincinnati". The state and country add nothing on a chip. */
const cityOf = (loc) => String(loc ?? '').split(',')[0].trim();

/**
 * The cities of a collapsed group, deduplicated and in order.
 *
 * Case-insensitive, keeping the better-capitalised spelling — the same employer
 * writes the same city differently on different postings ("Gurgaon" and
 * "gurgaon" both appear), and a chip list that shows both looks broken.
 */
function citiesOf(group) {
  const seen = new Map();
  for (const j of group) {
    const city = cityOf(j.location);
    if (!city) continue;
    const key = city.toLowerCase();
    const prev = seen.get(key);
    if (!prev || (prev[0] === prev[0].toLowerCase() && city[0] !== city[0].toLowerCase())) {
      seen.set(key, city);
    }
  }
  return [...seen.values()];
}

/* ---------------- owner controls ----------------

   /owner.js is added ONLY in a browser that has been paired from the helper on
   his Mac (http://127.0.0.1:4322/owner). A visitor has no token, so they never
   download it and never make a request to 127.0.0.1. See src/owner.js. */
(function loadOwnerControls() {
  try {
    if (!localStorage.getItem('interndoor-owner') && !/^#owner-pair=/.test(location.hash)) return;
  } catch (e) { return; }
  var s = document.createElement('script');
  s.src = '/owner.js';
  s.defer = true;
  document.head.appendChild(s);
})();

/* ---------------- theme ---------------- */

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;

  $('theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
}

/* ---------------- helpers ---------------- */

/** Compact, monospace-friendly age: 12m, 4h, 3d. */
function shortAge(ms) {
  if (!ms) return '—';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function relTime(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * The company's real logo when we have one, initials when we don't.
 *
 * The initials are rendered underneath rather than instead: if the image fails
 * to load for any reason, removing it reveals the fallback with no layout shift
 * and no flash of nothing.
 */
function companyBadge(job) {
  const badge = el('div', 'crest', companyInitials(job.company));

  if (job.logo) {
    const img = el('img', 'crest-img');
    img.alt = '';               // decorative: the company name is right beside it
    img.loading = 'lazy';
    img.decoding = 'async';
    const lit = () => badge.classList.add('lit');
    img.addEventListener('load', lit);

    // A failed logo is RETRIED, not written off.
    //
    // The logo file and jobs.json ship in the same commit, but they are
    // separate objects on the CDN with opposite caching: jobs.json is
    // max-age=0 and revalidates on every load, logos are immutable and pulled
    // to an edge only when something asks for them. So the first person to see
    // a brand-new employer can get the listing before the image exists at
    // their edge. It 404s, and before this the img was removed on the spot and
    // the card sat on initials for the life of the page.
    //
    // That lands on exactly the worst card: a new employer is by definition a
    // JUST NOW listing at the top of the board. Workday went up on 21 Aug and
    // showed as "WO".
    //
    // The query string is the point of the retry — without it the browser
    // serves its own cached 404 back and the second attempt fails identically.
    let tries = 0;
    img.addEventListener('error', () => {
      if (tries >= 2) { img.remove(); return; }   // genuinely missing; show initials
      tries += 1;
      setTimeout(() => { img.src = `${job.logo}?r=${tries}`; }, tries * 1500);
    });

    img.src = job.logo;         // set last, so both handlers are already attached
    if (img.complete && img.naturalWidth > 0) lit();   // already in cache: no load event coming
    badge.append(img);
  }
  return badge;
}

function companyInitials(name) {
  const words = String(name).replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function toast(message) {
  const t = $('toast');
  t.textContent = message;

  // Cancel a pending hide before unhiding. Without this, a toast arriving
  // during the previous one's fade-out would be hidden by that toast's timer
  // a moment after appearing.
  clearTimeout(toast._hide);
  t.hidden = false;

  // Commit the "down" state before flipping to "up", or the browser coalesces
  // both into one style change, finds nothing to transition from, and the toast
  // just appears. Reading offsetWidth forces that flush synchronously.
  //
  // Deliberately not requestAnimationFrame: rAF does not run in a backgrounded
  // tab, which would leave the toast unhidden but stuck at opacity 0 — visible
  // to a screen reader, invisible on screen.
  void t.offsetWidth;
  t.classList.add('is-up');

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.classList.remove('is-up');
    // Stay in the DOM until it has faded, or it would vanish instantly.
    clearTimeout(toast._hide);
    toast._hide = setTimeout(() => { t.hidden = true; }, 300);
  }, 2600);
}

/* ---------------- data ---------------- */

async function loadJobs() {
  try {
    /* CONDITIONAL, NOT CACHE-BUSTED. This used to send `?t=${Date.now()}` with
       cache: 'no-store', which made the board's own payload the most expensive
       thing on the site: a unique URL plus no-store means the full file is
       downloaded on EVERY load, every reload and every back-navigation, and no
       validator is ever sent. On the US board that is 205 KB and ~1.5s on a
       throttled connection, paid again by every returning reader.
       Nothing is gained by it. vercel.json already serves this file
       `max-age=0, must-revalidate`, so the browser revalidates on every load
       either way — freshness is identical. 'no-cache' says exactly that and
       nothing more: always ask the server, but send the validator so an
       unchanged file comes back 304 with an empty body. Measured against the
       live file: 200 + 204,814 bytes unconditional, 304 + 0 bytes conditional.
       Between publishes (30 min) a repeat load now transfers nothing.
       Do NOT reintroduce a timestamp here to "make sure it is fresh" — it
       defeats the validator and buys no freshness the header does not give. */
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.jobs = data.jobs ?? [];
    state.generatedAt = data.generatedAt ?? null;
  } catch {
    state.jobs = [];
    state.generatedAt = null;
  }
}

/**
 * The same fetch, for a board that is ALREADY on screen.
 *
 * Separate from loadJobs because the failure has to be the opposite: the first
 * load has nothing to show and an empty board is the honest answer, while a
 * refresh that fails must leave what the reader is reading exactly where it is.
 * Returns null on any failure, and never touches `state`.
 */
async function fetchBoard() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.jobs) ? data : null;
  } catch {
    return null;
  }
}

/**
 * How often an open tab asks whether the board has moved.
 *
 * "checked 44 minutes ago", 16 Sep 2026, on a tab left open: the page fetched
 * once at load and only re-rendered the label, so the number counted up while
 * the site itself had published twice. People watching for a new role leave
 * this open all day — that is the case to serve, not an edge case.
 *
 * Five minutes against a publish cadence of 30-50 minutes, and the request is
 * conditional (`max-age=0, must-revalidate` plus `cache: 'no-cache'`), so a
 * board that has not moved costs one 304 with an empty body.
 */
const REFRESH_MS = 5 * 60 * 1000;

/**
 * Take the new payload only when it is both real and NEWER.
 *
 * Pure, and exported onto the module scope for the test, because the two ways
 * this goes wrong are silent: a failed fetch wiping a board the reader was
 * reading, and an unchanged payload repainting the list under their cursor
 * every five minutes.
 */
function shouldAdopt(current, data) {
  if (!data) return false;
  const next = data.generatedAt ?? null;
  if (next == null) return false;
  return current == null || next > current;
}

/**
 * Bring an open tab up to date, keeping the reader's place.
 *
 * Filters, the search box and the selected role are all read back out of the
 * DOM by applyFilters, so they survive; the list's scroll position does not,
 * and is restored by hand.
 */
async function refreshBoard() {
  const data = await fetchBoard();
  if (!shouldAdopt(state.generatedAt, data)) {
    // Still worth repainting the label: "checked 5m ago" ages either way.
    renderFreshness();
    return false;
  }
  state.jobs = data.jobs;
  state.generatedAt = data.generatedAt;
  window.IDTrack?.refresh(state.jobs);
  const list = $('joblist');
  const scroll = list ? list.scrollTop : 0;
  renderFreshness();
  renderTotal();
  populateFilters();
  applyFilters();
  if (list) list.scrollTop = scroll;
  return true;
}

function renderFreshness() {
  $('freshness-text').textContent = state.generatedAt
    ? `checked ${relTime(state.generatedAt)}`
    : 'standing by';
}

/* ---------------- new since your last visit ---------------- */

/* THE BOARD REMEMBERS WHERE THE READER LEFT OFF, in localStorage and nowhere
   else. A daily visitor used to scroll from the top until the rows looked
   familiar and then leave — the page held nothing about them, so they did the
   remembering. Now the rows that arrived since their last visit are counted,
   pinned above the rest and the rest are dimmed, which turns the daily check
   into a glance. No account, no cookie, no request: the same footing as the
   application tracker. */
const VISIT_KEY = 'interndoor-visit';
/* Two loads inside half an hour are one visit. Without this a reload — the
   most natural thing to do when checking for new roles — would advance the
   mark and make the "new since" header vanish mid-visit. */
const VISIT_GAP_MS = 30 * 60 * 1000;

/** When the board last listed something: the newest firstSeenAt on it. */
function latestListed(jobs) {
  let max = 0;
  for (const j of jobs) {
    const t = Number(j.firstSeenAt ?? j.postedAt ?? 0);
    if (t > max) max = t;
  }
  return max || null;
}

/**
 * Decide what "since your last visit" means for this load, and what to store
 * for the next one. Pure — lifted into test/engage.test.mjs by name.
 *
 *   stored  what the previous load wrote: { mark, at, prev } or null
 *   now     the clock
 *   latest  latestListed(state.jobs)
 *
 * Returns { since, returning, next }. `since` is null on a first visit (there
 * is nothing to be new relative to, and a page full of "new" badges for a
 * stranger is noise), and otherwise the mark the reader's last VISIT ended on
 * — which, inside the 30-minute gap, is the mark before that, so a reload
 * shows the same header the first load did.
 */
function visitSince(stored, now, latest) {
  let rec = null;
  if (stored && typeof stored === 'object') rec = stored;
  else if (typeof stored === 'string') { try { rec = JSON.parse(stored); } catch { rec = null; } }
  // Number(null) is 0, and 0 is a mark that makes every row "new" — so an
  // absent field must read as absent, not as the dawn of time.
  const num = (v) => (v == null ? NaN : Number(v));
  const mark = num(rec?.mark);
  const at = num(rec?.at);
  const prev = num(rec?.prev);
  const top = Math.max(Number(latest) || 0, Number.isFinite(mark) ? mark : 0) || null;

  if (!rec || !Number.isFinite(mark) || !Number.isFinite(at)) {
    return { since: null, returning: false, next: { mark: top, at: now, prev: null } };
  }
  if (now - at > VISIT_GAP_MS) {
    // A new visit: everything listed after the last one is new.
    return { since: mark, returning: true, next: { mark: top, at: now, prev: mark } };
  }
  // The same visit continuing: keep showing what that visit was shown.
  const since = Number.isFinite(prev) ? prev : null;
  return { since, returning: since != null, next: { mark: top, at: now, prev: since } };
}

function readVisit() {
  try { return localStorage.getItem(VISIT_KEY); } catch { return null; }
}
function writeVisit(rec) {
  try { localStorage.setItem(VISIT_KEY, JSON.stringify(rec)); } catch { /* private mode */ }
}

/** Is this role new relative to the reader's last visit? Any city counts. */
function isNewSince(group, since) {
  if (since == null) return false;
  return group.some((j) => Number(j.firstSeenAt ?? j.postedAt ?? 0) > since);
}

/**
 * Put the new roles first, keeping each side's own order. Pure. Only the
 * default newest-first sort is partitioned: a reader who chose "best match"
 * or "company" asked for that order and gets it, with the seen rows merely
 * dimmed.
 */
function splitNewSince(groups, since, sort = 'newest') {
  // A first visit has nothing to be new relative to — and nothing has been
  // seen either, so nothing is dimmed. The list is exactly what it was.
  if (since == null) return { fresh: [], seen: [], n: 0, ordered: groups };
  const fresh = [], seen = [];
  for (const g of groups) (isNewSince(g, since) ? fresh : seen).push(g);
  if (sort !== 'newest') return { fresh, seen, n: fresh.length, ordered: groups };
  return { fresh, seen, n: fresh.length, ordered: [...fresh, ...seen] };
}

/**
 * How many roles are new since the last visit, per tab — over EVERY row on
 * the board, not the filtered set, the same way the tab badges count. Pure.
 *
 * THE OTHER TAB IS THE ONE THE READER CANNOT SEE. The board opens on
 * Internships, so a full-time role published overnight was invisible unless
 * the reader happened to click across: the "new since your last visit" bar
 * counted only the tab on screen (19 Sep 2026). This is what lets each tab
 * carry its own "+N new" and the bar name the other one.
 */
function newSinceByKind(jobs, since, keyOf = roleKey) {
  const out = { intern: 0, fulltime: 0 };
  if (since == null) return out;
  const seen = { intern: new Set(), fulltime: new Set() };
  for (const j of jobs) {
    if (!(Number(j.firstSeenAt ?? j.postedAt ?? 0) > since)) continue;
    const k = j.employmentType || 'intern';
    seen[k]?.add(keyOf(j));
  }
  out.intern = seen.intern.size;
  out.fulltime = seen.fulltime.size;
  return out;
}

/* The board decides new-vs-return before engage.js loads (rendering must not
   wait on a network fetch) and leaves the answer on <html> for it to count. */
function loadEngage() {
  const s = document.createElement('script');
  s.src = '/engage.js';
  s.defer = true;
  document.head.append(s);
}

/** A row written before the intern/full-time split is an internship. */
const kindOf = (j) => j.employmentType || 'intern';

/* THE SHELVES INSIDE EACH TAB. A jobs.json written before `category` existed
   files every row under software, so a stale data file shows one shelf and
   hides nothing — the control simply does not appear until there is a second
   shelf to choose. */
const CATS = [['software', 'Software'], ['hardware', 'Hardware'], ['misc', 'Misc']];
const catOf = (j) => j.category || 'software';

/** New roles per shelf, inside one tab — the same counting rule as the tabs. */
function newSinceByCat(jobs, since, kind, keyOf = roleKey) {
  const out = { software: 0, hardware: 0, misc: 0 };
  if (since == null) return out;
  const seen = { software: new Set(), hardware: new Set(), misc: new Set() };
  for (const j of jobs) {
    if (kindOf(j) !== kind) continue;
    if (!(Number(j.firstSeenAt ?? j.postedAt ?? 0) > since)) continue;
    seen[catOf(j)]?.add(keyOf(j));
  }
  for (const c of Object.keys(out)) out[c] = seen[c].size;
  return out;
}

/** Roles per shelf inside one tab, counted in roles like every other badge. */
function catCounts(kind) {
  const seen = { software: new Set(), hardware: new Set(), misc: new Set() };
  for (const j of state.jobs) if (kindOf(j) === kind) seen[catOf(j)]?.add(roleKey(j));
  return { software: seen.software.size, hardware: seen.hardware.size, misc: seen.misc.size };
}

/**
 * The shelf control. Made HERE rather than shipped in index.html, for the
 * reason the "+N new" markers are: the template is the published board, and a
 * control that needs this script to mean anything should not exist without it.
 * Idempotent — renderTotal calls it on every data load.
 *
 * IT SITS OVER THE LIST, under the role count — the slot the "N new since
 * your last visit" line had until he asked for that line gone and the shelves
 * there instead (26 Sep 2026). Beside the Internships / Full-time tabs it read
 * as a rival to them; over the cards it reads as a choice about the cards.
 */
function renderCatSeg() {
  let seg = $('seg-cat');
  if (!seg) {
    const list = $('joblist');
    if (!list) return;
    seg = document.createElement('div');
    seg.className = 'seg seg-cat';
    seg.id = 'seg-cat';
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Discipline');
    for (const [cat, label] of CATS) {
      const b = document.createElement('button');
      b.className = 'seg-b';
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.cat = cat;
      if (cat === 'misc') b.title = 'Core engineering, research, IT, reporting, design and other roles';
      b.append(label, ' ');
      const n = document.createElement('b');
      b.append(n);
      b.addEventListener('click', () => setCat(cat));
      seg.append(b);
    }
    list.before(seg);
  }
  const counts = catCounts(state.kind);
  const fresh = newSinceByCat(state.jobs, state.since, state.kind);
  for (const b of seg.querySelectorAll('.seg-b')) {
    const cat = b.dataset.cat;
    b.querySelector('b').textContent = counts[cat] ?? 0;
    b.setAttribute('aria-selected', String(cat === state.cat));
    // An empty shelf is not offered — unless the reader is standing on it.
    b.hidden = !counts[cat] && cat !== state.cat;
    let mark = b.querySelector('.seg-new');
    if (!mark) {
      mark = document.createElement('i');
      mark.className = 'seg-new';
      b.append(mark);
    }
    const n = fresh[cat] ?? 0;
    mark.hidden = n === 0;
    mark.textContent = n ? `+${n} new` : '';
  }
  // One shelf is no choice: the control appears once there is a second.
  seg.hidden = !counts.hardware && !counts.misc;
}

/** Switch shelves. The kind tab is untouched; the selection is cleared. */
function setCat(cat) {
  if (cat === state.cat) return;
  state.cat = cat;
  state.selectedId = null;
  renderCatSeg();
  applyFilters();
}

function renderTotal() {
  // Distinct ROLES, not postings, so the tab badge matches the number of cards
  // the reader will actually count in the list below it. Without this, P&G's
  // 21-city opening made the badge read 21 higher than the list.
  const seen = { intern: new Set(), fulltime: new Set() };
  for (const j of state.jobs) seen[kindOf(j)]?.add(roleKey(j));
  const counts = { intern: seen.intern.size, fulltime: seen.fulltime.size };
  for (const k of ['intern', 'fulltime']) {
    const el = $(`n-${k}`);
    if (el) el.textContent = counts[k] ?? 0;
  }
  // Hide the whole control when a region has no full-time roles at all — a tab
  // that only ever shows "nothing here" is worse than no tab.
  const seg = $('seg-kind');
  if (seg) seg.hidden = !counts.fulltime;
  const legacy = $('n-total');
  if (legacy) legacy.textContent = state.jobs.length;
  renderTabNews();
  renderCatSeg();
}

/**
 * "+N new" on each tab, so the tab the reader is NOT looking at can still say
 * something arrived. Nothing on a first visit (state.since is null), nothing
 * when the count is zero — a "+0" is noise. The marker is made here rather
 * than in index.html: the template is the published board and app.js already
 * owns everything inside these buttons.
 */
function renderTabNews() {
  const fresh = newSinceByKind(state.jobs, state.since);
  for (const btn of document.querySelectorAll('#seg-kind .seg-b')) {
    const kind = btn.dataset.kind;
    let mark = btn.querySelector('.seg-new');
    if (!mark) {
      mark = document.createElement('i');
      mark.className = 'seg-new';
      btn.append(mark);
    }
    const n = fresh[kind] ?? 0;
    mark.hidden = n === 0;
    mark.textContent = n ? `+${n} new` : '';
    btn.dataset.new = String(n);
  }
}

/** Switch tabs — from the tablist, or from the bar's link to the other one. */
function setKind(kind) {
  if (kind === state.kind) return;
  state.kind = kind;
  for (const b of document.querySelectorAll('#seg-kind .seg-b')) {
    b.setAttribute('aria-selected', String(b.dataset.kind === kind));
  }
  // A shelf the new tab does not have falls back to Software rather than
  // landing the reader on an empty list they did not ask for.
  if (state.cat !== 'software' && !catCounts(kind)[state.cat]) state.cat = 'software';
  renderCatSeg();
  state.selectedId = null;
  syncUrl();
  applyFilters();
}

/**
 * REBUILDS, rather than appends, because refreshBoard calls it again.
 *
 * Appending was right while this ran once per load; on a refresh it would list
 * every company twice. The first <option> is the "All …" placeholder from the
 * HTML and is kept; the reader's current choice is restored, and kept even when
 * the employer has just aged off the board — silently resetting their filter to
 * "All" mid-read is worse than one option that now matches nothing.
 */
function populateFilters() {
  const fill = (id, values) => {
    const sel = $(id);
    if (!sel) return;
    const chosen = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    for (const v of values) sel.append(new Option(v, v));
    if (chosen && !values.includes(chosen)) sel.append(new Option(chosen, chosen));
    sel.value = chosen;
  };
  const companies = [...new Set(state.jobs.map((j) => j.company))].sort((a, b) => a.localeCompare(b));
  const locations = [...new Set(state.jobs.map((j) => j.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fill('f-company', companies);
  fill('f-location', locations.slice(0, 200));
}

/* ---------------- filtering ---------------- */

/* ---------------- resume matching ----------------
 *
 * The one thing this board can do that a general listings site cannot without
 * an account: score every open role against the reader's own resume and sort
 * by fit.
 *
 * THE RESUME IS HELD IN MEMORY AND NOWHERE ELSE — not localStorage, not
 * sessionStorage. The footer promises it is "processed in memory and never
 * stored here" and that sentence has to stay true, so the scores are gone on
 * reload. That is the correct trade.
 *
 * Skills are normalised to a space-padded haystack so a skill can be matched
 * WHOLE-WORD with a plain includes(): "r" must not match "for", and "go" must
 * not match "algorithm". */
let resumeHay = '';
const normSkill = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();

function setResumeHay(text) {
  const next = text ? ` ${normSkill(text)} ` : '';
  // A different resume invalidates every AI score, and the card cannot say
  // which resume produced its number — so drop them rather than show a stale one.
  if (next !== resumeHay) { aiScores = new Map(); resetMatchCache(); }
  resumeHay = next;
}

/** Every skill named on a posting, de-duplicated across the two fields. */
function skillsOf(job) {
  const out = new Set();
  for (const raw of [...(job.keySkills ?? []), ...(job.skills ?? [])]) {
    const k = normSkill(raw);
    if (k) out.add(k);
  }
  return [...out];
}

/**
 * How well this posting fits the loaded resume.
 *
 * Returns null rather than a low score when there is nothing to judge on. A
 * posting naming two skills would swing between 0% and 100% on a single word,
 * and a confident "0% match" on a role the reader is well suited to is worse
 * than saying nothing — the number would be measuring our own extraction, not
 * their fit.
 *
 * @returns {{pct: number, hit: string[], of: number}|null}
 */
/* Scores from an AI rank on the reader's own key: job id -> {fit, why}.
 *
 * CLEARED WHENEVER THE RESUME CHANGES. A score computed against a different
 * resume is worse than no score at all, because nothing on the card says which
 * resume produced it. setResumeHay is the one place the resume changes, so it
 * is the one place this is emptied. */
let aiScores = new Map();

/**
 * How well this posting fits the loaded resume.
 *
 * An AI score wins where there is one — it read the posting rather than
 * counting word overlap, and it carries a reason. Otherwise the local skill
 * match decides, now comparing each skill under every spelling a resume might
 * use (`resumeNames`): a student who writes "JS, Node, K8s" was scoring a miss
 * on postings that say JavaScript, Node.js and Kubernetes, which measured out
 * at HALF the matches of an identical resume that spelled them out.
 *
 * Returns null rather than a low score when there is nothing to judge on. A
 * posting naming two skills would swing between 0% and 100% on a single word,
 * and a confident "0% match" on a role the reader is well suited to is worse
 * than saying nothing — the number would be measuring our own extraction, not
 * their fit.
 *
 * @returns {{pct: number, hit: string[], of: number, ai: boolean, why?: string}|null}
 */
/* MEMOISED PER JOB, and this one fixes a cost that PREDATES the alias change.
   Sorting by fit calls matchFor from the comparator, so it ran O(n log n) times
   over the whole board and rebuilt a Set of the posting's skills on every one.
   Measured on the live 3,884-role US board, a keystroke in the search box took
   256-321 ms sorted by fit against 30 ms sorted by date — and the alias lookup
   pushed that to 333-408 ms. Scoring each job once and keeping it puts both
   back at the baseline. The answer depends only on the job, the resume and the
   AI scores, so the cache is dropped whenever either of those changes. */
let matchCache = new Map();

function resetMatchCache() { matchCache = new Map(); covCache = null; }

function matchFor(job) {
  const cached = matchCache.get(job.id);
  if (cached !== undefined) return cached;
  const value = computeMatch(job);
  matchCache.set(job.id, value);
  return value;
}

function computeMatch(job) {
  const ai = aiScores.get(job.id);
  if (ai) return { pct: ai.fit, hit: [], of: 0, ai: true, why: ai.why };
  if (!resumeHay) return null;
  const skills = skillsOf(job);
  if (skills.length < 3) return null;
  const hit = skills.filter((k) => resumeNames(resumeHay, k));
  return { pct: Math.round((hit.length / skills.length) * 100), hit, of: skills.length, ai: false };
}

/**
 * What the last ranking actually managed, counted over the WHOLE board.
 *
 * This is the number the old build never showed, and not showing it is what
 * made the feature look broken: a card scoring a genuine 0% draws no fit line,
 * so "we scored it and you match none of it" and "we never scored it" were
 * indistinguishable. Measured on the live boards for a resume outside
 * engineering, 3 of 399 India roles drew anything at all — a reader saw the
 * board reorder, a toast saying it had worked, and essentially no numbers.
 */
let covCache = null;

function rankCoverage() {
  if (!resumeHay && !aiScores.size) return null;

  /* MEMOISED, AND THAT IS NOT AN OPTIMISATION — IT IS THE FIX FOR A REGRESSION
     THIS FUNCTION CAUSED. It walks the WHOLE board, and renderList() runs on
     every keystroke in the search box: measured on the 3,884-role US board with
     a resume loaded, a render went to 360-440 ms, which is the same per-render
     cost §15 windowed the list to remove in the first place.

     Nothing here depends on the filter or the window — only on the resume, the
     AI scores, the tab and the job set, all four of which are REPLACED rather
     than mutated, so identity is a sound key. */
  if (covCache
    && covCache.hay === resumeHay
    && covCache.ai === aiScores
    && covCache.kind === state.kind
    && covCache.cat === state.cat
    && covCache.jobs === state.jobs) return covCache.value;

  let shown = 0, silent = 0, unscorable = 0;
  for (const job of state.jobs) {
    if (kindOf(job) !== state.kind || catOf(job) !== state.cat) continue;
    const fit = matchFor(job);
    if (!fit) unscorable += 1;
    else if (fit.ai || fit.hit.length) shown += 1;
    else silent += 1;
  }
  const value = { shown, silent, unscorable, total: shown + silent + unscorable };
  covCache = { hay: resumeHay, ai: aiScores, kind: state.kind, cat: state.cat, jobs: state.jobs, value };
  return value;
}

/**
 * Bring the board into line with whatever resume is loaded.
 *
 * Adds "best for me" to the sort control the first time there is something to
 * sort by, and takes it away again when the resume is cleared — an option that
 * cannot do anything is worse than no option, because selecting it looks like a
 * bug rather than a missing input. Re-renders so scores appear on the cards
 * immediately rather than at the next keystroke.
 */
function syncRelevance() {
  setResumeHay(state.resumeText);
  const sort = $('f-sort');
  const have = sort.querySelector('option[value="match"]');
  if (resumeHay && !have) {
    const opt = el('option', null, 'best for me');
    opt.value = 'match';
    sort.append(opt);
  } else if (!resumeHay && have) {
    if (sort.value === 'match') sort.value = 'new';
    have.remove();
  }
  document.body.classList.toggle('has-resume', Boolean(resumeHay));
  applyFilters();
}

function applyFilters() {
  const q = $('q').value.trim().toLowerCase();
  const company = $('f-company').value;
  const location = $('f-location').value;
  const mode = $('f-mode').value;
  const sort = $('f-sort').value;

  const list = state.jobs.filter((j) => {
    if (kindOf(j) !== state.kind) return false;
    if (catOf(j) !== state.cat) return false;
    if (company && j.company !== company) return false;
    if (location && j.location !== location) return false;
    if (mode && (j.workplaceType ?? '').toLowerCase() !== mode.toLowerCase()) return false;
    if (q) {
      const blob = [j.title, j.company, j.location, j.summary, (j.skills || []).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  if (sort === 'company') list.sort((a, b) => a.company.localeCompare(b.company));
  else if (sort === 'match') {
    // Unscorable roles (fewer than three named skills) sort to the bottom
    // rather than to 0% — they were not judged, not judged badly. Newest first
    // inside an equal score, so the tie-break is still the board's own promise.
    const pct = (j) => matchFor(j)?.pct ?? -1;
    list.sort((a, b) => pct(b) - pct(a) || (b.postedAt ?? 0) - (a.postedAt ?? 0));
  } else list.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));

  state.filtered = list;
  renderList();
  syncStickyOffset();
}

function anyFilterActive() {
  return $('q').value.trim() || $('f-company').value || $('f-location').value ||
    $('f-mode').value;
}

/* ---------------- rendering ---------------- */

/**
 * The URL of a job's generated page.
 *
 * Must produce byte-identical output to slugify/jobSlug in src/pages.js, which is
 * what actually names the files at publish time. If the two ever drift, this links
 * to a 404 — so any change to one has to be made in both.
 */
function jobPageSlug(job) {
  const slug = (s, max = 70) => String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'role';
  // The id is never truncated — see the note on jobSlug in src/pages.js.
  return `${slug(job.company)}-${slug(job.title)}-${slug(job.id, Infinity)}`;
}

/**
 * An href we are willing to put in front of a reader. The apply URL comes from
 * the posting, and `javascript:` is a perfectly valid href — so only http(s)
 * links are ever assigned. Mirrors safeUrl() in src/pages.js.
 */
function safeUrl(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/** Has this posting been through the Gemini pass yet? */
function enriched(job) {
  return (job.bullets ?? []).length > 0;
}

/**
 * Who can apply. Highlighted because eligibility is the one fact that makes the
 * rest of the card irrelevant, and it is absent from most postings — so when it
 * IS known it deserves to be the loudest thing in the row.
 */
function degreeTag(job) {
  if (!job.degreeLevel) return null;
  const tag = el('span', 'elig');
  tag.append(el('b', null, job.degreeLevel));
  if (job.degreeText) tag.append(el('i', null, job.degreeText));
  return tag;
}

/**
 * Words that describe the shape of a job rather than the work in it. A title made
 * only of these tells a reader nothing.
 */
const FILLER_TITLE_WORDS = new Set([
  'intern', 'interns', 'internship', 'internships', 'apprentice', 'apprenticeship',
  'trainee', 'traineeship', 'graduate', 'grad', 'summer', 'winter', 'management',
  'program', 'programme', 'role', 'position', 'opportunity', 'hiring', 'new',
  'full', 'time', 'part', 'fresher', 'freshers', 'entry', 'level', 'junior',
]);

/**
 * Does this title distinguish the job from the others at the same company?
 *
 * A quarter of postings are titled only "Apprentice", "Intern" or "Trainee".
 * American Express alone has 25 of them — 25 genuinely different jobs, from GenAI
 * automation to credit-loss modelling, all sharing one useless label. Stacked in a
 * feed they read as duplicates.
 */
function titleIsGeneric(title) {
  const meaningful = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_TITLE_WORDS.has(w) && !/^\d+$/.test(w));
  return meaningful.length <= 1;
}

/**
 * What the job actually is, for titles that do not say.
 *
 * Prefers Gemini's short label. Falls back to the opening of the first bullet,
 * which already describes the work — worse than a real label, but it needs no extra
 * API call and it works for every posting enriched before roleLabel existed.
 *
 * Returns whether the bullet was consumed, because the caller must then not print
 * that same bullet three lines further down. The first draft did, and a card read
 * "Apprentice · analyze data to identify trends…" directly above a bullet saying
 * "Analyze data to identify trends into clear reports".
 *
 * @returns {{text: string, usedFirstBullet: boolean}|null}
 */
function roleQualifier(job) {
  if (job.roleLabel) return { text: job.roleLabel, usedFirstBullet: false };
  const first = (job.bullets ?? [])[0];
  if (!first) return null;
  const clipped = first.length > 58 ? `${first.slice(0, 57).replace(/[\s,;:.]+\S*$/, '')}…` : first;
  return { text: clipped.charAt(0).toLowerCase() + clipped.slice(1), usedFirstBullet: true };
}

/**
 * The role line, plus what the job is when the title hides it.
 * @returns {{node: HTMLElement, usedFirstBullet: boolean}}
 */
function roleLine(job) {
  // A heading, not a p: the role is the card's heading. It used to be a
  // paragraph under a heading of the company name, which told a screen reader
  // (and a crawler) that the employer was the subject and the job a detail.
  // h2 rather than h3 because the only heading above it is the page's h1, and
  // 610 cards each opening at h3 made every one of them a skipped level —
  // "Heading elements are not in a sequentially-descending order", the single
  // navigation failure in the accessibility audit. The card's look is carried
  // by .role, not by the tag, so nothing moves visually.
  const p = el('h2', 'role', job.title);
  if (!titleIsGeneric(job.title)) return { node: p, usedFirstBullet: false };
  const q = roleQualifier(job);
  if (!q) return { node: p, usedFirstBullet: false };
  p.append(el('span', 'qual', q.text));
  return { node: p, usedFirstBullet: q.usedFirstBullet };
}

/* THE BLURB UNDER A CARD WITH NO BULLETS, when it is worth reading.
   ------------------------------------------------------------------------
   When enrichment produces no bullets the card falls back to `summary`, which
   is the posting's own opening text. That was written on the reasoning that
   the original blurb beats an empty card -- true when the blurb is about the
   JOB, and false when it is not. Measured on the live board, six cards showed
   one and three of them said nothing at all:

     "About the job"                                    (Tonbo Imaging)
     "Qualcomm India Private Limited Interns Group..."  (the posting's header)
     "At Jacobs we value people. Having the right..."   (values boilerplate)

   The other three earn their place -- "Replacement intern position for AI4EE
   BE / BTech / MTech in AI/Data Science" is the most useful line on that card
   -- so this refuses the useless shapes rather than dropping the blurb
   whenever bullets are missing. A card that says less is better than a card
   that says nothing at length; a card that drops a real sentence is worse
   than both.

   Every rejection below is a shape counted on the live board, not a guess. */
const GIST_INVISIBLE = /[­͏​-‏‪-‮⁠-⁤﻿]/g;
const GIST_MIN_CHARS = 40;

function gistText(job) {
  /* Some ATS exports carry zero-width joiners between every word; Wipro's
     renders as "Job Description [4 invisible chars] Intern in AI/ML expertise".
     Stripped before the length test, or junk counts towards earning a place. */
  const s = String(job.summary ?? '').replace(GIST_INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < GIST_MIN_CHARS) return '';
  const flat = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const f = flat(s);
  const co = flat(job.company);
  // The posting's own header, or the company's values statement. Neither is
  // about the role, and the company name is already the line above.
  if (co && (f.startsWith(co) || f.startsWith(`at ${co}`))) return '';
  // The title back at us, padded. The title is already the card's heading.
  const ti = flat(job.title);
  if (ti && f.includes(ti) && s.length < 140) return '';
  return s;
}

function jobCard(job, index, group = [job], seen = false) {
  const li = document.createElement('li');
  /* A div, NOT an <article>. The card carries role="button" because the whole
     card opens the detail dialog, and `button` is not an allowed role on
     <article> — axe's aria-allowed-role flags it on every card, which is the
     entire "accessibility tree is not well-formed" finding in the agentic
     browsing category (237 of 237 cards, and the only rule in that audit's
     set this site breaks). The role already overrode the article semantics,
     so nothing was being exposed as an article anyway; a div has no implicit
     role and accepts any. No CSS targets the tag and every query here is by
     .row, so this is invisible in both look and behaviour. */
  const row = el('div', 'row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.id = job.id;
  row.style.animationDelay = `${Math.min(index, 14) * 32}ms`;
  if (job.id === state.selectedId) row.setAttribute('aria-current', 'true');

  const age = job.postedAt ? Date.now() - job.postedAt : null;
  const blazing = age != null && age < HOT_MS;
  if (blazing) row.classList.add('is-hot');
  /* Already on the board at the reader's last visit. The class recedes the
     card through its background and rule, never through opacity (§15 — dimmed
     text fails contrast); the row stays fully readable and fully clickable. */
  if (seen) row.classList.add('seen');

  // No rank number. It was decoration: the position of a row in a list the
  // reader is already looking at, restated. It cost a grid column on every card.
  row.append(companyBadge(job));

  const mid = el('div');
  // Company first in the DOM but styled as an eyebrow — the role is the heading.
  mid.append(el('div', 'co', job.company));
  const role = roleLine(job);
  mid.append(role.node);

  // Eligibility leads. A student's first question is "can I even apply", and
  // that used to be buried in the description while the card spent its
  // most-read line on a city they had already filtered by.
  const meta = el('div', 'meta');
  const degree = degreeTag(job);
  if (degree) meta.append(degree);

  // A role advertised in several cities says so here, whether or not it is
  // enriched — it is the most useful thing on the card for someone deciding
  // whether to read further, and it replaces the single city that would
  // otherwise misrepresent the opening as being in one place.
  const cities = group.length > 1 ? citiesOf(group) : [];
  if (cities.length > 1) {
    const shown = cities.slice(0, 3).join(' · ');
    const rest = cities.length - 3;
    meta.append(el('span', 'cities', rest > 0 ? `${shown} +${rest} more` : shown));
  } else if (!enriched(job)) {
    // Enrichment runs on a wall-clock budget, so at any moment some postings have
    // eligibility and skills and some do not. Where they do, that is the row. Where
    // they do not, fall back to city and work mode so the row is not left empty.
    if (job.location) meta.append(el('span', null, job.location));
    if (job.workplaceType) meta.append(el('span', null, job.workplaceType));
  }
  if (job.duration) meta.append(el('span', null, job.duration));
  if (meta.children.length) mid.append(meta);

  /* Fit, when a resume is loaded. Under the facts rather than beside the role:
     it is a strong signal but it is OURS, not the employer's, and it must not
     be mistaken for something the posting said. */
  const fit = matchFor(job);
  /* A genuine 0% still draws nothing HERE — 327 cards each reading "0% match"
     is noise, not information. The honest count of what was and was not scored
     is said once, in the summary bar at the top of the list. */
  if (fit && (fit.ai || fit.hit.length)) {
    const m = el('div', `match${fit.pct >= 60 ? ' is-strong' : ''}${fit.ai ? ' is-ai' : ''}`);
    m.append(el('b', null, `${fit.pct}% match`));
    // An AI score carries its own reason; a local one can only say how much of
    // the posting's own skill list the resume named.
    m.append(el('span', null, fit.ai
      ? (fit.why || 'judged against the posting')
      : `${fit.hit.length} of ${fit.of} skills`));
    mid.append(m);
  }

  const skills = (job.keySkills ?? []).slice(0, 4);
  if (skills.length) {
    const box = el('div', 'skills');
    for (const s of skills) {
      const chip = el('span', 'skill', s);
      // A skill the loaded resume already names is lit, so the chips stop being
      // uniform decoration and become a reason to look at one card over another.
      if (resumeHay && resumeNames(resumeHay, s)) chip.classList.add('has');
      box.append(chip);
    }
    mid.append(box);
  }

  // The role line may have consumed the first bullet as its qualifier; printing it
  // again here would say the same sentence twice on one card.
  const bullets = (job.bullets ?? []).slice(role.usedFirstBullet ? 1 : 0);
  if (bullets.length) {
    const ul = el('ul', 'gist-list');
    for (const b of bullets) ul.append(el('li', null, b));
    mid.append(ul);
  } else {
    /* No bullets: fall back to the posting's own opening, but only when it
       actually says something. See gistText. */
    const gist = gistText(job);
    if (gist) mid.append(el('p', 'gist', gist));
  }
  row.append(mid);

  // Age, plus a bar that drains over the first 24 hours. Turning "how long do I
  // have" into something you can see at a glance is the whole point of the site.
  const ageBox = el('div', `age${blazing ? ' blazing' : age != null && age < FRESH_MS ? ' fresh' : ''}`);
  ageBox.append(el('b', null, blazing ? 'JUST NOW' : shortAge(job.postedAt)));
  if (age != null && age < FRESH_MS) {
    const bar = el('s');
    const fill = el('i');
    fill.style.width = `${Math.max(4, Math.round((1 - age / FRESH_MS) * 100))}%`;
    bar.append(fill);
    ageBox.append(bar);
  }
  // Age and Apply share a footer strip. Applying used to cost two taps and a
  // full-screen context switch — open the role, then find the button — and the
  // detail pane exists to answer questions, not to gate the one action every
  // visitor came to take.
  const foot = el('div', 'card-foot');
  foot.append(ageBox);

  /* Between the age and Apply. Marking a role applied is the step that happens
     RIGHT AFTER Apply is pressed, so it belongs on the card the reader is
     already looking at rather than two taps away inside the detail pane. */
  const trk = trackControl(job);
  if (trk) foot.append(trk);

  const applyHref = safeUrl(job.applyUrl) || safeUrl(job.url);
  if (applyHref) {
    const go = el('a', 'card-go');
    go.href = applyHref;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.textContent = 'Apply';
    go.setAttribute('aria-label', `Apply for ${job.title} at ${job.company}`);
    // The whole card is clickable. Without this, applying would also fire the
    // card's handler and slide the detail pane up behind the new tab.
    go.addEventListener('click', (e) => { e.stopPropagation(); window.IDEngage?.onApply(); });
    foot.append(go);
  }
  row.append(foot);

  row.addEventListener('click', () => selectJob(job.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectJob(job.id); }
  });

  li.append(row);
  return li;
}

/* ---------------- the application tracker ---------------- */

/* The store is track.js, loaded ahead of this module on every page. Everything
   here degrades to nothing if it is missing: `trackControl` returns null and no
   card, pane or rail button is drawn, which is the same page the site had
   before the tracker existed. */

/** The payload track.js stores for a job — see its snapshot() for each field. */
function trackable(job) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    applyUrl: job.applyUrl,
    slug: jobPageSlug(job),
    // This board and its URL prefix, so the tracker can link the role's page
    // without carrying its own copy of the region→path map.
    region: REGION,
    path: REGION_PATH,
  };
}

/**
 * The track control on a card.
 *
 * A container whose contents are rebuilt on every change, because the control
 * is a BUTTON in one state and a LINK in another and the element itself has to
 * change with it.
 *
 * THE CARD CAN ONLY UNDO WHAT THE CARD DID. Untracked, it marks the role
 * Applied; still at Applied, pressing again removes it, which is a real undo
 * for a mis-click. Once the role has moved past Applied it becomes a status
 * chip that links to the tracker instead — a role sitting at "Interview
 * scheduled" carries a history that a stray click on a list of 250 cards must
 * not be able to delete, and there is nothing on a card to confirm against.
 */
function paintTrackControl(box) {
  const T = window.IDTrack;
  const job = state.jobs.find((j) => j.id === box.dataset.id);
  if (!T || !job) return;

  const row = T.get(job.id);
  const meta = row ? T.statusMeta(row.status) : null;
  box.replaceChildren();
  box.classList.toggle('is-on', !!row);

  const stop = (e) => e.stopPropagation();

  if (row && row.status !== 'applied') {
    const a = el('a', 'trk-b is-set', meta.short);
    a.href = `${REGION_PATH}/applications`;
    a.title = `Tracked — ${meta.label}. Open your applications to change it.`;
    a.setAttribute('aria-label',
      `${job.title} at ${job.company}: ${meta.label}. Open your applications.`);
    a.addEventListener('click', stop);
    box.append(a);
    return;
  }

  const b = el('button', row ? 'trk-b is-set' : 'trk-b');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(!!row));
  b.textContent = row ? 'Applied' : 'Track';
  b.setAttribute('aria-label', row
    ? `Applied to ${job.title} at ${job.company}. Press to remove from your applications.`
    : `Mark ${job.title} at ${job.company} as applied`);
  b.addEventListener('click', (e) => {
    // The whole card opens the detail pane; without this, tracking would also
    // slide the pane up over the board.
    stop(e);
    if (row) {
      T.remove(job.id);
      toast('Removed from your applications');
    } else if (T.track(trackable(job), 'applied')) {
      toast('Tracked as Applied — see My applications');
    }
    const err = T.error();
    if (err) toast(err);
  });
  box.append(b);
}

function trackControl(job) {
  if (!window.IDTrack) return null;
  const box = el('span', 'trk-w');
  box.dataset.id = job.id;
  paintTrackControl(box);
  return box;
}

/**
 * Repaint every track control on the page in place.
 *
 * A full renderList() would be correct and is far too heavy: it rebuilds up to
 * 250 cards, restarts their entrance animation and loses the reader's place,
 * all to change one word on one chip. This also has to run for a change made
 * in ANOTHER TAB — track.js emits on the storage event — so it cannot be
 * folded into the click handler that made the change.
 */
function paintTrackers() {
  for (const box of document.querySelectorAll('.trk-w')) paintTrackControl(box);
  /* The open detail pane's strip, if there is one. It is not subscribed to the
     store itself — see trackBar — so this is what keeps it in step with a
     change made on a card or in another tab. repaint() declines while the
     cursor is inside it, so this cannot eat a half-typed note. */
  const bar = document.querySelector('#detail .trk-bar');
  if (bar && typeof bar.repaint === 'function') bar.repaint();
  renderTrackCount();
}

/**
 * The rail's entry point: how many applications are on this device.
 *
 * The link itself is server-rendered and always visible — it is a real
 * destination that explains itself, and a reader whose script never arrives
 * still reaches it. Only the count is filled here, and only when there is one:
 * a badge reading 0 is noise on a control most visitors will never press.
 */
function renderTrackCount() {
  const btn = $('my-apps');
  if (!btn || !window.IDTrack) return;
  const n = window.IDTrack.count();
  btn.querySelector('b').textContent = n ? String(n) : '';
}

/* The filters live in the URL, so a filtered board can be linked, bookmarked
   and reloaded instead of resetting to everything.
   replaceState, not pushState: the search box reruns on every keystroke, and
   one history entry per character would make Back unusable. A fragment-only
   URL resolves against the current one, so selectJob()'s `#job-<id>` keeps the
   query string and this keeps the fragment. */
const URL_FILTERS = { q: 'q', company: 'f-company', city: 'f-location', mode: 'f-mode', sort: 'f-sort' };

function syncUrl() {
  const params = new URLSearchParams();
  for (const [key, id] of Object.entries(URL_FILTERS)) {
    const value = $(id).value.trim();
    // 'new' is the default sort; leaving it out keeps a shared link clean.
    if (value && !(key === 'sort' && value === 'new')) params.set(key, value);
  }
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, id] of Object.entries(URL_FILTERS)) {
    const value = params.get(key);
    if (value === null) continue;
    const node = $(id);
    // A company or city that has aged off the board would otherwise blank the
    // <select> and silently filter to nothing.
    if (node.tagName === 'SELECT' && !Array.from(node.options).some((o) => o.value === value)) continue;
    node.value = value;
  }
  $('clear-q').hidden = !$('q').value;
}

function renderList() {
  const list = $('joblist');

  // The entrance animation belongs to the first paint and nowhere else.
  //
  // Every filter change rebuilds this list through replaceChildren(), and the
  // search box reruns on `input` — so typing one character re-created up to 140
  // cards and restarted a keyframe on all of them. Keyframes restart from zero
  // rather than retargeting, so a fast typist saw a list that never settled.
  // Searching is a hundred-times-a-day action; it should not animate at all.
  list.classList.toggle('intro',
    !renderList.painted && !document.documentElement.hasAttribute('data-boot'));
  renderList.painted = true;

  list.replaceChildren();

  state.groups = groupByRole(state.filtered);
  const groups = [...state.groups.values()];

  // Counted in ROLES, matching the cards on screen. A role advertised in
  // twenty-one cities is one row here and says so on its own face.
  const n = groups.length;
  $('result-count').textContent = state.jobs.length === 0
    ? 'nothing on the radar yet'
    : `${n} ${n === 1 ? 'role' : 'roles'}${anyFilterActive() ? ` / ${state.jobs.length}` : ''}`;
  $('reset').hidden = !anyFilterActive();

  const empty = $('empty');
  if (n === 0) {
    empty.hidden = false;
    if (state.jobs.length === 0) {
      $('empty-title').textContent = 'Warming up';
      $('empty-body').textContent = 'No listings have been published here yet. New roles appear within minutes of going live.';
    } else if (!anyFilterActive()) {
      $('empty-title').textContent = 'No engineering roles yet';
      $('empty-body').textContent = 'Nothing software-side has been posted in this window. New roles appear within minutes of going live.';
    } else {
      $('empty-title').textContent = 'Radar clear';
      $('empty-body').textContent = 'Nothing matches those filters. Try clearing the search or widening the company filter.';
    }
    return;
  }
  empty.hidden = true;

  /* New since the last visit first, then everything the reader has already
     had the chance to see, dimmed. A first-time visitor sees neither, because
     "all 297 of these are new" is not information. Counted in roles, like the
     list. The line that said "N new since your last visit" above them is gone
     at his request (26 Sep 2026) — the shelf tabs took its place, and every
     tab and shelf still carries its own "+N new". */
  const split = splitNewSince(groups, state.since, $('f-sort').value || 'newest');
  document.documentElement.dataset.newsince = String(split.n);
  const seen = new Set(split.seen);

  const frag = document.createDocumentFragment();

  /* DID THE RANKING ACTUALLY DO ANYTHING? Said once, plainly, because the cards
     cannot say it: a role scoring a genuine 0% draws no fit line, so without
     this a reader whose resume matches little sees a reordered board, no
     numbers at all and a toast claiming success. Measured on the live boards,
     a resume from outside engineering drew a fit line on 3 of 399 India roles
     and 0 of 124 UK ones — which is exactly how this feature came to be
     reported as not working. */
  const cov = rankCoverage();
  if (cov && cov.total) {
    const bar = el('li', 'rank-bar');
    bar.setAttribute('role', 'status');
    if (aiScores.size) {
      bar.append(el('b', null, `${aiScores.size} roles read by AI`));
      bar.append(el('span', null, ' · scored against your resume, with a reason on each card'));
    } else if (cov.shown === 0) {
      bar.append(el('b', null, 'Nothing here matched your resume'));
      bar.append(el('span', null, ` — none of these ${cov.total} roles names a skill it mentions. This board is engineering-only, so a resume from another field will score low on word overlap.`));
    } else {
      bar.append(el('b', null, `${cov.shown} of ${cov.total} roles matched`));
      const tail = [];
      if (cov.silent) tail.push(`${cov.silent} matched none of your skills`);
      if (cov.unscorable) tail.push(`${cov.unscorable} named too few skills to judge`);
      bar.append(el('span', null, tail.length ? ` · ${tail.join(' · ')}` : ' · ranked against your resume'));
    }
    if (!aiScores.size) {
      const go = el('button', 'rank-ai', `Read the top ${RANK_BATCH} with AI →`);
      go.type = 'button';
      go.addEventListener('click', startAiRank);
      bar.append(go);
    }
    frag.append(bar);
  }

  /* THE LIST IS WINDOWED. Every group used to get a card on first paint, which
     was fine when a board held a few hundred roles and is not now: the US board
     groups to 2,961 cards, each carrying a logo, chips, bullets and two
     controls — tens of thousands of nodes. The cost is not the building, it is
     that every later style recalculation has to walk all of them, so switching
     the theme or typing in the search box janked the whole page. India, at 246
     cards, never showed it.

     ONLY THE RENDERING IS WINDOWED. state.groups, the result count, the
     new-first split and every filter still run over the WHOLE set — a reader must
     never be told there are 60 roles because 60 are drawn. */
  renderWindow(list, frag, split.ordered, seen);
}

/** How many cards are drawn before the reader has to scroll for more. Well over
 *  a tall viewport's worth, so the window is invisible until it is scrolled. */
const RENDER_CHUNK = 60;

function renderWindow(list, frag, ordered, seen) {
  /* The previous page's observer would otherwise keep firing against a list it
     no longer owns, appending cards from the old filter into the new one. */
  renderWindow.observer?.disconnect();

  let drawn = 0;
  const draw = (into) => {
    const upto = Math.min(drawn + RENDER_CHUNK, ordered.length);
    for (let i = drawn; i < upto; i++) {
      const group = ordered[i];
      into.append(jobCard(group[0], i, group, seen.has(group)));
    }
    drawn = upto;
  };

  draw(frag);
  list.append(frag);
  if (drawn >= ordered.length) return;

  /* A sentinel rather than a scroll listener: the observer fires once when the
     end of the list nears the viewport and costs nothing in between, where a
     scroll handler runs on every frame of every scroll on a page that is
     already the heavy one. */
  const sentinel = el('li', 'feed-more');
  sentinel.setAttribute('role', 'presentation');
  list.append(sentinel);

  /* No IntersectionObserver — an old browser, or a headless one that never
     reports intersection — draws the whole list rather than stopping at 60. A
     reader seeing every card is the behaviour this replaced; a reader stuck
     at 60 with no way forward is a broken board. */
  if (typeof IntersectionObserver !== 'function') {
    sentinel.remove();
    const rest = document.createDocumentFragment();
    while (drawn < ordered.length) draw(rest);
    list.append(rest);
    return;
  }

  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    const more = document.createDocumentFragment();
    draw(more);
    list.insertBefore(more, sentinel);
    if (drawn >= ordered.length) { io.disconnect(); sentinel.remove(); }
  }, { rootMargin: '600px' });   // start drawing before the reader arrives
  io.observe(sentinel);
  renderWindow.observer = io;
}

function selectJob(id, { silent = false } = {}) {
  state.selectedId = id;
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return;

  for (const card of document.querySelectorAll('.row')) {
    if (card.dataset.id === id) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }

  renderDetail(job);
  // A selection the reader did not make should not claim the URL — otherwise
  // copying the address gives someone a link to a job they never chose.
  if (!silent) history.replaceState(null, '', `#job-${id}`);

  /* 1024, AND IT MUST EQUAL THE MEDIA QUERY IN styles.css THAT OWNS .pane-col.
     This read 1000 while the stylesheet switches the pane to
     `position: fixed; display: none` at 1024 — so between 1001px and 1024px
     inclusive the CSS hid the column and the JS never added `.open`. The
     detail rendered into a pane nobody could see: clicking a role did
     visibly nothing, which is the silent-click signature. 1024x768 is iPad
     landscape and a common small-laptop width, so this was not a corner.
     `test/breakpoint.test.mjs` reads the number out of BOTH files and fails
     if they ever disagree again — a magic number duplicated across two
     languages cannot be held in step by hand. */
  if (matchMedia(`(max-width: ${PANE_OVERLAY_MAX_PX}px)`).matches) {
    $('detail-col').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeDetail() {
  const col = $('detail-col');
  document.body.style.overflow = '';

  // display:none cannot be transitioned, so the pane has to finish its exit
  // animation before it is hidden. Falling back on a timer as well as the event
  // matters: if the animation is suppressed — prefers-reduced-motion, or the
  // desktop layout where the pane is not an overlay — animationend never fires
  // and the pane would be left stuck open.
  if (!col.classList.contains('open')) return;
  col.classList.add('closing');
  const done = () => {
    col.classList.remove('open', 'closing');
    col.removeEventListener('animationend', done);
  };
  col.addEventListener('animationend', done);
  setTimeout(done, 260);
}

function renderDetail(job) {
  const d = $('detail');
  $('detail-placeholder').hidden = true;
  d.hidden = false;
  d.replaceChildren();
  // Which posting the pane shows, for the owner controls (/owner.js).
  d.dataset.jobId = job.id;
  d.scrollTop = 0;
  // Replay the entrance animation on every selection. Dropping the class and
  // re-adding it on the next frame restarts it; reassigning style.animation
  // did not, and left the pane stuck at opacity 0.
  d.classList.remove('is-in');
  requestAnimationFrame(() => d.classList.add('is-in'));

  const back = el('button', 'back');
  back.type = 'button';
  back.textContent = '\u2190 all roles';
  back.addEventListener('click', closeDetail);
  d.append(back);

  d.append(el('div', 'p-co', job.company));
  d.append(el('p', 'p-role', job.title));

  // The other cities this same role is open in.
  //
  // The card collapses them into one row; this is where the collapsed postings
  // become reachable again. Each is a genuinely separate vacancy with its own
  // id, its own page and its own apply link, so every one gets a real link
  // rather than a line of text — otherwise collapsing the card would be the
  // only thing standing between a reader and twenty of the openings.
  const siblings = state.groups.get(roleKey(job)) ?? [job];
  if (siblings.length > 1) {
    d.append(el('div', 'p-loc', `${siblings.length} locations`));
    const places = el('div', 'p-places');
    for (const s of siblings) {
      const a = el('a', s.id === job.id ? 'place is-here' : 'place', cityOf(s.location) || s.location || 'Unspecified');
      a.href = `${REGION_PATH}/jobs/${jobPageSlug(s)}`;
      a.title = s.location || '';
      places.append(a);
    }
    d.append(places);
  } else if (job.location) {
    d.append(el('div', 'p-loc', job.location));
  }

  const actions = el('div', 'p-acts');
  const applyHref = safeUrl(job.applyUrl) || safeUrl(job.url);
  if (applyHref) {
    // Label the destination honestly: ATS listings and, since LinkedIn's
    // redesign, plenty of LinkedIn ones too, apply on the employer's own site.
    const host = (applyHref.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || '';
    const where = /(^|\.)linkedin\.com$/i.test(host) ? 'LinkedIn' : 'company site';
    // Plain label. The drawn arrow and the .apply-glow wrapper are gone with
    // the ambient loop they existed for — the wrapper's only job was letting a
    // halo escape the overflow:hidden the sheen needed, and there is no sheen.
    const apply = el('a', 'go');
    apply.href = applyHref;
    apply.target = '_blank';
    apply.rel = 'noopener noreferrer';
    apply.textContent = 'Apply on ' + where;
    apply.addEventListener('click', () => window.IDEngage?.onApply());
    actions.append(apply);
  }

  const tailorBtn = el('button', 'alt');
  tailorBtn.type = 'button';
  tailorBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 11.8l-1.4 1.4M3 21l9-9"/>'
    + '<circle cx="15" cy="9" r="3"/></svg>';
  tailorBtn.append(document.createTextNode('Tailor my resume'));
  tailorBtn.addEventListener('click', () => openTailor(job));
  actions.append(tailorBtn);

  // The job's own page. Two reasons it belongs here: it is the only way to get a
  // link to one role that survives being pasted into a WhatsApp group, and it is
  // the internal link that lets a crawler reach a page the feed otherwise hides
  // behind JavaScript.
  const page = el('a', 'alt', 'Open full page ↗');
  page.href = `${REGION_PATH}/jobs/${jobPageSlug(job)}`;
  actions.append(page);

  d.append(actions);

  const bar = trackBar(job);
  if (bar) d.append(bar);

  const facts = el('dl', 'facts');
  const addFact = (label, value, cls) => {
    if (!value) return;
    const f = el('div', 'fact');
    f.append(el('dt', null, label), el('dd', cls, value));
    facts.append(f);
  };
  addFact('mode', job.workplaceType || '\u2014');
  addFact('duration', job.duration || '\u2014');
  // Computed from the timestamp, NOT from postedText. postedText is the string
  // LinkedIn showed at the moment the scraper opened the posting — "4 minutes
  // ago" — and it never ages. Preferring it meant the detail pane still read
  // "4 minutes ago" a day later, while the card beside it correctly read "22h"
  // from shortAge(postedAt). On a site whose whole promise is BE EARLY, that is
  // the worst possible field to get wrong: every stale posting looked brand new.
  // postedText is kept only as a fallback for a row with no parsed timestamp.
  addFact('posted', relTime(job.postedAt) || job.postedText);
  if (job.applicants) addFact('applicants', job.applicants);
  d.append(facts);

  if (job.summary) {
    d.append(el('h3', null, 'the role'));
    d.append(el('p', 'p-gist', job.summary));
  }

  if (job.skills?.length) {
    d.append(el('h3', null, 'skills'));
    const row = el('div', 'chips');
    for (const s of job.skills) row.append(el('span', 'chip', s));
    d.append(row);
  }

  const note = el('p', 'src');
  note.append(document.createTextNode('This is an automatic summary. '));
  const sourceHref = safeUrl(job.url);
  if (sourceHref) {
    // A careers-board row's source is the employer's own site, not LinkedIn;
    // naming LinkedIn on it was a false sentence on the pane.
    const onLinkedIn = /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(sourceHref);
    const link = el('a', null, onLinkedIn ? 'Read the full posting on LinkedIn' : 'Read the full posting on the employer\'s site');
    link.href = sourceHref;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    note.append(link, document.createTextNode(' before you apply — it is the source of truth.'));
  } else {
    note.append(document.createTextNode('Check the original posting before you apply — it is the source of truth.'));
  }
  d.append(note);
}

/**
 * The tracker strip in the detail pane — the FULL ladder, plus notes and a
 * follow-up date.
 *
 * Built by IDTrack.strip, which page.js also uses for a job page's side rail.
 * The card deliberately offers one step and no way to reach the rest; this is
 * the surface where somebody is looking at one role and can reasonably be
 * asked to pick from seven, write a note, and set a date.
 *
 * NOT subscribed to the store. renderDetail() rebuilds this element on every
 * role selection, so a self-registered listener would leak one dead closure per
 * click. paintTrackers() — which IS registered, once — repaints it instead.
 */
function trackBar(job) {
  if (!window.IDTrack) return null;
  return window.IDTrack.strip(job, {
    appsHref: `${REGION_PATH}/applications`,
    onChange: paintTrackers,
  });
}

/* ---------------- resume tailoring ---------------- */

let activeJob = null;

/* ONE QUESTION PER SCREEN. The dialog used to put the upload box, the key panel,
   a privacy warning and the button on one screen, and a reader could not tell
   which came first. It is a wizard now: the resume, then the key, then a review
   with one button. Rank mode is the first screen alone, because ranking needs no
   key; 'ai-rank' is the key screen alone, opened when "Read the top N with AI"
   is pressed without one.
   @type {'tailor'|'rank'|'ai-rank'} */
let tailorMode = 'tailor';
// "Use a different key" reopens the form over a key that is already saved.
let replacingKey = false;
// A read in progress, or the reason a file was refused. null when there is
// nothing to say. The resume screen is drawn from this plus state.resumeText.
let resumeNote = null;

const WIZARD = ['upload', 'key', 'review'];
const SCREENS = [...WIZARD, 'working', 'result', 'error'];

const resumeTextNow = () => (state.resumeText || $('resume-paste')?.value || '').trim();
const resumeReady = () => resumeTextNow().length >= 200;

/**
 * @param {object|null} job  null opens the dialog in RANK mode: no role to
 *   rewrite against, so it scores the whole board and sorts by fit instead.
 * @param {{mode?: 'ai-rank'}} [opts]  'ai-rank' asks for the key and nothing else.
 */
function openTailor(job, { mode } = {}) {
  activeJob = job;
  tailorMode = mode || (job ? 'tailor' : 'rank');
  replacingKey = false;

  // [title, subtitle, resume screen lede, key screen lede]
  const copy = {
    tailor: ['Tailor your resume', job ? `${job.company} · ${job.title}` : '',
      'A PDF works best. It is read right here in your browser.',
      'Tailoring runs on Google’s AI with your own key. Getting one is free and takes about a minute.'],
    rank: ['Rank the board', 'Every open role, sorted by fit with your resume',
      'Each open role is scored against it on this device. No key needed.', ''],
    'ai-rank': [`Read the top ${RANK_BATCH} with AI`, 'An AI reads each posting against your resume', '',
      `Google’s AI reads the top ${RANK_BATCH} roles against your resume, on your own key. Getting one is free and takes about a minute.`],
  }[tailorMode];
  $('tailor-title').textContent = copy[0];
  $('tailor-job').textContent = copy[1];
  const lede = $('upload-p');
  if (lede) lede.textContent = copy[2];
  const keyLede = $('key-p');
  if (keyLede && copy[3]) keyLede.textContent = copy[3];
  // Ranking never leaves this device, so the advice about what to strip before
  // sending a resume to Google would be noise there.
  const hint = $('upload-hint');
  if (hint) hint.hidden = tailorMode !== 'tailor';

  syncKeyUi();
  renderResume();
  // Pick up where the reader left off: a resume and a key from an earlier role
  // go straight to the review, rather than walking the same two screens again.
  const first = tailorMode === 'ai-rank' ? 'key'
    : tailorMode === 'rank' || !resumeReady() ? 'upload'
    : !hasKey() ? 'key' : 'review';
  showStep(first, { animate: false });
  $('tailor-backdrop').hidden = false;
  $('tailor').hidden = false;
  document.body.style.overflow = 'hidden';
  focusStep(first);
}

function closeTailor() {
  $('tailor').hidden = true;
  $('tailor-backdrop').hidden = true;
  if (!$('detail-col').classList.contains('open')) document.body.style.overflow = '';
}

/**
 * Swap the visible screen. Moving forward slides the new screen in from the
 * right, moving back from the left, so the direction of travel is legible.
 * WAAPI rather than a CSS class: the global reduced-motion rule only reaches
 * CSS animations, so this checks the preference itself and cross-fades instead.
 */
function showStep(name, { animate = true } = {}) {
  const modal = $('tailor');
  const from = modal?.dataset.step;
  for (const s of SCREENS) {
    const node = $(`step-${s}`);
    if (node) node.hidden = s !== name;
  }
  if (modal) modal.dataset.step = name;
  const body = modal?.querySelector('.modal-body');
  if (body) body.scrollTop = 0;
  if (name === 'review') syncReview();
  syncFooter();
  syncPrimary();

  const node = $(`step-${name}`);
  if (!animate || !from || from === name || !node?.animate) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const back = SCREENS.indexOf(name) < SCREENS.indexOf(from);
  node.animate(reduce
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: `translateX(${back ? -14 : 14}px)` }, { opacity: 1, transform: 'none' }],
  { duration: reduce ? 160 : 240, easing: 'cubic-bezier(.2,.9,.25,1)' });
}

function goTo(name) {
  showStep(name);
  focusStep(name);
}

/* Focus lands on the screen's heading so a screen reader announces where the
   reader now is. The key screen is the exception on a desktop, where the next
   thing anyone does is paste; on a phone that would throw the keyboard up over
   the instructions for getting a key. */
function focusStep(name) {
  const input = $('ai-key');
  const target = name === 'key' && input && !$('key-form')?.hidden
    && matchMedia('(pointer: fine)').matches
    ? input
    : $(`step-${name}`)?.querySelector('.tw-h');
  target?.focus({ preventScroll: true });
}

/* The footer holds Back and the one primary action for the screen on show. It
   is a single bar outside the scrolling body, so the action never scrolls away. */
function syncFooter() {
  const step = $('tailor')?.dataset.step;
  const foot = $('tw-foot');
  if (foot) foot.hidden = !WIZARD.includes(step);
  const primary = { upload: 'resume-next', key: 'key-next', review: 'do-tailor' };
  for (const [s, id] of Object.entries(primary)) {
    const btn = $(id);
    if (btn) btn.hidden = s !== step;
  }
  const back = $('tw-back');
  if (back) back.hidden = tailorMode !== 'tailor' || step === 'upload';
}

function goBack() {
  const step = $('tailor')?.dataset.step;
  goTo(step === 'review' ? 'key' : 'upload');
}

function syncReview() {
  const role = $('sum-role');
  if (role && activeJob) role.textContent = `${activeJob.title} at ${activeJob.company}`;
  const res = $('sum-resume');
  if (res) res.textContent = state.resumeLabel || 'Pasted text';
}

/**
 * @param {string} text
 * @param {string} label  the file name when ok, otherwise what went wrong
 * @param {boolean} [ok]
 * @param {{busy?: boolean}} [opts]  a read in progress rather than a refusal
 */
function setResumeText(text, label, ok = true, { busy = false } = {}) {
  state.resumeText = ok ? text : '';
  state.resumeLabel = ok ? label : '';
  resumeNote = ok ? null : { text: label, busy };
  syncRelevance();
  renderResume();
  syncPrimary();
}

/* The resume screen is DRAWN from state, never patched: a read file, a paste long
   enough to use, a read in progress and a refusal are four states of one box,
   and patching them one at a time is how two of them end up on screen at once. */
function renderResume() {
  const box = $('file-state');
  if (!box) return;
  const ready = resumeReady();
  const zone = $('dropzone');
  if (zone) zone.hidden = ready;

  if (ready) {
    const tick = el('span', 'fs-tick', '✓');
    tick.setAttribute('aria-hidden', 'true');
    const info = el('span', 'fs-info');
    info.append(
      el('b', 'fs-name', state.resumeLabel || 'Pasted text'),
      el('span', 'fs-meta', `${resumeTextNow().length.toLocaleString()} characters read`),
    );
    const remove = el('button', 'bare fs-remove', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', clearResume);
    box.className = 'filestate is-ready';
    box.replaceChildren(tick, info, remove);
    box.hidden = false;
  } else if (resumeNote) {
    box.className = `filestate ${resumeNote.busy ? 'is-busy' : 'bad'}`;
    box.replaceChildren(el('span', null, resumeNote.text));
    box.hidden = false;
  } else {
    box.hidden = true;
    box.replaceChildren();
  }
}

function clearResume() {
  state.resumeText = '';
  state.resumeLabel = '';
  resumeNote = null;
  const file = $('resume-file');
  if (file) file.value = '';
  const paste = $('resume-paste');
  if (paste) paste.value = '';
  syncRelevance();
  renderResume();
  syncPrimary();
  $('dropzone')?.focus();
}

async function extractPdfText(file) {
  const pdfjs = await import(`${PDFJS_BASE}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();

    // Rebuild line structure from glyph positions — a flat join loses the line
    // breaks that make a resume readable to the model.
    let lastY = null;
    let line = [];
    const lines = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join(' ').replace(/\s+/g, ' ').trim());
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) lines.push(line.join(' ').replace(/\s+/g, ' ').trim());
    pages.push(lines.filter(Boolean).join('\n'));
  }
  return pages.join('\n\n').trim();
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    setResumeText('', 'That file is over 5 MB. Try exporting a smaller PDF.', false);
    return;
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isTxt = file.type === 'text/plain' || /\.txt$/i.test(file.name);
  if (!isPdf && !isTxt) {
    setResumeText('', 'Please upload a PDF (or a .txt file).', false);
    return;
  }

  setResumeText('', `Reading ${file.name}…`, false, { busy: true });

  try {
    const text = isTxt ? await file.text() : await extractPdfText(file);
    if (text.trim().length < 200) {
      setResumeText('', 'Almost no text could be read. If this is a scanned or image-based PDF, paste your resume as text instead.', false);
      return;
    }
    setResumeText(text, file.name, true);
  } catch {
    setResumeText('', 'That PDF could not be read. Try pasting the text instead, just below.', false);
  }
}

async function runTailor() {
  const resumeText = resumeTextNow();
  if (resumeText.length < 200) {
    setResumeText('', 'Please provide a bit more of your resume, at least a couple of hundred characters.', false);
    showStep('upload');
    return;
  }

  /* RANK MODE NEEDS NO KEY AND NO NETWORK. There is no role to rewrite
     against; all that is left is to score the board locally and sort by fit.
     That stays free and instant for everyone, with or without an API key.
     TWO ORDERING BUGS LIVED IN THESE FOUR LINES.
     1. It called setResumeHay(resumeText) from the LOCAL variable and then
        syncRelevance(), which re-reads state.resumeText — so whenever the two
        disagreed the haystack was wiped a line after being set and the board
        ranked against nothing while the toast said it had worked. state is the
        single source of truth now.
     2. It set f-sort to "match" BEFORE syncRelevance() created that option.
        Assigning a <select>.value to a value with no matching <option> is a
        silent no-op — the select keeps "new" and the board stays in date
        order. It only appeared to work because the upload handler happened to
        call syncRelevance() first. */
  if (tailorMode !== 'tailor' || !activeJob) {
    state.resumeText = resumeText;
    syncRelevance();               // creates the "best for me" option
    $('f-sort').value = 'match';   // only now can this take
    applyFilters();
    closeTailor();
    const cov = rankCoverage();
    toast(cov && cov.shown === 0
      ? 'Ranked — but nothing here matched your resume.'
      : `Ranked ${cov?.shown ?? 0} of ${cov?.total ?? 0} roles against your resume.`);
    return;
  }

  if (!hasKey()) {
    /* Unreachable through the UI: the review screen is only reached with a key,
       and syncPrimary() disables its button without one. Kept because the guard
       is what makes that true rather than merely likely. §1: a guard that is
       only safe because of its callers is worth keeping at four lines. */
    goTo('key');
    return;
  }

  const labels = ['Reading your resume…', 'Comparing it to the role…', 'Rewriting for this job…', 'Almost there…'];
  // Reset, or a second run opens on the last run's "Almost there…".
  $('working-label').textContent = labels[0];
  showStep('working');
  let i = 0;
  const tick = setInterval(() => {
    i = Math.min(i + 1, labels.length - 1);
    $('working-label').textContent = labels[i];
  }, 4200);

  try {
    /* STRAIGHT TO GOOGLE FROM THIS BROWSER, on the reader's own key. Nothing is
       posted to interndoor.com at all, so neither the key nor the resume ever
       reaches a server of ours to be logged, rate-limited or leaked — which is
       a stronger promise than the one the footer already makes. */
    const tailored = await tailorWithAI({ key: getKey(), resumeText, job: activeJob });

    state.tailored = tailored;
    renderTailored(tailored);
    showStep('result');
    toast('resume tailored');
  } catch (err) {
    $('error-text').textContent = err.message;
    showStep('error');
  } finally {
    clearInterval(tick);
  }
}

/* ---------------- AI ranking, on the reader's own key ----------------
 *
 * The local ranker scores the WHOLE board on skill overlap, free, offline and
 * instantly, and that stays the no-key path. This re-reads only the best
 * RANK_BATCH of what the reader is actually looking at, in ONE request, and
 * replaces those scores with a judgement that read the posting rather than
 * counting word overlap.
 *
 * WHY A SHORTLIST. The US board is 3,884 roles. Sending them all would be slow
 * and would spend the reader's own money to re-derive an order the local pass
 * has already got roughly right; what the model is for is fixing the order at
 * the top, and scoring roles whose skill list was too thin to judge. When every
 * local score ties — which is what a resume from outside engineering produces —
 * the shortlist falls back to the newest 40, which is the honest default.
 */

let rankInFlight = null;

async function startAiRank() {
  const resumeText = resumeTextNow();
  if (resumeText.length < 200) { openTailor(null); return; }
  // The key screen alone, which says why it is asking and ranks once it is saved.
  if (!hasKey()) { openTailor(null, { mode: 'ai-rank' }); return; }

  rankInFlight?.abort();
  const ctl = new AbortController();
  rankInFlight = ctl;

  const btn = document.querySelector('.rank-ai');
  const reset = () => { if (btn) { btn.disabled = false; btn.textContent = `Read the top ${RANK_BATCH} with AI →`; } };

  /* ELAPSED SECONDS, NOT A FAKE PROGRESS BAR. This is ONE request and Google
     streams nothing back, so there is no completion fraction to report and
     inventing one would be a lie the reader can time. Measured at 16-25s for
     25 roles, so a still button reads as broken well before it is; a counter
     that is visibly moving reads as working. */
  let elapsed = 0;
  let attempt = 1;
  const label = () => {
    if (!btn) return;
    const wait = attempt > 1 ? ` · retry ${attempt}` : '';
    btn.textContent = `Reading ${RANK_BATCH} postings… ${elapsed}s${wait}`;
  };
  if (btn) { btn.disabled = true; }
  label();
  const tick = setInterval(() => { elapsed += 1; label(); }, 1000);

  try {
    const pool = state.filtered.length
      ? state.filtered
      : state.jobs.filter((j) => kindOf(j) === state.kind && catOf(j) === state.cat);
    const picked = shortlist(pool, (j) => matchFor(j)?.pct ?? null, RANK_BATCH);
    const scores = await rankWithAI({
      key: getKey(),
      resumeText,
      jobs: picked,
      signal: ctl.signal,
      // Google 503s often enough that a silent retry looks like a hang.
      onAttempt: (n) => { attempt = n; label(); },
    });
    if (ctl.signal.aborted) return;
    if (!scores.size) {
      toast('The AI returned no usable scores — the skill ranking is unchanged.');
      reset();
      return;
    }
    aiScores = scores;
    resetMatchCache();
    $('f-sort').value = 'match';
    applyFilters();               // redraws the bar, which now hides the button
    toast(`${scores.size} roles read and scored by AI.`);
  } catch (err) {
    if (ctl.signal.aborted) return;
    toast(err.message || 'That did not work.');
    reset();
  } finally {
    clearInterval(tick);
    if (rankInFlight === ctl) rankInFlight = null;
  }
}

/* ---------------- the key screen ----------------
 *
 * THE STORED KEY IS NEVER RENDERED BACK INTO THE INPUT. Putting it on screen
 * would leak it into any screenshot or screen share, and there is no reason a
 * reader needs to re-read a key they already saved — the same care §12 records
 * after the owner token was printed by a page and had to be rotated.
 */

/**
 * THE ONE PLACE THAT DECIDES WHETHER A PRIMARY BUTTON CAN BE PRESSED.
 *
 * It used to be set from three separate places and none of them knew about the
 * key, so with no key the button sat there bright and enabled and the ONLY way
 * to find out tailoring needs one was to press it and be shown an error screen.
 * Each screen now has its own primary, and all three are decided here:
 *   Continue      needs a resume
 *   the key step  needs a key typed, or one already saved
 *   Tailor        needs both, and is never reached without them
 * Ranking never needs a key, so in rank mode the first button does the ranking.
 */
function syncPrimary() {
  const haveResume = resumeReady();
  const haveKey = hasKey();
  const typed = ($('ai-key')?.value || '').trim().length > 0;
  const aiRank = tailorMode === 'ai-rank';

  const next = $('resume-next');
  if (next) {
    next.disabled = !haveResume;
    next.textContent = tailorMode === 'tailor' ? 'Continue' : 'Rank the board';
  }

  const keyNext = $('key-next');
  if (keyNext) {
    keyNext.disabled = !typed && !haveKey;
    keyNext.textContent = typed || !haveKey
      ? (aiRank ? 'Save key and rank' : 'Save key and continue')
      : (aiRank ? 'Rank with AI' : 'Continue');
  }

  const go = $('do-tailor');
  if (go) {
    const needsKey = !haveKey;
    go.disabled = !haveResume || needsKey;
    go.textContent = needsKey ? 'Add your key to tailor' : 'Tailor my resume';
  }
  syncSteps();
}

/**
 * Resume, Google AI key, Tailor — as a three-part bar under the title. Lime marks
 * the screen you are on and the ones you have finished; that is status, which
 * is what the accent is for. Rank mode and the AI-rank key screen are a single
 * screen each, and a progress bar with one part says nothing, so it hides.
 */
function syncSteps() {
  const bar = $('wiz');
  if (!bar) return;
  const at = $('tailor')?.dataset.step;
  const tailoring = tailorMode === 'tailor';
  bar.hidden = !tailoring || at === 'result';
  const done = { upload: resumeReady(), key: hasKey(), review: false };
  for (const li of bar.querySelectorAll('.wstep')) {
    const s = li.dataset.wiz;
    // Past the review the last part stays current: the tailoring IS that step.
    const now = s === at || (s === 'review' && !WIZARD.includes(at));
    li.classList.toggle('is-now', now);
    li.classList.toggle('is-done', !now && Boolean(done[s]));
    if (now) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function syncKeyUi() {
  const have = hasKey();
  // With a key saved there is nothing to fill in: the form gives way to one
  // line saying so, and to the two things a reader might still want.
  const showForm = !have || replacingKey;
  const form = $('key-form');
  if (form) form.hidden = !showForm;
  const set = $('key-set');
  if (set) set.hidden = showForm;

  const head = $('key-h');
  if (head) head.textContent = showForm ? 'Connect Google AI' : 'Google AI is connected';

  const input = $('ai-key');
  if (input) input.value = '';
  showKeyMsg('');
  syncPrimary();
}

function showKeyMsg(text) {
  const msg = $('key-msg');
  if (msg) msg.textContent = text;
  $('ai-key')?.setAttribute('aria-invalid', text ? 'true' : 'false');
}

/* Saves what was typed, if anything, then moves on. Shape only: whether a key
   WORKS is settled by using it — §13's rule that a configured credential is
   checked by using it, not by inspecting it. */
function submitKey() {
  const input = $('ai-key');
  const v = (input?.value || '').trim();
  if (v) {
    if (!looksLikeKey(v)) {
      showKeyMsg('That does not look like a Google AI key. They start with AIza or AQ.');
      input?.focus();
      return;
    }
    if (!setKey(v)) {
      showKeyMsg('This browser would not save the key. A private window blocks it.');
      return;
    }
    replacingKey = false;
    syncKeyUi();
    toast('Key saved.');
  } else if (!hasKey()) {
    input?.focus();
    return;
  }

  if (tailorMode === 'ai-rank') {
    closeTailor();
    startAiRank();
    return;
  }
  goTo('review');
}

function renderTailored(t) {
  const removed = $('removed-note');
  if (t.removedSkills?.length) {
    removed.hidden = false;
    removed.replaceChildren(
      el('b', null, 'Some skills were removed'),
      el('span', null, `These appeared in the draft but not in your resume, so they were stripped out rather than left in as claims you cannot back up: ${t.removedSkills.join(', ')}.`),
    );
  } else {
    removed.hidden = true;
  }

  const gaps = $('gaps-note');
  if (t.gaps?.length) {
    gaps.hidden = false;
    gaps.replaceChildren(el('b', null, 'What this role wants that your resume does not show'));
    const ul = el('ul');
    for (const g of t.gaps) ul.append(el('li', null, g));
    gaps.append(ul);
  } else {
    gaps.hidden = true;
  }

  const changes = $('changes');
  changes.replaceChildren();
  if (t.changeNotes?.length) {
    changes.append(el('h4', null, 'What changed'));
    const ul = el('ul');
    for (const c of t.changeNotes) ul.append(el('li', null, c));
    changes.append(ul);
  }

  const p = $('resume-preview');
  p.replaceChildren();
  if (t.name) p.append(el('div', 'r-name', t.name));
  if (t.contact) p.append(el('div', 'r-contact', t.contact));
  if (t.summary) p.append(el('p', 'r-summary', t.summary));

  for (const section of t.sections ?? []) {
    const sec = el('section', 'r-sec');
    sec.append(el('h5', null, section.heading));
    for (const item of section.items ?? []) {
      const box = el('div', 'r-item');
      const head = el('div', 'r-item-head');
      const left = el('div');
      if (item.title) left.append(el('span', 'r-role', item.title));
      if (item.org) {
        left.append(document.createTextNode(' — '));
        left.append(el('span', 'r-org', item.org));
      }
      head.append(left);
      if (item.dates) head.append(el('span', 'r-dates', item.dates));
      box.append(head);
      if (item.bullets?.length) {
        const ul = el('ul');
        for (const b of item.bullets) ul.append(el('li', null, b));
        box.append(ul);
      }
      sec.append(box);
    }
    p.append(sec);
  }

  if (t.skills?.length) {
    const sec = el('section', 'r-sec');
    sec.append(el('h5', null, 'Skills'));
    sec.append(el('div', 'r-skills', t.skills.join(' · ')));
    p.append(sec);
  }
}

function resumeAsText(t) {
  const out = [t.name, t.contact, '', t.summary, ''];
  for (const s of t.sections ?? []) {
    out.push(String(s.heading || '').toUpperCase(), '');
    for (const item of s.items ?? []) {
      out.push([item.title, item.org].filter(Boolean).join(' — ') + (item.dates ? `  (${item.dates})` : ''));
      for (const b of item.bullets ?? []) out.push(`  • ${b}`);
      out.push('');
    }
  }
  if (t.skills?.length) out.push('SKILLS', '', t.skills.join(' · '));
  return out.filter((l) => l !== undefined).join('\n');
}

/* ---------------- wiring ---------------- */

/**
 * The filter strip scrolls sideways on a phone and is faded at its right edge
 * so the overflow reads as "more this way" rather than as a clipped layout.
 * Once you reach the end there is nothing more to hint at, so the fade is
 * removed — otherwise the last chip looks permanently faded out.
 */
function wireFilterStrip() {
  const strip = document.querySelector('.picks');
  if (!strip) return;
  const sync = () => {
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
    strip.classList.toggle('at-end', atEnd);
  };
  strip.addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', sync, { passive: true });
  sync();
}

function wireControls() {
  const rerun = () => { syncUrl(); applyFilters(); };
  wireFilterStrip();

  // Internship / full-time. A real tablist rather than a filter dropdown,
  // because it is the one choice that changes what the board IS rather than
  // narrowing it — and the selection has to survive the detail pane, so it
  // clears the selected job when it flips.
  for (const btn of document.querySelectorAll('#seg-kind .seg-b')) {
    btn.addEventListener('click', () => setKind(btn.dataset.kind));
  }

  $('q').addEventListener('input', () => {
    $('clear-q').hidden = !$('q').value;
    rerun();
  });
  $('clear-q').addEventListener('click', () => {
    $('q').value = '';
    $('clear-q').hidden = true;
    rerun();
    $('q').focus();
  });
  for (const id of ['f-company', 'f-location', 'f-mode', 'f-sort']) {
    $(id).addEventListener('change', rerun);
  }

  $('reset').addEventListener('click', () => {
    $('q').value = '';
    $('clear-q').hidden = true;
    for (const id of ['f-company', 'f-location', 'f-mode']) $(id).value = '';
    $('f-sort').value = 'new';
    rerun();
  });
}

function wireTailor() {
  $('tailor-close').addEventListener('click', closeTailor);
  $('tailor-backdrop').addEventListener('click', closeTailor);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('tailor').hidden) closeTailor();
    else if ($('detail-col').classList.contains('open')) closeDetail();
  });

  const zone = $('dropzone');
  const input = $('resume-file');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => handleFile(input.files[0]));

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  zone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

  $('resume-paste').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v.length >= 200) { setResumeText(v, 'Pasted text', true); return; }
    state.resumeText = v;
    state.resumeLabel = '';
    resumeNote = null;
    syncRelevance();
    renderResume();
    syncPrimary();
  });

  /* The rail's call to action. No job is attached: this is the "rank the whole
     board" entry point, so openTailor is given null and the modal's per-role
     framing falls back to the generic one. */
  $('rank-resume')?.addEventListener('click', () => openTailor(null));

  // The footer: Back, and whichever primary belongs to the screen on show.
  $('tw-back')?.addEventListener('click', goBack);
  $('resume-next')?.addEventListener('click', () => {
    if (tailorMode !== 'tailor') { runTailor(); return; }
    goTo(hasKey() ? 'review' : 'key');
  });
  $('key-next')?.addEventListener('click', submitKey);
  $('do-tailor').addEventListener('click', runTailor);

  const keyInput = $('ai-key');
  keyInput?.addEventListener('input', () => { showKeyMsg(''); syncPrimary(); });
  keyInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('key-next')?.disabled) { e.preventDefault(); submitKey(); }
  });
  $('replace-key')?.addEventListener('click', () => {
    replacingKey = true;
    syncKeyUi();
    focusStep('key');
    $('ai-key')?.focus();
  });
  $('forget-key')?.addEventListener('click', () => {
    forgetKey();
    replacingKey = false;
    syncKeyUi();
    toast('Key forgotten.');
  });

  // "Change" on the review screen goes back to the screen that owns the answer.
  for (const btn of document.querySelectorAll('#step-review [data-go]')) {
    btn.addEventListener('click', () => goTo(btn.dataset.go));
  }

  syncKeyUi();

  $('error-retry').addEventListener('click', () => goTo(tailorMode === 'tailor' && resumeReady() ? 'review' : 'upload'));
  $('start-over').addEventListener('click', () => {
    state.tailored = null;
    clearResume();
    goTo('upload');
  });

  $('download-pdf').addEventListener('click', () => {
    toast('choose Save as PDF');
    setTimeout(() => window.print(), 350);
  });

  $('copy-text').addEventListener('click', async () => {
    if (!state.tailored) return;
    try {
      await navigator.clipboard.writeText(resumeAsText(state.tailored));
      toast('copied');
    } catch {
      toast('could not copy');
    }
  });
}

/**
 * Measure the sticky stack (top bar + filter rail) and publish it as a CSS
 * variable.
 *
 * The detail pane sticks below both of them. Its offset used to be a hardcoded
 * guess, so shrinking the header pushed the pane's heading underneath the rail —
 * and the rail's height is not fixed anyway: it wraps to two or three lines
 * depending on viewport width. Measuring is the only version that stays correct.
 */
function syncStickyOffset() {
  const bar = document.querySelector('.bar');
  const rail = document.querySelector('.rail');
  if (!bar || !rail) return;
  // Count only what is actually pinned. Below 680px the rail goes position:static
  // and scrolls away, so summing it there would reserve ~290px of offset that
  // nothing occupies and push the listings down behind a gap.
  const h = [bar, rail]
    .filter((el) => getComputedStyle(el).position === 'sticky')
    .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
  document.documentElement.style.setProperty('--stack-h', `${Math.round(h)}px`);
}

/* ---------------- boot ---------------- */

/**
 * Every visible element the intro brings back, each on its own.
 *
 * Individual elements rather than their containers: the point of the sequence
 * is that the interface unfolds out of the mark, and a container can only move
 * as one block. Anything not listed simply appears with its parent when the
 * attribute is dropped, which is the right outcome for wrappers and for the
 * things a reader is not looking at yet.
 */
const BOOT_PARTS = [
  '.brand .word', '.bar-right > *',
  '.lede h1', '.lede p',
  '.rail .seg', '.rail .find', '.rail .picks > *',
  '.feed-head', '.feed > li', '.void', '.pane-col',
  '.signup-band .sub-l', '.signup-band .sub-row',
];

/* How far back along the line from the mark each element starts, and how long
   the outermost one waits. The step SCALES WITH DISTANCE (7% of it, floored at
   12px and capped at 52) because a fixed step did not read: near the logo it
   was invisible, far from it the page just faded, so the whole thing looked
   like everything appearing at once rather than anything radiating.
   BOOT_LAG is the spread across the whole page, not a per-element delay — 60ms
   is under the threshold at which a sequence reads as a sequence, and it is
   what lets the eye catch the direction of travel. */
const BOOT_MIN = 12;
const BOOT_MAX = 52;
const BOOT_SPAN = 0.07;
const BOOT_LAG = 60;

/**
 * The page-load intro: measure the journey, let it play, clear up.
 *
 * ONE ELEMENT. The masthead's own radar is what animates — it starts large and
 * centred, sweeps once, then travels into its resting place and stays there,
 * because it was never a copy. There is no overlay to remove and no second logo
 * to cross-fade; the previous version faded one out while fading another in,
 * which is precisely what read as a cut rather than a transformation.
 *
 * The MOTION is entirely in CSS — it runs off the main thread, and the main
 * thread is busy parsing and rendering the board for exactly the window this
 * plays in. This does what CSS cannot: work out where the mark has to start
 * from, and give every element the direction it arrives from.
 *
 * THE PARTS ARE TAGGED WHEN THE MARK LANDS, not on a timer, and that is what
 * makes it robust rather than merely tidy. A card created while the radar is
 * still sweeping and one created a moment before it lands both animate at the
 * same instant, because the animation starts when the class is added rather
 * than at some absolute offset the element may have missed.
 *
 * IT NEVER TRAPS ANYONE. A safety timer clears the attribute whatever happens,
 * and the stylesheet carries its own failsafe for the case where this file
 * never arrives at all — the failure mode of an intro must be "no intro".
 */
function runIntro() {
  const root = document.documentElement;
  if (!root.hasAttribute('data-boot')) return;

  const mark = document.querySelector('.bar .brand .scope');
  if (!mark) { root.removeAttribute('data-boot'); return; }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    root.removeAttribute('data-boot');
    for (const el of document.querySelectorAll('.boot-part')) el.classList.remove('boot-part');
    try { sessionStorage.setItem('id-boot', '1'); } catch { /* private mode */ }
  };

  /* WHERE IT STARTS, and where everything else comes from.
     MEASURED WITH THE ANIMATION SUPPRESSED: it has `both` fill, so its own 0%
     keyframe — using the fallback scale — is already applied by the time this
     runs. Measuring straight away returns the mark at several times its size
     and computes a scale from that, and the radar never grows. */
  let centre = null;
  try {
    /* NO SUPPRESSION NEEDED ANY MORE, and that fixed a real bug rather than
       tidying one. The span is never transformed — only the svg inside it is —
       so its rect is always the true resting box. The previous version had to
       blank the animation to measure, which RESTARTED it: invisible here,
       where this runs before the first frame, but on a phone it runs a second
       in and the sweep visibly began again. That is what "more than one sweep,
       and it takes forever on mobile" was. */
    const r = mark.getBoundingClientRect();
    const svg = mark.querySelector('svg');
    if (r.width && svg) {
      /* Smaller again: 250 was a splash, 170 dominated the screen, 120 was
         still the largest thing on it. The mark has to read as a mark.
         The cap is what desktop gets; the vmin term only bites on a phone,
         which is already smaller than the cap. */
      const size = Math.round(Math.min(Math.min(innerWidth, innerHeight) * 0.21, 96));
      svg.style.setProperty('--bw', `${size}px`);
      svg.style.setProperty('--x0', `${innerWidth / 2 - size / 2 - r.left}px`);
      svg.style.setProperty('--y0', `${innerHeight / 2 - size / 2 - r.top}px`);
      /* The resting box, so the size animation lands on it exactly rather than
         on a fraction of a hardcoded number. */
      svg.style.setProperty('--rw', `${r.width}px`);
      centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  } catch { /* fall back to the keyframe's own defaults */ }

  /* Tagged the moment the mark lands. Measured first, applied second: every
     rect is read before a single class goes on, so nothing is measured against
     a page that is already animating — and the step and the delay both need
     the FARTHEST element, which is only known once everything is measured. */
  const unfold = () => {
    if (done) return;
    const parts = [];
    let far = 1;
    for (const sel of BOOT_PARTS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!centre) { parts.push({ el }); continue; }
        const b = el.getBoundingClientRect();
        const dx = (b.left + b.width / 2) - centre.x;
        const dy = (b.top + b.height / 2) - centre.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > far) far = d;
        parts.push({ el, dx, dy, d });
      }
    }
    for (const p of parts) {
      if (p.d) {
        const step = Math.min(Math.max(p.d * BOOT_SPAN, BOOT_MIN), BOOT_MAX);
        p.el.style.setProperty('--tx', `${-(p.dx / p.d) * step}px`);
        p.el.style.setProperty('--ty', `${-(p.dy / p.d) * step}px`);
        p.el.style.setProperty('--bd', `${Math.round((p.d / far) * BOOT_LAG)}ms`);
      }
      p.el.classList.add('boot-part');
    }
    // 320ms each, the last starting 60ms in; clear up once they have arrived.
    setTimeout(finish, 440);
  };

  /* Matched on the target rather than the animation name, so reduced motion —
     where every animation becomes a plain fade and the names all change —
     unfolds on the same line instead of waiting for the safety timer. */
  const svg = mark.querySelector('svg') ?? mark;
  svg.addEventListener('animationend', (e) => { if (e.target === svg) unfold(); });

  /* Skippable on the gestures that mean "I am already here". */
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(ev, finish, { once: true, passive: true });
  }

  setTimeout(finish, 2100);
}

async function init() {
  initTheme();
  runIntro();
  wireControls();
  wireTailor();

  syncStickyOffset();
  // The rail rewraps on resize, and again once the web fonts land and change
  // the text metrics — both move the stack height.
  addEventListener('resize', syncStickyOffset, { passive: true });
  document.fonts?.ready.then(syncStickyOffset);

  await loadJobs();
  /* Hidden here rather than in render(), which also runs on every filter
     change: the scanning state belongs to the FIRST load only, and the empty
     state below it is what speaks after that. */
  const scanning = $('scanning');
  if (scanning) scanning.hidden = true;

  /* Bring already-tracked rows up to date with the live board — a corrected
     title, a recovered apply URL. Only posting fields move; the status, the
     dates and the history are the reader's and are never touched. A tracked
     role that has aged off the board is left exactly as it was, which is the
     whole reason the store keeps a snapshot rather than an id. */
  window.IDTrack?.refresh(state.jobs);
  /* Repaint on any change, including one made in another tab. */
  window.IDTrack?.on(paintTrackers);
  renderTrackCount();
  renderFreshness();
  renderTotal();
  populateFilters();
  readUrl();          // after populateFilters(): the <option>s must exist first

  /* Where the reader left off, decided BEFORE the first paint and written
     back at once, so a crash or a closed tab after this point still counts
     as a visit. Only when the board actually loaded: an empty board must not
     advance the mark past roles the reader never had a chance to see. */
  if (state.jobs.length) {
    const visit = visitSince(readVisit(), Date.now(), latestListed(state.jobs));
    state.since = visit.since;
    writeVisit(visit.next);
    document.documentElement.dataset.visit = visit.returning ? 'return' : 'new';
    renderTabNews();   // renderTotal ran before `since` was known
    renderCatSeg();
  }
  applyFilters();
  loadEngage();

  const hash = location.hash.match(/^#job-(.+)$/);
  const target = hash && state.jobs.find((j) => j.id === hash[1]);
  /* A ROLE IS OPENED ONLY WHEN SOMEBODY ASKS FOR ONE — by clicking, or by
     arriving on a #job- link they were given. Otherwise the pane rests on its
     own placeholder.

     Desktop used to auto-open the newest listing here, to stop the right-hand
     column sitting empty. It solved an empty panel by creating three worse
     problems: the reader lands inside a job they did not choose, the newest
     role is made to look selected rather than merely first, and the pane's own
     "read the full posting" framing is applied to something nobody asked to
     read. The placeholder is the honest state — nothing is selected, so the
     pane says so. */
  /* A link to a role on another tab or shelf brings the reader to that tab and
     shelf, so the card they were sent is in the list beside its pane. */
  if (target) {
    setKind(kindOf(target));
    setCat(catOf(target));
    selectJob(target.id);
  }

  setInterval(renderFreshness, 60000);

  /* A TAB LEFT OPEN NOW CATCHES UP. Only while it is visible: a background tab
     polling every five minutes spends the reader's data and battery on a board
     nobody is looking at, and the visibility handler brings it up to date the
     moment they come back anyway. */
  setInterval(() => { if (!document.hidden) refreshBoard(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBoard(); });
}

init();
