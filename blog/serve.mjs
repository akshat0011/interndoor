#!/usr/bin/env node
/* Local preview of blog/public, served the way Vercel will serve it:
   cleanUrls, no trailing slashes, 404.html for a miss, and EVERY header from
   blog/vercel.json, the Content-Security-Policy included. The main site's
   preview sends no CSP, which is how inline scripts kept passing locally and
   failing in production; this one sends the real policy.

     node blog/serve.mjs            http://localhost:4340
     PORT=4341 node blog/serve.mjs */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const PORT = Number(process.env.PORT || 4340);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/* Vercel's source patterns, as far as this config uses them: a literal path,
   or one with a (.*) group. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toRegex = (source) => new RegExp(`^${source.split('(.*)').map(escapeRe).join('.*')}$`);
const headerRules = config.headers.map((h) => ({ re: toRegex(h.source), headers: h.headers }));

function resolve(pathname) {
  if (pathname === '/') return join(PUBLIC, 'index.html');
  const base = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!base.startsWith(PUBLIC)) return null;
  for (const f of [base, `${base}.html`, join(base, 'index.html')]) {
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  for (const rule of headerRules) if (rule.re.test(url.pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
  /* The analytics script exists only on Vercel. An empty script keeps the
     console clean without pretending to count anything. */
  if (url.pathname.startsWith('/_vercel/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(''); }
  if (config.trailingSlash === false && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    res.writeHead(308, { location: url.pathname.slice(0, -1) + url.search });
    return res.end();
  }
  if (config.cleanUrls && url.pathname.endsWith('.html')) {
    const clean = url.pathname.replace(/(\/index)?\.html$/, '') || '/';
    res.writeHead(308, { location: clean + url.search });
    return res.end();
  }
  const file = resolve(url.pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': TYPES['.html'] });
    return res.end(readFileSync(join(PUBLIC, '404.html')));
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`InternDoor Blog on http://localhost:${PORT}`));
