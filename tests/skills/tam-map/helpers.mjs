// tests/skills/tam-map/helpers.mjs — test helpers.
// (Kept inside tests/skills/tam-map/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL = 'tam-map';
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource () {
  return readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
}

/** The SKILL.md body, frontmatter stripped. Shape rules apply to the body only. */
export function skillBody () {
  const src = skillSource();
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

/** The body with fenced code blocks removed — for prose-only assertions. */
export function skillProse () {
  return skillBody().replace(/^```[\s\S]*?^```$/gm, '');
}

export const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
export const owners  = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
export const gates   = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));

let specDoc = null;
export function spec () {
  if (!specDoc) specDoc = parseYaml(readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'), 'utf8'));
  return specDoc;
}

/** Every endpoint `_lib/endpoint-owners.yaml` assigns to this skill. */
export function ownedEndpoints () {
  return new Set(
    Object.entries(owners.endpoints)
      .filter(([, skills]) => skills.includes(SKILL))
      .map(([name]) => name)
  );
}

/**
 * Endpoint invocations in a SKILL.md body, using the SAME pattern the validator uses.
 * Copying the regex would let the two drift; this is deliberately the one unambiguous
 * form (`name(`), which is what the validator resolves against the catalog.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

/** Gate keys the SKILL.md cites, as dotted paths. */
export function citedGateKeys (body) {
  return new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]));
}

// --- the spec, read for total-count fields ---------------------------------

/**
 * Count-ish keys. A TAM number is only free when the response reports the size of the
 * WHOLE result set alongside the page that was paid for. `_list_count` is deliberately
 * absent: it is the length of the list the call returned — a page, or a `limit` the
 * caller chose — so reading it as a market size reports a request parameter as a
 * finding.
 */
export const TOTAL_COUNT_KEYS = Object.freeze(['totalElements', 'totalCount', 'totalResults', 'totalPages']);

function walkKeys (node, seen = []) {
  if (Array.isArray(node)) { for (const v of node) walkKeys(v, seen); return seen; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { seen.push(k); walkKeys(v, seen); }
  }
  return seen;
}

/** The documented 200 response example for an endpoint, or null. */
export function responseExample (endpoint) {
  const def = catalog.endpoints[endpoint];
  if (!def) return null;
  const op = spec().paths?.[def.path]?.post;
  return op?.responses?.['200']?.content?.['application/json']?.example ?? null;
}

/**
 * Does this endpoint hand back a total for the whole result set, for free, next to the
 * page it charged for? Derived from the spec, never hardcoded — the whole point of this
 * suite's table is that it was read rather than assumed.
 */
export function hasFreeTotalCount (endpoint) {
  const ex = responseExample(endpoint);
  if (ex === null) return false;
  const keys = new Set(walkKeys(ex));
  return TOTAL_COUNT_KEYS.some(k => keys.has(k));
}

/** What the endpoint is actually BILLED on, from the spec's own x-pricing. */
export function billingCountField (endpoint) {
  const def = catalog.endpoints[endpoint];
  const op = spec().paths?.[def?.path]?.post;
  return op?.['x-pricing']?.result_count_field ?? null;
}

// --- sandbox ---------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'tam-map-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
export function cleanupTmp () {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on('exit', cleanupTmp);

/**
 * A throwaway copy of the package holding ONLY the skills named, so the real validator
 * can be run against this suite's output without another skill's in-progress SKILL.md
 * deciding whether this suite is green.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('tam-map-validate-');
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs',
                   'dual-contract.mjs', 'dual-contract.schema.json']) {
    cpSync(join(REPO_ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  for (const name of skillNames) {
    cpSync(join(REPO_ROOT, 'skills', name), join(dir, 'skills', name), { recursive: true });
  }
  return dir;
}

/**
 * Every skill reachable from `start` by following relative `../<name>/SKILL.md` links,
 * transitively, including `start` itself.
 *
 * The sandbox needs the CLOSURE and not just the direct links: the validator resolves
 * links inside every skill it is handed, so copying only this suite's neighbours makes
 * their links the broken ones. Computed rather than listed, so a new link in a
 * neighbouring skill does not turn this suite red for someone else's edit.
 */
export function linkClosure (start = SKILL) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    let src;
    try { src = readFileSync(join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) queue.push(m[1]);
  }
  return [...seen];
}

/** The skills this one links to directly. */
export function directLinks (body) {
  return [...new Set([...body.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)].map(m => m[1]))];
}

/** Runs the real validator inside a sandbox. Returns { code, out }. */
export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * The "free total on page one?" column of the SKILL.md's own table, as
 * { endpoint -> boolean }. Parsed out of the markdown so the document and the spec can
 * be held against each other rather than both being trusted.
 */
export function documentedCountTable (body) {
  const out = {};
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const m = cells[1]?.match(/^`([a-z_][a-z0-9_]+)\(\)`$/);
    if (!m) continue;
    const answer = (cells[2] ?? '').replace(/\*/g, '').trim().toLowerCase();
    if (answer !== 'yes' && answer !== 'no') continue;
    out[m[1]] = answer === 'yes';
  }
  return out;
}
