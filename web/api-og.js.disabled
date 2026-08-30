/**
 * The Open Graph card for one posting, rendered on request.
 *
 * WHY THIS IS NOT A FILE ON DISK. Every job page used to serve the same generic
 * og.jpg, so every share of every role looked identical — on the one element a
 * reader sees before any text. Drawing a card per posting and committing it
 * works, and was measured: ~46KB each (it will not compress further; four
 * quality levels and removing the film grain all landed within 8KB), which is
 * +44MB for today's board and ~1.7GB a YEAR of git history that cannot be
 * pruned without rewriting a public repo. Rendering on request costs nothing
 * per job and covers postings that do not exist yet.
 *
 * IMMUTABLE, AND THAT IS WHAT MAKES IT CHEAP. A card for a given job id never
 * changes, so the response is cached for a year at the edge and the work below
 * happens once per posting no matter how often the link is shared.
 *
 * BY ID, NEVER BY ARBITRARY TEXT. The obvious design is to pass the company and
 * role in the query string and skip the lookup. It is also a way to render any
 * text at all inside our own branding, on our own domain — a card saying
 * anything, carrying the credibility of the site. Taking an id and reading the
 * published jobs.json means only real listings can ever be drawn.
 *
 * SATORI IS FLEXBOX ONLY. No grid, no floats, no CSS filters; every element
 * with more than one child needs an explicit display:flex. The radar is an
 * inline SVG data URI rather than live SVG elements for the same reason.
 */
import { ImageResponse } from '@vercel/og';
import { buildCard, REGION_PREFIX } from './_card.js';

export const config = { runtime: 'edge' };

/* Fonts are read once per isolate, not per request. Two faces, 223KB: Archivo
   for the wordmark and the role, JetBrains Mono for everything set as a label. */
let fontsPromise;
function fonts() {
  fontsPromise ??= Promise.all([
    fetch(new URL('./fonts/archivo-900.ttf', import.meta.url)).then((r) => r.arrayBuffer()),
    fetch(new URL('./fonts/jetbrains-700.ttf', import.meta.url)).then((r) => r.arrayBuffer()),
  ]).then(([archivo, mono]) => ([
    { name: 'Archivo', data: archivo, weight: 900, style: 'normal' },
    { name: 'JetBrains Mono', data: mono, weight: 700, style: 'normal' },
  ]));
  return fontsPromise;
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const region = String(url.searchParams.get('r') ?? 'IN').toUpperCase();
    const prefix = REGION_PREFIX[region];

    // An unknown region is refused rather than coerced: guessing would draw a
    // card for the wrong board's posting, or none at all after a slow fetch.
    if (!id || prefix === undefined) return redirectToGeneric(url);

    const res = await fetch(`${url.origin}${prefix}/data/jobs.json`, {
      // The board changes every half hour; the card for one posting does not.
      cf: { cacheTtl: 300 }, headers: { accept: 'application/json' },
    });
    if (!res.ok) return redirectToGeneric(url);

    const job = (await res.json()).jobs?.find((j) => String(j.id) === id);
    if (!job) return redirectToGeneric(url);

    return new ImageResponse(
      buildCard({
        company: job.company ?? '',
        title: job.title ?? '',
        facts: job.cardFacts ?? [],
        logo: job.logo ? `${url.origin}${job.logo}` : '',
      }),
      {
        width: 1200,
        height: 630,
        fonts: await fonts(),
        headers: {
          /* A card for a given job id never changes, so this is drawn once per
             posting however often the link is shared. It is the whole reason
             rendering on request is cheaper than committing 46KB a job. */
          'cache-control': 'public, immutable, no-transform, max-age=31536000',
        },
      },
    );
  } catch {
    /* NEVER 500. A preview image that errors is a broken card on somebody's
       shared link; the generic one is a worse card but a working one. */
    return redirectToGeneric(new URL(req.url));
  }
}

function redirectToGeneric(url) {
  return Response.redirect(`${url.origin}/og.jpg?v=5`, 302);
}
