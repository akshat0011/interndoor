#!/usr/bin/env node
/* Turns the articles Distribb posted to /api/distribb into blog posts.
 *
 *   node bin/distribb-import.js            import what is new: download images,
 *                                          write blog/content/posts/<slug>.html,
 *                                          build and verify the blog, commit, push
 *   node bin/distribb-import.js --dry-run  read the inbox and say what it would do
 *   node bin/distribb-import.js --show     the newest delivery's field names and sizes
 *   node bin/distribb-import.js --token    copy the webhook's access token to the
 *                                          clipboard for Distribb's form (never printed)
 *   --no-push                              commit but leave the push to later
 *
 * bin/run.sh calls it every scan tick, so a post is live within ~30 minutes of
 * Distribb publishing it. It runs between the scan phases, never beside them:
 * both commit in this checkout.
 *
 * A post that breaks a blog rule is moved to blog/content/quarantine/ with the
 * reason, the rest still publish, and a push names it. Nothing is ever deleted
 * from the inbox here; what was handled is remembered in the state directory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, PATHS } from '../src/paths.js';
import { LIST_KEY, webhookToken } from '../web/api/distribb.js';
import { cleanArticleHtml } from '../blog/lib/htmlpost.mjs';
import { parseFrontmatter } from '../blog/lib/content.mjs';
import { mapArticle, buildPost, postFile, imageInfo, mediaName, istDay } from '../src/distribbimport.js';
import { notify, pushToPhone } from '../src/notify.js';
import { forceExitSoon } from '../src/forceexit.js';

process.chdir(ROOT);
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const ARGS = new Set(process.argv.slice(2));
/* DISTRIBB_STATE_DIR exists for an end-to-end run in a scratch worktree. */
const STATE_DIR = process.env.DISTRIBB_STATE_DIR || PATHS.state;
const STATE_FILE = join(STATE_DIR, 'distribb-import.json');
const LOCK = join(STATE_DIR, 'distribb-import.lock');
const POSTS = join(ROOT, 'blog', 'content', 'posts');
const MEDIA = join(ROOT, 'blog', 'content', 'media');
const QUARANTINE = join(ROOT, 'blog', 'content', 'quarantine');
const MAIN = 'https://interndoor.com';
const MAX_IMAGE = 8 * 1024 * 1024;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (m) => console.log(`${stamp()} [DISTRIBB] ${m}`);

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (ARGS.has('--token')) {
  const t = webhookToken(process.env);
  if (!t) { console.error('No KV_REST_API_TOKEN in .env, so there is no webhook token.'); process.exit(1); }
  execFileSync('pbcopy', { input: t });
  console.log(`Copied the access token (${t.length} characters) to the clipboard.`);
  console.log(`Webhook endpoint: ${MAIN}/api/distribb`);
  process.exit(0);
}
if (!url || !kvToken) { say('no KV_REST_API_URL / KV_REST_API_TOKEN in .env; nothing to read.'); process.exit(0); }

async function inbox() {
  const res = await fetch(`${url}/lrange/${encodeURIComponent(LIST_KEY)}/0/-1`, {
    headers: { authorization: `Bearer ${kvToken}` }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`the store answered ${res.status}`);
  const { result } = await res.json();
  return (result ?? []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean).reverse();
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { seen: {} }; }
}
const saveState = (s) => writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });

/** Field names and sizes only: enough to check the mapping, nothing worth hiding. */
function shape(v, depth = 0) {
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 2 ? ` of ${shape(v[0], depth + 1)}` : ''}`;
  if (v && typeof v === 'object') {
    if (depth > 2) return 'object';
    return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${shape(x, depth + 1)}`).join(', ')} }`;
  }
  if (typeof v === 'string') return v.length > 60 ? `string(${v.length})` : JSON.stringify(v);
  return String(v);
}

async function download(u) {
  let res;
  try { res = await fetch(u, { signal: AbortSignal.timeout(20000), redirect: 'follow' }); } catch { return null; }
  if (!res.ok || !/^image\//.test(res.headers.get('content-type') ?? '')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) return null;
  const info = imageInfo(buf);
  return info ? { buf, ...info } : null;
}

/** An interndoor.com link answers 200, asked up to three times; anything else is unwrapped. */
async function deadMainLinks(links) {
  const dead = new Set();
  for (const href of new Set(links.filter((h) => h === MAIN || h.startsWith(`${MAIN}/`)))) {
    let status = 0;
    for (let k = 0; k < 3 && status !== 200; k++) {
      try { status = (await fetch(href, { redirect: 'manual', signal: AbortSignal.timeout(15000) })).status; } catch { status = -1; }
    }
    if (status !== 200) dead.add(href);
  }
  return dead;
}

function existingPost(slug) {
  for (const ext of ['.html', '.md']) {
    const f = join(POSTS, `${slug}${ext}`);
    if (existsSync(f)) {
      const { data } = parseFrontmatter(readFileSync(f, 'utf8'), `${slug}${ext}`);
      return { file: f, data };
    }
  }
  return null;
}

function quarantine(slug, why) {
  mkdirSync(QUARANTINE, { recursive: true });
  const f = join(POSTS, `${slug}.html`);
  if (existsSync(f)) renameSync(f, join(QUARANTINE, `${slug}.html`));
  writeFileSync(join(QUARANTINE, `${slug}.reason.txt`), `${stamp()} ${why}\n`);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  if (existsSync(LOCK) && Date.now() - Number(readFileSync(LOCK, 'utf8')) < 20 * 60000) { say('another import is running; skipping.'); return; }
  writeFileSync(LOCK, String(Date.now()));
  try {
    const entries = await inbox();
    if (ARGS.has('--show')) {
      const e = entries.at(-1);
      console.log(e ? `Newest delivery ${e.id} at ${e.at}:\n${shape(e.body)}` : 'The inbox is empty.');
      return;
    }
    const state = loadState();
    const fresh = entries.filter((e) => !state.seen[e.id]);
    if (!fresh.length) return;
    const today = istDay();
    const done = [];
    const failed = [];

    for (const e of fresh) {
      const a = mapArticle(e.body);
      if (!a) { state.seen[e.id] = { at: e.at, status: 'not an article' }; continue; }
      if (a.test) { state.seen[e.id] = { at: e.at, status: 'test delivery', title: a.title }; say(`test delivery "${a.title}" received and ignored.`); continue; }
      if (ARGS.has('--dry-run')) { say(`would import "${a.title}" -> /${a.slug} (${a.event})`); continue; }

      const prior = existingPost(a.slug);
      if (a.event === 'remove') {
        /* Taken down in Distribb: the post becomes a draft (off the site, file kept). */
        if (prior?.data.origin === 'distribb' && prior.data.draft !== true) {
          writeFileSync(prior.file, readFileSync(prior.file, 'utf8').replace(/\norigin: distribb\n/, '\ndraft: true\norigin: distribb\n'));
          done.push({ id: e.id, at: e.at, slug: a.slug, title: prior.data.title, event: 'remove', dead: 0, images: 0 });
        } else state.seen[e.id] = { at: e.at, status: 'remove: nothing to take down', slug: a.slug };
        continue;
      }
      if (prior && prior.data.origin !== 'distribb') {
        failed.push({ slug: a.slug, why: `/${a.slug} is a hand-written post; refused to overwrite it` });
        state.seen[e.id] = { at: e.at, status: 'refused', slug: a.slug };
        continue;
      }

      /* First pass: which images and links does it carry? */
      const scan = cleanArticleHtml(a.html ?? '', { images: () => null });
      const dead = await deadMainLinks(scan.links);
      const dir = join(MEDIA, a.slug);
      const map = new Map();
      for (const src of [...new Set([a.image, ...scan.images].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))]) {
        const img = await download(src.replace(/^http:/, 'https:'));
        if (!img) continue;
        mkdirSync(dir, { recursive: true });
        const name = mediaName(img.buf, img.ext);
        writeFileSync(join(dir, name), img.buf);
        map.set(src, { src: `/media/${a.slug}/${name}`, width: img.width, height: img.height });
      }
      const built = buildPost(a, {
        images: (u) => map.get(u) ?? null,
        deadLinks: dead,
        hero: a.image ? map.get(a.image) ?? null : null,
        today,
        existing: prior ? { published: prior.data.published } : null,
      });
      if (built.error) {
        failed.push({ slug: a.slug, why: built.error });
        state.seen[e.id] = { at: e.at, status: 'refused', slug: a.slug, why: built.error };
        continue;
      }
      /* Images the article no longer uses go, so the folder matches the post. */
      if (existsSync(dir)) {
        const used = new Set([...built.post.html.matchAll(/\/media\/[^"]+\/([^"/]+)"/g)].map((m) => m[1]));
        if (built.post.image) used.add(built.post.image.split('/').pop());
        for (const f of readdirSync(dir)) if (!used.has(f)) rmSync(join(dir, f));
      }
      writeFileSync(join(POSTS, `${a.slug}.html`), postFile(built.post));
      done.push({ id: e.id, at: e.at, slug: a.slug, title: built.post.title, event: a.event, dead: dead.size, images: map.size });
    }

    if (!done.length) {
      saveState(state);
      for (const f of failed) say(`refused /${f.slug}: ${f.why}`);
      if (failed.length) await alert(failed);
      return;
    }

    /* Build and verify; a post the verifier names is quarantined and the rest rebuilt. */
    const { build, checkMainLinks } = await import('../blog/build.mjs');
    let res = await build({ log: () => {} });
    for (let round = 0; round < 3 && res.check.errors.length; round++) {
      const bad = done.filter((d) => res.check.errors.some((x) => x.startsWith(`/${d.slug}:`)));
      if (!bad.length) break;
      for (const d of bad) {
        const why = res.check.errors.filter((x) => x.startsWith(`/${d.slug}:`)).join('; ');
        quarantine(d.slug, why);
        failed.push({ slug: d.slug, why });
        state.seen[d.id] = { at: d.at, status: 'quarantined', slug: d.slug, why };
        done.splice(done.indexOf(d), 1);
      }
      res = await build({ log: () => {} });
    }
    if (res.check.errors.length) {
      say(`the blog build has problems this import did not cause; nothing committed:\n  ${res.check.errors.join('\n  ')}`);
      await alert([{ slug: '(blog)', why: 'the blog build is failing; see run.log' }]);
      return;
    }
    const badLinks = await checkMainLinks(res.mainLinks);
    if (badLinks.length) say(`links into interndoor.com that do not answer 200 (from older posts): ${badLinks.join(', ')}`);

    for (const d of done) state.seen[d.id] = { at: d.at, status: 'imported', slug: d.slug };
    saveState(state);
    if (!done.length) { await alert(failed); return; }

    const paths = ['blog/content/posts', 'blog/content/media', 'blog/public', 'blog/og-manifest.json', 'blog/vercel.json']
      .filter((p) => existsSync(join(ROOT, p)));
    git('add', '--', ...paths);
    const staged = git('diff', '--cached', '--name-only', '--', ...paths);
    if (!staged) { say('nothing changed in the blog after the build.'); return; }
    const verb = { update: 'Update', remove: 'Take down' };
    const lines = done.map((d) => `${verb[d.event] ?? 'Add'} "${d.title}" (/${d.slug})`);
    const msgFile = join(STATE_DIR, 'distribb-commit-msg.txt');
    writeFileSync(msgFile, `Blog: ${done.length === 1 ? lines[0] : `${done.length} articles from Distribb`}\n\n${lines.join('\n')}\n`);
    git('commit', '-q', '-F', msgFile, '--', ...paths);
    say(`committed ${git('rev-parse', '--short', 'HEAD')}: ${lines.join('; ')}`);
    if (!ARGS.has('--no-push')) {
      const push = spawnSync('git', ['push', '-q'], { encoding: 'utf8' });
      say(push.status === 0 ? 'pushed; Vercel deploys the blog in under a minute.' : `push failed (${(push.stderr || '').trim().split('\n').pop()}); the next push carries it.`);
    }
    for (const d of done) say(`live soon: https://blog.interndoor.com/${d.slug} (${d.images} image(s)${d.dead ? `, ${d.dead} dead interndoor.com link(s) unwrapped` : ''})`);
    if (failed.length) await alert(failed);
  } finally {
    rmSync(LOCK, { force: true });
  }
}

async function alert(failed) {
  const body = failed.map((f) => `/${f.slug}: ${f.why}`).join('\n').slice(0, 900);
  for (const f of failed) say(`NOT published /${f.slug}: ${f.why}`);
  await notify('Blog import: article held back', body, { subtitle: 'Distribb' }).catch(() => {});
  await pushToPhone('Blog import: article held back', body, { tags: 'warning' }).catch(() => {});
}

main().catch((e) => { say(`failed: ${e.message}`); process.exitCode = 1; }).finally(() => forceExitSoon());
