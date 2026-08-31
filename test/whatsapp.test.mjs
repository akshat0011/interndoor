import { composeWhatsApp, MAX_MESSAGE } from '../src/whatsapp.js';
import { composeJob, jobParts } from '../src/telegram.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN');
const job = (extra = {}) => ({
  id: '4458863278', company: 'Joveo', title: 'Software Engineer Intern',
  location: 'Bengaluru, Karnataka, India', workplaceType: 'Hybrid',
  applicants: '20 applicants', postedAt: Date.now() - 4 * 3600_000,
  applyUrl: 'https://www.linkedin.com/jobs/view/4458863278', ...extra,
});

console.log('\n== the two channels say the same thing ==');
{
  const p = jobParts(job(), IN);
  const w = composeWhatsApp(job(), IN);
  const t = composeJob(job(), IN);
  ok('both name the employer', w.includes(p.company) && t.includes(p.company));
  ok('both carry the job page', w.includes(p.page) && t.includes(p.page));
  for (const f of p.facts) ok(`whatsapp carries: ${f.slice(0, 22)}`, w.includes(f));
}

console.log('\n== but they are rendered for their own client ==');
{
  const w = composeWhatsApp(job(), IN);
  ok('no HTML anywhere', !/<b>|<a |&amp;|&lt;/.test(w));
  ok('bold is asterisks', w.includes('*Joveo*'));
  /* WhatsApp builds its preview card from the FIRST url. Leading with the
     employer's apply link would render LinkedIn's card on every post and throw
     away the per-posting OG image the site generates. */
  const first = w.match(/https?:\/\/\S+/)[0];
  ok('our job page is the first link', first.startsWith('https://interndoor.com/jobs/'));
  ok('the employer link still appears', w.includes('https://www.linkedin.com/jobs/view/4458863278'));
}

console.log('\n== a link is never cut in half ==');
{
  /* Real titles run to 172 characters — one employer names fifteen cities in
     one. Trimming has to drop whole FACTS, because slicing the string would
     cut a URL and WhatsApp renders the fragment as dead plain text. */
  /* THE TITLE CANNOT DO IT — jobParts already clamps it to 110 characters, so
     a fixture built on a long title never reaches the cap and the assertion
     passes while testing nothing. A mutation run is what said so. degreeText
     is passed through unclamped, so that is what overflows it. */
  const overflowing = job({
    degreeText: Array.from({ length: 120 }, (_, i) => `Qualification${i}`).join(' / '),
  });
  const untrimmed = [jobParts(overflowing, IN).facts.join('\n')].join('').length;
  ok('the fixture really is over the cap', untrimmed > MAX_MESSAGE);
  const huge = composeWhatsApp(overflowing, IN);
  ok('within the cap', huge.length <= MAX_MESSAGE);
  for (const url of huge.match(/https?:\/\/\S+/g) ?? []) {
    ok(`intact url: ${url.slice(8, 30)}`, /^https:\/\/(interndoor\.com|www\.linkedin\.com)\//.test(url));
  }
}

console.log('\n== the same link is never printed twice ==');
{
  /* With no employer URL, `apply` falls back to the job page. Printing it
     again under "Apply" reads as a mistake. */
  const w = composeWhatsApp(job({ applyUrl: '', url: '' }), IN);
  const page = jobParts(job({ applyUrl: '', url: '' }), IN).page;
  check('job page appears once', (w.match(new RegExp(page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
  ok('and no empty Apply line', !w.includes('👉 Apply:'));
}

console.log('\n== a zero applicant count is the strongest line, not "only 0" ==');
{
  const w = composeWhatsApp(job({ applicants: '0 applicants' }), IN);
  ok('says be the first', w.includes('No applicants yet'));
  ok('never says only 0', !/only 0/i.test(w));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
