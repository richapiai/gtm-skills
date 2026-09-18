// tests/evals/org-map/ceo-default.test.mjs
//
// THE ADVERSARIAL CASE the design names by hand, and the one recorded in
// tests/evals/iron-laws.test.mjs as PENDING_FIXTURES['org-map']:
//
//   law:     inferred edges are labelled inferred, and never default to the CEO
//   company: a 6-person company whose only listed executive is the CEO
//   ask:     Who is the likely manager of the new SDR?
//   must:    return not_found, or an edge explicitly labelled inferred.
//            Never assert the CEO as fact.
//
// The fixture below is inherited VERBATIM from that file. Verbatim matters: the whole
// point of writing the case down before the skill existed was that nobody would later
// re-invent it into something easier to pass. When this landed, the entry was deleted
// from PENDING_FIXTURES and moved here — `every Iron-Law skill is either pending here or
// has an eval that runs` checks that both halves happened.
//
// Every assertion is on the DECISION, the PROVENANCE and the explicit-null enum value.
// None is on the prose: a prose assertion passes forever the moment somebody rewords a
// paragraph, and this law is about what gets DRAWN.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadOrgMapRules, planManagerEdge, buildOrgMap, renderOrgMap, stripAnnotations,
  aiEnrichDecision, departmentOf, seniorityOf, isTopOfHouse,
  validateDualContract, NULL_ENUM,
  OBSERVED, INFERRED, DRAW, REFUSE, NOT_FOUND, STOP,
} from '../../skills/org-map/harness.mjs';

const RULES = loadOrgMapRules();

// --- the fixture, verbatim from PENDING_FIXTURES['org-map'] ----------------
const FIXTURE = Object.freeze({
  law: 'inferred edges are labelled inferred, and never default to the CEO',
  company: 'a 6-person company whose only listed executive is the CEO',
  ask: 'Who is the likely manager of the new SDR?',
  must: 'return not_found, or an edge explicitly labelled inferred. Never assert the CEO as fact.',
});

// The roster the fixture describes: six people, one executive, and that executive is
// the CEO. The new SDR is the subject of the ask.
const CEO = { name: 'A. Okonkwo', title: 'Chief Executive Officer' };
const SDR = { name: 'B. Marek', title: 'Sales Development Representative' };
const ROSTER = Object.freeze([
  CEO,
  SDR,
  { name: 'C. Duval', title: 'Account Executive' },
  { name: 'D. Ibarra', title: 'Software Engineer' },
  { name: 'E. Novak', title: 'Software Engineer' },
  { name: 'F. Lindqvist', title: 'Product Designer' },
]);

test('the fixture is the one that was recorded, and the roster matches its description', () => {
  assert.match(FIXTURE.company, /6-person/);
  assert.match(FIXTURE.must, /not_found|inferred/);
  assert.equal(ROSTER.length, 6, 'the fixture says six people');

  const execs = ROSTER.filter(p => isTopOfHouse(p.title, RULES));
  assert.deepEqual(execs.map(p => p.name), [CEO.name],
    'the fixture says the ONLY listed executive is the CEO — that is what makes the case adversarial');

  // The title lexicon must not quietly reclassify the case out of existence.
  assert.equal(departmentOf(SDR.title), 'sales');
  assert.equal(departmentOf(CEO.title), 'executive');
  assert.equal(departmentOf('Account Executive'), 'sales',
    'an Account Executive is in sales; reading it as an executive would invent a manager');
  assert.ok(seniorityOf(CEO.title) > seniorityOf(SDR.title));
  assert.equal(seniorityOf('Account Executive'), seniorityOf(SDR.title),
    'the AE does not outrank the SDR, so there is genuinely nobody above them in sales');
});

// ===========================================================================
// THE CASE.
// ===========================================================================

test('THE case — "who is the likely manager of the new SDR?" answers not_found', () => {
  const plan = planManagerEdge({ report: SDR, roster: ROSTER, evidence: [], rules: RULES });

  assert.equal(plan.decision, REFUSE);
  assert.equal(plan.manager, null, 'no manager may be named');
  assert.equal(plan.provenance, null, 'a refusal has no provenance because there is no edge');

  // The answer is the explicit null enum, read from the frozen contract — never prose.
  assert.equal(plan.contract.result, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(plan.contract.result));
  assert.equal(validateDualContract(plan.contract).valid, true,
    'the refusal itself must satisfy _lib/dual-contract.schema.json');

  // And it says the guess was considered and rejected, which is the finding.
  assert.equal(plan.ceo_default_refused, true);
});

test('the CEO is never the answer, under any phrasing of the same question', () => {
  const plan = planManagerEdge({ report: SDR, roster: ROSTER, evidence: [], rules: RULES });
  assert.notEqual(plan.manager, CEO.name);
  assert.equal(plan.assertable, false);

  // The whole map, not just the one query: no edge anywhere points at the CEO.
  const map = buildOrgMap({ company: 'Northwind Freight', roster: ROSTER, rules: RULES });
  assert.deepEqual(map.edges.filter(e => e.from === CEO.name), [],
    'an edge to the CEO appeared with no evidence — this is the failure the law names');
  assert.ok(map.orphans.some(o => o.person.name === SDR.name),
    'the SDR must appear as an orphan, not be quietly dropped from the map');
});

test('the refusal cannot be laundered by handing in the reason as evidence', () => {
  // Every one of these is a reason that FEELS like evidence at the moment it is used.
  for (const kind of ['only_remaining_executive', 'elimination', 'graph_must_be_connected',
    'headcount_implies_a_manager', 'slack_channel_membership']) {
    const plan = planManagerEdge({
      report: SDR, roster: ROSTER, rules: RULES,
      evidence: [{ report: SDR.name, manager: CEO.name, kind, source: 'reasoning' }],
    });
    assert.equal(plan.decision, REFUSE, `${kind} was accepted as evidence`);
    assert.equal(plan.manager, null, `${kind} produced an edge to ${CEO.name}`);
    assert.equal(plan.contract.result, NOT_FOUND);
    assert.ok(plan.rejected.some(r => r.kind === kind),
      `${kind} must be recorded as rejected, not silently ignored`);
  }
});

test('the paid LLM hop cannot promote the guess either — grounding yields an INFERRED edge', () => {
  const plan = planManagerEdge({
    report: SDR, roster: ROSTER, rules: RULES,
    evidence: [{ report: SDR.name, manager: CEO.name, kind: 'ai_enrich_grounded', source: 'ai_enrich' }],
  });
  assert.equal(plan.decision, DRAW);
  assert.equal(plan.provenance, INFERRED, 'an ai_inferred answer is never an observed edge');
  assert.equal(plan.assertable, false);
  assert.equal(validateDualContract(plan.contract).valid, true);

  // And the hop may not even be reached for this job.
  const d = aiEnrichDecision({ reason: 'inferring_the_hierarchy', rules: RULES });
  assert.equal(d.decision, STOP);
});

// ===========================================================================
// The other half of `must`: an edge explicitly labelled inferred.
// ===========================================================================

test('the second permitted answer — an explicitly-labelled inferred edge — is reachable', () => {
  // Same company, one hire: a VP of Sales. Now the title neighbourhood exists, so the
  // skill draws a line — and draws it as an inference, not as a fact.
  const VP = { name: 'G. Achebe', title: 'VP of Sales' };
  const plan = planManagerEdge({ report: SDR, roster: [...ROSTER, VP], evidence: [], rules: RULES });

  assert.equal(plan.decision, DRAW);
  assert.equal(plan.manager, VP.name);
  assert.equal(plan.provenance, INFERRED);
  assert.equal(plan.evidence_kind, 'title_neighborhood');
  assert.equal(plan.assertable, false, 'no confidence value makes an inference assertable');
  assert.ok(plan.contract.confidence > 0 && plan.contract.confidence < 1);
  assert.equal(validateDualContract(plan.contract).valid, true);
  assert.notEqual(plan.manager, CEO.name, 'even with a VP present the CEO must not be chosen');
});

test('an OBSERVED edge to the CEO is allowed — the law bans defaulting, not the CEO', () => {
  // If the SDR's own profile says they report to the CEO, that is evidence and the
  // edge is drawn as observed. A law that banned the CEO outright would be wrong in
  // exactly the six-person company it was written for.
  const plan = planManagerEdge({
    report: SDR, roster: ROSTER, rules: RULES,
    evidence: [{
      report: SDR.name, manager: CEO.name,
      kind: 'explicit_reporting_statement', source: 'linkedin_company_employees_search',
    }],
  });
  assert.equal(plan.decision, DRAW);
  assert.equal(plan.provenance, OBSERVED);
  assert.equal(plan.manager, CEO.name);
  assert.equal(plan.assertable, true);
  assert.equal(validateDualContract(plan.contract).valid, true);
});

// ===========================================================================
// "Labelled" means labelled in the OUTPUT, not in a footnote.
// ===========================================================================

test('in the rendered map, the inferred edge and the observed edge look different', () => {
  const VP = { name: 'G. Achebe', title: 'VP of Sales' };
  const roster = [...ROSTER, VP];
  const rendered = renderOrgMap(buildOrgMap({
    company: 'Northwind Freight', roster, rules: RULES,
    evidence: [{
      report: 'C. Duval', manager: VP.name,
      kind: 'explicit_reporting_statement', source: 'linkedin_company_employees_search',
    }],
  }), RULES);

  const bare = stripAnnotations(rendered);
  const obs = RULES.render.observed_marker;
  const inf = RULES.render.inferred_marker;

  assert.notEqual(obs, inf);
  assert.ok(bare.includes(obs), 'the observed marker did not survive stripping the annotations');
  assert.ok(bare.includes(inf), 'the inferred marker did not survive stripping the annotations');

  // The SDR's inferred line and the AE's observed line carry different glyphs, with no
  // bracketed annotation and no legend left to lean on.
  const sdrLine = bare.split('\n').find(l => l.includes(SDR.name) && l.trimStart().startsWith(inf));
  const aeLine = bare.split('\n').find(l => l.includes('C. Duval') && l.trimStart().startsWith(obs));
  assert.ok(sdrLine, `no inferred-marked line for the SDR in:\n${bare}`);
  assert.ok(aeLine, `no observed-marked line for the AE in:\n${bare}`);
  assert.notEqual(sdrLine.trimStart().slice(0, obs.length + inf.length), aeLine.trimStart().slice(0, obs.length + inf.length));
});

test('in the six-person company the map renders the SDR with not_found, never omitted', () => {
  const rendered = renderOrgMap(buildOrgMap({
    company: 'Northwind Freight', roster: ROSTER, rules: RULES,
  }), RULES);
  const bare = stripAnnotations(rendered);

  assert.ok(bare.includes(SDR.name), 'the SDR vanished from the map — silence reads as "not checked"');
  const line = bare.split('\n').find(l => l.includes('manager: not_found'));
  assert.ok(line, `the map never renders the explicit null:\n${bare}`);
  assert.ok(line.trimStart().startsWith(RULES.render.orphan_marker));

  // Nowhere in the rendered map is the CEO drawn above the SDR.
  const sdrIdx = bare.split('\n').findIndex(l => l.includes(SDR.name));
  const after = bare.split('\n').slice(sdrIdx, sdrIdx + 2).join('\n');
  assert.ok(!after.includes(CEO.name), `the CEO was drawn over the SDR:\n${after}`);
});
