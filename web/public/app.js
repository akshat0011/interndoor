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


/** How many skill chips a card shows before it collapses to a count. */
const MAX_CHIPS = 3;

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

  /* THE CHIPS ARE BUTTONS NOW, and that is what makes them worth their space.
     They were decoration: four grey words per card, identical in weight to the
     four on the card above, doing nothing. Clicking one searches the board for
     it, which turns a chip into the fastest filter on the page — you see
     "pytorch" on one listing and get every other listing naming it in one
     click. It also earns the hover state they now have; a chip that lights up
     under the cursor and then does nothing is a worse lie than a flat one.

     stopPropagation, or the search would fire AND the card would open behind
     the newly filtered list — the same guard .card-go already carries. */
  const skills = (job.keySkills ?? []);
  if (skills.length) {
    /* THREE, not four. The cap is about evenness down the column, not about
       the individual card: an employer that names nine skills and one that
       names two produced visibly different amounts of texture in the same
       list, and four was enough for the busy ones to look cluttered next to
       the sparse ones. Three plus a count reads the same on every card. */
    const box = el('div', 'skills');
    for (const sk of skills.slice(0, MAX_CHIPS)) {
      const chip = el('button', 'skill', sk);
      chip.type = 'button';
      chip.title = `Search for ${sk}`;
      if (resumeHay && resumeHay.includes(` ${normSkill(sk)} `)) chip.classList.add('has');
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const q = $('q');
        q.value = sk;
        q.dispatchEvent(new Event('input', { bubbles: true }));
        // Back to the top of the list, or the reader is left mid-feed looking
        // at a result set that changed above them.
        $('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      box.append(chip);
    }
    /* A COUNT, NOT A TRUNCATION. Four chips is the cap because five wrap on a
       tablet, but a card holding nine skills and a card holding exactly four
       looked identical, which is the "some cards feel richer than others"
       problem in reverse — the rich ones were being flattened to look like the
       sparse ones. */
    if (skills.length > MAX_CHIPS) box.append(el('span', 'skill skill-more', `+${skills.length - MAX_CHIPS}`));
    mid.append(box);
  }
  row.append(mid);

  /* THE DRAINING BAR IS GONE.
     A 2px lime rule under the timestamp, shrinking as a posting aged through
     its first 24 hours — a nice idea that nobody could read. It carried no
     label, no scale and no endpoint, so it said "something is running out"
     without saying what or by when, and it sat directly under a figure that
     already answers the question in words. The pill it sits under encodes the
     same thing in a way that needs no key: lime under 24h, hot under an hour,
     plain after that. One signal, understood on sight, instead of two of which
     one has to be explained. */
  const ageBox = el('div', `age${blazing ? ' blazing' : age != null && age < FRESH_MS ? ' fresh' : ''}`);
  ageBox.append(el('b', null, blazing ? 'JUST NOW' : shortAge(job.postedAt)));
  // Age and Apply share a footer strip. Applying used to cost two taps and a
  // full-screen context switch — open the role, then find the button — and the
  // detail pane exists to answer questions, not to gate the one action every
  // visitor came to take.
  const foot = el('div', 'card-foot');
  foot.append(ageBox);

  /* "Click for details →" USED TO SIT HERE AND IS GONE.
     It was a sentence of instructions printed on every one of 251 cards, which
     is what a UI says when it cannot show what it does. The affordance is now
     the chevron at the end of the row plus the card's own hover state — the
     ordinary way a list row says it opens, carrying no words and repeating
     nothing. The row is still role="button" with its own label, so nothing was
     lost for a screen reader; that sentence was aria-hidden decoration. */

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

  /* NO CHEVRON.
     It was added to replace "Click for details →" and it competed with the
     thing beside it: a chevron and an "Apply →" arrow both point right, sit on
     the same edge of the same card, and mean different things — one opens a
     panel, one leaves the site. Two right-pointing marks is not a clearer
     affordance than one, it is an ambiguous one.
     The role title carries it instead (see .role in styles.css): on hover it
     underlines, which is the one signal every reader already knows means
     "this opens", and it points at the thing that opens rather than at a
     corner of the card. */

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
  /* "N roles from M employers".
     The employer count used to be the caption under the vetting panel's logo
     wall, and it is the one fact on that panel worth keeping: it is the size of
     the vetted list, measured on the live board, and it is the answer to "is
     this a real board or twelve listings". The header line above the feed is
     where it costs nothing. Counted on what is SHOWING, so it tracks the
     filters rather than contradicting them. */
  const employers = new Set(state.filtered.map((j) => j.company)).size;
  /* THE NUMBERS ARE THE POINT, so they are typeset as numbers rather than as
     part of a sentence. This was one run of 11px grey uppercase mono, which is
     the register this file uses for labels — so the two figures that say how
     big the board is read as a caption and were skipped. The count is the
     answer to "is this a real board", and when a filter is on it is the answer
     to "did that do anything", so it is worth being able to read at a glance.
     Built as nodes rather than a template string because the figures and the
     words they label are styled differently. */
  const head = $('result-count');
  head.replaceChildren();
  /* Each figure and its noun are ONE flex item, not two. As separate items the
     container's column-gap fell between the number and its own word as well as
     between the two statistics, so "251 roles 151 employers" had four equal
     gaps and read as four things. Grouping puts a small space inside a pair and
     a large one between pairs, which is the only reason the line parses at a
     glance. It also keeps the accessible text readable — as bare siblings it
     flattened to "251roles151employers". */
  const stat = (value, word, extra) => {
    const g = el('span', 'rc-stat');
    g.append(el('b', null, String(value)), el('span', null, word));
    if (extra) g.append(el('span', 'rc-of', extra));
    return g;
  };
  if (state.jobs.length === 0) {
    head.append(el('span', 'rc-none', 'nothing on the radar yet'));
  } else {
    /* ROLES AGAINST ROLES. The filtered figure used to be compared against
       `state.jobs.length`, which is POSTINGS — so a board showing 251 roles
       said "90 of 265" the moment a filter was applied, because one opening
       advertised in twenty-one cities is one role and twenty-one postings. It
       read as a rounding error rather than as the mismatch it was, and only
       became visible when the line stopped being a slash and started being a
       sentence. Grouped the same way the visible list is, so the two numbers
       are the same kind of thing. */
    const totalRoles = groupByRole(state.jobs.filter((j) => kindOf(j) === state.kind)).size;
    head.append(stat(n, n === 1 ? 'role' : 'roles',
                     anyFilterActive() ? `of ${totalRoles}` : null));
    if (employers) head.append(stat(employers, employers === 1 ? 'employer' : 'employers'));
  }
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

  /* THE ROLE OPENS AS A DIALOG AT EVERY WIDTH NOW.
     ----------------------------------------------------------------------
     This used to be gated on `(max-width: 1000px)`, because above that the
     pane was a real column in the page and had nothing to open into. There is
     no column any more, so the branch is gone and the two sizes differ only in
     how the same element is painted: a centred modal on desktop, the same
     full-screen sheet as before on a phone. Both are in styles.css.

     The element the reader came from is remembered rather than looked up on
     close: filtering rebuilds every .row, and a card that has been replaced
     cannot be focused. If it is gone by then, focus falls back to the list. */
  detailOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('detail-backdrop').hidden = false;
  const col = $('detail-col');
  col.hidden = false;
  col.classList.add('open');
  document.body.style.overflow = 'hidden';
  // Into the dialog, not left behind on the card underneath it. `.back` is the
  // first focusable thing in the pane and it is the control that closes.
  requestAnimationFrame(() => $('detail')?.querySelector('.back')?.focus());
}

/** The card the dialog was opened from, so focus can go back where it started. */
let detailOpener = null;

/** Drop the selection: no role is open, nothing on the board is current. */
function deselect() {
  state.selectedId = null;
  for (const card of document.querySelectorAll('.row')) card.removeAttribute('aria-current');
  if (location.hash.startsWith('#job-')) history.replaceState(null, '', location.pathname + location.search);
}

function closeDetail() {
  const col = $('detail-col');
  document.body.style.overflow = '';
  if (!col.classList.contains('open')) { deselect(); return; }

  $('detail-backdrop').hidden = true;

  /* Focus goes back to the card that opened this, and it goes back BEFORE the
     dialog is hidden. Hiding first drops focus to <body>, and the browser then
     scrolls to wherever the restored element happens to be as a second,
     separate jump — the page appears to lurch after the dialog has already
     gone. Restoring first makes it one movement. */
  const back = detailOpener?.isConnected
    ? detailOpener
    : document.querySelector(`.row[data-id="${CSS.escape(String(state.selectedId ?? ''))}"]`);
  (back ?? $('joblist'))?.focus?.({ preventScroll: true });
  detailOpener = null;

  // display:none cannot be transitioned, so the dialog has to finish its exit
  // animation before it is hidden. Falling back on a timer as well as the event
  // matters: if the animation is suppressed — prefers-reduced-motion — then
  // animationend never fires and the dialog would be left stuck open.
  col.classList.add('closing');
  const done = () => {
    col.classList.remove('open', 'closing');
    col.hidden = true;
    col.removeEventListener('animationend', done);
    deselect();
  };
  col.addEventListener('animationend', done);
  setTimeout(done, 260);
}

function renderDetail(job) {
  const d = $('detail');
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
  // #detail-role is what aria-labelledby on the dialog points at, so the dialog
  // announces the role rather than an unnamed one. Set here rather than in the
  // markup because the element is built fresh on every selection.
  const roleHeading = el('p', 'p-role', job.title);
  roleHeading.id = 'detail-role';
  d.append(roleHeading);

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
  // A figure when there is one, and otherwise NOT DISCLOSED — never "Unpaid".
  // Silence left a reader unable to tell an unpaid role from an unstated one;
  // this says which it is. The card stays silent, because a "not disclosed"
  // chip on three cards in four is noise, not information.
  const money = stipendText(job);
  if (money) addFact('stipend', money, 'cash');
  else addFact('stipend', 'Not disclosed', 'unk');
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
  // Clicking away from a dialog closes it. On the role dialog this is the only
  // pointer affordance a desktop reader has besides the back button, since the
  // board behind it is visibly inert while the veil is up.
  $('detail-backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The tailor sits on top of the role dialog and is closed first, or Escape
    // would take both down at once when it was opened from a role.
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

  // The rail's call to action. No job is attached: this is the "rank the whole
  // board" entry point, so openTailor is given null and the modal's per-role
  // framing falls back to the generic one. It moved here from the vetting panel
  // the right-hand column used to show, which no longer exists.
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
  populateFilters();
  readUrl();          // after populateFilters(): the <option>s must exist first
  applyFilters();

  const hash = location.hash.match(/^#job-(.+)$/);
  const target = hash && state.jobs.find((j) => j.id === hash[1]);
  // A ROLE IS OPENED ONLY WHEN SOMEBODY ASKS FOR ONE — by clicking, or by
  // arriving on a #job- link they were given. Desktop used to auto-open the
  // newest listing to stop the right-hand column sitting empty; there is no
  // column to fill now, and opening a dialog over the board on first paint
  // would be considerably worse than the problem it once solved.
  if (target) selectJob(target.id);

  setInterval(renderFreshness, 60000);
}

init();
