#!/usr/bin/env node
/**
 * Build the README for the public GitHub internship list.
 *
 *   node bin/gh-readme.js                                  India, to stdout
 *   node bin/gh-readme.js --region=US
 *   node bin/gh-readme.js --out ../india-internships/README.md
 *
 * Deliberately NOT wired into publish(): nothing here may be able to fail a
 * scan. The rendering lives in src/ghreadme.js so it can be tested without
 * driving a publish — importing a bin/ file runs it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../src/paths.js';
import { renderReadme } from '../src/ghreadme.js';
import { regionOf, regionPath } from '../src/regions.js';

const ARGS = process.argv.slice(2);
const valueOf = (f, d = null) => {
  const hit = ARGS.find((a) => a.startsWith(`${f}=`));
  if (hit) return hit.slice(f.length + 1);
  const i = ARGS.indexOf(f);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('-') ? ARGS[i + 1] : d;
};

const CODE = String(valueOf('--region', 'IN')).toUpperCase();
const OUT = valueOf('--out');
const region = regionOf(CODE);
if (!region) { console.error(`Unknown region ${CODE}`); process.exit(1); }

const file = join(ROOT, 'web', 'public', regionPath(CODE), 'data', 'jobs.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));
const jobs = raw.jobs ?? raw;
const md = renderReadme(jobs, CODE);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
  console.error(`${region.name}: ${jobs.length} roles -> ${OUT}`);
} else {
  process.stdout.write(md);
}
