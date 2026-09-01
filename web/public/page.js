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

/* ---------------- the application tracker ---------------- */

/* Filled from the .trk-mount element src/pages.js renders into the side rail.
   Nothing is baked into the HTML: what belongs here depends on what is in this
   reader's own browser, and a page that shipped a "Track" button would show it
   to somebody who tracked this role last week. Absent when track.js has not
   loaded, which leaves the page exactly as it was before the tracker existed. */
(function tracker() {
  const mount = document.querySelector('.trk-mount');
  const T = window.IDTrack;
  if (!mount || !T) return;

  const d = mount.dataset;
  const job = {
    id: d.id,
    company: d.company,
    title: d.title,
    location: d.location,
    url: d.url,
    applyUrl: d.applyurl,
    slug: d.slug,
    region: d.region,
    path: d.path,
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function paint() {
    const row = T.get(job.id);
    mount.replaceChildren();
    mount.classList.toggle('is-on', !!row);

    if (!row) {
      const add = el('button', 'trk-add');
      add.type = 'button';
      add.textContent = 'I applied — track this';
      add.addEventListener('click', () => { T.track(job, 'applied'); paint(); });
      mount.append(add);
      mount.append(el('p', 'trk-hint', 'Kept on this device only. No account, nothing sent to us.'));
      return;
    }

    const label = el('label', 'trk-lab');
    label.append(el('span', null, 'Status'));
    const sel = el('select', 'trk-sel');
    sel.setAttribute('aria-label', 'Application status for this role');
    let known = false;
    for (const st of T.STATUSES) {
      const opt = el('option', null, st.label);
      opt.value = st.id;
      if (st.id === row.status) { opt.selected = true; known = true; }
      sel.append(opt);
    }
    /* A status written by a newer build, arriving through a restored backup.
       Offered back rather than snapped to Applied, so opening this page cannot
       rewrite what the reader recorded. */
    if (!known) {
      const raw = el('option', null, T.statusMeta(row.status).label);
      raw.value = row.status;
      raw.selected = true;
      sel.append(raw);
    }
    sel.addEventListener('change', () => { T.track(job, sel.value); paint(); });
    label.append(sel);
    mount.append(label);

    const acts = el('div', 'trk-bar-acts');
    const open = el('a', 'trk-link', 'All my applications →');
    open.href = d.apps || '/applications';
    acts.append(open);

    const drop = el('button', 'trk-drop');
    drop.type = 'button';
    drop.textContent = 'Remove';
    drop.addEventListener('click', () => {
      // Confirmed: the row may carry a history of status changes and this is
      // the only copy of it anywhere.
      if (!confirm('Remove this from your applications?\n\n' + job.company + ' — ' + job.title)) return;
      T.remove(job.id);
      paint();
    });
    acts.append(drop);
    mount.append(acts);
  }

  // Also repaints for a change made in another tab.
  T.on(paint);
  paint();
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

