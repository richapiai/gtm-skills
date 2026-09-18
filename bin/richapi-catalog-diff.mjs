#!/usr/bin/env node
// richapi-catalog-diff — classify what changed between two catalogs.
//
// The gate is calibrated, not binary. See _lib/catalog/diff.mjs for the reasoning and
// the measured churn it is sized against. Only REPRICED_MAJOR, REMOVED_UNMAPPED and
// PRICING_SEMANTICS_CHANGED exit non-zero.
//
// Usage:
//   node bin/richapi-catalog-diff.mjs <old.json> <new.json> [options]
//   node bin/richapi-catalog-diff.mjs                 # committed catalog vs the spec
//
//   --json              machine-readable output
//   --major-ratio <n>   price-increase multiple that counts as MAJOR (default 2)
//   --rename-threshold <n>
//   --warn-only         always exit 0 (report still names the blockers)
//
// Both v2 catalogs and the legacy MCP tool-list catalog format are accepted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCatalog } from '../_lib/catalog/adapt-v1.mjs';
import { diffCatalogs, formatReport } from '../_lib/catalog/diff.mjs';
import { buildCatalog } from '../_lib/catalog/generate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const positional = [];
const opts = {};
const flags = new Set();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json' || a === '--warn-only' || a === '--help') flags.add(a.slice(2));
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  else positional.push(a);
}

if (flags.has('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
  process.exit(0);
}

function readCatalog(file) {
  return normalizeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
}

let oldCatalog;
let newCatalog;
let oldLabel;
let newLabel;

if (positional.length >= 2) {
  [oldLabel, newLabel] = positional;
  oldCatalog = readCatalog(path.resolve(oldLabel));
  newCatalog = readCatalog(path.resolve(newLabel));
} else {
  // Default CI mode: what the repo has committed vs what the pinned spec says today.
  const committed = path.resolve(ROOT, opts.out ?? '_lib/api-catalog.json');
  const specFile = path.resolve(ROOT, opts.spec ?? 'spec/openapi.yaml');
  if (!fs.existsSync(committed)) {
    console.error(`error: no committed catalog at ${committed}; run \`npm run catalog:gen\` first`);
    process.exit(1);
  }
  oldLabel = path.relative(ROOT, committed);
  newLabel = `${path.relative(ROOT, specFile)} (regenerated)`;
  oldCatalog = readCatalog(committed);
  newCatalog = buildCatalog(fs.readFileSync(specFile), { generatedAt: oldCatalog.generated_at }).catalog;
}

const result = diffCatalogs(oldCatalog, newCatalog, {
  majorRatio: opts['major-ratio'] ? Number(opts['major-ratio']) : undefined,
  renameThreshold: opts['rename-threshold'] ? Number(opts['rename-threshold']) : undefined,
});

if (flags.has('json')) {
  console.log(JSON.stringify({ old: oldLabel, new: newLabel, ...result }, null, 2));
} else {
  console.log(formatReport(result, { oldLabel, newLabel }));
}

process.exit(flags.has('warn-only') ? 0 : result.exitCode);
