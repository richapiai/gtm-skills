#!/usr/bin/env node
// owners-check — the CI gate that fails on UNMAPPED.
//
// Lives under _lib/catalog/ rather than bin/ because it sits beside the
// catalog code it checks; it is a runnable all the same.
//
// Usage:
//   node _lib/catalog/owners-check.mjs [options]
//
//   --owners <file>       default _lib/endpoint-owners.yaml
//   --catalog <file>      default _lib/api-catalog.json
//   --coverage <file>     default _lib/catalog/coverage.md
//   --write-coverage      regenerate the coverage table
//   --check-coverage      fail if the coverage table on disk is stale
//   --json                machine-readable output
//
// Exit: 0 clean · 1 any problem (UNMAPPED, missing reason, stale claim, stale coverage).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkOwners, loadOwners, renderCoverage } from './owners.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const opts = {};
const flags = new Set();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (['write-coverage', 'check-coverage', 'json', 'help'].includes(k)) flags.add(k);
    else opts[k] = argv[++i];
  }
}

if (flags.has('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).join('\n'));
  process.exit(0);
}

const ownersFile = path.resolve(ROOT, opts.owners ?? '_lib/endpoint-owners.yaml');
const catalogFile = path.resolve(ROOT, opts.catalog ?? '_lib/api-catalog.json');
const coverageFile = path.resolve(ROOT, opts.coverage ?? '_lib/catalog/coverage.md');

const owners = loadOwners(ownersFile);
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const result = checkOwners(owners, catalog);

let coverageStale = false;
if (flags.has('write-coverage') || flags.has('check-coverage')) {
  const rendered = `${renderCoverage(owners, catalog)}\n`;
  const existing = fs.existsSync(coverageFile) ? fs.readFileSync(coverageFile, 'utf8') : null;
  if (flags.has('write-coverage')) {
    if (existing !== rendered) fs.writeFileSync(coverageFile, rendered);
    if (!flags.has('json')) console.log(`coverage table -> ${path.relative(ROOT, coverageFile)}`);
  } else if (existing !== rendered) {
    coverageStale = true;
  }
}

if (flags.has('json')) {
  console.log(JSON.stringify({ ...result, coverage_stale: coverageStale }, null, 2));
} else {
  const c = result.counts;
  console.log(
    `endpoint ownership: ${c.spec_endpoints} in spec · ${c.claimed} claimed · ${c.unclaimed} unclaimed · ${c.unmapped} UNMAPPED`
  );
  for (const p of result.problems) console.error(`${p.code}: ${p.message}`);
  if (coverageStale) {
    console.error(
      'STALE_COVERAGE: _lib/catalog/coverage.md does not match the generated table — ' +
        'run `node _lib/catalog/owners-check.mjs --write-coverage`. Never hand-type it.'
    );
  }
  if (result.ok && !coverageStale) console.log('ok');
}

process.exit(result.ok && !coverageStale ? 0 : 1);
