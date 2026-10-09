#!/usr/bin/env node
/**
 * Read the site's own event counters back — the other half of web/api/count.js.
 *
 *   npm run counts               last 14 days
 *   npm run counts -- --days 30
 *
 * One table per board, a row per UTC day, a column per event. Reads the same
 * Upstash Redis store the endpoint writes, over its REST API, using the same
 * two values (KV_REST_API_URL / KV_REST_API_TOKEN, or the UPSTASH_REDIS_REST_*
 * pair) — copy them from the Vercel project's environment into the local .env.
 * With neither set it says so and exits 2, rather than printing a table of
 * zeros that reads as "nobody came".
 */
import { readFileSync, existsSync } from 'node:fs';
import { EVENTS, REGIONS, keyFor, jobKeyFor, utcDay } from '../web/api/count.js';

/* .env is loaded by hand — the run scripts do it with `set -a; . .env`, and a
   one-off reader should not need that ceremony. Last assignment wins, matching
   the shell. */
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const ARGS = process.argv.slice(2);
const days = Number(ARGS[ARGS.indexOf('--days') + 1]) || 14;

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('No counter store configured: set KV_REST_API_URL and KV_REST_API_TOKEN in .env '
    + '(the values the Upstash Redis integration puts on the Vercel project).');
  process.exit(2);
}

/* --jobs: Apply clicks per job and per employer, from the day hashes
   web/api/count.js keeps since 9 Oct 2026 — the number an employer is told.
   `--company <name>` narrows it to one employer's roles. */
if (ARGS.includes('--jobs')) {
  const { fetchDayHashes, foldJobClicks } = await import('../src/jobclicks.js');
  const { jobSlug } = await import('../src/pages.js');
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(jobKeyFor(utcDay(Date.now() - i * 86_400_000)));
  let perDay;
  try { perDay = await fetchDayHashes({ url, token }, dayKeys); } catch (err) { console.error(err.message); process.exit(1); }
  const board = JSON.parse(readFileSync('web/public/data/jobs.json', 'utf8'));
  const bySlug = new Map((board.jobs ?? board).map((j) => [jobSlug({ company: j.company, title: j.title, slugTitle: j.slugTitle, id: j.id }), { company: j.company, title: j.title }]));
  const { jobs, companies, total } = foldJobClicks(perDay, bySlug);
  const want = ARGS.includes('--company') ? String(ARGS[ARGS.indexOf('--company') + 1] ?? '').toLowerCase() : '';
  const shown = want ? jobs.filter((j) => (j.company ?? j.slug).toLowerCase().includes(want)) : jobs;
  console.log(`\nApply clicks by job, last ${days} day(s): ${total} counted against a job page.\n`);
  for (const j of shown.slice(0, want ? 200 : 30)) {
    console.log(`${String(j.clicks).padStart(6)}  ${j.company ? `${j.company} — ${j.title}` : `${j.slug}  (no longer on the board)`}`);
  }
  if (!want) {
    console.log('\nBy employer (roles still on the board):\n');
    for (const c of companies.slice(0, 25)) console.log(`${String(c.clicks).padStart(6)}  ${c.company} (${c.roles} role${c.roles === 1 ? '' : 's'})`);
  }
  console.log('');
  process.exit(0);
}

const events = [...EVENTS];
const regions = [...REGIONS, 'XX'];
const dayList = [];
for (let i = days - 1; i >= 0; i--) dayList.push(utcDay(Date.now() - i * 86_400_000));

/* One MGET per board over the day × event grid — a few hundred keys, well
   inside a single request, and deterministic (no SCAN). */
let printed = 0;
for (const region of regions) {
  const keys = [];
  for (const d of dayList) for (const e of events) keys.push(keyFor(d, e, region));
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(['MGET', ...keys]),
  });
  if (!res.ok) { console.error(`store answered ${res.status} for ${region}`); process.exit(1); }
  const { result } = await res.json();
  const values = (result ?? []).map((v) => Number(v) || 0);
  if (!values.some(Boolean)) continue;
  printed += 1;

  console.log(`\n== ${region} ==`);
  const short = (e) => e.replace('visit-', 'v-').replace('nudge-', 'n-').replace('newsince-shown', 'newsince');
  console.log(['day'.padEnd(11), ...events.map((e) => short(e).padStart(9))].join(' '));
  dayList.forEach((d, i) => {
    const row = values.slice(i * events.length, (i + 1) * events.length);
    if (!row.some(Boolean)) return;
    console.log([d.padEnd(11), ...row.map((n) => String(n).padStart(9))].join(' '));
  });
}
/* An empty grid is a different answer from "no store" and must not look like
   it: the store answered, and nothing has been counted in the window. The
   usual reason on a fresh setup is that the Vercel deployment serving
   /api/count predates the env vars — they reach the NEXT deployment only. */
if (!printed) {
  console.log(`Store reachable; 0 events recorded in the last ${days} day(s) (${dayList[0]} to ${dayList.at(-1)} UTC).`);
  console.log('If the integration was just enabled, the running deployment does not have the env yet — any push to main redeploys with it.');
}
console.log('');
