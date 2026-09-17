#!/usr/bin/env node
/**
 * The weekly data posts — seven LinkedIn drafts made of counts, each with a
 * card image, written to one page once a week.
 *
 *   node bin/datapost.js            # what bin/run.sh calls after every scan
 *   node bin/datapost.js --force    # write it now, whatever day it is
 *   node bin/datapost.js --dry-run  # print the posts, write nothing, mark nothing
 *
 * `dataPostDue` answers yes once a week — on or after the configured hour on
 * the configured weekday in the board's own zone — so this costs a process
 * start 47 times a day and does real work once. Same shape as bin/weekly.js,
 * for the same reason: this Mac sleeps, and a cron entry would be missed.
 *
 * Nothing here posts anything. The page is a draft to copy from.
 */
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { dataPosts, dataPostDue, dataPostRegions, pickOfWeek } from '../src/datapost.js';
import { renderDataCard, cardId } from '../src/datacard.js';
import { buildDataPage, writeDataPage } from '../src/postpage.js';
import { weekKey } from '../src/weekly.js';
import { notify, open as openFile } from '../src/notify.js';
import { queueBase, queueServerUp } from '../src/postqueue.js';
import { regionOf } from '../src/regions.js';
import { PATHS } from '../src/paths.js';
import { join } from 'node:path';

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_OPEN = process.argv.includes('--no-open');
const SETTING = 'dataPostWeek';

const cfg = loadConfig();
const store = new Store();
const zoneFor = (code) => regionOf(code)?.timeZone ?? 'Asia/Kolkata';
const keyFor = (code) => weekKey(Date.now(), zoneFor(code));
const settingFor = (code) => `${SETTING}:${code}`;

const due = dataPostRegions(cfg).filter((code) => FORCE || DRY_RUN
  || dataPostDue(cfg, store.getSetting(settingFor(code)), Date.now(), code));
if (!due.length) { store.close(); process.exit(0); }

const built = [];
for (const code of due) {
  const bundle = dataPosts(store, cfg, { region: code });
  if (!bundle.posts.length) {
    log.info(`Data posts: too few ${code} rows in the window (${bundle.rows}) — not writing a page of thin numbers.`);
    if (!DRY_RUN && !FORCE) store.setSetting(settingFor(code), keyFor(code));
    continue;
  }
  built.push({ code, bundle, pick: pickOfWeek(bundle.posts, Date.now(), zoneFor(code)) });
}
if (!built.length) { store.close(); process.exit(0); }

if (DRY_RUN) {
  for (const { code, bundle, pick } of built) {
    console.log(`\n${'#'.repeat(70)}\n${code} — ${bundle.rows} rows, ${bundle.employers} employers, pick: ${pick}\n${'#'.repeat(70)}`);
    for (const p of bundle.posts) {
      console.log(`\n${'='.repeat(70)}\n${p.title} [${p.key}]${p.key === pick ? '  ← pick' : ''}\n${'='.repeat(70)}\n${p.post}\n-- ${p.notes}`);
    }
  }
  store.close();
  process.exit(0);
}

/* The cards first, so the page never links an image that is not there. A
   card that fails to render costs that format its image, not the page. */
let file = null;
for (const { code, bundle, pick } of built) {
  const cards = {};
  for (const p of bundle.posts) {
    const id = cardId(p.key, code);
    try {
      const out = await renderDataCard(p.card, join(PATHS.liCards, `${id}.png`));
      if (out) cards[p.key] = id;
    } catch (err) {
      log.warn(`Data post card for ${p.key} (${code}) not rendered — ${err.message}`);
    }
  }
  file = writeDataPage(buildDataPage(bundle, { generatedAt: Date.now(), pick, cards }), `${keyFor(code)}-${code}`);
  /* A FORCED run does not consume the week's slot — the same rule as the
     roundup, for the same reason: a --force on Wednesday must not make the
     scheduled Wednesday skip itself. */
  if (!FORCE) store.setSetting(settingFor(code), keyFor(code));
  log.ok(`Data posts for ${code}: ${bundle.posts.length} formats from ${bundle.rows} rows, pick "${pick}" → ${file}`);
}
store.close();

const first = built[0];
await notify(
  'Data posts ready',
  `${first.bundle.posts.length} formats from ${first.bundle.rows} ${first.code} internships · pick: ${first.pick}`,
  { sound: 'Glass', subtitle: 'One a week is plenty — copy from the page' },
);
if (!NO_OPEN && file) {
  const url = (await queueServerUp(cfg)) ? `${queueBase(cfg)}/data/latest` : file;
  await openFile(url);
}
