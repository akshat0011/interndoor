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
import {
  parseGuestCards, guestCards, buildGuestSearchUrl, fetchGuestPage, guestRequestCap,
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
  check('discovery fetches the public page, offset in 10s',
    /buildGuestSearchUrl\(search, filters, \{ start: pageIndex \* GUEST_PAGE_SIZE \}\)[\s\S]{0,120}?await fetchGuestPage\(url\)/.test(src), true);
  check('a 429 stops discovery for the rest of the run and is never fast-retried',
    /if \(res\.blocked\) \{[\s\S]{0,200}?sawBlocked = true;\s*guestBlocked = true;[\s\S]{0,400}?break;/.test(src), true);
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
    /if \(card\.jobId && store\.hasJob\(card\.jobId\)\) \{[\s\S]{0,300}?continue;\s*\}\s*let known = card\.jobId \? null : store\.jobIdForCard\(card\.identity\);/.test(src), true);
  check('a repeated card costs no second open',
    /if \(walkSeen\.has\(card\.jobId\)\) continue;/.test(src), true);
  check('the public walk skips the Next-control logic and paces itself',
    /if \(viaGuest\) \{[\s\S]{0,700}?await pause\(cfg\.pacing\.betweenGuestPages[^)]*\);\s*continue;\s*\}\s*\n\s*\/\/ Keep paging until LinkedIn's own "Next"/.test(src), true);
  check('reaching the ceiling completes the walk rather than freezing its baseline',
    /pageIndex === lastPage - 1\) \{[\s\S]{0,600}?walkComplete = true;\s*\}\s*await pause\(cfg\.pacing\.betweenGuestPages/.test(src), true);
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
  check('a public-search walk does not open its account up front',
    /if \(viaGuest\) \{\s*if \(session && openRegion !== region\) \{\s*await closeBrave\(session\);[\s\S]{0,120}?\}\s*\} else if \(!\(await sessionReady\(\)\)\) \{/.test(src), true);
  check('it opens the account at the first card worth opening',
    /log\.ok\(`Opening:[\s\S]{0,400}?if \(viaGuest && !\(await sessionReady\(\)\)\) \{\s*signedOutMidWalk = true;\s*break;\s*\}\s*\n\s*await pause\(cfg\.pacing\.betweenCards\);/.test(src), true);
  check('a signed-out account found there ends the walk',
    /if \(signedOutMidWalk\) break;/.test(src), true);
  check('and is recorded as signed out, exactly like the up-front check',
    /const sessionReady = async \(\) => \{[\s\S]{0,900}?deadRegions\.set\(region, err\.message\);[\s\S]{0,400}?return false;/.test(src), true);
  check('a walk that needed no browser still counts as a region that worked',
    /if \(viaGuest && reachedEnd && rendered && !signedOutMidWalk\) anyRegionWorked = true;/.test(src), true);
  check('the anchor href is cleaned in Node',
    /if \(detail\.applyUrl\) detail\.applyUrl = cleanApplyUrl\(detail\.applyUrl\);/.test(lk), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
