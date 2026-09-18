// tests/skills/local-business-prospecting/helpers.mjs — test helpers.
//
// `tests/helpers/` is shared and `tests/skills/<other>/` belongs to other skills, so
// this skill's machinery lives here. It is deliberately a near-twin of the helper file
// under tests/skills/tam-map/: the two suites assert against the same three source
// files (the catalog, the owners file, the spec) and a divergent reader is how two
// suites end up computing different answers from the same bytes. The pack hit that once
// already, with "the 11 unbounded endpoints".

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL = 'local-business-prospecting';
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource () {
  return readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
}

/** The body, frontmatter stripped. Every shape rule applies to the body only. */
export function skillBody () {
  const src = skillSource();
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

/** The body with fenced code blocks removed — for prose-only assertions. */
export function skillProse () {
  return skillBody().replace(/^```[\s\S]*?^```$/gm, '');
}

/** Just the fenced blocks, which is where every shell example lives. */
export function skillFences () {
  return [...skillBody().matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

/** The boundary section — everything from the first "will not" heading onward. */
export function boundarySection () {
  const body = skillBody();
  const at = body.search(/^#{2,3}\s+.*will not/im);
  return at < 0 ? '' : body.slice(at);
}

export const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
export const owners = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
export const gates = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));

let specDoc = null;
export function spec () {
  if (!specDoc) specDoc = parseYaml(readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'), 'utf8'));
  return specDoc;
}

/** The request-body schema the spec declares for an endpoint. */
export function requestSchema (endpoint) {
  const def = catalog.endpoints[endpoint];
  const op = spec().paths?.[def?.path]?.post;
  return op?.requestBody?.content?.['application/json']?.schema ?? null;
}

/**
 * This skill's endpoint set, DERIVED from the catalog's capability group rather than
 * listed here. "The maps and directory endpoints" is the scope it was given; deriving
 * it means a new endpoint landing in that group turns this suite red instead of being
 * silently unowned.
 */
export function capabilityGroupEndpoints (group = 'maps_directories') {
  return new Set(
    Object.entries(catalog.endpoints)
      .filter(([, def]) => def.capability_group === group)
      .map(([name]) => name)
  );
}

/** Every endpoint `_lib/endpoint-owners.yaml` currently assigns to this skill. */
export function ownedEndpoints (skill = SKILL) {
  return new Set(
    Object.entries(owners.endpoints)
      .filter(([, skills]) => skills.includes(skill))
      .map(([name]) => name)
  );
}

/** Whoever the owners file currently names for an endpoint. */
export function currentOwners (endpoint) {
  return owners.endpoints?.[endpoint] ?? [];
}

/**
 * Endpoint invocations in a SKILL.md body, using the SAME pattern the validator uses.
 * Copying the regex would let the two drift; this is the one unambiguous form.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map((m) => m[1]));
}

/** Gate keys the SKILL.md cites, as dotted paths. */
export function citedGateKeys (body) {
  return new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map((m) => m[1]));
}

// --- sandbox ---------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'lbp-') {
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

/** Every skill reachable from `start` by following relative links, transitively. */
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

/**
 * A throwaway copy of the package holding ONLY the named skills, so the real validator
 * decides whether this suite is green on its own merits rather than on whether another
 * skill happens to have a half-written SKILL.md on disk right now.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('lbp-validate-');
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

// --- shell-example parsing --------------------------------------------------
//
// The cost traps in this skill are both expressed as command lines, so the tests read
// the command lines rather than the prose around them. A paragraph can promise
// `--expect`; only the example proves it.

/** Every `richapi <verb> <endpoint> ...` invocation in a fenced block, joined. */
export function shellCommands () {
  const joined = skillFences().join('\n')
    // A backslash-newline continuation is one command.
    .replace(/\\\n\s*/g, ' ');
  const out = [];
  for (const line of joined.split('\n')) {
    const m = line.match(/^\s*(richapi\s+(call|search)\s+([a-z_][a-z0-9_]*)\b.*)$/);
    if (m) out.push({ text: m[1].trim(), verb: m[2], endpoint: m[3] });
  }
  return out;
}

/** `--param k=v` pairs on one command line. */
export function paramsOf (cmd) {
  const out = {};
  for (const m of cmd.matchAll(/--param\s+([a-z_][a-z0-9_]*)(?::)?=("[^"]*"|\S+)/g)) {
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** The `--expect <n>` value on one command line, or null. */
export function expectOf (cmd) {
  const m = cmd.match(/--expect[= ]\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
