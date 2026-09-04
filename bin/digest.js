#!/usr/bin/env node
/**
 * The daily digest, asked on every scan and answered once a day.
 *
 * Same shape as bin/weekly.js: `digestDue` exits immediately unless it is on or
 * after the configured hour in the board's own zone AND today's mail has not
 * gone out. Asked from bin/run.sh rather than cron because this Mac sleeps and
 * a job that fires at 09:00 exactly is simply missed.
 *
 *   node bin/digest.js --dry-run   # compose and print, send nothing, mark nothing
 *   node bin/digest.js --force     # ignore the once-a-day gate
 *   node bin/digest.js --send      # override digest.mode for one run
 *
 * IT CREATES A DRAFT UNTIL TOLD OTHERWISE. `digest.mode` is "draft", so the
 * scheduled path composes the mail and files it in Buttondown for review; the
 * day it becomes "send" is a one-line config change and a deliberate act. And
 * `digest.enabled` is false, so none of this runs at all until switched on —
 * a mail pipeline that starts working the moment it is merged is how strangers
 * get surprised.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { buildDigest, digestDue, dayKey, sendStatus } from '../src/digest.js';
import { regionOf, regionPath, resolveRowRegion } from '../src/regions.js';
import { PATHS } from '../src/paths.js';

try { process.loadEnvFile(join(PATHS.root, '.env')); } catch { /* optional */ }

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const SEND = process.argv.includes('--send');

const SETTING = 'digestDay';
const API = 'https://api.buttondown.email/v1/emails';

const cfg = loadConfig();
const store = new Store();

const code = cfg.digest?.region ?? 'IN';
const region = regionOf(code);
const zone = region?.timeZone ?? 'Asia/Kolkata';
const settingKey = `${SETTING}:${code}`;

if (!FORCE && !DRY_RUN && !digestDue(cfg, store.getSetting(settingKey), Date.now(), code)) process.exit(0);

/* THE SAME GUARD THE CHANNELS LEARNED THE HARD WAY (§12): compose from what
   publish actually WROTE, not from the store, or the mail links to pages that
   were held back. A missing file means we do not know, and the honest answer to
   not knowing is to send nothing rather than to guess. */
function publishedIds() {
  const prefix = regionPath(code);
  const file = join(PATHS.root, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
  if (!existsSync(file)) return null;
  try {
    return new Set((JSON.parse(readFileSync(file, 'utf8')).jobs ?? []).map((j) => String(j.id)));
  } catch (e) {
    log.warn(`Digest: could not read ${file} (${e.message}).`);
    return null;
  }
}

const ids = publishedIds();
if (!ids && !DRY_RUN) {
  log.warn('Digest: no published jobs file — refusing to send rather than link to pages that may not exist.');
  process.exit(0);
}

const since = Date.now() - (cfg.digest?.windowHours ?? 24) * 3_600_000 - 3_600_000;
const rows = store.recentJobs(since).filter((r) => resolveRowRegion(r) === code);
const mail = buildDigest(rows, cfg, { region: code, publishedIds: ids });

if (!mail) {
  /* A quiet day is not a failure, and "0 new internships today" is the message
     that teaches somebody to unsubscribe. The day is still marked done so the
     next scan does not ask again every thirty minutes. */
  log.info(`Digest: nothing new ${region.inName} today — no mail.`);
  if (!DRY_RUN) store.setSetting(settingKey, dayKey(Date.now(), zone));
  process.exit(0);
}

if (DRY_RUN) {
  log.info(`Digest (dry run) — subject: ${mail.subject}`);
  console.log(`\n${mail.body}`);
  process.exit(0);
}

const mode = SEND ? 'send' : (cfg.digest?.mode ?? 'draft');
const apiKey = process.env.BUTTONDOWN_API_KEY;
if (!apiKey) {
  /* Same rule as web/api/subscribe.js and src/websearch.js: a missing key is a
     visible refusal, never a pipeline that appears to work and drops the mail. */
  log.warn('Digest: BUTTONDOWN_API_KEY is not set — composed nothing to send. Add it to .env.');
  process.exit(0);
}

const res = await fetch(API, {
  method: 'POST',
  headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    subject: mail.subject,
    body: mail.body,
    status: sendStatus(mode),
  }),
});

if (!res.ok) {
  log.warn(`Digest: Buttondown refused (${res.status}) — ${(await res.text()).slice(0, 300)}`);
  process.exit(0);
}

store.setSetting(settingKey, dayKey(Date.now(), zone));
log.ok(`Digest: ${mode === 'send' ? 'sent' : 'drafted'} "${mail.subject}" (${mail.shown} of ${mail.count} roles).`);
