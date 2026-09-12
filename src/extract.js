/**
 * Pulling structured facts out of free-text job descriptions.
 * Everything here is offline and deterministic — no API calls, no key required.
 */

const CURRENCY_SYMBOLS = {
  '₹': 'INR', 'rs': 'INR', 'rs.': 'INR', 'inr': 'INR',
  '$': 'USD', 'usd': 'USD', 'us$': 'USD',
  '€': 'EUR', 'eur': 'EUR',
  '£': 'GBP', 'gbp': 'GBP',
  '¥': 'JPY', 'jpy': 'JPY',
  'aed': 'AED', 'sgd': 'SGD', 'cad': 'CAD', 'aud': 'AUD',
};

const PERIOD_PATTERNS = [
  [/\b(per\s+month|\/\s*month|\/\s*mo\b|p\.?m\.?\b|monthly|a\s+month)/i, 'month'],
  [/\b(per\s+hour|\/\s*hour|\/\s*hr\b|hourly|an\s+hour)/i, 'hour'],
  [/\b(per\s+week|\/\s*week|\/\s*wk\b|weekly|a\s+week)/i, 'week'],
  [/\b(per\s+year|\/\s*year|\/\s*yr\b|annually|per\s+annum|p\.?a\.?\b|lpa|yearly)/i, 'year'],
  [/\b(per\s+day|\/\s*day|daily|a\s+day)/i, 'day'],
  // THE WORD "stipend" IS NOT A PERIOD, AND IT USED TO BE LISTED HERE AS ONE.
  // It is the commonest MONEY_KEYWORD there is, so "Internship stipend -
  // ₹15,000." — a line that states no period at all — was read as a claim that
  // ₹15,000 is the WHOLE payment, and the card rendered "₹15,000 / total" for a
  // role paying that every month. The month/hour/week/year rules run first, so
  // this only ever fired on postings that named a figure and no period: exactly
  // the case where we know nothing and must say nothing. `total` and
  // `lump sum` are real claims an employer makes and are kept.
  [/\b(total|lump\s*sum)\b/i, 'total'],
];

/** A bare number with optional scale suffix: "1,20,000", "25k", "1.5 lakh", "12 LPA". */
const AMOUNT = String.raw`\d[\d,]*(?:\.\d+)?(?:\s*(?:k|lakhs?|lac|lpa|cr(?:ore)?s?|million|mn)\b)?`;
/** A leading currency marker: "₹", "$", "INR ", "Rs. ". */
const CURRENCY = String.raw`[₹$€£¥]|\b(?:inr|usd|eur|gbp|jpy|aed|sgd|cad|aud|rs)\b\.?\s*`;

/**
 * "1,20,000" / "25k" / "1.5 lakh" / "12 LPA" -> a number.
 * Also reports whether a scale suffix was applied, which is what lets us trust
 * a small figure like "50k" while rejecting a stray "3".
 */
function parseAmount(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/,/g, '').trim();

  let multiplier = 1;
  if (/\b(lakhs?|lac|lpa)\b/.test(s)) multiplier = 100_000;
  else if (/\bcr(ore)?s?\b/.test(s)) multiplier = 10_000_000;
  else if (/\b(million|mn)\b/.test(s)) multiplier = 1_000_000;
  else if (/\d\s*k\b/.test(s)) multiplier = 1_000;

  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const value = parseFloat(m[1]) * multiplier;
  if (!Number.isFinite(value)) return null;
  return { value, scaled: multiplier > 1 };
}

/**
 * Period and currency are read from a narrow window around the figure rather
 * than the whole line, so "₹40,000 per month" in a paragraph that also mentions
 * an annual bonus does not get mislabelled.
 */
function windowAround(line, index, length, span = 90) {
  return line.slice(Math.max(0, index - span), Math.min(line.length, index + length + span));
}

function detectPeriod(context) {
  for (const [re, period] of PERIOD_PATTERNS) {
    if (re.test(context)) return period;
  }
  return null;
}

function detectCurrency(context) {
  const lower = context.toLowerCase();
  // Symbols are unambiguous; check them before three-letter codes.
  for (const sym of ['₹', '$', '€', '£', '¥']) {
    if (lower.includes(sym)) return CURRENCY_SYMBOLS[sym];
  }
  for (const [token, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (/^[a-z]/.test(token) && new RegExp(`\\b${token.replace('.', '\\.')}`).test(lower)) return code;
  }
  // "12 LPA" implies rupees even with no explicit currency marker.
  if (/\b(lpa|lakhs?|lac|crore)\b/.test(lower)) return 'INR';
  return null;
}

/**
 * A period stated NEAR the figure but not on its own LINE — 12 Sep 2026.
 *
 * MEASURED FIRST: 1,313 live US rows carry a figure and no period, so none of
 * them can become `baseSalary`, and the URL Inspection API warns
 * `Missing field "baseSalary"` on every US page it checked. The postings do
 * state it — ATS descriptions simply break the line between the two:
 *
 *     Salary ranges for U.S (excl. PR) locations (USD):$26.50-$45.25
 *
 *     ... The Medtronic Internship Program offers an hourly rate of pay ...
 *
 * `windowAround` cannot see that, because it is scoped to the line. This looks
 * at the surrounding TEXT, and only when the figure's own line said nothing.
 *
 * THREE THINGS KEEP IT HONEST, each answering a bug this file has already had:
 *
 *  - **THE MAGNITUDE MUST FIT THE PERIOD.** "$48,100 – $86,950" next to the
 *    word "hourly" is refused. That is the Intel 76,398-per-hour row §11
 *    documents, arriving from a new direction, and `safeBaseSalary` would catch
 *    it later anyway — but the DISPLAY string would already have shipped.
 *  - **`total` AND `lump sum` ARE NEVER SEARCHED FOR HERE.** They are claims
 *    about the whole payment, and "total compensation" in a neighbouring
 *    paragraph is not one. The same-line rule still reads them.
 *  - **CLOSEST WINS, NOT FIRST IN THE LIST.** A benefits paragraph mentioning
 *    an annual bonus must never outrank "per hour" sitting beside the figure.
 */
const NEARBY_SPAN = 220;

/**
 * THE NEARBY SEARCH GETS ITS OWN, STRICTER PATTERNS, AND THE FIRST DRAFT PROVED
 * WHY. `PERIOD_PATTERNS` survives on a LINE because the figure is right there;
 * across 220 characters of neighbouring prose it reads anything shaped like a
 * period. Re-derived over all 6,799 stored descriptions, the loose list gained
 * 183 rows and two of the first dozen read by hand were wrong:
 *
 *   D Square  "Stipend: ₹10,000 (Fixed) … Timings: 9:30 AM to 6:30 PM"
 *             -> `p.m.` matched SIX THIRTY PM and called the stipend monthly.
 *   Cohere    "$500 home office stipend to set up your workspace"
 *             -> a stray "day" nearby made a one-off equipment budget $500/day.
 *
 * Both happened to be findable only because the change was measured against the
 * real corpus and the results were READ. So a period out here has to be part of
 * a pay phrase — "per hour", "hourly rate", "annualized" — never a bare unit, a
 * clock time, or a duration. `p.m.`, `p.a.`, `/mo` and bare `daily` are gone.
 */
const NEARBY_PERIOD_PATTERNS = [
  [/\b(?:per\s+hour|an\s+hour|hourly\s+(?:rate|pay|wage|salary|range)|(?:rate|pay|wage|salary|range)\s+per\s+hour)\b/i, 'hour'],
  [/\b(?:per\s+month|a\s+month|monthly\s+(?:stipend|salary|pay|rate|wage))\b/i, 'month'],
  /* WEEK CARRIES TWO TRAPS, BOTH FROM ONE EMPLOYER'S REAL POSTINGS.
     Formlabs writes "you will always be paid based on the assumed 40 HOURS PER
     WEEK as a full-time intern" a line above the figure — a working-hours
     statement, not a pay period — and posts both "The weekly pay range for this
     role is" and "The BI-WEEKLY pay range…". Reading either as `week` publishes
     a fortnightly range as a weekly one and doubles the implied rate; schema.org
     has no bi-weekly unit, so the honest answer there is no period at all.
     Fifteen live rows sat in one shape or the other. */
  [/(?<!\bhours?\s)(?<!\bhrs?\s)\b(?:per\s+week|a\s+week|(?<!bi[-\s]?)weekly\s+(?:stipend|salary|pay|rate|wage))\b/i, 'week'],
  [/\b(?:per\s+year|per\s+annum|annualized|annualised|annually|yearly\s+(?:salary|pay|rate|compensation)|annual\s+(?:salary|pay|rate|base|compensation))\b/i, 'year'],
  [/\b(?:per\s+day|daily\s+(?:rate|stipend|allowance))\b/i, 'day'],
];

function periodNearby(haystack, index, length, max) {
  const from = Math.max(0, index - NEARBY_SPAN);
  const text = haystack.slice(from, Math.min(haystack.length, index + length + NEARBY_SPAN));
  const at = index - from;
  let best = null;
  for (const [re, period] of NEARBY_PERIOD_PATTERNS) {
    const rx = new RegExp(re.source, 'gi');
    for (let m = rx.exec(text); m; m = rx.exec(text)) {
      const distance = Math.max(0, m.index < at ? at - (m.index + m[0].length) : m.index - (at + length));
      if (!best || distance < best.distance) best = { period, distance };
    }
  }
  if (!best) return null;
  const bounds = SALARY_BOUNDS[best.period];
  if (!bounds || !(max >= bounds[0] && max <= bounds[1])) return null;
  return best.period;
}

const MONEY_KEYWORD = /\b(stipend|salary|compensation|remuneration|pay|payment|paid|ctc|package|honorarium)\b/i;
const CURRENCY_HINT = /[₹$€£¥]|\b(inr|usd|eur|gbp|rs|lpa|lakhs?|lac|crore)\b/i;

/**
 * Money that is emphatically not the candidate's.
 *
 * Company blurbs are full of large currency figures — "received more than $410
 * million in funding" got published as a $410,000,000 intern stipend before this
 * existed. A line matching any of these is not a compensation line.
 */
const NOT_COMPENSATION = /\b(funding|funded|valuation|valued|raised|raising|investors?|investment|revenue|turnover|arr|gmv|market\s+cap|series\s+[a-f]\b|acquisition|acquired|profit|assets under management|aum|portfolio|transactions?|processed|donat|grant|referral|referred|refer\s+a\s+friend)\b/i;

/** A stipend must be quoted against a period, or be a plausible one-off. */
const PERIOD_HINT = /\b(per|\/|monthly|weekly|yearly|annually|annum|month|week|year|hour|day|pm\b|pa\b|lpa)\b/i;

/**
 * Nothing an intern is paid runs to a crore as an unqualified lump sum. A
 * figure this large with no period attached is a company statistic, not pay.
 */
const IMPLAUSIBLE_LUMP = 10_000_000;

/**
 * Find stipend/salary in text. Prefers an explicit range, then a figure with a
 * currency marker, then a bare figure on a line that talks about money.
 * Returns null when nothing credible is found — a wrong number is worse than
 * no number.
 *
 * Splits on newlines only. An earlier version also split on sentence
 * boundaries, which broke "Rs. 15,000" in half at the abbreviation's full stop.
 */
export function extractStipend(...texts) {
  const haystack = texts.filter(Boolean).join('\n');
  if (!haystack) return null;

  const candidates = [];

  /* The offset of each line in the haystack. `periodNearby` reads ACROSS line
     breaks, so it needs where this line sits, not just the line. */
  const lines = haystack.split('\n');
  const lineAt = [];
  for (let i = 0, o = 0; i < lines.length; i += 1) { lineAt.push(o); o += lines[i].length + 1; }

  for (const [lineNo, line] of lines.entries()) {
    const from = lineAt[lineNo];
    if (line.length > 2000) continue; // Runaway line; not worth scanning.

    // Funding, valuation and revenue figures are the single biggest source of
    // wrong stipends. Drop those lines before looking for numbers at all.
    if (NOT_COMPENSATION.test(line)) continue;

    const hasKeyword = MONEY_KEYWORD.test(line);
    if (!hasKeyword && !CURRENCY_HINT.test(line)) continue;
    const hasPeriod = PERIOD_HINT.test(line);

    // 1. An explicit range: "₹20,000 - ₹40,000", "$25 to $45".
    const range = new RegExp(
      `(?:${CURRENCY})?\\s*(${AMOUNT})\\s*(?:-|–|—|to|up\\s*to)\\s*(?:${CURRENCY})?\\s*(${AMOUNT})`,
      'i',
    ).exec(line);
    if (range) {
      const min = parseAmount(range[1]);
      const max = parseAmount(range[2]);
      const ctx = windowAround(line, range.index, range[0].length);
      // A "3 - 6 months" style range is a duration, not money.
      const credible = min && max && max.value >= min.value
        && (min.scaled || max.scaled || CURRENCY_HINT.test(ctx) || min.value >= 1000);
      if (credible) {
        candidates.push({
          min: min.value, max: max.value,
          currency: detectCurrency(ctx),
          period: detectPeriod(ctx) ?? periodNearby(haystack, from + range.index, range[0].length, max.value),
          raw: range[0].trim(), score: hasKeyword ? 4 : 3,
        });
        continue;
      }
    }

    // 2. A figure carrying a currency marker: "₹30,000", "Rs. 15,000".
    // A currency symbol on its own is not evidence of pay — the line must also
    // either talk about compensation or quote a period.
    const withCurrency = (hasKeyword || hasPeriod)
      ? new RegExp(`(${CURRENCY})\\s*(${AMOUNT})`, 'i').exec(line)
      : null;
    if (withCurrency) {
      const amount = parseAmount(withCurrency[2]);
      if (amount && (amount.scaled || amount.value >= 10)) {
        const ctx = windowAround(line, withCurrency.index, withCurrency[0].length);
        candidates.push({
          min: amount.value, max: amount.value,
          currency: detectCurrency(ctx),
          period: detectPeriod(ctx) ?? periodNearby(haystack, from + withCurrency.index, withCurrency[0].length, amount.value),
          raw: withCurrency[0].trim(), score: hasKeyword ? 3 : 2,
        });
        continue;
      }
    }

    // 3. A bare figure, but only on a line that is explicitly about money:
    //    "Stipend: 50k per month", "CTC 12 LPA".
    if (!hasKeyword && !/\b(lpa|lakhs?|lac|crore)\b/i.test(line)) continue;
    const bare = new RegExp(`(${AMOUNT})`, 'i').exec(line);
    if (bare) {
      const amount = parseAmount(bare[1]);
      // Unscaled small integers on a money line are usually counts
      // ("2 rounds", "3 interns"), so require a scale suffix or a real figure.
      if (amount && (amount.scaled || amount.value >= 1000)) {
        const ctx = windowAround(line, bare.index, bare[0].length);
        candidates.push({
          min: amount.value, max: amount.value,
          currency: detectCurrency(ctx),
          period: detectPeriod(ctx) ?? periodNearby(haystack, from + bare.index, bare[0].length, amount.value),
          raw: bare[0].trim(), score: 1,
        });
      }
    }
  }

  const plausible = candidates.filter(
    (c) => c.period || c.max < IMPLAUSIBLE_LUMP,
  );
  if (!plausible.length) return null;

  plausible.sort((a, b) => b.score - a.score || b.max - a.max);
  const best = plausible[0];
  return { min: best.min, max: best.max, currency: best.currency, period: best.period, raw: best.raw };
}

/** Human-readable stipend string for the report. */
export function formatStipend(stipend) {
  // Callers pass rows straight from the database, where these columns are null
  // whenever no figure was found.
  if (!stipend || stipend.min == null || stipend.max == null) return null;
  const sym = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[stipend.currency] ?? (stipend.currency ? `${stipend.currency} ` : '');
  const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const amount = stipend.min === stipend.max ? `${sym}${fmt(stipend.min)}` : `${sym}${fmt(stipend.min)} – ${sym}${fmt(stipend.max)}`;
  return stipend.period ? `${amount} / ${stipend.period}` : amount;
}

/**
 * A stipend safe to publish as schema.org `baseSalary`, or null.
 *
 * GOOGLE READS THIS FIELD AND WRONG STRUCTURED DATA RISKS A MANUAL ACTION ON
 * THE WHOLE DOMAIN, which is the risk `jobPostingLd` is written around. Search
 * Console reported `baseSalary` missing on 218 of 218 valid job postings, and
 * it is one of the fields Google's job experience ranks and enriches on — but
 * the stipend columns are dirty enough that emitting them unfiltered would be
 * worse than emitting nothing. Measured over 2,334 live rows on 6 Sep 2026:
 *
 *   1,423  carry a figure at all
 *   1,416  of those are positive
 *   1,399  also name a currency
 *     935  also name a usable period
 *     654  also have salary_text, i.e. the POSTING stated it
 *     635  also survive the magnitude bounds        <- what this returns
 *
 * THE TWO GATES THAT MATTER, both measured rather than assumed:
 *
 * - `salary_text` MUST be present. It is what the posting itself displayed, so
 *   it is the evidence the figure was stated rather than derived. This is the
 *   same rule `groundEnrichment` applies to every other field: an invented
 *   stipend sends a student to an application they are not eligible for, and
 *   `stipendStatus` is already a standing example of a field too invented to
 *   render.
 * - THE MAGNITUDE MUST FIT THE PERIOD, because the period is frequently wrong.
 *   Intel rows carry 76,398-95,702 tagged `hour` with a salary_text of "₹0",
 *   and Charles Schwab carries 30.5 tagged `year` from a salary_text of
 *   "$30.50/yr" — LinkedIn's own mislabel of an hourly rate. Without this bound
 *   the site would publish "$95,702 per hour" and "$30.50 per year" as
 *   structured data about named employers.
 *
 * Bounds are deliberately currency-agnostic and wide: they exist to catch an
 * order-of-magnitude period error, not to judge whether a wage is fair.
 */
const SALARY_BOUNDS = {
  hour: [1, 500],
  day: [10, 5_000],
  week: [50, 20_000],
  month: [100, 500_000],
  year: [1_000, 10_000_000],
};

export function safeBaseSalary(stipend) {
  if (!stipend) return null;
  const { min, max, currency, period, text } = stipend;

  // The posting has to have said it. See above.
  if (!String(text ?? '').trim()) return null;

  const lo = Number(min);
  const hi = Number(max ?? min);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo <= 0 || hi < lo) return null;

  const ccy = String(currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(ccy)) return null;

  const unit = String(period ?? '').trim().toLowerCase();
  const bounds = SALARY_BOUNDS[unit];
  if (!bounds) return null;
  if (hi < bounds[0] || hi > bounds[1]) return null;

  return { currency: ccy, min: lo, max: hi, unitText: unit.toUpperCase() };
}

/** "6 months", "Summer 2026", "3-6 month internship". */
export function extractDuration(...texts) {
  const haystack = texts.filter(Boolean).join('\n');
  const patterns = [
    /\b(\d+\s*(?:-|–|to)\s*\d+)\s*(month|week|year)s?\b/i,
    /\b(\d+)\s*(month|week|year)s?\s*(?:long\s*)?(?:internship|program|duration|contract|term)/i,
    /\b(?:duration|length|period)\s*[:\-–]?\s*(\d+\s*(?:-|–|to)?\s*\d*)\s*(month|week|year)s?/i,
    /\b(\d+)\s*(month|week)s?\b/i,
    /\b(summer|winter|spring|fall|autumn)\s*(20\d\d)\b/i,
  ];
  for (const re of patterns) {
    const m = haystack.match(re);
    if (!m) continue;

    // Build from the capture groups, never from m[0]. The whole match drags in
    // whatever the pattern needed as context — the label in
    // "Duration: 3 Months", the trailing noun in "6 months internship" — and
    // that is what ends up rendered on the card. Only the amount and the unit
    // are the answer.
    if (/^(?:summer|winter|spring|fall|autumn)$/i.test(m[1])) {
      return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
    }

    const amount = m[1].replace(/\s+/g, '').replace(/(to)/i, ' to ').trim();
    const unit = m[2].toLowerCase();
    return `${amount} ${amount === '1' ? unit : `${unit}s`}`;
  }
  return null;
}

// Bare "go" and "r" are deliberately absent: `\bgo\b` and `\br\b` fire on
// ordinary prose ("ready to go", "R&D") far more often than on the languages.
const SKILL_VOCAB = [
  'python', 'java', 'javascript', 'typescript', 'c++', 'c#', 'golang', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'matlab', 'sql',
  'react', 'react native', 'next.js', 'vue', 'angular', 'svelte', 'node.js', 'express', 'django', 'flask', 'fastapi', 'spring boot', 'springboot', 'spring framework', '.net', 'rails',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'jenkins', 'ci/cd', 'linux', 'git',
  'machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow', 'scikit-learn', 'pandas', 'numpy', 'llm', 'generative ai', 'rag',
  'mongodb', 'postgresql', 'mysql', 'redis', 'kafka', 'elasticsearch', 'graphql', 'rest api', 'microservices',
  /* ORDER IS LOAD-BEARING BECAUSE OF THE 14-SKILL CAP BELOW. `found` is a Set,
     so it preserves this order, and `slice(0, 14)` therefore drops whatever is
     listed LAST. Measured: 34 stored postings match more than 14 terms, and
     with this block after the generic tail four of them lost the specialist
     term that made them distinguishable — IBM's "Hardware Developer Intern"
     kept python and java and lost `signal integrity, tcl, perl`. The generic
     tail is what a reader can afford to lose; a specialist term is not. */
  /* HARDWARE AND EDA. This list was 69 web/data/cloud terms and nothing else,
     while the watchlist is heavy on Qualcomm, Micron, Cadence, Synopsys,
     MediaTek, Broadcom, onsemi and Infineon — so a Marvell "Design
     Verification Intern" extracted as [python, java, c++] and a "Physical
     Design Engineer Intern" as [python] alone. Those roles were being filed
     onto /skills/python (782 roles, a head term this site cannot rank for)
     instead of the low-competition niches that are the only facets measured to
     convert: /us/skills/rust took 1 click from 2 impressions while
     /us/skills/machine-learning took 0 from 39.

     EVERY TERM HERE WAS COUNTED AGAINST THE STORE AND ITS CONTEXT READ BEFORE
     BEING ADDED, and four candidates were REFUSED on that evidence:
       eda       61 hits, every sample "Exploratory Data Analysis"
       soc       51 hits, includes a military Security Operations Center
       assembly  66 hits, all physical — device assembly, weldment drawings
       semiconductor  an industry, not a skill; it would make a facet of 229
                      roles that says nothing about the work
     `vivado` and `quartus` are absent because they matched ZERO rows — an
     untested entry is surface, not coverage. */
  'verilog', 'systemverilog', 'vhdl', 'uvm', 'rtl', 'fpga', 'asic', 'dft',
  'physical design', 'design verification', 'place and route', 'signal integrity', 'mixed signal',
  'cuda', 'rtos', 'embedded c', 'pcb', 'tcl', 'perl', 'labview', 'simulink', 'altium', 'opencv',
  'i2c', 'spi', 'uart', 'can bus', 'autosar',
  'data structures', 'algorithms', 'system design', 'oop', 'agile', 'figma', 'tableau', 'power bi', 'excel',
];

/** Which known technologies does this description mention? */
export function extractSkills(...texts) {
  const haystack = texts.filter(Boolean).join('\n').toLowerCase();
  if (!haystack) return [];
  const found = new Set();
  for (const skill of SKILL_VOCAB) {
    // Escape regex metacharacters (c++, .net, ci/cd, next.js).
    const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^[a-z0-9]/.test(skill) ? `\\b${esc}` : esc;
    if (new RegExp(`${boundary}${/[a-z0-9]$/.test(skill) ? '\\b' : ''}`, 'i').test(haystack)) {
      found.add(skill);
    }
  }
  // Prefer the more specific of overlapping pairs.
  if (found.has('react native')) found.delete('react');
  /* `springboot` and `spring framework` are spellings of `spring boot`, not
     separate technologies, so they collapse into it rather than showing a
     reader three chips for one framework. */
  if (found.has('springboot')) { found.delete('springboot'); found.add('spring boot'); }
  if (found.has('spring framework')) { found.delete('spring framework'); found.add('spring boot'); }
  /* RTL is the level Verilog and VHDL describe, and postings name it alongside
     them ("RTL (SystemVerilog/Verilog/VHDL)"). Keeping both is not a duplicate:
     a posting can ask for RTL design without naming a language. */
  return [...found].slice(0, 14);
}

/**
 * Degree names, longest first so "B.Tech" wins before a bare "B" pattern could
 * match, and so "Bachelor" is only reached when no specific qualification is named.
 */
const DEGREE_PATTERNS = [
  [/\bb\.?\s?tech\b/i, 'B.Tech'],
  [/\bm\.?\s?tech\b/i, 'M.Tech'],
  // Case-sensitive, and no /i. "B.E" and "M.E" without it match the ordinary English
  // words "be" and "me" — a Stripe posting saying "will be used in production" was
  // read as requiring a B.E. Degree abbreviations are always written uppercase.
  [/\bB\.?\s?E\.?(?![a-zA-Z])/, 'B.E'],
  [/\bM\.?\s?E\.?(?![a-zA-Z])/, 'M.E'],
  [/\bb\.?\s?sc\b/i, 'B.Sc'],
  [/\bm\.?\s?sc\b/i, 'M.Sc'],
  [/\bb\.?\s?com\b/i, 'B.Com'],
  [/\bm\.?\s?com\b/i, 'M.Com'],
  [/\bbca\b/i, 'BCA'],
  [/\bmca\b/i, 'MCA'],
  [/\bbba\b/i, 'BBA'],
  [/\bmba\b/i, 'MBA'],
  // Same trap: "BA", "MA" and "CA" are all common words in lower case.
  [/\bB\.?\s?A\.?(?![a-zA-Z])/, 'BA'],
  [/\bM\.?\s?A\.?(?![a-zA-Z])/, 'MA'],
  [/\bph\.?\s?d\b/i, 'PhD'],
  [/\bCMA\b/, 'CMA'],
  [/\bCA\b(?!\w)/, 'CA'],
  [/\bdiploma\b/i, 'Diploma'],
  // Generic levels are matched alongside the specific degrees, not as a fallback
  // after them. "Bachelor's/Master's/PhD in CS" must not reduce to "PhD" just
  // because PhD is in the specific list — that reads as "a doctorate is required".
  [/\bbachelor|\bunder\s?graduate/i, "Bachelor's"],
  [/\bmaster|\bpost\s?graduate/i, "Master's"],
];

/**
 * Named qualifications that make a generic level redundant: "B.Tech or any
 * bachelor's degree" says bachelor twice.
 *
 * PhD is deliberately absent from the master's set. A doctorate is a different
 * level, not a master's, so "Bachelor's/Master's/PhD" must keep its Master's.
 */
const UG_DEGREES = new Set(['B.Tech', 'B.E', 'B.Sc', 'B.Com', 'BCA', 'BBA', 'BA', 'Diploma']);
const PG_DEGREES = new Set(['M.Tech', 'M.E', 'M.Sc', 'M.Com', 'MCA', 'MBA', 'MA']);

/**
 * Reduce a qualification phrase to the degree name alone.
 *
 * The model is asked for just the degree, but it reliably volunteers the field of
 * study too — "B.E/B.Tech CS or IT", "bachelor's degree in Computer Science". The
 * field is noise on a card: the reader already knows they are looking at engineering
 * roles, and "B.Tech" is the fact that decides whether they are eligible.
 *
 * Returns '' when nothing recognisable is named, which the card treats as "not stated"
 * rather than printing something misleading.
 */
export function normaliseDegree(text) {
  if (!text || typeof text !== 'string') return '';

  const found = [];
  for (const [pattern, name] of DEGREE_PATTERNS) {
    const m = text.match(pattern);
    if (m && !found.some((f) => f.name === name)) found.push({ name, at: m.index });
  }

  if (!found.length) return '';

  // "B.Tech or any bachelor's degree" names the same level twice. Keep the specific
  // one and drop the generic, but only for the level that is actually duplicated —
  // in "B.Tech or Master's" the Master's is new information and must survive.
  const names = new Set(found.map((f) => f.name));
  const drop = new Set();
  if ([...names].some((n) => UG_DEGREES.has(n))) drop.add("Bachelor's");
  if ([...names].some((n) => PG_DEGREES.has(n))) drop.add("Master's");

  const kept = found.filter((f) => !drop.has(f.name));
  if (!kept.length) return '';

  // Keep the order the posting used — "B.E/B.Tech" reads as written, not reshuffled.
  // Two is already a mouthful in a chip; beyond that the qualification stops being
  // the point. "B.E/B.Tech" is useful, "B.E/B.Tech/B.Sc/BCA" is not.
  return kept.sort((a, b) => a.at - b.at).slice(0, 2).map((f) => f.name).join('/');
}

/** Remote / hybrid / on-site. */
export function extractWorkplaceType(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  if (/\bhybrid\b/.test(haystack)) return 'Hybrid';
  if (/\b(remote|work from home|wfh)\b/.test(haystack)) return 'Remote';
  if (/\b(on-?site|in-?office|in person)\b/.test(haystack)) return 'On-site';
  return null;
}

/**
 * Turn LinkedIn's relative posted-time text into an absolute timestamp.
 * "3 hours ago" / "Just now" / "Posted 2 days ago" / "Reposted 45 minutes ago".
 * Returns epoch ms, or null when the text is unparseable.
 */
export function parseRelativeTime(text, now = Date.now()) {
  if (!text) return null;
  const s = String(text).toLowerCase();

  if (/just now|moments? ago|seconds? ago/.test(s)) return now;

  const m = s.match(/(\d+)\s*(minute|min|hour|hr|day|week|month|year)s?\s*ago/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const unit = m[2];
  const MS = {
    minute: 60_000, min: 60_000,
    hour: 3_600_000, hr: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  };
  return now - n * (MS[unit] ?? 0);
}

/** Extract a numeric LinkedIn job id from any job URL shape. */
export function jobIdFromUrl(url) {
  if (!url) return null;
  const patterns = [
    /currentJobId=(\d+)/,
    /\/jobs\/view\/(?:[^/?#]*-)?(\d+)/,
    /\/jobs\/collections\/[^?]*\?.*currentJobId=(\d+)/,
    /jobPostingId[=:](\d+)/,
    /(\d{9,12})/,
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

