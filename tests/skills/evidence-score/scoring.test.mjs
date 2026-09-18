// tests/skills/evidence-score/scoring.test.mjs
//
// The arithmetic half of the skill. The evals cover the fabrication boundary; this
// file covers the rubric the skill ships — that a supported signal scores, an
// unsupported one does not, a band that is not in the table scores zero rather than a
// guess, the caps hold, and the band cutoffs and the reachability floor come from gate
// keys that fail closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  loadEvidenceRules, scoreRecord, bandFor, gradeClaim, NOT_FOUND, SUPPORTED,
} from './harness.mjs';
import {
  brief, verified, inferred, NOW, PINNED_GATES, gatesWithout,
} from './helpers.mjs';

const RULES = loadEvidenceRules();
const GATES = loadGates();
// The shipped gates with this skill's whole block deleted. `skills.evidence_score` is
// merged now, so "the key is missing" can no longer be staged by reading the real file
// — it has to be staged by removing the block, which is also the failure this fails
// closed against: a merge that drops the hunk (see the RULES note at the top of
// _lib/gates.yaml's `skills:` block).
const STRIPPED = gatesWithout(GATES, 'skills.evidence_score');
const G = PINNED_GATES.evidence_score;
const ctx = { rules: RULES, gates: GATES, now: NOW };
const src = (n) => ({ source: `https://acme.example/evidence/${n}` });

/** A record with a supported signal in every dimension. */
function fullBrief () {
  const b = brief();
  verified(b, 'icp_seniority_match', true, src('fit1'));
  verified(b, 'icp_function_match', true, src('fit2'));
  verified(b, 'job_change_recent', true, src('t1'));
  verified(b, 'seniority_band', 'director', src('i1'));
  verified(b, 'authored_post_on_topic', true, src('e1'));
  verified(b, 'email_verification_status', 'ok', src('r1'));
  return b;
}

test('a supported signal scores its points and names the evidence that earned them', () => {
  const res = scoreRecord(fullBrief(), ctx);
  assert.equal(res.dimensions.fit.score, 6 + 5);
  assert.equal(res.dimensions.fit.measured, true);
  assert.equal(res.dimensions.fit.why.field, 'icp_seniority_match');
  assert.match(res.dimensions.fit.why.source, /^https:\/\//,
    'the why_ column is a pointer, which means it carries the source');
});

test('an unsupported signal contributes nothing, whatever its value would have been', () => {
  const b = fullBrief();
  // Same field, same value, but inferred rather than verified.
  inferred(b, 'icp_industry_match', {
    result: true, confidence: 1, reasoning: 'obvious', source: 'https://acme.example/about',
  });
  const res = scoreRecord(b, ctx);
  assert.equal(res.dimensions.fit.score, 6 + 5, 'an ai_inferred signal scored points');
  assert.ok(!res.dimensions.fit.supporting.some(s => s.field === 'icp_industry_match'));
});

test('a banded dimension reads its table, and an unrecognised band scores zero', () => {
  const known = verified(brief(), 'seniority_band', 'cxo', src('i'));
  assert.equal(scoreRecord(known, ctx).dimensions.influence.score, 20);

  const unknown = verified(brief(), 'seniority_band', 'Chief Vibes Officer', src('i'));
  const res = scoreRecord(unknown, ctx);
  assert.equal(res.dimensions.influence.score, 0, 'an unmapped band must not be guessed at');
  // It is still MEASURED — the signal was present and supported, it just scores zero.
  assert.equal(res.dimensions.influence.measured, true);
});

test('a banded dimension with no signal is zero AND unmeasured, which is a different thing', () => {
  const res = scoreRecord(brief(), ctx);
  assert.equal(res.dimensions.influence.score, 0);
  assert.equal(res.dimensions.influence.measured, false);
  assert.equal(res.dimensions.influence.null, NOT_FOUND);
});

test('adjustments add on top of the band, and the cap holds', () => {
  const b = brief();
  verified(b, 'seniority_band', 'cxo', src('i'));                 // 20
  verified(b, 'function_is_buying_centre', true, src('i2'));      // +4
  assert.equal(scoreRecord(b, ctx).dimensions.influence.score, 20, 'the cap must hold');

  const r = brief();
  verified(r, 'email_verification_status', 'ok', src('r'));      // 12
  verified(r, 'phone_present', true, src('r2'));                  // +4
  verified(r, 'linkedin_url_present', true, src('r3'));           // +4
  assert.equal(scoreRecord(r, ctx).dimensions.reachability.score, 20);
});

test('the recorded verifier verdict `ok` outranks catch_all, risky and unknown', () => {
  // A live run once scored a cleanly verified `ok` row 0 and ranked it under catch_all.
  // `ok` is what tests/fixtures/live/email_verifier.json recorded at result.status.
  const reach = (status) => scoreRecord(
    verified(brief(), 'email_verification_status', status, src('v')), ctx,
  ).dimensions.reachability.score;
  assert.ok(reach('ok') > 0, 'a verified ok row scored nothing');
  for (const weaker of ['catch_all', 'risky', 'unknown', 'invalid']) {
    assert.ok(reach('ok') > reach(weaker), `ok must outrank ${weaker}`);
  }
  // The finder's `email_status` is a different answer and never reads as the verdict.
  const finder = verified(brief(), 'email_status', 'ok', src('f'));
  assert.equal(scoreRecord(finder, ctx).dimensions.reachability.score, 0);
});

test('the shipped scorer runs from the skill directory, with no tests/ tree', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'evidence-score-cli-'));
  try {
    const file = join(dir, 'briefs.json');
    writeFileSync(file, JSON.stringify([fullBrief()]));
    const script = new URL('../../../skills/evidence-score/score.mjs', import.meta.url);
    const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(script), file],
      { encoding: 'utf8' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].dimensions.reachability.score, 12);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an additive dimension caps too', () => {
  const b = brief();
  for (const s of RULES.dimensions.timing.signals) verified(b, s.field, true, src(s.field));
  assert.equal(scoreRecord(b, ctx).dimensions.timing.score, RULES.dimensions.timing.max);
});

test('a total is reported once enough dimensions are measured, and refused below that', () => {
  const full = scoreRecord(fullBrief(), ctx);
  assert.equal(full.total_status, 'reported');
  assert.equal(full.dimensions_measured, 5);
  assert.ok(full.total > 0 && full.total <= 100);

  const thin = brief();
  verified(thin, 'icp_seniority_match', true, src('a'));
  verified(thin, 'seniority_band', 'cxo', src('b'));
  const res = scoreRecord(thin, ctx);
  assert.equal(res.dimensions_measured, 2);
  assert.ok(res.dimensions_measured < G.min_dimensions_scored);
  assert.equal(res.total, null);
  assert.equal(res.total_status, 'refused');
  assert.deepEqual(res.reasons, ['too_few_dimensions_measured']);
});

test('with the real gates.yaml the total is reported and banded', () => {
  // The merged half. `skills.evidence_score` is in the shipped file, so the working
  // path is now reachable and this is what it does: enough measured dimensions, a
  // total, a band. Before the merge every run of this skill landed on the refusal
  // below, which was correct and also completely inert.
  const res = scoreRecord(fullBrief(), { rules: RULES, gates: GATES, now: NOW });
  assert.equal(res.total_status, 'reported');
  assert.equal(typeof res.total, 'number');
  assert.equal(res.failed_closed, false);
  assert.ok(res.dimensions_measured >= G.min_dimensions_scored);
  assert.equal(res.band_status, 'reported');
  assert.ok(['hot', 'warm', 'watch', 'drop'].includes(res.band));
});

test('strip the block and the total is refused and says it failed closed', () => {
  // Was "with the real gates.yaml …", which asserted this only because the block had
  // not been merged yet. The safety property is the same one, staged deliberately:
  // lose `min_dimensions_scored` and the score is refused, never computed from a
  // default. A 0-100 assembled without knowing how many dimensions it needed is the
  // one output this skill must not produce.
  const res = scoreRecord(fullBrief(), { rules: RULES, gates: STRIPPED, now: NOW });
  assert.equal(res.total, null);
  assert.equal(res.total_status, 'refused');
  assert.equal(res.failed_closed, true);
  assert.ok(res.reasons[0].startsWith('gate_missing:skills.evidence_score.min_dimensions_scored'));
});

test('bands come from the gate keys, and the boundaries are inclusive at the minimum', () => {
  const opts = { rules: RULES, gates: GATES };
  const reach = G.priority_reachability_min;
  assert.equal(bandFor(G.band_hot_min, reach, opts).band, 'hot');
  assert.equal(bandFor(G.band_hot_min - 1, reach, opts).band, 'warm');
  assert.equal(bandFor(G.band_warm_min, reach, opts).band, 'warm');
  assert.equal(bandFor(G.band_warm_min - 1, reach, opts).band, 'watch');
  assert.equal(bandFor(G.band_watch_min, reach, opts).band, 'watch');
  assert.equal(bandFor(G.band_watch_min - 1, reach, opts).band, 'drop');
});

test('a record below the reachability floor cannot be banded hot, however well it scores', () => {
  const opts = { rules: RULES, gates: GATES };
  const res = bandFor(100, G.priority_reachability_min - 1, opts);
  assert.notEqual(res.band, 'hot');
  assert.equal(res.band, 'warm');
  assert.ok(res.reasons.includes('demoted_below_reachability_floor'));
});

test('a missing band gate key refuses the band rather than defaulting it', () => {
  // Staged by stripping the merged block rather than by the file lacking it. Every
  // cutoff is checked one at a time: dropping any single one of them must refuse the
  // band, not silently fall through to the next cutoff down — which would band a
  // record `warm` on the strength of a key nobody can read.
  for (const key of ['band_hot_min', 'band_warm_min', 'band_watch_min', 'priority_reachability_min']) {
    const gates = gatesWithout(GATES, `skills.evidence_score.${key}`);
    const res = bandFor(95, 20, { rules: RULES, gates });
    assert.equal(res.band, null, `dropping ${key} still produced a band`);
    assert.equal(res.status, 'refused');
    assert.equal(res.failed_closed, true);
    assert.deepEqual(res.reasons, [`gate_missing:skills.evidence_score.${key}`]);
  }
  // And the whole block gone is the same answer, not a different one.
  const res = bandFor(95, 20, { rules: RULES, gates: STRIPPED });
  assert.equal(res.band, null);
  assert.equal(res.status, 'refused');
  assert.equal(res.failed_closed, true);
  assert.ok(res.reasons[0].startsWith('gate_missing:skills.evidence_score.'));
});

test('scoring is a pure function of the brief — the same brief scores the same twice', () => {
  const b = fullBrief();
  assert.deepEqual(scoreRecord(b, ctx), scoreRecord(b, ctx));
});

test('a signal graded supported by the shipped table is what the rubric actually reads', () => {
  // Guards the seam: if gradeClaim and scoreOneDimension ever disagree about what
  // "supported" means, the why_ columns stop matching the points.
  const b = fullBrief();
  const res = scoreRecord(b, ctx);
  for (const s of res.dimensions.fit.supporting) {
    assert.equal(gradeClaim(b, s.field, ctx).grade, SUPPORTED);
  }
});
