/**
 * /skills, redesigned 8 Oct 2026 — his ask: "redesign it too … and can we add
 * a logo to each skill". A "Most open roles" row, the full grid with a mark on
 * every skill, the company directory's search box (page.js), and the skill
 * names spelled the way the products spell them.
 *
 * The marks: a product's logo is Devicon's SVG, served from our own origin;
 * a concept (or a brand Devicon does not carry) gets a drawn glyph, never an
 * invented logo; an unknown skill gets its initials.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { renderFacetIndex, skillMark } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const IN = regionOf('IN');
const jobs = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
const LABELS = [['python', 9], ['sql', 8], ['agile', 7], ['javascript', 6], ['pytorch', 5], ['power bi', 4], ['rag', 3], ['.net', 2], ['quantumfoo', 1]];
const facets = LABELS.map(([label, n]) => ({ slug: label === '.net' ? 'net' : label.replace(/\s+/g, '-'), label, jobs: jobs(n) }))
  .reverse();                       // handed in the WRONG order: the page must rank them itself
const html = renderFacetIndex('skill', facets, { region: IN });

console.log('\n== THE PAGE ==');
check('a title-case h1 that names both kinds', html.includes('<h1 class="sk-h1">Internships &amp; Entry-Level Jobs in India by Skill</h1>'), true);
check('page.css is versioned on this page', /href="\/page\.css\?v=s\d+"/.test(html), true);
check('the lede names the top five and how many more', html.includes('— Python, SQL, Agile, JavaScript, PyTorch and 4 more.'), true);
check('the directory search box, revealed by page.js', /<div class="filter" id="filter">/.test(html) && /id="filter-input"/.test(html) && /id="dir-none"/.test(html), true);
check('placeholder counts the skills', html.includes('placeholder="Search 9 skills — try “React”"'), true);

console.log('\n== RANKED, AND THE POPULAR ROW ==');
const pop = [...html.matchAll(/<a class="sk-pop-card"[\s\S]*?<span class="dir-name">([^<]+)</g)].map((m) => m[1]);
check('six popular skills, most roles first', pop, ['Python', 'SQL', 'Agile', 'JavaScript', 'PyTorch', 'Power BI']);
check('the popular cards are NOT filtered (no .dir-card)', /class="sk-pop-card[^"]*dir-card|class="dir-card sk-pop-card/.test(html), false);
const all = [...html.matchAll(/<a class="dir-card sk-card" data-name="([^"]+)"/g)].map((m) => m[1]);
check('every skill in the grid, most roles first, data-name lowercase', all, ['python', 'sql', 'agile', 'javascript', 'pytorch', 'power bi', 'rag', '.net', 'quantumfoo']);
check('the grid is a filter group', /<section class="strip sk-strip" data-group>/.test(html), true);
check('a role count on each card', html.includes('<span class="dir-n">9 open roles</span>') && html.includes('<span class="dir-n">1 open role</span>'), true);
const few = renderFacetIndex('skill', facets.slice(0, 4), { region: IN });
check('under six skills there is no popular row', /sk-pop/.test(few), false);

console.log('\n== NAMES, SPELLED LIKE THE PRODUCT ==');
for (const name of ['JavaScript', 'PyTorch', 'Power BI', 'RAG', '.NET']) {
  check(`"${name}"`, html.includes(`<span class="dir-name">${name}</span>`), true);
}

console.log('\n== THE MARKS ==');
check('a product gets its logo, from our own origin', skillMark('python', 'python').includes('<img src="/skill-logos/python.svg"'), true);
check('a concept gets a drawn glyph, never a logo', /class="sk-logo is-glyph"><svg/.test(skillMark('agile', 'agile')) && !/<img/.test(skillMark('agile', 'agile')), true);
check('an unknown skill gets its initials', /is-initials" aria-hidden="true">Q/.test(skillMark('quantumfoo', 'quantumfoo')), true);
const dir = new URL('../web/public/skill-logos/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
check('there are logo files', files.length > 40, true);
check('every logo file is used', files.filter((s) => !skillMark(s, s).includes('<img')), []);
const live = existsSync(new URL('../web/public/skills/', import.meta.url))
  ? readdirSync(new URL('../web/public/skills/', import.meta.url)).filter((f) => f.endsWith('.html') && f !== 'index.html').map((f) => f.slice(0, -5)) : [];
check('every live skill page has a mark that resolves', live.filter((s) => { const m = skillMark(s, s); const src = (m.match(/src="\/skill-logos\/([^"]+)\.svg"/) || [])[1]; return src ? !files.includes(src) : !/is-glyph/.test(m); }), []);
check('the licence travels with the logos', existsSync(new URL('LICENSE.txt', dir)) && /MIT License/.test(readFileSync(new URL('LICENSE.txt', dir), 'utf8')), true);
const svgs = files.map((f) => readFileSync(new URL(`${f}.svg`, dir), 'utf8'));
check('no logo carries a script or an external reference', svgs.filter((t) => /<script|href="http|<image|@import/i.test(t)).length, 0);
check('no logo is heavy (Linux shipped at 194 KB first)', files.filter((f, i) => svgs[i].length > 20_000), []);

console.log('\n== WHAT MUST NOT CHANGE ==');
check('no style attribute (the CSP refuses them)', / style="/.test(html), false);
const city = renderFacetIndex('city', [{ slug: 'pune', label: 'Pune', jobs: jobs(3) }], { region: IN });
check('the locations index keeps its own layout', /sk-|skill-logos/.test(city), false);
const pageJs = readFileSync(new URL('../web/public/page.js', import.meta.url), 'utf8');
check('page.js still drives the search box this page relies on',
  /getElementById\('filter'\)/.test(pageJs) && /getElementById\('filter-input'\)/.test(pageJs)
  && /getElementById\('dir-none'\)/.test(pageJs) && /querySelectorAll\('\.dir-card'\)/.test(pageJs) && /dataset\.name/.test(pageJs), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
