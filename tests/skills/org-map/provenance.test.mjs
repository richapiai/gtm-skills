// tests/skills/org-map/provenance.test.mjs
//
// The Iron Law is only real if BREAKING IT FAILS. tests/evals/org-map/ runs the one
// adversarial case the plan recorded; this file attacks the machinery around it:
//
//   - the rules block is the gate, so disarming a rule must STOP rather than pass
//   - a drawn line and an inferred line must differ IN THE OUTPUT, with the
//     annotations and the legend removed
//   - an orphan is rendered, never omitted
//   - Slack participation can never become an edge
//
// Every assertion here is on a decision, a provenance marker, or a rendered glyph.
// None is on the skill's prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillSource, skillBody, section } from './helpers.mjs';
import {
  loadOrgMapRules, planManagerEdge, buildOrgMap, renderOrgMap, stripAnnotations,
  planParticipation, departmentOf, seniorityOf, isTopOfHouse,
  validateDualContract, NULL_ENUM, OrgMapRulesUnavailable,
  OBSERVED, INFERRED, DRAW, REFUSE, NOT_FOUND, NOT_APPLICABLE,
} from './harness.mjs';

const RULES = loadOrgMapRules();
const BODY = skillBody();

const ROSTER = [
  { name: 'A. Okonkwo', title: 'Chief Executive Officer' },
  { name: 'G. Achebe', title: 'VP of Sales' },
  { name: 'H. Reyes', title: 'Sales Manager' },
  { name: 'B. Marek', title: 'Sales Development Representative' },
  { name: 'D. Ibarra', title: 'Software Engineer' },
];

// ---------------------------------------------------------------------------
// The block IS the gate.
// ---------------------------------------------------------------------------

test('there is exactly one org-map-rules block and it carries every required key', () => {
  const fences = [...skillSource().matchAll(/^```yaml[ \t]+org-map-rules[ \t]*$/gm)];
  assert.equal(fences.length, 1, 'the rules block must be unique — two gates is no gate');
  for (const key of ['default_decision', 'evidence_sources', 'iron_law', 'inferred_edge',
    'ceo_default', 'render', 'inference']) {
    assert.notEqual(RULES[key], undefined, `org-map-rules is missing \`${key}\``);
  }
  assert.match(RULES.iron_law, /inferred/i);
  assert.match(RULES.iron_law, /CEO/i);
});

/** Rewrite one line of the rules block in a copy of the SKILL.md source. */
function tampered (find, replace) {
  const src = skillSource();
  assert.ok(src.includes(find), `tamper fixture is stale: ${find}`);
  return src.replace(find, replace);
}

test('disarming the law in the block is a STOP, not a quiet pass', () => {
  const attacks = [
    ['  banned: true', '  banned: false', /ceo_default\.banned/],
    ['  assertable: false', '  assertable: true', /assertable/],
    ['default_decision: refuse', 'default_decision: draw', /default_decision/],
    ['  marker_on_edge_line: true', '  marker_on_edge_line: false', /marker_on_edge_line/],
    ['    - only_remaining_executive        # THE CEO DEFAULT',
      '    - a_reason_that_is_not_the_ceo_default', /only_remaining_executive/],
  ];
  for (const [find, replace, expect] of attacks) {
    assert.throws(
      () => loadOrgMapRules({ src: tampered(find, replace) }),
      (e) => e instanceof OrgMapRulesUnavailable && expect.test(e.message),
      `"${find}" -> "${replace}" was accepted; the rules block is not actually a gate`);
  }
});

test('a deleted rules block is a STOP, never "no rules"', () => {
  const src = skillSource().replace(/```yaml org-map-rules[\s\S]*?\n```/, '');
  assert.throws(() => loadOrgMapRules({ src }), (e) => e instanceof OrgMapRulesUnavailable);
});

// ---------------------------------------------------------------------------
// Provenance.
// ---------------------------------------------------------------------------

test('only two provenance kinds exist, and an inference is never one of the assertable ones', () => {
  assert.deepEqual(RULES.provenance_kinds, [OBSERVED, INFERRED]);
  assert.equal(RULES.inferred_edge.assertable, false);
  assert.equal(RULES.inferred_edge.refusal_null, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(RULES.inferred_edge.refusal_null));
  assert.ok(NULL_ENUM.includes(RULES.ceo_default.on_only_candidate));
});

test('every edge and every refusal validates against the frozen dual contract', () => {
  const map = buildOrgMap({ company: 'Acme', roster: ROSTER, rules: RULES });
  assert.ok(map.edges.length > 0 && map.orphans.length > 0,
    'the fixture must exercise both an edge and a refusal');
  for (const e of [...map.edges, ...map.orphans]) {
    const res = validateDualContract(e.contract);
    assert.equal(res.valid, true, `${e.report}: ${JSON.stringify(res.errors ?? res)}`);
  }
});

test('an inferred edge picks the NEAREST title above, not the most senior one', () => {
  // The failure this guards is subtler than the CEO default and has the same cause:
  // reaching for the most visible person rather than the most likely one.
  const plan = planManagerEdge({
    report: { name: 'B. Marek', title: 'Sales Development Representative' },
    roster: ROSTER, rules: RULES,
  });
  assert.equal(plan.decision, DRAW);
  assert.equal(plan.provenance, INFERRED);
  assert.equal(plan.manager, 'H. Reyes', 'the Sales Manager is nearer than the VP');
  assert.ok(seniorityOf('Sales Manager') < seniorityOf('VP of Sales'));
});

test('a cross-department senior is never a candidate', () => {
  const plan = planManagerEdge({
    report: { name: 'D. Ibarra', title: 'Software Engineer' },
    roster: ROSTER, rules: RULES,
  });
  assert.equal(plan.decision, REFUSE);
  assert.equal(plan.contract.result, NOT_FOUND);
  assert.equal(departmentOf('VP of Sales'), 'sales');
  assert.equal(departmentOf('Software Engineer'), 'engineering');
});

test('the top-of-house list is the one in the rules block, read rather than reinvented', () => {
  for (const t of RULES.ceo_default.top_of_house_titles) {
    assert.equal(isTopOfHouse(t, RULES), true, `${t} is listed but does not read as top-of-house`);
  }
  assert.equal(isTopOfHouse('Sales Development Representative', RULES), false);
  assert.equal(isTopOfHouse('Account Executive', RULES), false,
    'an Account Executive reading as top-of-house would invent a manager for the whole org');
});

// ---------------------------------------------------------------------------
// Rendering: the label is on the line.
// ---------------------------------------------------------------------------

test('observed and inferred survive as distinct glyphs with annotations and legend stripped', () => {
  const map = buildOrgMap({
    company: 'Acme', roster: ROSTER, rules: RULES,
    evidence: [{
      report: 'H. Reyes', manager: 'G. Achebe',
      kind: 'explicit_reporting_statement', source: 'linkedin_company_employees_search',
    }],
  });
  const bare = stripAnnotations(renderOrgMap(map, RULES));

  const obs = RULES.render.observed_marker;
  const inf = RULES.render.inferred_marker;
  const orphan = RULES.render.orphan_marker;
  assert.equal(new Set([obs, inf, orphan]).size, 3, 'the three markers must all differ');

  const markerOf = (line) => (line.match(/^\s*(\S+)/) || [])[1];
  const lines = bare.split('\n').filter(l => l.trim());
  const observedMarkers = new Set(map.edges.filter(e => e.provenance === OBSERVED)
    .map(e => markerOf(lines.find(l => l.includes(e.to) && l.trimStart().startsWith(obs)))));
  const inferredMarkers = new Set(map.edges.filter(e => e.provenance === INFERRED)
    .map(e => markerOf(lines.find(l => l.includes(e.to) && l.trimStart().startsWith(inf)))));

  assert.ok(observedMarkers.size > 0 && inferredMarkers.size > 0);
  for (const m of observedMarkers) {
    assert.ok(!inferredMarkers.has(m),
      `"${m}" marks both an observed and an inferred edge — the two are indistinguishable`);
  }
  // And no annotation is left to lean on.
  assert.ok(!bare.includes('['), `an annotation survived stripping:\n${bare}`);
});

test('a renderer that collapses the two markers is refused rather than rendered', () => {
  const same = JSON.parse(JSON.stringify(RULES));
  same.render.inferred_marker = same.render.observed_marker;
  const map = buildOrgMap({ company: 'Acme', roster: ROSTER, rules: RULES });
  assert.throws(() => renderOrgMap(map, same),
    (e) => e instanceof OrgMapRulesUnavailable && /identical/.test(e.message));
});

test('an unplaced person is rendered with the explicit null, never omitted', () => {
  assert.equal(RULES.render.render_unknown_parents, true);
  const map = buildOrgMap({ company: 'Acme', roster: ROSTER, rules: RULES });
  const bare = stripAnnotations(renderOrgMap(map, RULES));
  for (const o of map.orphans) {
    assert.ok(bare.includes(o.person.name), `${o.person.name} was dropped from the rendered map`);
    assert.ok(bare.includes(`manager: ${o.contract.result}`),
      `${o.person.name} has no rendered null — silence reads as "not checked"`);
  }
});

test('the SKILL.md shows the rendered form, and shows all three markers in it', () => {
  const s = section(/make the two kinds of line visibly different/i);
  const m = s.text.match(/```\n([\s\S]*?)```/);
  assert.ok(m, 'the section must show a rendered map, not merely describe one');
  const block = m[1];
  for (const key of ['observed_marker', 'inferred_marker', 'orphan_marker']) {
    assert.ok(block.includes(RULES.render[key]),
      `the example map never shows render.${key} (${RULES.render[key]})`);
  }
  assert.ok(block.includes('not_found'), 'the example map must demonstrate a rendered gap');
  assert.ok(block.includes('Legend'), 'render.legend_required is true');
  for (const token of NULL_ENUM) {
    assert.ok(BODY.includes(token), `the skill never mentions the explicit null \`${token}\``);
  }
  assert.match(BODY, /_lib\/dual-contract\.schema\.json/,
    'the skill must name where its null enum comes from');
});

// ---------------------------------------------------------------------------
// Slack participation is not hierarchy.
// ---------------------------------------------------------------------------

test('slack participation produces node attributes and never an edge', () => {
  const res = planParticipation({
    shared_connect_channel: true,
    members: ['A. Okonkwo', 'B. Marek', 'Someone Else'],
    roster: ROSTER, rules: RULES,
  });
  assert.equal(res.decision, DRAW);
  assert.deepEqual(res.edges, [], 'channel membership must never become a reporting edge');
  assert.deepEqual(res.attributes.map(a => a.attribute), ['in_deal_channel', 'in_deal_channel']);
  assert.equal(validateDualContract(res.contract).valid, true);
});

test('an internal channel is not_applicable, not a paid call', () => {
  const res = planParticipation({ shared_connect_channel: false, members: ['x'], roster: ROSTER, rules: RULES });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.contract.result, NOT_APPLICABLE);
  assert.deepEqual(res.edges, []);
});

test('removing slack_channel_membership from the never-list is a STOP', () => {
  const src = skillSource().replace(
    '    - slack_channel_membership        # participation is not hierarchy', '');
  const loosened = loadOrgMapRules({ src });
  assert.throws(() => planParticipation({ shared_connect_channel: true, rules: loosened }),
    (e) => e instanceof OrgMapRulesUnavailable && /slack_channel_membership/.test(e.message));
});
