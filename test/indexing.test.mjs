/**
 * The Google Indexing API client.
 *
 * The rule this file exists to defend is `isJobPageUrl`. The API accepts pages
 * carrying JobPosting or BroadcastEvent and NOTHING else, and Google warns that
 * using it for an unsupported page type can cost the project its API access —
 * so a company hub reaching it is not a bad row, it is the whole integration.
 * This site's hubs deliberately carry no JobPosting markup (marking up a closed
 * posting is what earns a structured-data manual action), which makes every hub
 * URL on the site a live example of what must never be sent.
 *
 * The queue semantics are the other half: 48 publishes a day against a quota of
 * 200 URLs per rolling 24h means an integration that re-announces a live page
 * every run spends the entire allowance on the first four pages.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

/* A real key, so signJwt's signature is verified rather than merely produced. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYDIR = mkdtempSync(join(tmpdir(), 'interndoor-indexing-'));
const KEYFILE = join(KEYDIR, 'key.json');
writeFileSync(KEYFILE, JSON.stringify({
  type: 'service_account',
  project_id: 'interndoor-test',
  client_email: 'indexer@interndoor-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));
process.env.GOOGLE_INDEXING_KEY_FILE = KEYFILE;

const {
  isJobPageUrl, signJwt, loadServiceAccount, accessToken, notify,
  runIndexingSweep, queueForIndexing, indexingConfigured, keyPath,
  _resetTokenCache, DAILY_QUOTA, UPDATED, DELETED,
} = await import('../src/indexing.js');
const { Store } = await import('../src/store.js');

// ---------------------------------------------------------------------------
console.log('\n== only a job page may ever be submitted ==');

const SITE = 'https://interndoor.com';
for (const url of [
  `${SITE}/jobs/adobe-apprentice-tech-4457612403`,
  `${SITE}/us/jobs/spacex-software-engineer-intern-1234`,
  `${SITE}/uk/jobs/stripe-intern-99`,
]) ok(`accepts ${url.slice(SITE.length)}`, isJobPageUrl(url));

/* Every one of these is a real URL on the live site. None carries JobPosting
   markup, so each is a way to lose the project's API access. */
for (const url of [
  `${SITE}/`,                       // the board
  `${SITE}/us`,                     // a region board
  `${SITE}/companies`,              // the directory — the tempting one
  `${SITE}/us/companies`,
  `${SITE}/companies/adobe`,        // a hub: deliberately no JobPosting markup
  `${SITE}/us/companies/spacex`,
  `${SITE}/alerts`,
  `${SITE}/jobs`,                   // the collection, not a posting
  `${SITE}/jobs/`,
  `${SITE}/jobs/a/b`,               // nothing nests under /jobs/
  `${SITE}/sitemap.xml`,
  `${SITE}/data/jobs.json`,
]) ok(`refuses ${url.slice(SITE.length) || '/'}`, !isJobPageUrl(url));

ok('refuses another domain', !isJobPageUrl('https://evil.example/jobs/x'));
ok('refuses a lookalike host', !isJobPageUrl('https://interndoor.com.evil.example/jobs/x'));
ok('refuses a query string', !isJobPageUrl(`${SITE}/jobs/x?utm_source=ig`));
ok('refuses a fragment', !isJobPageUrl(`${SITE}/jobs/x#apply`));
ok('refuses a non-string', !isJobPageUrl(null));
ok('refuses http', !isJobPageUrl('http://interndoor.com/jobs/x'));

// ---------------------------------------------------------------------------
console.log('\n== the service-account assertion ==');

const sa = loadServiceAccount();
ok('the key file is found', indexingConfigured());
check('keyPath honours the env override', keyPath(), KEYFILE);

const NOW_SEC = 1_800_000_000;
const jwt = signJwt(sa, { now: NOW_SEC });
const [h64, c64, s64] = jwt.split('.');
const dec = (b) => JSON.parse(Buffer.from(b, 'base64url').toString());

check('alg is RS256', dec(h64).alg, 'RS256');
check('iss is the service account', dec(c64).iss, sa.client_email);
check('scope is the indexing scope', dec(c64).scope, 'https://www.googleapis.com/auth/indexing');
check('aud is the token endpoint', dec(c64).aud, 'https://oauth2.googleapis.com/token');
check('exp is an hour out', dec(c64).exp - dec(c64).iat, 3600);
ok('the signature verifies against the public key', createVerify('RSA-SHA256')
  .update(`${h64}.${c64}`).end()
  .verify(publicKey, Buffer.from(s64, 'base64url')));
ok('the JWT is base64url, not base64', !/[+/=]/.test(jwt));

// ---------------------------------------------------------------------------
console.log('\n== the queue: what Google is owed ==');

/* The REAL schema, lifted out of src/store.js rather than restated here, so a
   column renamed there fails this file instead of drifting past it. */
const storeSrc = readFileSync('src/store.js', 'utf8');
const ddl = storeSrc.match(/CREATE TABLE IF NOT EXISTS indexed_urls \([^;]*\);/);
ok('the indexed_urls DDL was found in src/store.js', !!ddl);

function freshStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl[0]);
  const s = { db };
  for (const m of ['indexQueue', 'indexDue', 'indexMarkDone', 'indexMarkFailed', 'indexCountSince', 'indexStats']) {
    s[m] = Store.prototype[m].bind(s);
  }
  return s;
}

const A = `${SITE}/jobs/a-1`;
const B = `${SITE}/jobs/b-2`;
const T = 1_000_000;

let st = freshStore();
check('a new URL queues as an update', st.indexQueue([A], UPDATED, T), 1);
check('re-queueing the same action is a no-op', st.indexQueue([A], UPDATED, T + 5000), 0);
check('…and keeps its ORIGINAL age, so ordering survives', st.indexDue({ limit: 9 })[0].queued_at, T);

st.indexMarkDone(A, UPDATED, T + 10);
check('once announced, nothing is owed', st.indexDue({ limit: 9 }).length, 0);
check('and it is not re-announced next publish', st.indexQueue([A], UPDATED, T + 20), 0);

check('a URL Google never saw cannot be DELETED', freshStore().indexQueue([A], DELETED, T), 1 - 1);
check('…but one it did see can', st.indexQueue([A], DELETED, T + 30), 1);
check('a page that came back cancels its pending deletion', st.indexQueue([A], UPDATED, T + 40), 0);
check('…and then owes nothing at all', st.indexDue({ limit: 9 }).length, 0);

// ---------------------------------------------------------------------------
console.log('\n== what to send first ==');

st = freshStore();
st.indexQueue([A], UPDATED, T);            // older update
st.indexMarkDone(A, UPDATED, T);
st.indexQueue([A], DELETED, T + 9000);     // newer, but a deletion
st.indexQueue([B], UPDATED, T + 1000);     // newer update
const order = st.indexDue({ limit: 9 }).map((r) => `${r.type}:${r.url.slice(-3)}`);
check('updates outrank deletions however fresh the deletion', order, ['URL_UPDATED:b-2', 'URL_DELETED:a-1']);

st = freshStore();
st.indexQueue([A], UPDATED, T);
st.indexQueue([B], UPDATED, T + 5000);
check('newest first within a kind — a seed backlog never buries a new posting',
  st.indexDue({ limit: 9 }).map((r) => r.url.slice(-3)), ['b-2', 'a-1']);

check('minAgeMs holds back a URL queued moments ago',
  st.indexDue({ limit: 9, minAgeMs: 60_000, now: T + 6000 }).length, 0);
check('…and releases it once it has aged',
  st.indexDue({ limit: 9, minAgeMs: 60_000, now: T + 5000 + 60_000 }).length, 2);

st = freshStore();
st.indexQueue([A], UPDATED, T);
for (let i = 0; i < 3; i++) st.indexMarkFailed(A, 'boom');
check('a URL is retired after maxAttempts', st.indexDue({ limit: 9, maxAttempts: 3 }).length, 0);
check('…but keeps its error for --status', st.indexStats().lastError.error, 'boom');
check('…and is counted as retired, not forgotten', st.indexStats().retired, 1);

st = freshStore();
st.indexQueue([A, B], UPDATED, T);
st.indexMarkDone(A, UPDATED, T);
check('the rolling window counts what went out', st.indexCountSince(T - 1), 1);
check('…and excludes what fell out of it', st.indexCountSince(T + 1), 0);

// ---------------------------------------------------------------------------
console.log('\n== the sweep ==');

const cfg = (over = {}) => ({ indexing: { enabled: true, dailyCap: 190, perRun: 25, minAgeMinutes: 0, maxAttempts: 3, ...over } });

function fakeFetch(handler) {
  const calls = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, body: init?.body?.toString() });
      return handler(url, init, calls.length);
    },
  };
}
const tokenOk = () => new Response(JSON.stringify({ access_token: 't0k', expires_in: 3600 }), { status: 200 });
const publishOk = () => new Response('{}', { status: 200 });

st = freshStore();
st.indexQueue([A], UPDATED, T);
st.indexQueue([B], UPDATED, T + 1000);   // distinct ages, so the order is defined
_resetTokenCache();
let f = fakeFetch((url) => (url.includes('oauth2') ? tokenOk() : publishOk()));
let res = await runIndexingSweep(st, cfg(), { fetchImpl: f.fn, now: T + 2000 });
check('both went out', res.sent, 2);
check('one token, then one call per URL', f.calls.length, 3);
ok('the publish endpoint uses the colon method form',
  f.calls[1].url === 'https://indexing.googleapis.com/v3/urlNotifications:publish');
check('the body is url + type, freshest first', JSON.parse(f.calls[1].body), { url: B, type: UPDATED });
check('nothing is owed afterwards', st.indexDue({ limit: 9 }).length, 0);

st = freshStore();
st.indexQueue([A, B], UPDATED, T);
_resetTokenCache();
f = fakeFetch((url) => (url.includes('oauth2') ? tokenOk() : publishOk()));
res = await runIndexingSweep(st, cfg(), { fetchImpl: f.fn, now: T, dryRun: true });
check('a dry run sends nothing', res.sent, 0);
check('…and makes no request at all', f.calls.length, 0);
check('…but says what it would send', res.wouldSend.length, 2);
check('…and leaves the queue intact', st.indexDue({ limit: 9 }).length, 2);

st = freshStore();
st.indexQueue([A, B], UPDATED, T);
_resetTokenCache();
f = fakeFetch((url, init, n) => {
  if (url.includes('oauth2')) return tokenOk();
  return n === 2 ? new Response('quota', { status: 429 }) : publishOk();
});
res = await runIndexingSweep(st, cfg(), { fetchImpl: f.fn, now: T });
check('a 429 stops the batch rather than burning the rest', f.calls.length, 2);
/* Both survive, and that is the point: a spent quota is transient, so neither
   the URL that was refused nor the one never attempted should be given up on.
   Only `attempts` moves, and only for the one Google actually answered. */
check('…and nothing is dropped — both stay queued', st.indexDue({ limit: 9, maxAttempts: 3 }).length, 2);
check('…with only the attempted one carrying a strike',
  st.indexDue({ limit: 9, maxAttempts: 3 }).map((r) => r.attempts).sort(), [0, 1]);

st = freshStore();
st.indexQueue([A], UPDATED, T);
_resetTokenCache();
f = fakeFetch((url) => (url.includes('oauth2') ? tokenOk() : new Response('denied', { status: 403 })));
res = await runIndexingSweep(st, cfg(), { fetchImpl: f.fn, now: T });
ok('a 403 names Search Console, not Google Cloud',
  st.indexStats().lastError.error.includes('OWNER of this property in Search Console'));

st = freshStore();
st.indexQueue([A], UPDATED, T);
st.indexMarkDone(A, UPDATED, T);
_resetTokenCache();
f = fakeFetch(() => tokenOk());
res = await runIndexingSweep(st, cfg({ dailyCap: 1 }), { fetchImpl: f.fn, now: T + 1 });
check('the daily cap is obeyed', res.skipped, 'daily-cap');
check('…and nothing was requested', f.calls.length, 0);

res = await runIndexingSweep(freshStore(), cfg({ enabled: false }), { fetchImpl: f.fn });
check('disabled means disabled', res.skipped, 'disabled');

/* dailyCap is clamped to Google's real ceiling: a bigger number is not a bigger
   allowance, it is the same allowance plus refusals. */
st = freshStore();
for (let i = 0; i < 3; i++) {
  st.indexQueue([`${SITE}/jobs/x-${i}`], UPDATED, T);
  st.indexMarkDone(`${SITE}/jobs/x-${i}`, UPDATED, T);
}
res = await runIndexingSweep(st, cfg({ dailyCap: 5000 }), { fetchImpl: f.fn, now: T + 1, dryRun: true });
check('the cap reported is Google\'s ceiling, not the config', DAILY_QUOTA, 200);

// ---------------------------------------------------------------------------
console.log('\n== the last line of defence ==');

st = freshStore();
/* Straight into the table, bypassing queueForIndexing's filter — this is the
   case where a future caller has queued something it should not have. */
st.db.prepare("INSERT INTO indexed_urls (url, pending, queued_at) VALUES (?, 'URL_UPDATED', ?)")
  .run(`${SITE}/companies/adobe`, T);
_resetTokenCache();
f = fakeFetch((url) => (url.includes('oauth2') ? tokenOk() : publishOk()));
res = await runIndexingSweep(st, cfg(), { fetchImpl: f.fn, now: T + 1 });
check('a hub that reached the queue is refused before sending', res.sent, 0);
check('…and no publish request was made', f.calls.filter((c) => !c.url.includes('oauth2')).length, 0);
ok('…and the reason is recorded', st.indexStats().lastError.error.includes('not a job page'));

st = freshStore();
const mixed = [`${SITE}/jobs/real-1`, `${SITE}/companies/adobe`, `${SITE}/`, `${SITE}/alerts`];
const q = queueForIndexing(st, { indexUrls: mixed, removedUrls: [`${SITE}/companies/gone`] });
check('queueForIndexing keeps only the job page', q.queuedUpdate, 1);
check('…and refuses to queue a hub deletion', q.queuedDelete, 0);

// ---------------------------------------------------------------------------
console.log('\n== the config ships safe ==');

const conf = JSON.parse(readFileSync('config.json', 'utf8')).indexing;
ok('config.json carries an indexing block', !!conf);
ok('dailyCap sits under Google\'s ceiling', conf.dailyCap <= DAILY_QUOTA);
ok('minAgeMinutes is long enough for a Vercel deploy', conf.minAgeMinutes >= 1);
ok('perRun does not exceed the daily cap', conf.perRun <= conf.dailyCap);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
