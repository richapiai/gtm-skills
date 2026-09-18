// tests/skills/call-intel/helpers.mjs — test helpers for /call-intel.
// (Kept inside tests/skills/call-intel/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const SKILL = 'call-intel';

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

export function tmpRoot (prefix = 'call-intel-') {
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
 * sandbox is what keeps that from reading as a /call-intel failure.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('call-intel-validate-');
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
// `skills.call_intel` is MERGED into _lib/gates.yaml now, so `loadGates()` is the
// working state rather than the pending one. This suite still may not edit that file, so
// what it needs from here is the mirror image of what it needed before the merge:
//
//   1. REQUESTED_GATES stops being a request and becomes a PIN. The batch floor and the
//      one-profile rule are what this suite's assertions are calibrated to, so a silent
//      edit in gates.yaml has to be a red run rather than a quiet policy change.
//   2. `gatesWithout()` strips the block back out. Now that the keys exist that is the
//      only honest way to keep testing the fail-closed half — a test that relied on the
//      real file lacking the key stopped testing anything the moment it landed.
// ---------------------------------------------------------------------------

export const REQUESTED_GATES = Object.freeze({
  call_intel: {
    // Local inference's batch escape. Below this many transcripts in one run, the surrounding
    // agent reads them for free and `ai_enrich` is a billing error. Mirrors
    // skills.personalize.ai_enrich_batch_min_rows, which is the same decision on rows.
    ai_enrich_batch_min_transcripts: 200,
    // Attendee resolution is opt-in and chosen, never swept across everyone named on
    // a call. One profile is the default shape of the hop.
    max_enrich_profile_calls_per_run: 1,
  },
});

/** A gates object with this suite's pinned values grafted on. */
export function gatesWithRequestedKeys (base) {
  const gates = JSON.parse(JSON.stringify(base ?? {}));
  gates.skills = { ...(gates.skills || {}) };
  gates.skills.call_intel = { ...REQUESTED_GATES.call_intel };
  return gates;
}

/**
 * A deep copy of `gates` with the named dotted paths deleted — the fail-closed input,
 * MADE rather than found.
 *
 * Throws on a no-op strip. A fail-closed test handed a gates object that still holds
 * the key passes while proving nothing, so the strip itself has to be load-bearing.
 * Mirrors `tests/skills/evidence-score/helpers.mjs:gatesWithout`.
 */
export function gatesWithout (base, ...dottedPaths) {
  const gates = JSON.parse(JSON.stringify(base ?? {}));
  for (const dotted of dottedPaths) {
    const parts = dotted.split('.');
    const leaf = parts.pop();
    let node = gates;
    for (const p of parts) {
      if (node === null || typeof node !== 'object' || !(p in node)) { node = null; break; }
      node = node[p];
    }
    if (node === null || typeof node !== 'object' || !(leaf in node)) {
      throw new Error(`gatesWithout: ${dotted} is not present to strip — has the block moved?`);
    }
    delete node[leaf];
  }
  return gates;
}
