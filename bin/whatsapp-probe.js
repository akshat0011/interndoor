#!/usr/bin/env node
/**
 * What does WhatsApp Web actually look like right now?
 *
 *   npm run whatsapp-probe            -- report the session and find the target
 *   npm run whatsapp-probe -- --show  -- do it with the window visible
 *
 * WhatsApp Web's markup is undocumented and changes without notice, so every
 * selector in src/whatsapp.js is a guess with a shelf life. This prints what is
 * on the page so a broken send can be diagnosed by looking rather than by
 * editing selectors and hoping. It sends nothing.
 */
import { loadConfig } from '../src/config.js';
import { openWhatsApp, sessionState, findTarget } from '../src/whatsapp.js';

const cfg = loadConfig();
const show = process.argv.includes('--show');
const target = cfg.whatsapp?.target ?? 'InternDoor';

const { ctx, page } = await openWhatsApp({ headless: !show });
try {
  const s = await sessionState(page);
  console.log(`session: ${s.state}`);
  if (s.state !== 'ready') {
    console.log(s.state === 'needs-qr'
      ? 'Not linked. Run: npm run whatsapp-login'
      : `Could not tell. Page began: ${s.text ?? ''}`);
    process.exit(1);
  }

  const shape = await page.evaluate(() => ({
    chats: [...document.querySelectorAll('#pane-side [role="listitem"]')].length,
    tabs: [...document.querySelectorAll('[role="tab"], button[aria-label]')]
      .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
      .filter((t) => t && t.length < 40).slice(0, 18),
    searchBoxes: [...document.querySelectorAll('div[contenteditable="true"]')]
      .map((e) => e.getAttribute('data-tab') || '(no data-tab)'),
  }));
  console.log(`chats in the list: ${shape.chats}`);
  console.log(`contenteditable data-tabs: ${shape.searchBoxes.join(', ') || 'none'}`);
  console.log(`controls: ${shape.tabs.join(' | ')}`);

  console.log(`\nlooking for "${target}"…`);
  const found = await findTarget(page, target);
  console.log(found.ok ? `  found: ${found.how}` : `  NOT FOUND — ${found.error}`);
} finally {
  await ctx.close();
}
