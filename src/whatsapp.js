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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PATHS } from './paths.js';
import { jobParts, publishedIndex } from './telegram.js';
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
/**
 * Stop the profile restoring its last session.
 *
 * WHATSAPP ALLOWS ONE ACTIVE WEB SESSION AT A TIME. If Brave reopens the
 * WhatsApp tab it had last time, that restored tab claims the session and the
 * tab this code drives gets "WhatsApp is open in another window" instead of a
 * chat list — the automation then does nothing, correctly but uselessly, and
 * the cause is invisible from the logs.
 *
 * `restore_on_startup: 5` is Chromium's "open the New Tab page", so nothing is
 * restored and only the tab this code opens exists. `exited_cleanly` is set
 * with it because a profile killed mid-run otherwise shows the "restore pages?"
 * bubble on the next launch, which is the same problem wearing a hat.
 *
 * Written BEFORE the browser starts, because Chromium reads Preferences once
 * at startup and rewrites the whole file on exit — editing it while Brave is
 * running achieves nothing.
 */
function noSessionRestore(dir) {
  const file = join(dir, 'Default', 'Preferences');
  if (!existsSync(file)) return false;          // first run: nothing to fix yet
  try {
    const prefs = JSON.parse(readFileSync(file, 'utf8'));
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5, startup_urls: [] };
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
    writeFileSync(file, JSON.stringify(prefs));
    return true;
  } catch {
    // A malformed or half-written Preferences file is Brave's to repair, and a
    // broadcast is not worth failing a scan over.
    return false;
  }
}

export async function openWhatsApp({ headless = true } = {}) {
  const brave = bravePath();
  if (!brave) throw new Error('Brave is not installed at the expected path');
  mkdirSync(PATHS.whatsappProfile, { recursive: true });
  noSessionRestore(PATHS.whatsappProfile);
  const ctx = await chromium.launchPersistentContext(PATHS.whatsappProfile, {
    executablePath: brave,
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();

  /* WHATSAPP REFUSES HEADLESS CHROME BY USER AGENT, and says so in a way that
     looks like anything but: "WhatsApp works with Google Chrome 100+ — update
     Chrome". Nothing renders, there is no QR and no chat list, so every
     selector below reports absence and the session looks broken rather than
     rejected. The only difference between the two is the word:

       headless  ...(KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36
       headed    ...(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36

     Read from the live browser and rewritten rather than hardcoded, so the
     version can never drift out of step with the binary actually running. */
  const ua = await page.evaluate(() => navigator.userAgent);
  if (/HeadlessChrome/.test(ua)) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', { userAgent: ua.replace('HeadlessChrome', 'Chrome') });
  }

  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/**
 * "WhatsApp is open in another window. Click Use here."
 *
 * A LINKED session that some other window holds the claim on — which is a
 * third state, and missing it is what made a successful QR scan report as a
 * timeout: the account was linked, the chat list simply never rendered because
 * this window had not claimed it. One click takes the claim.
 */
export async function claimSession(page) {
  const btn = page.getByRole('button', { name: /use here/i })
    .or(page.locator('button:has-text("Use here")')).first();
  if (!await btn.count()) return false;
  await btn.click();
  await page.waitForTimeout(4000);
  return true;
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
      elsewhere: /open in another window|use here/i.test(document.body.innerText.slice(0, 400)),
      unsupported: /works with google chrome|update chrome/i.test(document.body.innerText.slice(0, 400)),
      text: document.body.innerText.slice(0, 120).replace(/\s+/g, ' '),
    }));
    if (seen.chatList) return { state: 'ready', ...seen };
    if (seen.qr) return { state: 'needs-qr', ...seen };
    /* Linked, but claimed elsewhere. Take the claim and carry on rather than
       reporting a broken session — the account is fine. */
    if (seen.elsewhere && await claimSession(page)) continue;
    if (seen.unsupported) return { state: 'browser-refused', ...seen };
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
/** The composer, which is the only element that both proves which conversation
 *  is open AND is the thing about to be typed into. */
function composer(page) {
  return page.locator('footer div[contenteditable="true"]')
    .or(page.locator('div[contenteditable="true"][data-tab="10"]')).first();
}

/**
 * Refuse to type unless the box itself names the target.
 *
 * A channel's header says "4 Updates in Status", not the channel name, so
 * checking the header would reject a correctly-opened channel. The composer
 * carries aria-label "Type a message to Interndoor" — it names the
 * destination, and it is the very element the text goes into, so there is no
 * gap between what was verified and what is used.
 */
async function composerNames(page, name) {
  const box = composer(page);
  if (!await box.count()) return { ok: false, error: 'no composer on this screen' };
  const aria = (await box.getAttribute('aria-label')) ?? '';
  if (!aria.toLowerCase().includes(String(name).toLowerCase())) {
    return { ok: false, error: `the message box says "${aria}" — not "${name}"` };
  }
  return { ok: true };
}

/**
 * Open the channel (or group) to broadcast into, by the name it shows.
 *
 * BY NAME, NOT BY POSITION. A list reorders itself the moment anything
 * arrives, so "the first row" is whatever was most recently active — which on
 * a number with personal chats on it could be somebody's reply. Nothing here
 * can select a conversation it was not asked for.
 *
 * CHANNELS ARE NOT IN THE CHAT LIST, and searching for one there finds
 * nothing: they live behind their own nav button, which only appears once the
 * account has a channel at all. That is why an earlier probe concluded the
 * client had no channel support — it had none to show. Channels are tried
 * first and the chat search is the fallback, so a group by the same name still
 * works.
 *
 * The title is matched case-insensitively but WHOLE: the channel is called
 * "Interndoor" and the config said "InternDoor". Exactness is what stops
 * "Interndoor" opening "Interndoor feedback"; case is not part of that.
 */
export async function findTarget(page, name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return { ok: false, error: 'no target name configured' };
  const exactly = new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  const channels = page.getByRole('button', { name: /^channels$/i }).first();
  if (await channels.count()) {
    try {
      await channels.click();
      await page.waitForTimeout(2500);
      const row = page.getByTitle(exactly).first();
      if (await row.count()) {
        await row.click();
        await page.waitForTimeout(2500);
        const v = await composerNames(page, wanted);
        if (v.ok) return { ok: true, how: `channel "${wanted}"` };
      }
    } catch { /* fall through to the chat search */ }
  }

  try {
    await page.getByRole('button', { name: /^chats$/i }).first().click();
    await page.waitForTimeout(1200);
    const search = page.locator('div[contenteditable="true"][data-tab="3"]')
      .or(page.getByRole('textbox', { name: /search/i })).first();
    await search.click({ timeout: 10_000 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(wanted, { delay: 40 });
    await page.waitForTimeout(2000);
    const row = page.locator('#pane-side').getByTitle(exactly).first();
    if (!await row.count()) {
      return { ok: false, error: `nothing called "${wanted}" in the channels list or the chats` };
    }
    await row.click();
    await page.waitForTimeout(1800);
    const v = await composerNames(page, wanted);
    return v.ok ? { ok: true, how: `chat "${wanted}"` } : { ok: false, error: v.error };
  } catch (e) {
    return { ok: false, error: `could not reach "${wanted}" (${e.message.split('\n')[0]})` };
  }
}

/**
 * Type one message and send it.
 *
 * ENTER SENDS IN WHATSAPP, so a multi-line message cannot simply be typed: the
 * first newline would post a half-written listing. Every line is typed and
 * joined with Shift+Enter, and Enter is pressed exactly once, at the end.
 */
/**
 * Wait for WhatsApp to build the link preview.
 *
 * THIS IS WHY THE FIRST POSTS HAD NO CARD. WhatsApp fetches the URL and
 * renders the preview CLIENT-SIDE, into the composer, and it is not instant:
 * measured against the live client, the image appears at about five seconds —
 * while sendOne was pressing Enter after roughly one. The message went out
 * before the card existed, every time, and nothing about it looked wrong.
 *
 * Our own /api/og takes 1.1-2.4s to answer on top of whatever WhatsApp spends,
 * which is most of that five seconds.
 *
 * Returns whether it appeared. A post with no card still beats no post, so a
 * timeout sends anyway rather than dropping the listing.
 */
/**
 * Wait for the link preview to actually resolve, before Enter sends the message.
 *
 * WhatsApp builds the card CLIENT-SIDE, and a message sent before it lands goes
 * out as bare text — which on a channel of job listings is the difference
 * between the employer's OG card and a line of grey link.
 *
 * WATCH `compose-box-link-preview` FOR AN `img`, and nothing else. Two earlier
 * guesses were both wrong in ways that looked right:
 *
 *  - `footer img` never becomes non-zero AT ALL, so it timed out on every
 *    single post and reported no card while the card was sitting there.
 *  - The container's mere PRESENCE is not enough either. Measured on a real
 *    listing, it appears at t=1s holding only the bare domain ("interndoor.com")
 *    and does not fill in until t=3s, when the title, the description and the
 *    thumbnail arrive together. Sending on presence sends the skeleton, which
 *    attaches no card — the same outcome as not waiting.
 *
 * The `img` is the last thing to arrive, so it is the honest signal that the
 * card is complete.
 */
async function waitForPreview(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="compose-box-link-preview"]');
      return !!c && c.querySelectorAll('img').length > 0;
    });
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/** Is anything selected? Guards the Backspace in clearComposer. */
async function hasSelection(page) {
  return page.evaluate(() => (window.getSelection()?.toString() ?? '').length > 0);
}

/** Whatever is sitting in the composer right now. */
async function composerText(page) {
  const box = composer(page);
  if (!await box.count()) return '';
  return (await box.innerText()).trim();
}

/**
 * Empty the composer, and prove it is empty.
 *
 * THIS IS THE ONE THAT CORRUPTED A LIVE CHANNEL. `sendOne` used to click the
 * box and start typing, and a click puts the caret WHERE IT LANDS — so with
 * anything already in the box the new message is typed into the MIDDLE of it.
 * WhatsApp Web persists a draft, so a run that dies between typing and Enter
 * leaves one behind, and the next run splices its message into it. The post
 * that went out read
 *
 *   https://interndoor.com/jobs/joveo-softw🏢 Joveo … interndoor.com/are-engineer-intern-4458863278
 *
 * — the previous listing's URL cut at character 39 with a whole listing
 * inserted between the halves, and its own footer link welded to the tail. Two
 * unusable links in one message, on a public channel.
 *
 * Select-all is scoped to the focused contenteditable, so it cannot reach the
 * rest of the page. The read-back is not belt-and-braces: if the box will not
 * empty, typing into it produces exactly the spliced message above, and NOT
 * sending is unambiguously better than sending that.
 */
async function clearComposer(page) {
  const box = composer(page);
  await box.click({ timeout: 10_000 });
  if (!(await composerText(page))) return { ok: true };

  /* Select-all is tried three ways before giving up. The box is a
     framework-controlled contenteditable, so a single keystroke is not
     guaranteed to register, and this is not a place to find out by writing a
     spliced message to a public channel. Select-all is scoped to the focused
     element and cannot reach the rest of the page. */
  for (const combo of ['ControlOrMeta+A', 'Meta+A', 'Control+A']) {
    if (!(await composerText(page))) break;
    await box.click({ timeout: 10_000 });
    await page.keyboard.press(combo);
    /* Only delete if something is actually selected. A bare Backspace after a
       select-all that did not take deletes ONE CHARACTER — so three attempts
       silently ate three characters out of a draft this function had already
       failed to clear, turning "…joveo-software-engineer…" into
       "…joveo-softe-engineer…". Nothing is sent in that case, but mangling a
       box you could not clear is not a no-op, and the next run inherits it. */
    if (!(await hasSelection(page))) continue;
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);
  }

  const left = await composerText(page);
  if (left) return { ok: false, error: `composer would not clear — ${JSON.stringify(left.slice(0, 60))} still in it` };
  return { ok: true };
}

/**
 * Type one message and send it.
 *
 * ENTER SENDS IN WHATSAPP, so a multi-line message cannot simply be typed: the
 * first newline would post a half-written listing. Every line is typed and
 * joined with Shift+Enter, and Enter is pressed exactly once, at the end —
 * after the preview has had its chance.
 *
 * The box is CLEARED first and checked EMPTY afterwards. The clear stops a
 * stranded draft being spliced into (see clearComposer); the check afterwards
 * is how a failed send is noticed at all — Enter silently doing nothing leaves
 * the whole message sitting there, which is both a listing that never went out
 * and the draft that corrupts the next one. Either way the text is removed, so
 * a bad send costs one message instead of two.
 */
export async function sendOne(page, text, { previewMs = 15_000 } = {}) {
  const cleared = await clearComposer(page);
  if (!cleared.ok) return { sent: false, carded: false, error: cleared.error };

  const lines = String(text).split('\n');
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.type(line, { delay: 8 });
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }

  const carded = /https?:\/\//.test(text) ? await waitForPreview(page, previewMs) : true;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const leftover = await composerText(page);
  if (leftover) {
    /* Enter did not send. Clear it rather than leave a draft for the next
       message to be spliced into — the listing is lost either way, and a lost
       listing is recoverable where a corrupted channel post is not. */
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    return { sent: false, carded, error: 'Enter did not send — the message was still in the box afterwards' };
  }
  return { sent: true, carded };
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

  /* RESOLVE EACH ROW TO ITS PUBLISHED PROJECTION, exactly as postNewJobs does.
     What arrives here is a STORE row, where the column is `job_id` and `id` is
     undefined — and jobSlug used to answer that with slugify's 'role' fallback,
     so every link this sent read `.../jobs/harman-india-intern-role` and 404'd.
     The message composed, sent and looked perfect; only the link was dead, and
     with it the preview card, because WhatsApp cannot build one from a 404.
     Mapping through the published file is not just a way to get the id: it is
     what makes this function's documented promise true — a listing is only
     posted once a page is known to exist for it — and it hands the composer the
     same cleaned fields the job page shows, so a message cannot state something
     the site does not. */
  const indexes = new Map();
  const mine = [];
  for (const row of jobs ?? []) {
    const code = resolveRowRegion(row);
    if (!regions.has(code)) continue;
    if (!indexes.has(code)) indexes.set(code, publishedIndex(code));
    const pub = indexes.get(code).get(String(row.job_id ?? row.id));
    if (pub) mine.push({ job: pub, code });
  }
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

    let carded = 0;
    let tried = 0;
    for (const { job, code } of batch) {
      const r = await sendOne(page, composeWhatsApp(job, regionOf(code)));
      tried += 1;
      /* Only a send that was PROVEN to leave the box counts. It used to be
         counted unconditionally, so a listing that never went out was reported
         as posted — and the run that stranded it went on to corrupt the next
         message with the draft it left behind. */
      if (r.sent) { sent += 1; if (r.carded) carded += 1; }
      else log.warn(`WhatsApp: ${job.company ?? 'a listing'} was not posted — ${r.error}`);
      if (tried < batch.length) await sleep(gap);
    }
    const held = mine.length - batch.length;
    /* The card count is reported even when every one worked. A preview that
       silently stops appearing is invisible otherwise — which is exactly how
       the first posts went out bare — and the same reason the apply-link
       tripwire prints its ratio on every run. */
    log.ok(`WhatsApp: posted ${sent} to "${conf.target}" (${carded}/${sent} with a preview card)`
      + `${held ? ` — ${held} held for the next run` : ''}.`);
  } catch (err) {
    log.warn(`WhatsApp: ${err.message.split('\n')[0]} — ${sent} posted before it stopped.`);
  } finally {
    await ctx?.close().catch(() => {});
  }
  return { sent };
}
