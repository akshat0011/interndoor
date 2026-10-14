// The nightly public-search recovery slot (src/recovery.js, bin/run.sh): once a
// night, in the quietest hour, both India searches are read on the public
// search over 24h; no signed-in walk runs in that hour. These tests run the
// real slot logic, the real run.sh block in /bin/bash with a stub node, and pin
// the index.js wiring.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { recoverySlot, recoveryDay, recoveryConfig, zonedParts, RECOVERY_KEY } from '../src/recovery.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`); }
};
const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

console.log('\n== the slot ==');
{
  const cfg = { recovery: { enabled: true, hour: 4, timeZone: 'Asia/Kolkata', windowHours: 24 } };
  const at = (iso) => Date.parse(iso);
  // 04:10 IST on 15 Oct is 22:40 UTC on 14 Oct: the day must be IST's.
  check('04:10 IST, not run tonight -> recover', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg, lastDay: null }), 'recover');
  check('04:10 IST, ran tonight -> hold', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg, lastDay: '2026-10-15' }), 'hold');
  check('04:10 IST, last ran the night before -> recover', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg, lastDay: '2026-10-14' }), 'recover');
  check('04:59 IST is still the slot', recoverySlot({ now: at('2026-10-14T23:29:00Z'), cfg, lastDay: '2026-10-15' }), 'hold');
  check('03:59 IST is a normal tick', recoverySlot({ now: at('2026-10-14T22:29:00Z'), cfg, lastDay: null }), 'normal');
  check('05:00 IST is a normal tick', recoverySlot({ now: at('2026-10-14T23:30:00Z'), cfg, lastDay: null }), 'normal');
  check('the day recorded is the IST day', recoveryDay(at('2026-10-14T22:40:00Z'), cfg), '2026-10-15');
  check('zonedParts reads the zone', zonedParts(at('2026-10-14T22:40:00Z'), 'Asia/Kolkata'), { day: '2026-10-15', hour: 4 });
  check('switched off -> normal', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg: { recovery: { ...cfg.recovery, enabled: false } } }), 'normal');
  check('no block -> normal', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg: {} }), 'normal');
  check('a bad hour -> normal', recoverySlot({ now: at('2026-10-14T22:40:00Z'), cfg: { recovery: { enabled: true, hour: 25 } } }), 'normal');
  check('window defaults to 24h', recoveryConfig({ recovery: { enabled: true, hour: 4 } }).windowHours, 24);
  check('the key', RECOVERY_KEY, 'recovery_day');
  const live = JSON.parse(read('config.json')).recovery;
  // OFF since 15 Oct 2026 (his call); a pause must carry its reason, like a paused search.
  check('live config: off, with a written reason', [live.enabled, String(live._off_note ?? '').length > 80], [false, true]);
  check('live config: 04:00 IST, 24h window if turned back on', [live.hour, live.timeZone, live.windowHours], [4, 'Asia/Kolkata', 24]);
  check('live config says why', String(live._note ?? '').length > 80, true);
}

console.log('\n== bin/run.sh, run in /bin/bash with a stub node ==');
{
  const sh = read('bin/run.sh');
  const start = sh.indexOf('# THE NIGHTLY RECOVERY SLOT');
  const end = sh.indexOf('echo "$(date \'+%Y-%m-%d %H:%M:%S\') [EXIT $STATUS]"', start);
  check('the slot block is found before the final EXIT line', start > 0 && end > start, true);
  const block = sh.slice(start, end);
  const dir = mkdtempSync(join(tmpdir(), 'recovery-sh-'));
  const stub = join(dir, 'node');
  writeFileSync(stub, `#!/bin/bash
case "$*" in
  *recovery-slot.js*--done*) echo DONE >> "$CALLS" ;;
  *recovery-slot.js*) echo "noise line"; printf '%s\\n' "$SLOT_OUT" ;;
  *src/index.js*) echo "INDEX $*" >> "$CALLS"; case "$*" in *--kind=intern*) exit "\${INTERN_EXIT:-0}" ;; *) exit "\${FT_EXIT:-0}" ;; esac ;;
esac
`);
  chmodSync(stub, 0o755);
  const script = join(dir, 'block.sh');
  writeFileSync(script, `set -uo pipefail\nNODE="${stub}"\nHERE="${dir}"\nLOG="${join(dir, 'log')}"\nset -- --scheduled\n${block}\necho "STATUS=$STATUS"\n`);
  const run = (env) => {
    const calls = join(dir, `calls-${Math.random().toString(36).slice(2)}`);
    writeFileSync(calls, '');
    const out = execFileSync('/bin/bash', [script], { env: { ...process.env, CALLS: calls, ...env }, encoding: 'utf8' });
    const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    return { status: out.match(/STATUS=(\d+)/)?.[1], index: lines.filter((l) => l.startsWith('INDEX')), done: lines.includes('DONE') };
  };

  const rec = run({ SLOT_OUT: 'recover 24' });
  check('recover: both phases run', rec.index.length, 2);
  check('recover: each on the public search, 24h, as a recovery', rec.index.every((l) => / --recovery --source=guest --window-hours=24/.test(l)), true);
  check('recover: internships first, then full-time', [/--kind=intern/.test(rec.index[0] ?? ''), /--kind=fulltime/.test(rec.index[1] ?? '')], [true, true]);
  check('recover: the scheduler\'s own args still pass through', rec.index.every((l) => /--scheduled/.test(l)), true);
  check('recover: tonight is recorded', rec.done, true);

  const hold = run({ SLOT_OUT: 'hold 24' });
  check('hold: no LinkedIn walk at all', hold.index.length, 0);
  check('hold: a clean status', hold.status, '0');
  check('hold: nothing recorded', hold.done, false);

  const normal = run({ SLOT_OUT: 'normal 24' });
  check('normal: both phases run', normal.index.length, 2);
  check('normal: no recovery flags', normal.index.some((l) => /--recovery|--source=|--window-hours/.test(l)), false);
  check('normal: nothing recorded', normal.done, false);

  const offline = run({ SLOT_OUT: 'recover 24', INTERN_EXIT: '75' });
  check('recover with no network: full-time skipped', offline.index.length, 1);
  check('recover with no network: tried again next tick (not recorded)', offline.done, false);
  check('recover with no network: 75 passed on', offline.status, '75');

  const junk = run({ SLOT_OUT: 'whatever' });
  check('an unreadable answer is a normal tick', [junk.index.length, junk.index.some((l) => /--recovery/.test(l))], [2, false]);
  const odd = run({ SLOT_OUT: 'recover abc' });
  check('a bad window falls back to 24', odd.index.every((l) => /--window-hours=24\b/.test(l)), true);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== src/index.js wiring ==');
{
  const idx = read('src/index.js');
  check('--source=guest|browser is an override', /searchSource: \['guest', 'browser'\]\.includes\(strArg\('source'\)\) \? strArg\('source'\) : null,/.test(idx), true);
  check('the override decides before config', /const sourceFor = \(search = \{\}\) => \{\s*if \(OVERRIDES\.searchSource\) return OVERRIDES\.searchSource;/.test(idx), true);
  check('--recovery is read', /const RECOVERY = ARGS\.has\('--recovery'\);/.test(idx), true);
  const rec = idx.indexOf('if (RECOVERY && reachedEnd && rendered) {');
  const mark = idx.indexOf('store.markRegionSweep(search.sweepKey ?? region, sweepMark);');
  check('a recovery walk is answered before any baseline is written', rec > 0 && mark > rec && /\} else if \(!DRY_RUN && reachedEnd && rendered && sweepMark\) \{\s*store\.markRegionSweep/.test(idx.slice(rec, mark + 80)), true);
  check('a recovery run stays out of the intake alarm', /if \(!RECOVERY\) await noteIntake\(store, \{/.test(idx), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
