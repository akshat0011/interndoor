/**
 * The theme sweep and the scroll reveals (9 Oct 2026, after hiregram.ai).
 *
 * One block of script does both, and it lives in TWO files — app.js (the
 * board) and page.js (every generated page) — because neither loads the
 * other. Two hand-kept copies of one thing drift, so the first check here is
 * that the copies are the same bytes. Everything after runs the REAL block,
 * lifted out of app.js, against a fake browser:
 *
 *  - the theme it switches TO. Before this, both files asked the OS when the
 *    reader had made no choice, while every theme rule in styles.css keys on
 *    data-theme="light" alone — so a system-light reader saw the dark page and
 *    their first click set "dark": a switch that did nothing.
 *  - when it runs the sweep, and when it must just switch: no view
 *    transitions, reduced motion, no origin, or a stylesheet too old to carry
 *    the rules (no --fx). The last one is real: CSS is cached up to a day
 *    behind the script, and without its rules the sweep runs over the
 *    browser's own cross-fade and flashes.
 *  - the circle: from 0 at the switch to the farthest corner, on the NEW
 *    snapshot, and the switching attribute cleared only by the latest run.
 *  - the reveal: only what starts below the fold is held back (hiding
 *    something already on screen would flash it), each is shown once, a run
 *    is staggered and capped, and a child's animation does not end its
 *    parent's.
 *
 * Then the stylesheet rules the block depends on, and where it is wired in.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const app = read('web/public/app.js');
const page = read('web/public/page.js');
const css = read('web/public/styles.css');
const pageCss = read('web/public/page.css');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const START = '/* ---------------- motion: the theme sweep and the reveals ----------------';
function lift(src) {
  const a = src.indexOf(START);
  const r = src.indexOf('const reveal = (() => {', a);
  const b = src.indexOf('\n})();\n', r);
  return a < 0 || r < 0 || b < 0 ? '' : src.slice(a, b + '\n})();\n'.length);
}
const block = lift(app);

console.log('\n== one block, two files ==');
ok('the block is found in app.js', block.length > 2000);
check('page.js carries the same bytes', lift(page), block);

/* ---------------- a fake browser ---------------- */

function deferred() { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; }

function makeEnv({ vt = true, reduced = false, fx = '1', storageThrows = false, io = true, width = 1000, height = 800 } = {}) {
  const attrs = new Set();
  const animations = [];
  const transitions = [];
  const stored = {};
  const root = {
    dataset: {},
    setAttribute: (n) => attrs.add(n),
    removeAttribute: (n) => attrs.delete(n),
    hasAttribute: (n) => attrs.has(n),
    animate: (keyframes, options) => { animations.push({ keyframes, options }); },
  };
  const document = { documentElement: root };
  if (vt) {
    document.startViewTransition = (update) => {
      const ready = deferred(), finished = deferred();
      const t = { update, ready: ready.p, finished: finished.p, themeAtStart: root.dataset.theme,
        switchingAtStart: attrs.has('data-theme-switching'),
        run() { update(); ready.resolve(); }, finish() { finished.resolve(); } };
      transitions.push(t);
      return t;
    };
  }
  const window = {
    innerWidth: width, innerHeight: height,
    matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' ? reduced : false }),
  };
  const getComputedStyle = () => ({ getPropertyValue: (name) => (name === '--fx' ? fx : '') });
  const localStorage = { setItem: (k, v) => { if (storageThrows) throw new Error('private'); stored[k] = v; } };
  const observed = new Set();
  let ioCallback = null, ioOptions = null;
  class FakeIO {
    constructor(cb, opts) { ioCallback = cb; ioOptions = opts; }
    observe(n) { observed.add(n); }
    unobserve(n) { observed.delete(n); }
    disconnect() { observed.clear(); }
  }
  const api = new Function('document', 'window', 'getComputedStyle', 'IntersectionObserver', 'localStorage',
    `${block}\nreturn { switchTheme, themeOrigin, motionOk, reveal };`)(
    document, window, getComputedStyle, io ? FakeIO : undefined, localStorage);
  return { api, root, attrs, animations, transitions, stored, observed,
    intersect: (nodes) => ioCallback(nodes.map((n) => ({ target: n, isIntersecting: true }))),
    passBy: (nodes) => ioCallback(nodes.map((n) => ({ target: n, isIntersecting: false }))),
    ioOptions: () => ioOptions };
}

function node(top) {
  const classes = new Set();
  const handlers = new Map();
  return {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    style: {},
    getBoundingClientRect: () => ({ top, left: 0, width: 10, height: 10 }),
    addEventListener: (t, f) => handlers.set(t, f),
    removeEventListener: (t, f) => { if (handlers.get(t) === f) handlers.delete(t); },
    fire(type, target) { const f = handlers.get(type); if (f) f({ target: target ?? this, currentTarget: this }); },
    has: (c) => classes.has(c),
    listening: (t) => handlers.has(t),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

if (!block) { console.log(`\n${pass} passed, ${fail + 1} failed\n`); process.exit(1); }

console.log('\n== the theme it switches to ==');
{
  const e = makeEnv({ vt: false });
  e.api.switchTheme({ x: 1, y: 1 });
  check('no choice yet (the dark default) -> light, whatever the OS says', e.root.dataset.theme, 'light');
  e.api.switchTheme({ x: 1, y: 1 });
  check('light -> dark', e.root.dataset.theme, 'dark');
  e.api.switchTheme({ x: 1, y: 1 });
  check('dark -> light', e.root.dataset.theme, 'light');
  check('the choice is stored under the key the head script reads', e.stored.theme, 'light');
  const t = makeEnv({ vt: false, storageThrows: true });
  t.api.switchTheme({ x: 1, y: 1 });
  check('private mode (storage throws) still switches', t.root.dataset.theme, 'light');
}
ok('neither file asks the OS which theme the page is in',
  !/prefers-color-scheme/.test(block) && !/prefers-color-scheme/.test(app) && !/prefers-color-scheme/.test(page));

console.log('\n== when it sweeps, and when it just switches ==');
for (const [label, opts, origin] of [
  ['no view transitions', { vt: false }, { x: 5, y: 5 }],
  ['reduced motion', { reduced: true }, { x: 5, y: 5 }],
  ['a stylesheet without --fx (cached a day behind)', { fx: '' }, { x: 5, y: 5 }],
  ['no origin', {}, null],
]) {
  const e = makeEnv(opts);
  e.api.switchTheme(origin);
  check(`${label}: switches at once`, e.root.dataset.theme, 'light');
  check(`${label}: no transition started`, e.transitions.length, 0);
  check(`${label}: no switching attribute left`, e.attrs.has('data-theme-switching'), false);
}

console.log('\n== the sweep ==');
{
  const e = makeEnv({ width: 1000, height: 800 });
  e.api.switchTheme({ x: 900, y: 100 });
  const t = e.transitions[0];
  ok('a view transition was started', t);
  check('the switching attribute is set BEFORE the snapshot (transitions off in it)', t?.switchingAtStart, true);
  check('the theme is not changed before the old page is captured', t?.themeAtStart, undefined);
  t.run();
  await tick();
  check('the update callback flips the theme', e.root.dataset.theme, 'light');
  const a = e.animations[0];
  ok('one animation, once the transition is ready', e.animations.length === 1);
  check('on the NEW snapshot', a?.options.pseudoElement, '::view-transition-new(root)');
  check('650ms', a?.options.duration, 650);
  const r = Math.hypot(900, 700);   // the farthest corner from (900,100) in 1000x800 is (0,800)
  check('from a point at the switch', a?.keyframes.clipPath[0], 'circle(0px at 900px 100px)');
  check('to the farthest corner of the screen', a?.keyframes.clipPath[1], `circle(${r}px at 900px 100px)`);
  ok('still switching until it finishes', e.attrs.has('data-theme-switching'));
  t.finish();
  await tick();
  check('transitions come back on when it finishes', e.attrs.has('data-theme-switching'), false);
}
{
  const e = makeEnv();
  e.api.switchTheme({ x: 10, y: 10 });
  e.api.switchTheme({ x: 10, y: 10 });
  const [first, second] = e.transitions;
  first.finish();          // the browser skips the first when a second begins
  await tick();
  check('a skipped first sweep does not switch transitions back on under the second', e.attrs.has('data-theme-switching'), true);
  second.finish();
  await tick();
  check('the latest one does', e.attrs.has('data-theme-switching'), false);
}
{
  const e = makeEnv();
  const btn = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 100, top: 40, width: 17, height: 17 }) }) };
  check('the circle starts at the centre of the switch\'s mark', e.api.themeOrigin(btn), { x: 108.5, y: 48.5 });
}

console.log('\n== the reveal ==');
{
  const e = makeEnv({ height: 800 });
  const inView = node(300), atFold = node(800), below = node(1400), farther = node(2600);
  e.api.reveal.watch([inView, atFold, below, farther, null]);
  check('a block already on screen is left alone (hiding it would flash it)', inView.has('fx-wait'), false);
  check('and not watched', e.observed.has(inView), false);
  ok('a block starting at the fold is held back', atFold.has('fx-wait') && e.observed.has(atFold));
  ok('so is one further down', below.has('fx-wait') && e.observed.has(below));
  check('it shows a little after entering, not on the first pixel', e.ioOptions()?.rootMargin, '0px 0px -8% 0px');
  e.passBy([below]);
  ok('a block that is not yet intersecting keeps waiting', below.has('fx-wait'));
  e.intersect([atFold, below]);
  ok('once reached it stops waiting and arrives', !below.has('fx-wait') && below.has('fx-in'));
  check('only once: it is no longer watched', e.observed.has(below), false);
  check('arriving together, they go 60ms apart', [atFold.style.animationDelay, below.style.animationDelay], ['0ms', '60ms']);
  below.fire('animationend', { child: true });
  ok('a child\'s own animation ending does not end the block\'s', below.has('fx-in'));
  below.fire('animationend');
  ok('its own end takes the class off (nothing left holding a transform over :hover)', !below.has('fx-in'));
  check('and the delay', below.style.animationDelay, '');
  ok('and stops listening', !below.listening('animationend'));
  e.api.reveal.drop([farther]);
  check('drop() stops watching a block about to leave the page', e.observed.has(farther), false);
}
{
  const e = makeEnv({ height: 100 });
  const run = Array.from({ length: 9 }, (_, i) => node(200 + i));
  e.api.reveal.watch(run);
  e.intersect(run);
  check('a long run is capped: the sixth and later share the last delay',
    run.map((n) => n.style.animationDelay), ['0ms', '60ms', '120ms', '180ms', '240ms', '300ms', '300ms', '300ms', '300ms']);
}
for (const [label, opts] of [
  ['reduced motion', { reduced: true }],
  ['no IntersectionObserver', { io: false }],
  ['a stylesheet without --fx', { fx: '' }],
]) {
  const e = makeEnv(opts);
  const n = node(5000);
  e.api.reveal.watch([n]);
  check(`${label}: nothing is held back`, n.has('fx-wait'), false);
}

console.log('\n== the stylesheet the block depends on ==');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}\n', css.indexOf(':root {')));
ok('--fx: 1 is in :root (the marker the scripts read)', /--fx:\s*1;/.test(rootBlock));
ok('--spring has a cubic-bezier fallback in :root', /--spring:\s*cubic-bezier\(/.test(rootBlock));
ok('linear() appears only inside @supports (an unsupported one drops the whole transition)',
  /@supports \(transition-timing-function: linear\(0, 1\)\)\s*\{\s*:root\s*\{\s*--spring: linear\(/.test(css)
  && (css.match(/linear\(0,/g) ?? []).length === 2);
ok('both snapshots lose the browser\'s cross-fade while switching',
  /:root\[data-theme-switching\]::view-transition-old\(root\),\s*:root\[data-theme-switching\]::view-transition-new\(root\)\s*\{\s*animation:\s*none;\s*mix-blend-mode:\s*normal;/.test(css));
ok('every transition is held off while switching',
  /:root\[data-theme-switching\] \*,\s*:root\[data-theme-switching\] \*::before,\s*:root\[data-theme-switching\] \*::after\s*\{\s*transition:\s*none !important;/.test(css));
const waitRule = css.match(/\n\.fx-wait \{([^}]*)\}/)?.[1] ?? '';
ok('.fx-wait hides by opacity', /opacity:\s*0/.test(waitRule));
ok('and only by opacity — no display, visibility or size, so layout and anchors are unchanged',
  waitRule && !/display|visibility|height|width/.test(waitRule));
ok('.fx-wait is never hidden under reduced motion', /prefers-reduced-motion: reduce\)\s*\{\s*\.fx-wait, \.feed \.row\.fx-wait \{ opacity: 1; \}/.test(css));
ok('or in print', /@media print \{\s*\.fx-wait, \.fx-in, \.feed \.row\.fx-wait, \.feed \.row\.fx-in \{ opacity: 1 !important; animation: none !important; \}/.test(css));
ok('a waiting card sits out the first-paint entrance: its rule comes AFTER .feed.intro .row',
  css.indexOf('.feed .row.fx-wait') > css.indexOf('.feed.intro .row {'));
ok('page.css lets a waiting tile sit out tileIn', /\.tiles\.in > \.fx-wait, \.dir\.in > \.fx-wait \{ opacity: 0; animation: none; \}/.test(pageCss));
ok('page.css stops the heading entrance under reduced motion',
  /prefers-reduced-motion: reduce\)\s*\{[^}]*\}\s*main\.page \.wrap > h1, \.jp-hero, \.hub-hero, \.dir-hero \{ animation: none; \}/.test(pageCss));

console.log('\n== where it is wired in ==');
ok('the board\'s switch runs the sweep from its mark', /btn\.addEventListener\('click', \(\) => switchTheme\(themeOrigin\(btn\)\)\)/.test(app));
ok('so does every generated page\'s', /btn\.addEventListener\('click', \(\) => switchTheme\(themeOrigin\(btn\)\)\)/.test(page));
ok('the board watches the first cards it draws', /const first = draw\(frag\);\s*list\.append\(frag\);\s*reveal\.watch\(first\);/.test(app));
ok('and every later batch, after it is in the document', /const rows = draw\(more\);\s*list\.insertBefore\(more, sentinel\);\s*reveal\.watch\(rows\);/.test(app));
ok('a rebuilt list lets go of its waiting cards first', /reveal\.drop\(list\.querySelectorAll\('\.fx-wait'\)\);\s*list\.replaceChildren\(\);/.test(app));
ok('generated pages watch their tiles', /function stagger\(list\) \{[\s\S]*?reveal\.watch\(list\.children\);\s*\}/.test(page));
ok('and the late-filled strip\'s heading', /strip\.hidden = false;[\s\S]{0,140}reveal\.watch\(strip\.querySelectorAll\(':scope > \.strip-head'\)\)/.test(page));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
