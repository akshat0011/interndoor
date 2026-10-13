/* Charts, drawn at build time. No chart library and no script.

   A chart is a real <table>: the label is a row header and the value cell holds
   the bar and the figure, so a screen reader reads a table and a crawler reads
   numbers, while the eye reads bars. The bar is an <svg> whose WIDTH ATTRIBUTE
   carries the value as a percentage. The production CSP refuses style=""
   attributes, and an attribute is not a style, which is the same trick the main
   site's /insights bars use.

   Mark rules (dataviz): one series, so one neutral hue, no legend; the row the
   text is about is the only one in the accent; bars are 10px with a 4px round
   end and a square baseline; every value is printed at the bar tip in text ink,
   never in the bar's colour. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from './markdown.mjs';

export class ChartError extends Error {}

const SAFE_URL = /^https:\/\/[^\s<>"]+$/;

/** Every dataset under content/data, keyed by its id. */
export function loadDatasets(dir) {
  const sets = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!data.id || sets.has(data.id)) throw new ChartError(`${f}: a dataset needs a unique id.`);
    for (const [name, c] of Object.entries(data.charts ?? {})) validateChart(`${data.id}.${name}`, c, data);
    sets.set(data.id, data);
  }
  return sets;
}

export function validateChart(key, c, data = {}) {
  if (!c.title || !c.subtitle) throw new ChartError(`${key}: a chart needs a title and a subtitle saying what was counted.`);
  if (!Array.isArray(c.rows) || c.rows.length < 2 || c.rows.length > 16) throw new ChartError(`${key}: 2 to 16 rows.`);
  const source = c.source ?? data.source;
  if (!source?.label || !SAFE_URL.test(source.url ?? '')) throw new ChartError(`${key}: every chart names its source with an https link.`);
  for (const r of c.rows) {
    if (!r.label || typeof r.value !== 'number' || !Number.isFinite(r.value) || r.value < 0) {
      throw new ChartError(`${key}: every row needs a label and a non-negative number.`);
    }
  }
  const max = c.max ?? Math.max(...c.rows.map((r) => r.value));
  if (!(max > 0) || c.rows.some((r) => r.value > max)) throw new ChartError(`${key}: max must cover every value.`);
  for (const h of c.highlight ?? []) {
    if (!c.rows.some((r) => r.label === h)) throw new ChartError(`${key}: highlight "${h}" is not a row.`);
  }
  if (/[\u2014\u2013]/.test(JSON.stringify(c))) throw new ChartError(`${key}: an em or en dash in chart text.`);
  return true;
}

const fmt = (v, unit) => (unit === 'percent' ? `${Math.round(v)}%` : v.toLocaleString('en-IN'));

/* Percent of the track, to one decimal, with a floor so a non-zero value never
   draws as nothing. Rounded so two builds write the same bytes. */
export function barWidth(value, max) {
  if (value <= 0) return 0;
  return Math.max(0.6, Math.round((value / max) * 1000) / 10);
}

function bar(value, max, key) {
  const w = barWidth(value, max);
  return `<svg class="cbar${key ? ' is-key' : ''}" width="${w}%" height="10" aria-hidden="true" focusable="false"><rect width="100%" height="10" rx="4"/><rect width="6" height="10"/></svg>`;
}

/**
 * The figure for one chart. `variant: 'mini'` is the homepage version: the
 * first rows only, no note, no source line (the article carries those).
 */
export function renderChart(datasets, ref, { variant = 'full', limit = null } = {}) {
  const [setId, name] = String(ref).split('.');
  const data = datasets.get(setId);
  const c = data?.charts?.[name];
  if (!c) throw new ChartError(`Unknown chart "${ref}".`);
  const source = c.source ?? data.source;
  const rows = limit ? c.rows.slice(0, limit) : c.rows;
  const max = c.max ?? Math.max(...c.rows.map((r) => r.value));
  const hi = new Set(c.highlight ?? []);
  const id = `chart-${setId}-${name}`;
  const notes = rows.some((r) => r.note) && variant !== 'mini';
  const body = rows.map((r) => {
    const v = r.display ?? fmt(r.value, c.unit);
    const n = r.note && variant !== 'mini' ? `<span class="val-n">${esc(r.note)}</span>` : '';
    return `<tr${hi.has(r.label) ? ' class="is-key"' : ''}><th scope="row">${esc(r.label)}</th><td><span class="track">${bar(r.value, max, hi.has(r.label))}<span class="val">${esc(v)}${n}</span></span></td></tr>`;
  }).join('\n');
  const head = `<figcaption class="chart-head"><span class="chart-title">${esc(c.title)}</span><span class="chart-sub">${esc(c.subtitle)}</span></figcaption>`;
  const table = `<table class="bars">
<caption class="sr-only">${esc(c.title)}. ${esc(c.subtitle)}</caption>
<thead class="sr-only"><tr><th scope="col">${esc(c.label ?? 'Item')}</th><th scope="col">${esc(c.valueLabel ?? 'Value')}</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
  if (variant === 'mini') {
    return `<figure class="chart chart-mini" data-chart>\n${head}\n${table}\n</figure>`;
  }
  const note = c.note ? `<p class="chart-note">${esc(c.note)}</p>` : '';
  const src = `<p class="chart-src">Source: <a href="${esc(source.url)}">${esc(source.label)}</a></p>`;
  return `<figure class="chart${notes ? ' has-notes' : ''}" id="${id}" data-chart>\n${head}\n${table}\n${note}${src}\n</figure>`;
}
