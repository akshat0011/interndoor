/**
 * /post-a-job — employers asking for a role to go on the board (9 Oct 2026).
 *
 * Four pieces, each pinned here:
 *   - web/api/post-job.js, IMPORTED and CALLED (the /api/apply lesson: a grep
 *     cannot tell you what an endpoint does), every refusal pinned both ways;
 *   - the page, which must never claim a role "goes live" — it is reviewed;
 *   - the per-job Apply count (web/api/count.js + engage.js + app.js), the
 *     number an employer is told, and src/jobclicks.js which folds it;
 *   - approval (src/employerjobs.js), driven with a fake store.
 */
import { readFileSync } from 'node:fs';
import {
  parseJobSubmission, cleanUrl, siteHost, sameOrg, rateLimited, save, newId,
  LIST_KEY, KEEP, FREE_MAIL,
} from '../web/api/post-job.js';
import { parseEvent, commandsFor, jobKeyFor, keyFor, JOB_SLUG } from '../web/api/count.js';
import { renderPostJobPage, POST_JOB_VERSION } from '../src/pages.js';
import { publishedPaths } from '../src/publish.js';
import { hashPairs, foldJobClicks } from '../src/jobclicks.js';
import { linkedinJobId, payText, addToWatchlist, approveSubmission, GROUP } from '../src/employerjobs.js';
import { normaliseCompany } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const GOOD = {
  company: 'Razorpay', website: 'https://razorpay.com', email: 'hiring@razorpay.com',
  link: 'https://jobs.lever.co/razorpay/abc', kind: 'intern', pay: '25,000', period: 'month', notes: '',
};
const err = (over) => parseJobSubmission({ ...GOOD, ...over }).error ?? null;

console.log('\n== WHAT A SUBMISSION MUST BE ==');
{
  const ok = parseJobSubmission(GOOD);
  check('a real submission is accepted', ok.accepted, true);
  check('…with the pay as a number', ok.entry.pay, 25000);
  check('…and an empty note stored as nothing', ok.entry.notes, null);
  check('a JSON string body parses too', parseJobSubmission(JSON.stringify(GOOD)).accepted, true);
  check('junk is a readable error', typeof parseJobSubmission('nope').error, 'string');
  check('an oversized body is refused', typeof parseJobSubmission('x'.repeat(9000)).error, 'string');
  check('the honeypot is a silent success', parseJobSubmission({ ...GOOD, fax: 'x' }), { accepted: false });
  check('…and company is a real field here, not the honeypot', parseJobSubmission({ ...GOOD, company: 'Razorpay' }).accepted, true);

  check('no company is refused', typeof err({ company: '' }), 'string');
  check('no website is refused', typeof err({ website: '' }), 'string');
  check('a website with no scheme is fine', parseJobSubmission({ ...GOOD, website: 'razorpay.com' }).accepted, true);

  check('a personal mailbox is refused', /work email/.test(err({ email: 'founder@gmail.com' }) ?? ''), true);
  check('every listed free host is refused', [...FREE_MAIL].every((d) => err({ email: `a@${d}`, website: `https://${d}` }) != null), true);
  check('an address at another domain is refused', /razorpay\.com/.test(err({ email: 'a@other.com' }) ?? ''), true);
  check('a subdomain address is the same company', err({ email: 'a@in.razorpay.com' }), null);
  check('…and so is a careers-subdomain website', err({ website: 'https://careers.razorpay.com' }), null);
  check('a lookalike domain is not', typeof err({ email: 'a@razorpay.com.evil.example' }), 'string');
  check('www on the site does not matter', err({ website: 'https://www.razorpay.com' }), null);

  check('no link is refused', typeof err({ link: '' }), 'string');
  check('a shortened link is refused', /full link/.test(err({ link: 'https://bit.ly/x' }) ?? ''), true);
  check('a LinkedIn posting is a fine link', err({ link: 'https://www.linkedin.com/jobs/view/4477143329/' }), null);

  check('a kind that is neither is refused', typeof err({ kind: 'contract' }), 'string');
  check('an entry-level job is a kind', err({ kind: 'fulltime' }), null);
  check('a period that is neither is refused', typeof err({ period: 'hour' }), 'string');
  check('per year is fine', err({ period: 'year', pay: '600000' }), null);
  check('unpaid is refused, and says why', /paid roles only/.test(err({ pay: '0' }) ?? ''), true);
  check('a blank pay is refused the same way', /paid roles only/.test(err({ pay: '' }) ?? ''), true);
  check('a fraction is refused', typeof err({ pay: '2500.5' }), 'string');
  check('an absurd monthly figure is refused, naming the period', /per month or per year/.test(err({ pay: '2000000' }) ?? ''), true);
  check('…the same figure per year is not', err({ pay: '2000000', period: 'year' }), null);
  check('a rupee sign and spaces are read', parseJobSubmission({ ...GOOD, pay: '₹ 15 000' }).entry?.pay, 15000);
  check('a long note is refused', typeof err({ notes: 'x'.repeat(1001) }), 'string');
  check('a note keeps its paragraphs', parseJobSubmission({ ...GOOD, notes: 'one\n\ntwo' }).entry.notes, 'one\n\ntwo');
}

console.log('\n== A PUBLIC ADDRESS, OR NOTHING ==');
check('http is upgraded', cleanUrl('http://razorpay.com/careers'), 'https://razorpay.com/careers');
check('a bare host gets https', cleanUrl('razorpay.com'), 'https://razorpay.com/');
check('an IP address is refused', cleanUrl('https://10.0.0.1/x'), null);
check('localhost is refused', cleanUrl('http://localhost:3000'), null);
check('credentials in a URL are refused', cleanUrl('https://a:b@razorpay.com'), null);
check('a single-label host is refused', cleanUrl('https://intranet/jobs'), null);
check('a non-web scheme is refused', cleanUrl('javascript:alert(1)'), null);
check('…including one with a real host', cleanUrl('ftp://razorpay.com/jobs'), null);
check('an IPv6 literal is refused', cleanUrl('https://[::1]/x'), null);
check('the host drops www', siteHost('https://www.Razorpay.com/x'), 'razorpay.com');
check('sameOrg is symmetric on subdomains', sameOrg('razorpay.com', 'careers.razorpay.com') && sameOrg('in.razorpay.com', 'razorpay.com'), true);
check('sameOrg refuses a suffix that is not a subdomain', sameOrg('notrazorpay.com', 'razorpay.com'), false);
check('ids are six characters with no lookalikes', /^[a-hj-km-np-z2-9]{6}$/.test(newId()), true);

console.log('\n== THE ENDPOINT, CALLED ==');
{
  const mod = await import('../web/api/post-job.js');
  const res = () => { const r = { code: null, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; r.setHeader = () => {}; return r; };
  const call = (req) => { const r = res(); return mod.default(req, r).then(() => r, (e) => ({ threw: String(e) })); };
  const env = { ...process.env };
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { await new Promise((r) => setTimeout(r, 10)); calls.push({ url, body: opts?.body }); return { ok: true }; };
  try {
    check('GET is refused', (await call({ method: 'GET', headers: {} })).code, 405);
    check('OPTIONS is a 204', (await call({ method: 'OPTIONS', headers: {} })).code, 204);
    check('a bad submission is a 400 with the reason', (await call({ method: 'POST', headers: {}, body: { ...GOOD, email: 'a@gmail.com' } })).code, 400);
    let r = await call({ method: 'POST', headers: { 'x-forwarded-for': '1.1.1.1' }, body: { ...GOOD, fax: 'bot' } });
    check('the honeypot is a 200 and stores nothing', [r.code, r.body?.ok, calls.length], [200, true, 0]);
    r = await call({ method: 'POST', headers: { 'x-forwarded-for': '1.1.1.2' }, body: GOOD });
    check('with no store it refuses honestly and names the address', [r.code, /akshat@interndoor\.com/.test(r.body?.error ?? ''), calls.length], [503, true, 0]);

    process.env.KV_REST_API_URL = 'https://example.upstash.io/';
    process.env.KV_REST_API_TOKEN = 'tok';
    r = await call({ method: 'POST', headers: { 'x-forwarded-for': '1.1.1.3' }, body: GOOD });
    const sent = calls[0] && JSON.parse(calls[0].body);
    const stored = sent && JSON.parse(sent[0][2]);
    check('a good submission is stored and answered 200', [r.code, r.body?.ok], [200, true]);
    check('…in one pipeline: push then trim', [calls[0]?.url, sent?.[0]?.[0], sent?.[0]?.[1], sent?.[1]], ['https://example.upstash.io/pipeline', 'LPUSH', LIST_KEY, ['LTRIM', LIST_KEY, 0, KEEP - 1]]);
    check('…with an id, a time and the fields', [typeof stored?.id, typeof stored?.at, stored?.company, stored?.pay], ['string', 'string', 'Razorpay', 25000]);

    let limited = false;
    for (let i = 0; i < 6; i++) limited = (await call({ method: 'POST', headers: { 'x-forwarded-for': '7.7.7.7' }, body: GOOD })).code === 429;
    check('the sixth in a minute from one address is a 429', limited, true);

    globalThis.fetch = async () => { throw new Error('down'); };
    r = await call({ method: 'POST', headers: { 'x-forwarded-for': '1.1.1.4' }, body: GOOD });
    check('a dead store is a 502 inviting a retry', r.code, 502);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (env[k] == null) delete process.env[k]; else process.env[k] = env[k];
    }
  }
  const store = new Map();
  let hit = false;
  for (let i = 0; i < 6; i++) hit = rateLimited('9.9.9.9', 1000 + i, store);
  check('rateLimited: five a minute, the sixth refused', hit, true);
  check('save never throws on a dead transport', await save({}, { url: 'x', token: 't' }, async () => { throw new Error('x'); }), false);

  /* No console line may carry anything the sender typed. Strings are emptied
     first, so prose inside a message cannot read as a leak (§5). */
  const code = read('web/api/post-job.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g, "''");
  const logs = code.match(/console\.\w+\([^)]*\)/g) ?? [];
  check('the endpoint logs one fixed line and nothing personal', logs, ["console.error('')"]);
  check('the local server knows the route', /'\/api\/post-job': '\.\/api\/post-job\.js'/.test(read('web/serve.js')), true);
}

console.log('\n== THE PAGE ==');
{
  const html = renderPostJobPage();
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  check('the form ships hidden, with no action', /<form class="pj-form" id="pj-form" hidden novalidate>/.test(html), true);
  check('a reader with no script is given the address', /id="pj-noscript"[^>]*>[^<]*<a href="mailto:akshat@interndoor\.com/.test(html), true);
  check('every field the endpoint reads is there', ['company', 'website', 'email', 'link', 'kind', 'pay', 'period', 'notes', 'fax'].every((n) => form.includes(`name="${n}"`)), true);
  check('the honeypot is fax, not company', /class="sub-hp"[^>]*><label>Fax<input type="text" name="fax"/.test(form), true);
  check('its script is loaded, from our own origin', html.includes('<script defer src="/post-job.js"></script>'), true);
  check('no inline script beyond the page’s own', (html.match(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)/g) ?? []).length <= 1, true);
  check('no style attribute (the CSP refuses them)', /\sstyle="/.test(html), false);
  check('its stylesheet is versioned', html.includes(`href="/page.css?v=${POST_JOB_VERSION}"`), true);
  check('it is indexable', /noindex/.test(html), false);
  check('its canonical is itself', html.includes('<link rel="canonical" href="https://interndoor.com/post-a-job">'), true);
  check('no JobPosting markup — nothing here is a vacancy', /JobPosting/.test(html), false);
  check('it says the role is checked by hand', /checked by hand/.test(html), true);
  check('it never promises a role goes live on submit', /goes live (?:immediately|instantly|right away)/i.test(html), false);
  check('it says unpaid roles are turned down', /Paid roles only/.test(html), true);
  check('the done panel exists and starts hidden', /<div class="pj-done" id="pj-done" tabindex="-1" hidden>/.test(html), true);

  const pub = publishedPaths();
  check('the page is in the publish allowlist', pub.includes('web/public/post-a-job.html'), true);
  check('…and its script is NOT (hand-committed)', pub.some((p) => /post-job\.js$/.test(p)), false);
  const pages = read('src/pages.js');
  check('the root render writes it', /join\(root, 'post-a-job\.html'\), renderPostJobPage\(/.test(pages), true);
  check('the root sitemap lists it', /region\.slug \? \[\] : \[\{ loc: `\$\{SITE\}\/post-a-job`/.test(pages), true);
  check('every generated footer links it', pages.includes('<a href="/post-a-job">Post a job</a>'), true);
  check('the header menu links it', pages.includes('<a class="bar-menu-item" href="/post-a-job">Post a job</a>'), true);
  const board = read('web/public/index.html');
  check('the board’s menu links it', board.includes('<a class="bar-menu-item" href="/post-a-job">Post a job</a>'), true);
  check('the board’s footer links it', board.includes('href="/post-a-job"'), true);

  const client = read('web/public/post-job.js');
  check('the client reveals the form', /form\.hidden = false;/.test(client), true);
  check('…posts to the endpoint', /fetch\('\/api\/post-job'/.test(client), true);
  check('…and shows the server’s own words', /say\(body\.error \|\|/.test(client), true);
}

console.log('\n== APPLY CLICKS PER JOB ==');
{
  const slug = 'salesforce-ad-software-engineering-amts-4477143329';
  check('an Apply may name its job', parseEvent({ name: 'apply', region: 'IN', job: slug })?.job, slug);
  check('…as a beacon string too', parseEvent(JSON.stringify({ name: 'apply', region: 'IN', job: slug }))?.job, slug);
  check('a job on any other event is dropped', parseEvent({ name: 'visit-new', region: 'IN', job: slug })?.job, undefined);
  check('a job not shaped like a slug is dropped', ['../x', 'A-B', 'a b', '-a', 'a-', '', 'x'.repeat(201)].map((j) => parseEvent({ name: 'apply', region: 'IN', job: j })?.job), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  check('JOB_SLUG takes a one-character slug', JOB_SLUG.test('a'), true);
  const long = `${'a'.repeat(170)}-4477143329`;
  check('the longest real slug survives as a beacon string', parseEvent(JSON.stringify({ name: 'apply', region: 'IN', job: long }))?.job, long);
  const plain = commandsFor('2026-10-09', { name: 'apply', region: 'IN' });
  check('without a job it is the board count alone', plain, [['INCR', keyFor('2026-10-09', 'apply', 'IN')], ['EXPIRE', keyFor('2026-10-09', 'apply', 'IN'), 8640000]]);
  const withJob = commandsFor('2026-10-09', { name: 'apply', region: 'IN', job: slug });
  check('with one it also bumps the job in the day hash, with an expiry', withJob.slice(2), [['HINCRBY', jobKeyFor('2026-10-09'), slug, 1], ['EXPIRE', 'applyjobs:2026-10-09', 8640000]]);
  check('the handler sends what commandsFor says', /await send\(commandsFor\(utcDay\(\), event\), target\);/.test(read('web/api/count.js')), true);

  const engage = read('web/public/engage.js');
  const m = engage.match(/function jobFromPath\(path\) \{[\s\S]*?\n  \}/);
  // eslint-disable-next-line no-new-func
  const jobFromPath = m ? new Function(`${m[0]}; return jobFromPath;`)() : () => 'MISSING';
  check('a job page names itself', jobFromPath('/jobs/red-hat-software-engineering-intern-4476569701'), 'red-hat-software-engineering-intern-4476569701');
  check('any other page names nothing', ['/', '/companies/x', '/jobs/', '/jobs/a/b', '/us/jobs/x'].map(jobFromPath), ['', '', '', '', '']);
  check('the counter sends the job with the event', /if \(typeof job === 'string' && job\) ev\.job = job;/.test(engage), true);
  check('an Apply with no job named reads it off the page', /count\('apply', typeof job === 'string' && job \? job : jobFromPath\(location\.pathname\)\);/.test(engage), true);
  const app = read('web/public/app.js');
  check('the card’s Apply names its job', app.includes("window.IDEngage?.onApply(jobPageSlug(job)); });"), true);
  check('the pane’s Apply names its job', app.includes("apply.addEventListener('click', () => window.IDEngage?.onApply(jobPageSlug(job)));"), true);
}

console.log('\n== FOLDING THE DAYS ==');
{
  check('an HGETALL answer becomes a map, junk dropped', [...hashPairs(['a', '3', 'b', 'x', 'c', '0', 'd'])], [['a', 3]]);
  const days = [new Map([['x-1', 2], ['y-2', 5]]), new Map([['x-1', 4], ['gone-3', 1]])];
  const bySlug = new Map([['x-1', { company: 'Acme', title: 'Intern' }], ['y-2', { company: 'Acme', title: 'SDE' }]]);
  const out = foldJobClicks(days, bySlug);
  check('clicks add up across days, busiest first', out.jobs.map((j) => [j.slug, j.clicks]), [['x-1', 6], ['y-2', 5], ['gone-3', 1]]);
  check('a slug the board no longer has is kept, unnamed', out.jobs[2].company, null);
  check('employers sum their roles', out.companies, [{ company: 'Acme', clicks: 11, roles: 2 }]);
  check('the total counts every click', out.total, 12);
}

console.log('\n== APPROVAL ==');
{
  check('a LinkedIn view link gives its id', linkedinJobId('https://www.linkedin.com/jobs/view/4477143329/'), '4477143329');
  check('…a slugged one too', linkedinJobId('https://in.linkedin.com/jobs/view/software-intern-at-acme-4477143329?trk=x'), '4477143329');
  check('…and a search link with currentJobId', linkedinJobId('https://www.linkedin.com/jobs/search/?currentJobId=4477143329'), '4477143329');
  check('another host is not LinkedIn', linkedinJobId('https://linkedin.com.evil.example/jobs/view/4477143329/'), null);
  check('pay reads like the store’s other rows', payText(25000, 'month'), '₹25,000/month');

  const term = (n) => ({ display: n, term: normaliseCompany(n) });
  const file = { 'global-tech': ['Google'] };
  check('a new employer is added to its own group', [addToWatchlist(file, 'Acme Robotics', [term('Google')]), file[GROUP]], [true, ['Acme Robotics']]);
  check('one already matched is left alone', [addToWatchlist(file, 'Google', [term('Google')]), file[GROUP].length], [false, 1]);

  const fakeStore = () => {
    const s = { ats: new Map(), jobs: new Map(), updates: [] };
    s.getAts = (c) => s.ats.get(c) ?? null;
    s.saveAts = (c, provider, token) => s.ats.set(c, { provider, token });
    s.hasJob = (id) => s.jobs.has(id);
    s.upsertJob = (j) => { s.jobs.set(j.jobId, j); return true; };
    s.db = { prepare: () => ({ run: (...args) => s.updates.push(args) }) };
    return s;
  };
  const cfg = { watchlist: [term('Google')] };
  const entry = { id: 'abc123', company: 'Acme Robotics', website: 'https://acme.ai', email: 'a@acme.ai', kind: 'intern', pay: 20000, period: 'month' };

  let s = fakeStore();
  let r = await approveSubmission({ ...entry, link: 'https://www.linkedin.com/jobs/view/4477143329/' }, {
    store: s, cfg, companiesFile: {}, ingest: async () => { throw new Error('must not ingest a LinkedIn link'); },
    fetchPosting: async (id) => ({ detail: { title: 'Robotics Intern', location: 'Bengaluru, Karnataka, India', description: 'Build robots with ROS and Python.', postedText: '2 days ago', logoUrl: '' } }),
    now: Date.UTC(2026, 9, 9),
  });
  const row = s.jobs.get('4477143329');
  check('a LinkedIn link is stored from its public page', r.role, { status: 'stored', jobId: '4477143329', title: 'Robotics Intern' });
  check('…as an engineering row, filed under the new watchlist name', [row?.isTech, row?.companyMatched, row?.region], [true, 'Acme Robotics', 'IN']);
  check('…with the employer’s own pay', [row?.salaryText, row?.stipend], ['₹20,000/month', { min: 20000, max: 20000, currency: 'INR', period: 'month' }]);
  check('…its Apply on the LinkedIn posting', row?.applyUrl, 'https://www.linkedin.com/jobs/view/4477143329/');
  check('…and the employer added to the watchlist', r.watchlist, 'added');

  s = fakeStore();
  r = await approveSubmission({ ...entry, link: 'https://www.linkedin.com/jobs/view/4477143329/' }, {
    store: s, cfg, companiesFile: {}, ingest: async () => ({}), fetchPosting: async () => ({ gone: true }),
  });
  check('a closed LinkedIn posting stores nothing and says so', [r.role.status, /closed/.test(r.role.reason), s.jobs.size], ['error', true, 0]);

  s = fakeStore();
  s.jobs.set('4477143329', {});
  r = await approveSubmission({ ...entry, link: 'https://www.linkedin.com/jobs/view/4477143329/' }, {
    store: s, cfg, companiesFile: {}, ingest: async () => ({}), fetchPosting: async () => { throw new Error('must not fetch a held posting'); },
  }).catch((e) => ({ role: { status: 'threw', reason: String(e) } }));
  check('a LinkedIn posting already held is left alone', r.role, { status: 'exists', jobId: '4477143329' });

  s = fakeStore();
  r = await approveSubmission({ ...entry, company: 'Google India', link: 'https://www.linkedin.com/jobs/view/4477143330/' }, {
    store: s, cfg, companiesFile: {}, ingest: async () => ({}),
    fetchPosting: async () => ({ detail: { title: 'SWE Intern', location: 'Bengaluru, India', description: 'x', postedText: '1 day ago' } }),
  });
  check('an employer already listed is filed under the list’s own name', [r.watchlist, s.jobs.get('4477143330')?.companyMatched], ['already', 'Google']);

  s = fakeStore();
  let seen = null;
  r = await approveSubmission({ ...entry, kind: 'fulltime', link: 'https://jobs.lever.co/acme/123' }, {
    store: s, cfg, companiesFile: {}, fetchPosting: async () => { throw new Error('must not fetch'); },
    ingest: async (link, opts) => { seen = { link, opts }; return { status: 'stored', jobId: 'ats:lever:acme:123', title: 'SDE 1' }; },
  });
  check('a job-board link seeds the board', [r.board, s.ats.get('Acme Robotics')], ['lever/acme', { provider: 'lever', token: 'acme' }]);
  check('…and is ingested with force, as the employer', seen, { link: 'https://jobs.lever.co/acme/123', opts: { company: 'Acme Robotics', force: true, source: 'employer' } });
  check('…and the stored row gets the stated pay and kind', s.updates[0]?.slice(), ['₹20,000/month', 20000, 20000, 'month', 'fulltime', 'ats:lever:acme:123']);

  s = fakeStore();
  s.ats.set('Acme Robotics', { provider: 'greenhouse', token: 'acme' });
  r = await approveSubmission({ ...entry, link: 'https://jobs.lever.co/acme/123' }, {
    store: s, cfg, companiesFile: {}, fetchPosting: async () => ({}), ingest: async () => ({ status: 'exists', jobId: 'x' }),
  });
  check('a board already known is not overwritten', s.ats.get('Acme Robotics'), { provider: 'greenhouse', token: 'acme' });
  check('…and an existing row is not repriced', s.updates.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
