/* ============================================================
   Google Ads tag — conversion tracking for the paid campaign.

   THE CONVERSION ID LIVES HERE AND NOWHERE ELSE. Set ADS_ID
   below and the whole site is tagged; leave it empty and
   nothing loads, nothing is requested, and every call site is
   a no-op. That is the same shape src/websearch.js takes with
   no GOOGLE_CSE_KEY and web/api/subscribe.js takes with no
   BUTTONDOWN_API_KEY: a missing key is a quiet no-op, never a
   half-working feature.

   WHY THIS IS AN EXTERNAL FILE AND NOT GOOGLE'S OWN SNIPPET.
   The snippet Google hands you is two tags, the second inline:

     <script async src="…/gtag/js?id=AW-X"></script>
     <script>window.dataLayer=…;gtag('config','AW-X')</script>

   Both halves are a problem here.

   1. web/vercel.json ships script-src 'self' plus a HASH
      allowlist and no 'unsafe-inline', so an inline script
      whose sha256 is not in that list is silently blocked in
      production while working perfectly on every local server
      — nothing local sends the CSP header. That is exactly how
      the no-flash theme script shipped broken on 21 Aug.
   2. test/pages.test.mjs pins a job page at EXACTLY ONE inline
      script and checks its hash against the real vercel.json.
      A second one fails the suite.
   3. A hash is byte-exact, so an inline snippet carrying the
      ID would need its hash regenerated every time the ID
      changed — a footgun with a silent failure mode.

   Loading the tag from here sidesteps all three: no inline
   script, no hash, and because this file injects the
   googletagmanager loader itself, the ID appears once rather
   than being duplicated into both web/public/index.html and
   src/pages.js (which would be a fourth copy of the
   jobPageSlug problem).

   THE CSP MUST ALLOW THESE HOSTS. web/vercel.json takes NO
   comment keys — it is validated against a published JSON
   Schema with additionalProperties:false, and one _comment key
   failed every deploy silently on 23 Aug — so the reasoning
   lives here instead:

   THIS LIST WAS MEASURED, NOT READ OFF A DOC. A real ID was
   set, a page was served with the production header, and
   every request the tag made was recorded. Two hosts that
   every guide puts under img-src are wrong:

   * googleads.g.doubleclick.net serves the conversion beacon
     as a SCRIPT (/pagead/viewthroughconversion), so it needs
     script-src. With it only in img-src, BOTH conversions
     were blocked and nothing anywhere said so.
   * ad.doubleclick.net (/ccm/s/collect) is a DIFFERENT host
     from googleads.g.doubleclick.net and needs connect-src
     of its own.

   The five hosts actually contacted, verified with zero CSP
   violations:

     www.googletagmanager.com     the loader
     googleads.g.doubleclick.net  the conversion beacon (SCRIPT)
     ad.doubleclick.net           /ccm/s/collect (CONNECT)
     www.google.com               1p-user-list, rmkt, ccm
     www.google.co.in             1p-user-list

   www.google.co.in is there because the campaign targets
   India and readers are routinely served their country TLD.
   TARGETING ANOTHER COUNTRY MEANS ADDING ITS TLD, or its
   conversions are dropped with no error anywhere.
   test/gtag.test.mjs pins all of this against the real
   web/vercel.json, so tightening the CSP fails the suite
   instead of silently killing conversion tracking.

   NOT in publish.js's PUBLISHED allowlist, like app.js,
   page.js, styles.css and subscribe.js — the scheduler will
   never commit this file. Stage it by hand.
   ============================================================ */

(function ads() {

/* Google Ads conversion ID, e.g. 'AW-1234567890'. Empty = off. */
const ADS_ID = '';

/* One entry per conversion action created in Google Ads. Paste the FULL
   send_to value it gives you — 'AW-1234567890/AbC-D_efGhIjKlMnOp', not the
   bare label. An entry left empty still fires a plain named event, which is
   worth having: it shows up as a real signal before the conversion action
   exists, and costs nothing if it never does. */
const CONVERSIONS = {
  /* Someone joined the email list. THE conversion worth optimising toward —
     it is the only channel this site owns rather than rents. */
  subscribe: '',
  /* Someone clicked through to an employer's application. The site's core
     action, and the only one that already works end to end. */
  apply: '',
};

/* Fired by subscribe.js on a successful signup, and by the delegated listener
   below on an apply click. Defined even when the tag is off, so no call site
   ever has to know whether it is — they use window.idTrack?.() anyway, which
   also covers being called before this file has run. */
window.idTrack = function idTrack() {};

if (ADS_ID) {
  window.dataLayer = window.dataLayer || [];
  /* Must be `arguments`, not a rest parameter: gtag.js reads the arguments
     object off the queued entries and a real array is not equivalent. A
     function EXPRESSION, not a declaration — a declaration inside a block
     carries Annex B hoisting semantics in a classic script. */
  const gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', ADS_ID);

  /* Injected rather than written as a <script> tag in the markup, so the ID
     stays in this one file. script-src covers an injected script exactly as
     it covers a parsed one. */
  const loader = document.createElement('script');
  loader.async = true;
  loader.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ADS_ID);
  document.head.appendChild(loader);

  window.idTrack = function idTrack(name, params) {
    const sendTo = CONVERSIONS[name];
    if (sendTo) gtag('event', 'conversion', Object.assign({ send_to: sendTo }, params));
    else gtag('event', name, params);
  };

  /* APPLY CLICKS, wired here rather than at each call site.

     The apply link is built in three different places — .card-go on a feed
     card and .go in the detail dialog (both web/public/app.js), and
     .btn-apply on a generated job page and its mobile dock (src/pages.js).
     A call site in each means four edits and four things to keep in step;
     one delegated listener is a single place that cannot drift out of sync
     with itself.

     The trade is that a class rename here fails silently, so: IF YOU RENAME
     AN APPLY BUTTON'S CLASS, RENAME IT HERE TOO.

     Capture phase, because app.js stops propagation on the card's apply link
     to keep the click from also opening the dialog — a bubble-phase listener
     on document would never see it. */
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a.card-go, a.go, a.btn-apply');
    if (link) window.idTrack('apply');
  }, true);
}

})();
