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

function card(e, checks, decision) {
  const stop = checks.some((c) => c.level === 'stop');
  const status = decision
    ? `<span class="st st-${esc(decision.status)}">${decision.status === 'approved' ? 'Approved' : 'Rejected'}${decision.at ? ` ${esc(istTime(decision.at))}` : ''}</span>${decision.reason ? `<p class="why">${esc(decision.reason)}</p>` : ''}`
    : '';
  const actions = decision ? '' : `
    <div class="act">
      <button type="button" class="go" data-act="approve" data-id="${esc(e.id)}"${stop ? ' disabled' : ''}>Approve</button>
      <input class="reason" data-reason="${esc(e.id)}" placeholder="Reason, if rejecting" aria-label="Reason for rejecting ${esc(e.company)}" maxlength="200">
      <button type="button" class="alt" data-act="reject" data-id="${esc(e.id)}">Reject</button>
    </div>
    <p class="out" data-out="${esc(e.id)}" role="status"></p>`;
  return `<article class="sub${decision ? ' done' : ''}" id="s-${esc(e.id)}">
    <header><h2>${esc(e.company)}</h2><span class="when">${esc(istTime(e.at))} IST</span></header>
    <p class="pay">${payLine(e)}</p>
    <dl>
      <div><dt>Website</dt><dd>${link(e.website)}</dd></div>
      <div><dt>Role link</dt><dd>${link(e.link)}</dd></div>
      <div><dt>Email</dt><dd>${esc(e.email)}</dd></div>
    </dl>
    ${e.notes ? `<p class="notes">${esc(e.notes)}</p>` : ''}
    <ul class="checks">${checks.map((c) => `<li class="ck ck-${c.level}">${esc(c.text)}</li>`).join('')}</ul>
    ${status}${actions}
  </article>`;
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

/**
 * The page. `pitch` is the line he can quote to an employer (pitchNumbers in
 * src/employerpitch.js), or null when the counter could not be read.
 */
export function renderEmployerQueue({ submissions = [], decisions = {}, watchlist = [], pitch = null, error = null } = {}) {
  const pending = submissions.filter((e) => !decisions[e.id]);
  const decided = submissions.filter((e) => decisions[e.id]).slice(0, 20);
  const pitchBox = pitch
    ? `<section class="pitch" aria-label="Numbers to quote to employers">
        <p><b>${esc(pitch.applyPerDayText)}</b> Apply clicks a day, <b>${esc(pitch.applyWeekText)}</b> in the last 7 days, across <b>${esc(String(pitch.liveRoles))}</b> live roles.</p>
        <p class="dim">Say "Apply clicks", never "applicants": they are presses of our Apply button.</p>
        ${outreachNote(pitch) ? `<label class="note-l" for="note">A note to send an employer</label>
        <textarea id="note" class="note" rows="4" readonly>${esc(outreachNote(pitch))}</textarea>
        <button type="button" class="alt" id="copy-note">Copy note</button> <span class="dim" id="copied" role="status"></span>` : ''}
      </section>`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>Employer queue · InternDoor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#070708;--card:#131316;--ink:#f4f4f5;--ink2:#b4b4bc;--dim:#8a8a93;--live:#c8ff00;--line:#26262c;--line2:#393940;--warn:#fbbf24;--stop:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 'Geist',ui-sans-serif,-apple-system,'Segoe UI',sans-serif;padding:32px 16px 64px}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:24px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
.lede{color:var(--ink2);margin:0 0 20px}
.pitch{border:1px solid var(--line2);border-radius:16px;padding:14px 16px;margin:0 0 24px;background:var(--card)}
.pitch p{margin:0}.pitch b{color:var(--live);font-weight:600}
.dim{color:var(--dim);font-size:13px;margin-top:4px!important}
h3{font-size:14px;font-weight:600;color:var(--ink2);margin:28px 0 10px}
.sub{border:1px solid var(--line);border-radius:16px;background:var(--card);padding:16px 18px;margin-bottom:12px}
.sub.done{opacity:1;background:transparent}
.sub header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.sub h2{font-size:18px;font-weight:600;margin:0}
.when{color:var(--dim);font-size:13px;white-space:nowrap}
.pay{margin:2px 0 10px;color:var(--ink2)}
dl{margin:0 0 10px;display:grid;gap:4px}
dl div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px}
dt{color:var(--dim);font-size:13px}dd{margin:0;overflow-wrap:anywhere}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px}
a:hover{text-decoration-color:var(--live)}
.notes{white-space:pre-wrap;color:var(--ink2);border-left:2px solid var(--line2);padding-left:10px;margin:0 0 10px}
.checks{list-style:none;padding:0;margin:0 0 12px;display:grid;gap:4px;font-size:14px}
.ck::before{display:inline-block;width:18px;font-weight:700}
.ck-ok{color:var(--ink2)}.ck-ok::before{content:'+';color:var(--live)}
.ck-warn{color:var(--ink)}.ck-warn::before{content:'!';color:var(--warn)}
.ck-stop{color:var(--stop);font-weight:600}.ck-stop::before{content:'x';color:var(--stop)}
.act{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{font:inherit;font-weight:600;border-radius:999px;padding:8px 18px;cursor:pointer;border:1px solid var(--line2);transition:filter .2s,border-color .2s}
.go{background:var(--live);color:#16160f;border-color:var(--live)}
.go:hover{filter:brightness(1.06)}
.alt{background:transparent;color:var(--ink)}
.alt:hover{border-color:var(--ink2)}
button:active{transform:scale(.97)}
button[disabled]{background:var(--line);border-color:var(--line);color:var(--dim);cursor:not-allowed;transform:none}
button:focus-visible,.reason:focus-visible{outline:2px solid var(--live);outline-offset:2px}
.reason{flex:1 1 200px;min-width:0;font:inherit;font-size:14px;padding:8px 12px;border-radius:10px;border:1px solid var(--line2);background:var(--bg);color:var(--ink)}
.reason::placeholder{color:var(--dim)}
.out{margin:8px 0 0;font-size:14px;color:var(--ink2);white-space:pre-wrap}
.out:empty{display:none}
.st{display:inline-block;font-size:13px;font-weight:600;border-radius:999px;padding:2px 10px;border:1px solid var(--line2)}
.st-approved{color:var(--live);border-color:color-mix(in oklab,var(--live) 40%,transparent)}
.st-rejected{color:var(--ink2)}
.why{margin:6px 0 0;color:var(--dim);font-size:14px}
.empty{color:var(--ink2);border:1px dashed var(--line2);border-radius:16px;padding:22px 18px}
.err{color:var(--stop)}
.note-l{display:block;margin:14px 0 6px;font-size:13px;color:var(--ink2)}
.note{width:100%;font:inherit;font-size:14px;line-height:1.5;padding:10px 12px;border-radius:10px;border:1px solid var(--line2);background:var(--bg);color:var(--ink);resize:vertical;margin-bottom:8px}
</style>
<div class="wrap">
<h1>Employer queue</h1>
<p class="lede">${pending.length ? `${pending.length} waiting for your decision.` : 'Nothing waiting.'} Approving adds the employer to the watchlist and stores the role; it goes live with the next scan's publish. Rejecting publishes nothing.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${pitchBox}
${pending.length ? pending.map((e) => card(e, checksFor(e, watchlist), null)).join('') : `<p class="empty">No employer has sent a role since you last decided. New ones also arrive as a Mac banner and a phone push.</p>`}
${decided.length ? `<h3>Decided</h3>${decided.map((e) => card(e, checksFor(e, watchlist), decisions[e.id])).join('')}` : ''}
</div>
<script>
var copyBtn = document.getElementById('copy-note');
if (copyBtn) copyBtn.addEventListener('click', async function () {
  var t = document.getElementById('note');
  try { await navigator.clipboard.writeText(t.value); } catch (e) { t.select(); document.execCommand('copy'); }
  document.getElementById('copied').textContent = 'Copied';
});
document.addEventListener('click', async function (ev) {
  var b = ev.target.closest('button[data-act]');
  if (!b) return;
  var id = b.dataset.id, act = b.dataset.act;
  var reasonBox = document.querySelector('[data-reason="' + CSS.escape(id) + '"]');
  var reason = reasonBox ? reasonBox.value.trim() : '';
  var company = document.querySelector('#s-' + CSS.escape(id) + ' h2').textContent;
  if (!confirm((act === 'approve' ? 'Approve ' : 'Reject ') + company + '?')) return;
  var out = document.querySelector('[data-out="' + CSS.escape(id) + '"]');
  var all = document.querySelectorAll('#s-' + CSS.escape(id) + ' button');
  all.forEach(function (x) { x.disabled = true; });
  out.textContent = act === 'approve' ? 'Approving. This can take up to a minute.' : 'Rejecting.';
  try {
    var r = await fetch('/api/employers/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, action: act, reason: reason }) });
    var j = await r.json();
    out.textContent = j.output || j.error || (r.ok ? 'Done.' : 'That did not work.');
    if (r.ok) document.getElementById('s-' + id).classList.add('done');
    else all.forEach(function (x) { x.disabled = false; });
  } catch (e) {
    out.textContent = 'Could not reach the helper. Is npm run queue running?';
    all.forEach(function (x) { x.disabled = false; });
  }
});
</script>`;
}
