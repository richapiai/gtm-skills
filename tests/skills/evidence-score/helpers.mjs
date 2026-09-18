// tests/skills/evidence-score/helpers.mjs — test helpers.
// (Kept inside tests/skills/evidence-score/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { newArtifact, storeLlmResult } from '../../../_lib/dual-contract.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const skillDir = (name) => join(REPO_ROOT, 'skills', name);
export const skillMd = (name) => join(skillDir(name), 'SKILL.md');

export function skillSource (name) { return readFileSync(skillMd(name), 'utf8'); }

/** The SKILL.md body, frontmatter stripped. Shape rules apply to the body only. */
export function skillBody (name) {
  const src = skillSource(name).replace(/\r\n/g, '\n');
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

const tmpRoots = [];
export function tmpRoot (prefix = 'evidence-score-') {
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
 * A throwaway copy of the package holding ONLY the skills named, so the real
 * validator can run against this suite's output without another skill's in-progress
 * (or empty) skill directory deciding whether this suite is green.
 *
 * `gatesMutate` receives the sandbox's PARSED copy of the real gates.yaml and may
 * change it freely — that copy is what the validator then reads. It is how a test
 * proves the skill's `gates.yaml:` citations are load-bearing: strip the block back
 * out and the validator must fail the skill. This suite still never writes
 * _lib/gates.yaml, which it may not touch.
 */
export function validatorSandbox (skillNames, { gatesMutate = null } = {}) {
  const dir = tmpRoot('evidence-score-validate-');
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
    cpSync(skillDir(name), join(dir, 'skills', name), { recursive: true });
  }
  if (gatesMutate) {
    const p = join(dir, '_lib', 'gates.yaml');
    const doc = parseYaml(readFileSync(p, 'utf8'));
    gatesMutate(doc);
    writeFileSync(p, stringifyYaml(doc), 'utf8');
  }
  return dir;
}

/**
 * Every skill reachable by relative `../x/SKILL.md` links from `seeds`, transitively.
 *
 * A fixed list goes stale the week another skill adds a link, and a stale list shows up
 * as a rule-1 "broken link" failure in THIS suite's test for somebody else's edit. The
 * closure is computed instead, so the sandbox always holds exactly what the links need.
 */
export function linkClosure (seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const md = skillMd(name);
    if (!existsSync(md)) continue;
    seen.add(name);
    for (const m of readFileSync(md, 'utf8').matchAll(/\]\(\.\.\/([^/)]+)\/SKILL\.md\)/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return [...seen];
}

/** Error lines the validator attributed to a particular skill. */
export function errorsFor (out, skillNames) {
  const wanted = new Set(skillNames);
  return out.split('\n')
    .filter(l => /^\s*✗\s/.test(l))
    .filter(l => {
      const m = l.match(/✗\s+skills\/([^:]+):/);
      return m && wanted.has(m[1]);
    })
    .map(l => l.trim());
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
// `skills.evidence_score` and `skills.personalize` are MERGED into _lib/gates.yaml —
// the orchestrator applied them, and `loadGates()` is now the working state rather
// than the pending one. This suite still may not edit that file, so the two things it
// needs from here are the mirror image of what it needed before the merge:
//
//   1. PINNED_GATES pins the values this suite's arithmetic is calibrated against, so a
//      silent edit to a band cutoff is a red run rather than a quiet re-grading.
//      `tests/skills/evidence-score/rules-block.test.mjs` asserts these ARE what the
//      shipped file resolves to, which is what keeps the pin honest.
//   2. `gatesWithout()` / the sandbox's `gatesMutate` strip a block back out. Now that
//      the keys exist, that is the only honest way to keep testing the fail-closed
//      half — a test that relied on the real file lacking the key stopped testing
//      anything the moment the key landed.
// ---------------------------------------------------------------------------

export const PINNED_GATES = Object.freeze({
  evidence_score: {
    emit_min_confidence: 0.70,
    evidence_max_age_days: 90,
    min_dimensions_scored: 3,
    band_hot_min: 80,
    band_warm_min: 60,
    band_watch_min: 40,
    priority_reachability_min: 8,
  },
  personalize: {
    ai_enrich_batch_min_rows: 200,
  },
});

/**
 * A deep copy of `gates` with the named dotted paths deleted.
 *
 * Drives every fail-closed assertion in this suite. Deleting rather than never-having
 * is deliberate: it exercises the same `MissingGateKey` -> STOP path the old
 * "the block is not merged yet" tests exercised, but it stays true forever instead of
 * expiring at the merge — and it is a property of the CODE (a lost merge hunk wedges
 * the skill) rather than an accident of the file's current contents.
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
      // A no-op strip would turn every fail-closed test below it green and vacuous.
      throw new Error(`gatesWithout: ${dotted} is not present to strip — has the block moved?`);
    }
    delete node[leaf];
  }
  return gates;
}

/**
 * The real gates.yaml, deep-copied, mutated, written to a temp file — for the code
 * paths that take a gates PATH rather than a loaded object. Mirrors
 * `tests/skills/measure/helpers.mjs:gatesFileWith`.
 */
export function gatesFileWith (dir, mutate) {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const file = join(dir, `gates-${Math.random().toString(36).slice(2, 8)}.yaml`);
  writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Brief builders. A research brief IS a dual-contract artifact.
// ---------------------------------------------------------------------------

export const FRESH = '2026-08-20T00:00:00Z';
export const NOW = new Date('2026-08-28T12:00:00Z');

export function brief () { return newArtifact(); }

/** A verified fact with a real source line and a fetch timestamp. */
export function verified (b, field, value, {
  source = 'https://acme.example/press/series-b', fetched_at = FRESH, confidence,
} = {}) {
  const rec = { value, source, fetched_at };
  if (confidence !== undefined) rec.confidence = confidence;
  b.verified[field] = rec;
  return b;
}

/** An LLM-derived value, stored the way the runtime stores one. */
export function inferred (b, field, response) {
  storeLlmResult(b, field, response);
  return b;
}
