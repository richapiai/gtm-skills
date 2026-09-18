// tests/skills/gtm-kickoff/helpers.mjs — test helpers.
//
// Scoped to two skills (/gtm-kickoff and /icp-review). The generic pieces —
// the validator sandbox, the link closure, the fenced-block reader — are imported by
// tests/skills/icp-review/ rather than copied there: two copies of a sandbox builder
// drift, and a drifted sandbox is a green run that proves nothing.
//
// Nothing here lives in the shared tests/helpers/. Everything here is
// scoped to this suite's two skills and duplicated deliberately rather than reached for
// across test directories.
//
// The one thing this file must never do is re-implement a shipped engine. Gate lookups
// go through _lib/gates.mjs and the null-alias set comes from _lib/dual-contract.mjs,
// so a change to either shows up here as a failing test rather than as two copies of a
// rule drifting apart.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL_NAME = 'gtm-kickoff';
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL_NAME);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource () {
  return readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
}

/** The SKILL.md body, frontmatter stripped. The shape rules apply to the body only. */
export function skillBody () {
  const src = skillSource();
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

/**
 * Endpoint invocations, using the SAME unambiguous form the validator resolves
 * against the catalog. Copying its regex is deliberate: any other pattern here would
 * let the test and the linter disagree about what "invokes" means.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

// ---------------------------------------------------------------------------
// Sandbox — so this suite's green is attributable to this suite
// ---------------------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'gtm-kickoff-') {
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
 * A throwaway copy of the package holding ONLY the named skills, so the real validator
 * can run over this suite's output without another skill's in-progress SKILL.md deciding
 * whether this suite is green. Many skills are written into skills/ concurrently.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('gtm-kickoff-validate-');
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
 * The transitive closure of `../<skill>/SKILL.md` links reachable from `seeds`.
 *
 * Rule 1 makes the validator resolve every relative link, so a sandbox holding only
 * this suite's skills fails on a link OUT of the suite. Copying the closure keeps the
 * run isolated from skills this suite does not reference, while still proving that
 * everything this suite points at actually exists.
 */
export function linkClosure (seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const md = join(REPO_ROOT, 'skills', name, 'SKILL.md');
    if (!existsSync(md)) continue;          // reported by the validator, not swallowed here
    seen.add(name);
    const src = readFileSync(md, 'utf8');
    for (const m of src.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) queue.push(m[1]);
  }
  return [...seen].sort();
}

export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ---------------------------------------------------------------------------
// The fenced, machine-readable contract, loaded OUT OF the shipped skill
// ---------------------------------------------------------------------------

/**
 * Extract one fenced block by its info string. No default is returned for a missing
 * block: a default contract is exactly how a deleted rule goes unnoticed.
 */
export function fencedBlock (src, infoWord, label = SKILL_MD) {
  const fenceRe = new RegExp(`^\`\`\`yaml[ \\t]+${infoWord}[ \\t]*$`);
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) {
      if (fenceRe.test(line)) open = [];
      continue;
    }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new Error(`unterminated \`${infoWord}\` fence in ${label}`);
  if (blocks.length === 0) throw new Error(`${label} carries no \`\`\`yaml ${infoWord} block`);
  if (blocks.length > 1) throw new Error(`${label} carries ${blocks.length} \`${infoWord}\` blocks; exactly one is the contract`);
  return blocks[0];
}

export function loadBriefContract ({ path = SKILL_MD } = {}) {
  if (!existsSync(path)) throw new Error(`no SKILL.md at ${path}`);
  const doc = parseYaml(fencedBlock(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'kickoff-brief'));
  if (!doc || typeof doc !== 'object') throw new Error('the kickoff-brief block did not parse to a map');
  return doc;
}
