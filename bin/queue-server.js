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
import { PATHS } from '../src/paths.js';
import { log } from '../src/logger.js';
import { buildPost, jobFacts } from '../src/postgen.js';
import { buildPostsPage, writePostsPage } from '../src/postpage.js';
import { writePostDrafts } from '../src/ollama.js';
import { notify, open as openFile } from '../src/notify.js';
import { queuePort } from '../src/postqueue.js';
import { reelCaption } from '../src/reelcaption.js';
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
 * The job as the SITE has it, not as the database has it.
 *
 * Same rule bin/render-reel.js follows and for the same reason: the public
 * projection has already been through every cleaning rule the site uses, so a
 * caption cannot state something the job page does not. Re-deriving from raw
 * columns would let the two drift on the first fix to either.
 */
function publicJob(jobId) {
  const file = join(PATHS.root, 'web', 'public', 'data', 'jobs.json');
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return (data.jobs ?? []).find((j) => String(j.id) === String(jobId)) ?? null;
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

async function publishReel(jobId) {
  const job = publicJob(jobId);
  if (!job) return { error: `job ${jobId} is not on the published board` };
  if (!store.reelClaim(jobId)) {
    const row = store.reelPost(jobId);
    return { error: row?.status === 'published' ? 'already published' : 'already in flight' };
  }

  const account = cfg.reels?.account || 'interndoor';
  reelRunning = { jobId, company: job.company, title: job.title, stage: 'rendering',
    startedAt: Date.now(), url: null, error: null };
  log.info(`Reel for ${job.company} — ${job.title}: rendering…`);

  try {
    await run(process.execPath, ['--no-warnings=ExperimentalWarning',
      join(PATHS.root, 'bin', 'render-reel.js'), `--job=${jobId}`], 'render-reel');

    const video = join(PATHS.reelsOut, `${jobId}.mp4`);
    if (!existsSync(video)) throw new Error('the render produced no file');

    const page = utmUrl(`https://interndoor.com/jobs/${jobSlug({ ...job, id: jobId })}`,
      { campaign: 'reel', content: String(jobId) }, cfg);
    const caption = reelCaption(job, { url: page });
    store.reelRendered(jobId, video, caption);

    reelRunning = { ...reelRunning, stage: 'publishing' };
    log.info(`Reel for ${job.company}: publishing to @${account}…`);

    /* The caption goes on a FILE. It is multi-line and carries emoji and
       hashtags, and argv quoting for that across uv, sh and Python is a way to
       silently truncate somebody's post. */
    const capFile = join(tmpdir(), `interndoor-reel-${jobId}.txt`);
    writeFileSync(capFile, caption);

    const seconds = Number(await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video], 'ffprobe'));

    const out = await run('uv', ['run', '--project',
      join(process.env.HOME, 'Desktop', 'projects', 'storygasted'), 'python',
      join(PATHS.root, 'bin', 'ig_publish.py'),
      '--video', video, '--caption-file', capFile,
      '--duration', seconds.toFixed(2), '--account', account], 'ig_publish');

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

  if (path === '/api/generate/status') {
    return json(res, 200, running ?? { done: 0, total: 0 });
  }

  if (path === '/api/reel' && req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return undefined;
    if (reelRunning && !reelRunning.finishedAt) {
      return json(res, 409, { error: 'a reel is already being made' });
    }
    if (!body.jobId) return json(res, 400, { error: 'jobId is required' });
    /* Not awaited: the page polls /api/reel/status. */
    publishReel(String(body.jobId));
    return json(res, 202, { started: true });
  }

  if (path === '/api/reel/status') {
    return json(res, 200, {
      running: reelRunning,
      posts: store.reelPosts().map((r) => ({
        jobId: r.job_id, status: r.status, url: r.permalink, error: r.error,
      })),
    });
  }

  if (path === '/' || path === '/report' || path === '/report/') {
    res.statusCode = 302;
    res.setHeader('location', '/report/latest');
    return res.end();
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
