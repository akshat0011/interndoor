/**
 * The employer queue: what came in through /post-a-job, the checks worth
 * reading before a decision, and the page he opens once a day on this Mac at
 * http://127.0.0.1:4322/employers (17 Oct 2026, his ask: "generate a gui ...
 * for employer queue that i can check daily").
 *
 * The page DECIDES nothing. Approve and Reject run bin/job-submissions.js,
 * the one implementation of both (the owner bar's Hide/Block precedent), so a
 * decision made here and one made in the terminal are the same decision.
 *
 * Decisions live in the local store (settings DECIDED_KEY), never in Redis:
 * the list is what employers sent, the decision is his.
 */
import { LIST_KEY, KEEP, sameOrg, siteHost } from '../web/api/post-job.js';
import { matchCompany, isBlockedCompany } from './config.js';
import { parseAtsLink } from './ats.js';
import { linkedinJobId } from './employerjobs.js';

export const DECIDED_KEY = 'jobSubmissions:decided';
export const NOTIFIED_KEY = 'jobSubmissions:notified';

/** Every submission the store holds, newest first; unreadable entries dropped. */
export async function fetchSubmissions({ url, token, fetchImpl = fetch }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/lrange/${encodeURIComponent(LIST_KEY)}/0/${KEEP - 1}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read the submissions: HTTP ${res.status}.`);
  const body = await res.json();
  return (body.result ?? [])
    .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
    .filter((e) => e && typeof e.id === 'string');
}

export function readDecisions(store) {
  try { return JSON.parse(store.getSetting(DECIDED_KEY) ?? '') ?? {}; } catch { return {}; }
}

/**
 * What is worth knowing before approving one. `level` is 'ok' (good news),
 * 'warn' (look before approving) or 'stop' (do not approve).
 */
export function checksFor(e, watchlist) {
  const onList = matchCompany(e.company, watchlist);
  const ats = parseAtsLink(e.link);
  const li = linkedinJobId(e.link);
  const out = [];
  if (isBlockedCompany(e.company)) out.push({ level: 'stop', text: 'On the blocklist. Do not approve.' });
  out.push(onList
    ? { level: 'ok', text: `Already on the watchlist as ${onList}.` }
    : { level: 'warn', text: 'New employer. Approving adds it to the watchlist.' });
  if (ats) out.push({ level: 'ok', text: `Job board ${ats.provider}/${ats.token}: every future role there is collected too.` });
  else if (li) out.push({ level: 'ok', text: `LinkedIn posting ${li}.` });
  else out.push({ level: 'warn', text: 'The link is not a board we read, so the role may need adding by hand.' });
  if (!ats && !li && !sameOrg(siteHost(e.link), siteHost(e.website))) {
    out.push({ level: 'warn', text: `The link is on ${siteHost(e.link)}, not ${siteHost(e.website)}.` });
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const istTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const payLine = (e) => {
  const n = Number(e.pay);
  const amount = Number.isFinite(n) ? `₹${n.toLocaleString('en-IN')}` : esc(e.pay);
  return `${e.kind === 'fulltime' ? 'Entry-level job' : 'Internship'} · ${amount} per ${esc(e.period ?? 'month')}`;
};
/** Only an http(s) link becomes an href; anything else is shown as text. */
const safeHref = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : null);
const link = (u) => {
  const href = safeHref(u);
  return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u);
};

/** "3 h ago", "2 days ago": how long an employer has been waiting for an answer. */
export function ago(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

const statusOf = (decision) => (decision ? (decision.status === 'approved' ? 'approved' : 'rejected') : 'waiting');

/* What became of an approved role, from the decision bin/job-submissions.js
   wrote (role: stored | exists | anything else = not stored). */
function roleNote(decision) {
  if (decision?.status !== 'approved') return '';
  if (decision.role === 'stored') return 'Role stored. It goes live with the next scan\'s publish.';
  if (decision.role === 'exists') return 'The role was already on the board.';
  return 'The employer is on the watchlist, but the role was not stored: add it by hand with npm run add-url, or ask for a LinkedIn or careers-board link.';
}

/**
 * Submissions grouped by employer (the website's host, else the name), each
 * group newest first and the groups by their newest submission. One employer
 * sending three roles is one decision about the employer and three about roles.
 */
export function groupSubmissions(subs = []) {
  const groups = new Map();
  for (const e of subs) {
    const host = siteHost(e.website) || '';
    const key = host || String(e.company ?? '').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, company: e.company, host, items: [] });
    groups.get(key).items.push(e);
  }
  const at = (e) => new Date(e.at).getTime() || 0;
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => at(b) - at(a));
  return out.sort((a, b) => at(b.items[0]) - at(a.items[0]));
}

/* THE TWO EMAILS THAT MAKE AN EMPLOYER COME BACK (17 Oct 2026, his ask:
   "how would they know that we posted it so in the future they come back to
   us and become a regular client"). Nothing told an employer anything after
   the form's own confirmation. The page hands him two drafts for every
   approved role that is live: "it's live", with the link, and later the
   results, with the role's own Apply clicks. He sends them, from his own
   mail: nothing here sends mail (§2). "Apply clicks", never "applicants". */
const SIGNATURE = 'Akshat\nInternDoor · interndoor.com';
export function employerEmail(kind, e, live) {
  const team = `Hi ${String(e.company ?? '').trim()} team,`;
  const what = `${e.kind === 'fulltime' ? 'entry-level role' : 'internship'}${live?.title ? ` "${live.title}"` : ''}`;
  if (kind === 'results') {
    const n = Number(live?.clicks) || 0;
    const since = live?.firstSeenAt ? new Date(live.firstSeenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : null;
    return {
      subject: `${n.toLocaleString('en-IN')} Apply click${n === 1 ? '' : 's'} on your InternDoor listing`,
      body: [team, '',
        `A quick update on your ${what} on InternDoor: candidates have pressed Apply ${n.toLocaleString('en-IN')} time${n === 1 ? '' : 's'}${since ? ` since it went live on ${since}` : ''}. Each one is a click from InternDoor through to your own application page.`,
        live?.page ?? '', '',
        'If you are hiring for anything else, interns or freshers, reply with the links or post them at interndoor.com/post-a-job. It stays free.', '',
        SIGNATURE].join('\n'),
    };
  }
  return {
    subject: 'Your role is live on InternDoor',
    body: [team, '',
      `Thanks for posting on InternDoor. Your ${what} is live here:`,
      live?.page ?? '', '',
      'Students apply on your own posting, and listing on InternDoor is free. I will send you how many Apply clicks it gets after its first week.', '',
      'If you have more roles, post them at interndoor.com/post-a-job, or just reply to this email with the links.', '',
      SIGNATURE].join('\n'),
  };
}
const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
function mailLink(kind, e, live, label) {
  if (!EMAIL_SHAPE.test(String(e.email ?? ''))) return '';
  const m = employerEmail(kind, e, live);
  const href = `mailto:${encodeURIComponent(e.email).replace(/%40/g, '@')}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
  return `<a class="alt mail" href="${esc(href)}">${label}</a><button type="button" class="alt copy" data-copy="${esc(`${m.subject}\n\n${m.body}`)}">Copy</button>`;
}
function liveBlock(e, live) {
  if (!live) return '';
  const clicks = live.clicks == null ? '' : ` ${Number(live.clicks).toLocaleString('en-IN')} Apply click${live.clicks === 1 ? '' : 's'} so far.`;
  return `<p class="why">Live on the board: ${link(live.page)}.${clicks}</p>
      <div class="act">${mailLink('live', e, live, 'Email them: it\'s live')}${live.clicks > 0 ? mailLink('results', e, live, 'Email them: the results') : ''}</div>`;
}

function card(e, checks, decision, now, live = null) {
  const status = statusOf(decision);
  const stop = checks.some((c) => c.level === 'stop');
  const find = [e.company, e.email, e.website, e.link, siteHost(e.link)].join(' ').toLowerCase();
  const chip = status === 'waiting'
    ? `<span class="st st-waiting">Waiting ${esc(ago(e.at, now))}</span>`
    : `<span class="st st-${status}">${status === 'approved' ? 'Approved' : 'Rejected'}${decision.at ? ` ${esc(istTime(decision.at))}` : ''}</span>`;
  const after = decision
    ? `${decision.reason ? `<p class="why">Reason: ${esc(decision.reason)}</p>` : ''}${live ? liveBlock(e, live) : (roleNote(decision) ? `<p class="why">${esc(roleNote(decision))}</p>` : '')}`
    : `
      <div class="act">
        <button type="button" class="go" data-act="approve" data-id="${esc(e.id)}"${stop ? ' disabled data-stop' : ''}>Approve</button>
        <input class="reason" data-reason="${esc(e.id)}" placeholder="Reason, if rejecting" aria-label="Reason for rejecting ${esc(e.company)}" maxlength="200">
        <button type="button" class="alt" data-act="reject" data-id="${esc(e.id)}">Reject</button>
      </div>
      <p class="out" data-out="${esc(e.id)}" role="status"></p>`;
  return `<article class="sub" id="s-${esc(e.id)}" data-status="${status}" data-find="${esc(find)}">
      <header>
        <div class="what"><span class="kind">${e.kind === 'fulltime' ? 'Entry-level job' : 'Internship'}</span><span class="pay">${payLine(e).replace(/^[^·]*· /, '')}</span></div>
        ${chip}
      </header>
      <dl>
        <div><dt>Role link</dt><dd>${link(e.link)}</dd></div>
        <div><dt>Email</dt><dd>${esc(e.email)}</dd></div>
        <div><dt>Sent</dt><dd>${esc(istTime(e.at))} IST</dd></div>
      </dl>
      ${e.notes ? `<details class="notes"><summary>Their note</summary><p>${esc(e.notes)}</p></details>` : ''}
      <ul class="checks">${checks.map((c) => `<li class="ck ck-${c.level}">${esc(c.text)}</li>`).join('')}</ul>
      ${after}
    </article>`;
}

/**
 * The list on its own, so the page can swap it in every minute without a
 * reload. Counts are per status, for the tabs and the tab title.
 */
export function renderEmployerList({ submissions = [], decisions = {}, watchlist = [], live = {}, now = Date.now() } = {}) {
  const counts = { waiting: 0, approved: 0, rejected: 0, all: submissions.length };
  for (const e of submissions) counts[statusOf(decisions[e.id])] += 1;
  const groups = groupSubmissions(submissions);
  const html = groups.map((g) => {
    const statuses = [...new Set(g.items.map((e) => statusOf(decisions[e.id])))].join(' ');
    return `<section class="grp" data-statuses="${statuses}">
    <header class="grp-h">
      <h2>${esc(g.company)}</h2>
      <span class="grp-m">${g.host ? `${link(`https://${g.host}`).replace(`>https://${esc(g.host)}<`, `>${esc(g.host)}<`)} · ` : ''}${g.items.length} role${g.items.length === 1 ? '' : 's'}</span>
    </header>
    ${g.items.map((e) => card(e, checksFor(e, watchlist), decisions[e.id], now, live[e.id] ?? null)).join('')}
  </section>`;
  }).join('');
  return { html, counts };
}

/** A note he can paste to an HR or a founder, from the same live figures. */
export function outreachNote(pitch) {
  if (!pitch?.applyWeekText) return null;
  return [
    'Hi, I run InternDoor (interndoor.com), a free job board for engineering internships and entry-level roles in India.',
    `Candidates pressed Apply ${pitch.applyWeekText} times on our listings in the last 7 days${pitch.liveRoles ? `, across ${Number(pitch.liveRoles).toLocaleString('en-IN')} live roles` : ''}.`,
    'If you are hiring interns or freshers, you can list a paid role free at interndoor.com/post-a-job. No account needed, and applications go straight to your own posting.',
  ].join(' ');
}

const EMPTY = {
  waiting: 'Nothing waiting. New submissions show up here on their own, and as a Mac banner and a phone push.',
  approved: 'Nothing approved yet.',
  rejected: 'Nothing rejected yet.',
  all: 'No employer has sent a role yet.',
};

/**
 * The whole page: numbers to quote, tabs, search, the list grouped by
 * employer. It refreshes its own list every minute (/employers?fragment=1),
 * so a tab left open is always current, and the tab title carries the
 * waiting count.
 */
export function renderEmployerQueue({ submissions = [], decisions = {}, watchlist = [], pitch = null, error = null, live = {}, now = Date.now() } = {}) {
  const { html, counts } = renderEmployerList({ submissions, decisions, watchlist, live, now });
  const note = outreachNote(pitch);
  const tab = (key, label) => `<button type="button" class="tab" role="tab" data-tab="${key}" aria-selected="${key === 'waiting'}">${label} <b data-count="${key}">${counts[key]}</b></button>`;
  const stat = (value, label) => (value ? `<div class="stat"><b>${esc(value)}</b><span>${label}</span></div>` : '');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${counts.waiting ? `(${counts.waiting}) ` : ''}Employer queue · InternDoor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#070708;--card:#131316;--card2:#1c1c20;--ink:#f4f4f5;--ink2:#b4b4bc;--dim:#8a8a93;--live:#c8ff00;--line:#26262c;--line2:#393940;--warn:#fbbf24;--stop:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 'Geist',ui-sans-serif,-apple-system,'Segoe UI',sans-serif;padding:28px 16px 64px}
.wrap{max-width:920px;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:24px;font-weight:600;margin:0;letter-spacing:-.01em}
.upd{color:var(--dim);font-size:13px}
.lede{color:var(--ink2);margin:4px 0 18px;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 10px}
.stat{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.stat b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.stat:first-child b{color:var(--live)}
.stat span{color:var(--ink2);font-size:13px}
details.pitch{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:10px 14px;margin:0 0 20px}
details.pitch summary{cursor:pointer;color:var(--ink2);font-size:14px}
.note{width:100%;font:inherit;font-size:14px;line-height:1.5;padding:10px 12px;border-radius:10px;border:1px solid var(--line2);background:var(--bg);color:var(--ink);resize:vertical;margin:10px 0 8px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
.tab{font:inherit;font-size:14px;font-weight:600;color:var(--ink2);background:none;border:0;border-radius:999px;padding:6px 14px;cursor:pointer}
.tab b{font-weight:600;color:var(--dim);margin-left:4px;font-variant-numeric:tabular-nums}
.tab[aria-selected="true"]{background:var(--ink);color:#0b0b0c}.tab[aria-selected="true"] b{color:#52525b}
#q{flex:1 1 220px;min-width:0;font:inherit;font-size:14px;padding:9px 14px;border-radius:999px;border:1px solid var(--line2);background:var(--card);color:var(--ink)}
#q::placeholder{color:var(--dim)}
.grp{border:1px solid var(--line);border-radius:16px;background:var(--card);margin-bottom:12px;overflow:hidden}
.grp[hidden],.sub[hidden]{display:none}
.grp-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--line)}
.grp-h h2{font-size:17px;font-weight:600;margin:0}
.grp-m{color:var(--dim);font-size:13px}
.sub{padding:14px 18px}
.sub + .sub{border-top:1px solid var(--line)}
.sub header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.what{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.kind{font-weight:600}
.pay{color:var(--ink2)}
dl{margin:0 0 8px;display:grid;gap:3px}
dl div{display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px}
dt{color:var(--dim);font-size:13px}dd{margin:0;overflow-wrap:anywhere;font-size:14px}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px}
a:hover{text-decoration-color:var(--live)}
.notes{margin:0 0 8px;font-size:14px}.notes summary{cursor:pointer;color:var(--ink2)}
.notes p{white-space:pre-wrap;color:var(--ink2);border-left:2px solid var(--line2);padding-left:10px;margin:6px 0 0}
.checks{list-style:none;padding:0;margin:0 0 10px;display:grid;gap:3px;font-size:14px}
.ck::before{display:inline-block;width:18px;font-weight:700}
.ck-ok{color:var(--ink2)}.ck-ok::before{content:'+';color:var(--live)}
.ck-warn{color:var(--ink)}.ck-warn::before{content:'!';color:var(--warn)}
.ck-stop{color:var(--stop);font-weight:600}.ck-stop::before{content:'x';color:var(--stop)}
.act{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button.go,button.alt{font:inherit;font-weight:600;border-radius:999px;padding:8px 18px;cursor:pointer;border:1px solid var(--line2);transition:filter .2s,border-color .2s}
.go{background:var(--live);color:#16160f;border-color:var(--live)}
.go:hover{filter:brightness(1.06)}
.alt{background:transparent;color:var(--ink)}
.alt:hover{border-color:var(--ink2)}
button:active{transform:scale(.97)}
button[disabled]{background:var(--line);border-color:var(--line);color:var(--dim);cursor:not-allowed;transform:none}
button:focus-visible,.reason:focus-visible,#q:focus-visible,.tab:focus-visible{outline:2px solid var(--live);outline-offset:2px}
.reason{flex:1 1 200px;min-width:0;font:inherit;font-size:14px;padding:8px 12px;border-radius:10px;border:1px solid var(--line2);background:var(--bg);color:var(--ink)}
.reason::placeholder{color:var(--dim)}
.out{margin:8px 0 0;font-size:14px;color:var(--ink2);white-space:pre-wrap}.out:empty{display:none}
.st{display:inline-block;font-size:13px;font-weight:600;border-radius:999px;padding:2px 10px;border:1px solid var(--line2);white-space:nowrap}
.st-waiting{color:var(--warn);border-color:color-mix(in oklab,var(--warn) 40%,transparent)}
.st-approved{color:var(--live);border-color:color-mix(in oklab,var(--live) 40%,transparent)}
.st-rejected{color:var(--ink2)}
.why{margin:4px 0 0;color:var(--ink2);font-size:14px}
.sub .act + .act,.why + .act{margin-top:10px}
a.mail{display:inline-block;text-decoration:none;font-weight:600;border-radius:999px;padding:8px 16px;border:1px solid var(--line2);color:var(--ink)}
a.mail:hover{border-color:var(--ink2)}
button.copy{padding:8px 12px}
.empty{color:var(--ink2);border:1px dashed var(--line2);border-radius:16px;padding:22px 18px}
.err{color:var(--stop)}
@media (max-width:560px){.stats{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.stat:first-child{grid-column:1/-1}.tabs{width:100%;justify-content:space-between}.tab{padding:6px 10px}}
</style>
<div class="wrap">
<div class="top"><h1>Employer queue</h1><span class="upd" id="upd" role="status">Updated just now</span></div>
<p class="lede">Approving adds the employer to the watchlist and stores the role; it goes live with the next scan's publish. Rejecting publishes nothing. This page refreshes itself every minute.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${pitch ? `<div class="stats">${stat(pitch.applyPerDayText, 'Apply clicks a day')}${stat(pitch.applyWeekText, 'Apply clicks, last 7 days')}${stat(pitch.liveRoles ? Number(pitch.liveRoles).toLocaleString('en-IN') : null, 'Live roles')}</div>
<details class="pitch"><summary>Numbers to quote, and a note to send an employer</summary>
<p class="lede" style="margin:8px 0 0">Say "Apply clicks", never "applicants": they are presses of our Apply button, over the 7 days before today.</p>
${note ? `<textarea id="note" class="note" rows="4" readonly aria-label="A note to send an employer">${esc(note)}</textarea>
<button type="button" class="alt" id="copy-note">Copy note</button> <span class="upd" id="copied" role="status"></span>` : ''}
</details>` : ''}
<div class="bar">
  <div class="tabs" role="tablist" aria-label="Filter by status">${tab('waiting', 'Waiting')}${tab('approved', 'Approved')}${tab('rejected', 'Rejected')}${tab('all', 'All')}</div>
  <input id="q" type="search" placeholder="Search company, email or link" aria-label="Search submissions" autocomplete="off">
</div>
<div id="list">${html}</div>
<p class="empty" id="empty" hidden></p>
</div>
<script>
var EMPTY = ${JSON.stringify(EMPTY)};
var state = { tab: (location.hash || '#waiting').slice(1), q: '', at: Date.now() };
if (!EMPTY[state.tab]) state.tab = 'waiting';
function apply() {
  var shown = 0;
  document.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)); });
  document.querySelectorAll('.grp').forEach(function (g) {
    var any = false;
    g.querySelectorAll('.sub').forEach(function (s) {
      var ok = (state.tab === 'all' || s.dataset.status === state.tab) && (!state.q || s.dataset.find.indexOf(state.q) !== -1);
      s.hidden = !ok; if (ok) { any = true; shown += 1; }
    });
    g.hidden = !any;
  });
  var empty = document.getElementById('empty');
  empty.hidden = shown > 0;
  empty.textContent = state.q ? 'Nothing matches that search.' : EMPTY[state.tab];
}
function setCounts(c) {
  Object.keys(c).forEach(function (k) { var b = document.querySelector('[data-count="' + k + '"]'); if (b) b.textContent = c[k]; });
  document.title = (c.waiting ? '(' + c.waiting + ') ' : '') + 'Employer queue · InternDoor';
}
document.querySelector('.tabs').addEventListener('click', function (ev) {
  var t = ev.target.closest('.tab'); if (!t) return;
  state.tab = t.dataset.tab; history.replaceState(null, '', '#' + state.tab); apply();
});
document.getElementById('q').addEventListener('input', function (ev) { state.q = ev.target.value.trim().toLowerCase(); apply(); });
var copyBtn = document.getElementById('copy-note');
if (copyBtn) copyBtn.addEventListener('click', async function () {
  var t = document.getElementById('note');
  try { await navigator.clipboard.writeText(t.value); } catch (e) { t.select(); document.execCommand('copy'); }
  document.getElementById('copied').textContent = 'Copied';
});
/* A minute's refresh never wipes what he is in the middle of: a reason being
   typed or a decision on its way. */
function busy() {
  return [].some.call(document.querySelectorAll('.reason'), function (r) { return r.value.trim() || r === document.activeElement; })
    || !!document.querySelector('.sub button[disabled]:not([data-stop])');
}
async function refresh(force) {
  if (!force && busy()) return;
  try {
    var r = await fetch('/employers?fragment=1', { cache: 'no-store' });
    if (!r.ok) return;
    var j = await r.json();
    document.getElementById('list').innerHTML = j.html;
    setCounts(j.counts); state.at = Date.now(); apply(); tick();
  } catch (e) { document.getElementById('upd').textContent = 'Could not reach the helper. Is npm run queue running?'; }
}
function tick() {
  var m = Math.round((Date.now() - state.at) / 60000);
  document.getElementById('upd').textContent = m < 1 ? 'Updated just now' : 'Updated ' + m + ' min ago';
}
setInterval(refresh, 60000);
setInterval(tick, 15000);
document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
document.getElementById('list').addEventListener('click', async function (ev) {
  var cp = ev.target.closest('button[data-copy]');
  if (cp) {
    try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = 'Copied'; } catch (e) { cp.textContent = 'Copy failed'; }
    setTimeout(function () { cp.textContent = 'Copy'; }, 1500);
    return;
  }
  var b = ev.target.closest('button[data-act]');
  if (!b) return;
  var id = b.dataset.id, act = b.dataset.act;
  var card = document.getElementById('s-' + id);
  var reasonBox = card.querySelector('.reason');
  var reason = reasonBox ? reasonBox.value.trim() : '';
  var company = card.closest('.grp').querySelector('h2').textContent;
  if (!confirm((act === 'approve' ? 'Approve ' : 'Reject ') + company + '?')) return;
  var out = card.querySelector('.out');
  var all = card.querySelectorAll('button');
  all.forEach(function (x) { x.disabled = true; });
  out.textContent = act === 'approve' ? 'Approving. This can take up to a minute.' : 'Rejecting.';
  try {
    var r = await fetch('/api/employers/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, action: act, reason: reason }) });
    var j = await r.json();
    out.textContent = j.output || j.error || (r.ok ? 'Done.' : 'That did not work.');
    if (r.ok) { if (reasonBox) reasonBox.value = ''; setTimeout(function () { refresh(true); }, 2500); }
    else all.forEach(function (x) { x.disabled = false; });
  } catch (e) {
    out.textContent = 'Could not reach the helper. Is npm run queue running?';
    all.forEach(function (x) { x.disabled = false; });
  }
});
apply();
</script>`;
}
