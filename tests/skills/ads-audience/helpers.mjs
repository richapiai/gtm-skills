// tests/skills/ads-audience/helpers.mjs — test helpers for /ads-audience.
// (Kept inside tests/skills/ads-audience/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const SKILL = 'ads-audience';

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
 * Copying a different regex would let the two drift.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
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

export function tmpRoot (prefix = 'ads-audience-') {
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
 * The sandbox must be transitively closed or it fails for the wrong reason: the
 * validator lints EVERY skill in the tree it is given.
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

/**
 * A throwaway copy of the package holding ONLY the skills named (plus everything they
 * link to), so the real validator can be run against this suite's output without other
 * skills' in-progress directories deciding whether this suite is green. On
 * 2026-08-29 the live tree carried five skill directories with no SKILL.md yet; the
 * sandbox is what keeps that from reading as an /ads-audience failure.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('ads-audience-validate-');
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

// ---------------------------------------------------------------------------
// Gate values.
//
// `skills.ads_audience` is MERGED into _lib/gates.yaml — the orchestrator applied the
// block this suite requested, so `loadGates()` is now the working state rather than the
// pending one. This suite still may not edit that file, so what it needs from here is
// the mirror image of what it needed before the merge:
//
//   1. REQUESTED_GATES pins the values this suite's arithmetic was calibrated against.
//      `skill-shape.test.mjs` asserts the shipped file resolves to exactly these, so a
//      silent edit to the fill ceiling is a red run rather than a quiet re-sizing.
//   2. `gatesWithout()` strips a block back out. Now that the keys exist that is the
//      only honest way to keep testing the fail-closed half — a test that relied on
//      the real file lacking the key stopped testing anything at the merge.
//
// The SKILL.md now cites both keys as `gates.yaml:<key>`, and rule 4 of
// docs/skill-shape.md resolves every one of those, so a typo fails loudly.
// ---------------------------------------------------------------------------

export const REQUESTED_GATES = Object.freeze({
  ads_audience: {
    // Rows one run may put through the paid fill. email_finder is flat-priced per
    // call, so this is the only bound on the fill that is not the session budget.
    max_fill_rows: 2000,
    // Uploading exactly at the floor fails: the platform matches a fraction. This is
    // the multiple of the floor the CEILING must clear before the fill is offered.
    pre_match_headroom_multiple: 1.5,
  },
});

/** A gates object with the requested keys grafted on, for exercising the merged state. */
export function gatesWithRequestedKeys (base) {
  const gates = JSON.parse(JSON.stringify(base ?? {}));
  gates.skills = { ...(gates.skills || {}) };
  gates.skills.ads_audience = { ...REQUESTED_GATES.ads_audience };
  return gates;
}
