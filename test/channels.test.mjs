import { channelsFor, telegramFor, instagramFor, whatsappFor } from '../src/channels.js';
import { renderAlertsPage, renderJobPage } from '../src/pages.js';
import { regionOf } from '../src/regions.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const cfg = {
  notifications: { telegram: { channels: { IN: '@interndoor', US: '@interndoorusa' } } },
  reels: { accounts: { IN: 'interndoorin', US: 'interndoorusa' } },
};

console.log('\n== each region gets its OWN channel ==');
/* THE BUG THIS PINS. regions.js hardcodes telegram:'https://t.me/interndoor' on
   every region, so the live US board sent Americans to India's channel — while
   notifications.telegram.channels had said @interndoorusa since 25 Aug and the
   POSTING half had been using it all along. */
check('US telegram is its own', telegramFor('US', cfg).url, 'https://t.me/interndoorusa');
check('and NOT India\'s', telegramFor('US', cfg).url.includes('/interndoor'), true);
check('IN telegram', telegramFor('IN', cfg).url, 'https://t.me/interndoor');
check('the @ is stripped from the URL', telegramFor('IN', cfg).url.includes('@'), false);
check('but kept for display', telegramFor('IN', cfg).handle, '@interndoor');
check('US instagram is its own', instagramFor('US', cfg).url, 'https://www.instagram.com/interndoorusa/');
check('IN instagram is its own', instagramFor('IN', cfg).url, 'https://www.instagram.com/interndoorin/');

console.log('\n== a region with no channel gets NOTHING, never a fallback ==');
// Same rule Telegram posting already follows and reels follow: sending somebody
// who asked about India a feed of American roles is worse than offering nothing.
check('GB has no telegram', telegramFor('GB', cfg), null);
check('GB has no instagram', instagramFor('GB', cfg), null);
check('nobody has whatsapp yet', whatsappFor('IN', cfg), null);
check('GB is offered email alone', channelsFor('GB', cfg).map((c) => c.kind), ['email']);

console.log('\n== email is always offered ==');
// The only channel the site OWNS rather than rents, so it leads.
check('IN', channelsFor('IN', cfg).map((c) => c.kind), ['email', 'telegram', 'instagram']);
check('US', channelsFor('US', cfg).map((c) => c.kind), ['email', 'telegram', 'instagram']);
check('email leads', channelsFor('IN', cfg)[0].kind, 'email');
check('even with no config at all', channelsFor('IN', {}).map((c) => c.kind), ['email']);

console.log('\n== adding WhatsApp later is a config entry and nothing else ==');
const withWa = { ...cfg, notifications: { ...cfg.notifications, whatsapp: { channels: { IN: 'https://whatsapp.com/channel/x' } } } };
check('it appears', channelsFor('IN', withWa).map((c) => c.kind), ['email', 'telegram', 'instagram', 'whatsapp']);
check('and only for its own region', channelsFor('US', withWa).map((c) => c.kind), ['email', 'telegram', 'instagram']);

console.log('\n== the page ==');
const inPage = renderAlertsPage(channelsFor('IN', cfg), { region: regionOf('IN') });
const gbPage = renderAlertsPage(channelsFor('GB', cfg), { region: regionOf('GB') });
check('the signup form is on it', inPage.includes('<form class="sub"'), true);
check('so is Telegram', inPage.includes('https://t.me/interndoor'), true);
check('so is Instagram', inPage.includes('instagram.com/interndoorin'), true);
// A page offering nothing but a form still has to explain itself.
check('GB still gets the form', gbPage.includes('<form class="sub"'), true);
check('and says why there is nothing else', gbPage.includes('only alert channel'), true);
check('GB links to no channel it does not have', /t\.me|instagram\.com/.test(gbPage), false);
check('the form knows its board', /data-region="GB"/.test(gbPage), true);

console.log('\n== the header points at the page, not straight at Telegram ==');
/* Jumping to Telegram decided for the reader that Telegram was the channel they
   wanted, and offered nothing at all to somebody who does not use it. */
const job = { id: '1', company: 'Adobe', title: 'AI Intern', location: 'Bengaluru, Karnataka, India', bullets: ['a', 'b'], postedAt: Date.now(), firstSeenAt: Date.now(), lastSeenAt: Date.now() };
const jobPage = renderJobPage(job, [], { region: regionOf('US') });
check('the pill is an internal link', /class="alerts"[^>]*href="\/us\/alerts"/.test(jobPage), true);
check('and no longer jumps to a chat app', /class="alerts"[^>]*t\.me/.test(jobPage), false);

console.log('\n== the homepage template localises it ==');
// index.html is ONE template for all three boards, so a hardcoded /alerts would
// send the US and UK boards to India's page. REGION_LINKS rewrites it.
const tpl = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
check('the template links to the bare path', tpl.includes('class="alerts" aria-label="Get alerts" href="/alerts"'), true);
check('and hardcodes no region', tpl.includes('href="/in/alerts"'), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
