import {
  boldSans, plainText, batchYears, sourceLabel, applyProvider, providerTip,
  jobFacts, groundPost, buildPost, tidyTech, utmUrl, telegramFor,
  postedLabel, applicantCount, composeComment, MAX_POST_CHARS, MAX_COMMENT_CHARS,
} from '../src/postgen.js';
import { buildPostsPage } from '../src/postpage.js';
import { buildReport } from '../src/report.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

const CFG = {
  regions: { publish: ['IN', 'US', 'GB'] },
  notifications: { telegram: { chatId: '@interndoor', channels: { IN: '@interndoor' } } },
  postQueue: { utm: { enabled: true, source: 'linkedin', medium: 'social' } },
};
const Y = new Date().getFullYear();

const row = (over = {}) => ({
  job_id: '4449259269',
  title: 'Software Engineering Intern',
  company: 'NoBroker.com',
  location: 'Bengaluru, Karnataka, India',
  workplace_type: 'On-site',
  description: 'Work with our backend team on Python services. Open to students graduating in ' + (Y + 1) + '.',
  apply_url: 'https://www.linkedin.com/jobs/view/4449259269',
  job_url: 'https://www.linkedin.com/jobs/view/4449259269',
  bullets: JSON.stringify(['Build REST endpoints on the payments service', 'Write tests against a live staging cluster']),
  key_skills: JSON.stringify(['python', 'postgres']),
  is_tech: 1,
  ...over,
});

console.log('\n== bold lettering ==');
ok('letters and digits are mapped', boldSans('Ab9') === '\u{1D5D4}\u{1D5EF}\u{1D7F5}');
ok('punctuation and currency pass through', boldSans('₹ 45, & Co.').includes('₹') && boldSans('₹ 45, & Co.').includes('&'));
ok('round trips back to ASCII', plainText(boldSans('Software Engineer 2027')) === 'Software Engineer 2027');
// Every bold glyph is a surrogate pair. A mapper that walked UTF-16 units would
// split them and produce replacement characters here.
ok('no replacement characters', !boldSans('Hiring Now').includes('�'));
ok('plainText leaves ordinary text alone', plainText('Already plain 123') === 'Already plain 123');

console.log('\n== batch years are read from the posting, never guessed ==');
ok('finds a stated graduation year', batchYears(`open to ${Y + 1} graduates`).join() === String(Y + 1));
ok('finds several', batchYears(`${Y} and ${Y + 1} batches`).join() === `${Y},${Y + 1}`);
// A posting is full of other four-digit numbers: a copyright line, a founding
// year, and the "2,026" that reaches the stipend slot in real data.
ok('ignores a year in the past', batchYears('founded in 2011, © 2019').length === 0);
ok('ignores a year far in the future', batchYears(`valid until ${Y + 9}`).length === 0);
ok('nothing stated means nothing claimed', batchYears('Great team, apply now').length === 0);

console.log('\n== where the listing came from ==');
ok('a numeric id is LinkedIn', sourceLabel(row()) === 'LinkedIn');
ok('an ats id names the board', sourceLabel(row({ job_id: 'ats:greenhouse:stripe:7', company: 'Stripe' })) === 'Stripe careers page (Greenhouse)');
// The apply URL says nothing about where we FOUND it: LinkedIn postings
// routinely carry a Workday apply link.
ok('a Workday apply link on a LinkedIn row still reads LinkedIn',
  sourceLabel(row({ apply_url: 'https://x.myworkdayjobs.com/y' })) === 'LinkedIn');

console.log('\n== the applying tip matches the form he will actually meet ==');
ok('workday is recognised', applyProvider('https://acme.wd1.myworkdayjobs.com/x') === 'Workday');
ok('greenhouse is recognised', applyProvider('https://job-boards.greenhouse.io/acme/jobs/1') === 'Greenhouse');
ok('an unknown host is null', applyProvider('https://careers.acme.com/x') === null);
ok('workday tip mentions the account', /account/i.test(providerTip(row({ apply_url: 'https://a.myworkdayjobs.com/b' }))));
ok('easy apply gets the easy-apply tip', /two minutes/i.test(providerTip(row({ easy_apply: 1 }))));
ok('a plain linkedin row is warned about the hand-off', /own site/i.test(providerTip(row({ easy_apply: 0 }))));
ok('an unknown host still gets a real tip', providerTip(row({ apply_url: 'https://careers.acme.com/x' })).length > 40);

console.log('\n== technology names in the bullets are written properly ==');
// The enricher's sentenceCase raises only the first letter of a line, which is
// right for a card and reads careless in a post seen by strangers.
ok('languages and tools are raised', tidyTech('Use python and terraform daily') === 'Use Python and Terraform daily');
ok('acronyms are upper-cased', tidyTech('write sql, build ci/cd, ship a rest api') === 'write SQL, build CI/CD, ship a REST API');
ok('dotted names keep their shape', tidyTech('ship node.js behind nginx') === 'ship Node.js behind nginx');
ok('the longest name wins', tidyTech('node.js') === 'Node.js');
// go/rust/swift/spring are ordinary English words far more often than they are
// languages, and are deliberately absent.
ok('ambiguous words are left alone', tidyTech('a swift turnaround, ready to go this spring') === 'a swift turnaround, ready to go this spring');
ok('already-correct text is untouched', tidyTech('Python and AWS') === 'Python and AWS');
ok('a substring is not a match', tidyTech('pythonic apic') === 'pythonic apic');

console.log('\n== facts come from the row ==');
const f = jobFacts(row(), CFG);
ok('company and role are the row\'s', f.company === 'NoBroker.com' && f.title === 'Software Engineering Intern');
ok('batch is read from the description', f.batch === String(Y + 1));
ok('bullets are parsed from the stored JSON', f.bullets.length === 2);
ok('an India row links to the site root', f.siteUrl === 'https://interndoor.com/jobs/nobroker-com-software-engineering-intern-4449259269');
ok('and is flagged as linking to the site', f.linksToSite === true);

const us = jobFacts(row({ location: 'Austin, TX', job_id: 'ats:greenhouse:acme:3' }), CFG);
ok('a US row links under /us/', us.siteUrl.startsWith('https://interndoor.com/us/jobs/'));

// A posting the site does not publish has no page written for it, and an
// "Apply here" that 404s is worse than one pointing at the original.
const unpublished = jobFacts(row({ location: 'Warsaw, Poland' }), CFG);
ok('an unpublished region does not link to a page that does not exist', unpublished.siteUrl === null);
ok('it falls back to the posting itself', unpublished.link === 'https://www.linkedin.com/jobs/view/4449259269');
ok('and says so', unpublished.linksToSite === false);

const nonTech = jobFacts(row({ is_tech: 0 }), CFG);
ok('a non-engineering row has no site page either', nonTech.siteUrl === null);

console.log('\n== stipend is formatted, never written by the model ==');
const paid = jobFacts(row({ stipend_min: 50000, stipend_max: 50000, stipend_currency: 'INR', stipend_period: 'month' }), CFG);
ok('formatted from the columns', paid.stipend === '₹50,000 / month');
ok('absent when nothing was captured', jobFacts(row(), CFG).stipend === null);

console.log('\n== the applicant count is only stated while the queue is short ==');
/* THE PROBLEM. This number exists to prove the reader is EARLY. On a crowded
   role it proves the opposite, and it was being printed directly above the
   apply link on every post — "Applicants: 100 when this was listed" is an
   argument against clicking. The board already withholds it above 25; the post
   did not, so the site was arguing with itself about the same field. */
const AI = { hook: 'A backend role on payments.', tip: 'Lead with Python.', hashtags: [] };
const shownAt = (n) => plainText(buildPost(row({ applicants: `${n} applicants` }), CFG, AI).text)
  .includes(`Applicants: ${n} when this was listed`);

ok('a short queue is stated — it is the reason to hurry', shownAt(3));
ok('and zero is stated, not treated as missing', shownAt(0));
ok('a crowded queue is left out entirely', !shownAt(100));
ok('and so is one just over the line', !shownAt(40));
// Strictly under, so LinkedIn's own "Be among the first 25 applicants" prompt
// could never be read as a real count of 25.
ok('25 itself is not stated', !shownAt(25));
ok('24 is', shownAt(24));

/* Withholding it must not take the freshness signal with it: "Posted" is what
   still tells a reader the role is new when the count is gone. */
const crowded = plainText(buildPost(
  row({ applicants: '100 applicants', posted_at: Date.now() - 3600_000 }), CFG, AI).text);
ok('the posted line survives a withheld count', /Posted:/.test(crowded));
ok('and no applicant line is left behind', !/Applicants:/.test(crowded));

console.log('\n== the model is not trusted with facts ==');
const facts = jobFacts(row(), CFG);

const money = groundPost({ hook: 'A backend role paying ₹45 LPA for the right student.', tip: '', hashtags: [] }, facts);
ok('a stipend the row does not have is dropped', !money.hook.includes('45'));
ok('and the fallback hook takes its place', money.hook.length > 40);
ok('the drop is reported, not silent', money.dropped.some((d) => d.includes('money')));

const wrongYear = groundPost({ hook: `Open to ${Y + 4} graduates who like distributed systems.`, tip: '', hashtags: [] }, facts);
ok('a graduation year the posting never named is dropped', !wrongYear.hook.includes(String(Y + 4)));
const rightYear = groundPost({ hook: `Open to ${Y + 1} graduates who like distributed systems.`, tip: '', hashtags: [] }, facts);
ok('the year the posting DID name survives', rightYear.hook.includes(String(Y + 1)));

const hype = groundPost({ hook: 'An exciting opportunity in a fast-paced environment!', tip: '', hashtags: [] }, facts);
ok('marketing language is refused', !/exciting opportunity/i.test(hype.hook));

const decorated = groundPost({ hook: '🚀 **Backend** work on payments #hiring', tip: 'Attach a PDF 📎', hashtags: ['#Python', 'no spaces here', 'ok'] }, facts);
ok('emoji are stripped from the hook', !/🚀/.test(decorated.hook));
ok('markdown is stripped', !decorated.hook.includes('**'));
ok('hash marks are stripped from prose', !decorated.hook.includes('#'));
ok('a hash in a tag is stripped, not kept', decorated.hashtags.includes('Python'));
ok('a short list is topped up rather than thrown away', decorated.hashtags.length >= 3);
ok('a tag with spaces is collapsed, not dropped mid-post', decorated.hashtags.every((t) => !t.includes(' ')));

const empty = groundPost({}, facts);
ok('no model answer still yields a hook', empty.hook.length > 40);
ok('no model answer still yields a tip', empty.tip === facts.tipFallback);
ok('no model answer still yields hashtags', empty.hashtags.length >= 3);

console.log('\n== the assembled post ==');
const { text } = buildPost(row(), CFG, { hook: 'You would be on the payments backend writing Python services that real users hit.', tip: 'Put Python and Postgres in the top three lines of the resume.', hashtags: ['NoBroker', 'internship', 'python', 'hiring'] });

ok('names the company', text.includes('NoBroker.com'));
ok('names the role', text.includes('Software Engineering Intern'));
ok('carries the location', text.includes('Bengaluru, Karnataka, India'));
ok('carries the batch', text.includes(String(Y + 1)));
ok('links to the job page on the site', text.includes('https://interndoor.com/jobs/nobroker-com-software-engineering-intern-4449259269'));
ok('links to the board', text.includes('https://interndoor.com/'));
ok('names the source', text.includes('LinkedIn'));
ok('carries the disclaimer', /Disclaimer/i.test(plainText(text)));
ok('carries the hashtags', text.includes('#NoBroker'));
ok('uses bold lettering', text !== plainText(text));
ok('no stipend line when none was captured', !plainText(text).includes('Stipend:'));
ok('under the LinkedIn limit', text.length <= MAX_POST_CHARS, `${text.length} chars`);

// LinkedIn cuts at ~210 characters, so the company and the role have to be in
// front of the fold or the post is invisible in a feed.
// Sliced by code point, not UTF-16 unit: every bold glyph is a surrogate pair
// and a naive slice(0,210) would cut one in half.
const fold = plainText([...text].slice(0, 210).join(''));
ok('company and role are above the fold', fold.includes('NoBroker') && fold.includes('Software Engineering Intern'));

const withStipend = buildPost(
  row({ stipend_min: 50000, stipend_max: 50000, stipend_currency: 'INR', stipend_period: 'month' }),
  CFG,
).text;
ok('a captured stipend IS printed', withStipend.includes('₹50,000 / month'));

console.log('\n== a long posting still fits ==');
const huge = buildPost(row({
  title: 'Intern Software development engineering (AI/ML/NLP & Cybersecurity), Graduation Year (' + (Y + 1) + ')',
  bullets: JSON.stringify(Array.from({ length: 3 }, () => 'A deliberately long bullet about the work '.repeat(3))),
  description: 'x'.repeat(20000),
}), CFG, {
  hook: 'A very long hook. '.repeat(20),
  tip: 'A very long tip. '.repeat(20),
  hashtags: Array.from({ length: 8 }, (_, i) => `tag${i}`),
}).text;
ok('still under the limit', huge.length <= MAX_POST_CHARS, `${huge.length} chars`);
ok('and still carries the apply link', huge.includes('interndoor.com'));

console.log('\n== utm tags ==');
ok('our own link is tagged', utmUrl('https://interndoor.com/jobs/x', { campaign: 'post', content: 'acme' }, CFG)
  === 'https://interndoor.com/jobs/x?utm_source=linkedin&utm_medium=social&utm_campaign=post&utm_content=acme');
// Somebody else's URL is not ours to tag, and some ATS routers read the query.
ok('a workday apply url is untouched', utmUrl('https://a.myworkdayjobs.com/b?x=1', { campaign: 'post' }, CFG) === 'https://a.myworkdayjobs.com/b?x=1');
ok('a linkedin apply url is untouched', utmUrl('https://www.linkedin.com/jobs/view/1', { campaign: 'post' }, CFG) === 'https://www.linkedin.com/jobs/view/1');
ok('can be switched off', utmUrl('https://interndoor.com/x', { campaign: 'post' }, { postQueue: { utm: { enabled: false } } }) === 'https://interndoor.com/x');
ok('garbage in, garbage out, not a throw', utmUrl('not a url', { campaign: 'post' }, CFG) === 'not a url');

console.log('\n== the telegram channel ==');
ok('read from the same config the channel poster uses', telegramFor(CFG, 'IN').handle === '@interndoor');
ok('and turned into a link', telegramFor(CFG, 'IN').url === 'https://t.me/interndoor');
// A private channel is addressed by a numeric id, and t.me has no address for one.
ok('a numeric chat id yields no link', telegramFor({ notifications: { telegram: { chatId: '-1004300938042' } } }, 'IN') === null);
ok('a region with no channel gets none', telegramFor(CFG, 'US') === null);

console.log('\n== freshness, stated so it cannot rot ==');
// Never "2 hours ago": a draft is written when Generate is pressed and pasted
// whenever he gets to it. posted_text taught the site this the expensive way.
const stamp = postedLabel(Date.parse('2026-08-24T10:10:00Z'), 'IN');
ok('an absolute stamp in the region\'s zone', /24 Aug/.test(stamp) && /3:40/.test(stamp), stamp);
ok('nothing to stamp is null', postedLabel(null) === null);
ok('a count is read out of linkedin\'s phrasing', applicantCount('8 people clicked apply') === 8);
ok('commas survive', applicantCount('1,200 applicants') === 1200);
ok('no number means no claim', applicantCount('Be among the first applicants') === null);

console.log('\n== one link in the body, the rest in the comment ==');
const one = buildPost(row({ applicants: '4 applicants', posted_at: Date.now() - 7200_000 }), CFG,
  { hook: 'Backend work on payments.', tip: 'Bring a resume.', hashtags: ['a1', 'b2', 'c3'] });
const urls = one.text.match(/https?:\/\//g) || [];
ok('exactly one url in the post', urls.length === 1, `${urls.length}`);
ok('and it is the job page', one.text.includes('/jobs/nobroker-com-software-engineering-intern-4449259269?utm_'));
ok('the board link is NOT in the post', !one.text.includes('interndoor.com/?utm'));
// A handle is not an outbound link, so naming the channel costs the post nothing.
ok('the channel is named in the post', one.text.includes('@interndoor'));
ok('but not linked there', !one.text.includes('t.me'));
ok('the posted stamp is in the facts', /Posted:/.test(plainText(one.text)));
// A row with no timestamp claims no timestamp, rather than stamping "now".
ok('no posted time means no posted line', !/Posted:/.test(plainText(buildPost(row(), CFG).text)));
ok('no applicant count means no applicant line', !/Applicants:/.test(plainText(buildPost(row(), CFG).text)));
ok('the applicant count is scoped so it cannot go stale', one.text.includes('4 when this was listed'));

ok('the comment carries the board', one.comment.includes('interndoor.com/?utm_'));
ok('and the channel link', one.comment.includes('https://t.me/interndoor'));
ok('and fits a comment', one.comment.length <= MAX_COMMENT_CHARS);
ok('composeComment is deterministic from the facts', composeComment(one.facts) === one.comment);

console.log('\n== the page hands back exactly the post, and nothing else ==');
// The copy buttons read the block's textContent. Anything rendered inside that
// block that is not the post ends up pasted into LinkedIn — which is what the
// fold marker did until its label moved into CSS generated content.
const built = buildPost(row(), CFG, { hook: 'A long enough hook that the post certainly runs past the fold and the marker has to be drawn somewhere inside it.', tip: 'Bring a resume.', hashtags: ['a1', 'b2', 'c3'] });
const page = buildPostsPage([{ row: row(), facts: built.facts, text: built.text, meta: { fromModel: true, dropped: [] } }],
  { batchId: 'test', model: 'qwen3:14b', generatedAt: Date.now() });

const unesc = (h) => h.replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const shown = unesc(page.match(/<pre class="post">([\s\S]*?)<\/pre>/)[1]);
ok('the fold marker is drawn', page.includes('<i class="fold">'));
ok('but contributes no text', shown === built.text, `${shown.length} vs ${built.text.length}`);
ok('no replacement character at the fold', !shown.includes('\uFFFD'));

const plainShown = unesc(page.match(/<pre class="plain" hidden>([\s\S]*?)<\/pre>/)[1]);
ok('the plain copy is the same post without the bold', plainShown === plainText(built.text));
ok('and carries no astral characters', [...plainShown].every((c) => c.codePointAt(0) < 0x10000 || /\p{Extended_Pictographic}/u.test(c)));

// A draft written on Friday and pasted on Monday still carries Friday's real
// timestamp — honest, but it sits under a line saying "apply as soon as you can".
const stale = buildPost(row({ posted_at: Date.now() - 3 * 86400_000 }), CFG);
const stalePage = buildPostsPage([{ row: row(), facts: stale.facts, text: stale.text, meta: {} }],
  { batchId: 't', model: 'm', generatedAt: Date.now() });
ok('an old posting is flagged on the page', /about 3 days old/.test(stalePage));
const freshPage = buildPostsPage([{ row: row(), facts: buildPost(row({ posted_at: Date.now() - 3600_000 }), CFG).facts, text: 'x', meta: {} }],
  { batchId: 't', model: 'm', generatedAt: Date.now() });
ok('a fresh one is not', !/days old/.test(freshPage));

// A post with no page on the site says so, rather than linking somewhere that 404s.
const offSite = buildPost(row({ location: 'Warsaw, Poland' }), CFG);
const offPage = buildPostsPage([{ row: row({ location: 'Warsaw, Poland' }), facts: offSite.facts, text: offSite.text, meta: {} }],
  { batchId: 'test', model: 'm', generatedAt: Date.now() });
ok('an off-site post is flagged on the page', offPage.includes('no page on InternDoor'));

console.log('\n== the run report offers the queue ==');
const report = buildReport({
  jobs: [row(), row({ job_id: '999', company: 'Other Co' })],
  run: { runId: 'r1', startedAt: Date.now(), finishedAt: Date.now(), pagesScanned: 1, cardsSeen: 20 },
  notes: [], stats: { total: 1, companies: 1, skipped: 0 },
});
ok('every listing carries its id', report.includes('data-id="4449259269"') && report.includes('data-id="999"'));
ok('every listing has an add button', (report.match(/class="qbtn"/g) || []).length === 2);
ok('the bar is rendered', report.includes('id="qgen"'));
// The port is configurable, so the offline message must not name one.
ok('the offline message names no port', !/127\.0\.0\.1:\d+/.test(report));
ok('it says how to start the helper', report.includes('npm run queue'));
// The company is the scanning key on this page — see the note in the CSS.
ok('the employer is the largest line on a card', /\.co\{font-size:22px/.test(report));

const noJobs = buildReport({ jobs: [], run: { runId: 'r2' }, notes: [], stats: {} });
ok('an empty run renders no queue bar', !noJobs.includes('id="qgen"'));
ok('and no script', !noJobs.includes('<script>'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
