#!/usr/bin/env node
/**
 * Show what the board currently has to say about itself.
 *
 *   npm run stats                    # India, 30 days
 *   npm run stats -- --days=7        # this week
 *   npm run stats -- --region=US
 *   npm run stats -- --json          # for src/ideate.js to consume
 *
 * Read-only. It runs no model and writes nothing — the facts are query results
 * and this is the window onto them. `--json` is the shape the concept
 * generator will be handed: a fact, not a topic.
 */
import { Store } from '../src/store.js';
import { mineStats, DEFAULT_DAYS } from '../src/statsmine.js';

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));

const region = String(args.region ?? 'IN').toUpperCase();
const days = Number(args.days ?? DEFAULT_DAYS);

const facts = mineStats(new Store(), { region, days });

if (args.json) {
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
} else if (!facts.length) {
  console.log(`\n  Nothing worth saying about ${region} over ${days} days.`);
  console.log('  Every fact is below its minimum sample — a thin stat is a false one,');
  console.log('  so they are dropped rather than softened. Try a longer --days.\n');
} else {
  console.log(`\n  ${region} · last ${days} days · ${facts[0].sample} engineering internships\n`);
  for (const f of facts) {
    console.log(`  ${f.headline}`);
    console.log(`      ${f.detail}`);
    console.log(`      \x1b[90m${f.id} · ${f.value} of ${f.of}\x1b[0m`);
    console.log('');
  }
}
