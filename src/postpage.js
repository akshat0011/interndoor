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
import { writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
/* The post image. Hidden until it loads: an older batch has no file, and a
   broken-image glyph beside a finished post reads as a fault. */
.shot{display:none;width:100%;border-radius:10px;border:1px solid var(--line);margin:12px 0 2px}
.shot.ok{display:block}
/* THE PICKER. He chooses which employers the post features and the card shows;
   the automatic six are pre-ticked so doing nothing keeps the old behaviour. */
.pick{background:var(--panel);border:1px solid var(--line);border-radius:12px;
      box-shadow:var(--shadow);padding:16px 18px;margin:0 0 18px}
.pick h2{font-size:15px;font-weight:650;margin:0 0 2px;letter-spacing:-.01em}
.pick .hint{color:var(--ink-2);font-size:13px;margin-bottom:12px}
.pick .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 14px;
            max-height:264px;overflow:auto;padding:2px 2px 10px;border-bottom:1px solid var(--line)}
.pick label{display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer;
            padding:3px 4px;border-radius:6px;min-width:0}
.pick label:hover{background:var(--chip)}
.pick label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick label em{font-style:normal;color:var(--ink-2);font-size:12px;flex:none}
/* A disabled box still has to read as "full", not as "broken". */
.pick label.full{opacity:.42;cursor:not-allowed}
.pick .bar{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
.pick .tally{color:var(--ink-2);font-size:13px;margin-right:auto}
.pick .tally.max{color:var(--warn)}
.pick .msg{font-size:13px;color:var(--ink-2);margin-top:10px;min-height:1.2em}
.pick .msg.bad{color:var(--warn)}
.card-out{margin-top:12px}
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
/* Reveal a post image only once it has loaded. An older batch has no file, and
   a broken-image glyph beside a finished post reads as a fault. */
for (const img of document.querySelectorAll('.shot')) {
  const show = () => {
    img.classList.add('ok');
    const dl = img.closest('.card')?.querySelector('.shot-dl');
    if (dl) dl.hidden = false;
  };
  if (img.complete && img.naturalWidth) show();
  else img.addEventListener('load', show, { once: true });
}

/**
 * THE PICKER'S BEHAVIOUR.
 *
 * Two buttons, one rule: whatever is ticked is what both the post and the image
 * use. Neither publishes anything — "Rewrite the post" replaces the text in the
 * block below so he can copy it, and "Generate image" renders a PNG he can save.
 *
 * The page is written to disk and reopened later, so every call has to survive
 * the queue server being down. A failed fetch says so in the panel rather than
 * leaving a button that looks like it did nothing.
 */
for (const panel of document.querySelectorAll('.pick')) {
  const region = panel.dataset.region;
  const max    = Number(panel.dataset.max) || 6;
  const boxes  = [...panel.querySelectorAll('input[type=checkbox]')];
  const tally  = panel.querySelector('.tally');
  const msg    = panel.querySelector('.msg');
  const out    = panel.querySelector('.card-out');
  const initial = boxes.filter((b) => b.checked).map((b) => b.value);

  const picked = () => boxes.filter((b) => b.checked).map((b) => b.value);
  const say = (text, bad) => { msg.textContent = text || ''; msg.classList.toggle('bad', !!bad); };

  /* AT THE CAP, THE UNTICKED BOXES ARE DISABLED rather than left tickable and
     then trimmed server-side. A box that ticks and quietly does nothing is
     worse than one that will not tick. */
  function sync() {
    const n = picked().length;
    tally.textContent = n + ' / ' + max + ' picked';
    tally.classList.toggle('max', n >= max);
    for (const b of boxes) {
      const full = n >= max && !b.checked;
      b.disabled = full;
      b.closest('label').classList.toggle('full', full);
    }
  }
  boxes.forEach((b) => b.addEventListener('change', () => { sync(); say(''); }));
  sync();

  async function call(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  panel.querySelector('[data-act=reset]').addEventListener('click', () => {
    for (const b of boxes) b.checked = initial.includes(b.value);
    sync();
    say('Back to the automatic pick. Rewrite the post to apply it.');
    out.innerHTML = '';
  });

  panel.querySelector('[data-act=compose]').addEventListener('click', async (e) => {
    const picks = picked();
    if (!picks.length) return say('Tick at least one employer.', true);
    const btn = e.currentTarget, was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Rewriting…';
    try {
      const d = await call('/api/weekly/compose', { region, picks });
      const card = document.getElementById('post-' + region);
      if (card) {
        card.querySelector('.post').textContent = d.post;
        const count = card.querySelector('.count');
        if (count) count.textContent = d.post.length + ' / 3000';
      }
      /* A name with no live role this week is dropped rather than invented, so
         SAY which ones went — silently featuring five when he ticked six is the
         kind of thing he would only notice after posting. */
      const missing = (d.stats && d.stats.pickedMissing) || [];
      say(missing.length
        ? 'Rewritten around ' + d.stats.featuredCompanies.length + '. No live role this week for: ' + missing.join(', ')
        : 'Rewritten around ' + d.stats.featuredCompanies.length + ' employers. Copy it below.');
    } catch (err) {
      say('Could not rewrite: ' + err.message + '. Is npm run queue running?', true);
    } finally {
      btn.disabled = false; btn.textContent = was;
    }
  });

  panel.querySelector('[data-act=card]').addEventListener('click', async (e) => {
    const picks = picked();
    if (!picks.length) return say('Tick at least one employer.', true);
    const btn = e.currentTarget, was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Rendering…';
    try {
      const d = await call('/api/weekly/card', { region, picks });
      out.innerHTML =
        '<img class="shot ok" src="' + d.url + '" alt="">' +
        '<a class="link shot-dl" href="' + d.url + '" download="interndoor-week-' + region + '.png">Save the image ↓</a>';
      say('Rendered ' + d.companies.length + ' logos. Attaching an image REPLACES the link preview.');
    } catch (err) {
      say('Could not render: ' + err.message + '. Is npm run queue running?', true);
    } finally {
      btn.disabled = false; btn.textContent = was;
    }
  });
}

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
  <img class="shot" src="/li/${esc(row.job_id)}.png" alt="" loading="lazy">
  <div class="actions">
    <button class="primary" data-copy="post">Copy post</button>
    <button class="second" data-copy="comment" title="Post this as the first comment, straight after the post itself">Copy 1st comment</button>
    <button data-copy="plain" title="Same post with the bold letters as ordinary text — screen readers read the bold codepoints one character at a time">Copy without bold</button>
    <button data-regen="${esc(row.job_id)}">Rewrite</button>
    <a class="link shot-dl" href="/li/${esc(row.job_id)}.png" download="${esc(row.job_id)}.png" hidden>Save image ↓</a>
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
  /* THE COMBINED POST LEADS, when there is one. It is the thing he asked the
     page for — one post covering everything selected, each posting keeping its
     own link — so it goes above the individual drafts rather than below them,
     where a page of ten single posts would bury it.
     pasteBlock is the Sunday roundup's renderer and is reused verbatim: same
     copy button, same over-limit counter, same "post it here" link. */
  const combined = batch.combined && batch.combined.text
    ? pasteBlock(
      'All selected postings, as one post',
      batch.combined.text,
      `${batch.combined.count} posting${batch.combined.count === 1 ? '' : 's'}, each with its own link`
        + (batch.combined.dropped ? ` · ${batch.combined.dropped} did not fit and are counted in the post` : ''),
      MAX_POST_CHARS,
      true,
    )
    : '';

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
  ${combined}
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
  writeFileSync(PATHS.latestPosts, html, 'utf8');
  // A null batch id means "this is not a new batch" — a re-render after rows
  // aged out. It must NOT stamp a batch file: the page holds the whole queue,
  // so writing it under the newest survivor's id would file other batches'
  // drafts under that batch and leave /posts/<id> answering with a page that
  // is not that batch.
  if (batchId == null) return PATHS.latestPosts;
  const file = join(PATHS.posts, `posts-${batchId}.html`);
  writeFileSync(file, html, 'utf8');
  return file;
}

/**
 * Delete stored post PAGES last written before the cutoff.
 *
 * The batch pages are the other half of the queue's retention: 43 of them had
 * accumulated since 24 Aug, each one reachable at /posts/<id> and each holding
 * posts the queue itself no longer has.
 *
 * TWO NAMES MUST SURVIVE WHATEVER THE CUTOFF, and both are in this directory:
 * `latest.html` is the page he actually opens, and `weekly-*.html` is the
 * Sunday roundup, which is a different feature with a different lifetime.
 * Excluded BY NAME rather than by age — relying on mtime to spare the file
 * that must never be deleted is one stale timestamp away from deleting it.
 */
export function prunePostPages(cutoffMs, dir = PATHS.posts) {
  let names;
  // A directory that does not exist yet holds nothing to prune, and creating
  // it here would make a read-only helper write to disk.
  try { names = readdirSync(dir); } catch { return 0; }
  let dropped = 0;
  for (const name of names) {
    if (!name.startsWith('posts-') || !name.endsWith('.html')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs >= cutoffMs) continue;
      unlinkSync(file);
      dropped++;
    } catch { /* a file that vanished under us needs no deleting */ }
  }
  return dropped;
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
function pasteBlock(label, text, note, limit, primary = false, id = '') {
  const over = text.length > limit;
  return `
<article class="card"${id ? ` id="${id}"` : ''}>
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
/**
 * THE PICKER — which employers the post features and the card shows.
 *
 * The automatic six arrive pre-ticked, so doing nothing leaves the roundup
 * exactly as `rankForFeature` chose it. This only ever changes what he COPIES;
 * the file on disk and the scheduled post are untouched.
 *
 * Ticking is capped at the configured `featured` count rather than silently
 * trimming a longer list on the server, because a box that ticks and then
 * quietly does nothing is worse than one that will not tick.
 */
function pickerFor(stats, max) {
  const chosen = new Set(stats.featuredCompanies ?? []);
  const all = stats.allCompanies ?? [];
  if (!all.length) return '';
  const boxes = all.map((c) => {
    const on = chosen.has(c.company);
    return `<label${on ? ' class="on"' : ''}>
      <input type="checkbox" value="${esc(c.company)}"${on ? ' checked' : ''}>
      <span>${esc(c.company)}</span><em>${c.roles}</em>
    </label>`;
  }).join('');

  return `
<section class="pick" data-region="${esc(stats.region)}" data-max="${max}">
  <h2>Feature by hand — ${esc(stats.region)}</h2>
  <div class="hint">
    ${all.length} employers opened a role this week. Tick up to ${max}; the six already ticked are the
    automatic pick. Rewriting only changes what you copy from this page — nothing is published.
  </div>
  <div class="grid">${boxes}</div>
  <div class="bar">
    <div class="tally"></div>
    <button class="second" data-act="reset">Reset to automatic</button>
    <button class="second" data-act="card">Generate image</button>
    <button class="primary" data-act="compose">Rewrite the post</button>
  </div>
  <div class="msg"></div>
  <div class="card-out"></div>
</section>`;
}

export function buildWeeklyPage(roundups, { generatedAt }) {
  /* AN ARRAY NOW, because the roundup runs per board and both belong on ONE
     page. /weekly/latest serves the most recently written file, so writing a
     page per region would mean the second silently replaced the first and he
     would only ever see one board's post. A single roundup is still accepted,
     so nothing that passed one has to change.
     The region rides in each block's LABEL rather than a section heading: the
     labels are what he reads while pasting, and "The post — United States"
     next to "The post — India" cannot be pasted into the wrong board by
     mistake. */
  const list = (Array.isArray(roundups) ? roundups : [roundups]).filter(Boolean);
  const s = list[0].stats;
  const many = list.length > 1;

  // Say what did not fit, out loud and in numbers. A roundup that silently
  // drops half the week reads as though the week were half as good, and the
  // whole point of this post is showing that the board has depth.
  const coverageFor = (st) => `
<div class="flag">
  ${many ? `<b>${esc(st.region)}</b> — ` : ''}<b>${st.roles} roles from ${st.companies} employers</b> in ${esc(st.span)}.
  The post names <b>${st.companiesListed}</b> of them; the remaining ${st.companiesDropped} are counted but not listed, because
  LinkedIn stops at ${MAX_POST_CHARS} characters and naming every employer with its roles does not fit.
  The follow-up comments carry apply links for <b>${st.linksCovered}</b> roles — the other ${st.linksOmitted} are on the board,
  which is what the single link in the post is for.
</div>`;

  const blocks = list.flatMap((r) => {
    const suffix = many ? ` — ${r.stats.region}` : '';
    return [
      coverageFor(r.stats),
      pickerFor(r.stats, r.stats.featuredCap || 6),
      pasteBlock(`The post${suffix}`, r.post, 'Paste this first.', MAX_POST_CHARS, true,
        `post-${r.stats.region}`),
      ...r.comments.map((c, i) => pasteBlock(
        (i === 0 ? 'First comment' : `Comment ${i + 1}`) + suffix,
        c,
        i === 0 ? 'The board and the channel.' : 'Apply links — optional, post as a reply.',
        MAX_COMMENT_CHARS,
      )),
    ];
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly roundup — ${esc(absTime(generatedAt))}</title>
<style>${CSS}</style></head><body>
<div class="wrap">
  <h1>This week on the board</h1>
  <div class="sub">${esc(s.span)} · ${esc(list.map((r) => r.stats.region).join(' + '))} · written ${esc(absTime(generatedAt))} ·
    no model involved, every line is a count or a company name</div>
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
