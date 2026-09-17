/**
 * The Facebook cross-post: src/facebookreels.js, the store columns behind it,
 * the queue server's wiring, and the token tool's guards.
 *
 * Nothing here reaches Facebook. The publish sequence is driven against a
 * scripted fetch that records every call, so what is pinned is the exact
 * shape Meta documents — and the one property that matters more than any of
 * them: THE TOKEN NEVER APPEARS IN A URL OR A THROWN MESSAGE.
 */
import { readFileSync } from 'node:fs';
import {
  fbEnvNames, facebookEnabled, facebookRegions, pageCreds, permalinkFor, interpretStatus,
  publishFacebookReel, GRAPH, UPLOAD, DAILY_CAP, RETRY_GAP_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_AGE_MS,
} from '../src/facebookreels.js';
import { Store } from '../src/store.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TOKEN = 'EAAB-secret-page-token-XYZ';

console.log('\n== names, switches, credentials ==');
{
  ok('env names are region-suffixed', JSON.stringify(fbEnvNames('in')) === JSON.stringify({ page: 'FB_PAGE_ID_IN', token: 'FB_PAGE_TOKEN_IN' }));
  let threw = false; try { fbEnvNames('india'); } catch { threw = true; }
  ok('a bad region is refused', threw);
  ok('off with no block', facebookEnabled({}) === false && facebookEnabled({ reels: {} }) === false);
  ok('off when enabled but no regions', facebookEnabled({ reels: { facebook: { enabled: true, regions: [] } } }) === false);
  ok('off unless enabled is literally true', facebookEnabled({ reels: { facebook: { enabled: 'yes', regions: ['IN'] } } }) === false);
  ok('on with both', facebookEnabled({ reels: { facebook: { enabled: true, regions: ['in', 'US'] } } }) === true);
  ok('regions are upper-cased', facebookRegions({ reels: { facebook: { regions: ['in', 'us'] } } }).join() === 'IN,US');
  ok('no id → no credentials', pageCreds('IN', { FB_PAGE_TOKEN_IN: 't' }) === null);
  ok('no token → no credentials', pageCreds('IN', { FB_PAGE_ID_IN: '1' }) === null);
  ok('blank token → no credentials', pageCreds('IN', { FB_PAGE_ID_IN: '1', FB_PAGE_TOKEN_IN: '  ' }) === null);
  ok('both → credentials', JSON.stringify(pageCreds('IN', { FB_PAGE_ID_IN: ' 123 ', FB_PAGE_TOKEN_IN: 't' })) === JSON.stringify({ pageId: '123', token: 't' }));
  ok('the other region\'s pair is never read', pageCreds('US', { FB_PAGE_ID_IN: '1', FB_PAGE_TOKEN_IN: 't' }) === null);
}

console.log('\n== the permalink ==');
{
  ok('site-relative permalink_url is made absolute', permalinkFor('9', '/reel/9') === 'https://www.facebook.com/reel/9');
  ok('an absolute one is kept', permalinkFor('9', 'https://www.facebook.com/x/videos/9') === 'https://www.facebook.com/x/videos/9');
  ok('none → /reel/{id}', permalinkFor('9') === 'https://www.facebook.com/reel/9');
  ok('the id is encoded', permalinkFor('a b') === 'https://www.facebook.com/reel/a%20b');
}

console.log('\n== reading Facebook\'s status object ==');
{
  const S = (o) => interpretStatus(o);
  ok('nothing yet → pending', !S({}).done && !S({}).failed && !S(null).done);
  ok('publishing complete → done', S({ video_status: 'processing', publishing_phase: { status: 'complete' } }).done === true);
  ok('video_status ready → done', S({ video_status: 'ready' }).done === true);
  ok('upload_complete alone is NOT done (still processing)', S({ video_status: 'upload_complete', processing_phase: { status: 'in_progress' } }).done === false);
  const f = S({ video_status: 'processing', processing_phase: { status: 'error', error: { message: 'bad codec' } } });
  ok('a phase error → failed, with the phase and the message', f.failed && /processing: bad codec/.test(f.reason), f.reason);
  const u = S({ uploading_phase: { status: 'error', errors: [{ message: 'too small' }] } });
  ok('the upload phase\'s errors array is read too', u.failed && /uploading: too small/.test(u.reason), u.reason);
  ok('video_status error/expired/upload_failed → failed', ['error', 'expired', 'upload_failed'].every((v) => S({ video_status: v }).failed));
  ok('a failure is never also done', !f.done && !u.done);
}

/* A scripted Facebook: answers in order, records every call. */
function fakeFacebook(script) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(i, script.length - 1)]; i += 1;
    const status = step.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => step.body };
  };
  return { calls, fetchImpl };
}
const VIDEO = Buffer.from('not really an mp4');
const base = (fetchImpl) => ({
  pageId: '111', token: TOKEN, videoPath: '/tmp/reel.mp4', description: 'Hiring #intern',
  fetchImpl, readFile: () => VIDEO, fileSize: () => VIDEO.length,
  sleep: async () => {}, pollMs: 1,
});

console.log('\n== the publish sequence, as Meta documents it ==');
{
  const fb = fakeFacebook([
    { body: { video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/V1' } },
    { body: { success: true } },
    { body: { success: true } },
    { body: { status: { video_status: 'processing', publishing_phase: { status: 'in_progress' } } } },
    { body: { status: { video_status: 'ready', publishing_phase: { status: 'complete' } }, permalink_url: '/reel/V1' } },
  ]);
  const res = await publishFacebookReel(base(fb.fetchImpl));
  const [start, upload, finish, s1, s2] = fb.calls;
  ok('1. start: POST /{page}/video_reels with upload_phase=start', start.url === `${GRAPH}/111/video_reels` && start.init.method === 'POST' && start.init.body === 'upload_phase=start');
  ok('   with the token in a Bearer header', start.init.headers.authorization === `Bearer ${TOKEN}`);
  ok('2. upload: to the upload_url Facebook gave', upload.url === 'https://rupload.facebook.com/video-upload/v25.0/V1' && upload.init.method === 'POST');
  ok('   Authorization: OAuth, offset 0, file_size, binary body', upload.init.headers.authorization === `OAuth ${TOKEN}` && upload.init.headers.offset === '0' && upload.init.headers.file_size === String(VIDEO.length) && upload.init.body === VIDEO);
  ok('3. finish: video_id, upload_phase=finish, video_state=PUBLISHED, description', finish.url === `${GRAPH}/111/video_reels` && /^upload_phase=finish&video_id=V1&video_state=PUBLISHED&description=Hiring\+%23intern$/.test(finish.init.body), finish.init.body);
  ok('4. status: GET /{video}?fields=status,permalink_url, Bearer header', s1.url === `${GRAPH}/V1?fields=status,permalink_url` && !s1.init.method && s1.init.headers.authorization === `Bearer ${TOKEN}`);
  ok('   polled until publishing is complete', fb.calls.length === 5 && s2.url === s1.url);
  ok('result: ok, the id, the permalink Facebook gave, not pending', res.ok && res.videoId === 'V1' && res.permalink === 'https://www.facebook.com/reel/V1' && res.pending === false);
  ok('THE TOKEN IS IN NO URL', fb.calls.every((c) => !c.url.includes(TOKEN)));
  ok('and in no body', fb.calls.every((c) => !(typeof c.init.body === 'string' && c.init.body.includes(TOKEN))));
}

console.log('\n== refusals never leak the token ==');
{
  const fb = fakeFacebook([{ status: 400, body: { error: { message: 'Invalid OAuth access token.', code: 190, error_subcode: 463 } } }]);
  let err = null;
  try { await publishFacebookReel(base(fb.fetchImpl)); } catch (e) { err = e; }
  ok('a Graph error envelope becomes a plain message with the code', err && /^facebook 190\/463 Invalid OAuth access token\.$/.test(err.message), err?.message);
  ok('that message carries no token', err && !err.message.includes(TOKEN));
  ok('nothing was uploaded after a refused start', fb.calls.length === 1);

  const bad = fakeFacebook([
    { body: { video_id: 'V2' } }, { body: { success: true } }, { body: { success: true } },
    { body: { status: { processing_phase: { status: 'error', error: { message: 'Unsupported video format' } } } } },
  ]);
  err = null;
  try { await publishFacebookReel(base(bad.fetchImpl)); } catch (e) { err = e; }
  ok('a processing error after finish is a failure', err && /publish processing: Unsupported video format/.test(err.message), err?.message);

  const netdown = fakeFacebook([]);
  netdown.fetchImpl = async () => { throw new Error(`getaddrinfo ENOTFOUND graph.facebook.com ${TOKEN}`); };
  err = null;
  try { await publishFacebookReel(base(netdown.fetchImpl)); } catch (e) { err = e; }
  ok('a network failure names the step', err && /^start: getaddrinfo/.test(err.message), err?.message);

  const noId = fakeFacebook([{ body: { success: true } }]);
  err = null;
  try { await publishFacebookReel(base(noId.fetchImpl)); } catch (e) { err = e; }
  ok('start without a video_id is refused', err && /no video_id/.test(err.message));
  err = null;
  try { await publishFacebookReel({ ...base(noId.fetchImpl), token: '' }); } catch (e) { err = e; }
  ok('no credentials is refused before any request', err && /no Facebook Page credentials/.test(err.message) && noId.calls.length === 1);
}

console.log('\n== the upload host is anchored, and the deadline is honest ==');
{
  const fb = fakeFacebook([
    { body: { video_id: 'V3', upload_url: 'https://evil.example/rupload.facebook.com/video-upload/v25.0/V3' } },
    { body: { success: true } }, { body: { success: true } },
    { body: { status: { publishing_phase: { status: 'complete' } } } },
  ]);
  await publishFacebookReel(base(fb.fetchImpl));
  ok('a lookalike upload_url is ignored for the documented host', fb.calls[1].url === `${UPLOAD}/V3`, fb.calls[1].url);

  let t = 0;
  const slow = fakeFacebook([
    { body: { video_id: 'V4' } }, { body: { success: true } }, { body: { success: true } },
    { body: { status: { publishing_phase: { status: 'in_progress' } } } },
  ]);
  const res = await publishFacebookReel({ ...base(slow.fetchImpl), now: () => (t += 1000), deadlineMs: 3000 });
  ok('past the deadline: ok, id and /reel/{id}, marked pending', res.ok && res.videoId === 'V4' && res.pending === true && res.permalink === 'https://www.facebook.com/reel/V4');
  ok('it did not poll forever', slow.calls.length <= 8, String(slow.calls.length));
}

console.log('\n== the store: one row, two destinations ==');
{
  const s = new Store(':memory:');
  const cols = s.db.prepare('PRAGMA table_info(reel_posts)').all().map((c) => c.name);
  ok('the five fb_ columns exist', ['fb_video_id', 'fb_permalink', 'fb_error', 'fb_attempted_at', 'fb_attempts'].every((c) => cols.includes(c)));
  const put = (id, region, finished, status = 'published', video = '/v.mp4') => s.db.prepare(
    'INSERT INTO reel_posts (job_id, status, started_at, finished_at, region, video_path) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, status, finished - 1, finished, region, video);
  const Q = (now, extra = {}) => s.reelFacebookDue({ regions: ['IN', 'US'], since: 5000, now, gapMs: 100, maxAttempts: 3, maxAgeMs: 10_000, ...extra });
  put('old', 'IN', 4000);            // before the feature went live
  put('a', 'IN', 6000);
  put('b', 'US', 7000);
  put('failed', 'IN', 8000, 'failed');
  put('novideo', 'IN', 8500, 'published', null);
  put('gb', 'GB', 9000);
  ok('a reel published before the feature is never owed', Q(9500)?.job_id === 'a');
  ok('oldest owed first', Q(9500)?.job_id === 'a' && Q(9500, { regions: ['US'] })?.job_id === 'b');
  ok('a region not configured is never owed', s.reelFacebookDue({ regions: ['IN', 'US'], since: 8900, now: 9500, gapMs: 100, maxAttempts: 3, maxAgeMs: 10_000 }) === null);
  ok('an Instagram failure is never cross-posted', Q(9500, { regions: ['IN'] })?.job_id !== 'failed');
  s.reelFacebookFailed('a', 'boom', 9500);
  ok('a failure records why and counts an attempt', (() => { const r = s.db.prepare("SELECT * FROM reel_posts WHERE job_id='a'").get(); return r.fb_error === 'boom' && r.fb_attempts === 1 && r.fb_attempted_at === 9500; })());
  ok('inside the gap it is not retried', Q(9550, { regions: ['IN'] }) === null);
  ok('after the gap it is', Q(9700, { regions: ['IN'] })?.job_id === 'a');
  s.reelFacebookFailed('a', 'boom', 9700); s.reelFacebookFailed('a', 'boom', 9900);
  ok('after maxAttempts it is given up', Q(11_000, { regions: ['IN'] })?.job_id !== 'a');
  s.reelFacebookPublished('b', { videoId: 'V', permalink: 'https://www.facebook.com/reel/V', at: 9600 });
  const b = s.db.prepare("SELECT * FROM reel_posts WHERE job_id='b'").get();
  ok('success stores id and permalink and clears the error', b.fb_video_id === 'V' && b.fb_permalink === 'https://www.facebook.com/reel/V' && b.fb_error === null && b.fb_attempts === 1);
  /* Asked well past the retry gap, or the gap answers instead of the id. */
  ok('and a reel on the Page is never owed again', Q(12_000, { regions: ['US'] }) === null);
  ok('the daily count sees it', s.reelFacebookCountSince('US', 9000) === 1 && s.reelFacebookCountSince('US', 9700) === 0 && s.reelFacebookCountSince('IN', 0) === 0);
  ok('a reel older than maxAgeMs is dropped', Q(20_000, { regions: ['IN'] }) === null);
  ok('the Instagram status is untouched throughout', s.db.prepare("SELECT status FROM reel_posts WHERE job_id IN ('a','b')").all().every((r) => r.status === 'published'));
  s.close?.();
}

console.log('\n== wired into the queue server ==');
{
  const qs = read('bin/queue-server.js');
  const lift = (from) => { const i = qs.indexOf(from); ok(`${from.slice(0, 40)} found`, i > 0); const j = qs.indexOf('\n}\n', i); return qs.slice(i, j + 3); };
  const publish = qs.slice(qs.indexOf('async function doPublish(row)'), qs.indexOf('async function crossPostFacebook('));
  const crossCalls = publish.match(/await crossPostFacebook\(\{ jobId, region, videoPath: video, caption: row\.caption \?\? ''/g) || [];
  ok('the cross-post is called exactly once from the publish', crossCalls.length === 1, String(crossCalls.length));
  ok('and AFTER the Instagram outcome is recorded and announced',
    publish.indexOf('await crossPostFacebook(') > publish.indexOf('store.reelPublished(jobId')
    && publish.indexOf('await crossPostFacebook(') > publish.indexOf('await notify(`Reel published'));
  const cross = lift('async function crossPostFacebook(');
  ok('it has its own try/catch', /try \{[\s\S]*\} catch \(err\) \{[\s\S]*\} finally \{/.test(cross));
  ok('a refusal writes the fb_ columns and NEVER reelFailed', /store\.reelFacebookFailed\(jobId, why\)/.test(cross) && !/reelFailed\(/.test(cross));
  ok('success writes the id and permalink', /store\.reelFacebookPublished\(jobId, \{ videoId: res\.videoId, permalink: res\.permalink \}\)/.test(cross));
  ok('off, or a region not configured, is a skip', /if \(!facebookEnabled\(cfg\) \|\| !facebookRegions\(cfg\)\.includes\(region\)\) return/.test(cross));
  ok('missing credentials re-read .env once before giving up', /if \(!creds\) \{\s*\/\*[\s\S]*?\*\/\s*try \{ process\.loadEnvFile\(join\(PATHS\.root, '\.env'\)\); \} catch[\s\S]*?creds = pageCreds\(region\);/.test(cross));
  ok('no credentials is one log line per region, not an error', /fbCredsWarned\.has\(region\)/.test(cross) && /fbCredsWarned\.add\(region\)/.test(cross) && /return \{ skipped: 'no-creds' \}/.test(cross));
  ok('the per-Page daily cap is checked first', /reelFacebookCountSince\(region, dayAgo\) >= FB_DAILY_CAP/.test(cross));
  ok('one upload at a time', /if \(fbBusy\) return \{ skipped: 'busy' \}/.test(cross) && /fbBusy = true;/.test(cross) && /fbBusy = false;/.test(cross));
  const retry = lift('async function retryFacebook(');
  ok('the tick retries what is owed, bounded by the module\'s limits', /reelFacebookDue\(\{[\s\S]*gapMs: FB_RETRY_GAP_MS, maxAttempts: FB_RETRY_MAX_ATTEMPTS, maxAgeMs: FB_RETRY_MAX_AGE_MS/.test(retry));
  ok('never before the feature went live', /since = Number\(store\.getSetting\(FB_SINCE_KEY\)/.test(retry) && /if \(!since\) return;/.test(retry));
  ok('a vanished file is recorded, not retried forever', /existsSync\(row\.video_path\)[\s\S]*reelFacebookFailed\(row\.job_id, 'the rendered file is gone'\)/.test(retry));
  ok('the tick calls it', /retryFacebook\(\)\.catch\(/.test(qs));
  ok('the live-since marker is written once and never moved', /if \(facebookEnabled\(cfg\) && !Number\(store\.getSetting\(FB_SINCE_KEY\) \?\? 0\)\) \{\s*store\.setSetting\(FB_SINCE_KEY, String\(Date\.now\(\)\)\);/.test(qs) && (qs.match(/setSetting\(FB_SINCE_KEY/g) || []).length === 1);
  ok('.env is loaded, and its absence is fine', /try \{ process\.loadEnvFile\(join\(PATHS\.root, '\.env'\)\); \} catch/.test(qs));
  ok('the status route reports the Facebook link', /facebook: r\.fb_permalink \?\? null/.test(qs));
  /* The identifier, not the word: the no-credentials line names `npm run fb-token`. */
  ok('the token is never logged', !/log\.\w+\([^)]*(creds\.token|\$\{token\}|\$\{creds)/.test(qs));
  ok('limits are the module\'s: 30/day, 30 min, 3 attempts, 24h', DAILY_CAP === 30 && RETRY_GAP_MS === 30 * 60_000 && RETRY_MAX_ATTEMPTS === 3 && RETRY_MAX_AGE_MS === 24 * 3_600_000);
}

console.log('\n== config and the token tool ==');
{
  const cfg = JSON.parse(read('config.json'));
  ok('reels.facebook is on for IN and US', cfg.reels.facebook.enabled === true && cfg.reels.facebook.regions.join() === 'IN,US');
  ok('pages are named or null, never guessed', Object.entries(cfg.reels.facebook.pages).every(([r, v]) => /^[A-Z]{2}$/.test(r) && (v === null || typeof v === 'string')));
  const pkg = JSON.parse(read('package.json'));
  ok('npm run fb-token exists', /bin\/fb-token\.js/.test(pkg.scripts['fb-token'] || ''));
  const tool = read('bin/fb-token.js').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the token is read with echo off', /\{ secret: true \}/.test(tool));
  ok('and never printed', !/console\.(log|error)\([^)]*(\$\{token\}|\btoken\s*[,)])/.test(tool) && !/die\([^)]*\$\{token\}/.test(tool));
  ok('a USER token is refused (a Page has a category)', /if \(!me\.category\)/.test(tool) && /USER token/.test(tool));
  ok('the wrong Page is refused by name when config names one', /me\.name\)\.trim\(\)\.toLowerCase\(\) !== String\(expectedName\)/.test(tool));
  ok('an unnamed Page must be confirmed', /Is this the \$\{region\} Page\? \[y\/N\]/.test(tool) && /if \(!\/\^y\(es\)\?\$\/i\.test\(yes\)\) die/.test(tool));
  ok('reels are probed before storing', /video_reels\?limit=1/.test(tool));
  ok('the token travels in a header, never a URL', /authorization: `Bearer \$\{token\}`/.test(tool) && !/access_token=/.test(tool));
  ok('both variables are written through setEnvVar', /setEnvVar\(setEnvVar\(before, pageVar, String\(me\.id\)\), tokenVar, token\)/.test(tool));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
