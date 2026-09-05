#!/usr/bin/env node
/**
 * Announce job pages to the Google Indexing API by hand.
 *
 *   npm run index-urls -- --status     # queue depth, quota used, last error
 *   npm run index-urls -- --check      # prove the key and Search Console owner
 *   npm run index-urls -- --dry-run    # what the next sweep would send
 *   npm run index-urls -- --seed       # queue every job page now on the site
 *   npm run index-urls -- --limit=50   # send more than perRun, once
 *   npm run index-urls -- --force      # ignore minAgeMinutes
 *
 * The scheduler already does this after every publish (src/publish.js). This
 * exists for the two things a scheduler cannot do: prove the credentials work
 * before waiting 30 minutes to find out, and seed the board's existing pages,
 * which are the ones Google has never seen and the reason for building any of
 * this.
 *
 * --seed reads the SITEMAPS rather than the database. They already hold exactly
 * the indexable job URLs, in canonical form, built by writeSitemap from the
 * same isIndexable + jobSlug rules the pages were written with — so seeding
 * from them cannot queue a URL with no page behind it, and cannot drift the way
 * a fourth copy of the slug rule would. (jobPageSlug already exists three
 * times; see the project notes.) Same principle as the Telegram post: a link is worth
 * sending once a page is known to be there.
 */
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import {
  runIndexingSweep, indexingConfigured, keyPath, loadServiceAccount,
  accessToken, isJobPageUrl, queueForIndexing, DAILY_QUOTA,
} from '../src/indexing.js';
import { publishedRegions } from '../src/regions.js';

const ROOT = join(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (f) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit ? Number(hit.split('=')[1]) : null;
};

const cfg = loadConfig();
const store = new Store();
const SITE = 'https://interndoor.com';

function setup() {
  console.log(`\nNo service-account key at ${keyPath()}\n`);
  console.log('Four steps, and all four are required:');
  console.log('  1. Google Cloud console: pick a project and ENABLE the Indexing API.');
  console.log('  2. Create a service account there, add a JSON key, download it.');
  console.log(`  3. Save it as ${keyPath()}`);
  console.log('  4. Search Console -> interndoor.com -> Settings -> Users and permissions');
  console.log('     -> add the key\'s client_email as an OWNER. Less than Owner is a 403.\n');
}

/** Every indexable job page on the published boards, read off the sitemaps. */
function seedUrls() {
  const urls = [];
  for (const region of publishedRegions(cfg)) {
    const file = join(ROOT, 'web', 'public', ...(region.slug ? [region.slug] : []), 'sitemap.xml');
    if (!existsSync(file)) { log.warn(`no sitemap for ${region.code} at ${file}`); continue; }
    const xml = readFileSync(file, 'utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(m[1].trim());
  }
  /* The sitemap also lists the board, the directory and /alerts. None of them
     carries JobPosting markup, and the API accepts nothing else — so this
     filter is the rule, not a tidy-up. */
  return urls.filter((u) => isJobPageUrl(u, SITE));
}

if (has('--status')) {
  const s = store.indexStats({ maxAttempts: cfg.indexing?.maxAttempts ?? 3 });
  const cap = Math.min(cfg.indexing?.dailyCap ?? 190, DAILY_QUOTA);
  console.log(`\nkey            ${indexingConfigured() ? keyPath() : 'MISSING — nothing is being announced'}`);
  console.log(`enabled        ${cfg.indexing?.enabled === false ? 'no (config)' : 'yes'}`);
  console.log(`sent, 24h      ${s.submitted24h} of ${cap} (Google's ceiling is ${DAILY_QUOTA})`);
  console.log(`sent, total    ${s.submittedTotal}`);
  console.log(`queued         ${s.pendingUpdate} update · ${s.pendingDelete} delete`);
  console.log(`retired        ${s.retired}${s.retired ? ' (hit maxAttempts — see the error below)' : ''}`);
  if (s.lastError) console.log(`last error     ${s.lastError.url}\n               ${s.lastError.error}`);
  console.log('');
  process.exit(0);
}

if (!indexingConfigured()) { setup(); process.exit(1); }

if (has('--check')) {
  const sa = loadServiceAccount();
  console.log(`\nkey file       ${keyPath()}`);
  console.log(`client_email   ${sa.client_email}`);
  console.log(`project        ${sa.project_id ?? '(not in key)'}`);
  try {
    await accessToken(sa);
    console.log('token          OK — the key is valid and the Indexing API is enabled.');
  } catch (err) {
    console.log(`token          FAILED — ${err.message}`);
    console.log('\nThat is a Google Cloud problem: the API is probably not enabled on the project.');
    process.exit(1);
  }
  /* A token proves the key. It does NOT prove the Search Console grant, which
     is the step people miss — so send one real URL and let Google answer. */
  const [probe] = store.indexDue({ limit: 1, minAgeMs: 0 });
  console.log(`\nA valid token does not prove the Search Console owner grant.\n${probe
    ? `Run --dry-run then --force --limit=1 to test it against ${probe.url}`
    : 'Queue something first: npm run index-urls -- --seed'}\n`);
  process.exit(0);
}

if (has('--seed')) {
  const urls = seedUrls();
  const { queuedUpdate } = queueForIndexing(store, { indexUrls: urls, removedUrls: [] });
  console.log(`Found ${urls.length} live job pages; ${queuedUpdate} newly queued (the rest were already announced or already owed).`);
}

const res = await runIndexingSweep(store, cfg, {
  dryRun: has('--dry-run'),
  force: has('--force'),
  limit: num('--limit'),
});

if (res.wouldSend) {
  console.log(`\nWould send ${res.wouldSend.length}, ${res.spent} already used in the last 24h:`);
  for (const r of res.wouldSend) console.log(`  ${r.type.padEnd(12)} ${r.url}`);
  console.log('');
} else if (res.skipped) {
  console.log(`Nothing sent — ${res.skipped}.`);
} else {
  console.log(`Sent ${res.sent}${res.failed ? `, ${res.failed} failed` : ''}. ${res.spent}/${res.cap} used in the last 24h.`);
}
