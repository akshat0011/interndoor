import { stripHtml, parseAtsLink } from '../src/ats.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== ordinary HTML ==');
check('tags removed', stripHtml('<p>Hello <strong>world</strong></p>'), 'Hello world');
check('block tags become newlines', stripHtml('<li>One</li><li>Two</li>'), 'One\nTwo');
check('br becomes a newline', stripHtml('One<br>Two'), 'One\nTwo');
check('attributes do not survive', stripHtml('<div class="x" data-y="z">Text</div>'), 'Text');
check('entities decoded', stripHtml('<p>R&amp;D at 9&nbsp;AM</p>'), 'R&D at 9 AM');
check('smart quotes', stripHtml('<p>&ldquo;early&rdquo; &rsquo;s</p>'), '"early" \'s');

console.log('\n== an entity-escaped document ==');
// Greenhouse answers with the whole document escaped — there is not one literal
// `<` in it. Stripping tags first found nothing, and the entity decode that ran
// afterwards turned the markup into visible text. Roblox's card on the US board
// read "<p><br><strong>You Will:</strong></p> There, you'll gain access to...".
const escaped = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;&lt;strong&gt;You Will:&lt;/strong&gt;&lt;/p&gt;Build things.&lt;/div&gt;';
check('markup does not survive as text', stripHtml(escaped), 'You Will:\nBuild things.');
check('no angle brackets left at all', /[<>]/.test(stripHtml(escaped)), false);
check('escaped br', stripHtml('One&lt;br&gt;Two'), 'One\nTwo');

console.log('\n== a document with real tags keeps escaped ones as text ==');
// A frontend posting genuinely writing about <div> elements. The escape-first
// path must not fire here: this document has real tags, so the escaped ones are
// content the reader is meant to see.
check('escaped tag inside real markup is content',
  stripHtml('<p>You will style &lt;div&gt; elements.</p>'),
  'You will style <div> elements.');
check('mixed document is not double-stripped',
  stripHtml('<ul><li>Know &lt;section&gt; and &lt;main&gt;</li></ul>'),
  'Know <section> and <main>');

console.log('\n== double-escaped ampersands ==');
// &amp; is decoded last, or "&amp;lt;" collapses to "<" in a single pass
// instead of stopping at "&lt;".
check('amp decoded after the rest', stripHtml('<p>Tom &amp;amp; Jerry</p>'), 'Tom &amp; Jerry');

console.log('\n== whitespace ==');
check('runs of spaces collapse', stripHtml('<p>a     b</p>'), 'a b');
check('three or more newlines collapse to two', stripHtml('a<br><br><br><br>b'), 'a\n\nb');
check('trimmed', stripHtml('  <p>  x  </p>  '), 'x');

console.log('\n== degenerate input ==');
check('empty', stripHtml(''), '');
check('null', stripHtml(null), 'null');
check('no markup at all', stripHtml('Just words.'), 'Just words.');

console.log('\n== Workday links, the ones that cannot be guessed ==');
// A Workday token is `tenant:wdN:site` and NO part of the site name is
// derivable from the company — "CareerDepot", "CSC_Careers", "External". If
// this parser misses the link the board is simply unreachable, which is why
// nine companies with Workday on their careers page had no board at all.
const wd = (u) => { const r = parseAtsLink(u); return r ? `${r.provider}:${r.token}` : null; };
check('plain', wd('https://homedepot.wd5.myworkdayjobs.com/CareerDepot/login'), 'workday:homedepot:wd5:CareerDepot');
check('deep job path', wd('https://nordstrom.wd501.myworkdayjobs.com/nordstrom_careers/job/Dubuque-IA/x_R-1'), 'workday:nordstrom:wd501:nordstrom_careers');
check('three-digit datacentre', wd('https://a.wd501.myworkdayjobs.com/Careers'), 'workday:a:wd501:Careers');
check('underscored site', wd('https://columbiasportswearcompany.wd5.myworkdayjobs.com/CSC_Careers'), 'workday:columbiasportswearcompany:wd5:CSC_Careers');
// Both domains are real and in use. Missing the second loses the whole tenant.
check('myworkdaysite.com', wd('https://acme.wd3.myworkdaysite.com/en-US/Careers'), 'workday:acme:wd3:Careers');
check('en-US locale skipped', wd('https://acme.wd1.myworkdayjobs.com/en-US/Global'), 'workday:acme:wd1:Global');
check('en_US locale skipped', wd('https://acme.wd1.myworkdayjobs.com/en_US/Global'), 'workday:acme:wd1:Global');
check('no locale', wd('https://travelers.wd5.myworkdayjobs.com/External'), 'workday:travelers:wd5:External');

console.log('\n== the other providers still parse ==');
check('greenhouse', wd('https://boards.greenhouse.io/cloudflare'), 'greenhouse:cloudflare');
// The embed form hides the real token in a query parameter; matching the path
// first would capture the literal word "embed" as the board name.
check('greenhouse embed', wd('https://boards.greenhouse.io/embed/job_board?for=cloudsek'), 'greenhouse:cloudsek');
check('lever', wd('https://jobs.lever.co/gopuff'), 'lever:gopuff');
check('ashby', wd('https://jobs.ashbyhq.com/drata'), 'ashby:drata');
check('smartrecruiters', wd('https://jobs.smartrecruiters.com/WesternDigital'), 'smartrecruiters:WesternDigital');
check('nothing to find', wd('https://example.com/careers'), null);
check('empty', wd(''), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
