/**
 * The voiceover script for a Format A reel.
 *
 * EVERY WORD IS DERIVED FROM A STORED FACT. No model writes this. That is
 * deliberate and it is the same rule groundPost() enforces in postgen.js:
 * these reels go out under the InternDoor name next to "apply here", and an
 * invented stipend sends a student to an application they are not eligible
 * for. When the ideate stage lands, a model may propose a HOOK — it still
 * has to survive grounding against these same fields.
 *
 * The script is also written to match the card, scene for scene: hook,
 * company and role, then the call to action. The VO and the picture must say
 * the same thing at the same moment or the reel reads as dubbed.
 */

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0-99 in words. */
function small(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

/**
 * An amount in words, on the Indian scale.
 *
 * Digits are spelled out because the TTS reads "20,000" unreliably — it can
 * come out as "twenty comma zero zero zero". Words cannot be misread, and
 * this is the single most important number in the reel.
 */
export function amountInWords(n) {
  n = Math.round(Number(n) || 0);
  if (n <= 0) return '';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  if (crore) { parts.push(`${small(crore)} crore`); n %= 10000000; }
  const lakh = Math.floor(n / 100000);
  if (lakh) { parts.push(`${small(lakh)} lakh`); n %= 100000; }
  const thousand = Math.floor(n / 1000);
  if (thousand) { parts.push(`${small(thousand)} thousand`); n %= 1000; }
  const hundred = Math.floor(n / 100);
  if (hundred) { parts.push(`${small(hundred)} hundred`); n %= 100; }
  if (n) parts.push(small(n));
  return parts.join(' ');
}

/** "a month" reads better than "per month" in speech. */
function per(period) {
  if (!period) return '';
  return period === 'year' ? ' a year' : period === 'week' ? ' a week' : ' a month';
}

/** Titles carry punctuation and parentheses that a voice should not read. */
function speakable(title) {
  return String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[_|/\\]+/g, ' ')
    .replace(/\s*[-–—:,]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the lines. Returns an array so a future version can synthesise each
 * beat separately and land the cuts on the pauses, the way storygasted does.
 * Joined with a space it is the whole script.
 *
 * Kept to roughly 26 words: measured through Qwen3-TTS at the tempo the
 * renderer applies, that lands near 11 seconds, which is the reel length the
 * card is proportioned for.
 */
export function reelScript(d, { site = 'InternDoor dot com' } = {}) {
  const lines = [];
  const role = speakable(d.title);
  const where = d.city ? ` in ${d.city}` : '';

  if (d.stipendText && d.stipendAmount) {
    lines.push(`${amountInWords(d.stipendAmount)} rupees${per(d.stipendPeriod)}.`);
    lines.push(`${d.company} is hiring a ${role}${where}.`);
  } else if (d.zeroApplicants) {
    lines.push(`Nobody has applied to this one yet.`);
    lines.push(`${d.company} just posted a ${role}${where}.`);
  } else {
    lines.push(`${d.company} is hiring interns${where}.`);
    lines.push(`They are looking for a ${role}.`);
  }

  /* Urgency only when the number supports it. An applicant count is stored
     for about half of India rows, and inventing scarcity is the fastest way
     to lose the audience this is meant to build. */
  const n = Number(d.applicantsCount);
  if (Number.isFinite(n) && n > 0 && n <= 60) {
    lines.push(`Only ${small(n)} people have applied so far.`);
  } else if (d.zeroApplicants) {
    lines.push(`You would be first in the queue.`);
  }

  lines.push(`Find it on ${site}.`);
  return lines;
}

export function scriptText(d, opts) {
  return reelScript(d, opts).join(' ');
}
