/**
 * Where a posting is, as a first-class value.
 *
 * This replaces `isIndianLocation`, which was a boolean gate applied twice — at
 * collection and again at publish — on a site that only ever had one board. The
 * ATS collector was already worldwide by nature and every posting outside India
 * was thrown away: a census on 23 Aug of the 170 non-Workday boards already
 * discovered found 189 live engineering internships, of which 13 were in India
 * and 176 were discarded. The collector was running at 7% utilisation.
 *
 * The rule that made the old gate safe is kept exactly: UNKNOWN MEANS NO. A
 * location naming nowhere we recognise resolves to `unknown` and is never
 * published, because the permissive version of this let "Bayan Lepas, my",
 * "MSB, Singapore" and "Hannover, de" onto a board promising internships in
 * India — 90 of 174 published roles at one point. The difference now is that
 * `unknown` is a bucket rather than a verdict: the row is still stored, and a
 * better gazetteer or a later model pass can route it without re-collecting.
 *
 * ORDER OF EVIDENCE, and it is load-bearing:
 *
 *   1. An explicit country name          "Bengaluru, Karnataka, India"
 *   2. A known city                      "Chicago, IL" · "Toronto"
 *   3. A country/state code in position  "PL-Warsaw-Lixa C" · "London, gb"
 *
 * City beats code because the two collide outright: `CA` is the ISO code for
 * Canada AND the postal abbreviation for California, so "Toronto, CA" and
 * "San Jose, CA" are the same shape and mean different continents. Resolving
 * the city first gets both right; resolving the code first gets one wrong every
 * time. For the same reason genuinely ambiguous bare cities are NOT in the
 * gazetteers at all — Cambridge, Birmingham and London (Ontario) need their
 * country spelled out, and returning `unknown` is the correct answer until it
 * is. Misfiling a US role onto the India board is the failure this module
 * exists to prevent; declining to guess is not.
 */

/** Nothing recognisable. Stored, never published. */
export const UNKNOWN = 'unknown';

/**
 * The regions the site knows how to render.
 *
 * `slug` is the URL prefix and INDIA'S IS DELIBERATELY EMPTY. The board has
 * ~130 job pages and 125 company hubs already indexed at `/jobs/…` and
 * `/companies/…`; moving them under `/in/` to make the scheme tidy would 404
 * every one of those URLs at once. That cost is already documented in this
 * repo's history — 198 hubs were deleted and rebuilt by an earlier bug, and the
 * churn suppressed them for weeks. India stays at the root permanently, and new
 * regions are added beside it. `/in/` redirects to `/`, never the reverse.
 *
 * `code` is ISO 3166-1 alpha-2 because schema.org's `addressCountry` wants
 * exactly that, so the JSON-LD reads it straight off. The slug is allowed to
 * disagree where people expect it to: GB is served at `/uk/`.
 */
const REGION_LIST = [
  {
    code: 'IN',
    slug: '',
    name: 'India',
    // "internships in India" — reads as a place, used after a preposition.
    inName: 'in India',
    hreflang: 'en-IN',
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    // LinkedIn's geoId for India. buildSearchUrl already supports the parameter;
    // the redirect to /jobs/search-results/ drops `location=` but keeps `geoId`,
    // so this is the only reliable way to scope a search once regions multiply.
    geoId: 102713980,
    telegram: 'https://t.me/internzo',
    countries: ['india', 'bharat'],
    // NO `in` code, deliberately. The leading-prefix form would match
    // "In-Office" — which is Cloudflare's location text for 29 live roles — and
    // file every one of them in India. `in` is also the commonest preposition in
    // English. India is spelled out or names a city in every row we hold, so the
    // code buys nothing and costs a whole employer's board.
    codes: [],
    cities: [
      'bengaluru', 'bangalore', 'mumbai', 'bombay', 'delhi', 'gurugram', 'gurgaon',
      'noida', 'hyderabad', 'chennai', 'madras', 'pune', 'kolkata', 'calcutta',
      'ahmedabad', 'jaipur', 'indore', 'kochi', 'cochin', 'coimbatore', 'chandigarh',
      'thiruvananthapuram', 'trivandrum', 'mysuru', 'mysore', 'nagpur', 'bhubaneswar',
      'visakhapatnam', 'vizag', 'lucknow', 'kanpur', 'surat', 'vadodara', 'nashik',
      'bhopal', 'patna', 'ranchi', 'guwahati', 'dehradun', 'mohali', 'manesar',
      'gandhinagar', 'thane', 'faridabad', 'ghaziabad', 'aurangabad', 'rajkot',
      'ludhiana', 'amritsar', 'jodhpur', 'madurai', 'tiruchirappalli', 'salem',
      'hosur', 'hubli', 'belgaum', 'warangal', 'vijayawada', 'tirupati', 'puducherry',
      'pondicherry', 'bareilly', 'sahibabad', 'sanand', 'pantnagar', 'sri city',
      // Added from real rows the gazetteer could not read: "Dahej,GJ" and the
      // bare "Gift City". Extending the list with strings actually observed is
      // safer than admitting a class of two-letter state codes to catch them.
      'dahej', 'gift city', 'jamnagar', 'silvassa', 'roorkee', 'vapi',
      // States and union territories. Kept in the city list because they appear
      // in exactly the same slot — "Bengaluru, Karnataka, India" — and a state
      // name with no city is still unambiguous evidence.
      'karnataka', 'maharashtra', 'tamil nadu', 'telangana', 'gujarat', 'haryana',
      'punjab', 'rajasthan', 'uttar pradesh', 'west bengal', 'kerala', 'goa',
      'andhra pradesh', 'madhya pradesh', 'odisha', 'orissa', 'bihar', 'jharkhand',
      'assam', 'uttarakhand', 'himachal', 'chhattisgarh',
    ],
  },
  {
    code: 'US',
    slug: 'us',
    name: 'United States',
    inName: 'in the US',
    hreflang: 'en-US',
    timeZone: 'America/New_York',
    currency: 'USD',
    geoId: 103644278,
    telegram: 'https://t.me/internzo',
    countries: ['united states', 'usa', 'u\\.s\\.a\\.', 'u\\.s\\.'],
    // Postal abbreviations. Only consulted after the city pass, so "Toronto, CA"
    // has already resolved to Canada by the time `ca` is looked at here.
    // `in`, `de`, `or`, `ia`, `me` and `hi` are all absent: the first three
    // collide with India, Germany and an English conjunction, and the rest are
    // ordinary words. Indiana, Delaware, Oregon, Iowa, Maine and Hawaii lose
    // their abbreviation and keep their spelled-out names below.
    codes: ['us', 'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'fl', 'ga', 'id',
      'il', 'ks', 'ky', 'la', 'ma', 'md', 'mi', 'mn', 'mo', 'ms', 'mt',
      'nc', 'nd', 'ne', 'nh', 'nj', 'nm', 'nv', 'ny', 'oh', 'ok', 'pa', 'ri',
      'sc', 'sd', 'tn', 'tx', 'ut', 'va', 'vt', 'wa', 'wi', 'wv', 'wy'],
    cities: [
      'new york', 'brooklyn', 'san francisco', 'seattle', 'bellevue', 'redmond',
      'austin', 'boston', 'chicago', 'atlanta', 'denver', 'los angeles',
      'san jose', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara',
      'cupertino', 'menlo park', 'san diego', 'san mateo', 'oakland', 'berkeley',
      'irvine', 'pasadena', 'arlington', 'alexandria', 'bethesda', 'reston',
      'mclean', 'herndon', 'raleigh', 'durham', 'charlotte', 'nashville',
      'dallas', 'houston', 'plano', 'fort worth', 'phoenix', 'tempe', 'chandler',
      'portland', 'salt lake city', 'minneapolis', 'detroit', 'ann arbor',
      'pittsburgh', 'philadelphia', 'columbus', 'cleveland', 'cincinnati',
      'indianapolis', 'kansas city', 'st louis', 'saint louis', 'miami',
      'orlando', 'tampa', 'jacksonville', 'las vegas', 'sacramento', 'boulder',
      'madison', 'milwaukee', 'hartford', 'stamford', 'jersey city', 'newark',
      'princeton', 'hoboken', 'washington dc', 'washington, d\\.c\\.',
      // States spelled out. Same slot as the city, same reasoning as India's.
      'california', 'texas', 'florida', 'illinois', 'massachusetts', 'virginia',
      'georgia', 'colorado', 'arizona', 'oregon', 'michigan', 'pennsylvania',
      'north carolina', 'new jersey', 'ohio', 'utah', 'minnesota', 'wisconsin',
      'maryland', 'tennessee', 'missouri', 'indiana', 'connecticut',
    ],
  },
  {
    code: 'GB',
    slug: 'uk',
    name: 'United Kingdom',
    inName: 'in the UK',
    hreflang: 'en-GB',
    timeZone: 'Europe/London',
    currency: 'GBP',
    geoId: 101165590,
    telegram: 'https://t.me/internzo',
    countries: ['united kingdom', 'england', 'scotland', 'wales',
      'northern ireland', 'great britain'],
    codes: ['gb', 'uk'],
    // "cambridge" and "birmingham" are deliberately absent — both are also US
    // cities, and both appear in these feeds. They need the country spelled out.
    cities: ['london', 'manchester', 'edinburgh', 'glasgow', 'bristol', 'leeds',
      'belfast', 'cardiff', 'liverpool', 'sheffield', 'nottingham', 'newcastle',
      'oxford', 'reading', 'brighton', 'southampton', 'aberdeen', 'coventry',
      'milton keynes', 'basingstoke', 'swindon', 'leicester'],
  },
  {
    code: 'CA',
    slug: 'ca',
    name: 'Canada',
    inName: 'in Canada',
    hreflang: 'en-CA',
    timeZone: 'America/Toronto',
    currency: 'CAD',
    geoId: 101174742,
    telegram: 'https://t.me/internzo',
    countries: ['canada'],
    // No ISO code: `ca` belongs to California here far more often than to
    // Canada, and the city pass above already catches the real Canadian rows.
    codes: [],
    cities: ['toronto', 'vancouver', 'montreal', 'montréal', 'ottawa', 'waterloo',
      'calgary', 'edmonton', 'mississauga', 'kitchener', 'quebec', 'québec',
      'winnipeg', 'halifax', 'ontario', 'british columbia'],
  },
  {
    code: 'DE',
    slug: 'de',
    name: 'Germany',
    inName: 'in Germany',
    hreflang: 'en-DE',
    timeZone: 'Europe/Berlin',
    currency: 'EUR',
    geoId: 101282230,
    telegram: 'https://t.me/internzo',
    countries: ['germany', 'deutschland'],
    codes: ['de'],
    cities: ['berlin', 'munich', 'münchen', 'muenchen', 'hamburg', 'frankfurt',
      'stuttgart', 'cologne', 'köln', 'duesseldorf', 'düsseldorf', 'hannover',
      'nuremberg', 'nürnberg', 'leipzig', 'dresden', 'karlsruhe', 'darmstadt',
      'walldorf', 'bremen', 'essen', 'dortmund'],
  },
  {
    code: 'IE',
    slug: 'ie',
    name: 'Ireland',
    inName: 'in Ireland',
    hreflang: 'en-IE',
    timeZone: 'Europe/Dublin',
    currency: 'EUR',
    geoId: 104738515,
    telegram: 'https://t.me/internzo',
    countries: ['ireland'],
    codes: ['ie'],
    cities: ['dublin', 'cork', 'galway', 'limerick'],
  },
  {
    code: 'NL',
    slug: 'nl',
    name: 'Netherlands',
    inName: 'in the Netherlands',
    hreflang: 'en-NL',
    timeZone: 'Europe/Amsterdam',
    currency: 'EUR',
    geoId: 102890719,
    telegram: 'https://t.me/internzo',
    countries: ['netherlands', 'nederland', 'holland'],
    codes: ['nl'],
    cities: ['amsterdam', 'rotterdam', 'eindhoven', 'utrecht', 'the hague',
      'den haag', 'delft', 'groningen', 'north holland'],
  },
  {
    code: 'FR',
    slug: 'fr',
    name: 'France',
    inName: 'in France',
    hreflang: 'en-FR',
    timeZone: 'Europe/Paris',
    currency: 'EUR',
    geoId: 105015875,
    telegram: 'https://t.me/internzo',
    countries: ['france'],
    codes: ['fr'],
    cities: ['paris', 'toulouse', 'lyon', 'grenoble', 'lille', 'nantes',
      'bordeaux', 'sophia antipolis', 'rennes', 'montpellier'],
  },
  {
    code: 'PL',
    slug: 'pl',
    name: 'Poland',
    inName: 'in Poland',
    hreflang: 'en-PL',
    timeZone: 'Europe/Warsaw',
    currency: 'PLN',
    geoId: 105072130,
    telegram: 'https://t.me/internzo',
    countries: ['poland', 'polska'],
    codes: ['pl'],
    cities: ['warsaw', 'warszawa', 'krakow', 'kraków', 'cracow', 'wroclaw',
      'wrocław', 'gdansk', 'gdańsk', 'poznan', 'poznań', 'lodz', 'katowice'],
  },
  {
    code: 'SG',
    slug: 'sg',
    name: 'Singapore',
    inName: 'in Singapore',
    hreflang: 'en-SG',
    timeZone: 'Asia/Singapore',
    currency: 'SGD',
    geoId: 102454443,
    telegram: 'https://t.me/internzo',
    countries: ['singapore'],
    codes: ['sg'],
    cities: [],
  },
  {
    code: 'AU',
    slug: 'au',
    name: 'Australia',
    inName: 'in Australia',
    hreflang: 'en-AU',
    timeZone: 'Australia/Sydney',
    currency: 'AUD',
    geoId: 101452733,
    telegram: 'https://t.me/internzo',
    countries: ['australia'],
    codes: ['au'],
    cities: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra',
      'new south wales', 'victoria, au'],
  },
];

/** code -> region. The order of REGION_LIST is the resolution order. */
export const REGIONS = Object.fromEntries(REGION_LIST.map((r) => [r.code, r]));

/** Every region, in resolution order. */
export const ALL_REGIONS = REGION_LIST;

/**
 * Build the three matchers per region, once at module load.
 *
 * Word boundaries throughout, exactly as `matchCompany` does it: without them
 * "in" matches the middle of "Berlin" and every German posting becomes Indian.
 * Spaces are matched as `\s+` so "tamil nadu" survives "Tamil  Nadu" and a
 * newline between the words.
 */
const spaced = (s) => s.replace(/ /g, '\\s+');
const anyOf = (list) => (list.length ? new RegExp(`\\b(${list.map(spaced).join('|')})\\b`, 'i') : null);

const MATCHERS = REGION_LIST.map((region) => ({
  code: region.code,
  country: anyOf(region.countries),
  city: anyOf(region.cities),
  /**
   * A country or state code, but only where one actually appears.
   *
   * Two positions, and nothing else: trailing after a comma ("London, gb",
   * "Chicago, IL") or leading before a hyphen ("PL-Warsaw-Lixa C",
   * "DE-Berlin-Trion Building"). Both shapes are real and both are taken
   * verbatim from live ATS payloads. Matching a bare two-letter word anywhere
   * in the string would be a disaster — "Fab 10N/X, Singapore" contains "in",
   * and so does every sentence in English.
   */
  code2: region.codes.length
    ? new RegExp(`(?:,\\s*(?:${region.codes.join('|')})\\s*$)|(?:^\\s*(?:${region.codes.join('|')})-)`, 'i')
    : null,
}));

/**
 * Which region is this location in?
 *
 * @param {string} location  raw location text, exactly as the collector saw it
 * @param {{fallback?: string|null}} opts
 *   `fallback` is what an EMPTY location resolves to, and it is how the two
 *   collectors differ. The LinkedIn sweep is scoped to one region by its search
 *   parameters, so a card with no location text is still known to be in that
 *   region and the collector passes it — this preserves the old rule that a
 *   blank location is kept, which mattered because both collectors leave it
 *   blank and dropping blanks lost real roles. An ATS board has no region at
 *   all (one Greenhouse board carries Dublin, San Francisco and Bengaluru in
 *   one response), so it passes nothing and a blank becomes `unknown`.
 *
 * @returns {string} an ISO 3166-1 alpha-2 code, or UNKNOWN
 */
export function resolveRegion(location, { fallback = null } = {}) {
  const text = String(location ?? '').trim();
  if (!text) return fallback ?? UNKNOWN;

  for (const m of MATCHERS) if (m.country?.test(text)) return m.code;
  for (const m of MATCHERS) if (m.city?.test(text)) return m.code;
  for (const m of MATCHERS) if (m.code2?.test(text)) return m.code;

  return UNKNOWN;
}

/**
 * The region of a stored row, re-derived at read time.
 *
 * Publish calls this rather than trusting `jobs.region`, for the same reason it
 * re-runs `matchCompany` instead of trusting `company_matched`: a row captured
 * before a fix carries the old answer, and the gazetteer here will go on
 * improving. Re-deriving means an improvement reaches every historical row on
 * the next run with no migration.
 *
 * It also keeps the documented remedy for a bad geocode working. LinkedIn
 * placed a Valeo posting in Kanda, Fukuoka as "Kanda, Uttarakhand, India", and
 * the fix is to correct the row rather than delete it — deleting it leaves
 * `card_keys` pointing at a dead id, so the card is simply reopened next
 * sighting. If publish partitioned on a stored region column, that UPDATE would
 * silently stop working.
 *
 *   UPDATE jobs SET location='Kanda, Fukuoka, Japan' WHERE job_id='4414679303';
 *
 * A real location therefore always decides. The stored column is consulted only
 * when the location is blank, where it carries what the collector knew: the
 * LinkedIn sweep is scoped to a region by its search parameters, so a card with
 * no location text is still placed, while an ATS board knows nothing and leaves
 * it unknown.
 */
export function resolveRowRegion(row) {
  return resolveRegion(row?.location, { fallback: row?.region ?? null });
}

/** The region record for a code, or null. UNKNOWN has no record. */
export function regionOf(code) {
  return REGIONS[String(code ?? '').toUpperCase()] ?? null;
}

/** The region served at a URL prefix. `''` is India, at the root. */
export function regionBySlug(slug) {
  const want = String(slug ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return REGION_LIST.find((r) => r.slug === want) ?? null;
}

/**
 * The URL prefix for a region: `''` for India, `/us` for the rest.
 *
 * Every generated link goes through this rather than concatenating a slug, so
 * India's empty slug can never produce a `//jobs/…` double slash.
 */
export function regionPath(code) {
  const region = regionOf(code);
  return region && region.slug ? `/${region.slug}` : '';
}

/**
 * Which regions get a published board.
 *
 * Deliberately separate from which regions are COLLECTED. Collection is cheap
 * and reversible — an ATS board is read once whatever its rows turn out to be,
 * so gathering every region costs nothing extra — while publishing a region is
 * a public commitment to a board that has to look worth visiting. Keeping the
 * two apart is what lets a region accumulate inventory quietly for a month
 * before anyone is shown it.
 */
export function publishedRegions(cfg) {
  const want = cfg?.regions?.publish;
  const codes = Array.isArray(want) && want.length ? want : ['IN'];
  return codes.map((c) => regionOf(c)).filter(Boolean);
}

export function isPublishedRegion(cfg, code) {
  return publishedRegions(cfg).some((r) => r.code === code);
}

/**
 * Which regions are collected.
 *
 * `"all"` — the default — means every region this module knows, plus `unknown`,
 * which is stored but never published. Storing `unknown` is the point: a
 * location this gazetteer cannot read today is a row that a better gazetteer
 * reads tomorrow without re-collecting anything.
 */
export function collectsRegion(cfg, code) {
  const want = cfg?.regions?.collect ?? 'all';
  if (want === 'all') return true;
  if (!Array.isArray(want)) return true;
  return want.includes(code);
}
