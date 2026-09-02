/**
 * The second opinion on a contested tech verdict.
 *
 * IQVIA's `Intern` carried the model's own label "AI Research", off a
 * description about generative AI, LLMs and RAG pipelines — and the same model
 * answered NON-TECH in the same reply. Re-running it returned tech three times
 * out of three: `chatJson` defaults to temperature 0.2 and enrichment uses the
 * default, so the field that decides whether a listing exists was a weighted
 * coin flip, taken once, never revisited.
 */
import { classifyRole, vetoNonTech, GENERIC_POSITIVE } from '../src/roles.js';
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const cfg = loadConfig();
const src = readFileSync(new URL('../src/ollama.js', import.meta.url), 'utf8');

/** The trigger, exactly as enrichJobs computes it. */
function contested(roleLabel) {
  const c = classifyRole(roleLabel ?? '', cfg);
  return c.verdict === 'tech' && !GENERIC_POSITIVE.has(c.matched);
}

console.log('\n== THE TRIGGER IS ALLOWED TO BE NOISY, BECAUSE IT DECIDES NOTHING ==');
{
  /* These are the ten real India labels the same test, used as a FIX, would
     have got wrong on six. As a TRIGGER all ten are correct behaviour: the
     contested ones are asked about and the specialist answers. Measured live
     2 Sep — IQVIA and HARMAN came back tech, the other six non-tech. */
  check('a genuinely tech label is contested', contested('AI Research'), true);
  check('so is software testing', contested('Software Testing'), true);
  /* Noisy on purpose. `quality assurance` and `trading` are tech in a software
     context and nowhere else, so these ask the specialist and get told no. */
  check('food QA is contested too — and that is fine', contested('Food quality assurance'), true);
  check('as is commodity trading', contested('Commodity trading'), true);

  /* A GENERIC term must NOT contest. "Technical Support" and "Engineering
     Support" carry no information about the work, so asking again would spend
     a call to be told the same thing. */
  for (const label of ['Technical support', 'Engineering support', 'Engineering', 'Trainee'])
    check(`generic label does not contest: ${label}`, contested(label), false);

  check('a plainly non-tech label does not contest', contested('Payroll operations'), false);
  check('nor does an empty one', contested(''), false);
  check('nor a missing one', contested(undefined), false);
}

console.log('\n== GENERIC_POSITIVE is exported for this, and still means what it did ==');
{
  check('exported', GENERIC_POSITIVE instanceof Set, true);
  check('holds the generic multi-word pair',
    [GENERIC_POSITIVE.has('engineering intern'), GENERIC_POSITIVE.has('engineering trainee')], [true, true]);
  check('and the bare generic words', GENERIC_POSITIVE.has('engineering'), true);
  /* It must NOT swallow a specific term, or the trigger would stop firing on
     the case it was built for. */
  check('but not a specific one', GENERIC_POSITIVE.has('ai'), false);
  check('nor machine learning', GENERIC_POSITIVE.has('machine learning'), false);
}

console.log('\n== the wiring in enrichJobs ==');
{
  const fn = src.slice(src.indexOf('export async function enrichJobs'));

  /* ONLY EVER ASKED ABOUT A POSTING THE MODEL CALLED NON-TECH, so it can add
     listings and never remove them. */
  check('it only runs on a non-tech verdict',
    /if \(item\.isTech === false && Date\.now\(\) - started <= budgetMs\)/.test(fn), true);
  check('and respects the run budget, so it can never delay a listing',
    /Date\.now\(\) - started <= budgetMs/.test(fn), true);
  check('the trigger is the model contradicting its own label',
    /const label = classifyRole\(item\.roleLabel[\s\S]{0,120}?label\.verdict === 'tech' && !GENERIC_POSITIVE\.has\(label\.matched\)/.test(fn), true);

  /* classifyOne is the authority: one posting per call, a prompt that does
     nothing else, and TEMPERATURE 0 — reproducible, which the enricher is not. */
  check('it escalates to the dedicated classifier',
    /const second = await classifyOne\(job, \{ model, timeoutMs \}\)/.test(fn), true);
  check('which runs at temperature 0', /async function classifyOne[\s\S]*?temperature: 0,/.test(src), true);
  check('the specialist decides', /item\.isTech = !!second\.value\.isTech;/.test(fn), true);
  /* A model that will not answer must leave the verdict alone rather than
     defaulting either way. */
  check('an unavailable second opinion changes nothing',
    /second opinion unavailable[\s\S]{0,90}?keeping the enricher's verdict/.test(fn), true);

  /* Unconditional, like the apply-link ratio and the employer cap: a verdict
     silently going wrong is the failure this exists to catch. */
  check('the counters are reported even at zero',
    /if \(items\.length\) \{[\s\S]{0,200}?Tech verdict: \$\{contested\} contested/.test(fn), true);
}

console.log('\n== it runs BEFORE anything could have been suppressed by hand ==');
{
  /* This is the other half of the design. A retrospective sweep cannot do this
     safely: `is_tech = 0` also means "a human suppressed this", and nothing
     distinguishes the two — the HARMAN row demoted by hand for a dead apply
     page reads role_label "Software Testing", is_tech 0, role_source
     model-enrich, which is byte-identical to a model mistake. Running inside
     enrichJobs means no human decision exists yet to overrule. */
  const fn = src.slice(src.indexOf('export async function enrichJobs'));
  const opinion = fn.indexOf('const second = await classifyOne');
  const save = fn.indexOf('out.set(i, item);');
  check('the second opinion is inside enrichJobs', opinion > 0, true);
  check('and resolves before the row is handed back to be saved', opinion < save, true);
  /* The veto still gets the last word, so the specialist cannot admit something
     the vocabulary refuses. */
  check('the vocabulary veto still runs after it',
    fn.indexOf('vetoNonTech(job.title, item.roleLabel') > opinion, true);
  check('and the veto can still overrule it',
    vetoNonTech('Intern', 'Credit risk modelling', true, cfg), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
