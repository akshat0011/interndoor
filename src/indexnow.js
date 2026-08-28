/**
 * IndexNow — tell Bing (and Yandex, Seznam, Naver) what changed.
 *
 * WHY THIS EXISTS ALONGSIDE src/indexing.js. Google's Indexing API accepts
 * pages carrying JobPosting and nothing else, which is why that module refuses
 * everything but a job page. So the homepage, the company hubs, the two
 * directories, /alerts and /report — every page that is not a vacancy — have no
 * way to be announced to Google at all and must wait for an ordinary crawl.
 *
 * IndexNow has no such restriction: any URL, any page type. One protocol
 * covers Bing, and through Bing it covers Yahoo and much of DuckDuckGo, plus
 * Yandex, Seznam and Naver directly. For a domain with no inbound links that is
 * the difference between a hub being found this week and next month.
 *
 * IT SUBMITS WHAT CHANGED, NOT A SITEMAP ON A TIMER. Bing's own guidance is
 * that IndexNow is for announcing change, and re-submitting an unchanged page
 * every thirty minutes is exactly the abuse it asks you not to commit.
 * `writeIfChanged` in pages.js is the only thing that knows which bytes moved,
 * which is why it now reports.
 *
 * SETUP — the key file must be LIVE before the first submission, or every call
 * is refused 403:
 *   1. A key file sits at web/public/<key>.txt containing exactly the key.
 *   2. `indexing.indexNow.key` in config.json holds the same string.
 *   3. web/public/<key>.txt is in the PUBLISHED allowlist, or it is written
 *      every run and pushed never — and the whole integration silently 403s.
 *
 * No daily quota to manage, unlike Google's 200. The cap here is politeness and
 * the 10,000-URL ceiling on a single request.
 */
import { log } from './logger.js';

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITE = 'https://interndoor.com';

/** IndexNow refuses a request carrying more than this many URLs. */
export const MAX_URLS = 10_000;

export function indexNowConfigured(cfg) {
  return !!cfg?.indexing?.indexNow?.key;
}

/**
 * Only our own URLs, and only ones that look like real pages.
 *
 * IndexNow checks that every URL belongs to the host the key is registered to
 * and refuses the WHOLE batch on a mismatch, so one stray URL loses the lot.
 */
export function ownUrl(url, site = SITE) {
  return typeof url === 'string' && url.startsWith(`${site}/`) && !/[?#]/.test(url);
}

/**
 * Announce a batch.
 *
 * Fails soft and returns what happened. This is a hint to a search engine, not
 * part of publishing — the same rule src/indexing.js follows, and for the same
 * reason: a search engine being unreachable must never turn a good publish into
 * a failed one.
 */
export async function submitUrls(urls, cfg, { fetchImpl = fetch, site = SITE } = {}) {
  const key = cfg?.indexing?.indexNow?.key;
  if (!key) return { sent: 0, skipped: 'no-key' };
  if (cfg?.indexing?.indexNow?.enabled === false) return { sent: 0, skipped: 'disabled' };

  const list = [...new Set(urls.filter((u) => ownUrl(u, site)))].slice(0, MAX_URLS);
  if (!list.length) return { sent: 0, skipped: 'nothing-changed' };

  const body = {
    host: new URL(site).host,
    key,
    keyLocation: `${site}/${key}.txt`,
    urlList: list,
  };

  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });

  /* 200 accepted · 202 accepted, key still being verified · 400 bad request
     · 403 the key file is missing or does not match · 422 a URL is not on this
     host · 429 too many requests. Only the first two are success. */
  if (res.status === 200 || res.status === 202) return { sent: list.length, status: res.status };

  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch { /* status is enough */ }
  return { sent: 0, status: res.status, error: explain(res.status, detail) };
}

function explain(status, detail) {
  if (status === 403) {
    return `403 — ${SITE}/<key>.txt is missing or does not match the key in config.json. It must be LIVE before any submission. ${detail}`;
  }
  if (status === 422) return `422 — a URL in the batch is not on this host. ${detail}`;
  if (status === 429) return `429 — too many requests; back off. ${detail}`;
  return `${status} — ${detail}`;
}
