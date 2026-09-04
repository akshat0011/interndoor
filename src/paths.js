import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
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

  /**
   * WhatsApp Web's own Brave profile, and it is SEPARATE for two reasons.
   *
   * `profile` above is the scraper's, and launchBrave clears and claims it on
   * its way in — pointing WhatsApp at that directory would kill a scrape
   * mid-flight, which is the one thing this repo's browser rule exists to
   * prevent. And his personal Brave profile is not usable either: a Playwright
   * persistent context takes an exclusive lock on the directory, so automating
   * it would mean he cannot have his own browser open.
   *
   * A directory of its own means the throwaway number's session lives here,
   * survives restarts, and touches nothing else.
   */
  whatsappProfile: join(STATE, 'whatsapp-profile'),
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
   * all 48 deploys a day. Nothing is committed: the WEBSITE's cards are drawn
   * on request by web/api/og.js and never touch the repo at all.
   */
  ogCards: join(STATE, 'og'),
  /* LinkedIn post images. In the STATE directory beside the OG cards and for
     the same reason: one per queued posting, and app/ is a public repo. */
  liCards: join(STATE, 'li'),

  /** Generated LinkedIn posts, one page per batch, plus a stable latest.html. */
  posts: join(STATE, 'posts'),

  /**
   * A checkout of the PUBLIC GitHub internship list.
   *
   * In the state directory for exactly the reason the reels and the OG cards
   * are: it is a second git repository, and nesting one inside `app/` — itself
   * a public repo the scheduler commits to every 30 minutes — is a way to
   * accidentally commit one into the other. Not on the Desktop either; a
   * launchd-spawned process gets no TCC grant there and fails silently.
   */
  ghList: join(STATE, 'gh-list'),
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
  'reels', 'reelsBgm', 'reelsOut', 'reelsWork', 'ogCards', 'liCards'];

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

/* WHERE STORYGASTED LIVES, resolved rather than hard-coded.

   The reels pipeline borrows storygasted's venv for three things — the MLX
   Qwen3-TTS voiceover, the forced aligner behind the burned-in captions, and
   the Graph API client that publishes to Instagram. Each was invoked with a
   literal `~/Desktop/projects/storygasted`, in five separate places.

   That project moved to ~/projects, and every reel failed for 20 hours:
   `uv` exits 2 with "Project directory ... does not exist", the publish step
   dies, and the ONLY place it is visible is reel_posts.error. Nothing else
   notices, because a render that cannot reach the publisher still looks like
   a healthy render.

   So: check the known locations, honour STORYGASTED_HOME for anywhere else,
   and fall back to the historical path so the error message still names
   something recognisable. Callers pass this to `uv run --project`. */
const STORYGASTED_CANDIDATES = [
  process.env.STORYGASTED_HOME,
  join(homedir(), 'projects', 'storygasted'),
  join(homedir(), 'Desktop', 'projects', 'storygasted'),
].filter(Boolean);

export function storygastedRoot() {
  for (const dir of STORYGASTED_CANDIDATES) {
    if (existsSync(join(dir, 'pyproject.toml'))) return dir;
  }
  return STORYGASTED_CANDIDATES[STORYGASTED_CANDIDATES.length - 1];
}
