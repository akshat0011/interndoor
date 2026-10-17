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
import { checksFor, renderEmployerQueue, renderEmployerList, groupSubmissions, ago, fetchSubmissions, readDecisions, outreachNote, employerEmail } from '../src/employerqueue.js';
import { pitchNumbers, roundedText, floorTo, lastDays } from '../src/employerpitch.js';
import { loadConfig, matchCompany } from '../src/config.js';

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
  /* A name no watchlist term can match. Not Nestack: it has been on the
     watchlist since its approval on 17 Oct 2026, which is how this check first
     failed (a live-data fixture, the §8 hiring-record lesson again). */
  ok('the stand-in employer really is new', matchCompany('Quillfern Robotics Pvt Ltd', cfg.watchlist) === null);
  const c = checksFor(sub({ company: 'Quillfern Robotics Pvt Ltd' }), cfg.watchlist);
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
  ok('the tabs count each status', /data-count="waiting">1</.test(page) && /data-count="rejected">1</.test(page) && /data-count="approved">0</.test(page) && /data-count="all">2</.test(page));
  ok('the tab title carries the waiting count', /<title>\(1\) Employer queue/.test(page));
  ok('every card says its status for the tabs', /id="s-abc123" data-status="waiting"/.test(page) && /id="s-zzz999" data-status="rejected"/.test(page));
  ok('a waiting submission has both buttons', /data-act="approve" data-id="abc123"/.test(page) && /data-act="reject" data-id="abc123"/.test(page));
  ok('a decided one has none', !/data-act="approve" data-id="zzz999"/.test(page));
  ok('and shows its decision and reason', /Rejected/.test(page) && /pay too low/.test(page));
  ok('pay is in rupees per period', /<span class="kind">Internship<\/span><span class="pay">₹12,000 per month<\/span>/.test(page));
  const stop = renderEmployerQueue({ submissions: [sub({ company: blocked })], watchlist: cfg.watchlist });
  ok('a blocklisted employer cannot be approved from the page', /data-act="approve" data-id="abc123" disabled/.test(stop));
  const evil = renderEmployerQueue({ submissions: [sub({ company: '<script>alert(1)</script>', link: 'javascript:alert(1)', notes: '<img src=x onerror=alert(1)>' })], watchlist: cfg.watchlist });
  ok('what an employer typed is escaped', !/<script>alert/.test(evil) && !/<img src=x/.test(evil));
  ok('a link that is not http(s) never becomes an href', !/href="javascript:/i.test(evil));
  const empty = renderEmployerQueue({ submissions: [], watchlist: cfg.watchlist });
  ok('an empty queue says so plainly', /Nothing waiting/.test(empty) && /No employer has sent a role/.test(empty));
  const pitched = renderEmployerQueue({ submissions: [], watchlist: cfg.watchlist, pitch: { applyPerDayText: '2,000+', applyWeekText: '15,000+', liveRoles: 1407 } });
  ok('the numbers to quote are on the page', /<b>2,000\+<\/b><span>Apply clicks a day<\/span>/.test(pitched) && /<b>15,000\+<\/b>/.test(pitched) && /<b>1,407<\/b><span>Live roles/.test(pitched));
  const visible = pitched.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '').replace(/"[^"]*"/g, '');
  ok('and reminds him never to say applicants', /never "applicants"/.test(pitched) || /never/.test(visible));
  ok('with a note to send an employer, from the same figures', /A note to send an employer/.test(pitched) && /Candidates pressed Apply 15,000\+ times on our listings in the last 7 days, across 1,407 live roles\./.test(pitched));
  ok('the note never says applicants and carries no em dash', !/applicant/i.test(outreachNote({ applyWeekText: '1+', liveRoles: 2 })) && !/[\u2013\u2014]/.test(outreachNote({ applyWeekText: '1+', liveRoles: 2 })));
  ok('no figures, no note', outreachNote(null) === null && !/A note to send/.test(renderEmployerQueue({ watchlist: cfg.watchlist })));
  ok('the page carries no em dash', !/—/.test(page.replace(/<script>[\s\S]*?<\/script>/, '')));
  ok('decisions go to the helper\'s own endpoint, as JSON', /fetch\('\/api\/employers\/decide', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/.test(page));
}

console.log('\n== organized ==');
{
  const NOW = Date.parse('2026-10-17T10:00:00Z');
  const subs = [
    sub({ id: 'a1', at: '2026-10-12T03:12:00Z', company: 'Nestack Technologies Pvt Ltd', website: 'https://nestack.com/' }),
    sub({ id: 'a2', at: '2026-10-12T03:12:20Z', company: 'Nestack Technologies', website: 'https://www.nestack.com' }),
    sub({ id: 'b1', at: '2026-10-13T07:31:00Z', company: 'Multispace ai', website: 'https://www.multispaceai.com/' }),
  ];
  const g = groupSubmissions(subs);
  ok('one employer sending two roles is one group', g.length === 2 && g.find((x) => x.items.length === 2)?.items.map((e) => e.id).join() === 'a2,a1');
  ok('the newest employer comes first', g[0].items[0].id === 'b1');
  const { html, counts } = renderEmployerList({ submissions: subs, decisions: { a1: { status: 'approved', role: 'stored' } }, watchlist: cfg.watchlist, now: NOW });
  ok('counts each status', counts.waiting === 2 && counts.approved === 1 && counts.rejected === 0 && counts.all === 3);
  ok('a group knows which statuses it holds', /<section class="grp" data-statuses="waiting approved">/.test(html));
  ok('a waiting card says how long it has waited', /Waiting 5 days ago/.test(html));
  ok('an approved role says what happens next', /Role stored\. It goes live with the next scan&#39;s publish\./.test(html));
  ok('a role that was not stored says what to do', /npm run add-url/.test(renderEmployerList({ submissions: [subs[2]], decisions: { b1: { status: 'approved', role: 'failed' } }, watchlist: cfg.watchlist }).html));
  ok('cards are searchable by company, email and link', /data-find="[^"]*multispace ai[^"]*info@|data-find="[^"]*contact@nestack\.com[^"]*neilp\.nestack\.ai/.test(html));
  ok('ago reads like a person', ago('2026-10-17T09:59:30Z', NOW) === 'just now' && ago('2026-10-17T09:20:00Z', NOW) === '40 min ago' && ago('2026-10-17T04:00:00Z', NOW) === '6 h ago' && ago('2026-10-16T08:00:00Z', NOW) === '1 day ago');
  const blockedPage = renderEmployerQueue({ submissions: [sub({ company: blocked })], watchlist: cfg.watchlist });
  ok('a blocklisted Approve is marked so the refresh does not read it as busy', /disabled data-stop>Approve/.test(blockedPage) && /button\[disabled\]:not\(\[data-stop\]\)/.test(blockedPage));
  const page = renderEmployerQueue({ submissions: subs, watchlist: cfg.watchlist });
  ok('it refreshes its own list every minute', /setInterval\(refresh, 60000\)/.test(page) && /fetch\('\/employers\?fragment=1'/.test(page));
  ok('but never over a reason being typed or a decision on its way', /function busy\(\)/.test(page) && /if \(!force && busy\(\)\) return;/.test(page));
  ok('and again when the tab comes back', /visibilitychange[\s\S]{0,60}refresh\(\)/.test(page));
  ok('the tab is kept in the address', /history\.replaceState\(null, '', '#' \+ state\.tab\)/.test(page));
  const qs = read('bin/queue-server.js');
  ok('the helper answers the refresh with the list alone', /searchParams\.get\('fragment'\) === '1'/.test(qs) && /renderEmployerList\(\{ submissions, decisions, watchlist: loadConfig\(\)\.watchlist, live:/.test(qs));
}

console.log('\n== telling the employer ==');
{
  const live = { title: 'Robotics Prototyping Intern', page: 'https://interndoor.com/jobs/nestack-robotics-prototyping-intern-123', firstSeenAt: Date.parse('2026-10-17T10:00:00Z'), clicks: 142 };
  const e = sub({ id: 'r1', company: 'Nestack Technologies Pvt Ltd' });
  const a = employerEmail('live', e, live);
  ok('the live email names the role and links its page', a.subject === 'Your role is live on InternDoor' && /Your internship "Robotics Prototyping Intern" is live here:\nhttps:\/\/interndoor\.com\/jobs\/nestack-robotics-prototyping-intern-123/.test(a.body));
  ok('greets the company and promises the results', /^Hi Nestack Technologies Pvt Ltd team,/.test(a.body) && /after its first week/.test(a.body));
  const r = employerEmail('results', e, live);
  ok('the results email carries the role\'s own Apply clicks', r.subject === '142 Apply clicks on your InternDoor listing' && /pressed Apply 142 times since it went live on 17 Oct/.test(r.body));
  ok('one click is singular', employerEmail('results', e, { ...live, clicks: 1 }).subject === '1 Apply click on your InternDoor listing');
  ok('neither says applicants or carries an em dash', ![a.body, a.subject, r.body, r.subject].some((t) => /applicant/i.test(t) || /[\u2013\u2014]/.test(t)));
  ok('an entry-level role is called one', /Your entry-level role "/.test(employerEmail('live', sub({ kind: 'fulltime' }), live).body));
  const decided = { r1: { status: 'approved', role: 'stored', jobId: '123' } };
  const html = renderEmployerList({ submissions: [e], decisions: decided, watchlist: cfg.watchlist, live: { r1: live } }).html;
  ok('an approved live role shows its page and clicks', /Live on the board: <a href="https:\/\/interndoor\.com\/jobs\/nestack-robotics-prototyping-intern-123"/.test(html) && /142 Apply clicks so far\./.test(html));
  ok('with a ready email to their address', /<a class="alt mail" href="mailto:contact@nestack\.com\?subject=Your%20role%20is%20live%20on%20InternDoor&amp;body=Hi%20Nestack/.test(html));
  ok('and a results email once there are clicks', /Email them: the results/.test(html));
  ok('each with a Copy button carrying the text', /data-copy="Your role is live on InternDoor/.test(html));
  const noClicks = renderEmployerList({ submissions: [e], decisions: decided, watchlist: cfg.watchlist, live: { r1: { ...live, clicks: 0 } } }).html;
  ok('no results email before there is a result', /Email them: it's live/.test(noClicks) && !/Email them: the results/.test(noClicks));
  const notLive = renderEmployerList({ submissions: [e], decisions: decided, watchlist: cfg.watchlist, live: {} }).html;
  ok('a role not on the board yet gets no email, only what happens next', !/mailto:/.test(notLive) && /goes live with the next scan/.test(notLive));
  const badMail = renderEmployerList({ submissions: [sub({ id: 'r1', email: 'not an email' })], decisions: decided, watchlist: cfg.watchlist, live: { r1: live } }).html;
  ok('no mailto for an address that is not one', !/mailto:/.test(badMail));
  ok('a waiting submission never offers these', !/mailto:/.test(renderEmployerList({ submissions: [e], decisions: {}, watchlist: cfg.watchlist, live: { r1: live } }).html));
  const qs = read('bin/queue-server.js');
  ok('the helper works out what each approval became', /async function liveForSubmissions\(submissions, decisions\)/.test(qs) && (qs.match(/live: await liveForSubmissions\(submissions, decisions\)/g) ?? []).length === 2);
  ok('matched by the stored job id, else the link they sent', /d\.jobId && String\(x\.id\) === String\(d\.jobId\)\) \|\| \(e\.link && \(x\.applyUrl === e\.link \|\| x\.url === e\.link\)\)/.test(qs));
  ok('nothing on the page sends mail itself', !/sendmail|nodemailer|smtp|\/api\/send/i.test(read('src/employerqueue.js')));
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
