/**
 * ROLE PAGES — /roles, /roles/<role>, /roles/<role>-in-<city> (1 Oct 2026),
 * and the job page's "similar roles" strip that links into them.
 *
 * What has to stay true:
 *   - a page exists only at its bar (8 for a role, 10 for a role in a city),
 *     so the set cannot grow into the doorway shape the facets were built to
 *     avoid;
 *   - a posting is on a role page only when its FAMILY and its SHELF agree
 *     (the strategy analyst whose title says "AI" is not an AI role);
 *   - every /roles/ link any page writes resolves to a written file, and the
 *     sitemap lists exactly the role pages and nothing noindex;
 *   - the similar-roles pick is stable — not newest-first — so a new posting
 *     does not rewrite every job page in its family (§10);
 *   - the JobPosting description stays our own words, never the employer's.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_PAGES, ROLE_MIN, ROLE_CITY_MIN, rolePageOf, roleGroups, stableRank, roleCitySlug } from '../src/rolepages.js';
import { writePages, renderRolePage, renderRoleCityPage, renderRoleIndex, similarRoles, roleInsights, isIndexable, jobSlug, SIMILAR_MAX, renderJobPage, experienceMonths } from '../src/pages.js';
import { publishedPaths } from '../src/publish.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const NOINDEX = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;
const region = regionOf('IN');
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) ?? [])[1]?.replace(/&amp;/g, '&') ?? '';

let seq = 0;
const job = (o = {}) => ({
  id: String(++seq), company: `Co${seq}`, title: 'Software Engineer', location: 'Bengaluru, Karnataka, India',
  employmentType: 'fulltime', category: 'software', family: 'swe', postedAt: 1_790_000_000_000 + seq,
  bullets: ['Build services', 'Write tests'], skills: ['python', 'sql'], summary: 'Our own summary.', ...o,
});

console.log('\n== which role page a posting belongs on ==');
check('a software-engineering title on the Software shelf', rolePageOf(job())?.slug, 'software-engineering');
check('family ai_ml on the Software shelf is the AI page', rolePageOf(job({ family: 'ai_ml' }))?.slug, 'ai-machine-learning');
check('family ai_ml moved to MISC is on no page (the "Enterprise AI Value Strategy" analyst)', rolePageOf(job({ family: 'ai_ml', category: 'misc' })), null);
check('hardware family on the Hardware shelf', rolePageOf(job({ family: 'hardware', category: 'hardware' }))?.slug, 'vlsi-hardware');
check('core engineering on Misc', rolePageOf(job({ family: 'core_eng', category: 'misc' }))?.slug, 'core-engineering');
check('a title naming no discipline has no role page', rolePageOf(job({ family: 'generic' })), null);
check('no family or shelf on the row: read off the title, no shelf check', rolePageOf({ title: 'DevOps Engineer Intern' })?.slug, 'devops-cloud');
check('every role page has a unique slug', new Set(ROLE_PAGES.map((d) => d.slug)).size, ROLE_PAGES.length);
check('no role slug contains "-in-" (the role-in-a-city slug separator)', ROLE_PAGES.filter((d) => d.slug.includes('-in-')).length, 0);
check('every role page has its own paragraph', ROLE_PAGES.filter((d) => !d.about || d.about.length < 80).map((d) => d.slug), []);

console.log('\n== the bars ==');
{
  const many = (n, o) => Array.from({ length: n }, () => job(o));
  check('the bars are 8 and 10', [ROLE_MIN, ROLE_CITY_MIN], [8, 10]);
  check('7 postings: no role page', roleGroups(many(7)).roles.length, 0);
  check('8 postings: a role page', roleGroups(many(8)).roles.map((r) => r.slug), ['software-engineering']);
  check('9 in one city: no role-in-a-city page', roleGroups(many(9)).combos.length, 0);
  check('10 in one city: a role-in-a-city page', roleGroups(many(10)).combos.map((c) => c.slug), ['software-engineering-in-bengaluru']);
  check('the city slug is folded (Bangalore is Bengaluru)',
    roleGroups([...many(5), ...many(5, { location: 'Bangalore, Karnataka, India' })]).combos.map((c) => c.slug), ['software-engineering-in-bengaluru']);
  check('no role-in-a-city page without its role page', roleGroups(many(10, { family: 'mobile' }), { min: 11 }).combos.length, 0);
  check('rows naming no city make no role-in-a-city page', roleGroups(many(10, { location: 'India' })).combos.map((c) => c.slug), []);
  check('role-in-a-city pages are ordered by size',
    roleGroups([...many(10, { location: 'Pune, Maharashtra, India' }), ...many(12)]).combos.map((c) => c.slug),
    ['software-engineering-in-bengaluru', 'software-engineering-in-pune']);
  const g = roleGroups([...many(9, { family: 'qa' }), ...many(12)]);
  check('ordered by size', g.roles.map((r) => r.slug), ['software-engineering', 'qa-testing']);
  check('roleCitySlug', roleCitySlug('qa-testing', 'pune'), 'qa-testing-in-pune');
}

console.log('\n== the similar-roles pick ==');
{
  const me = job({ company: 'Me' });
  const pool = [me, job({ company: 'Me', title: 'Other role' }), ...Array.from({ length: 12 }, (_, i) => job({ title: `Role ${i}`, location: i < 4 ? 'Pune, Maharashtra, India' : 'Bengaluru, Karnataka, India' })),
    job({ title: 'Thin', bullets: [] })];
  const picked = similarRoles(me, pool);
  check(`at most ${SIMILAR_MAX}`, picked.length, SIMILAR_MAX);
  check('never itself, never its own employer', picked.filter((j) => j.id === me.id || j.company === 'Me').length, 0);
  check('never a noindex page', picked.filter((j) => !isIndexable(j)).length, 0);
  check('the same city first', picked.every((j) => j.location.startsWith('Bengaluru')), true);
  check('the order of the input does not matter (not newest-first)', similarRoles(me, [...pool].reverse()).map((j) => j.id), picked.map((j) => j.id));
  const shuffledDates = pool.map((j, i) => ({ ...j, postedAt: 1_790_000_000_000 - i * 1000 }));
  check('nor does posting age', similarRoles(me, shuffledDates).map((j) => j.id), picked.map((j) => j.id));
  /* A second city copy carries the same fingerprint (roleKey), so it is the same role. */
  const fp = pool.map((j) => ({ ...j, roleFingerprint: `fp-${j.title}` }));
  const firstPick = similarRoles(me, fp)[0];
  const copies = Array.from({ length: 8 }, (_, i) => ({ ...firstPick, id: `copy-${i}` }));
  check('one per role: city copies of a picked role are one pick', similarRoles(me, [...fp, ...copies]).filter((j) => j.title === firstPick.title).length, 1);
  /* Deterministic pools: the hash decides order within a tier, so a check that
     leans on where a candidate happens to rank is luck, not a test. */
  const ownOther = job({ company: 'Me', title: 'My other role' });
  const stranger = job({ company: 'Stranger', title: 'Their role' });
  check('its own employer is never picked, even with room to spare', similarRoles(me, [me, ownOther, stranger]).map((j) => j.company), ['Stranger']);
  const near = Array.from({ length: 6 }, (_, i) => job({ title: `Near ${i}` }));
  const far = Array.from({ length: 20 }, (_, i) => job({ title: `Far ${i}`, location: 'Pune, Maharashtra, India' }));
  check('six in the same city beat twenty elsewhere, every one', similarRoles(me, [...far, ...near]).map((j) => j.title).sort(), near.map((j) => j.title).sort());
  const thin = job({ title: 'Thin only', bullets: [] });
  check('a noindex page is never picked, even when it is the only candidate', similarRoles(me, [me, thin]).length, 0);
  check('stableRank is deterministic', stableRank('a', 'b'), stableRank('a', 'b'));
  check('stableRank depends on the pair', stableRank('a', 'b') !== stableRank('a', 'c'), true);
}

console.log('\n== a role page ==');
{
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => job({ company: 'Infosys', title: `SRE ${i}`, family: 'devops', stipend: '' })),
    ...Array.from({ length: 4 }, () => job({ family: 'devops', employmentType: 'internship', location: 'Pune, Maharashtra, India' })),
  ];
  const g = roleGroups(rows);
  const group = g.roles[0];
  const html = renderRolePage(group, { region, roles: g.roles, combos: g.combos, skillPages: new Set(['python']), cityPages: new Set(['pune']) });
  check('it is indexable', NOINDEX.test(html), false);
  check('it names itself canonical', html.includes('<link rel="canonical" href="https://interndoor.com/roles/devops-cloud">'), true);
  check('its <title> fits 60 characters', titleOf(html).length <= 60, true);
  check('it names both kinds when both are there', /<h1>DevOps, cloud and site reliability internships and entry-level jobs in India<\/h1>/.test(html), true);
  check('it carries a breadcrumb', html.includes('"@type":"BreadcrumbList"'), true);
  check('the description says "fresher" when it has full-time roles', /content="[^"]*\(fresher\) jobs/.test(html), true);
  check('a skill with a page is linked', html.includes('href="/skills/python"'), true);
  check('a skill with no page is not', html.includes('href="/skills/sql"'), false);
  check('a city with a page is linked', html.includes('href="/locations/pune"'), true);
  check('a city with no page is not', html.includes('href="/locations/bengaluru"'), false);
  check('employers link their hubs', html.includes('href="/companies/infosys"'), true);
  check('its own paragraph is on it', html.includes('keep software running'), true);
  check('no employer text on it', html.includes('employer\'s own'), false);
  const once = roleInsights([job({ title: 'A' }), job({ title: 'A' }), job({ title: 'B' })]);
  check('a title seen once is not a "common title"', once.titles.map((x) => x.name), ['A']);
  const noPay = roleInsights(rows);
  check('pay is counted, not claimed', [noPay.paidInterns, noPay.paidFullTime], [0, 0]);
  check('an unstated pay says none, never "unpaid"', /None of the 4 internships state a stipend/.test(html) && !/unpaid/i.test(html), true);
  const intOnly = roleGroups(Array.from({ length: 8 }, () => job({ family: 'qa', employmentType: 'internship' })));
  const ih = renderRolePage(intOnly.roles[0], { region, roles: intOnly.roles });
  check('internships only: the heading does not claim jobs', /<h1>QA and software testing internships in India<\/h1>/.test(ih), true);
  check('internships only: no "fresher"', /fresher/.test(ih), false);
  const idx = renderRoleIndex(g.roles, g.combos, { region });
  check('the index is noindex while it lists fewer than 3 roles', NOINDEX.test(idx), true);
}

console.log('\n== the JobPosting description is our own words ==');
{
  const j = job({ description: 'EMPLOYER-OWN-TEXT the employer wrote this paragraph.', keySkills: ['Python', 'SQL'] });
  const html = renderJobPage(j, [], { region });
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  check('it opens with our summary', ld.description.startsWith('<p>Our own summary.</p>'), true);
  check('it lists the duties', ld.description.includes('<li>Build services</li>'), true);
  check('it names the skills', ld.description.includes('Skills: Python, SQL'), true);
  check('it never carries the employer\'s text', ld.description.includes('EMPLOYER-OWN-TEXT'), false);
  check('no stated experience: no experienceRequirements', 'experienceRequirements' in ld, false);
  const ldOf = (o) => JSON.parse(renderJobPage(job(o), [], { region }).match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  check('a stated "0–1 years" is no experience required', ldOf({ experience: 'Graduating 2027 · 0–1 years' }).experienceRequirements?.monthsOfExperience, 0);
  check('"2+ years" is 24 months', ldOf({ experience: '2+ years' }).experienceRequirements?.monthsOfExperience, 24);
  check('a graduation year alone states no experience', 'experienceRequirements' in ldOf({ experience: 'Graduating 2026' }), false);
  check('experienceMonths reads the minimum', ['1–3 years', '1 year', '2025 or 2026 graduates'].map(experienceMonths), [12, 12, null]);
  const withRole = renderJobPage(j, [], { region, role: { slug: 'software-engineering', name: 'Software engineering' } });
  check('a job page links its role page when one is passed', withRole.includes('<dt>Role type</dt><dd><a href="/roles/software-engineering">'), true);
  check('and not when none is', html.includes('Role type'), false);
  /* 587 of 703 live full-time pages were titled "... Internship" until 1 Oct 2026. */
  const ft = titleOf(renderJobPage(job({ company: 'Cisco', title: 'Site Reliability Engineer', employmentType: 'fulltime' }), [], { region }));
  check('a full-time role is never titled an internship', /internship/i.test(ft), false);
  check('it is titled a job', /Cisco Site Reliability Engineer Job\b/.test(ft), true);
  const ftHtml = renderJobPage(job({ company: 'Cisco', title: 'Site Reliability Engineer', employmentType: 'fulltime' }), [], { region });
  check('and its snippet says what it is', /<meta name="description" content="Site Reliability Engineer at Cisco in India\. Full-time entry-level role/.test(ftHtml), true);
  const it = titleOf(renderJobPage(job({ company: 'Cisco', title: 'Software Engineer', employmentType: 'internship' }), [], { region }));
  check('an internship whose title lacks the word still gains it', /Cisco Software Engineer Internship\b/.test(it), true);
}

console.log('\n== the real board, rendered ==');
const live = existsSync('web/public/data/jobs.json') ? (JSON.parse(readFileSync('web/public/data/jobs.json', 'utf8')).jobs ?? []) : [];
const dir = mkdtempSync(join(tmpdir(), 'rolepages-'));
try {
  copyFileSync('web/public/index.html', join(dir, 'index.html'));
  writePages(live, dir, []);
  const roleDir = join(dir, 'roles');
  const written = new Set(readdirSync(roleDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)));
  /* Without role pages every check below passes vacuously. */
  check('India has role pages to test against', written.size >= 5, true);
  check('the index is written', written.has('index'), true);

  const sitemap = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
  const inMap = new Set([...sitemap.matchAll(/<loc>https:\/\/interndoor\.com\/roles(?:\/([^<]*))?<\/loc>/g)].map((m) => m[1] ?? 'index'));
  check('the sitemap lists exactly the role pages written', [...written].filter((s) => !inMap.has(s)).concat([...inMap].filter((s) => !written.has(s))), []);
  check('no role page in the sitemap is noindex',
    [...written].filter((s) => NOINDEX.test(readFileSync(join(roleDir, `${s}.html`), 'utf8'))), []);
  check('no role page title is over 60 characters',
    [...written].filter((s) => titleOf(readFileSync(join(roleDir, `${s}.html`), 'utf8')).length > 60), []);

  /* Every /roles/ link on every page resolves — job pages, hubs, facets, the
     index, the homepage fill and the footer included. */
  const broken = new Set();
  let linking = 0;
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.html')) continue;
      const html = readFileSync(p, 'utf8');
      let found = false;
      for (const m of html.matchAll(/href="\/roles(?:\/([^"#?]*))?"/g)) {
        found = true;
        const slug = m[1] || 'index';
        if (!written.has(slug)) broken.add(slug);
      }
      if (found) linking++;
    }
  };
  walk(dir);
  check('every /roles/ link on the site resolves', [...broken], []);
  check('the links are really there (the walk found pages linking them)', linking > 500, true);
  const home = readFileSync(join(dir, 'index.html'), 'utf8');
  check('the homepage links the role pages', home.includes('<b>By role:</b>'), true);
  check('the homepage links the city pages', home.includes('<b>By city:</b>'), true);
  check('and the role index', home.includes('<a href="/roles">All&nbsp;roles&nbsp;→</a>'), true);
  const org = JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1])['@graph'].find((x) => x['@type'] === 'Organization');
  check('the Organization logo is at least 112px (logo-512)', org.logo, 'https://interndoor.com/logo-512.png');
  check('its sameAs names the LinkedIn company page', org.sameAs.includes('https://www.linkedin.com/company/interndoorhq/'), true);
  check('and never a personal LinkedIn profile', org.sameAs.some((u) => /linkedin\.com\/in\//.test(u)), false);
  check('the homepage allows a large image preview', home.includes('<meta name="robots" content="max-image-preview:large">'), true);
  const sample = readFileSync(join(roleDir, `${[...written].find((x) => x !== 'index')}.html`), 'utf8');
  check('so does an indexable page', sample.includes('<meta name="robots" content="max-image-preview:large">'), true);
  check('published: web/public/roles is in the allowlist', publishedPaths().includes('web/public/roles'), true);

  const jobFiles = readdirSync(join(dir, 'jobs')).filter((f) => !readFileSync(join(dir, 'jobs', f), 'utf8').includes('http-equiv="refresh"'));
  const withSimilar = jobFiles.filter((f) => readFileSync(join(dir, 'jobs', f), 'utf8').includes('Similar roles at other companies')).length;
  check('nearly every job page carries similar roles', withSimilar / Math.max(1, jobFiles.length) > 0.9, true);

  /* Two renders of the same rows write the same bytes (§10). */
  const dir2 = mkdtempSync(join(tmpdir(), 'rolepages-'));
  try {
    copyFileSync('web/public/index.html', join(dir2, 'index.html'));
    writePages(live, dir2, []);
    const differ = [...written].filter((s) => readFileSync(join(roleDir, `${s}.html`), 'utf8') !== readFileSync(join(dir2, 'roles', `${s}.html`), 'utf8'));
    check('two renders of the same rows are byte-identical', differ, []);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== a thin board lists no role index in its sitemap ==');
{
  const small = mkdtempSync(join(tmpdir(), 'rolepages-'));
  try {
    writePages(Array.from({ length: 8 }, () => job()), small, []);
    const sm = readFileSync(join(small, 'sitemap.xml'), 'utf8');
    check('one role page: it is in the sitemap', sm.includes('<loc>https://interndoor.com/roles/software-engineering</loc>'), true);
    check('one role page: the (noindex) index is not', sm.includes('<loc>https://interndoor.com/roles</loc>'), false);
    check('and the index really is noindex', NOINDEX.test(readFileSync(join(small, 'roles', 'index.html'), 'utf8')), true);
  } finally { rmSync(small, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
