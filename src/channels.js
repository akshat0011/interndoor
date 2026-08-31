/**
 * Every way a reader can follow one region's board.
 *
 * ONE PLACE THAT KNOWS, because the answer was previously spread across three
 * and two of them disagreed. `regions.js` hardcodes `telegram:
 * 'https://t.me/interndoor'` on EVERY region, so the US board's "Get alerts"
 * pill sent Americans to India's channel — verified live on 27 Aug — while
 * `notifications.telegram.channels` had said `@interndoorusa` since 25 Aug and
 * the POSTING half had been using it all along. The link and the thing it links
 * to have to come from the same fact.
 *
 * A REGION WITH NO CHANNEL GETS NO LINK, never another region's. That is the
 * rule Telegram posting already follows ("a region with no channel configured
 * gets no post") and the one reels follow ("a region absent from reels.accounts
 * gets no reel"), and it exists because sending somebody who asked about
 * internships in India to a feed of American roles is worse than offering them
 * nothing. GB has no Telegram channel and no Instagram account, so its alerts
 * page offers email only — which is honest, and is why email is the one channel
 * that is always there.
 *
 * Adding WhatsApp later is a config entry and nothing else.
 */

/** Email is not optional: it is the only channel the site itself owns. */
function emailChannel() {
  return {
    kind: 'email',
    name: 'Email',
    blurb: 'New internships in your inbox. One message, no spam.',
    url: null,          // rendered as the signup form, not a link
  };
}

export function telegramFor(code, cfg = {}) {
  const handle = cfg.notifications?.telegram?.channels?.[code];
  if (!handle) return null;
  const bare = String(handle).replace(/^@/, '').trim();
  return bare ? { handle: `@${bare}`, url: `https://t.me/${bare}` } : null;
}

export function instagramFor(code, cfg = {}) {
  const user = cfg.reels?.accounts?.[code];
  if (!user) return null;
  const bare = String(user).replace(/^@/, '').trim();
  return bare ? { handle: `@${bare}`, url: `https://www.instagram.com/${bare}/` } : null;
}

export function whatsappFor(code, cfg = {}) {
  const url = cfg.notifications?.whatsapp?.channels?.[code];
  return url ? { handle: 'WhatsApp channel', url: String(url) } : null;
}

/**
 * The channels this region actually has, best first.
 *
 * Email leads because it is the only one that survives a reader leaving a
 * messaging app, and the only one this site owns rather than rents.
 */
export function channelsFor(code, cfg = {}) {
  const region = String(code || '').toUpperCase();
  const out = [emailChannel()];

  /* WHATSAPP BEFORE TELEGRAM, where a region has both. Ordering here is a
     claim about which one a reader is most likely to already have open, not a
     ranking of the channels — and for the India board that is not close.
     A region with only Telegram is unaffected: this is an order, not a
     replacement, and nothing is hidden because something else exists. */
  const wa = whatsappFor(region, cfg);
  if (wa) {
    out.push({
      kind: 'whatsapp', name: 'WhatsApp', url: wa.url, handle: wa.handle,
      blurb: 'Every new role the moment it is listed.',
    });
  }

  const tg = telegramFor(region, cfg);
  if (tg) {
    out.push({
      kind: 'telegram', name: 'Telegram', url: tg.url, handle: tg.handle,
      blurb: wa
        ? 'The same feed, if you prefer Telegram.'
        : 'Every new role the moment it is listed.',
    });
  }

  const ig = instagramFor(region, cfg);
  if (ig) {
    out.push({
      kind: 'instagram', name: 'Instagram', url: ig.url, handle: ig.handle,
      blurb: 'Short reels on the roles worth knowing about.',
    });
  }

  return out;
}
