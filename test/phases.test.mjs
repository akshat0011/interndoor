/**
 * A scheduled run is two scans since 26 Sep 2026 — the home region first, then
 * everything else — so India's new roles are published before the US walk and
 * its enrichment instead of 20-47 minutes after the run began.
 */
import { readFileSync } from 'node:fs';
import { scopeSearches } from '../src/searches.js';
import { alertOnSessionLoss, SESSION_ALERT_KEY } from '../src/sessionalert.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== which searches a phase walks ==');
{
  const S = [{ region: 'IN', label: 'IN' }, { region: 'IN', label: 'IN entry-level' }, { region: 'US', label: 'US' }, { label: 'no region' }];
  const names = (x) => x.map((s) => s.label);
  check('no scope is every search (a hand-run scan)', names(scopeSearches(S, null)), ['IN', 'IN entry-level', 'US', 'no region']);
  check('an empty scope is every search too', names(scopeSearches(S, '')), ['IN', 'IN entry-level', 'US', 'no region']);
  check('home is the home region, both of its searches', names(scopeSearches(S, 'home', 'IN')), ['IN', 'IN entry-level', 'no region']);
  check('-home is everything else', names(scopeSearches(S, '-home', 'IN')), ['US']);
  check('the two phases cover every search exactly once',
    [...names(scopeSearches(S, 'home', 'IN')), ...names(scopeSearches(S, '-home', 'IN'))].sort(), names(S).sort());
  check('home follows the configured home region', names(scopeSearches(S, 'home', 'US')), ['US']);
  check('explicit codes, any case', names(scopeSearches(S, 'us')), ['US']);
  check('and exclusions', names(scopeSearches(S, '-IN,US')), []);
}

console.log('\n== one sign-out alert marker per phase ==');
{
  const settings = new Map();
  const store = { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => settings.set(k, String(v)) };
  const pushes = [];
  const push = async (...a) => { pushes.push(a); return true; };
  await alertOnSessionLoss(store, { sessionExpired: true, regions: ['US'], push, now: () => 1000, scope: '-home' });
  check('the rest phase alerts once about the US account', pushes.length, 1);
  check('into its own marker', [settings.get(`${SESSION_ALERT_KEY}:-home`), settings.get(SESSION_ALERT_KEY)], ['1000', undefined]);
  const r = await alertOnSessionLoss(store, { healthy: true, push, now: () => 2000, scope: 'home' });
  check('a healthy home phase does NOT clear the rest phase\'s marker', [r, settings.get(`${SESSION_ALERT_KEY}:-home`)], ['skipped', '1000']);
  await alertOnSessionLoss(store, { sessionExpired: true, regions: ['US'], push, now: () => 1000 + 30 * 60_000, scope: '-home' });
  check('so the dead US account is not pushed again half an hour later', pushes.length, 1);
  await alertOnSessionLoss(store, { healthy: true, push, now: () => 5000, scope: '-home' });
  check('its own healthy run re-arms it', settings.get(`${SESSION_ALERT_KEY}:-home`), '');
  await alertOnSessionLoss(store, { sessionExpired: true, push, now: () => 9000 });
  check('an unscoped run keeps the old marker', settings.get(SESSION_ALERT_KEY), '9000');
}

console.log('\n== the wiring ==');
{
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const sh = readFileSync(new URL('../bin/run.sh', import.meta.url), 'utf8');
  check('the scan takes its scope from --regions', /const REGION_SCOPE = \[\.\.\.ARGS\]\.map\(\(a\) => a\.match\(\/\^--regions=\(\.\+\)\$\/\)/.test(idx), true);
  check('and walks only that scope', /const allSearches = scopeSearches\(resolveSearches\(cfg\), REGION_SCOPE, homeScope\);/.test(idx), true);
  check('a phased run leaves the rotation cursor alone',
    /const cursor = DRY_RUN \|\| REGION_SCOPE \? 0 :/.test(idx) && /if \(!DRY_RUN && !REGION_SCOPE && allSearches\.length > 0\) \{/.test(idx), true);
  check('the alert is told its phase', /enabled: cfg\.notifications\?\.onError !== false,\s*scope: REGION_SCOPE,/.test(idx), true);
  check('the rest phase skips a deploy only when it found nothing new',
    /const skipPublish = restPhase && newJobs\.length === 0;/.test(idx) && /DRY_RUN \|\| skipPublish \? null : await publish\(/.test(idx), true);
  check('the rest phase is the one that excludes the home region',
    /const restPhase = Boolean\(REGION_SCOPE\) && !scopeSearches\(\[\{ region: homeScope \}\], REGION_SCOPE, homeScope\)\.length;/.test(idx), true);
  const home = sh.indexOf('--regions=home'), rest = sh.indexOf('--regions=-home');
  check('the scheduler runs the home board first, then the rest', home > 0 && rest > home, true);
  check('a home phase with no network skips the rest', /if \[ "\$STATUS" -ne 75 \]; then\s*"\$NODE"[^\n]*--regions=-home/.test(sh), true);
  check('the rest phase\'s 75 never asks for a fast retry of both',
    /if \[ "\$STATUS" -eq 0 \] && \[ "\$REST_STATUS" -ne 75 \]; then STATUS=\$REST_STATUS; fi/.test(sh), true);
  check('the scan is no longer run once for every region', (sh.match(/src\/index\.js" "\$@"/g) ?? []).length, 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
