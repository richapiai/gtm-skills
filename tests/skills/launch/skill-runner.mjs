// Runs the gate scripts that ship INSIDE the SKILL.md files.
//
// Why extract instead of importing a module: the sole-writer mechanism is only real if the
// thing the user runs is the thing that refuses. If the gate lived in a test-only
// helper, the SKILL.md could drift into "just export it" and every test would stay
// green. So these tests read the fenced script out of the shipped SKILL.md and run
// it verbatim — a skill whose script rots fails here.
//
// Lives under tests/skills/launch/ because it serves tests/skills/launch/** and
// tests/skills/campaign-review/** and nothing above them; the campaign-review suite
// imports it from here rather than putting a shared file in an unowned directory.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const PACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const SKILL_MD = {
  launch: path.join(PACK_ROOT, 'skills', 'launch', 'SKILL.md'),
  'campaign-review': path.join(PACK_ROOT, 'skills', 'campaign-review', 'SKILL.md'),
};

/** Pull the fenced ```js block whose first line carries `marker` out of a SKILL.md. */
export function extractScript (skill, marker) {
  const src = fs.readFileSync(SKILL_MD[skill], 'utf8');
  const blocks = [...src.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.split('\n', 1)[0].includes(marker));
  if (!hit) {
    throw new Error(`skills/${skill}/SKILL.md no longer carries a \`\`\`js block marked "${marker}". `
      + 'The gate the tests exercise is the one the skill ships; if the script moved, move these tests with it.');
  }
  return hit;
}

export const LAUNCH_SCRIPT = () => extractScript('launch', '==== gtm-launch v1 ====');
export const REVIEW_SCRIPT = () => extractScript('campaign-review', '==== gtm-campaign-review v1 ====');

/**
 * Run one of the extracted scripts exactly as the SKILL.md tells the user to:
 * `node --input-type=module -e <script>` from the pack root, configured by env.
 */
export function runScript (script, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) },
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    out: (res.stdout ?? '') + (res.stderr ?? ''),
  };
}

export const runLaunch = (env) => runScript(LAUNCH_SCRIPT(), env);
export const runReview = (env) => runScript(REVIEW_SCRIPT(), env);

/** Refusal codes parsed off stderr, so a test asserts the code and not the prose. */
export function refusalCodes (out) {
  return [...out.matchAll(/^ {2}([A-Z_]{4,}): /gm)].map((m) => m[1]);
}

/**
 * A copy of the real gates.yaml with a few leaves changed, written into `dir`.
 * Used only to prove that the gate reads gates.yaml rather than a hard-coded number:
 * These tests may not edit _lib/gates.yaml, so the alternative would be no coverage at all.
 */
export function gatesFileWith (dir, mutate) {
  const doc = parseYaml(fs.readFileSync(path.join(PACK_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const file = path.join(dir, `gates-${Math.random().toString(36).slice(2, 8)}.yaml`);
  fs.writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}
