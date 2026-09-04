/* ============================================================
   The LinkedIn post image.

   WHY THIS FILE EXISTS. The fit loop has been wrong twice
   already, in both directions, and both times it LOOKED right:

     - measuring a container's scrollHeight against its own
       clientHeight is a tautology on an auto-height block, and
       the other card shipped every headline at its 40px floor
       for weeks because of it;
     - measuring against the CARD instead of the container said
       "fits" while the employer name was clipped by the lime
       band, because the left column is 531px of a 627px card.

   So the render assertion below uses the LONGEST employer name
   and title in the store. A fit test whose fixture never
   reaches the cap tests nothing.
   ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liCardModel } from '../src/licard.js';
import { chromiumPath } from '../src/ogcard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const tpl = readFileSync(join(ROOT, 'web', 'li-card.html'), 'utf8');

console.log('\n== the template holds the design decisions that cost something ==');
check('it is LinkedIn landscape, 1200x627',
  /width:1200px;height:627px/.test(tpl.replace(/\s/g, '')), true);
// A cropped trademark is simply wrong, and 462 logo files come in every shape.
check('the logo is CONTAINED, never cover',
  /object-fit:contain/.test(tpl.replace(/\s/g, '')), true);
check('and cover appears nowhere', /object-fit:\s*cover/.test(tpl), false);
check('the lime band carries the shout', /IS HIRING/.test(tpl), true);
check('the band uses the live token, not a literal',
  /\.band\{[^}]*background:var\(--live\)/.test(tpl.replace(/\s+/g, '')), true);
// The renderer inlines the logo as a data URI; a site-relative src would never
// resolve from a file:// render and every card would ship an empty plate.
check('the template ships no logo src of its own', /<img[^>]*src=/.test(tpl), false);

console.log('\n== the model is the OG card model, deliberately ==');
const job = { company: 'Pixxel', title: 'AI & Data Engineering Intern',
              location: 'Bengaluru, Karnataka, India' };
const m = liCardModel(job);
check('company', m.company, 'Pixxel');
check('title', m.title, 'AI & Data Engineering Intern');
check('the city is first among the facts', m.facts[0], 'Bengaluru');
check('a job with nothing still yields a shape',
  Object.keys(liCardModel({})).sort(), ['company', 'facts', 'title']);

const exe = chromiumPath();
if (!exe) {
  console.log('\n  (no Playwright Chromium — render assertions skipped)');
} else {
  console.log('\n== a LONG name and title still fit inside the card ==');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 627 } });
  await page.setContent(tpl, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.getElementById('co').textContent = 'Jupiter Business Systems FZC';
    document.getElementById('ttl').textContent =
      'Interim Engineering Intern — Systems Software, Summer 2027';
    document.getElementById('facts').innerHTML =
      '<div class="chip">Greater Hyderabad Area</div><div class="chip">On-site</div><div class="chip">6 months</div>';
  });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.fit')) {
      const box = el.parentElement;
      const room = () => {
        if (el.scrollWidth > el.clientWidth + 0.5) return false;
        const bs = getComputedStyle(box);
        const cap = box.clientHeight - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom);
        if (!(cap > 0)) return true;
        const gap = parseFloat(bs.rowGap) || 0;
        let used = -gap;
        for (const sib of box.children) used += sib.getBoundingClientRect().height + gap;
        return used <= cap + 0.5;
      };
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (size > 22 && !room()) { size -= 2; el.style.fontSize = `${size}px`; }
    }
  });

  const r = await page.evaluate(() => {
    const band = document.querySelector('.band').getBoundingClientRect();
    const co = document.getElementById('co').getBoundingClientRect();
    const ttl = document.getElementById('ttl').getBoundingClientRect();
    const px = (el) => Math.round(parseFloat(getComputedStyle(el).fontSize));
    return {
      nameClearsBand: co.bottom <= band.top + 0.5,
      titleClearsBand: ttl.bottom <= band.top + 0.5,
      nameInside: co.right <= 1200.5 && co.top >= 0,
      titleInside: ttl.right <= 1200.5 && ttl.top >= 0,
      nameShrank: px(document.getElementById('co')) < 58,
      titleSize: px(document.getElementById('ttl')),
    };
  });
  await browser.close();

  check('the long employer name clears the lime band', r.nameClearsBand, true);
  check('so does the long title', r.titleClearsBand, true);
  check('the name stays inside the card', r.nameInside, true);
  check('the title stays inside the card', r.titleInside, true);
  // The point of the fixture: if it did not shrink, the cap was never reached
  // and every assertion above would pass against a broken loop.
  check('and the fixture actually REACHED the cap', r.nameShrank, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
