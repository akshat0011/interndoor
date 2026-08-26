#!/usr/bin/env node
/**
 * Render one 1080x1920 reel from a published job row.
 *
 *   npm run reel                          # newest India job that has bullets
 *   npm run reel -- --job=4457471044
 *   npm run reel -- --region=US --out=/tmp/x.mp4
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
import { scriptText } from '../src/reelscript.js';
import { PATHS } from '../src/paths.js';

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
const VO_TEMPO = Number(process.env.REEL_VO_TEMPO || 1.25);

/* A tail after the voice ends, so the CTA is on screen in silence for a beat
   rather than cutting the instant the last word lands. */
const TAIL = 0.9;

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
  /* Bullets are what scene 4 is made of, and 98% of India rows have them, so
     requiring them costs almost nothing and avoids rendering an empty scene. */
  const usable = jobs.filter(j => Array.isArray(j.bullets) && j.bullets.length >= 2);
  if (!usable.length) fail(`no ${REGION} job has bullets yet`);
  return usable.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))[0];
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
  if (!raw) return { text: null, zero: false };
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

function shape(job) {
  const s = stipend(job);
  const a = applicants(job);
  return {
    company: job.company,
    title: job.title,
    city: city(job),
    stipendText: s.text,
    stipendAmount: s.amount,
    stipendPeriod: s.period,
    currency: CURRENCY[REGION] || '\u20b9',
    duration: job.duration || null,
    mode: job.workplaceType || null,
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
function makeVoice(text) {
  mkdirSync(WORK, { recursive: true });
  const raw = join(WORK, 'vo-raw.wav');
  const out = join(WORK, 'vo.wav');

  const res = execFileSync('uv', [
    'run', '--project', STORYGASTED, 'python', join(ROOT, 'bin', 'tts_once.py'),
    '--text', text, '--out', raw
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });

  const line = String(res).trim().split('\n').filter(Boolean).pop();
  const info = JSON.parse(line);

  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', info.wav,
    '-filter:a', `atempo=${VO_TEMPO}`, out]);
  return { wav: out, seconds: probeSeconds(out), raw: info.seconds };
}

/* ---------- music ---------- */

/**
 * Pick a track at random and shape it to the reel.
 *
 * Chosen by index rather than by name so adding or renaming files needs no
 * change here. Returns null when the folder is empty, and the reel is simply
 * rendered without music — a missing track must never fail a render.
 */
function pickBgm() {
  if (!existsSync(BGM_DIR)) return null;
  const tracks = readdirSync(BGM_DIR)
    .filter(f => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f))
    .sort();
  if (!tracks.length) return null;
  const f = join(BGM_DIR, tracks[Math.floor(Math.random() * tracks.length)]);
  return { file: f, name: tracks.find(t => join(BGM_DIR, t) === f), seconds: probeSeconds(f) };
}

/* ---------- render ---------- */

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

async function main() {
  const jobs = loadJobs(REGION);
  const job = pickJob(jobs);
  const data = shape(job);

  mkdirSync(OUT_DIR, { recursive: true });
  /* --out=~/... arrives with a literal tilde: the shell does not expand it
     after an '=' sign, and resolve() then makes a directory called "~". */
  const out = resolve(String(args.out || join(OUT_DIR, `${job.id}.mp4`))
    .replace(/^~(?=\/|$)/, homedir()));
  mkdirSync(dirname(out), { recursive: true });

  const exe = chromiumPath();
  if (!exe) fail("Playwright's Chromium is not in ~/Library/Caches/ms-playwright\n  fix: npx playwright install chromium");

  console.log(`\n  ${data.company} — ${data.title}`);
  console.log(`  ${data.city || '—'} · ${data.stipendText || 'no stipend listed'} · ${data.applicantsText || 'no applicant data'}`);

  /* THE VOICE IS SYNTHESISED FIRST, because its length sets the reel's.
     Rendering frames to a guessed duration and then fitting speech to them
     is what produced either a clipped last word or a silent CTA. */
  let voice = null;
  const text = scriptText(data);
  if (!args['no-voice']) {
    console.log(`\n  script: ${text}`);
    process.stdout.write('  synthesising…');
    voice = makeVoice(text);
    console.log(`\r  voice: ${voice.seconds.toFixed(1)}s (${voice.raw.toFixed(1)}s raw, ${VO_TEMPO}x)   `);
  }

  const duration = voice
    ? Math.min(Number(args.max || 20), voice.seconds + TAIL)
    : Number(args.duration || 11);

  const bgm = args['no-bgm'] ? null : pickBgm();
  if (bgm) console.log(`  music: ${bgm.name} (${bgm.seconds.toFixed(0)}s source, ${BGM_LUFS} LUFS, ${VO_LUFS - BGM_LUFS} LU under the voice)`);
  else if (!args['no-bgm']) console.log(`  music: none — drop MP3s in ${BGM_DIR}`);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });

  await page.addInitScript(d => { window.REEL = d; }, { ...data, duration });
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
    inputs.push('-stream_loop', '-1', '-i', bgm.file);
    /* Looped so a short track still covers the reel, trimmed to length, and
       faded at both ends — a hard cut into music reads as a mistake. */
    chains.push(
      `[2:a]atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      /* Levelled BEFORE the fades, or the fades would be normalised back up. */
      `loudnorm=I=${BGM_LUFS}:TP=-2:LRA=11,` +
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
