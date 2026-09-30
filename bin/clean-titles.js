#!/usr/bin/env node
/**
 * Read a clean title and a discipline for every live posting not read yet.
 * See src/titles.js. Each scan reads its own new postings; this is the rest of
 * the store, and it is resumable — a posting is marked read the moment it is,
 * so stopping and starting again carries on where it left off.
 *
 *   node bin/clean-titles.js                 every published board
 *   node bin/clean-titles.js --region=IN     one board first
 *   node bin/clean-titles.js --minutes=30    a wall-clock budget
 *
 * ~1.5 s a posting on this Mac. It shares Ollama with the scans, so a scan
 * running at the same time is slower, not broken. Nothing is published here:
 * the next scan's publish carries the titles.
 */
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { cleanTitles } from '../src/ollama.js';
import { titleTargets, saveTitleReading } from '../src/titles.js';
import { publishedRegions } from '../src/regions.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const cfg = loadConfig();
const regions = arg('region') ? arg('region').split(',').map((s) => s.trim().toUpperCase()) : publishedRegions(cfg).map((r) => r.code);
const minutes = Number(arg('minutes') ?? 600);
const deadline = Date.now() + minutes * 60_000;
const BATCH = 50;

const store = new Store();
let read = 0;
try {
  for (;;) {
    const left = (deadline - Date.now()) / 60_000;
    if (left <= 0) { console.log('Budget spent — run again to carry on.'); break; }
    const rows = titleTargets(store.db, regions, BATCH);
    if (!rows.length) { console.log('Every live posting on those boards has been read.'); break; }
    const results = await cleanTitles(rows, cfg, { budgetMinutes: left });
    if (!results.size) { console.log('The model answered none of this batch — stopping rather than looping.'); break; }
    for (const [i, r] of results) saveTitleReading(store.db, rows[i].job_id, r);
    read += results.size;
    console.log(`${read} read so far.`);
  }
} finally {
  store.close();
}
