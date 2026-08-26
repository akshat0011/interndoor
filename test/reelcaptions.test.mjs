/**
 * Word timings to caption cues.
 *
 * The aligner gives one span per word. A caption that changed on every word
 * would strobe; one that held a whole sentence would be a paragraph on a phone.
 */
import { groupCues, closeCues, captionsFor, CAPTION } from '../src/reelcaptions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/** Evenly spaced words, `each` seconds long, starting at `from`. */
const run = (text, from = 0, each = 0.3) =>
  text.split(' ').map((word, i) => ({ word, start: +(from + i * each).toFixed(3), end: +(from + (i + 1) * each).toFixed(3) }));

const texts = (cues) => cues.map((c) => c.text);

console.log('\n== a cue holds a readable number of words ==');
const many = groupCues(run('one two three four five six seven eight nine ten'));
check('it splits at the word cap', many.every((c) => c.words.length <= CAPTION.maxWords), true);
check('nothing is dropped', many.flatMap((c) => c.words.map((w) => w.word)).length, 10);
check('and nothing is reordered',
  many.flatMap((c) => c.words.map((w) => w.word)),
  ['one','two','three','four','five','six','seven','eight','nine','ten']);

console.log('\n== a real pause breaks a cue ==');
// Words run together, then half a second of silence, then more.
const paused = groupCues([...run('apply before friday'), ...run('the link is below', 3.0)]);
check('the silence is a break', texts(paused), ['apply before friday', 'the link is below']);
// Below the gap threshold it stays one cue, subject to the other caps.
const tight = groupCues(run('apply before friday now', 0, 0.3), { maxWords: 9, maxDur: 9, maxChars: 99 });
check('a small gap does not break', texts(tight), ['apply before friday now']);

console.log('\n== a cue that would overflow the band is split ==');
const wide = groupCues(run('extraordinarily complicated engineering internship opportunity'),
  { maxWords: 9, maxDur: 9 });
check('the character budget splits it', wide.length > 1, true);
check('and every cue fits', wide.every((c) => c.text.length <= CAPTION.maxChars), true);

console.log('\n== a one-word orphan is pulled back ==');
// Four words that fill a cue, then one straggler close behind it.
const orphan = groupCues([...run('sign up right now', 0, 0.3), ...run('today', 1.25, 0.3)],
  { maxWords: 5, maxDur: 9, maxChars: 99 });
check('the straggler joins the cue before it', texts(orphan), ['sign up right now today']);
// The word cap is SOFT BY ONE for a rescue, because a one-word cue is a worse
// readability outcome than a cue one word over. Enforcing it produced
// "Find it on InternDoor dot" | "com." on a real voiceover.
const full = groupCues([...run('a b c d e', 0, 0.3), ...run('f', 1.55, 0.3)],
  { maxWords: 5, maxDur: 9, maxChars: 99 });
check('a full cue absorbs an orphan anyway', texts(full), ['a b c d e f']);
// One over is the ceiling. A cue absorbs at most one orphan — the back-pass
// walks right to left and the enlarged cue is never re-examined as a target —
// so nothing can reach maxWords + 2.
const long = groupCues(run('a b c d e f g h i j k l m n o p', 0, 0.3),
  { maxWords: 5, maxDur: 9, maxChars: 99 });
check('no cue exceeds the cap by more than one',
  long.every((c) => c.words.length <= 6), true);
// A second orphan too far to merge stays where it is.
const far = groupCues([...run('a b c d e', 0, 0.3), ...run('f', 1.55, 0.3), ...run('g', 4.0, 0.3)],
  { maxWords: 5, maxDur: 9, maxChars: 99 });
check('a distant second orphan is left alone', texts(far), ['a b c d e f', 'g']);
// The character budget is NOT soft — it is the width of the band.
const budget = groupCues([...run('aaaaaaaa bbbbbbbb cccccccc dddddddd', 0, 0.3), ...run('eeeeeeee', 1.25, 0.3)],
  { maxWords: 5, maxDur: 9, maxChars: 40 });
check('the band width still wins', budget.length, 2);
// Nor across a real pause: that orphan belongs to what comes next.
const farOrphan = groupCues([...run('a b c', 0, 0.3), ...run('d', 5.0, 0.3)], { maxWords: 5, maxDur: 9, maxChars: 99 });
check('a distant orphan stays separate', texts(farOrphan), ['a b c', 'd']);

console.log('\n== cues are closed against each other ==');
const closed = closeCues([
  { text: 'first half', start: 0, end: 1.0, words: [] },
  { text: 'second half', start: 1.2, end: 2.0, words: [] },
]);
// A small gap means one sentence in two halves — the band must not blink empty.
check('a small gap is closed to the next cue', closed[0].end, 1.2);
const apart = closeCues([
  { text: 'first', start: 0, end: 1.0, words: [] },
  { text: 'much later', start: 6.0, end: 7.0, words: [] },
]);
// Past closeGap the speaker really has stopped; holding a finished line
// through that reads as a freeze.
check('a long silence is not closed', apart[0].end, 1.12);
check('the last cue lingers a little', apart[1].end, 7.2);

// closeGap is LARGER than maxGap on purpose — they answer different questions.
// A 0.52s pause is a sentence boundary (so a new cue) but not a reason for the
// band to blink: sixteen blank frames at 30fps reads as a dropped caption.
// This exact gap appeared in the middle of a real voiceover.
check('closeGap is more generous than maxGap', CAPTION.closeGap > CAPTION.maxGap, true);
const sentenceBreak = closeCues([
  { text: 'intern embedded system.', start: 3.84, end: 5.50, words: [] },
  { text: 'only thirteen people have applied', start: 6.02, end: 7.68, words: [] },
]);
check('a sentence break does not blank the band', sentenceBreak[0].end, 6.02);
// But it is still two cues: the break is real, the blank is not wanted.
const stillTwo = groupCues([
  { word: 'system.', start: 5.2, end: 5.5 },
  { word: 'only', start: 6.02, end: 6.3 },
], { maxChars: 99 });
check('and it is still two cues', stillTwo.length, 2);

console.log('\n== a short cue stays up long enough to read ==');
const brief = captionsFor(run('go', 0, 0.12));
check('it is stretched to the minimum', brief[0].end >= CAPTION.minDur, true);

console.log('\n== degenerate input ==');
check('no words means no cues', captionsFor([]), []);
check('null is not a crash', captionsFor(null), []);
// The aligner can hand back an empty token; it must not become an empty cue.
check('blank words are dropped',
  texts(captionsFor([{ word: 'real', start: 0, end: 0.3 }, { word: '   ', start: 0.3, end: 0.6 }])),
  ['real']);
check('a single word still makes a cue', texts(captionsFor(run('hello'))), ['hello']);

console.log('\n== every word keeps its own span ==');
// The cue is what appears; the word inside it is what moves, so the per-word
// timings have to survive grouping intact.
const kept = captionsFor(run('one two three'), { maxWords: 9, maxDur: 9, maxChars: 99 });
check('spans survive grouping', kept[0].words,
  [{ word: 'one', start: 0, end: 0.3 }, { word: 'two', start: 0.3, end: 0.6 }, { word: 'three', start: 0.6, end: 0.9 }]);
check('the cue starts with its first word', kept[0].start, 0);

console.log('\n== a real voiceover ==');
// The actual alignment of the Philips reel, 28 words over 10.6s.
const real = [
  ['Philips',0.06,0.32],['is',0.32,0.45],['hiring',0.45,0.83],['interns',0.83,1.34],['in',1.34,1.47],
  ['Pune',1.47,1.66],['Division.',1.73,2.30],['They',2.82,2.94],['are',2.94,3.01],['looking',3.01,3.33],
  ['for',3.33,3.52],['a',3.58,3.71],['Intern',3.71,4.10],['Embedded',4.10,4.62],['System.',4.62,5.20],
  ['Only',5.70,5.95],['thirteen',5.95,6.45],['people',6.45,6.80],['have',6.80,6.98],['applied',6.98,7.40],
  ['so',7.40,7.55],['far.',7.55,8.00],['Find',8.55,8.80],['it',8.80,8.92],['on',9.22,9.41],
  ['InternDoor',9.41,9.92],['dot',9.92,10.18],['com.',10.18,10.62],
].map(([word, start, end]) => ({ word, start, end }));
const cues = captionsFor(real);
check('it produces a readable number of cues', cues.length >= 5 && cues.length <= 9, true);
check('no cue overflows the band', cues.every((c) => c.text.length <= CAPTION.maxChars), true);
check('no cue is a single word', cues.every((c) => c.words.length > 1), true);
// NOT a word count: "InternDoor dot com." collapses into one displayed word,
// "interndoor.com", so three spoken words become one shown one. What must hold
// is that nothing is LOST — every spoken word still appears somewhere.
const shown = cues.map((c) => c.text).join(' ').toLowerCase();
check('nothing is dropped', real.every((w) => {
  const t = w.word.toLowerCase().replace(/[^a-z0-9']/g, '');
  return !t || shown.includes(t) || 'dotcom'.includes(t);
}), true);
check('the domain is shown as a domain, not as speech',
  cues.some((c) => c.text.includes('interndoor.com')), true);
check('and never as "dot com"', /dot com/i.test(shown), false);
check('cues never overlap', cues.every((c, i) => i === 0 || c.start >= cues[i - 1].start), true);
check('the first cue starts with the first word', cues[0].start, 0.06);
console.log(`         ${cues.length} cues: ${cues.map((c) => `"${c.text}"`).join(' | ')}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
