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
