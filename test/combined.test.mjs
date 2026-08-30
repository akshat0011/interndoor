import { composeCombined, jobFacts, isZeroPay, boldSans, MAX_POST_CHARS } from '../src/postgen.js';
import { buildReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const cfg = loadConfig();
const row = (id, company, title, location, extra = {}) => ({
  job_id: id, company, title, location,
  job_url: `https://www.linkedin.com/jobs/view/${id}`, apply_url: '',
  posted_at: Date.now(), first_seen_at: Date.now(), is_tech: 1, ...extra,
});
const facts = (rows) => rows.map((r) => jobFacts(r, cfg, 'combined'));

console.log('\n== zero is not an amount ==');
{
  for (const v of ['₹0', '₹ 0', '0', '$0.00', '₹0 - ₹0']) ok(`${v} is zero pay`, isZeroPay(v));
  for (const v of ['₹20,000 / month', '$30 / hour', 'Unpaid', '', null]) {
    check(`${JSON.stringify(v)} is not`, isZeroPay(v), false);
  }
  /* THE RANGE IS THE ONE THAT MATTERS. A lower bound of zero with a real upper
     bound is a real stipend, and an all-figures-are-zero test is what keeps it. */
  check('a range with a real upper bound survives', isZeroPay('₹0 - ₹50,000'), false);
}

console.log('\n== one post, every posting keeping its own link ==');
{
  const rows = [
    row('1', 'Qualcomm', 'Hardware Intern', 'Bengaluru, Karnataka, India'),
    row('2', 'Infineon', 'Verilog Intern', 'Pune, Maharashtra, India'),
    row('3', 'Philips', 'Embedded Intern', 'Bengaluru, Karnataka, India'),
  ];
  const text = composeCombined(facts(rows));
  check('one link per posting', (text.match(/\n→ /g) ?? []).length, 3);
  ok('the count leads', text.includes(boldSans('3')));
  // The employer leads each entry in bold sans, so the ASCII name is not
  // present — asserting on it passed vacuously until a run said otherwise.
  for (const r of rows) ok(`${r.company} is named`, text.includes(boldSans(r.company)));
  ok('within LinkedIn\'s limit', text.length <= MAX_POST_CHARS);
  check('deterministic', composeCombined(facts(rows)), text);
  check('an empty selection is an empty string', composeCombined([]), '');
}

console.log('\n== a zero stipend never reaches the post ==');
{
  const text = composeCombined(facts([
    row('9', 'Joveo', 'Frontend Intern', 'Bengaluru, Karnataka, India',
      { stipend_min: 0, stipend_max: 0, stipend_currency: 'INR', stipend_period: 'month' }),
  ]));
  ok('no zero figure', !/₹\s*0\b/.test(text));
  ok('and no money line at all for that row', !text.includes('💰'));
}

console.log('\n== what does not fit is COUNTED, not dropped in silence ==');
{
  /* Long titles so the budget is genuinely reached — the same discipline the
     weekly roundup follows, because a post that quietly loses half its
     listings reads as though there were half as many. */
  const many = Array.from({ length: 40 }, (_, i) => row(
    String(100 + i), `Employer Number ${i}`,
    'Software Engineering Internship for the Summer 2027 Cohort, Platform Group',
    'San Francisco, CA',
  ));
  const text = composeCombined(facts(many));
  ok('still within the limit', text.length <= MAX_POST_CHARS);
  const shown = (text.match(/\n→ /g) ?? []).length;
  ok('some were shed', shown < many.length);
  ok('and the shortfall is stated', text.includes(`${many.length - shown} more`));
  // The heading is bold sans, so the digits are surrogate pairs and not '40'.
  ok('the heading still counts them all', text.includes(boldSans('40')));
}

console.log('\n== the footer follows the rows, not rows[0] ==');
{
  const mixed = [
    row('5', 'Qualcomm', 'Intern', 'Bengaluru, Karnataka, India'),
    row('6', 'SpaceX', 'Intern', 'Hawthorne, CA'),
    row('7', 'Stripe', 'Intern', 'South San Francisco, CA'),
  ];
  const text = composeCombined(facts(mixed));
  /* Two of the three are American, so the board link and the channel are the
     US ones even though the first row is Indian — the same mistake the
     Telegram routing is careful about, from a different direction. */
  ok('the US board is linked', /interndoor\.com\/us\//.test(text));
  ok('and the US channel is named', text.includes('@interndoorusa'));
  ok('but the India row keeps its own link', text.includes('/jobs/qualcomm-'));
}

console.log('\n== the report keeps the boards apart ==');
{
  const j = (id, co, region) => ({
    job_id: id, company: co, title: `Intern ${id}`, location: 'X',
    job_url: 'https://x/' + id, apply_url: 'https://x/' + id,
    skills: [], first_seen_at: Date.now(), posted_at: Date.now(), __reportRegion: region,
  });
  const html = buildReport({
    jobs: [j('1', 'Qualcomm', 'IN'), j('2', 'Infineon', 'IN'), j('3', 'SpaceX', 'US')],
    regions: ['IN', 'US'],
    run: { runId: 't', startedAt: Date.now(), finishedAt: Date.now() },
    stats: { total: 9 },
  });
  const tab = (code) => (html.match(new RegExp(`data-region="${code}"[^>]*data-jobs="([0-9]+)"`)) ?? [])[1];
  check('India tab counts India only', tab('IN'), '2');
  check('US tab counts US only', tab('US'), '1');
  check('every card is tagged', (html.match(/class="job" data-id="[^"]*" data-region=/g) ?? []).length, 3);
  check('one chip row per board', (html.match(/class="chips" data-region=/g) ?? []).length, 2);
  ok('the inactive board is hidden', /data-region="US" hidden/.test(html));
  /* Opens on a board that HAS something, so a quiet India morning does not
     present as an empty report while US roles sit one tab away. */
  const only = buildReport({
    jobs: [j('4', 'SpaceX', 'US')], regions: ['IN', 'US'],
    run: { runId: 't', startedAt: Date.now(), finishedAt: Date.now() }, stats: {},
  });
  ok('opens on the board with roles', /data-region="US" aria-pressed="true"/.test(only));
  ok('and the combined button is offered', html.includes('id="qcomb"'));
  /* A PRESENCE CHECK, and deliberately labelled as one. The switching itself
     lives in the page's single inline script, which this suite PARSES
     (test/report.test.mjs) but never executes — the behaviour was verified in
     a real browser, where toggling repoints the cards, the chip row and the
     three counters. This only stops the line being deleted unnoticed, which a
     mutation run showed nothing else would catch. */
  ok('the script filters cards by region', html.includes('j.dataset.region === region'));
  ok('and repoints the counters', html.includes("setStat('stat-co'"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
