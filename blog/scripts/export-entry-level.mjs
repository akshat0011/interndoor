#!/usr/bin/env node
/* Writes blog/content/data/entrylevel.json: what India engineering postings
   tagged "Entry level" on public job boards turned out to be.

     node --no-warnings blog/scripts/export-entry-level.mjs

   Runs on this Mac only. It reads the scan views the full-time search saves
   for every run (reports/scans/<runId>.html: every card it was shown, page by
   page, with what InternDoor decided about it). The blog build never does; it
   reads the JSON this writes, which is committed, so a published figure cannot
   change unless this is re-run and the diff is reviewed.

   The window is 25 September to 13 October 2026: from the first run that saved
   a scan view to the last run whose search asked for the Entry level tag ALONE.
   From 14 October the search also asked for Associate, so later runs are a
   different population and are left out.

   Counted once per posting (job id), whatever city or run it came back in.
   When a posting was decided more than once, the most informed decision wins:
   a reading of the posting itself beats a reading of its title, which beats
   the employer check. */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'content', 'data', 'entrylevel.json');
const { PATHS } = await import(join(APP, 'src/paths.js'));
const SCANS = join(PATHS.reports, 'scans');

const FROM = '2026-09-25';
const TO = '2026-10-13';
const LAST_RUN = '2026-10-13T23'; // run ids are UTC; nothing after 13 Oct
const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/* Every card the full-time search was shown, with the Entry level tag alone. */
const cards = [];
let runs = 0;
for (const f of readdirSync(SCANS).filter((x) => /^\d{4}-\d\d-\d\dT[\d-]+\.html$/.test(x)).sort()) {
  const run = f.slice(0, -5);
  if (run < FROM || run > LAST_RUN) continue;
  const html = readFileSync(join(SCANS, f), 'utf8');
  let used = false;
  for (const sec of html.split('<section>').slice(1)) {
    if (!/<h2>IN · IN entry-level[^·]* · page \d+/.test(sec)) continue;
    const url = unescape(sec.match(/class="url">([^<]*)/)?.[1] ?? '');
    if (!/[?&]f_E=2(&|$)/.test(url)) continue; // the Entry level tag alone
    used = true;
    for (const row of sec.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const id = row.match(/class="id">([\s\S]*?)<\/td>/)?.[1]?.trim();
      const out = unescape(row.match(/class="badge"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '').trim();
      const title = unescape(row.match(/class="title">([\s\S]*?)<\/div>/)?.[1] ?? '').trim();
      if (id) cards.push({ id, out, title });
    }
  }
  if (used) runs += 1;
}
if (runs < 200) throw new Error(`Only ${runs} runs found between ${FROM} and ${TO}; the scan views may have been pruned. Stop and look.`);

/* What each decision means, in the order the checks run. */
function bucket(o) {
  if (/^repeat of a card/.test(o)) return null;
  if (/^company not on watchlist|^blocked employer/.test(o)) return 'offList';
  if (/^non-engineering role|^not a role we take/.test(o)) return 'notEngineering';
  if (/^not checked/.test(o)) return 'unchecked';
  if (/senior title|experienced title|years in the title/.test(o)) return 'senior';
  if (/level II\+ title/.test(o)) return 'level';
  if (/manager title/.test(o)) return 'manager';
  if (/consultant or architect title/.test(o)) return 'consultant';
  if (/asks (\d+)\+ years/.test(o)) return `asks${Math.min(5, Number(o.match(/asks (\d+)\+ years/)[1]))}`;
  if (/Mid-Senior level/.test(o)) return 'midSenior';
  if (/^SAVED|^already held/.test(o)) return 'kept';
  return 'other';
}
const rank = (b) => (b == null ? -1 : /^(asks|midSenior|kept|other)/.test(b) ? 3 : /^(senior|level|manager|consultant)$/.test(b) ? 2 : 1);

const best = new Map();
for (const c of cards) {
  const b = bucket(c.out);
  if (b == null) continue;
  const prev = best.get(c.id);
  if (!prev || rank(b) > rank(prev.b)) best.set(c.id, { b, out: c.out, title: c.title });
}
const n = {};
for (const { b } of best.values()) n[b] = (n[b] ?? 0) + 1;
const otherWhy = {};
for (const v of best.values()) if (v.b === 'other') otherWhy[v.out.replace(/\s*—.*$/, '')] = (otherWhy[v.out.replace(/\s*—.*$/, '')] ?? 0) + 1;

const asks = ['asks2', 'asks3', 'asks4', 'asks5'].reduce((s, k) => s + (n[k] ?? 0), 0);
const titleTotal = ['senior', 'level', 'manager', 'consultant'].reduce((s, k) => s + (n[k] ?? 0), 0);
const onList = titleTotal + asks + (n.midSenior ?? 0) + (n.kept ?? 0) + (n.other ?? 0);
const pct = (v) => Math.round((1000 * v) / onList) / 10;
const fmt = (v) => v.toLocaleString('en-IN');
const row = (label, v) => ({ label, value: pct(v), display: `${Math.round(pct(v))}%`, note: `(${fmt(v)})` });

const source = {
  label: `InternDoor collection records, ${new Date(`${FROM}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} to ${new Date(`${TO}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} (see How we count)`,
  url: 'https://blog.interndoor.com/methodology',
};

const data = {
  id: 'entrylevel',
  window: { from: FROM, to: TO, runs },
  returned: best.size,
  offList: n.offList ?? 0,
  notEngineering: n.notEngineering ?? 0,
  unchecked: n.unchecked ?? 0,
  onList,
  counts: { ...n, titles: titleTotal, asks },
  otherWhy,
  source,
  charts: {
    verdict: {
      title: 'What "Entry level" engineering postings turned out to be',
      subtitle: `The ${fmt(onList)} India engineering postings from employers on InternDoor's list that public job boards tagged Entry level, ${FROM.slice(8)} September to ${TO.slice(8)} October 2026`,
      unit: 'percent', max: 50, label: 'What the posting was', valueLabel: 'Share of postings',
      highlight: ['Open to a fresher'],
      rows: [
        row('Senior, lead, principal or staff title', n.senior ?? 0),
        row('Asked for two or more years', asks),
        row('Open to a fresher', n.kept ?? 0),
        row('Level II or higher in the title', n.level ?? 0),
        row('The posting said Mid-Senior level', n.midSenior ?? 0),
        row('Manager title', n.manager ?? 0),
        row('Consultant or architect title', n.consultant ?? 0),
        row('Other reasons', n.other ?? 0),
      ],
      note: 'Each posting is counted once, in the first check it failed. Titles are checked first, then the posting itself is read.',
    },
    years: {
      title: 'How much experience the "entry-level" postings asked for',
      subtitle: `The ${fmt(asks)} postings among them whose own text asked for two or more years, by the smallest figure stated`,
      unit: 'count', label: 'Experience asked for', valueLabel: 'Postings',
      highlight: ['5 years or more'],
      rows: [
        { label: '2 years or more', value: n.asks2 ?? 0 },
        { label: '3 years or more', value: n.asks3 ?? 0 },
        { label: '4 years or more', value: n.asks4 ?? 0 },
        { label: '5 years or more', value: n.asks5 ?? 0 },
      ],
      note: 'Where a posting gave a range, such as 3 to 5 years, the smallest figure is the one counted.',
    },
  },
};

writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
console.log(`runs ${runs}, postings returned ${best.size}, off list ${data.offList}, not engineering ${data.notEngineering}, unchecked ${data.unchecked}, on list ${onList}`);
console.log(JSON.stringify(data.counts));
console.log('other:', JSON.stringify(otherWhy));
