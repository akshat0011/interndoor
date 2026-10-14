/**
 * The readable run log as a page on the queue helper (127.0.0.1:4322/log).
 * Pure: handed the file's text, returns HTML. Newest line first, a "right
 * now" box on top saying what the scan is doing and for how long, and a meta
 * refresh so a page left open keeps up without any script.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:24px;max-width:1100px;color:#111;background:#fff}
h1{font-size:20px;margin:0 0 4px} .meta{color:#555;margin:0 0 16px}
.now{border:2px solid #111;border-radius:10px;padding:12px 16px;margin:0 0 18px}
.now.wait{border-color:#b45309;background:#fffbeb} .now.err{border-color:#b91c1c;background:#fef2f2} .now.done{border-color:#15803d;background:#f0fdf4}
.now b{display:block;font-size:13px;color:#555;margin-bottom:4px}
pre{white-space:pre-wrap;font:13px/1.55 ui-monospace,Menlo,monospace;margin:0}
.l-WAIT{color:#92400e} .l-ERROR{color:#b91c1c;font-weight:600} .l-DONE{color:#15803d}
a{color:#1d4ed8} ul{padding-left:18px} li{margin:4px 0}`;

function levelOf(line) {
  const m = line.match(/^\d\d:\d\d:\d\d {2}(WAIT|ERROR|DONE) /);
  return m ? m[1] : '';
}

/** What the box at the top says. */
export function nowBox(lines, { mtimeMs, now = Date.now(), running = false } = {}) {
  const body = lines.filter((l) => /^\d\d:\d\d:\d\d /.test(l));
  const last = body[body.length - 1] ?? '';
  const quietMin = mtimeMs != null ? Math.max(0, Math.round((now - mtimeMs) / 60_000)) : null;
  const lvl = levelOf(last);
  let head;
  let cls = '';
  if (!running) {
    head = 'This run has finished.';
    cls = 'done';
  } else if (/asking again at (\d\d:\d\d)/.test(last)) {
    head = `Waiting on LinkedIn — it refused the last request. Next try at ${last.match(/asking again at (\d\d:\d\d)/)[1]}. Not stuck: it keeps trying until LinkedIn answers or you press stop.`;
    cls = 'wait';
  } else if (lvl === 'ERROR') {
    head = 'Running — the last thing it said was an error:';
    cls = 'err';
  } else {
    head = quietMin != null && quietMin >= 5
      ? `Running, but nothing new for ${quietMin} min — the last step is still going (opening or enriching can take a while).`
      : 'Running — last step:';
  }
  return `<div class="now ${cls}"><b>Right now</b>${esc(head)}${last ? `<pre>${esc(last)}</pre>` : ''}</div>`;
}

export function renderRunLogPage(text, { name, mtimeMs, now = Date.now(), running = false } = {}) {
  const lines = String(text ?? '').split('\n');
  const [title = name, started = ''] = lines;
  const body = lines.slice(2).filter((l) => l.trim());
  const rows = body.slice().reverse().map((l) => `<span class="l-${levelOf(l)}">${esc(l)}</span>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8">${running ? '<meta http-equiv="refresh" content="10">' : ''}<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(started)} · newest line first${running ? ' · refreshes every 10 seconds' : ''} · <a href="/log">all runs</a> · <a href="/scan/latest">scan view</a></p>
${nowBox(body, { mtimeMs, now, running })}
<pre>${rows}</pre>
</body></html>`;
}

export function renderRunLogIndex(entries) {
  const items = entries.map((e) => `<li><a href="/log/${esc(e.id)}">${esc(e.title)}</a> <span class="meta">${esc(e.summary ?? '')}</span></li>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Run logs</title><style>${STYLE}</style></head><body>
<h1>Run logs</h1><p class="meta">Newest first. <a href="/log/latest">The latest run</a></p>
<ul>${items || '<li>No run logs yet — they start with the next scan.</li>'}</ul>
</body></html>`;
}
