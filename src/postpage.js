/**
 * The page of finished LinkedIn posts.
 *
 * One card per posting, each holding the exact text to paste. Nothing here
 * publishes anything — the last step is deliberately his hands, because these
 * go out under his own name and the whole reason the queue exists is that he
 * chooses which employers are worth that.
 *
 * Styled to match src/report.js rather than the public site: this is a tool he
 * looks at, not a page anyone else ever sees.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';
import { plainText, composeComment, MAX_POST_CHARS, MAX_COMMENT_CHARS, FOLD_CHARS } from './postgen.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function absTime(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const CSS = `
:root{
  --bg:#f6f7f9; --panel:#fff; --panel-2:#fbfbfd; --ink:#14161a; --ink-2:#5b6470;
  --line:#e3e6ea; --accent:#0a66c2; --accent-ink:#fff; --good:#0a7c4a; --good-bg:#e6f5ee;
  --warn:#8a5a00; --warn-bg:#fdf3dc; --chip:#eef1f5;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 4px 12px rgba(16,24,40,.04);
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
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 96px}
h1{font-size:23px;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}
.sub{color:var(--ink-2);font-size:13.5px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  margin-bottom:16px;box-shadow:var(--shadow);overflow:hidden}
.head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:18px 18px 14px}
/* The employer is the biggest thing on the card. Scanning a page of these, the
   question is always "is this company worth a post" — the role only tells two
   of the same employer's listings apart. The public site inverts this on
   purpose, because a student scans for the ROLE; this page is not that page. */
.cname{font-size:23px;font-weight:700;letter-spacing:-.025em;line-height:1.15;margin:0 0 4px}
.role{font-size:16px;font-weight:550;letter-spacing:-.01em;margin:0 0 4px;line-height:1.3;color:var(--ink)}
.where{font-size:12.5px;color:var(--ink-2)}
.count{font-size:12px;color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums}
.count.over{color:var(--warn);font-weight:600}
.post{margin:0;padding:16px 18px;background:var(--panel-2);border-top:1px solid var(--line);
  border-bottom:1px solid var(--line);white-space:pre-wrap;word-wrap:break-word;
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  max-height:520px;overflow:auto}
/* Where LinkedIn cuts the post off behind "…see more". Everything a scroller
   ever sees without clicking is above this line, so it is worth drawing.

   THE LABEL IS CSS GENERATED CONTENT AND MUST STAY THAT WAY. The copy buttons
   read the block's textContent, and generated content is not part of it — with
   the words in the markup instead, every copied post carried "…see more —
   everything below is one click away" into the middle of the LinkedIn box. */
.fold{display:block;border-top:1px dashed var(--line);margin:12px 0 2px;text-align:right;
  font-size:10px;letter-spacing:.04em;color:var(--ink-2);opacity:.55}
.fold::after{content:"LinkedIn cuts here"}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:13px 18px}
button,.link{font-family:inherit;font-size:13px;border-radius:7px;padding:7px 13px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
button.second{border-color:var(--accent);color:var(--accent)}
button:hover,.link:hover{border-color:var(--accent)}
button.done{background:var(--good-bg);border-color:var(--good);color:var(--good);font-weight:600}
.notes{padding:0 18px 13px;font-size:12.5px;color:var(--ink-2)}
.flag{background:var(--warn-bg);color:var(--warn);border-radius:7px;padding:9px 12px;margin:0 18px 13px;font-size:12.5px}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:12px;padding:40px 20px;text-align:center;color:var(--ink-2)}
footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:var(--ink-2);font-size:12.5px}
footer code{background:var(--chip);padding:1px 5px;border-radius:4px}
`;

const JS = `
async function copy(text, btn, label){
  try {
    // 127.0.0.1 is a secure context, so the async API is available here; the
    // fallback is for the same file opened straight off disk.
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const was = btn.textContent;
    btn.textContent = label; btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1600);
  } catch (err) {
    btn.textContent = 'Copy failed — select it by hand';
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) {
    const card = btn.closest('.card');
    const src = card.querySelector('.' + btn.dataset.copy);
    return copy(src.textContent, btn, 'Copied ✓');
  }

  const again = e.target.closest('[data-regen]');
  if (again) {
    again.disabled = true;
    again.textContent = 'Rewriting…';
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobIds: [again.dataset.regen] }),
      });
      if (!res.ok) throw new Error(await res.text());
      again.textContent = 'Reloading…';
      // The server rewrites this page in place, so a reload is the whole update.
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      again.disabled = false;
      again.textContent = 'Rewrite failed — try again';
    }
  }
});
`;

/**
 * Where LinkedIn's "…see more" cut falls, drawn inside the text.
 *
 * Split at a space where there is one nearby, and never between the halves of a
 * surrogate pair — the bold lettering is entirely astral characters, so a blind
 * slice at 210 lands inside one about half the time and renders a replacement
 * character in the middle of the company name.
 */
function withFold(text) {
  if (text.length <= FOLD_CHARS) return esc(text);
  const space = text.lastIndexOf(' ', FOLD_CHARS);
  let at = space > FOLD_CHARS - 40 ? space : FOLD_CHARS;
  const lowSurrogate = (i) => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  while (at > 0 && lowSurrogate(at)) at--;
  return `${esc(text.slice(0, at))}<i class="fold"></i>${esc(text.slice(at))}`;
}

function card(draft) {
  const { row, text, facts, meta } = draft;
  const plain = plainText(text);
  const comment = draft.comment ?? composeComment(facts);
  const over = text.length > MAX_POST_CHARS;

  const flags = [];
  // A draft written on Friday and pasted on Monday still carries Friday's
  // timestamp, which is honest — but the post it sits in says "apply as soon as
  // you can", and pasting a three-day-old listing under that line is the one
  // thing that cheapens the promise the whole site is built on.
  if (facts.ageHours != null && facts.ageHours >= 24) {
    const days = Math.round(facts.ageHours / 24);
    flags.push(
      `This posting is ${days === 1 ? 'about a day' : `about ${days} days`} old. The post carries its real timestamp, so nothing here is untrue — `
      + 'but "be early" is the reason anyone follows this, so consider rewriting or skipping it.',
    );
  }
  if (!facts.linksToSite) {
    flags.push(
      'This posting has no page on InternDoor — it is outside a published region or was not classed as engineering — '
      + 'so Apply here links straight to the original posting instead.',
    );
  }
  if (meta?.fromModel === false) {
    flags.push('Written from the stored facts alone: the local model did not answer for this one. Every fact is still correct; the opening line is the generic one.');
  }
  if (meta?.dropped?.length) {
    flags.push(`Dropped from the model's draft — ${meta.dropped.join('; ')}.`);
  }

  return `
<article class="card" data-id="${esc(row.job_id)}">
  <div class="head">
    <div>
      <div class="cname">${esc(facts.company)}</div>
      <h2 class="role">${esc(row.title)}</h2>
      <div class="where">${esc(facts.location ?? 'Location not stated')}${facts.batch ? ` · batch ${esc(facts.batch)}` : ''}</div>
    </div>
    <div class="count${over ? ' over' : ''}">${text.length} / ${MAX_POST_CHARS}</div>
  </div>
  <pre class="post">${withFold(text)}</pre>
  <pre class="plain" hidden>${esc(plain)}</pre>
  <pre class="comment" hidden>${esc(comment)}</pre>
  <div class="notes">First comment (${comment.length}/${MAX_COMMENT_CHARS}) — the board and the channel live here, not in the post: two links competing for one click is strictly worse than one. Post it straight after.</div>
  <div class="actions">
    <button class="primary" data-copy="post">Copy post</button>
    <button class="second" data-copy="comment" title="Post this as the first comment, straight after the post itself">Copy 1st comment</button>
    <button data-copy="plain" title="Same post with the bold letters as ordinary text — screen readers read the bold codepoints one character at a time">Copy without bold</button>
    <button data-regen="${esc(row.job_id)}">Rewrite</button>
    <a class="link" href="https://www.linkedin.com/feed/?shareActive=true" target="_blank" rel="noreferrer">Open LinkedIn ↗</a>
    ${facts.siteUrl ? `<a class="link" href="${esc(facts.siteUrl)}" target="_blank" rel="noreferrer">Job page ↗</a>` : ''}
    ${facts.applyUrl ? `<a class="link" href="${esc(facts.applyUrl)}" target="_blank" rel="noreferrer">Original ↗</a>` : ''}
  </div>
  ${flags.map((f) => `<div class="flag">${esc(f)}</div>`).join('')}
</article>`;
}

/**
 * @param {Array<{row: object, facts: object, text: string, meta: object}>} drafts
 * @param {{batchId: string, model: string, generatedAt: number}} batch
 */
export function buildPostsPage(drafts, batch) {
  const body = drafts.length
    ? drafts.map(card).join('\n')
    : '<div class="empty"><b>Nothing in the queue.</b><br>Add postings from the run report, then press Generate.</div>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkedIn posts — ${esc(absTime(batch.generatedAt))}</title>
<style>${CSS}</style></head><body>
<div class="wrap">
  <h1>${drafts.length} post${drafts.length === 1 ? '' : 's'} ready to paste</h1>
  <div class="sub">Written ${esc(absTime(batch.generatedAt))} by <code>${esc(batch.model)}</code> on this Mac ·
    every fact comes from the stored posting, the model only wrote the opening line and the tip</div>
  ${body}
  <footer>
    Copy a post, open LinkedIn and paste it — nothing here publishes anything on your behalf.<br>
    Batch <code>${esc(batch.batchId)}</code>. These stay in the queue until you clear it, so you can come back to them.
  </footer>
</div>
<script>${JS}</script>
</body></html>`;
}

/** Write the page to a batch file plus the stable latest.html. Returns its path. */
export function writePostsPage(html, batchId) {
  ensureDirs();
  const file = join(PATHS.posts, `posts-${batchId}.html`);
  writeFileSync(file, html, 'utf8');
  writeFileSync(PATHS.latestPosts, html, 'utf8');
  return file;
}

/* ------------------------------------------------------- the Sunday roundup */

/**
 * One copyable block per thing he has to paste, in the order he pastes them.
 *
 * Deliberately NOT one big text area. The post and each comment are separate
 * actions in LinkedIn's UI — post, then comment, then comment — and a page that
 * hands him one blob to split by hand is a page that gets split wrong at 10am
 * on a Sunday.
 */
function pasteBlock(label, text, note, limit, primary = false) {
  const over = text.length > limit;
  return `
<article class="card">
  <div class="head">
    <div>
      <div class="cname">${esc(label)}</div>
      ${note ? `<div class="where">${note}</div>` : ''}
    </div>
    <div class="count${over ? ' over' : ''}">${text.length} / ${limit}</div>
  </div>
  <pre class="post">${esc(text)}</pre>
  <div class="actions">
    <button class="${primary ? 'primary' : 'second'}" data-copy="post">Copy</button>
    <a class="link" href="https://www.linkedin.com/feed/?shareActive=true" target="_blank" rel="noreferrer">Open LinkedIn ↗</a>
  </div>
</article>`;
}

/**
 * @param {{post: string, comments: string[], stats: object}} roundup
 * @param {{generatedAt: number}} meta
 */
export function buildWeeklyPage(roundup, { generatedAt }) {
  const s = roundup.stats;

  // Say what did not fit, out loud and in numbers. A roundup that silently
  // drops half the week reads as though the week were half as good, and the
  // whole point of this post is showing that the board has depth.
  const coverage = `
<div class="flag">
  <b>${s.roles} roles from ${s.companies} employers</b> in ${esc(s.span)}.
  The post names <b>${s.companiesListed}</b> of them; the remaining ${s.companiesDropped} are counted but not listed, because
  LinkedIn stops at ${MAX_POST_CHARS} characters and naming every employer with its roles does not fit.
  The follow-up comments carry apply links for <b>${s.linksCovered}</b> roles — the other ${s.linksOmitted} are on the board,
  which is what the single link in the post is for.
</div>`;

  const blocks = [
    pasteBlock('The post', roundup.post, 'Paste this first.', MAX_POST_CHARS, true),
    ...roundup.comments.map((c, i) => pasteBlock(
      i === 0 ? 'First comment' : `Comment ${i + 1}`,
      c,
      i === 0 ? 'The board and the channel.' : 'Apply links — optional, post as a reply.',
      MAX_COMMENT_CHARS,
    )),
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly roundup — ${esc(absTime(generatedAt))}</title>
<style>${CSS}</style></head><body>
<div class="wrap">
  <h1>This week on the board</h1>
  <div class="sub">${esc(s.span)} · ${esc(s.region)} · written ${esc(absTime(generatedAt))} ·
    no model involved, every line is a count or a company name</div>
  ${coverage}
  ${blocks.join('\n')}
  <footer>
    Post the first block, then add the comments as replies in order. Nothing here publishes anything on your behalf.<br>
    Written by <code>bin/weekly.js</code> on the day set in <code>postQueue.weekly</code>; run it any time with <code>npm run weekly -- --force</code>.
  </footer>
</div>
<script>${JS}</script>
</body></html>`;
}

/** Write the roundup page. Returns its path. */
export function writeWeeklyPage(html, weekKey) {
  ensureDirs();
  const file = join(PATHS.posts, `weekly-${weekKey}.html`);
  writeFileSync(file, html, 'utf8');
  writeFileSync(PATHS.latestWeekly, html, 'utf8');
  return file;
}
