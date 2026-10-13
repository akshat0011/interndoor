/* Share images: one 1200x630 PNG per post, drawn by Playwright's own Chromium
   from the template below (never Brave: that browser belongs to the scan).

   An image is redrawn only when what it shows changes. Its file name stays put
   and the page asks for it with ?v=<hash of its inputs>, so a reader's
   browser fetches a new card when, and only when, the card changed. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { esc, smartQuotes } from './markdown.mjs';
import { MARK } from './icons.mjs';

export const OG_VERSION = 3;

export function ogInputs(card) {
  return { v: OG_VERSION, kicker: card.kicker, title: card.title, figure: card.figure ?? null, figureLabel: card.figureLabel ?? null };
}

export const ogHash = (card) => createHash('sha256').update(JSON.stringify(ogInputs(card))).digest('hex').slice(0, 10);

function fontFace(file, weight) {
  const data = readFileSync(file).toString('base64');
  return `@font-face{font-family:Geist;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format('truetype')}`;
}

export function ogHtml(card, fontsDir) {
  const fonts = [fontFace(join(fontsDir, 'geist-500.ttf'), 500), fontFace(join(fontsDir, 'geist-600.ttf'), 600)].join('');
  const long = card.title.length > 70;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;background:#070708;color:#fafafa;font-family:Geist,system-ui,sans-serif}
.c{position:relative;width:1200px;height:630px;padding:64px 72px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:14px;font-weight:600;font-size:28px;letter-spacing:-.03em}
.top svg{width:40px;height:40px}.s-ring{fill:none;stroke:#c8ff00;stroke-width:1.1;opacity:.35}.s-sweep path{fill:#c8ff00;opacity:.3}.s-dot{fill:#c8ff00}
.top .sub{color:#92929b;font-weight:500;padding-left:14px;border-left:1px solid #393940}
.mid{margin-top:auto;display:flex;gap:56px;align-items:flex-end}
.txt{flex:1;min-width:0}
.k{font-size:24px;font-weight:500;color:#c8ff00;margin-bottom:18px}
h1{font-size:${long ? 52 : 62}px;line-height:1.06;letter-spacing:-.035em;font-weight:600;text-wrap:balance}
.fig{width:300px;flex:none;border-left:1px solid #26262c;padding-left:40px}
.num{font-size:112px;font-weight:600;letter-spacing:-.05em;line-height:.9;color:#c8ff00}
.lab{margin-top:14px;font-size:22px;line-height:1.3;color:#b4b4bc;font-weight:500}
.foot{margin-top:40px;font-size:20px;color:#92929b;font-weight:500}
</style></head><body><div class="c">
<div class="top">${MARK}<span>InternDoor</span><span class="sub">Blog</span></div>
<div class="mid"><div class="txt"><p class="k">${esc(card.kicker)}</p><h1>${esc(smartQuotes(card.title))}</h1></div>
${card.figure ? `<div class="fig"><p class="num">${esc(card.figure)}</p><p class="lab">${esc(smartQuotes(card.figureLabel))}</p></div>` : ''}</div>
<p class="foot">blog.interndoor.com</p>
</div></body></html>`;
}

function chromiumPath() {
  const base = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Draw every card whose inputs changed since the manifest was written, and
 * delete images no card owns. The manifest lives OUTSIDE the published
 * directory: it is bookkeeping, not a page. Returns { slug: hash }.
 */
export async function renderOgImages(cards, outDir, fontsDir, { manifestFile, log = () => {} } = {}) {
  mkdirSync(outDir, { recursive: true });
  const old = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
  const want = Object.fromEntries(cards.map((c) => [c.slug, ogHash(c)]));
  const stale = cards.filter((c) => old[c.slug] !== want[c.slug] || !existsSync(join(outDir, `${c.slug}.png`)));
  if (stale.length) {
    const { chromium } = await import('playwright-core');
    const exe = chromiumPath();
    if (!exe) throw new Error("Playwright's Chromium is not in ~/Library/Caches/ms-playwright (npx playwright install chromium).");
    const browser = await chromium.launch({ executablePath: exe });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
      for (const c of stale) {
        await page.setContent(ogHtml(c, fontsDir), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(outDir, `${c.slug}.png`), type: 'png' });
        log(`og: drew ${c.slug}.png`);
      }
    } finally {
      await browser.close();
    }
  }
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.png') && !(f.replace(/\.png$/, '') in want)) { unlinkSync(join(outDir, f)); log(`og: removed ${f}`); }
  }
  writeFileSync(manifestFile, `${JSON.stringify(want, null, 2)}\n`);
  return want;
}
