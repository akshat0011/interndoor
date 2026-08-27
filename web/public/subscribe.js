/* ============================================================
   The email signup, wired once for the whole site.

   IT IS ITS OWN FILE because the form is on TWO kinds of page
   that load different scripts: the board loads app.js (a
   module) and every generated page loads page.js (a classic
   script). A classic script cannot import, so the choice was
   a shared file or a second copy of the handler — and this
   repo already knows what a second copy costs, which is why
   jobPageSlug's three copies are pinned by a test. One file,
   loaded by both, cannot drift.

   Everything here is an upgrade. The form carries a real
   action and method, so without this handler a submit still
   reaches /api/subscribe and still subscribes the reader —
   they just land on the endpoint's JSON instead of staying
   here. This keeps them on the page and turns the endpoint's
   replies into something a person can read.

   The messages shown are the SERVER'S, not ours. They are
   written for readers ("That does not look like an email
   address"), and a second set here would mean two wordings to
   keep in step and one of them going stale. Only the
   transport failure — where there is no server message — is
   worded locally.

   NOTE: like app.js, page.js and styles.css, this file is NOT
   in publish.js's PUBLISHED allowlist, so the scheduler never
   commits it. Changes here have to be staged by hand.
   ============================================================ */

/* An upgrade, like everything else in this file. The form carries a real
   action and method, so without this handler a submit still reaches
   /api/subscribe and still subscribes the reader — they just land on the
   endpoint's JSON instead of staying here. This keeps them on the page and
   turns the endpoint's replies into something a person can read.

   The messages shown are the SERVER'S, not ours. They are written for readers
   ("That does not look like an email address"), and inventing a second set here
   would mean two wordings to keep in step and one of them going stale. Only the
   transport failure — where there is no server message — is worded locally. */
/* WHICH BOARD THIS READER IS ON.
   A generated page bakes it into data-region at build time, which cannot be
   wrong the way a runtime guess can. THE HOMEPAGE CANNOT: web/public/index.html
   is one TEMPLATE rendered for every board, so a hardcoded attribute there
   would tell the US and UK boards they were India. Those pages carry the
   per-region <meta name="interndoor-region"> instead — the same tag app.js has
   always read, and read the same tolerant way, because a page cached from an
   older rebrand still carries the old name. */
function regionOf(form) {
  if (form.dataset.region) return form.dataset.region;
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content;
  return meta('interndoor-region') || meta('gradkite-region') || meta('internzo-region') || 'IN';
}

(function subscribe() {
  const form = document.querySelector('form.sub');
  if (!form) return;

  const msg = form.querySelector('.sub-msg');
  const btn = form.querySelector('.sub-b');
  const input = form.querySelector('.sub-i');
  let busy = false;

  function say(text, kind) {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const email = input.value.trim();
    /* Checked here only to save an obviously-pointless round trip. The server
       validates for real — this is a convenience, never the gate. */
    if (!email) { say('Enter an email address first.', 'bad'); input.focus(); return; }

    busy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Adding…';
    say('', '');

    try {
      const res = await fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          region: regionOf(form),
          company: form.querySelector('[name=company]').value,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        /* The row goes away on success. Leaving a filled-in box beside a
           thank-you invites a second submit, and the second one is the reader
           wondering whether the first worked. */
        form.querySelector('.sub-row').hidden = true;
        say('Done — you are on the list. Check your inbox to confirm.', 'good');
        return;
      }
      say(data.error || 'Could not add you just now. Please try again.', 'bad');
    } catch (err) {
      say('No connection. Please try again.', 'bad');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
})();
