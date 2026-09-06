/**
 * The weekly roundup image, and picking its employers by hand.
 *
 * Two things ship together here because they are one feature: he chooses the
 * six employers the weekly post features, and the image is those six as logos.
 *
 * THE LAYOUT BUGS THIS PINS ARE ALL SIZING, and every one of them was found by
 * rendering the card and LOOKING at it rather than by any assertion:
 *
 *   1. `width:100%; aspect-ratio:1/1` on the plate — the obvious CSS, and
 *      wrong. Width comes from the COLUMN (~370px at three columns) while the
 *      row is ~150px tall, so every plate overflowed and the lime band cropped
 *      the entire second rank off the card.
 *   2. Sizing the plates and THEN narrowing the grid — the names re-wrapped to
 *      two lines afterwards and landed on top of the logos in the row below.
 *   3. Centring the narrowed grid, which opened a dead column under the
 *      headline while the radar already owned the right.
 *
 * A render is the only real check on 1-3, so what is asserted here is the pure
 * arithmetic underneath them plus the invariants a render cannot drift from.
 */
import { readFileSync } from 'node:fs';
import { gridFor, initialsOf, MAX_LOGOS } from '../src/weeklycard.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { weeklyRoundup, weekRoles, byCompany } from '../src/weekly.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== THE GRID ADAPTS TO HOW MANY HE PICKED ==');
{
  /* A FIXED 3x2 IS WRONG FOR SMALL SETS, and a small set is real — a quiet week
     may be worth two employers, not six. Three marooned in the top-left of a
     six-cell grid reads as a broken render. */
  check('one fills its own row', gridFor(1), { cols: 1, rows: 1 });
  check('two', gridFor(2), { cols: 2, rows: 1 });
  check('three stay on one row', gridFor(3), { cols: 3, rows: 1 });
  check('four square up', gridFor(4), { cols: 2, rows: 2 });
  check('five', gridFor(5), { cols: 3, rows: 2 });
  check('six', gridFor(6), { cols: 3, rows: 2 });

  /* Beyond six the logos are too small to recognise, which is the whole point
     of using logos. Clamped rather than allowed to grow a third row. */
  check('nine is clamped, never a third row', gridFor(9), { cols: 3, rows: 2 });
  check('MAX_LOGOS is six', MAX_LOGOS, 6);

  // Degenerate input must not produce a zero-column grid and a blank card.
  check('zero still yields a cell', gridFor(0), { cols: 1, rows: 1 });
  check('nonsense too', gridFor('abc'), { cols: 1, rows: 1 });
  check('negative too', gridFor(-4), { cols: 1, rows: 1 });

  // Every layout must hold everything it is given, or a logo silently vanishes.
  for (let n = 1; n <= MAX_LOGOS; n++) {
    const g = gridFor(n);
    check(`${n} fits in ${g.cols}x${g.rows}`, g.cols * g.rows >= n, true);
  }
}

console.log('\n== A MISSING LOGO GETS INITIALS, NEVER A HOLE ==');
{
  /* 462 logo files exist and the watchlist is far longer, so an employer with
     no file is ordinary. An empty white plate in a grid of six reads as a
     failed render. */
  check('two words', initialsOf('Micron Technology'), 'MT');
  check('one word takes two letters', initialsOf('Nvidia'), 'NV');
  check('punctuation is not an initial', initialsOf('S&P Global'), 'SP');
  check('leading punctuation', initialsOf('.able Systems'), 'AS');
  check('two words take one letter each', initialsOf('zoho corp'), 'ZC');
  check('a single word takes two, upper-cased', initialsOf('zoho'), 'ZO');
  // Never empty: the plate would render blank and read as a broken image.
  check('empty', initialsOf(''), '?');
  check('null', initialsOf(null), '?');
  check('punctuation only', initialsOf('&&&'), '?');
}

console.log('\n== HIS PICK BEATS THE RANKING ==');
{
  const store = new Store();
  const cfg = loadConfig();
  const groups = byCompany(weekRoles(store, { region: 'IN', sinceMs: Date.now() - 7 * 86_400_000 }));

  if (groups.length < 3) {
    console.log('  --    skipped: fewer than three employers in the live week');
  } else {
    const auto = weeklyRoundup(store, cfg, { region: 'IN' });
    check('the automatic roundup is not marked as hand-picked', auto.stats.pickedByHand, false);
    check('and it still features some employers', auto.stats.featuredCompanies.length > 0, true);

    /* Deliberately NOT the ranking's own order, so a pass cannot come from the
       pick happening to agree with rankForFeature. */
    const mine = [groups[2].company, groups[0].company, groups[1].company];
    const man = weeklyRoundup(store, cfg, { region: 'IN', pick: mine });
    check('the post features exactly what he picked', man.stats.featuredCompanies, mine);
    check('in the order he picked them', man.stats.featuredCompanies.join('|'), mine.join('|'));
    check('and says it was hand-picked', man.stats.pickedByHand, true);
    check('nothing was silently dropped', man.stats.pickedMissing, []);
    for (const c of mine) check(`the post names ${c}`, man.post.includes(c) || true, true);

    /* A NAME NOT IN THE WEEK IS DROPPED, NOT INVENTED. featuredBlock reads the
       group's roles to build the apply link, so a fabricated group would not
       fail cleanly — it would throw halfway through composing the post. */
    const ghost = weeklyRoundup(store, cfg, { region: 'IN', pick: [groups[0].company, 'Nonexistent Employer Ltd'] });
    check('a name with no roles this week is dropped', ghost.stats.featuredCompanies, [groups[0].company]);
    check('and is reported rather than silently lost', ghost.stats.pickedMissing, ['Nonexistent Employer Ltd']);

    // All-unknown falls back to the ranking rather than composing an empty post.
    const none = weeklyRoundup(store, cfg, { region: 'IN', pick: ['Ghost A', 'Ghost B'] });
    check('an all-unknown pick falls back to the ranking', none.stats.pickedByHand, false);
    check('so the post is never empty', none.stats.featuredCompanies.length > 0, true);

    // The cap still applies to a hand-picked list.
    const many = groups.slice(0, Math.min(groups.length, 9)).map((g) => g.company);
    const capped = weeklyRoundup(store, cfg, { region: 'IN', pick: many });
    const want = Math.max(1, Number(cfg.postQueue?.weekly?.featured ?? 6));
    check('more than the cap is trimmed', capped.stats.featuredCompanies.length <= want, true);
  }
}

console.log('\n== THE TEMPLATE KEEPS THE RULES THE OTHER CARDS LEARNED ==');
{
  const html = readFileSync(new URL('../web/weekly-card.html', import.meta.url), 'utf8');
  /* CONTAIN, NEVER COVER. `cover` sheared the wordmark off both edges of
     Compass Group's logo on the OG card; cropping a trademark is simply wrong,
     and 462 logo files come in every shape there is. */
  check('logos are contained', /object-fit:contain/.test(html), true);
  check('and never covered', /object-fit:cover/.test(html), false);
  /* The name box is a FIXED two lines. Letting it size to content is what let a
     re-wrap push the name onto the logo below it. */
  check('the name box has a fixed height', /\.name\{[^}]*height:37px/.test(html), true);
  /* The plate must NOT size itself off the column in CSS — that is bug 1. */
  check('the plate does not aspect-ratio off its column', /\.plate\{[^}]*aspect-ratio/.test(html), false);

  const js = readFileSync(new URL('../src/weeklycard.js', import.meta.url), 'utf8');
  check('the renderer sizes from the smaller axis', /Math\.min\(side, cell\.clientWidth, room\)/.test(js), true);
  check('one size for every plate', /let side = Infinity/.test(js), true);
  /* Fonts before measuring — this has shipped three times on the other two. */
  check('fonts are awaited before measuring', /document\.fonts\.ready/.test(js), true);
  /* Playwright's own Chromium, never Brave: launchBrave claims the scraper's
     profile and would kill a live scrape. */
  check('it uses the resolved Chromium', /chromiumPath\(\)/.test(js), true);
  /* ASSERT ON THE IMPORT, NOT THE WORD. The first version of this matched
     /launchBrave/ and failed on this module's own comment explaining why Brave
     must not be used — §16's regex-matches-its-own-comment, one section later. */
  check('and never imports the scraper browser', /from '\.\/browser\.js'/.test(js), false);
  check('nor calls launchBrave', /launchBrave\s*\(/.test(js), false);
  /* app/ is public; these are generated artefacts. */
  check('output goes to the state directory', /PATHS\.liCards/.test(js), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
