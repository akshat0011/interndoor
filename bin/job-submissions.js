#!/usr/bin/env node
/**
 * Review what employers sent through /post-a-job — the other half of
 * web/api/post-job.js, which only stores requests.
 *
 *   npm run submissions                        the ones waiting for a decision
 *   npm run submissions -- --all               every submission the list holds
 *   npm run submissions -- --approve <id>      watchlist + board + the role itself
 *   npm run submissions -- --reject <id> [--reason "…"]
 *   npm run submissions -- --notify            bin/run.sh: a Mac banner and a phone
 *                                              push for anything new, silent otherwise
 *
 * Approval is src/employerjobs.js. It commits companies.json by pathspec, the
 * owner bar's Block precedent, so the next scheduled publish pushes it; the role
 * itself appears with that publish (≤30 min), after the scan has enriched it.
 *
 * Decisions are kept in the local store (settings `jobSubmissions:decided`), not
 * in Redis: the list is what employers sent, the decision is his.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIST_KEY, KEEP, sameOrg, siteHost } from '../web/api/post-job.js';
import { loadConfig, matchCompany, isBlockedCompany } from '../src/config.js';
import { Store } from '../src/store.js';
import { parseAtsLink } from '../src/ats.js';
import { ROOT } from '../src/paths.js';
import { approveSubmission, linkedinJobId } from '../src/employerjobs.js';

process.chdir(ROOT);
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const ARGS = process.argv.slice(2);
const arg = (name) => (ARGS.includes(name) ? ARGS[ARGS.indexOf(name) + 1] : null);
const DECIDED_KEY = 'jobSubmissions:decided';
const NOTIFIED_KEY = 'jobSubmissions:notified';

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('No submission store configured: set KV_REST_API_URL and KV_REST_API_TOKEN in .env.');
  process.exit(2);
}

const res = await fetch(`${url}/lrange/${encodeURIComponent(LIST_KEY)}/0/${KEEP - 1}`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error(`Could not read the submissions: HTTP ${res.status}.`); process.exit(1); }
const all = ((await res.json()).result ?? []).map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
  .filter((e) => e && typeof e.id === 'string');

const store = new Store();
const readJson = (key, fallback) => { try { return JSON.parse(store.getSetting(key) ?? '') ?? fallback; } catch { return fallback; } };
const decided = readJson(DECIDED_KEY, {});
const pending = all.filter((e) => !decided[e.id]);

if (ARGS.includes('--notify')) {
  const notified = new Set(readJson(NOTIFIED_KEY, []));
  const fresh = pending.filter((e) => !notified.has(e.id));
  if (fresh.length) {
    const { notify, pushToPhone } = await import('../src/notify.js');
    const names = fresh.map((e) => e.company).slice(0, 3).join(', ');
    const title = `${fresh.length} new employer submission${fresh.length === 1 ? '' : 's'}`;
    const body = `${names}${fresh.length > 3 ? '…' : ''} — run: npm run submissions`;
    await notify(title, body, {}).catch(() => {});
    await pushToPhone(title, body, { tags: 'briefcase' }).catch(() => {});
    for (const e of fresh) notified.add(e.id);
    store.setSetting(NOTIFIED_KEY, JSON.stringify([...notified].slice(-KEEP)));
    console.log(`${title}: ${names}`);
  }
  process.exit(0);
}

const cfg = loadConfig();
const ist = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

function describe(e) {
  const onList = matchCompany(e.company, cfg.watchlist);
  const ats = parseAtsLink(e.link);
  const li = linkedinJobId(e.link);
  const checks = [
    onList ? `already on the watchlist as ${onList}` : 'new employer — approval adds it to the watchlist',
    isBlockedCompany(e.company) ? 'BLOCKLISTED — do not approve' : null,
    ats ? `job board: ${ats.provider}/${ats.token} (every future role is collected)` : li ? `LinkedIn posting ${li}` : 'link is not a board we read — the role may need adding by hand',
    sameOrg(siteHost(e.link), siteHost(e.website)) || ats || li ? null : `the link is on ${siteHost(e.link)}, not ${siteHost(e.website)}`,
  ].filter(Boolean);
  const status = decided[e.id] ? `  [${decided[e.id].status}${decided[e.id].reason ? `: ${decided[e.id].reason}` : ''}]` : '';
  return [
    '─'.repeat(72),
    `${e.id} · ${ist(e.at)} IST${status}`,
    `${e.company} — ${e.website}`,
    `${e.email}`,
    `${e.kind === 'fulltime' ? 'Entry-level job' : 'Internship'} · ₹${Number(e.pay).toLocaleString('en-IN')} per ${e.period}`,
    `${e.link}`,
    ...(e.notes ? ['', ...e.notes.split('\n').map((l) => `  ${l}`)] : []),
    '',
    ...checks.map((c) => `  • ${c}`),
  ].join('\n');
}

const approveId = arg('--approve');
const rejectId = arg('--reject');

if (approveId || rejectId) {
  const id = approveId || rejectId;
  const entry = all.find((e) => e.id === id);
  if (!entry) { console.error(`No submission with id ${id}.`); process.exit(1); }
  if (decided[id]) { console.error(`${id} was already ${decided[id].status}.`); process.exit(1); }

  if (rejectId) {
    decided[id] = { status: 'rejected', at: new Date().toISOString(), reason: arg('--reason') || null };
    store.setSetting(DECIDED_KEY, JSON.stringify(decided));
    console.log(`Rejected ${id} (${entry.company}). Nothing was published.`);
    process.exit(0);
  }

  if (isBlockedCompany(entry.company)) { console.error(`${entry.company} is blocklisted — not approving.`); process.exit(1); }
  const companiesPath = join(ROOT, 'companies.json');
  const companiesFile = JSON.parse(readFileSync(companiesPath, 'utf8'));
  const { fetchPublicPosting } = await import('../src/guestsearch.js');
  const { ingestUrl } = await import('../src/ingest.js');
  const out = await approveSubmission(entry, {
    store,
    cfg,
    companiesFile,
    fetchPosting: (jobId) => fetchPublicPosting(jobId, { waits: [] }),
    ingest: (link, opts) => ingestUrl(store, cfg, link, opts),
  });

  if (out.watchlist === 'added') {
    writeFileSync(companiesPath, `${JSON.stringify(companiesFile, null, 2)}\n`);
    try {
      execFileSync('git', ['commit', '-m', `Watchlist: add ${entry.company} (employer submission)`, '--', 'companies.json'], { stdio: 'pipe' });
      console.log(`Added ${entry.company} to the watchlist (normalised "${out.normalised}") and committed companies.json.`);
    } catch (err) {
      console.log(`Added ${entry.company} to companies.json — the commit did not go through (${String(err.stderr || err.message).split('\n')[0]}). Commit it by hand.`);
    }
  } else {
    console.log(`${entry.company} was already on the watchlist.`);
  }
  if (out.board) console.log(`Job board: ${out.board}.`);
  const r = out.role;
  if (r.status === 'stored') console.log(`Stored the role${r.title ? ` "${r.title}"` : ''} (${r.jobId}). It goes live with the next scan's publish, after enrichment.`);
  else if (r.status === 'exists') console.log(`The role is already in the store (${r.jobId}).`);
  else console.log(`The role was NOT stored: ${r.reason ?? r.status}.${out.board ? ' The board is seeded, so its roles arrive with the next poll.' : ''}`);

  decided[id] = { status: 'approved', at: new Date().toISOString(), jobId: r.jobId ?? null, role: r.status };
  store.setSetting(DECIDED_KEY, JSON.stringify(decided));
  process.exit(0);
}

const shown = ARGS.includes('--all') ? all : pending;
if (!shown.length) {
  console.log(!all.length ? 'No submissions yet. (The store IS configured — this is a real empty.)' : `Nothing waiting — all ${all.length} submission${all.length === 1 ? ' is' : 's are'} decided.`);
  process.exit(0);
}
console.log(`\n${shown.length} submission${shown.length === 1 ? '' : 's'}${ARGS.includes('--all') ? '' : ' waiting'}, newest first:\n`);
for (const e of shown) console.log(describe(e));
console.log('─'.repeat(72));
console.log('\nApprove: npm run submissions -- --approve <id>     Reject: npm run submissions -- --reject <id> --reason "…"\n');
