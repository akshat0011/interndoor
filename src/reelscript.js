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
  const role = speakable(d.title);
  const where = d.city ? ` in ${d.city}` : '';
  const n = Number(d.applicantsCount);

  /* ONE SENTENCE UNTIL THE CTA, NOT FOUR.
   *
   * Every full stop is a pause the model inserts, and four of them in twenty
   * seconds is what "reading a paragraph and stopping in between" sounds like.
   * The first version pushed four separate sentences joined with a space, so
   * the voice halted four times in a reel whose whole job is to hold somebody
   * for fifteen seconds.
   *
   * Clauses are joined with a comma and a conjunction instead. A comma is a
   * breath; a full stop is a stop, and the model treats them differently.
   * Contractions ("nobody's", "you'd") for the same reason — the expanded
   * forms read as written English rather than as speech.
   *
   * Each branch is punctuated by hand rather than through a generic joiner. A
   * rule that inserted a comma before every clause produced "twenty thousand
   * rupees a month, for a Back End Developer", which is a breath in the middle
   * of a prepositional phrase — exactly the halt being removed.
   *
   * THE CTA KEEPS ITS OWN SENTENCE. It is the one line that should land
   * separately, and the single pause before it is the only one worth having.
   */
  let head;
  if (d.stipendText && d.stipendAmount) {
    head = `${d.company} is paying ${amountInWords(d.stipendAmount)} rupees${per(d.stipendPeriod)} for ${article(role)} ${role}${where}`;
  } else if (d.zeroApplicants) {
    head = `${d.company} just posted ${article(role)} ${role}${where} and nobody's applied yet`;
  } else {
    head = `${d.company} is hiring ${article(role)} ${role}${where}`;
  }

  /* Urgency only when the number supports it. An applicant count is stored for
     about half of India rows, and inventing scarcity is the fastest way to
     lose the audience this is meant to build. */
  if (Number.isFinite(n) && n > 0 && n <= 60) {
    head += `, and only ${small(n)} people have applied so far`;
  } else if (d.zeroApplicants) {
    head += `, so you'd be first in the queue`;
  }

  /* Still an array: bin/render-reel.js aligns against the whole text, and a
     future version may synthesise each beat separately and land the cuts on
     the pauses the way storygasted does. */
  return [`${head}.`, `Find it on ${site}.`];
}

/**
 * "a" or "an".
 *
 * Spoken, not written: the model says the article it is given, so "a Intern
 * Embedded System" is heard as a stumble. Decided on the SOUND of the first
 * letter, which is why the vowel test is not enough on its own — "an SDE" is
 * right because the letter is said "ess", and "a UX" is right because "you"
 * starts with a consonant sound.
 */
function article(next) {
  const w = String(next || '').trim();
  if (!w) return 'a';
  const first = w[0].toUpperCase();
  /* A leading capital that is read letter by letter: SDE, ML, R&D, FPGA. */
  if (/^[A-Z]{2,}\b/.test(w)) return 'AEFHILMNORSX'.includes(first) ? 'an' : 'a';
  if (/^[uU](?:ni|se|ser|x|i)/.test(w)) return 'a';        // "university", "UX" -> "you"
  return /^[aeiouAEIOU]/.test(w) ? 'an' : 'a';
}

export function scriptText(d, opts) {
  return reelScript(d, opts).join(' ');
}
