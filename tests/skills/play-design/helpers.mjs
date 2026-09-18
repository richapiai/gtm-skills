// tests/skills/play-design/helpers.mjs — test helpers for /play-design.
// (Kept inside tests/skills/play-design/ rather than the shared tests/helpers/.)
//
// The requested gate keys for BOTH of this suite's skills live in
// tests/skills/research-agent/helpers.mjs, so there is one copy of the request rather
// than two that can disagree.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export { REQUESTED_GATES, gatesWithRequestedKeys, gatesWithout } from '../research-agent/helpers.mjs';

export const SKILL = 'play-design';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource (name = SKILL) {
  return readFileSync(join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
}

export function skillBody (name = SKILL) {
  const src = skillSource(name);
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

export function catalog () {
  return JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
}

export function owners () {
  return parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
}

export function ownedEndpoints (skill = SKILL) {
  return new Set(
    Object.entries(owners().endpoints)
      .filter(([, skills]) => skills.includes(skill))
      .map(([name]) => name)
  );
}

/** Same regex the validator uses. Copying a different one would let the two drift. */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

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

/** Every skill directory that actually ships a SKILL.md. */
export function shippedSkills () {
  const dir = join(REPO_ROOT, 'skills');
  return new Set(readdirSync(dir).filter(d => existsSync(join(dir, d, 'SKILL.md'))));
}

const tmpRoots = [];
export function tmpRoot (prefix = 'play-design-') {
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

export function validatorSandbox (skillNames) {
  const dir = tmpRoot('play-design-validate-');
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

export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** A play record that satisfies every rule. Tests break ONE thing off this at a time. */
export function goodPlay (overrides = {}) {
  return {
    name: 'new-revops-hire-at-a-series-b-account',
    version: 1,
    approved_at: '2026-08-20T00:00:00Z',
    stages: {
      trigger: { runs: ['signal-watch'], schedule_via: 'scheduled-workflow', params: { title: 'RevOps' } },
      audience: { runs: ['icp-review', 'build-prospect-list', 'evidence-score'], rows: 120 },
      prepare: { runs: ['enrich-waterfall', 'list-hygiene'] },
      act: { runs: ['personalize', 'sequence-builder', 'comply', 'campaign-review', 'launch'] },
      measure: { runs: ['measure', 'gtm-retro', 'learn'] },
    },
    measurement: { primary_metric: 'meetings_per_cycle', declared_before_first_run: true },
    audience_rows: 120,
    last_run_measured: true,
    ...overrides,
  };
}
