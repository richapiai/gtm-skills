// tests/skills/play-design/composition.test.mjs
//
// The reason this skill exists is the design ruling that new motions become
// PLAYS, not skills — which is only true if a play actually composes. Its failure mode
// is quiet: a play that stops naming skills and starts re-describing them, then drifts
// from the six it shadows until they disagree about what a sendable list is.
//
// So every assertion here is on a REFUSAL of a specific reimplementation, not on the
// prose that promises composition.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlaySpec, validatePlay, planTriggerProbe, shippedSkills,
  SAVE, REFUSE, OWNED, STOP,
} from './harness.mjs';
import {
  goodPlay, catalog, ownedEndpoints, skillBody, gatesWithRequestedKeys, gatesWithout,
  REQUESTED_GATES,
} from './helpers.mjs';
import { loadGates, hasGate } from '../../../_lib/gates.mjs';
import { priceCall } from '../../../_lib/dryrun.mjs';

const SPEC = loadPlaySpec();
const CATALOG = catalog();
const REAL_GATES = loadGates();                     // the shipped file: block merged
const MERGED = gatesWithRequestedKeys(REAL_GATES);  // the same, with this suite's pins
/** The shipped gates with this skill's whole block deleted — the law-5 input. */
const STRIPPED = gatesWithout(REAL_GATES, 'skills.play_design');

const check = (play, gates = MERGED) => validatePlay(play, { spec: SPEC, gates });

test('a well-formed play saves — so every refusal below is specific', () => {
  const res = check(goodPlay());
  assert.equal(res.decision, SAVE, JSON.stringify(res.violations));
  assert.deepEqual(res.violations, []);
  assert.deepEqual(res.stops, []);
});

test('every stage of the schema names skills that actually ship', () => {
  const shipped = shippedSkills();
  for (const [stage, body] of Object.entries(SPEC.stages)) {
    for (const name of body.runs) {
      assert.ok(shipped.has(name), `stage ${stage} names /${name}, which has no SKILL.md`);
    }
  }
  // The four the brief names by hand must all be in the composition.
  const all = Object.values(SPEC.stages).flatMap(s => s.runs);
  for (const must of ['signal-watch', 'enrich-waterfall', 'campaign-review', 'measure']) {
    assert.ok(all.includes(must), `/${must} is not composed by any stage`);
  }
});

test('a stage that names a skill the pack does not have is REFUSED', () => {
  const play = goodPlay();
  play.stages.prepare.runs = ['enrich-waterfall', 'super-enricher'];
  const res = check(play);
  assert.equal(res.decision, REFUSE);
  assert.ok(res.violations.includes('unknown_skill:prepare:super-enricher'), JSON.stringify(res.violations));
});

test('a stage that REIMPLEMENTS the skill it names is REFUSED — this is the whole rule', () => {
  // Each of these is a play quietly growing a second copy of somebody else's logic.
  const cases = {
    prepare: { waterfall: ['email_finder', 'email_verifier'] },
    audience: { scoring: { fit: 20, timing: 20 } },
    act: { copy_rules: 'always mention the funding round' },
    trigger: { routing: 'use lead_search when the company is big' },
    measure: { export: 'gtm/plays/out.csv' },
  };
  for (const [stage, extra] of Object.entries(cases)) {
    const play = goodPlay();
    Object.assign(play.stages[stage], extra);
    const res = check(play);
    assert.equal(res.decision, REFUSE, `${stage} accepted ${Object.keys(extra)[0]}`);
    assert.ok(res.violations.some(v => v.startsWith(`reimplements:${stage}:`)),
      `${stage}: ${JSON.stringify(res.violations)}`);
  }
});

test('a play may not reach an endpoint outside the two this skill owns', () => {
  // Every other paid call in a play is made by the skill that owns it, under that
  // skill\'s gates, cache class and receipt. A play naming an endpoint directly is a
  // play routing the user around all three.
  assert.deepEqual([...ownedEndpoints()].sort(), [...OWNED].sort());
  const play = goodPlay();
  play.stages.audience.params = { search: 'lead_search' };
  const res = check(play);
  assert.equal(res.decision, REFUSE);
  assert.ok(res.violations.some(v => v === 'endpoint_not_owned:audience:lead_search'),
    JSON.stringify(res.violations));

  // And the two it DOES own are fine in a trigger.
  const ok = goodPlay();
  ok.stages.trigger.probe = 'linkedin_job_search';
  assert.equal(check(ok).decision, SAVE, JSON.stringify(check(ok).violations));
});

test('the Act chain cannot be reordered, shortened, or have /launch moved off the end', () => {
  const reorder = goodPlay();
  reorder.stages.act.runs = ['personalize', 'sequence-builder', 'campaign-review', 'comply', 'launch'];
  assert.ok(check(reorder).violations.some(v => v.startsWith('act_chain:')));

  const skipComply = goodPlay();
  skipComply.stages.act.runs = ['personalize', 'sequence-builder', 'campaign-review', 'launch'];
  assert.equal(check(skipComply).decision, REFUSE);

  const launchFirst = goodPlay();
  launchFirst.stages.act.runs = ['launch', 'personalize', 'sequence-builder', 'comply', 'campaign-review'];
  assert.equal(check(launchFirst).decision, REFUSE);

  // The sole-writer rule in the schema itself: /launch is last, always.
  assert.equal(SPEC.stages.act.runs[SPEC.stages.act.runs.length - 1], 'launch');
});

test('a play with no stage, or a stage that runs nothing, is REFUSED', () => {
  for (const stage of SPEC.required_stages) {
    const play = goodPlay();
    delete play.stages[stage];
    const res = check(play);
    assert.equal(res.decision, REFUSE, `a play with no ${stage} stage was saved`);
    assert.ok(res.violations.includes(`missing_stage:${stage}`));
  }
  const empty = goodPlay();
  empty.stages.measure.runs = [];
  assert.ok(check(empty).violations.includes('stage_runs_nothing:measure'));
});

test('a play with no declared measurement is REFUSED — that is what makes it a play', () => {
  const noMetric = goodPlay();
  delete noMetric.measurement;
  assert.ok(check(noMetric).violations.includes('no_primary_metric'));

  const afterTheFact = goodPlay();
  afterTheFact.measurement.declared_before_first_run = false;
  assert.ok(check(afterTheFact).violations.includes('metric_declared_after_the_fact'));
});

test('the guardrails bite: a thin audience, a stale play, and a re-run before measurement', () => {
  const thin = goodPlay({ audience_rows: 1 });
  assert.ok(check(thin).violations.some(v => v.startsWith('audience_below_floor:')));
  assert.equal(check(goodPlay({ audience_rows: REQUESTED_GATES.play_design.min_audience_rows })).decision, SAVE);

  const stale = goodPlay({ approved_at: '2019-01-01T00:00:00Z' });
  assert.ok(check(stale).violations.includes('play_stale_reapprove'));

  const rerun = goodPlay({ rerun: true, last_run_measured: false });
  assert.ok(check(rerun).violations.includes('rerun_before_last_run_measured'));
  assert.equal(check(goodPlay({ rerun: true, last_run_measured: true })).decision, SAVE);
});

test('strip the block and not one of these guardrails resolves — the law-5 input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs. The
  // fail-closed cases below feed STRIPPED; if that strip ever became a no-op — the
  // block renamed, moved, nested differently — they would pass while proving nothing.
  for (const k of Object.keys(REQUESTED_GATES.play_design)) {
    assert.equal(hasGate(STRIPPED, `skills.play_design.${k}`), false,
      `skills.play_design.${k} survived the strip`);
  }
});

test('every guardrail FAILS CLOSED when its gate key does not resolve', () => {
  // Was: "while its gate key is unmerged" — asserted against the real file, which
  // happened to carry no block. It carries one now, so the fail-closed input is MADE:
  // a copy of the shipped gates with `skills.play_design` deleted. Same
  // MissingGateKey -> STOP path, but it stays true for every future key, and it is a
  // property of the CODE (a lost merge hunk wedges the skill) rather than an accident
  // of the file's current contents.
  //
  // A play whose guardrails cannot be read does not get saved — never "no guardrail".
  const res = check(goodPlay(), STRIPPED);
  assert.equal(res.decision, REFUSE);
  const stopped = res.stops.map(s => s.gate);
  for (const key of ['skills.play_design.min_audience_rows',
    'skills.play_design.play_max_age_days',
    'skills.play_design.require_measure_before_rerun']) {
    assert.ok(stopped.includes(key), `${key} did not STOP when absent`);
  }
  for (const s of res.stops) {
    assert.equal(s.decision, STOP);
    assert.equal(s.failed_closed, true);
  }

  // And the same play against the SHIPPED file saves, so the REFUSE above is the
  // missing keys and nothing else about the play.
  const shipped = check(goodPlay(), REAL_GATES);
  assert.equal(shipped.decision, SAVE, JSON.stringify(shipped.violations));
  assert.deepEqual(shipped.stops, []);
});

test('the trigger probe reads ONE page of a page-gated endpoint and refuses to walk', () => {
  const p = planTriggerProbe({ kind: 'hiring', pages: 1, catalog: CATALOG, gates: MERGED, spec: SPEC, expectedResults: 25 });
  assert.equal(p.dry_run, true);
  assert.equal(p.calls_made, 0);
  assert.equal(p.endpoint, 'linkedin_job_search');
  assert.equal(p.unbounded, true);
  assert.equal(p.blocked, false, JSON.stringify(p.stops));
  assert.equal(p.credits_per_call,
    priceCall(CATALOG.endpoints.linkedin_job_search, { expectedResults: 25 }).credits,
    'the probe must be priced from the catalog, not from the skill');

  const walk = planTriggerProbe({
    kind: 'hiring', pages: REQUESTED_GATES.play_design.trigger_probe_max_pages + 4,
    catalog: CATALOG, gates: MERGED, spec: SPEC, expectedResults: 25,
  });
  assert.equal(walk.blocked, true);
  assert.ok(walk.stops.some(s => s.gate === 'skills.play_design.trigger_probe_max_pages'),
    JSON.stringify(walk.stops));

  // Unpriced is also blocked: linkedin_job_search bills per result, so a probe with no
  // expected count is a probe nobody can approve.
  const unpriced = planTriggerProbe({ kind: 'hiring', pages: 1, catalog: CATALOG, gates: MERGED, spec: SPEC });
  assert.equal(unpriced.blocked, true);
  assert.equal(unpriced.total_credits, null);

  // And with the key stripped the probe is unavailable, not unlimited. Was asserted
  // against the real file back when it carried no block; the block is merged now, so
  // the closed case is made by deleting the one key the probe reads.
  const closed = planTriggerProbe({
    kind: 'hiring', pages: 1, catalog: CATALOG,
    gates: gatesWithout(REAL_GATES, 'skills.play_design.trigger_probe_max_pages'),
    spec: SPEC, expectedResults: 25,
  });
  assert.equal(closed.blocked, true);
  assert.ok(closed.stops.some(s => s.failed_closed));
  assert.ok(closed.stops.some(s => s.gate === 'skills.play_design.trigger_probe_max_pages'));

  // The counterpart on the SHIPPED file: one page is allowed, and the page after it is
  // not, so the block above is the missing key rather than the probe itself.
  const onShipped = planTriggerProbe({
    kind: 'hiring', pages: 1, catalog: CATALOG, gates: REAL_GATES, spec: SPEC, expectedResults: 25,
  });
  assert.equal(onShipped.blocked, false, JSON.stringify(onShipped.stops));
  const overShipped = planTriggerProbe({
    kind: 'hiring', pages: REQUESTED_GATES.play_design.trigger_probe_max_pages + 1,
    catalog: CATALOG, gates: REAL_GATES, spec: SPEC, expectedResults: 25,
  });
  assert.equal(overShipped.blocked, true);
});

test('the flat trigger probe samples and never sweeps', () => {
  const p = planTriggerProbe({ kind: 'tech_change', rows: 10, catalog: CATALOG, gates: MERGED, spec: SPEC });
  assert.equal(p.endpoint, 'web_tech_stack');
  assert.equal(p.unbounded, false);
  assert.equal(p.blocked, false, JSON.stringify(p.stops));
  assert.equal(SPEC.trigger_probe.endpoints.tech_change.sample_only, true);
  assert.equal(p.total_credits,
    priceCall(CATALOG.endpoints.web_tech_stack, {}).credits * 10);
});

test('the play-spec cannot be edited into failing open', () => {
  const mutations = [
    ['default_decision', d => { d.default_decision = 'save'; }],
    ['a stage dropped', d => { d.required_stages = ['trigger', 'audience', 'prepare', 'act']; }],
    ['stage order unpinned', d => { d.stage_order_fixed = false; }],
    ['act chain unpinned', d => { d.stages.act.order_fixed = false; }],
    ['launch moved off the end', d => { d.stages.act.runs = ['launch', 'personalize', 'sequence-builder', 'comply', 'campaign-review']; }],
    ['measure made optional', d => { d.stages.measure.required = false; }],
    ['reimplementation permitted', d => { d.composition.stage_may_redefine_composed_behaviour = true; }],
    ['an extra endpoint allowed', d => { d.composition.play_may_call_endpoints.push('lead_search'); }],
    ['a stage naming a non-skill', d => { d.stages.prepare.runs = ['not-a-skill']; }],
    ['probe pretends to be bounded', d => { d.trigger_probe.endpoints.hiring.unbounded = false; }],
    ['guardrail failure ignored', d => { d.guardrails.on_missing_key = 'allow'; }],
    ['metric chosen afterwards', d => { d.measurement.declared_before_first_run = false; }],
    ['cost reported as a point', d => { d.measurement.cost_is_a_range = false; }],
    ['a paid inference hop', d => { d.inference.paid_hop = 'ai_enrich'; }],
  ];
  for (const [label, mutate] of mutations) {
    const doc = JSON.parse(JSON.stringify(SPEC));
    mutate(doc);
    assert.throws(() => revalidate(doc), /PlaySpecUnavailable|must|IS |sole writer|local-inference|law 5/,
      `a fail-open edit survived: ${label}`);
  }
});

test('the skill routes to every skill it composes', () => {
  // A composition whose parts are not linked is a list of names. The validator only
  // checks that the links it finds resolve; this checks that they are all there.
  const body = skillBody();
  for (const name of new Set(Object.values(SPEC.stages).flatMap(s => s.runs))) {
    assert.ok(body.includes(`../${name}/SKILL.md`), `the skill composes /${name} but never links to it`);
  }
});

/** Re-run the loader's validation against an in-memory doc. One copy of the rules. */
function revalidate (doc) {
  const { writeFileSync, mkdtempSync } = require$('node:fs');
  const { join } = require$('node:path');
  const { tmpdir } = require$('node:os');
  const { stringify } = require$('yaml');
  const dir = mkdtempSync(join(tmpdir(), 'play-design-spec-'));
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, '# t\n\n```yaml play-spec\n' + stringify(doc) + '```\n', 'utf8');
  return loadPlaySpec({ path: p });
}

import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);
