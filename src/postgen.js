/**
 * Turn a stored posting into a LinkedIn post he can paste into his own feed.
 *
 * The split here is the whole point: EVERY FACT IS DETERMINISTIC and comes
 * straight out of the database — company, role, location, stipend, duration,
 * batch year, both links. The local model writes exactly two pieces of prose,
 * the opening hook and the applying tip, and even those are checked against the
 * posting before they are used.
 *
 * That is not caution for its own sake. This goes out under his own name to his
 * own network, next to a link that says "apply here". A model that invents a
 * ₹45 LPA stipend or a 2027 batch restriction sends students to an application
 * they are not eligible for, with his name on it. An empty field is fine; an
 * invented one is not — the same rule groundEnrichment already enforces for the
 * site.
 *
 * The bold text is Unicode Mathematical Sans-Serif Bold, applied HERE and never
 * by the model. LinkedIn has no rich text, so the convention is to swap in these
 * codepoints; a local 8b model asked to emit them produces mojibake about half
 * the time, and it has no way to know which spans should be bold anyway.
 */
import { jobSlug, SITE } from './pages.js';
import { resolveRowRegion, regionPath, publishedRegions, regionOf } from './regions.js';
import { formatStipend } from './extract.js';

/** LinkedIn refuses a post longer than this. */
export const MAX_POST_CHARS = 3000;

/** And a comment longer than this, which is a quarter of the post budget. */
export const MAX_COMMENT_CHARS = 1250;

/** Everything past this is behind "…see more", so the hook has to land inside it. */
export const FOLD_CHARS = 210;

/* ------------------------------------------------------------ bold lettering */

const BOLD_UPPER = 0x1d5d4; // MATHEMATICAL SANS-SERIF BOLD CAPITAL A
const BOLD_LOWER = 0x1d5ee; // MATHEMATICAL SANS-SERIF BOLD SMALL A
const BOLD_DIGIT = 0x1d7ec; // MATHEMATICAL SANS-SERIF BOLD DIGIT ZERO

/**
 * ASCII letters and digits to their sans-serif-bold codepoints.
 *
 * Built from the code points rather than pasted as literals: these are all
 * astral-plane characters, so a copied literal is two UTF-16 units and one
 * careless `.slice()` in an editor silently halves one into a replacement
 * character. Everything else — punctuation, ₹, accented letters, emoji — is
 * passed through untouched, because there is no bold form of it to map to.
 */
export function boldSans(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) out += String.fromCodePoint(BOLD_UPPER + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(BOLD_LOWER + c - 97);
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(BOLD_DIGIT + c - 48);
    else out += ch;
  }
  return out;
}

/**
 * Undo boldSans.
 *
 * Not a debugging aid — a screen reader announces these codepoints one at a
 * time by their Unicode names, so a post written entirely in them is unreadable
 * to anyone using one. The posts page offers this as a second copy button so
 * the choice is his per post rather than baked into the generator.
 */
export function plainText(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= BOLD_UPPER && c < BOLD_UPPER + 26) out += String.fromCharCode(65 + c - BOLD_UPPER);
    else if (c >= BOLD_LOWER && c < BOLD_LOWER + 26) out += String.fromCharCode(97 + c - BOLD_LOWER);
    else if (c >= BOLD_DIGIT && c < BOLD_DIGIT + 10) out += String.fromCharCode(48 + c - BOLD_DIGIT);
    else out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------- sources */

const ATS_NAMES = [
  [/myworkdayjobs\.com|workday/i, 'Workday'],
  [/greenhouse\.io/i, 'Greenhouse'],
  [/lever\.co/i, 'Lever'],
  [/ashbyhq\.com/i, 'Ashby'],
  [/smartrecruiters\.com/i, 'SmartRecruiters'],
  [/icims\.com/i, 'iCIMS'],
  [/taleo\.net/i, 'Taleo'],
  [/successfactors|sapsf\.com/i, 'SuccessFactors'],
  [/oraclecloud\.com/i, 'Oracle Recruiting'],
  [/darwinbox\.(in|com)/i, 'Darwinbox'],
  [/keka\.com/i, 'Keka'],
  [/zohorecruit|recruit\.zoho/i, 'Zoho Recruit'],
];

/** Which system the Apply button actually lands on. Null when we cannot tell. */
export function applyProvider(url) {
  const href = String(url ?? '');
  if (!href) return null;
  for (const [re, name] of ATS_NAMES) if (re.test(href)) return name;
  if (/linkedin\.com/i.test(href)) return 'LinkedIn';
  return null;
}

/**
 * The provider token inside an `ats:` job id, spelled the way a reader knows it.
 *
 * Keyed on what src/ats.js actually writes, which is NOT a hostname — matching
 * the URL patterns above against the bare word `greenhouse` finds nothing,
 * because those look for `greenhouse.io`. `amazon` and `microsoft` are the
 * companies' own APIs rather than a third-party system, so they are absent on
 * purpose: naming a product beside them would be wrong.
 */
const PROVIDER_LABELS = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  workable: 'Workable',
};

/**
 * Where the listing was found, for the Source line.
 *
 * Read from the job id, not the apply URL: a LinkedIn posting routinely carries
 * a Workday apply link, and saying it was sourced from Workday would be false.
 * The id is the only field that records which collector saw it — digits are
 * LinkedIn, `ats:provider:token:n` is a first-party board.
 */
export function sourceLabel(row) {
  const id = String(row.job_id ?? '');
  if (!id.startsWith('ats:')) return 'LinkedIn';
  const who = row.company || 'the company';
  const pretty = PROVIDER_LABELS[id.split(':')[1] ?? ''];
  return pretty ? `${who} careers page (${pretty})` : `${who} careers page`;
}

/* --------------------------------------------------------------------- utm */

/**
 * Tag a link so Vercel Analytics can tell LinkedIn traffic from everything else.
 *
 * ONLY our own URLs. An ATS or LinkedIn apply link belongs to somebody else,
 * some of them route on the query string, and adding tracking to a third party's
 * URL is not ours to do.
 *
 * Safe against the canonical: every generated page emits
 * `<link rel="canonical">` pointing at the clean URL, so a tagged link cannot
 * become a second indexed copy of the page.
 */
export function utmUrl(url, { campaign, content, source, medium } = {}, cfg = {}) {
  const conf = cfg.postQueue?.utm ?? {};
  if (conf.enabled === false) return url;
  if (!url) return url;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return url;
  }
  /* THE ORIGIN, NOT A STRING PREFIX. `startsWith(SITE)` also accepts
     `https://interndoor.com.evil.example/…`, which would put our tracking
     parameters on somebody else's host — and the whole reason this refuses a
     foreign host is that some ATS routers read the query string and break.
     Unreachable today: every caller builds its argument from SITE. But
     `isJobPageUrl` guards the same lookalike and is tested for it, and a
     function that is safe only because of what its callers happen to pass is
     one refactor from not being safe. */
  if (u.origin !== SITE) return url;
  try {
    /* `source` overrides the config default, because these tags are shared by
       more than one channel now. The default is 'linkedin' because that is
       what this function was written for; the first published reel went out
       tagged utm_source=linkedin, which would have filed every click from
       Instagram under LinkedIn in Vercel Analytics. */
    u.searchParams.set('utm_source', source || conf.source || 'linkedin');
    /* MEDIUM OVERRIDES FOR THE SAME REASON `source` DOES, one field over. The
       config default is `social` because every caller was a social post; the
       daily email digest is not, and leaving it would file every click from
       every subscriber under social traffic — the exact mistake the note above
       describes for a reel tagged utm_source=linkedin. */
    u.searchParams.set('utm_medium', medium || conf.medium || 'social');
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    if (content) u.searchParams.set('utm_content', content);
    return u.toString();
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ telegram */

/**
 * The channel for a region, as a handle and a link.
 *
 * Read from the same config the channel poster uses, so the two can never name
 * different channels. A numeric chat id (a private channel) yields no link,
 * because t.me has no address for one.
 */
/**
 * The channel a post should send people to. WhatsApp first where it exists.
 *
 * Not a ranking of the channels — an ordering claim about which app the reader
 * already has open, and for the India board that is not close. A region with
 * only Telegram is unaffected: this picks a preference, it does not remove
 * anything, and the same rule the alerts page follows.
 *
 * A WHATSAPP CHANNEL HAS NO HANDLE, only an invite URL, which is why `handle`
 * can be null and callers must not assume one. That matters in the post BODY,
 * where Telegram's "@interndoor" could be named without spending a link and
 * WhatsApp cannot — so the body names the channel in words and the link goes
 * in the first comment, which is where it was going anyway.
 */
export function followChannel(cfg, code) {
  const wa = cfg?.notifications?.whatsapp?.channels?.[code];
  if (wa) return { name: 'WhatsApp', url: String(wa), handle: null };
  const tg = telegramFor(cfg, code);
  return tg ? { name: 'Telegram', url: tg.url, handle: tg.handle } : null;
}

export function telegramFor(cfg, code) {
  const conf = cfg?.notifications?.telegram ?? {};
  const chat = conf.channels?.[code] ?? (code === 'IN' ? conf.chatId : null);
  const handle = String(chat ?? '').trim();
  if (!handle.startsWith('@')) return null;
  return { handle, url: `https://t.me/${handle.slice(1)}` };
}

/* -------------------------------------------------------------- batch years */

/**
 * Graduation years the posting itself names.
 *
 * Deliberately extracted here and never asked of the model. "2027 graduates" is
 * a hard eligibility filter — getting it wrong either sends the wrong students
 * to an application or tells the right ones not to bother — and it is a plain
 * regex over text we already hold, so there is nothing for a model to add.
 *
 * Bounded to a graduation window around now because postings are full of other
 * four-digit years: a copyright line, "founded in 2011", a ₹2,026 figure that
 * reached the stipend slot. Anything before this year is somebody's history.
 */
export function batchYears(...texts) {
  const haystack = texts.filter(Boolean).join('\n');
  const thisYear = new Date().getFullYear();
  const found = new Set();
  for (const m of haystack.matchAll(/\b(20[2-3]\d)\b/g)) {
    const year = Number(m[1]);
    if (year >= thisYear && year <= thisYear + 5) found.add(year);
  }
  return [...found].sort();
}

/* ------------------------------------------------------------- applying tips */

/**
 * What is actually annoying about this particular form.
 *
 * Written per provider because the friction is per provider and does not change
 * between postings. The model is shown this and asked to improve on it with
 * something specific to the role; when it cannot, this is what ships, which is
 * why each one has to be worth reading on its own.
 */
const PROVIDER_TIPS = {
  Workday: 'Workday makes you create an account before you can apply — upload the PDF resume first and let it autofill, because filling the fields by hand and then attaching the file overwrites what you typed.',
  Greenhouse: 'One page, no account needed. Fill the LinkedIn and GitHub fields even though they are marked optional — on an internship req they are usually the first thing a recruiter opens.',
  Lever: 'Short single-page form with no login. The "additional information" box is the only free text you get, so use it for one specific thing you have built.',
  Ashby: 'Single page, no account. It saves as you type, so you can leave the tab open and come back to the long-answer questions.',
  SmartRecruiters: 'It offers to import from LinkedIn — do that first, then fix the fields it gets wrong, rather than typing everything twice.',
  iCIMS: 'iCIMS wants an account and times the session out. Have the resume PDF, your marks and your address ready before you start.',
  LinkedIn: 'Easy Apply takes about two minutes, but it sends whichever resume LinkedIn has on file — open your profile and check that it is the current one before you submit.',
};

const DEFAULT_TIP = 'Keep a one-page PDF resume ready and apply from a laptop — several of these forms drop attachments on mobile.';

export function providerTip(row) {
  const provider = applyProvider(row.apply_url || row.job_url);
  if (provider === 'LinkedIn' && !row.easy_apply) {
    return 'The apply button hands you off to the company\'s own site, so expect a second form and have a PDF resume ready.';
  }
  return PROVIDER_TIPS[provider] ?? DEFAULT_TIP;
}

/* -------------------------------------------------------------- freshness */

/**
 * The posting's own clock, as an ABSOLUTE time.
 *
 * Never "2 hours ago". A draft is written when he presses Generate and pasted
 * whenever he gets to it — often hours later, sometimes the next day — so a
 * relative age is a claim that rots between the two. The site already learned
 * this the expensive way with `posted_text`, which froze at scrape time and had
 * day-old listings reading "4 minutes ago" on a board whose whole promise is
 * being early.
 *
 * An absolute stamp cannot rot. It also fails in the safe direction: paste a
 * three-day-old draft and the timestamp says so, instead of claiming freshness
 * the listing no longer has.
 */
export function postedLabel(ms, code = 'IN') {
  if (!ms) return null;
  const zone = regionOf(code)?.timeZone ?? 'Asia/Kolkata';
  return new Date(ms).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone,
  });
}

/**
 * "8 people clicked apply" -> 8.
 *
 * LinkedIn writes this field several ways and sometimes with no number at all
 * ("Be among the first 25 applicants"). Only a real count is used, because the
 * line it feeds is a factual claim about how early the reader is.
 */
export function applicantCount(text) {
  const m = String(text ?? '').match(/\b(\d[\d,]*)\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------- facts */

/** A utm_content value: which post sent the click, without a tracking id. */
const slugFor = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'post';

const parseArray = (raw) => {
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string' && s);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
};

/**
 * Everything the post states as fact, resolved from the row alone.
 *
 * @param {object} row  a jobs row, as store.queuedJobs() returns it
 * @param {object} cfg  loaded config, for which regions have a public board
 */
/**
 * "₹0", "₹ 0", "0", "$0.00" — a figure that says the pay is nothing.
 *
 * Missing data rather than a wage: an employer that genuinely pays nothing is
 * recorded in `stipendStatus`, which is NOT trustworthy and is rendered
 * nowhere. Any zero introduced by a currency counts, not merely an all-zero
 * string, so "₹0 - ₹0" and "$0/month" are caught too.
 */
export function isZeroPay(value) {
  const v = String(value ?? '').trim();
  if (!/\d/.test(v)) return false;
  const figures = v.match(/\d[\d,.\s]*/g) ?? [];
  return figures.length > 0 && figures.every((f) => Number(f.replace(/[,\s]/g, '')) === 0);
}

export function jobFacts(row, cfg = {}, campaign = 'post') {
  /* ZERO IS NOT AN AMOUNT, and this path had missed that.
     `stipendText` in pages.js already drops "₹0" for the site — 68 live rows
     hold one, 30 of them on the US board where the currency is wrong as well
     as the figure — but a post is built from the raw columns through
     formatStipend, which has no such guard, so "💰 ₹0" went out under his own
     name next to an apply link. On a job page that reads as a data quirk; in a
     post it reads as a claim about what an employer pays. Same call the reel
     caption already makes for the same reason. */
  const rawStipend = formatStipend({
    min: row.stipend_min, max: row.stipend_max,
    currency: row.stipend_currency, period: row.stipend_period,
  }) || row.salary_text || null;
  const stipend = isZeroPay(rawStipend) ? null : rawStipend;

  const region = resolveRowRegion(row);
  const published = new Set(publishedRegions(cfg).map((r) => r.code));

  // Only link to a page that exists. A job outside a published region, or one
  // the site classed non-tech, has no page written for it — and a post whose
  // "Apply here" 404s is worse than one that links straight to the posting.
  const onSite = published.has(region) && row.is_tech !== 0;
  const siteUrl = onSite
    ? `${SITE}${regionPath(region)}/jobs/${jobSlug({ company: row.company, title: row.title, id: row.job_id })}`
    : null;

  const years = batchYears(row.description, row.title);
  const postedAt = row.posted_at || row.first_seen_at || null;
  const tag = (url, content) => utmUrl(url, { campaign, content }, cfg);

  return {
    jobId: row.job_id,
    postedAt,
    // Exposed so a caller holding several postings can tell which board each
    // belongs to. composeCombined needs it to pick ONE footer, and without it
    // the majority tally silently read every row as India.
    region,
    postedLabel: postedLabel(postedAt, region),
    // How stale the DRAFT is by the time he looks at it. The posts page warns
    // above a day: pasting a three-day-old listing under a headline that says
    // "apply as soon as you can" is the one thing that cheapens the promise.
    ageHours: postedAt ? Math.round((Date.now() - postedAt) / 3_600_000) : null,
    applicants: applicantCount(row.applicants),
    telegram: telegramFor(cfg, region),
    // Where the post actually sends people: WhatsApp if the region has one.
    follow: followChannel(cfg, region),
    company: row.company || row.company_matched || 'Unknown company',
    title: row.title,
    roleLabel: row.role_label || null,
    location: row.location || null,
    workplaceType: row.workplace_type || null,
    stipend,
    duration: row.duration || null,
    degreeText: row.degree_text || null,
    batchYears: years,
    batch: years.length ? years.join(' / ') : null,
    bullets: parseArray(row.bullets).slice(0, 3),
    keySkills: parseArray(row.key_skills).slice(0, 5),
    source: sourceLabel(row),
    applyUrl: row.apply_url || row.job_url || null,
    siteUrl,
    // The reader-facing link, and the one thing worth being careful about: it is
    // the site when the site has the page, and the raw posting otherwise.
    link: tag(siteUrl, `${slugFor(row.company)}`) || row.apply_url || row.job_url || SITE,
    linksToSite: !!siteUrl,
    boardUrl: tag(`${SITE}${published.has(region) ? regionPath(region) : ''}/`, `${slugFor(row.company)}`),
    tipFallback: providerTip(row),
  };
}

/* ---------------------------------------------------------------- the model */

export const POST_SYSTEM = `You write two short pieces of text for a LinkedIn post about ONE internship. Somebody else writes the rest of the post; you never see it and must not try to reproduce it.

hook — one or two sentences, 30 to 45 words, addressed to a student deciding whether to apply. Say who this suits and what they would actually work on. Lead with the work, not with the company's reputation. Plain sentences, no emoji, no hashtags, no asterisks, no bold, no line breaks. Never open with "Exciting opportunity", "Great news", "Calling all" or any variant. Never say "dream job", "don't miss out", "fast-paced" or "dynamic".

tip — one sentence, at most 200 characters, of genuinely useful advice about APPLYING to this specific posting. You are given the tip that will be used if yours is not better; beat it by naming something concrete from this posting — a named skill worth putting at the top of the resume, a portfolio or project the description asks for, an assessment or a test that is mentioned. If the posting gives you nothing concrete, return an empty string and the fallback is used.

hashtags — 5 to 8 tags, lowercase, no "#" and no spaces inside a tag. Mix the specific (the company, the stack) with the broad (internship, hiring). No more than eight.

THE HARD RULE: state only what the posting supports. Do not name a stipend, a salary, a graduation year, a batch, a duration, a degree, a location or a deadline anywhere in your answer — those are filled in from structured data by the caller, and a number you invent here contradicts them in the same post. Do not repeat the job title back word for word.

Return only JSON.`;

export const POST_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string' },
    tip: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['hook', 'tip', 'hashtags'],
};

/** The user turn: facts the model may lean on, and the posting itself. */
export function postPrompt(facts, description) {
  return [
    `Company: ${facts.company}`,
    `Role: ${facts.title}`,
    `What the work is: ${facts.roleLabel ?? 'not stated'}`,
    `Location: ${facts.location ?? 'not stated'}`,
    `Skills named: ${facts.keySkills.length ? facts.keySkills.join(', ') : 'none captured'}`,
    `Applying through: ${applyProvider(facts.applyUrl) ?? 'an unknown system'}`,
    `Fallback tip (beat this or return an empty tip): ${facts.tipFallback}`,
    '',
    'Description:',
    String(description ?? '') || '(none captured)',
  ].join('\n');
}

/* -------------------------------------------------------------- grounding */

// Decoration the model adds unasked. Stripped rather than rejected, because a
// good sentence with a rocket emoji on the end is still a good sentence.
const DECORATION = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]|[*_`#]/gu;

const HYPE = /\b(exciting opportunity|dream (job|role)|don'?t miss|fast[- ]paced|dynamic team|game[- ]chang|once[- ]in[- ]a[- ]lifetime|calling all|amazing opportunity)\b/i;

// Anything that reads as money. The facts block already carries the stipend, or
// deliberately carries nothing; a figure in the prose can only contradict it.
const MONEY = /[₹$€£]\s?\d|\b\d+(\.\d+)?\s*(lpa|lakhs?|crores?|k\s*(per|\/)\s*month)\b|\bstipend of\b|\bper month\b|\bper annum\b/i;

function clean(text) {
  return String(text ?? '')
    .replace(DECORATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep only what the posting supports.
 *
 * Every rejection here falls back to something deterministic rather than to an
 * empty post, so a model having a bad night degrades the writing and never the
 * correctness.
 *
 * @returns {{hook: string, tip: string, hashtags: string[], dropped: string[]}}
 */
export function groundPost(raw, facts) {
  const dropped = [];
  let hook = clean(raw?.hook);
  let tip = clean(raw?.tip);

  if (hook.length > 400) { hook = ''; dropped.push('hook: too long'); }
  if (hook && HYPE.test(hook)) { hook = ''; dropped.push('hook: marketing language'); }
  if (hook && MONEY.test(hook)) { hook = ''; dropped.push('hook: named money the facts do not'); }

  // A year in the prose is an eligibility claim. It may only stand if the
  // posting named that exact year, which is the same test the facts block uses.
  const allowed = new Set(facts.batchYears.map(String));
  for (const m of hook.matchAll(/\b20\d\d\b/g)) {
    if (!allowed.has(m[0])) { hook = ''; dropped.push(`hook: named ${m[0]}, which the posting does not`); break; }
  }

  if (tip.length > 260) { tip = ''; dropped.push('tip: too long'); }
  if (tip && MONEY.test(tip)) { tip = ''; dropped.push('tip: named money the facts do not'); }
  for (const m of tip.matchAll(/\b20\d\d\b/g)) {
    if (!allowed.has(m[0])) { tip = ''; dropped.push(`tip: named ${m[0]}, which the posting does not`); break; }
  }

  const tags = (Array.isArray(raw?.hashtags) ? raw.hashtags : [])
    .map((t) => String(t).replace(/[^A-Za-z0-9]/g, ''))
    .filter((t) => t.length >= 3 && t.length <= 28);

  // Topped up rather than replaced. The model's tags are the specific ones —
  // the company, the stack — and discarding a short list outright threw away
  // exactly the tags worth having in order to reach a count.
  const hashtags = [...new Set([...tags, ...fallbackHashtags(facts)])].slice(0, 8);

  return {
    hook: hook || fallbackHook(facts),
    tip: tip || facts.tipFallback,
    hashtags,
    dropped,
  };
}

/** Written from the facts alone, so a post always has an opening line. */
export function fallbackHook(facts) {
  const who = facts.batch ? `If you graduate in ${facts.batch}` : 'If you are a student';
  const what = facts.roleLabel ? `${facts.roleLabel.toLowerCase()} work` : 'engineering work';
  const where = facts.location ? ` in ${cityOf(facts.location)}` : '';
  return `${who} and you want ${what}${where}, this one is worth a look — ${facts.company} has just opened applications and internship listings like this close fast.`;
}

function fallbackHashtags(facts) {
  const slug = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');
  return [...new Set([
    slug(facts.company), 'internship', 'hiring', 'techjobs', 'interndoor',
    ...facts.keySkills.map(slug),
  ].filter((t) => t.length >= 3 && t.length <= 28))].slice(0, 8);
}

/** "Bengaluru, Karnataka, India" -> "Bengaluru". */
export function cityOf(location) {
  return String(location ?? '').split(',')[0].trim() || String(location ?? '');
}

/**
 * Technology names as they are actually written.
 *
 * The stored bullets come from the enricher, whose sentenceCase raises only the
 * first letter of the line — correct for a card, wrong in a post, where real
 * bullets read "Use python and terraform to manage cloud resources" and
 * "Work with 2d/3d cad". A stranger reading that in a feed reads it as careless.
 *
 * Only unambiguous names are here. `go`, `rust`, `swift`, `spring` and `r` are
 * deliberately absent: each is an ordinary English word far more often than it
 * is a language, and "a Swift turnaround" is a worse error than a lowercase s.
 * src/extract.js leaves `go` and `r` out of its own vocabulary for this reason.
 */
const TECH_CASE = new Map(Object.entries({
  python: 'Python', terraform: 'Terraform', kubernetes: 'Kubernetes', docker: 'Docker',
  ansible: 'Ansible', jenkins: 'Jenkins', grafana: 'Grafana', prometheus: 'Prometheus',
  linux: 'Linux', django: 'Django', flask: 'Flask', fastapi: 'FastAPI', angular: 'Angular',
  react: 'React', vue: 'Vue', svelte: 'Svelte', numpy: 'NumPy', pandas: 'pandas',
  pytorch: 'PyTorch', tensorflow: 'TensorFlow', kafka: 'Kafka', redis: 'Redis',
  javascript: 'JavaScript', typescript: 'TypeScript', 'node.js': 'Node.js', 'next.js': 'Next.js',
  mysql: 'MySQL', postgresql: 'PostgreSQL', postgres: 'Postgres', mongodb: 'MongoDB',
  sqlite: 'SQLite', github: 'GitHub', gitlab: 'GitLab', gitops: 'GitOps', graphql: 'GraphQL',
  git: 'Git', jira: 'Jira', figma: 'Figma', kotlin: 'Kotlin', java: 'Java', scala: 'Scala',
  matlab: 'MATLAB', 'c++': 'C++', 'c#': 'C#', '.net': '.NET', ios: 'iOS', macos: 'macOS',
  android: 'Android', azure: 'Azure', firebase: 'Firebase', selenium: 'Selenium',
  sql: 'SQL', nosql: 'NoSQL', aws: 'AWS', gcp: 'GCP', api: 'API', apis: 'APIs',
  rest: 'REST', restful: 'RESTful', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML',
  'ci/cd': 'CI/CD', etl: 'ETL', ml: 'ML', ai: 'AI', nlp: 'NLP', llm: 'LLM', llms: 'LLMs',
  ui: 'UI', ux: 'UX', cad: 'CAD', iot: 'IoT', fpga: 'FPGA', vlsi: 'VLSI', rtl: 'RTL',
  qa: 'QA', saas: 'SaaS', oops: 'OOPS', jvm: 'JVM', orm: 'ORM', '2d': '2D', '3d': '3D',
}));

// Longest first, so "node.js" is matched before "node" would be, and the dots,
// pluses and slashes are escaped rather than acting as regex syntax.
const TECH_RE = new RegExp(
  `(^|[^A-Za-z0-9.+#/])(${[...TECH_CASE.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.+*?^${}()|[\]\\/]/g, '\\$&'))
    .join('|')})(?![A-Za-z0-9.+#/])`,
  'gi',
);

/** Raise the technology names inside a sentence, leaving everything else alone. */
export function tidyTech(text) {
  return String(text ?? '').replace(TECH_RE, (_, before, word) => before + TECH_CASE.get(word.toLowerCase()));
}

/* -------------------------------------------------------------- the post */

const B = boldSans;

/**
 * Assemble the post.
 *
 * Blocks are built as an ordered list of optional sections so that fitting it
 * under LinkedIn's 3,000-character limit can drop whole sections from the least
 * important end, rather than slicing the string and leaving half a URL.
 */
/**
 * Above this the applicant count is left out of the post entirely.
 *
 * 25 is the board's own threshold for the same field, and the two must not
 * drift: a card that stays silent about a crowded queue while the post about
 * it announces one is the site arguing with itself.
 */
const APPLICANTS_SHOW_MAX = 25;

export function composePost(facts, ai) {
  const role = facts.title;
  const head = `🚨 ${B(facts.company)} ${B('is Hiring')} ${B(role)}! 💻🔥`;

  const factLines = [
    `🎯 ${B('Company')}: ${facts.company}`,
    `💼 ${B('Role')}: ${role}`,
  ];
  if (facts.batch) factLines.push(`🎓 ${B('Batch')}: ${facts.batch}`);
  if (facts.degreeText) factLines.push(`📜 ${B('Degree')}: ${facts.degreeText}`);
  if (facts.location) {
    const mode = facts.workplaceType ? ` (${facts.workplaceType})` : '';
    factLines.push(`📍 ${B('Location')}: ${facts.location}${mode}`);
  }
  if (facts.stipend) factLines.push(`💰 ${B('Stipend')}: ${facts.stipend}`);
  if (facts.duration) factLines.push(`⏳ ${B('Duration')}: ${facts.duration}`);

  // Being early is the site's whole promise, and on most postings there is no
  // stipend and no batch year to lead with — measured over a fortnight of India
  // tech rows, 16 of 168 carried a stipend and 26 named a year. These two are
  // there: 143 of 168 carried an applicant count, and every row knows when it
  // was posted. They are also the only facts that say "you are ahead of the
  // queue", which is the reason to click today rather than bookmark it.
  if (facts.postedLabel) factLines.push(`🕐 ${B('Posted')}: ${facts.postedLabel}`);
  /* ONLY WHILE THE QUEUE IS SHORT, which is the same call the board already
     makes and for the same reason. This number exists to prove the reader is
     early. On a crowded role it proves the opposite — "Applicants: 100 when
     this was listed", printed directly above an apply link, is an argument
     against clicking it, and it was going out on every such post.
     Withholding it is not hiding anything: the posting is one click away and
     shows its own count, and the "Posted" timestamp still carries freshness.
     STRICTLY under, so LinkedIn's own "Be among the first 25 applicants"
     prompt could never be read as a real count of 25 — no row in the store
     carries that phrasing today, so this costs a character rather than a
     branch. */
  if (facts.applicants != null && facts.applicants < APPLICANTS_SHOW_MAX) {
    factLines.push(`👥 ${B('Applicants')}: ${facts.applicants} when this was listed`);
  }

  const share = facts.batch
    ? `Know a ${facts.batch} graduate who would be right for this? ${B('Share it with them')} 🚀`
    : `Know a junior who would be right for this? ${B('Share it with them')} 🚀`;

  // ONE link in the body, and it is the job page.
  //
  // There used to be two — the job page and the board — competing for the same
  // click. Whatever LinkedIn's ranking really does with outbound links, and the
  // evidence for a penalty is far softer than the folklore, two is strictly
  // worse than one. The board and the channel moved to composeComment, where
  // they cost the post nothing and are read by people already interested.
  //
  // The channel is still NAMED here without a link. A handle is not an outbound
  // link, so it costs nothing, and a subscriber is worth more than a click: it
  // is the only thing on this site anybody can follow.
  /* Telegram's handle is naming a channel, not linking one, so it costs the
     post nothing. A WhatsApp channel has no handle at all, so it is named in
     words instead — the link is in the first comment either way. */
  const follow = facts.follow
    ? (facts.follow.handle
      ? `📢 Every new internship, the minute it opens: ${facts.follow.handle} on ${facts.follow.name} — link in the comments.`
      : `📢 Every new internship, the minute it opens — our ${facts.follow.name} channel, link in the comments.`)
    : '';

  const section = {
    bullets: facts.bullets.length
      ? [`⚙️ ${B('What you would work on')}:`, ...facts.bullets.map((b) => `• ${tidyTech(b).replace(/\.$/, '')}`)].join('\n')
      : '',
    tip: `📝 ${B('Applying tip')}: ${ai.tip}`,
    hashtags: ai.hashtags.length ? ai.hashtags.map((t) => `#${t}`).join(' ') : '',
    disclaimer: `⚠️ ${B('Disclaimer')}: the logo and links belong to their respective owners. I am only sharing this opportunity and have no affiliation with ${facts.company}.`,
  };

  const build = (drop) => [
    head,
    ai.hook,
    factLines.join('\n'),
    drop.has('bullets') ? '' : section.bullets,
    `🔎 ${B('Source')}: ${facts.source}`,
    `⚡ ${B('Important')}: apply as soon as you can — internship openings like this close within days.`,
    drop.has('tip') ? '' : section.tip,
    `👉 ${B('Apply here')}: ${facts.link}`,
    share,
    follow,
    `Follow me for more ${B('Jobs')}, ${B('Internships')} & ${B('Career Opportunities')} 🔥`,
    drop.has('hashtags') ? '' : section.hashtags,
    drop.has('disclaimer') ? '' : section.disclaimer,
  ].filter(Boolean).join('\n\n');

  // Shed the least valuable sections first if the post is over LinkedIn's limit.
  // The disclaimer is courtesy and the hashtags are reach; the bullets are the
  // only part that says what the job actually involves, so they go last.
  const drop = new Set();
  for (const next of ['disclaimer', 'hashtags', 'tip', 'bullets']) {
    const text = build(drop);
    if (text.length <= MAX_POST_CHARS) return text;
    drop.add(next);
  }
  return build(drop).slice(0, MAX_POST_CHARS);
}

/**
 * ONE post for everything in the queue, each posting keeping its own link.
 *
 * NO MODEL, and that is the same call the Sunday roundup makes for the same
 * reason: every line here is a company name, a place and a URL. There is
 * nothing for a model to add that would not be an invented adjective, and
 * skipping it means the button is instant rather than a minute of Ollama.
 *
 * THE PER-JOB LINK IS THE WHOLE POINT, so the rule that a single-job post
 * carries exactly one link does not apply. That rule exists because a board
 * link and a job link compete for one click; here the links ARE the content,
 * and a reader who wants the third role should not have to go and find it.
 *
 * WHAT DOES NOT FIT IS COUNTED, NEVER SILENTLY DROPPED — the same discipline
 * the weekly roundup follows, because a post that quietly loses half its
 * listings reads as though there were half as many.
 */
export function composeCombined(list) {
  const rows = (list ?? []).filter(Boolean);
  if (!rows.length) return '';

  /* THE FOOTER FOLLOWS THE ROWS, NOT THE FIRST ONE. Each posting carries the
     board and channel for its OWN region, so taking them off rows[0] put
     India's board and @interndoor under a list that was two-thirds American —
     which is the same mistake the Telegram routing is careful about, arriving
     from a different direction. The report keeps the boards apart behind a
     toggle so a queue is normally all one region; when it is not, the majority
     decides and the minority still keeps its own per-job links. */
  const tally = new Map();
  for (const f of rows) {
    const key = f.region ?? 'IN';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const main = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const pick = (get) => get(rows.find((f) => (f.region ?? 'IN') === main) ?? rows[0])
    ?? get(rows.find((f) => get(f)) ?? {});
  const board = pick((f) => f?.boardUrl);
  const tg = pick((f) => f?.follow);

  const entry = (f) => {
    const bits = [];
    if (f.location) {
      const city = cityOf(f.location) || f.location;
      bits.push(`📍 ${city}${f.workplaceType ? ` (${f.workplaceType})` : ''}`);
    }
    if (f.stipend) bits.push(`💰 ${f.stipend}`);
    if (f.batch) bits.push(`🎓 ${f.batch}`);
    const lines = [`${B(f.company)} — ${f.title}`];
    if (bits.length) lines.push(bits.join(' · '));
    // The apply link, or the job page where one exists. jobFacts already
    // decided which, and already refused to tag a URL that is not ours.
    lines.push(`→ ${f.link}`);
    return lines.join('\n');
  };

  const head = `${B(`${rows.length} engineering internship${rows.length === 1 ? '' : 's'} open right now`)} 🚨`;
  const lede = 'Apply while the queue is still short — the good ones collect hundreds of applicants inside a day.';

  const build = (n) => {
    const parts = [head, lede, rows.slice(0, n).map(entry).join('\n\n')];
    const dropped = rows.length - n;
    if (dropped > 0) parts.push(`…and ${dropped} more on the board.`);
    const foot = [];
    if (board) foot.push(`🌐 Every live engineering internship: ${board}`);
    // Named, not linked. A handle is not an outbound link so it costs the post
    // nothing, and a subscriber is worth more than a click.
    if (tg) {
      foot.push(tg.handle
        ? `${tg.handle} on ${tg.name} — new roles the minute they go up.`
        : `New roles the minute they go up, on ${tg.name} 👉 ${tg.url}`);
    }
    if (foot.length) parts.push(foot.join('\n'));
    return parts.filter(Boolean).join('\n\n');
  };

  /* Whole entries are shed, never characters. Bold glyphs are surrogate pairs,
     so slicing the finished string to length would cut one in half and emit a
     lone surrogate; and half a job listing is worse than one fewer. */
  for (let n = rows.length; n >= 1; n -= 1) {
    const text = build(n);
    if (text.length <= MAX_POST_CHARS) return text;
  }
  return build(1);
}

/**
 * The first comment: the two links the post body deliberately does not carry.
 *
 * Posted straight after the post itself. Both links belong to us, so both are
 * tagged; the channel link is the one that matters, because a follower is worth
 * every future visit and a click is worth one.
 */
export function composeComment(facts) {
  const lines = [`Every live engineering internship, updated as they open 👉 ${facts.boardUrl}`];
  if (facts.follow) {
    lines.push(`New roles the minute they go up, on ${facts.follow.name} 👉 ${facts.follow.url}`);
  }
  return lines.join('\n\n').slice(0, MAX_COMMENT_CHARS);
}

/**
 * The whole post for one row, given whatever the model returned (or nothing).
 *
 * `ai` may be null: a run with Ollama down still produces a complete, correct
 * post from the facts, which is the point of keeping the model's share this
 * small.
 */
export function buildPost(row, cfg, ai = null, campaign = 'post') {
  const facts = jobFacts(row, cfg, campaign);
  const grounded = groundPost(ai ?? {}, facts);
  return { facts, ai: grounded, text: composePost(facts, grounded), comment: composeComment(facts) };
}
