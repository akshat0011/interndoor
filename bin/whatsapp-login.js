#!/usr/bin/env node
/**
 * Log the broadcast number into WhatsApp Web, once.
 *
 *   npm run whatsapp-login
 *
 * Opens Brave on the profile at PATHS.whatsappProfile — NOT the scraper's, and
 * not his personal one — shows the QR, and waits while he scans it from the
 * throwaway phone. The session then lives in that directory and every later
 * send reuses it headlessly.
 *
 * It stays open for a while on purpose: a QR that expires while somebody finds
 * their phone is the whole reason this is a command rather than a step buried
 * inside the first send.
 */
import { openWhatsApp, sessionState } from '../src/whatsapp.js';
import { PATHS } from '../src/paths.js';

/* Long, and a flag can make it longer. The first version waited five minutes
   and timed out with nothing saved, which is the wrong failure for a step that
   needs a phone in someone's hand — the QR refreshes itself, so waiting costs
   nothing but an open window. */
const argMin = Number((process.argv.find((a) => a.startsWith('--minutes=')) ?? '').split('=')[1]);
const WAIT_MS = (Number.isFinite(argMin) && argMin > 0 ? argMin : 20) * 60_000;

const { ctx, page } = await openWhatsApp({ headless: false });
console.log(`profile: ${PATHS.whatsappProfile}`);

let s = await sessionState(page, { timeoutMs: 60_000 });
if (s.state === 'ready') {
  console.log('Already logged in — nothing to do. This profile has a live session.');
  await ctx.close();
  process.exit(0);
}
if (s.state !== 'needs-qr') {
  console.log(`Could not tell what WhatsApp is showing (${s.state}). Look at the window.`);
  console.log(`page said: ${s.text ?? ''}`);
}

console.log('\nScan the QR in the Brave window with the broadcast number:');
console.log('  WhatsApp → Settings → Linked devices → Link a device\n');
console.log('Waiting up to 5 minutes…');

const deadline = Date.now() + WAIT_MS;
let announced = 0;
while (Date.now() < deadline) {
  /* sessionState answers IMMEDIATELY while a QR is on screen, so without this
     sleep the loop spins on page.evaluate for the whole wait. */
  await page.waitForTimeout(3000);
  const left = Math.round((deadline - Date.now()) / 60_000);
  if (left !== announced) { announced = left; process.stdout.write(`  …still waiting, ${left} min left\n`); }
  const now = await sessionState(page, { timeoutMs: 4000 });
  if (now.state === 'ready') {
    console.log('\nLinked. The session is saved in this profile and survives restarts.');
    // A moment for WhatsApp to finish writing its IndexedDB before the context
    // closes, or the next run finds a half-written session and asks for the QR
    // again.
    await page.waitForTimeout(6000);
    await ctx.close();
    process.exit(0);
  }
}
console.log('\nTimed out — nothing was saved. Re-run: npm run whatsapp-login -- --minutes=30');
await ctx.close();
process.exit(1);
