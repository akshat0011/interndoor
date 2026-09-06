/**
 * The weekly roundup image — the employers he picked, as logos.
 *
 * A THIRD CARD (see web/weekly-card.html for why it is not a copy of the other
 * two): og-card is the link preview a crawler fetches, li-card is the image
 * attached to a post about ONE job, this one is about a WEEK. Output goes to
 * PATHS.liCards in the state directory, never the repo — `app/` is public and
 * these are generated artefacts, the same rule ogCards and liCards follow.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, PATHS } from './paths.js';
import { chromiumPath } from './ogcard.js';
import { logoOnDisk } from './logos.js';
import { log } from './logger.js';

const TEMPLATE = join(ROOT, 'web', 'weekly-card.html');

/** At most this many plates. Beyond six the logos are too small to recognise. */
export const MAX_LOGOS = 6;

/**
 * How the plates are laid out for a given count.
 *
 * A FIXED 3x2 IS WRONG FOR SMALL SETS and one is a real case — he may want to
 * feature two employers on a quiet week. At n<=3 a single row of larger plates
 * reads far better than three marooned in the top-left of a six-cell grid.
 */
export function gridFor(count) {
  const n = Math.max(1, Math.min(MAX_LOGOS, Number(count) || 0));
  if (n <= 3) return { cols: n, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

/** Initials for an employer with no logo file, so the grid has no hole in it. */
export function initialsOf(name) {
  const words = String(name ?? '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Inline a logo as a data URI.
 *
 * The card renders from a `file://` page with no server, so a site-relative
 * `/logos/x.jpg` resolves to nothing and every plate comes out empty. The job
 * card learned this the same way.
 */
function logoDataUri(company) {
  const rel = logoOnDisk(company);
  if (!rel) return '';
  const f = join(ROOT, 'web', 'public', rel.replace(/^\//, ''));
  if (!existsSync(f)) return '';
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${readFileSync(f).toString('base64')}`;
}

/**
 * Render one weekly card.
 *
 * @param {{companies: string[], roles: number, span?: string, region?: string}} model
 * @returns {Promise<string|null>} the file path, or null when Chromium is absent
 */
export async function renderWeeklyCard(model, outFile) {
  const companies = (model.companies ?? []).slice(0, MAX_LOGOS);
  if (!companies.length) throw new Error('renderWeeklyCard needs at least one company.');

  const exe = chromiumPath();
  if (!exe) { log.warn('No Playwright Chromium — skipping the weekly card image.'); return null; }

  mkdirSync(PATHS.liCards, { recursive: true });
  const file = outFile ?? join(PATHS.liCards, 'weekly-latest.png');
  const html = readFileSync(TEMPLATE, 'utf8');
  const grid = gridFor(companies.length);
  const cells = companies.map((c) => ({ name: c, logo: logoDataUri(c), initials: initialsOf(c) }));

  /* PLAYWRIGHT'S OWN CHROMIUM, NEVER BRAVE. launchBrave clears and claims the
     scraper's profile on its way in and would kill a live scrape. */
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 627 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });

    await page.evaluate(({ cells, grid, roles, sub }) => {
      const n = String(roles);
      document.getElementById('count').innerHTML =
        `<em>${n}</em> engineering internship${roles === 1 ? '' : 's'}<br>opened this week`;
      document.getElementById('sub').textContent = sub;

      const g = document.getElementById('grid');
      g.style.gridTemplateColumns = `repeat(${grid.cols}, minmax(0, 1fr))`;
      // A one-row grid must not stretch its plates to the full 300px height —
      // the plate is square, so a tall row makes it wide enough to collide.
      g.style.gridTemplateRows = `repeat(${grid.rows}, minmax(0, 1fr))`;
      g.innerHTML = cells.map((c) => `
        <div class="cell">
          <div class="plate">${c.logo
            ? `<img src="${c.logo}" alt="">`
            : `<div class="mark"></div>`}</div>
          <div class="name"></div>
        </div>`).join('');
      [...g.querySelectorAll('.cell')].forEach((cell, i) => {
        cell.querySelector('.name').textContent = cells[i].name;
        const mark = cell.querySelector('.mark');
        if (mark) mark.textContent = cells[i].initials;
      });
    }, { cells, grid, roles: Number(model.roles) || 0, sub: model.span ?? '' });

    /* FONTS BEFORE MEASURING. Measuring in Helvetica and reflowing in Archivo
       has shipped three times on the other cards. */
    await page.evaluate(() => document.fonts.ready);

    /**
     * SIZE THE PLATES FROM THE SMALLER OF THE TWO AXES.
     *
     * The square is bounded by the cell's WIDTH at three columns and by its
     * HEIGHT at two rows, and only one of those binds at a time. Taking the
     * width alone — which `aspect-ratio` in CSS effectively does — overflowed
     * every plate into the row below and the lime band cropped the whole second
     * rank off the card.
     */
    await page.evaluate(() => {
      const head = document.querySelector('.head');
      const grid = document.getElementById('grid');

      // Headline first: it moves the grid's top edge, so plates measured before
      // it settles are sized against the wrong box.
      let size = parseFloat(getComputedStyle(document.getElementById('count')).fontSize);
      while (size > 30 && head.getBoundingClientRect().bottom > grid.getBoundingClientRect().top - 10) {
        size -= 3;
        document.getElementById('count').style.fontSize = `${size}px`;
      }

      /* ONE size for every plate, taken from the tightest cell. Sizing each
         independently makes a row of subtly different squares, which reads as
         sloppy rather than as six equals. */
      const cells = [...document.querySelectorAll('.cell')];
      let side = Infinity;
      for (const cell of cells) {
        const name = cell.querySelector('.name');
        const gap = parseFloat(getComputedStyle(cell).rowGap) || 0;
        const room = cell.clientHeight - name.getBoundingClientRect().height - gap;
        side = Math.min(side, cell.clientWidth, room);
      }
      side = Math.max(48, Math.floor(side));
      for (const cell of cells) {
        const plate = cell.querySelector('.plate');
        plate.style.width = `${side}px`;
        plate.style.height = `${side}px`;
      }

      /* PULL THE COLUMNS IN TO THE PLATES. The grid spans the full card width,
         so at three columns each is ~370px while the plate is height-bound at
         ~200 — leaving the six scattered across the card with the radar showing
         between them instead of reading as one group. Narrowing the track to
         the plate plus a little air makes it a deliberate cluster. */
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      const colGap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      const want = cols * (side + 46) + (cols - 1) * colGap;
      /* LEFT-ALIGNED, not centred. Centring the narrowed grid opens a dead
         column under the headline on the left while the radar already owns the
         right, so the card reads as two unrelated halves. Sharing the
         headline's left edge makes it one block. */
      if (want < grid.clientWidth) {
        grid.style.width = `${Math.round(want)}px`;
        grid.style.marginRight = 'auto';
      }

      // Initials only after the plate has its real size.
      for (const m of document.querySelectorAll('.mark')) {
        m.style.fontSize = `${Math.round(m.parentElement.clientHeight * 0.34)}px`;
      }
    });
    await page.waitForTimeout(60);

    writeFileSync(file, await page.locator('#card').screenshot({ type: 'png' }));
    log.ok(`Weekly card image: ${file}`);
    return file;
  } finally {
    await browser.close();
  }
}
