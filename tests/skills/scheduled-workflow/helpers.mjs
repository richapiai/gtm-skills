// tests/skills/scheduled-workflow/helpers.mjs — test helpers for /scheduled-workflow and /cost-optimizer.
//
// This suite owns tests/skills/scheduled-workflow/** and tests/skills/cost-optimizer/**
// and nothing above them, so the shared machinery for BOTH suites lives here and the
// /cost-optimizer suite imports it from here. Same arrangement the /measure suite used.
//
// Two things it provides:
//
//   1. `runSkillScript` — runs the fenced ```js block that ships INSIDE a SKILL.md,
//      extracted verbatim, exactly as the skill tells the user to run it. The stopping
//      properties are only real if the thing the user runs is the thing that stops; a
//      test-only copy of the logic would stay green while the shipped skill rotted.
//
//   2. `validatorSandbox` — a throwaway package holding only this suite's skills and the
//      transitive closure of their `../x/SKILL.md` links, so the real validator can be
//      run over this suite's output without another skill's in-progress, half-written (or
//      entirely absent) SKILL.md deciding whether this suite is green.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync,
  openSync, closeSync,
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

export const SCHEDULE_SCRIPT = () => extractScript('scheduled-workflow', '==== gtm-schedule v1 ====');
export const COST_SCRIPT = () => extractScript('cost-optimizer', '==== gtm-cost-optimizer v1 ====');

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

export const runSchedule = (env) => runSkillScript(SCHEDULE_SCRIPT(), env);
export const runCost = (env) => runSkillScript(COST_SCRIPT(), env);

// --- temp trees -------------------------------------------------------------

const tmpRoots = [];

export function tmpRoot (prefix = 'q3-') {
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

/** A project root with a gtm/ tree. `journal` is keyed by run id. */
export function projectWith ({ ledger = [], journals = {}, prefix = 'q3-' } = {}) {
  const root = tmpRoot(prefix);
  mkdirSync(join(root, 'gtm', 'runs'), { recursive: true });
  if (ledger.length) {
    writeFileSync(join(root, 'gtm', 'api-calls.jsonl'),
      ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }
  for (const [runId, lines] of Object.entries(journals)) {
    writeFileSync(join(root, 'gtm', 'runs', `${runId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }
  return {
    root,
    path: (rel) => join(root, rel),
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    exists: (rel) => existsSync(join(root, rel)),
    readJsonl: (rel) => readFileSync(join(root, rel), 'utf8').split('\n').filter(Boolean).map(JSON.parse),
    write: (rel, body) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
      return join(root, rel);
    },
  };
}

// --- gate and catalog seams -------------------------------------------------
//
// These tests may not edit _lib/gates.yaml. The four skills.scheduled_workflow.* keys and two
// skills.cost_optimizer.* keys these skills read are MERGED into it now, so the shipped
// file is the working state and both scripts run against it. What this suite needs from
// here is therefore the mirror image of what it needed before the merge:
//
//   1. REQUESTED_* stops being a request and becomes a PIN, written into a copy of the
//      real file. Pinning is still the only way to prove a threshold is READ rather than
//      hard-coded — the tests move a value and watch the behaviour move with it.
//   2. `gatesFileWithout()` strips a block back out. Now that the keys exist that is the
//      only honest way to keep testing the fail-closed half: a test that relied on the
//      real file lacking the key stopped testing anything the moment it landed, whereas
//      a stripped block keeps proving law 5 for every future key too.

export const REQUESTED_SCHEDULE_GATES = {
  approval_max_age_days: 30,
  max_runs_per_approval: 26,
  min_interval_hours: 6,
  max_envelope_credits: 20000,
};
export const REQUESTED_COST_GATES = {
  min_evidence_calls: 2,
  min_saving_credits: 1,
};

export function gatesFileWith (dir, mutate = () => {}) {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const file = join(dir, `gates-${Math.random().toString(36).slice(2, 8)}.yaml`);
  writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}

/** The real gates.yaml with this suite's values pinned onto it. */
export function gatesWithRequestedKeys (dir, mutate = () => {}) {
  return gatesFileWith(dir, (doc) => {
    doc.skills ??= {};
    doc.skills.scheduled_workflow = { ...REQUESTED_SCHEDULE_GATES };
    doc.skills.cost_optimizer = { ...REQUESTED_COST_GATES };
    mutate(doc);
  });
}

/**
 * A copy of the real gates.yaml with the named `skills.<name>` blocks DELETED — the
 * fail-closed input, made rather than found.
 *
 * Throws on a no-op strip. A fail-closed test pointed at a gates file that still holds
 * the block passes while proving nothing, so the strip has to be load-bearing. Mirrors
 * `tests/skills/evidence-score/helpers.mjs:gatesWithout`, on a file rather than an
 * object, because these scripts take a gates PATH.
 */
export function gatesFileWithout (dir, ...blocks) {
  return gatesFileWith(dir, (doc) => {
    for (const name of blocks) {
      if (!doc.skills || !(name in doc.skills)) {
        throw new Error(`gatesFileWithout: skills.${name} is not present to strip — has the block moved?`);
      }
      delete doc.skills[name];
    }
  });
}

export function catalogFileWith (dir, mutate = () => {}) {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
  mutate(doc);
  const file = join(dir, `catalog-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

// --- plan artifacts ---------------------------------------------------------
//
// A plan is produced by the REAL CLI: `richapi <verb> ... --dry-run --json`. Building
// one by hand would let these tests pass against a plan shape the runtime never emits,
// which is the failure the shape contract exists to prevent.

// The child's stdout goes to a FILE, not to a pipe, and is read back afterwards.
//
// This is not a style preference. `spawnSync` truncates a piped stdout at 8192 bytes
// — one pipe buffer — on every Node tested up to and including v24.0.0 (18.20.8,
// 20.0.0, 20.19.0, 22.0.0, 24.0.0 all truncate; 24.5.0 does not). A plan for ten rows
// clears 11KB, so on any of those runtimes this helper used to hand JSON.parse a
// string chopped mid-token and every test in this suite died with
// "Unterminated string in JSON at position 8192".
//
// The CLI itself is blameless and was verified so: `richapi ... --json | wc -c`
// returns the full 11576 bytes on 18.20.8, 20.0.0 and 24.5.0 alike. The defect is in
// the PARENT's read — proven by crossing the versions, where the parent's version
// alone decides whether the output arrives whole. Redirecting to a file bypasses the
// pipe, so this suite no longer depends on which Node is running the tests.
export function dryRunPlan (projectRoot, argv) {
  mkdirSync(join(projectRoot, 'gtm'), { recursive: true });
  const supp = join(projectRoot, 'gtm', 'suppression.jsonl');
  if (!existsSync(supp)) writeFileSync(supp, '', 'utf8');

  const outFile = join(mkdtempSync(join(tmpdir(), 'dryrun-')), 'plan.json');
  const fd = openSync(outFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [join(REPO_ROOT, 'bin', 'richapi.mjs'), ...argv, '--dry-run', '--json'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', fd, 'pipe'],
    });
  } finally {
    closeSync(fd);
  }
  const stdout = readFileSync(outFile, 'utf8');
  if (res.status !== 0) {
    throw new Error(`dry run failed (${res.status}):\n${stdout}\n${res.stderr}`);
  }
  return JSON.parse(stdout);
}

/** Write a dry-run plan artifact into the project and return its path. */
export function planFile (proj, argv, name = 'plan.json') {
  const doc = dryRunPlan(proj.root, argv);
  proj.write(name, doc);
  return { path: join(proj.root, name), doc };
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
 * A throwaway copy of the package holding only the named skills, so the REAL validator
 * can decide whether this suite is green on its own merits.
 */
export function validatorSandbox (seeds) {
  const dir = tmpRoot('q3-validate-');
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

// --- ledger / journal line builders -----------------------------------------
//
// row_id is deliberately an EMAIL. The ledger and journal are the PII-bearing
// artifacts; fixtures built on synthetic ids like "r1" would prove nothing about
// whether a report leaks one.

export const CONTACTS = [
  'ada.lovelace@analytical-engines.example',
  'grace.hopper@compilers.example',
  'alan.turing@bletchley.example',
];

let tick = 0;
const stamp = (base = '2026-08-01T10:00:00.000Z') =>
  new Date(Date.parse(base) + (tick += 1000)).toISOString();

export function lline ({
  runId = 'run-1', endpoint = 'enrich_company', estimated = 0, actual = null,
  costStatus = 'estimated_unverifiable', rowId = null, hop = 0, at = undefined,
  httpStatus = 200, resultCount = null,
}) {
  return {
    schema_version: 1,
    ts: at ?? stamp(),
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

export function jline ({
  runId = 'run-1', rowId, hop = 0, endpoint = 'enrich_company', status = 'ok',
  creditsEstimated = null, creditsActual = null, attempt = 1, at = undefined,
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
    ts: at ?? stamp(),
    credits_estimated: creditsEstimated,
    credits_actual: creditsActual,
    response_hash: null,
    provider: null,
    confidence: null,
    error: null,
    attempt,
  };
}

/** Every substring in `text` that looks like a contact. Used to prove absence. */
export function contactLeaks (text) {
  const hits = [];
  for (const c of CONTACTS) if (text.includes(c)) hits.push(c);
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) hits.push(m[0]);
  return [...new Set(hits)];
}
