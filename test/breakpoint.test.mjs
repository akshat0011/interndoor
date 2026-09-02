/**
 * The detail pane's breakpoint lives in TWO files, and they must agree.
 *
 * styles.css switches `.pane-col` from a sticky right-hand column to a
 * full-screen overlay (`position: fixed; display: none`) inside a media query,
 * and app.js decides whether to add the `.open` class that makes that overlay
 * visible. Nothing links them but a number typed twice.
 *
 * They drifted. app.js checked `max-width: 1000px` while the stylesheet used
 * 1024, so between 1001px and 1024px INCLUSIVE the CSS hid the column and the
 * JS never opened it: renderDetail ran, the content was written into the DOM,
 * and the reader saw nothing happen. 1024x768 is iPad landscape and a common
 * small-laptop width, so it was not a corner case — and a click that silently
 * does nothing is the hardest class of front-end bug to notice, because every
 * other viewport works and no error is logged.
 *
 * Asserted against the REAL FILES, not a fixture. A fixture would keep passing
 * the moment somebody edits the stylesheet.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'web/public/styles.css'), 'utf8');
const js = readFileSync(join(ROOT, 'web/public/app.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond, extra = '') => check(label + (extra ? ` — ${extra}` : ''), !!cond, true);

console.log('\n== the pane breakpoint is the same number in both files ==');

/* The media query that actually contains the .pane-col overlay rule, found by
   scanning blocks rather than by assuming which one it is — styles.css carries
   several max-width queries and the pane could be moved between them. */
function queryOwningPaneOverlay(source) {
  const widths = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m;
  while ((m = re.exec(source))) {
    // walk to the matching close brace, counting nesting
    let depth = 1, i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.slice(re.lastIndex, i);
    if (/\.pane-col\s*\{[^}]*position:\s*fixed/.test(body)) widths.push(Number(m[1]));
  }
  return widths;
}

const cssWidths = queryOwningPaneOverlay(css);
check('exactly one media query turns .pane-col into an overlay', cssWidths.length, 1);

const jsConst = Number((js.match(/const PANE_OVERLAY_MAX_PX\s*=\s*(\d+)/) || [])[1]);
ok('app.js declares PANE_OVERLAY_MAX_PX', Number.isFinite(jsConst), String(jsConst));

check('and it equals the stylesheet breakpoint', jsConst, cssWidths[0]);

/* The constant has to be the thing selectJob actually consults. Without this
   the two could agree while the media query below still hardcodes a third
   number, which is exactly the shape of the original bug. */
ok('selectJob builds its media query from the constant, not a literal',
  /matchMedia\(`\(max-width: \$\{PANE_OVERLAY_MAX_PX\}px\)`\)/.test(js));
ok('no stray hardcoded max-width query is left in app.js',
  !/matchMedia\(\s*['"]\(max-width:\s*\d+px\)['"]\s*\)/.test(js));

/* The overlay is only reachable when the class is applied, so the class the JS
   adds must be the one the stylesheet opens on. */
ok('the stylesheet opens on .pane-col.open', /\.pane-col\.open\s*\{[^}]*display:\s*block/.test(css));
ok('and app.js adds exactly that class', /detail-col'\)\.classList\.add\('open'\)/.test(js));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
