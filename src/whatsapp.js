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
/* How long the nav is given to hydrate, and how long the channels list is given
   to paint. BOTH ARE MEASURED, not guessed (2 Sep 2026, three cold opens):

     session ready   10.3s · 11.7s · 12.4s
     Channels button +50ms after ready, every time
     the channel row  203ms · 433ms · 399ms after the click

   So the row is fast and the HYDRATION is slow, which is the opposite of what
   the fixed 2500ms sleep this replaces assumed. The nav budget is generous
   because the send runs at the END of a scan, on a machine that has just spent
   twelve minutes driving a second browser — which is exactly when the app takes
   longest to become interactive, and exactly when this failed. */
const CHANNELS_NAV_MS = 20_000;
/* THE CHANNEL ROW WAITED 8s AND THE NAV WAITED 20s, WHICH IS BACKWARDS.
   `sessionState` reports ready as soon as `#pane-side` exists, well before the
   app is interactive, and this send runs at the END of a scan when the machine
   is loaded — so both waits are taken under the worst conditions of the run.
   The row measures 203-433ms after the click on a warm app, but 4 of 11 recent
   failures were "no channel called Interndoor appeared within 8s". A wait that
   is generous costs nothing when the row is already there; a wait that is tight
   loses the whole run's listings. Matched to the nav. */
const CHANNEL_ROW_MS = 20_000;

export async function findTarget(page, name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return { ok: false, error: 'no target name configured' };
  const exactly = new RegExp(`^${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  /* WHY EVERY STAGE IS RECORDED. This function failed once on 2 Sep 2026 with
     `nothing called "Interndoor" in the channels list or the chats`, and that
     one sentence was reachable from four different causes — the Channels button
     being absent, the click throwing, the row never appearing, or the composer
     refusing to confirm the name — because the channels branch fell through
     silently on all four. The message named both surfaces while only one had
     actually been tried. A failure that cannot say which stage it was is one
     nobody can fix afterwards. */
  const tried = [];

  // --- the channels surface -------------------------------------------------
  let channelsBtn = page.getByRole('button', { name: /^channels$/i }).first();
  try {
    /* WAIT FOR THE NAV, do not sample it. `sessionState` reports ready as soon
       as #pane-side exists, and that container is present well before the app
       is interactive — so a single count() here reads 0 on a slow open and
       skips the ONLY surface a channel can be found on. The fallback below
       cannot rescue that: a channel is not in the chat list at all (measured —
       `#pane-side [role="listitem"]` is 0 even while the channel row is on
       screen), so falling through is falling into a dead end. */
    await channelsBtn.waitFor({ state: 'visible', timeout: CHANNELS_NAV_MS });
  } catch {
    channelsBtn = null;
    tried.push(`the Channels button never appeared in ${CHANNELS_NAV_MS / 1000}s`);
  }

  if (channelsBtn) {
    try {
      await channelsBtn.click();
      const row = page.getByTitle(exactly).first();
      try {
        await row.waitFor({ state: 'visible', timeout: CHANNEL_ROW_MS });
      } catch {
        tried.push(`no channel called "${wanted}" appeared within ${CHANNEL_ROW_MS / 1000}s`);
      }
      if (await row.count()) {
        await row.click();
        await page.waitForTimeout(2500);
        const v = await composerNames(page, wanted);
        if (v.ok) return { ok: true, how: `channel "${wanted}"` };
        tried.push(`the channel opened but ${v.error}`);
      }
    } catch (e) {
      tried.push(`the channels list failed (${e.message.split('\n')[0]})`);
    }
  }

  // --- the chat list --------------------------------------------------------
  /* Kept because a GROUP may legitimately carry the same name, which is the
     shape this ran as before the channel existed. It can never find a channel. */
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
      tried.push(`no chat called "${wanted}" in the chat list`);
      return { ok: false, error: tried.join('; ') };
    }
    await row.click();
    await page.waitForTimeout(1800);
    const v = await composerNames(page, wanted);
    if (v.ok) return { ok: true, how: `chat "${wanted}"` };
    tried.push(`the chat opened but ${v.error}`);
    return { ok: false, error: tried.join('; ') };
  } catch (e) {
    tried.push(`the chat search failed (${e.message.split('\n')[0]})`);
    return { ok: false, error: tried.join('; ') };
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
/** Where a region's unposted backlog lives between runs. */
export const pendingKey = (code) => `whatsappPending:${code}`;

/** How many ids a region's backlog may carry before the oldest are dropped. */
export const MAX_PENDING = 60;

/**
 * Which ids still need posting, oldest first.
 *
 * NOTHING HERE IS RETRIED TODAY AND THAT IS THE BUG. This function is handed
 * one scan's new rows; a run whose WhatsApp attempt fails — a locked profile, a
 * channel row that did not render, a composer that never appeared — drops those
 * listings for ever. 11 of 28 recent attempts failed that way, so roughly a
 * third of the India board never reached the channel, while Telegram carried
 * every one of them because it is an HTTP call with no browser to go wrong.
 * Telegram was given a retry after losing 100 listings in three days (§12);
 * this is the same fix, one layer up.
 *
 * It also makes the "N held for the next run" line true. Anything over
 * `maxPerRun` was reported as held and then silently discarded, because the
 * next run only ever received its OWN new rows.
 *
 * Self-cleaning: a pending id is resolved through `publishedIndex`, so a
 * posting that has since left the board simply fails to resolve and falls out.
 * No expiry logic, and no chance of announcing a page that 404s.
 */
export function readPending(store, code) {
  try {
    const raw = store?.getSetting?.(pendingKey(code));
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch { return []; }
}

/** Replace a region's backlog, newest dropped first when it overflows. */
export function writePending(store, code, ids) {
  try {
    const uniq = [...new Set((ids ?? []).map(String))];
    store?.setSetting?.(pendingKey(code), JSON.stringify(uniq.slice(0, MAX_PENDING)));
  } catch { /* a backlog that cannot be saved must not fail the run */ }
}

export async function postNewJobsWhatsApp(jobs, cfg, { store = null } = {}) {
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
  const indexFor = (code) => {
    if (!indexes.has(code)) indexes.set(code, publishedIndex(code));
    return indexes.get(code);
  };

  /* THE BACKLOG GOES FIRST. A listing that failed to send yesterday is older
     than one found this minute, and the whole point of keeping it is that it
     stops being lost — so it is not made to queue behind fresh arrivals. */
  const mine = [];
  const seen = new Set();
  for (const code of regions) {
    for (const id of readPending(store, code)) {
      const pub = indexFor(code).get(String(id));
      if (pub && !seen.has(String(id))) { seen.add(String(id)); mine.push({ job: pub, code, id: String(id) }); }
    }
  }
  for (const row of jobs ?? []) {
    const code = resolveRowRegion(row);
    if (!regions.has(code)) continue;
    const id = String(row.job_id ?? row.id);
    const pub = indexFor(code).get(id);
    if (pub && !seen.has(id)) { seen.add(id); mine.push({ job: pub, code, id }); }
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
  /* EVERY EXIT PATH SAVES WHAT DID NOT GO OUT, which is why this is computed in
     `finally` rather than at the end of the happy path. The failures that lose
     listings are exactly the early returns — an unlinked session, a channel row
     that never rendered — plus the catch, where the browser died mid-batch. */
  const posted = new Set();
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
    for (const { job, code, id } of batch) {
      const r = await sendOne(page, composeWhatsApp(job, regionOf(code)));
      tried += 1;
      /* Only a send that was PROVEN to leave the box counts. It used to be
         counted unconditionally, so a listing that never went out was reported
         as posted — and the run that stranded it went on to corrupt the next
         message with the draft it left behind. */
      if (r.sent) { sent += 1; posted.add(id); if (r.carded) carded += 1; }
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
    /* Anything not proven to have left the composer goes back on the queue —
       over the cap, refused, or never attempted because the run fell over
       before it got there. Written per region, oldest first, so the next run
       picks them up ahead of its own new rows. */
    const left = mine.filter((m) => !posted.has(m.id));
    for (const code of regions) writePending(store, code, left.filter((m) => m.code === code).map((m) => m.id));
    if (left.length) log.info(`WhatsApp: ${left.length} listing(s) queued for the next run.`);
  }
  return { sent };
}
