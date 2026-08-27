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
const DATA_URL = meta('interndoor-data') || meta('gradkite-data') || meta('internzo-data') || '/data/jobs.json';
/** '' for India, '/us' and so on for the rest — the prefix every internal link needs. */
const REGION_PATH = DATA_URL.replace(/\/data\/jobs\.json$/, '');

const PDFJS_BASE = '/vendor/pdfjs';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HOT_MS = 60 * 60 * 1000;      // "just posted"
const FRESH_MS = 24 * 60 * 60 * 1000; // "new"

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
  filtered: [],
  // roleKey -> every posting of that role currently on screen, so the detail
  // pane can list a collapsed card's other cities. Rebuilt by renderList.
  groups: new Map(),
  selectedId: null,
  resumeText: '',
  tailored: null,
  generatedAt: null,
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
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    state.jobs = data.jobs ?? [];
    state.generatedAt = data.generatedAt ?? null;
  } catch {
    state.jobs = [];
    state.generatedAt = null;
  }
}

function renderFreshness() {
  // "swept" is this project's own word for one pass of the scraper. Nothing on
  // the page ever taught it, so to a first-time reader the header's only live
  // signal was jargon. "Checked" needs no glossary and claims exactly the same
  // thing — and deliberately less than "updated", which would promise that
  // something NEW arrived on a pass that may well have found nothing.
  $('freshness-text').textContent = state.generatedAt
    ? `checked ${relTime(state.generatedAt)}`
    : 'standing by';
}

/* ---------------- the brand pool ----------------
 *
 * Twenty logos, as inlined SVG path data rather than image files.
 *
 * WHY INLINE. The live CSP is `img-src 'self' data:`, so nothing can be pulled
 * from a logo CDN at runtime and every alternative is a file this repo has to
 * carry. Paths cost about 20KB in a script that is already cached, draw crisp
 * at any size on any display, tint from CSS so the pool can be monochrome
 * without twenty recoloured assets, and cannot 404 — which matters for a
 * decorative wall whose whole job is looking deliberate. The glyphs are
 * Simple Icons (CC0); the marks themselves remain their owners' trademarks and
 * are used here nominatively, to name companies this board tracks.
 *
 * These are NOT filtered against the live board, unlike the employer crests on
 * the cards. They are the watchlist's headline names — checked: 43 of the 44
 * marquee companies tested match `matchCompany` against the real watchlist,
 * Google, Apple, Amazon, Meta, NVIDIA, Tesla and Uber among them — so the
 * caption says what is true of ALL of them ("companies we watch") and states
 * the live count separately. Do not caption this "hiring now": on any given day
 * most of them are not.
 */
const BRANDS = [
  // The real four-colour G, not Simple Icons' single-path outline.
  { n: "Google", c: "#4285F4", vb: "0 0 24 24", g: "<path d=\"M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z\" fill=\"#4285F4\"/><path d=\"M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z\" fill=\"#34A853\"/><path d=\"M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z\" fill=\"#FBBC05\"/><path d=\"M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z\" fill=\"#EA4335\"/><path d=\"M1 1h22v22H1z\" fill=\"none\"/>" },
  { n: "Apple", c: "#000000", d: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" },
  // The real a-smile in black and #f90, not the bare monochrome swoosh.
  { n: "Amazon", c: "#FF9900", vb: "2.167 .438 251.038 259.969", g: "<g fill=\"none\" fill-rule=\"evenodd\"><path d=\"m221.503 210.324c-105.235 50.083-170.545 8.18-212.352-17.271-2.587-1.604-6.984.375-3.169 4.757 13.928 16.888 59.573 57.593 119.153 57.593 59.621 0 95.09-32.532 99.527-38.207 4.407-5.627 1.294-8.731-3.16-6.872zm29.555-16.322c-2.826-3.68-17.184-4.366-26.22-3.256-9.05 1.078-22.634 6.609-21.453 9.93.606 1.244 1.843.686 8.06.127 6.234-.622 23.698-2.826 27.337 1.931 3.656 4.79-5.57 27.608-7.255 31.288-1.628 3.68.622 4.629 3.68 2.178 3.016-2.45 8.476-8.795 12.14-17.774 3.639-9.028 5.858-21.622 3.71-24.424z\" fill=\"#f90\" fill-rule=\"nonzero\"/><path d=\"m150.744 108.13c0 13.141.332 24.1-6.31 35.77-5.361 9.489-13.853 15.324-23.341 15.324-12.952 0-20.495-9.868-20.495-24.432 0-28.75 25.76-33.968 50.146-33.968zm34.015 82.216c-2.23 1.992-5.456 2.135-7.97.806-11.196-9.298-13.189-13.615-19.356-22.487-18.502 18.882-31.596 24.527-55.601 24.527-28.37 0-50.478-17.506-50.478-52.565 0-27.373 14.85-46.018 35.96-55.126 18.313-8.066 43.884-9.489 63.43-11.718v-4.365c0-8.018.616-17.506-4.08-24.432-4.128-6.215-12.003-8.777-18.93-8.777-12.856 0-24.337 6.594-27.136 20.257-.57 3.037-2.799 6.026-5.835 6.168l-32.735-3.51c-2.751-.618-5.787-2.847-5.028-7.07 7.543-39.66 43.36-51.616 75.43-51.616 16.415 0 37.858 4.365 50.81 16.795 16.415 15.323 14.849 35.77 14.849 58.02v52.565c0 15.798 6.547 22.724 12.714 31.264 2.182 3.036 2.657 6.69-.095 8.966-6.879 5.74-19.119 16.415-25.855 22.393l-.095-.095\" fill=\"#000\"/><path d=\"m221.503 210.324c-105.235 50.083-170.545 8.18-212.352-17.271-2.587-1.604-6.984.375-3.169 4.757 13.928 16.888 59.573 57.593 119.153 57.593 59.621 0 95.09-32.532 99.527-38.207 4.407-5.627 1.294-8.731-3.16-6.872zm29.555-16.322c-2.826-3.68-17.184-4.366-26.22-3.256-9.05 1.078-22.634 6.609-21.453 9.93.606 1.244 1.843.686 8.06.127 6.234-.622 23.698-2.826 27.337 1.931 3.656 4.79-5.57 27.608-7.255 31.288-1.628 3.68.622 4.629 3.68 2.178 3.016-2.45 8.476-8.795 12.14-17.774 3.639-9.028 5.858-21.622 3.71-24.424z\" fill=\"#f90\" fill-rule=\"nonzero\"/><path d=\"m150.744 108.13c0 13.141.332 24.1-6.31 35.77-5.361 9.489-13.853 15.324-23.341 15.324-12.952 0-20.495-9.868-20.495-24.432 0-28.75 25.76-33.968 50.146-33.968zm34.015 82.216c-2.23 1.992-5.456 2.135-7.97.806-11.196-9.298-13.189-13.615-19.356-22.487-18.502 18.882-31.596 24.527-55.601 24.527-28.37 0-50.478-17.506-50.478-52.565 0-27.373 14.85-46.018 35.96-55.126 18.313-8.066 43.884-9.489 63.43-11.718v-4.365c0-8.018.616-17.506-4.08-24.432-4.128-6.215-12.003-8.777-18.93-8.777-12.856 0-24.337 6.594-27.136 20.257-.57 3.037-2.799 6.026-5.835 6.168l-32.735-3.51c-2.751-.618-5.787-2.847-5.028-7.07 7.543-39.66 43.36-51.616 75.43-51.616 16.415 0 37.858 4.365 50.81 16.795 16.415 15.323 14.849 35.77 14.849 58.02v52.565c0 15.798 6.547 22.724 12.714 31.264 2.182 3.036 2.657 6.69-.095 8.966-6.879 5.74-19.119 16.415-25.855 22.393l-.095-.095\" fill=\"#000\"/></g>" },
  { n: "Meta", c: "#0467DF", d: "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" },
  { n: "NVIDIA", c: "#76B900", d: "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" },
  { n: "Tesla", c: "#CC0000", d: "M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z" },
  { n: "Uber", c: "#000000", d: "M0 7.97v4.958c0 1.867 1.302 3.101 3 3.101.826 0 1.562-.316 2.094-.87v.736H6.27V7.97H5.082v4.888c0 1.257-.85 2.106-1.947 2.106-1.11 0-1.946-.827-1.946-2.106V7.971H0zm7.44 0v7.925h1.13v-.725c.521.532 1.257.86 2.06.86a3.006 3.006 0 0 0 3.034-3.01 3.01 3.01 0 0 0-3.033-3.024 2.86 2.86 0 0 0-2.049.861V7.971H7.439zm9.869 2.038c-1.687 0-2.965 1.37-2.965 3 0 1.72 1.334 3.01 3.066 3.01 1.053 0 1.913-.463 2.49-1.233l-.826-.611c-.43.577-.996.847-1.664.847-.973 0-1.753-.7-1.912-1.64h4.697v-.373c0-1.72-1.222-3-2.886-3zm6.295.068c-.634 0-1.098.294-1.381.758v-.713h-1.131v5.774h1.142V12.61c0-.894.544-1.47 1.291-1.47H24v-1.065h-.396zm-6.319.928c.85 0 1.564.588 1.756 1.47H15.52c.203-.882.916-1.47 1.765-1.47zm-6.732.012c1.086 0 1.98.883 1.98 2.004a1.993 1.993 0 0 1-1.98 2.001A1.989 1.989 0 0 1 8.56 13.02a1.99 1.99 0 0 1 1.992-2.004z" },
  { n: "Adobe", c: "#FF0000", d: "M13.966 22.624l-1.69-4.281H8.122l3.892-9.144 5.662 13.425zM8.884 1.376H0v21.248zm15.116 0h-8.884L24 22.624Z" },
  { n: "Netflix", c: "#E50914", d: "M5.398 0v.006c3.028 8.556 5.37 15.175 8.348 23.596 2.344.058 4.85.398 4.854.398-2.8-7.924-5.923-16.747-8.487-24zm8.489 0v9.63L18.6 22.951c-.043-7.86-.004-15.913.002-22.95zM5.398 1.05V24c1.873-.225 2.81-.312 4.715-.398v-9.22z" },
  { n: "Intel", c: "#0071C5", d: "M20.42 7.345v9.18h1.651v-9.18zM0 7.475v1.737h1.737V7.474zm9.78.352v6.053c0 .513.044.945.13 1.292.087.34.235.618.44.828.203.21.475.359.803.451.334.093.754.136 1.255.136h.216v-1.533c-.24 0-.445-.012-.593-.037a.672.672 0 0 1-.39-.173.693.693 0 0 1-.173-.377 4.002 4.002 0 0 1-.037-.606v-2.182h1.193v-1.416h-1.193V7.827zm-3.505 2.312c-.396 0-.76.08-1.082.241-.327.161-.6.384-.822.668l-.087.117v-.902H2.658v6.256h1.639v-3.214c.018-.588.16-1.02.433-1.299.29-.297.642-.445 1.044-.445.476 0 .841.149 1.082.433.235.284.359.686.359 1.2v3.324h1.663V12.97c.006-.89-.229-1.595-.686-2.09-.458-.495-1.1-.742-1.917-.742zm10.065.006a3.252 3.252 0 0 0-2.306.946c-.29.29-.525.637-.692 1.033a3.145 3.145 0 0 0-.254 1.273c0 .452.08.878.241 1.274.161.395.39.742.674 1.032.284.29.637.526 1.045.693.408.173.86.26 1.342.26 1.397 0 2.262-.637 2.782-1.23l-1.187-.904c-.248.297-.841.699-1.583.699-.464 0-.847-.105-1.138-.321a1.588 1.588 0 0 1-.593-.872l-.019-.056h4.915v-.587c0-.451-.08-.872-.235-1.267a3.393 3.393 0 0 0-.661-1.033 3.013 3.013 0 0 0-1.02-.692 3.345 3.345 0 0 0-1.311-.248zm-16.297.118v6.256h1.651v-6.256zm16.278 1.286c1.132 0 1.664.797 1.664 1.255l-3.32.006c0-.458.525-1.255 1.656-1.261zm7.073 3.814a.606.606 0 0 0-.606.606.606.606 0 0 0 .606.606.606.606 0 0 0 .606-.606.606.606 0 0 0-.606-.606zm-.008.105a.5.5 0 0 1 .002 0 .5.5 0 0 1 .5.501.5.5 0 0 1-.5.5.5.5 0 0 1-.5-.5.5.5 0 0 1 .498-.5zm-.233.155v.699h.13v-.285h.093l.173.285h.136l-.18-.297a.191.191 0 0 0 .118-.056c.03-.03.05-.074.05-.136 0-.068-.02-.117-.063-.154-.037-.038-.105-.056-.185-.056zm.13.099h.154c.019 0 .037.006.056.012a.064.064 0 0 1 .037.031c.013.013.012.031.012.056a.124.124 0 0 1-.012.055.164.164 0 0 1-.037.031c-.019.006-.037.013-.056.013h-.154Z" },
  { n: "Qualcomm", c: "#3253DC", d: "M12 0C6.22933 0 1.5761 4.48645 1.5761 10.47394c0 6.00417 4.65323 10.47394 10.4239 10.47394.98402 0 1.93468-.13343 2.8353-.3836l1.13412 2.9187c.11675.31688.35025.51702.7672.51702h1.80125c.43364 0 .75052-.28353.55038-.83391l-1.46768-3.81932c2.88534-1.81793 4.80333-5.03683 4.80333-8.8895C22.4239 4.48644 17.77067 0 12 0m4.53648 16.5615l-1.31758-3.41904c-.11675-.28353-.35024-.55038-.85059-.55038h-1.71786c-.43363 0-.7672.28353-.56706.83391l1.73454 4.48645c-.56706.1501-1.18416.21682-1.81793.21682-4.2196 0-7.22168-3.31897-7.22168-7.65532C4.77832 6.1376 7.7804 2.81862 12 2.81862s7.22168 3.31898 7.22168 7.65532c0 2.5351-1.01737 4.70327-2.6852 6.08756" },
  { n: "Salesforce", c: "#00A1E0", d: "M10.006 5.415a4.195 4.195 0 013.045-1.306c1.56 0 2.954.9 3.69 2.205.63-.3 1.35-.45 2.1-.45 2.85 0 5.159 2.34 5.159 5.22s-2.31 5.22-5.176 5.22c-.345 0-.69-.044-1.02-.104a3.75 3.75 0 01-3.3 1.95c-.6 0-1.155-.15-1.65-.375A4.314 4.314 0 018.88 20.4a4.302 4.302 0 01-4.05-2.82c-.27.062-.54.076-.825.076-2.204 0-4.005-1.8-4.005-4.05 0-1.5.811-2.805 2.01-3.51-.255-.57-.39-1.2-.39-1.846 0-2.58 2.1-4.65 4.65-4.65 1.53 0 2.85.705 3.72 1.8" },
  { n: "Oracle", c: "#F80000", d: "M16.412 4.412h-8.82a7.588 7.588 0 0 0-.008 15.176h8.828a7.588 7.588 0 0 0 0-15.176zm-.193 12.502H7.786a4.915 4.915 0 0 1 0-9.828h8.433a4.914 4.914 0 1 1 0 9.828z" },
  { n: "Spotify", c: "#1ED760", d: "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" },
  { n: "Stripe", c: "#635BFF", d: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" },
  { n: "Cisco", c: "#1BA0D7", d: "M16.331 18.171V17.06l-.022.01c-.25.121-.522.19-.801.203a1.186 1.186 0 01-.806-.237 1.038 1.038 0 01-.352-.498 1.21 1.21 0 01-.023-.667c.052-.225.178-.426.357-.569.16-.134.355-.218.562-.242a1.85 1.85 0 011.061.198l.024.013v-1.117l-.051-.014a2.862 2.862 0 00-1.011-.132 2.34 2.34 0 00-.903.206c-.287.132-.54.327-.739.571a2.221 2.221 0 00-.04 2.705c.295.378.709.645 1.175.756.491.12 1.006.102 1.487-.052l.082-.023M5.336 18.171V17.06l-.022.01c-.25.121-.522.19-.801.203a1.183 1.183 0 01-.806-.237 1.03 1.03 0 01-.351-.498 1.202 1.202 0 01-.024-.667c.052-.225.177-.426.357-.569.16-.134.355-.218.562-.242a1.85 1.85 0 011.061.198l.024.013v-1.117l-.051-.014a2.862 2.862 0 00-1.011-.132 2.344 2.344 0 00-.903.206 2.08 2.08 0 00-.74.571 2.224 2.224 0 00-.041 2.705 2.11 2.11 0 001.176.756c.491.12 1.005.102 1.487-.052l.083-.023M9.26 17.249l-.004.957.07.012c.22.041.441.069.664.085.195.019.391.022.587.012.187-.014.372-.049.551-.104.21-.06.405-.163.571-.305a1.16 1.16 0 00.333-.478 1.31 1.31 0 00-.007-.96 1.068 1.068 0 00-.298-.414 1.261 1.261 0 00-.438-.255l-.722-.268a.388.388 0 01-.197-.188.245.245 0 01.008-.219.382.382 0 01.154-.142.798.798 0 01.257-.074c.153-.022.308-.021.46.005.18.02.358.051.533.096l.038.008v-.883l-.069-.015a4.749 4.749 0 00-.543-.097 2.844 2.844 0 00-.714-.003c-.3.027-.585.143-.821.33-.16.126-.281.293-.351.484-.104.29-.105.608 0 .899.054.145.14.274.252.381.097.093.207.173.327.236.157.084.324.149.497.195.057.017.114.035.17.054l.085.031.024.01c.084.03.162.078.226.14.045.042.08.094.101.151a.325.325 0 01.001.161.339.339 0 01-.166.198.856.856 0 01-.275.086 2.032 2.032 0 01-.427.021 5.208 5.208 0 01-.557-.074 9.195 9.195 0 01-.287-.067l-.033-.006zm-2.475.995h1.05v-4.167h-1.05v4.167zm12.162-2.936a1.095 1.095 0 011.541.158 1.094 1.094 0 01-.157 1.541l-.017.014a1.096 1.096 0 01-1.367-1.713m-1.525.854a2.193 2.193 0 002.666 2.107 2.139 2.139 0 00.701-3.937 2.207 2.207 0 00-3.367 1.83M22.961 10.728a.52.52 0 001.039 0V9.573a.52.52 0 00-1.039 0v1.155M20.117 10.728a.522.522 0 001.041 0V8.139a.521.521 0 00-1.04 0v2.589M17.231 11.771a.521.521 0 001.039 0V6.17a.52.52 0 00-1.039 0v5.601M14.393 10.728a.521.521 0 001.04 0V8.139a.52.52 0 00-1.039 0v2.589M11.494 10.728a.522.522 0 001.039 0V9.573a.52.52 0 00-1.039 0v1.155M8.624 10.728a.52.52 0 001.039 0V8.139a.52.52 0 00-1.039 0v2.589M5.737 11.771a.52.52 0 001.039 0V6.17a.52.52 0 00-1.039 0v5.601M2.876 10.728a.522.522 0 001.04 0V8.139a.52.52 0 00-1.039 0v2.589M0 10.728a.521.521 0 001.039 0V9.573a.52.52 0 00-1.039 0v1.155" },
  { n: "Samsung", c: "#1428A0", d: "M19.8166 10.2808l.0459 2.6934h-.023l-.7793-2.6934h-1.2837v3.3925h.8481l-.0458-2.785h.023l.8366 2.785h1.2264v-3.3925zm-16.149 0l-.6418 3.427h.9284l.4699-3.1175h.0229l.4585 3.1174h.9169l-.6304-3.4269zm5.1805 0l-.424 2.6132h-.023l-.424-2.6132H6.5788l-.0688 3.427h.8596l.023-3.0832h.0114l.573 3.0831h.8711l.5731-3.083h.023l.0228 3.083h.8596l-.0802-3.4269zm-7.2664 2.4527c.0343.0802.0229.1949.0114.2522-.0229.1146-.1031.2292-.3324.2292-.2177 0-.3438-.126-.3438-.3095v-.3323H0v.2636c0 .7679.6074.9971 1.2493.9971.6189 0 1.1346-.2178 1.2149-.7794.0458-.298.0114-.4928 0-.5616-.1605-.722-1.467-.9283-1.5588-1.3295-.0114-.0688-.0114-.1375 0-.1834.023-.1146.1032-.2292.3095-.2292.2063 0 .321.126.321.3095v.2063h.8595v-.2407c0-.745-.6762-.8596-1.1576-.8596-.6074 0-1.1117.2063-1.2034.7564-.023.149-.0344.2866.0114.4585.1376.7106 1.364.9169 1.5358 1.3524m11.152 0c.0343.0803.0228.1834.0114.2522-.023.1146-.1032.2292-.3324.2292-.2178 0-.3438-.126-.3438-.3095v-.3323h-.917v.2636c0 .7564.596.9857 1.2379.9857.6189 0 1.1232-.2063 1.2034-.7794.0459-.298.0115-.4814 0-.5616-.1375-.7106-1.4327-.9284-1.5243-1.318-.0115-.0688-.0115-.1376 0-.1835.0229-.1146.1031-.2292.3094-.2292.1948 0 .321.126.321.3095v.2063h.848v-.2407c0-.745-.6647-.8596-1.146-.8596-.6075 0-1.1004.1948-1.192.7564-.023.149-.023.2866.0114.4585.1376.7106 1.341.9054 1.513 1.3524m2.8882.4585c.2407 0 .3094-.1605.3323-.2522.0115-.0343.0115-.0917.0115-.126v-2.533h.871v2.4642c0 .0688 0 .1948-.0114.2292-.0573.6419-.5616.8482-1.192.8482-.6303 0-1.1346-.2063-1.192-.8482 0-.0344-.0114-.1604-.0114-.2292v-2.4642h.871v2.533c0 .0458 0 .0916.0115.126 0 .0917.0688.2522.3095.2522m7.1518-.0344c.2522 0 .3324-.1605.3553-.2522.0115-.0343.0115-.0917.0115-.126v-.4929h-.3553v-.5043H24v.917c0 .0687 0 .1145-.0115.2292-.0573.6303-.596.8481-1.2034.8481-.6075 0-1.1461-.2178-1.2034-.8481-.0115-.1147-.0115-.1605-.0115-.2293v-1.444c0-.0574.0115-.172.0115-.2293.0802-.6419.596-.8482 1.2034-.8482s1.1347.2063 1.2034.8482c.0115.1031.0115.2292.0115.2292v.1146h-.8596v-.1948s0-.0803-.0115-.1261c-.0114-.0802-.0802-.2521-.3438-.2521-.2521 0-.321.1604-.3438.2521-.0115.0458-.0115.1032-.0115.1605v1.5702c0 .0458 0 .0916.0115.126 0 .0917.0917.2522.3323.2522" },
  { n: "Sony", c: "#FFFFFF", d: "M8.5505 9.8881c.921 0 1.6574.2303 2.2209.7423.3848.3485.5999.8454.5939 1.3665a1.9081 1.9081 0 0 1-.5939 1.3726c-.5272.4848-1.3483.7423-2.221.7423-.8725 0-1.6785-.2575-2.2148-.7423-.3908-.3485-.609-.8484-.603-1.3726 0-.518.2182-1.015.603-1.3665.5-.4545 1.3847-.7423 2.2149-.7423zm.003 3.6692c.4606 0 .8878-.1606 1.1878-.4575.2999-.2999.4332-.6605.4332-1.1029 0-.4242-.1484-.821-.4333-1.1029-.2938-.2908-.7332-.4545-1.1877-.4545s-.8938.1637-1.1907.4545c-.2848.2818-.4333.6787-.4333 1.103-.006.409.1485.806.4333 1.1029.2969.2939.7332.4575 1.1907.4575zm-4.8418-1.9665c.1605.0424.315.094.4666.1636a1.352 1.352 0 0 1 .3787.2576c.197.206.309.4817.306.7665a.9643.9643 0 0 1-.3787.7788 2.0662 2.0662 0 0 1-.709.3485 3.7231 3.7231 0 0 1-1.1938.1697c-.352 0-.5467-.0406-.8138-.0962l-.077-.016c-.294-.0666-.5817-.1575-.8575-.2787a.0695.0695 0 0 0-.0424-.0121c-.0454 0-.0818.0394-.0818.0848v.203H.1212v-1.4786h.5242a.7559.7559 0 0 0 .1363.418c.2121.2607.4394.3607.6575.4395.3666.1212.7514.1848 1.1362.1969.5526 0 .8756-.134.9455-.163l.009-.0037.0062-.0023c.0616-.0226.3119-.1143.3119-.3916 0-.2743-.2338-.334-.387-.373l-.022-.0058c-.1708-.046-.562-.0872-.9897-.1323l-.1526-.016c-.4848-.0515-.9696-.1273-1.1968-.1758-.4977-.1097-.6942-.2917-.816-.4045l-.0082-.0076A1.0192 1.0192 0 0 1 0 11.1608c0-.497.3394-.797.7575-.9817.4454-.2.9756-.288 1.4392-.288.8211.0031 1.4877.2697 1.727.394.097.0515.1455-.0121.1455-.0606v-.1484h.5272v1.2876h-.4727a.9056.9056 0 0 0-.2939-.4909 1.289 1.289 0 0 0-.297-.1787c-.3968-.1667-.821-.2515-1.2513-.2455-.4423 0-.8665.085-1.0786.2153-.1333.0818-.2.1848-.2.306 0 .1727.1454.2424.2182.2636.1967.0597.6328.103.972.1369.0736.0073.1426.0142.2036.0206.3272.0334 1.012.1243 1.315.2zm18.1673-.9966v-.4787H24v.4696h-.4757c-.1727 0-.2424.0334-.3727.1788l-1.4271 1.63a.098.098 0 0 0-.0182.0698v.7423a1.106 1.106 0 0 0 .0121.103.1496.1496 0 0 0 .1.0909.9368.9368 0 0 0 .1303.009h.4848v.4698h-2.5724v-.4697h.4606a.9343.9343 0 0 0 .1302-.0091.1627.1627 0 0 0 .1031-.091.5626.5626 0 0 0 .009-.1v-.7422c0-.0242 0-.0242-.0333-.0636a606.7592 606.7592 0 0 0-1.4119-1.6028c-.0758-.0788-.2061-.2061-.406-.2061h-.4576v-.4696h2.5876v.4696h-.3121c-.0697 0-.1182.0697-.0576.1455 0 0 .8696 1.0392.8787 1.0513.0091.0122.0152.0122.0273.003.0121-.009.8938-1.0453.8999-1.0543a.0912.0912 0 0 0-.0182-.1273.1095.1095 0 0 0-.0606-.0182zm-6.284-.0031h.4848c.2212 0 .2606.0848.2636.2909l.0273 1.5664-2.5815-2.324H11.944v.4697h.412c.297 0 .3182.1636.3182.309v2.2138c.0004.1285.0009.295-.1818.295h-.506v.4667h2.1634v-.4697h-.5273c-.212 0-.2211-.097-.2242-.303v-1.8816l2.9724 2.6511h.7575l-.0394-2.9966c.003-.218.0182-.2908.2424-.2908h.4726v-.4697H15.595Z" },
  { n: "Airbnb", c: "#FF5A5F", d: "M12.001 18.275c-1.353-1.697-2.148-3.184-2.413-4.457-.263-1.027-.16-1.848.291-2.465.477-.71 1.188-1.056 2.121-1.056s1.643.345 2.12 1.063c.446.61.558 1.432.286 2.465-.291 1.298-1.085 2.785-2.412 4.458zm9.601 1.14c-.185 1.246-1.034 2.28-2.2 2.783-2.253.98-4.483-.583-6.392-2.704 3.157-3.951 3.74-7.028 2.385-9.018-.795-1.14-1.933-1.695-3.394-1.695-2.944 0-4.563 2.49-3.927 5.382.37 1.565 1.352 3.343 2.917 5.332-.98 1.085-1.91 1.856-2.732 2.333-.636.344-1.245.558-1.828.609-2.679.399-4.778-2.2-3.825-4.88.132-.345.395-.98.845-1.961l.025-.053c1.464-3.178 3.242-6.79 5.285-10.795l.053-.132.58-1.116c.45-.822.635-1.19 1.351-1.643.346-.21.77-.315 1.246-.315.954 0 1.698.558 2.016 1.007.158.239.345.557.582.953l.558 1.089.08.159c2.041 4.004 3.821 7.608 5.279 10.794l.026.025.533 1.22.318.764c.243.613.294 1.222.213 1.858zm1.22-2.39c-.186-.583-.505-1.271-.9-2.094v-.03c-1.889-4.006-3.642-7.608-5.307-10.844l-.111-.163C15.317 1.461 14.468 0 12.001 0c-2.44 0-3.476 1.695-4.535 3.898l-.081.16c-1.669 3.236-3.421 6.843-5.303 10.847v.053l-.559 1.22c-.21.504-.317.768-.345.847C-.172 20.74 2.611 24 5.98 24c.027 0 .132 0 .265-.027h.372c1.75-.213 3.554-1.325 5.384-3.317 1.829 1.989 3.635 3.104 5.382 3.317h.372c.133.027.239.027.265.027 3.37.003 6.152-3.261 4.802-6.975z" },
  { n: "PayPal", c: "#003087", d: "M7.016 19.198h-4.2a.562.562 0 0 1-.555-.65L5.093.584A.692.692 0 0 1 5.776 0h7.222c3.417 0 5.904 2.488 5.846 5.5-.006.25-.027.5-.066.747A6.794 6.794 0 0 1 12.071 12H8.743a.69.69 0 0 0-.682.583l-.325 2.056-.013.083-.692 4.39-.015.087zM19.79 6.142c-.01.087-.01.175-.023.261a7.76 7.76 0 0 1-7.695 6.598H9.007l-.283 1.795-.013.083-.692 4.39-.134.843-.014.088H6.86l-.497 3.15a.562.562 0 0 0 .555.65h3.612c.34 0 .63-.249.683-.585l.952-6.031a.692.692 0 0 1 .683-.584h2.126a6.793 6.793 0 0 0 6.707-5.752c.306-1.95-.466-3.744-1.89-4.906z" },
];

/**
 * Fill the idle panel: a slow pool of brand marks, and the live employer count.
 *
 * The wall is decorative and the count is not — so the count is computed from
 * the board every render and the marks are static. Positions are handed to CSS
 * as custom properties (--i, --n, --ring) so the three layouts are pure CSS and
 * nothing animates from JavaScript; a JS-driven transform would also defeat
 * `prefers-reduced-motion`, which the stylesheet handles centrally.
 */
function renderIdle() {
  const wall = $('idle-wall');
  if (!wall) return;

  if (!wall.childElementCount) {
    // Built once. renderIdle runs on every deselect, and rebuilding twenty
    // inline SVGs each time would restart every keyframe in the pool.
    wall.replaceChildren();

    // DETERMINISTIC PSEUDO-RANDOM, never Math.random().
    //
    // The pool has to look scattered, but it must be the SAME scatter every
    // time: renderIdle runs again on every deselect, and a pool that reshuffles
    // when you close a role reads as the panel reloading. This is the standard
    // fract(sin(x) * large) hash — no state, no seeding, same answer forever.
    const rnd = (i, salt) => {
      const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };

    // Positions, in per cent of the pool, laid out then pushed apart.
    //
    // PHYLLOTAXIS FIRST — successive points at the golden angle, the
    // arrangement a sunflower uses. It spreads evenly without ever forming a
    // ring or a spoke, which two concentric rings did and which read as
    // machine-made the moment you saw it.
    //
    // THEN RELAXATION, because phyllotaxis packs the middle far denser than the
    // rim: at these chip sizes the first render had NVIDIA over Oracle, Samsung
    // over Netflix and Cisco over Adobe. Thirty passes of pushing any
    // overlapping pair apart fixes it and keeps the scatter — a minimum-spacing
    // rule is what "random but not a mess" actually means. Deterministic, so
    // the pool is identical on every render.
    const R = 44;                       // outermost centre, % of the pool
    const pts = BRANDS.map((b, i) => {
      const ang = (i * 137.507 + (rnd(i, 1) - 0.5) * 30) * Math.PI / 180;
      const rad = Math.sqrt((i + 0.7) / BRANDS.length) * R + (rnd(i, 2) - 0.5) * 4;
      // Chip diameter as a percentage of the pool, so spacing is in one unit.
      // Floor raised from 8.4: the smallest chips left wide wordmarks (Sony,
      // Samsung, Cisco) too small to read, and an unreadable mark defeats a
      // wall whose only job is recognition.
      const sz = 9.8 + rnd(i, 3) * 4.0;
      return { x: 50 + rad * Math.cos(ang), y: 50 + rad * Math.sin(ang), sz };
    });
    for (let pass = 0; pass < 30; pass++) {
      for (let a = 0; a < pts.length; a++) {
        for (let c = a + 1; c < pts.length; c++) {
          const p = pts[a]; const q = pts[c];
          const dx = q.x - p.x; const dy = q.y - p.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const need = (p.sz + q.sz) / 2 + 1.6;      // touching, plus a gap
          if (d >= need) continue;
          const push = (need - d) / 2;
          const ux = dx / d; const uy = dy / d;
          p.x -= ux * push; p.y -= uy * push;
          q.x += ux * push; q.y += uy * push;
        }
      }
      // Keep everything inside the box; a chip half off the edge looks clipped.
      for (const p of pts) {
        const dx = p.x - 50; const dy = p.y - 50;
        const d = Math.hypot(dx, dy);
        const max = 50 - p.sz / 2 - 1;
        if (d > max) { p.x = 50 + dx / d * max; p.y = 50 + dy / d * max; }
      }
    }

    BRANDS.forEach((b, i) => {
      const pt = pts[i];
      const cell = el('span', 'pool-i');
      cell.style.left = `${pt.x}%`;
      cell.style.top = `${pt.y}%`;
      cell.style.setProperty('--sz', `${pt.sz}cqmin`);

      // Each mark wanders on its own two periods, one per axis. Equal periods
      // would give every logo a straight diagonal shuttle; unequal ones trace a
      // slow Lissajous curve that takes minutes to repeat, so nothing in the
      // pool ever looks like it is on a timer. The travel is small — a chip
      // that wandered far would reopen the overlaps the relaxation just closed.
      cell.style.setProperty('--dx', `${(rnd(i, 4) - 0.5) * 13}px`);
      cell.style.setProperty('--dy', `${(rnd(i, 5) - 0.5) * 13}px`);
      cell.style.setProperty('--tx', `${9 + rnd(i, 6) * 7}s`);
      cell.style.setProperty('--ty', `${11 + rnd(i, 7) * 9}s`);
      cell.style.setProperty('--tr', `${13 + rnd(i, 8) * 10}s`);
      cell.style.setProperty('--rot', `${(rnd(i, 9) - 0.5) * 14}deg`);
      // Negative delays start every mark part-way through its own cycle, so the
      // pool is already in motion on the first frame instead of everything
      // setting off together from rest.
      cell.style.setProperty('--d1', `${-rnd(i, 10) * 16}s`);
      cell.style.setProperty('--d2', `${-rnd(i, 11) * 20}s`);

      // Sony's brand colour is #FFFFFF, which on a white chip is an empty
      // circle. Anything this light is darkened rather than dropped — the mark
      // is still the brand's, just legible.
      const rgb = b.c.slice(1).match(/../g).map((h) => parseInt(h, 16));
      const lite = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.75;
      cell.style.setProperty('--c', lite ? '#15161a' : b.c);

      // Two nested elements because the two axes run on different periods and
      // one transform can only carry one timeline.
      const chip = el('span', 'pool-c');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', b.vb || '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      if (b.g) {
        // A brand carrying its own artwork: Google's four-colour G and Amazon's
        // black-and-orange a-smile, which a single tinted path cannot be. Their
        // own paths declare fill, so the `fill: var(--c)` on the <svg> reaches
        // nothing. Static markup from a constant in this file, never anything a
        // posting supplied, which is why innerHTML is safe at this one site.
        svg.innerHTML = b.g;
      } else {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', b.d);
        svg.append(path);
      }
      chip.append(svg);
      cell.append(chip);
      cell.title = b.n;
      wall.append(cell);
    });
  }

  const live = state.jobs.filter((j) => kindOf(j) === state.kind);
  const co = new Set(live.map((j) => j.company)).size;
  const n = $('idle-n');
  if (n) {
    n.textContent = co
      ? `A few of the companies we watch. ${co} employer${co === 1 ? ' is' : 's are'} hiring here right now.`
      : 'A few of the companies we watch.';
  }
}

const kindOf = (j) => j.employmentType || 'intern';

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
}

function populateFilters() {
  const companies = [...new Set(state.jobs.map((j) => j.company))].sort((a, b) => a.localeCompare(b));
  const locations = [...new Set(state.jobs.map((j) => j.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const c of companies) $('f-company').append(new Option(c, c));
  for (const l of locations.slice(0, 200)) $('f-location').append(new Option(l, l));
}

/* ---------------- filtering ---------------- */

/**
 * Bring the board into line with whatever resume is loaded.
 *
 * Adds "best for me" to the sort control the first time there is something to
 * sort by, and takes it away again when the resume is cleared — an option that
 * cannot do anything is worse than no option, because selecting it looks like a
 * bug rather than like a missing input. Re-renders so scores appear on the
 * cards immediately rather than at the next keystroke.
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

/* Mark every filter that is holding a value.
 *
 * The controls lost their separate text labels when the resting option started
 * naming the filter — which is what removed four copies of the word "any" — so
 * nothing was left to say WHICH of the four are currently narrowing the board.
 * The lit border is that. Sort is excluded: it always holds a value, so lighting
 * it would mean one control is permanently on and the signal stops meaning
 * anything. */
function markSetFilters() {
  for (const id of ['f-company', 'f-location', 'f-mode']) {
    const sel = $(id);
    sel?.closest('label')?.classList.toggle('is-set', Boolean(sel.value));
  }
}

function applyFilters() {
  markSetFilters();
  const q = $('q').value.trim().toLowerCase();
  const company = $('f-company').value;
  const location = $('f-location').value;
  const mode = $('f-mode').value;
  const sort = $('f-sort').value;

  const list = state.jobs.filter((j) => {
    if (kindOf(j) !== state.kind) return false;
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
    // Fit first, then freshness inside a tie — two roles that suit you equally
    // are still separated by which one you can get in front of first, which is
    // what this board is for. Unscorable postings sort last but are NOT hidden:
    // a thin skills list is our gap, not a judgement about the role.
    list.sort((a, b) => ((matchFor(b)?.pct ?? -1) - (matchFor(a)?.pct ?? -1))
      || ((b.postedAt ?? 0) - (a.postedAt ?? 0)));
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

/* ---------------- the decision facts ----------------
 *
 * MIRRORS src/pages.js. stipendText/durationText/modeText are the site's own
 * display filters and the generated job pages have used them since 24 Aug; the
 * board never did, which is why 350 of 409 US listings carried a stipend that
 * was never once shown to a reader. Mirrored rather than imported because this
 * file is plain script served to the browser and pages.js is a build-time ES
 * module — the same reason jobPageSlug exists in three copies. Keep them in
 * step: test/pages.test.mjs pins the slug trio, and these belong to the same
 * class of duplication.
 *
 * Both filters exist because the stored values are dirty in ways that read as
 * confident claims rather than as missing data. The stipend column holds "Rs 0"
 * (68 live rows), "2,026" and "AUD 2,018" — years that reached the money slot —
 * and the duration column holds "0 to 3 years" and "0-11 months", which are
 * experience requirements, not internship lengths. Printing either next to an
 * Apply button is worse than printing nothing.
 */

/** A stipend we are willing to state, or '' when the value is not one. */
function stipendText(job) {
  const raw = String(job.stipend ?? '').trim();
  if (!raw) return '';
  // No currency and no period is not an amount — it is a number that reached
  // the wrong column.
  if (!/[₹$£€]|\brs\b|\blpa\b|\bper\b|\/\s*(month|year|week|total)|\b(month|year|week)ly\b/i.test(raw)) return '';
  // ZERO IS NOT AN AMOUNT. An employer that genuinely pays nothing is recorded
  // in stipendStatus and rendered as "Unpaid"; a zero here is missing data. A
  // zero anywhere a currency introduces an amount counts, including the lower
  // bound of a range like "$0 – $1,000 / hour".
  if (/[₹$£€]\s*0(?![\d.])/.test(raw)) return '';
  if (!/[1-9]/.test(raw.replace(/[^\d]/g, ''))) return '';
  return raw;
}

/** A duration, or '' when the value is an experience requirement in disguise. */
function durationText(job) {
  const raw = String(job.duration ?? '').trim();
  if (!raw) return '';
  if (/^0\b/.test(raw)) return '';
  if (/\d\s*(?:to|[-–—])\s*\d+\s*(?:\+\s*)?(?:years?|yrs?)\b/i.test(raw)) return '';
  return raw;
}

function modeText(job) {
  const raw = String(job.workplaceType ?? '').trim();
  if (!raw) return '';
  if (/^on-?site$/i.test(raw)) return 'On-site';
  return raw[0].toUpperCase() + raw.slice(1);
}

/**
 * How many people were already in the queue WHEN THE POSTING WAS READ.
 *
 * The column is text, never a number — "47 people clicked apply", "7 applicants",
 * "Over 100 applicants" — so it is parsed before it is compared. Comparing the
 * raw string against a number silently matches nothing and has already produced
 * one confident wrong answer in this project.
 */
function applicantCount(job) {
  const raw = String(job.applicants ?? '').trim();
  if (!raw) return null;
  const n = Number((raw.match(/([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  // "Over 100" parses to 100 and means at least that. It must never be read as
  // a low number: CAST('Over 100 applicants' AS INTEGER) is 0 in SQL, and the
  // equivalent mistake here would put "only 0 so far" on the most crowded role
  // on the board.
  return /\bover\b/i.test(raw) ? n + 1 : n;
}

/* The queue is only worth showing while it is still SHORT.
 *
 * "69 people clicked apply" is a LinkedIn click count, not applications, and it
 * is frozen at scrape time — so on a crowded role it is both unreliable and
 * purely discouraging, which is the opposite of what this board is for. Below
 * the threshold it is the single best proof the site's promise works, so that
 * is the only case where it reaches a card. Above it, the pane still states it
 * plainly for anyone who opens the role. */
const QUEUE_SHORT = 25;

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
  // An h3, not a p: the role is the card's heading. It used to be a paragraph
  // under an h3 of the company name, which told a screen reader (and a crawler)
  // that the employer was the subject and the job was a detail.
  const p = el('h3', 'role', job.title);
  if (!titleIsGeneric(job.title)) return { node: p, usedFirstBullet: false };
  const q = roleQualifier(job);
  if (!q) return { node: p, usedFirstBullet: false };
  p.append(el('span', 'qual', q.text));
  return { node: p, usedFirstBullet: q.usedFirstBullet };
}

/* ---------------- relevance ----------------
 *
 * Once a resume is loaded, every listing is scored against it and the reader
 * can sort by fit. This is the one thing a job board can do that LinkedIn
 * cannot do without an account, and it costs nothing but the skills already in
 * jobs.json.
 *
 * IT IS HELD IN MEMORY AND NOWHERE ELSE. Not localStorage, not sessionStorage,
 * not a cookie — the footer on this page promises "your resume is processed in
 * memory and never stored here", and that sentence has to stay true. The cost
 * is that scores are gone on reload, which is the correct trade: a resume is
 * the most personal thing anybody hands this site, and persisting it to make a
 * percentage survive a refresh would be a promise broken for a convenience.
 */

/* The resume, lowercased and reduced to single-space-separated tokens, with the
   characters real skill names actually contain kept. Held as one padded string
   so a skill can be matched whole-word with a plain includes() — "r" must not
   match "for", and "go" must not match "algorithm". */
let resumeHay = '';
const normSkill = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();

function setResumeHay(text) {
  resumeHay = text ? ` ${normSkill(text)} ` : '';
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
 * and a confident "0% MATCH" on a role the reader is well suited to is worse
 * than saying nothing — the number would be measuring our own extraction, not
 * their fit.
 *
 * @returns {{pct: number, hit: string[], of: number}|null}
 */
function matchFor(job) {
  if (!resumeHay) return null;
  const skills = skillsOf(job);
  if (skills.length < 3) return null;
  const hit = skills.filter((k) => resumeHay.includes(` ${k} `));
  return { pct: Math.round((hit.length / skills.length) * 100), hit, of: skills.length };
}

/**
 * The decision line: everything a reader needs to reject or shortlist a role
 * without opening it.
 *
 * ORDER IS FIXED AND CONTENT IS NOT. Most postings are missing most of these —
 * on the India board a stipend is on 26% and a duration on 27% — so a grid with
 * a slot per fact would render a column of em-dashes and teach the eye to skip
 * the row. Instead every fact keeps its place in the order and simply does not
 * appear when it is unknown, which is what lets someone scanning the column
 * still compare like with like: money is always leftmost when there is money.
 */
function factLine(job, group) {
  const meta = el('div', 'meta');

  // 1. PAY. First because it is the fact people scan for and the one this board
  // was not showing at all. "Unpaid" is stated as plainly as an amount — it is
  // decision-critical, and 47 live India rows carry it.
  // A FIGURE, OR NOTHING. Never a "Paid"/"Unpaid" badge off `stipendStatus`:
  // that field is a local-model judgement and measurement says it is wrong —
  // of 47 India rows and 63 US rows it marks `unpaid`, not one contains any
  // unpaid phrasing in its own description, and the employers include NatWest
  // and Seclore. Saying nothing about pay is honest; saying "Unpaid" about a
  // paid role is a false claim about somebody's employer sitting next to an
  // Apply button.
  const money = stipendText(job);
  if (money) meta.append(el('span', 'cash', money));

  // 2. ELIGIBILITY — the only fact that can rule you out entirely.
  const degree = degreeTag(job);
  if (degree) meta.append(degree);

  // 3. WHERE. A role advertised in several cities says so rather than naming
  // whichever posting happened to be newest, which would claim an opening is in
  // one place when it is open in twenty-two.
  const cities = group.length > 1 ? citiesOf(group) : [];
  if (cities.length > 1) {
    const shown = cities.slice(0, 2).join(' · ');
    const rest = cities.length - 2;
    meta.append(el('span', 'cities', rest > 0 ? `${shown} +${rest}` : shown));
  } else if (job.location) {
    // The city alone. Every listing on a board is in that region, so the state
    // and the country are the two least useful words on the card.
    meta.append(el('span', 'cities', cityOf(job.location) || job.location));
  }

  // 4. MODE and 5. DURATION — both filtered, so an experience requirement can
  // never render as an internship length.
  const mode = modeText(job);
  if (mode) meta.append(el('span', null, mode));
  const dur = durationText(job);
  if (dur) meta.append(el('span', null, dur));

  // 6. THE QUEUE, and only while it is still short. See QUEUE_SHORT.
  const queue = applicantCount(job);
  if (queue != null && queue < QUEUE_SHORT) {
    meta.append(el('span', 'ea', queue === 0 ? 'no applicants yet' : `only ${queue} so far`));
  }

  return meta.children.length ? meta : null;
}

function jobCard(job, index, group = [job]) {
  const li = document.createElement('li');
  const row = el('article', 'row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.id = job.id;
  row.style.animationDelay = `${Math.min(index, 14) * 32}ms`;
  if (job.id === state.selectedId) row.setAttribute('aria-current', 'true');

  const age = job.postedAt ? Date.now() - job.postedAt : null;
  const blazing = age != null && age < HOT_MS;
  if (blazing) row.classList.add('is-hot');

  row.append(companyBadge(job));

  const mid = el('div');
  // Company first in the DOM but styled as an eyebrow — the role is the heading.
  mid.append(el('div', 'co', job.company));
  const role = roleLine(job);
  mid.append(role.node);

  const facts = factLine(job, group);
  if (facts) mid.append(facts);

  // Fit, when a resume has been loaded. Placed under the facts rather than
  // beside the role: it is a strong signal but it is OURS, not the employer's,
  // and it must not be mistaken for something the posting said.
  const fit = matchFor(job);
  if (fit && fit.hit.length) {
    // THE SCORE ONLY. It used to name the matching skills too, and they were
    // the same words the lit chips underneath were already showing — one more
    // line of text per card saying what the card had just said. The number is
    // what the eye compares down a sorted column; the chips say which; and the
    // pane spells out the whole overlap and the gap for the role you open.
    const m = el('div', `match${fit.pct >= 60 ? ' is-strong' : ''}`);
    m.append(el('b', null, `${fit.pct}% match`));
    m.append(el('span', null, `${fit.hit.length} of ${fit.of} skills`));
    mid.append(m);
  }

  // THE BULLET LIST IS GONE, and that is the density reduction.
  //
  // Every card carried up to three lines of generated prose describing the
  // work. Stacked down a column of 281 they were the bulk of the reading and
  // the least scannable part of it — three near-identical grey paragraphs per
  // card, differing in wording rather than in anything a reader decides on.
  // The facts above answer "should I open this"; the summary answers "what is
  // it", which is a question you ask AFTER deciding to look, and the detail
  // pane and the job page both still carry it in full. Nothing is lost from the
  // site — one screen of scanning is.
  //
  // The role qualifier survives, because a quarter of postings are titled only
  // "Apprentice" or "Intern" and without it those cards name no job at all.

  const skills = (job.keySkills ?? []).slice(0, 4);
  if (skills.length) {
    const box = el('div', 'skills');
    for (const sk of skills) {
      const chip = el('span', 'skill', sk);
      // A skill the reader already has is lit, so the chips stop being uniform
      // decoration and start being a reason to look.
      if (resumeHay && resumeHay.includes(` ${normSkill(sk)} `)) chip.classList.add('has');
      box.append(chip);
    }
    mid.append(box);
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

  // Says what the card itself does. Apply was the only thing on the row that
  // looked pressable, so the card reading as a button — and the whole detail
  // pane behind it — was something a reader had to discover by accident.
  // aria-hidden because the row is already role="button" with its own label;
  // a screen reader would otherwise hear the affordance twice.
  const opens = el('span', 'opens');   // the wording is CSS — see .opens::after
  opens.setAttribute('aria-hidden', 'true');
  foot.append(opens);

  const applyHref = safeUrl(job.applyUrl) || safeUrl(job.url);
  if (applyHref) {
    const go = el('a', 'card-go');
    go.href = applyHref;
    go.target = '_blank';
    go.rel = 'noopener noreferrer';
    go.append(el('span', 'card-go-t', 'Apply'), el('i', 'card-go-a'));
    go.setAttribute('aria-label', `Apply for ${job.title} at ${job.company}`);
    // The whole card is clickable. Without this, applying would also fire the
    // card's handler and slide the detail pane up behind the new tab.
    go.addEventListener('click', (e) => e.stopPropagation());
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
  list.classList.toggle('intro', !renderList.painted);
  renderList.painted = true;

  // Stop observing the rows we are about to drop; the observer keeps a
  // strong reference to every target until it is disconnected.
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

  const frag = document.createDocumentFragment();
  groups.forEach((group, i) => frag.append(jobCard(group[0], i, group)));
  list.append(frag);
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

  if (matchMedia('(max-width: 1000px)').matches) {
    $('detail-col').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

/** Put the right-hand column back to the vetting panel. */
function showIdle() {
  state.selectedId = null;
  $('detail').hidden = true;
  $('detail-placeholder').hidden = false;
  for (const card of document.querySelectorAll('.row')) card.removeAttribute('aria-current');
  if (location.hash.startsWith('#job-')) history.replaceState(null, '', location.pathname + location.search);
  renderIdle();
}

function closeDetail() {
  const col = $('detail-col');
  document.body.style.overflow = '';

  // On desktop the column is not an overlay, so there is no exit animation to
  // wait for and the early return below would make "all roles" do nothing at
  // all. It deselects instead, which is the same thing the button promises.
  if (!col.classList.contains('open')) { showIdle(); return; }

  // display:none cannot be transitioned, so the pane has to finish its exit
  // animation before it is hidden. Falling back on a timer as well as the event
  // matters: if the animation is suppressed — prefers-reduced-motion, or the
  // desktop layout where the pane is not an overlay — animationend never fires
  // and the pane would be left stuck open.
  col.classList.add('closing');
  const done = () => {
    col.classList.remove('open', 'closing');
    col.removeEventListener('animationend', done);
    showIdle();
  };
  col.addEventListener('animationend', done);
  setTimeout(done, 260);
}

function renderDetail(job) {
  const d = $('detail');
  $('detail-placeholder').hidden = true;
  d.hidden = false;
  d.replaceChildren();
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
    // Built as label + drawn arrow rather than one string with a "\u2192" in it,
    // and wrapped, so this button carries the same ambient loop as the card
    // buttons and the generated job pages: the halo and the ping hang off
    // .apply-glow, the sheen and the arrow off the button itself. The arrow has
    // to be an element for it to lean on its own.
    const apply = el('a', 'go');
    apply.href = applyHref;
    apply.target = '_blank';
    apply.rel = 'noopener noreferrer';
    apply.append(el('span', 'go-t', 'Apply on ' + where), el('i', 'card-go-a'));
    const glow = el('span', 'apply-glow');
    glow.append(apply);
    actions.append(glow);
  }

  const tailorBtn = el('button', 'alt');
  tailorBtn.type = 'button';
  tailorBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 11.8l-1.4 1.4M3 21l9-9"/>'
    + '<circle cx="15" cy="9" r="3"/></svg>';
  // The label names THIS role. "Tailor my resume" beside a job you are reading
  // reads as a generic tool that happens to live on the page; "Tailor for this
  // role" is the next step in the thing you are already doing.
  tailorBtn.append(document.createTextNode(resumeHay ? 'Tailor for this role' : 'Tailor my resume'));
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

  const facts = el('dl', 'facts');
  const addFact = (label, value, cls) => {
    if (!value) return;
    const f = el('div', 'fact');
    f.append(el('dt', null, label), el('dd', cls, value));
    facts.append(f);
  };
  // PAY LEADS, and it was not here at all until now — the board rendered no
  // stipend anywhere, on either the card or this pane, while 86% of US listings
  // and 26% of India's carried one. Filtered through the same rule the
  // generated job pages use, so "Rs 0" and the stray "2,026" never render as a
  // wage — and only ever a real figure, never a badge derived from
  // `stipendStatus`, which measurement shows is invented. See factLine.
  const money = stipendText(job);
  if (money) addFact('stipend', money, 'cash');
  // Eligibility — the one fact that can rule a reader out entirely.
  if (job.degreeLevel) addFact('eligibility', [job.degreeLevel, job.degreeText].filter(Boolean).join(' · '));
  // An unknown fact is OMITTED, never rendered as an em-dash. A grid of stubs
  // teaches the eye that this block is mostly empty and it stops being read —
  // and on the India board, where a duration is on 27% of rows, most of it
  // would have been stubs.
  addFact('mode', modeText(job));
  addFact('duration', durationText(job));
  // Computed from the timestamp, NOT from postedText. postedText is the string
  // LinkedIn showed at the moment the scraper opened the posting — "4 minutes
  // ago" — and it never ages. Preferring it meant the detail pane still read
  // "4 minutes ago" a day later, while the card beside it correctly read "22h"
  // from shortAge(postedAt). On a site whose whole promise is BE EARLY, that is
  // the worst possible field to get wrong: every stale posting looked brand new.
  // postedText is kept only as a fallback for a row with no parsed timestamp.
  addFact('posted', relTime(job.postedAt) || job.postedText);
  // THE QUEUE, worded as what it is. The stored string is a LinkedIn click
  // count frozen at scrape time — not applications, and not live — so it is
  // stamped "when we listed it" rather than presented as the state of play now.
  // Unlike the card, the pane states it at any size: somebody who has opened
  // the role is deciding, and withholding a crowded queue from them would be
  // choosing what they are allowed to weigh. It is the card, where it can only
  // discourage a reader who has not even looked yet, that holds it back.
  // The caveat lives in the LABEL, so the value stays a value. Written into the
  // value it wrapped to four lines and stretched every other cell in the grid
  // to match — the tallest cell sets the row.
  const queue = applicantCount(job);
  if (queue != null) {
    const clicks = /clicked/i.test(job.applicants);
    const over = /\bover\b/i.test(job.applicants);
    addFact(`${clicks ? 'clicked apply' : 'applicants'} · when listed`,
      queue === 0 ? 'Nobody yet' : over ? `Over ${queue - 1}` : String(queue),
      queue < QUEUE_SHORT ? 'cash' : null);
  }
  d.append(facts);

  // WHAT YOU ALREADY MATCH, AND WHAT YOU DO NOT.
  //
  // This is the answer to "Tailor my resume feels disconnected": the button is
  // an offer with no argument attached until the page can say what the gap
  // actually is. Naming the skills the posting asks for that the resume never
  // mentions turns it into a specific piece of work — and those are exactly the
  // lines the tailoring pass would write.
  const fit = matchFor(job);
  if (fit) {
    const gap = skillsOf(job).filter((k) => !resumeHay.includes(` ${k} `));
    d.append(el('h3', null, 'your fit'));
    const box = el('div', `pfit${fit.pct >= 60 ? ' is-strong' : ''}`);
    box.append(el('b', null, `${fit.pct}%`));
    // A truncated list says so. "You already name 7 of 7: <six things>" reads as
    // a miscount rather than as a trim, and the number is the part being trusted.
    const list = (arr, max = 6) => arr.length > max
      ? `${arr.slice(0, max).join(', ')} and ${arr.length - max} more`
      : arr.join(', ');
    const lines = el('div', 'pfit-t');
    lines.append(el('span', null, fit.hit.length
      ? `You already name ${fit.hit.length} of ${fit.of}: ${list(fit.hit)}.`
      : `Your resume names none of the ${fit.of} skills on this posting.`));
    if (gap.length) lines.append(el('i', null, `Not on your resume: ${list(gap)}.`));
    box.append(lines);
    d.append(box);
  }

  // THE ROLE — the summary, then the bullets.
  //
  // The bullets used to be on every feed card and were removed from there
  // because 259 of them stacked down a column were the bulk of the reading and
  // the least scannable part of it. This is where they belong: the reader has
  // chosen this role and is now asking what the work actually is, which is
  // exactly the question three specifics answer better than a paragraph.
  // Summary first as a sentence of context, bullets under it for the detail.
  if (job.summary || (job.bullets ?? []).length) {
    d.append(el('h3', null, 'the role'));
    if (job.summary) d.append(el('p', 'p-gist', job.summary));
    const bullets = job.bullets ?? [];
    if (bullets.length) {
      const ul = el('ul', 'p-bullets');
      for (const b of bullets) ul.append(el('li', null, b));
      d.append(ul);
    }
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
    const link = el('a', null, 'Read the full posting on LinkedIn');
    link.href = sourceHref;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    note.append(link, document.createTextNode(' before you apply — it is the source of truth.'));
  } else {
    note.append(document.createTextNode('Check the original posting before you apply — it is the source of truth.'));
  }
  d.append(note);
}

/* ---------------- resume tailoring ---------------- */

let activeJob = null;

/**
 * @param {object|null} job  null opens the modal in RANK mode, from the idle
 *   panel's call to action. There is no role to rewrite against there — the
 *   point is only to get a resume into the tab so every listing can be scored,
 *   which the upload and paste handlers already do on their own. So the modal
 *   changes what it promises and the primary button stops calling /api/tailor,
 *   rather than the button being pointed at an arbitrary role.
 */
function openTailor(job) {
  activeJob = job;
  $('tailor-title').textContent = job ? 'Tailor your resume' : 'Rank the whole board';
  $('tailor-job').textContent = job
    ? `${job.company} · ${job.title}`
    : 'Score every open role against your resume, and sort by fit.';
  $('do-tailor').textContent = job ? 'Tailor it' : 'Rank the board';
  showStep('upload');
  $('tailor-backdrop').hidden = false;
  $('tailor').hidden = false;
  document.body.style.overflow = 'hidden';
  $('tailor-close').focus();
}

function closeTailor() {
  $('tailor').hidden = true;
  $('tailor-backdrop').hidden = true;
  if (!$('detail-col').classList.contains('open')) document.body.style.overflow = '';
}

function showStep(name) {
  for (const s of ['upload', 'working', 'result', 'error']) {
    $(`step-${s}`).hidden = s !== name;
  }
}

function setResumeText(text, label, ok = true) {
  state.resumeText = ok ? text : '';
  syncRelevance();
  const box = $('file-state');
  box.hidden = false;
  box.classList.toggle('bad', !ok);
  box.replaceChildren(el('span', null, ok
    ? `${label} · ${text.length.toLocaleString()} characters read`
    : label));
  $('do-tailor').disabled = !ok || text.trim().length < 200;
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

  setResumeText('', `Reading ${file.name}…`, false);
  $('file-state').classList.remove('bad');

  try {
    const text = isTxt ? await file.text() : await extractPdfText(file);
    if (text.trim().length < 200) {
      setResumeText('', 'Almost no text could be read. If this is a scanned or image-based PDF, paste your resume as text instead.', false);
      return;
    }
    setResumeText(text, file.name, true);
  } catch {
    setResumeText('', 'That PDF could not be read. Try the paste-as-text option below.', false);
  }
}

async function runTailor() {
  const resumeText = state.resumeText || $('resume-paste').value.trim();
  if (resumeText.trim().length < 200) {
    setResumeText('', 'Please provide a bit more of your resume — at least a couple of hundred characters.', false);
    return;
  }

  // RANK MODE has nothing to send anywhere. The resume is already in memory and
  // the board is already scored — syncRelevance() ran the moment it was read —
  // so the button's whole job is to get out of the way and show the result.
  if (!activeJob) {
    state.resumeText = resumeText;
    syncRelevance();
    $('f-sort').value = 'match';
    applyFilters();
    closeTailor();
    toast('sorted by fit');
    return;
  }

  showStep('working');
  const labels = ['Reading your resume…', 'Comparing it to the role…', 'Rewriting for this job…', 'Almost there…'];
  let i = 0;
  const tick = setInterval(() => {
    i = Math.min(i + 1, labels.length - 1);
    $('working-label').textContent = labels[i];
  }, 4200);

  try {
    const res = await fetch('/api/tailor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resumeText, job: activeJob }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The service is unavailable right now.');

    state.tailored = data.tailored;
    renderTailored(data.tailored);
    showStep('result');
    toast('resume tailored');
  } catch (err) {
    $('error-text').textContent = err.message;
    showStep('error');
  } finally {
    clearInterval(tick);
  }
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
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === state.kind) return;
      state.kind = kind;
      for (const b of document.querySelectorAll('#seg-kind .seg-b')) {
        b.setAttribute('aria-selected', String(b.dataset.kind === kind));
      }
      state.selectedId = null;
      rerun();
    });
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
    // Desktop has no back button — `.back` is display:none above 1000px, where
    // the column is not an overlay — so Escape is the only way to put the
    // vetting panel back once a role has been opened. Worth having now that the
    // panel says something: before, deselecting only ever revealed PICK A ROLE.
    else if (!$('detail').hidden) showIdle();
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
    state.resumeText = v;
    syncRelevance();
    $('do-tailor').disabled = v.length < 200;
    if (v.length >= 200) setResumeText(v, 'Pasted resume', true);
  });

  // The idle panel's call to action. No job is attached: this is the "rank the
  // whole board" entry point, so openTailor is given null and the modal's
  // per-role framing falls back to the generic one.
  $('idle-tailor')?.addEventListener('click', () => openTailor(null));

  $('do-tailor').addEventListener('click', runTailor);
  $('error-retry').addEventListener('click', () => showStep('upload'));
  $('start-over').addEventListener('click', () => {
    state.resumeText = '';
    syncRelevance();
    state.tailored = null;
    $('resume-file').value = '';
    $('resume-paste').value = '';
    $('file-state').hidden = true;
    $('do-tailor').disabled = true;
    showStep('upload');
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

async function init() {
  initTheme();
  wireControls();
  wireTailor();

  syncStickyOffset();
  // The rail rewraps on resize, and again once the web fonts land and change
  // the text metrics — both move the stack height.
  addEventListener('resize', syncStickyOffset, { passive: true });
  document.fonts?.ready.then(syncStickyOffset);

  await loadJobs();
  renderFreshness();
  renderTotal();
  renderIdle();
  populateFilters();
  readUrl();          // after populateFilters(): the <option>s must exist first
  applyFilters();

  const hash = location.hash.match(/^#job-(.+)$/);
  const target = hash && state.jobs.find((j) => j.id === hash[1]);
  // A ROLE IS OPENED ONLY WHEN SOMEBODY ASKS FOR ONE — by clicking, or by
  // arriving on a #job- link they were given.
  //
  // Desktop used to auto-open the newest listing, to stop the right-hand column
  // being 45% of the viewport saying PICK A ROLE. That solved the empty panel
  // by creating three worse problems: the reader lands inside a job they did
  // not choose, the newest role is made to look selected rather than merely
  // first, and the pane's own "read the full posting" framing applies to
  // something nobody asked to read. The panel now carries the vetting story
  // instead, which is worth the space on its own.
  if (target) selectJob(target.id);

  setInterval(renderFreshness, 60000);
}

init();
