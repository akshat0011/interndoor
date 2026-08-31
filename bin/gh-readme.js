#!/usr/bin/env node
/**
 * Build (and publish) the README for the public GitHub internship list.
 *
 *   node bin/gh-readme.js                     India, to stdout
 *   node bin/gh-readme.js --region=US
 *   node bin/gh-readme.js --out path/README.md
 *   node bin/gh-readme.js --daily             what bin/run.sh calls
 *   node bin/gh-readme.js --daily --force     ignore today's marker
 *
 * DAILY, ASKED EVERY SCAN. bin/run.sh invokes this on all 48 slots and it
 * answers once — the same shape as the weekly roundup and the discovery sweep,
 * and for the same reason those are not cron entries: this Mac is asleep for
 * large parts of the day, so a job firing at a fixed hour is simply missed,
 * while this lands on the first scan after it wakes.
 *
 * Not per publish. The README is deterministic and would usually be identical,
 * but the repo's history is PUBLIC and asking 48 times a day is noise even when
 * the answer is "nothing changed". Daily is also a claim that can always be
 * met; the README itself says "Updated Daily".
 *
 * NOTHING HERE MAY FAIL A SCAN. Every failure path logs and exits 0, and
 * run.sh discards the status anyway.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { ROOT, PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { renderReadme } from '../src/ghreadme.js';
import { regionOf, regionPath } from '../src/regions.js';
import { log } from '../src/logger.js';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const valueOf = (f, d = null) => {
  const hit = ARGS.find((a) => a.startsWith(`${f}=`));
  if (hit) return hit.slice(f.length + 1);
  const i = ARGS.indexOf(f);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('-') ? ARGS[i + 1] : d;
};

const DAILY = has('--daily');
const FORCE = has('--force');
const cfg = loadConfig();
const conf = cfg.github ?? {};
const CODE = String(valueOf('--region', conf.region ?? 'IN')).toUpperCase();
const OUT = valueOf('--out');

const region = regionOf(CODE);
if (!region) { console.error(`Unknown region ${CODE}`); process.exit(1); }

/* ---- the daily gate ---------------------------------------------------- */
const SETTING = `ghReadmeDay:${CODE}`;
const MISSING_NOTICE = `ghReadmeMissingDay:${CODE}`;
let store = null;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

if (DAILY) {
  if (conf.enabled === false) process.exit(0);
  store = new Store();
  if (!FORCE && store.getSetting(SETTING) === today) { store.close(); process.exit(0); }
}

const done = (mark = true) => {
  if (store) { if (mark) store.setSetting(SETTING, today); store.close(); }
  process.exit(0);
};

/* ---- render ------------------------------------------------------------ */
const file = join(ROOT, 'web', 'public', regionPath(CODE), 'data', 'jobs.json');
const jobsRaw = JSON.parse(readFileSync(file, 'utf8'));
const jobs = jobsRaw.jobs ?? jobsRaw;
const md = renderReadme(jobs, CODE);

if (!DAILY && !OUT) { process.stdout.write(md); process.exit(0); }

const target = OUT ?? join(PATHS.ghList, 'README.md');

/* A missing checkout is reported ONCE A DAY, and does NOT mark the day done —
   the same split the discovery sweep makes for a missing API key. Marking it
   would mean cloning the repo at noon buys nothing until tomorrow. */
if (DAILY && !existsSync(join(PATHS.ghList, '.git'))) {
  if (!store || store.getSetting(MISSING_NOTICE) !== today) {
    log.info(`GitHub list: no checkout at ${PATHS.ghList} — nothing published. `
      + `Clone ${conf.repo ?? 'the repo'} there to switch it on.`);
    store?.setSetting(MISSING_NOTICE, today);
  }
  done(false);
}

mkdirSync(dirname(target), { recursive: true });

/* THE COMMIT ONLY HAPPENS WHEN THE CONTENT MOVED. renderReadme is deterministic
   precisely so this comparison is meaningful: an unchanged board produces a
   byte-identical file, so a commit in that repo always means the board changed. */
const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
if (before === md) {
  log.info(`GitHub list: ${region.name} unchanged (${jobs.length} roles) — nothing committed.`);
  done();
}
writeFileSync(target, md);

if (OUT && !DAILY) {
  console.error(`${region.name}: ${jobs.length} roles -> ${target}`);
  process.exit(0);
}

/* ---- commit and push --------------------------------------------------- */
const git = (...args) => execFileSync('git', ['-C', PATHS.ghList, ...args], { encoding: 'utf8' });
try {
  git('add', 'README.md');
  if (!git('status', '--porcelain', 'README.md').trim()) { log.info('GitHub list: nothing staged.'); done(); }
  const companies = new Set(jobs.map((j) => j.company).filter(Boolean)).size;
  /* No AI co-author trailer, the same rule this project's own commits follow. */
  git('commit', '-m', `${jobs.length} live internships from ${companies} companies`);
  git('push', 'origin', 'HEAD');
  log.ok(`GitHub list: pushed ${jobs.length} ${region.name} roles to ${conf.repo ?? 'origin'}.`);
} catch (err) {
  const msg = String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0] ?? err.message;
  log.warn(`GitHub list: could not publish — ${msg}`);
  /* Not marked done, so the next scan retries. A push that failed on a network
     blip should not cost a whole day. */
  done(false);
}
done();
