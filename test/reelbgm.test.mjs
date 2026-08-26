/**
 * Picking a music bed out of an hour-long track.
 *
 * The renderer used to take atrim=0:<reel length> — always the HEAD of the file
 * it picked. Five tracks meant five beds in existence, repeating two to four
 * times a day at 10-20 Reels, and the head is the worst slice there is: m1's
 * first 11s measures 8.2 dB below its middle, because a long track opens on a
 * fade-in that two-pass loudnorm then drags back up to full bed level.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeSpans, pickBgm, commitBgm, EDGE_SECONDS } from '../src/reelbgm.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== where a clip may start ==');
// No edge margin in these, so the arithmetic is visible on its own.
check('a clean track offers everything but the tail', freeSpans(100, 10, [], 0), [[0, 90]]);
check('a track shorter than the clip offers nothing', freeSpans(5, 10, [], 0), []);
check('a track exactly the clip length offers nothing', freeSpans(10, 10, [], 0), []);

// A start s overlaps a used span [a,b] when s < b AND s + need > a, so the
// BLOCKED range of starts is (a - need, b) — not (a, b). Getting this wrong
// lets a new clip overlap the tail of an old one: the same repetition, only
// harder to notice.
check('a used span blocks need seconds BEFORE it too',
  freeSpans(100, 10, [[40, 50]], 0), [[0, 30], [50, 90]]);
check('not merely the span itself',
  freeSpans(100, 10, [[40, 50]], 0)[0][1] === 40, false);
check('touching spans merge', freeSpans(100, 10, [[20, 30], [30, 40]], 0), [[0, 10], [40, 90]]);
check('overlapping spans merge', freeSpans(100, 10, [[20, 40], [30, 50]], 0), [[0, 10], [50, 90]]);
check('out-of-order spans still merge', freeSpans(100, 10, [[60, 70], [20, 30]], 0), [[0, 10], [30, 50], [70, 90]]);
check('a fully used track offers nothing', freeSpans(100, 10, [[0, 100]], 0), []);

console.log('\n== the edge margin ==');
// Long tracks fade in and out, and a bed normalised to a fixed loudness turns a
// fade into hiss at full level.
check('the head and tail are skipped', freeSpans(3600, 11, [], 20), [[20, 3569]]);
check('the default margin is 20s', EDGE_SECONDS, 20);
// The margin is capped at half the runway so a short track shrinks its edges
// rather than inverting them.
check('a shorter track still keeps a middle', freeSpans(60, 10, [], 20), [[20, 30]]);
// 30s needing 10s is only 20s of runway; 20s margins leave nothing, and there
// genuinely is nowhere to start — the caller falls back rather than inverting.
check('too little runway yields nothing', freeSpans(30, 10, [], 20), []);
check('and never inverts', freeSpans(12, 10, [], 20), []);

console.log('\n== picking ==');
const seed = (n) => { let i = 0; return () => n[i++ % n.length]; };

/**
 * A folder of placeholder files plus a matching index, so nothing shells out to
 * ffprobe. The index key must be built from the REAL stat or indexTracks sees a
 * mismatch, re-probes a 1-byte file and records an error instead.
 */
function fakeLibrary(prefix, tracks, usage = { last: null, used: {} }) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  const index = {};
  for (const [name, seconds] of Object.entries(tracks)) {
    writeFileSync(join(d, name), 'x');
    const st = statSync(join(d, name));
    index[name] = seconds === null
      ? { key: [st.size, Math.floor(st.mtimeMs)], error: 'not audio' }
      : { key: [st.size, Math.floor(st.mtimeMs)], seconds };
  }
  writeFileSync(join(d, 'index.json'), JSON.stringify(index));
  writeFileSync(join(d, 'usage.json'), JSON.stringify(usage));
  return { dir: d, indexPath: join(d, 'index.json'), usagePath: join(d, 'usage.json') };
}

const lib = fakeLibrary('bgm-', { 'm1.mp3': 3600, 'm2.mp3': 3600, 'm3.mp3': 3600 });
const dir = lib.dir, idx = lib.indexPath, use = lib.usagePath;

const first = pickBgm({ dir, need: 11, indexPath: idx, usagePath: use, rng: seed([0.5, 0.5, 0.5]) });
check('it picks something', first !== null, true);
check('and not from the very start of the file', first.start >= EDGE_SECONDS, true);
check('and leaves room for the whole bed', first.start + 11 <= first.seconds, true);
check('it is not flagged as a repeat', first.reused, false);

console.log('\n== the same span is not handed out twice ==');
commitBgm(use, { name: first.name, start: first.start, need: 11 });
const state = JSON.parse(readFileSync(use, 'utf8'));
check('the span was recorded', state.used[first.name].length, 1);
check('and the track is remembered as last', state.last, first.name);

// Force the SAME track by leaving only one, then check the used span is avoided.
const s1 = fakeLibrary('bgm1-', { 'only.mp3': 200 }, { last: null, used: { 'only.mp3': [[20, 31]] } });
const solo = s1.dir;
const avoid = pickBgm({ ...s1, need: 11, rng: seed([0, 0, 0]) });
check('a used span is skipped', avoid.start >= 31 || avoid.start + 11 <= 20, true);

console.log('\n== the same track is not used twice running ==');
const r1 = fakeLibrary('bgm2-', { 'a.mp3': 3600, 'b.mp3': 3600 }, { last: 'a.mp3', used: {} });
const rot = r1.dir;
check('the last track is avoided', pickBgm({ ...r1, need: 11, rng: seed([0, 0, 0]) }).name, 'b.mp3');
// Unless it is the only one left — a bed must never fail to be chosen.
const r2 = fakeLibrary('bgm2b-', { 'a.mp3': 3600 }, { last: 'a.mp3', used: {} });
check('unless it is the only one', pickBgm({ ...r2, need: 11, rng: seed([0, 0, 0]) }).name, 'a.mp3');

console.log('\n== degrade, never throw ==');
const empty = mkdtempSync(join(tmpdir(), 'bgm3-'));
check('an empty folder yields no bed',
  pickBgm({ dir: empty, need: 11, indexPath: join(empty, 'i.json'), usagePath: join(empty, 'u.json') }), null);
check('a missing folder yields no bed',
  pickBgm({ dir: join(empty, 'nope'), need: 11, indexPath: join(empty, 'i.json'), usagePath: join(empty, 'u.json') }), null);
// Every track shorter than the reel.
const sh = fakeLibrary('bgm4-', { 's.mp3': 4 });
const shortDir = sh.dir;
check('a track shorter than the reel is refused', pickBgm({ ...sh, need: 11 }), null);
// An unreadable file is reported and skipped, not thrown.
const bad = fakeLibrary('bgm5-', { 'bad.mp3': null, 'good.mp3': 3600 });
const badDir = bad.dir;
const warns = [];
const survived = pickBgm({ ...bad, need: 11, rng: seed([0, 0, 0]), onWarn: (m) => warns.push(m) });
check('a bad file is skipped, not fatal', survived.name, 'good.mp3');
check('and it is reported', warns.some((w) => w.includes('bad.mp3')), true);

console.log('\n== an exhausted pool says so ==');
const dd = fakeLibrary('bgm6-', { 'only.mp3': 100 }, { last: null, used: { 'only.mp3': [[0, 100]] } });
const dry = dd.dir;
const dryWarns = [];
const repeat = pickBgm({ ...dd, need: 11, rng: seed([0, 0, 0]), onWarn: (m) => dryWarns.push(m) });
check('it still returns a bed', repeat !== null, true);
check('flagged as a repeat', repeat.reused, true);
check('and it warns rather than repeating quietly', dryWarns.some((w) => /repeat/i.test(w)), true);

for (const d of [dir, solo, rot, r2.dir, empty, shortDir, badDir, dry]) rmSync(d, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
