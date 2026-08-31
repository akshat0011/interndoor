import { DatabaseSync } from 'node:sqlite';
import { PATHS, ensureDirs } from './paths.js';
import { resolveRegion, UNKNOWN } from './regions.js';
import { log } from './logger.js';
import { parseCardIdentity } from './linkedin.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id            TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  company           TEXT,
  company_matched   TEXT,
  location          TEXT,
  workplace_type    TEXT,
  posted_text       TEXT,
  posted_at         INTEGER,
  salary_text       TEXT,
  stipend_min       REAL,
  stipend_max       REAL,
  stipend_currency  TEXT,
  stipend_period    TEXT,
  applicants        TEXT,
  easy_apply        INTEGER DEFAULT 0,
  apply_url         TEXT,
  job_url           TEXT,
  duration          TEXT,
  skills            TEXT,
  description       TEXT,
  summary           TEXT,
  bullets           TEXT,
  role_label        TEXT,
  degree_level      TEXT,
  degree_text       TEXT,
  key_skills        TEXT,
  stipend_status    TEXT,
  logo_url          TEXT,
  is_tech           INTEGER,
  role_source       TEXT,
  search_keywords   TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  first_run_id      TEXT,
  reported          INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_reported   ON jobs(reported, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company    ON jobs(company_matched);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  status            TEXT,
  pages_scanned     INTEGER DEFAULT 0,
  cards_seen        INTEGER DEFAULT 0,
  details_extracted INTEGER DEFAULT 0,
  new_jobs          INTEGER DEFAULT 0,
  skipped_note      TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS seen_cards (
  job_id       TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  reason       TEXT,
  company      TEXT,
  title        TEXT
);

-- What a search card turned out to be, once it was clicked.
--
-- The redesigned LinkedIn results page carries no job id anywhere in the DOM;
-- it only appears after a card is opened. Without a memory of what an earlier
-- click revealed, every card matching the watchlist would have to be reopened
-- on every run just to find out whether we already hold it — roughly a dozen
-- pointless page opens per posting, against the one account this all depends on.
--
-- The key is company|title with no timestamp, so it survives a card ageing from
-- "5 minutes ago" to "2 hours ago" between runs. posted_at is what stops that
-- stability swallowing a repost: the same role relisted under a new id reads as
-- much newer than the row this maps to, and is opened rather than assumed known.
CREATE TABLE IF NOT EXISTS card_keys (
  card_key     TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  posted_at    INTEGER,
  last_seen_at INTEGER NOT NULL,
  -- How many DIFFERENT postings have ever been bound to this card identity.
  --
  -- A card carries no job id until it is clicked, so it is identified by
  -- company|title|location — and that is not unique for an employer using a
  -- generic title. American Express files 41 distinct jobs under
  -- "Apprentice | Gurugram, Haryana, India". Once this passes 1 the identity
  -- has PROVEN it cannot tell two postings apart, and the already-known
  -- shortcut must stop trusting it. See the gate in src/index.js.
  job_count    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cache of watchlist company name -> LinkedIn numeric company id, so the
-- expensive resolution pass happens once rather than every run. The status
-- column lets a name that genuinely cannot be resolved be remembered as such
-- instead of being retried forever.
CREATE TABLE IF NOT EXISTS company_ids (
  name        TEXT PRIMARY KEY,
  display     TEXT,
  linkedin_id TEXT,
  slug        TEXT,
  matched_as  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_company_ids_status ON company_ids(status);

-- Postings picked out by hand for a LinkedIn post on his own account.
--
-- Separate from the reported column, which records that a job appeared in the
-- run report and is set automatically. This is the opposite: nothing enters it
-- without a click, because the whole point of the queue is that he decides
-- which employers are worth putting his own name behind.
--
-- No foreign key to jobs. Every read joins, so an orphan row simply stops
-- appearing rather than failing a write in a different process, and this table
-- must never be able to break a scan.
CREATE TABLE IF NOT EXISTS post_queue (
  job_id     TEXT PRIMARY KEY,
  added_at   INTEGER NOT NULL,
  -- 'queued' until a draft exists, then 'drafted'. A drafted row STAYS here so
  -- the post can be re-read and re-copied after the tab is closed; clearing is
  -- an explicit action.
  status     TEXT NOT NULL DEFAULT 'queued',
  batch_id   TEXT,
  post_text  TEXT,
  post_meta  TEXT,
  drafted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_post_queue_batch ON post_queue(batch_id);

-- Careers URLs a web search has already offered us, and what came of each.
--
-- Without this every daily sweep re-fetches every result it has ever seen. The
-- searches are deliberately date-restricted, so the same pages come back for
-- days; re-resolving them means a request to somebody else's careers site per
-- page per day for a posting we already decided about. The verdict is worth
-- remembering even when it was no: a role refused as non-engineering on Monday
-- is still non-engineering on Tuesday.
/*
 * One row per job that has been through the Instagram reel flow.
 *
 * In jobs.db beside post_queue rather than in a reels.db of its own. The
 * reels.db note in CLAUDE.md is about the AUTOMATED 10-20/day agent, which gets
 * its own process and must never be able to fail a scan; this is the manual
 * queue, driven by a click in the run report, in the same process and with the
 * same reasoning post_queue already carries — WAL plus the 5s busy timeout
 * cover a second writer.
 *
 * No foreign key to jobs, exactly like post_queue: an orphan row must stop
 * appearing rather than fail a write in a different process.
 *
 * The row exists BEFORE the render starts, so a job cannot be published twice
 * by double-clicking, and so a crash mid-publish leaves evidence rather than
 * looking like it never happened.
 */
CREATE TABLE IF NOT EXISTS reel_posts (
  job_id      TEXT PRIMARY KEY,
  -- rendering -> publishing -> published, or failed at any point.
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  media_id    TEXT,
  permalink   TEXT,
  caption     TEXT,
  video_path  TEXT,
  -- When it may go out. NULL means "as soon as it is rendered". Set for the
  -- second and later reels of a sitting, so three good jobs found at once
  -- become three separate posts rather than one burst.
  publish_at  INTEGER,
  error       TEXT
);

/*
 * What has been announced to Google's Indexing API, and what is still owed.
 *
 * The API's quota is 200 URLs a rolling 24h and this site publishes ~110 new
 * job pages a day plus about as many expiries, so the interesting state is not
 * "did we send it" but "what do we still owe, and which of it matters most".
 * Hence a queue with a pending intent rather than a log of sends.
 *
 * submitted/submitted_at are what stop a URL being re-announced on every one
 * of the 48 publishes a day — at 200/day that would spend the whole quota on
 * the first four pages. (No backticks in this comment: SCHEMA is a template
 * literal, and a backtick here ends it mid-string.)
 */
CREATE TABLE IF NOT EXISTS indexed_urls (
  url          TEXT PRIMARY KEY,
  pending      TEXT,
  queued_at    INTEGER,
  submitted    TEXT,
  submitted_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS discovered_urls (
  url        TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  status     TEXT,
  job_id     TEXT
);
`;

export class Store {
  /**
   * @param {string} [dbPath] Override the database file. Defaults to the real
   *   one and every caller uses that; the argument exists so a test can build
   *   a throwaway store instead of writing rows into the live jobs.db.
   */
  constructor(dbPath = PATHS.db) {
    ensureDirs();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    /**
     * Wait for a busy writer instead of failing on one.
     *
     * WAL lets readers and a writer coexist, but it does NOT let two writers
     * coexist — and this database has several processes that write: the scan,
     * the ATS poller, the enricher and bin/discover-ats.js, all of which the
     * scheduler can have in flight while somebody runs a tool by hand.
     *
     * Without a timeout the loser does not queue, it throws
     * `SQLITE_BUSY: database is locked` and takes the whole process with it.
     * That killed a discovery run 128 companies into 293 on 23 Aug, losing the
     * other 165 with no way to tell from the exit code — the crash was inside a
     * Promise.all worker and the pipeline still reported success.
     *
     * Five seconds is far longer than any write here takes; the writes are
     * single-row upserts, not batches.
     */
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Additive migrations for databases created by an earlier version. */
  #migrate() {
    const seenCols = this.db.prepare('PRAGMA table_info(seen_cards)').all().map((c) => c.name);
    for (const [name, type] of [['company', 'TEXT'], ['title', 'TEXT']]) {
      if (!seenCols.includes(name)) {
        this.db.exec(`ALTER TABLE seen_cards ADD COLUMN ${name} ${type}`);
      }
    }

    const jobCols = this.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    for (const [name, type] of [
      ['logo_url', 'TEXT'], ['is_tech', 'INTEGER'], ['role_source', 'TEXT'],
      // Gemini enrichment. bullets and key_skills hold JSON arrays; they stay NULL
      // until a posting has been enriched, which is what the card falls back on.
      ['bullets', 'TEXT'], ['role_label', 'TEXT'], ['degree_level', 'TEXT'], ['degree_text', 'TEXT'],
      ['key_skills', 'TEXT'], ['stipend_status', 'TEXT'],
      // Which country the posting is in, resolved once at ingest. Stored rather
      // than computed at read time because publish partitions on it every run,
      // the gazetteer will keep improving, and a stored value can be re-derived
      // by a migration where a computed one has to be recomputed everywhere.
      ['region', 'TEXT'],
      // 'intern' or 'fulltime'. Rows written before this existed are NULL and
      // are treated as internships, which is what the site was until now.
      ['employment_type', 'TEXT'],
    ]) {
      if (!jobCols.includes(name)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
    }

    const cardCols = this.db.prepare('PRAGMA table_info(card_keys)').all().map((c) => c.name);
    if (!cardCols.includes('job_count')) {
      this.db.exec('ALTER TABLE card_keys ADD COLUMN job_count INTEGER NOT NULL DEFAULT 1');
      this.#seedCardKeyCounts();
    }

    const reelCols = this.db.prepare('PRAGMA table_info(reel_posts)').all().map((c) => c.name);
    if (!reelCols.includes('publish_at')) {
      this.db.exec('ALTER TABLE reel_posts ADD COLUMN publish_at INTEGER');
    }
    /* Which format the reel was. Rows written before formats existed stay NULL
       rather than being backfilled to 'A': every one of them WAS a Format A,
       but the whole reason this column exists is to compare formats against
       each other, and a guessed value is indistinguishable from a measured one
       once it is in the table. NULL says "before we were counting". */
    if (!reelCols.includes('format')) {
      this.db.exec('ALTER TABLE reel_posts ADD COLUMN format TEXT');
    }
    /* WHICH ACCOUNT IT WENT TO. One Instagram account per region, and the
       platform's 100-per-rolling-day publish quota is PER ACCOUNT, so the daily
       cap can only be counted if each row knows whose day it spent. NULL on
       rows written before there were two accounts — every one of them went to
       the single account that existed then, but a guessed value is
       indistinguishable from a measured one once it is in the table. */
    if (!reelCols.includes('region')) {
      this.db.exec('ALTER TABLE reel_posts ADD COLUMN region TEXT');
    }
    /* Whether a human pressed the button or the pipeline chose it. Kept apart
       so the automatic half can be measured, paused or capped without touching
       the manual queue, which is a different product with a different rule. */
    if (!reelCols.includes('source')) {
      this.db.exec("ALTER TABLE reel_posts ADD COLUMN source TEXT");
    }
    /* The posting's own description hash — the SAME key the board collapses
       one-role-in-many-cities on. Two job ids carrying one description are one
       opening, and two reels about it are two near-identical posts in the same
       feed. Recorded so a role can never be posted twice across sweeps. */
    if (!reelCols.includes('fingerprint')) {
      this.db.exec('ALTER TABLE reel_posts ADD COLUMN fingerprint TEXT');
    }

    if (!jobCols.includes('region')) this.#backfillRegions();
  }

  /**
   * Give existing card identities their ambiguity count, once.
   *
   * Without this the table would have to re-learn from scratch, and it only
   * learns when the 6-hour repost rule happens to let a second posting through
   * — which is precisely the rule that is failing. The worst identities would
   * keep losing postings for another day before correcting themselves.
   *
   * Matched with LIKE rather than equality because the two tables hold
   * different location text: `card_keys` stores what the CARD said
   * ("Gurugram") and `jobs` stores what the detail pane said ("Gurugram,
   * Haryana, India"). Company and title agree, so the prefix match on location
   * is the only join available.
   */
  #seedCardKeyCounts() {
    const rows = this.db.prepare('SELECT card_key FROM card_keys').all();
    const count = this.db.prepare(`
      SELECT COUNT(DISTINCT job_id) n FROM jobs
      WHERE job_id NOT GLOB 'ats:*'
        AND lower(company) = ?
        AND lower(title) = ?
        AND lower(COALESCE(location, '')) LIKE ? || '%'
    `);
    const update = this.db.prepare('UPDATE card_keys SET job_count = ? WHERE card_key = ?');
    let seeded = 0;
    for (const { card_key: key } of rows) {
      const id = parseCardIdentity(key);
      if (!id) continue;
      const { company, title, location } = id;
      const n = count.get(company, title, location)?.n ?? 0;
      if (n > 1) { update.run(n, key); seeded++; }
    }
    if (seeded) log.info(`Marked ${seeded} card identit${seeded === 1 ? 'y' : 'ies'} as ambiguous — they map to more than one posting.`);
  }

  /**
   * Give every pre-existing row a region, once.
   *
   * The fallback for an empty location is the thing that has to be right here,
   * and it differs by collector — which is recoverable from the id, because a
   * LinkedIn id is digits and an ATS id is `ats:provider:token:n`. Every
   * LinkedIn row in the table was collected by a search scoped to India, so a
   * blank location on one of those genuinely means India. An ATS board carries
   * every office a company has and says nothing about which, so a blank there
   * is honestly unknown and must not inherit India.
   *
   * Runs once, in the migration that adds the column. Rows written afterwards
   * carry their region from the collector that stored them.
   */
  #backfillRegions() {
    const rows = this.db.prepare('SELECT job_id, location FROM jobs').all();
    const stmt = this.db.prepare('UPDATE jobs SET region = ? WHERE job_id = ?');
    for (const row of rows) {
      const fromLinkedIn = !String(row.job_id ?? '').startsWith('ats:');
      stmt.run(resolveRegion(row.location, { fallback: fromLinkedIn ? 'IN' : null }), row.job_id);
    }
  }

  /**
   * Which ATS board each company uses, if any.
   *
   * Created on demand rather than in SCHEMA so that an existing database picks
   * it up without a migration step — same additive-only rule as everywhere else.
   * A row with provider NULL is a recorded miss, not missing data: it stops the
   * next discovery run re-probing a company that has no public board.
   */
  ensureAtsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS company_ats (
        company     TEXT PRIMARY KEY,
        provider    TEXT,
        token       TEXT,
        job_count   INTEGER DEFAULT 0,
        checked_at  INTEGER NOT NULL,
        last_polled INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ats_provider ON company_ats(provider);
    `);
  }

  getAts(company) {
    return this.db.prepare('SELECT * FROM company_ats WHERE lower(company) = lower(?)').get(company) ?? null;
  }

  saveAts(company, provider, token, jobCount) {
    this.db.prepare(`
      INSERT INTO company_ats (company, provider, token, job_count, checked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company) DO UPDATE SET
        provider = excluded.provider,
        token = excluded.token,
        job_count = excluded.job_count,
        checked_at = excluded.checked_at
    `).run(company, provider, token, jobCount ?? 0, Date.now());
  }

  /**
   * Which company a board token belongs to.
   *
   * The reverse of getAts, and the reason it exists: a URL carries the TOKEN,
   * which is usually the company name lower-cased and mangled — "zscaler",
   * "paytm", "voleon". Storing that as the employer puts a lower-case name on a
   * public card. The discovery pass already recorded the real name against the
   * token, so this reads it back instead of guessing at capitalisation.
   */
  companyForBoard(provider, token) {
    this.ensureAtsTable();
    return this.db.prepare(
      'SELECT company FROM company_ats WHERE provider = ? AND lower(token) = lower(?) LIMIT 1',
    ).get(provider, token)?.company ?? null;
  }

  /** Every company with a board worth polling. */
  atsBoards() {
    return this.db.prepare(
      'SELECT company, provider, token, job_count, last_polled FROM company_ats WHERE provider IS NOT NULL ORDER BY company',
    ).all();
  }

  markAtsPolled(company) {
    this.db.prepare('UPDATE company_ats SET last_polled = ? WHERE lower(company) = lower(?)').run(Date.now(), company);
  }

  atsStats() {
    const total = this.db.prepare('SELECT COUNT(*) n FROM company_ats').get().n;
    const resolved = this.db.prepare('SELECT COUNT(*) n FROM company_ats WHERE provider IS NOT NULL').get().n;
    return { total, resolved };
  }

  /** Postings that still need a Gemini pass — enriched rows are never re-sent. */
  /**
   * Postings still waiting for bullets, newest first — but a PUBLISHED region
   * always ahead of one that is merely collected.
   *
   * The ordering matters now that every region is collected. A single ATS poll
   * stores ~60 postings worldwide against India's ~29 a day, and enrichment is
   * a local model on a wall-clock budget (enrich.budgetMinutes), so a plain
   * newest-first queue would let a burst of roles nobody can see yet push
   * India's fresh listings past the budget and onto the board without bullets —
   * which also means noindex, since isIndexable needs two.
   *
   * Unpublished regions are still enriched, last. That is what makes a region
   * ready to switch on: a board whose pages all lack bullets is a board of
   * noindex pages on day one.
   *
   * @param {string[]} published ISO codes to prioritise; empty means no preference
   */
  needingEnrichment(limit = 500, published = []) {
    // Inlined rather than bound, because SQLite has no array parameter. The
    // values come from the region registry, never from user input.
    const codes = published
      .filter((c) => /^[A-Z]{2}$/.test(String(c)))
      .map((c) => `'${c}'`);
    const priority = codes.length
      ? `CASE WHEN region IN (${codes.join(',')}) THEN 0 ELSE 1 END,`
      : '';

    return this.db.prepare(`
      -- location is selected because the enricher writes the page's summary and
      -- names the city in it. Without it the model was told "not stated" and
      -- filled the gap from the company name: an American Express apprenticeship
      -- in Gurugram was published as "Based in the us".
      SELECT job_id, title, company, location, description, salary_text AS stipend
      FROM jobs
      WHERE bullets IS NULL AND length(description) > 200
      ORDER BY ${priority} first_seen_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Jobs that were stored without their page ever being opened, and so have no
   * description — nothing for `needingEnrichment` to work from, and nothing a
   * later scan will fix, because `hasJob` short-circuits a known job before it
   * is ever re-opened. Without this query such a row is stuck forever: no
   * bullets, no stipend, no duration, published as a bare title.
   *
   * Two conditions matter, and both were wrong before:
   *
   * - `is_tech = 1` alone never matched anything. Every card-only row is written
   *   with is_tech = 0 (see the openNonTechRoles branch in src/index.js), and
   *   with storeNonTechRoles = false those rows are not stored at all — so the
   *   whole pass was a no-op against a live database of 444 jobs. A NULL verdict
   *   is included instead: that row has no description AND no verdict, and the
   *   classification pass later in the same run reads exactly this description
   *   to settle it. Non-tech stays excluded — it can never be published, so
   *   opening it spends a page load on nobody's behalf.
   *
   * - ATS rows must be excluded outright. Their job_id is `ats:provider:token:n`,
   *   which is not a LinkedIn job id; handing one to li.openAndExtract navigates
   *   to a nonexistent posting, burns a page open and logs a failure. An ATS row
   *   missing its description has to be re-polled, not scraped.
   *
   * Restricted to rows still inside the publish window — backfilling a job that
   * has already dropped off the site helps nobody.
   */
  needingDescription(limit = 8, maxAgeDays = 14) {
    return this.db.prepare(`
      SELECT job_id, title, company
      FROM jobs
      WHERE description IS NULL
        AND (is_tech = 1 OR is_tech IS NULL)
        AND job_id NOT LIKE 'ats:%'
        AND first_seen_at > ?
      ORDER BY first_seen_at DESC
      LIMIT ?
    `).all(Date.now() - maxAgeDays * 86_400_000, limit);
  }

  /**
   * Fill in a row that was originally stored from card data alone.
   *
   * COALESCE on every optional column so a backfill can only ever add: if the
   * detail pane does not mention a duration, the card's value stays. The one
   * exception is `description` itself, which is what we came for.
   *
   * Deliberately does NOT touch first_seen_at. That column is the site's sort
   * order and its freshness label, so moving it would push a week-old posting
   * back to the top of the list purely because we got around to reading it.
   */
  saveDescription(jobId, job) {
    this.db.prepare(`
      UPDATE jobs SET
        description      = ?,
        summary          = COALESCE(?, summary),
        duration         = COALESCE(?, duration),
        skills           = COALESCE(?, skills),
        salary_text      = COALESCE(?, salary_text),
        stipend_min      = COALESCE(?, stipend_min),
        stipend_max      = COALESCE(?, stipend_max),
        stipend_currency = COALESCE(?, stipend_currency),
        stipend_period   = COALESCE(?, stipend_period),
        applicants       = COALESCE(?, applicants),
        apply_url        = COALESCE(?, apply_url),
        workplace_type   = COALESCE(?, workplace_type),
        logo_url         = COALESCE(logo_url, ?),
        last_seen_at     = ?
      WHERE job_id = ?
    `).run(
      job.description ?? null,
      job.summary ?? null,
      job.duration ?? null,
      job.skills?.length ? JSON.stringify(job.skills) : null,
      job.salaryText ?? null,
      job.stipend?.min ?? null,
      job.stipend?.max ?? null,
      job.stipend?.currency ?? null,
      job.stipend?.period ?? null,
      job.applicants ?? null,
      job.applyUrl ?? null,
      job.workplaceType ?? null,
      job.logoUrl ?? null,
      Date.now(),
      jobId,
    );
  }

  /**
   * Persist one enrichment result. isTech is only overwritten when the caller
   * actually produced one.
   *
   * `source` records who wrote the row. It is not cosmetic: a verdict from the
   * model and a verdict from a one-off backfill should be distinguishable when
   * you later ask why a job is filed where it is.
   */
  saveEnrichment(jobId, e, source = 'model-enrich') {
    this.db.prepare(`
      UPDATE jobs SET
        bullets = ?, role_label = ?, degree_level = ?, degree_text = ?, key_skills = ?, stipend_status = ?,
        is_tech = COALESCE(?, is_tech),
        -- Only replace the summary when a rewritten one was actually produced.
        -- The column already holds the extractive plain-text summary, which is
        -- what the card falls back to; overwriting it with an empty string when
        -- the model returns nothing, or when the copy check rejects the rewrite,
        -- would leave the page with no prose at all.
        summary = COALESCE(?, summary),
        role_source = CASE WHEN ? IS NULL THEN role_source ELSE ? END
      WHERE job_id = ?
    `).run(
      JSON.stringify(e.bullets ?? []),
      e.roleLabel || null,
      e.degreeLevel || null,
      e.degreeText || null,
      JSON.stringify(e.keySkills ?? []),
      e.stipendStatus || 'unknown',
      typeof e.isTech === 'boolean' ? (e.isTech ? 1 : 0) : null,
      e.summary?.trim() ? e.summary.trim() : null,
      typeof e.isTech === 'boolean' ? 1 : null,
      source,
      jobId,
    );
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // ---- runs -----------------------------------------------------------------

  /**
   * How long a run can plausibly still be alive.
   *
   * The scan budget is limits.maxRuntimeMinutes (90), plus enrichment and
   * publish after it. Three hours is comfortably past any real run and well
   * short of a genuinely orphaned one — the shortest orphan this was written
   * for was four hours old.
   */
  static #RUN_STALE_MS = 3 * 3_600_000;

  /**
   * Close out runs that never finished, then open a new one.
   *
   * A run is marked `running` when it starts and rewritten by finishRun when it
   * ends. Anything that kills the process in between — a battery dying mid-scan,
   * a kill, a crash — leaves the row saying `running` forever, because nothing
   * ever comes back to correct it. Nine had accumulated by 24 Aug, the oldest
   * from 26 July.
   *
   * They are harmless to the pipeline: resolveWindowHours measures from the last
   * `ok` run, so a phantom `running` cannot widen or narrow a window. They do
   * distort every count of run health, which is the first thing anyone reads
   * when asking whether collection is working.
   *
   * Reconciled here rather than by hand, because the condition that creates them
   * is exactly the condition that stops any cleanup code from running. The next
   * run to start is the first moment anything CAN notice.
   */
  startRun(runId) {
    const orphaned = this.db.prepare(
      "UPDATE runs SET status = 'interrupted', finished_at = started_at, error = COALESCE(error, 'process died before finishing') WHERE status = 'running' AND started_at < ?",
    ).run(Date.now() - Store.#RUN_STALE_MS);
    if (orphaned.changes) {
      log.info(`Marked ${orphaned.changes} unfinished run${orphaned.changes === 1 ? '' : 's'} as interrupted.`);
    }
    this.db.prepare('INSERT INTO runs (run_id, started_at, status) VALUES (?, ?, ?)')
      .run(runId, Date.now(), 'running');
    return orphaned.changes;
  }

  finishRun(runId, { status, pagesScanned = 0, cardsSeen = 0, detailsExtracted = 0, newJobs = 0, skippedNote = null, error = null }) {
    this.db.prepare(`
      UPDATE runs SET finished_at = ?, status = ?, pages_scanned = ?, cards_seen = ?,
                      details_extracted = ?, new_jobs = ?, skipped_note = ?, error = ?
      WHERE run_id = ?
    `).run(Date.now(), status, pagesScanned, cardsSeen, detailsExtracted, newJobs, skippedNote, error, runId);
  }

  /**
   * The last run that actually finished its sweep — 'ok' only, never 'partial'.
   *
   * This is the baseline the next lookback window is measured from, and
   * including 'partial' here silently lost postings. A partial run is one that
   * stopped at its time or details limit PART WAY THROUGH the window it was
   * given. Treating it as the new baseline means the next run starts from where
   * that run BEGAN, so everything it never paginated to is never looked at by
   * anything, ever. Twenty-nine of the last two hundred runs ended partial.
   *
   * With this restricted to 'ok', an incomplete sweep leaves the baseline where
   * it was and the next run re-covers the same window. The cost is re-walking
   * pages already seen, which is cheap — hasJob skips them before any page is
   * opened — and filters.maxWindowHours still caps how far back it can stretch.
   */
  lastFullSweep() {
    return this.db.prepare(
      "SELECT * FROM runs WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1",
    ).get();
  }

  recentRuns(limit = 10) {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  /**
   * When a REGION's own search last finished its walk.
   *
   * lastFullSweep() above is per-RUN, and that was the right granularity while
   * every search covered the same ground. It stops being right the moment two
   * searches cover different regions: a run that swept India and marked itself
   * `ok` would become the baseline for the US search too, and the US sweep
   * would then measure its lookback — and its covered-ground early stop — from
   * a run that never issued a single US request.
   *
   * The concrete failure that motivates this is the early stop, not the window.
   * coveredHorizon halts a search once two consecutive pages carry nothing
   * newer than the baseline. On a region's FIRST sweeps there is a backlog and
   * no baseline should exist at all, but the run-level one does, so the walk
   * would stop about two pages in — truncating exactly the ground those first
   * sweeps exist to cover. A region with no row here returns null, which the
   * caller reads as "never swept": full window, no early stop.
   *
   * Kept in `settings` rather than as a column on `runs` because one run can
   * complete some regions and abort partway through another, so the fact being
   * recorded belongs to the region and not to the run.
   */
  lastRegionSweep(region) {
    const at = Number(this.getSetting(`sweep_ok_at:${region}`) ?? 0);
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  /**
   * Record that `region` finished a full walk, starting at `startedAt`.
   *
   * The SEARCH'S OWN START is stored, never Date.now(). A sweep that takes
   * twelve minutes would otherwise declare the twelve minutes it spent walking
   * as already-covered ground, and every posting that went up during the walk
   * would fall behind the next run's horizon without ever having been read.
   */
  markRegionSweep(region, startedAt) {
    this.setSetting(`sweep_ok_at:${region}`, startedAt);
  }

  // ---- Google Indexing API queue --------------------------------------------

  /**
   * Record what Google should be told about a set of URLs.
   *
   * The model is two fields, not a log: `submitted` is the last thing Google
   * was told, `pending` is what it should be told next, and a call is owed
   * exactly when they differ. That is what makes this idempotent across the 48
   * publishes a day — enqueueing the same live page every run must not re-spend
   * a quota that is only 200 URLs per rolling 24h.
   *
   * Three cases are load-bearing:
   *  - A URL we have never announced cannot be DELETED. Google was never told
   *    it existed, so there is nothing to withdraw and the call would be waste.
   *  - A URL already owed the same action keeps its ORIGINAL `queued_at`.
   *    Bumping it every run would flatten the ordering `indexDue` sorts on, and
   *    a page published today would tie with one queued a week ago.
   *  - A page that is live again before its queued deletion went out has its
   *    deletion CANCELLED rather than sent and undone. That is an expiry
   *    followed by a relisting at the same slug, and it is cheaper to say
   *    nothing than to say two contradictory things.
   */
  indexQueue(urls, type, now = Date.now()) {
    const sel = this.db.prepare('SELECT pending, submitted FROM indexed_urls WHERE url = ?');
    const ins = this.db.prepare('INSERT INTO indexed_urls (url, pending, queued_at) VALUES (?, ?, ?)');
    const upd = this.db.prepare('UPDATE indexed_urls SET pending = ?, queued_at = ?, attempts = 0, error = NULL WHERE url = ?');
    const clr = this.db.prepare('UPDATE indexed_urls SET pending = NULL WHERE url = ?');
    let queued = 0;
    for (const url of urls) {
      const row = sel.get(url);
      if (!row) {
        if (type === 'URL_DELETED') continue;
        ins.run(url, type, now);
        queued++;
        continue;
      }
      if (row.submitted === type) {
        if (row.pending) clr.run(url);
        continue;
      }
      if (row.pending === type) continue;
      upd.run(type, now, url);
      queued++;
    }
    return queued;
  }

  /**
   * What to send next, most valuable first.
   *
   * Updates outrank deletions because an update is the whole point — a job page
   * lives 30 days on a domain with no authority, so being crawled in hours
   * rather than never is the entire return on this API. A deletion is only a
   * speed-up: the page already 404s, and Google drops a 404 on its own.
   *
   * Newest first WITHIN each kind, deliberately, and this is the opposite of a
   * normal queue. Seeding an existing board puts hundreds of URLs in here at
   * once; draining oldest-first would park every genuinely new posting behind
   * that backlog for days, which defeats the reason for using the API at all.
   */
  indexDue({ limit = 25, minAgeMs = 0, maxAttempts = 3, now = Date.now() } = {}) {
    return this.db.prepare(`
      SELECT url, pending AS type, queued_at, attempts
      FROM indexed_urls
      WHERE pending IS NOT NULL AND attempts < ? AND queued_at <= ?
      ORDER BY (pending = 'URL_UPDATED') DESC, queued_at DESC
      LIMIT ?
    `).all(maxAttempts, now - minAgeMs, limit);
  }

  indexMarkDone(url, type, now = Date.now()) {
    this.db.prepare(`
      UPDATE indexed_urls
      SET submitted = ?, submitted_at = ?, pending = NULL, attempts = 0, error = NULL
      WHERE url = ?
    `).run(type, now, url);
  }

  /** Failures accumulate rather than clearing `pending`: `indexDue` retires a
   *  URL once `attempts` reaches the cap, so a permanently bad one stops
   *  blocking the queue without being silently forgotten. */
  indexMarkFailed(url, message) {
    this.db.prepare('UPDATE indexed_urls SET attempts = attempts + 1, error = ? WHERE url = ?')
      .run(String(message).slice(0, 300), url);
  }

  /**
   * URLs successfully announced inside a rolling window — the daily-cap input.
   *
   * Counts URLs rather than calls, so a URL announced twice in one window
   * (published, expired, both inside 24h) counts once and this can undercount.
   * A 30-day page lifetime makes that close to impossible, and the configured
   * cap leaves headroom under the real 200 for exactly this reason.
   */
  indexCountSince(sinceMs) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM indexed_urls WHERE submitted_at >= ?').get(sinceMs).n;
  }

  indexStats({ now = Date.now(), maxAttempts = 3 } = {}) {
    const n = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    return {
      pendingUpdate: n("SELECT COUNT(*) AS n FROM indexed_urls WHERE pending = 'URL_UPDATED' AND attempts < ?", maxAttempts),
      pendingDelete: n("SELECT COUNT(*) AS n FROM indexed_urls WHERE pending = 'URL_DELETED' AND attempts < ?", maxAttempts),
      retired: n('SELECT COUNT(*) AS n FROM indexed_urls WHERE pending IS NOT NULL AND attempts >= ?', maxAttempts),
      submittedTotal: n('SELECT COUNT(*) AS n FROM indexed_urls WHERE submitted_at IS NOT NULL'),
      submitted24h: this.indexCountSince(now - 86400000),
      lastError: this.db.prepare('SELECT url, error, attempts FROM indexed_urls WHERE error IS NOT NULL ORDER BY queued_at DESC LIMIT 1').get() ?? null,
    };
  }

  // ---- settings / cooldown --------------------------------------------------

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  /**
   * After LinkedIn rate-limits or restricts the session, refuse to run again
   * until this timestamp. Walking straight back into a rate limit on the next
   * scheduled run is how a temporary block becomes a permanent one.
   */
  setCooldown(untilMs, reason) {
    this.setSetting('cooldown_until', untilMs);
    this.setSetting('cooldown_reason', reason);
  }

  /** Returns { until, reason } while a cooldown is active, else null. */
  activeCooldown() {
    const until = Number(this.getSetting('cooldown_until') ?? 0);
    if (!until || until <= Date.now()) return null;
    return { until, reason: this.getSetting('cooldown_reason') ?? 'unspecified' };
  }

  clearCooldown() {
    this.setSetting('cooldown_until', 0);
  }

  // ---- company id cache -----------------------------------------------------

  /** Register every watchlist name so the resolver has a work queue. */
  seedCompanyNames(entries) {
    const stmt = this.db.prepare(`
      INSERT INTO company_ids (name, display, status) VALUES (?, ?, 'pending')
      ON CONFLICT(name) DO NOTHING
    `);
    let added = 0;
    for (const { name, display } of entries) {
      const before = this.db.prepare('SELECT 1 FROM company_ids WHERE name = ?').get(name);
      stmt.run(name, display ?? name);
      if (!before) added++;
    }
    return added;
  }

  recordCompanyId(name, { linkedinId, slug, matchedAs }) {
    this.db.prepare(`
      UPDATE company_ids
      SET linkedin_id = ?, slug = ?, matched_as = ?, status = 'resolved',
          attempts = attempts + 1, resolved_at = ?
      WHERE name = ?
    `).run(linkedinId ?? null, slug ?? null, matchedAs ?? null, Date.now(), name);
  }

  /**
   * Mark a name as unresolvable. Kept distinct from 'pending' so the resolver
   * does not spend every future run retrying the same hopeless lookups; three
   * failures is treated as settled.
   */
  markCompanyUnresolved(name, reason) {
    this.db.prepare(`
      UPDATE company_ids
      SET attempts = attempts + 1,
          matched_as = ?,
          status = CASE WHEN attempts + 1 >= 3 THEN 'unresolved' ELSE 'pending' END
      WHERE name = ?
    `).run(reason ?? null, name);
  }

  pendingCompanyNames(limit = 150) {
    return this.db.prepare(
      "SELECT name, display, attempts FROM company_ids WHERE status = 'pending' ORDER BY attempts ASC, rowid ASC LIMIT ?",
    ).all(limit);
  }

  resolvedCompanyIds() {
    return this.db.prepare(
      "SELECT name, display, linkedin_id FROM company_ids WHERE status = 'resolved' AND linkedin_id IS NOT NULL ORDER BY rowid",
    ).all();
  }

  companyIdStats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM company_ids GROUP BY status').all();
    const out = { pending: 0, resolved: 0, unresolved: 0, total: 0 };
    for (const { status, n } of rows) {
      out[status] = n;
      out.total += n;
    }
    return out;
  }

  /**
   * Jobs still lacking a role verdict.
   *
   * Not just this run's: a row stored before the verdict column existed, or one
   * whose classification pass was skipped, must still be labelled or it lands
   * in the wrong tab forever. Classifying by "needs a verdict" rather than "was
   * captured this run" is what keeps the site correct.
   *
   * 'offline-uncertain' rows are re-queried too. Those were published on a
   * guess because the classifier API was unavailable and a posting must not
   * wait on a quota reset. They already have a verdict, so NULL alone would
   * never return them, and the guess would stand forever. Including them here
   * means Gemini reads the description and corrects the record as soon as it
   * can — publish first, get accurate second.
   */
  jobsNeedingRoleVerdict(sinceMs) {
    return this.db.prepare(`
      SELECT job_id, title, company FROM jobs
      WHERE (is_tech IS NULL OR role_source = 'offline-uncertain')
        AND first_seen_at >= ?
      ORDER BY first_seen_at DESC
    `).all(sinceMs);
  }

  /** The stored description, for classifying an ambiguous title. */
  descriptionFor(jobId) {
    return this.db.prepare('SELECT description FROM jobs WHERE job_id = ?').get(jobId)?.description ?? '';
  }

  /** Record a role verdict once the batch classifier has run. */
  setRoleVerdict(jobId, isTech, source) {
    this.db.prepare('UPDATE jobs SET is_tech = ?, role_source = ? WHERE job_id = ?')
      .run(isTech ? 1 : 0, source, jobId);
  }

  // ---- cards ----------------------------------------------------------------

  /** Have we already fully extracted this job in an earlier run? */
  hasJob(jobId) {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(jobId);
  }

  /**
   * Cheap record of a card we saw but chose not to open (wrong company, wrong
   * title). Lets later runs skip re-evaluating it and gives us honest counts.
   */
  noteSkippedCard(jobId, reason, company = null, title = null) {
    this.db.prepare(`
      INSERT INTO seen_cards (job_id, last_seen_at, reason, company, title)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        -- The reason has to move with the timestamp. It used to be written once
        -- and never again, so a card refused in June as off-watchlist still read
        -- "company not on watchlist" after the employer had been added and the
        -- card was being refused for something else entirely — with a timestamp
        -- from today. Every reason-based figure inherits that: the report's skip
        -- breakdown, topSkippedCompanies, and any attempt to ask why a posting
        -- never made the site. It read as 92 watchlist companies being turned
        -- away in six days when the true number was nil.
        reason       = excluded.reason,
        -- Null only because an older schema had no such column.
        company      = COALESCE(excluded.company, seen_cards.company),
        title        = COALESCE(excluded.title, seen_cards.title)
    `).run(jobId, Date.now(), reason, company, title);
  }

  /**
   * Titles the role classifier could not decide, plus ones it rejected.
   *
   * These are the evidence for tuning `extraTechTerms` / `extraNonTechTerms`.
   * A software role sitting in the 'role unclear' list is a miss, and this is
   * the only way to notice it.
   */
  skippedByRole(reason = 'role unclear', limit = 60) {
    return this.db.prepare(`
      SELECT title, company, last_seen_at
      FROM seen_cards
      WHERE reason = ? AND title IS NOT NULL AND title != ''
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(reason, limit);
  }

  /**
   * Which companies keep turning up and getting skipped.
   *
   * When a run reports "0 new jobs, 97 off-watchlist", this is the answer to
   * the obvious next question — who were those 97? Without it the watchlist is
   * impossible to tune from evidence.
   */
  topSkippedCompanies(limit = 30, sinceMs = 0) {
    return this.db.prepare(`
      SELECT company, COUNT(*) AS n
      FROM seen_cards
      WHERE reason = 'company not on watchlist'
        AND company IS NOT NULL AND company != ''
        AND last_seen_at >= ?
      GROUP BY LOWER(company)
      ORDER BY n DESC, company ASC
      LIMIT ?
    `).all(sinceMs, limit);
  }

  wasSkipped(jobId) {
    return !!this.db.prepare('SELECT 1 FROM seen_cards WHERE job_id = ?').get(jobId);
  }

  /**
   * Remember which posting a search card turned out to be.
   *
   * Written straight after a click, which is the only moment LinkedIn reveals
   * the id. `posted_at` is the opened posting's own timestamp, not the time of
   * the click — it is what a later run compares against to tell "the same card
   * again" from "the same role, relisted".
   */
  mapCard(cardKey, jobId, postedAt = null) {
    if (!cardKey || !jobId) return;
    this.db.prepare(`
      INSERT INTO card_keys (card_key, job_id, posted_at, last_seen_at, job_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(card_key) DO UPDATE SET
        job_id       = excluded.job_id,
        posted_at    = COALESCE(excluded.posted_at, card_keys.posted_at),
        last_seen_at = excluded.last_seen_at,
        -- Binding a DIFFERENT posting to an identity is the moment that
        -- identity proves it cannot tell two postings apart. Counted, not
        -- flagged, because the count is also the evidence when someone asks
        -- why a card is being reopened every sweep.
        job_count    = card_keys.job_count + (CASE WHEN excluded.job_id <> card_keys.job_id THEN 1 ELSE 0 END)
    `).run(cardKey, jobId, postedAt ?? null, Date.now());
  }

  /**
   * What an earlier run learned this card to be, or null.
   *
   * `posted_at` comes from the JOB, not from the cached copy on `card_keys`.
   * The cached one is rewritten to the newest sighting every time a card is
   * opened, so it slides forward — and the repost rule that compares against it
   * then never fires. That is how a genuinely new American Express
   * "Apprentice" posted at 22:47 was refused because a different one had been
   * seen at 18:02 the same day: 4h45m, under the 6-hour threshold. The job's
   * own posted time does not move, so it is the honest reference.
   */
  jobIdForCard(cardKey) {
    if (!cardKey) return null;
    return this.db.prepare(`
      SELECT k.job_id, k.job_count, COALESCE(j.posted_at, k.posted_at) AS posted_at
      FROM card_keys k LEFT JOIN jobs j ON j.job_id = k.job_id
      WHERE k.card_key = ?
    `).get(cardKey) ?? null;
  }

  /**
   * Move a row from the pre-location identity to the current one.
   *
   * The old row is DELETED rather than left in place. Leaving it would defeat
   * the reason location joined the key: the second city's card would miss the
   * new key, fall back to the old one, and be refused as already known exactly
   * as before.
   */
  migrateCardKey(oldKey, newKey, jobId, postedAt = null) {
    if (!oldKey || !newKey || oldKey === newKey) return;
    this.mapCard(newKey, jobId, postedAt);
    this.db.prepare('DELETE FROM card_keys WHERE card_key = ?').run(oldKey);
  }

  touchJob(jobId) {
    this.db.prepare('UPDATE jobs SET last_seen_at = ? WHERE job_id = ?').run(Date.now(), jobId);
  }

  /**
   * Fill in a logo for a job we already hold.
   *
   * An already-known job is skipped without being opened, so upsertJob never
   * runs for it — meaning rows stored before logo capture existed would never
   * acquire one. Their card still carries the URL, so take it from there. Only
   * writes when the column is empty.
   */
  backfillLogo(jobId, logoUrl) {
    if (!logoUrl) return false;
    const changes = this.db.prepare(
      'UPDATE jobs SET logo_url = ? WHERE job_id = ? AND (logo_url IS NULL OR logo_url = \'\')',
    ).run(logoUrl, jobId).changes;
    return changes > 0;
  }

  // ---- jobs -----------------------------------------------------------------

  /** Insert a newly extracted job. Returns true if it was genuinely new. */
  upsertJob(job, runId) {
    const now = Date.now();
    const existing = this.db.prepare('SELECT job_id FROM jobs WHERE job_id = ?').get(job.jobId);

    if (existing) {
      this.db.prepare(`
        UPDATE jobs SET last_seen_at = ?, salary_text = COALESCE(?, salary_text),
                        applicants = COALESCE(?, applicants), apply_url = COALESCE(?, apply_url),
                        logo_url = COALESCE(logo_url, ?)
        WHERE job_id = ?
      `).run(now, job.salaryText ?? null, job.applicants ?? null, job.applyUrl ?? null, job.logoUrl ?? null, job.jobId);
      return false;
    }

    this.db.prepare(`
      INSERT INTO jobs (
        job_id, title, company, company_matched, location, workplace_type,
        posted_text, posted_at, salary_text, stipend_min, stipend_max,
        stipend_currency, stipend_period, applicants, easy_apply, apply_url,
        job_url, duration, skills, description, summary, search_keywords,
        logo_url, is_tech, role_source, region, employment_type, first_seen_at, last_seen_at, first_run_id, reported
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).run(
      job.jobId,
      job.title ?? '(untitled)',
      job.company ?? null,
      job.companyMatched ?? null,
      job.location ?? null,
      job.workplaceType ?? null,
      job.postedText ?? null,
      job.postedAt ?? null,
      job.salaryText ?? null,
      job.stipend?.min ?? null,
      job.stipend?.max ?? null,
      job.stipend?.currency ?? null,
      job.stipend?.period ?? null,
      job.applicants ?? null,
      job.easyApply ? 1 : 0,
      job.applyUrl ?? null,
      job.jobUrl ?? null,
      job.duration ?? null,
      job.skills ? JSON.stringify(job.skills) : null,
      job.description ?? null,
      job.summary ?? null,
      job.searchKeywords ?? null,
      job.logoUrl ?? null,
      job.isTech == null ? null : (job.isTech ? 1 : 0),
      job.roleSource ?? null,
      // What the collector believed. Publish re-derives from the location every
      // run and only falls back to this when there is no location text at all —
      // see resolveRowRegion. Storing it is what makes the region queryable and
      // what lets a blank-location LinkedIn card keep its search's region.
      job.region ?? resolveRegion(job.location, { fallback: job.regionFallback ?? null }),
      job.employmentType ?? 'intern',
      now,
      now,
      runId,
    );
    return true;
  }

  jobsForRun(runId) {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE first_run_id = ? ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC',
    ).all(runId).map(hydrate);
  }

  unreportedJobs() {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE reported = 0 ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC',
    ).all().map(hydrate);
  }

  markReported(jobIds) {
    const stmt = this.db.prepare('UPDATE jobs SET reported = 1 WHERE job_id = ?');
    for (const id of jobIds) stmt.run(id);
  }

  /**
   * Postings recent enough to publish.
   *
   * Two rules, because the collectors mean different things by "still open".
   *
   * LINKEDIN: `first_seen_at` within the window. A LinkedIn posting genuinely
   * expires, we cannot see when, and 14 days from first sighting is the proxy
   * the site has always used.
   *
   * ATS: still ON THE BOARD. The board is the source of truth — if a company
   * still lists the role, it is still open, and `last_seen_at` says whether we
   * saw it on the most recent poll. Windowing those on `first_seen_at` was
   * throwing away live vacancies: on 23 Aug it dropped 37 US and 11 UK roles
   * that were on their boards that morning, which was more than half the US
   * board. India was losing them too, just less visibly, because LinkedIn keeps
   * refilling it.
   *
   * `postedFloorMs` still caps how old an ATS posting may be, so a requisition
   * a company leaves open for a year does not sit here forever — being first to
   * a seven-month-old listing is not being early.
   *
   * @param {number} sinceMs        first-seen floor, for LinkedIn rows
   * @param {object} [ats]          ATS rules; omit to apply sinceMs to everything
   * @param {number} ats.seenSinceMs   last-seen floor: still on the board
   * @param {number} ats.postedFloorMs oldest posted_at still worth showing
   */
  recentJobs(sinceMs, ats = null) {
    if (!ats) {
      return this.db.prepare(
        'SELECT * FROM jobs WHERE first_seen_at >= ? ORDER BY first_seen_at DESC',
      ).all(sinceMs).map(hydrate);
    }
    return this.db.prepare(`
      SELECT * FROM jobs
      WHERE first_seen_at >= ?
         OR (job_id LIKE 'ats:%'
             AND last_seen_at >= ?
             AND COALESCE(posted_at, first_seen_at) >= ?)
      ORDER BY first_seen_at DESC
    `).all(sinceMs, ats.seenSinceMs, ats.postedFloorMs).map(hydrate);
  }

  /**
   * How many stored postings sit in each region, engineering only.
   *
   * Reporting rather than publishing — publish re-derives the region per row —
   * but it is the cheap way to see whether a region has enough inventory to be
   * worth showing anybody before it is switched on.
   */
  regionCounts({ sinceMs = 0, techOnly = true } = {}) {
    const rows = this.db.prepare(`
      SELECT COALESCE(region, ?) AS region, COUNT(*) AS n
      FROM jobs
      WHERE first_seen_at >= ? ${techOnly ? 'AND is_tech = 1' : ''}
      GROUP BY COALESCE(region, ?)
      ORDER BY n DESC
    `).all(UNKNOWN, sinceMs, UNKNOWN);
    return Object.fromEntries(rows.map((r) => [r.region, r.n]));
  }

  /* ------------------------------------------------- the LinkedIn post queue */

  /**
   * Mark a posting for a hand-written LinkedIn post. Idempotent.
   *
   * A row already drafted is left exactly as it is: re-clicking Add on a job
   * whose post has been written must not throw the post away, because the queue
   * page is where he goes to copy it back.
   */
  queueAdd(jobId) {
    this.db.prepare(
      'INSERT INTO post_queue (job_id, added_at) VALUES (?, ?) ON CONFLICT(job_id) DO NOTHING',
    ).run(jobId, Date.now());
  }

  queueRemove(jobId) {
    this.db.prepare('DELETE FROM post_queue WHERE job_id = ?').run(jobId);
  }

  /** Empty the queue. `status` narrows it, e.g. clear only what has been drafted. */
  queueClear(status = null) {
    if (status) this.db.prepare('DELETE FROM post_queue WHERE status = ?').run(status);
    else this.db.exec('DELETE FROM post_queue');
  }

  queuedIds() {
    return this.db.prepare('SELECT job_id FROM post_queue').all().map((r) => r.job_id);
  }

  /**
   * Queued postings with their full job row.
   *
   * An inner join on purpose: a queue row whose job has since been removed has
   * nothing to write a post from, so it should simply stop appearing.
   */
  queuedJobs(status = null) {
    const where = status ? 'WHERE q.status = ?' : '';
    const rows = this.db.prepare(`
      SELECT j.*, q.added_at AS queued_at, q.status AS queue_status,
             q.batch_id, q.post_text, q.post_meta, q.drafted_at
      FROM post_queue q JOIN jobs j ON j.job_id = q.job_id
      ${where}
      ORDER BY q.added_at
    `).all(...(status ? [status] : []));
    return rows.map(hydrate);
  }

  /** Every posting in one generated batch, in the order it was queued. */
  draftedBatch(batchId) {
    return this.db.prepare(`
      SELECT j.*, q.added_at AS queued_at, q.status AS queue_status,
             q.batch_id, q.post_text, q.post_meta, q.drafted_at
      FROM post_queue q JOIN jobs j ON j.job_id = q.job_id
      WHERE q.batch_id = ?
      ORDER BY q.added_at
    `).all(batchId).map(hydrate);
  }

  saveDraft(jobId, batchId, postText, meta = null) {
    this.db.prepare(`
      UPDATE post_queue
      SET status = 'drafted', batch_id = ?, post_text = ?, post_meta = ?, drafted_at = ?
      WHERE job_id = ?
    `).run(batchId, postText, meta ? JSON.stringify(meta) : null, Date.now(), jobId);
  }

  /* ---- Instagram reels ------------------------------------------------ */

  reelPost(jobId) {
    return this.db.prepare('SELECT * FROM reel_posts WHERE job_id = ?').get(jobId) ?? null;
  }

  reelPosts() {
    return this.db.prepare('SELECT * FROM reel_posts ORDER BY started_at DESC').all();
  }

  /**
   * Claim a job for publishing.
   *
   * Returns false when the job is already published or in flight, which is what
   * makes a double-click harmless — the check and the write are one statement,
   * so two requests cannot both win. A previously FAILED row is allowed through:
   * a tunnel that did not come up is worth retrying, and refusing would strand
   * the job forever.
   */
  reelClaim(jobId, { region = null, source = 'manual', fingerprint = null } = {}) {
    const info = this.db.prepare(`
      INSERT INTO reel_posts (job_id, status, started_at, region, source, fingerprint)
      VALUES (?, 'rendering', ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE
        SET status = 'rendering', started_at = excluded.started_at,
            region = excluded.region, source = excluded.source,
            fingerprint = excluded.fingerprint,
            finished_at = NULL, error = NULL
        WHERE reel_posts.status = 'failed'
    `).run(jobId, Date.now(), region, source, fingerprint);
    return info.changes > 0;
  }

  /**
   * Description hashes this table has already committed to, so one ROLE is
   * never posted twice.
   *
   * The board learned this on 25 Aug: Procter & Gamble filed 22 copies of one
   * internship, one per city, each a real posting with its own id. Keyed on
   * company and title alone they would merge genuinely different jobs, so the
   * discriminator is a hash of the posting's own description. A feed is far
   * less forgiving than a board — two identical reels back to back read as a
   * broken bot, not as two vacancies.
   */
  reelKnownFingerprints() {
    return new Set(this.db.prepare(
      "SELECT DISTINCT fingerprint FROM reel_posts WHERE fingerprint IS NOT NULL AND status != 'failed'")
      .all().map((r) => r.fingerprint));
  }

  /**
   * Reels this region has PUBLISHED or is committed to publishing in the last
   * `sinceMs`, which is what the daily cap is measured against.
   *
   * Counts scheduled and in-flight rows too, not just published ones. The cap
   * exists to stay inside Instagram's 100-per-rolling-day quota, and a reel
   * already rendered and holding a slot will spend one of those posts — leaving
   * it out would let a single drain pass queue the whole day's allowance twice
   * over before the first one finished.
   */
  reelCountSince(region, sinceMs) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reel_posts
      WHERE region = ?
        AND status IN ('rendering', 'scheduled', 'publishing', 'published')
        AND COALESCE(publish_at, started_at) >= ?
    `).get(region, sinceMs);
    return row?.n ?? 0;
  }

  /**
   * Publish failures for this region since its last SUCCESSFUL publish.
   *
   * This is the number the auto-sweep's circuit breaker reads, and it exists
   * because the daily cap cannot see a failure at all: `reelCountSince` counts
   * rendering|scheduled|publishing|published and NOT failed, so every failure
   * frees a cap slot, the 60-second sweep queues a replacement, and that fails
   * too. On 28-29 Aug that loop produced 36 failed US reels against a cap of
   * 20 while Instagram was answering "API access blocked" — and hammering an
   * endpoint that is blocking you is the worst thing to be doing while an app
   * restriction is live. Twice now that has been stopped by hand.
   *
   * SINCE THE LAST SUCCESS, not a plain window count, so it clears itself: one
   * reel going out proves the endpoint is answering and the count returns to
   * zero with nothing to reset by hand. A window is still applied on top, so a
   * region that failed a fortnight ago and has simply been quiet since is not
   * held shut for ever.
   *
   * A CANCELLATION IS NOT A FAILURE. Rows retired by hand — an employer
   * dropped from the watchlist, a region switched off — are written as 'failed'
   * with the reason, deliberately, because `reelKnownJobIds` returns every row
   * whatever its status and a kept row is what stops the sweep re-queueing that
   * posting. They must not trip a breaker about Instagram.
   *
   * The discriminator is `finished_at`: the publisher stamps it whether the
   * attempt succeeded or failed, and a row cancelled before it was ever
   * attempted has none. Measured across the whole table when this was written —
   * all 36 real API failures carry one, and none of the 11 cancellations does.
   * There is deliberately no `finished_at IS NOT NULL` clause: the window
   * comparison below already excludes those rows, because any comparison with
   * NULL is false, and an explicit guard that no mutation can reach is a line
   * that only looks like it is doing something.
   */
  reelFailuresSinceSuccess(region, sinceMs) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM reel_posts
      WHERE region = ?
        AND status = 'failed'
        AND finished_at >= ?
        AND finished_at > COALESCE(
          (SELECT MAX(finished_at) FROM reel_posts
            WHERE region = ? AND status = 'published'), 0)
    `).get(region, sinceMs, region);
    return row?.n ?? 0;
  }

  /**
   * Free rows that were mid-render when this process last died.
   *
   * A row is CLAIMED as 'rendering' the moment it is queued, and the queue
   * itself is in memory — so if the helper stops, every 'rendering' row is
   * orphaned, and `reelClaim` only ever re-claims a FAILED one. Before this
   * existed they were stranded permanently, and because the sweep tops the
   * queue up every 60 seconds there was never a moment with nothing in flight:
   * the helper could not be restarted safely at all once automatic posting was
   * on. Marking them failed on boot puts them back in reach of the next sweep.
   *
   * ONLY 'rendering', NEVER 'publishing'. A row that died in the publishing
   * step may already be live on Instagram — the upload can succeed and the
   * process die before the permalink is written — and retrying that would post
   * the same reel twice, which cannot be undone. Those are left alone
   * deliberately; they still count against the daily cap, which is the safe
   * direction to be wrong in.
   *
   * Safe because this process is the only writer: nothing else renders.
   */
  reelReleaseOrphans() {
    /* DELETED, not marked failed. Marking them failed looked right and did
       nothing: `reelKnownJobIds` — which is how the sweep decides what it has
       already dealt with — returns EVERY row including failed ones, so a
       released orphan was skipped for ever and the release freed nothing.
       Deleting is also the honest record: the row asserts that a reel was
       attempted, and for these nothing was rendered, nothing was uploaded and
       nothing was published, so there is no attempt to remember. The posting
       becomes a candidate again on the next sweep, which is the whole point.

       A row that genuinely FAILED is untouched and stays failed, so a broken
       posting is still skipped rather than retried every 60 seconds. */
    const info = this.db.prepare("DELETE FROM reel_posts WHERE status = 'rendering'").run();
    return info.changes;
  }

  /** Job ids this table already knows about, so a candidate sweep can skip them. */
  reelKnownJobIds() {
    return new Set(this.db.prepare('SELECT job_id FROM reel_posts').all().map((r) => String(r.job_id)));
  }

  reelRendered(jobId, videoPath, caption, publishAt = null, format = null) {
    /* A reel that is due now goes straight to publishing; one with a slot in
       the future waits as 'scheduled'. Rendering happens either way, and it
       happens NOW rather than at the slot: he is at the keyboard when he
       presses the button, which is when a render failure is worth surfacing. */
    const status = publishAt && publishAt > Date.now() ? 'scheduled' : 'publishing';
    this.db.prepare(`
      UPDATE reel_posts SET status = ?, video_path = ?, caption = ?, publish_at = ?, format = ?
      WHERE job_id = ?
    `).run(status, videoPath, caption, publishAt ?? null, format ?? null, jobId);
    return status;
  }

  /** The next scheduled reel whose slot has arrived, if any. */
  reelDue(now = Date.now()) {
    return this.db.prepare(`
      SELECT * FROM reel_posts
      WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?
      ORDER BY publish_at LIMIT 1
    `).get(now) ?? null;
  }

  /** Everything still waiting, soonest first — what the next slot is measured from. */
  reelPending() {
    return this.db.prepare(`
      SELECT * FROM reel_posts WHERE status IN ('scheduled', 'rendering', 'publishing')
      ORDER BY COALESCE(publish_at, started_at)
    `).all();
  }

  /**
   * The most recent time a reel actually went out, optionally for one region.
   *
   * SCOPED PER REGION because spacing is per ACCOUNT: two regions post to two
   * different accounts with two different audiences and two separate quotas, so
   * a US reel going out says nothing about when India's next one may. Unscoped
   * it would make one board's activity delay the other's for no reason.
   * Rows written before there were two accounts carry region NULL and are
   * counted only by the unscoped call.
   */
  reelLastPublishedAt(region = null) {
    const r = region
      ? this.db.prepare(
        "SELECT MAX(finished_at) AS t FROM reel_posts WHERE status = 'published' AND region = ?").get(region)
      : this.db.prepare(
        "SELECT MAX(finished_at) AS t FROM reel_posts WHERE status = 'published'").get();
    return r?.t ?? null;
  }

  reelPublishing(jobId) {
    this.db.prepare("UPDATE reel_posts SET status = 'publishing' WHERE job_id = ?").run(jobId);
  }

  reelPublished(jobId, { mediaId, permalink }) {
    this.db.prepare(`
      UPDATE reel_posts SET status = 'published', media_id = ?, permalink = ?, finished_at = ?
      WHERE job_id = ?
    `).run(mediaId ?? null, permalink ?? null, Date.now(), jobId);
  }

  reelFailed(jobId, error) {
    this.db.prepare(`
      UPDATE reel_posts SET status = 'failed', error = ?, finished_at = ?
      WHERE job_id = ?
    `).run(String(error ?? '').slice(0, 500), Date.now(), jobId);
  }

  queueCounts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM post_queue GROUP BY status').all();
    const counts = { queued: 0, drafted: 0 };
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  /* ------------------------------------------------- web-discovered URLs */

  /** True the first time this URL is offered, false every time after. */
  noteDiscovered(url, status = 'pending', jobId = null) {
    const before = this.db.prepare('SELECT url FROM discovered_urls WHERE url = ?').get(url);
    this.db.prepare(`
      INSERT INTO discovered_urls (url, first_seen, status, job_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET status = excluded.status, job_id = COALESCE(excluded.job_id, job_id)
    `).run(url, Date.now(), status, jobId);
    return !before;
  }

  seenDiscovered(url) {
    return !!this.db.prepare('SELECT url FROM discovered_urls WHERE url = ?').get(url);
  }

  discoveryStats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM discovered_urls GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    const companies = this.db.prepare('SELECT COUNT(DISTINCT company_matched) AS n FROM jobs').get().n;
    const skipped = this.db.prepare('SELECT COUNT(*) AS n FROM seen_cards').get().n;
    return { total, companies, skipped };
  }
}

function hydrate(row) {
  return { ...row, skills: row.skills ? JSON.parse(row.skills) : [], easy_apply: !!row.easy_apply };
}
