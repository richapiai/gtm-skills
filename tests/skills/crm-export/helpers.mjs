// tests/skills/crm-export/helpers.mjs — test helpers.
// (Kept inside tests/skills/crm-export/ rather than the shared tests/helpers/.)

import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const SKILL = 'crm-export';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL_MD = join(REPO_ROOT, 'skills', SKILL, 'SKILL.md');

export function skillSource (name = SKILL) {
  return readFileSync(join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
}

export function skillBody (name = SKILL) {
  const src = skillSource(name);
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

export function skillProse (name = SKILL) {
  return skillBody(name).replace(/^```[\s\S]*?^```$/gm, '');
}

export const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
export const owners  = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));

export function ownedEndpoints (name = SKILL) {
  return new Set(
    Object.entries(owners.endpoints)
      .filter(([, skills]) => skills.includes(name))
      .map(([e]) => e)
  );
}

export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

export function citedGateKeys (body) {
  return new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]));
}

export function sections (body) {
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

export function section (re, body) {
  const hits = sections(body).filter(s => re.test(s.heading));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one section matching ${re}, found ${hits.length}`
      + ` (${hits.map(h => h.heading).join(' | ')})`);
  }
  return hits[0];
}

export function directLinks (body) {
  return [...new Set([...body.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)].map(m => m[1]))];
}

// --- the script that ships INSIDE the SKILL.md ------------------------------
//
// Extracted rather than imported, for the reason tests/skills/launch/skill-runner.mjs
// gives: the gate is only real if the thing the user runs is the thing that refuses. A
// gate living in a test-only helper lets the SKILL.md drift into "just export it" while
// every test stays green.

export const SCRIPT_MARKER = '==== gtm-crm-export v1 ====';

export function extractScript (marker = SCRIPT_MARKER) {
  const src = skillSource();
  const blocks = [...src.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
  const hit = blocks.find(b => b.split('\n', 1)[0].includes(marker));
  if (!hit) {
    throw new Error(`skills/${SKILL}/SKILL.md no longer carries a \`\`\`js block marked "${marker}". `
      + 'The gate these tests exercise is the one the skill ships; if the script moved, move these tests.');
  }
  return hit;
}

/** Run the extracted script exactly as the SKILL.md tells the user to. */
export function runExport (env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', extractScript()], {
    cwd: REPO_ROOT,
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

/** Refusal codes parsed off stderr, so a test asserts the code and not the prose. */
export function refusalCodes (out) {
  return [...out.matchAll(/^ {2}([A-Z_]{4,}): /gm)].map(m => m[1]);
}

/** The targets the shipped script itself admits to, read out of its UNKNOWN_TARGET fix. */
export function scriptTargets () {
  const r = runExport({ LIST: '/dev/null', OUT: '/dev/null', TARGET: '__no_such_target__' });
  const m = r.out.match(/Pick one of: ([^.]+)\./);
  if (!m) throw new Error(`could not read the target list out of the script's refusal:\n${r.out}`);
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// --- sandbox ---------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'q5-crm-') {
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
 * A throwaway project root with a `gtm/` tree. Never the developer's real one: `gtm/`
 * is PII (law 7) and a stray tree is something a later `/comply erase` test could
 * mistake for real data.
 */
export function projectRoot ({ suppression = null } = {}) {
  const root = tmpRoot();
  for (const d of ['lists', 'exports']) mkdirSync(join(root, 'gtm', d), { recursive: true });
  if (suppression !== null) {
    writeFileSync(join(root, 'gtm', 'suppression.jsonl'),
      suppression.map(e => JSON.stringify(e)).join('\n') + (suppression.length ? '\n' : ''), 'utf8');
  }
  return root;
}

export function writeCsv (root, rel, rows) {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const text = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

export function writeJsonl (root, rel, rows) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

// --- validator sandbox ------------------------------------------------------

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
  const dir = tmpRoot('q5-crm-validate-');
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

/**
 * Validator lines attributable to `label`. The sandbox is transitively closed, so it
 * can still hold another skill linking to something not yet written; those
 * errors are labelled with the LINKING skill, so filtering by label is exact.
 */
export function linesFor (out, label) {
  return out.split('\n').filter(l => l.includes(`skills/${label}:`)).map(l => l.trim());
}
