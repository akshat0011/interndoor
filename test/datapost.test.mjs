/**
 * The weekly data posts: src/datapost.js, the card model, the page, the
 * schedule and the wiring.
 *
 * Fixtures go through a real in-memory Store and the REAL watchlist, because
 * the whole point of `dataRows` is that it re-derives the gate the way publish
 * does — a fixture watchlist would keep passing after the rule drifted. Every
 * employer named below is on the live watchlist; the off-watchlist one is a
 * made-up name that nothing can match.
 *
 * The standing rule from /report: EVERY NUMBER IN A HEADLINE IS DERIVABLE
 * FROM THE STATS. It is asserted mechanically for every format.
 */
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import {
  dataRows, dataPosts, pickOfWeek, dataPostDue, dataPostRegions, prettySkill,
  employersPost, newcomersPost, queuePost, stipendsPost, timingPost, citiesPost, skillsPost,
  FORMATS, MIN_ROWS, MIN_COUNTED, WINDOW_DAYS,
} from '../src/datapost.js';
import { cardModel, cardId, MAX_ROWS } from '../src/datacard.js';
import { buildDataPage } from '../src/postpage.js';
import { plainText } from '../src/postgen.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const cfg = loadConfig();

/* ---- a board in memory ---- */
const NOW = Date.UTC(2026, 8, 17, 6, 0, 0);        // 17 Sep 2026 11:30 IST
const D = 86_400_000, H = 3_600_000;
const store = new Store(':memory:');
let seq = 0;
function put(o) {
  seq += 1;
  const id = o.id ?? (o.ats ? `ats:greenhouse:x:${seq}` : String(4400000000 + seq));
  const firstSeen = o.firstSeen ?? NOW - 3 * D;
  store.db.prepare(`INSERT INTO jobs (job_id, title, company, location, first_seen_at, last_seen_at, first_run_id, posted_at,
      is_tech, suppressed_reason, employment_type, workplace_type, applicants, stipend_min, stipend_max, stipend_currency, stipend_period, salary_text, skills, region)
    VALUES (?, ?, ?, ?, ?, ?, 'r', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, o.title ?? 'Software Engineer Intern', o.company, o.location ?? 'Bengaluru, Karnataka, India',
    firstSeen, firstSeen, o.postedAt ?? firstSeen - 2 * H,
    o.isTech ?? 1, o.suppressed ?? null, o.employment ?? 'intern', o.mode ?? 'On-site', o.applicants ?? null,
    o.min ?? null, o.max ?? null, o.currency ?? null, o.period ?? null, o.salaryText ?? null,
    JSON.stringify(o.skills ?? ['python', 'sql']), o.region ?? 'IN');
  return id;
}
/* Six employers with varying counts, an old-timer, and the rows that must be refused. */
for (let i = 0; i < 12; i++) put({ company: 'Siemens', location: i % 2 ? 'Bengaluru, Karnataka, India' : 'Bangalore, India', applicants: `${i * 12} applicants`, firstSeen: NOW - (i + 1) * D, postedAt: NOW - (i + 1) * D - H, skills: ['python', 'c++', 'git', 'python'] });   // python twice: counted once
for (let i = 0; i < 9; i++) put({ company: 'Microsoft', location: 'Hyderabad, Telangana, India', applicants: 'Over 100 applicants', mode: 'Hybrid', firstSeen: NOW - (i + 2) * D, skills: ['python', 'sql', 'aws'] });
for (let i = 0; i < 7; i++) put({ company: 'Google', title: `Intern ${i}`, location: 'Mumbai Metropolitan Region', applicants: '0 applicants', mode: 'Remote', firstSeen: NOW - (i + 1) * D, min: 40000, max: 60000, currency: 'INR', period: 'month', salaryText: '₹40,000/month', skills: ['java', 'python'] });
for (let i = 0; i < 6; i++) put({ company: 'Valeo', location: 'Chennai, Tamil Nadu, India', applicants: '30 applicants', firstSeen: NOW - (i + 1) * D, skills: ['c++'] });
for (let i = 0; i < 5; i++) put({ company: 'Nvidia', location: 'Pune, Maharashtra, India', applicants: '5 applicants', firstSeen: NOW - (i + 1) * D, salaryText: '₹0', skills: [] });
for (let i = 0; i < 4; i++) put({ company: 'Qualcomm', location: 'Gurgaon, Haryana, India', firstSeen: NOW - (i + 1) * D, ats: true, postedAt: NOW - 40 * D, applicants: '50 applicants', skills: ['python'] });   // a count on a careers-board row is never read
for (const c of ['IBM', 'Oracle', 'Adobe', 'Intel']) put({ company: c, location: 'Noida, Uttar Pradesh, India', firstSeen: NOW - 2 * D, mode: '' });   // one each: newcomers with a single posting, no work mode stated
put({ company: 'Nvidia', firstSeen: NOW - 45 * D });                                   // Nvidia is NOT a newcomer: a row before the window
put({ company: 'Amazon', firstSeen: NOW - 40 * D });                                   // outside the window, on the board before it
const REFUSED = [
  put({ company: 'Siemens', isTech: 0 }),
  put({ company: 'Siemens', suppressed: 'apply page 404s' }),
  put({ company: 'Siemens', employment: 'fulltime', title: 'Campus Software Engineer (Full-Time)' }),
  put({ company: 'Zzqx Zenithbyte Solutions', location: 'Bengaluru, India' }),
  put({ company: 'Siemens', location: 'Austin, TX', region: 'US' }),
  put({ company: 'Siemens', firstSeen: NOW + H }),                                     // the future is not in the window
];

console.log('\n== the gate, re-derived the way publish does ==');
{
  const data = dataRows(store, cfg, { region: 'IN', now: NOW });
  ok(`the window holds ${data.rows.length} rows: 12+9+7+6+5+4+4 = 47`, data.rows.length === 47, String(data.rows.length));
  ok('history holds the two older rows and the future one too', data.history.length === 50);
  ok('none of the refused rows is in the window', REFUSED.every((id) => !data.rows.some((r) => r.id === id)));
  ok('and only the future one is anywhere at all', REFUSED.filter((id) => data.history.some((r) => r.id === id)).length === 1);
  ok('the employer is the WATCHLIST name', data.rows.every((r) => r.employer && r.employer !== 'Zzqx Zenithbyte Solutions'));
  ok('careers-board rows are marked', data.rows.filter((r) => r.ats).length === 4);
  ok('tracking began at the oldest row', data.trackedSince === NOW - 45 * D);
  ok('a stated stipend needs a real figure — ₹0 is not one', data.rows.filter((r) => r.stated).length === 7);
  ok('"Over 100" reads as 100+, careers-board rows carry no count', data.rows.filter((r) => r.applicants != null).length === 39 && data.rows.filter((r) => r.applicants >= 100).length === 12);
  ok('Bangalore and Bengaluru fold, Gurgaon is Gurugram', new Set(data.rows.filter((r) => r.employer === 'Siemens').map((r) => r.city)).size === 1 && data.rows.find((r) => r.employer === 'Qualcomm').city === 'Gurugram');
  ok('US rows never appear on the India board', dataRows(store, cfg, { region: 'US', now: NOW }).rows.length === 1);
}

const data = dataRows(store, cfg, { region: 'IN', now: NOW });
const headNumbers = (post) => (plainText(post.split('\n')[0]).match(/\d+/g) || []).map(Number);
const deepNumbers = (o, out = new Set()) => {
  if (typeof o === 'number') out.add(o);
  else if (Array.isArray(o)) o.forEach((v) => deepNumbers(v, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => deepNumbers(v, out));
  return out;
};
const derivable = (p) => { const nums = deepNumbers(p.stats); nums.add(WINDOW_DAYS); nums.add(1); return headNumbers(p.post).every((n) => nums.has(n)); };
/* URLs first: utm_source=linkedin is a tag, not a sentence. */
const noSources = (text) => !/\b(linkedin|greenhouse|lever|ashby|workday|smartrecruiters|scrap(e|ed|ing))\b/i.test(String(text).replace(/https?:\/\/\S+/g, ''));

console.log('\n== 1. who posted the most ==');
{
  const p = employersPost(data, cfg);
  ok('composes', !!p && p.key === 'employers');
  ok('ranked by postings, ties alphabetical', p.stats.top.map((t) => t.employer).join(',') === 'Siemens,Microsoft,Google,Valeo,Nvidia,Qualcomm,Adobe,IBM,Intel,Oracle', p.stats.top.map((t) => t.employer).join(','));
  ok('the headline is bold and its numbers are in the stats', /^[\u{1D400}-\u{1D7FF}]/u.test(p.post) && derivable(p));
  ok('the multi-city caveat appears because Siemens posts one title in many rows', /same role in several cities/.test(p.post));
  ok('the link is the companies directory, UTM-tagged', /https:\/\/interndoor\.com\/companies\?utm_source=linkedin&utm_medium=social&utm_campaign=data-post&utm_content=employers/.test(p.post));
  ok('no source is ever named', noSources(p.post) && noSources(p.title));
  ok('the card lists the same ten in the same order', p.card.rows.map((r) => r.label).join() === p.stats.top.map((t) => t.employer).join() && p.card.rows[0].share === 1);
  ok('too few rows → nothing, not a thin post', employersPost({ ...data, rows: data.rows.slice(0, MIN_ROWS - 1) }, cfg) === null);
}

console.log('\n== 2. who posted for the first time ==');
{
  const p = newcomersPost(data, cfg);
  ok('composes', !!p && p.key === 'newcomers');
  const names = p.stats.listed.map((l) => l.employer);
  ok('an employer with a row before the window is NOT a newcomer', !names.includes('Nvidia') && !names.includes('Amazon'));
  ok('the others are, ranked by postings then name', names.join() === 'Siemens,Microsoft,Google,Valeo,Qualcomm,Adobe,IBM,Intel,Oracle', names.join());
  ok('the count in the headline is the count of newcomers', headNumbers(p.post)[0] === p.stats.newcomers && p.stats.newcomers === 9);
  ok('it says "first since we started tracking", never "first ever"', /First since we started tracking/.test(p.post) && !/first ever[^,.]/.test(p.post.replace('not first ever', '')));
  ok('headline numbers derivable', derivable(p));
  ok('fewer than 8 newcomers → nothing', newcomersPost({ ...data, rows: data.rows.filter((r) => r.employer === 'Siemens' || r.employer === 'Microsoft' || r.employer === 'Google' || r.employer === 'Valeo') }, cfg) === null);
}

console.log('\n== 3. how fast the queue forms ==');
{
  const p = queuePost(data, cfg);
  ok('composes', !!p && p.key === 'queue');
  const b = p.stats.bands;
  ok('bands sum to the counted rows, careers-board rows excluded', b.none + b.few + b.some + b.many === p.stats.counted && p.stats.counted === 39);
  ok('Microsoft\'s "Over 100" and Siemens\' 108/120/132 are 100+', b.many === 12);
  ok('Google\'s zeros and Siemens\' first are "nobody yet"', b.none === 8);
  ok('"1 in N" is counted ÷ 100+, at least 2', p.stats.oneIn === Math.round(39 / 12) && p.stats.oneIn >= 2);
  ok('headline numbers derivable', derivable(p));
  ok('the WhatsApp channel is offered where the region has one', /whatsapp\.com\/channel\//.test(p.post));
  ok('the percentages in the body are the stats\'', new RegExp(`100\\+ applicants — ${b.many} \\(${p.stats.pct.many}%\\)`).test(p.post));
  ok('too few counted → nothing', queuePost({ ...data, rows: data.rows.filter((r) => r.employer === 'Google') }, cfg) === null);
}

console.log('\n== 4. who says what they pay ==');
{
  const p = stipendsPost(data, cfg);
  ok('composes', !!p && p.key === 'stipends');
  ok('stated is the stipendText rule: 7 of 47 (₹0 does not count)', p.stats.stated === 7 && p.stats.rows === 47);
  ok('the median is over INR monthly figures and needs at least 5', p.stats.monthlyFigures === 7 && p.stats.medianMonthlyInr === 40000 && /₹40,000/.test(p.post));
  ok('the top employers\' pay line counts how many of them stated on any listing', p.stats.topStated === 1 && /1 of them stated pay/.test(p.post));
  ok('headline numbers derivable', derivable(p));
  ok('no source named', noSources(p.post));
}

console.log('\n== 5. when they go up ==');
{
  const p = timingPost(data, cfg);
  ok('composes', !!p && p.key === 'timing');
  ok('careers-board rows are excluded from timing', p.stats.counted === 43);
  ok('weekdays sum to the counted rows', Object.values(p.stats.byDay).reduce((a, b) => a + b, 0) === 43);
  ok('the hour blocks sum too', Object.values(p.stats.byBlock).reduce((a, b) => a + b, 0) === 43);
  ok('headline names the busiest day', new RegExp(`^${Object.entries(p.stats.byDay).sort((a, b) => b[1] - a[1])[0][0]}`).test(plainText(p.post.split('\n')[0])));
  ok('headline numbers derivable', derivable(p));
  ok('the card is Monday to Sunday', p.card.rows.map((r) => r.label).join() === 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday');
}

console.log('\n== 6. where they are ==');
{
  const p = citiesPost(data, cfg);
  ok('composes', !!p && p.key === 'cities');
  ok('Bengaluru leads with the folded count', p.stats.cities[0].city === 'Bengaluru' && p.stats.cities[0].postings === 12);
  ok('mode percentages are over ALL rows, not only those stating one', p.stats.modePct.remote === Math.round(700 / 47) && p.stats.modeStated === 43 && p.stats.modePct.remote !== Math.round(700 / 43));
  ok('headline numbers derivable', derivable(p));
  ok('the hashtag is the top city', /#bengaluru\b/.test(p.post));
}

console.log('\n== 7. what they ask for ==');
{
  const p = skillsPost(data, cfg);
  ok('composes', !!p && p.key === 'skills');
  ok('denominator is rows WITH skills (Nvidia\'s five have none)', p.stats.rows === 42);
  ok('python leads and counts once per posting', p.stats.top[0].skill === 'python' && p.stats.top[0].postings === 12 + 9 + 7 + 4 + 4);
  ok('headline numbers derivable', derivable(p));
  ok('casing is the community\'s: Git, SQL, C++, Machine learning', ['git', 'sql', 'c++', 'machine learning', 'aws', 'python'].map(prettySkill).join('|') === 'Git|SQL|C++|Machine learning|AWS|Python');
  ok('too few with skills → nothing', skillsPost({ ...data, rows: data.rows.filter((r) => r.employer === 'Nvidia' || r.employer === 'Siemens') }, cfg) === null);
}

console.log('\n== all together, and the pick ==');
{
  const b = dataPosts(store, cfg, { region: 'IN', now: NOW });
  ok('every format composed, in FORMATS order', b.posts.map((p) => p.key).join() === FORMATS.join());
  ok('every post ends with a UTM-tagged interndoor link or hashtags and names no source', b.posts.every((p) => noSources(p.post) && /utm_campaign=data-post/.test(p.post)));
  ok('no post is over LinkedIn\'s cut', b.posts.every((p) => p.post.length < 1300), b.posts.map((p) => p.post.length).join());
  ok('nothing renders undefined or NaN', b.posts.every((p) => !/undefined|NaN|\[object/.test(p.post + p.title + JSON.stringify(p.card))));
  const picks = new Set([0, 1, 2, 3, 4, 5, 6].map((w) => pickOfWeek(b.posts, NOW + w * 7 * D)));
  ok('the pick rotates through every format over seven weeks', picks.size === FORMATS.length);
  ok('and is deterministic', pickOfWeek(b.posts, NOW) === pickOfWeek(b.posts, NOW + H));
  ok('no posts → no pick', pickOfWeek([], NOW) === null);
}

console.log('\n== the schedule ==');
{
  const C = (over = {}) => ({ postQueue: { dataPost: { enabled: true, weekday: 3, hour: 10, ...over } } });
  const wed10 = Date.UTC(2026, 8, 16, 4, 30);   // Wed 16 Sep 2026 10:00 IST
  ok('off unless enabled is literally true', dataPostDue({ postQueue: { dataPost: { weekday: 3, hour: 10 } } }, null, wed10) === false && dataPostDue(C({ enabled: 'yes' }), null, wed10) === false);
  ok('not before the hour', dataPostDue(C(), null, wed10 - H) === false);
  ok('due on the hour', dataPostDue(C(), null, wed10) === true);
  ok('and after it', dataPostDue(C(), null, wed10 + 5 * H) === true);
  ok('not on another day', dataPostDue(C(), null, wed10 + D) === false);
  ok('once per week: the week key stops a repeat', dataPostDue(C(), '2026-W38', wed10) === false && dataPostDue(C(), '2026-W37', wed10) === true);
  ok('regions default to India', dataPostRegions({}).join() === 'IN' && dataPostRegions({ postQueue: { dataPost: { regions: ['in', 'us'] } } }).join() === 'IN,US');
}

console.log('\n== the card model and the page ==');
{
  const m = cardModel({ eyebrow: 'e', headline: 'h', rows: Array.from({ length: 14 }, (_, i) => ({ label: `r${i}`, value: i ? String(i) : '', share: i / 5 })) });
  ok(`at most ${MAX_ROWS} rows`, m.rows.length === MAX_ROWS);
  ok('shares clamp to [0, 1]', m.rows.every((r) => r.share >= 0 && r.share <= 1) && m.rows[9].share === 1);
  ok('an empty value stays empty', m.rows[0].value === '');
  ok('the band has a default', m.band === 'BE EARLY.' && cardModel({ band: 'X' }).band === 'X');
  ok('card ids are safe file names', cardId('employers', 'in') === 'data-employers-IN' && cardId('../x', 'IN') === 'data-x-IN');
  const b = dataPosts(store, cfg, { region: 'IN', now: NOW });
  const html = buildDataPage(b, { generatedAt: NOW, pick: 'queue', cards: { queue: 'data-queue-IN', employers: 'data-employers-IN' } });
  ok('one section per format', (html.match(/<section class="fmt/g) || []).length === b.posts.length);
  ok('the pick is marked once, on the picked format', (html.match(/class="fmt is-pick"/g) || []).length === 1 && /class="fmt is-pick" id="fmt-queue"/.test(html));
  ok('images come from the /li/ route only where rendered', (html.match(/src="\/li\/data-[a-z]+-IN\.png"/g) || []).length === 2);
  ok('every post is on the page, escaped', b.posts.every((p) => html.includes(p.post.split('\n')[2].replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 40))));
  ok('the notes travel with the post', b.posts.every((p) => html.includes('How it was counted')));
  const tpl = read('web/data-card.html');
  ok('the card template has the ids the renderer fills', ['eyebrow', 'headline', 'rows', 'say'].every((id) => tpl.includes(`id="${id}"`)));
  ok('and no inline script to keep in step', !/<script/.test(tpl));
}

console.log('\n== wired in ==');
{
  const run = read('bin/run.sh');
  ok('bin/run.sh asks after every scan, output discarded', /bin\/datapost\.js" --no-open >> "\$LOG" 2>&1 \|\| true/.test(run));
  ok('and after the roundup, before the digest', run.indexOf('bin/datapost.js') > run.indexOf('bin/weekly.js') && run.indexOf('bin/datapost.js') < run.indexOf('bin/digest.js'));
  const pkg = JSON.parse(read('package.json'));
  ok('npm run data-post exists', /bin\/datapost\.js/.test(pkg.scripts['data-post'] || ''));
  const qs = read('bin/queue-server.js');
  ok('/data/latest is served', /path === '\/data\/latest'[\s\S]*PATHS\.latestData/.test(qs));
  ok('/data/<id> is guarded by SAFE_ID', /path\.startsWith\('\/data\/'\)[\s\S]*SAFE_ID\.test\(id\)[\s\S]*`data-\$\{id\}\.html`/.test(qs));
  const conf = JSON.parse(read('config.json')).postQueue.dataPost;
  ok('config: on, India, Wednesday 10:00', conf.enabled === true && conf.regions.join() === 'IN' && conf.weekday === 3 && conf.hour === 10);
  const tool = read('bin/datapost.js');
  ok('--force never consumes the week', /if \(!FORCE\) store\.setSetting\(settingFor\(code\), keyFor\(code\)\);/.test(tool));
  ok('cards are rendered before the page links them, and a failed card costs only its image', tool.indexOf('renderDataCard(') < tool.indexOf('writeDataPage(') && /catch \(err\) \{\s*log\.warn\(`Data post card/.test(tool));
  ok('a thin week marks itself done on a scheduled run only', /if \(!DRY_RUN && !FORCE\) store\.setSetting\(settingFor\(code\), keyFor\(code\)\);\s*continue;/.test(tool));
}

console.log('\n== the prune leaves the data pages alone ==');
{
  const { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prunePostPages } = await import('../src/postpage.js');
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-datapost-'));
  const old = new Date(Date.now() - 3 * D);
  for (const f of ['posts-2026-09-10T10-00-00.html', 'data-2026-W38-IN.html', 'data-latest.html', 'weekly-latest.html']) {
    writeFileSync(join(dir, f), '<html>'); utimesSync(join(dir, f), old, old);
  }
  const dropped = prunePostPages(Date.now() - D, dir);
  ok('an aged batch page goes', dropped === 1 && !existsSync(join(dir, 'posts-2026-09-10T10-00-00.html')));
  ok('the data pages survive whatever their age', existsSync(join(dir, 'data-2026-W38-IN.html')) && existsSync(join(dir, 'data-latest.html')));
  rmSync(dir, { recursive: true, force: true });
}

store.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
