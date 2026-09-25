/**
 * The scan, drawn in the scraper's own Brave window so it can be WATCHED, and
 * kept afterwards as one page per run so it can be CHECKED.
 *
 * Asked for on 25 Sep 2026, the day discovery moved to LinkedIn's public
 * search: "I also want to be able to see the jobs being scraped and the card
 * pages being searched like we used to before so that I can manually check
 * and see if any bug occurs — don't hide anything from me." The classic walk
 * was watchable by accident: the search page itself was on screen. The public
 * search is a plain request with nothing to look at, so this draws what it
 * returned, page by page, in the same window the jobs are then opened in.
 *
 * EVERY CARD IS SHOWN, NOT ONLY THE ONES THAT GOT THROUGH. When a page is done
 * each card carries what actually happened to it, read back from the store
 * (Store.cardOutcome) rather than re-decided here — so the view cannot say
 * something the gates did not do.
 *
 * NOTHING ON IT IS A LINK. This is the scraper's own browser; clicking in it
 * mid-scan swaps the page out from under an open and can file one employer's
 * posting under another (CLAUDE.md §7). Ids and URLs are plain, selectable
 * text to copy into another browser.
 *
 * It costs LinkedIn nothing: the page is `about:blank` filled locally. The
 * logos load from LinkedIn's image CDN, as they did on the old results page.
 * Everything here fails soft — a view that breaks must never cost the walk.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * One card's outcome, from what the walk recorded. Order matters: a card saved
 * THIS run also has a first run id, and a card refused after an open can have
 * both a reason and nothing stored.
 */
export function outcomeFor({ pending = false, repeat = false, opened = false, skipReason = null, firstRunId = null, runId = null, refusedBefore = null } = {}) {
  if (pending) return { kind: 'pending', text: 'checking…' };
  if (repeat) return { kind: 'skip', text: 'repeat of a card already read in this walk' };
  if (firstRunId && firstRunId === runId) return { kind: 'saved', text: 'SAVED this run — new listing' };
  if (skipReason) return { kind: opened ? 'refused' : 'skip', text: opened ? `opened, then refused: ${skipReason}` : skipReason };
  if (firstRunId) return { kind: 'held', text: 'already held — not opened again' };
  if (refusedBefore) return { kind: 'skip', text: `refused when opened earlier (${refusedBefore}) — not opened again` };
  if (opened) return { kind: 'refused', text: 'opened, but could not be read — see the run log' };
  return { kind: 'unchecked', text: 'not checked — the walk stopped before this card' };
}

const COLOURS = {
  pending: '#6b7280', skip: '#6b7280', held: '#2563eb', saved: '#15803d', refused: '#b45309', unchecked: '#b91c1c',
};

const STYLE = `
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px 28px; color: #111; background: #fafafa; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 26px 0 4px; }
  .warn { background: #fff7ed; border: 1px solid #fdba74; padding: 6px 10px; border-radius: 4px; margin: 8px 0 12px; }
  .meta { color: #444; margin: 2px 0; word-break: break-all; }
  .url { font: 12px ui-monospace, monospace; user-select: all; }
  .totals { margin: 8px 0 10px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  td { border-top: 1px solid #e5e5e5; padding: 8px; vertical-align: middle; }
  td.logo img, .nologo { width: 40px; height: 40px; object-fit: contain; display: inline-block; background: #f0f0f0; }
  .title { font-weight: 600; } .sub { color: #555; font-size: 13px; }
  .id { color: #888; font: 12px ui-monospace, monospace; user-select: all; }
  .badge { color: #fff; border-radius: 4px; padding: 3px 8px; font-size: 12px; }`;

/** One page of results: header, what was requested, and every card. */
export function renderScanSection({ region, label, pageNo, url, windowHours, cards = [], outcomes = [], totals = {}, done = false, at = new Date() }) {
  const rows = cards.map((c, i) => {
    const o = outcomes[i] ?? outcomeFor({ pending: true });
    const logo = /^https:\/\//.test(c.logoUrl ?? '') ? `<img src="${esc(c.logoUrl)}" alt="">` : '<span class="nologo"></span>';
    return `<tr>
      <td class="logo">${logo}</td>
      <td><div class="title">${esc(c.title)}</div>
          <div class="sub">${esc(c.company || '— no company on the card —')} · ${esc(c.location)} · ${esc(c.postedText || 'no date')}</div></td>
      <td class="id">${esc(c.jobId ?? '')}</td>
      <td><span class="badge" style="background:${COLOURS[o.kind] ?? COLOURS.skip}">${esc(o.text)}</span></td>
    </tr>`;
  }).join('\n');
  const tally = outcomes.reduce((m, o) => (m[o.kind] = (m[o.kind] ?? 0) + 1, m), {});
  return `<section>
<h2>${esc(region)} · ${esc(label)} · page ${esc(pageNo)} ${done ? '— done' : '— checking'}</h2>
<p class="meta">${esc(windowHours)}h window · ${cards.length} cards on this page · ${esc(at.toISOString().replace('T', ' ').slice(0, 19))} UTC</p>
<p class="meta">Requested (LinkedIn's public job search): <span class="url">${esc(url)}</span></p>
<p class="totals">Run so far: ${esc(totals.cards ?? 0)} cards read · ${esc(totals.opened ?? 0)} opened · ${esc(totals.saved ?? 0)} saved${done ? ` — this page: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}</p>
<table>${rows}</table>
</section>`;
}

/** A whole document around one or more sections. */
export function renderScanDocument(title, sections, { live = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
<h1>${esc(title)}</h1>
${live ? '<p class="warn">This is the scraper\'s own browser. Do not click or type in it while a scan is running — copy an id or URL into another browser instead.</p>' : ''}
${sections.join('\n')}
</body></html>`;
}

/**
 * Put the view in the window. `about:blank` first so the page is not drawn
 * inside whatever LinkedIn page was last open. Never throws.
 */
export async function showScanView(page, html) {
  try {
    if (page.url() !== 'about:blank') await page.goto('about:blank');
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return true;
  } catch {
    return false;
  }
}
