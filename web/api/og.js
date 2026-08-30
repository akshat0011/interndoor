/**
 * The Open Graph card for one posting, drawn on request.
 *
 * WHY THIS IS NOT A FILE ON DISK. Every job page used to serve the same generic
 * og.jpg, so every share of every role looked identical — on the one element a
 * reader sees before any text. Drawing a card per posting and committing it
 * works, and was measured: ~46KB each, and it will not compress further (four
 * JPEG quality levels and removing the film grain all landed within 8KB,
 * because the cost is the radar gradient and the type rather than the noise).
 * That is +44MB for today's board and ~1.7GB a YEAR of git history, in a public
 * repo Vercel clones on every one of its 48 daily deploys — and git history
 * cannot be pruned without rewriting a public repo, so it does not come back.
 * Rendering on request costs nothing per job and covers postings that do not
 * exist yet.
 *
 * SATORI AND RESVG DIRECTLY, NOT @vercel/og. That package is built to be
 * consumed by Next.js's bundler and is unusable in a plain Vercel function in
 * BOTH runtimes, which cost one failed deploy to learn:
 *   - on Edge it imports `./resvg.wasm?module` and `./yoga.wasm?module`, a
 *     framework-specific convention the plain Edge bundler cannot resolve —
 *     "The Edge Function api/og is referencing unsupported modules".
 *   - on Node it declares "type": "module" and yet ships `require("fs")`, so
 *     Node loads it as ESM and throws "Dynamic require of fs is not supported".
 * satori is pure JS and resvg is a wasm module we initialise ourselves, so
 * neither needs a bundler to rewrite anything.
 *
 * THE NODE RUNTIME, DELIBERATELY. Everything here can then be exercised
 * locally, end to end, before it ships — which is the whole reason the previous
 * attempt failed in production instead of on this machine.
 *
 * IMMUTABLE, AND THAT IS WHAT MAKES IT CHEAP. A card for a given job id never
 * changes, so the response is cached for a year and the work below happens once
 * per posting no matter how often the link is shared.
 *
 * BY ID, NEVER BY ARBITRARY TEXT. The obvious design passes the company and
 * role in the query string and skips the lookup. It is also a way to render any
 * text at all inside our own branding, on our own domain. Taking an id and
 * reading the published jobs.json means only real listings can ever be drawn.
 */
import { readFileSync } from 'node:fs';
import { buildCard, REGION_PREFIX } from './_card.js';

/* The logo is fetched from the CANONICAL domain, not the request's own origin.
   Satori refuses a localhost image as an SSRF risk, so the request origin
   cannot be used on the dev server; and a preview deployment does not carry
   its own copy of every employer logo, while interndoor.com always does. */
const SITE = 'https://interndoor.com';

const asset = (name) => readFileSync(new URL(`./assets/${name}`, import.meta.url));

/* Read once per warm instance, not per request. The fonts are 223KB and the
   rasteriser 2.4MB; paying that on every share would be the whole cost of the
   feature. */
/* DYNAMIC, and inside the guarded path on purpose. A static import that fails
   to resolve throws before any of our code runs, so the whole function 500s
   instead of falling back — which is what happened on the first deploy of this
   and could not be diagnosed from the outside at all. Imported here, a broken
   module is just another reason to serve the generic card, and the reason
   comes back on the x-og-error header. */
let ready;
function boot() {
  ready ??= (async () => {
    const [satoriMod, resvgMod] = await Promise.all([
      import('satori'),
      import('@resvg/resvg-wasm'),
    ]);
    await resvgMod.initWasm(asset('resvg.wasm'));
    return {
      satori: satoriMod.default ?? satoriMod,
      Resvg: resvgMod.Resvg,
      fonts: [
        { name: 'Archivo', data: asset('archivo-900.ttf'), weight: 900, style: 'normal' },
        { name: 'JetBrains Mono', data: asset('jetbrains-700.ttf'), weight: 700, style: 'normal' },
      ],
    };
  })();
  return ready;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, origin(req));
    const id = url.searchParams.get('id');
    const region = String(url.searchParams.get('r') ?? 'IN').toUpperCase();
    const prefix = REGION_PREFIX[region];

    // An unknown region is refused rather than coerced: guessing would look up
    // the wrong board, and a card drawn for the wrong posting is worse than none.
    if (!id || prefix === undefined) return generic(res, url);

    /* NOT named `origin`: a local const of that name shadows the origin()
       helper below for the whole function body, so every call to it throws
       "Cannot access 'origin' before initialization" and every card silently
       falls back to the generic one. Same trap as `const location` inside
       openAndExtract. */
    const site = url.origin;
    const board = await fetch(`${site}${prefix}/data/jobs.json`, {
      headers: { accept: 'application/json' },
    });
    if (!board.ok) return generic(res, url);

    const job = (await board.json()).jobs?.find((j) => String(j.id) === id);
    if (!job) return generic(res, url);

    const { satori, Resvg, fonts } = await boot();
    const svg = await satori(buildCard({
      company: job.company ?? '',
      title: job.title ?? '',
      facts: job.cardFacts ?? [],
      logo: job.logo ? `${SITE}${job.logo}` : '',
    }), { width: 1200, height: 630, fonts });

    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
      .render().asPng();

    res.setHeader('content-type', 'image/png');
    /* A card for a given job id never changes, so this is drawn once per
       posting however often the link is shared. It is the whole reason
       rendering on request is cheaper than committing 46KB a job. */
    res.setHeader('cache-control', 'public, immutable, no-transform, max-age=31536000');
    return res.status(200).end(Buffer.from(png));
  } catch (err) {
    /* NEVER 500. A preview image that errors is a broken card on somebody's
       shared link; the generic one is a worse card but a working one.
       The reason travels on a header rather than in the body: a redirect has
       no body a crawler would read, and a deployed function that quietly falls
       back is otherwise undiagnosable from outside. It carries the message
       only, never a stack, and is truncated. */
    console.error('og:', err);
    return generic(res, new URL(req.url, origin(req)),
      String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200));
  }
}

/* Vercel always sets x-forwarded-proto; the local dev server does not, and
   assuming https there builds an https URL for an http server so the board
   fetch dies and every card silently falls back to the generic one. */
function origin(req) {
  const proto = req.headers['x-forwarded-proto']
    ?? (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

function generic(res, url, why = '') {
  if (why) res.setHeader('x-og-error', why);
  res.setHeader('location', `${url.origin}/og.jpg?v=5`);
  return res.status(302).end();
}
