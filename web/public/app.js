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
 * Remember which board this reader is on, for the edge redirect.
 *
 * `web/vercel.json` sends a US or GB visitor from the apex to their own board
 * ONCE, and only while this cookie is absent. Setting it here means the nudge
 * happens on a first visit and never again — so a US reader who deliberately
 * opens the India board keeps it, and nobody can be trapped on a board they
 * did not choose. The redirect is a 302 and applies to `/` alone, so a deep
 * link into any region is never bounced.
 */
try {
  var __board = (document.querySelector('meta[name="interndoor-region"]') || {}).content;
  if (__board) document.cookie = 'board=' + __board + ';path=/;max-age=31536000;samesite=lax';
} catch (e) { /* a blocked cookie just means the reader is nudged again */ }
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
  $('freshness-text').textContent = state.generatedAt
    ? `checked ${relTime(state.generatedAt)}`
    : 'standing by';
}

/** A row written before the intern/full-time split is an internship. */
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
 * and a confident "0% match" on a role the reader is well suited to is worse
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
  if (fit && fit.hit.length) {
    const m = el('div', `match${fit.pct >= 60 ? ' is-strong' : ''}`);
    m.append(el('b', null, `${fit.pct}% match`));
    m.append(el('span', null, `${fit.hit.length} of ${fit.of} skills`));
    mid.append(m);
  }

  const skills = (job.keySkills ?? []).slice(0, 4);
  if (skills.length) {
    const box = el('div', 'skills');
    for (const s of skills) {
      const chip = el('span', 'skill', s);
      // A skill the loaded resume already names is lit, so the chips stop being
      // uniform decoration and become a reason to look at one card over another.
      if (resumeHay && resumeHay.includes(` ${normSkill(s)} `)) chip.classList.add('has');
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
  } else if (job.summary) {
    // Not yet enriched — the original blurb still beats an empty card.
    mid.append(el('p', 'gist', job.summary));
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
 * @param {object|null} job  null opens the modal in RANK mode — no role to
 *   rewrite against, so it scores the whole board and sorts by fit instead.
 *   Passing a job it does not have would throw on job.company.
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

  /* RANK MODE RETURNS BEFORE THE API CALL. There is no role to rewrite
     against, and the board is already scored by this point — the upload and
     paste handlers call syncRelevance() themselves — so all that is left is to
     sort by fit and get out of the way. Sending this to /api/tailor would cost
     twenty seconds and a Gemini round trip to produce nothing. */
  if (!activeJob) {
    setResumeHay(resumeText);
    $('f-sort').value = 'match';
    syncRelevance();
    closeTailor();
    toast('Board ranked against your resume.');
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

  /* The rail's call to action. No job is attached: this is the "rank the whole
     board" entry point, so openTailor is given null and the modal's per-role
     framing falls back to the generic one. */
  $('rank-resume')?.addEventListener('click', () => openTailor(null));

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

/**
 * The page-load intro: measure the journey, let it play, clear up.
 *
 * ONE ELEMENT. The masthead's own radar is what animates — it starts large and
 * centred, sweeps once, then travels into its resting place and stays there,
 * because it was never a copy. There is no overlay to remove and no second
 * logo to cross-fade; the previous version faded one out while fading another
 * in, which is precisely what read as a cut rather than a transformation.
 *
 * The MOTION is entirely in CSS — it runs off the main thread, and the main
 * thread is busy parsing and rendering the board for exactly the window this
 * plays in. This does the two things CSS cannot: work out where the mark has
 * to start from to be centred, and where the logo sits inside each block that
 * expands out of it.
 *
 * IT NEVER TRAPS ANYONE. A safety timer clears the attribute whatever happens,
 * so a browser that never fires animationend still leaves a working page — the
 * failure mode of an intro must be "no intro".
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
    // Once a session, not once a page view: a reader moving between the board
    // and a job page should not sit through it again.
    try { sessionStorage.setItem('id-boot', '1'); } catch { /* private mode */ }
  };

  /* WHERE IT STARTS. Measured from where the mark actually rests rather than
     hardcoded, because the masthead moves — the brand shrinks below 480px and
     the bar's height changes with the rail. The keyframe's own fallbacks put
     it roughly centred, so a failed measurement still animates rather than
     sitting in the corner. */
  try {
    /* MEASURED WITH THE ANIMATION SUPPRESSED. It has `both` fill, so its 0%
       keyframe — which uses the fallback scale — is already applied by the
       time this runs: measuring straight away returns the mark at eight times
       its size and computes a scale of 1.04 from it, and the radar never grows.
       Suppressing for one synchronous reflow reads the true resting box; it is
       restored in the same task, so nothing paints in between. */
    const held = mark.style.animation;
    mark.style.animation = 'none';
    void mark.offsetWidth;
    const r = mark.getBoundingClientRect();
    mark.style.animation = held;
    if (r.width) {
      const big = Math.min(innerWidth, innerHeight) * 0.38;
      const scale = Math.min(big, 250) / r.width;
      mark.style.setProperty('--cx', `${innerWidth / 2 - (r.left + r.width / 2)}px`);
      mark.style.setProperty('--cy', `${innerHeight / 2 - (r.top + r.height / 2)}px`);
      mark.style.setProperty('--cs', String(scale));

      /* WHERE THE SITE GROWS FROM. The logo's centre expressed inside each
         expanding block's own box, so the growth radiates from the mark rather
         than from the middle of the page. */
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (const el of document.querySelectorAll('.bar, main, .outro')) {
        const b = el.getBoundingClientRect();
        el.style.setProperty('--ox', `${cx - b.left}px`);
        el.style.setProperty('--oy', `${cy - b.top}px`);
      }
    }
  } catch { /* fall back to the keyframe's own defaults */ }

  /* Cleared when the CONTENT has finished expanding, not when the mark lands.
     The mark settles at 2480ms and the expansion runs to 2660ms; clearing on
     the mark drops the rule the expansion is defined by, so the site snaps to
     full opacity halfway through its own reveal.
     Matched on the target rather than the animation name, so reduced motion —
     where every animation becomes a plain fade and the names all change —
     clears on the same line instead of waiting for the safety timer. */
  const last = document.querySelector('main');
  (last ?? mark).addEventListener('animationend', (e) => {
    if (e.target === (last ?? mark)) finish();
  });

  /* Skippable on the gestures that mean "I am already here". */
  const skip = () => finish();
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(ev, skip, { once: true, passive: true });
  }

  setTimeout(finish, 3600);
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
  renderFreshness();
  renderTotal();
  populateFilters();
  readUrl();          // after populateFilters(): the <option>s must exist first
  applyFilters();

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
  if (target) selectJob(target.id);

  setInterval(renderFreshness, 60000);
}

init();
