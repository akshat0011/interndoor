/**
 * The retired boards — /us, /uk and /ca — answer 410 Gone. 30 Sep 2026.
 *
 * InternDoor lists India only now (his call). Those boards held ~5,000 job,
 * company and facet pages Google had crawled. A deleted static file on Vercel
 * answers 404; 410 is the stronger statement — this was here and was removed
 * on purpose — and Google drops a 410 from its index sooner than a 404.
 *
 * NOT A REDIRECT, DELIBERATELY. A US vacancy has no India equivalent, and
 * sending every old URL to the India board is the "soft 404" pattern Google
 * treats as a 404 anyway, while misleading the reader who clicked. The body
 * says what happened and links the India board for a person; the status tells
 * the crawler the truth.
 *
 * web/vercel.json rewrites /us, /uk, /ca and everything under them here. A
 * rewrite only applies when no static file matches, and publish deletes those
 * trees (removeUnpublishedRegions), so nothing live is shadowed.
 */

const BODY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This board has closed | InternDoor</title>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<main class="wrap">
<h1>This board has closed</h1>
<p>InternDoor now lists engineering internships and entry-level jobs in India only, so this page is no longer available.</p>
<p><a href="https://interndoor.com/">See every live role in India</a></p>
</main>
</body>
</html>
`;

export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method === 'HEAD') return res.status(410).end();
  return res.status(410).send(BODY);
}
