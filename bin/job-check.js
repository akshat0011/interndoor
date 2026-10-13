#!/usr/bin/env node
/**
 * Is each live job still open? One pass of the checker (src/jobchecks.js).
 *
 *   node bin/job-check.js                what bin/run.sh calls after every scan
 *   node bin/job-check.js --plan         what this pass would look at; nothing fetched
 *   node bin/job-check.js --job <id|url> one job's status and every check behind it
 *   node bin/job-check.js --summary      live jobs by status
 *
 * It never publishes: a close or a status change rides the next scan's
 * publish (≤30 min), exactly as the link sweep's closes always did.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { PATHS } from '../src/paths.js';
import { publishedRegions, regionPath } from '../src/regions.js';
import { announceable } from '../src/rolefocus.js';
import { channelRefusal } from '../src/channelgate.js';
import { ensureJobChecks, checksFor, planTick, runTick, pruneChecks, linkedinPausedUntil } from '../src/jobchecks.js';
import { decideStatus, SIGNALS } from '../src/jobstatus.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const HOT_NEW_MS = 3 * 86_400_000;
const HOT_POST_MS = 7 * 86_400_000;

const cfg = loadConfig();
const mode = cfg.jobStatus?.mode === 'on' ? 'on' : 'shadow';
const store = new Store();
ensureJobChecks(store.db);
const now = Date.now();
const ist = (t) => new Date(Number(t) + 5.5 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16) + ' IST';

function published() {
  const out = [];
  for (const r of publishedRegions(cfg)) {
    const prefix = regionPath(r.code);
    const file = join(PATHS.root, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
    if (!existsSync(file)) continue;
    try { out.push(...(JSON.parse(readFileSync(file, 'utf8')).jobs ?? [])); } catch (e) { log.warn(`Job checks: could not read ${file} (${e.message}).`); }
  }
  return out;
}

const rowOf = store.db.prepare(`SELECT job_id, title, company, apply_url, first_seen_at, status, status_confidence, status_reason,
  status_at, next_check_at, link_checked_at, closed_at, closed_reason FROM jobs WHERE job_id = ?`);
const lastEmployerCheck = store.db.prepare("SELECT signal FROM job_checks WHERE job_id = ? AND source = 'employer' ORDER BY checked_at DESC LIMIT 1");
const lastLinkedinCheck = store.db.prepare("SELECT checked_at FROM job_checks WHERE job_id = ? AND source = 'linkedin' ORDER BY checked_at DESC LIMIT 1");
const joined = (pub) => {
  const r = rowOf.get(String(pub.id));
  if (!r) return null;
  /* Blind: the last look at the employer page could not see the job at all
     (blocked, unreachable, unreadable). kindOf then asks LinkedIn instead. */
  const lastEmp = lastEmployerCheck.get(String(pub.id))?.signal;
  return { id: String(pub.id), title: r.title, company: r.company, applyUrl: r.apply_url, firstSeenAt: r.first_seen_at,
    status: r.status, statusConfidence: r.status_confidence, statusReason: r.status_reason, nextCheckAt: r.next_check_at,
    linkCheckedAt: r.link_checked_at, closedAt: r.closed_at,
    employerBlind: SIGNALS[lastEmp]?.dir === 'none',
    linkedinCheckedAt: lastLinkedinCheck.get(String(pub.id))?.checked_at ?? null };
};

/* ON THE CHANNELS: a job that went (or would go) to WhatsApp in the last three
   days, or got a reel or a LinkedIn post in the last seven. That is where
   readers come from, so those are looked at every few hours. */
function hotIds(pubs) {
  const hot = new Set();
  for (const j of pubs) {
    if (now - Number(j.firstSeenAt ?? 0) <= HOT_NEW_MS && announceable(j.category) && !channelRefusal(j)) hot.add(String(j.id));
  }
  try { for (const r of store.db.prepare("SELECT job_id FROM reel_posts WHERE status = 'published' AND finished_at >= ?").all(now - HOT_POST_MS)) hot.add(String(r.job_id)); } catch { /* no reels table */ }
  try { for (const r of store.db.prepare('SELECT job_id FROM post_queue WHERE added_at >= ?').all(now - HOT_POST_MS)) hot.add(String(r.job_id)); } catch { /* no queue table */ }
  return hot;
}

/* Closed on medium evidence ('on' mode): owed one look two days later. */
const rechecks = () => store.db.prepare(`SELECT job_id, title, company, apply_url, first_seen_at, status_confidence, status_reason, closed_at
  FROM jobs WHERE closed_at IS NOT NULL AND next_check_at IS NOT NULL AND next_check_at <= ? AND closed_reason LIKE 'status:%'`).all(now)
  .map((r) => ({ id: String(r.job_id), title: r.title, company: r.company, applyUrl: r.apply_url, firstSeenAt: r.first_seen_at,
    statusConfidence: r.status_confidence, statusReason: r.status_reason, closedAt: r.closed_at, recheck: true, status: 'closed' }));

if (has('--job')) {
  const want = String(arg('--job') ?? '').trim();
  /* An id, or a job page URL whose slug ends in the id. */
  const id = /^(?:ats:|\d+$)/.test(want) ? want : (want.match(/-(\d{6,})\/?(?:[?#].*)?$/)?.[1] ?? want);
  const r = rowOf.get(id) ?? rowOf.get(want);
  if (!r) { console.log(`No job ${want}.`); process.exit(1); }
  const checks = checksFor(store.db, r.job_id);
  const now2 = Date.now();
  const st = decideStatus({ checks, firstSeenAt: r.first_seen_at, now: now2 });
  console.log(`${r.company} — ${r.title}  (${r.job_id})`);
  console.log(`  apply: ${r.apply_url || '(LinkedIn)'}`);
  console.log(`  stored status: ${r.status ?? '(never checked)'}${r.status_confidence != null ? ` · ${Math.round(r.status_confidence * 100)}%` : ''}${r.status_reason ? ` · ${r.status_reason}` : ''}${r.status_at ? ` · ${ist(r.status_at)}` : ''}`);
  console.log(`  status now:    ${st.status} · ${Math.round(st.confidence * 100)}% · ${st.reason}`);
  console.log(`  closed: ${r.closed_at ? `${ist(r.closed_at)} — ${r.closed_reason}` : 'no'}   next check: ${r.next_check_at ? ist(r.next_check_at) : '—'}`);
  console.log(checks.length ? '  checks:' : '  no checks recorded yet');
  for (const c of checks) console.log(`    ${ist(c.at)}  ${c.source.padEnd(8)} ${c.signal.padEnd(15)} ${c.http_status ?? ''}  ${c.detail ?? ''}`);
  store.close();
  process.exit(0);
}

const pubs = published();
const jobs = pubs.map(joined).filter(Boolean);

if (has('--summary')) {
  const by = {};
  for (const j of jobs) by[j.status ?? 'never checked'] = (by[j.status ?? 'never checked'] ?? 0) + 1;
  console.log(`Live jobs by status (${mode} mode):`, by);
  store.close();
  process.exit(0);
}

const hot = hotIds(pubs);
const plan = planTick({ jobs, extra: mode === 'on' ? rechecks() : [], hot, now, linkedinPausedUntil: linkedinPausedUntil(store) });
if (has('--plan')) {
  console.log(`${plan.due} due; this pass: ${plan.employer.length} employer page(s), ${plan.linkedin.length} LinkedIn page(s); ${hot.size} job(s) on the channels.`);
  for (const j of [...plan.employer, ...plan.linkedin]) console.log(`  ${j.kind.padEnd(8)} rank ${j.rank} due ${ist(j.dueAt)}  ${j.company} — ${j.title}`);
  store.close();
  process.exit(0);
}

const res = await runTick(store, { plan, mode, log });
pruneChecks(store.db, now);
const sig = Object.entries(res.bySignal).map(([k, n]) => `${k} ${n}`).join(', ');
log.ok(`Job checks (${mode}): looked at ${res.checked} of ${plan.due} due — open ${res.open}, possibly closed ${res.possibly}, closed ${res.closed}, couldn't check ${res.unknown}`
  + `${res.held ? `, held ${res.held} (per-site cap)` : ''}${res.reopened ? `, reopened ${res.reopened}` : ''}`
  + `${mode !== 'on' && res.shadowWouldClose ? `; would close ${res.shadowWouldClose} more in 'on' mode` : ''}`
  + `${res.linkedinBlocked ? '; LinkedIn paused at a rate limit' : ''}${res.outOfTime ? '; stopped at the time budget' : ''}${sig ? ` [${sig}]` : ''}.`);
store.close();
process.exit(0);
