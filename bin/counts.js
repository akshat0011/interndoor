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
import { EVENTS, REGIONS, keyFor, utcDay } from '../web/api/count.js';

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

const events = [...EVENTS];
const regions = [...REGIONS, 'XX'];
const dayList = [];
for (let i = days - 1; i >= 0; i--) dayList.push(utcDay(Date.now() - i * 86_400_000));

/* One MGET per board over the day × event grid — a few hundred keys, well
   inside a single request, and deterministic (no SCAN). */
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

  console.log(`\n== ${region} ==`);
  const short = (e) => e.replace('visit-', 'v-').replace('nudge-', 'n-').replace('newsince-shown', 'newsince');
  console.log(['day'.padEnd(11), ...events.map((e) => short(e).padStart(9))].join(' '));
  dayList.forEach((d, i) => {
    const row = values.slice(i * events.length, (i + 1) * events.length);
    if (!row.some(Boolean)) return;
    console.log([d.padEnd(11), ...row.map((n) => String(n).padStart(9))].join(' '));
  });
}
console.log('');
