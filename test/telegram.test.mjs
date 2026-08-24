import { compose } from '../src/telegram.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

const job = (over = {}) => ({
  job_id: '4449259269', company: 'NoBroker.com',
  title: 'Engineering Intern', location: 'Bengaluru', workplace_type: 'On-site', ...over,
});

console.log('\n== one message per run ==');
const three = compose([job(), job({ job_id: '2', title: 'Backend Intern' }), job({ job_id: '3', title: 'QA Intern' })]);
ok('header counts the batch', three.includes('<b>3 new internships</b>'));
ok('singular when there is one', compose([job()]).includes('<b>1 new internship</b>'));
ok('every role is named', ['Engineering Intern', 'Backend Intern', 'QA Intern'].every((t) => three.includes(t)));

console.log('\n== links point at the site, not LinkedIn ==');
ok('links to the job page on interndoor.com', three.includes('https://interndoor.com/jobs/nobroker-com-engineering-intern-4449259269'));
ok('closes with a link to the feed', three.includes('>See every live role →</a>'));
ok('no linkedin.com links', !three.includes('linkedin.com'));

console.log('\n== untrusted text is escaped ==');
// A real posting title with an ampersand; unescaped it makes Telegram 400 the
// whole message, silently dropping every job in the batch.
const nasty = compose([job({ company: 'Tom & Jerry <Labs>', title: 'Dev & Ops Intern' })]);
ok('ampersands escaped', nasty.includes('Tom &amp; Jerry'));
ok('angle brackets escaped', nasty.includes('&lt;Labs&gt;'));
ok('no raw < from the data survives', !/Jerry <Labs/.test(nasty));

console.log('\n== stays inside Telegram limits ==');
const many = Array.from({ length: 40 }, (_, i) =>
  job({ job_id: String(i), title: 'A very long internship title that goes on '.repeat(4) + i }));
const big = compose(many);
ok('under the 4096-char hard limit', big.length < 4096, `${big.length} chars`);
ok('says how many were not listed', /and \d+ more on the site/.test(big));
ok('does not truncate mid-tag', (big.match(/<a /g) || []).length === (big.match(/<\/a>/g) || []).length);

console.log('\n== degenerate input ==');
ok('missing location does not print a stray dash', !compose([job({ location: null, workplace_type: null })]).includes(' — \n'));

console.log('\n== every link carries its region ==');
// A listing links to its page on the site, and those pages live under the
// region's own prefix. A US role posted with an India link is a 404 sent
// straight to a subscriber.
const us = compose([job({ company: 'Databricks', location: 'San Francisco, CA' })], regionOf('US'));
ok('job link is prefixed', us.includes('https://interndoor.com/us/jobs/'));
ok('footer link is prefixed', us.includes('<a href="https://interndoor.com/us/">'));
ok('no unprefixed job link leaks in', !us.includes('interndoor.com/jobs/'));

const uk = compose([job()], regionOf('GB'));
ok('GB is served at /uk/, not /gb/', uk.includes('interndoor.com/uk/jobs/') && !uk.includes('/gb/'));

console.log('\n== India is unchanged, and is the default ==');
// India sits at the ROOT, so its links must carry no prefix at all — and
// compose() with no region argument must still produce exactly that.
const inExplicit = compose([job()], regionOf('IN'));
const inDefault = compose([job()]);
ok('default region is India', inDefault === inExplicit);
ok('no prefix on an India link', inDefault.includes('interndoor.com/jobs/'));
ok('no double slash from the empty slug', !inDefault.includes('interndoor.com//'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
