// tests/skills/gtm-retro/helpers.mjs — test helpers for /gtm-retro.
//
// The script under test is the fenced ```js block that ships INSIDE the SKILL.md,
// extracted verbatim and run exactly the way the skill tells the user to run it:
// `node --input-type=module -e <script>` from the pack root. A test-only copy of the
// logic would stay green while the shipped skill rotted, and the honesty properties
// this suite claims are only real if the thing the user runs is the thing that refuses.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL = 'gtm-retro';
export const SKILL_MD = join(REPO_ROOT, 'skills', SKILL, 'SKILL.md');

export function skillSource () {
  return readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
}

export function skillBody () {
  const src = skillSource();
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

export function skillProse () {
  return skillBody().replace(/^```[\s\S]*?^```$/gm, '');
}

export function headings (body = skillBody()) {
  return [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((h) => h[1].trim());
}

export const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
export const owners = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));

/** Endpoint invocations, using the SAME pattern the validator uses. */
export function invokedEndpoints (body = skillBody()) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map((m) => m[1]));
}

export function citedGateKeys (body = skillBody()) {
  return new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map((m) => m[1]));
}

/** Pull the fenced ```js block whose first line carries `marker`. */
export function extractScript (marker = '==== gtm-retro v1 ====') {
  const blocks = [...skillSource().matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.split('\n', 1)[0].includes(marker));
  if (!hit) {
    throw new Error(`skills/${SKILL}/SKILL.md no longer carries a \`\`\`js block marked "${marker}". `
      + 'These tests exercise the script the skill ships; if it moved, move the tests with it.');
  }
  return hit;
}

export const RETRO_SCRIPT = () => extractScript();

/** Run the extracted script the way the SKILL.md says to run it. */
export function runRetro (env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', RETRO_SCRIPT()], {
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

// --- temp trees --------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'retro-') {
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

// --- fixtures ----------------------------------------------------------------
//
// row_id is deliberately an EMAIL in these fixtures. The journal is the PII-bearing
// artifact, and a share-safety test built on synthetic ids like "r1" would prove
// nothing about a real one.

export const CONTACTS = [
  'ada.lovelace@analytical-engines.example',
  'grace.hopper@compilers.example',
  'alan.turing@bletchley.example',
  'katherine.johnson@orbital.example',
  'margaret.hamilton@apollo.example',
  'dorothy.vaughan@fortran.example',
];

/**
 * `_lib/journal.mjs` hashes `list_key` on the way in AND on the way out, so the arm
 * label the retro emits is derived from the hash and not from whatever the fixture
 * wrote. The label then maps each hex digit onto a letter — see the SKILL.md comment;
 * a raw hex label can contain a ten-digit run and the pack's share guard rejects those.
 */
export function armLabelFor (listKey) {
  const hashed = createHash('sha256').update(String(listKey)).digest('hex').slice(0, 32);
  const hex = hashed.slice(0, 12).toLowerCase();
  return 'list_' + hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

let tick = 0;
const ts = (base = '2026-08-20T10:00:00.000Z') =>
  new Date(Date.parse(base) + (tick += 1000)).toISOString();

export function jline ({
  runId, rowId, hop = 0, endpoint = 'email_finder', status = 'ok', listKey = null,
  creditsEstimated = null, creditsActual = null, provider = 'providerx', confidence = null,
  error = null, attempt = 1, at = undefined,
}) {
  return {
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
    dry_run: false,
    list_key: listKey,
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
    estimate_basis: 'flat ' + estimated,
    credits_actual: actual,
    cost_status: costStatus,
    result_count: resultCount,
    balance_after: null,
    balance_source: 'unknown',
    http_status: httpStatus,
  };
}

/**
 * A project root with a gtm/ tree holding several run journals and one ledger.
 * `runs` is { runId: [journalLine, ...] }; `ledger` is a flat array of ledger lines.
 */
export function projectWith ({ runs = {}, ledger = [], prefix = 'retro-' } = {}) {
  const root = tmpRoot(prefix);
  mkdirSync(join(root, 'gtm', 'runs'), { recursive: true });
  for (const [runId, lines] of Object.entries(runs)) {
    writeFileSync(join(root, 'gtm', 'runs', runId + '.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), 'utf8');
  }
  if (ledger.length) {
    writeFileSync(join(root, 'gtm', 'api-calls.jsonl'),
      ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }
  return {
    root,
    path: (rel) => join(root, rel),
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => existsSync(join(root, rel)),
    write: (rel, body) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
      return join(root, rel);
    },
  };
}

/**
 * A copy of the real gates.yaml with a few leaves changed. These tests may not edit
 * _lib/gates.yaml, so this is the only way to exercise BOTH sides of the fail-closed
 * boundary deterministically, whatever the real file grows later.
 */
export function gatesFileWith (dir, mutate) {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const file = join(dir, `gates-${Math.random().toString(36).slice(2, 8)}.yaml`);
  writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}

/** The four skills.gtm_retro keys, as the orchestrator would apply them. */
export function withRetroKeys (dir, overrides = {}) {
  return gatesFileWith(dir, (doc) => {
    doc.skills = doc.skills ?? {};
    doc.skills.gtm_retro = {
      retro_max_window_days: 90,
      min_runs_to_compare: 1,
      min_rows_per_arm_to_decide: 1,
      max_decisions: 5,
      ...overrides,
    };
  });
}

// --- validator sandbox --------------------------------------------------------

export function linkClosure (start = SKILL) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    let src;
    try { src = readFileSync(join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) queue.push(m[1]);
  }
  return [...seen];
}

export function validatorSandbox (skillNames) {
  const dir = tmpRoot('retro-validate-');
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

export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** Every credit figure a rendered report claims, so a claim can be held against a cap. */
export function claimedCredits (text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:spent|at least|up to)\s+([\d.,]+)/gi)) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
