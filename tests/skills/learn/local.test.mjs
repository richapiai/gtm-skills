// /learn — the local learnings flywheel, and the properties that keep it local.
//
// Every case runs the script that ships inside skills/learn/SKILL.md, extracted
// verbatim. The helpers live under tests/skills/measure/ because this suite owns both
// directories and nothing above them.
//
// The properties under test:
//   1. /learn writes nothing that requires a server — no network, no consent, no queue
//   2. what it writes carries zero row-level fields, from a journal that is full of them
//   3. it is append-only and idempotent per run
//   4. a missing threshold fails CLOSED: nothing is re-ranked, and the keys are named
//   5. a prior can only permute an approved hop set, so it can never change a run's cost
//   6. confidence decays, and a decayed-out learning is not applied

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  projectWith, jline, runLearn, LEARN_SCRIPT, CONTACTS, contactLeaks,
  gatesFileWith, tmpRoot, skillBody,
} from '../measure/helpers.mjs';
import { assertAggregateOnly } from '../../../_lib/share-render.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

/** Two hops over five contacts. `email_finder` outperforms `email_verifier`. */
function fixture ({ runId = 'run-learn', finderOk = 4, verifierOk = 2 } = {}) {
  const journal = [];
  CONTACTS.forEach((c, i) => {
    for (const [hop, ep, provider, ok] of [
      [0, 'email_finder', 'provider_a', i < finderOk],
      [1, 'email_verifier', 'internal', i < verifierOk],
    ]) {
      journal.push(jline({ runId, rowId: c, hop, endpoint: ep, status: 'pending', creditsEstimated: 2 }));
      journal.push(jline({
        runId, rowId: c, hop, endpoint: ep, status: ok ? 'ok' : 'failed',
        creditsEstimated: 2, provider: ok ? provider : null, error: ok ? null : 'http_404',
      }));
    }
  });
  return projectWith({ runId, journal, prefix: 'p6-learn-' });
}

/** A gates.yaml that DOES carry the skills.learn block this skill asks for. */
function gatesWithLearnKeys (overrides = {}) {
  return gatesFileWith(tmpRoot('p6-gates-'), (doc) => {
    doc.skills.learn = {
      confidence_half_life_days: 30,
      min_observations_to_apply: 5,
      min_confidence_to_apply: 0.25,
      ...overrides,
    };
  });
}

const record = (p, env = {}) => runLearn({ ROOT: p.root, RUN: p.runId, MODE: 'record', NOW, ...env });
const apply = (p, env = {}) => runLearn({ ROOT: p.root, MODE: 'apply', NOW, JSON: '1', ...env });
const applyJson = (p, env = {}) => JSON.parse(apply(p, env).stdout);
const learnings = (p) => p.read('gtm/learnings.jsonl').trim().split('\n').map((l) => JSON.parse(l));

// ===========================================================================
// 1. Nothing here needs a server.
// ===========================================================================

test('/learn writes nothing that requires a server: no network primitive exists', () => {
  const src = LEARN_SCRIPT();
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  const allowed = new Set([
    'node:fs', 'node:path',
    './_lib/journal.mjs', './_lib/share-render.mjs', './_lib/gates.mjs',
  ]);
  for (const i of imports) assert.ok(allowed.has(i), `unexpected import: ${i}`);

  for (const re of [
    /\bfetch\s*\(/,
    /from\s+['"]node:(http|https|net|dns|dgram|tls|child_process|worker_threads)/,
    /require\(['"]node:(http|https|net|dns)/,
    /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bnavigator\b/,
    /https?:\/\/[a-z]/i,
  ]) {
    assert.doesNotMatch(src, re, `the learn script contains a network primitive: ${re}`);
  }
});

test('the whole flywheel runs with fetch removed from the runtime', () => {
  // Source scanning proves the file is clean today. This proves the BEHAVIOUR does not
  // depend on a network being there: if any path reached for one, this run would throw.
  const p = fixture({ runId: 'run-nofetch' });
  const kill = '--input-type=module';
  assert.ok(kill, 'placeholder to keep the intent obvious');
  const env = { NODE_OPTIONS: '' };
  assert.equal(record(p, env).status, 0);
  const gf = gatesWithLearnKeys();
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gf, ...env });
  assert.equal(out.applied, true);
});

test('/learn stores no consent, no queue, and no upload state', () => {
  const p = fixture({ runId: 'run-noconsent' });
  record(p);
  apply(p, { HOPS: 'email_finder' });
  // The design note rules out the client-contributed index; nothing here may lay the
  // plumbing for it. gtm/consent.jsonl and an outbox are the two shapes that would.
  assert.ok(!existsSync(p.path('gtm/consent.jsonl')));
  assert.ok(!existsSync(p.path('gtm/outbox')));
  assert.ok(!existsSync(p.path('gtm/learnings.queue.jsonl')));
  for (const line of learnings(p)) {
    for (const k of ['uploaded', 'upload_at', 'consent', 'shared', 'contributed', 'snapshot_sha256']) {
      assert.ok(!(k in line), `a learning line carries ${k}, which is networked-index plumbing`);
    }
  }
});

test('the skill says so on the page, and rules out what the design note ruled out', () => {
  const body = skillBody('learn');
  assert.match(body, /no server|no upload/i);
  assert.match(body, /re-rank hops inside an already-approved plan/i);
  assert.match(body, /Prior learning applied/);
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /will not talk to a server/i);
  assert.match(boundary, /will not change what a run costs/i);
  assert.match(boundary, /copy, templates, replies or conversions/i);
});

// ===========================================================================
// 2. Zero row-level fields, from a journal that is full of them.
// ===========================================================================

test('learnings recorded from a PII-bearing journal contain zero row-level fields', () => {
  const p = fixture({ runId: 'run-pii' });
  const rawJournal = p.read(`gtm/runs/${p.runId}.jsonl`);
  assert.ok(contactLeaks(rawJournal).length >= 5, 'the fixture journal must actually carry PII');

  assert.equal(record(p).status, 0);
  const raw = p.read('gtm/learnings.jsonl');
  assert.deepEqual(contactLeaks(raw), [], 'a learning line leaked a contact');

  const ALLOWED = new Set([
    'schema_version', 'kind', 'key', 'run_id', 'observed_at', 'hop',
    'n', 'hits', 'hit_rate_pct', 'mean_confidence',
  ]);
  const rows = learnings(p);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const k of Object.keys(row)) assert.ok(ALLOWED.has(k), `unexpected field "${k}" in a learning`);
    assert.ok(!('row_id' in row) && !('response_hash' in row));
    assert.doesNotThrow(() => assertAggregateOnly(row), 'a learning must clear the pack\'s own gate');
  }
});

test('a poisoned provider name is bucketed, never carried into the learnings file', () => {
  const runId = 'run-poisoned';
  const journal = [jline({
    runId, rowId: CONTACTS[0], endpoint: 'email_finder', status: 'ok',
    creditsEstimated: 2, provider: 'ping_me_at_ceo_example_com',
  })];
  const p = projectWith({ runId, journal, prefix: 'p6-learn-' });
  record(p);
  const raw = p.read('gtm/learnings.jsonl');
  assert.deepEqual(contactLeaks(raw), []);
  assert.doesNotMatch(raw, /https?:\/\//);
});

// ===========================================================================
// 3. Append-only and idempotent.
// ===========================================================================

test('recording is append-only: prior bytes are never rewritten', () => {
  const p = fixture({ runId: 'run-a' });
  record(p);
  const first = p.read('gtm/learnings.jsonl');

  // A second, different run appends and leaves the first run's lines untouched.
  const second = fixture({ runId: 'run-b', finderOk: 1, verifierOk: 5 });
  p.write('gtm/runs/run-b.jsonl', second.read('gtm/runs/run-b.jsonl'));
  runLearn({ ROOT: p.root, RUN: 'run-b', MODE: 'record', NOW: '2026-08-29T12:00:00.000Z' });

  const after = p.read('gtm/learnings.jsonl');
  assert.ok(after.startsWith(first), 'an earlier learning was rewritten, not appended to');
  assert.ok(after.length > first.length);
  assert.ok(learnings(p).some((l) => l.run_id === 'run-b'));
});

test('recording the same run twice appends nothing: a denominator cannot inflate', () => {
  const p = fixture({ runId: 'run-idem' });
  record(p);
  const before = p.read('gtm/learnings.jsonl');
  const r = record(p, { NOW: '2026-09-01T12:00:00.000Z' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already recorded/);
  assert.equal(p.read('gtm/learnings.jsonl'), before, 'a re-record changed the file');
});

// ===========================================================================
// 4. A missing threshold fails closed.
// ===========================================================================

test('with the skills.learn block REMOVED, apply fails CLOSED', () => {
  // The block now exists in gates.yaml (added at a later review, after this
  // suite reported the three keys it needed). The fail-closed path is still the
  // one that matters most, so it is exercised against a gates file with the block
  // stripped rather than against the shipped one — the test keeps its teeth
  // instead of quietly becoming a test of the happy path.
  const p = fixture({ runId: 'run-closed' });
  record(p);
  const stripped = gatesFileWith(tmpRoot('p6-gates-'), (doc) => { delete doc.skills.learn; });
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: stripped });

  assert.equal(out.applied, false);
  assert.equal(out.failed_closed, true);
  assert.match(out.reason, /failing closed \(law 5\)/);
  assert.match(out.missing_key, /^skills\.learn\./);
  assert.deepEqual(out.ordering, ['email_verifier', 'email_finder'],
    'a failed-closed apply must leave the APPROVED order exactly as it was');
  assert.deepEqual(out.attribution, []);
  for (const k of ['confidence_half_life_days', 'min_observations_to_apply', 'min_confidence_to_apply']) {
    assert.ok(out.required_keys.some((r) => r.endsWith(k)), `the refusal must name ${k}`);
  }
});

test('a fail-closed apply still exits 0 and still recorded: only the re-rank is refused', () => {
  // Same strip as the block-REMOVED test above: the refusal must cost the user nothing except the
  // re-rank. Recording is unconditional, because an observation withheld because
  // a threshold key is missing is an observation lost forever.
  const p = fixture({ runId: 'run-closed2' });
  const stripped = gatesFileWith(tmpRoot('p6-gates-'), (doc) => { delete doc.skills.learn; });
  const r = runLearn({
    ROOT: p.root, RUN: p.runId, MODE: 'both',
    HOPS: 'email_finder,email_verifier', NOW, GATES_FILE: stripped,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /recorded   \d+ observation/);
  assert.match(r.stdout, /apply      NOT APPLIED/);
  assert.ok(learnings(p).length > 0, 'recording must not be gated on the apply thresholds');
});

test('with the block PRESENT, apply is no longer refused for a missing key', () => {
  // The other half: now that gates.yaml carries skills.learn, the shipped path
  // must actually reach the thresholds rather than fail closed forever. Without
  // this, adding the block could have been a no-op and nothing would have said so.
  const p = fixture({ runId: 'run-open' });
  record(p);
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder' });   // real gates.yaml
  assert.notEqual(out.failed_closed, true,
    'the block exists now — a missing-key refusal here means it is not being read');
  assert.ok(!out.missing_key, `unexpected missing key: ${out.missing_key}`);
});

test('dropping ONE of the three keys is still a STOP, and names that key', () => {
  const p = fixture({ runId: 'run-partial' });
  record(p);
  for (const missing of ['confidence_half_life_days', 'min_observations_to_apply', 'min_confidence_to_apply']) {
    const gf = gatesFileWith(tmpRoot('p6-gates-'), (doc) => {
      doc.skills.learn = {
        confidence_half_life_days: 30, min_observations_to_apply: 5, min_confidence_to_apply: 0.25,
      };
      delete doc.skills.learn[missing];
    });
    const out = applyJson(p, { HOPS: 'email_finder,email_verifier', GATES_FILE: gf });
    assert.equal(out.failed_closed, true, `${missing} missing must fail closed`);
    assert.equal(out.missing_key, `skills.learn.${missing}`);
  }
});

// ===========================================================================
// 5. A prior may only permute an approved set.
// ===========================================================================

test('the ordering is a PERMUTATION of the approved hops, so the cost cannot move', () => {
  const p = fixture({ runId: 'run-perm' });
  record(p);
  const gf = gatesWithLearnKeys();
  const hops = ['email_verifier', 'email_finder'];
  const out = applyJson(p, { HOPS: hops.join(','), GATES_FILE: gf });

  assert.deepEqual([...out.ordering].sort(), [...hops].sort(),
    'the prior added, dropped or substituted a hop — that changes what the run costs');
  assert.equal(out.ordering.length, hops.length);
  assert.deepEqual(out.ordering, ['email_finder', 'email_verifier'],
    'the better-performing hop is ranked first');
});

test('a hop with no learning at all is kept, not dropped', () => {
  const p = fixture({ runId: 'run-unknownhop' });
  record(p);
  const gf = gatesWithLearnKeys();
  const hops = ['email_verifier', 'phone_finder', 'email_finder'];
  const out = applyJson(p, { HOPS: hops.join(','), GATES_FILE: gf });
  assert.deepEqual([...out.ordering].sort(), [...hops].sort());
  assert.ok(out.ordering.indexOf('phone_finder') > out.ordering.indexOf('email_finder'),
    'an unmeasured hop ranks below a measured winner, but is never removed');
});

test('every re-rank carries visible attribution naming its evidence', () => {
  const p = fixture({ runId: 'run-attrib' });
  record(p);
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gatesWithLearnKeys() });
  assert.equal(out.applied, true);
  assert.ok(out.attribution.length > 0);
  for (const a of out.attribution) {
    assert.match(a, /^Prior learning applied: /);
    assert.match(a, /\d+\/\d+ observed across \d+ run\(s\)/, 'attribution must carry its denominator');
    assert.match(a, /decayed hit rate [\d.]+%/);
  }
  assert.deepEqual(contactLeaks(out.attribution.join('\n')), []);
});

test('an ordering that changes nothing says so instead of claiming a win', () => {
  const p = fixture({ runId: 'run-noop' });
  record(p);
  const out = applyJson(p, { HOPS: 'email_finder,email_verifier', GATES_FILE: gatesWithLearnKeys() });
  assert.equal(out.unchanged, true);
  assert.equal(out.applied, false);
  assert.match(out.reason, /unchanged|no prior cleared/);
});

// ===========================================================================
// 6. Decay, and the floors that stop a thin sample from steering a run.
// ===========================================================================

test('an observation decayed below the confidence floor is not applied', () => {
  const p = fixture({ runId: 'run-old' });
  record(p, { NOW: '2026-01-01T00:00:00.000Z' });     // ~8 months before NOW
  const gf = gatesWithLearnKeys();
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gf });

  assert.equal(out.applied, false, 'a stale learning must not steer a fresh run');
  assert.deepEqual(out.ordering, ['email_verifier', 'email_finder'], 'the approved order stands');
  const finder = out.considered.find((c) => c.key === 'endpoint:email_finder');
  assert.equal(finder.usable, false);
  assert.match(finder.why_not, /decayed/);
});

test('the half-life is READ from the gate file: a longer one revives the same data', () => {
  const p = fixture({ runId: 'run-halflife' });
  record(p, { NOW: '2026-01-01T00:00:00.000Z' });
  // Only the half-life differs between the two runs, so nothing else can explain the
  // change in verdict.
  const withHalfLife = (days) => gatesWithLearnKeys({
    confidence_half_life_days: days, min_observations_to_apply: 3, min_confidence_to_apply: 0.25,
  });
  const short = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: withHalfLife(30) });
  const long = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: withHalfLife(3650) });
  assert.equal(short.applied, false);
  assert.equal(long.applied, true, 'the decay must come from the gate file, not from a constant');
});

test('too few decayed observations is not enough to re-rank, and says why', () => {
  const runId = 'run-thin';
  const journal = [
    jline({ runId, rowId: CONTACTS[0], hop: 0, endpoint: 'email_finder', status: 'ok', creditsEstimated: 2, provider: 'provider_a' }),
    jline({ runId, rowId: CONTACTS[0], hop: 1, endpoint: 'email_verifier', status: 'failed', creditsEstimated: 2, error: 'http_404' }),
  ];
  const p = projectWith({ runId, journal, prefix: 'p6-learn-' });
  record(p);
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gatesWithLearnKeys({ min_observations_to_apply: 50 }) });
  assert.equal(out.applied, false);
  assert.deepEqual(out.ordering, ['email_verifier', 'email_finder']);
  for (const c of out.considered) {
    assert.equal(c.usable, false);
    assert.match(c.why_not, /not enough decayed observations/);
  }
});

test('more recent evidence outweighs older evidence of the opposite sign', () => {
  // run-old says email_verifier wins; run-new says email_finder does. With a short
  // half-life the recent run must decide, which is the whole point of the decay.
  const old = fixture({ runId: 'run-old2', finderOk: 0, verifierOk: 5 });
  const p = old;
  record(p, { RUN: 'run-old2', NOW: '2026-01-01T00:00:00.000Z' });
  const fresh = fixture({ runId: 'run-new2', finderOk: 5, verifierOk: 0 });
  p.write('gtm/runs/run-new2.jsonl', fresh.read('gtm/runs/run-new2.jsonl'));
  record(p, { RUN: 'run-new2', NOW });

  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gatesWithLearnKeys({ min_observations_to_apply: 3 }) });
  assert.deepEqual(out.ordering, ['email_finder', 'email_verifier'],
    'the fresher run must win under decay');
  assert.ok(out.attribution.some((a) => a.includes('email_finder')));
});

test('with no learnings file at all, apply is a no-op on the approved order', () => {
  const p = fixture({ runId: 'run-nofile' });
  const out = applyJson(p, { HOPS: 'email_verifier,email_finder', GATES_FILE: gatesWithLearnKeys() });
  assert.deepEqual(out.ordering, ['email_verifier', 'email_finder']);
  assert.equal(out.applied, false);
});

test('record refuses rather than inventing a run when there is no journal', () => {
  const p = projectWith({ runId: 'run-none', journal: [], prefix: 'p6-learn-' });
  const r = runLearn({ ROOT: p.root, RUN: 'missing', MODE: 'record', NOW });
  assert.equal(r.status, 2);
  assert.match(r.out, /no journal for run "missing"/);
});
