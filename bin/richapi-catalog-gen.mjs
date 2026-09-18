#!/usr/bin/env node
// richapi-catalog-gen — generate _lib/api-catalog.json from the pinned openapi.yaml.
//
// The catalog is the single source of truth for cost and routing (CLAUDE.md law #1).
// No credit number is ever typed by hand into a skill or a doc; it is read from here.
//
// Usage:
//   node bin/richapi-catalog-gen.mjs [options]
//
//   --spec <file>          pinned spec               (default spec/openapi.yaml)
//   --checksum <file>      expected sha256           (default <spec>.sha256)
//   --out <file>           catalog output            (default _lib/api-catalog.json)
//   --spec-url <url>       try this first, fall back to --spec on any failure
//   --allow-sha-mismatch   warn instead of failing when the pin does not match
//   --generated-at <iso>   pin the timestamp (used by tests)
//   --check                do not write; exit 1 if the catalog on disk is stale
//   --json                 emit the stats block as JSON on stdout
//   --absorb-live          MAINTAINER: rebuild _lib/live-field-maps.json from the raw
//                          captures in tests/fixtures/live/, then generate. Requires a
//                          checkout (tests/ is not shipped). Without it, generation
//                          reads the committed digest, which is what a consumer has.
//   --captures <dir>       where the raw captures live (default tests/fixtures/live/)
//   --no-live              generate from the SPEC ALONE, ignoring the digest. Produces
//                          the pre-capture catalog; useful only for proving what the
//                          absorption changed.
//
// Exit codes: 0 ok (including offline-with-cache) · 1 integrity failure or stale --check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, serialize, LIVE_DIGEST_FILE } from '../_lib/catalog/generate.mjs';
import { buildDigest } from '../_lib/catalog/live-maps.mjs';
import { sha256 } from '../_lib/catalog/generate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['allow-sha-mismatch', 'check', 'json', 'help', 'absorb-live', 'no-live'].includes(key)) out.flags.add(key);
    else out.opts[key] = argv[++i];
  }
  return out;
}

const { flags, opts } = parseArgs(process.argv.slice(2));

if (flags.has('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
  process.exit(0);
}

const specFile = path.resolve(ROOT, opts.spec ?? 'spec/openapi.yaml');
const checksumFile = path.resolve(ROOT, opts.checksum ?? `${opts.spec ?? 'spec/openapi.yaml'}.sha256`);
const outFile = path.resolve(ROOT, opts.out ?? '_lib/api-catalog.json');
const check = flags.has('check');
const digestFile = path.resolve(ROOT, '_lib', LIVE_DIGEST_FILE);
const capturesDir = path.resolve(ROOT, opts.captures ?? 'tests/fixtures/live');

// --absorb-live rebuilds the shipped digest from the raw captures. It is deliberately
// NOT the default: the raw captures are not in the published tarball, so a consumer
// running a plain regen must read the committed digest instead of silently producing a
// catalog with every live shape stripped out.
if (flags.has('absorb-live')) {
  if (!fs.existsSync(capturesDir)) {
    console.error(`error: --absorb-live needs the raw captures, and ${path.relative(ROOT, capturesDir)} does not exist.`);
    console.error('       They ship only in a checkout. From an npm install there is nothing to absorb.');
    process.exit(1);
  }
  const specSha = sha256(fs.readFileSync(specFile));
  const digest = buildDigest(capturesDir, { specSha256: specSha });
  fs.writeFileSync(digestFile, `${JSON.stringify(digest, null, 2)}\n`);
  const n = Object.keys(digest.endpoints).length;
  console.log(`absorbed ${n} live capture(s) into ${path.relative(ROOT, digestFile)}`);
  for (const s of digest.skipped) console.warn(`  skipped ${s.endpoint}: ${s.reason}`);
}

const before = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;

const result = await run({
  specFile,
  checksumFile: fs.existsSync(checksumFile) ? checksumFile : null,
  outFile,
  specUrl: opts['spec-url'] ?? null,
  allowShaMismatch: flags.has('allow-sha-mismatch'),
  generatedAt: opts['generated-at'] ?? null,
  write: !check,
  liveDigestFile: flags.has('no-live') ? null : digestFile,
});

for (const w of result.warnings) console.warn(`warn: ${w}`);
for (const e of result.errors) console.error(`error: ${e}`);

if (check && result.code === 0 && result.catalog) {
  const expected = serialize(result.catalog);
  if (before !== expected) {
    console.error('error: _lib/api-catalog.json is stale — run `npm run catalog:gen`');
    process.exit(1);
  }
  console.log('catalog is up to date');
  process.exit(0);
}

if (result.stats) {
  const s = result.stats;
  if (flags.has('json')) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`${result.wrote ? 'wrote' : 'unchanged'} ${path.relative(ROOT, outFile)}`);
    console.log(`  endpoints            ${s.total}`);
    console.log(
      `  pricing models       ${Object.entries(s.pricing_models)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`
    );
    console.log(
      `  capability groups    ${Object.entries(s.by_group)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`
    );
    console.log(`  bounded:false        ${s.bounded_false.length}  (${s.bounded_false.join(', ')})`);
    // Printed next to bounded:false on purpose — they are DIFFERENT predicates and the
    // sets differ. See the page_gated comment in _lib/catalog/extract.mjs.
    console.log(`  page_gated           ${s.page_gated.length}  (${s.page_gated.join(', ')})`);
    console.log(
      `  charge unreported   ${s.billing_field_absent.length} of ${s.total}  -> no recorded response carries a billing field, so the ledger writes cost_status=estimated_unverifiable`
    );
    console.log(`  no required fields   ${s.no_required_fields.length}  (runtime must validate these itself)`);
    console.log(
      `  field_map keys       ${s.field_map_keys_from_spec.length}  top-level response key NAMES from the 200 example, ` +
        `status=${s.field_map_keys_status}`
    );
    console.log(
      `  field_map TODOs      ${s.field_map_todo.length}  (${s.field_map_todo.join(', ')}) — no usable example at all`
    );
    console.log('                       nested shapes come only from recorded live fixtures, never the spec');
    if (s.provisional_groups.length) {
      console.log(`  UNGROUPED (new?)     ${s.provisional_groups.join(', ')}`);
    }
  }
}

process.exit(result.code);
