// tests/contracts/skill-shape.test.mjs
//
// The SKILL.md shape contract (docs/skill-shape.md), asserted the only way that
// means anything: by running the real validator over synthetic skills that break
// exactly one rule each.
//
// A test that only checked the two shipped skills would pass forever the moment
// someone deleted a rule. These fixtures fail if a rule stops being enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForBareNumbers, loadGates, gateValue, hasGate } from '../../_lib/gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- harness ---------------------------------------------------------------
// The validator walks `skills/` relative to the package root, so a fixture skill
// has to live in a throwaway copy of the package rather than in a temp dir of its
// own. We copy only what the validator reads.

const tracked = [];
function sandbox () {
  const dir = mkdtempSync(join(tmpdir(), 'skill-shape-'));
  tracked.push(dir);
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs', 'dual-contract.mjs',
                   'dual-contract.schema.json']) {
    cpSync(join(ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  // Every fixture links to the router, and rule "broken link" resolves relative
  // paths for real — so the sandbox needs a router to point at. It is itself a
  // conforming skill, which keeps the link target honest.
  writeSkill(dir, 'richapi-gtm', goodSkill('richapi-gtm').replace(
    /## Related[\s\S]*$/, '## Related\n\n- the pack\n'));
  return dir;
}

process.on('exit', () => {
  for (const d of tracked) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function writeSkill (dir, name, body) {
  const d = join(dir, 'skills', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), body);
}

/** Runs the real validator. Returns { code, out }. */
function validate (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A skill that satisfies every rule. Each test breaks exactly one thing. */
function goodSkill (name, extra = '') {
  return `---
name: ${name}
version: 1.0.0
description: A fixture skill used to prove the shape contract is enforced.
allowed-tools: Bash, Read
triggers:
  - fixture
---

# ${name}

## Before anything else

Run \`richapi-skills-preflight\` and read the keys.

## What it does

Nothing. It is a fixture.
${extra}
## What this skill will not do

It will not send anything.

## Related

- [\`/richapi-gtm\`](../richapi-gtm/SKILL.md) — the router
`;
}

// --- rule 0: the good fixture actually passes ------------------------------
// Without this, every test below could be passing for the wrong reason.

test('the reference fixture passes every rule', () => {
  const dir = sandbox();
  writeSkill(dir, 'fixture-ok', goodSkill('fixture-ok'));
  const { code, out } = validate(dir);
  assert.equal(code, 0, `expected a clean pass, got:\n${out}`);
});

// --- rule 1: ## Related ----------------------------------------------------

test('rule 1 — a skill with no Related section fails', () => {
  const dir = sandbox();
  const body = goodSkill('fixture-noref').replace(/## Related[\s\S]*$/, '');
  writeSkill(dir, 'fixture-noref', body);
  const { code, out } = validate(dir);
  assert.equal(code, 1);
  assert.match(out, /missing a `## Related` section/);
});

// --- rule 2: the boundary section ------------------------------------------

test('rule 2 — a skill that never states its boundary fails', () => {
  const dir = sandbox();
  const body = goodSkill('fixture-nobound')
    .replace('## What this skill will not do\n\nIt will not send anything.\n', '');
  writeSkill(dir, 'fixture-nobound', body);
  const { code, out } = validate(dir);
  assert.equal(code, 1);
  assert.match(out, /missing a boundary section/);
});

test('rule 2 — any of the accepted boundary headings satisfies it', () => {
  for (const heading of ['## Limitations', '## Not in scope', '## Boundaries',
                         "## What it won't do"]) {
    const dir = sandbox();
    const body = goodSkill('fixture-bound')
      .replace('## What this skill will not do', heading);
    writeSkill(dir, 'fixture-bound', body);
    const { code, out } = validate(dir);
    assert.equal(code, 0, `heading "${heading}" should satisfy rule 2, got:\n${out}`);
  }
});

// --- rule 3: law 3, a metered call needs a visible plan --------------------

test('rule 3 — invoking a metered endpoint with no plan fails', () => {
  const dir = sandbox();
  // `email_finder(` is an unambiguous invocation of a metered endpoint, and the
  // body mentions neither a dry-run nor gates.yaml.
  writeSkill(dir, 'fixture-spend', goodSkill('fixture-spend',
    '\nCall `email_finder(` for each contact.\n'));
  const { code, out } = validate(dir);
  assert.equal(code, 1);
  assert.match(out, /law 3 requires/);
});

test('rule 3 — a dry-run reference satisfies it, and so does a gates citation', () => {
  for (const evidence of ['Always dry-run first.',
                          'Stops at `gates.yaml:quality_stops.coverage_min_pct`.']) {
    const dir = sandbox();
    writeSkill(dir, 'fixture-spend-ok', goodSkill('fixture-spend-ok',
      `\n${evidence}\n\nCall \`email_finder(\` for each contact.\n`));
    const { code, out } = validate(dir);
    assert.equal(code, 0, `"${evidence}" should satisfy rule 3, got:\n${out}`);
  }
});

// --- rule 4: a cited gate key must resolve ---------------------------------
//
// This is the rule that turns a gates.yaml merge hunk lost between parallel
// workstreams into a red CI run. Without it the symptom in production is a skill that
// reads STOP on every guarded call, with green tests in the workstream that wrote it.

test('rule 4 — citing a gate key that does not exist fails', () => {
  const dir = sandbox();
  writeSkill(dir, 'fixture-badkey', goodSkill('fixture-badkey',
    '\nStops at `gates.yaml:skills.fixture_badkey.no_such_key`.\n'));
  const { code, out } = validate(dir);
  assert.equal(code, 1);
  assert.match(out, /does not resolve/);
});

test('rule 4 — citing a real gate key passes', () => {
  const dir = sandbox();
  writeSkill(dir, 'fixture-goodkey', goodSkill('fixture-goodkey',
    '\nStops at `gates.yaml:quality_stops.coverage_min_pct`.\n'));
  const { code, out } = validate(dir);
  assert.equal(code, 0, out);
});

// --- the shipped skills conform --------------------------------------------

test('every shipped skill satisfies the contract', () => {
  const { code, out } = validate(ROOT);
  assert.equal(code, 0, `shipped skills must satisfy their own contract:\n${out}`);
});

// --- the skills: namespace ---------------------------------------------------

test('the skills: gate namespace resolves for every list-to-launch skill', () => {
  const gates = loadGates();
  for (const skill of ['build_prospect_list', 'list_hygiene', 'comply',
                       'campaign_review', 'launch']) {
    assert.ok(hasGate(gates, `skills.${skill}`),
      `gates.yaml is missing the skills.${skill} block — a lost merge hunk reads as STOP`);
  }
  // Spot-check a leaf, so a block that exists but was emptied still fails.
  assert.equal(gateValue(gates, 'skills.launch.require_pass_verdict'), true);
  assert.deepEqual(gateValue(gates, 'skills.comply.jurisdictions'), ['gdpr', 'ccpa', 'casl', 'can_spam']);
});

// --- the statute escape ------------------------------------------------------
//
// /comply cannot ship without this: measured against real compliance prose, the
// `audience minimum` pattern claimed "at least 3 years" (CASL) and "no fewer than
// 10 business days" (CCPA), and the validator promotes those to errors.

test('statutory periods are not bare numbers', () => {
  const legal = [
    'CASL requires consent records be retained for at least 3 years after the last message.',
    'CCPA: honour a deletion request in no fewer than 10 business days of verification.',
    'GDPR Article 12 gives a controller 30 days to respond.',
    'Under § 7 the statutory floor is 3 years.',
  ];
  for (const line of legal) {
    assert.deepEqual(scanForBareNumbers(line), [],
      `a line citing the law is not a policy knob: ${line}`);
  }
});

test('the statute escape does not disarm law 1', () => {
  // The escape is narrow on purpose. These must still fail, or the whole cost
  // model rots the way the 16 repriced hand-typed numbers did.
  const policy = [
    'The waterfall costs about 8 credits per contact.',
    'Firmographic data is swept on a 90 days cache TTL.',
    'Bounce rate above 5% stops the run.',
    'Upload at least 300 contacts to LinkedIn.',
  ];
  for (const line of policy) {
    assert.ok(scanForBareNumbers(line).length > 0,
      `a hand-typed policy number must still fail: ${line}`);
  }
});

test('a statute named on another line does not exempt the number', () => {
  // "GDPR" in a heading three lines up must not launder a credit cost below it.
  const doc = '## GDPR\n\nThe waterfall costs about 8 credits per contact.\n';
  assert.ok(scanForBareNumbers(doc).length > 0,
    'the escape must be same-line, or any compliance doc becomes a law-1 blind spot');
});
