import { appendFileSync, createWriteStream, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';

const LEVEL_STYLE = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let logFile = null;
/* THE READABLE RUN LOG (his ask, 14 Oct 2026: "run logs which i can read
   easily so i know why its stuck"). One file per scan, written beside the day
   log: India time, no colour codes, no debug lines, long links shortened. Only
   a scan opens one (startRunLog), so tests never write here. */
let runLog = null;
const RUN_LOG_KEEP = 300;
const LEVEL_WORD = { info: '      ', ok: 'DONE  ', warn: 'WAIT  ', error: 'ERROR ' };

export function istTime(d = new Date()) {
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

/** A line as the run log shows it, or null for a line it leaves out. */
export function readableLine(level, msg, d = new Date()) {
  if (level === 'debug') return null;
  const text = String(msg).replace(/https?:\/\/[^\s)]+/g, (u) => {
    if (/linkedin\.com\/jobs-guest\/jobs\/api\/seeMoreJobPostings/.test(u)) return '(LinkedIn search)';
    if (/linkedin\.com\/jobs-guest\/jobs\/api\/jobPosting\//.test(u)) return '(LinkedIn posting)';
    if (u.length <= 70) return u;
    try { return `${new URL(u).host}/…`; } catch { return u.slice(0, 60) + '…'; }
  });
  return `${istTime(d)}  ${LEVEL_WORD[level] ?? '      '}${text}`;
}

export function runLogDir() {
  return join(PATHS.logs, 'runs');
}

/** Open this run's readable log. Never throws; returns the path or null. */
export function startRunLog(runId, title) {
  try {
    const dir = runLogDir();
    mkdirSync(dir, { recursive: true });
    runLog = join(dir, `${runId}.txt`);
    const day = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    appendFileSync(runLog, `${title}\nStarted ${day}, ${istTime()} India time\n\n`);
    const old = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - RUN_LOG_KEEP))) unlinkSync(join(dir, f));
    return runLog;
  } catch {
    runLog = null;
    return null;
  }
}

function stamp(d = new Date()) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function fileFor(d = new Date()) {
  return join(PATHS.logs, `run-${d.toISOString().slice(0, 10)}.log`);
}

function write(level, msg) {
  const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] ${msg}`;
  const colour = LEVEL_STYLE[level] ?? '';
  process.stdout.write(`${colour}${line}${RESET}\n`);
  try {
    if (!logFile) {
      ensureDirs();
      logFile = fileFor();
    }
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must never be the reason a run dies.
  }
  if (runLog) {
    try {
      const r = readableLine(level, msg);
      if (r) appendFileSync(runLog, `${r}\n`);
    } catch { /* same rule */ }
  }
}

export const log = {
  debug: (m) => write('debug', m),
  info: (m) => write('info', m),
  ok: (m) => write('ok', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),

  /** A visually distinct section header, so long runs stay readable. */
  section(title) {
    process.stdout.write(`\n\x1b[1m\x1b[35m${'─'.repeat(4)} ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}\x1b[0m\n`);
    try {
      if (!logFile) { ensureDirs(); logFile = fileFor(); }
      appendFileSync(logFile, `\n=== ${title} ===\n`);
    } catch {}
    if (runLog) { try { appendFileSync(runLog, `\n── ${title} ──\n`); } catch {} }
  },
};
