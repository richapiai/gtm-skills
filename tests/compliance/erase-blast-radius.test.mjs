// tests/compliance/erase-blast-radius.test.mjs — REGRESSION.
//
// THE BUG THIS FILE EXISTS TO CATCH (high severity, found in a security audit).
//
// `gates.yaml:skills.comply.erase_confirm_fraction` was declared, and the only
// implementation of it lived in `tests/skills/comply/harness.mjs` — a file
// `package.json:files[]` does not publish. Shipped `erase()` and its CLI loaded no
// gates, computed no fraction and asked nothing. The sole defence was a paragraph in
// skills/comply/SKILL.md telling the agent to divide two numbers, one of which the
// dry run did not return.
//
// And there was no floor on the target: `makeTargetMatcher('com')` produced a valid
// domain matcher, so
//
//     node _lib/pii.mjs erase com --root .
//
// walked the whole gtm/ tree, deleted every row mentioning any .com address, redacted
// every note and rmSync'd every .json whose top-level scalars matched — then appended
// a tombstone recording success. The skill says it plainly: "It is irreversible.
// There is no undo, no trash, and no second copy."
//
// Every test below is written to go red if any of that comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { tmpRoot, cleanupTmp, write, jsonl, snapshot, REPO_ROOT } from './helpers.mjs';
import {
  erase, eraseDecision, countErasableRows, erasableUnits, makeTargetMatcher,
  ensureGtmTree, readTombstones, MIN_TARGET_LABELS, EraseTargetTooBroadError,
  ERASE_DENOMINATOR_EXCLUDED, ERASE_CONFIRM_GATE, ERASE_FRACTION_GATE,
  ALLOW, CONFIRM, STOP,
} from '../../_lib/pii.mjs';
import { loadGates, gateValue } from '../../_lib/gates.mjs';

test.after(cleanupTmp);

const PII_CLI = join(REPO_ROOT, '_lib', 'pii.mjs');
const NOW = new Date('2026-08-29T12:00:00.000Z');
const GATES = loadGates();

/** 20 erasable rows: 18 nobody is erasing, 2 at `wide.example`. */
function tree20() {
  const root = tmpRoot('compliance-blast-');
  ensureGtmTree(root);
  const stamp = { source_endpoint: 'enrich_company', fetched_at: '2026-08-20T00:00:00Z' };
  const rows = [];
  for (let i = 0; i < 18; i++) rows.push({ ...stamp, email: `keep${i}@safe.example` });
  rows.push({ ...stamp, email: 'a@wide.example' });
  rows.push({ ...stamp, email: 'b@wide.example' });
  write(root, 'gtm/lists/main.jsonl', jsonl(rows));
  return root;
}

/** Every gtm/ artifact type, with `.com` addresses scattered through it. */
function treeOfDotCom() {
  const root = tmpRoot('compliance-tld-');
  ensureGtmTree(root);
  write(root, 'gtm/lists/q3.csv', 'email,company\nbob@acme.com,Acme\ncarol@zenith.io,Zenith\n');
  write(root, 'gtm/lists/q3.jsonl', jsonl([{ email: 'bob@acme.com' }, { email: 'carol@zenith.io' }]));
  write(root, 'gtm/research/acme.md', '# Acme\n\nChampion is bob@acme.com.\n');
  write(root, 'gtm/deals/deal-1.json', { deal_id: 1, contact: 'bob@acme.com' });
  write(root, 'gtm/org-maps/acme.json', [{ email: 'bob@acme.com' }, { email: 'dave@other.com' }]);
  return root;
}

// ---------------------------------------------------------------------------
// 1. The floor: a bare TLD is not an erasure target.
// ---------------------------------------------------------------------------

test('a bare TLD is REFUSED by the matcher — it never gets as far as a confirmation', () => {
  assert.equal(MIN_TARGET_LABELS, 2, 'the floor is two labels; one label is a public suffix');
  for (const bare of ['com', 'io', 'COM', ' com ', '@com', 'https://io/', 'www.com', 'com.', 'ai']) {
    assert.throws(
      () => makeTargetMatcher(bare),
      EraseTargetTooBroadError,
      `makeTargetMatcher(${JSON.stringify(bare)}) built a matcher for a bare TLD`,
    );
  }
});

test('two labels is the floor, and legitimate targets still build', () => {
  for (const ok of ['acme.com', 'mail.acme.com', 'wide.example', 'bob@acme.com', 'a@b.io']) {
    assert.ok(makeTargetMatcher(ok).normalized, `${ok} should still be an erasable target`);
  }
});

test('`erase com` destroys nothing — the refusal is in the engine, not in the prose', () => {
  const root = treeOfDotCom();
  const before = snapshot(join(root, 'gtm'));

  assert.throws(() => erase('com', { root, now: NOW }), EraseTargetTooBroadError);
  assert.throws(() => erase('io', { root, now: NOW }), EraseTargetTooBroadError);

  assert.deepEqual(snapshot(join(root, 'gtm')), before, 'a bare-TLD erase touched data');
  assert.equal(readTombstones({ root }).length, 0,
    'a refused erase must not record itself as an erasure that happened');
});

test('no amount of confirming turns a bare TLD into a data subject', () => {
  const root = treeOfDotCom();
  const d = eraseDecision({
    root, target: 'com', confirmed: true, sweepConfirmed: true, gates: GATES, now: NOW,
  });
  assert.equal(d.verdict, STOP, 'confirming twice walked a bare TLD through the gate');
  assert.equal(d.failed_closed, true);
  assert.match(d.reason, /bare TLD/);
});

test('the CLI refuses a bare TLD with a non-zero exit and writes nothing', () => {
  const root = treeOfDotCom();
  const before = snapshot(join(root, 'gtm'));
  const r = runCli(['erase', 'com', '--root', root]);
  assert.notEqual(r.code, 0, 'the CLI exited 0 on a bare-TLD erase');
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /bare TLD/);
  assert.deepEqual(snapshot(join(root, 'gtm')), before);
});

// ---------------------------------------------------------------------------
// 2. The denominator: defined in code, returned by the dry run.
// ---------------------------------------------------------------------------

test('the dry run RETURNS the denominator, so the fraction is computable without guessing', () => {
  const root = tree20();
  const preview = erase('wide.example', { root, now: NOW, dryRun: true });

  // Before this fix `--dry-run --json` returned rows_removed / files_deleted /
  // files_scanned, and the skill told the agent to divide by "the number of erasable
  // rows stored under gtm/" — a number nothing computed. Two agents, two answers.
  assert.equal(preview.erasable_rows_total, 20, 'the denominator is not reported');
  assert.equal(preview.impacted_rows, 2, 'the numerator is not reported');
  assert.equal(preview.impact_fraction, 0.1);
  assert.equal(preview.erasable_rows_total, countErasableRows(root),
    'the report and the counter must not be two different denominators');
});

test('numerator and denominator are the SAME unit — rows, files and redactions all count', () => {
  const root = tmpRoot('compliance-units-');
  ensureGtmTree(root);
  write(root, 'gtm/lists/a.jsonl', jsonl([{ e: 'x@wide.example' }, { e: 'k@safe.example' }]));
  write(root, 'gtm/research/note.md', 'ping x@wide.example about the renewal\n');
  write(root, 'gtm/deals/d.json', { contact: 'x@wide.example' });   // deleted whole
  write(root, 'gtm/copy/seq.json', { steps: [{ body: 'hi x@wide.example' }] }); // redacted

  assert.equal(erasableUnits(join(root, 'gtm', 'lists', 'a.jsonl')), 2);
  assert.equal(erasableUnits(join(root, 'gtm', 'research', 'note.md')), 1);
  assert.equal(erasableUnits(join(root, 'gtm', 'deals', 'd.json')), 1);
  const total = countErasableRows(root);
  assert.equal(total, 5);

  const preview = erase('wide.example', { root, now: NOW, dryRun: true });
  assert.equal(preview.rows_removed, 2);          // one jsonl line + one pruned step
  assert.equal(preview.files_deleted, 1);         // deals/d.json is ABOUT them
  assert.equal(preview.artifacts_redacted, 1);    // the research note, rewritten in place
  assert.equal(preview.impacted_rows, 4);
  assert.equal(preview.impact_fraction, 4 / 5);
});

test('the denominator excludes exactly what an erase cannot destroy', () => {
  // Counting them would inflate the denominator, shrink the fraction and make the
  // gate fire LESS often. Fail closed means the SMALLER denominator.
  assert.ok(ERASE_DENOMINATOR_EXCLUDED.has('tombstones.jsonl'));
  assert.ok(ERASE_DENOMINATOR_EXCLUDED.has('suppression.jsonl'));
  assert.ok(ERASE_DENOMINATOR_EXCLUDED.has('consent.jsonl'));

  const root = tree20();
  assert.equal(countErasableRows(root), 20);
  for (const f of ['tombstones.jsonl', 'suppression.jsonl', 'consent.jsonl']) {
    writeFileSync(join(root, 'gtm', f), jsonl([{ a: 1 }, { b: 2 }, { c: 3 }]), 'utf8');
  }
  assert.equal(countErasableRows(root), 20, 'an undestroyable file inflated the denominator');
});

test('a live run reports the same fraction its own dry run did', () => {
  const root = tree20();
  const dry = erase('wide.example', { root, now: NOW, dryRun: true });
  const live = erase('wide.example', { root, now: NOW });
  assert.equal(live.erasable_rows_total, dry.erasable_rows_total,
    'the denominator was measured AFTER the sweep, so it shrank as the sweep ran');
  assert.equal(live.impact_fraction, dry.impact_fraction);
  // …and the audit trail records how wide the sweep was, not merely that it happened.
  const stone = readTombstones({ root }).at(-1);
  assert.equal(stone.impacted_rows, 2);
  assert.equal(stone.erasable_rows_total, 20);
  assert.equal(stone.impact_fraction, 0.1);
});

// ---------------------------------------------------------------------------
// 3. The fraction gate, in shipped code.
// ---------------------------------------------------------------------------

test('the gate is in _lib/, not in tests/ — the shipped package carries it', () => {
  // The original bug in one assertion: the ONLY implementation lived under tests/,
  // which package.json:files[] does not publish.
  const shipped = readFileSync(join(REPO_ROOT, '_lib', 'pii.mjs'), 'utf8');
  assert.match(shipped, /export function eraseDecision/);
  assert.match(shipped, /export function countErasableRows/);
  assert.match(shipped, new RegExp(ERASE_FRACTION_GATE.replace(/\./g, '\\.')));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('_lib/'), '_lib/ is not published, so neither is the gate');
  assert.ok(!pkg.files.some(f => f.startsWith('tests')), 'tests/ is not published');
});

test('an over-threshold sweep requires a SECOND explicit confirmation', () => {
  const root = tmpRoot('compliance-wide-');
  ensureGtmTree(root);
  const stamp = { source_endpoint: 'enrich_company', fetched_at: '2026-08-20T00:00:00Z' };
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ ...stamp, email: `keep${i}@safe.example` });
  for (let i = 0; i < 6; i++) rows.push({ ...stamp, email: `w${i}@wide.example` });
  write(root, 'gtm/lists/main.jsonl', jsonl(rows));

  const threshold = gateValue(GATES, ERASE_FRACTION_GATE);
  const d = eraseDecision({ root, target: 'wide.example', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, CONFIRM, 'a 30% sweep proceeded without asking');
  assert.equal(d.gate, ERASE_FRACTION_GATE);
  assert.equal(d.impacted, 6);
  assert.equal(d.total, 20);
  assert.ok(d.fraction > threshold);

  // Measuring is a dry run: no rows gone, no tombstone.
  assert.equal(readFileSync(join(root, 'gtm', 'lists', 'main.jsonl'), 'utf8').trim().split('\n').length, 20);
  assert.equal(readTombstones({ root }).length, 0);

  // The second confirmation, and nothing else, unlocks it.
  const ok = eraseDecision({
    root, target: 'wide.example', confirmed: true, sweepConfirmed: true, gates: GATES, now: NOW,
  });
  assert.equal(ok.verdict, ALLOW);
});

test('a narrow sweep is not gated — the gate is about blast radius, not about erasing', () => {
  const root = tree20();
  const d = eraseDecision({ root, target: 'wide.example', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, ALLOW, JSON.stringify(d));
  assert.ok(d.fraction <= d.threshold);
});

test('a missing gate key is STOP, not a bypass (law 5)', () => {
  const root = tree20();
  const dir = tmpRoot('compliance-nogates-');
  const p = join(dir, 'gates.yaml');

  // The whole skills.comply block lost in a merge.
  writeFileSync(p, 'schema_version: 1\n', 'utf8');
  const d = eraseDecision({ root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW });
  assert.equal(d.verdict, STOP);
  assert.equal(d.failed_closed, true);

  // The fraction key alone dropped — the confirm key surviving must not open the door.
  writeFileSync(p, `schema_version: 1\nskills:\n  comply:\n    ${ERASE_CONFIRM_GATE.split('.').pop()}: true\n`, 'utf8');
  const d2 = eraseDecision({ root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW });
  assert.equal(d2.verdict, STOP);
  assert.equal(d2.gate, ERASE_FRACTION_GATE);

  // Present but unusable is also no gate.
  writeFileSync(p, 'schema_version: 1\nskills:\n  comply:\n    erase_requires_explicit_confirm: true\n    erase_confirm_fraction: "most of it"\n', 'utf8');
  assert.equal(eraseDecision({ root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW }).verdict, STOP);
});

// ---------------------------------------------------------------------------
// 4. The CLI does its OWN arithmetic. It does not trust the caller to have done it.
// ---------------------------------------------------------------------------

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [PII_CLI, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('the CLI refuses an over-threshold sweep, writes nothing, and shows the numbers', () => {
  const root = treeOfDotCom();
  const before = snapshot(join(root, 'gtm'));

  const r = runCli(['erase', 'acme.com', '--root', root]);
  assert.notEqual(r.code, 0, 'the CLI ran a wide sweep without a second confirmation');
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, new RegExp(ERASE_FRACTION_GATE.replace(/\./g, '\\.')));
  assert.match(r.stderr, /of \d+ erasable row/, 'the refusal did not show the arithmetic');
  assert.match(r.stderr, /--confirm-sweep/, 'the refusal did not say how to proceed');

  assert.deepEqual(snapshot(join(root, 'gtm')), before,
    'a refused sweep wrote to the tree — including the tombstone claiming it succeeded');
  // ensureGtmTree() creates the tombstone log empty, so the assertion is that a
  // refused sweep appended no ERASURE to it, not that the file is absent.
  assert.equal(readTombstones({ root }).length, 0);
});

test('--confirm-sweep is what proceeds, and the CLI prints the blast radius either way', () => {
  const root = treeOfDotCom();
  const r = runCli(['erase', 'acme.com', '--root', root, '--confirm-sweep']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /blast radius: \d+ of \d+ erasable row/);
  assert.equal(readFileSync(join(root, 'gtm', 'lists', 'q3.jsonl'), 'utf8').includes('acme.com'), false);
  assert.equal(readTombstones({ root }).length, 1);
});

test('--dry-run needs no confirmation: measuring must never be the thing you cannot do', () => {
  const root = treeOfDotCom();
  const before = snapshot(join(root, 'gtm'));
  const r = runCli(['erase', 'acme.com', '--root', root, '--dry-run', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.dry_run, true);
  assert.ok(report.erasable_rows_total > 0);
  assert.ok(report.impact_fraction > gateValue(GATES, ERASE_FRACTION_GATE));
  assert.deepEqual(snapshot(join(root, 'gtm')), before, 'a dry run wrote to the tree');
});

test('the gtm/ tree that does not exist yet is not a division by zero', () => {
  const root = tmpRoot('compliance-empty-');
  mkdirSync(root, { recursive: true });
  assert.equal(countErasableRows(root), 0);
  const d = eraseDecision({ root, target: 'acme.com', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, ALLOW, 'nothing stored, nothing at risk');
  assert.equal(d.fraction, 0);
});
