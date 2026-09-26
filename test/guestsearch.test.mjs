/**
 * Discovery through LinkedIn's PUBLIC job search, and the open that follows it.
 *
 * On 25 Sep 2026 both scraper accounts were moved to the AI-powered search,
 * which rewrote the query into a sentence, searched "Greater Delhi Area"
 * instead of India, dropped the date sort, and gave the US account an empty
 * onboarding page. Discovery moved to the signed-out endpoint the public job
 * pages call (src/guestsearch.js); opens stay on the signed-in account, by id,
 * on the posting's own page.
 *
 * The markup below is the real response's structure with the employers
 * renamed. What matters, and what is pinned:
 *   - every card yields its REAL id, title, company, place and age;
 *   - an empty answer is the END, a card-shaped answer we cannot read is LOUD;
 *   - a 429 is "blocked", never retried, never mistaken for an empty window;
 *   - nothing assumes date order, because the endpoint does not keep it;
 *   - the Apply link's /safety/go/ wrapper is unwrapped before it is stored.
 */
import { readFileSync } from 'node:fs';
import { admitEntryLevel } from '../src/employment.js';
import {
  parseGuestCards, guestCards, buildGuestSearchUrl, fetchGuestPage, guestRequestCap,
  fetchGuestPageRetrying, retryAfterMsOf, GUEST_BLOCK_WAITS_MS, splitKeywords, rereadPlan, REREAD_TAIL_PAGES, MAX_WALK_PASSES,
  parsePublicPosting, fetchPublicPosting, publicPostingUrl,
  searchSourceFor, decodeEntities, GUEST_SEARCH_URL, GUEST_PAGE_SIZE, GUEST_RESULT_CEILING,
} from '../src/guestsearch.js';
import { buildSearchUrl, cleanApplyUrl, applyUrlFrom, stripExpanderLabel } from '../src/linkedin.js';
import { parseRelativeTime } from '../src/extract.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/* One card as the endpoint serves it — layout, class names, comments and
   whitespace kept, employer renamed. */
const card = ({ id, title, company, link = true, place, age, date = '2026-09-25', salary = null, attrsSwapped = false }) => `
      <li>
      <div class="base-card relative w-full hover:no-underline focus:no-underline
        base-card--link
         base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:${id}" data-impression-id="jobs-search-result-0" data-reference-id="OoGM2yMYzUjcmiNXLzf9fg==" data-tracking-id="9zvQpW2NWGMQNExVdQldQg==" data-column="1" data-row="1">
        <a class="base-card__full-link absolute top-0 right-0 bottom-0 left-0 p-0 z-[2] outline-offset-[4px]" href="https://in.linkedin.com/jobs/view/some-slug-${id}?position=1&amp;pageNum=0&amp;refId=OoGM2yMYzUjcmiNXLzf9fg%3D%3D&amp;trackingId=9zvQpW2NWGMQNExVdQldQg%3D%3D" data-tracking-control-name="public_jobs_jserp-result_search-card">
          <span class="sr-only">
        ${title}
          </span>
        </a>
    <div class="search-entity-media">
      <img class="artdeco-entity-image artdeco-entity-image--square-4
          " data-delayed-url="https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/logo_${id}?e=2147483647&amp;v=beta&amp;t=abc" data-ghost-classes="artdeco-entity-image--ghost" data-ghost-url="https://static.licdn.com/aero-v1/sc/h/6puxblwmhnodu6fjircz4dn4h" alt>
    </div>
        <div class="base-search-card__info">
          <h3 class="base-search-card__title">
        ${title}
          </h3>
            <h4 class="base-search-card__subtitle">
          ${link ? `<a class="hidden-nested-link" href="https://in.linkedin.com/company/x?trk=public_jobs_jserp-result_job-search-card-subtitle">
            ${company}
          </a>` : `${company}<!---->`}
            </h4>
<!---->
            <div class="base-search-card__metadata">
          <span class="job-search-card__location">
            ${place}
          </span>
      <div class="job-posting-benefits text-sm">
        <span class="job-posting-benefits__text">
          Be an early applicant
<!---->        </span>
      </div>
${salary ? `          <span class="job-search-card__salary-info">
            ${salary}
          </span>` : ''}
          <time ${attrsSwapped ? `datetime="${date}" class="job-search-card__listdate--new"` : `class="job-search-card__listdate--new" datetime="${date}"`}>
      ${age}
          </time>
<!---->
            </div>
        </div>
      </div>
      </li>`;

const PAGE = `<!DOCTYPE html>
${card({ id: '4470111950', title: 'Internship - Social Media &amp; Creative | Public Relations', company: 'Acme &amp; Co.', place: 'Delhi, India', age: '1 hour ago' })}
${card({ id: '4470132098', title: 'Software Engineer Intern', company: 'Beta Robotics', link: false, place: 'Bengaluru, Karnataka, India', age: '32 minutes ago', attrsSwapped: true })}
${card({ id: '4470125624', title: 'Data Engineering Intern', company: 'Gamma Analytics', place: 'Hyderabad, Telangana, India', age: '2 hours ago', salary: '₹25,000/month - ₹30,000/month' })}
${card({ id: '4470111950', title: 'Internship - Social Media &amp; Creative | Public Relations', company: 'Acme &amp; Co.', place: 'Delhi, India', age: '1 hour ago' })}`;

console.log('\n== every card yields its real id and its facts ==');
{
  const { rows, listed } = parseGuestCards(PAGE);
  check('four cards listed (the repeat included)', listed, 4);
  check('ids', rows.map((r) => r.jobId), ['4470111950', '4470132098', '4470125624', '4470111950']);
  check('entities decoded in the title', rows[0].title, 'Internship - Social Media & Creative | Public Relations');
  check('company behind a link', rows[0].company, 'Acme & Co.');
  // An employer with no LinkedIn page is bare text beside a comment.
  check('company with no link', rows[1].company, 'Beta Robotics');
  check('the full place', rows[1].location, 'Bengaluru, Karnataka, India');
  check('the age, read whatever order the <time> attributes are in', rows[1].postedText, '32 minutes ago');
  check('and its date', rows[1].postedDate, '2026-09-25');
  check('the age parses', typeof parseRelativeTime(rows[0].postedText), 'number');
  check('a stated salary', rows[2].salaryText, '₹25,000/month - ₹30,000/month');
  check('no salary is null, not empty', rows[0].salaryText, null);
  check('the logo, entities decoded', rows[0].logoUrl, 'https://media.licdn.com/dms/image/v2/X/company-logo_100_100/0/1/logo_4470111950?e=2147483647&v=beta&t=abc');
  // refId / trackingId change on every request; a stored href must not.
  check('the link without its tracking query', rows[0].href, 'https://in.linkedin.com/jobs/view/some-slug-4470111950');
}

console.log('\n== into the card shape the gates read ==');
{
  const cards = guestCards(parseGuestCards(PAGE).rows);
  check('the repeat is dropped', cards.map((c) => c.jobId), ['4470111950', '4470132098', '4470125624']);
  check('the key IS the id — no synthetic key', cards.map((c) => c.key), cards.map((c) => c.jobId));
  check('the identity the skip records use', cards[1].identity, 'card:beta robotics|software engineer intern|bengaluru, karnataka, india');
  check('fields the gates read', Object.keys(cards[0]).filter((k) => ['title', 'company', 'location', 'postedText', 'salaryText', 'easyApply', 'viewed', 'logoUrl', 'nth'].includes(k)).length, 9);
  check('a card with no title is not a card', guestCards([{ jobId: '1', title: '' }]).length, 0);
}

console.log('\n== the URL asks the same question as the signed-in search ==');
{
  const search = { keywords: '(intern OR internship)', location: 'United States', geoId: 103644278, experienceLevels: ['entry'] };
  const filters = { postedWithinHours: 2, sortBy: 'recent', jobTypes: [] };
  const url = buildGuestSearchUrl(search, filters, { start: 30 });
  check('the public endpoint', url.startsWith(`${GUEST_SEARCH_URL}?`), true);
  // One query-string builder for both, so they cannot drift apart.
  check('identical query string to the signed-in URL',
    url.split('?')[1], buildSearchUrl(search, filters, { start: 30 }).split('?')[1]);
  const q = new URL(url).searchParams;
  check('window in seconds', q.get('f_TPR'), 'r7200');
  check('offset counts cards', q.get('start'), '30');
  check('geoId kept', q.get('geoId'), '103644278');
  check('entry-level facet kept', q.get('f_E'), '2');
  check('10 a request', GUEST_PAGE_SIZE, 10);
}

console.log('\n== a page cap written in 25-card pages, in 10-card requests ==');
check('40 pages = the whole 1,000-result ceiling', guestRequestCap(40), GUEST_RESULT_CEILING / GUEST_PAGE_SIZE);
check('10 pages = 25 requests', guestRequestCap(10), 25);
check('never past the ceiling', guestRequestCap(400), 100);
check('no cap = the ceiling', guestRequestCap(0), 100);

console.log('\n== which collector a search uses ==');
check('absent means the signed-in page (every fixture keeps its behaviour)', searchSourceFor({}, {}), 'browser');
check('config-wide', searchSourceFor({}, { searchSource: 'guest' }), 'guest');
check('a search may override it', searchSourceFor({ searchSource: 'browser' }, { searchSource: 'guest' }), 'browser');
check('an unknown value is the signed-in page, not a guess', searchSourceFor({}, { searchSource: 'publik' }), 'browser');
{
  const cfg = loadConfig();
  check('live config: every search goes through the public search',
    cfg.searches.map((s) => searchSourceFor(s, cfg)), cfg.searches.map(() => 'guest'));
  const p = cfg.pacing.betweenGuestPages;
  check('with its own pacing, a real range', Array.isArray(p) && p.length === 2 && p[0] > 0 && p[1] >= p[0], true);
}

console.log('\n== one request, and exactly which of six things happened ==');
{
  const calls = [];
  const stub = (status, body, { throwIt = false } = {}) => async (url, init) => {
    calls.push({ url, init });
    if (throwIt) throw new Error('getaddrinfo ENOTFOUND www.linkedin.com');
    return { status, text: async () => body };
  };
  const r = await fetchGuestPage('https://x/', { fetchImpl: stub(200, PAGE) });
  check('cards', r.cards?.map((c) => c.jobId), ['4470111950', '4470132098', '4470125624']);
  const h = calls[0].init.headers;
  // Never tied to a scraper account.
  check('no cookie is sent', Object.keys(h).some((k) => k.toLowerCase() === 'cookie'), false);
  check('a browser user agent', /Mozilla\/5\.0/.test(h['user-agent']), true);
  check('with a timeout', !!calls[0].init.signal, true);

  check('an empty answer is the END', await fetchGuestPage('u', { fetchImpl: stub(200, '<!DOCTYPE html>\n\n<!---->  ') }), { end: true, status: 200 });
  check('429 is blocked', (await fetchGuestPage('u', { fetchImpl: stub(429, '') })).blocked, true);
  check('999 is blocked', (await fetchGuestPage('u', { fetchImpl: stub(999, '') })).blocked, true);
  check('a 429 is never read as an empty window', (await fetchGuestPage('u', { fetchImpl: stub(429, '') })).end, undefined);
  check('500 is a failure, not the end', (await fetchGuestPage('u', { fetchImpl: stub(500, '') })).failed, true);
  check('a thrown fetch is a network error', (await fetchGuestPage('u', { fetchImpl: stub(0, '', { throwIt: true }) })).networkError, true);
  // Cards in the answer and none readable: a markup change, which must be loud.
  check('card markup with no ids is a markup change',
    (await fetchGuestPage('u', { fetchImpl: stub(200, '<li><div class="base-card job-search-card"></div></li>') })).markupChanged, true);
  check('ids with no readable titles is a markup change',
    (await fetchGuestPage('u', { fetchImpl: stub(200, '<div data-entity-urn="urn:li:jobPosting:123"></div>') })).markupChanged, true);
}

console.log('\n== a 429 is waited out, minutes at a time, and the same page asked for again ==');
{
  const PAGE_OK = PAGE;
  // Answers in turn: each entry is [status, body, headers].
  const seq = (answers) => {
    const asked = [];
    const impl = async (url) => {
      asked.push(url);
      const [status, body, headers = {}] = answers[Math.min(asked.length - 1, answers.length - 1)];
      return { status, text: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } };
    };
    return { impl, asked };
  };
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  check('the waits are 2, 5 and 10 minutes', GUEST_BLOCK_WAITS_MS, [120_000, 300_000, 600_000]);

  let s = seq([[429, ''], [200, PAGE_OK]]);
  let r = await fetchGuestPageRetrying('https://x/p?start=70', { fetchImpl: s.impl, sleep });
  check('a 429 then an answer: the cards', r.cards?.length, 3);
  check('after one wait of 2 minutes', [r.retries, r.waitedMs, slept.splice(0)], [1, 120_000, [120_000]]);
  check('asking for the SAME page again', s.asked, ['https://x/p?start=70', 'https://x/p?start=70']);

  s = seq([[429, '']]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('a 429 that outlasts every wait is still a block', [r.blocked, r.status, r.retries], [true, 429, 3]);
  check('after 2, 5 and 10 minutes, and four asks in all', [slept.splice(0), s.asked.length], [[120_000, 300_000, 600_000], 4]);

  s = seq([[999, '']]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('a 999 is never asked again', [r.blocked, r.retries, s.asked.length, slept.splice(0)], [true, 0, 1, []]);

  s = seq([[429, '']]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep, budgetMs: 100_000 });
  check('a wait the run cannot afford is not started', [r.blocked, r.retries, slept.splice(0)], [true, 0, []]);
  s = seq([[429, '']]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep, budgetMs: 350_000 });
  // 2 min fits; 2 + 5 does not, though 5 alone would.
  check('and the budget counts every wait so far', [r.retries, slept.splice(0)], [1, [120_000]]);

  s = seq([[429, '', { 'retry-after': '400' }], [200, PAGE_OK]]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('a longer Retry-After is honoured', slept.splice(0), [400_000]);
  s = seq([[429, '', { 'retry-after': '7200' }], [200, PAGE_OK]]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('up to 15 minutes', slept.splice(0), [900_000]);
  s = seq([[429, '', { 'retry-after': '5' }], [200, PAGE_OK]]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('a shorter one never shortens the planned wait', slept.splice(0), [120_000]);

  const told = [];
  s = seq([[429, ''], [429, ''], [200, PAGE_OK]]);
  await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep, onWait: (w) => told.push(w) });
  slept.splice(0);
  check('each wait is announced before it starts', told, [{ attempt: 1, of: 3, waitMs: 120_000 }, { attempt: 2, of: 3, waitMs: 300_000 }]);

  s = seq([[200, PAGE_OK]]);
  r = await fetchGuestPageRetrying('u', { fetchImpl: s.impl, sleep });
  check('an ordinary answer costs no wait', [r.retries, r.waitedMs, slept.length], [0, 0, 0]);

  check('Retry-After in seconds', retryAfterMsOf('120'), 120_000);
  check('Retry-After as a date', retryAfterMsOf('Sat, 26 Sep 2026 00:05:00 GMT', Date.parse('2026-09-26T00:00:00Z')), 300_000);
  check('no Retry-After', [retryAfterMsOf(''), retryAfterMsOf(null), retryAfterMsOf('soon')], [null, null, null]);
  check('fetchGuestPage passes it on', (await fetchGuestPage('u', { fetchImpl: seq([[429, '', { 'retry-after': '60' }]]).impl })).retryAfterMs, 60_000);
}

console.log('\n== a search split into two that ask the same question ==');
{
  const terms = (k) => k.replace(/^\(|\)$/g, '').split(' OR ');
  const cfg = loadConfig();
  for (const search of cfg.searches) {
    const parts = splitKeywords(search.keywords);
    check(`live config: "${search.label ?? search.region}" splits in two`, parts?.length, 2);
    check('  and the halves hold exactly its terms, once each',
      parts ? [...parts.flatMap(terms)].sort() : null, [...terms(search.keywords)].sort());
  }
  check('odd counts put the extra term first', splitKeywords('(a OR b OR c)'), ['(a OR b)', '(c)']);
  check('two terms, one each', splitKeywords('(intern OR internship)'), ['(intern)', '(internship)']);
  check('brackets are optional', splitKeywords('a OR b'), ['(a)', '(b)']);
  check('a quoted phrase is one term, OR and all', splitKeywords('("a OR b" OR c)'), ['("a OR b")', '(c)']);
  check('ANDROID is a word, not an AND', splitKeywords('(ANDROID OR ios)'), ['(ANDROID)', '(ios)']);
  check('one term cannot split', splitKeywords('(intern)'), null);
  check('nested brackets are left alone', splitKeywords('(a OR (b OR c) OR d)'), null);
  check('an AND is left alone', splitKeywords('(a OR b AND c)'), null);
  check('a NOT is left alone', splitKeywords('(a OR NOT b)'), null);
  check('an open quote is left alone', splitKeywords('(x OR "a OR b)'), null);
  check('nothing is nothing', [splitKeywords(''), splitKeywords(null)], [null, null]);
  check('an empty term is refused', splitKeywords('(a OR  OR b)'), null);
}

console.log('\n== a capped window is re-read only when its last pages still held roles ==');
{
  const kw = '(intern OR internship OR trainee OR "co-op" OR apprentice)';
  const zeros = (n) => Array(n).fill(0);
  check('the last ten pages decide', REREAD_TAIL_PAGES, 10);
  check('nothing worth opening in them: filler, not re-read',
    rereadPlan({ tailHits: zeros(100), keywords: kw }).reason, 'the last 10 pages held nothing worth opening, so the rest is filler');
  check('a hit before the last ten does not count',
    rereadPlan({ tailHits: [...zeros(89), 3, ...zeros(10)], keywords: kw }).parts, undefined);
  check('one hit in the last ten re-reads, as the two halves',
    rereadPlan({ tailHits: [...zeros(90), 1, ...zeros(9)], keywords: kw }), { parts: ['(intern OR internship OR trainee)', '("co-op" OR apprentice)'], hits: 1 });
  check('and says how many it saw', rereadPlan({ tailHits: [...zeros(95), 2, 0, 3, 0, 0], keywords: kw }).hits, 5);
  check('keywords that cannot split are not re-read',
    /not a plain OR-list/.test(rereadPlan({ tailHits: [1], keywords: '(intern)' }).reason), true);
  check('six passes at most', MAX_WALK_PASSES, 6);
  check('a split that would make seven is refused', rereadPlan({ tailHits: [1], keywords: kw, passes: 5 }).parts, undefined);
  check('one that makes exactly six is allowed', rereadPlan({ tailHits: [1], keywords: kw, passes: 4 }).parts?.length, 2);
}

console.log('\n== the posting\'s public page, read before the account opens anything ==');
{
  /* The shape of jobs-guest/jobs/api/jobPosting/<id> as served on 26 Sep 2026
     (Snowflake's Core Infrastructure intern), cut down to the parts read. */
  const page = ({ employment = 'Full-time', seniority = 'Internship', apply = 'offsite', desc = true, closed = false } = {}) => `
    <section class="top-card-layout"><h2 class="top-card-layout__title font-sans topcard__title">Software Engineer Intern (Core &amp; Security) — Spring 2027</h2>
    <a class="topcard__org-name-link topcard__flavor--black-link" href="https://www.linkedin.com/company/snowflake">
      Snowflake
    </a><span class="topcard__flavor topcard__flavor--bullet">Menlo Park, CA</span>
    <span class="posted-time-ago__text topcard__flavor--metadata">13 hours ago</span>
    <figcaption class="num-applicants__caption">40 applicants</figcaption>
    ${apply === 'offsite' ? '<button class="sign-up-modal__outlet top-card-layout__cta" data-tracking-control-name="public_jobs_apply-link-offsite_contextual-sign-in-modal_join-link">Apply</button>'
      : apply === 'onsite' ? '<button class="sign-up-modal__outlet top-card-layout__cta" data-tracking-control-name="public_jobs_apply-link-onsite">Apply</button>' : ''}
    ${closed ? '<figure class="closed-job"><figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption></figure>' : ''}
    <img class="artdeco-entity-image" data-delayed-url="https://media.licdn.com/dms/image/v2/X/company-logo_100_100/y.png">
    </section>
    ${desc ? `<div class="show-more-less-html__markup relative overflow-hidden">
      <p>At Snowflake, we build &amp; ship.</p><p>Interns own real systems.</p><ul><li>Python or Java</li><li>Minimum 3 years of experience</li></ul><br>Pay: 42.00-60.00 per hour.
    </div>` : ''}
    <ul class="description__job-criteria-list">
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Seniority level</h3>
        <span class="description__job-criteria-text description__job-criteria-text--criteria">${seniority}</span></li>
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Employment type</h3>
        <span class="description__job-criteria-text description__job-criteria-text--criteria">${employment}</span></li>
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Job function</h3>
        <span class="description__job-criteria-text description__job-criteria-text--criteria">Engineering</span></li>
    </ul>`;
  const d = parsePublicPosting(page(), '4471846966');
  check('title, company and place', [d.title, d.company, d.location], ['Software Engineer Intern (Core & Security) — Spring 2027', 'Snowflake', 'Menlo Park, CA']);
  check('the description keeps its lines', d.description, 'At Snowflake, we build & ship.\nInterns own real systems.\nPython or Java\nMinimum 3 years of experience\nPay: 42.00-60.00 per hour.');
  check('posted, applicants, logo', [d.postedText, d.applicants, /company-logo/.test(d.logoUrl)], ['13 hours ago', '40 applicants', true]);
  check('an employer link exists (offsite apply)', d.applyKind, 'offsite');
  check('LinkedIn\'s own form is not an employer link', parsePublicPosting(page({ apply: 'onsite' }), '1').applyKind, 'onsite');
  check('no marker at all is unknown, not "no link"', parsePublicPosting(page({ apply: 'none' }), '1').applyKind, null);
  check('an open posting is not closed', d.closed, false);
  check('a closed posting says so', parsePublicPosting(page({ apply: 'none', closed: true }), '1').closed, true);
  check('it never claims an apply URL', d.applyUrl, null);
  check('and says where it came from', d.viaPublicPage, true);
  // Employment type "Full-time" with seniority "Internship" is an internship.
  check('an internship by seniority is an internship', d.employmentTag, 'Internship');
  check('and by employment type', parsePublicPosting(page({ employment: 'Internship', seniority: 'Not Applicable' }), '1').employmentTag, 'Internship');
  const ft = parsePublicPosting(page({ employment: 'Full-time', seniority: 'Entry level' }), '1');
  check('a full-time entry-level role reads as the account page\'s chips do', [ft.employmentTag, ft.seniorityTag], ['Full-time', 'Entry level']);
  check('"Not Applicable" is no seniority at all', parsePublicPosting(page({ employment: 'Full-time', seniority: 'Not Applicable' }), '1').seniorityTag, null);
  check('no description block is not a posting', parsePublicPosting(page({ desc: false }), '1'), null);
  // The refusal the India account opened 314 postings a day to reach.
  const v = admitEntryLevel({ title: 'Software Engineer', employmentTag: ft.employmentTag, seniorityTag: ft.seniorityTag, description: ft.description, isIntern: () => false });
  check('"3 years" on the public page refuses before any open', v.reason, 'entry-level: asks 3+ years');
  check('the public URL is the posting endpoint', publicPostingUrl('123'), 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/123');

  const seq = (answers) => { let i = 0; return async () => { const [status, body] = answers[Math.min(i++, answers.length - 1)]; return { status, text: async () => body, headers: { get: () => null } }; }; };
  const sleep = async () => {};
  check('a readable page is a detail', (await fetchPublicPosting('1', { fetchImpl: seq([[200, page()]]), sleep })).detail?.company, 'Snowflake');
  check('a 404 is a posting taken down', (await fetchPublicPosting('1', { fetchImpl: seq([[404, '']]), sleep })).gone, true);
  check('so is a 410', (await fetchPublicPosting('1', { fetchImpl: seq([[410, '']]), sleep })).gone, true);
  const waited = await fetchPublicPosting('1', { fetchImpl: seq([[429, ''], [200, page()]]), sleep });
  check('a 429 is waited out like the search\'s', [waited.retries, waited.detail?.company], [1, 'Snowflake']);
  check('a 999 is a block, never retried', (await fetchPublicPosting('1', { fetchImpl: seq([[999, '']]), sleep })).blocked, true);
  check('a 500 is a failure, not a refusal', [(await fetchPublicPosting('1', { fetchImpl: seq([[500, '']]), sleep })).failed, (await fetchPublicPosting('1', { fetchImpl: seq([[500, '']]), sleep })).gone], [true, undefined]);
  const shut = await fetchPublicPosting('1', { fetchImpl: seq([[200, page({ apply: 'none', closed: true })]]), sleep });
  check('a closed posting is as good as taken down', [shut.gone, shut.closed, shut.detail], [true, true, undefined]);
  check('a page with no description is a markup change', (await fetchPublicPosting('1', { fetchImpl: seq([[200, '<html>nothing</html>']]), sleep })).markupChanged, true);
  check('search pages still parse as cards', (await fetchGuestPage('u', { fetchImpl: seq([[200, PAGE]]) })).cards?.length, 3);
}

console.log('\n== the Apply link is the employer\'s page, not LinkedIn\'s interstitial ==');
{
  /* Verbatim shape of the anchor on the posting page, 25 Sep 2026: every row
     collected from the AI surface that morning stored this wrapper. */
  const wrapped = 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ffa-etvl-saasfaprod1%2Efa%2Eocs%2Eoraclecloud%2Ecom%2FhcmUI%2FCandidateExperience%2Fen%2Fjob%2F149214%2F%3Futm_medium%3Djobboard%26utm_source%3DlinkedIn&urlhash=RZFl&mt=Jasm&isSdui=true';
  check('unwrapped', cleanApplyUrl(wrapped), 'https://fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/job/149214/?utm_medium=jobboard&utm_source=linkedIn');
  check('LinkedIn\'s own form is refused', cleanApplyUrl('https://www.linkedin.com/job-apply/4441463619'), null);
  check('an employer URL passes untouched', cleanApplyUrl('https://jobs.acme.com/42?src=li'), 'https://jobs.acme.com/42?src=li');
  check('nothing is nothing', cleanApplyUrl(''), null);
  check('not a URL is nothing', cleanApplyUrl('javascript:void 0'), null);
  // The JSON path still goes through the same function.
  check('the bootstrap-JSON path unwraps the same way',
    applyUrlFrom(`{"entityUrn":"urn:li:fsd_jobPosting:9","companyApplyUrl":"${wrapped}"}`, '9'), cleanApplyUrl(wrapped));
  check('entities', decodeEntities('a &amp; b &#39;c&#39; &quot;d&quot;'), 'a & b \'c\' "d"');
}

console.log('\n== the posting page\'s own furniture stays out of the description ==');
check('the expander label is dropped', stripExpanderLabel('please see our Privacy Policy .\n… more'), 'please see our Privacy Policy .');
check('"... see more" too', stripExpanderLabel('Apply today ... see more'), 'Apply today');
check('a sentence ending in "more" is kept', stripExpanderLabel('We want to hear more'), 'We want to hear more');
check('only at the end', stripExpanderLabel('… more of the same, every day'), '… more of the same, every day');

console.log('\n== the wiring in index.js and linkedin.js ==');
{
  /* index.js executes on import, so these read the source. Each pins one
     thing the public search needs that the signed-in walk did not. */
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const lk = readFileSync(new URL('../src/linkedin.js', import.meta.url), 'utf8');
  check('the source is decided per search',
    /const viaGuest = searchSourceFor\(search, cfg\) === 'guest';/.test(src), true);
  check('discovery fetches the public page, offset in 10s, for the part being read',
    /buildGuestSearchUrl\(passSearch, filters, \{ start: pageIndex \* GUEST_PAGE_SIZE \}\)[\s\S]{0,420}?await fetchGuestPageRetrying\(url, \{/.test(src), true);
  check('the wait never eats the end of the run\'s budget',
    /fetchGuestPageRetrying\(url, \{\s*budgetMs: clock\.remainingMs\(\) - BLOCK_WAIT_RESERVE_MS,/.test(src), true);
  check('a 429 waited out still counts as a block for the exit code (no fast retry)',
    /onWait: \(\{ attempt, of, waitMs \}\) => \{\s*sawBlocked = true;/.test(src), true);
  check('a 429 that answered again slows every later request this run',
    /if \(res\.retries && \(res\.cards \|\| res\.end\)\) \{\s*guestPace = Math\.min\(guestPace \* 2, GUEST_MAX_SLOWDOWN\);/.test(src), true);
  check('the public walk is paced through the slowdown',
    /const guestPacing = \(\) => \(cfg\.pacing\.betweenGuestPages \?\? \[1500, 3500\]\)\.map\(\(ms\) => ms \* guestPace\);/.test(src)
      && (src.match(/await pause\(guestPacing\(\)\);/g) ?? []).length === 4
      && (src.match(/betweenGuestPages/g) ?? []).length === 1, true);
  check('a block that outlasts the waits stops discovery for the rest of the run',
    /if \(res\.blocked\) \{[\s\S]{0,200}?sawBlocked = true;\s*guestBlocked = true;[\s\S]{0,700}?break;/.test(src), true);
  check('and later searches are skipped rather than walked into it',
    /if \(viaGuest && guestBlocked\) \{[\s\S]{0,200}?continue;/.test(src), true);
  check('a card-shaped answer we cannot read throws',
    /if \(res\.markupChanged\) \{[\s\S]{0,700}?throw new Error\(/.test(src), true);
  // Not in date order: the covered-ground stop must be off for it.
  check('no covered-ground horizon for the public search',
    /coveredHorizon: \(!OVERRIDES\.windowHours && baseline && searchSourceFor\(search, cfg\) !== 'guest'\)/.test(src), true);
  check('the per-card staleness gate trusts the endpoint\'s own window',
    /if \(!viaGuest && postedAt && postedAt < cutoff\)/.test(src), true);
  check('a card with a real id is answered by the id, before the identity',
    /if \(card\.jobId && store\.hasJob\(card\.jobId\)\) \{[\s\S]{0,300}?continue;\s*\}[\s\S]{0,900}?let known = card\.jobId \? null : store\.jobIdForCard\(card\.identity\);/.test(src), true);
  check('a repeated card costs no second open',
    /if \(walkSeen\.has\(card\.jobId\)\) continue;/.test(src), true);
  check('the public walk skips the Next-control logic and paces itself',
    /if \(viaGuest\) \{\s*tailHits\.push\(relevantOnPage\);[\s\S]{0,2400}?await pause\(guestPacing\(\)\);\s*continue;\s*\}\s*\n\s*\/\/ Keep paging until LinkedIn's own "Next"/.test(src), true);
  check('reaching the ceiling completes the walk rather than freezing its baseline',
    /pageIndex === lastPage - 1\) \{[\s\S]{0,2000}?\s*walkComplete = true;\s*\}\s*await pause\(guestPacing\(\)\);/.test(src), true);
  // The re-read (rereadPlan): decided on the pages just before the limit, for
  // the keywords of the part that reached it, and read before the walk ends.
  check('each page\'s count of cards worth opening is kept before the limit is judged',
    /tailHits\.push\(relevantOnPage\);\s*if \(pageIndex === lastPage - 1\) \{/.test(src), true);
  check('the limit asks rereadPlan, about the part that reached it',
    /const plan = rereadPlan\(\{ tailHits, keywords: passSearch\.keywords, passes: passNo \+ 1 \+ pendingParts\.length \}\);\s*if \(plan\.parts\) \{\s*pendingParts\.push\(\.\.\.plan\.parts\);/.test(src), true);
  check('the end of a part moves on to the next before the walk completes',
    /if \(pendingParts\.length\) \{\s*startPart\(\);\s*pageIndex = firstPage - 1;\s*await pause\(guestPacing\(\)\);\s*continue;\s*\}\s*walkComplete = true;\s*break;/.test(src), true);
  check('so does the limit',
    /if \(pendingParts\.length\) \{\s*startPart\(\);\s*pageIndex = firstPage - 1;\s*await pause\(guestPacing\(\)\);\s*continue;\s*\}\s*walkComplete = true;\s*\}/.test(src), true);
  check('a part starts from its own first page, with its own limit and tail',
    /const startPart = \(\) => \{[\s\S]{0,200}?passSearch = \{ \.\.\.search, keywords: pendingParts\.shift\(\) \};\s*firstPage = 0;\s*lastPage = guestRequestCap\(pageCap\);\s*tailHits = \[\];/.test(src), true);
  check('an empty part is not read as an empty window',
    /if \(pageIndex === firstPage && passNo === 0\) log\.warn\(`\$\{region\}: the public search returned no results at all/.test(src), true);
  check('held, refused-before and opened cards all count toward the tail',
    /store\.hasJob\(card\.jobId\)\) \{\s*counters\.skippedKnown\+\+;\s*relevantOnPage\+\+;/.test(src)
      && /if \(refusedBefore\) \{\s*counters\.skippedKnown\+\+;\s*relevantOnPage\+\+;/.test(src)
      && /openedThisWalk\.add\(card\.key\);\s*relevantOnPage\+\+;/.test(src), true);
  check('what every re-read bought is logged',
    /if \(passNo > 0\) \{\s*const saved = counters\.newJobs - reread\.newJobsAtStart;\s*log\.info\(`Re-read of the capped window/.test(src), true);
  // The open by id reads the posting's own page, not the pane URL that the AI
  // search redirects to "keywords=jobs" and that read 0 characters.
  check('an open by id navigates to the posting page',
    /await gotoResilient\(page, jobUrl\(card\.jobId\)/.test(lk), true);
  check('the pane URL is gone', /jobPaneUrl/.test(lk), false);
  check('it only goes back to a search page it came from',
    /if \(!clicked && page\.url\(\) !== before && \/\\\/jobs\\\/search\/\.test\(before\)\)/.test(lk), true);
  check('the AI-layout expander, found from the description block',
    /\[id\^="JobDetails_AboutTheJob_"\][\s\S]{0,200}?button\[data-testid="expandable-text-button"\]/.test(lk), true);
  // After a navigation the URL holds the id before anything renders; the
  // first verification open read an empty page by trusting it.
  check('a direct open waits for the posting\'s own block, not its URL',
    /if \(id && navigated\) return false;\s*if \(id\) return location\.href\.includes\(id\);/.test(lk)
      && /navigated: !clicked/.test(lk), true);
  check('the label is stripped in Node', /detail\.description = stripExpanderLabel\(detail\.description\);/.test(lk), true);
  /* The browser is only needed to OPEN a card. Opened up front, it sat on the
     feed doing nothing while the walk ran elsewhere — "stuck on the Brave
     homepage", 25 Sep. */
  // Unless the scan view is on (test/scanview.test.mjs), when the window is
  // opened up front so there is something to watch.
  check('a public-search walk does not open its account up front',
    /if \(viaGuest && !showScan\) \{\s*if \(session && openRegion !== region\) \{\s*await closeBrave\(session\);[\s\S]{0,120}?\}\s*\} else if \(!\(await sessionReady\(\)\)\) \{/.test(src), true);
  check('the account is opened only through openOnAccount, which asks for the session first',
    /const openOnAccount = async \(\) => \{\s*if \(viaGuest && !\(await sessionReady\(\)\)\) return \{ signedOut: true \};\s*await pause\(cfg\.pacing\.betweenCards\);/.test(src)
      && (src.match(/li\.openAndExtract\(page, card, cfg\)/g) ?? []).length === 1, true);
  check('a signed-out account found there ends the walk',
    /if \(signedOutMidWalk \|\| \(viaGuest && guestBlocked\)\) break;/.test(src)
      && (src.match(/if \(got\.signedOut\) \{\s*signedOutMidWalk = true;\s*break;\s*\}/g) ?? []).length === 2, true);
  /* 26 Sep 2026: the public page first, the account only for a kept posting
     that has an employer link to find, and no feed visit. */
  check('every card worth opening is read on its public page first',
    /let publicRead = null;\s*if \(viaGuest && card\.jobId\) \{\s*const pub = await fetchPublicPosting\(card\.jobId, \{/.test(src), true);
  check('the account opens up front only when the public page could not be read',
    /let detail = publicRead;\s*let openedOnAccount = false;\s*if \(!detail\) \{\s*const got = await openOnAccount\(\);/.test(src), true);
  check('a block on the public page stops discovery, it does not fall back to the account',
    /\} else if \(pub\.blocked\) \{[\s\S]{0,120}?sawBlocked = true;\s*guestBlocked = true;[\s\S]{0,400}?break;\s*\} else if \(pub\.gone\)/.test(src), true);
  check('a kept Misc role, or one on LinkedIn\'s own form, is never opened — an unknown marker is',
    /if \(shelf === 'misc' \|\| detail\.applyKind === 'onsite'\) \{\s*counters\.keptWithoutOpen\+\+;/.test(src), true);
  check('the kept-posting open comes after every refusal',
    src.indexOf('if (mustConfirmInternFromPane && !isInternshipTag(detail.employmentTag))') > 0
      && src.indexOf('if (mustConfirmInternFromPane && !isInternshipTag(detail.employmentTag))') < src.indexOf('const shelf = roleCategory({ title: detail.title || card.title }, cfg.roleFocus).category;'), true);
  check('an account that fails that open keeps the public read', /kept from the public page without the employer's link/.test(src), true);
  check('the apply-link tripwire counts only real account opens', /if \(openedOnAccount && !detail\.easyApply\) \{/.test(src), true);
  check('a public-search session is opened without the feed',
    /await openRegionSession\(region, \{ warm: !viaGuest \}\);/.test(src) && /if \(warm\) \{\s*await li\.warmUp\(page, cfg\);/.test(src), true);
  check('and checked on the first posting it opens, before that read is trusted',
    /if \(viaGuest && !accountVerified\) \{\s*try \{\s*await assertSignedIn\(page, context, cfg\);\s*accountVerified = true;/.test(src)
      && src.indexOf('if (viaGuest && !accountVerified)') < src.indexOf('return got;'), true);
  check('a new session starts unverified', /openRegion = code;\s*accountVerified = warm;/.test(src), true);
  check('the backfill opens postings only through a verified session', /if \(openRegion && accountVerified\) \{\s*await backfillDescriptions/.test(src), true);
  check('every walk says what it cost the account', /opened on the \$\{region\} account\.`\);/.test(src), true);
  check('re-read cards are counted apart', /if \(passNo > 0\) counters\.rereadCards \+= cards\.length;/.test(src), true);
  check('and left out of the intake yield', /noteIntake\(store, \{ cards: counters\.cardsSeen - counters\.rereadCards,/.test(src), true);
  check('and is recorded as signed out, exactly like the up-front check',
    /const sessionReady = async \(\) => \{[\s\S]{0,900}?deadRegions\.set\(region, err\.message\);[\s\S]{0,400}?return false;/.test(src), true);
  check('a walk that needed no browser still counts as a region that worked',
    /if \(viaGuest && reachedEnd && rendered && !signedOutMidWalk\) anyRegionWorked = true;/.test(src), true);
  check('the anchor href is cleaned in Node',
    /if \(detail\.applyUrl\) detail\.applyUrl = cleanApplyUrl\(detail\.applyUrl\);/.test(lk), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
