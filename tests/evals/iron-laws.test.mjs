// The Iron-Law eval suite.
//
// Each case is ADVERSARIAL: it hands the pack a situation where the tempting answer
// is a fabrication, and asserts the REFUSAL or the explicit null — never the prose
// around it. Checking that a law is written down somewhere proves nothing; these
// check that breaking it fails.
//
// SCOPE. This file runs every law that has enforcement code in `_lib/` — the ones that
// hold no matter which skill is calling. The skill-level Iron Laws live in
// tests/evals/<skill>/, next to the skill that carries them.
//
// It used to say `skills/` was empty and no skill had been written, which was true when
// it was written and stopped being true the moment the first skill landed. Under law 6
// a stale claim in a comment is a correctness problem rather than a tidiness one: the
// next reader trusts it and reasons from a repo that no longer exists.
//
// The mechanism that got all four skill-level cases written: each adversarial fixture
// was recorded HERE, before its skill existed, as a `todo` that surfaced in every CI
// run — so the eventual author inherited the exact case instead of inventing a friendlier
// one. All four have since landed and moved out. PENDING_FIXTURES is now empty, which is
// the mechanism finishing rather than the mechanism being abandoned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree } from '../helpers/index.mjs';
import { validateDualContract, isExplicitNull, storeLlmResult, newArtifact, readArtifactField, NULL_ENUM, STATUS_INVALID } from '../../_lib/dual-contract.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { loadSuppressionStore, ensureSuppressionStore, addSuppressionEntry, writeOutputList, isSuppressed } from '../../_lib/suppression.mjs';
import { loadGates, gateValue, MissingGateKey } from '../../_lib/gates.mjs';
import { buildRequest } from '../../_lib/client.mjs';
import { writeSenderExport, listContentHash, SenderExportRefused } from '../../_lib/sender-export.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

// ===========================================================================
// LAW: there is ONE way to say "no answer", and it is an explicit null.
// ===========================================================================

test('LAW no-fabrication — every way of dodging "I do not know" is rejected', () => {
  // The adversarial set: what an LLM actually emits when it has no answer. Each of
  // these is a fabrication dressed as an answer, and each must be refused.
  const dodges = ['', 'N/A', 'n/a', 'unknown', 'Unknown', 'none', 'null', 'NULL', '-', 'TBD', '?', 'not found', 'no data'];
  for (const dodge of dodges) {
    const res = validateDualContract({ result: dodge, confidence: 0.9, reasoning: 'r', source: 's' });
    assert.equal(res.valid, false, `"${dodge}" must not pass as an answer`);
  }
  // Structural dodges too.
  for (const dodge of [null, [], {}]) {
    assert.equal(validateDualContract({ result: dodge, confidence: 0.5, reasoning: 'r', source: 's' }).valid, false,
      `${JSON.stringify(dodge)} must not pass as an answer`);
  }
  // And the three that ARE allowed.
  for (const ok of NULL_ENUM) {
    assert.equal(validateDualContract({ result: ok, confidence: 0.9, reasoning: 'r', source: 's' }).valid, true);
    assert.equal(isExplicitNull({ result: ok }), true);
  }
});

test('LAW no-fabrication — a non-conforming answer is stored INVALID, never as verified', () => {
  const artifact = newArtifact();
  const stored = storeLlmResult(artifact, 'industry', { result: 'N/A', confidence: 0.9, reasoning: 'guessed', source: 'vibes' });
  assert.equal(stored.status, STATUS_INVALID);
  assert.equal(stored.valid, false);

  // Stronger than "flagged": an invalid answer is not readable as a field AT ALL.
  // It lands in ai_inferred_invalid[] and readArtifactField reports it as absent, so
  // downstream code cannot accidentally render a fabrication.
  assert.equal(readArtifactField(artifact, 'industry').provenance, 'absent');
  assert.equal(readArtifactField(artifact, 'industry').value, undefined);
  assert.equal(artifact.ai_inferred_invalid.length, 1);
  assert.deepEqual(artifact.verified, {}, 'an LLM value must never enter verified');

  // A well-formed answer IS readable, but keeps its inferred marker — never blended.
  storeLlmResult(artifact, 'segment', { result: 'SMB', confidence: 0.8, reasoning: 'r', source: 's' });
  const good = readArtifactField(artifact, 'segment');
  assert.equal(good.value, 'SMB');
  assert.equal(good.provenance, 'ai_inferred');
  assert.notEqual(good.provenance, 'verified');
});

// ===========================================================================
// LAW: never fabricate an actual.
// ===========================================================================

test('LAW never-fabricate-an-actual — a response with no billing field yields no actual', (t) => {
  const tree = makeGtmTree({ prefix: 'law-ledger-' });
  t.after(() => tree.cleanup());
  const led = new Ledger({ dir: path.join(tree.root, 'gtm'), runId: 'r' });

  // profile_activities bills on totalElements but returns only `elements`. The
  // tempting move is to compute the charge from the estimate and call it an actual.
  const line = led.record({
    endpoint: 'profile_activities',
    catalogEntry: CATALOG.endpoints.profile_activities,
    estimatedCredits: 20,
    responseBody: { elements: [1, 2, 3, 4, 5] },   // a count IS present, just not the billed one
    httpStatus: 200,
  });
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.equal(line.credits_actual, null, 'an estimate must never be promoted to an actual');

  // Every unverifiable endpoint in the catalog behaves the same way. No exceptions.
  const unverifiable = Object.entries(CATALOG.endpoints)
    .filter(([, d]) => d.pricing?.billing_field_present_in_response === false);
  assert.ok(unverifiable.length >= 10, `expected the 11 unverifiable endpoints, saw ${unverifiable.length}`);
  for (const [name, def] of unverifiable) {
    const l = led.record({ endpoint: name, catalogEntry: def, estimatedCredits: 5, responseBody: { ok: true }, httpStatus: 200 });
    assert.equal(l.credits_actual, null, `${name} fabricated an actual`);
  }
});

// ===========================================================================
// LAW: fail closed.
// ===========================================================================

test('LAW fail-closed — an unreadable suppression store is STOP, not "nothing suppressed"', (t) => {
  const tree = makeGtmTree({ prefix: 'law-sup-' });
  t.after(() => tree.cleanup());

  // No store at all. The tempting reading is "no entries, so nobody is suppressed".
  assert.throws(() => loadSuppressionStore({ root: tree.root }),
    (e) => e.name === 'SuppressionUnavailableError',
    'a check we could not run is not a passing check');

  // An empty store is different from a missing one: empty is a real answer.
  ensureSuppressionStore(tree.root);
  assert.equal(loadSuppressionStore({ root: tree.root }).count, 0);
});

test('LAW fail-closed — a suppressed contact cannot reach an output list', (t) => {
  const tree = makeGtmTree({ prefix: 'law-out-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  addSuppressionEntry({ email: 'nope@x.example', reason: 'unsubscribed' }, { root: tree.root });

  const rows = [{ email: 'ok@x.example' }, { email: 'nope@x.example' }, { email: 'NOPE@X.EXAMPLE' }];
  const file = path.join(tree.root, 'out.csv');
  const res = writeOutputList(file, rows, { root: tree.root });

  assert.equal(res.written, 1);
  assert.equal(res.suppressed, 2, 'case must not be an escape hatch');
  assert.ok(!fs.readFileSync(file, 'utf8').toLowerCase().includes('nope@x.example'));
});

test('LAW fail-closed — a missing gate key reads as STOP, never as "no gate"', () => {
  const gates = loadGates();
  assert.throws(() => gateValue(gates, 'session_budget.fractions.does_not_exist'),
    (e) => e instanceof MissingGateKey);
  // A gate that exists still answers normally, so the failure mode is specific.
  assert.equal(typeof gateValue(gates, 'session_budget.fractions.stop'), 'number');
});

// ===========================================================================
// LAW: every paid call is named and costed first.
// ===========================================================================

test('LAW no-blind-spend — an empty POST is refused on the endpoints the SPEC allows it on', () => {
  // The spec sets requestBody.required = false on all ten zero-required-field
  // endpoints, phone_finder at 25 credits included. An empty POST is spec-valid.
  for (const ep of ['phone_finder', 'email_finder']) {
    assert.equal(buildRequest(ep, {}).ok, false, `${ep} accepted an empty request`);
    assert.equal(buildRequest(ep, { first_name: 'A' }).ok, false, `${ep} accepted a partial request`);
  }
});

// ===========================================================================
// LAW: /launch owns the irreversible act.
// ===========================================================================

test('LAW launch-owns-the-export — no other actor, no stale verdict', (t) => {
  const tree = makeGtmTree({ prefix: 'law-launch-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const rows = [{ email: 'a@x.example', first_name: 'A' }];
  const file = path.join(tree.root, 'send.csv');
  const verdict = { status: 'PASS', list_hash: listContentHash(rows) };

  assert.throws(() => writeSenderExport({ file, rows, platform: 'smartlead', verdict, root: tree.root, actor: 'personalize' }),
    (e) => e instanceof SenderExportRefused);
  assert.throws(() => writeSenderExport({ file, rows: [...rows, { email: 'b@x.example' }], platform: 'smartlead', verdict, root: tree.root, actor: 'launch' }),
    (e) => /STALE/.test(e.message));
  assert.equal(fs.existsSync(file), false, 'a refused launch leaves nothing behind');
});

// ===========================================================================
// PENDING — the cases the plan names, whose skills do not exist yet.
//
// The fixture is written. When the skill lands, delete the `todo` and wire it up.
// ===========================================================================

// The four adversarial cases the plan names, one per Iron Law.
//
// A fixture lived here until its skill landed, then moved into
// tests/evals/<skill>/ where it is actually executed. Verbatim matters: the
// whole point of writing each case down before the skill existed was that
// nobody could later re-invent it into something easier to pass.
//
// ALL FOUR HAVE NOW LANDED, so this list is empty and the two tests below have
// swapped roles. They no longer nag about missing skills; they hold the line
// that every Iron Law still has an eval that runs:
//
//   personalize     tests/evals/personalize/      brief missing the claimed fact
//   call-intel      tests/evals/call-intel/       a transcript with no objection
//   org-map         tests/evals/org-map/          the only exec is the CEO
//   research-agent  tests/evals/research-agent/   a question with no findable answer
//
// An empty list is therefore the CORRECT terminal state, not a sign the
// mechanism was abandoned — which is precisely why the second test derives its
// expectation from IRON_LAW_SKILLS rather than from this object's length.
const PENDING_FIXTURES = {};

for (const [skill, f] of Object.entries(PENDING_FIXTURES)) {
  // node:test runs a todo body, so it must not assert. The fixture above is the
  // deliverable; this marker keeps it visible in every CI run until the skill lands.
  test(`LAW ${skill} — ${f.law}`, { todo: `/${skill} does not exist yet. Fixture is written in PENDING_FIXTURES; wire it when the skill lands.` }, () => {});
}

const IRON_LAW_SKILLS = ['personalize', 'call-intel', 'org-map', 'research-agent'];

test('the pending fixtures are real, so nobody has to reinvent them', () => {
  for (const [skill, f] of Object.entries(PENDING_FIXTURES)) {
    assert.ok(f.law && f.ask && f.must, `${skill} fixture is incomplete`);
    assert.match(f.must, /refuse|not_found|not_applicable|inferred/,
      `${skill} must assert a refusal or an explicit null, not a prose shape`);
  }
  // Every pending fixture is genuinely pending, so the todo markers stay honest.
  const skillsDir = path.join(REPO, 'skills');
  const present = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
  for (const skill of Object.keys(PENDING_FIXTURES)) {
    assert.ok(!present.includes(skill),
      `/${skill} now exists — move its fixture into tests/evals/${skill}/ and delete it here`);
  }
});

test('every Iron-Law skill is either pending here or has an eval that runs', () => {
  // The half the original was missing. Removing a fixture from PENDING_FIXTURES
  // was enough to make the suite green, whether or not the eval it named was
  // ever written — so the tripwire could be silenced by deletion, which is the
  // one thing a tripwire must not permit.
  //
  // Now a landed skill must have an eval directory with a real test in it, and
  // a pending one must have a fixture. Neither state can be reached by removing
  // a line.
  const skillsDir = path.join(REPO, 'skills');
  const present = new Set(fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []);

  for (const skill of IRON_LAW_SKILLS) {
    if (!present.has(skill)) {
      assert.ok(PENDING_FIXTURES[skill],
        `/${skill} has not shipped and has no pending fixture — its Iron Law is unrecorded`);
      continue;
    }
    const evalDir = path.join(REPO, 'tests', 'evals', skill);
    assert.ok(fs.existsSync(evalDir),
      `/${skill} shipped, so tests/evals/${skill}/ must exist and execute its Iron Law`);
    const files = fs.readdirSync(evalDir).filter((f) => f.endsWith('.test.mjs'));
    assert.ok(files.length > 0, `tests/evals/${skill}/ has no test file`);
    assert.ok(!PENDING_FIXTURES[skill],
      `/${skill} shipped but is still listed as pending — the fixture is in two places`);
  }
});
