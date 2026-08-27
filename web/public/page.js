/* ============================================================
   Generated pages: the small amount of behaviour they need.

   Everything here is an upgrade to a page that already works
   without it. A crawler, or a reader whose JavaScript never
   arrives, still gets the whole posting, every link and a
   working Apply button — this file only makes the dates
   relative, the directory filterable, and adds the strip of
   roles that arrived most recently.

   NOTE: like app.js and styles.css, this file is NOT in
   publish.js's PUBLISHED allowlist, so the scheduler never
   commits it. Changes here have to be staged by hand.
   ============================================================ */

/* ---------------- theme ---------------- */

/* The no-flash read of localStorage happens inline in <head>; this only wires
   the button. Same key as app.js so a choice made on the homepage carries. */
(function theme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : !window.matchMedia('(prefers-color-scheme: light)').matches;
    const next = isDark ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* private mode */ }
  });
}());

/* ---------------- relative time ---------------- */

/* The markup carries an absolute date and a data-ago timestamp. The absolute
   date is what ships in the file — a relative one baked in at publish time
   would rewrite every job page on nearly every 30-minute run, and this repo is
   public. So the freshness a reader actually wants is computed here, at the
   moment they look. */

const DAY = 86400000;

function relTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function freshness(ms) {
  const age = Date.now() - ms;
  return age < DAY ? 'is-hot' : age < 3 * DAY ? 'is-fresh' : '';
}

function dressAges(root) {
  for (const el of root.querySelectorAll('[data-ago]')) {
    const ms = Number(el.dataset.ago);
    if (!ms) continue;
    const cls = freshness(ms);

    // The pill wraps its date in a <time>; a tile's age element is the <time>
    // itself. Write into whichever is there so the machine-readable datetime
    // attribute survives.
    const slot = el.tagName === 'TIME' ? el : el.querySelector('time');
    if (slot) slot.textContent = relTime(ms);

    el.classList.remove('is-hot', 'is-fresh');
    if (cls) el.classList.add(cls);
  }
}

dressAges(document);

/* ---------------- the mobile apply dock ---------------- */

/* It appears only once the real Apply button has scrolled off. A bar that
   duplicates a control already on screen is clutter; one that appears when the
   control is gone is the reason somebody still applies at the foot of a long
   page. CSS hides it entirely above 1000px. */
(function dock() {
  const bar = document.getElementById('dock');
  const anchor = document.querySelector('.jp-side .btn-apply');
  if (!bar || !anchor || !('IntersectionObserver' in window)) return;

  const link = bar.querySelector('a');
  const show = (on) => {
    bar.classList.toggle('is-up', on);
    bar.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (link) link.tabIndex = on ? 0 : -1;
  };

  new IntersectionObserver(([entry]) => {
    // Only below the button, never above it: scrolling up past the top of the
    // page should not summon a bar for a button that is about to reappear.
    show(!entry.isIntersecting && entry.boundingClientRect.top < 0);
  }, { threshold: 0 }).observe(anchor);
}());

/* ---------------- the company directory filter ---------------- */

/* Revealed rather than always present: without this script the input would do
   nothing, and a dead search box is worse than none. A hundred-plus rows with
   no way to jump to a name is a list nobody reads to the end. */
(function filter() {
  const box = document.getElementById('filter');
  const input = document.getElementById('filter-input');
  const none = document.getElementById('dir-none');
  if (!box || !input) return;
  box.classList.add('on');

  const cards = [...document.querySelectorAll('.dir-card')];
  const groups = [...document.querySelectorAll('[data-group]')];

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let hits = 0;
    for (const card of cards) {
      const match = !q || card.dataset.name.includes(q);
      card.hidden = !match;
      if (match) hits++;
    }
    // Hide a section heading whose whole group was filtered away, or the page
    // reads as two empty headings and a stray result.
    for (const g of groups) {
      g.hidden = ![...g.querySelectorAll('.dir-card')].some((c) => !c.hidden);
    }
    if (none) none.classList.toggle('on', hits === 0);
  });
}());

/* ---------------- "just landed" ---------------- */

/* Kept out of the HTML on purpose. Baking the newest roles into every job page
   would rewrite all ~130 of them every time one arrived, and the repo is
   public — so this reads the same jobs.json the homepage does. The links that
   matter for crawling (the employer's other roles, the hub, the directory) are
   in the HTML; this strip is for the reader. */

// Duplicated from src/pages.js and app.js. test/pages.test.mjs pins all three
// against each other, because a drift here links to a 404.
function jobPageSlug(job) {
  const part = (s, max) => String(s == null ? '' : s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'role';
  return `${part(job.company, 70)}-${part(job.title, 70)}-${part(job.id, Infinity)}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

// Tiles carry the city only; see cityOf() in src/pages.js for why.
function cityOf(location) {
  return String(location || '').split(',')[0].trim() || 'India';
}

function mode(job) {
  const raw = String(job.workplaceType || '').trim();
  if (!raw) return '';
  return /^on-?site$/i.test(raw) ? 'On-site' : raw[0].toUpperCase() + raw.slice(1);
}

// Mirrors the `tile()` markup in src/pages.js. One shape everywhere.
function tileHtml(job, prefix = '') {
  const posted = job.postedAt || job.firstSeenAt || 0;
  const meta = [
    posted ? `<span class="tile-age ${freshness(posted)}" data-ago="${posted}"><time>${esc(relTime(posted))}</time></span>` : '',
    esc(cityOf(job.location)),
    mode(job) ? esc(mode(job)) : '',
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');

  return `<a class="tile${posted && Date.now() - posted < DAY ? ' is-hot' : ''}" href="${prefix}/jobs/${jobPageSlug(job)}">
    <span class="tile-top">
      <span class="tile-crest">${esc(initials(job.company))}${job.logo ? `<img src="${esc(job.logo)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <span class="tile-co">${esc(job.company)}</span>
    </span>
    <span class="tile-role">${esc(job.title)}</span>
    <span class="tile-meta">${meta}</span>
  </a>`;
}

(async function fresh() {
  const strip = document.getElementById('fresh');
  const list = document.getElementById('fresh-list');
  if (!strip || !list) return;

  // This page's own region, carried on the strip by src/pages.js. A US job page
  // filling its "just landed" rail from India's board would be showing roles
  // the reader cannot take — and linking them under /us/, where they 404.
  // Falls back to the root so an older cached page behaves as it always did.
  const feed = strip.dataset.feed || '/data/jobs.json';
  const prefix = feed.replace(/\/data\/jobs\.json$/, '');

  let jobs;
  try {
    const res = await fetch(feed, { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    jobs = Array.isArray(data) ? data : (data.jobs || data.items || []);
  } catch (e) {
    return; // A strip that fails to load simply is not there.
  }

  // Never repeat something already on the page: this page's own posting, and
  // anything the "more at this employer" strip is already showing.
  const shown = new Set();
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) shown.add(canonical.href.split('/jobs/')[1] || '');
  // Match on the region's own prefix, or a /us/ page would compare its tiles
  // against a bare "/jobs/" that never appears on it and repeat every role the
  // "more at this employer" strip is already showing.
  for (const a of document.querySelectorAll(`.tile[href^="${prefix}/jobs/"]`)) {
    shown.add(a.getAttribute('href').slice(`${prefix}/jobs/`.length));
  }

  const picks = jobs
    .filter((j) => j.isTech !== false && (j.bullets || []).length >= 2)
    .filter((j) => !shown.has(jobPageSlug(j)))
    .sort((a, b) => (b.postedAt || b.firstSeenAt || 0) - (a.postedAt || a.firstSeenAt || 0))
    .slice(0, 6);

  if (!picks.length) return;
  list.innerHTML = picks.map((j) => tileHtml(j, prefix)).join('');
  strip.hidden = false;
  stagger(list);
}());

/* ---------------- entrance ---------------- */

/* First paint only, and only for the strips. 40ms apart, nothing past the
   eighth, and the whole cascade is done inside 300ms — the ceiling for UI
   motion. Skipped wholesale under prefers-reduced-motion by page.css. */
function stagger(list) {
  list.classList.add('in');
  [...list.children].forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i, 7) * 40}ms`;
  });
}

for (const list of document.querySelectorAll('.tiles:not(#fresh-list), .dir')) stagger(list);

/* ---------------- email signup ---------------- */

/* An upgrade, like everything else in this file. The form carries a real
   action and method, so without this handler a submit still reaches
   /api/subscribe and still subscribes the reader — they just land on the
   endpoint's JSON instead of staying here. This keeps them on the page and
   turns the endpoint's replies into something a person can read.

   The messages shown are the SERVER'S, not ours. They are written for readers
   ("That does not look like an email address"), and inventing a second set here
   would mean two wordings to keep in step and one of them going stale. Only the
   transport failure — where there is no server message — is worded locally. */
(function subscribe() {
  const form = document.querySelector('form.sub');
  if (!form) return;

  const msg = form.querySelector('.sub-msg');
  const btn = form.querySelector('.sub-b');
  const input = form.querySelector('.sub-i');
  let busy = false;

  function say(text, kind) {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const email = input.value.trim();
    /* Checked here only to save an obviously-pointless round trip. The server
       validates for real — this is a convenience, never the gate. */
    if (!email) { say('Enter an email address first.', 'bad'); input.focus(); return; }

    busy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Adding…';
    say('', '');

    try {
      const res = await fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          region: form.dataset.region || 'IN',
          company: form.querySelector('[name=company]').value,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        /* The row goes away on success. Leaving a filled-in box beside a
           thank-you invites a second submit, and the second one is the reader
           wondering whether the first worked. */
        form.querySelector('.sub-row').hidden = true;
        say('Done — you are on the list. Check your inbox to confirm.', 'good');
        return;
      }
      say(data.error || 'Could not add you just now. Please try again.', 'bad');
    } catch (err) {
      say('No connection. Please try again.', 'bad');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();
