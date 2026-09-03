/**
 * Removing ONE posting must survive the next sweep.
 *
 * `bin/remove-company.js --job <id>` used to run `DELETE FROM jobs`, and that
 * removes a LinkedIn posting for about thirty minutes. The scan skips a card
 * two ways and both need the row:
 *
 *   before the click:  known && store.hasJob(known.job_id)
 *   after the click:   store.hasJob(jobId)
 *
 * Delete the row and neither fires, so the card is opened, `mapCard` rewrites
 * the card_keys binding, and the posting is stored straight back.
 *
 * CLEARING `card_keys` TOO IS THE OBVIOUS WRONG FIX and is worth naming here,
 * because it is what anyone reaching for this will try first: the binding is
 * re-created by `mapCard` immediately after the click, and the decision still
 * comes down to `hasJob`. The row is the only thing that carries the answer.
 *
 * So `--job` suppresses instead: `is_tech = 0` plus a `suppressed_reason`, which
 * is also what tells bin/recheck-tech.js a HUMAN pulled it.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond, extra = '') => check(label + (extra ? ` — ${extra}` : ''), !!cond, true);

const script = readFileSync(join(ROOT, 'bin/remove-company.js'), 'utf8');
const storeSrc = readFileSync(join(ROOT, 'src/store.js'), 'utf8');

console.log('\n== the single-posting path does not delete the row ==');

/* The apply step, sliced out so the COMPANY branch — which still deletes, and
   is safe because the blocklist stops the name returning — cannot satisfy
   these on the job branch's behalf. */
const applyStart = script.indexOf('if (JOB_ID) {', script.indexOf('const marks ='));
const applyEnd = script.indexOf('\n}', applyStart);
const jobBranch = script.slice(applyStart, applyEnd);
ok('the apply step branches on JOB_ID', applyStart > 0);
ok('the job branch suppresses', /UPDATE jobs SET is_tech = 0, suppressed_reason = \?/.test(jobBranch));
ok('and records a reason', /suppressed_reason = \?/.test(jobBranch));
check('the job branch NEVER deletes from jobs', /DELETE FROM jobs/.test(jobBranch), false);
// Deleting the binding is the wrong fix and must not creep back in as a "tidy-up".
check('and never clears card_keys', /card_keys/.test(jobBranch), false);
// The company branch is a different case and must keep deleting.
ok('the company branch still deletes', /DELETE FROM jobs/.test(script.slice(applyEnd)));

console.log('\n== a --reason value is not mistaken for a company name ==');
/* `--reason "not software"` would otherwise be picked up by the bare-argument
   scan and the script would try to remove a company called "not software". */
ok('flag values are excluded from the name scan', /FLAG_VALUES/.test(script));
ok('and --reason is one of them', /'--job', '--reason'/.test(script));

console.log('\n== the suppression holds against the real schema ==');
const ddl = storeSrc.match(/CREATE TABLE IF NOT EXISTS jobs \([^;]*\);/);
ok('the jobs DDL was found in src/store.js', !!ddl);

/* `suppressed_reason` is added by a MIGRATION, not by the base DDL — this
   schema is additive-only, so new columns arrive as ALTER TABLE. Lifting the
   migration list too means a rename there fails this file instead of drifting
   past it, and it is what makes the assertions below run against the real
   column set rather than a stale CREATE TABLE. */
const migrated = [...storeSrc.matchAll(/\['([a-z_]+)', '([A-Z]+[^']*)'\],/g)].map((m) => [m[1], m[2]]);
ok('the jobs migrations were found', migrated.length > 0, `${migrated.length} columns`);
ok('…including suppressed_reason', migrated.some(([n]) => n === 'suppressed_reason'));

const db = new DatabaseSync(':memory:');
db.exec(ddl[0]);
const baseCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
for (const [name, type] of migrated) {
  if (!baseCols.includes(name)) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`); } catch { /* belongs to another table */ }
  }
}
ok('suppressed_reason exists after migrating',
  db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'suppressed_reason'));
const now = Date.now();
db.prepare('INSERT INTO jobs (job_id, title, company, is_tech, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)')
  .run('j1', 'Service Intern', 'Acme', 1, now, now);
// bullets is what stops re-enrichment; give it one so the guard below is real.
db.prepare('UPDATE jobs SET bullets = ? WHERE job_id = ?').run(JSON.stringify(['a', 'b']), 'j1');

db.prepare('UPDATE jobs SET is_tech = 0, suppressed_reason = ? WHERE job_id = ?').run('not software', 'j1');
const row = db.prepare('SELECT job_id, is_tech, suppressed_reason, bullets FROM jobs WHERE job_id = ?').get('j1');

check('the row still exists', !!row, true);
check('it is no longer tech, so publish drops it', row.is_tech, 0);
check('and a human is recorded as the reason', row.suppressed_reason, 'not software');
/* The two revisit guards, asserted as the queries state them: a suppressed row
   must satisfy NEITHER, or the model would quietly undo the removal. */
check('needingEnrichment cannot pick it up (bullets IS NOT NULL)', row.bullets !== null, true);
check('jobsNeedingRoleVerdict cannot pick it up (is_tech IS NOT NULL)', row.is_tech !== null, true);
/* And the scan's own guard still answers "known", which is the whole point. */
check('hasJob still finds it, so the card is never re-opened',
  !!db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get('j1'), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
