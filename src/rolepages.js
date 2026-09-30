/**
 * Role pages — "software engineering internships", "data engineer fresher jobs
 * in bangalore". 1 Oct 2026, his ask: "make role category pages … try
 * everything we can to make google show our site more".
 *
 * The board has always known the role family of every posting (rolefocus.js,
 * which files each one on the Software / Hardware / Misc shelves), and until now
 * no page existed for one. People search by ROLE far more than by skill: the
 * skill pages answer "python internship", nothing answered "devops fresher jobs".
 *
 * TWO KINDS OF PAGE, AND THE THRESHOLDS ARE THE WHOLE DESIGN — the same rule
 * the skill and city pages follow (facets.js). A role page with three postings
 * on it is thin, and a site of them is the doorway-page shape Google demotes:
 *  - /roles/<role>             at ROLE_MIN (8) live postings
 *  - /roles/<role>-in-<city>   at ROLE_CITY_MIN (10) — stricter, because a
 *    role-in-a-city page shares most of its rows with two other pages and has
 *    to carry enough of its own to be worth a separate URL.
 * Below the bar a page is not written at all, and nothing links to it.
 *
 * A POSTING BELONGS TO A ROLE PAGE ON TWO FACTS: its family (decided once, at
 * publish, by the same roleCategory call that decides its shelf) AND its shelf.
 * The shelf is the second fact because shelfMove (titles.js) can move a
 * Software-family title to Misc — Accenture's "Enterprise AI Value Strategy"
 * analyst reads as the ai_ml family on the word "AI" and is a strategy
 * consultant's job. Without the shelf check it would sit on the AI page.
 *
 * Pure: no config, no store, no files. Rendering is in pages.js.
 */
import { roleFamily } from './rolefocus.js';
import { canonicalCity, facetSlug } from './facets.js';

export const ROLE_MIN = 8;
export const ROLE_CITY_MIN = 10;

/**
 * Every role page the site may write, in the order the index lists them.
 *
 *  slug      the URL segment, /roles/<slug>
 *  families  rolefocus.js family keys it collects
 *  shelf     the shelf a posting must be on (software / hardware / misc)
 *  name      sentence case, for headings and prose
 *  title     Title Case and SHORT, for the <title> — "AI & ML" and not the
 *            full name, because "<title> Internships & Entry-Level Jobs in
 *            India" has to fit in 60 characters
 *  about     what the work is. Written by hand, one per page, and limited to
 *            what is true of the field everywhere: nothing here claims a
 *            number, a salary or a trend. Everything numeric on the page is
 *            counted from the live postings.
 */
export const ROLE_PAGES = [
  {
    slug: 'software-engineering', families: ['swe'], shelf: 'software',
    name: 'Software engineering', title: 'Software Engineering',
    about: 'Software engineers design, write, test and maintain the code behind a company’s products and internal systems. Entry-level roles in India go by many titles — Software Engineer, SDE-1, Associate Software Engineer, Software Developer — and most ask for data structures, one programming language used well, and the basics of how software is built and shipped.',
  },
  {
    slug: 'ai-machine-learning', families: ['ai_ml'], shelf: 'software',
    name: 'AI, machine learning and data science', title: 'AI & ML',
    about: 'These roles build and evaluate models: machine learning, deep learning, NLP, computer vision and, increasingly, applications built on large language models. Data science roles sit here too. Most postings ask for Python and the core libraries, some statistics, and experience training or fine-tuning a model on real data.',
  },
  {
    slug: 'data-engineering-analytics', families: ['data_eng'], shelf: 'software',
    name: 'Data engineering and data analyst', title: 'Data & Analytics',
    about: 'Data engineers build the pipelines and warehouses that move and store a company’s data; data analysts query it to answer business questions. SQL is the common ground, with Python, Spark and a cloud data platform on the engineering side and dashboards and reporting on the analyst side.',
  },
  {
    slug: 'backend-development', families: ['backend'], shelf: 'software',
    name: 'Backend development', title: 'Backend Developer',
    about: 'Backend developers build the services, APIs and databases behind an application — the parts a user never sees. Common stacks are Java with Spring Boot, Node.js, Python, Go and .NET, alongside SQL and an understanding of how services talk to each other.',
  },
  {
    slug: 'full-stack-development', families: ['fullstack'], shelf: 'software',
    name: 'Full-stack development', title: 'Full Stack Developer',
    about: 'Full-stack developers work on both halves of a web application: the interface in the browser and the server and database behind it. Common combinations are the MERN stack (MongoDB, Express, React, Node) and a Java or Python backend with a JavaScript framework in front.',
  },
  {
    slug: 'frontend-development', families: ['frontend'], shelf: 'software',
    name: 'Frontend and web development', title: 'Frontend Developer',
    about: 'Frontend developers build what a user sees and clicks — web pages and web apps — in HTML, CSS and JavaScript or TypeScript, usually with a framework such as React or Angular. Postings often ask for an eye for layout and accessibility as well as the code.',
  },
  {
    slug: 'mobile-app-development', families: ['mobile'], shelf: 'software',
    name: 'Mobile app development', title: 'Mobile App Developer',
    about: 'Mobile developers build Android and iOS apps, natively in Kotlin or Swift or across both platforms with Flutter or React Native.',
  },
  {
    slug: 'devops-cloud', families: ['devops'], shelf: 'software',
    name: 'DevOps, cloud and site reliability', title: 'DevOps & Cloud',
    about: 'DevOps, cloud and site reliability engineers keep software running: they build the pipelines that test and deploy it, manage the cloud infrastructure it runs on and respond when it breaks. The usual asks are Linux, a cloud platform (AWS, Azure or GCP), containers and Kubernetes, and scripting.',
  },
  {
    slug: 'qa-testing', families: ['qa'], shelf: 'software',
    name: 'QA and software testing', title: 'QA & Testing',
    about: 'QA engineers and SDETs find the bugs before users do, through manual test plans and, more and more, automated tests written in code. Selenium, Playwright, API testing and a scripting language such as Java or Python are the usual asks.',
  },
  {
    slug: 'cybersecurity', families: ['security'], shelf: 'software',
    name: 'Cybersecurity', title: 'Cybersecurity',
    about: 'Security roles protect systems and data: monitoring for attacks, testing defences, securing cloud accounts and code, and managing who can access what. Postings ask for networking and operating-system fundamentals, and often for a security tool or certification.',
  },
  {
    slug: 'vlsi-hardware', families: ['hardware'], shelf: 'hardware',
    name: 'VLSI, chip design and hardware', title: 'VLSI & Hardware',
    about: 'Hardware roles design and verify chips and electronics: RTL design in Verilog or VHDL, design verification with SystemVerilog and UVM, physical design, analog and RF. Most postings ask for an electronics degree and working knowledge of the EDA tools used at that stage of the flow.',
  },
  {
    slug: 'embedded-systems', families: ['embedded'], shelf: 'hardware',
    name: 'Embedded systems and firmware', title: 'Embedded Systems',
    about: 'Embedded engineers write the software that runs on devices rather than on servers — firmware for microcontrollers, drivers, and real-time systems in cars, medical devices and consumer electronics. C and C++ are near-universal, with an RTOS or embedded Linux and some electronics.',
  },
  {
    slug: 'core-engineering', families: ['core_eng'], shelf: 'misc',
    name: 'Core engineering (mechanical, electrical, civil)', title: 'Core Engineering',
    about: 'Core engineering roles are the traditional disciplines — mechanical, electrical, civil, chemical, manufacturing and quality — at employers who also hire software engineers. Postings ask for the degree in that discipline and, often, a design or simulation tool.',
  },
  {
    slug: 'it-support', families: ['it_support'], shelf: 'misc',
    name: 'IT support and networking', title: 'IT Support',
    about: 'IT support, networking and application-support roles keep a company’s systems, networks and business applications working for the people who use them. Postings ask for operating systems, networking basics and troubleshooting, and often a willingness to work shifts.',
  },
  {
    slug: 'sap-salesforce', families: ['enterprise'], shelf: 'misc',
    name: 'SAP, Salesforce and enterprise software', title: 'SAP & Salesforce',
    about: 'These roles configure and extend the large business platforms companies run on — SAP, Salesforce, ServiceNow, Oracle and similar. Some are functional (setting the platform up for a business process), some technical (building on it in its own language).',
  },
  {
    slug: 'research', families: ['research'], shelf: 'misc',
    name: 'Research', title: 'Research',
    about: 'Research roles — at industrial labs, trading firms and R&D centres — study a problem rather than ship a product: publishing, prototyping and testing ideas. Most ask for a strong academic record, and many for a master’s or PhD in progress.',
  },
];

const BY_SLUG = new Map(ROLE_PAGES.map((d) => [d.slug, d]));
export const rolePageDef = (slug) => BY_SLUG.get(slug) ?? null;

/**
 * The role page a posting belongs on, or null. `family` and `category` are
 * set by publish (decided once, like the shelf); a row without them — every
 * test fixture, and any caller holding a store row — falls back to the title's
 * family and to no shelf check, which is the only reading available.
 */
export function rolePageOf(job) {
  const family = job?.family ?? roleFamily(job?.slugTitle ?? job?.title);
  for (const d of ROLE_PAGES) {
    if (!d.families.includes(family)) continue;
    if (job?.category != null && job.category !== d.shelf) continue;
    return d;
  }
  return null;
}

/** "/roles/software-engineering-in-bengaluru". Shared by the writer and every link. */
export const roleCitySlug = (roleSlug, citySlug) => `${roleSlug}-in-${citySlug}`;

/**
 * The role pages worth writing, and the role-in-a-city pages under them.
 * Ordered by size then slug, so two publishes of the same rows are identical.
 *
 * @param {object[]} jobs published rows for ONE board
 */
export function roleGroups(jobs, { min = ROLE_MIN, cityMin = ROLE_CITY_MIN } = {}) {
  const byRole = new Map();
  for (const j of jobs ?? []) {
    const d = rolePageOf(j);
    if (!d) continue;
    if (!byRole.has(d.slug)) byRole.set(d.slug, []);
    byRole.get(d.slug).push(j);
  }
  const bySize = (a, b) => b.jobs.length - a.jobs.length || a.slug.localeCompare(b.slug);
  const roles = [...byRole]
    .filter(([, rows]) => rows.length >= min)
    .map(([slug, rows]) => ({ slug, def: BY_SLUG.get(slug), jobs: rows }))
    .sort(bySize);

  const combos = [];
  for (const r of roles) {
    const byCity = new Map();
    for (const j of r.jobs) {
      const city = canonicalCity(j.location);
      if (!city) continue;
      const cs = facetSlug(city);
      if (!byCity.has(cs)) byCity.set(cs, { city, jobs: [] });
      byCity.get(cs).jobs.push(j);
    }
    for (const [citySlug, v] of byCity) {
      if (v.jobs.length < cityMin) continue;
      combos.push({ slug: roleCitySlug(r.slug, citySlug), roleSlug: r.slug, def: r.def, city: v.city, citySlug, jobs: v.jobs });
    }
  }
  combos.sort(bySize);
  return { roles, combos };
}

/**
 * A stable rank for the pair (a, b): FNV-1a over both ids.
 *
 * WHY NOT NEWEST FIRST. A job page's "similar roles" strip chosen newest-first
 * changes on every page in the family the moment one new posting arrives —
 * pages.js already refuses that for the "just landed" strip, because it would
 * rewrite every job page on every publish and announce them all to IndexNow
 * (§10). Ranked by a hash of the pair, a page's picks change only when one of
 * them expires or a newcomer happens to hash below the sixth, and the links
 * spread evenly over the whole family instead of piling onto the newest few —
 * which is what a job page waiting in "Discovered – currently not indexed"
 * needs: somebody linking to it.
 */
export function stableRank(a, b) {
  let h = 0x811c9dc5;
  const s = `${a}|${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
