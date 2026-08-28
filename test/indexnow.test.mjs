/**
 * IndexNow — announcing change to Bing, Yandex, Seznam and Naver.
 *
 * This exists BECAUSE Google's Indexing API refuses everything that is not a
 * JobPosting page. The homepage, the hubs, both directories, /alerts and
 * /report have no way to be announced to Google at all; IndexNow takes any URL,
 * so it is the only channel those pages have besides an ordinary crawl.
 *
 * The two rules worth pinning: it announces what CHANGED (re-sending an
 * unchanged page every 30 minutes is the abuse the protocol warns against), and
 * one foreign URL in a batch makes the whole batch 422, so filtering is not
 * tidiness.
 */
import { readFileSync, existsSync } from 'node:fs';
import { submitUrls, ownUrl, indexNowConfigured, MAX_URLS } from '../src/indexnow.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
const S = 'https://interndoor.com';

console.log('\n== only our own URLs may go in a batch ==');
/* IndexNow 422s the WHOLE batch if any URL is off-host, so one stray link
   loses every other page in the same request. */
for (const u of [`${S}/`, `${S}/us/companies/amazon`, `${S}/report`, `${S}/jobs/x-1`]) ok(`accepts ${u.slice(S.length) || '/'}`, ownUrl(u));
for (const u of ['https://evil.example/x', 'https://interndoor.com.evil.io/x', `${S}/jobs/x?utm=1`, `${S}/x#a`, null, '']) {
  ok(`refuses ${String(u).slice(0, 38)}`, !ownUrl(u));
}

console.log('\n== it accepts what Google refuses ==');
/* The entire reason this module exists — src/indexing.js would reject all of
   these because they carry no JobPosting markup. */
for (const u of ['/', '/us', '/companies', '/us/companies/amazon', '/report', '/alerts']) {
  ok(`${u} is submittable here`, ownUrl(`${S}${u}` === `${S}/` ? `${S}/` : `${S}${u}`));
}

console.log('\n== the request Bing actually receives ==');
{
  let got = null;
  const fake = async (url, init) => { got = { url, body: JSON.parse(init.body) }; return { status: 200, text: async () => '' }; };
  const res = await submitUrls([`${S}/report`, `${S}/us`, 'https://evil.example/x'], cfg, { fetchImpl: fake });
  check('the foreign URL is dropped, the batch still goes', res.sent, 2);
  check('endpoint', got.url, 'https://api.indexnow.org/indexnow');
  check('host', got.body.host, 'interndoor.com');
  check('the key matches config', got.body.key, cfg.indexing.indexNow.key);
  ok('keyLocation points at the live file', got.body.keyLocation === `${S}/${cfg.indexing.indexNow.key}.txt`);
  check('urlList', got.body.urlList.sort(), [`${S}/report`, `${S}/us`].sort());
}

console.log('\n== duplicates are collapsed and nothing empty is sent ==');
{
  let calls = 0;
  const fake = async () => { calls++; return { status: 200, text: async () => '' }; };
  const dup = await submitUrls([`${S}/report`, `${S}/report`], cfg, { fetchImpl: fake });
  check('one URL, not two', dup.sent, 1);
  const none = await submitUrls([], cfg, { fetchImpl: fake });
  check('an unchanged publish sends nothing', none.skipped, 'nothing-changed');
  check('…and makes no request', calls, 1);
}

console.log('\n== it fails soft and says something useful ==');
{
  const f403 = async () => ({ status: 403, text: async () => 'key not found' });
  const res = await submitUrls([`${S}/report`], cfg, { fetchImpl: f403 });
  check('a 403 sends nothing', res.sent, 0);
  /* The 403 cause is invisible on the site: the key file is missing or wrong,
     and every page still renders perfectly. The message has to name it. */
  ok('…and names the key file as the cause', /key.*\.txt|<key>\.txt/i.test(res.error));
  const f202 = async () => ({ status: 202, text: async () => '' });
  check('202 (key still verifying) counts as accepted', (await submitUrls([`${S}/report`], cfg, { fetchImpl: f202 })).sent, 1);
}

console.log('\n== switched off means switched off ==');
{
  let calls = 0;
  const fake = async () => { calls++; return { status: 200, text: async () => '' }; };
  const off = await submitUrls([`${S}/report`], { indexing: { indexNow: { key: 'k', enabled: false } } }, { fetchImpl: fake });
  check('disabled', off.skipped, 'disabled');
  const nokey = await submitUrls([`${S}/report`], { indexing: {} }, { fetchImpl: fake });
  check('no key', nokey.skipped, 'no-key');
  check('neither made a request', calls, 0);
}

console.log('\n== the key file must exist AND ship ==');
const key = cfg.indexing.indexNow.key;
ok('config carries a key', indexNowConfigured(cfg) && /^[0-9a-f]{8,}$/i.test(key));
ok(`web/public/${key}.txt exists`, existsSync(`web/public/${key}.txt`));
check('…and contains exactly the key', readFileSync(`web/public/${key}.txt`, 'utf8').trim(), key);
/* A generated file missing from the allowlist is written every run and pushed
   never — and here that means every submission is refused 403 while the site
   looks perfectly healthy. */
ok('…and is in the PUBLISHED allowlist',
  readFileSync('src/publish.js', 'utf8').includes(`'web/public/${key}.txt'`));

console.log('\n== the batch ceiling is the protocol\'s ==');
check('MAX_URLS', MAX_URLS, 10_000);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
