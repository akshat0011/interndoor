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
  if (d.format === 'D') return formatD(d, { role, where, site });

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
 * FORMAT D — "hidden opportunity".
 *
 * THE EMPLOYER IS WITHHELD UNTIL THE SECOND CLAUSE. That is the format: the
 * scarcity is the hook and the company is the reveal, so naming it first
 * leaves nothing to reveal. The card puts its scenes in the same order for the
 * same reason, and the VO and the picture have to agree or the reel reads as
 * dubbed.
 *
 * "WHEN WE LISTED IT" IS NOT A HEDGE, IT IS THE ONLY TRUE TENSE. `applicants`
 * is frozen at scrape time and nothing refreshes it, so "nobody has applied"
 * is a claim about now that we cannot make — the same failure `posted_text`
 * caused on the live board. src/reelformat.js additionally refuses to build
 * one of these at all once the reading goes stale; this is the second half of
 * that rule, for the hours inside the window where the number can still move.
 * It is also the phrase src/reelcaption.js already uses, so the reel and its
 * caption date the claim the same way.
 *
 * THE STIPEND IS DELIBERATELY LEFT OUT even when the row has one. Format A
 * leads on money because money is the strongest fact it has; here the short
 * queue is, and a second headline number splits the one thing the reel is
 * about. It is still on screen as a pill in the role scene, so nothing is
 * hidden — the picture carries it and the voice stays on the point.
 */
function formatD(d, { role, where, site }) {
  const company = String(d.company ?? '').replace(/\.+$/, '').trim();
  const n = Number(d.applicantsCount) || 0;

  const lead = n === 0
    ? 'Zero applicants when we listed it'
    : `Only ${small(n)} applicant${n === 1 ? '' : 's'} when we listed it`;

  const parts = [lead, `it's at ${company}${where}`];
  if (role) parts.push(`and the role is ${role}`);

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
/**
 * The most words of a role worth SAYING.
 *
 * The script as a whole targets ~26 words, and the role is one clause of three
 * or four. At the tempo the renderer applies, nine words is already about three
 * and a half seconds of one clause.
 */
const MAX_ROLE_WORDS = 9;

/**
 * Cut a title down to the part that is actually the ROLE.
 *
 * IT RUNS ON THE RAW TITLE, BEFORE `speakable`, and that ordering is the whole
 * trick: `speakable` turns `|` and `,` into spaces, so by the time it has run
 * the structure that says where the role ends is gone.
 *
 * The case that forced this is real and was going out automatically:
 * STEMpedia files a 172-character title — "AI And Robotics Trainer Internship
 * in Haryana, Jhajjar, Ambala, Bhiwani, Palwal, Hisar, Jind, Kurukshetra,
 * Gurgaon, Sirsa, Sonipat, Faridabad, Nuh, Charkhi Dadri, Fatehabad" — and the
 * voiceover read every city aloud. The card never showed this because it
 * already clamps and shrinks to fit; only the VO did.
 *
 * Measured over all 688 published titles: 28 change, **none is emptied**, and
 * the spoken role goes to a median of 4 words and a maximum of 9.
 */
function clampRole(raw) {
  let t = String(raw || '').trim();

  /* THE PARENTHETICAL IS SOMETIMES THE WHOLE JOB. `speakable` deletes bracketed
     text, which is right for "(Remote)" and "(PI/PO)" — but Honeywell files
     "Intern (Bachelor's)" and Yubi files "Intern (Data Science)", where
     deleting it leaves the bare word "Intern", which is then stripped as
     redundant and the reel says no role at all. Unwrapped only when what is
     left outside the brackets is nothing but a generic intern word, so every
     ordinary "(Remote)" is still dropped. */
  const outside = t.replace(/\([^)]*\)/g, ' ').replace(/[^A-Za-z ]/g, ' ').trim();
  if (/^(intern|interns|internship|internships|trainee|apprentice)?$/i.test(outside)) {
    t = t.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* " in A, B, C" with three or more comma-separated items is a list of
     cities, not part of the job. Three, not one: "Internship in Machine
     Learning" carries no comma and must survive, and the VO has already said
     the city in the clause before this one. */
  t = t.replace(/\s+in\s+[^,]+(?:,\s*[^,]+){2,}\s*$/i, '');

  /* A pipe is a separator nobody puts inside a job name:
     "AI Training | Internship | Job Opportunity | 2026 Graduates". */
  t = cutBefore(t, /\s*\|\s*/);

  /* A dash is NOT reliably a separator — "Intern - Embedded System" keeps its
     meaning on the right-hand side — so it is only cut when the title is still
     too long to say. Cutting unconditionally threw away the informative half
     of "Trainee Consultant - SAP Process Integration", which already fitted. */
  if (speakable(t).split(' ').filter(Boolean).length > MAX_ROLE_WORDS) {
    t = cutBefore(t, /\s+[-–—]\s+/);
  }
  return t;
}

/** Keep what is before the first match, but only if two or more words survive. */
function cutBefore(t, re) {
  const m = t.match(re);
  if (!m) return t;
  const head = t.slice(0, m.index).trim();
  return head.split(/\s+/).filter(Boolean).length >= 2 ? head : t;
}

function roleOnly(title) {
  const words = /** @type {string} */ (speakable(clampRole(title))).split(' ').filter(Boolean);
  /* Only the words that are REDUNDANT with "an intern", and only where they
     are decoration rather than part of the name. "Trainee" and "apprentice"
     are kept: "Young Graduate Trainee" is the whole role, and trimming it left
     "the role is Young Graduate", which is not a job. "Intern - Embedded
     System" and "Zoho CRM Developer Intern" are the shapes worth trimming. */
  const redundant = /^(intern|interns|internship|internships)$/i;
  const trailingNoise = /^(job|jobs|opportunity|role|position|intern|interns|internship|internships)$/i;
  while (words.length && redundant.test(words[0])) words.shift();
  while (words.length && trailingNoise.test(words[words.length - 1])) words.pop();
  /* The backstop, for a long title carrying none of the separators above. The
     noise trim runs again because the cut can expose a new trailing "Job". */
  const capped = words.slice(0, MAX_ROLE_WORDS);
  while (capped.length && trailingNoise.test(capped[capped.length - 1])) capped.pop();
  return capped.join(' ');
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
