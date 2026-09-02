/**
 * An index of past run reports.
 *
 * Every run writes `reports/report-<runId>.html` and the queue server has
 * always served them at `/report/<runId>` — but nothing listed them, so a
 * report was reachable only by knowing its id, and closing the tab lost it.
 * There are 1,676 of them on disk. He asked the obvious question: how do I open
 * the American Express one again to write a post about it?
 *
 * So this lists them by what you would actually remember — WHICH EMPLOYERS were
 * in it — and lets you filter by that in the browser. A date is not how anyone
 * remembers a report.
 */

/** Newest first, and bounded: 1,676 files is not a page anyone reads. */
export const INDEX_LIMIT = 150;

/** `report-2026-09-02T11-34-33.html` -> `2026-09-02T11-34-33` */
export function runIdFromFile(name) {
  const m = /^report-(.+)\.html$/.exec(name);
  return m ? m[1] : null;
}

/**
 * `2026-09-02T11-34-33` -> `Wed 2 Sep, 11:34 am`
 *
 * PARSED BY HAND, NOT BY `new Date(...)`. The run id is already local time —
 * it is how the file was named — so handing it to Date would read it as UTC and
 * shift every report by the offset. This project has already had that bug in
 * the tracker's follow-up dates, where it moved a US reader's reminder a day.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function prettyRunId(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(String(id ?? ''));
  if (!m) return String(id ?? '');
  const [, y, mo, d, hh, mm] = m;
  const day = DAYS[new Date(Number(y), Number(mo) - 1, Number(d)).getDay()];
  const h = Number(hh);
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day} ${Number(d)} ${MONTHS[Number(mo) - 1]}, ${h12}:${mm} ${ampm}`;
}

/** Every distinct employer named in a report, in the order they appear. */
export function companiesIn(htmlText) {
  const out = [];
  const seen = new Set();
  for (const m of String(htmlText ?? '').matchAll(/data-company="([^"]*)"/g)) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** How many listings the report carried, counted from the cards themselves. */
export function jobCountIn(htmlText) {
  return [...String(htmlText ?? '').matchAll(/<article class="job"/g)].length;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The page.
 *
 * Filtering is client-side over data already on the page, so it stays instant
 * and needs no endpoint. A report with no listings is still listed — "that run
 * found nothing" is a real thing to want to confirm.
 */
export function renderReportIndex(entries = []) {
  const rows = entries.map((e) => {
    const cos = e.companies ?? [];
    const shown = cos.slice(0, 8);
    const more = cos.length - shown.length;
    return `<a class="r" href="/report/${encodeURIComponent(e.id)}" data-find="${esc([e.id, prettyRunId(e.id), ...cos].join(' ').toLowerCase())}">
      <div class="when">${esc(prettyRunId(e.id))}<span class="n">${e.jobs} listing${e.jobs === 1 ? '' : 's'}</span></div>
      <div class="cos">${shown.length
        ? shown.map((c) => `<span class="c">${esc(c)}</span>`).join('') + (more > 0 ? `<span class="c more">+${more}</span>` : '')
        : '<span class="c none">nothing new</span>'}</div>
    </a>`;
  }).join('');

  return `<!doctype html><meta charset="utf-8"><title>Run reports — InternDoor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#0a0a0b;--card:#141416;--ink:#e8e8e6;--dim:#8a8a84;--live:#c8ff00;--line:#26262a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;padding:32px 20px 60px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 20px;font-size:13px}
#q{width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:16px;margin-bottom:18px}
#q:focus{outline:2px solid var(--live);outline-offset:1px}
.r{display:block;padding:13px 15px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-bottom:8px;text-decoration:none;color:inherit}
.r:hover{border-color:var(--live)}
.when{font-weight:600;font-size:14px;display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.n{color:var(--dim);font-weight:400;font-size:12px;white-space:nowrap}
.cos{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px}
.c{font-size:11.5px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.c.more{border-style:dashed}
.c.none{border:0;padding-left:0;font-style:italic}
.empty{color:var(--dim);padding:20px 0}
</style>
<div class="wrap">
<h1>Run reports</h1>
<p class="sub">The ${entries.length} most recent. Type a company to find the one you mean — <a href="/report/latest" style="color:var(--live)">latest</a></p>
<input id="q" placeholder="Filter by company or date, e.g. american express" autocomplete="off" autofocus>
<div id="list">${rows || '<p class="empty">No reports yet — run a scan.</p>'}</div>
</div>
<script>
var q = document.getElementById('q');
var rows = [].slice.call(document.querySelectorAll('.r'));
q.addEventListener('input', function () {
  var t = q.value.trim().toLowerCase();
  rows.forEach(function (r) { r.hidden = t && r.dataset.find.indexOf(t) === -1; });
});
</script>`;
}
