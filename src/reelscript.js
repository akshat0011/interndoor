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
  const role = roleOnly(d.title);
  const where = d.city ? ` in ${d.city}` : '';
  const n = Number(d.applicantsCount);

  /* "…hiring an intern, and the role is X" RATHER THAN "…hiring an Intern X".
   *
   * The title runs straight into the generic word before it — "hiring an Intern
   * Embedded System" — and a listener cannot hear where the job description
   * starts. Naming the role in its own clause gives the comma a job to do: it
   * is the one beat the sentence wants, right before the thing somebody is
   * deciding on.
   *
   * It also stops the caption cutting the role in half, because the clause
   * boundary is now where the cue break wants to be anyway.
   *
   * ONE SENTENCE UNTIL THE CTA. Every full stop is a pause the model inserts,
   * and four of them was what "reading a paragraph and stopping in between"
   * sounded like. Clauses are joined with a comma and a conjunction instead: a
   * comma is a breath, a full stop is a stop, and the model treats them
   * differently. Contractions for the same reason.
   */
  /* "Baxter International Inc." puts a full stop in the middle of the
     sentence, and the model pauses on it exactly as it would on a real one.
     The abbreviation reads the same without it. */
  const company = String(d.company ?? '').replace(/\.+$/, '').trim();

  const head = d.stipendText && d.stipendAmount
    ? `${company} is paying ${amountInWords(d.stipendAmount)} rupees${per(d.stipendPeriod)} for an intern${where}`
    : `${company} is hiring an intern${where}`;

  const parts = [head];
  if (role) parts.push(`and the role is ${role}`);

  /* Urgency only when the number supports it. An applicant count is stored for
     about half of India rows, and inventing scarcity is the fastest way to
     lose the audience this is meant to build. */
  if (d.zeroApplicants) {
    parts.push(`and nobody's applied yet`);
  } else if (Number.isFinite(n) && n > 0 && n <= 60) {
    parts.push(`and only ${small(n)} people have applied so far`);
  }

  /* ONE BEAT PER CLAUSE, not one beat per sentence.
   *
   * bin/render-reel.js synthesises each entry separately and joins them with a
   * pause it chooses. A 22-word beat is still long enough for the model's
   * pacing to wander inside it — measured: 0.96s of silence after "only",
   * mid-phrase, in a line that had no punctuation there. Short beats do not
   * give it room to.
   *
   * The trailing comma is kept on every clause but the last: it tells the model
   * the phrase is not finished, and it is what src/reelcaptions.js reads to
   * break a cue on a clause rather than on a word count.
   */
  const clauses = parts.map((part, i) => (i < parts.length - 1 ? `${part},` : `${part}.`));
  return [...clauses, `Find it on ${site}.`];
}

/**
 * The role, with the generic internship words taken off the front and back.
 *
 * The sentence already says "an intern", so "the role is Intern Embedded
 * System" says it twice. Titles carry it in every position — "Intern -
 * Embedded System", "Zoho CRM Developer Intern", "Graduate Engineer Trainee" —
 * so both ends are trimmed.
 *
 * If trimming leaves nothing the title WAS the generic word, and the whole
 * clause is dropped rather than saying "the role is" and trailing off.
 */
function roleOnly(title) {
  const words = /** @type {string} */ (speakable(title)).split(' ').filter(Boolean);
  /* Only the words that are REDUNDANT with "an intern", and only where they
     are decoration rather than part of the name. "Trainee" and "apprentice"
     are kept: "Young Graduate Trainee" is the whole role, and trimming it left
     "the role is Young Graduate", which is not a job. "Intern - Embedded
     System" and "Zoho CRM Developer Intern" are the shapes worth trimming. */
  const redundant = /^(intern|interns|internship|internships)$/i;
  const trailingNoise = /^(job|jobs|opportunity|role|position|intern|interns|internship|internships)$/i;
  while (words.length && redundant.test(words[0])) words.shift();
  while (words.length && trailingNoise.test(words[words.length - 1])) words.pop();
  return words.join(' ');
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
