import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';
import { formatStipend } from './extract.js';
import { regionOf } from './regions.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relTime(ms) {
  if (!ms) return 'unknown';
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function absTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const CSS = `
:root{
  --bg:#f6f7f9; --panel:#fff; --panel-2:#fbfbfd; --ink:#14161a; --ink-2:#5b6470;
  --line:#e3e6ea; --accent:#0a66c2; --accent-ink:#fff; --good:#0a7c4a; --good-bg:#e6f5ee;
  --warn:#8a5a00; --warn-bg:#fdf3dc; --chip:#eef1f5; --shadow:0 1px 2px rgba(16,24,40,.06),0 4px 12px rgba(16,24,40,.04);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1116; --panel:#161a21; --panel-2:#1b2029; --ink:#e8ecf1; --ink-2:#96a1b0;
    --line:#262c36; --accent:#4a9eff; --accent-ink:#08131f; --good:#5fd39b; --good-bg:#12291f;
    --warn:#e8c169; --warn-bg:#2a2213; --chip:#222833; --shadow:none;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 72px}
header{margin-bottom:22px}
h1{font-size:23px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
.sub{color:var(--ink-2);font-size:13.5px}
.statbar{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 20px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:9px 13px;box-shadow:var(--shadow)}
.stat b{display:block;font-size:19px;font-weight:650;letter-spacing:-.02em}
/* Direct child only — the count lives in a span inside the <b> and must not
   pick up the label's small-caps styling. */
.stat > span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2)}
.controls{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
input[type=search]{flex:1;min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);color:var(--ink);font-size:14px}
input[type=search]:focus{outline:2px solid var(--accent);outline-offset:-1px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chipbtn{border:1px solid var(--line);background:var(--panel);color:var(--ink-2);border-radius:999px;
  padding:5px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}
.chipbtn[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:550}
.job{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px 18px;
  margin-bottom:12px;box-shadow:var(--shadow)}
.job.hide{display:none}
.top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
/* Employer first and large. This page is a shortlist: the decision it exists to
   support is "is this company worth a LinkedIn post", and the role only tells
   two of the same employer's listings apart. The public board inverts this
   deliberately — a student scans for the ROLE — but this is not that page. */
.co{font-size:22px;font-weight:700;letter-spacing:-.025em;line-height:1.15;color:var(--ink);margin:0 0 3px}
.title{font-size:15.5px;font-weight:550;letter-spacing:-.01em;margin:0;line-height:1.35}
.title a{color:var(--ink-2);text-decoration:none}
.title a:hover{color:var(--accent);text-decoration:underline}
.posted{white-space:nowrap;font-size:12.5px;color:var(--ink-2);text-align:right}
.fresh{color:var(--good);font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 0}
.tag{background:var(--chip);border-radius:6px;padding:3px 8px;font-size:12px;color:var(--ink-2)}
.tag.money{background:var(--good-bg);color:var(--good);font-weight:600}
.tag.easy{background:var(--warn-bg);color:var(--warn);font-weight:550}
.summary{margin:12px 0 0;font-size:14px;color:var(--ink);white-space:pre-line}
.skills{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}
.skill{border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:11.5px;color:var(--ink-2)}
.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;
  border-radius:7px;padding:8px 15px;font-size:13.5px;font-weight:600}
.btn.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--line);font-weight:500}
details{margin-top:12px}
summary{cursor:pointer;font-size:13px;color:var(--ink-2);user-select:none}
summary:hover{color:var(--accent)}
.desc{margin-top:10px;padding:13px;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;
  font-size:13.5px;white-space:pre-wrap;max-height:440px;overflow:auto;color:var(--ink-2)}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:12px;padding:40px 20px;text-align:center;color:var(--ink-2)}

/* The post queue. Everything below is inert unless the page is being served by
   bin/queue-server.js — a report opened straight off disk has nowhere to send a
   click, so the bar says so rather than pretending to work. */
.regtabs{display:flex;gap:6px;margin:0 0 14px}
.regtab{border:1px solid var(--line);background:transparent;color:var(--ink-2);border-radius:9px;
  padding:8px 15px;font:inherit;font-size:13.5px;cursor:pointer;display:flex;align-items:center;gap:7px}
.regtab b{font-size:15px}
.regtab:hover{border-color:var(--accent);color:var(--accent)}
.regtab[aria-pressed=true]{background:var(--good-bg);border-color:var(--good);color:var(--good);font-weight:600}
.chips[hidden]{display:none}
.qbtn{border:1px solid var(--line);background:transparent;color:var(--ink-2);border-radius:7px;
  padding:8px 13px;font-size:13px;font-family:inherit;cursor:pointer}
.qbtn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.qbtn:disabled{opacity:.45;cursor:default}
.qbtn[aria-pressed=true]{background:var(--good-bg);border-color:var(--good);color:var(--good);font-weight:600}
.qbar{position:sticky;bottom:0;z-index:5;margin:22px -20px -72px;padding:13px 20px;
  background:var(--panel);border-top:1px solid var(--line);
  display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  box-shadow:0 -2px 14px rgba(16,24,40,.07)}
.qbar b{font-variant-numeric:tabular-nums}
.qbar .grow{flex:1}
.qbar button{font-family:inherit;font-size:13.5px;border-radius:7px;padding:9px 15px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--ink)}
.qbar button.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.qbar button:disabled{opacity:.45;cursor:default}
/* The reel button is deliberately NOT the accent colour. It publishes, and it
   must not look like the apply link sitting beside it. */
.rbtn{font-family:inherit;font-size:13.5px;border-radius:7px;padding:9px 15px;cursor:pointer;
  border:1px solid var(--rule);background:transparent;color:var(--ink)}
.rbtn[data-state="busy"]{opacity:.6;cursor:progress}
.rbtn[data-state="queued"]{border-color:var(--accent);color:var(--accent);cursor:default}
.rbtn[data-state="published"]{border-color:#2f7d4f;color:#2f7d4f;cursor:default}
.rbtn[data-state="failed"]{border-color:#a33;color:#a33}
.qbar .why{font-size:12.5px;color:var(--ink-2)}
.qbar code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:12px}
footer{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--ink-2);font-size:12.5px}
footer code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:12px}
.note{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:11px 13px;font-size:13px;margin-bottom:16px}
`;

const JS = `
const q = document.getElementById('q');
const chips = [...document.querySelectorAll('.chipbtn')];
const jobs = [...document.querySelectorAll('.job')];
const regtabs = [...document.querySelectorAll('.regtab')];
let company = 'all';
/* Null when only one board is being reported, and then the region test below
   is skipped entirely and the page behaves exactly as it did before. */
const pressedTab = regtabs.find(t => t.getAttribute('aria-pressed') === 'true');
let region = pressedTab ? pressedTab.dataset.region : null;

function apply(){
  const term = (q.value || '').toLowerCase().trim();
  let shown = 0;
  for (const j of jobs){
    const okReg = !region || j.dataset.region === region;
    const okCo = company === 'all' || j.dataset.company === company;
    const okTerm = !term || j.dataset.search.includes(term);
    const show = okReg && okCo && okTerm;
    j.classList.toggle('hide', !show);
    if (show) shown++;
  }
  document.getElementById('shown').textContent = shown;
}
q.addEventListener('input', apply);
for (const c of chips){
  c.addEventListener('click', () => {
    chips.forEach(x => x.setAttribute('aria-pressed', String(x === c)));
    company = c.dataset.co;
    apply();
  });
}

function setStat(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }
for (const t of regtabs){
  t.addEventListener('click', () => {
    regtabs.forEach(x => x.setAttribute('aria-pressed', String(x === t)));
    region = t.dataset.region;
    /* The counters belong to the board on screen, not to both at once. */
    setStat('stat-co', t.dataset.companies);
    setStat('stat-stipend', t.dataset.stipend);
    setStat('stat-easy', t.dataset.easy);
    /* Each board has its own chip row and the company filter does not carry
       across — Qualcomm on the India board is not a filter the US board has,
       and leaving it set would show an empty list that looks like a fault. */
    company = 'all';
    for (const row of document.querySelectorAll('.chips')){
      row.hidden = row.dataset.region !== region;
      for (const c of row.querySelectorAll('.chipbtn')) c.setAttribute('aria-pressed', String(c.dataset.co === 'all'));
    }
    apply();
  });
}
/* Run once at load: every card is rendered visible, so without this the
   inactive board would be on screen until the first interaction. */
apply();

/* ---- post queue -------------------------------------------------------- */
/* Same-origin calls only, so there is no host or port written down here: the
   report is served by bin/queue-server.js and these paths resolve against it.
   Opened as a file instead, every call would fail — so the UI is disabled up
   front and says why, rather than failing one click at a time. */
const bar = document.getElementById('qbar');
const count = document.getElementById('qcount');
const genBtn = document.getElementById('qgen');
const combBtn = document.getElementById('qcomb');
const clearBtn = document.getElementById('qclear');
const why = document.getElementById('qwhy');
const qbtns = [...document.querySelectorAll('.qbtn')];

/* A drafted row stays in the queue so its post can be copied again, so the
   button state tracks EVERY queue row while the Generate button tracks only the
   ones still waiting to be written. */
function paint(state){
  const set = new Set(state.ids);
  for (const b of qbtns){
    const on = set.has(b.dataset.id);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '✓ Queued' : '+ Add to post queue';
  }
  count.innerHTML = '<b>' + state.queued + '</b> waiting to be written'
    + (state.drafted ? ' · <b>' + state.drafted + '</b> already written (<a href="/posts/latest">view</a>)' : '');
  genBtn.disabled = state.queued === 0;
  /* Enabled on the WHOLE queue, not just the rows still waiting to be written.
     The combined post is a different way of saying the same selection, so a
     queue whose posts have all been drafted individually can still be rolled
     into one — and needs no model to do it. */
  combBtn.disabled = set.size === 0;
  clearBtn.disabled = set.size === 0;
}

async function api(path, body){
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

if (location.protocol !== 'http:'){
  for (const b of qbtns) b.disabled = true;
  genBtn.disabled = true;
  combBtn.disabled = true;
  clearBtn.disabled = true;
  why.innerHTML = 'The post queue needs the local helper — this page is open as a file, which cannot reach it. Start it with <code>npm run queue</code> and reopen the report at the address it prints.';
} else {
  api('/api/queue').then(paint).catch(() => {
    why.textContent = 'The local helper is not answering — start it with npm run queue.';
  });

  for (const b of qbtns){
    b.addEventListener('click', async () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      b.disabled = true;
      try { paint(await api('/api/queue', { jobId: b.dataset.id, action: on ? 'remove' : 'add' })); }
      catch { why.textContent = 'Could not reach the local helper.'; }
      b.disabled = false;
    });
  }

  clearBtn.addEventListener('click', async () => {
    try { paint(await api('/api/queue/clear', {})); } catch {}
  });

  /* ONE post covering everything in the queue, each posting keeping its own
     link. No model, so this returns in one call rather than the polling the
     per-job Generate needs. */
  combBtn.addEventListener('click', async () => {
    combBtn.disabled = true;
    combBtn.textContent = 'Building…';
    why.textContent = '';
    try {
      const r = await api('/api/generate/combined', {});
      combBtn.textContent = 'Combined post ready';
      why.innerHTML = 'One post covering ' + r.count + ' posting' + (r.count === 1 ? '' : 's')
        + ', ' + r.chars + ' characters — <a href="/posts/latest">open it</a>.';
    } catch (err) {
      combBtn.textContent = 'Generate combined post';
      combBtn.disabled = false;
      why.textContent = 'Could not build it: ' + err.message;
    }
  });

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    genBtn.textContent = 'Writing…';
    why.textContent = 'Asking the local model — this takes a few seconds per posting.';
    try {
      await api('/api/generate', {});
    } catch (err) {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate LinkedIn posts';
      why.textContent = 'Could not start: ' + err.message;
      return;
    }
    const poll = setInterval(async () => {
      let s;
      try { s = await api('/api/generate/status'); } catch { return; }
      if (s.total) why.textContent = 'Written ' + s.done + ' of ' + s.total + '…';
      if (s.error){
        clearInterval(poll);
        genBtn.disabled = false;
        genBtn.textContent = 'Generate LinkedIn posts';
        why.textContent = 'Generation failed: ' + s.error;
      } else if (s.finishedAt){
        clearInterval(poll);
        genBtn.textContent = 'Posts ready';
        why.innerHTML = 'Opened in a new tab — <a href="/posts/latest">view them</a>.';
        // The drafted rows have moved out of "waiting" — repaint so the bar
        // agrees with the server rather than showing the pre-generation count.
        api('/api/queue').then(paint).catch(() => {});
      }
    }, 1500);
  });
}
`;

function jobCard(job) {
  const stipend = formatStipend({
    min: job.stipend_min, max: job.stipend_max,
    currency: job.stipend_currency, period: job.stipend_period,
  }) || job.salary_text;

  const postedMs = job.posted_at || job.first_seen_at;
  const isFresh = postedMs && Date.now() - postedMs < 6 * 3_600_000;
  const applyUrl = job.apply_url || job.job_url;
  const external = job.apply_url && !/linkedin\.com/.test(job.apply_url);

  const tags = [];
  if (stipend) tags.push(`<span class="tag money">${esc(stipend)}</span>`);
  if (job.location) tags.push(`<span class="tag">${esc(job.location)}</span>`);
  if (job.workplace_type) tags.push(`<span class="tag">${esc(job.workplace_type)}</span>`);
  if (job.duration) tags.push(`<span class="tag">${esc(job.duration)}</span>`);
  if (job.applicants) tags.push(`<span class="tag">${esc(job.applicants)}</span>`);
  if (job.easy_apply) tags.push('<span class="tag easy">Easy Apply</span>');
  if (external) tags.push('<span class="tag">External site</span>');

  const searchBlob = [job.title, job.company, job.location, job.summary, (job.skills || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();

  return `
<article class="job" data-id="${esc(job.job_id)}" data-region="${esc(job.__reportRegion || 'IN')}" data-company="${esc(job.company_matched || job.company || 'Other')}" data-search="${esc(searchBlob)}">
  <div class="top">
    <div>
      <div class="co">${esc(job.company || 'Unknown company')}</div>
      <h2 class="title"><a href="${esc(job.job_url)}" target="_blank" rel="noreferrer">${esc(job.title)}</a></h2>
    </div>
    <div class="posted">
      <div class="${isFresh ? 'fresh' : ''}">${esc(job.posted_text || relTime(postedMs))}</div>
      <div style="opacity:.7;margin-top:2px">seen ${esc(relTime(job.first_seen_at))}</div>
    </div>
  </div>
  ${tags.length ? `<div class="meta">${tags.join('')}</div>` : ''}
  ${job.summary ? `<p class="summary">${esc(job.summary)}</p>` : ''}
  ${(job.skills || []).length ? `<div class="skills">${job.skills.map((s) => `<span class="skill">${esc(s)}</span>`).join('')}</div>` : ''}
  <div class="actions">
    <a class="btn" href="${esc(applyUrl)}" target="_blank" rel="noreferrer">${external ? 'Apply on company site' : 'Apply on LinkedIn'}</a>
    ${external ? `<a class="btn ghost" href="${esc(job.job_url)}" target="_blank" rel="noreferrer">View on LinkedIn</a>` : ''}
    <button class="qbtn" data-id="${esc(job.job_id)}" aria-pressed="false">+ Add to post queue</button>
    <button class="rbtn" data-id="${esc(job.job_id)}">📹 Reel → Instagram</button>
  </div>
  ${job.description ? `<details><summary>Full description</summary><div class="desc">${esc(job.description)}</div></details>` : ''}
</article>`;
}

/**
 * Build the HTML report. `notes` is a list of honest caveats about the run
 * (caps hit, pages skipped, CAPTCHA encountered) — never silently omitted.
 */
/** India, United States, United Kingdom — but short enough for a tab. */
function regionLabel(code) {
  if (code === 'US') return 'USA';
  if (code === 'GB') return 'UK';
  return regionOf(code)?.name ?? code;
}

/**
 * ONE PAGE, SEVERAL BOARDS, HELD APART RATHER THAN MERGED.
 *
 * Every tile on this page derives from the jobs array — new jobs, companies,
 * stipend listed, easy apply, the company chips — so a page showing two boards
 * at once would need every one of those to mean something across both, and
 * "23 companies" spanning two countries answers no question he has. The boards
 * are separate views instead: one set of cards, tagged by region, with a tab
 * that switches which set is on screen and repoints the counters at it.
 *
 * The per-region facts ride on the tab BUTTONS as data attributes rather than
 * in a JSON blob in the script. There is exactly one inline script on this
 * page and a syntax error anywhere in it kills all of it — the reel button,
 * the queue buttons and the filters together — so the less that is injected
 * into it, the better.
 */
export function buildReport({ jobs, run, notes = [], stats = {}, regions = null }) {
  const regionOfJob = (j) => j.__reportRegion || 'IN';
  const codes = (regions && regions.length ? regions : [...new Set(jobs.map(regionOfJob))])
    .filter((c, i, a) => a.indexOf(c) === i);
  const facts = (code) => {
    const rows = jobs.filter((j) => regionOfJob(j) === code);
    return {
      code,
      jobs: rows.length,
      companies: [...new Set(rows.map((j) => j.company_matched || j.company || 'Other'))].sort(),
      withStipend: rows.filter((j) => j.stipend_min || j.salary_text).length,
      easyApply: rows.filter((j) => j.easy_apply).length,
    };
  };
  const all = codes.map(facts);
  // Open on a board that has something on it, so a quiet India morning does
  // not present as an empty report while 40 US roles sit one tab away.
  const first = (all.find((f) => f.jobs > 0) ?? all[0] ?? facts('IN')).code;
  const cur = all.find((f) => f.code === first) ?? facts('IN');
  const companies = cur.companies;
  const withStipend = cur.withStipend;
  const easyApply = cur.easyApply;

  const body = jobs.length
    ? jobs.map(jobCard).join('\n')
    : `<div class="empty"><b>No new matching internships this run.</b><br>
       Scanned ${esc(run.cardsSeen ?? 0)} job cards across ${esc(run.pagesScanned ?? 0)} pages — none were new postings from your watchlist companies.</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkedIn internships — ${esc(absTime(run.startedAt))}</title>
<style>${CSS}</style></head><body>
<div class="wrap">
<header>
  <h1>New internships on your watchlist</h1>
  <div class="sub">Run finished ${esc(absTime(run.finishedAt || Date.now()))} · scanned ${esc(run.pagesScanned ?? 0)} pages, ${esc(run.cardsSeen ?? 0)} cards · next run within 3 hours</div>
</header>

${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}

${all.length > 1 ? `<div class="regtabs" role="group" aria-label="Board">
  ${all.map((f) => `<button class="regtab" data-region="${esc(f.code)}" aria-pressed="${String(f.code === first)}"
    data-jobs="${f.jobs}" data-companies="${f.companies.length}" data-stipend="${f.withStipend}" data-easy="${f.easyApply}"
  >${esc(regionLabel(f.code))} <b>${f.jobs}</b></button>`).join('')}
</div>` : ''}

<div class="statbar">
  <div class="stat"><b><span id="shown">${cur.jobs}</span></b><span>new jobs</span></div>
  <div class="stat"><b id="stat-co">${companies.length}</b><span>companies</span></div>
  <div class="stat"><b id="stat-stipend">${withStipend}</b><span>stipend listed</span></div>
  <div class="stat"><b id="stat-easy">${easyApply}</b><span>easy apply</span></div>
  <div class="stat"><b>${esc(stats.total ?? 0)}</b><span>tracked all-time</span></div>
</div>

${jobs.length ? `<div class="controls">
  <input type="search" id="q" placeholder="Filter by title, skill, location…" autocomplete="off">
  ${all.map((f) => `<div class="chips" data-region="${esc(f.code)}"${f.code === first ? '' : ' hidden'}>
    <button class="chipbtn" data-co="all" aria-pressed="true">All</button>
    ${f.companies.map((c) => `<button class="chipbtn" data-co="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}
  </div>`).join('')}
</div>` : ''}

${body}

<footer>
  <!-- Reports are kept for every run and served at /report/<runId>, but nothing
       listed them, so closing the tab used to lose one. /reports is the index. -->
  <a href="/reports" style="color:var(--live,#c8ff00)">&larr; All past reports</a> ·
  Generated by <code>linkedin-internship-watcher</code> · run <code>${esc(run.runId)}</code> ·
  ${esc(stats.skipped ?? 0)} non-matching cards remembered so they are not re-opened next run.<br>
  Edit <code>config.json</code> to change the company watchlist, search terms, or pacing.
</footer>

${jobs.length ? `<div class="qbar" id="qbar">
  <span id="qcount"><b>0</b> waiting to be written</span>
  <button class="go" id="qgen" disabled>Generate LinkedIn posts</button>
  <button id="qcomb" disabled>Generate combined post</button>
  <button id="qclear" disabled>Clear queue</button>
  <span class="why grow" id="qwhy"></span>
</div>` : ''}
</div>
${jobs.length ? `<script>${JS}
/* ---- reel -> instagram -------------------------------------------------
   One press renders a reel for this posting and publishes it to Instagram.
   It is a PUBLISH button, so it confirms first: the render is a minute of
   work and the post is public the moment it lands, and a misclick on a card
   in a long list is exactly the kind of mistake that is not worth being
   clever about.

   State comes from the server, not from this page, because a render outlives
   a reload and a row already published must never offer the button again. */
const rbtns = [...document.querySelectorAll('.rbtn')];

function paintReels(state){
  const by = new Map((state.posts || []).map(p => [p.jobId, p]));
  const busy = state.running && !state.running.finishedAt;
  const queue = state.queue || [];
  for (const b of rbtns){
    const p = by.get(b.dataset.id);
    const isMe = busy && state.running.jobId === b.dataset.id;
    const waiting = queue.indexOf(b.dataset.id);
    if (waiting >= 0 && !isMe){
      /* Claimed and waiting for the worker. The press already succeeded, so
         this must not look like nothing happened. */
      b.dataset.state = 'busy';
      b.textContent = '⏳ ' + (waiting === 0 ? 'Next up…' : (waiting + 1) + 'th in line');
      b.disabled = true;
    } else if (isMe){
      b.dataset.state = 'busy';
      /* Name the stage. The tunnel step alone took 1m45s on the first real
         publish, and a flat "Publishing…" for three minutes reads as a hang. */
      b.textContent = state.running.stage === 'publishing' ? '⏳ Uploading…' : '⏳ Rendering…';
      b.disabled = true;
    } else if (p && p.status === 'scheduled'){
      /* Rendered and waiting for its slot. Naming the time is the whole point:
         "queued" alone leaves him wondering whether it worked. */
      b.dataset.state = 'queued';
      b.textContent = '🕐 ' + (p.slotLabel || 'Queued');
      b.disabled = true;
      b.title = 'Rendered and waiting for its slot';
    } else if (p && p.status === 'published'){
      b.dataset.state = 'published';
      b.textContent = '✓ On Instagram';
      b.disabled = true;
      if (p.url) b.title = p.url;
    } else if (p && p.status === 'failed'){
      b.dataset.state = 'failed';
      b.textContent = '↻ Retry reel';
      b.title = p.error || '';
      b.disabled = false;
    } else {
      /* NOT disabled while another reel is working. The press returns as soon
         as the job is claimed, so three good jobs are three clicks — the
         waiting is the server's problem, not the button's. */
      b.dataset.state = '';
      b.textContent = '📹 Reel → Instagram';
      b.disabled = false;
    }
  }
}

let reelTimer = null;
async function pollReels(){
  const state = await api('/api/reel/status');
  paintReels(state);
  const busy = (state.running && !state.running.finishedAt) || (state.queue || []).length > 0;
  const queued = (state.posts || []).some(p => p.status === 'scheduled');
  clearTimeout(reelTimer);
  /* Fast while something is in flight, slow while something is merely waiting
     for its slot, and not at all otherwise — a report left open in a tab all
     day should not talk to the server every two seconds forever. */
  if (busy) reelTimer = setTimeout(pollReels, 2000);
  else if (queued) reelTimer = setTimeout(pollReels, 30000);
}

for (const b of rbtns){
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    const card = b.closest('article');
    const who = card ? card.querySelector('h2, h3, .role, .co') : null;
    /* \\n, not \n. This whole page is built inside a TEMPLATE LITERAL, so a
       single backslash is consumed here at build time and a REAL newline is
       emitted into a single-quoted string in the output — which is a syntax
       error, and one that kills the ENTIRE inline script, not just this
       handler. The queue buttons went dead with it. */
    if (!confirm('Render a reel for this posting and publish it to Instagram?\\n\\n'
      + (who ? who.textContent.trim() + '\\n\\n' : '')
      + 'It renders now. If another reel went out recently it is queued for a '
      + 'later slot rather than posted straight away.\\n\\n'
      + 'This posts publicly and cannot be undone from here.')) return;
    b.disabled = true;
    b.textContent = '⏳ Queued…';
    const res = await api('/api/reel', { jobId: b.dataset.id });
    if (res && res.error){ alert('Could not start: ' + res.error); b.disabled = false; }
    pollReels();
  });
}
pollReels();
</script>` : ''}
</body></html>`;
}

/** Write the report to a timestamped file plus `latest.html`. Returns its path. */
export function writeReport(html, runId) {
  ensureDirs();
  const file = join(PATHS.reports, `report-${runId}.html`);
  writeFileSync(file, html, 'utf8');
  writeFileSync(PATHS.latestReport, html, 'utf8');
  return file;
}
