/**
 * Broadcasting India's new listings to WhatsApp.
 *
 * WHAT THIS IS, AND THE RISK IT CARRIES. WhatsApp has no public channel API,
 * so this drives WhatsApp Web through Playwright. That is against their
 * Acceptable Use policy and the documented consequence is the NUMBER being
 * banned, which is why this repo stayed Telegram-only until now. It runs on a
 * throwaway number, on its own browser profile, at a deliberately slow pace,
 * and every part of it fails soft — but the risk is real and it is the reason
 * `whatsapp.enabled` exists and defaults to false.
 *
 * IT NEVER TOUCHES THE SCRAPER'S BROWSER. `PATHS.profile` is the scraper's
 * Brave profile and `launchBrave` clears and claims it on its way in; pointing
 * WhatsApp at it would kill a scrape mid-flight. This uses
 * `PATHS.whatsappProfile`, a directory of its own, and it is the only browser
 * in this project that is Brave rather than Playwright's own Chromium —
 * because the session has to persist somewhere the user can scan a QR into.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PATHS } from './paths.js';
import { jobParts } from './telegram.js';
import { regionOf, resolveRowRegion } from './regions.js';
import { log } from './logger.js';

/** WhatsApp's own cap is far higher, but a wall of text is not read. */
export const MAX_MESSAGE = 1400;

/** Brave, wherever it is. Nothing here falls back to Chrome: the user logged
 *  the number in on Brave and a different browser is a different profile. */
export function bravePath() {
  const candidates = [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * One posting, in WhatsApp's own markup.
 *
 * The facts and their order come from `jobParts`, shared with Telegram, so the
 * two channels cannot drift apart on wording. What differs is everything about
 * the rendering: WhatsApp has *bold* rather than <b>, and NO ANCHOR AT ALL, so
 * a URL is always visible text.
 *
 * OUR PAGE LEADS AND THE EMPLOYER'S LINK FOLLOWS, which is the opposite of the
 * Telegram message and is forced by how WhatsApp previews. It builds the card
 * from the FIRST url in the message, so leading with the employer's apply link
 * would render LinkedIn's preview on every post and throw away the per-posting
 * OG card the site now generates. Leading with the job page shows our card,
 * and that page carries its own Apply button, so nothing is a click further
 * away than it was.
 */
export function composeWhatsApp(job, region = regionOf('IN')) {
  const p = jobParts(job, region);
  const lines = [
    `🏢 *${p.company}*`,
    `🚀 *${p.title}*`,
    p.page,
  ];
  if (p.facts.length) lines.push('', ...p.facts);
  // Only when it is somewhere else. With no employer URL `apply` falls back to
  // the job page, and printing the same link twice reads as a mistake.
  if (p.apply && p.apply !== p.page) lines.push('', `👉 Apply: ${p.apply}`);
  lines.push('', `🌐 Every open internship: ${p.board}`);

  // Trim from the FACTS, never the string: slicing would cut a URL in half and
  // WhatsApp would render the fragment as plain text.
  let out = lines.join('\n');
  while (out.length > MAX_MESSAGE && lines.length > 6) {
    lines.splice(lines.length - 5, 1);
    out = lines.join('\n');
  }
  return out;
}

/**
 * Open the WhatsApp profile. The caller always closes it.
 *
 * `headless` is a parameter and not a constant because the two uses genuinely
 * differ: the login flow has to be visible for a QR to be scanned, and the
 * scheduled send should not throw a window in front of whatever he is doing
 * every thirty minutes.
 */
export async function openWhatsApp({ headless = true } = {}) {
  const brave = bravePath();
  if (!brave) throw new Error('Brave is not installed at the expected path');
  mkdirSync(PATHS.whatsappProfile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PATHS.whatsappProfile, {
    executablePath: brave,
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/**
 * Logged in, waiting for a QR, or still deciding.
 *
 * WhatsApp Web's markup changes often and every selector here is a guess that
 * will eventually stop being true, so this asks several questions and reports
 * what it saw rather than returning a bare boolean. A send that cannot tell
 * which state it is in must do nothing, not press on.
 */
export async function sessionState(page, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await page.evaluate(() => ({
      chatList: !!document.querySelector('#pane-side'),
      qr: !!document.querySelector('[data-ref], canvas[aria-label*="scan" i], canvas[aria-label*="QR" i]'),
      loading: /loading|starting/i.test(document.body.innerText.slice(0, 400)),
      text: document.body.innerText.slice(0, 120).replace(/\s+/g, ' '),
    }));
    if (seen.chatList) return { state: 'ready', ...seen };
    if (seen.qr) return { state: 'needs-qr', ...seen };
    await page.waitForTimeout(1000);
  }
  return { state: 'unknown' };
}

/* ---------------------------------------------------------------- the target */

/**
 * Open the channel or group to broadcast into, by the name it shows.
 *
 * BY NAME, NOT BY POSITION. A chat list reorders itself the moment anything
 * arrives, so "the first item" is whatever was most recently active — which on
 * a shared number could be somebody's reply. Typing the name into search and
 * clicking the row whose title matches EXACTLY is the only addressing here
 * that cannot quietly select the wrong conversation and post a job listing
 * into it.
 */
export async function findTarget(page, name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return { ok: false, error: 'no target name configured' };

  const search = page.locator('div[contenteditable="true"][data-tab="3"]')
    .or(page.getByRole('textbox', { name: /search/i })).first();
  try {
    await search.click({ timeout: 10_000 });
    // Clear whatever a previous run left behind, or the query concatenates.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(wanted, { delay: 40 });
    await page.waitForTimeout(1800);
  } catch (e) {
    return { ok: false, error: `could not reach the search box (${e.message.split('\n')[0]})` };
  }

  // The exact title, not a contains: "InternDoor" must never match a chat
  // called "InternDoor feedback".
  const row = page.locator(`#pane-side span[title="${wanted.replace(/"/g, '\\"')}"]`).first();
  if (!await row.count()) {
    return { ok: false, error: `no chat titled exactly "${wanted}" — create it in WhatsApp first, or fix whatsapp.target` };
  }
  await row.click();
  await page.waitForTimeout(1500);

  // Prove the right conversation is open before anything is typed into it.
  const header = await page.locator('header').first().innerText().catch(() => '');
  if (!header.includes(wanted)) {
    return { ok: false, error: `opened a conversation whose header does not say "${wanted}" (saw "${header.slice(0, 60)}")` };
  }
  return { ok: true, how: `search → exact title "${wanted}"` };
}

/**
 * Type one message and send it.
 *
 * ENTER SENDS IN WHATSAPP, so a multi-line message cannot simply be typed: the
 * first newline would post a half-written listing. Every line is typed and
 * joined with Shift+Enter, and Enter is pressed exactly once, at the end.
 */
export async function sendOne(page, text) {
  const box = page.locator('footer div[contenteditable="true"]')
    .or(page.locator('div[contenteditable="true"][data-tab="10"]')).first();
  await box.click({ timeout: 10_000 });
  const lines = String(text).split('\n');
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.type(line, { delay: 8 });
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Broadcast a scan's new listings.
 *
 * Handed the SAME array Telegram gets — the rows publish actually published —
 * so this inherits the guarantee that every link has a page behind it. It does
 * not re-derive that: `postNewJobs`'s own note explains what it cost to get
 * wrong, and a second filter here would be a second thing to get wrong.
 *
 * EVERYTHING FAILS SOFT. A browser that will not start, a session that has
 * been unlinked from the phone, a renamed channel, a selector WhatsApp changed
 * this morning — none of them may fail a scan. The scrape is the product; this
 * is a broadcast, and the same rule Telegram has followed since it was added.
 */
export async function postNewJobsWhatsApp(jobs, cfg) {
  const conf = cfg.whatsapp ?? {};
  if (!conf.enabled) return { sent: 0, reason: 'disabled' };

  const regions = new Set(conf.regions ?? ['IN']);
  const mine = (jobs ?? []).filter((j) => regions.has(resolveRowRegion(j)));
  if (!mine.length) return { sent: 0, reason: 'nothing on these boards' };

  /* ONE SCAN'S WORTH, and the rest wait for the next — the same call the reel
     sweep makes. This is a UI being driven at roughly six seconds a message,
     so forty new listings would hold a browser open for four minutes and look
     exactly like the burst that gets a number flagged. */
  const cap = Math.max(1, Number(conf.maxPerRun ?? 8));
  const batch = mine.slice(0, cap);
  const gap = Math.max(1500, Number(conf.sendGapMs ?? 6000));

  let ctx = null;
  let sent = 0;
  try {
    const opened = await openWhatsApp({ headless: conf.headless !== false });
    ctx = opened.ctx;
    const { page } = opened;

    const s = await sessionState(page);
    if (s.state !== 'ready') {
      log.warn(s.state === 'needs-qr'
        ? 'WhatsApp: the number is not linked — run npm run whatsapp-login. Nothing posted.'
        : `WhatsApp: could not read the session (${s.state}). Nothing posted.`);
      return { sent: 0, reason: s.state };
    }

    const target = await findTarget(page, conf.target);
    if (!target.ok) {
      log.warn(`WhatsApp: ${target.error}. Nothing posted.`);
      return { sent: 0, reason: 'target not found' };
    }

    for (const job of batch) {
      await sendOne(page, composeWhatsApp(job, regionOf(resolveRowRegion(job))));
      sent += 1;
      if (sent < batch.length) await sleep(gap);
    }
    const held = mine.length - batch.length;
    log.ok(`WhatsApp: posted ${sent} to "${conf.target}"${held ? ` — ${held} held for the next run` : ''}.`);
  } catch (err) {
    log.warn(`WhatsApp: ${err.message.split('\n')[0]} — ${sent} posted before it stopped.`);
  } finally {
    await ctx?.close().catch(() => {});
  }
  return { sent };
}
