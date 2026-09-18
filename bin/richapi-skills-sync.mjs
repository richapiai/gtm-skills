#!/usr/bin/env node
// bin/richapi-skills-sync.mjs — installs as `richapi-skills-sync`.
//
// Two rules shape this file:
//
//   1. The source of truth is `openapi.yaml`, not an MCP tool listing. The spec
//      carries `x-pricing`, which is what makes cost estimation a real calculation
//      instead of prose.
//   2. A sync never commits what it finds. Blind-committing a fetched listing lets a
//      price increase or a removed endpoint land on main with nobody looking.
//
// So this orchestrates the absorption pipeline and REPORTS. It never commits, and it
// exits non-zero when the diff finds something a human has to decide.
//
//   fetch (pinned + checksum) -> catalog-gen -> catalog-diff (severity) -> owners gate

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
richapi-skills-sync — absorb an API release

  --spec-url <url>   Fetch the spec from here first (falls back to the pinned copy).
  --check            Report only; fail if the committed catalog is stale.
  --write-spec       Update spec/openapi.yaml + its .sha256 from --spec-url.
  --json             Machine-readable summary.

Exit: 0 clean or non-blocking · 1 a blocking change needs a human · 2 usage error.

It NEVER commits. An earlier sync did, which is how a price increase reached main
with nobody looking.
`.trimStart();

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); process.exit(0); }

const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

const specUrl = val('spec-url') ?? process.env.RICHAPI_SPEC_URL ?? null;
const asJson = flag('json');
const steps = [];

function run (label, file, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, file), ...args], { encoding: 'utf8' });
  const step = { label, status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  steps.push(step);
  if (!asJson) {
    process.stdout.write(`\n=== ${label} ===\n`);
    if (step.out) process.stdout.write(step.out + '\n');
    if (step.err) process.stderr.write(step.err + '\n');
  }
  return step;
}

// 1. Regenerate the catalog. Offline or unreachable keeps the cache and warns; it
//    never wedges, because a sync failure must not stop someone using the pack.
const genArgs = [];
if (specUrl) genArgs.push('--spec-url', specUrl);
if (flag('check')) genArgs.push('--check');
if (specUrl && !flag('write-spec')) genArgs.push('--allow-sha-mismatch');
const gen = run('catalog-gen', 'bin/richapi-catalog-gen.mjs', genArgs);

// 2. Classify what changed. Only REPRICED_MAJOR, REMOVED_UNMAPPED and
//    PRICING_SEMANTICS_CHANGED block; renames and minor repricings warn, because at
//    ~30% surface churn a quarter a binary gate would be red every month and switched
//    off by month two.
const diff = run('catalog-diff', 'bin/richapi-catalog-diff.mjs', asJson ? ['--json'] : []);

// 3. Every endpoint owned or explicitly unclaimed.
const owners = run('owners-check', '_lib/catalog/owners-check.mjs', ['--check-coverage']);

const blocking = diff.status !== 0;
const failed = gen.status !== 0 || owners.status !== 0;

if (asJson) {
  process.stdout.write(JSON.stringify({ blocking, failed, spec_url: specUrl, steps }, null, 2) + '\n');
} else {
  process.stdout.write('\n=== summary ===\n');
  if (blocking) {
    process.stdout.write(
      'BLOCKING: the diff found a change a human must decide on.\n'
      + 'Review _lib/gates.yaml and _lib/endpoint-owners.yaml, then regenerate.\n'
      + 'Nothing was committed — that is deliberate.\n');
  } else if (failed) {
    process.stdout.write('FAILED: the catalog is stale or an endpoint is unowned. See above.\n');
  } else {
    process.stdout.write('clean — no blocking changes.\n');
  }
}

process.exit(blocking || failed ? 1 : 0);
