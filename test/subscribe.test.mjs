import { normaliseEmail, normaliseRegion, looksAutomated, rateLimit, addSubscriber, REGIONS } from '../web/api/subscribe.js';

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
check('the address is the one given', JSON.parse(sent.opts.body).email_address, 'a@b.com');
check('the key is a header, never a query param', sent.url.includes('secret'), false);
check('and it is sent as a token', sent.opts.headers.authorization, 'Token secret');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
