#!/usr/bin/env node
/**
 * The local helper behind the "Add to post queue" button.
 *
 * The run report has always been a file on disk opened with `open`, which means
 * it renders under `file://` — an origin with no way to write to disk, reach
 * SQLite or start a local model. This serves that exact same file over
 * http://127.0.0.1 instead, which gives the page a same-origin API and costs
 * one small long-lived process. Nothing about the report changes; it is the
 * bytes writeReport already wrote.
 *
 * What it does:
 *   - serves the run reports and the generated post pages
 *   - keeps the queue (a table in the same jobs.db everything else uses)
 *   - on Generate, asks the local model for one hook and one tip per posting,
 *     assembles the posts from stored facts, writes a page, notifies him and
 *     opens it
 *
 * What it deliberately does NOT do: publish anything. The last step is his
 * hands on his own account, which is the entire reason the queue is manual.
 *
 *   node bin/queue-server.js            → http://127.0.0.1:4322
 *   QUEUE_PORT=5000 node bin/queue-server.js
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { PATHS, storygastedRoot } from '../src/paths.js';
import { readdirSync } from 'node:fs';
import { renderReportIndex, runIdFromFile, companiesIn, jobCountIn, INDEX_LIMIT } from '../src/reportindex.js';
import { postableRegion } from '../src/postregions.js';
import { log } from '../src/logger.js';
import { buildPost, jobFacts, composeCombined } from '../src/postgen.js';
import { buildPostsPage, writePostsPage } from '../src/postpage.js';
import { writePostDrafts } from '../src/ollama.js';
import { notify, open as openFile } from '../src/notify.js';
import { queuePort } from '../src/postqueue.js';
import { reelCaption } from '../src/reelcaption.js';
import { nextSlot, slotLabel, intoWindow } from '../src/reelslots.js';
import { formatFor } from '../src/reelformat.js';
import { publishedRegions, regionPath, regionOf } from '../src/regions.js';
import { accountFor, autoRegions, autoEnabled, dailyCap, autoSlotConfig, autoSpacingMinutes } from '../src/reelaccounts.js';
import { jobSlug } from '../src/pages.js';
import { utmUrl } from '../src/postgen.js';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const cfg = loadConfig();
const PORT = queuePort(cfg);
const store = new Store();

/* ------------------------------------------------------------------ replies */

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * Read a JSON body, refusing anything that is not one.
 *
 * The content-type check is not politeness — it is the CSRF guard. A page on
 * another origin can fire a form POST at 127.0.0.1 without a preflight, but
 * only with a form content type; requiring `application/json` forces a
 * preflight, which this server never answers, so the request never arrives.
 */
function readJson(req, res) {
  return new Promise((resolve) => {
    if (!/application\/json/i.test(req.headers['content-type'] ?? '')) {
      json(res, 415, { error: 'expected application/json' });
      return resolve(null);
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { json(res, 400, { error: 'unparseable body' }); resolve(null); }
    });
  });
}

/** Belt to the content-type braces: a cross-origin caller is refused outright. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches send no Origin header
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

/** A path segment we are willing to turn into a filename. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;

async function sendFile(res, path, notFound) {
  try {
    return html(res, 200, await readFile(path, 'utf8'));
  } catch {
    return html(res, 404, `<h1>404</h1><p>${notFound}</p>`);
  }
}

/* --------------------------------------------------------------- generation */

/**
 * One generation at a time.
 *
 * Not a queue of batches: the model is the only one on this machine and the
 * enricher is already competing for it during a scan. Two concurrent batches
 * would halve the speed of both and produce two pages he then has to reconcile.
 */
let running = null;

/**
 * Draft posts for the queue.
 *
 * With no ids, only rows that have NOT been drafted yet — a drafted row stays in
 * the queue so he can come back and copy it, and rewriting the whole queue on
 * every press would spend minutes of model time redoing posts he has already
 * read. The Rewrite button on a card passes that job's id explicitly, which is
 * the only way an existing draft is replaced.
 */
async function generate(jobIds) {
  const rows = jobIds?.length
    ? store.queuedJobs().filter((r) => jobIds.includes(r.job_id))
    : store.queuedJobs('queued');

  if (!rows.length) return { error: 'nothing new in the queue' };

  const batchId = new Date().toISOString().replace(/[:.]/g, '-');
  const model = cfg.postQueue?.model || cfg.ollama?.model || 'qwen3:8b';

  running = { done: 0, total: rows.length, batchId, startedAt: Date.now(), url: null, error: null };
  log.info(`Writing ${rows.length} LinkedIn post(s) with ${model}…`);

  try {
    const drafts = await writePostDrafts(
      rows.map((row) => ({ facts: jobFacts(row, cfg), description: row.description })),
      cfg,
      (done, total) => { running = { ...running, done, total }; },
    );

    for (const [i, row] of rows.entries()) {
      const raw = drafts.get(i) ?? null;
      const built = buildPost(row, cfg, raw);
      store.saveDraft(row.job_id, batchId, built.text, { fromModel: !!raw, dropped: built.ai.dropped, model });
    }

    // The page holds the whole queue, not just this batch: he asked for one
    // page of posts to work through, and rendering only the batch would drop
    // the other nine every time a single post was rewritten.
    const all = store.queuedJobs('drafted').map((row) => ({
      row,
      facts: jobFacts(row, cfg),
      text: row.post_text,
      meta: safeMeta(row.post_meta),
    }));

    const file = writePostsPage(
      buildPostsPage(all, { batchId, model, generatedAt: Date.now() }),
      batchId,
    );
    const url = `http://127.0.0.1:${PORT}/posts/latest`;
    running = { ...running, done: rows.length, url, finishedAt: Date.now() };
    log.ok(`Posts ready: ${file}`);

    await notify(
      `${rows.length} LinkedIn post${rows.length === 1 ? '' : 's'} ready`,
      rows.slice(0, 3).map((r) => `${r.company}: ${r.title}`).join('\n'),
      { sound: 'Glass', subtitle: 'Copy and paste — nothing is posted for you' },
    );
    await openFile(url);
    return { batchId, url, count: rows.length };
  } catch (err) {
    log.error(`Post generation failed: ${err.stack ?? err.message}`);
    running = { ...running, error: err.message, finishedAt: Date.now() };
    return { error: err.message };
  }
}

function safeMeta(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}


/* ------------------------------------------------- instagram reels */

/**
 * One reel at a time, and the state the page polls.
 *
 * Rendering is ~30s of frames and a TTS call; publishing adds a Cloudflare
 * tunnel and however long Instagram takes to fetch the video. That is far too
 * long to hold a request open, so this follows the same shape as /api/generate:
 * answer 202 immediately, report progress on a status endpoint.
 *
 * Serialised deliberately. Two renders at once would both drive Playwright and
 * both hold a tunnel, and the whole point of this button is that he presses it
 * on the ones he likes — not that it becomes a batch.
 */
let reelRunning = null;

/**
 * Jobs claimed and waiting for the worker.
 *
 * The route used to answer 409 while anything was in flight, so three good
 * jobs could not be pressed in three clicks: the first press publishes
 * immediately and that takes about four minutes end to end (render, tunnel,
 * Instagram's fetch), and both other buttons were dead for the whole of it.
 *
 * Now a press CLAIMS the job and returns straight away, and this queue is
 * drained one at a time. Serial on purpose — two renders at once would both
 * drive Playwright and both hold a tunnel — but the waiting is the server's
 * problem rather than the button's.
 */
const reelQueue = [];
let reelWorking = false;

async function pumpReels() {
  if (reelWorking) return;
  reelWorking = true;
  try {
    while (reelQueue.length) {
      const jobId = reelQueue.shift();
      await publishReel(jobId).catch((e) => log.warn(`Reel ${jobId}: ${e.message}`));
    }
    /* A slot may have fallen due while the queue was being worked. */
    await drainReels().catch((e) => log.warn(`Reel drain: ${e.message}`));
  } finally {
    reelWorking = false;
  }
}

/**
 * Claim a job and put it in the queue.
 *
 * The claim happens HERE, synchronously, not in the worker: it is what makes a
 * double-click harmless, and it has to happen before the request is answered
 * or two presses race into the queue twice.
 */
function enqueueReel(jobId, source = 'manual', fingerprint = null) {
  if (reelQueue.includes(jobId)) return { error: 'already queued' };
  const job = publicJob(jobId);
  if (!job) return { error: `job ${jobId} is not on the published board` };
  const region = job.__region;
  if (!accountFor(region, cfg)) {
    return { error: `no Instagram account configured for ${region} — see reels.accounts` };
  }
  if (!store.reelClaim(jobId, { region, source, fingerprint: fingerprint ?? job.roleFingerprint ?? null })) {
    const row = store.reelPost(jobId);
    return { error: row?.status === 'published' ? 'already published' : 'already in flight' };
  }
  reelQueue.push(jobId);
  pumpReels().catch((e) => log.warn(`Reel pump: ${e.message}`));
  return { queued: true, position: reelQueue.length };
}

/**
 * The job as the SITE has it, not as the database has it.
 *
 * Same rule bin/render-reel.js follows and for the same reason: the public
 * projection has already been through every cleaning rule the site uses, so a
 * caption cannot state something the job page does not. Re-deriving from raw
 * columns would let the two drift on the first fix to either.
 */
function regionJobsFile(code) {
  return join(PATHS.root, 'web', 'public', ...(regionPath(code) ? [regionPath(code).slice(1)] : []), 'data', 'jobs.json');
}

/** Every published board's jobs, newest first, each tagged with its region. */
function publishedJobs() {
  const out = [];
  for (const region of publishedRegions(cfg)) {
    const file = regionJobsFile(region.code);
    if (!existsSync(file)) continue;
    for (const j of JSON.parse(readFileSync(file, 'utf8')).jobs ?? []) {
      out.push({ ...j, __region: region.code });
    }
  }
  return out;
}

/**
 * The job as the SITE has it, searched across EVERY published board.
 *
 * It used to read India's data file and nothing else, which was correct while
 * India was the only board that produced reels. With a US account it is not:
 * a US job id simply was not found, so the reel could never be queued at all.
 * The region comes back on the row because everything downstream needs it —
 * which account to post to, which board to render, and whose daily cap it
 * spends.
 */
function publicJob(jobId) {
  return publishedJobs().find((j) => String(j.id) === String(jobId)) ?? null;
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: PATHS.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve(out)
      : reject(new Error(`${label} exited ${code}: ${(err || out).trim().split('\n').slice(-3).join(' ')}`)));
  });
}

/**
 * Upload an already-rendered reel and publish it.
 *
 * Split out from the queue step so the drain loop below can call it when a
 * scheduled slot arrives, without re-rendering. The video is on disk from the
 * moment the button was pressed.
 */
async function doPublish(row) {
  const jobId = row.job_id;
  const job = publicJob(jobId) ?? { company: jobId, title: '' };
  /* The row's region, not the file's: by the time a scheduled reel publishes,
     its posting may have aged off the board and publicJob would find nothing.
     The claim recorded the region precisely so this cannot become a guess. */
  const region = row.region || job.__region || 'IN';
  const account = accountFor(region, cfg);
  if (!account) {
    const why = `no Instagram account configured for ${region}`;
    store.reelFailed(jobId, why);
    log.warn(`Reel for ${job.company} not published — ${why}`);
    return { error: why };
  }

  reelRunning = { jobId, company: job.company, title: job.title, stage: 'publishing',
    startedAt: Date.now(), url: null, error: null };
  store.reelPublishing(jobId);
  log.info(`Reel for ${job.company} (${region}): publishing to @${account}…`);

  try {
    const video = row.video_path;
    if (!video || !existsSync(video)) throw new Error('the rendered file is gone');

    /* The caption goes on a FILE. It is multi-line and carries emoji and
       hashtags, and argv quoting for that across uv, sh and Python is a way to
       silently truncate somebody's post. */
    const capFile = join(tmpdir(), `interndoor-reel-${jobId}.txt`);
    writeFileSync(capFile, row.caption ?? '');

    const seconds = Number(await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video], 'ffprobe'));

    const out = await run('uv', ['run', '--project',
      storygastedRoot(), 'python',
      join(PATHS.root, 'bin', 'ig_publish.py'),
      '--video', video, '--caption-file', capFile,
      '--duration', seconds.toFixed(2), '--account', account,
      /* --region picks IG_USER_ID_<REGION>/IG_ACCESS_TOKEN_<REGION> out of .env.
         The guard still asks the live account who it is: with two accounts the
         bare names collide by design, so the name alone is not proof. */
      '--region', region], 'ig_publish');

    const res = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop());
    if (!res.ok) throw new Error(res.error);

    store.reelPublished(jobId, { mediaId: res.id, permalink: res.url });
    reelRunning = { ...reelRunning, stage: 'published', url: res.url, finishedAt: Date.now() };
    log.ok(`Published reel for ${job.company} — ${res.url}`);
    notify(`Reel published — ${job.company}`, job.title, res.url);
    return { ok: true, url: res.url };
  } catch (err) {
    store.reelFailed(jobId, err.message);
    reelRunning = { ...reelRunning, stage: 'failed', error: err.message, finishedAt: Date.now() };
    log.warn(`Reel for ${job.company} failed — ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Render a reel now, then publish it now or at its slot.
 *
 * RENDERING ALWAYS HAPPENS IMMEDIATELY, even for a reel that will not go out
 * for hours: he is at the keyboard when he presses the button, which is the
 * only moment a render failure is worth surfacing. It also means the slot
 * cannot arrive to find the model down or Playwright broken.
 */
async function publishReel(jobId) {
  /* Already claimed by enqueueReel — claiming here too would refuse the job it
     was handed. */
  const job = publicJob(jobId) ?? { company: jobId, title: '' };
  const claimed = store.reelPost(jobId);
  const region = claimed?.region || job.__region || 'IN';
  const isAuto = claimed?.source === 'auto';

  reelRunning = { jobId, company: job.company, title: job.title, stage: 'rendering',
    startedAt: Date.now(), url: null, error: null };
  log.info(`Reel for ${job.company} — ${job.title}: rendering…`);

  try {
    /* THE FORMAT IS DECIDED ONCE, HERE, and handed to both halves. The
       renderer would reach the same answer on its own — 'auto' asks the same
       function — but the caption is built in this process from the same row,
       and a reel whose picture reveals an employer under a caption that opened
       by naming them is two posts stapled together. One decision, two
       consumers. */
    const format = formatFor(job, { want: 'auto' }, cfg);

    /* --region is not optional now there is more than one board: render-reel
       loads that region's jobs.json, and without it a US job id is simply not
       found. */
    await run(process.execPath, ['--no-warnings=ExperimentalWarning',
      join(PATHS.root, 'bin', 'render-reel.js'),
      `--job=${jobId}`, `--format=${format}`, `--region=${region}`], 'render-reel');

    const video = join(PATHS.reelsOut, `${jobId}.mp4`);
    if (!existsSync(video)) throw new Error('the render produced no file');

    const page = utmUrl(`https://interndoor.com/jobs/${jobSlug({ ...job, id: jobId })}`,
      { campaign: 'reel', content: String(jobId), source: 'instagram' }, cfg);
    const caption = reelCaption(job, { url: page, format });

    /* Slots already promised to queued reels count, not just the last publish
       — otherwise three presses inside a minute all measure from the same
       moment and collide on one slot. This row is excluded: it has no slot yet
       and is what we are computing one for. */
    /* Spacing is PER ACCOUNT. Two regions post to two different accounts with
       two different audiences and two separate quotas, so a US reel holding a
       slot says nothing about when India's next one may go.

       An automatic reel is spaced by the day's cap rather than by
       reels.spacingMinutes: that value is 180 and belongs to the manual queue,
       where a sitting is two or three reels he picked by hand. At 180 the
       10:00-22:00 window holds four posts, so an automatic cap of 20 would take
       days to deliver one day's roles and never catch up. */
    const slotCfg = isAuto
      ? autoSlotConfig(region, cfg, regionOf(region)?.timeZone)
      : (cfg.reels ?? {});
    let slot = nextSlot({
      now: Date.now(),
      lastPublishedAt: store.reelLastPublishedAt(region),
      pendingSlots: store.reelPending()
        .filter((r) => r.job_id !== jobId && (r.region || 'IN') === region)
        .map((r) => r.publish_at),
    }, slotCfg);

    /* AN AUTOMATIC REEL MUST NEVER BYPASS THE POSTING WINDOW.
       `nextSlot` answers null for "go out now", and with no anchor — a region
       that has never published — that is the answer it always gives. For the
       manual button null is right and deliberate: he pressed it because he
       wants it out, and making him wait would mean the button did not do what
       it said. Nobody pressed this one. Left alone, the first reel of a new
       region publishes at whatever hour the sweep happened to find it, so
       India's first would have gone out at 4am to an audience asleep — which
       is the same mistake as running a US account on Kolkata hours, arriving
       from the other direction. Clamping to the window keeps "now" when now is
       inside it and pushes to the opening when it is not. */
    if (isAuto && slot === null) {
      const opens = intoWindow(Date.now(), slotCfg);
      slot = opens > Date.now() ? opens : null;
    }

    const state = store.reelRendered(jobId, video, caption, slot, format);
    if (state === 'scheduled') {
      reelRunning = { ...reelRunning, stage: 'scheduled', slot,
        slotLabel: slotLabel(slot, slotCfg), finishedAt: Date.now() };
      log.ok(`Reel for ${job.company} rendered — queued for ${slotLabel(slot, slotCfg)}`);
      return { ok: true, scheduled: slot };
    }

    return await doPublish(store.reelPost(jobId));
  } catch (err) {
    store.reelFailed(jobId, err.message);
    reelRunning = { ...reelRunning, stage: 'failed', error: err.message, finishedAt: Date.now() };
    log.warn(`Reel for ${job.company} failed — ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Publish whatever is due.
 *
 * Polled rather than timed, so a slot that fell while this Mac was asleep, or
 * while the helper was being restarted by bin/run.sh, goes out on the next
 * tick instead of being missed. The state is in the database, so a restart
 * loses nothing. One at a time: `reelDue` returns the soonest only.
 */
async function drainReels() {
  if (reelRunning && !reelRunning.finishedAt) return;
  if (reelQueue.length) return;   // the pump will call this when it is empty
  const due = store.reelDue();
  if (due) await doPublish(due);
}

/**
 * Queue reels for newly scraped jobs, with no approval step.
 *
 * This is the automatic half. The manual queue is unchanged and still exists:
 * a press of the button in the run report is a reel he chose, and those are
 * marked source='manual' so the two can be told apart later.
 *
 * ONLY NEW POSTINGS, NEVER THE BACKLOG. Candidates are limited by
 * `maxAgeHours` on first_seen_at. Without it, switching this on would open with
 * a day's worth of reels about roles that had been on the board for weeks —
 * the opposite of what a feed built on "be early" is for, and it would spend
 * the whole cap before a single fresh listing arrived.
 *
 * NEWEST FIRST, and that is what the cap buys. Instagram allows 100 posts per
 * rolling 24 hours per account and the US board takes a median of 105 tech
 * listings a day, so not every job CAN become a reel. Choosing explicitly means
 * the ones that go out are the freshest rather than whichever happened to be
 * reached before the API started refusing.
 *
 * A FEW AT A TIME, not the whole day's allowance at once. Rendering is serial
 * and takes about 45 seconds a reel, and a row is claimed the moment it is
 * queued — so claiming twenty would leave eighteen sitting in 'rendering' with
 * no way back if this process restarted, since reelClaim only ever re-claims a
 * FAILED row. The sweep runs every 60 seconds and the slots are minutes apart,
 * so there is nothing to gain by queueing deeper.
 */
/* Regions the breaker has already spoken about, so it says it once. */
const breakerWarned = new Set();
/* Same, for the "this board has gone quiet" tripwire. */
const staleWarned = new Set();

function autoSweep() {
  if (!autoEnabled(cfg)) return;
  if (reelRunning && !reelRunning.finishedAt) return;
  if (reelQueue.length) return;

  const auto = cfg.reels?.auto ?? {};
  const perSweep = Number(auto.perSweep ?? 3);
  const failureLimit = Number(auto.failureLimit ?? 3);
  const maxAgeMs = Number(auto.maxAgeHours ?? 48) * 3_600_000;
  const now = Date.now();

  const all = publishedJobs();
  const known = store.reelKnownJobIds();
  /* ONE ROLE, ONE REEL. The board already collapses one opening advertised in
     many cities onto a single card, keyed on a hash of the posting's own
     description — company and title alone merge genuinely different jobs.
     Without the same rule here the feed gets the raw postings: a live sweep
     queued three Micron internships and the SAME StemPedia role twice, which
     reads as a broken bot rather than as several vacancies. */
  const seenPrints = store.reelKnownFingerprints();

  for (const region of autoRegions(cfg)) {
    /* THE CIRCUIT BREAKER. A failure does not count against the daily cap —
       reelCountSince counts rendering|scheduled|publishing|published and not
       failed — so a blocked endpoint frees a slot, this sweep refills it 60
       seconds later, and that fails too. On 28-29 Aug it turned a cap of 20
       into 36 failed US reels while Instagram answered "API access blocked",
       and hammering an endpoint that is blocking you is the worst thing to be
       doing while an app restriction is live. It has been stopped by hand
       twice; this stops it on its own.
       It clears itself on the next successful publish, so there is nothing to
       reset — see reelFailuresSinceSuccess, which also explains why a row
       cancelled by hand is not a failure. */
    const spacingMs = autoSpacingMinutes(region, cfg) * 60_000;
    const failures = store.reelFailuresSinceSuccess(region, now - 86_400_000);
    if (failures >= failureLimit) {
      /* Once per region per process. A warning repeated every 60 seconds is
         one nobody reads, and this one has to be legible in the log the
         morning after it trips. */
      if (!breakerWarned.has(region)) {
        breakerWarned.add(region);
        log.warn(`Reels: ${region} has failed ${failures} times since its last successful post — automatic posting is paused for this region. Probe the account before re-enabling; it clears itself on the next success.`);
      }
      continue;
    }
    breakerWarned.delete(region);

    /* A SILENCE MUST NEVER BE INVISIBLE AGAIN. India went from 29 Aug 11:42 to
       31 Aug 10:30 with no reel — 46 hours — and nothing anywhere said so: the
       sweep was running, the log was clean, and the only trace was a gap in a
       table nobody was reading. The pool had simply gone empty under a 48-hour
       maxAgeHours while India's intake had collapsed to ~2 rows a day. This is
       the tripwire for that, and like the apply-link one it is worth having
       precisely because the failure is silent. Reported once per process, at
       twice the promised gap, so an ordinary spacing wait never trips it. */
    const lastOut = store.reelLastPublishedAt(region);
    const staleMs = lastOut ? now - lastOut : null;
    if (staleMs !== null && staleMs > 2 * spacingMs && !staleWarned.has(region)) {
      staleWarned.add(region);
      log.warn(`Reels: ${region} has not published for ${(staleMs / 3_600_000).toFixed(1)}h against a ${(spacingMs / 3_600_000).toFixed(1)}h cadence — the eligible pool may be empty. Check reels.auto.maxAgeHours against that board's intake.`);
    } else if (staleMs !== null && staleMs <= 2 * spacingMs) {
      staleWarned.delete(region);
    }

    const cap = dailyCap(region, cfg);
    const used = store.reelCountSince(region, now - 86_400_000);
    let spent = used;   // moves as we queue, so the log counts up rather than repeating
    let budget = Math.min(cap - used, perSweep);
    if (budget <= 0) {
      if (cap - used <= 0) log.info(`Reels: ${region} has used its daily cap (${used}/${cap}) — nothing queued.`);
      continue;
    }

    const fresh = all
      .filter((j) => j.__region === region
        && j.isTech !== false
        && !known.has(String(j.id))
        && (now - (j.firstSeenAt ?? j.postedAt ?? 0)) <= maxAgeMs)
      .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));

    /* One employer per sweep as well. Micron alone had eight fresh postings
       with eight different descriptions, so the fingerprint rule correctly lets
       them all through — but three Micron reels in a row is still a monotonous
       feed. They are not dropped, only deferred: the next sweep takes the next
       one, which spreads one employer's roles across the day instead of
       spending a third of the cap on them at once. */
    const seenEmployers = new Set();

    for (const j of fresh) {
      if (budget <= 0) break;
      const print = j.roleFingerprint || `id:${j.id}`;
      if (seenPrints.has(print)) continue;
      if (seenEmployers.has(j.company)) continue;
      const r = enqueueReel(String(j.id), 'auto', print);
      if (r.queued) {
        known.add(String(j.id));
        seenPrints.add(print);
        seenEmployers.add(j.company);
        budget--;
        spent++;
        log.info(`Reels: queued ${region} ${j.company} — ${j.title} (auto, ${spent}/${cap} today)`);
      } else if (r.error && !/already/.test(r.error)) {
        log.warn(`Reels: could not queue ${j.id} — ${r.error}`);
      }
    }
  }
}

/* Anything still marked 'rendering' belongs to a previous life of this process:
   the queue is in memory, so nothing is working on it. Released here rather
   than left stranded — see reelReleaseOrphans for why 'publishing' is not. */
{
  const freed = store.reelReleaseOrphans();
  if (freed) log.info(`Reels: released ${freed} posting${freed === 1 ? '' : 's'} left rendering by a previous run — they are candidates again.`);
}

setInterval(() => {
  try { autoSweep(); } catch (e) { log.warn(`Reel auto-sweep: ${e.message}`); }
  drainReels().catch((e) => log.warn(`Reel drain: ${e.message}`));
}, 60_000);

/* ------------------------------------------------------------------- routes */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'cross-origin requests are refused' });

  if (path === '/api/health') {
    return json(res, 200, { ok: true, ...store.queueCounts(), generating: !!running && !running.finishedAt });
  }

  if (path === '/api/queue' && req.method === 'GET') {
    return json(res, 200, { ids: store.queuedIds(), ...store.queueCounts() });
  }

  if (path === '/api/queue' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;
    const id = String(body.jobId ?? '');
    if (!id) return json(res, 400, { error: 'jobId is required' });
    /* The report hides the button for a board with no LinkedIn account, but the
       endpoint refuses it too: the page is cached HTML and an old tab left open
       still carries the old buttons. Removal is always allowed — a row queued
       before the rule changed has to be gettable out. */
    if (body.action !== 'remove') {
      const row = store.db.prepare('SELECT region FROM jobs WHERE job_id = ?').get(id);
      if (row && !postableRegion(cfg, row.region)) {
        return json(res, 400, { error: `${row.region} listings are not posted to LinkedIn — there is no account for that board.` });
      }
    }
    if (body.action === 'remove') store.queueRemove(id);
    else store.queueAdd(id);
    return json(res, 200, { ids: store.queuedIds(), ...store.queueCounts() });
  }

  if (path === '/api/queue/clear' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;
    store.queueClear(body.status ?? null);
    return json(res, 200, { ids: store.queuedIds(), ...store.queueCounts() });
  }

  if (path === '/api/generate' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;
    if (running && !running.finishedAt) return json(res, 409, { error: 'a batch is already being written' });

    const ids = Array.isArray(body.jobIds) ? body.jobIds.map(String) : null;
    if (!store.queuedJobs(ids ? null : 'queued').length) return json(res, 400, { error: 'nothing new in the queue' });

    // Answered immediately: a dozen postings through a local 14b model is
    // minutes of work, and a request held open that long is one the browser
    // gives up on. The page polls /api/generate/status instead.
    generate(ids);
    return json(res, 202, { started: true });
  }

  /* ONE POST FOR EVERYTHING IN THE QUEUE, and it answers straight away.
     No model is involved — every line is a company, a place and a URL, the
     same call the Sunday roundup makes — so unlike /api/generate there is
     nothing to poll and no 202. It also does not touch the drafts: a combined
     post is a different way of saying the same queue, not a replacement for
     the individual ones, and both end up on the same page. */
  if (path === '/api/generate/combined' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;

    const ids = Array.isArray(body.jobIds) ? body.jobIds.map(String) : null;
    const rows = ids?.length
      ? store.queuedJobs().filter((r) => ids.includes(String(r.job_id)))
      : store.queuedJobs();
    if (!rows.length) return json(res, 400, { error: 'nothing in the queue' });

    const facts = rows.map((row) => jobFacts(row, cfg, 'combined'));
    const text = composeCombined(facts);
    // What did not fit is counted in the post itself; this is the same number,
    // said on the page so he can see it without reading to the bottom.
    const fitted = (text.match(/\n→ /g) ?? []).length;

    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const drafted = store.queuedJobs('drafted').map((row) => ({
      row,
      facts: jobFacts(row, cfg),
      text: row.post_text,
      meta: safeMeta(row.post_meta),
    }));
    const file = writePostsPage(
      buildPostsPage(drafted, {
        batchId,
        model: cfg.postQueue?.model || cfg.ollama?.model || 'qwen3:8b',
        generatedAt: Date.now(),
        combined: { text, count: rows.length, dropped: Math.max(0, rows.length - fitted) },
      }),
      batchId,
    );
    const url = `http://127.0.0.1:${PORT}/posts/latest`;
    log.ok(`Combined post ready (${rows.length} postings): ${file}`);
    await openFile(url);
    return json(res, 200, { url, count: rows.length, chars: text.length });
  }

  if (path === '/api/generate/status') {
    return json(res, 200, running ?? { done: 0, total: 0 });
  }

  if (path === '/api/reel' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;
    if (!body.jobId) return json(res, 400, { error: 'jobId is required' });
    /* Answers as soon as the job is CLAIMED, not when it is finished. The
       work happens on the queue; the page polls /api/reel/status. */
    const out = enqueueReel(String(body.jobId));
    return out.error ? json(res, 409, out) : json(res, 202, out);
  }

  if (path === '/api/reel/status') {
    return json(res, 200, {
      running: reelRunning,
      queue: reelQueue.slice(),
      posts: store.reelPosts().map((r) => ({
        jobId: r.job_id, status: r.status, url: r.permalink, error: r.error,
        slot: r.publish_at ?? null,
        slotLabel: r.publish_at ? slotLabel(r.publish_at, cfg.reels ?? {}) : null,
      })),
    });
  }

  if (path === '/' || path === '/report' || path === '/report/') {
    res.statusCode = 302;
    res.setHeader('location', '/report/latest');
    return res.end();
  }

  /* AN INDEX OF PAST REPORTS. Every run writes one and they have always been
     served at /report/<runId>, but nothing listed them — so closing the tab
     lost the report, and there are 1,676 on disk. Read at request time rather
     than cached: this is a local page opened a few times a day, and a cache
     would go stale every 30 minutes. */
  if (path === '/reports' || path === '/reports/') {
    let entries = [];
    try {
      entries = readdirSync(PATHS.reports)
        .map(runIdFromFile)
        .filter(Boolean)
        .sort()
        .reverse()
        .slice(0, INDEX_LIMIT)
        .map((id) => {
          try {
            const text = readFileSync(join(PATHS.reports, `report-${id}.html`), 'utf8');
            return { id, companies: companiesIn(text), jobs: jobCountIn(text) };
          } catch {
            return { id, companies: [], jobs: 0 };
          }
        });
    } catch { /* no reports directory yet — render the empty state */ }
    return html(res, 200, renderReportIndex(entries));
  }

  if (path === '/report/latest') {
    return sendFile(res, PATHS.latestReport, 'No report yet — run a scan first.');
  }

  if (path.startsWith('/report/')) {
    const id = decodeURIComponent(path.slice('/report/'.length));
    if (!SAFE_ID.test(id)) return html(res, 400, '<h1>400</h1>');
    return sendFile(res, join(PATHS.reports, `report-${id}.html`), `No report stored for run ${id}.`);
  }

  if (path === '/weekly' || path === '/weekly/' || path === '/weekly/latest') {
    return sendFile(res, PATHS.latestWeekly, 'No roundup yet — it is written on the day set in postQueue.weekly, or run `npm run weekly -- --force`.');
  }

  if (path.startsWith('/weekly/')) {
    const id = decodeURIComponent(path.slice('/weekly/'.length));
    if (!SAFE_ID.test(id)) return html(res, 400, '<h1>400</h1>');
    return sendFile(res, join(PATHS.posts, `weekly-${id}.html`), `No roundup for ${id}.`);
  }

  if (path === '/posts' || path === '/posts/' || path === '/posts/latest') {
    return sendFile(res, PATHS.latestPosts, 'No posts written yet — queue a few listings and press Generate.');
  }

  if (path.startsWith('/posts/')) {
    const id = decodeURIComponent(path.slice('/posts/'.length));
    if (!SAFE_ID.test(id)) return html(res, 400, '<h1>400</h1>');
    return sendFile(res, join(PATHS.posts, `posts-${id}.html`), `No post batch ${id}.`);
  }

  return html(res, 404, '<h1>404</h1>');
});

// Loopback only. Nothing off this machine may reach the queue, and binding to
// 0.0.0.0 on a laptop that joins cafe wifi would do exactly that.
server.listen(PORT, '127.0.0.1', () => {
  log.ok(`Post queue helper → http://127.0.0.1:${PORT}`);
});

// A port already in use is almost always this same helper started twice — say
// so and exit quietly rather than leaving a crash in the loop's log every 30
// minutes.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.info(`Port ${PORT} is already serving the post queue — nothing to start.`);
    process.exit(0);
  }
  log.error(`Post queue helper failed: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); store.close(); process.exit(0); });
}
