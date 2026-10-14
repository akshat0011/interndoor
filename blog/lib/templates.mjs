/* Every page the blog writes, as plain functions of their data.

   Nothing here reads the clock, the network or the disk: two builds of the
   same content produce the same bytes, so a rebuild with nothing changed
   changes nothing, and the sitemap's lastmod means what it says. */

import { esc, smartQuotes } from './markdown.mjs';
import { icon, MARK } from './icons.mjs';
import {
  SITE, MAIN, NAME, LANG, DESCRIPTION, ORG, CATEGORIES, WHATSAPP_URL,
  SUBSCRIBE_ENDPOINT, SUBSCRIBE_REGION,
} from './site.mjs';

const t = (s) => esc(smartQuotes(s));
export const THEME_SCRIPT = "try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}";

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export const postUrl = (p) => `${SITE}/${p.slug}`;
export const postPath = (p) => `/${p.slug}`;
export const catPath = (slug, page = 1) => (page > 1 ? `/${slug}/page/${page}` : `/${slug}`);

/* ------------------------------------------------------------------ head */

function ld(obj) {
  /* </script> cannot appear inside the block; < is escaped as a unicode
     escape, which JSON parsers read back as the same character. */
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

export const ORG_LD = {
  '@type': 'Organization',
  '@id': `${MAIN}/#organization`,
  name: ORG.name,
  url: ORG.url,
  logo: { '@type': 'ImageObject', url: ORG.logo, width: 512, height: 512 },
  email: ORG.email,
  sameAs: ORG.sameAs,
};

function head({ title, description, path, index = true, canonical: withCanonical = true, ogType = 'website', image, imageAlt, extra = '', assets, article = null }) {
  const canonical = `${SITE}${path === '/' ? '/' : path}`;
  return `<!doctype html>
<html lang="${LANG}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${t(title)}</title>
<meta name="description" content="${t(description)}">
${withCanonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}<meta name="robots" content="${index ? 'index,follow,max-image-preview:large' : 'noindex,follow'}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#070708">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${NAME}">
<meta property="og:locale" content="en_IN">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${t(title)}">
<meta property="og:description" content="${t(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${t(imageAlt ?? title)}">
${article ? `<meta property="article:published_time" content="${article.published}">\n${article.updated ? `<meta property="article:modified_time" content="${article.updated}">\n` : ''}<meta property="article:section" content="${esc(article.section)}">\n` : ''}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t(title)}">
<meta name="twitter:description" content="${t(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="${NAME}" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/blog.css?v=${assets.css}">
<script>${THEME_SCRIPT}</script>
<script defer src="/blog.js?v=${assets.js}"></script>
<script defer src="/_vercel/insights/script.js"></script>
${extra}</head>`;
}

/* -------------------------------------------------------- masthead, foot */

function masthead(current = '', { progress = false } = {}) {
  const here = (name, exact) => (current === name ? ` aria-current="${exact ? 'page' : 'true'}"` : '');
  const nav = [['reports', 'Reports'], ['guides', 'Guides'], ['about', 'About']];
  return `<body>
<a class="skip" href="#main">Skip to content</a>
<header class="bar">
<div class="wrap bar-in">
<a class="brand" href="/"${current === 'home' ? ' aria-current="page"' : ''}>
<span class="scope" aria-hidden="true">${MARK}</span>
<span class="word">InternDoor</span><span class="word-sub">Blog</span>
</a>
<nav class="bar-nav" aria-label="Sections">
${nav.map(([k, label]) => `<a href="/${k}"${here(k, current === k)}>${label}</a>`).join('\n')}
</nav>
<div class="bar-right">
<a class="ghost-btn" href="/search" aria-label="Search the blog"${current === 'search' ? ' aria-current="page"' : ''}>${icon('search', 18)}</a>
<button class="ghost-btn" id="theme-toggle" type="button" aria-label="Switch between dark and light theme">${icon('sun', 18, 'i-sun')}${icon('moon', 18, 'i-moon')}</button>
<a class="pill-link bar-jobs" href="${MAIN}/">Browse jobs${icon('arrowUpRight', 15)}</a>
<details class="menu">
<summary class="ghost-btn" aria-label="Menu">${icon('menu', 19)}</summary>
<nav class="menu-list" aria-label="Menu">
<a href="/reports">Reports</a>
<a href="/guides">Guides</a>
<a href="/about">About this blog</a>
<a href="/methodology">How we count</a>
<a href="${MAIN}/">Browse jobs on InternDoor</a>
</nav>
</details>
</div>
</div>
${progress ? '<div class="progress" aria-hidden="true"></div>\n' : ''}</header>`;
}

function footer(cats) {
  const catLinks = cats.map((c) => `<li><a href="/${c.slug}">${c.name}</a></li>`).join('');
  return `<footer class="foot">
<div class="wrap foot-in">
<div class="foot-brand">
<a class="brand" href="/"><span class="scope" aria-hidden="true">${MARK}</span><span class="word">InternDoor</span><span class="word-sub">Blog</span></a>
<p>Data and guides on engineering internships and entry-level jobs in India, from the postings <a href="${MAIN}/">InternDoor</a> records every day.</p>
</div>
<nav class="foot-cols" aria-label="Footer">
<div><h2>Read</h2><ul>${catLinks}<li><a href="/search">Search</a></li><li><a href="/feed.xml">RSS feed</a></li></ul></div>
<div><h2>About</h2><ul><li><a href="/about">This blog</a></li><li><a href="/methodology">How we count</a></li><li><a href="/privacy">Privacy</a></li><li><a href="mailto:${ORG.email}">${ORG.email}</a></li></ul></div>
<div><h2>InternDoor</h2><ul><li><a href="${MAIN}/">Open roles</a></li><li><a href="${MAIN}/companies">Companies</a></li><li><a href="${MAIN}/insights">Monthly reports</a></li><li><a href="${MAIN}/post-a-job">Post a job</a></li></ul></div>
</nav>
</div>
<div class="wrap foot-fine"><p>InternDoor lists engineering internships and entry-level jobs in India and never takes applications. Apply on the employer’s own posting.</p></div>
</footer>
</body>
</html>
`;
}

function page({ head: h, current, progress, body, cats }) {
  return `${h}\n${masthead(current, { progress })}\n${body}\n${footer(cats)}`;
}

/* -------------------------------------------------------------- pieces */

const metaLine = (p, minutes, { by = false } = {}) => `<p class="meta">${by ? `<span>By <a href="/about">InternDoor</a></span>` : ''}<time datetime="${p.published}">${longDate(p.published)}</time>${p.updated ? `<span>Updated <time datetime="${p.updated}">${longDate(p.updated)}</time></span>` : ''}<span>${minutes} min read</span></p>`;

function catLabel(p) {
  const c = CATEGORIES[p.category];
  return `<a class="kicker" href="/${c.slug}">${c.singular}</a>`;
}

/** A post as a row in a list: date, title, standfirst, reading time. */
export function postRow(p, minutes, { heading = 'h3' } = {}) {
  return `<li class="row">
<a class="row-link" href="${postPath(p)}">
<span class="row-date"><time datetime="${p.published}">${shortDate(p.published)}</time></span>
<span class="row-main"><${heading} class="row-title"><span>${t(p.title)}</span></${heading}><span class="row-dek">${t(p.dek)}</span></span>
<span class="row-side">${CATEGORIES[p.category].singular} · ${minutes} min${icon('arrowRight', 16, 'row-arrow')}</span>
</a>
</li>`;
}

/** A report led by its one number. */
function figureItem(p, minutes) {
  return `<article class="fig-item">
<a class="fig-link" href="${postPath(p)}">
${p.figure ? `<span class="fig-num">${esc(p.figure)}</span><span class="fig-label">${t(p.figureLabel)}</span>` : ''}
<h3 class="fig-title"><span>${t(p.title)}</span></h3>
<span class="fig-meta">${shortDate(p.published)} · ${minutes} min read</span>
</a>
</article>`;
}

export function subscribeBlock({ id = 'sub', heading = 'h2', cls = '' } = {}) {
  return `<section class="sub${cls ? ` ${cls}` : ''}" aria-labelledby="${id}-h">
<div class="sub-copy">
<${heading} id="${id}-h" class="sub-h">New roles, the day they open</${heading}>
<p>At most one email a day with the engineering internships and entry-level jobs InternDoor listed in India. Or follow the <a href="${WHATSAPP_URL}">WhatsApp channel</a>, with no signup.</p>
</div>
<form class="sub-form" action="${SUBSCRIBE_ENDPOINT}" method="post" data-endpoint="${SUBSCRIBE_ENDPOINT}" data-sub>
<label class="sub-label" for="${id}-email">Email address</label>
<div class="sub-row">
<input class="sub-input" id="${id}-email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="254" aria-describedby="${id}-msg ${id}-fine">
<button class="go" type="submit">Subscribe</button>
</div>
<input type="hidden" name="region" value="${SUBSCRIBE_REGION}">
<div class="hp" aria-hidden="true"><label>Company <input name="company" type="text" tabindex="-1" autocomplete="off"></label></div>
<p class="sub-msg" id="${id}-msg" role="status" aria-live="polite"></p>
<p class="sub-fine" id="${id}-fine">Sent through Buttondown. Every email has an unsubscribe link. <a href="/privacy">Privacy</a></p>
</form>
</section>`;
}

function shareBar(p) {
  const url = encodeURIComponent(postUrl(p));
  const title = encodeURIComponent(p.title);
  return `<div class="share" role="group" aria-label="Share this post">
<button class="share-b" type="button" data-share="${esc(postUrl(p))}" data-title="${esc(p.title)}" hidden>${icon('link', 16)}<span>Copy link</span></button>
<a class="share-b" href="https://www.linkedin.com/sharing/share-offsite/?url=${url}" aria-label="Share on LinkedIn">${icon('linkedin', 16)}<span>LinkedIn</span></a>
<a class="share-b" href="https://wa.me/?text=${title}%20${url}" aria-label="Share on WhatsApp">${icon('whatsapp', 16)}<span>WhatsApp</span></a>
<a class="share-b" href="https://x.com/intent/post?url=${url}&amp;text=${title}" aria-label="Share on X">${icon('x', 16)}<span>X</span></a>
</div>`;
}

function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map(([label, href], k) => (k === items.length - 1
    ? `<li><span aria-current="page">${t(label)}</span></li>`
    : `<li><a href="${href}">${t(label)}</a></li>`)).join('')}</ol></nav>`;
}

function crumbLd(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, href], k) => ({ '@type': 'ListItem', position: k + 1, name, item: `${SITE}${href === '/' ? '/' : href}` })),
  };
}

/* -------------------------------------------------------------- article */

export function articlePage(p, { html, headings, minutes, words, citations, related, prev, next, image, cats, assets }) {
  const cat = CATEGORIES[p.category];
  const path = postPath(p);
  const trail = [['Blog', '/'], [cat.name, `/${cat.slug}`], [p.title, path]];
  const toc = p.toc && headings.filter((h) => h.level === 2).length >= 3;
  const tocList = toc ? `<ol>${headings.map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${t(h.text)}</a></li>`).join('')}</ol>` : '';

  const order = [...citations, ...p.sources.map((s) => s.id).filter((id) => !citations.includes(id))];
  const byId = new Map(p.sources.map((s) => [s.id, s]));
  const sources = order.length ? `<section class="sources" aria-labelledby="sources">
<h2 id="sources">Sources</h2>
<ol>${order.map((id) => { const s = byId.get(id); return `<li id="src-${id}">${t(s.publisher)}, <a href="${esc(s.url)}">${t(s.title)}</a>${s.date ? `, ${longDate(s.date)}` : ''}.</li>`; }).join('\n')}</ol>
</section>` : '';

  const further = [...p.further, { label: 'Open engineering internships and entry-level jobs in India', url: `${MAIN}/` }];
  const relatedHtml = related.length ? `<section class="related wrap" aria-labelledby="related-h">
<h2 id="related-h">Read next</h2>
<ol class="rows">${related.map((r) => postRow(r.post, r.minutes)).join('\n')}</ol>
</section>` : '';
  const pager = (prev || next) ? `<nav class="pager wrap" aria-label="More posts">
${prev ? `<a class="pager-l" href="${postPath(prev)}" rel="prev"><span class="pager-k">${icon('chevronLeft', 15)}Older</span><span class="pager-t">${t(prev.title)}</span></a>` : '<span></span>'}
${next ? `<a class="pager-r" href="${postPath(next)}" rel="next"><span class="pager-k">Newer${icon('chevronRight', 15)}</span><span class="pager-t">${t(next.title)}</span></a>` : '<span></span>'}
</nav>` : '';

  const jsonld = ld({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${SITE}${path}#post`,
        headline: p.seoTitle ?? p.title,
        description: p.description,
        image: { '@type': 'ImageObject', url: image, width: 1200, height: 630 },
        datePublished: p.published,
        dateModified: p.updated ?? p.published,
        author: { '@id': `${MAIN}/#organization` },
        publisher: { '@id': `${MAIN}/#organization` },
        mainEntityOfPage: `${SITE}${path}`,
        isPartOf: { '@type': 'Blog', '@id': `${SITE}/#blog`, name: NAME, url: `${SITE}/` },
        articleSection: cat.name,
        ...(p.tags.length ? { keywords: p.tags.join(', ') } : {}),
        inLanguage: LANG,
        wordCount: words,
        ...(p.sources.length ? { citation: p.sources.map((s) => s.url) } : {}),
      },
      ORG_LD,
      crumbLd(trail),
    ],
  });

  const body = `<main id="main" class="post">
<div class="wrap">
${crumbs(trail)}
<header class="post-head">
${catLabel(p)}
<h1 class="post-title">${t(p.title)}</h1>
<p class="post-dek">${t(p.dek)}</p>
<div class="post-by">
${metaLine(p, minutes, { by: true })}
${shareBar(p)}
</div>
</header>
${p.image ? `<figure class="post-hero"><img src="${esc(p.image)}" alt="${esc(p.imageAlt)}"${p.imageWidth && p.imageHeight ? ` width="${esc(p.imageWidth)}" height="${esc(p.imageHeight)}"` : ''} decoding="async" fetchpriority="high"></figure>` : ''}
<div class="post-grid${toc ? ' has-toc' : ''}">
${toc ? `<aside class="toc" aria-labelledby="toc-h"><p class="toc-h" id="toc-h">On this page</p><nav aria-labelledby="toc-h">${tocList}</nav></aside>` : ''}
<article class="prose">
${toc ? `<details class="toc-m"><summary>${icon('list', 16)}On this page</summary><nav aria-label="On this page">${tocList}</nav></details>` : ''}
${html}
${sources}
<section class="further" aria-labelledby="further-h">
<h2 id="further-h">On InternDoor</h2>
<ul>${further.map((f) => `<li><a href="${esc(f.url)}">${t(f.label)}${icon('arrowUpRight', 15)}</a></li>`).join('')}</ul>
</section>
<div class="post-end">
<p class="post-end-k">Share this ${cat.singular.toLowerCase()}</p>
${shareBar(p)}
</div>
</article>
</div>
</div>
${subscribeBlock({ id: 'sub-post', cls: 'wrap' })}
${relatedHtml}
${pager}
</main>`;

  return page({
    head: head({
      title: `${p.seoTitle ?? p.title} | ${NAME}`,
      description: p.description,
      path,
      index: !p.noindex,
      ogType: 'article',
      image,
      imageAlt: p.title,
      extra: `${jsonld}\n`,
      assets,
      article: { published: p.published, updated: p.updated, section: cat.name },
    }),
    current: p.category,
    progress: true,
    body,
    cats,
  });
}

/* ----------------------------------------------------------------- home */

export function homePage({ posts, minutesOf, lead, leadChart, months, cats, assets, image }) {
  const reports = posts.filter((p) => p.category === 'reports' && p !== lead);
  const guides = posts.filter((p) => p.category === 'guides');
  const jsonld = ld({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Blog',
        '@id': `${SITE}/#blog`,
        name: NAME,
        url: `${SITE}/`,
        description: DESCRIPTION,
        inLanguage: LANG,
        publisher: { '@id': `${MAIN}/#organization` },
        blogPost: posts.slice(0, 10).map((p) => ({ '@type': 'BlogPosting', '@id': `${SITE}${postPath(p)}#post`, headline: p.title, url: postUrl(p), datePublished: p.published })),
      },
      ORG_LD,
    ],
  });

  const leadHtml = lead ? `<section class="lead" aria-labelledby="lead-h">
<div class="lead-copy">
${catLabel(lead)}
<h2 class="lead-title" id="lead-h"><a href="${postPath(lead)}">${t(lead.title)}</a></h2>
<p class="lead-dek">${t(lead.dek)}</p>
${metaLine(lead, minutesOf(lead))}
<a class="go lead-go" href="${postPath(lead)}">Read the report${icon('arrowRight', 16)}</a>
</div>
<div class="lead-visual">
${lead.figure ? `<p class="lead-figure"><span class="lead-num">${esc(lead.figure)}</span><span class="lead-num-label">${t(lead.figureLabel)}</span></p>` : ''}
${leadChart ?? ''}
</div>
</section>` : '';

  const reportsHtml = reports.length ? `<section class="block" aria-labelledby="research-h">
<div class="block-head"><h2 id="research-h">More research</h2><a class="more" href="/reports">All reports${icon('arrowRight', 15)}</a></div>
<div class="figs">${reports.slice(0, 4).map((p) => figureItem(p, minutesOf(p))).join('\n')}</div>
</section>` : '';

  const guidesHtml = guides.length ? `<section class="block block-split" aria-labelledby="guides-h">
<div class="block-side"><h2 id="guides-h">Guides</h2><p>Practical answers for applicants, checked against the postings we track.</p><a class="more" href="/guides">All guides${icon('arrowRight', 15)}</a></div>
<ol class="rows">${guides.slice(0, 6).map((p) => postRow(p, minutesOf(p))).join('\n')}</ol>
</section>` : '';

  const monthsHtml = months?.length ? `<section class="block months" aria-labelledby="months-h">
<div class="block-head"><h2 id="months-h">The monthly figures</h2><a class="more" href="${MAIN}/insights">All monthly reports${icon('arrowUpRight', 15)}</a></div>
<p class="block-lede">Each month is counted once and then frozen, so a figure you quote stays true. The full tables live on InternDoor.</p>
<ol class="month-list">${months.map((m) => `<li><a href="${esc(m.url)}"><span class="m-name">${esc(m.label)}</span><span class="m-stat"><b>${esc(m.rows)}</b> internships</span><span class="m-stat"><b>${esc(m.employers)}</b> employers</span><span class="m-stat"><b>${esc(m.statedPct)}</b> stated a stipend</span>${icon('arrowUpRight', 16, 'm-arrow')}</a></li>`).join('')}</ol>
</section>` : '';

  const body = `<main id="main" class="home">
<div class="wrap">
<section class="intro" aria-labelledby="intro-h">
<h1 id="intro-h">What the postings say about engineering internships in India</h1>
<p>Monthly figures and practical guides, built from the internships and entry-level jobs InternDoor records every day.</p>
</section>
${leadHtml}
${reportsHtml}
${guidesHtml}
${monthsHtml}
</div>
${subscribeBlock({ id: 'sub-home', cls: 'wrap' })}
</main>`;

  return page({
    head: head({ title: `${NAME}: data and guides on engineering internships in India`, description: DESCRIPTION, path: '/', image, imageAlt: NAME, extra: `${jsonld}\n`, assets }),
    current: 'home',
    body,
    cats,
  });
}

/* ------------------------------------------------------------- category */

export function categoryPage({ cat, posts, minutesOf, page: n, pages, cats, assets, image }) {
  const path = catPath(cat.slug, n);
  const trail = [['Blog', '/'], [cat.name, `/${cat.slug}`]];
  const pagerNav = pages > 1 ? `<nav class="pages" aria-label="Pages">
${n > 1 ? `<a href="${catPath(cat.slug, n - 1)}" rel="prev">${icon('chevronLeft', 15)}Newer</a>` : '<span></span>'}
<span class="pages-n">Page ${n} of ${pages}</span>
${n < pages ? `<a href="${catPath(cat.slug, n + 1)}" rel="next">Older${icon('chevronRight', 15)}</a>` : '<span></span>'}
</nav>` : '';
  const jsonld = ld({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', '@id': `${SITE}${path}#page`, name: cat.title, url: `${SITE}${path}`, description: cat.description, isPartOf: { '@id': `${SITE}/#blog` }, inLanguage: LANG },
      crumbLd(trail),
    ],
  });
  const body = `<main id="main" class="list">
<div class="wrap">
${crumbs(trail)}
<header class="list-head">
<h1>${t(cat.title)}</h1>
<p>${t(cat.intro)}</p>
</header>
<ol class="rows rows-wide">${posts.map((p) => postRow(p, minutesOf(p), { heading: 'h2' })).join('\n')}</ol>
${pagerNav}
</div>
</main>`;
  return page({
    head: head({ title: `${cat.title}${n > 1 ? `, page ${n}` : ''} | ${NAME}`, description: cat.description, path, image, extra: `${jsonld}\n`, assets }),
    current: cat.slug,
    body,
    cats,
  });
}

/* --------------------------------------------------------------- search */

export function searchPage({ posts, minutesOf, headingsOf, cats, assets, image }) {
  const items = posts.map((p) => {
    const hay = [p.title, p.dek, p.description, CATEGORIES[p.category].name, ...p.tags, ...headingsOf(p)].join(' ').toLowerCase();
    return postRow(p, minutesOf(p), { heading: 'h2' }).replace('<li class="row">', `<li class="row" data-text="${esc(hay)}">`);
  }).join('\n');
  const body = `<main id="main" class="list search">
<div class="wrap">
<header class="list-head">
<h1>Search the blog</h1>
<form class="search-form" role="search" action="/search" method="get">
<label class="sr-only" for="q">Search posts</label>
<span class="search-box">${icon('search', 18)}<input id="q" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="Try stipend, Python or apprentice" aria-describedby="search-count"></span>
</form>
<p class="search-count" id="search-count" role="status" aria-live="polite">${posts.length} posts</p>
</header>
<ol class="rows rows-wide" id="results">${items}</ol>
<div class="empty" id="no-results" hidden>
<h2>Nothing matched that</h2>
<p>Try a shorter word, or browse the <a href="/reports">reports</a> and <a href="/guides">guides</a>.</p>
</div>
</div>
</main>`;
  return page({
    head: head({ title: `Search | ${NAME}`, description: 'Search every report and guide on the InternDoor Blog.', path: '/search', index: false, image, assets }),
    current: 'search',
    body,
    cats,
  });
}

/* ---------------------------------------------------------- plain pages */

export function prosePage({ path, title, seoTitle, description, lede, html, current, cats, assets, image, ldType = 'WebPage' }) {
  const trail = [['Blog', '/'], [title, path]];
  const jsonld = ld({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': ldType, '@id': `${SITE}${path}#page`, name: title, url: `${SITE}${path}`, description, isPartOf: { '@id': `${SITE}/#blog` }, inLanguage: LANG, publisher: { '@id': `${MAIN}/#organization` } },
      ORG_LD,
      crumbLd(trail),
    ],
  });
  const body = `<main id="main" class="doc">
<div class="wrap">
${crumbs(trail)}
<header class="list-head">
<h1>${t(title)}</h1>
<p>${t(lede)}</p>
</header>
<div class="prose doc-prose">
${html}
</div>
</div>
</main>`;
  return page({
    head: head({ title: `${seoTitle ?? title} | ${NAME}`, description, path, image, extra: `${jsonld}\n`, assets }),
    current,
    body,
    cats,
  });
}

export function notFoundPage({ posts, minutesOf, cats, assets, image }) {
  const body = `<main id="main" class="list notfound">
<div class="wrap">
<header class="list-head">
<h1>That page is not here</h1>
<p>The address may be mistyped, or the post may have moved. Try <a href="/search">searching the blog</a>, or start from the latest posts.</p>
</header>
<ol class="rows rows-wide">${posts.slice(0, 5).map((p) => postRow(p, minutesOf(p), { heading: 'h2' })).join('\n')}</ol>
</div>
</main>`;
  return page({
    head: head({ title: `Page not found | ${NAME}`, description: 'This page does not exist on the InternDoor Blog.', path: '/404', index: false, canonical: false, image, assets }),
    current: '',
    body,
    cats,
  });
}
