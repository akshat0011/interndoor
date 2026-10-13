/* The facts every blog page agrees on. One place, so the canonical host, the
   publisher and the categories cannot drift into two spellings. */

export const SITE = 'https://blog.interndoor.com';
export const MAIN = 'https://interndoor.com';
export const NAME = 'InternDoor Blog';
export const SHORT_NAME = 'InternDoor';
export const LANG = 'en-IN';
export const DESCRIPTION = 'Original data and practical guides on engineering internships and entry-level jobs in India, from the postings InternDoor tracks every day.';

/* The publisher is the organisation, and so is the byline. The site has never
   named a person publicly and the blog does not start: an author it cannot
   stand behind is the one thing structured data must not carry. */
export const ORG = {
  name: 'InternDoor',
  url: MAIN,
  logo: `${MAIN}/logo-512.png`,
  email: 'akshat@interndoor.com',
  sameAs: [
    'https://www.linkedin.com/company/interndoorhq/',
    'https://whatsapp.com/channel/0029VbEJ2qLBA1eq3S5hBE3P',
  ],
};

/* India's one channel. test/blog.test.mjs holds this to config.json, so a new
   channel URL cannot leave the blog pointing at the old one. */
export const WHATSAPP_URL = 'https://whatsapp.com/channel/0029VbEJ2qLBA1eq3S5hBE3P';

/* The daily email is the main site's Buttondown list. The browser calls the
   main site's endpoint directly (web/api/subscribe.js allows this one origin),
   so the provider sees the reader's own address and nothing new stores it. */
export const SUBSCRIBE_ENDPOINT = `${MAIN}/api/subscribe`;
export const SUBSCRIBE_REGION = 'IN';

/* A category exists only while it has posts: build.mjs writes no page for an
   empty one and links none. */
export const CATEGORIES = {
  reports: {
    slug: 'reports',
    name: 'Reports',
    singular: 'Report',
    title: 'Hiring reports',
    description: 'Monthly and topical reports built from the engineering internships and entry-level jobs InternDoor records in India. Every figure carries its count and its method.',
    intro: 'Reports built from the engineering internships and entry-level jobs InternDoor records in India. Every figure carries its count, and every report says what it does not cover.',
  },
  guides: {
    slug: 'guides',
    name: 'Guides',
    singular: 'Guide',
    title: 'Guides for applicants',
    description: 'Practical guides for engineering students in India applying for internships and entry-level jobs, grounded in the postings InternDoor tracks.',
    intro: 'Practical guides for engineering students applying for internships and entry-level jobs in India. Where a guide makes a claim about postings, it says how many it looked at.',
  },
};

export const PER_PAGE = 12;

/* Pages that are not posts. Each one is written by build.mjs and listed in the
   sitemap unless `index` is false. */
export const STATIC_PAGES = {
  about: { path: '/about', index: true },
  methodology: { path: '/methodology', index: true },
  privacy: { path: '/privacy', index: true },
  search: { path: '/search', index: false },
};

export const WORDS_PER_MINUTE = 230;
