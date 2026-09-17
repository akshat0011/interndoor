#!/usr/bin/env node
/**
 * Put a Facebook PAGE token into .env for one region's reels, and refuse a
 * wrong one.
 *
 *   npm run fb-token -- --region IN
 *
 * WHY THIS EXISTS. The reels cross-post to a Facebook Page through the Reels
 * API (src/facebookreels.js), which wants a Page access token — a different
 * credential from the two Instagram Login tokens, minted a different way, and
 * with the same three silent ways to store it wrong that bin/ig-token.js was
 * written for: the wrong region's variable, a token for the wrong PAGE, or a
 * USER token pasted where a Page token belongs (it reads fine and every
 * publish answers "(#200) requires pages_manage_posts").
 *
 * HOW TO MINT ONE (Meta, 17 Sep 2026):
 *   1. developers.facebook.com/tools/explorer → pick the app → User Token →
 *      add pages_show_list, pages_read_engagement, pages_manage_posts →
 *      Generate. Your Facebook login, not the Page's; the account must be an
 *      admin of the Page. Development mode is enough for your own Pages —
 *      App Review is for other people's.
 *   2. Make it long-lived, or the Page token below dies in an hour:
 *        GET /oauth/access_token?grant_type=fb_exchange_token
 *            &client_id=<app id>&client_secret=<app secret>
 *            &fb_exchange_token=<the user token>
 *   3. GET /me/accounts with the long-lived user token. Each Page row carries
 *      its own `access_token` — THAT is what this tool wants. A Page token
 *      derived from a long-lived user token does not expire.
 *
 * THE TOKEN NEVER APPEARS ON THE COMMAND LINE. Read with echo off, never
 * printed back, never in a URL — the Graph API takes it as a header.
 *
 * THREE CHECKS BEFORE ANYTHING IS WRITTEN, each a real request:
 *   1. The token opens a PAGE — /me answers with a Page (it has `category`),
 *      not a user. A user token is the likeliest wrong paste.
 *   2. It is THIS region's Page: config.json's reels.facebook.pages names it,
 *      or, unnamed, you confirm the Page it found by name.
 *   3. /{page}/video_reels answers — pages_read_engagement is present. There
 *      is no read-only probe for pages_manage_posts; the first publish is.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { PATHS } from '../src/paths.js';
import { setEnvVar } from '../src/reelaccounts.js';
import { fbEnvNames, GRAPH } from '../src/facebookreels.js';

const args = process.argv.slice(2);
const region = String(args[args.indexOf('--region') + 1] || '').toUpperCase();
const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };
if (!/^[A-Z]{2}$/.test(region)) die('Usage: npm run fb-token -- --region IN');

const cfgPath = join(PATHS.root, 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const fb = cfg.reels?.facebook ?? {};
if (!(fb.regions ?? []).map((r) => String(r).toUpperCase()).includes(region)) {
  die(`config.json's reels.facebook.regions does not include ${region}. Nothing to set.`);
}
const expectedName = fb.pages?.[region] || null;

const { page: pageVar, token: tokenVar } = fbEnvNames(region);
const envPath = PATHS.env ?? join(PATHS.root, '.env');
if (!existsSync(envPath)) die(`No .env at ${envPath}`);

console.log(`\n  Region ${region} → Facebook Page${expectedName ? ` "${expectedName}"` : ''}`);
console.log('  Paste the PAGE access token (from GET /me/accounts, the row for the Page).');
console.log('  See the comment at the top of bin/fb-token.js for how to mint one.\n');

function ask(prompt, { secret = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = () => { rl.output.write(`\x1b[2K\r${prompt}`); };
    rl.output.write(prompt);
    if (secret) rl.input.on('data', onData);
    rl.question('', (answer) => {
      if (secret) rl.input.off('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

const token = await ask('  Paste the token (it will not be shown): ', { secret: true });
if (!token) die('Nothing pasted. .env is unchanged.');
if (/\s/.test(token)) die('That has whitespace in it — probably a partial paste. .env is unchanged.');

async function graph(path) {
  const res = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (body?.error) throw new Error(body.error.message ?? 'the API refused it');
  return body;
}

let me;
try {
  me = await graph('/me?fields=id,name,category');
} catch (err) {
  die(`That token does not open anything: ${err.message}\n  .env is unchanged.`);
}
if (!me.category) {
  /* A USER token: /me is a person, and a person has no `category`. Every
     publish with it would answer "requires pages_manage_posts". */
  die(`That is a USER token (it opens "${me.name}", not a Page).\n`
    + '  GET /me/accounts with it and paste the access_token on the Page\'s row instead.\n  .env is unchanged.');
}

if (expectedName) {
  if (String(me.name).trim().toLowerCase() !== String(expectedName).trim().toLowerCase()) {
    die(`That token is for the Page "${me.name}", but config.json says ${region} posts to "${expectedName}".\n  .env is unchanged.`);
  }
} else {
  const yes = await ask(`  That token opens the Page "${me.name}" (id ${me.id}). Is this the ${region} Page? [y/N] `);
  if (!/^y(es)?$/i.test(yes)) die('Not stored. .env is unchanged. Name the Page in config.json reels.facebook.pages to skip this question.');
}

try {
  await graph(`/${me.id}/video_reels?limit=1`);
} catch (err) {
  die(`The Page answers, but its reels do not: ${err.message}\n`
    + '  Mint the user token with pages_show_list, pages_read_engagement AND pages_manage_posts,\n'
    + '  then take the Page token from /me/accounts again. .env is unchanged.');
}

const before = readFileSync(envPath, 'utf8');
let after;
try {
  after = setEnvVar(setEnvVar(before, pageVar, String(me.id)), tokenVar, token);
} catch (err) {
  die(`${err.message}\n  .env is unchanged.`);
}
writeFileSync(envPath, after);

console.log(`  Stored ${pageVar}=${me.id} and ${tokenVar} for the Page "${me.name}".`);
console.log('  The queue server re-reads .env when a region has no credentials: the next reel cross-posts, no restart.');
console.log('  pages_manage_posts cannot be probed without posting — the first reel is the test;');
console.log('  watch queue.log for "Facebook reel for … —".\n');
