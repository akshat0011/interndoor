#!/usr/bin/env node
/**
 * Render one 1080x1920 reel from a published job row.
 *
 *   npm run reel                          # newest India job that has bullets
 *   npm run reel -- --job=4457471044
 *   npm run reel -- --region=US --out=/tmp/x.mp4
 *   npm run reel -- --format=D            # the emptiest fresh queue on the board
 *   npm run reel -- --job=X --format=A    # force "company is hiring"
 *
 * --format is A ("company is hiring"), D ("hidden opportunity") or auto.
 * AUTO IS THE DEFAULT and lets the posting decide: a fresh row with almost no
 * applicants becomes Format D, everything else stays Format A. That is what
 * lets the one press in the run report keep producing the right reel without a
 * second button beside it. src/reelformat.js holds the rules, including why a
 * stale applicant count disqualifies a posting outright.
 *
 * WHY IT READS jobs.json AND NOT THE DATABASE
 * -------------------------------------------
 * The public projection has already been through every cleaning rule the
 * site uses — stipend/duration filtering, the local logo path, sentence-cased
 * bullets, the collapsed location. Re-deriving any of that from the raw
 * columns would mean a reel could state something the job page does not, and
 * the two would drift the first time either side was fixed. Same reason
 * publish re-derives the region rather than trusting the stored one.
 *
 * WHY IT USES PLAYWRIGHT'S CHROMIUM AND NEVER BRAVE
 * -------------------------------------------------
 * launchBrave() clears and claims the shared Brave profile on its way in, so
 * a reel render would kill a scrape that was mid-flight. This process must
 * never be able to touch the scraper, so it launches the Chromium in
 * Playwright's own cache instead.
 *
 * HOW SEEKING WORKS
 * -----------------
 * The card animates with ordinary CSS @keyframes. Nothing is driven by a JS
 * timer, so every animation is a real Animation object and can be positioned
 * exactly with currentTime. Frame n is therefore a pure function of n, which
 * is what makes a render reproducible and resumable.
 */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { scriptText, reelScript } from '../src/reelscript.js';
import { PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { durationText, modeText } from '../src/pages.js';
import { pickBgm, commitBgm } from '../src/reelbgm.js';
import { captionsFor } from '../src/reelcaptions.js';
import { formatFor, formatDCandidates, formatDRefusal, formatDConfig, countAgeHours } from '../src/reelformat.js';

const cfg = loadConfig();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = join(ROOT, 'web', 'reel-card.html');
const PUBLIC = join(ROOT, 'web', 'public');

/* All video lives in the app's state directory, beside posts/ and reports/.
   NOT in the repo (app/ is public and these are generated artefacts) and NOT
   on the Desktop — see the TCC note in src/paths.js: a render spawned by
   launchd gets no grant for ~/Desktop and would fail silently. Coming from
   PATHS also means a rename of the app id carries these along for free. */
const BGM_DIR = PATHS.reelsBgm;
const WORK = PATHS.reelsWork;
const OUT_DIR = PATHS.reelsOut;
const STORYGASTED = join(homedir(), 'Desktop', 'projects', 'storygasted');

/* Speech from Qwen3-TTS is slower than reel pacing — measured at about 1.7
   words a second raw, against the 2.1 a listener expects. storygasted solves
   this the same way, with atempo after generation rather than the model's own
   coarse speed presets. */
/**
 * How much the voiceover is sped up after synthesis.
 *
 * Raw Qwen3-TTS runs about 1.7 words/second. 1.25x put that at ~2.1 w/s, which
 * was the number a reel listener was assumed to expect — and watching a real
 * one back, it is still too slow for the format. 1.5x is ~2.55 w/s, which sits
 * in the ordinary range for Reels narration.
 *
 * The last scene is what limits this: the CTA reads out a domain, and a URL
 * spoken too fast is a URL nobody can type. If it needs to go faster than
 * ~1.6x, shorten the script instead — see src/reelscript.js.
 */
const VO_TEMPO = Number(process.env.REEL_VO_TEMPO || cfg.reels?.voiceTempo || 1.15);

/** Overridden by `reels.voiceInstruct`. See the note where it is used. */
const DEFAULT_INSTRUCT = 'An upbeat young presenter announcing a job opening to students. '
  + 'Bright, confident and energetic, with the quick forward pace of a short social promo. '
  + 'Keep the momentum up throughout, do not dwell on any word, and take no long pauses.';

/* A tail after the voice ends, so the CTA is on screen in silence for a beat
   rather than cutting the instant the last word lands. */
const TAIL = 0.9;

/** Shortest reel worth making. Overridden by `reels.minSeconds`. */
const MIN_SECONDS = Number(cfg.reels?.minSeconds || 10);

/* Playwright-core ships no browsers. The Chromium in the shared cache is the
   one the scraper's own install put there; resolve it explicitly so a missing
   download fails with a sentence rather than a stack trace. */
function chromiumPath() {
  const base = join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter(d => d.startsWith('chromium-'));
  for (const d of dirs.sort().reverse()) {
    const p = join(base, d, 'chrome-mac-arm64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return null;
}

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));

const REGION = String(args.region || 'IN').toUpperCase();
const FPS = Number(args.fps || 30);
const CRF = Number(args.crf || 19);

/* Which reel this is. 'auto' lets the POSTING decide — a fresh row with an
   empty queue becomes Format D and everything else stays Format A — which is
   what makes the existing one-press button in the run report produce the right
   reel without a second button beside it. See src/reelformat.js. */
const WANT_FORMAT = String(args.format || 'auto');

/* Where the music sits, as an ABSOLUTE loudness target in LUFS — not as a
   cut in dB from wherever the file happened to be mastered.
   
   That distinction is the whole point. A fixed "-26 dB" makes the result
   depend entirely on the track: a quiet master lands inaudible (measured at
   -58 dB with a quiet source) while a loud one competes with the voice. With
   five arbitrary MP3s dropped in a folder, the level has to be measured and
   set, exactly as it is for the voice.

   The voice is levelled to -14 LUFS, so -32 puts the music 18 LU under it —
   present, never competing. Tune with `--bgm-lufs`: -30 for something sparse
   and ambient, -36 for a track with a strong melody or any vocal. Judge it on
   a phone speaker, not on laptop speakers. */
const BGM_LUFS = Number(args['bgm-lufs'] ?? -32);
const VO_LUFS = -14;

/* India is served at the root; every other region sits under its slug. Mirrors
   regionPath() in src/regions.js, which returns '' for IN. */
function dataFile(region) {
  const slug = region === 'IN' ? '' : region === 'GB' ? 'uk' : region.toLowerCase();
  return join(PUBLIC, slug, 'data', 'jobs.json');
}

/* ---------- picking a job ---------- */

function loadJobs(region) {
  const f = dataFile(region);
  if (!existsSync(f)) {
    fail(`no published data for ${region}\n  looked for ${f}\n  fix: run a publish, or pass --region=IN`);
  }
  return JSON.parse(readFileSync(f, 'utf8')).jobs || [];
}

function pickJob(jobs) {
  if (args.job) {
    const j = jobs.find(x => String(x.id) === String(args.job));
    if (!j) fail(`job ${args.job} is not in the published ${REGION} data`);
    return j;
  }
  /* --format=D with no --job means "make one of these", so the format picks
     the posting rather than the other way round: the emptiest queue that was
     read most recently. Deliberately NOT the newest posting, which is what a
     Format A run wants. */
  if (WANT_FORMAT.toUpperCase() === 'D') {
    const c = formatDCandidates(jobs, cfg);
    if (!c.length) fail(coldPoolMessage(jobs));
    return c[0];
  }
  /* Bullets are what scene 4 is made of, and 98% of India rows have them, so
     requiring them costs almost nothing and avoids rendering an empty scene. */
  const usable = jobs.filter(j => Array.isArray(j.bullets) && j.bullets.length >= 2);
  if (!usable.length) fail(`no ${REGION} job has bullets yet`);
  return usable.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))[0];
}

/**
 * Why there is nothing to make a Format D reel out of.
 *
 * An empty pool is the ORDINARY state, not a fault: the count has to be fresh
 * for the claim to be true, and fresh readings arrive a couple a day. "No job
 * qualifies" would send you looking for a bug, so this names the nearest miss
 * and how stale it is — which is almost always the answer.
 */
function coldPoolMessage(jobs) {
  const c = formatDConfig(cfg);
  const near = jobs
    .filter(j => formatDRefusal(j, cfg)?.startsWith('the count is stale'))
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0];
  const lines = [`no ${REGION} posting qualifies for a Format D reel right now`,
    `  it needs ${c.maxApplicants} applicants or fewer, read in the last ${c.maxCountAgeHours}h`];
  if (near) {
    lines.push(`  nearest: ${near.company} — ${formatDRefusal(near, cfg)}`);
    lines.push(`  fix: wait for the next scan, or raise reels.formatD.maxCountAgeHours`);
  } else {
    lines.push(`  fix: wait for a scan to bring in a posting with a short queue`);
  }
  return lines.join('\n');
}

/* ---------- shaping it for the card ---------- */

/** "₹0" and a bare "2,026" both reach this field. Print money only when it
 *  reads as money AND is a number somebody could live on. */
const CURRENCY = { IN: '\u20b9', US: '$', GB: '\u00a3' };

function stipend(job) {
  const raw = String(job.stipend ?? '').trim();
  const none = { text: null, amount: null, period: null };
  if (!raw) return none;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  /* Rejects "\u20b90" (a real stored value) and the stray "2,026" that a
     copyright year leaves in the money slot. Below a thousand is not a
     monthly stipend in any currency this site publishes. */
  if (!Number.isFinite(n) || n < 1000) return none;
  const pm = raw.match(/\b(month|year|week|hour|annum)\b/i);
  const sym = (raw.match(/^[^\d\s]+/) || [''])[0] || CURRENCY[REGION] || '';
  return {
    amount: n,
    period: pm ? pm[1].toLowerCase() : null,
    text: sym + n.toLocaleString(REGION === 'IN' ? 'en-IN' : 'en-US')
  };
}

/** "47 people clicked apply" / "7 applicants" / "Over 100 applicants". */
function applicants(job) {
  const raw = String(job.applicants ?? '').trim();
  if (!raw) return { text: null, zero: false, count: null };

  /* A STALE READING MAKES NO SCARCITY CLAIM, IN ANY FORMAT.
     `applicants` is frozen at scrape time and nothing refreshes it — only about
     4% of LinkedIn rows are ever re-seen a day later — so "nobody's applied
     yet" on a week-old posting is a claim about a week-old number, and that is
     the `posted_text` failure again. Format D has refused to exist without a
     fresh reading since it was built; the ordinary format had NO such gate and
     said it anyway.
     It matters far more now that reels.auto.maxAgeHours reaches back a week
     rather than two days: before, almost everything was fresh by accident.
     Dropping the text as well as the count is deliberate — "47 applied" on a
     seven-day-old row is the same stale claim, only quieter. */
  if (countAgeHours(job) > formatDConfig(cfg).maxCountAgeHours) {
    return { text: null, zero: false, count: null };
  }
  /* "Over 100 applicants" must not reach a numeric band: CAST of it is 0,
     which would read as "nobody has applied". */
  if (/^over\s/i.test(raw)) return { text: raw.replace(/\s*applicants?$/i, '') + ' applied', zero: false, count: null };
  const m = raw.match(/^(\d+)/);
  if (!m) return { text: null, zero: false, count: null };
  const n = Number(m[1]);
  return { text: `${n} applied`, zero: n === 0, count: n };
}

/** The city alone. The state and the country are the two least useful words
 *  on a card — same rule cityOf() applies on the board. */
function city(job) {
  const parts = String(job.location ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return parts[0] || '';
}

function age(job) {
  if (!job.postedAt) return 'Live';
  const h = (Date.now() - job.postedAt) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The card is loaded over file://, so a "/logos/x.jpg" href would resolve
 *  against the filesystem root and 404. Inlining sidesteps path handling
 *  entirely and means the render never depends on a CDN that expires. */
function logoDataUri(job) {
  if (!job.logo) return null;
  const f = join(PUBLIC, job.logo.replace(/^\//, ''));
  if (!existsSync(f)) return null;
  const mime = extname(f) === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(f).toString('base64')}`;
}

function shape(job, format) {
  const s = stipend(job);
  const a = applicants(job);
  return {
    /* The card and the script both branch on this: Format D withholds the
       employer until the second scene, so the two have to agree on which reel
       they are making or the voice describes a frame that is not there. */
    format,
    company: job.company,
    title: job.title,
    city: city(job),
    stipendText: s.text,
    stipendAmount: s.amount,
    stipendPeriod: s.period,
    currency: CURRENCY[REGION] || '\u20b9',
    /* Through the site's own filter. `duration` is dirty in the store — it
       holds "0 to 1 years" and "0-11 months", which are EXPERIENCE
       requirements that landed in the duration slot — and pages.js already
       refuses to print those, so a reel was stating something its own job
       page would not. */
    duration: durationText(job) || null,
    mode: modeText(job) || null,
    applicantsText: a.text,
    zeroApplicants: a.zero,
    applicantsCount: a.count,
    logo: logoDataUri(job),
    ageText: age(job)
  };
}


/* ---------- voice ---------- */

/** Duration of any media file, via ffprobe. */
function probeSeconds(f) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', f], { encoding: 'utf8' });
  return Number(String(out).trim());
}

/**
 * Synthesise the voiceover with storygasted's MLX Qwen3-TTS, then speed it up.
 *
 * It runs in storygasted's own venv because that is where mlx-audio and the
 * weights live; bin/tts_once.py is the adapter and prints one JSON line.
 * Roughly 17s for a 12s line including a cold model load.
 */
/**
 * Synthesise the voiceover BEAT BY BEAT, then join with a pause we choose.
 *
 * One long utterance was the problem. In isolation the CTA line synthesises in
 * 2.40s with no internal gaps at all; inside the full script the same words
 * came out as "on … InternDoor … dot … com" with 0.77s, 0.25s and 0.21s of
 * silence in them, and a 1.35s hole before "Find". The model's pacing drifts
 * over a long stretch and the `instruct` does not hold it.
 *
 * So each line is synthesised on its own — every beat gets the model's best
 * pacing — and the join is a fixed `beatPause` rather than whatever the model
 * felt like. It is what storygasted does, and what the note on `reelScript`
 * has said to do since it was written: that function returns an ARRAY for
 * exactly this.
 */
function makeVoice(text, lines) {
  mkdirSync(WORK, { recursive: true });
  const raw = join(WORK, 'vo-raw.wav');
  const out = join(WORK, 'vo.wav');
  const beats = (lines?.length ? lines : [text]).filter((l) => String(l).trim());

  /* THE DELIVERY DIRECTION MATTERS AS MUCH AS THE TEMPO.
   *
   * Without one, storygasted's own default applies — "a young adult American
   * woman telling a personal story to a close friend, natural conversational
   * pacing, warm and intimate, NEVER ANNOUNCER-LIKE" — which is a storytelling
   * voice, and precisely the unhurried delivery a job promo does not want.
   * Every reel inherited it until this was passed. */
  const instruct = cfg.reels?.voiceInstruct || DEFAULT_INSTRUCT;
  const pause = Number(cfg.reels?.beatPause ?? 0.22);

  const parts = beats.map((line, i) => {
    const dst = join(WORK, `vo-beat-${i}.wav`);
    const res = execFileSync('uv', [
      'run', '--project', STORYGASTED, 'python', join(ROOT, 'bin', 'tts_once.py'),
      '--text', line, '--out', dst, '--instruct', instruct
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });
    const info = JSON.parse(String(res).trim().split('\n').filter(Boolean).pop());
    return { text: line, wav: info.wav, seconds: info.seconds };
  });

  /* Concatenated with silence between. 24kHz mono is what the model emits;
     anullsrc has to match or concat refuses the mismatched streams. */
  if (parts.length === 1) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', parts[0].wav, '-c', 'copy', raw]);
  } else {
    const inputs = [];
    const chain = [];
    parts.forEach((p, i) => {
      if (i) {
        inputs.push('-f', 'lavfi', '-t', String(pause), '-i', 'anullsrc=r=24000:cl=mono');
        chain.push(`[${inputs.filter((x) => x === '-i').length - 1}:a]`);
      }
      inputs.push('-i', p.wav);
      chain.push(`[${inputs.filter((x) => x === '-i').length - 1}:a]`);
    });
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs,
      '-filter_complex', `${chain.join('')}concat=n=${chain.length}:v=0:a=1[a]`,
      '-map', '[a]', '-c:a', 'pcm_s16le', raw]);
  }

  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter:a', `atempo=${VO_TEMPO}`, out]);

  /* Each beat's offset on the RAW timeline, so the aligner can be run per beat
     and the timings shifted into place. */
  let at = 0;
  const beatsOut = parts.map((p, i) => {
    const start = at;
    at += p.seconds + (i < parts.length - 1 ? pause : 0);
    return { ...p, start };
  });

  return { wav: out, seconds: probeSeconds(out), raw: probeSeconds(raw), rawWav: raw, text, beats: beatsOut };
}

/**
 * Word timings for the voiceover, via storygasted's MLX forced aligner.
 *
 * Handed the RAW wav and told the tempo, NOT the stretched one: aligning
 * time-stretched audio measurably degrades the timings, so the aligner works on
 * the original timeline and bin/align_once.py scales the numbers by 1/tempo.
 *
 * Captions are worth having and are not worth failing a render for. An aligner
 * that is missing, slow or wrong returns nothing and the reel goes out without
 * them — the same rule the music bed follows.
 */
function alignVoice(voice) {
  try {
    /* Per BEAT, against that beat's own wav. Aligning the concatenated file
       would ask the model to account for silence it never spoke, and the
       timings drift across it. */
    const words = [];
    for (const b of voice.beats ?? [{ wav: voice.rawWav, text: voice.text, start: 0 }]) {
      const res = execFileSync('uv', [
        'run', '--project', STORYGASTED, 'python', join(ROOT, 'bin', 'align_once.py'),
        '--wav', b.wav, '--text', b.text, '--tempo', '1'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });
      const got = JSON.parse(String(res).trim().split('\n').filter(Boolean).pop()).words ?? [];
      /* Shifted onto the raw timeline, then scaled once for the tempo — the
         same order bin/align_once.py uses, for the same reason. */
      for (const w of got) {
        words.push({ word: w.word,
          start: (w.start + b.start) / VO_TEMPO, end: (w.end + b.start) / VO_TEMPO });
      }
    }
    return captionsFor(words);
  } catch (err) {
    console.log(`  captions: skipped — ${String(err.message).split('\n')[0]}`);
    return [];
  }
}

/* ---------- music ---------- */

/**
 * Measure a slice of audio so loudnorm can be given a target it will actually
 * hit.
 *
 * Single-pass loudnorm is DYNAMIC: it adapts gain across the clip, which on an
 * 11-second bed means the music breathes against the voice instead of sitting
 * under it. Two-pass with `linear=true` applies one constant gain. Measured on
 * a real slice: single pass landed at -32.46 LUFS against a -32 target, two
 * pass at -32.00. The 0.46 LU is not the point; the constant gain is.
 *
 * Measured on the SLICE, not the file — these tracks are an hour long, and
 * measuring the whole of one to normalise eleven seconds of it would be both
 * slow and wrong.
 */
function measureLoudness(file, start, seconds, target) {
  try {
    const err = execFileSync('ffmpeg', ['-hide_banner', '-nostats',
      '-ss', String(start), '-t', String(seconds), '-i', file,
      '-af', `loudnorm=I=${target}:TP=-2:LRA=11:print_format=json`,
      '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    return JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  } catch {
    /* A bed that cannot be measured is still better than no bed: fall back to
       single-pass rather than dropping the music. */
    return null;
  }
}

/* ---------- render ---------- */

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

async function main() {
  const jobs = loadJobs(REGION);
  const job = pickJob(jobs);
  /* Forcing a format the posting cannot carry THROWS rather than falling back
     to A. A silent downgrade is the worst outcome here: the run looks like it
     did what was asked and the reel is a different one. */
  let format;
  try {
    format = formatFor(job, { want: WANT_FORMAT }, cfg);
  } catch (e) {
    fail(`${e.message}\n  job ${job.id} — ${job.company}`);
  }
  const data = shape(job, format);

  mkdirSync(OUT_DIR, { recursive: true });
  /* --out=~/... arrives with a literal tilde: the shell does not expand it
     after an '=' sign, and resolve() then makes a directory called "~". */
  const out = resolve(String(args.out || join(OUT_DIR, `${job.id}.mp4`))
    .replace(/^~(?=\/|$)/, homedir()));
  mkdirSync(dirname(out), { recursive: true });

  const exe = chromiumPath();
  if (!exe) fail("Playwright's Chromium is not in ~/Library/Caches/ms-playwright\n  fix: npx playwright install chromium");

  const FORMAT_NAME = { A: 'company is hiring', D: 'hidden opportunity' };
  console.log(`\n  Format ${format} — ${FORMAT_NAME[format]}`);
  console.log(`  ${data.company} — ${data.title}`);
  console.log(`  ${data.city || '—'} · ${data.stipendText || 'no stipend listed'} · ${data.applicantsText || 'no applicant data'}`);

  /* THE VOICE IS SYNTHESISED FIRST, because its length sets the reel's.
     Rendering frames to a guessed duration and then fitting speech to them
     is what produced either a clipped last word or a silent CTA. */
  let voice = null;
  let captions = [];
  const text = scriptText(data);
  const lines = reelScript(data);
  if (!args['no-voice']) {
    console.log(`\n  script: ${text}`);
    process.stdout.write('  synthesising…');
    voice = makeVoice(text, lines);
    console.log(`\r  voice: ${voice.seconds.toFixed(1)}s (${voice.raw.toFixed(1)}s raw, ${VO_TEMPO}x)   `);
    if (!args['no-captions']) {
      captions = alignVoice(voice);
      if (captions.length) {
        const words = captions.reduce((n, c) => n + c.words.length, 0);
        console.log(`  captions: ${captions.length} cues, ${words} words`);
      }
    }
  }

  /* A FLOOR, because speeding the voice up shortened the reel.
   *
   * At 1.6x with a short posting the voiceover runs under five seconds, and
   * the card lays its scenes out as FRACTIONS of the total — so a 5.8s reel
   * gave the CTA 0.9s, which is not long enough to read "INTERNDOOR.COM", let
   * alone type it. The last scene is the only one that asks the viewer to do
   * something; it cannot be the one that gets squeezed.
   *
   * Padding the tail rather than slowing the voice back down: the pace was the
   * complaint, and a beat of music under the CTA is not dead air, it is the
   * pause that lets the address land. */
  const duration = voice
    ? Math.min(Number(args.max || 20), Math.max(MIN_SECONDS, voice.seconds + TAIL))
    : Number(args.duration || 11);

  const bgm = args['no-bgm'] ? null : pickBgm({
    dir: BGM_DIR,
    need: duration,
    indexPath: join(PATHS.reels, 'bgm-index.json'),
    usagePath: join(PATHS.reels, 'bgm-usage.json'),
    onWarn: (m) => console.log(`  music: ${m}`),
  });
  if (bgm) {
    const at = `${Math.floor(bgm.start / 60)}m${String(Math.floor(bgm.start % 60)).padStart(2, '0')}s`;
    console.log(`  music: ${bgm.name} @ ${at} of ${(bgm.seconds / 60).toFixed(0)}m`
      + `${bgm.reused ? ' (repeat)' : ''}, ${BGM_LUFS} LUFS, ${VO_LUFS - BGM_LUFS} LU under the voice`);
  } else if (!args['no-bgm']) console.log(`  music: none — drop MP3s in ${BGM_DIR}`);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

  await page.addInitScript(d => { window.REEL = d; }, { ...data, reelSeconds: duration, captions });
  await page.goto(pathToFileURL(CARD).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  /* Sizes are chosen from measured text, so they are only correct once the
     real faces are loaded. See the note on layout() in the card. */
  await page.evaluate(() => window.layout());

  const total = await page.evaluate(() => window.REEL_DURATION);
  const frames = Math.round(total * FPS);

  /* Inputs: 0 = frames on stdin, 1 = voice or silence, 2 = music if present.
     A silent track stands in when there is no voice because Instagram
     rejects a Reel with no audio stream at all. */
  const inputs = ['-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'];
  const chains = [];
  if (voice) inputs.push('-i', voice.wav);
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  /* Broadcast-style levelling so every reel lands at the same loudness
     whatever the voice did — the same -14 LUFS target storygasted uses. */
  /* apad then atrim pins the voice track to the FULL reel length. Without
     it the mix is only as long as the speech: amix sized itself to the voice
     and the closing beat — the CTA — played in total silence, music and all.
     Padding here also means the no-music path cannot end up shorter than the
     video and get clipped by -shortest. */
  chains.push(
    `[1:a]loudnorm=I=${VO_LUFS}:TP=-1.5:LRA=11,apad,atrim=0:${total.toFixed(3)},` +
    `asetpts=N/SR/TB,aresample=48000[vo]`);

  if (bgm) {
    /* -ss BEFORE -i so ffmpeg seeks rather than decoding an hour to reach the
       eleven seconds it wants. It used to take atrim=0:<length> — always the
       HEAD of the file, so five tracks meant five beds in existence and the
       same music came round several times a day. It is also the worst slice:
       m1's first 11s measures 8.2 dB below its middle, because a long track
       opens on a fade-in that the levelling below then drags back up. */
    inputs.push('-ss', String(bgm.start), '-stream_loop', '-1', '-i', bgm.file);
    const m = measureLoudness(bgm.file, bgm.start, total, BGM_LUFS);
    /* Two-pass where the measurement worked. Single-pass loudnorm adapts its
       gain across the clip, so the bed breathes against the voice; linear=true
       applies one constant gain. */
    const level = m
      ? `loudnorm=I=${BGM_LUFS}:TP=-2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
        + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}`
        + `:offset=${m.target_offset}:linear=true`
      : `loudnorm=I=${BGM_LUFS}:TP=-2:LRA=11`;
    /* Looped so a short track still covers the reel, trimmed to length, and
       faded at both ends — a hard cut into music reads as a mistake. */
    chains.push(
      `[2:a]atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      /* Levelled BEFORE the fades, or the fades would be normalised back up. */
      `${level},` +
      `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2,` +
      `aresample=48000[bg]`);
    /* normalize=0 or amix halves everything to avoid clipping, which would
       undo the levelling above and pull the voice down with the music. */
    chains.push('[vo][bg]amix=inputs=2:duration=first:normalize=0[a]');
  } else {
    chains.push('[vo]anull[a]');
  }

  const ff = spawn('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', '0:v', '-map', '[a]',
    /* format=yuv420p as a FILTER, plus -color_range tv. The frames arrive as
       MJPEG, which is full-range, and x264 carried that through as yuvj420p
       despite -pix_fmt: a deprecated flag some players refuse and others
       render with shifted colour. */
    '-vf', 'format=yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', out
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  let ffErr = '';
  ff.stderr.on('data', c => { ffErr += c.toString(); });
  const done = new Promise((res, rej) => {
    ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}\n${ffErr.slice(-2000)}`)));
    ff.on('error', rej);
  });

  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate(t => window.seek(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 60 === 0) process.stdout.write(`\r  frame ${i}/${frames}  ${(i / FPS).toFixed(1)}s`);
  }
  ff.stdin.end();
  process.stdout.write(`\r  frame ${frames}/${frames}  ${total.toFixed(1)}s\n`);

  await done;
  await browser.close();

  /* Only now. A span recorded for a render that then failed would be burned
     out of the pool for nothing. */
  if (bgm) commitBgm(join(PATHS.reels, 'bgm-usage.json'), { ...bgm, need: total });

  /* Two streams or it cannot be posted — Instagram rejects video-only. */
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' })
    .split('\n').map(x => x.replace(/,+$/, '').trim()).filter(Boolean);
  if (!streams.includes('video') || !streams.includes('audio')) {
    fail(`${out} has streams [${streams}] — Instagram needs both video and audio`);
  }

  /* A WebM twin for looking at the reel in a chat window or any Chromium
     build compiled WITHOUT proprietary codecs — those cannot decode H.264 or
     AAC at all and show the player stuck at 0:00. The MP4 stays H.264/AAC
     because that is what Instagram requires; this is only ever a preview. */
  if (args.preview) {
    const webm = out.replace(/\.mp4$/, '.webm');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out,
      '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-speed', '2',
      '-c:a', 'libopus', '-b:a', '96k', webm]);
    console.log(`  preview: ${webm}`);
  }

  const mb = statSync(out).size / 1048576;
  console.log(`\n  ${out}`);
  console.log(`  ${total.toFixed(1)}s · ${frames} frames · ${mb.toFixed(1)} MB · ${streams.join('+')} · rendered in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
}

main().catch(e => fail(e.stack || e.message));
