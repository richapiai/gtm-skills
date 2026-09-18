// Access to the pinned fixture corpus.
//
// The five spec fixtures ARE the monthly-absorption test. Load them
// through here rather than by path so that a rename breaks one file instead of
// five suites, and so that every consumer sees the same manifest of declared
// expectations.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const FIXTURES_DIR = join(HERE, '..', 'fixtures');
export const SPEC_FIXTURES_DIR = join(FIXTURES_DIR, 'spec');
export const LIVE_FIXTURES_DIR = join(FIXTURES_DIR, 'live');
export const FIELD_MAPS_DIR = join(LIVE_FIXTURES_DIR, 'field-maps');

/** The five pinned spec snapshots, in the monthly-absorption order. */
export const SPEC_FIXTURE_NAMES = Object.freeze([
  'current', 'endpoint-added', 'endpoint-removed', 'price-changed', 'malformed'
]);

/** Absolute path to a spec fixture. */
export function specFixturePath (name) {
  if (!SPEC_FIXTURE_NAMES.includes(name)) {
    throw new Error(`unknown spec fixture "${name}". Known: ${SPEC_FIXTURE_NAMES.join(', ')}`);
  }
  return join(SPEC_FIXTURES_DIR, `${name}.yaml`);
}

/** Raw YAML text of a spec fixture. `malformed` is returned unparsed, by design. */
export function specFixtureText (name) {
  return readFileSync(specFixturePath(name), 'utf8');
}

/**
 * Parsed spec fixture. Throws YamlError for `malformed` — that is the point of
 * that fixture, so catch it deliberately rather than calling this by accident.
 */
export function specFixture (name) {
  return parseYaml(specFixtureText(name));
}

/** The machine-readable declaration of what each fixture encodes. */
export function specFixtureManifest () {
  return JSON.parse(readFileSync(join(SPEC_FIXTURES_DIR, 'manifest.json'), 'utf8'));
}

/** The declared expectations for one fixture. */
export function expectationsFor (name) {
  const m = specFixtureManifest();
  const f = m.fixtures[name];
  if (!f) throw new Error(`manifest.json has no entry for fixture "${name}"`);
  return f;
}

/** The pinned upstream spec, parsed. */
export function pinnedSpec () {
  return parseYaml(readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'), 'utf8'));
}

/** sha256 recorded in spec/openapi.yaml.sha256. */
export function pinnedSpecSha256 () {
  return readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml.sha256'), 'utf8').trim().split(/\s+/)[0];
}

/** sha256 of the pinned spec file as it currently is on disk. */
export function actualSpecSha256 () {
  return createHash('sha256').update(readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'))).digest('hex');
}

/**
 * `{ path: operationBlockText }` for a fixture's `paths:` entries, sliced out
 * of the raw YAML text. Used to prove `current.yaml` holds byte-identical
 * slices of the pinned spec.
 */
export function pathBlocks (yamlText) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex(l => l === 'paths:');
  if (start < 0) throw new Error('no `paths:` key found');
  const out = new Map();
  let cur = null; let from = 0;
  for (let i = start + 1; i <= lines.length; i++) {
    const l = lines[i];
    const isEnd = i === lines.length || (l !== undefined && /^\S/.test(l));
    const m = l === undefined ? null : l.match(/^  (\/\S+):$/);
    if (m || isEnd) {
      if (cur) out.set(cur, lines.slice(from, i).join('\n').replace(/\s+$/, ''));
      if (isEnd) break;
      cur = m[1]; from = i;
    }
  }
  return out;
}

/** Names of the endpoints with a hand-authored placeholder field map. */
/**
 * The endpoints whose field map is STILL a hand-authored placeholder.
 *
 * Was ['email_finder', 'enrich_profiles_bulk', 'enrich_companies_bulk']. The 2026-08-31
 * capture recorded a real email_finder response and it moved to `live_capture` — which
 * is how the pack learned the address lives at `result.email` rather than at the top
 * level, and that the spec-derived map had been dropping it on every paid call.
 *
 * The bulk endpoints followed on 2026-09-17, recorded deliberately at 1 credit each.
 * None remain.
 */
export const PLACEHOLDER_FIELD_MAPS = Object.freeze([]);


/** Load a recorded/placeholder field map, or null if absent. */
export function fieldMap (endpoint) {
  const p = join(FIELD_MAPS_DIR, `${endpoint}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** All field maps present on disk, keyed by endpoint. */
export function allFieldMaps () {
  if (!existsSync(FIELD_MAPS_DIR)) return {};
  const out = {};
  for (const f of readdirSync(FIELD_MAPS_DIR).sort()) {
    if (!f.endsWith('.json')) continue;
    out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(FIELD_MAPS_DIR, f), 'utf8'));
  }
  return out;
}

export default {
  SPEC_FIXTURE_NAMES, SPEC_FIXTURES_DIR, LIVE_FIXTURES_DIR, FIELD_MAPS_DIR, FIXTURES_DIR, REPO_ROOT,
  specFixturePath, specFixtureText, specFixture, specFixtureManifest, expectationsFor,
  pinnedSpec, pinnedSpecSha256, actualSpecSha256, pathBlocks,
  fieldMap, allFieldMaps, PLACEHOLDER_FIELD_MAPS
};
