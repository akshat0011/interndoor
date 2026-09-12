#!/usr/bin/env node
/**
 * Put a freshly minted Instagram token into .env, and refuse a wrong one.
 *
 *   npm run ig-token -- --region IN
 *
 * WHY THIS EXISTS. An Instagram Login token lasts 60 days and NOTHING WARNS
 * YOU (§13), and it can also be killed outright long before that: linking a
 * Facebook Page to one account on 12 Sep 2026 invalidated the OTHER account's
 * token the same hour — *"the session has been invalidated because the user
 * changed their password or Facebook has changed the session for security
 * reasons"* — and an invalidated token cannot be refreshed, only replaced. So
 * replacing one is a recurring chore, and it was a hand-edit of .env with three
 * ways to get it silently wrong: the wrong region's variable, a token for the
 * wrong ACCOUNT, or a token minted before
 * `instagram_business_content_publish` was granted, which reads perfectly and
 * fails on the first publish.
 *
 * THE TOKEN NEVER APPEARS ON THE COMMAND LINE. It is read from the terminal
 * with echo off, so it does not land in shell history, in `ps`, or in a
 * transcript. It is never printed back, not even truncated.
 *
 * THREE CHECKS BEFORE ANYTHING IS WRITTEN, and every one is a real request to
 * the live API rather than a guess about the string:
 *
 *   1. The token resolves to an account at all.
 *   2. That account's username is the one config.json names for this region.
 *      This is `bin/ig_publish.py`'s guard moved EARLIER — that one refuses at
 *      publish time, which is correct but late; the wrong token sits in .env
 *      until a slot fires. Here the wrong token is never stored.
 *   3. `content_publishing_limit` answers. §13's note says the first real
 *      publish is the only test of the publish scope; it is not quite — a token
 *      without it is refused here, hours before a reel needs it.
 *
 * Only then is .env rewritten, in place, with every other line untouched.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { PATHS } from '../src/paths.js';
import { credEnvNames, accountFor, setEnvVar } from '../src/reelaccounts.js';

const GRAPH = 'https://graph.instagram.com/v21.0';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const region = String(arg('region') ?? '').toUpperCase();
if (!/^[A-Z]{2}$/.test(region)) die('Which board? e.g. npm run ig-token -- --region IN');

const cfgPath = join(PATHS.root, 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const expected = accountFor(region, cfg);
if (!expected) die(`config.json names no reels account for ${region}. Nothing to set.`);

const { user: userVar, token: tokenVar } = credEnvNames(region);
const envPath = PATHS.env ?? join(PATHS.root, '.env');
if (!existsSync(envPath)) die(`No .env at ${envPath}`);

console.log(`\n  Region ${region} → @${expected}`);
console.log('  Mint one at: Meta App Dashboard → Instagram → API setup with');
console.log('  Instagram login → Generate access tokens → the @' + expected + ' row.\n');

/** Read a secret with the terminal's echo off. */
function askSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    /* The prompt is written by hand and the echoed characters suppressed, so
       nothing the user pastes is ever drawn to the screen or kept by the
       terminal's scrollback. */
    const onData = () => { rl.output.write(`\x1b[2K\r${prompt}`); };
    rl.output.write(prompt);
    rl.input.on('data', onData);
    rl.question('', (answer) => {
      rl.input.off('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

const token = await askSecret('  Paste the token (it will not be shown): ');
if (!token) die('Nothing pasted. .env is unchanged.');
if (/\s/.test(token)) die('That has whitespace in it — probably a partial paste. .env is unchanged.');

async function graph(path) {
  const res = await fetch(`${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`);
  const body = await res.json().catch(() => ({}));
  if (body?.error) throw new Error(body.error.message ?? 'the API refused it');
  return body;
}

let me;
try {
  me = await graph('/me?fields=id,username,account_type');
} catch (err) {
  die(`That token does not open an account: ${err.message}\n  .env is unchanged.`);
}

if (me.username !== expected) {
  /* THE MISTAKE THIS FILE EXISTS FOR. A reel posted to the wrong account
     cannot be taken back. */
  die(`That token is for @${me.username}, but ${region} posts as @${expected}.\n  .env is unchanged.`);
}

try {
  await graph(`/${me.id}/content_publishing_limit`);
} catch (err) {
  die(`@${me.username} answers, but publishing does not: ${err.message}\n`
    + '  Add instagram_business_content_publish under the app\'s Permissions and\n'
    + '  mint the token again. .env is unchanged.');
}

/* Every other byte left alone — see setEnvVar, which also refuses a file that
   already assigns this variable twice rather than picking a winner. */
const before = readFileSync(envPath, 'utf8');
let after;
try {
  after = setEnvVar(before, tokenVar, token);
} catch (err) {
  die(`${err.message}\n  .env is unchanged.`);
}
writeFileSync(envPath, after);

console.log(`  Stored ${tokenVar} for @${me.username} (${me.account_type}).`);

/* THE CONFIGURED ID IS CHECKED BY USE, NOT BY COMPARISON, and the first
   version of this got it wrong. `me.id` returns the app-scoped id an
   Instagram Login token carries (`2800…`), while `.env` holds the Instagram
   Business Account id (`17841…`) — the two ALWAYS differ, they address the
   same account, and both answer. Comparing them printed an alarming NOTE
   about every healthy account on the site, including @interndoorusa, which
   had been publishing on that exact pair for weeks.
   What actually matters is whether the id the PUBLISHER uses resolves with
   this token, so that is what is asked. */
const configuredId = new RegExp(`^${userVar}=(.*)$`, 'm').exec(after)?.[1]?.trim();
if (!configuredId) {
  console.log(`  NOTE: ${userVar} is not set. The publisher addresses the account by it.`);
} else {
  try {
    await graph(`/${configuredId}/content_publishing_limit`);
    console.log(`  ${userVar} resolves with it, so the pair the publisher uses is good.`);
  } catch (err) {
    console.log(`  NOTE: ${userVar}=${configuredId} does NOT resolve with this token — ${err.message}`);
    console.log('  The token is stored, but publishing addresses the account by that id.');
  }
}
console.log('  Publishing answered, so the scope is there too.\n');
