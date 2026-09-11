/**
 * Post-queue retention.
 *
 * `post_queue` used to keep a drafted row for ever, and `/posts/latest` renders
 * the WHOLE queue rather than one batch — so the page grew to 40 drafts and
 * 265 KB, the oldest 13 days old. His instruction (11 Sep 2026) was to keep the
 * current day's posts and drop the rest after 24 hours.
 *
 * Every case here works on an in-memory database and a scratch directory.
 * `prunePostPages` deletes real files, so a test that let it default to
 * PATHS.posts would delete his actual pages — which is why it takes the
 * directory as an argument at all.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, readdirSync, existsSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { prunePostPages, writePostsPage } from '../src/postpage.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function ok(label, cond) { check(label, !!cond, true); }

/* The REAL schema, lifted out of src/store.js rather than restated here, so a
   column renamed there fails this file instead of drifting past it. */
const storeSrc = readFileSync('src/store.js', 'utf8');
// NOT [^;]* — the DDL carries a semicolon inside one of its own SQL comments,
// which stops that class dead and yields a silent null. Section 16's
// regex-meets-a-comment, in a third costume.
const ddl = storeSrc.match(/CREATE TABLE IF NOT EXISTS post_queue \([\s\S]*?\n\);/);
ok('the post_queue DDL was found in src/store.js', !!ddl);
// Read defensively: without the DDL every case below would THROW rather than
// fail, and a throw stops the whole `npm test` && chain instead of one file.
const DDL = ddl?.[0] ?? 'CREATE TABLE post_queue (job_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL,'
  + " status TEXT NOT NULL DEFAULT 'queued', batch_id TEXT, post_text TEXT, post_meta TEXT, drafted_at INTEGER);";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const CUTOFF = NOW - 24 * HOUR;

function freshStore(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const s = { db };
  s.prunePostQueue = Store.prototype.prunePostQueue.bind(s);
  const ins = db.prepare('INSERT INTO post_queue (job_id, added_at, status, drafted_at) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.added, r.status, r.drafted ?? null);
  return s;
}
const idsIn = (s) => s.db.prepare('SELECT job_id FROM post_queue ORDER BY job_id').all().map((r) => r.job_id);

console.log('\n== a drafted row is judged from when its post was written ==');
{
  const s = freshStore([
    // Queued days ago, drafted an hour ago: the POST is fresh, so it stays.
    { id: 'fresh-draft', added: NOW - 200 * HOUR, status: 'drafted', drafted: NOW - 1 * HOUR },
    { id: 'stale-draft', added: NOW - 200 * HOUR, status: 'drafted', drafted: NOW - 25 * HOUR },
  ]);
  check('dropped', s.prunePostQueue(CUTOFF), 1);
  check('the fresh draft survives its old added_at', idsIn(s), ['fresh-draft']);
}

console.log('\n== an undrafted row is judged from when it was queued ==');
{
  // The second half of the COALESCE, and the reason it exists: generating a
  // week-old queued row produces exactly the stale post this prevents.
  const s = freshStore([
    { id: 'fresh-queue', added: NOW - 2 * HOUR, status: 'queued' },
    { id: 'stale-queue', added: NOW - 30 * HOUR, status: 'queued' },
  ]);
  check('dropped', s.prunePostQueue(CUTOFF), 1);
  check('only the stale one goes', idsIn(s), ['fresh-queue']);
}

console.log('\n== the boundary, and an empty queue ==');
{
  const s = freshStore([
    { id: 'on-the-cutoff', added: NOW, status: 'drafted', drafted: CUTOFF },
    { id: 'just-past-it', added: NOW, status: 'drafted', drafted: CUTOFF - 1 },
  ]);
  check('a row exactly on the cutoff is KEPT', s.prunePostQueue(CUTOFF), 1);
  check('only the older one went', idsIn(s), ['on-the-cutoff']);
  check('pruning again drops nothing', s.prunePostQueue(CUTOFF), 0);
}
check('an empty queue prunes to zero', freshStore([]).prunePostQueue(CUTOFF), 0);

console.log('\n== the stored pages: what must NEVER be deleted ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-posts-'));
  const old = (NOW - 48 * HOUR) / 1000, recent = (NOW - 1 * HOUR) / 1000;
  const write = (name, secs) => {
    const f = join(dir, name);
    writeFileSync(f, '<html></html>', 'utf8');
    utimesSync(f, secs, secs);
  };
  write('posts-2026-08-24T12-31-13-257Z.html', old);
  write('posts-rerender.html', old);              // no stamp in the name; aged by mtime like the rest
  write('posts-2026-09-11T03-06-51-332Z.html', recent);
  write('posts-2026-08-24T12-31-13-257Z.json', old);  // same prefix, not a page
  write('latest.html', old);                       // the page he opens
  write('weekly-2026-W35.html', old);              // a different feature, different lifetime
  write('weekly-latest.html', old);

  check('two aged batch pages go', prunePostPages(CUTOFF, dir), 2);
  check('and these survive', readdirSync(dir).sort(),
    ['latest.html', 'posts-2026-08-24T12-31-13-257Z.json',
      'posts-2026-09-11T03-06-51-332Z.html', 'weekly-2026-W35.html', 'weekly-latest.html']);
  check('pruning again is a no-op', prunePostPages(CUTOFF, dir), 0);
}
{
  // A UNIQUE name, made and then removed. A fixed /tmp path is poisoned by its
  // own history: a mutation that created the directory once left it there, and
  // the NEXT clean run then failed the does-not-create assertion for a reason
  // that had nothing to do with the code under test.
  const gone = mkdtempSync(join(tmpdir(), 'interndoor-gone-'));
  rmdirSync(gone);
  check('a directory that does not exist prunes to zero', prunePostPages(CUTOFF, gone), 0);
  ok('and it does not create one', !existsSync(gone));
}

console.log('\n== a re-render must not stamp a batch file ==');
{
  // latest.html holds the whole queue, so writing it under the newest
  // survivor's id would file other batches' drafts under that batch.
  const src = readFileSync('src/postpage.js', 'utf8');
  const body = src.slice(src.indexOf('export function writePostsPage'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  ok('latest is written before the batch-id guard',
    fn.indexOf('PATHS.latestPosts') < fn.indexOf('batchId == null'));
  ok('a null batch id returns early, before any posts-<id> write',
    fn.indexOf('batchId == null') < fn.indexOf('posts-${batchId}'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
