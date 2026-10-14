#!/usr/bin/env node
/**
 * Asked by bin/run.sh once per tick: is this the nightly recovery slot?
 * (src/recovery.js). Prints one line, "<slot> <windowHours>", and nothing else
 * on stdout, so the shell can read it.
 *
 *   node bin/recovery-slot.js          -> "recover 24" | "hold 24" | "normal 24"
 *   node bin/recovery-slot.js --done   -> records tonight's recovery as run
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { recoverySlot, recoveryDay, recoveryConfig, RECOVERY_KEY } from '../src/recovery.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The raw file, not loadConfig(): only the recovery block is needed, and
// nothing here may print to stdout before the answer.
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const store = new Store();
const now = Date.now();

if (process.argv.includes('--done')) {
  store.setSetting(RECOVERY_KEY, recoveryDay(now, cfg));
} else {
  const slot = recoverySlot({ now, cfg, lastDay: store.getSetting(RECOVERY_KEY) });
  process.stdout.write(`${slot} ${recoveryConfig(cfg)?.windowHours ?? 24}\n`);
}
