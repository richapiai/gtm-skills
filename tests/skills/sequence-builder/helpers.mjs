// tests/skills/sequence-builder/helpers.mjs — test helpers for /sequence-builder.
// (Kept inside tests/skills/sequence-builder/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const SKILL = 'sequence-builder';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
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

export function catalog () {
  return JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
}

export function owners () {
  return parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
}

export function gates () {
  return parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
}

/** Every endpoint the owners file assigns to this skill. */
export function ownedEndpoints (skill = SKILL) {
  return new Set(
    Object.entries(owners().endpoints)
      .filter(([, skills]) => skills.includes(skill))
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

/** Every `gates.yaml:<dotted.key>` the body cites, as the validator reads them. */
export function citedGateKeys (body) {
  return [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
}

/** Fenced code blocks are examples, not policy — the bare-number scanner skips them. */
export function bodyWithoutFences (body) {
  const out = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

/** Split the body into `## ` sections: [{ heading, text }] in document order. */
export function sections (body = skillBody()) {
  const out = [];
  let cur = { heading: '(preamble)', text: '' };
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { out.push(cur); cur = { heading: m[1].trim(), text: '' }; continue; }
    cur.text += line + '\n';
  }
  out.push(cur);
  return out;
}

const tmpRoots = [];

export function tmpRoot (prefix = 'sequence-builder-') {
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
 * Every skill reachable from `roots` by `../<name>/SKILL.md` links, roots included.
 * The sandbox must be transitively closed or the validator reports a broken link in a
 * sibling and turns this suite red over another skill's routing.
 */
export function linkClosure (roots) {
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

/** A throwaway package holding only the named skills plus everything they link to. */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('sequence-builder-validate-');
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs',
    'dual-contract.mjs', 'dual-contract.schema.json']) {
    cpSync(join(REPO_ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  for (const name of linkClosure(skillNames)) {
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

/**
 * Validator output lines that name a given skill. Filtering rather than asserting on
 * the exit code keeps this suite green when another in-progress skill is red: the
 * validator lints the whole tree it is handed, and the link closure necessarily pulls
 * in siblings this suite does not own.
 */
export function linesFor (out, skill) {
  return out.split('\n').filter(l => l.includes(`skills/${skill}:`));
}
