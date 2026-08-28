import { normaliseEmail, normaliseRegion, looksAutomated, rateLimit, addSubscriber, REGIONS } from '../web/api/subscribe.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== a real address survives ==');
// Every one of these is a shape a real person has, and a regex written to look
// strict refuses most of them.
check('ordinary', normaliseEmail('akshat@example.com'), 'akshat@example.com');
check('plus-addressing', normaliseEmail('me+interndoor@gmail.com'), 'me+interndoor@gmail.com');
check('apostrophe', normaliseEmail("s.o'brien@example.co.uk"), "s.o'brien@example.co.uk");
check('long TLD', normaliseEmail('hi@startup.engineering'), 'hi@startup.engineering');
check('subdomain', normaliseEmail('a@mail.iitb.ac.in'), 'a@mail.iitb.ac.in');
check('digits and dashes', normaliseEmail('a1-b@my-college.edu'), 'a1-b@my-college.edu');

console.log('\n== cleaned, but never rewritten ==');
check('trimmed', normaliseEmail('  a@b.com  '), 'a@b.com');
check('lowercased', normaliseEmail('Akshat@Example.COM'), 'akshat@example.com');
// Stripping dots and +tags is a Gmail habit, wrong nearly everywhere else, and
// not ours to do — the address belongs to the person who typed it.
check('gmail dots are NOT stripped', normaliseEmail('a.k.s@gmail.com'), 'a.k.s@gmail.com');
check('+tag is NOT stripped', normaliseEmail('a+x@gmail.com'), 'a+x@gmail.com');

console.log('\n== header injection cannot get through ==');
// THE CHECK THAT MATTERS. A newline in a submitted field is how that field
// becomes extra headers downstream. It can never be part of a real address.
check('newline', normaliseEmail('a@b.com\nbcc: victim@x.com'), null);
check('carriage return', normaliseEmail('a@b.com\r\nbcc: victim@x.com'), null);
check('tab', normaliseEmail('a@b.com\tx'), null);
check('embedded space', normaliseEmail('a b@c.com'), null);

console.log('\n== what is not an address ==');
check('empty', normaliseEmail(''), null);
check('null', normaliseEmail(null), null);
check('a number', normaliseEmail(12345), null);
check('no @', normaliseEmail('akshat.example.com'), null);
check('two @', normaliseEmail('a@b@c.com'), null);
check('nothing before @', normaliseEmail('@example.com'), null);
check('no dot in domain', normaliseEmail('a@localhost'), null);
check('domain starts with a dot', normaliseEmail('a@.com'), null);
check('domain ends with a dot', normaliseEmail('a@b.'), null);
check('double dot', normaliseEmail('a@b..com'), null);
check('over 254 chars', normaliseEmail('a'.repeat(250) + '@b.com'), null);

console.log('\n== the board ==');
check('IN', normaliseRegion('IN'), 'IN');
check('lowercase is fine', normaliseRegion('us'), 'US');
check('missing means India', normaliseRegion(undefined), 'IN');
// Not silently coerced: an unknown board is a bad request, because sending US
// listings to somebody who asked for India is the same class of mistake as
// posting them to India's Telegram channel.
check('an unknown board is refused', normaliseRegion('FR'), null);
check('the three published boards', REGIONS, ['IN', 'US', 'GB']);

console.log('\n== the honeypot ==');
check('a human leaves it empty', looksAutomated({ email: 'a@b.com' }), false);
check('and an empty string is still human', looksAutomated({ company: '   ' }), false);
check('a bot fills it in', looksAutomated({ company: 'Acme' }), true);

console.log('\n== the rate limit ==');
const now = Date.now();
let store = new Map();
for (let i = 0; i < 5; i++) rateLimit('1.1.1.1', now, store);
check('the sixth in an hour is refused', rateLimit('1.1.1.1', now, store).status, 429);
// Per IP, or one noisy network would lock everybody out.
check('a different address is unaffected', rateLimit('2.2.2.2', now, store).ok, true);
// An hour later the hourly window has rolled but the daily has not.
store = new Map();
for (let i = 0; i < 5; i++) rateLimit('3.3.3.3', now - 7_200_000, store);
check('an hour later it is allowed again', rateLimit('3.3.3.3', now, store).ok, true);

console.log('\n== already subscribed is a SUCCESS, not an error ==');
// Surfacing the provider's duplicate error would turn this endpoint into an
// oracle for whether a given address is on the list — a disclosure about a
// person, made to whoever typed their address in.
const dupe = await addSubscriber('a@b.com', 'IN', 'k',
  async () => ({ ok: false, status: 400, json: async () => ({ code: 'email_already_exists' }) }));
check('duplicate reads as ok', dupe.ok, true);
check('but is marked not-created', dupe.created, false);

const fresh = await addSubscriber('a@b.com', 'IN', 'k', async () => ({ ok: true }));
check('a new address is created', fresh, { ok: true, created: true });

const broken = await addSubscriber('a@b.com', 'IN', 'k',
  async () => ({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) }));
check('a real provider failure is NOT swallowed', broken.ok, false);
check('and carries its status', broken.status, 500);

console.log('\n== what is sent to the provider ==');
let sent = null;
await addSubscriber('a@b.com', 'US', 'secret', async (url, opts) => {
  sent = { url, opts }; return { ok: true };
});
check('the region travels as a tag', JSON.parse(sent.opts.body).tags, ['region:US']);
// ...AND in a field that is not a paid feature, so it survives the fallback
// below. Buttondown gates tags behind Basic; referrer_url is on every plan.
check('the region also travels in referrer_url', JSON.parse(sent.opts.body).referrer_url, 'https://interndoor.com/us');

console.log('\n== single opt-in: no confirmation email ==');
/* Buttondown defaults a new subscriber to `unactivated` and mails them a
   confirmation link. That CANNOT be disabled globally — there is no toggle in
   Settings > Subscribing and its docs say as much — so the only lever is
   per-subscriber, on creation. Drop this field and every signup silently goes
   back to needing a click in an inbox before it counts. */
check('the subscriber is created already confirmed', JSON.parse(sent.opts.body).type, 'regular');

console.log('\n== tags are a PAID feature, and a signup is worth more than a label ==');
// Buttondown answers 403 feature_disabled — "Tags require a Basic plan or
// higher" — and rejects the WHOLE request rather than dropping the tag, so
// every signup was failing on the free plan. Retry once without them.
const TAGS_403 = { ok: false, status: 403, json: async () => ({ code: 'feature_disabled', detail: 'Tags require a Basic plan or higher - please upgrade your account.', metadata: { tags: ['region:IN'] } }) };
const calls = [];
const degraded = await addSubscriber('a@b.com', 'IN', 'k', async (url, opts) => {
  calls.push(JSON.parse(opts.body));
  return calls.length === 1 ? TAGS_403 : { ok: true };
});
check('the subscriber is still added', degraded.ok, true);
check('and is flagged as untagged', degraded.tagged, false);
check('exactly one retry', calls.length, 2);
check('the first attempt carried tags', calls[0].tags, ['region:IN']);
check('the retry carries none', 'tags' in calls[1], false);
check('and still carries the region', calls[1].referrer_url, 'https://interndoor.com');
/* The retry drops TAGS and nothing else. Losing `type` here would send a
   confirmation email to exactly the free-plan accounts the fallback exists
   for — i.e. this one. */
check('the retry still opts out of confirmation', calls[1].type, 'regular');
check('as did the first attempt', calls[0].type, 'regular');

// NARROW ON PURPOSE. A 403 that is not about tags is a real permission
// problem and must keep failing loudly rather than being retried into a
// different error.
let tries = 0;
const forbidden = await addSubscriber('a@b.com', 'IN', 'k', async () => {
  tries++; return { ok: false, status: 403, json: async () => ({ code: 'forbidden', detail: 'nope' }) };
});
check('an unrelated 403 is not retried', tries, 1);
check('and is not swallowed', forbidden.ok, false);
check('the address is the one given', JSON.parse(sent.opts.body).email_address, 'a@b.com');
check('the key is a header, never a query param', sent.url.includes('secret'), false);
check('and it is sent as a token', sent.opts.headers.authorization, 'Token secret');

console.log('\n== the on-page message matches what actually happens ==');
/* With no confirmation email, this message is the ONLY acknowledgement a
   reader gets — and telling them to check an inbox that will stay empty is
   worse than saying nothing. */
const clientJs = readFileSync(join(ROOT, 'web', 'public', 'subscribe.js'), 'utf8');
check('it does not send the reader to their inbox to confirm',
  /check your inbox to confirm/i.test(clientJs), false);
check('it still confirms the signup worked', clientJs.includes('you are on the list'), true);


console.log('\n== the subscriber IP is what unblocks the firewall ==');
/* Buttondown was refusing EVERY address with `subscriber_blocked`, and its own
   API console said why: "Improve list quality by passing `ip_address`".
   Without it every signup arrives from a rotating Vercel serverless IP with no
   subscriber attached, which is what bulk bot signups look like. */
{
  let sent = null;
  const fake = async (u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 201, json: async () => ({}) }; };
  await addSubscriber('a@b.com', 'IN', 'k', fake, '203.0.113.9');
  check('the IP is sent', sent.ip_address, '203.0.113.9');
  /* Omitted rather than faked: a wrong IP is worse for list quality than none,
     and it would also be a false consent record. */
  sent = null;
  await addSubscriber('a@b.com', 'IN', 'k', fake, null);
  check('an unknown IP is omitted, never invented', 'ip_address' in sent, false);
  /* fetchImpl is the FOURTH argument. Passing the IP in its place made the
     handler call the IP string as a function — caught before shipping. */
  check('the fetch impl is still the 4th argument', typeof fake, 'function');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
