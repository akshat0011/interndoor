#!/usr/bin/env node
/**
 * Read the feedback readers have sent — the other half of web/api/feedback.js.
 *
 *   npm run feedback                 the newest 30
 *   npm run feedback -- --all        everything the list holds (up to KEEP)
 *   npm run feedback -- --n 100
 *   npm run feedback -- --json       raw, for piping
 *
 * Reads the same Upstash Redis list the endpoint writes, over its REST API,
 * with the same two values (KV_REST_API_URL / KV_REST_API_TOKEN, or the
 * UPSTASH_REDIS_REST_* pair) — copy them from the Vercel project into .env.
 * With neither set it SAYS SO and exits 2, rather than printing "no feedback
 * yet", which would read as "nobody wrote" when the truth is "nothing is
 * configured". The same distinction bin/counts.js makes, and for the same
 * reason: an empty result and a missing store must never look alike.
 */
import { readFileSync, existsSync } from 'node:fs';
import { LIST_KEY, KEEP } from '../web/api/feedback.js';

/* .env by hand, last assignment wins, matching the shell — as bin/counts.js. */
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const n = ARGS.includes('--all') ? KEEP : (Number(ARGS[ARGS.indexOf('--n') + 1]) || 30);

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('No feedback store configured: set KV_REST_API_URL and KV_REST_API_TOKEN in .env '
    + '(the values the Upstash Redis integration puts on the Vercel project).');
  process.exit(2);
}

const res = await fetch(`${url}/lrange/${encodeURIComponent(LIST_KEY)}/0/${n - 1}`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`Could not read the feedback list: HTTP ${res.status}.`);
  process.exit(1);
}
const body = await res.json();
const rows = (body.result ?? []).map((raw) => {
  try { return JSON.parse(raw); } catch { return null; }
}).filter(Boolean);

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (!rows.length) {
  console.log('No feedback yet. (The store IS configured — this is a real empty.)');
  process.exit(0);
}

const ist = (iso) => {
  /* Printed in IST because he reads it, and the site's own logs already mix UTC
     and IST enough (CLAUDE.md §4). The stored value stays ISO/UTC. */
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
};

console.log(`\n${rows.length} message${rows.length === 1 ? '' : 's'}, newest first:\n`);
for (const r of rows) {
  const who = r.email ? r.email : 'no reply address';
  const where = r.path && r.path !== '/' ? ` · ${r.path}` : '';
  console.log('─'.repeat(72));
  console.log(`${ist(r.at)} IST · ${r.region || '??'}${where} · ${who}`);
  console.log();
  for (const line of String(r.message ?? '').split('\n')) console.log(`  ${line}`);
  console.log();
}
console.log('─'.repeat(72));
const withMail = rows.filter((r) => r.email).length;
console.log(`${withMail} of ${rows.length} left an address to reply to. List holds at most ${KEEP}.\n`);
