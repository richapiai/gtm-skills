#!/usr/bin/env node
// placeholder-metric — compute, rather than remember, the number behind CLAUDE.md law 2.
//
// WHY THIS FILE EXISTS
//
// The plan and CLAUDE.md both carry "39 of 68 response examples are >=40% the literal
// string `example`". The number is right, but the sentence does not say WHAT is 40% of
// what, and the two obvious readings give different answers:
//
//   by leaf value      count every scalar anywhere in the example tree      -> 39
//   by top-level key   count only the response object's own top-level keys  -> 26
//
// A claim heading for public docs cannot have two answers. This module pins the
// definition, computes it from the pinned spec, and a test asserts the number so the
// day the API ships real examples the doc is caught being stale instead of being
// quietly wrong.
//
// THE PINNED DEFINITION (`scalar_leaf_values` — the reading law 2 states):
//
//   Population   every operation in spec/openapi.yaml (all 68), including the two whose
//                200 response declares no example at all. They belong in the
//                denominator because the claim is about the spec's usefulness as a
//                schema source, and "no example" is no more usable than a placeholder
//                one. They are never in the numerator.
//   Per endpoint take the `200` response's `application/json` `example`. Walk the whole
//                tree, arrays included, to any depth, and collect every SCALAR LEAF: a
//                string, number, boolean or null. Objects and arrays are structure, not
//                values, and are counted in neither the numerator nor the denominator —
//                including empty ones. (See EMPTY CONTAINERS below; that choice is
//                worth exactly three endpoints.)
//   Placeholder  a scalar leaf whose value is EXACTLY the string "example" —
//                case-sensitive, untrimmed, whole-value. "example.com", "Example" and
//                "user@example.com" do NOT count: those are plausible sample data, not
//                a field the spec author left blank.
//   Threshold    an endpoint is placeholder-dominated when
//                   placeholder_leaves / scalar_leaves >= 0.40   (>=, not >)
//                An endpoint with no example is NOT dominated; it is reported
//                separately as `no_example`.
//
// MEASURED ON THE PINNED SPEC: 39 of 68. The law 2 sentence is CORRECT as written; what
// was missing was the definition under it.
//
// THE READINGS THAT WERE REJECTED, and what each would have printed instead:
//
//   26  top-level keys only — counts only the response object's own keys. Understates
//       badly: the placeholders are mostly one level down, inside `data`.
//   36  scalar leaves PLUS empty containers as leaves. Defensible (`{"data": {}}` tells
//       a field-map author as little as `{"data": "example"}` does) but it dilutes the
//       ratio with things that are not placeholder strings, so it understates too.
//   40  string leaves only — drops numbers, booleans and nulls from the denominator.
//       Overstates: a spec example that is half real integers is not 40% blank.
//   38  the same scalar-leaf reading at a strict `> 0.40`. The threshold is `>=`.
//
// All four are computed by `measureSpec` so the gap stays visible and this comment can
// never drift from the code.
//
// Usage:
//   node _lib/catalog/placeholder-metric.mjs [--spec <file>] [--json] [--per-endpoint]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

/** The literal a spec author leaves behind instead of a real sample value. */
export const PLACEHOLDER = 'example';

/** An endpoint is placeholder-dominated at or above this share of its leaves. */
export const THRESHOLD = 0.4;

/**
 * Every SCALAR leaf of a JSON value, in document order.
 *
 * Objects and arrays are structure, not values: they are walked through, never counted.
 * An empty object or array therefore contributes nothing at all. That is the one
 * genuinely arguable call in this file — see EMPTY CONTAINERS in the header — and
 * `leafValuesWithEmptyContainers` computes the alternative so the difference is a
 * number in a test rather than an opinion in a comment.
 */
export function leafValues(node, out = []) {
  if (node === null || typeof node !== 'object') {
    out.push(node);
    return out;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) leafValues(v, out);
  return out;
}

/** The rejected reading that treats `{}` and `[]` as leaves. Yields 36, not 39. */
export function leafValuesWithEmptyContainers(node, out = []) {
  if (node === null || typeof node !== 'object') {
    out.push(node);
    return out;
  }
  const entries = Array.isArray(node) ? node : Object.values(node);
  if (entries.length === 0) {
    out.push(Array.isArray(node) ? '[]' : '{}');
    return out;
  }
  for (const v of entries) leafValuesWithEmptyContainers(v, out);
  return out;
}

/** The values of the response object's own top-level keys. The rejected reading. */
export function topLevelValues(node) {
  if (node === null || typeof node !== 'object') return [node];
  return Array.isArray(node) ? node : Object.values(node);
}

/** The declared `200` `application/json` example, or undefined when there is none. */
export function responseExampleOf(op) {
  const r200 = op?.responses?.['200'] ?? op?.responses?.[200];
  return r200?.content?.['application/json']?.example;
}

function share(values) {
  if (values.length === 0) return { total: 0, placeholders: 0, ratio: null };
  const placeholders = values.filter((v) => v === PLACEHOLDER).length;
  return { total: values.length, placeholders, ratio: placeholders / values.length };
}

/** Only string leaves. A rejected reading — see the header. Yields 40, not 39. */
export function stringLeafValues(node) {
  return leafValues(node).filter((v) => typeof v === 'string');
}

/**
 * Measure one operation under every reading, so the gap between them is data.
 * `leaf` is the PINNED reading; the others exist to be compared against it.
 */
export function measureOperation(name, op) {
  const example = responseExampleOf(op);
  const none = { total: 0, placeholders: 0, ratio: null };
  if (example === undefined) {
    return {
      name,
      has_example: false,
      leaf: none,
      leaf_with_empty_containers: none,
      string_leaves: none,
      top_level: none,
    };
  }
  return {
    name,
    has_example: true,
    leaf: share(leafValues(example)),
    leaf_with_empty_containers: share(leafValuesWithEmptyContainers(example)),
    string_leaves: share(stringLeafValues(example)),
    top_level: share(topLevelValues(example)),
  };
}

/**
 * Measure a parsed OpenAPI document.
 *
 * `by_scalar_leaf_values` is the pinned answer. The other keys are the readings that
 * were considered and rejected; they are returned rather than described so the header
 * comment cannot drift away from what the code actually does.
 */
export function measureSpec(doc, { threshold = THRESHOLD } = {}) {
  const perEndpoint = [];
  for (const [p, item] of Object.entries(doc?.paths ?? {})) {
    const op = item?.post;
    if (!op) continue; // the API is POST-only; a path without one is not an endpoint
    perEndpoint.push(measureOperation(op.operationId ?? p.replace(/^\//, ''), op));
  }
  perEndpoint.sort((a, b) => a.name.localeCompare(b.name));

  const dominated = (reading, cmp = (r) => r >= threshold) =>
    perEndpoint.filter((e) => e[reading].ratio !== null && cmp(e[reading].ratio)).map((e) => e.name);

  const pinned = dominated('leaf');
  const noExample = perEndpoint.filter((e) => !e.has_example).map((e) => e.name);
  const reading = (name, cmp) => ({ count: dominated(name, cmp).length, endpoints: dominated(name, cmp) });

  return {
    definition:
      `an endpoint is placeholder-dominated when at least ${Math.round(threshold * 100)}% of the ` +
      `SCALAR LEAF VALUES of its 200 application/json example — strings, numbers, booleans and ` +
      `nulls at any depth, arrays included, objects and arrays themselves excluded — are exactly ` +
      `the string "${PLACEHOLDER}"`,
    threshold,
    endpoints_total: perEndpoint.length,
    no_example: noExample,
    by_scalar_leaf_values: { count: pinned.length, endpoints: pinned },
    rejected_readings: {
      top_level_keys_only: reading('top_level'),
      leaf_with_empty_containers: reading('leaf_with_empty_containers'),
      string_leaves_only: reading('string_leaves'),
      scalar_leaves_strictly_above: reading('leaf', (r) => r > threshold),
    },
    per_endpoint: perEndpoint,
  };
}

/** The one sentence that is allowed into a doc. Generated, never typed. */
export function claimSentence(result) {
  const n = result.by_scalar_leaf_values.count;
  const total = result.endpoints_total;
  const pct = Math.round(result.threshold * 100);
  const none = result.no_example.length;
  return (
    `${n} of ${total} response examples are at least ${pct}% the literal string ` +
    `"${PLACEHOLDER}" by scalar leaf value` +
    (none ? `; ${none} (${result.no_example.join(', ')}) declare no example at all` : '')
  );
}

export function measureSpecFile(file, opts) {
  return measureSpec(YAML.parse(fs.readFileSync(file, 'utf8')), opts);
}

// --- CLI -------------------------------------------------------------------
// Realpath on both sides: `path.resolve` normalises but does NOT follow symlinks,
// so this guard was false whenever the file was reached through one. Same rule as
// bin/richapi.mjs; see the note there.
const realOf = (f) => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
if (process.argv[1] && realOf(path.resolve(process.argv[1])) === realOf(fileURLToPath(import.meta.url))) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  const specIdx = argv.indexOf('--spec');
  const spec = path.resolve(ROOT, specIdx === -1 ? 'spec/openapi.yaml' : argv[specIdx + 1]);

  const result = measureSpecFile(spec);
  if (flags.has('json')) {
    console.log(JSON.stringify(flags.has('per-endpoint') ? result : { ...result, per_endpoint: undefined }, null, 2));
  } else {
    const rr = result.rejected_readings;
    console.log(`spec: ${path.relative(ROOT, spec)}`);
    console.log(`definition: ${result.definition}`);
    console.log('');
    console.log(`  endpoints                       ${result.endpoints_total}`);
    console.log(`  no example at all               ${result.no_example.length}  (${result.no_example.join(', ')})`);
    console.log(`  >=40% "example", SCALAR LEAVES  ${result.by_scalar_leaf_values.count}   <- PINNED`);
    console.log('  rejected readings, for comparison:');
    console.log(`    top-level keys only           ${rr.top_level_keys_only.count}`);
    console.log(`    leaves + empty containers     ${rr.leaf_with_empty_containers.count}`);
    console.log(`    string leaves only            ${rr.string_leaves_only.count}`);
    console.log(`    scalar leaves, strict >40%    ${rr.scalar_leaves_strictly_above.count}`);
    console.log('');
    console.log(`claim: ${claimSentence(result)}`);
    if (flags.has('per-endpoint')) {
      console.log('');
      for (const e of result.per_endpoint) {
        const f = (x) => (x.ratio === null ? '  n/a' : `${(x.ratio * 100).toFixed(0).padStart(3)}%`);
        console.log(`  ${e.name.padEnd(42)} leaf ${f(e.leaf)} (${e.leaf.placeholders}/${e.leaf.total})   top ${f(e.top_level)}`);
      }
    }
  }
}
