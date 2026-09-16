/**
 * AN OPEN TAB CATCHES UP WITH THE BOARD — 16 SEP 2026.
 *
 * He read "checked 44 minutes ago" on the live site. Nothing was stale: the
 * page fetched jobs.json once at load and then only re-rendered the label every
 * minute, so on a tab left open the number counted up while the site itself had
 * published twice. (Publishes are 8-50 min apart — a long US run publishes only
 * when it ends — so the label is honest on a fresh load and wrong on an old tab.)
 *
 * The two ways the fix goes wrong are both silent, and both are pinned here:
 *   - a failed or unchanged refetch WIPING the board somebody is reading;
 *   - populateFilters appending, so every company appears twice, then three times.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};
const src = readFileSync(join(ROOT, 'web/public/app.js'), 'utf8');

/* Lifted out of the shipped file rather than restated. */
const lift = (from, until, name) => {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start);
  ok(`${name} was found in app.js`, start > 0 && end > start);
  return src.slice(start, end + until.length);
};

console.log('\n== only a newer payload is adopted ==');
{
  const shouldAdopt = new Function(`${lift('function shouldAdopt(', '\n}', 'shouldAdopt')}; return shouldAdopt;`)();
  ok('a failed fetch is refused', shouldAdopt(1000, null) === false);
  ok('a payload with no generatedAt is refused', shouldAdopt(1000, { jobs: [] }) === false);
  ok('an older payload is refused', shouldAdopt(2000, { generatedAt: 1000 }) === false);
  ok('the same payload is refused — no repaint under the cursor', shouldAdopt(2000, { generatedAt: 2000 }) === false);
  ok('a newer one is taken', shouldAdopt(2000, { generatedAt: 2001 }) === true);
  ok('and any real one is taken when we have nothing', shouldAdopt(null, { generatedAt: 1 }) === true);
}

console.log('\n== a refresh keeps the reader where they are ==');
{
  const body = lift('async function refreshBoard()', '\n}', 'refreshBoard');
  const make = (fetched) => {
    const calls = [];
    const listEl = { scrollTop: 120 };
    const state = { jobs: [{ id: 'old' }], generatedAt: 2000 };
    const fn = new Function('state', '$', 'fetchBoard', 'shouldAdopt', 'renderFreshness', 'renderTotal',
      'populateFilters', 'applyFilters', 'window', 'calls',
      `${body}; return refreshBoard;`)(
      state,
      () => listEl,
      async () => fetched,
      (cur, d) => !!d && d.generatedAt != null && (cur == null || d.generatedAt > cur),
      () => calls.push('freshness'),
      () => calls.push('total'),
      () => calls.push('filters'),
      () => { calls.push('filter+render'); listEl.scrollTop = 0; },   // renderList resets it
      { IDTrack: { refresh: () => calls.push('track') } },
      calls,
    );
    return { fn, state, calls, listEl };
  };

  const failed = make(null);
  const r1 = await failed.fn();
  ok('a failed refresh changes nothing', r1 === false && failed.state.jobs.length === 1 && failed.state.jobs[0].id === 'old');
  ok('and still ages the label', failed.calls.join(',') === 'freshness');

  const same = make({ generatedAt: 2000, jobs: [] });
  await same.fn();
  ok('an unchanged board is not repainted', same.state.jobs[0].id === 'old' && !same.calls.includes('filter+render'));

  const fresh = make({ generatedAt: 3000, jobs: [{ id: 'new' }, { id: 'new2' }] });
  const r3 = await fresh.fn();
  ok('a newer board replaces the rows', r3 === true && fresh.state.jobs.length === 2 && fresh.state.generatedAt === 3000);
  ok('the tracker is told about the new rows', fresh.calls.includes('track'));
  ok('the label, the count, the filters and the list are all redrawn',
    ['freshness', 'total', 'filters', 'filter+render'].every((c) => fresh.calls.includes(c)));
  ok('and the scroll position is put back', fresh.listEl.scrollTop === 120, String(fresh.listEl.scrollTop));
}

console.log('\n== the filter lists are rebuilt, never appended to ==');
{
  const body = lift('function populateFilters()', '\n}\n', 'populateFilters');
  const select = (placeholder) => {
    const opts = [{ value: '', text: placeholder }];
    return {
      value: '',
      options: opts,
      append(o) { opts.push(o); },
      remove(i) { opts.splice(i, 1); },
    };
  };
  const run = (jobs, chosen) => {
    const company = select('All companies');
    const location = select('All locations');
    company.value = chosen ?? '';
    const state = { jobs };
    new Function('state', '$', 'Option', `${body}; return populateFilters;`)(
      state,
      (id) => (id === 'f-company' ? company : location),
      function Opt(value, text) { return { value, text }; },
    )();
    return { company, location };
  };

  const jobs = [{ company: 'Zoho', location: 'Chennai' }, { company: 'Acme', location: 'Pune' }, { company: 'Acme', location: 'Pune' }];
  const first = run(jobs);
  ok('one option per company, alphabetical, after the placeholder',
    first.company.options.map((o) => o.value).join(',') === ',Acme,Zoho', first.company.options.map((o) => o.value).join(','));
  ok('and one per location', first.location.options.map((o) => o.value).join(',') === ',Chennai,Pune');

  /* THE BUG THIS EXISTS FOR: called twice, the old code listed everything twice. */
  const twice = run(jobs);
  new Function('state', '$', 'Option', `${body}; return populateFilters;`)(
    { jobs }, (id) => (id === 'f-company' ? twice.company : twice.location),
    function Opt(value, text) { return { value, text }; },
  )();
  ok('a second call does not duplicate anything', twice.company.options.map((o) => o.value).join(',') === ',Acme,Zoho',
    twice.company.options.map((o) => o.value).join(','));

  const kept = run(jobs, 'Acme');
  ok('the reader\'s choice survives the rebuild', kept.company.value === 'Acme');
  const gone = run([{ company: 'Zoho', location: 'Chennai' }], 'Acme');
  ok('and survives even when that employer has aged off the board',
    gone.company.value === 'Acme' && gone.company.options.some((o) => o.value === 'Acme'));
}

console.log('\n== wired into the page ==');
{
  ok('the refresh interval is five minutes', /const REFRESH_MS = 5 \* 60 \* 1000;/.test(src));
  ok('an open tab refreshes on that interval',
    /setInterval\(\(\) => \{ if \(!document\.hidden\) refreshBoard\(\); \}, REFRESH_MS\);/.test(src));
  ok('a hidden tab does not — it catches up when it comes back',
    /visibilitychange', \(\) => \{ if \(!document\.hidden\) refreshBoard\(\); \}\)/.test(src));
  ok('the label still ages every minute', /setInterval\(renderFreshness, 60000\);/.test(src));
  /* The FIRST load keeps the opposite failure: nothing to show, so show nothing. */
  const load = src.slice(src.indexOf('async function loadJobs()'), src.indexOf('async function fetchBoard()'));
  ok('a failed first load still empties the board', /catch \{\s*state\.jobs = \[\];/.test(load));
  ok('the refetch is conditional, like the first one',
    (src.match(/fetch\(DATA_URL, \{ cache: 'no-cache' \}\)/g) ?? []).length === 2);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
