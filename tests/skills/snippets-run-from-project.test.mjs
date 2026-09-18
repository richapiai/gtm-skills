// The embedded scripts have to run where the user is.
//
// /comply, /campaign-review and /crm-est each ship a script the skill tells the user to
// run. All three imported `./_lib/…`, which is a path inside the PACK. A customer
// installs the pack into their own project and runs the script from there, so the
// import resolved against their project root and died:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<project>/_lib/csv.mjs'
//
// Three live runs ended there, before a single row was read. The scripts now resolve
// the pack themselves — RICHAPI_PACK_ROOT, else the installed `@richapi/gtm-skills`,
// else the current directory — and these tests run each one with the cwd set to a temp
// project that is NOT the pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PACK_ROOT, LAUNCH_SCRIPT, REVIEW_SCRIPT } from './launch/skill-runner.mjs';
import { COMPLY_SCRIPT, COMPLY_SKILL_MD, clearRow, csvOf } from './comply/comply-runner.mjs';
import { extractScript as crmScript } from './crm-export/helpers.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

/** A project directory that is not the pack, with gtm/ and a list in it. */
function project (t, { installed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q9-project-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  ensureSuppressionStore(root);
  fs.mkdirSync(path.join(root, 'gtm', 'lists'), { recursive: true });
  const list = path.join(root, 'gtm', 'lists', 'q3.csv');
  fs.writeFileSync(list, csvOf([clearRow(1), clearRow(2)]), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'customer-project', private: true, type: 'module' }, null, 2), 'utf8');
  if (installed) {
    // Exactly what `npm i @richapi/gtm-skills` leaves behind: the package reachable by
    // name from the project. A symlink, because that is also what `npm link` and a
    // workspace install produce, and the script must work through one.
    const scope = path.join(root, 'node_modules', '@richapi');
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(PACK_ROOT, path.join(scope, 'gtm-skills'), 'junction');
  }
  return { root, list };
}

/** Run a script the way a user in their own project would: cwd = the project. */
function runThere (script, root, env = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Prove the resolution, not the ambient environment.
      RICHAPI_PACK_ROOT: '',
      ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
    },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

const SCRIPTS = () => [
  ['comply', COMPLY_SCRIPT()],
  ['campaign-review', REVIEW_SCRIPT()],
  ['crm-export', crmScript()],
  ['launch', LAUNCH_SCRIPT()],
];

test('no shipped script imports a path that only exists inside the pack', () => {
  for (const [name, script] of SCRIPTS()) {
    assert.ok(!/from '\.\/_lib\//.test(script),
      `${name} still imports './_lib/…', which is ERR_MODULE_NOT_FOUND in a user's project`);
  }
});

test('every shipped script runs from a project with the pack installed', (t) => {
  const p = project(t);
  for (const [name, script] of SCRIPTS()) {
    const r = runThere(script, p.root, { LIST: p.list, ROOT: p.root, NOW });
    assert.ok(!/ERR_MODULE_NOT_FOUND/.test(r.out), `${name} could not find the pack:\n${r.out}`);
    // Each script has its own exit codes; what none of them may do is fail to load.
    // 2 is "could not run at all", which is what a resolution failure used to look like.
    assert.notEqual(r.status, 1, `${name} crashed:\n${r.out}`);
  }
});

test('/comply actually reaches its verdict from the project directory', (t) => {
  const p = project(t);
  const r = runThere(COMPLY_SCRIPT(), p.root, { LIST: p.list, ROOT: p.root, NOW });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^PASS /m);
  // And it read the gate TABLE out of the pack too, not out of the project — a rule
  // table it could not find would be a FAIL with comply_rules_unavailable.
  const verdict = JSON.parse(fs.readFileSync(
    path.join(p.root, 'gtm', 'reviews', 'q3.comply.json'), 'utf8'));
  assert.equal(verdict.status, 'PASS');
  assert.deepEqual(verdict.jurisdictions, ['gdpr']);
});

test('RICHAPI_PACK_ROOT is the one line that works with nothing installed', (t) => {
  const p = project(t, { installed: false });
  const without = runThere(COMPLY_SCRIPT(), p.root, { LIST: p.list, ROOT: p.root, NOW });
  assert.match(without.out, /ERR_MODULE_NOT_FOUND|Cannot find/,
    'with no pack anywhere, the failure must be about finding the pack');

  const withVar = runThere(COMPLY_SCRIPT(), p.root,
    { LIST: p.list, ROOT: p.root, NOW, RICHAPI_PACK_ROOT: PACK_ROOT });
  assert.equal(withVar.status, 0, withVar.out);
  assert.match(withVar.out, /^PASS /m);
});

test('each skill documents the one requirement, so the fix is findable', () => {
  for (const skill of ['comply', 'campaign-review', 'crm-export']) {
    const src = fs.readFileSync(path.join(PACK_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(src, /RICHAPI_PACK_ROOT/, `${skill} never mentions RICHAPI_PACK_ROOT`);
    assert.match(src, /@richapi\/gtm-skills/, `${skill} never says the installed package is the normal path`);
  }
});

// ---------------------------------------------------------------------------
// A snippet must be copyable IN ONE GO.
//
// The /comply gate script contained two literal triple-backtick sequences — inside the
// regexes that parse the `comply-rules` fence. A fenced block that contains its own
// fence character cannot be lifted out by any fence-aware reader: the only way to get
// the script was to count lines, which is exactly the instruction that rots the moment
// somebody edits a paragraph above it. The fence is now built from a char code, so the
// script contains no triple backtick at all.
//
// This rule is not about the extractor these tests happen to use. It is about a HUMAN
// copying the block out of the page, and about the next reader who writes one.
// ---------------------------------------------------------------------------

const FENCE = String.fromCharCode(96).repeat(3);

test('no shipped script contains the fence that would close the block it lives in', () => {
  for (const [name, script] of SCRIPTS()) {
    const at = script.split('\n').findIndex((l) => l.includes(FENCE));
    assert.equal(at, -1,
      `${name}'s snippet contains a triple backtick on line ${at + 1} — it cannot be copied in one `
      + 'go, and it can only be extracted by line number. Build the fence (String.fromCharCode(96)) '
      + 'instead of writing it.');
  }
});

test('each snippet is exactly one fenced block, found by its marker and not by position', () => {
  const WANT = [
    ['comply', COMPLY_SKILL_MD, '==== gtm-comply v1 ===='],
    ['campaign-review', path.join(PACK_ROOT, 'skills', 'campaign-review', 'SKILL.md'),
      '==== gtm-campaign-review v1 ===='],
  ];
  for (const [name, file, marker] of WANT) {
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const blocks = [...src.matchAll(new RegExp(FENCE + 'js\\n([\\s\\S]*?)\\n' + FENCE, 'g'))].map((m) => m[1]);
    const hit = blocks.filter((b) => b.includes(marker));
    assert.equal(hit.length, 1, `${name}: expected exactly one ${FENCE}js block carrying "${marker}"`);
    // Whole, not truncated: the marker opens it and the matching end marker closes it.
    assert.ok(hit[0].startsWith('// ' + marker), `${name}: the block does not open with its marker`);
    assert.match(hit[0], /\n\/\/ ==== end gtm-[a-z-]+ v1 ====$/,
      `${name}: the extracted block does not reach its own end marker — a fence cut it short`);
  }
});
