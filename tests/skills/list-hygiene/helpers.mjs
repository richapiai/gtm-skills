// tests/skills/list-hygiene/helpers.mjs — test helpers.
// (Kept inside tests/skills/list-hygiene/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL_DIR = join(REPO_ROOT, 'skills', 'list-hygiene');
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

/** The SKILL.md body, frontmatter stripped. Shape rules apply to the body only. */
export function skillSource() {
  return readFileSync(SKILL_MD, 'utf8');
}

export function skillBody() {
  const src = skillSource().replace(/\r\n/g, '\n');
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

const tmpRoots = [];

export function tmpRoot(prefix = 'list-hygiene-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

export function cleanupTmp() {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

process.on('exit', cleanupTmp);

/**
 * A project root with a suppression store containing `entries`.
 * Pass `null` to get a root with NO store at all — the fail-closed case.
 */
export function rootWithStore(entries) {
  const root = tmpRoot();
  if (entries === null) return root;
  mkdirSync(join(root, 'gtm'), { recursive: true });
  const body = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(join(root, 'gtm', 'suppression.jsonl'), body ? body + '\n' : '', 'utf8');
  return root;
}

/**
 * A throwaway copy of the package holding ONLY the skills named, so the real
 * validator can be run against this suite's output without other skills' in-progress
 * skill directories deciding whether this suite is green.
 */
/**
 * Every `../x/SKILL.md` link target reachable from `roots`, roots included.
 *
 * The sandbox used to take a HAND-WRITTEN list, and that broke the first time a
 * sibling link was added to this skill: the validator lints every skill in the
 * tree it is handed, so a link out of the sandbox reads as a broken link and
 * turns this suite red for someone else's edit. Deriving the closure means a new
 * link is followed instead of fatal.
 */
export function linkClosure(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const md = join(REPO_ROOT, 'skills', name, 'SKILL.md');
    if (!existsSync(md)) continue;
    seen.add(name);
    for (const m of readFileSync(md, 'utf8').matchAll(/\]\(\.\.\/([^/)]+)\/SKILL\.md\)/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return [...seen];
}

export function validatorSandbox(skillNames) {
  const dir = tmpRoot('list-hygiene-validate-');
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
export function runValidator(dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * Endpoint invocations in a SKILL.md body, using the SAME pattern the validator
 * uses. Copying the regex would let the two drift; this is deliberately the one
 * unambiguous form (`name(`), which is what the validator resolves against the
 * catalog.
 */
export function invokedEndpoints(body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}
