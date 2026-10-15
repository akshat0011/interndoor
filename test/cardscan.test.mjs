/**
 * PROMOTED AND VIEWED CARDS ARE CARDS (15 Oct 2026).
 *
 * scanCardsInPage found cards by their age ("3 hours ago"). LinkedIn prints
 * "Promoted" or "Viewed" in that slot instead, so those cards were never read:
 * the signed-in walk read ~19 of 25 cards a page, and employers that pay to
 * promote their postings (big ones do) were the ones skipped.
 *
 * Runs the REAL enumerateCards in Playwright's Chromium against a page shaped
 * like the results column: a scrolling list, cards with a logo and 3+ lines,
 * and a detail pane beside it.
 */
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { enumerateCards } from '../src/linkedin.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const card = (id, title, company, status) => `
  <li><div class="card"><img src="${LOGO}" alt="">
    <a href="/jobs/view/${id}/">${title}</a>
    <div>${company}</div><div>India (Remote)</div>${status}
  </div></li>`;
const html = `<!doctype html><html><body>
  <div id="list" style="height:300px;overflow:auto"><ul>
    ${card(111, 'Software Engineer Intern', 'Acme', '<div><time>2 hours ago</time></div>')}
    ${card(222, 'Backend Golang Developer', 'Proofpoint', '<div><span>Promoted</span></div>')}
    ${card(333, 'Camera Firmware Engineer', 'Qualcomm', '<div><span>Viewed</span><span> · </span><span>Promoted</span></div>')}
    ${card(444, 'Java Fullstack Developer', 'Citi', '<div>Viewed · Promoted</div>')}
    <li><div class="info"><img src="${LOGO}" alt=""><div>Jobs you may like</div><div>Based on your profile</div>
      <div>Promoted by hirer — how promoted jobs are ranked</div></div></li>
    <li><div class="ad"><img src="${LOGO}" alt=""><div>Top job picks for you</div><div>See all</div><div>Try Premium</div></div></li>
    <li style="height:900px"></li>
  </ul></div>
  <div id="pane"><img src="${LOGO}" alt=""><h1>Pane Title</h1><div>Pane Co</div><div>India · 14 hours ago</div>
    <div>Promoted by hirer</div><a href="/jobs/view/999/">x</a></div>
</body></html>`;

const base = join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
const dir = readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()[0];
const browser = await chromium.launch({ executablePath: join(base, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
try {
  const page = await browser.newPage();
  await page.setContent(html);
  const cfg = { pacing: { scrollStep: [1, 2] } };
  const { cards, listFound } = await enumerateCards(page, cfg);
  const ids = cards.map((c) => c.jobId).sort();
  check('the results column is found', listFound, true);
  check('dated, Promoted and Viewed cards are all read', ids, ['111', '222', '333', '444']);
  check('the detail pane is never a card', ids.includes('999'), false);
  check('an in-list box that merely mentions promotion is not a card', cards.some((c) => /Jobs you may like/.test(c.title)), false);
  check('an ad with no status line is not a card', cards.some((c) => /Top job picks/.test(c.title)), false);
  const promoted = cards.find((c) => c.jobId === '222');
  check('a Promoted card parses: title and company', [promoted?.title, promoted?.company], ['Backend Golang Developer', 'Proofpoint']);
  check('and carries no age (the walk treats an undated card as fresh)', promoted?.postedText ?? '', '');
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
