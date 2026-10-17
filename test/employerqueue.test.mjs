/**
 * The employer queue page and the numbers employers are told, 17 Oct 2026.
 *
 * src/employerqueue.js renders http://127.0.0.1:4322/employers, where he
 * approves or rejects what came in through /post-a-job. src/employerpitch.js
 * reads seven days of Apply clicks out of the counter store for that page and
 * for /post-a-job. A figure told to an employer must never be higher than what
 * happened, so every rounding here is DOWN, and the word is "Apply clicks".
 */
import { readFileSync } from 'node:fs';
import { checksFor, renderEmployerQueue, fetchSubmissions, readDecisions, outreachNote } from '../src/employerqueue.js';
import { pitchNumbers, roundedText, floorTo, lastDays } from '../src/employerpitch.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const cfg = loadConfig();   // fills the blocklist isBlockedCompany reads
const blocked = (cfg.matching?.blocklist ?? [])[0];
const sub = (over = {}) => ({
  id: 'abc123', at: '2026-10-12T03:12:20.000Z', company: 'Nestack Technologies Pvt Ltd', website: 'https://nestack.com/',
  email: 'contact@nestack.com', kind: 'intern', pay: 12000, period: 'month',
  link: 'https://neilp.nestack.ai/career/internship', notes: 'In-person interviews are required.', ...over,
});

console.log('\n== the checks ==');
{
  const c = checksFor(sub(), cfg.watchlist);
  ok('a new employer is flagged for a look', c.some((x) => x.level === 'warn' && /New employer/.test(x.text)));
  ok('a link off the employer\'s own domain is flagged', c.some((x) => x.level === 'warn' && /neilp\.nestack\.ai, not nestack\.com/.test(x.text)));
  const gh = checksFor(sub({ link: 'https://boards.greenhouse.io/stripe/jobs/123', website: 'https://stripe.com' }), cfg.watchlist);
  ok('a board we read is good news', gh.some((x) => x.level === 'ok' && /greenhouse\/stripe/.test(x.text)));
  ok('and the domain check is not asked of a board link', !gh.some((x) => /not stripe\.com/.test(x.text)));
  const known = checksFor(sub({ company: 'Google' }), cfg.watchlist);
  ok('a watchlist employer says so', known.some((x) => x.level === 'ok' && /Already on the watchlist/.test(x.text)));
  ok('a blocklisted employer is a stop', blocked && checksFor(sub({ company: blocked }), cfg.watchlist).some((x) => x.level === 'stop'), `blocklist entry: ${blocked}`);
}

console.log('\n== the page ==');
{
  const page = renderEmployerQueue({ submissions: [sub(), sub({ id: 'zzz999', company: 'Done Co' })], decisions: { zzz999: { status: 'rejected', at: '2026-10-13T00:00:00Z', reason: 'pay too low' } }, watchlist: cfg.watchlist });
  ok('counts what is waiting', /1 waiting for your decision/.test(page));
  ok('a waiting submission has both buttons', /data-act="approve" data-id="abc123"/.test(page) && /data-act="reject" data-id="abc123"/.test(page));
  ok('a decided one has none', !/data-act="approve" data-id="zzz999"/.test(page));
  ok('and shows its decision and reason', /Rejected/.test(page) && /pay too low/.test(page));
  ok('pay is in rupees per period', /Internship · ₹12,000 per month/.test(page));
  const stop = renderEmployerQueue({ submissions: [sub({ company: blocked })], watchlist: cfg.watchlist });
  ok('a blocklisted employer cannot be approved from the page', /data-act="approve" data-id="abc123" disabled/.test(stop));
  const evil = renderEmployerQueue({ submissions: [sub({ company: '<script>alert(1)</script>', link: 'javascript:alert(1)', notes: '<img src=x onerror=alert(1)>' })], watchlist: cfg.watchlist });
  ok('what an employer typed is escaped', !/<script>alert/.test(evil) && !/<img src=x/.test(evil));
  ok('a link that is not http(s) never becomes an href', !/href="javascript:/i.test(evil));
  const empty = renderEmployerQueue({ submissions: [], watchlist: cfg.watchlist });
  ok('an empty queue says so plainly', /Nothing waiting/.test(empty) && /No employer has sent a role/.test(empty));
  const pitched = renderEmployerQueue({ submissions: [], watchlist: cfg.watchlist, pitch: { applyPerDayText: '2,000+', applyWeekText: '15,000+', liveRoles: 1407 } });
  ok('the numbers to quote are on the page', /2,000\+<\/b> Apply clicks a day/.test(pitched) && /15,000\+/.test(pitched));
  const visible = pitched.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '').replace(/"[^"]*"/g, '');
  ok('and reminds him never to say applicants', /never "applicants"/.test(pitched) || /never/.test(visible));
  ok('with a note to send an employer, from the same figures', /A note to send an employer/.test(pitched) && /Candidates pressed Apply 15,000\+ times on our listings in the last 7 days, across 1,407 live roles\./.test(pitched));
  ok('the note never says applicants and carries no em dash', !/applicant/i.test(outreachNote({ applyWeekText: '1+', liveRoles: 2 })) && !/[\u2013\u2014]/.test(outreachNote({ applyWeekText: '1+', liveRoles: 2 })));
  ok('no figures, no note', outreachNote(null) === null && !/A note to send/.test(renderEmployerQueue({ watchlist: cfg.watchlist })));
  ok('the page carries no em dash', !/—/.test(page.replace(/<script>[\s\S]*?<\/script>/, '')));
  ok('decisions go to the helper\'s own endpoint, as JSON', /fetch\('\/api\/employers\/decide', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/.test(page));
}

console.log('\n== reading the store ==');
{
  const good = { ok: true, json: async () => ({ result: [JSON.stringify(sub()), 'not json', JSON.stringify({ no: 'id' })] }) };
  let asked = '';
  const list = await fetchSubmissions({ url: 'https://kv.example/', token: 't', fetchImpl: async (u, init) => { asked = `${u} ${init.headers.authorization}`; return good; } });
  ok('reads the list and drops what it cannot read', list.length === 1 && list[0].id === 'abc123');
  ok('with the token in a header', /lrange\/job-submissions\/0\/499 Bearer t$/.test(asked), asked);
  let threw = null;
  try { await fetchSubmissions({ url: 'u', token: 't', fetchImpl: async () => ({ ok: false, status: 502 }) }); } catch (err) { threw = err.message; }
  ok('a store that answers badly is an error, not an empty queue', /HTTP 502/.test(threw ?? ''));
  ok('damaged decisions read as none', JSON.stringify(readDecisions({ getSetting: () => '{nope' })) === '{}');
}

console.log('\n== the numbers employers are told ==');
{
  ok('2,588 a day reads 2,500+', roundedText(2588) === '2,500+');
  ok('16,234 a week reads 16,000+', roundedText(16234) === '16,000+');
  ok('999 reads 990+, never 1,000', roundedText(999) === '990+');
  ok('1,407 live roles read 1,400+', roundedText(1407) === '1,400+');
  ok('455 employers read 450+', roundedText(455) === '450+');
  ok('a round number stays itself', roundedText(2500) === '2,500+');
  ok('nothing reads as nothing', roundedText(0) === null && roundedText('x') === null);
  ok('floorTo only goes down', floorTo(1999, 1000) === 1000 && floorTo(999, 1000) === 0);
  const NOW = Date.UTC(2026, 9, 17, 9, 0);
  const days = lastDays(7, NOW);
  ok('the week is the 7 complete UTC days before today', days[0] === '2026-10-16' && days[6] === '2026-10-10' && !days.includes('2026-10-17'));

  let sent = null;
  const perDay = [2588, 2314, 2059, 1849, 1551, 1310, 1483];
  const kv = async (u, init) => { sent = { u, body: JSON.parse(init.body), auth: init.headers.authorization }; return { ok: true, json: async () => perDay.map((n) => ({ result: String(n) })) }; };
  const p = await pitchNumbers({ url: 'https://kv.example', token: 'tok', liveRoles: 1407, now: NOW, fetchImpl: kv });
  ok('asks for the apply count of each of those days', sent.body.length === 7 && sent.body[0][0] === 'GET' && sent.body[0][1] === 'count:2026-10-16:apply:IN');
  ok('in one pipeline, with the token in a header', sent.u === 'https://kv.example/pipeline' && sent.auth === 'Bearer tok');
  ok('sums the week', p.applyWeek === perDay.reduce((a, b) => a + b, 0));
  ok('and quotes it rounded down', p.applyWeekText === '13,000+' && p.applyPerDayText === '1,800+', `${p.applyWeekText} / ${p.applyPerDayText}`);
  ok('carries the live role count', p.liveRoles === 1407);
  const thin = await pitchNumbers({ url: 'u', token: 't', now: NOW, fetchImpl: async () => ({ ok: true, json: async () => Array(7).fill({ result: '10' }) }) });
  ok('a thin week is not quoted at all', thin === null);
  ok('no store, no figure', await pitchNumbers({ url: '', token: '' }) === null);
  ok('a failed read, no figure', await pitchNumbers({ url: 'u', token: 't', fetchImpl: async () => { throw new Error('down'); } }) === null);
  ok('a short answer, no figure', await pitchNumbers({ url: 'u', token: 't', fetchImpl: async () => ({ ok: true, json: async () => [{ result: '5000' }] }) }) === null);
}

console.log('\n== /post-a-job and the hiring line ==');
{
  const { renderPostJobPage } = await import('../src/pages.js');
  const p = renderPostJobPage({ pitch: { applyPerDayText: '2,500+', applyWeekText: '16,000+', days: ['2026-10-16'] }, board: { roles: 1407, employers: 455 } });
  ok('the numbers are on the page', /<dd>2,500\+<\/dd>/.test(p) && /<dd>1,400\+<\/dd>/.test(p) && /<dd>450\+<\/dd>/.test(p));
  ok('labelled as Apply clicks', /<dt>Apply clicks a day<\/dt>/.test(p));
  ok('with the week they are from', /16,000\+ times on InternDoor listings in the 7 days to 16 Oct/.test(p));
  ok('and never as applicants', !/applicant/i.test(p));
  ok('a dl holds only dt then dd in each div', /<div><dt>[^<]+<\/dt><dd>[^<]+<\/dd><\/div>/.test(p) && !/<div><dd>/.test(p));
  const bare = renderPostJobPage({});
  ok('no figure, no block', !/pj-nums/.test(bare));
  ok('a half figure, no block', !/pj-nums/.test(renderPostJobPage({ pitch: { applyPerDayText: '2,500+' } })));
  const block = p.slice(p.indexOf('<dl class="pj-nums">'), p.indexOf('<ul class="pj-trust">'));
  ok('the numbers block carries no em dash', block.length > 200 && !/[\u2013\u2014]/.test(block));
  const src = read('src/pages.js');
  ok('job pages carry the hiring line', /\$\{hireLine\(job\.company, 'jp-hire'\)\}/.test(src));
  ok('company pages too', /\$\{hireLine\(company, 'hire-line'\)\}/.test(src));
  ok('linking the one root page, never a regional copy', /<a href="\/post-a-job">Post a role on InternDoor, free<\/a>/.test(src) && !/regionHref\('\/post-a-job'/.test(src));
  const pub = read('src/publish.js');
  ok('a publish asks for the figures once a day per board', /const key = `employerPitch:\$\{region\.code\}`;/.test(pub) && /cached\?\.day === today && cached\.pitch/.test(pub));
  ok('keeps only a good read', /if \(pitch\) \{\s*store\.setSetting\(key/.test(pub));
  ok('and lets a stale one go after three days', /now - Number\(cached\.at \?\? 0\) < PITCH_KEEP_MS/.test(pub) && /PITCH_KEEP_MS = 3 \* 86_400_000/.test(pub));
}

console.log('\n== wiring ==');
{
  const qs = read('bin/queue-server.js');
  ok('the helper serves the page', /path === '\/employers'/.test(qs) && /renderEmployerQueue\(/.test(qs));
  const at = qs.indexOf("path === '/api/employers/decide'");
  ok('decisions are POST-only and behind the same-origin guard', at > qs.indexOf("req.method === 'POST' && !sameOrigin(req)") && /'\/api\/employers\/decide' && req\.method === 'POST'/.test(qs));
  ok('and read a JSON body (the CSRF guard)', /'\/api\/employers\/decide'[\s\S]{0,120}await readJson\(req, res\)/.test(qs));
  ok('and run the one implementation, bin/job-submissions.js', /\['bin\/job-submissions\.js', '--approve', id\]/.test(qs) && /\['bin\/job-submissions\.js', '--reject', id/.test(qs));
  const cli = read('bin/job-submissions.js');
  ok('the terminal tool shares the checks', /checksFor\(e, cfg\.watchlist\)/.test(cli));
  ok('and the notification points at the page', /127\.0\.0\.1:4322\/employers/.test(cli));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
