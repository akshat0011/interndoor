/* ============================================================
   The feedback box, wired once for the whole site.

   ITS OWN FILE for the same reason subscribe.js is: the board
   loads app.js (a module) and every generated page loads
   page.js (a classic script), and a classic script cannot
   import. One file loaded by both cannot drift.

   THE MESSAGES SHOWN ARE THE SERVER'S. They are written for
   readers ("Please write a little more so we can act on it"),
   and a second set here would mean two wordings to keep in
   step and one of them going stale. Only the transport
   failure — where there is no server message — is worded
   locally. Same rule as subscribe.js.

   UNLIKE subscribe.js THIS IS NOT AN UPGRADE OVER A WORKING
   FORM. The signup form carries a real method and action, so
   without its handler a submit still subscribes the reader.
   This form deliberately does NOT: a no-JavaScript submit
   would navigate away to raw JSON, and the reader would have
   no idea whether their message arrived. The markup carries
   no action, the button is type=button, and the whole block
   is hidden until this file wires it — so a reader who would
   get a broken experience is shown nothing instead of a box
   that looks like it works.

   NOTE: like app.js, page.js, engage.js and styles.css, this
   file is NOT in publish.js's PUBLISHED allowlist, so the
   scheduler never commits it. Changes here are staged by hand.
   ============================================================ */

/* WHICH BOARD THIS READER IS ON — the same tolerant read subscribe.js does,
   and for the same reason: web/public/index.html is ONE template rendered for
   every board, so a hardcoded attribute there would tell the US and UK boards
   they were India. A page cached from an older rebrand still carries the old
   meta name, so all three are accepted. */
function regionOf(form) {
  if (form.dataset.region) return form.dataset.region;
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content;
  return meta('interndoor-region') || meta('gradkite-region') || meta('internzo-region') || 'IN';
}

(function feedback() {
  document.querySelectorAll('form.fb').forEach(wire);
  wireDialog();
})();

/**
 * The masthead button opens the dialog; everything here closes it.
 *
 * THE BACKDROP DOES CLOSE IT, unlike engage.js's prompt. That one interrupts a
 * reader who did not ask for it, so it deliberately has to be answered; this
 * one is a dialog the reader opened on purpose, and a backdrop that ignores a
 * click on a thing the reader opened themselves reads as broken.
 */
function wireDialog() {
  const open = document.querySelector('.fb-open');
  const modal = document.querySelector('.fb-modal');
  const veil = document.querySelector('.fb-veil');
  if (!open || !modal || !veil) return;

  /* Revealed only now, like the form itself: with no JavaScript the button
     would open nothing, so it is not shown at all. */
  open.hidden = false;

  let lastFocus = null;
  const focusable = () => [...modal.querySelectorAll('textarea, input, button')]
    .filter((el) => !el.disabled && el.offsetParent !== null);

  function show() {
    lastFocus = document.activeElement;
    veil.hidden = false;
    modal.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    /* The page must not scroll behind it — a dialog over a moving board is
       the shape that makes a phone feel broken. */
    document.documentElement.classList.add('fb-open-modal');
    /* THE TEXTAREA, NOT THE FIRST FOCUSABLE. The close button precedes the form
       in the DOM, so `focusable()[0]` put the cursor on Close — a reader who
       opened a feedback box and pressed Space would have shut it again. Caught
       by reading `document.activeElement` after a real click; nothing about the
       markup looked wrong. */
    (modal.querySelector('.fb-t') ?? focusable()[0])?.focus();
  }

  function hide() {
    veil.hidden = true;
    modal.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('fb-open-modal');
    /* Focus goes back where it came from, or it lands on <body> and the next
       Tab starts from the top of the page. */
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  open.addEventListener('click', show);
  veil.addEventListener('click', hide);
  modal.querySelector('.fb-x')?.addEventListener('click', hide);

  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    /* Tab stays inside. Without this the reader tabs straight out of an open
       dialog into the board behind it, which a screen reader reads as the
       dialog having closed. */
    if (e.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function wire(form) {
  const msg = form.querySelector('.fb-msg');
  const btn = form.querySelector('.fb-b');
  const box = form.querySelector('.fb-t');
  const mail = form.querySelector('.fb-e');
  const row = form.querySelector('.fb-row');
  let busy = false;

  /* Revealed only now. The block ships hidden so a reader without JavaScript
     is never shown a form that cannot submit — see the header note. */
  form.hidden = false;

  function say(text, kind) {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  async function send() {
    if (busy) return;
    const message = box.value.trim();
    /* Checked here only to save an obviously-pointless round trip. The server
       validates for real — this is a convenience, never the gate. */
    if (!message) { say('Write something first.', 'bad'); box.focus(); return; }

    busy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    say('', '');

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          email: mail ? mail.value.trim() : '',
          region: regionOf(form),
          /* Which page this is about. pathname ONLY — never search or hash.
             The board's own filter state lives in ?q=, so sending the whole
             URL would put whatever the reader typed into the store by the back
             door. The endpoint drops a query too; this is the near half of the
             same rule. */
          path: location.pathname,
          company: form.querySelector('[name=company]').value,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        /* The inputs go away on success, exactly as the signup row does.
           Leaving a filled-in box beside a thank-you invites a second submit,
           and the second one is the reader wondering whether the first
           worked. */
        row.hidden = true;
        say('Thank you — that reached us. We read every one.', 'good');
        return;
      }
      say(data.error || 'That did not send. Please try again.', 'bad');
    } catch (err) {
      say('No connection. Please try again.', 'bad');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  btn.addEventListener('click', send);
  /* Enter sends, Shift+Enter is a newline — the convention in every message box
     a reader has used. Without this the only way to send is the mouse, because
     the form has no submit button to catch Enter (see the header note). */
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  /* The form has no action and no method, but a stray submit — an Enter inside
     the email input, which IS a submit — would still navigate. Refuse it and
     send instead. */
  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
}
