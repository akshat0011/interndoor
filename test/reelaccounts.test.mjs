import { credEnvNames, accountFor, autoRegions, autoEnabled, dailyCap, autoSpacingMinutes, autoSlotConfig } from '../src/reelaccounts.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const cfg = {
  reels: {
    accounts: { US: 'interndoorusa', IN: 'interndoorin' },
    windowStartHour: 10, windowEndHour: 22, spacingMinutes: 180,
    auto: { enabled: true, regions: ['US'], dailyCap: 20, dailyCapByRegion: { US: 20, IN: 10 } },
  },
};

console.log('\n== credentials are addressed per region ==');
/* THE WHOLE POINT. The bare names are also what storygasted's .env uses for a
   different account, so with two accounts of our own the collision is no longer
   hypothetical — a region must be addressable on its own. */
check('US', credEnvNames('US').user, 'IG_USER_ID_US');
check('US token', credEnvNames('US').token, 'IG_ACCESS_TOKEN_US');
check('IN', credEnvNames('in').user, 'IG_USER_ID_IN');
check('the bare pair survives as a fallback only', credEnvNames('US').legacy,
  { user: 'IG_USER_ID', token: 'IG_ACCESS_TOKEN' });
let threw = false; try { credEnvNames('USA'); } catch { threw = true; }
check('a non-ISO region is refused', threw, true);

console.log('\n== an account is never borrowed from another region ==');
check('US', accountFor('US', cfg), 'interndoorusa');
check('IN', accountFor('IN', cfg), 'interndoorin');
// Falling back to another region's account would post one board's roles to the
// other's followers -- the same call Telegram already made for a region with
// no channel: no channel, no post.
check('an unconfigured region gets NOTHING, not a default', accountFor('GB', cfg), null);
check('and neither does an empty one', accountFor(undefined, cfg), null);

console.log('\n== which regions post automatically ==');
check('only the ones listed', autoRegions(cfg), ['US']);
check('auto is on', autoEnabled(cfg), true);
// A region listed but with no account is skipped rather than crashing a sweep.
check('a listed region with no account is dropped',
  autoRegions({ reels: { accounts: { US: 'a' }, auto: { regions: ['US', 'GB'] } } }), ['US']);
check('enabled:false stops everything',
  autoEnabled({ ...cfg, reels: { ...cfg.reels, auto: { ...cfg.reels.auto, enabled: false } } }), false);
check('no config means no posting', autoEnabled({}), false);

console.log('\n== the daily cap is the platform\'s limit, not a preference ==');
check('US', dailyCap('US', cfg), 20);
check('IN has its own', dailyCap('IN', cfg), 10);
/* Instagram allows 100 posts per rolling 24h per account, verified live. A cap
   above that is not a bigger allowance, it is the same allowance plus refusals. */
check('nothing above 100 is honoured',
  dailyCap('US', { reels: { auto: { dailyCap: 5000 } } }), 100);
check('zero disables the region', dailyCap('US', { reels: { auto: { dailyCap: 0 } } }), 0);
check('a negative is not a licence', dailyCap('US', { reels: { auto: { dailyCap: -5 } } }), 0);
check('the default is his own stated target', dailyCap('US', { reels: { auto: {} } }), 20);

console.log('\n== spacing comes from the cap, not from the manual queue ==');
/* reels.spacingMinutes is 180 and belongs to the hand-picked queue. At 180 the
   10:00-22:00 window holds four posts, so a cap of 20 would take days to
   deliver one day's roles and never catch up. */
check('12h window / 20 a day = 36 min', autoSpacingMinutes('US', cfg), 36);
check('IN\'s smaller cap spaces further', autoSpacingMinutes('IN', cfg), 72);
check('and it is NOT the manual 180', autoSpacingMinutes('US', cfg) === 180, false);
check('an explicit override wins',
  autoSpacingMinutes('US', { reels: { ...cfg.reels, auto: { ...cfg.reels.auto, spacingMinutes: 15 } } }), 15);
check('a 24h window when start == end',
  autoSpacingMinutes('US', { reels: { windowStartHour: 0, windowEndHour: 0, auto: { dailyCap: 24 } } }), 60);
check('never tighter than 5 minutes',
  autoSpacingMinutes('US', { reels: { windowStartHour: 10, windowEndHour: 11, auto: { dailyCap: 100 } } }), 5);

console.log('\n== the slot config keeps the rest of reels.* ==');
const sc = autoSlotConfig('US', cfg);
check('window survives', [sc.windowStartHour, sc.windowEndHour], [10, 22]);
check('spacing is replaced', sc.spacingMinutes, 36);

console.log('\n== the window is measured in the REGION\'s own zone ==');
/* reels.timeZone is Asia/Kolkata because the manual queue was built when India
   was the only account. 10:00-22:00 there is 23:30-11:30 in New York, so a US
   reel would have gone out while America slept -- which defeats the only reason
   a posting window exists. The HOURS are shared (they are a claim about when
   people look at their phones); only the zone changes. */
check('US posts on New York time', autoSlotConfig('US', cfg, 'America/New_York').timeZone, 'America/New_York');
check('IN keeps Kolkata', autoSlotConfig('IN', cfg, 'Asia/Kolkata').timeZone, 'Asia/Kolkata');
check('and it is NOT the shared default for US',
  autoSlotConfig('US', cfg, 'America/New_York').timeZone === cfg.reels.timeZone, false);
check('the hours themselves are unchanged',
  [autoSlotConfig('US', cfg, 'America/New_York').windowStartHour,
   autoSlotConfig('US', cfg, 'America/New_York').windowEndHour], [10, 22]);
check('an explicit per-region override still wins',
  autoSlotConfig('US', { reels: { ...cfg.reels, auto: { ...cfg.reels.auto, timeZoneByRegion: { US: 'America/Los_Angeles' } } } }, 'America/New_York').timeZone,
  'America/Los_Angeles');
check('no zone anywhere falls back to the shared one',
  autoSlotConfig('US', cfg, null).timeZone, cfg.reels.timeZone);

console.log('\n== the shipped config actually works ==');
// Asserting against config.json, not against the defaults -- a default that
// passes while the real config is broken is the failure mode this catches.
const real = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
check('every auto region has an account',
  autoRegions(real).every((r) => !!accountFor(r, real)), true);
check('every auto region has a workable cap',
  autoRegions(real).every((r) => dailyCap(r, real) > 0 && dailyCap(r, real) <= 100), true);
check('and spacing fits the day',
  autoRegions(real).every((r) => autoSpacingMinutes(r, real) * dailyCap(r, real) <= 24 * 60), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
