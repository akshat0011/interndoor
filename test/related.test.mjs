import { employerIndex, relatedEmployers } from '../src/pages.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

/* A posting shaped the way isIndexable wants one: it needs bullets to count as
   a live role, or every fixture here is silently "no live roles". */
const job = (company, skills, extra = {}) => ({
  id: `${company}-${skills.join('-')}`,
  company,
  title: `Intern ${skills[0]}`,
  location: 'Bengaluru, Karnataka, India',
  bullets: ['Build things', 'Ship things'],
  summary: 'A role.',
  keySkills: skills,
  postedAt: Date.UTC(2026, 7, 1),
  ...extra,
});

const build = (spec) => {
  const by = new Map();
  for (const [company, skills] of Object.entries(spec)) by.set(company, [job(company, skills)]);
  return employerIndex(by, new Map());
};

console.log('\n== the shape of the answer ==');
{
  const idx = build({
    Alpha: ['verilog', 'vhdl', 'rtl'],
    Beta: ['verilog', 'vhdl', 'rtl'],
    Gamma: ['ledgers', 'audit', 'tax'],
  });
  check('an employer is never related to itself',
    relatedEmployers('Alpha', idx).some((r) => r.company === 'Alpha'), false);
  check('a genuine match is returned',
    relatedEmployers('Alpha', idx).map((r) => r.company), ['Beta']);
  check('an unrelated employer is not', relatedEmployers('Gamma', idx).length, 0);
  check('an unknown company is empty, not a throw', relatedEmployers('Nobody', idx), []);
}

console.log('\n== IDF: a skill everybody names says nothing ==');
{
  /* python is in EVERY set, so its inverse document frequency is log(1) = 0.
     Without that, "both write software" would relate every employer on the
     board to every other and the block would be noise. Delta and Epsilon share
     python and nothing else. */
  const idx = build({
    Alpha: ['python', 'verilog', 'vhdl'],
    Beta: ['python', 'verilog', 'vhdl'],
    Delta: ['python', 'ledgers', 'audit'],
    Epsilon: ['python', 'brand', 'copy'],
  });
  check('a universal skill alone does not relate two employers',
    relatedEmployers('Delta', idx).map((r) => r.company), []);
  check('a rare shared skill still does',
    relatedEmployers('Alpha', idx).map((r) => r.company), ['Beta']);
}

console.log('\n== a hub that cannot be indexed is never linked to ==');
{
  /* Zeta has one past posting and no live one, so renderCompanyPage marks it
     noindex. Linking to it would spend a link on a page that cannot rank and
     drop the reader on an empty one.

     THE FILLER EMPLOYERS ARE LOAD-BEARING, and finding that out is worth the
     note: with only Alpha and Zeta on the board, verilog appears in 100% of
     the sets, its inverse document frequency is log(1) = 0, and NOTHING is
     related to anything. That is the weighting behaving correctly — a skill
     everyone names cannot distinguish anyone — but it means a fixture has to
     carry employers who do NOT share the skill under test. */
  const filler = {
    Filler1: [['ledgers', 'audit', 'tax']],
    Filler2: [['brand', 'copy', 'social']],
    Filler3: [['nursing', 'triage', 'charting']],
  };
  const withFiller = (extra) => {
    const by = new Map(Object.entries(filler).map(([c, [sk]]) => [c, [job(c, sk)]]));
    by.set('Alpha', [job('Alpha', ['verilog', 'vhdl', 'rtl'])]);
    return employerIndex(by, extra);
  };

  const past1 = new Map([['Zeta', [job('Zeta', ['verilog', 'vhdl', 'rtl'])]]]);
  check('one past role only -> not linked',
    relatedEmployers('Alpha', withFiller(past1)).map((r) => r.company), []);

  const past2 = new Map([['Zeta', [
    job('Zeta', ['verilog', 'vhdl', 'rtl']),
    job('Zeta', ['verilog', 'vhdl', 'rtl'], { title: 'Second role' }),
  ]]]);
  check('two past roles -> linked',
    relatedEmployers('Alpha', withFiller(past2)).map((r) => r.company), ['Zeta']);
}

console.log('\n== deterministic, and capped ==');
{
  const spec = { Alpha: ['verilog', 'vhdl', 'rtl'] };
  /* INSERTED IN DESCENDING ORDER ON PURPOSE. A Map iterates in insertion order,
     so building these ascending made the "ties break on the name" assertion
     pass whether or not the tiebreak existed — it was asserting nothing, and a
     mutation run is what exposed it. Descending, the sort has to do real work. */
  for (let i = 13; i >= 0; i--) spec[`Co${String(i).padStart(2, '0')}`] = ['verilog', 'vhdl', 'rtl'];
  // Same reason as above: without employers who do not share them, verilog and
  // vhdl are universal, weigh nothing, and nobody is related to anybody.
  for (let i = 0; i < 6; i++) spec[`Other${i}`] = [`craft${i}`, `trade${i}`, `art${i}`];
  const idx = build(spec);
  const a = relatedEmployers('Alpha', idx).map((r) => r.company);
  const b = relatedEmployers('Alpha', idx).map((r) => r.company);
  check('two identical calls agree', a, b);
  check('capped at 8', a.length, 8);
  /* Every rival here scores identically, so only the name tiebreak decides.
     Without it the order would follow Map insertion and a list could reshuffle
     between two otherwise identical publishes — churn dressed as content. */
  check('ties break on the name', a, [...a].sort());
  check('limit is honoured', relatedEmployers('Alpha', idx, 3).length, 3);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
