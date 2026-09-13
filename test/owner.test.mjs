/**
 * Owner controls — src/owner.js, the job_edits table, the publish wiring, and
 * the two browser files that load them.
 *
 * The failures that matter, in order:
 *   1. SOMEONE WHO IS NOT HIM DRIVES THE HELPER. The live site's JavaScript can
 *      reach 127.0.0.1 from any browser, so the token, the origin allowlist and
 *      the host check are what stand between a stranger's page and "block
 *      Google from the board".
 *   2. A VISITOR'S BROWSER TOUCHES 127.0.0.1 AT ALL. The loaders must add
 *      /owner.js only where a token is stored, and owner.js must do nothing
 *      without one — otherwise every visitor meets Chrome's "reach apps on this
 *      device" prompt, on a job board.
 *   3. AN EDIT IS PUBLISHED WRONG — the old pay figure winning over his
 *      correction, or a corrected title 404ing the page Google already holds.
 */
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import {
  ownerToken, ownerAuth, corsHeaders, localHost, parseEdit, applyJobEdit, applyJobEdits,
  slugFromPath, OWNER_ORIGINS, TOKEN_HEADER,
} from '../src/owner.js';
import { Store } from '../src/store.js';
import { titleEditRedirects, publishedPaths } from '../src/publish.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const PORT = 4322;
const TOKEN = 'a'.repeat(48);
const req = (headers) => ({ headers });
const good = { host: `127.0.0.1:${PORT}`, origin: 'https://interndoor.com', [TOKEN_HEADER]: TOKEN };

console.log('\n== ONLY HIS BROWSER, ON THE SITE, WITH THE TOKEN ==');
{
  check('the site with the token is the owner', ownerAuth(req(good), { port: PORT, token: TOKEN }), { ok: true });
  check('localhost is the same machine', ownerAuth(req({ ...good, host: `localhost:${PORT}` }), { port: PORT, token: TOKEN }).ok, true);
  check('a wrong token is refused', ownerAuth(req({ ...good, [TOKEN_HEADER]: 'b'.repeat(48) }), { port: PORT, token: TOKEN }).status, 401);
  check('no token is refused', ownerAuth(req({ ...good, [TOKEN_HEADER]: undefined }), { port: PORT, token: TOKEN }).status, 401);
  check('a token of a different length is refused, not thrown on',
    ownerAuth(req({ ...good, [TOKEN_HEADER]: 'a' }), { port: PORT, token: TOKEN }).status, 401);
  check('an empty expected token cannot be matched by an empty header',
    ownerAuth(req({ ...good, [TOKEN_HEADER]: '' }), { port: PORT, token: '' }).ok, false);
  check('another site, even with the token, is refused',
    ownerAuth(req({ ...good, origin: 'https://evil.example' }), { port: PORT, token: TOKEN }).status, 403);
  check('a lookalike of our domain is refused',
    ownerAuth(req({ ...good, origin: 'https://interndoor.com.evil.example' }), { port: PORT, token: TOKEN }).status, 403);
  check('plain http on our domain is refused', ownerAuth(req({ ...good, origin: 'http://interndoor.com' }), { port: PORT, token: TOKEN }).status, 403);
  /* A browser always sends Origin on a cross-origin fetch, and the site is
     always cross-origin to 127.0.0.1; a caller with none is not his browser. */
  check('no Origin at all is refused, the token alone is not enough',
    ownerAuth(req({ ...good, origin: undefined }), { port: PORT, token: TOKEN }).status, 403);
  /* DNS rebinding: an attacker's hostname resolved to 127.0.0.1 makes their
     page same-origin with the helper. The Host header still names them. */
  check('a rebound hostname is refused', ownerAuth(req({ ...good, host: `evil.example:${PORT}` }), { port: PORT, token: TOKEN }).status, 403);
  check('the right host on the wrong port is refused', localHost(req({ host: '127.0.0.1:9999' }), PORT), false);
}

console.log('\n== CORS ANSWERS OUR ORIGINS AND NOTHING ELSE ==');
{
  const h = corsHeaders(req({ origin: 'https://interndoor.com' }));
  check('our origin is echoed, never *', h?.['access-control-allow-origin'], 'https://interndoor.com');
  check('the private-network preflight is answered', h?.['access-control-allow-private-network'], 'true');
  check('the token header is allowed', /x-owner-token/.test(h?.['access-control-allow-headers'] ?? ''), true);
  check('responses vary by Origin', h?.vary, 'Origin');
  check('another origin gets no CORS headers at all', corsHeaders(req({ origin: 'https://evil.example' })), null);
  check('no origin gets none', corsHeaders(req({})), null);
  check('the allowlist is the site and the local preview only',
    [...OWNER_ORIGINS].sort(), ['http://127.0.0.1:4321', 'http://localhost:4321', 'https://interndoor.com', 'https://www.interndoor.com']);
}

console.log('\n== THE TOKEN FILE ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'owner-token-'));
  const file = join(dir, 'owner-token');
  const t1 = ownerToken(file);
  check('a token is 48 hex characters', /^[a-f0-9]{48}$/.test(t1), true);
  check('the file is readable by him alone', (statSync(file).mode & 0o777).toString(8), '600');
  check('it is reused, not regenerated, so pairing survives a restart', ownerToken(file), t1);
  writeFileSync(file, 'short\n');
  const t2 = ownerToken(file);
  check('a malformed file is replaced with a real token', /^[a-f0-9]{48}$/.test(t2) && t2 !== 'short', true);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== WHAT AN EDIT MAY CONTAIN ==');
{
  check('fields are trimmed and inner whitespace collapsed',
    parseEdit({ title: '  Software   Engineer Intern ' }), { edit: { title: 'Software Engineer Intern' } });
  check('an empty field clears that override', parseEdit({ stipend: '' }), { edit: { stipend: null } });
  check('a field left out is not touched', Object.keys(parseEdit({ location: 'Pune' }).edit), ['location']);
  check('a newline is refused, not repaired', parseEdit({ title: 'Intern\nBcc: x' }).error, 'title contains a control character');
  check('an over-long field is refused', /longer than 80/.test(parseEdit({ stipend: 'x'.repeat(81) }).error ?? ''), true);
  check('a non-string is refused', parseEdit({ title: 42 }).error, 'title must be text');
  check('an empty body is refused', parseEdit({}).error, 'nothing to change');
  check('unknown fields are ignored, not stored', parseEdit({ title: 'A', is_tech: 1 }), { edit: { title: 'A' } });
}

console.log('\n== AN EDIT LAID OVER A ROW ==');
{
  const row = {
    job_id: '9', company: 'Acme', title: 'Intern', location: 'Bengaluru', salary_text: '₹0',
    stipend_min: 76398, stipend_max: 95702, stipend_currency: 'INR', stipend_period: 'hour',
  };
  const out = applyJobEdit(row, { title: 'Backend Intern', location: null, stipend: '₹25,000 / month' });
  check('the title is replaced', out.title, 'Backend Intern');
  check('and the original kept, for the old URL', out.original_title, 'Intern');
  check('a null field leaves the posting\'s own value', out.location, 'Bengaluru');
  check('the pay text is his', out.salary_text, '₹25,000 / month');
  /* formatStipend reads the figures BEFORE salary_text, and safeBaseSalary
     publishes them as structured data — both would state the wrong number. */
  check('and the old structured figures are cleared with it',
    [out.stipend_min, out.stipend_max, out.stipend_currency, out.stipend_period], [null, null, null, null]);
  check('the stored row itself is not mutated', row.title, 'Intern');
  check('no edit returns the row untouched', applyJobEdit(row, undefined), row);
  const rows = [row, { job_id: '10', title: 'Other' }];
  check('edits apply by job id only', applyJobEdits(rows, new Map([['9', { title: 'X' }]])).map((r) => r.title), ['X', 'Other']);
  check('no edits at all returns the same array', applyJobEdits(rows, new Map()) === rows, true);
}

console.log('\n== THE job_edits TABLE ==');
{
  const s = new Store(':memory:');
  check('empty to begin with', s.jobEdits().size, 0);
  s.saveJobEdit('9', { title: 'Backend Intern' });
  s.saveJobEdit('9', { stipend: '₹25,000 / month' });
  check('edits to one posting MERGE', s.jobEdits().get('9'), { title: 'Backend Intern', location: null, stipend: '₹25,000 / month' });
  s.saveJobEdit('9', { title: null });
  check('a null clears only that field', s.jobEdits().get('9'), { title: null, location: null, stipend: '₹25,000 / month' });
  s.saveJobEdit('9', { stipend: null });
  check('nothing left overridden deletes the record', s.jobEdits().has('9'), false);
  s.close?.();
}

console.log('\n== A CORRECTED TITLE REDIRECTS ITS OLD PAGE ==');
{
  const entry = (row) => ({ row, matchedNow: 'Acme', region: 'IN' });
  const edited = applyJobEdit({ job_id: '4463891565', company: 'Acme', title: 'Apprentice Tech', is_tech: 1 }, { title: 'Software Apprentice' });
  check('the old slug redirects to the new one, on the same board',
    titleEditRedirects([entry(edited)]),
    [{ region: 'IN', slug: 'acme-apprentice-tech-4463891565', target: 'acme-software-apprentice-4463891565' }]);
  check('an unedited posting makes no redirect', titleEditRedirects([entry({ job_id: '1', company: 'Acme', title: 'Intern' })]), []);
  const sameSlug = applyJobEdit({ job_id: '2', company: 'Acme', title: 'SDE Intern' }, { title: 'SDE  intern' });
  check('a title edit that slugs the same makes no redirect', titleEditRedirects([entry(sameSlug)]), []);

  const pub = read('src/publish.js');
  check('publish lays the edits over the LIVE rows', /applyJobEdits\(store\.recentJobs\(Date\.now\(\) - maxAgeMs, atsWindow\), edits\)/.test(pub), true);
  check('and over the history the hubs are built from', /applyJobEdits\(store\.recentJobs\(0\), edits\)/.test(pub), true);
  check('and the title redirects join the reposted-role redirects', /titleEditRedirects\(jobs, logoIndex\)/.test(pub), true);
}

console.log('\n== LINKEDIN POSTS ARE WRITTEN FROM THE CORRECTED ROW ==');
{
  const qs = read('bin/queue-server.js');
  const raw = (qs.match(/store\.queuedJobs\(/g) ?? []).length;
  check('the helper reads the queue only through queuedWithEdits', raw, 1);
  check('and that one read applies the edits', /return applyJobEdits\(store\.queuedJobs\(status\), store\.jobEdits\(\)\)/.test(qs), true);
  /* The global cross-origin refusal answers every foreign POST with 403. The
     owner routes are cross-origin by design, so they must be handled first. */
  check('the owner routes come before the cross-origin refusal',
    qs.indexOf("path.startsWith('/api/owner/')") > 0
      && qs.indexOf("path.startsWith('/api/owner/')") < qs.indexOf("req.method === 'POST' && !sameOrigin(req)"), true);
  check('every owner action runs behind ownerAuth',
    qs.indexOf('ownerAuth(req') < qs.indexOf("path === '/api/owner/status'"), true);
  check('the pairing page is served to this machine only',
    /path === '\/owner'[\s\S]{0,120}if \(!localHost\(req, PORT\)\) return/.test(qs), true);
}

console.log('\n== PAGE ADDRESSES ==');
{
  check('an India job page', slugFromPath('/jobs/acme-intern-9'), 'acme-intern-9');
  check('a US job page', slugFromPath('/us/jobs/acme-intern-9'), 'acme-intern-9');
  check('with .html', slugFromPath('/jobs/acme-intern-9.html'), 'acme-intern-9');
  check('a company hub is not a job', slugFromPath('/companies/acme'), null);
  check('the bare jobs path is not a job', slugFromPath('/jobs/'), null);
}

/* ---------------- the browser side ---------------- */

/** Run a script in a fake browser and record what it tried to do. */
function inBrowser(src, { stored = null, hash = '', throwOnStorage = false } = {}) {
  const log = { scripts: [], links: [], fetches: 0, stored, replaced: null };
  const el = (tag) => ({ tag, set src(v) { log.scripts.push(v); }, set href(v) { log.links.push(v); } });
  const storage = {
    getItem: () => { if (throwOnStorage) throw new Error('blocked'); return log.stored; },
    setItem: (_k, v) => { if (throwOnStorage) throw new Error('blocked'); log.stored = v; },
    removeItem: () => { log.stored = null; },
  };
  const ctx = {
    localStorage: storage,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_s, _t, url) => { log.replaced = url; } },
    document: {
      createElement: el,
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, prepend: () => {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: () => { log.fetches++; return new Promise(() => {}); },
    MutationObserver: class { observe() {} },
    CSS: { escape: (s) => s },
    window: {},
  };
  vm.runInNewContext(src, ctx);
  return log;
}

const loaderOf = (file) => {
  const src = read(file);
  const m = src.match(/\(function loadOwnerControls\(\) \{[\s\S]*?\n\}\)\(\);/);
  return m ? m[0] : '';
};

console.log('\n== A VISITOR NEVER LOADS THE OWNER SCRIPT ==');
for (const file of ['web/public/app.js', 'web/public/page.js']) {
  const loader = loaderOf(file);
  check(`${file}: the loader is present`, loader.length > 0, true);
  if (!loader) continue;
  check(`${file}: no token, no script`, inBrowser(loader).scripts, []);
  check(`${file}: a stored token loads /owner.js`, inBrowser(loader, { stored: 'x' }).scripts, ['/owner.js']);
  check(`${file}: a pairing link loads it too`, inBrowser(loader, { hash: '#owner-pair=abc' }).scripts, ['/owner.js']);
  check(`${file}: an unrelated fragment does not`, inBrowser(loader, { hash: '#role-42' }).scripts, []);
  check(`${file}: blocked storage loads nothing and does not throw`, inBrowser(loader, { throwOnStorage: true }).scripts, []);
}

console.log('\n== AND THE OWNER SCRIPT DOES NOTHING WITHOUT A TOKEN ==');
{
  const owner = read('web/public/owner.js');
  const visitor = inBrowser(owner);
  check('no request to the helper', visitor.fetches, 0);
  check('no stylesheet', visitor.links, []);
  const pairing = inBrowser(owner, { hash: `#owner-pair=${TOKEN}` });
  check('a pairing link stores the token', pairing.stored, TOKEN);
  check('and strips it from the address bar', pairing.replaced, '/');
  const bogus = inBrowser(owner, { hash: '#owner-pair=not-a-token' });
  check('a malformed pairing link stores nothing', bogus.stored, null);
  check('and still makes no request', bogus.fetches, 0);
}

console.log('\n== THE SITE MAY REACH THE HELPER, AND NOTHING NEW IS PUBLISHED ==');
{
  const vj = JSON.parse(read('web/vercel.json'));
  const csp = JSON.stringify(vj).match(/default-src[^"]*/)?.[0] ?? '';
  const directive = (name) => (csp.match(new RegExp(`${name} ([^;]*)`))?.[1] ?? '').split(' ');
  check('connect-src allows the helper', directive('connect-src').includes('http://127.0.0.1:4322'), true);
  check('script-src does NOT', directive('script-src').includes('http://127.0.0.1:4322'), false);
  check('no other local port is opened', (csp.match(/127\.0\.0\.1:\d+/g) ?? []), ['127.0.0.1:4322']);
  const published = publishedPaths();
  check('owner.js is hand-committed, not in the publish allowlist', published.some((p) => /owner\./.test(p)), false);
  check('owner.css sets no style attributes the CSP would block', /style=/.test(read('web/public/owner.js')), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
