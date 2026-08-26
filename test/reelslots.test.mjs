/**
 * When the next reel goes out.
 *
 * Three good jobs found in one sitting should become three posts, not one
 * burst — not because Instagram punishes bursts (it does not, and at zero
 * followers there is no follower feed to compete in) but because three reels
 * dropped into one slot is ONE measurement, not three.
 */
import { nextSlot, intoWindow, hourIn, slotLabel, SLOTS } from '../src/reelslots.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const IST = 'Asia/Kolkata';
/** A UTC instant for a given IST wall-clock hour. IST is UTC+5:30, no DST. */
const ist = (day, hour, min = 0) => Date.UTC(2026, 7, day, hour - 5, min - 30);
const MIN = 60_000;

console.log('\n== reading the local hour ==');
check('midday IST', hourIn(ist(26, 12), IST), 12);
check('midnight IST', hourIn(ist(26, 0), IST), 0);
check('the half-hour offset is handled', hourIn(ist(26, 18, 45), IST), 18);

console.log('\n== the first reel of a sitting is not delayed ==');
// He pressed the button because he wants it out. Making him wait four hours
// for the FIRST one means the button no longer does what it says.
check('nothing published, nothing queued', nextSlot({ now: ist(26, 12) }), null);
// Long enough ago that the spacing has already elapsed.
check('last publish was ages ago',
  nextSlot({ now: ist(26, 12), lastPublishedAt: ist(25, 12) }), null);

console.log('\n== the second and third are spaced ==');
const now = ist(26, 12);
const second = nextSlot({ now, lastPublishedAt: now }, { timeZone: IST });
check('spaced by the interval', second, ist(26, 15));
// A slot already promised counts even though nothing has published yet —
// otherwise three presses inside a minute all measure from the same last
// publish and collide on one slot.
const third = nextSlot({ now, lastPublishedAt: now, pendingSlots: [second] }, { timeZone: IST });
check('the third measures from the second', third, ist(26, 18));
check('and they are all different', new Set([second, third]).size, 2);

console.log('\n== slots stay inside the window ==');
// The board's own intake data puts weekday attention in the evening; a reel
// scheduled for 03:00 IST is a wasted reel however well spaced.
const late = nextSlot({ now: ist(26, 21), lastPublishedAt: ist(26, 21) }, { timeZone: IST });
check('a slot past the window moves to the next morning', hourIn(late, IST), SLOTS.windowStartHour);
// Steps land on UTC hour boundaries, which in IST (UTC+05:30) is :30 past.
// Pinned so the half-hour is a known consequence rather than a surprise.
check('and on a half-hour, because IST is offset', new Date(late).getUTCMinutes(), 0);
check('and it lands the NEXT day', late > ist(27, 0), true);
const overnight = nextSlot({ now: ist(26, 2), lastPublishedAt: ist(26, 2) }, { timeZone: IST });
check('an overnight press waits for the window', hourIn(overnight, IST), SLOTS.windowStartHour);

console.log('\n== intoWindow on its own ==');
check('inside the window is untouched', intoWindow(ist(26, 14), { timeZone: IST }), ist(26, 14));
check('before it moves forward', hourIn(intoWindow(ist(26, 5), { timeZone: IST }), IST), 10);
check('after it moves to tomorrow', hourIn(intoWindow(ist(26, 23), { timeZone: IST }), IST), 10);
// A 24-hour window is a real configuration and must not loop.
check('a 24h window changes nothing',
  intoWindow(ist(26, 3), { windowStartHour: 0, windowEndHour: 0, timeZone: IST }), ist(26, 3));
// A window spanning midnight is the awkward case.
const night = intoWindow(ist(26, 12), { windowStartHour: 22, windowEndHour: 6, timeZone: IST });
check('a window over midnight is honoured', hourIn(night, IST), 22);
check('and one already inside it is untouched',
  hourIn(intoWindow(ist(26, 23), { windowStartHour: 22, windowEndHour: 6, timeZone: IST }), IST), 23);

console.log('\n== spacing is configurable ==');
check('a shorter gap',
  nextSlot({ now, lastPublishedAt: now }, { spacingMinutes: 60, timeZone: IST }), ist(26, 13));
check('a longer gap',
  nextSlot({ now, lastPublishedAt: now }, { spacingMinutes: 300, timeZone: IST }), ist(26, 17));

console.log('\n== the label a button shows ==');
const lbl = slotLabel(ist(26, 18, 30), { timeZone: IST });
check('it names a time', /6:30\s*pm/i.test(lbl), true);
check('and a day, so tomorrow is not mistaken for today', /wed|thu/i.test(lbl), true);

console.log('\n== degenerate input ==');
check('a null pending slot is ignored',
  nextSlot({ now, lastPublishedAt: null, pendingSlots: [null, undefined] }), null);
check('slots are never in the past',
  nextSlot({ now, lastPublishedAt: ist(20, 12), pendingSlots: [ist(26, 14)] }, { timeZone: IST }) >= now, true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
