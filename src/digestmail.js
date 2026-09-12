/**
 * The daily digest, drawn like the board.
 *
 * WHY THIS IS NOT THE MARKDOWN IT REPLACES. `src/digest.js` composed markdown
 * and let Buttondown's "modern" template render it, so the one email this site
 * sends looked like a default newsletter and nothing like the site it is
 * advertising. Every other surface here — the board, the OG card, the reel, the
 * LinkedIn card — carries the same dark ground, the same lime accent and the
 * same role-first card, and the mail was the only one that did not.
 *
 * EMAIL IS NOT THE WEB, AND EVERY DEPARTURE BELOW IS FORCED RATHER THAN
 * CHOSEN. Read this before "simplifying" any of it:
 *
 *  - **Tables, not flex or grid.** Outlook renders through Word, which knows
 *    neither. Every layout row here is a `<table role="presentation">` with
 *    `cellpadding=0 cellspacing=0 border=0` and a `width` ATTRIBUTE beside the
 *    CSS one, because Word reads the attribute and ignores the style.
 *  - **Inline styles, not a stylesheet.** Gmail strips `<style>` on some
 *    surfaces (notably the Android app rendering a forwarded message), so
 *    anything that must survive is inline. The `<style>` block carries only
 *    progressive extras: the web fonts and the mobile media query, both of
 *    which the design is legible without.
 *  - **NO SVG ANYWHERE.** Gmail, Outlook and Yahoo all refuse it. The masthead
 *    radar is `/email/radar.png`, rendered from the same geometry the site's
 *    inline SVG uses — see `scratchpad/radar.mjs`. That is also why the mark
 *    is baked on `#0a0a0b` rather than shipped transparent: a client that
 *    inverts the mail must not put a lime-on-nothing mark on white.
 *  - **The wordmark is LIVE TEXT, not part of that image.** Most clients block
 *    remote images until the reader allows them, and an all-image masthead
 *    leaves the top of the mail empty. Text keeps the brand legible with images
 *    off, and keeps its colour.
 *  - **`background-color` goes on `<td>`, never on a `<div>` a client might
 *    ignore**, and every nested table repeats the ground it sits on. A single
 *    background on the outer table alone leaves white gutters in Outlook.
 *
 * ROUNDED CORNERS DEGRADE TO SQUARE IN OUTLOOK AND THAT IS ACCEPTED. The
 * alternative is VML per card, which is a second layout to keep in step for a
 * client this audience barely uses.
 */
import { SITE, stipendText, durationText, modeText, jobSlug } from './pages.js';
import { utmUrl } from './postgen.js';
import { logoOnDisk } from './logos.js';
import { regionPath } from './regions.js';

/* ---- the site's own tokens, copied from web/public/styles.css -------------
   Copied rather than imported because a stylesheet cannot be read from Node
   at send time and email needs literal values inline anyway. THESE MUST BE
   KEPT IN STEP BY HAND — `test/digestmail.test.mjs` reads styles.css and fails
   if any of them drifts, which is the only thing making that safe. */
const C = {
  bg: '#0a0a0b',
  card: '#121214',
  card2: '#17171a',
  rule: '#222226',
  rule2: '#303036',
  ink: '#f2f2ec',
  ink2: '#9d9d94',
  ink3: '#82827a',
  live: '#c8ff00',
  liveInk: '#14170a',
};

/* Real stacks, not a bare family name. The Google Fonts import below reaches
   Apple Mail and iOS and almost nothing else, so the fallback is what most
   readers actually see and it has to be a deliberate choice rather than
   whatever the client defaults to. */
const F = {
  display: `Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif`,
  ui: `'Space Grotesk','Segoe UI',Helvetica,Arial,sans-serif`,
  mono: `'JetBrains Mono',Menlo,Consolas,monospace`,
};

const WIDTH = 600;

/**
 * How much HTML Gmail will show before it stops.
 *
 * **GMAIL CLIPS A MESSAGE OVER ABOUT 102KB** and replaces the tail with
 * "[Message clipped] View entire message" — so on a busy day the last third of
 * the digest, the board button and the unsubscribe link would all be behind a
 * click. Measured on the real corpus: the chrome is ~8.6KB and a card runs
 * ~5.3KB, so 25 cards (the markdown's cap) renders 130KB and clips.
 *
 * THE BUDGET IS IN BYTES AND NOT A CARD COUNT, because cards are not the same
 * size — one with four skills and two long bullets is half as big again as a
 * bare one, so any fixed count is either wasteful or occasionally over. Cards
 * are added while they fit and the remainder is counted, which the design
 * already has a line for.
 *
 * 92,000 leaves ~10KB under the threshold for the headers and the plain-text
 * alternative Buttondown generates, neither of which this function can see.
 */
const MAX_BYTES = 92_000;

/** HTML-escape. Employer names and titles come from LinkedIn and are not trusted. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** An href we are willing to put in front of a reader. `javascript:` survives escaping. */
function safeUrl(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? esc(raw) : '';
}

const boardUrlFor = (code, path = '/') => `${SITE}${regionPath(code)}${path}`;

/** One tagged link back to the site. Never used on an employer's own URL. */
function tagged(url, cfg, content) {
  return utmUrl(url, { campaign: 'digest', content, source: 'email', medium: 'email' }, cfg);
}

/**
 * A row of facts, the same four the board's card shows and in the same order.
 *
 * Imported, never re-implemented: `stipend` holds "₹0", "2,026" and
 * "AUD 2,018", and `duration` holds "0 to 3 years". Both the reel caption and
 * the OG card broke by guessing at these fields.
 */
function factsOf(row) {
  return [row.location, modeText(row), stipendText(row), durationText(row)].filter(Boolean);
}

/** `bullets` is an array on a hydrated row and a JSON string on a raw one. */
function bulletsOf(row, max) {
  let list = row.bullets;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).slice(0, max);
}

/** `keySkills` likewise. */
function skillsOf(row, max) {
  let list = row.keySkills ?? row.key_skills;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).filter(Boolean).slice(0, max);
}

/**
 * The employer's crest, or their initials.
 *
 * THE PLATE IS WHITE AND THE FIT IS `contain`-SHAPED, for the same reason §14
 * gives for both OG cards: 462 logo files in every shape there is, and cropping
 * a trademark is simply wrong. Email cannot do `object-fit`, so the plate is a
 * fixed box and the image is given a max width and height instead — which is
 * what `contain` means when the container cannot help.
 *
 * Initials are NOT a fallback for a blocked image — they are the fallback for
 * an employer with no logo file. A blocked image shows its `alt`, which is the
 * company name, and that is the better answer.
 */
function crest(company, size = 48) {
  const path = logoOnDisk(company);
  const initials = String(company ?? '').trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] ?? '').join('').toUpperCase() || '?';
  const box = `width="${size}" height="${size}"`;
  if (!path) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ${box}`
      + ` style="width:${size}px;height:${size}px;background:${C.card2};border-radius:8px">`
      + `<tr><td align="center" valign="middle"`
      + ` style="font-family:${F.mono};font-size:15px;font-weight:700;color:${C.ink2};`
      + `text-align:center;vertical-align:middle">${esc(initials)}</td></tr></table>`;
  }
  const inner = size - 8;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ${box}`
    + ` style="width:${size}px;height:${size}px;background:#ffffff;border-radius:8px">`
    + `<tr><td align="center" valign="middle" style="padding:4px;text-align:center;vertical-align:middle">`
    + `<img src="${SITE}${path}" alt="${esc(company)}" width="${inner}"`
    + ` style="display:block;margin:0 auto;max-width:${inner}px;max-height:${inner}px;`
    + `width:auto;height:auto;border:0;outline:none;text-decoration:none"></td></tr></table>`;
}

/** A skill chip, matching the board's `.skill`. */
function chip(text) {
  return `<span style="display:inline-block;background:${C.card2};border:1px solid ${C.rule};`
    + `border-radius:999px;padding:3px 9px;margin:0 5px 5px 0;`
    + `font-family:${F.mono};font-size:11px;letter-spacing:.02em;color:${C.ink2};`
    + `white-space:nowrap">${esc(text)}</span>`;
}

/**
 * One role, as a card.
 *
 * ROLE FIRST, EMPLOYER AS AN EYEBROW — §15's rule, and the opposite of the
 * Telegram message, which leads with the company because a channel is a feed of
 * single messages. A digest is a LIST, so it is scanned the way the board is.
 */
function card(row, cfg, code, { bullets: maxBullets = 2, skills: maxSkills = 4 } = {}) {
  const url = tagged(boardUrlFor(code, `/jobs/${jobSlug(row)}`), cfg, 'role');
  const facts = factsOf(row);
  const bullets = bulletsOf(row, maxBullets);
  const skills = skillsOf(row, maxSkills);
  const href = safeUrl(url);

  const factsRow = facts.length
    ? `<tr><td style="padding:6px 0 0;font-family:${F.ui};font-size:13px;line-height:1.5;color:${C.ink2}">`
      + facts.map(esc).join(' <span style="color:' + C.ink3 + '">·</span> ')
      + `</td></tr>`
    : '';

  const skillsRow = skills.length
    ? `<tr><td style="padding:10px 0 0">${skills.map(chip).join('')}</td></tr>`
    : '';

  /* A list, not a paragraph — and drawn with a lime marker in a fixed-width
     cell rather than a <ul>, because Outlook's list indentation is its own
     invention and cannot be reset. */
  const bulletRows = bullets.length
    ? `<tr><td style="padding:10px 0 0">`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">`
      + bullets.map((b) => `<tr>`
        + `<td width="14" valign="top" style="width:14px;padding:0 0 5px;`
        + `font-family:${F.ui};font-size:13px;line-height:1.55;color:${C.live}">&#9656;</td>`
        + `<td valign="top" style="padding:0 0 5px;font-family:${F.ui};font-size:13px;`
        + `line-height:1.55;color:${C.ink2}">${esc(b)}</td></tr>`).join('')
      + `</table></td></tr>`
    : '';

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="width:100%;background:${C.card};border:1px solid ${C.rule};border-radius:10px;margin:0 0 12px">
  <tr><td style="padding:16px 18px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="48" valign="top" style="width:48px;padding:0 12px 0 0">${crest(row.company)}</td>
        <td valign="top">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="font-family:${F.mono};font-size:11px;letter-spacing:.07em;
                           text-transform:uppercase;color:${C.ink2};padding:0 0 3px">${esc(row.company)}</td></tr>
            <tr><td style="font-family:${F.ui};font-size:17px;line-height:1.3;font-weight:700;
                           letter-spacing:-.015em;color:${C.ink}">${
              href ? `<a href="${href}" style="color:${C.ink};text-decoration:none">${esc(row.title)}</a>`
                   : esc(row.title)}</td></tr>
            ${factsRow}
            ${skillsRow}
            ${bulletRows}
          </table>
        </td>
      </tr>
    </table>
  </td></tr>
  ${href ? `<tr><td style="padding:0 18px 16px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:${C.live};border-radius:999px">
        <a href="${href}" style="display:inline-block;padding:8px 18px;font-family:${F.ui};
           font-size:13px;font-weight:700;letter-spacing:.01em;color:${C.liveInk};
           text-decoration:none">See the role &rarr;</a>
      </td></tr>
    </table>
  </td></tr>` : ''}
</table>`;
}

/**
 * The whole email.
 *
 * `roles` is already filtered, sorted and capped by `buildDigest` — this
 * function decides nothing about WHICH postings appear, only how they look.
 */
function page(cardsHtml, { cfg, region, code, n, rest, now }) {
  const boardUrl = safeUrl(tagged(boardUrlFor(code), cfg, 'board'));
  const alertsUrl = safeUrl(tagged(boardUrlFor(code, '/alerts'), cfg, 'alerts'));
  const contactUrl = safeUrl(tagged(`${SITE}/contact`, cfg, 'contact'));
  const plural = n === 1 ? '' : 's';
  const where = region.inName;

  const date = new Date(now).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: region.timeZone,
  });

  /* THE PREHEADER IS THE LINE THE INBOX SHOWS BESIDE THE SUBJECT, and without
     one every client invents it from the first text in the body — which here
     would be the date. Hidden by three properties because no single one works
     everywhere, then padded with zero-width spaces so the client cannot pull
     the following content up into the preview. */
  const preheader = `${n} new engineering internship${plural} ${where}, newest first.`;

  return `<!doctype html>
<html lang="${esc(region.hreflang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(`${n} new engineering internship${plural} ${where}`)}</title>
<style>
  /* PROGRESSIVE ONLY. Everything the design needs is inline; this block adds
     the site's fonts where a client supports them and narrows the layout on a
     phone. A client that drops it renders the mail correctly in fallback type. */
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
  body { margin: 0; padding: 0; width: 100% !important; background: ${C.bg}; }
  a { text-decoration: none; }
  /* Gmail and Outlook.com both underline and recolour anything that looks like
     a date, an address or a phone number, in blue, on a dark ground. */
  a[x-apple-data-detectors], .unstyle-auto-detected-links a, .aBn {
    color: inherit !important; text-decoration: none !important; font-size: inherit !important;
  }
  @media only screen and (max-width: 620px) {
    .wrap { width: 100% !important; }
    .pad { padding-left: 16px !important; padding-right: 16px !important; }
    .hero { font-size: 27px !important; line-height: 1.08 !important; }
    /* The date crowds the wordmark on a phone and is the least useful thing in
       the masthead — the mail arrives dated. Hidden with display:none rather
       than the preheader's three-property trick, because here it genuinely
       should not be read out either. */
    .stamp { display: none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">
  ${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="width:100%;background:${C.bg}">
  <tr><td align="center" style="padding:0">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${WIDTH}" class="wrap"
           style="width:${WIDTH}px;max-width:${WIDTH}px;background:${C.bg}">

      <!-- masthead: the radar as a PNG, the wordmark as live text -->
      <tr><td class="pad" style="padding:26px 24px 18px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td valign="middle" style="vertical-align:middle">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="30" valign="middle" style="width:30px;padding:0 9px 0 0;vertical-align:middle">
                    <img src="${SITE}/email/radar.png" alt="" width="30" height="30"
                         style="display:block;width:30px;height:30px;border:0;outline:none">
                  </td>
                  <td valign="middle" style="vertical-align:middle;font-family:${F.display};
                      font-size:19px;font-weight:900;letter-spacing:-.02em;color:${C.ink}">INTERN<span
                      style="color:${C.live}">DOOR</span></td>
                </tr>
              </table>
            </td>
            <td align="right" valign="middle" class="stamp" style="text-align:right;vertical-align:middle;
                font-family:${F.mono};font-size:11px;letter-spacing:.06em;text-transform:uppercase;
                color:${C.ink3}">${esc(date)}</td>
          </tr>
        </table>
      </td></tr>

      <tr><td class="pad" style="padding:0 24px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="height:1px;background:${C.rule};font-size:0;line-height:0">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- the count leads, exactly as the subject and the weekly roundup do -->
      <tr><td class="pad" style="padding:24px 24px 4px">
        <div class="hero" style="font-family:${F.display};font-size:34px;line-height:1.04;
             font-weight:900;letter-spacing:-.035em;color:${C.ink};margin:0">
          ${n} new engineering<br>internship${plural}
        </div>
      </td></tr>
      <tr><td class="pad" style="padding:8px 24px 20px;font-family:${F.ui};font-size:15px;
          line-height:1.55;color:${C.ink2}">
        ${esc(where.replace(/^in /, 'In '))}, since yesterday. Newest first &mdash; the queue is
        shortest right now.
      </td></tr>

      <tr><td class="pad" style="padding:0 24px">
        ${cardsHtml}
      </td></tr>

      ${rest > 0 ? `<tr><td class="pad" style="padding:4px 24px 0;font-family:${F.ui};
        font-size:14px;line-height:1.55;color:${C.ink2}">
        &mdash; and ${rest} more on the board.</td></tr>` : ''}

      <!-- the closing invitation, the same one foot() makes on the site -->
      <tr><td class="pad" align="center" style="padding:22px 24px 6px;text-align:center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
          <tr><td style="background:${C.live};border-radius:999px">
            <a href="${boardUrl}" style="display:inline-block;padding:12px 26px;font-family:${F.ui};
               font-size:15px;font-weight:700;color:${C.liveInk};text-decoration:none">Browse
               all live internships</a>
          </td></tr>
        </table>
      </td></tr>

      <tr><td class="pad" style="padding:28px 24px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="height:1px;background:${C.rule};font-size:0;line-height:0">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- the site's own disclaimer, verbatim, because it must stay true here too -->
      <tr><td class="pad" style="padding:16px 24px 8px;font-family:${F.ui};font-size:12px;
          line-height:1.6;color:${C.ink3}">
        Every listing links back to its original posting &mdash; always apply there. Summaries are
        written by InternDoor; the linked posting is the source of truth.
      </td></tr>
      <tr><td class="pad" style="padding:0 24px 30px;font-family:${F.ui};font-size:12px;
          line-height:1.7;color:${C.ink3}">
        <a href="${boardUrl}" style="color:${C.ink2};text-decoration:underline">The board</a>
        &nbsp;&middot;&nbsp;
        <a href="${alertsUrl}" style="color:${C.ink2};text-decoration:underline">Other channels</a>
        &nbsp;&middot;&nbsp;
        <a href="${contactUrl}" style="color:${C.ink2};text-decoration:underline">Contact</a>
        &nbsp;&middot;&nbsp;
        <a href="{{ unsubscribe_url }}" style="color:${C.ink2};text-decoration:underline">Unsubscribe</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * The whole email, with as many cards as Gmail will show.
 *
 * `roles` is already filtered, sorted and capped by `buildDigest` — this
 * function decides nothing about WHICH postings appear, only how many fit and
 * how they look. `total` is the true count of eligible roles, so the "and N
 * more" line stays honest whichever of the two caps bites.
 *
 * THE CHROME IS MEASURED, NOT ASSUMED. Rendering the page once with no cards
 * gives its exact byte cost, so editing the masthead or the footer cannot
 * silently push a full digest over the threshold — the budget absorbs it by
 * showing one card fewer.
 */
export function renderDigestEmail(roles, cfg, { region, code, total = null, now = Date.now() } = {}) {
  const n = total ?? roles.length;
  const opts = { cfg, region, code, n, rest: 0, now };
  const chrome = Buffer.byteLength(page('', { ...opts, rest: n }), 'utf8');

  const kept = [];
  let used = chrome;
  for (const row of roles) {
    const html = card(row, cfg, code);
    const size = Buffer.byteLength(html, 'utf8');
    /* The first card is always kept: a digest with no listing in it is not a
       digest, and one enormous posting should still be sent rather than
       silently becoming an empty mail. */
    if (kept.length && used + size > MAX_BYTES) break;
    kept.push(html);
    used += size;
  }

  const rest = Math.max(0, n - kept.length);
  return page(kept.join(''), { ...opts, rest });
}
