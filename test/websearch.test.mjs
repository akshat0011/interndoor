import { buildQuery, search, searchConfigured, MAX_PER_QUERY } from '../src/websearch.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

console.log('\n== the query sent to Google ==');
const u = new URL(buildQuery({ q: 'intern India', site: 'amazon.jobs', dateRestrict: 'd7', key: 'K', cx: 'C' }));
ok('hits the Custom Search endpoint', u.origin + u.pathname === 'https://www.googleapis.com/customsearch/v1');
ok('carries the key and the engine', u.searchParams.get('key') === 'K' && u.searchParams.get('cx') === 'C');
ok('carries the query', u.searchParams.get('q') === 'intern India');
// The engine searches the whole web and each query narrows it, so the list of
// careers sites lives in config.json rather than in a Google console.
ok('restricts to the site', u.searchParams.get('siteSearch') === 'amazon.jobs');
ok('and INCLUDES rather than excludes it', u.searchParams.get('siteSearchFilter') === 'i');
ok('carries the freshness window', u.searchParams.get('dateRestrict') === 'd7');

console.log('\n== the parts that are optional ==');
const bare = new URL(buildQuery({ q: 'x', key: 'K', cx: 'C' }));
ok('no site means no site filter', !bare.searchParams.has('siteSearch') && !bare.searchParams.has('siteSearchFilter'));
ok('no window means no dateRestrict', !bare.searchParams.has('dateRestrict'));
ok('defaults to a full page of results', bare.searchParams.get('num') === String(MAX_PER_QUERY));
// Google returns at most 10 whatever you ask for; sending 50 just looks wrong
// in a log when 10 come back.
ok('never asks for more than Google returns', new URL(buildQuery({ q: 'x', num: 50, key: 'K', cx: 'C' })).searchParams.get('num') === '10');

console.log('\n== a query is escaped, not concatenated ==');
const nasty = new URL(buildQuery({ q: 'intern & "SDE I" 2027', site: 'amazon.jobs', key: 'K', cx: 'C' }));
ok('ampersands and quotes survive intact', nasty.searchParams.get('q') === 'intern & "SDE I" 2027');

console.log('\n== no credentials is a no-op, never a throw ==');
const key = process.env.GOOGLE_CSE_KEY;
const cx = process.env.GOOGLE_CSE_CX;
delete process.env.GOOGLE_CSE_KEY;
delete process.env.GOOGLE_CSE_CX;
ok('reports itself unconfigured', searchConfigured() === false);
// A discovery pass is the least important thing the scheduler does. It must
// never be the reason a scan fails.
const empty = await search({ q: 'anything', site: 'amazon.jobs' });
ok('returns an empty list rather than throwing', Array.isArray(empty) && empty.length === 0);
if (key) process.env.GOOGLE_CSE_KEY = key;
if (cx) process.env.GOOGLE_CSE_CX = cx;
ok('a key alone is not enough', (() => {
  process.env.GOOGLE_CSE_KEY = 'K'; delete process.env.GOOGLE_CSE_CX;
  const v = searchConfigured();
  delete process.env.GOOGLE_CSE_KEY;
  if (key) process.env.GOOGLE_CSE_KEY = key;
  if (cx) process.env.GOOGLE_CSE_CX = cx;
  return v === false;
})());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
