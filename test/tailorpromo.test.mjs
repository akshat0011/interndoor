/**
 * The board's tailor promo, 17 Oct 2026 (his ask: "currently most people dont
 * know it exists, suggest them to use tailor my resume").
 *
 * One block at the top of the list for a reader who has never tailored and has
 * no resume on the board; its button tailors to the first role below it. Gone
 * for good after a first tailor, and for TLP_QUIET_DAYS after the cross.
 * Counted (tlp-shown, tlp-click, tlp-dismiss, tailor-open) so it is judged on
 * numbers. The rule is lifted out of app.js by name and run, not grepped.
 */
import { readFileSync } from 'node:fs';
import { EVENTS } from '../web/api/count.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('web/public/app.js');
const css = read('web/public/styles.css');

/** One top-level function's source, by brace matching from its declaration. */
function lift(name) {
  const at = app.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let i = app.indexOf('{', app.indexOf(')', at)), depth = 0;
  for (; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') { depth -= 1; if (depth === 0) return app.slice(at, i + 1); }
  }
  return null;
}
const constOf = (name) => app.match(new RegExp(`const ${name} = ([^;]+);`))?.[1];

console.log('\n== when it shows ==');
{
  const src = lift('tailorPromoDue');
  ok('the rule is found', !!src && src.length > 80);
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const due = new Function('localStorage', `const TAILORED_STORE = ${constOf('TAILORED_STORE')}; const TLP_OFF_STORE = ${constOf('TLP_OFF_STORE')}; const TLP_QUIET_DAYS = ${constOf('TLP_QUIET_DAYS')};\n${src}\nreturn tailorPromoDue;`)(localStorage);
  const NOW = Date.UTC(2026, 9, 17, 10, 0);
  ok('a reader who never tailored and never dismissed it sees it', due(NOW) === true);
  store.set('interndoor-tlp-off', String(NOW - 13 * 86_400_000));
  ok('dismissed 13 days ago, it stays away', due(NOW) === false);
  store.set('interndoor-tlp-off', String(NOW - 15 * 86_400_000));
  ok('dismissed 15 days ago, it may come back', due(NOW) === true);
  store.set('interndoor-tailored', String(NOW));
  ok('after a first tailor it never shows', due(NOW) === false);
  const blocked = new Function('localStorage', `const TAILORED_STORE = 'a'; const TLP_OFF_STORE = 'b'; const TLP_QUIET_DAYS = 14;\n${src}\nreturn tailorPromoDue;`)({ getItem() { throw new Error('blocked'); } });
  ok('blocked storage shows it rather than throwing', blocked(NOW) === true);
  ok('the quiet spell is a fortnight', constOf('TLP_QUIET_DAYS') === '14');
}

console.log('\n== where it goes ==');
{
  const list = lift('renderList');
  ok('only when no resume ranks the board (the rank bar owns that slot)', /\} else if \(tailorPromoDue\(\) && split\.ordered\[0\]\?\.\[0\]\) \{\s*frag\.append\(tailorPromo\(split\.ordered\[0\]\[0\]\)\);/.test(list));
  const promo = lift('tailorPromo');
  ok('its button tailors to the role it is given', /go\.addEventListener\('click', \(\) => \{ countEvent\('tlp-click'\); openTailor\(job\); \}\);/.test(promo));
  ok('and names that role to a screen reader', /`Tailor your resume to \$\{job\.title\} at \$\{job\.company\}`/.test(promo));
  ok('the cross remembers when, counts, and removes the block', /localStorage\.setItem\(TLP_OFF_STORE, String\(Date\.now\(\)\)\)/.test(promo) && /countEvent\('tlp-dismiss'\)/.test(promo) && /li\.remove\(\)/.test(promo));
  ok('the cross has a name', /'aria-label', 'Hide this suggestion'/.test(promo));
  ok('shown is counted once a page, not once a redraw', /if \(!tailorPromo\.counted\) \{ tailorPromo\.counted = true; countEvent\('tlp-shown'\); \}/.test(promo));
  ok('the allowance it states is the real one', /\$\{FREE_PER_DAY\.tailor\} a day/.test(promo));
  ok('and it promises nothing the tailor does not keep', /keep everything you wrote/.test(promo) && !/one-page|guarantee|ATS score/i.test(promo));
  const run = lift('runTailor');
  ok('a first tailor marks the browser', /toast\('Resume tailored'\);\s*try \{ localStorage\.setItem\(TAILORED_STORE, String\(Date\.now\(\)\)\); \}/.test(run));
  ok('opening the tailor for a role is counted', /tailorMode = job \? 'tailor' : 'rank';\s*if \(job\) countEvent\('tailor-open'\);/.test(lift('openTailor')));
  const ce = lift('countEvent');
  ok('a count waits for engage.js instead of being lost', /if \(tries < 20\) setTimeout\(\(\) => countEvent\(name, tries \+ 1\), 500\);/.test(ce));
}

console.log('\n== the counter knows the events ==');
for (const e of ['tailor-open', 'tlp-shown', 'tlp-click', 'tlp-dismiss']) ok(`${e} is counted`, EVENTS.has(e));

console.log('\n== how it looks ==');
{
  const rule = (sel) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';
  ok('the block has its own rule', rule('.tl-promo').length > 50);
  ok('its button is the lime action', /background: var\(--cta\); color: var\(--cta-ink\)/.test(rule('.tlp-go')));
  ok('nothing in it recedes by opacity', !/opacity/.test([rule('.tl-promo'), rule('.tlp-txt span'), rule('.tlp-x')].join('')));
  ok('the card button reads at full strength now', /\.tl-b \{ color: var\(--ink\); border-color: var\(--rule-2\); font-weight: 600; \}/.test(css));
  ok('on a phone the button takes the full width', /@media \(max-width: 640px\) \{[^@]*\.tlp-go \{ grid-column: 1 \/ -1; width: 100%; \}/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
