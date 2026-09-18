// tests/skills/measure/helpers.mjs — test helpers.
//
// (Kept outside the shared tests/helpers/. This suite owns tests/skills/measure/** and
// tests/skills/learn/** and nothing above them, so the shared machinery for BOTH of
// this suite's skills lives here and the /learn suite imports it from here.)
//
// Two things it provides:
//
//   1. `runSkillScript` — runs the fenced ```js block that ships INSIDE a SKILL.md,
//      extracted verbatim, exactly as the skill tells the user to run it. The honesty
//      properties are only real if the thing the user runs is the thing that refuses;
//      a test-only copy of the logic would stay green while the shipped skill rotted.
//
//   2. `validatorSandbox` — a throwaway package holding only this suite's skills and
//      the transitive closure of their `../x/SKILL.md` links, so the real validator
//      can be run over this suite's output without another skill's in-progress,
//      half-written SKILL.md deciding whether this suite is green.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

export const SKILL_MD = (skill) => join(REPO_ROOT, 'skills', skill, 'SKILL.md');

// --- reading a SKILL.md -----------------------------------------------------

export function skillSource (skill) {
  return readFileSync(SKILL_MD(skill), 'utf8').replace(/\r\n/g, '\n');
}

/** The body, frontmatter stripped. Every shape rule applies to the body only. */
export function skillBody (skill) {
  const src = skillSource(skill);
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

export function frontmatterBlock (skill) {
  const src = skillSource(skill);
  return src.slice(4, src.indexOf('\n---\n', 4));
}

export function headings (body) {
  return [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((h) => h[1].trim());
}

/** Pull the fenced ```js block whose first line carries `marker`. */
export function extractScript (skill, marker) {
  const blocks = [...skillSource(skill).matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.split('\n', 1)[0].includes(marker));
  if (!hit) {
    throw new Error(`skills/${skill}/SKILL.md no longer carries a \`\`\`js block marked "${marker}". `
      + 'These tests exercise the script the skill ships; if it moved, move the tests with it.');
  }
  return hit;
}

export const MEASURE_SCRIPT = () => extractScript('measure', '==== gtm-measure v1 ====');
export const LEARN_SCRIPT = () => extractScript('learn', '==== gtm-learn v1 ====');

/**
 * Run an extracted script exactly as its SKILL.md tells the user to:
 * `node --input-type=module -e <script>` from the pack root, configured by env.
 */
export function runSkillScript (script, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
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

export const runMeasure = (env) => runSkillScript(MEASURE_SCRIPT(), env);
export const runLearn = (env) => runSkillScript(LEARN_SCRIPT(), env);

// --- temp trees -------------------------------------------------------------

const tmpRoots = [];

export function tmpRoot (prefix = 'p6-') {
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
 * A project root with a gtm/ tree, a run journal, and a ledger.
 * `journal` and `ledger` are arrays of already-shaped lines.
 */
export function projectWith ({ runId, journal = [], ledger = [], prefix = 'p6-' } = {}) {
  const root = tmpRoot(prefix);
  mkdirSync(join(root, 'gtm', 'runs'), { recursive: true });
  if (journal.length) {
    writeFileSync(join(root, 'gtm', 'runs', `${runId}.jsonl`),
      journal.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  } else {
    writeFileSync(join(root, 'gtm', 'runs', `${runId}.jsonl`), '', 'utf8');
  }
  if (ledger.length) {
    writeFileSync(join(root, 'gtm', 'api-calls.jsonl'),
      ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }
  return {
    root,
    runId,
    path: (rel) => join(root, rel),
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => existsSync(join(root, rel)),
    write: (rel, body) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body, 'utf8');
      return join(root, rel);
    },
  };
}

/**
 * A copy of the real gates.yaml with a few leaves changed, written into `dir`.
 * These tests may not edit _lib/gates.yaml, so this is the only way to prove that a gate
 * is READ rather than hard-coded — and, for /learn, the only way to exercise both
 * sides of the fail-closed boundary deterministically, whatever the real file grows
 * later.
 */
export function gatesFileWith (dir, mutate) {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const file = join(dir, `gates-${Math.random().toString(36).slice(2, 8)}.yaml`);
  writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}

// --- the validator sandbox --------------------------------------------------

/** Every `../x/SKILL.md` link target reachable from `seeds`, seeds included. */
export function linkClosure (seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    let body;
    try { body = skillBody(name); } catch { continue; }
    for (const m of body.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) queue.push(m[1]);
  }
  return [...seen];
}

/**
 * A throwaway copy of the package holding only the named skills, so the REAL
 * validator can decide whether this suite is green on its own merits.
 */
export function validatorSandbox (seeds) {
  const dir = tmpRoot('p6-validate-');
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs',
    'dual-contract.mjs', 'dual-contract.schema.json']) {
    cpSync(join(REPO_ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  const names = linkClosure(seeds);
  for (const name of names) {
    cpSync(join(REPO_ROOT, 'skills', name), join(dir, 'skills', name), { recursive: true });
  }
  return { dir, names };
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

// --- journal / ledger line builders ----------------------------------------
//
// row_id is deliberately an EMAIL in these fixtures. The journal is the PII-bearing
// artifact; a share-safety test built on synthetic ids like "r1" would prove nothing.

export const CONTACTS = [
  'ada.lovelace@analytical-engines.example',
  'grace.hopper@compilers.example',
  'alan.turing@bletchley.example',
  'katherine.johnson@orbital.example',
  'margaret.hamilton@apollo.example',
];

let clockTick = 0;
const ts = (base = '2026-08-28T10:00:00.000Z') =>
  new Date(Date.parse(base) + (clockTick += 1000)).toISOString();

export function jline ({
  runId, rowId, hop = 0, endpoint = 'email_finder', status = 'ok',
  creditsEstimated = null, creditsActual = null, provider = null, confidence = null,
  error = null, attempt = 1, at = undefined,
}) {
  return {
    dry_run: false,
    list_key: null,
    schema_version: 1,
    run_id: runId,
    row_id: rowId,
    hop,
    endpoint,
    status,
    ts: at ?? ts(),
    credits_estimated: creditsEstimated,
    credits_actual: creditsActual,
    response_hash: null,
    provider,
    confidence,
    error,
    attempt,
  };
}

export function lline ({
  runId, endpoint = 'email_finder', estimated = 0, actual = null,
  costStatus = 'estimated_unverifiable', rowId = null, hop = 0, at = undefined,
  httpStatus = 200, resultCount = null,
}) {
  return {
    schema_version: 1,
    ts: at ?? ts(),
    run_id: runId,
    row_id: rowId,
    hop,
    endpoint,
    credits_estimated: estimated,
    estimate_basis: `flat ${estimated}`,
    credits_actual: actual,
    cost_status: costStatus,
    result_count: resultCount,
    balance_after: null,
    balance_source: 'unknown',
    http_status: httpStatus,
  };
}

/** Every substring in `text` that looks like a contact. Used to prove absence. */
export function contactLeaks (text) {
  const hits = [];
  for (const c of CONTACTS) if (text.includes(c)) hits.push(c);
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) hits.push(m[0]);
  return [...new Set(hits)];
}
