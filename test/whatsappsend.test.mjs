/**
 * sendOne, and the draft splice that corrupted a live channel.
 *
 * A post went out reading
 *
 *   https://interndoor.com/jobs/joveo-softw🏢 Joveo … /are-engineer-intern-4458863278
 *
 * — the previous listing's URL cut at character 39, a whole listing inserted
 * between the halves, and the new message's own footer link welded to the tail.
 * Two dead links in one message, on a public channel.
 *
 * The cause was that `sendOne` clicked the composer and started typing. A click
 * puts the caret WHERE IT LANDS, and WhatsApp Web persists a draft, so a run
 * that died between typing and Enter left one behind for the next run to type
 * into the middle of. The page here models exactly that: a caret that lands
 * mid-text, typing that inserts at the caret, and an Enter that may not send.
 */
import { sendOne } from '../src/whatsapp.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/**
 * A composer that behaves like the real one.
 *
 * @param {object} o
 * @param {string} o.initial     a draft already in the box
 * @param {number} o.caret       where a click puts the caret (the real bug: mid-text)
 * @param {boolean} o.clearable  whether select-all + Backspace works
 * @param {boolean} o.sends      whether Enter actually posts
 * @param {boolean} o.preview    whether a link card ever resolves
 */
function fakePage({ initial = '', caret = 0, clearable = true, sends = true, preview = true } = {}) {
  const st = { value: initial, caret: Math.min(caret, initial.length), sent: null, selected: false };
  const box = {
    count: async () => 1,
    innerText: async () => st.value,
    click: async () => { st.caret = Math.min(caret, st.value.length); st.selected = false; },
    getAttribute: async () => 'Type a message to Interndoor',
  };
  const loc = { or: () => loc, first: () => box, ...box };
  return {
    _st: st,
    locator: () => loc,
    waitForTimeout: async () => {},
    /* Two different questions reach evaluate: "is anything selected?" (the
       guard before Backspace) and "has the link card resolved?". Told apart by
       the source of the function passed in, the way the real page tells them
       apart by what they query. */
    evaluate: async (fn) => (String(fn).includes('getSelection') ? st.selected : preview),
    keyboard: {
      type: async (t) => {
        if (st.selected) { st.value = ''; st.caret = 0; st.selected = false; }
        st.value = st.value.slice(0, st.caret) + t + st.value.slice(st.caret);
        st.caret += t.length;
      },
      press: async (k) => {
        if (/\+A$/.test(k)) { st.selected = clearable; return; }
        if (k === 'Backspace') {
          if (st.selected) { st.value = ''; st.caret = 0; st.selected = false; }
          else if (st.caret > 0) { st.value = st.value.slice(0, st.caret - 1) + st.value.slice(st.caret); st.caret -= 1; }
          return;
        }
        if (k === 'Shift+Enter') { await loc.first(); st.value = st.value.slice(0, st.caret) + '\n' + st.value.slice(st.caret); st.caret += 1; return; }
        if (k === 'Enter') { if (sends) { st.sent = st.value; st.value = ''; st.caret = 0; } return; }
      },
    },
  };
}

const MSG = 'ACME\nRole\nhttps://interndoor.com/jobs/acme-role-123\n\nApply: https://x.test/1';
const STRANDED = 'https://interndoor.com/jobs/joveo-software-engineer-intern-4458863278';

console.log('\n== the ordinary case ==');
{
  const p = fakePage();
  const r = await sendOne(p, MSG);
  check('it reports sent', r.sent, true);
  check('it reports the card', r.carded, true);
  check('exactly the message went out', p._st.sent, MSG);
  check('and the box is empty afterwards', p._st.value, '');
}

console.log('\n== A STRANDED DRAFT IS NOT TYPED INTO ==');
// The regression. caret 39 is where the live corruption split the URL.
{
  const p = fakePage({ initial: STRANDED, caret: 39 });
  const r = await sendOne(p, MSG);
  check('the message still goes out', r.sent, true);
  check('and it is the message, whole', p._st.sent, MSG);
  check('no fragment of the draft survives anywhere in it', /joveo|4458863278/.test(p._st.sent), false);
  // What the bug produced, spelled out so it can never read as passing again.
  check('specifically, not the spliced form', p._st.sent.startsWith('https://interndoor.com/jobs/joveo-softw'), false);
}

console.log('\n== a box that will not clear posts NOTHING ==');
// Typing into it produces exactly the spliced message above, and not sending is
// unambiguously better than sending that.
{
  const p = fakePage({ initial: STRANDED, caret: 39, clearable: false });
  const r = await sendOne(p, MSG);
  check('refused', r.sent, false);
  check('nothing was posted', p._st.sent, null);
  check('and it says why', /would not clear/.test(r.error), true);
  check('the draft is left untouched, not half-typed-into', p._st.value, STRANDED);
}

console.log('\n== an Enter that does not send is NOTICED ==');
// It used to be counted as sent, so the listing was reported posted while the
// text sat in the box becoming the draft that corrupted the next message.
{
  const p = fakePage({ sends: false });
  const r = await sendOne(p, MSG);
  check('not reported as sent', r.sent, false);
  check('and it says why', /did not send/.test(r.error), true);
  check('THE BOX IS EMPTIED ANYWAY', p._st.value, '');
}

console.log('\n== the preview is waited for, but never blocks a post ==');
{
  const p = fakePage({ preview: false });
  const r = await sendOne(p, MSG, { previewMs: 30 });
  check('a card that never arrives still sends', r.sent, true);
  check('and is reported as uncarded', r.carded, false);
}
{
  // A message with no URL must not pay the preview wait at all.
  const p = fakePage({ preview: false });
  const r = await sendOne(p, 'no links here', { previewMs: 30 });
  check('a message with no URL is carded:true by definition', r.carded, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
