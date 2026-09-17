/**
 * THE RETURN-VISIT LAYER — 17 SEP 2026.
 *
 * "A person comes, sees internships, applies and leaves; someone who has been
 * following the site only checks the topmost jobs because they've already
 * seen the rest." Three pieces answer that, and each has a silent failure
 * this file pins:
 *
 *   1. "N new since your last visit" — app.js remembers a high-water mark in
 *      localStorage. Wrong and it dims a first-time visitor's whole board, or
 *      vanishes on the reload people do to check for new roles.
 *   2. The channel prompt after Apply — engage.js. Wrong and it nags every
 *      visit, or offers a US reader India's WhatsApp channel.
 *   3. The counter — web/api/count.js. Wrong and it stores something personal,
 *      or counts junk, or throws into a page that was only sending a beacon.
 *
 * Functions are lifted out of the shipped files by name, the way
 * boardrefresh.test.mjs does, so the code under test is the code that ships.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const app = read('web/public/app.js');
const page = read('web/public/page.js');
const engage = read('web/public/engage.js');
const css = read('web/public/styles.css');

/* Lifted out of the shipped file rather than restated. */
const lift = (src, from, until, name) => {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start);
  ok(`${name} was found`, start > 0 && end > start);
  return src.slice(start, end + until.length);
};

const H = 3_600_000, D = 24 * H;

console.log('\n== visitSince: what "since your last visit" means ==');
{
  const gap = lift(app, 'const VISIT_GAP_MS', ';', 'VISIT_GAP_MS');
  const visitSince = new Function(`${gap}; ${lift(app, 'function visitSince(', '\n}', 'visitSince')}; return visitSince;`)();
  const now = 1_000 * D;

  const first = visitSince(null, now, 500);
  ok('a first visit has nothing to be new relative to', first.since === null && first.returning === false);
  ok('and stores the board\'s newest listing as the mark', first.next.mark === 500 && first.next.prev === null && first.next.at === now);

  const back = visitSince(JSON.stringify({ mark: 500, at: now - 2 * D, prev: null }), now, 900);
  ok('a return after the gap is measured from the last visit\'s mark', back.since === 500 && back.returning === true);
  ok('and advances the mark, remembering the old one', back.next.mark === 900 && back.next.prev === 500);

  const reload = visitSince(JSON.stringify(back.next), now + 5 * 60_000, 950);
  ok('a reload inside the gap shows the SAME header the first load did', reload.since === 500 && reload.returning === true);
  ok('and keeps advancing the mark for rows that arrive meanwhile', reload.next.mark === 950 && reload.next.prev === 500);

  const firstReload = visitSince(JSON.stringify(first.next), now + 60_000, 500);
  ok('a reload of a FIRST visit is still a first visit', firstReload.since === null && firstReload.returning === false);

  const shrunk = visitSince(JSON.stringify({ mark: 900, at: now - 2 * D, prev: 100 }), now, 700);
  ok('a board that shrank never moves the mark backwards', shrunk.next.mark === 900);

  ok('a corrupt record is a first visit, not a crash', visitSince('{not json', now, 5).since === null);
  ok('an object is accepted as well as its JSON', visitSince({ mark: 1, at: now - 2 * D, prev: null }, now, 2).since === 1);

  const edge = visitSince(JSON.stringify({ mark: 500, at: now - 30 * 60_000, prev: 7 }), now, 900);
  ok('exactly the gap is still the same visit', edge.since === 7);
  const past = visitSince(JSON.stringify({ mark: 500, at: now - 30 * 60_000 - 1, prev: 7 }), now, 900);
  ok('one millisecond past it is a new one', past.since === 500);
}

console.log('\n== splitNewSince: new first, seen dimmed, first-timers untouched ==');
{
  const isNewSince = lift(app, 'function isNewSince(', '\n}', 'isNewSince');
  const splitNewSince = new Function(`${isNewSince}; ${lift(app, 'function splitNewSince(', '\n}', 'splitNewSince')}; return splitNewSince;`)();
  const g = (id, seen) => [{ id, firstSeenAt: seen }];
  const groups = [g('a', 100), g('b', 50), g('c', 80), g('d', 20)];

  const nothing = splitNewSince(groups, null, 'newest');
  ok('a first visit: nothing new, NOTHING seen, order untouched',
    nothing.n === 0 && nothing.seen.length === 0 && nothing.ordered === groups);

  const s = splitNewSince(groups, 60, 'newest');
  ok('rows listed after the mark are new, in their own order', s.ordered.map((x) => x[0].id).join('') === 'acbd' && s.n === 2);
  ok('the rest are seen', s.seen.map((x) => x[0].id).join('') === 'bd');

  const m = splitNewSince(groups, 60, 'match');
  ok('another sort keeps its order and still reports the count', m.ordered === groups && m.n === 2 && m.seen.length === 2);

  const cities = [[{ id: 'x1', firstSeenAt: 10 }, { id: 'x2', firstSeenAt: 90 }]];
  ok('a role is new if ANY of its city copies is', splitNewSince(cities, 60).n === 1);
  ok('a row exactly at the mark is not new', splitNewSince([g('e', 60)], 60).n === 0);
}

console.log('\n== the board wires it in the right order ==');
{
  const init = lift(app, 'async function init()', '\ninit();', 'init');
  const iVisit = init.indexOf('visitSince(readVisit()');
  const iRender = init.indexOf('applyFilters();', iVisit);
  const iLoad = init.indexOf('loadEngage();');
  ok('the visit is decided before the first render', iVisit > 0 && iRender > iVisit);
  ok('and engage.js is loaded after it', iLoad > iRender);
  ok('an empty board never advances the mark', /if \(state\.jobs\.length\) \{[^}]*visitSince/.test(init));
  ok('the answer is left on <html> for the counter', /dataset\.visit = visit\.returning \? 'return' : 'new'/.test(init));

  const renderList = lift(app, 'function renderList()', '\n}', 'renderList');
  ok('the header is drawn only when something is new', /if \(split\.n > 0\) \{[\s\S]*'since-bar'/.test(renderList));
  ok('the count reaches <html> too', /dataset\.newsince = String\(split\.n\)/.test(renderList));
  ok('cards are told whether they were seen', /jobCard\(group\[0\], i, group, seen\.has\(group\)\)/.test(renderList));

  const jobCard = lift(app, 'function jobCard(', '\n}', 'jobCard');
  ok('a seen card carries the class', /if \(seen\) row\.classList\.add\('seen'\)/.test(jobCard));
  ok('the card\'s Apply tells the layer', /go\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); window\.IDEngage\?\.onApply\(\); \}\)/.test(jobCard));

  const detail = lift(app, 'function renderDetail(', '\n}', 'renderDetail');
  ok('so does the pane\'s', /apply\.addEventListener\('click', \(\) => window\.IDEngage\?\.onApply\(\)\)/.test(detail));

  ok('page.js loads the layer too', /s\.src = '\/engage\.js'/.test(page));
  ok('and delegates the job page\'s Apply buttons', /closest\('a\.btn-apply'\)[\s\S]*IDEngage\.onApply\(\)/.test(page));
}

console.log('\n== a seen card recedes, never through opacity (§15) ==');
{
  const seenRules = [...css.matchAll(/\.row\.seen[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  ok('.row.seen is styled', seenRules.length >= 1);
  ok('no opacity anywhere on it', seenRules.every((r) => !/opacity/.test(r)));
  ok('it recedes through the background', seenRules.some((r) => /background/.test(r)));
  ok('the header is styled', /\.since-bar\s*\{/.test(css));
  ok('and the prompt', /\.nudge\s*\{/.test(css) && /\.nudge:not\(\.is-up\)/.test(css));
}

console.log('\n== nudgeDue: once, then leave them alone ==');
{
  const again = lift(engage, 'var NUDGE_AGAIN_MS', ';', 'NUDGE_AGAIN_MS');
  const nudgeDue = new Function(`${again}; ${lift(engage, 'function nudgeDue(', '\n  }', 'nudgeDue')}; return nudgeDue;`)();
  const now = 1_000 * D;
  ok('nothing stored: due', nudgeDue(null, now) === true);
  ok('accepted: never again', nudgeDue(JSON.stringify({ at: now - 400 * D, outcome: 'accepted' }), now) === false);
  ok('dismissed 13 days ago: not yet', nudgeDue(JSON.stringify({ at: now - 13 * D, outcome: 'dismissed' }), now) === false);
  ok('dismissed 14 days ago: due again', nudgeDue(JSON.stringify({ at: now - 14 * D, outcome: 'dismissed' }), now) === true);
  ok('garbage: due', nudgeDue('{{', now) === true && nudgeDue('[]', now) === true);
  ok('a record with no usable time: due', nudgeDue(JSON.stringify({ outcome: 'dismissed' }), now) === true);
}

console.log('\n== channelsFromPage: this board\'s channels, never another\'s ==');
{
  const channelsFromPage = new Function(`${lift(engage, 'function channelsFromPage(', '\n  }', 'channelsFromPage')}; return channelsFromPage;`)();
  const board = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization',
    sameAs: ['https://whatsapp.com/channel/0029VbEJ2qLBA1eq3S5hBE3P', 'https://t.me/interndoor', 'https://www.instagram.com/interndoorin/'] }] });
  const c = channelsFromPage([board], '#signup');
  ok('WhatsApp, Telegram and email, in that order', c.map((x) => x.kind).join(',') === 'whatsapp,telegram,email');
  ok('Instagram is not an alert channel', !c.some((x) => /instagram/.test(x.url)));
  ok('the email option is the page\'s own', c[2].url === '#signup');

  const us = JSON.stringify({ '@type': 'Organization', sameAs: ['https://t.me/interndoorusa', 'https://www.instagram.com/interndoorusa/'] });
  const u = channelsFromPage([us], '/us/alerts');
  ok('a board with no WhatsApp offers none — never India\'s', u.map((x) => x.kind).join(',') === 'telegram,email' && u[0].url === 'https://t.me/interndoorusa');

  const j = channelsFromPage(['{"@type":"JobPosting","title":"x"}', 'not json'], '/uk/alerts');
  ok('a job page offers its own alerts link and nothing invented', j.length === 1 && j[0].kind === 'email' && j[0].url === '/uk/alerts');
  ok('a lookalike host is refused — the pattern is anchored at the origin, not searched for',
    channelsFromPage([JSON.stringify({ sameAs: [
      'https://t.me.evil.example/x', 'https://whatsapp.com.evil.example/channel/y',
      'https://evil.example/t.me/x', 'https://evil.example/whatsapp.com/channel/y',
      'http://t.me/interndoor',
    ] })], null).length === 0);
  ok('duplicates collapse', channelsFromPage([board, board], null).length === 2);
}

console.log('\n== the prompt is one click per event, and the events are the counter\'s ==');
{
  const show = lift(engage, 'function show()', '\n  }', 'show');
  ok('a channel click is remembered as accepted', /remember\('accepted'\)/.test(show));
  ok('and counted by channel', /count\('nudge-' \+ c\.kind\)/.test(show));
  ok('dismissal is remembered and counted', /remember\('dismissed'\)[\s\S]*count\('nudge-dismiss'\)/.test(show));
  const onApply = lift(engage, 'function onApply()', '\n  }', 'onApply');
  ok('every Apply is counted', /count\('apply'\)/.test(onApply));
  ok('at most once a session', /sessionStorage\.getItem\(SESSION_KEY\)/.test(onApply) && /if \(shownThisSession\) return/.test(onApply));
  ok('the beacon carries the name and the board and nothing else', /JSON\.stringify\(\{ name: String\(name\), region: region\(\) \}\)/.test(engage));
}

console.log('\n== /api/count keeps a number per day and nothing about anyone ==');
{
  const mod = await import('../web/api/count.js');
  const { parseEvent, keyFor, utcDay, rateLimited, EVENTS } = mod;
  ok('a beacon body (text/plain string) parses', JSON.stringify(parseEvent('{"name":"apply","region":"in"}')) === '{"name":"apply","region":"IN"}');
  ok('the local server\'s object body parses', parseEvent({ name: 'visit-return', region: 'US' })?.region === 'US');
  ok('an unknown name is nothing', parseEvent({ name: 'signup', region: 'IN' }) === null);
  ok('an unknown board is kept but filed under XX', parseEvent({ name: 'apply', region: 'zz' })?.region === 'XX');
  ok('a fat body is nothing', parseEvent('{"name":"apply","region":"IN","x":"' + 'y'.repeat(300) + '"}') === null);
  ok('junk is nothing', parseEvent('nope') === null && parseEvent(null) === null && parseEvent(42) === null);
  ok('the key is day-first', keyFor('2026-09-17', 'apply', 'IN') === 'count:2026-09-17:apply:IN');
  ok('the day is UTC', utcDay(Date.UTC(2026, 8, 17, 23, 59)) === '2026-09-17' && utcDay(Date.UTC(2026, 8, 18, 0, 0)) === '2026-09-18');
  const store = new Map();
  let limited = false;
  for (let i = 0; i < 61; i++) limited = rateLimited('1.2.3.4', 1000 + i, store);
  ok('the sixty-first hit in a minute is refused', limited === true);
  ok('another address is not', rateLimited('5.6.7.8', 1000, store) === false);
  ok('every event the client sends is in the vocabulary',
    ['visit-new', 'visit-return', 'newsince-shown', 'apply', 'nudge-shown', 'nudge-whatsapp', 'nudge-telegram', 'nudge-email', 'nudge-dismiss'].every((e) => EVENTS.has(e)));

  const src = read('web/api/count.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the endpoint logs nothing', !/console\./.test(src));
  ok('and stores nothing but the counter key', !/user-agent|referer|cookie/i.test(src));

  const res = () => { const r = { code: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.end = () => r; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
  /* A handler that THROWS must read as a failed check, not abort this file —
     an abort stops the whole npm test chain and reads as a pass (§1). */
  const call = (req, r) => mod.default(req, r).then(() => true, () => false);
  const env = { ...process.env };
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const realFetch = globalThis.fetch;
  const calls = [];
  /* Records AFTER a tick, so a handler that forgets to await the store call
     returns before the record exists — which is exactly what a frozen
     serverless instance would lose. */
  globalThis.fetch = async (url, opts) => { await new Promise((r) => setTimeout(r, 10)); calls.push({ url, body: opts?.body }); return { ok: true }; };
  try {
    let r = res();
    let lived = await call({ method: 'POST', headers: {}, body: '{"name":"apply","region":"IN"}' }, r);
    ok('with no store it answers 204 and calls nothing', lived && r.code === 204 && calls.length === 0);

    process.env.KV_REST_API_URL = 'https://example.upstash.io/';
    process.env.KV_REST_API_TOKEN = 'tok';
    r = res();
    lived = await call({ method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: '{"name":"apply","region":"IN"}' }, r);
    const sent = calls[0] && JSON.parse(calls[0].body);
    ok('with a store it increments today\'s key for that board',
      lived && r.code === 204 && calls.length === 1 && calls[0].url === 'https://example.upstash.io/pipeline'
      && sent[0][0] === 'INCR' && sent[0][1] === `count:${utcDay()}:apply:IN` && sent[1][0] === 'EXPIRE');
    r = res();
    lived = await call({ method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: '{"name":"bogus"}' }, r);
    ok('an unknown event is still 204 and touches nothing', lived && r.code === 204 && calls.length === 1);
    r = res();
    lived = await call({ method: 'GET', headers: {} }, r);
    ok('GET is refused', lived && r.code === 405);
    globalThis.fetch = async () => { throw new Error('down'); };
    r = res();
    lived = await call({ method: 'POST', headers: { 'x-forwarded-for': '8.8.8.8' }, body: '{"name":"apply","region":"IN"}' }, r);
    ok('a dead store never reaches the reader', lived && r.code === 204);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (env[k] == null) delete process.env[k]; else process.env[k] = env[k];
    }
  }
  ok('the local server knows the route', /'\/api\/count': '\.\/api\/count\.js'/.test(read('web/serve.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
