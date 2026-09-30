/**
 * sendCard, and the draft splice that corrupted a live channel.
 *
 * A post went out reading
 *
 *   https://interndoor.com/jobs/joveo-softw🏢 Joveo … /are-engineer-intern-4458863278
 *
 * — the previous listing's URL cut at character 39, a whole listing inserted
 * between the halves, and the new message's own footer link welded to the tail.
 * Two dead links in one message, on a public channel.
 *
 * The cause was that the send clicked the composer and started typing. A click
 * puts the caret WHERE IT LANDS, and WhatsApp Web persists a draft, so a run
 * that died between typing and Enter left one behind for the next run to type
 * into the middle of. Since 30 Sep 2026 every post is a PHOTO (the card) with
 * the message as its caption, and WhatsApp carries the composer's text into
 * that caption — so the page here models a caret that lands mid-text, a
 * caption seeded from the composer, a photo editor that may not send, and a
 * bubble that goes Pending then Sent, or fails, or never appears.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendCard, bubbleStatus, warmPreview, LIVE_MS, DELIVER_MS } from '../src/whatsapp.js';

/* The default warm-up reaches the network and polls for a page that does not
   exist in a test. Every case that is not about it passes this. */
const noWarm = async () => false;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'interndoor-wasend-'));
const CARD = join(dir, 'card.jpg');
writeFileSync(CARD, 'jpeg bytes');

/**
 * The channel as WhatsApp Web presents it.
 *
 * @param {object} o
 * @param {string}  o.initial          a draft already in the composer
 * @param {number}  o.caret            where a click puts the caret (the real bug: mid-text)
 * @param {boolean} o.clearable        whether select-all + Backspace works in the composer
 * @param {string}  o.seed             text the caption starts with besides the composer's
 * @param {boolean} o.captionClearable whether select-all + Backspace works in the caption
 * @param {boolean} o.sends            whether Enter in the photo editor posts
 * @param {boolean} o.appears          whether the post shows up as a new bubble
 * @param {string}  o.outcome          the bubble's end state: 'sent' | 'failed' | 'pending'
 * @param {number}  o.pendingPolls     how many reads the bubble stays Pending first
 */
function fakePage({
  initial = '', caret = 0, clearable = true, seed = '', captionClearable = true,
  sends = true, appears = true, outcome = 'sent', pendingPolls = 2,
} = {}) {
  const st = {
    composer: { value: initial, caret: Math.min(caret, initial.length) },
    caption: { value: '', caret: 0 },
    focus: 'composer', selected: false, editor: false, attached: null, posted: null,
    msgs: [{ id: 'conv-msg-OLD', labels: ['You:', ' Sent '] }], reads: 0, chooser: null,
  };
  const can = (name) => (name === 'composer' ? clearable : captionClearable);
  const boxFor = (name) => ({
    count: async () => (name === 'caption' && !st.editor ? 0 : 1),
    innerText: async () => st[name].value,
    click: async () => { st.focus = name; st[name].caret = Math.min(caret, st[name].value.length); st.selected = false; },
    getAttribute: async () => 'Type a message to Interndoor',
    waitFor: async () => {},
  });
  const composerLoc = { or: () => composerLoc, first: () => boxFor('composer') };
  const editorLoc = {
    count: async () => (st.editor ? 1 : 0),
    waitFor: async () => { if (!st.editor) throw new Error('editor never opened'); },
  };
  const bubble = () => {
    const m = st.msgs[st.msgs.length - 1];
    if (m.id !== 'conv-msg-NEW') return m;
    st.reads += 1;
    if (st.reads <= pendingPolls || outcome === 'pending') return { ...m, labels: ['You:', ' Pending '] };
    return { ...m, labels: outcome === 'failed' ? ['Something went wrong. Click to learn more.', 'You:'] : ['You:', 'Open picture', ' Sent '] };
  };
  return {
    _st: st,
    locator: (sel) => {
      /* The caption selector NAMES data-tab="10" inside its :not(), so it is
         matched first or it would be routed to the composer. */
      if (sel.includes(':not([data-tab="10"])')) return { first: () => boxFor('caption') };
      if (sel.includes('footer') || sel.includes('data-tab="10"]')) return composerLoc;
      if (sel === '[aria-label="Attach"]') return { first: () => ({ click: async () => {} }) };
      if (sel === '[aria-label="Remove attachment"]') return { first: () => editorLoc };
      throw new Error(`unexpected selector ${sel}`);
    },
    getByText: () => ({ first: () => ({ click: async () => st.chooser?.({
      /* WhatsApp carries the composer's text into the caption, which is why
         the composer is cleared before a photo is attached. */
      setFiles: async (p) => { st.attached = p; st.editor = true; st.caption = { value: st.composer.value + seed, caret: 0 }; },
    }) }) }),
    getByRole: () => ({ count: async () => 0, first: () => ({ click: async () => {} }) }),
    waitForEvent: () => new Promise((res) => { st.chooser = res; }),
    waitForTimeout: async () => {},
    evaluate: async (fn) => (String(fn).includes('getSelection') ? st.selected : bubble()),
    keyboard: {
      type: async (t) => {
        const b = st[st.focus];
        if (st.selected) { b.value = ''; b.caret = 0; st.selected = false; }
        b.value = b.value.slice(0, b.caret) + t + b.value.slice(b.caret);
        b.caret += t.length;
      },
      press: async (k) => {
        const b = st[st.focus];
        if (/\+A$/.test(k)) { st.selected = can(st.focus); return; }
        if (k === 'Backspace') {
          if (st.selected) { b.value = ''; b.caret = 0; st.selected = false; }
          else if (b.caret > 0) { b.value = b.value.slice(0, b.caret - 1) + b.value.slice(b.caret); b.caret -= 1; }
          return;
        }
        if (k === 'Shift+Enter') { b.value = b.value.slice(0, b.caret) + '\n' + b.value.slice(b.caret); b.caret += 1; return; }
        if (k === 'Escape') { st.editor = false; st.caption = { value: '', caret: 0 }; st.focus = 'composer'; return; }
        if (k === 'Enter' && st.focus === 'caption' && st.editor && sends) {
          st.posted = { card: st.attached, caption: st.caption.value };
          st.editor = false; st.caption = { value: '', caret: 0 }; st.focus = 'composer';
          if (appears) st.msgs.push({ id: 'conv-msg-NEW', labels: [] });
        }
      },
    },
  };
}

const MSG = 'ACME\nRole\nhttps://interndoor.com/jobs/acme-role-123\n\nApply: https://x.test/1';
const STRANDED = 'https://interndoor.com/jobs/joveo-software-engineer-intern-4458863278';
const quick = { warm: noWarm, deliverMs: 30, editorMs: 30 };

console.log('\n== the ordinary case: the card, captioned, and it reaches Sent ==');
{
  const p = fakePage();
  const r = await sendCard(p, MSG, CARD, quick);
  check('it reports sent', r.sent, true);
  check('the card is the photo attached', p._st.posted?.card, CARD);
  check('exactly the message is the caption', p._st.posted?.caption, MSG);
  check('and the composer is empty afterwards', p._st.composer.value, '');
  check('the editor is closed', p._st.editor, false);
}

console.log('\n== A STRANDED DRAFT IS NOT CARRIED INTO THE CAPTION ==');
// The regression. caret 39 is where the live corruption split the URL.
{
  const p = fakePage({ initial: STRANDED, caret: 39 });
  const r = await sendCard(p, MSG, CARD, quick);
  check('the message still goes out', r.sent, true);
  check('and it is the message, whole', p._st.posted?.caption, MSG);
  check('no fragment of the draft survives anywhere in it', /joveo|4458863278/.test(p._st.posted?.caption ?? ''), false);
  // What the bug produced, spelled out so it can never read as passing again.
  check('specifically, not the spliced form', (p._st.posted?.caption ?? '').startsWith('https://interndoor.com/jobs/joveo-softw'), false);
}

console.log('\n== a composer that will not clear posts NOTHING ==');
{
  const p = fakePage({ initial: STRANDED, caret: 39, clearable: false });
  const r = await sendCard(p, MSG, CARD, quick);
  check('refused', r.sent, false);
  check('nothing was posted', p._st.posted, null);
  check('no photo was even attached', p._st.attached, null);
  check('and it says why', /would not clear/.test(r.error), true);
  check('the draft is left untouched, not half-typed-into', p._st.composer.value, STRANDED);
}

console.log('\n== text already in the CAPTION is cleared, or nothing is sent ==');
{
  const p = fakePage({ seed: 'leftover', caret: 3 });
  const r = await sendCard(p, MSG, CARD, quick);
  check('a caption that clears still posts', r.sent, true);
  check('with only the message in it', p._st.posted?.caption, MSG);
}
{
  const p = fakePage({ seed: 'leftover', caret: 3, captionClearable: false });
  const r = await sendCard(p, MSG, CARD, quick);
  check('a caption that will not clear is refused', r.sent, false);
  check('nothing was posted', p._st.posted, null);
  check('the editor is discarded, not left open', p._st.editor, false);
  check('and it says it was the caption', /^caption:/.test(r.error), true);
}

console.log('\n== an Enter that does not send is NOTICED, and discarded ==');
{
  const p = fakePage({ sends: false });
  const r = await sendCard(p, MSG, CARD, quick);
  check('not reported as sent', r.sent, false);
  check('and it says why', /did not send/.test(r.error), true);
  check('the editor is closed without posting', [p._st.editor, p._st.posted], [false, null]);
}

console.log('\n== ONLY "Sent" COUNTS — the 30 Sep bug ==');
/* The old send counted a composer that emptied after Enter and closed the
   browser 1.5s later. WhatsApp marked some of those "not sent". */
{
  const p = fakePage({ outcome: 'failed' });
  const r = await sendCard(p, MSG, CARD, quick);
  check('a post WhatsApp marked not-sent is not counted', r.sent, false);
  check('and it says so', /not sent/.test(r.error), true);
  /* Returned on the read that showed the badge (the third: two Pending, then
     failed) — not after polling a dead post for the rest of the minute. */
  check('and it stops at the first read that shows the failure', p._st.reads, 3);
}
{
  const p = fakePage({ outcome: 'pending' });
  const r = await sendCard(p, MSG, CARD, quick);
  check('one still Pending at the deadline is not counted', r.sent, false);
  check('and it says it was pending', /still pending/.test(r.error), true);
}
{
  const p = fakePage({ appears: false });
  const r = await sendCard(p, MSG, CARD, quick);
  /* The OLD bubble says Sent. A post that never appeared must not borrow it. */
  check('a post that never appears does not borrow the previous bubble\'s Sent', r.sent, false);
  check('and it says it was not shown', /not shown/.test(r.error), true);
}
{
  const p = fakePage({ pendingPolls: 4 });
  const r = await sendCard(p, MSG, CARD, { ...quick, deliverMs: 60_000 });
  check('Pending then Sent is waited out and counted', r.sent, true);
  check('it read the bubble more than once before believing it', p._st.reads > 4, true);
  check('the deadline is a minute', DELIVER_MS, 60_000);
}

console.log('\n== no card, no post ==');
{
  const p = fakePage({ initial: STRANDED });
  const r = await sendCard(p, MSG, join(dir, 'missing.jpg'), quick);
  check('a card that is not on disk sends nothing', [r.sent, p._st.posted], [false, null]);
  check('and says so', /no card/.test(r.error), true);
  check('without touching the composer', p._st.composer.value, STRANDED);
  const q = fakePage();
  check('nor does an absent path', (await sendCard(q, MSG, null, quick)).sent, false);
}

console.log('\n== bubbleStatus reads WhatsApp\'s own words ==');
check('" Sent " is sent', bubbleStatus(['You:', 'Open picture', ' Sent ', 'React']), 'sent');
check('" Pending " is pending', bubbleStatus(['You:', ' Pending ']), 'pending');
check('the red badge is failed', bubbleStatus(['Something went wrong. Click to learn more.', 'You:']), 'failed');
check('failed outranks a Sent beside it', bubbleStatus(['Something went wrong. Click to learn more.', ' Sent ']), 'failed');
check('nothing known is unknown', bubbleStatus(['You:', 'React']), 'unknown');
check('no labels at all is unknown', bubbleStatus([]), 'unknown');
check('a caption that merely says Sent is not a status', bubbleStatus(['Sent from my phone']), 'unknown');

console.log('\n== the page is waited for before the link goes out ==');
{
  const calls = [];
  const html = '<meta property="og:image" content="https://interndoor.com/api/og?id=1&amp;r=IN">';
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, text: async () => html }; };
  const got = await warmPreview('see https://interndoor.com/jobs/acme-intern-1 for more', { fetchImpl });
  check('the page is fetched', calls[0], 'https://interndoor.com/jobs/acme-intern-1');
  check('and so is the card image it names', calls[1], 'https://interndoor.com/api/og?id=1&r=IN');
  check('the escaped separator is unescaped — &amp; would 404', /&amp;/.test(calls[1] ?? ''), false);
  check('it reports that it warmed something', got, true);
}
{
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); throw new Error('offline'); };
  const fast = { fetchImpl, liveMs: 0, pause: async () => {} };
  check('a warm-up that throws is swallowed', await warmPreview('https://interndoor.com/jobs/x', fast), false);
  check('a message with no URL fetches nothing',
    [await warmPreview('no links here', fast), calls.length], [false, 1]);
}
{
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return { ok: false, status: 404, text: async () => '' }; };
  check('a page that never appears gives up and posts anyway',
    [await warmPreview('https://interndoor.com/jobs/gone', { fetchImpl, liveMs: 0, pause: async () => {} }), calls.length], [false, 1]);

  /* The scan posts ~40s after publishing while Vercel is still deploying, and a
     follower taps the link the moment the notification lands. */
  let asks = 0;
  const waits = [];
  const html = '<meta property="og:image" content="https://interndoor.com/api/og?id=9&amp;r=IN">';
  const deploying = async () => (++asks < 3 ? { ok: false, status: 404 } : { ok: true, text: async () => html });
  const warmed = await warmPreview('https://interndoor.com/jobs/nvidia-system-software-intern-1',
    { fetchImpl: deploying, liveMs: 90_000, pause: async (ms) => { waits.push(ms); } });
  check('it waits for the deploy rather than posting a dead link', [warmed, asks >= 3], [true, true]);
  check('polling every 3s', waits.every((w) => w === 3000) && waits.length === 2, true);
  check('and the deadline is 90s', LIVE_MS, 90_000);
}
{
  /* Wired into the send, and finished BEFORE the photo is attached. */
  const order = [];
  const p = fakePage();
  const typed = p.keyboard.type;
  p.keyboard.type = async (t, o) => { order.push('type'); return typed(t, o); };
  const r = await sendCard(p, MSG, CARD, { ...quick, warm: async () => { order.push('warm'); } });
  check('the warm-up finishes before the first keystroke', order[0], 'warm');
  check('the post still goes out', r.sent, true);
}
{
  /* A warm-up that hangs or throws must not lose the listing. */
  const p = fakePage();
  const r = await sendCard(p, MSG, CARD, { ...quick, warm: async () => { throw new Error('boom'); } });
  check('a throwing warm-up still posts', r.sent, true);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
