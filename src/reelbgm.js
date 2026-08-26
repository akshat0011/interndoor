/**
 * Choosing an 11-second music bed out of an hour-long track.
 *
 * The first version took `atrim=0:<reel length>` — always the HEAD of whichever
 * file it picked. With five tracks that is five distinct beds in existence, and
 * at 10-20 Reels a day the same eleven seconds comes round two to four times a
 * day. The head is also the worst slice to take: measured over the real files,
 * m1's first 11s is **8.2 dB quieter than its middle** (-20.1 dB against -11.9),
 * because a long track opens on a fade-in. Two-pass loudnorm then drags that
 * intro up to the same target as everything else, so what a viewer hears is the
 * sparsest part of the track at full bed level.
 *
 * The five files hold ~18,500s between them, so at 11s a reel there are roughly
 * 1,680 distinct beds available — about 84 days at 20 a day before anything has
 * to repeat. This module is what spends that pool evenly instead of using 0.06%
 * of it.
 *
 * Ported from storygasted's `backgrounds.py`, which solves the same problem for
 * video B-roll: index the files, remember which spans have been used, prefer a
 * different file from last time, weight the choice by how much unused material
 * each file still has, and say so out loud when the pool is exhausted rather
 * than silently repeating.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Audio the renderer can actually mux. */
const AUDIO = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

/**
 * Seconds skipped at each end of a track.
 *
 * Long ambient tracks fade in and fade out, and a bed normalised to a fixed
 * loudness turns a fade into hiss at full level. 20s clears the intro on all
 * five files measured. It is not a fix for a track that is quiet throughout —
 * nothing here is — it just stops the pool being seeded with its worst slices.
 */
export const EDGE_SECONDS = 20;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
}

/**
 * Where a clip of `need` seconds may START, given the spans already used.
 *
 * A start `s` overlaps a used span `[a, b]` whenever `s < b` and `s + need > a`
 * — so the blocked range of STARTS is `(a - need, b)`, not `(a, b)`. Getting
 * that wrong lets a new clip overlap the tail of an old one, which is the same
 * repetition this module exists to avoid, only harder to notice.
 *
 * Exported for the tests; the arithmetic is the whole of the correctness here.
 */
export function freeSpans(duration, need, used = [], edge = EDGE_SECONDS) {
  // `usable` is the last valid start, before margins. The margin is capped at
  // half of it so a short track shrinks its edges rather than inverting them —
  // and if even that leaves no runway, there is genuinely nowhere to start and
  // the caller falls back.
  const usable = duration - need;
  if (usable <= 0) return [];
  const lo = Math.min(edge, usable / 2);
  const hi = usable - lo;
  if (hi <= lo) return [];

  const blocked = used
    .filter(([a, b]) => b > 0 && a - need < hi && b > lo)
    .map(([a, b]) => [Math.max(lo, a - need), Math.min(hi, b)])
    .sort((x, y) => x[0] - y[0]);

  const free = [];
  let at = lo;
  for (const [a, b] of blocked) {
    if (a > at) free.push([at, Math.min(a, hi)]);
    at = Math.max(at, b);
    if (at >= hi) break;
  }
  if (at < hi) free.push([at, hi]);
  return free.filter(([a, b]) => b > a);
}

/**
 * Duration of every track in the folder, cached on size and mtime.
 *
 * ffprobe on five ~90 MB files is not free, and this runs once per reel at
 * 10-20 a day. A file that has been replaced under the same name changes size
 * or mtime, so the cache cannot go stale silently.
 *
 * An unreadable file is recorded with its error and skipped rather than
 * throwing: one bad MP3 must never stop a render, for the same reason an empty
 * folder does not.
 */
export function indexTracks(dir, indexPath) {
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter((f) => AUDIO.test(f)).sort();
  const old = readJson(indexPath, {});
  const out = {};
  for (const name of files) {
    const st = statSync(join(dir, name));
    const key = [st.size, Math.floor(st.mtimeMs)];
    const prev = old[name];
    if (prev && Array.isArray(prev.key) && prev.key[0] === key[0] && prev.key[1] === key[1]) {
      out[name] = prev;
      continue;
    }
    try {
      const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', join(dir, name)], { encoding: 'utf8' });
      const seconds = Number(String(raw).trim());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('no duration');
      out[name] = { key, seconds };
    } catch (err) {
      out[name] = { key, error: String(err.message).slice(0, 120) };
    }
  }
  if (JSON.stringify(out) !== JSON.stringify(old)) writeJson(indexPath, out);
  return out;
}

/**
 * Pick a track and a start offset for a bed of `need` seconds.
 *
 * Returns null when there is nothing usable — an empty folder, or every file
 * shorter than the reel. A missing bed must never fail a render, so the caller
 * simply renders without music.
 *
 * `rng` is injected so the tests are deterministic. Everything else about the
 * choice is deliberately random: a rotation in file order would put the same
 * track under every reel posted in the same hour.
 */
export function pickBgm({ dir, need, indexPath, usagePath, rng = Math.random, onWarn = () => {} }) {
  const index = indexTracks(dir, indexPath);
  for (const [name, v] of Object.entries(index)) {
    if (v.error) onWarn(`skipping ${name}: ${v.error}`);
  }

  const ok = Object.entries(index).filter(([, v]) => !v.error && v.seconds > need);
  if (!ok.length) return null;

  const state = readJson(usagePath, { last: null, used: {} });
  const used = state.used ?? {};

  // Never the same track twice running, when there is another to choose. The
  // spans below already stop the same MUSIC repeating; this stops two reels
  // posted back to back sharing a texture, which is the thing a viewer
  // scrolling a feed actually notices.
  let candidates = ok;
  if (candidates.length > 1 && state.last) {
    const others = candidates.filter(([name]) => name !== state.last);
    if (others.length) candidates = others;
  }

  const spans = candidates
    .map(([name, v]) => ({ name, seconds: v.seconds, free: freeSpans(v.seconds, need, used[name] ?? []) }))
    .filter((t) => t.free.length);

  if (spans.length) {
    // Weighted by how much unused material each track still holds, so the pool
    // drains evenly instead of exhausting the shortest file first.
    const track = weighted(spans, (t) => total(t.free), rng);
    const span = weighted(track.free, ([a, b]) => b - a, rng);
    const start = span[0] + rng() * (span[1] - span[0]);
    return { file: join(dir, track.name), name: track.name, seconds: track.seconds, start: round(start), need, reused: false };
  }

  // Everything has been used. Say so — a bed silently repeating is exactly the
  // failure this module was written for, and it must not come back quietly.
  onWarn('every music span has been used — starting to repeat');
  const [name, v] = candidates.reduce((a, b) => ((used[a[0]]?.length ?? 0) <= (used[b[0]]?.length ?? 0) ? a : b));
  const hi = Math.max(0, v.seconds - need);
  return { file: join(dir, name), name, seconds: v.seconds, start: round(rng() * hi), need, reused: true };
}

/** Record a span as used. Called only after a render actually succeeds. */
export function commitBgm(usagePath, choice) {
  if (!choice) return;
  const state = readJson(usagePath, { last: null, used: {} });
  state.used ??= {};
  (state.used[choice.name] ??= []).push([choice.start, round(choice.start + choice.need)]);
  state.last = choice.name;
  writeJson(usagePath, state);
}

const total = (spans) => spans.reduce((n, [a, b]) => n + (b - a), 0);
const round = (n) => Math.round(n * 1000) / 1000;

function weighted(items, weightOf, rng) {
  const weights = items.map(weightOf);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return items[Math.floor(rng() * items.length)];
  let r = rng() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
