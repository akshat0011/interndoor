import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const APP_ID = 'interndoor';

/**
 * Runtime state deliberately lives OUTSIDE the project directory.
 *
 * macOS puts ~/Desktop, ~/Documents and ~/Downloads behind TCC. A process
 * spawned by launchd is attributed to a bare interpreter with no stable code
 * signature, so it gets no grant for those folders — the tool works when you
 * run it in Terminal (which already has a grant) and then fails silently at
 * 12:00. ~/Library/Application Support carries no such restriction.
 */
const STATE = join(homedir(), 'Library', 'Application Support', APP_ID);
const LOGS = join(homedir(), 'Library', 'Logs', APP_ID);

export const PATHS = {
  root: ROOT,
  config: join(ROOT, 'config.json'),

  state: STATE,
  db: join(STATE, 'jobs.db'),
  profile: join(STATE, 'brave-profile'),
  reports: join(STATE, 'reports'),
  screenshots: join(STATE, 'screenshots'),
  latestReport: join(STATE, 'reports', 'latest.html'),

  /**
   * Instagram reels. Deliberately beside posts/ and reports/ rather than
   * inside the project: the MP4s are generated artefacts and app/ is a PUBLIC
   * git repo. And per the note above, ~/Desktop is TCC-protected — a reel
   * render spawned by launchd could not write there at all.
   */
  reels: join(STATE, 'reels'),
  reelsBgm: join(STATE, 'reels', 'bgm'),
  reelsOut: join(STATE, 'reels', 'out'),
  reelsWork: join(STATE, 'reels', 'work'),

  /**
   * Open Graph cards, one per posting, for CHANNELS rather than the website.
   *
   * In the state directory and NOT in the repo, for exactly the reason the
   * reels are: these are generated artefacts and `app/` is a PUBLIC git repo.
   * Telegram uploads the file itself, so the image never needs to be served —
   * which is what keeps ~110 cards a day out of a repository Vercel clones on
   * all 48 deploys a day. The website's own copies, drawn only for postings we
   * SHARE on LinkedIn, live under web/public/og and are committed on purpose.
   */
  ogCards: join(STATE, 'og'),

  /** Generated LinkedIn posts, one page per batch, plus a stable latest.html. */
  posts: join(STATE, 'posts'),
  latestPosts: join(STATE, 'posts', 'latest.html'),
  latestWeekly: join(STATE, 'posts', 'weekly-latest.html'),

  /**
   * Service-account key for the Google Indexing API.
   *
   * A file rather than a .env variable because the key JSON carries a PEM
   * private key whose newlines do not survive .env round-tripping without
   * escaping, and an escaping mistake reads as an invalid-signature error a
   * long way from its cause. Outside the repo for the same reason as the
   * reels: `app/` is a PUBLIC git repo and this is a credential.
   *
   * Overridable with GOOGLE_INDEXING_KEY_FILE.
   */
  indexingKey: join(STATE, 'google-indexing-key.json'),

  logs: LOGS,

  /** Where install-schedule.sh puts the script launchd actually executes. */
  launchScriptDir: join(homedir(), 'Library', 'Application Scripts', `com.akshat0011.${APP_ID}`),
};

/** Directories that must exist before use. launchd never creates them for us. */
const MANAGED = ['state', 'profile', 'reports', 'screenshots', 'posts', 'logs',
  'reels', 'reelsBgm', 'reelsOut', 'reelsWork', 'ogCards'];

export function ensureDirs() {
  for (const key of MANAGED) {
    mkdirSync(PATHS[key], { recursive: true });
  }
}

/** True when the project sits in a TCC-protected folder. */
export function inProtectedFolder(path = ROOT) {
  const home = homedir();
  return ['Desktop', 'Documents', 'Downloads'].some((d) => path.startsWith(join(home, d)));
}
