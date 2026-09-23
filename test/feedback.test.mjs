/**
 * /api/feedback — the reader's own words.
 *
 * WHY THIS FILE IS SHAPED LIKE THIS: /api/apply already learned that a SOURCE
 * GREP is the wrong test for an endpoint. Its first leak check searched the
 * file for a word and found it inside the honest-refusal MESSAGE, calling
 * prose a leak; and a newline guard that could never fire survived a grep
 * entirely, because reading the source cannot tell you what runs. So the
 * handler is IMPORTED and CALLED here with a stubbed fetch and a stub res.
 *
 * The one thing a grep is right for is the no-logging rule, and even that
 * strips string CONTENT first — literal prose is inert, an interpolated value
 * is not.
 */
import { readFileSync } from 'node:fs';
import { publishedPaths } from '../src/publish.js';
import {
  parseFeedback, cleanMessage, cleanPath, rateLimited, save, store,
  LIST_KEY, KEEP, MIN_MESSAGE, MAX_MESSAGE, REGIONS, STORE_TIMEOUT_MS,
} from '../web/api/feedback.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
/* An unexpected throw must fail ONE assertion, not abort the file. A bare call
   that throws takes every later check with it, and `npm test` is an && chain —
   so the whole suite stops and the output reads like a crash rather than a
   failure. The ig-token work learned this the hard way. */
function returns(fn) {
  try { return fn(); } catch (err) { return { threw: String(err && err.message) }; }
}

/* A stub response that records rather than writes. */
function stubRes() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.body = o; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
const REQ = (body, method = 'POST') => ({ method, body, headers: {}, socket: { remoteAddress: '203.0.113.9' } });

const ENV = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const SAVED = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function withStore(on) {
  for (const k of ENV) delete process.env[k];
  if (on) { process.env.KV_REST_API_URL = 'https://redis.example'; process.env.KV_REST_API_TOKEN = 'tok-secret'; }
}

console.log('\n== THE MESSAGE IS CLEANED, AND NEWLINES SURVIVE ==');
{
  /* Every other cleaner in this repo flattens newlines, because an address
     carrying one becomes extra mail headers. This is prose going into a JSON
     string — a newline is a paragraph break, and deleting it would mangle the
     one thing the reader actually wrote. */
  check('a paragraph break survives', cleanMessage('line one\n\nline two'), 'line one\n\nline two');
  check('CRLF is normalised', cleanMessage('a\r\nb'), 'a\nb');
  check('a lone CR is normalised', cleanMessage('a\rb'), 'a\nb');
  check('a run of blank lines is collapsed', cleanMessage('a\n\n\n\n\nb'), 'a\n\nb');
  check('control characters become spaces', cleanMessage('a\u0000\u0007b'), 'a  b');
  check('ends are trimmed', cleanMessage('   hi   '), 'hi');
  check('a non-string is empty', cleanMessage(null), '');
}

console.log('\n== THE PATH IS OURS, AND CARRIES NO QUERY ==');
{
  /* The board's own filter state lives in ?q=, so keeping a query would write
     whatever the reader typed into the store by the back door — the exact
     thing the site's rule about query strings exists to stop. */
  check('a query is dropped', cleanPath('/?q=my%20name'), '/');
  check('a hash is dropped', cleanPath('/jobs/x#apply'), '/jobs/x');
  check('a plain path survives', cleanPath('/us/jobs/abc'), '/us/jobs/abc');
  check('an absolute URL is refused', cleanPath('https://evil.example/x'), null);
  /* Protocol-relative: `//evil.example/x` is a URL, not a path, and it starts
     with a slash — so a bare startsWith('/') admits it. */
  check('a protocol-relative URL is refused', cleanPath('//evil.example/x'), null);
  check('a relative path is refused', cleanPath('jobs/x'), null);
  check('a control character is refused', cleanPath('/a\u0000b'), null);
  check('an over-long path is refused', cleanPath('/' + 'a'.repeat(400)), null);
  check('a non-string is null', cleanPath(undefined), null);
}

console.log('\n== THE GAUNTLET ==');
{
  const okBody = { message: 'The apply link on the Siemens page 404s.', region: 'IN' };
  check('a real message is accepted', parseFeedback(okBody).accepted, true);
  check('the message is carried through', parseFeedback(okBody).entry.message, okBody.message);
  check('no email means null, not empty string', parseFeedback(okBody).entry.email, null);
  check('a known region is kept', parseFeedback(okBody).entry.region, 'IN');
  check('an unknown region becomes XX', parseFeedback({ ...okBody, region: 'ZZ' }).entry.region, 'XX');
  check('a missing region becomes XX', parseFeedback({ message: okBody.message }).entry.region, 'XX');

  check('too short is refused', !!parseFeedback({ message: 'hi' }).error, true);
  check('empty is refused', !!parseFeedback({ message: '' }).error, true);
  check('whitespace only is refused', !!parseFeedback({ message: '        ' }).error, true);
  check('at the floor it is accepted', parseFeedback({ message: 'a'.repeat(MIN_MESSAGE) }).accepted, true);
  check('over the ceiling is refused', !!parseFeedback({ message: 'a'.repeat(MAX_MESSAGE + 1) }).error, true);
  check('at the ceiling it is accepted', parseFeedback({ message: 'a'.repeat(MAX_MESSAGE) }).accepted, true);

  /* A bad address is REFUSED, never dropped. Silently discarding it would
     promise the reader a reply that can never arrive. */
  check('a bad email is refused, not dropped', !!parseFeedback({ ...okBody, email: 'not-an-email' }).error, true);
  check('a newline in the email is refused', !!parseFeedback({ ...okBody, email: 'a@b.com\nBcc: x@y.com' }).error, true);
  check('a good email is kept', parseFeedback({ ...okBody, email: ' A@B.com ' }).entry.email, 'a@b.com');
  check('a blank email is not an error', parseFeedback({ ...okBody, email: '   ' }).accepted, true);
}

console.log('\n== THE HONEYPOT LOOKS EXACTLY LIKE SUCCESS ==');
{
  const bot = parseFeedback({ message: 'buy cheap things', company: 'Acme' });
  /* Never an error: an error tells the bot which field gave it away. */
  check('a filled honeypot is not an error', bot.error, undefined);
  check('a filled honeypot stores nothing', bot.accepted, false);
  check('an empty honeypot is fine', parseFeedback({ message: 'a real message', company: '' }).accepted, true);
  check('a whitespace honeypot is fine', parseFeedback({ message: 'a real message', company: '  ' }).accepted, true);
}

console.log('\n== BOTH BODY SHAPES, BECAUSE THE TWO SERVERS DIFFER ==');
{
  /* web/serve.js JSON-parses and hands over an object; Vercel can hand over the
     raw string. A test that only passes objects passes against a handler that
     breaks in production — the lesson /api/count's own tests carry. */
  check('a JSON string body parses', parseFeedback(JSON.stringify({ message: 'from a string body' })).accepted, true);
  check('a non-JSON string is refused', !!parseFeedback('not json at all').error, true);
  /* Refused on LENGTH before JSON.parse is ever reached.
     THE FIXTURE HAS TO BE VALID JSON WITH AN IN-BOUNDS MESSAGE, or it tests
     nothing: `'x'.repeat(9000)` is also unparseable, so it errors with OR
     without the length guard and the mutation that removes the guard survives.
     Mutation testing caught exactly that here. */
  const bulky = JSON.stringify({ message: 'a perfectly ordinary message', filler: 'x'.repeat(9000) });
  check('the oversized fixture is otherwise acceptable', parseFeedback(JSON.stringify({ message: 'a perfectly ordinary message' })).accepted, true);
  check('an oversized string body is refused on length', !!parseFeedback(bulky).error, true);
  check('null is refused', !!parseFeedback(null).error, true);
  check('a number is refused', !!parseFeedback(42).error, true);
}

console.log('\n== RATE LIMITING ==');
{
  const s = new Map();
  const at = 1_700_000_000_000;
  let blocked = 0;
  for (let i = 0; i < 10; i++) if (rateLimited('1.2.3.4', at, s)) blocked++;
  check('a burst is eventually blocked', blocked > 0, true);
  check('a different address is unaffected', rateLimited('5.6.7.8', at, s), false);
  check('the window rolls off', rateLimited('1.2.3.4', at + 61_000, s), false);
}

console.log('\n== THE WRITE: ONE PIPELINE, AND THE TOKEN NEVER LEAVES THE HEADER ==');
{
  let seen = null;
  const fake = async (url, opts) => { seen = { url, opts }; return { ok: true }; };
  const ok = await save({ message: 'm', email: null, region: 'IN', path: '/' },
    { url: 'https://redis.example', token: 'tok-secret' }, '2026-09-22T00:00:00.000Z', fake);
  check('a successful write reports true', ok, true);
  const cmds = JSON.parse(seen.opts.body);
  /* Two round trips would leave a window where the list is over KEEP, and a
     trim that fails on its own leaves it growing for ever with nothing
     reporting it. */
  check('the push and the trim are ONE pipeline', cmds.length, 2);
  check('it pushes to the head', cmds[0][0], 'LPUSH');
  check('it pushes to the right list', cmds[0][1], LIST_KEY);
  check('it trims in the same call', cmds[1][0], 'LTRIM');
  check('the trim keeps KEEP entries', cmds[1].slice(2), [0, KEEP - 1]);
  check('the timestamp is stored', JSON.parse(cmds[0][2]).at, '2026-09-22T00:00:00.000Z');
  /* A token in a URL is a token in every log on the way. */
  check('the token is not in the URL', seen.url.includes('tok-secret'), false);
  check('the token is not in the body', seen.opts.body.includes('tok-secret'), false);
  check('the token is in the header', seen.opts.headers.authorization, 'Bearer tok-secret');

  const bad = await save({ message: 'm' }, { url: 'x', token: 'y' }, 'now', async () => { throw new Error('down'); });
  check('a thrown fetch reports false, never throws', bad, false);
  const notOk = await save({ message: 'm' }, { url: 'x', token: 'y' }, 'now', async () => ({ ok: false }));
  check('a non-ok response reports false', notOk, false);
}

console.log('\n== THE HANDLER ==');
{
  const { default: handler } = await import('../web/api/feedback.js');

  withStore(false);
  {
    const res = stubRes();
    await handler(REQ({ message: 'a real message here' }), res);
    /* THE HONEST REFUSAL. Not 204, and not a cheerful 200: a person has just
       typed something and is watching for an answer. Telling them it sent when
       nothing was stored is the failure /api/subscribe's own comment calls
       worse than having no box at all. */
    check('with no store it refuses with 503', res.code, 503);
    check('with no store it says so plainly', res.body.ok, false);
    check('the refusal names somewhere else to write', /interndoor\.com/.test(res.body.error), true);
  }

  withStore(true);
  {
    const res = stubRes();
    await handler(REQ(null, 'GET'), res);
    check('GET is refused', res.code, 405);
  }
  {
    const res = stubRes();
    await handler(REQ(null, 'OPTIONS'), res);
    check('OPTIONS is 204', res.code, 204);
  }
  {
    const res = stubRes();
    await handler(REQ({ message: 'hi' }), res);
    check('a too-short message is 400', res.code, 400);
    check('a rejection carries a readable reason', typeof res.body.error, 'string');
  }
  {
    const res = stubRes();
    await handler(REQ({ message: 'spam spam spam', company: 'Acme' }), res);
    check('the honeypot answers a plain 200', res.code, 200);
    check('the honeypot answers ok', res.body.ok, true);
  }
  check('store() sees the environment', !!store(), true);

  {
    /* THE WRITE IS AWAITED. A serverless function may be frozen the moment it
       answers, so an un-awaited request is simply lost. The stub DELAYS before
       recording — with a synchronous one, the mutation that drops the `await`
       survives, which is exactly what /api/count's tests already learned. */
    const realFetch = globalThis.fetch;
    let recorded = false;
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 10));
      recorded = true;
      return { ok: true };
    };
    const res = stubRes();
    await handler(REQ({ message: 'a genuine piece of feedback', region: 'IN' }), res);
    globalThis.fetch = realFetch;
    check('the store write is awaited before answering', recorded, true);
    check('a stored message answers 200', res.code, 200);
    check('a stored message answers ok', res.body.ok, true);
  }
  {
    /* A real transport failure is a 502 the reader may retry — unlike the
       no-store 503 above, which no amount of retrying fixes. */
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    const res = stubRes();
    await handler(REQ({ message: 'another genuine piece of feedback', region: 'IN' }), res);
    globalThis.fetch = realFetch;
    check('a failed write is 502, not a false success', res.code, 502);
    check('a failed write never claims ok', res.body.ok, false);
  }

  withStore(false);
  check('store() is null with nothing set', store(), null);
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
}

console.log('\n== NOTHING PERSONAL IS EVER LOGGED ==');
{
  const src = readFileSync(new URL('../web/api/feedback.js', import.meta.url), 'utf8');
  /* Strip string CONTENT first. Literal prose is inert; an interpolated value
     is not. The first version of /api/apply's leak check called its own honest
     refusal message a leak for exactly this reason. */
  const code = src.replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  check('no console line interpolates the message', /console\.[a-z]+\([^)]*\bmessage\b/.test(code), false);
  check('no console line interpolates the email', /console\.[a-z]+\([^)]*\bemail\b/.test(code), false);
  check('no console line interpolates the entry', /console\.[a-z]+\([^)]*\bentry\b/.test(code), false);
  /* The check is capable of firing — an assertion that can never fail is not a
     test, and this file has eight of them above it that could hide behind a
     broken regex. */
  check('the leak check can actually fire',
    /console\.[a-z]+\([^)]*\bmessage\b/.test('console.error(`x ${message}`)'.replace(/`[^`]*`/g, '`` message')), true);
}

console.log('\n== THE CLIENT, AND THE ALLOWLIST ==');
{
  const client = readFileSync(new URL('../web/public/feedback.js', import.meta.url), 'utf8');
  /* Hand-committed, exactly like app.js, page.js, engage.js and subscribe.js.
     In the allowlist the scheduler would push half-finished edits every 30
     minutes; test/published.test.mjs pins the same inverse for its siblings. */
  check('feedback.js is NOT in the published allowlist',
    publishedPaths().some((p) => p.endsWith('feedback.js')), false);
  check('the API handler is not in the allowlist either',
    publishedPaths().some((p) => p.includes('api')), false);
  /* It reveals the form itself, so a reader without JavaScript never sees a box
     that cannot submit. Dropping this line ships a dead control. */
  check('the client reveals the form', /form\.hidden = false/.test(client), true);
  check('the client posts to its own endpoint', /'\/api\/feedback'/.test(client), true);
  /* location.pathname, never location.href: the board's filter state is in the
     query, and the endpoint dropping it is only the far half of the rule. */
  check('the client sends pathname, not the whole URL', /location\.pathname/.test(client), true);
  check('the client never sends location.href', /location\.href/.test(client), false);
  check('the client never sends location.search', /location\.search/.test(client), false);

  const serve = readFileSync(new URL('../web/serve.js', import.meta.url), 'utf8');
  /* A function missing from web/serve.js's hand-kept map 404s locally while
     working in production — the trap /careers already sprang. */
  check('web/serve.js routes /api/feedback', /'\/api\/feedback':/.test(serve), true);

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('npm run feedback exists to read it back', !!pkg.scripts.feedback, true);
  check('this test file is in the test chain', pkg.scripts.test.includes('test/feedback.test.mjs'), true);
}

console.log('\n== THE HOMEPAGE MARKUP ==');
{
  /* index.html is ONE template rendered for all three boards, so everything
     here lands on /, /us and /uk at once. It is also in the PUBLISHED
     allowlist, which is why the scheduler has to be stopped to edit it. */
  const home = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');

  check('the board carries the feedback form', /<form class="fb" hidden>/.test(home), true);
  /* SHIPS HIDDEN. Without the attribute a reader with no JavaScript sees a box
     whose button does nothing — the form has no action to fall back to. */
  check('the form ships hidden', /class="fb"[^>]*\shidden/.test(home), true);
  check('the client is loaded', /<script defer src="\/feedback\.js"><\/script>/.test(home), true);
  check('the honeypot is present and aria-hidden', /class="sub-hp" aria-hidden="true"/.test(home), true);
  check('the reply is a live region', /class="fb-msg" role="status" aria-live="polite"/.test(home), true);
  /* type=button, not submit: the form has no action, and a submit would be a
     navigation. feedback.js binds the click. */
  check('the send control is type=button', /class="fb-b" type="button"/.test(home), true);
  check('the textarea is labelled', /class="fb-t" aria-label="Your feedback"/.test(home), true);
  check('the email input is labelled', /class="fb-e"[^>]*aria-label=/.test(home), true);

  /* THE CAP IS WRITTEN IN TWO PLACES — the endpoint and the markup — and this
     is what stops them drifting. A maxlength above MAX_MESSAGE lets a reader
     type a message the server will then refuse, after they have written it. */
  const ml = home.match(/class="fb-t"[^>]*maxlength="(\d+)"/);
  check('the textarea declares a maxlength', !!ml, true);
  check('the maxlength equals MAX_MESSAGE', ml && Number(ml[1]), MAX_MESSAGE);

  /* THE ENTRY POINT IS IN THE MASTHEAD, NOT A BAND AT THE BOTTOM. His call,
     22 Sep 2026. ONE implementation: a button that opens the dialog, and no
     second copy of the form further down the page. */
  check('the masthead carries the feedback button', /class="ghost-btn fb-open"/.test(home), true);
  /* The button ships hidden for the same reason the form does — with no
     JavaScript it opens nothing, so it is not shown at all. */
  check('the button ships hidden', /class="ghost-btn fb-open"[^>]*\shidden/.test(home), true);
  check('it declares its expanded state', /class="ghost-btn fb-open"[^>]*aria-expanded="false"/.test(home), true);
  check('it is labelled for a screen reader', /class="ghost-btn fb-open"[^>]*aria-label="Send feedback"/.test(home), true);
  check('the old bottom band is gone', /feedback-band/.test(home), false);

  /* A real dialog, not a panel: modal, labelled by its own heading, and with a
     veil so the board behind it is not clickable. */
  check('the dialog is a dialog', /<aside class="fb-modal" role="dialog" aria-modal="true"/.test(home), true);
  check('it is labelled by its heading', /aria-labelledby="fb-title"/.test(home) && /class="fb-h" id="fb-title"/.test(home), true);
  check('the dialog ships hidden', /class="fb-modal"[^>]*\shidden/.test(home), true);
  check('there is a veil', /<div class="fb-veil" hidden><\/div>/.test(home), true);
  check('and a close control', /class="fb-x" type="button" aria-label="Close"/.test(home), true);

  /* .fb-msg deliberately shares .sub-msg's MEASURED colours rather than
     carrying a second copy of them. */
  const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
  check('the dialog is styled', /\.fb-modal \{/.test(css), true);
  check('the veil is styled', /\.fb-veil \{/.test(css), true);
  check('the masthead button is styled', /\.fb-open \{/.test(css), true);
  /* THE TWO HALVES OF THE MASTHEAD FIT, BOTH MEASURED IN A REAL BROWSER.

     (1) `.ghost-btn` is a 33x33 `display: grid` box written for the theme
     toggle's SINGLE icon, and grid flows in ROWS by default — so this button's
     icon and label were laid out stacked inside a box still 33px tall and the
     word rendered eight pixels below the button's own border. Its own
     getBoundingClientRect reads a sensible 87x33 throughout, which is why
     measuring the parent alone passed it twice.

     (2) The masthead was tuned for FOUR controls; feedback made it five and put
     every phone into horizontal scroll (390px overflowed by 45). The WhatsApp
     label collapses early enough to pay for it, and the breakpoint has to
     cover the phone range — 340, what it used to be, does not. */
  const fbOpenRule = css.slice(css.indexOf('.fb-open {'), css.indexOf('}', css.indexOf('.fb-open {')));
  check('the label sits BESIDE the icon, not under it', /grid-auto-flow:\s*column/.test(fbOpenRule), true);
  const alertsCollapse = css.match(/@media \(max-width: (\d+)px\) \{\s*\.alerts span \{ display: none; \}/);
  check('the WhatsApp label collapses on a phone', Number(alertsCollapse?.[1]) >= 430, true);
  /* The page must not scroll behind an open dialog. */
  check('the page is locked while it is open', /html\.fb-open-modal/.test(css), true);
  check('.fb-msg shares .sub-msg\'s rules', /\.sub-msg, \.fb-msg \{/.test(css), true);
  check('.fb-msg shares the light-theme correction', /\.fb-msg\[data-kind="good"\] \{ color: #065f46/.test(css), true);

  /* NO inline script and NO style attribute: production CSP is script-src
     'self' + hashes with no 'unsafe-inline', and no local preview sends the
     header, so a violation is invisible everywhere but the live site. */
  /* THE END ANCHOR MUST BE SEARCHED FROM THE START ANCHOR. index.html carries
     TWO `<footer class="foot">` — the board's own and one inside the crawlable
     listings block — and the first sits BEFORE this dialog, so a bare indexOf
     returned a backwards range and an EMPTY slice. The two checks below then
     passed against nothing, which is how the band they replaced was pinned for
     a day. The length guard is what caught it; keep it. */
  const dialogAt = home.indexOf('<div class="fb-veil"');
  const dialog = home.slice(dialogAt, home.indexOf('<footer class="foot">', dialogAt));
  check('the dialog block is non-empty', dialog.length > 400, true);
  check('and really contains the form', /<form class="fb"/.test(dialog), true);
  check('it carries no inline script', /<script/.test(dialog), false);
  check('it carries no style attribute', /\sstyle="/.test(dialog), false);
}

console.log('\n== THE CLIENT OPENS AND CLOSES IT ==');
{
  const client = readFileSync(new URL('../web/public/feedback.js', import.meta.url), 'utf8');
  check('the button is wired', /open\.addEventListener\('click', show\)/.test(client), true);
  check('the button is revealed', /open\.hidden = false/.test(client), true);
  /* THE BACKDROP DOES CLOSE IT, unlike engage.js's prompt — that one interrupts
     a reader who did not ask for it; this is a dialog the reader opened. */
  check('the veil closes it', /veil\.addEventListener\('click', hide\)/.test(client), true);
  check('Escape closes it', /e\.key === 'Escape'/.test(client), true);
  /* Without a trap the reader tabs straight out into the board behind, which a
     screen reader reads as the dialog having closed. */
  check('Tab is trapped inside', /e\.key !== 'Tab'/.test(client), true);
  check('focus returns where it came from', /lastFocus\.focus\(\)/.test(client), true);
  /* FOCUS LANDS IN THE TEXTAREA, NOT ON THE FIRST FOCUSABLE. The close button
     precedes the form in the DOM, so `focusable()[0]` focused Close — a reader
     who opened the box and pressed Space would have shut it again. Found by
     reading document.activeElement after a real click; the markup looked fine. */
  check('focus lands in the textarea, not on Close', /querySelector\('\.fb-t'\) \?\? focusable\(\)\[0\]/.test(client), true);
  check('the page is locked while open', /classList\.add\('fb-open-modal'\)/.test(client), true);
  check('and unlocked on close', /classList\.remove\('fb-open-modal'\)/.test(client), true);
}


console.log('\n== "Sending…" has to end ==');
/* Reported live: the box stuck on "Sending…" for minutes. `fetch` has NO default
   timeout in any browser, and neither end bounded anything — so a slow store
   left the reader staring at a button with their text un-sent and no way to
   know. Warm, the round trip measures ~0.35s. */
{
  const client = readFileSync(new URL('../web/public/feedback.js', import.meta.url), 'utf8');
  check('the client bounds the send', /signal:\s*AbortSignal\.timeout\?\.\(SEND_TIMEOUT_MS\)/.test(client), true);
  const ms = Number(client.match(/const SEND_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, ''));
  check('and the bound is a sane few seconds', ms >= 5000 && ms <= 30000, true);
  // A timeout and a dead connection need different advice, so they must not
  // collapse into one message.
  check('a timeout is told apart from no connection', /TimeoutError/.test(client), true);
  check('and says the text is still there', /still here/.test(client), true);
  // The typed message must survive a failure — row.hidden is success-only.
  const onFail = client.slice(client.indexOf('catch (err)'), client.indexOf('finally'));
  check('a failure never hides the form', /row\.hidden\s*=\s*true/.test(onFail), false);

  check('the store call is bounded too', STORE_TIMEOUT_MS >= 2000 && STORE_TIMEOUT_MS <= 15000, true);
  const api = readFileSync(new URL('../web/api/feedback.js', import.meta.url), 'utf8');
  check('and it is actually passed to the fetch',
    /signal:\s*AbortSignal\.timeout\?\.\(STORE_TIMEOUT_MS\)/.test(api), true);
  // A store that times out must read as a transport failure, not a success.
  const slow = await save({ message: 'x' }, { url: 'https://u', token: 't' }, 1,
    async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
  check('a timed-out store returns false, never true', slow, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);