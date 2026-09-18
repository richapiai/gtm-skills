/**
 * The `--dry-run` plan artifact.
 *
 * Verify criterion: dry-run makes zero calls; actual spend matches the
 * plan within a stated tolerance. The tolerance used here is 10%, and it is passed
 * explicitly so the number a plan was judged against is never implicit.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { RunJournal, chargedUnits, planResume, readJournal, runWaterfall, summarize } from '../../_lib/journal.mjs';
import {
  ETA_UNAVAILABLE,
  PlanContractError,
  buildPlan,
  priceCall,
  reconcile,
  renderPlanText,
  writeDryRun,
} from '../../_lib/dryrun.mjs';
import { catalogFixture, waterfallFixture } from './fixtures/catalog.fixture.mjs';
import { assertValid, loadSchema } from './fixtures/schema-check.mjs';
import { tmpGtmDir } from './fixtures/tmp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_SCHEMA = loadSchema(path.join(repoRoot, '_lib/contracts/api-catalog.schema.json'));
const JOURNAL_SCHEMA = loadSchema(path.join(repoRoot, '_lib/contracts/journal-line.schema.json'));
const LEDGER_SCHEMA = loadSchema(path.join(repoRoot, '_lib/contracts/ledger-line.schema.json'));

const TOLERANCE = 0.10; // stated, not implied

/**
 * A client that detonates on ANY property access. If a dry run touched the transport
 * in any way — even to read a header — this throws.
 */
function explodingClient() {
  return new Proxy({}, {
    get(_t, prop) {
      throw new Error(`a dry run must make ZERO calls, but the client was used: ${String(prop)}`);
    },
  });
}

function descriptors(n, mutate = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    row_id: `row-${String(i + 1).padStart(4, '0')}`,
    ...mutate(i),
  }));
}

// ---------------------------------------------------------------------------

test('the local catalog fixture conforms to the FROZEN api-catalog schema', () => {
  assertValid(catalogFixture, CATALOG_SCHEMA, 'catalog fixture');
});

test('a dry run makes ZERO calls', () => {
  const dir = tmpGtmDir('t7-zero');
  const plan = buildPlan({
    runId: 'run-dry',
    rows: descriptors(50),
    waterfall: waterfallFixture,
    catalog: catalogFixture,
  });
  const written = writeDryRun({ plan, dir, client: explodingClient() });
  assert.ok(written.pending_written > 0);
  const { lines, corrupt } = readJournal(written.path);
  assert.equal(corrupt.length, 0);
  for (const line of lines) assertValid(line, JOURNAL_SCHEMA, 'dry-run journal line');
  // Nothing was charged and nothing was called.
  assert.equal(chargedUnits(lines).credits, 0);
  assert.equal(lines.filter((l) => l.status === 'ok').length, 0);
});

test('every planned row/hop is written pending, marked "planned, never attempted"', () => {
  const dir = tmpGtmDir('t7-pending');
  const rows = descriptors(10);
  const plan = buildPlan({ runId: 'run-p', rows, waterfall: waterfallFixture, catalog: catalogFixture });
  const written = writeDryRun({ plan, dir, client: explodingClient() });
  const { lines } = readJournal(written.path);

  assert.equal(lines.length, plan.units.length);
  assert.equal(lines.length, 30, '10 rows x 3 hops');
  for (const line of lines) {
    assert.equal(line.status, 'pending');
    assert.equal(line.attempt, 0, 'attempt 0 distinguishes a plan line from an in-flight call');
    assert.equal(line.credits_actual, null);
    assert.equal(line.response_hash, null);
  }
  const rowIds = new Set(lines.map((l) => l.row_id));
  assert.equal(rowIds.size, 10, 'every row appears in the plan');
});

test('cache hits are shown as skipped-and-not-charged, suppressed rows as dropped', () => {
  const dir = tmpGtmDir('t7-skips');
  const rows = [
    { row_id: 'r-plain' },
    { row_id: 'r-cached', cached: ['company_enrich', 'email_finder', 'phone_finder'] },
    { row_id: 'r-suppressed', suppressed: true },
    { row_id: 'r-has-email', has: ['email'] },
  ];
  const plan = buildPlan({ runId: 'run-skips', rows, waterfall: waterfallFixture, catalog: catalogFixture });

  assert.equal(plan.totals.rows_total, 4);
  assert.equal(plan.totals.rows_suppressed, 1);
  assert.equal(plan.totals.rows_fully_cached, 1);
  assert.equal(plan.totals.skipped_cache, 3, 'three hops answered from cache, none charged');
  assert.equal(plan.totals.skipped_suppressed, 3, 'the suppressed row is dropped at every hop');
  assert.equal(plan.totals.not_applicable, 1, 'the row that already has an email skips email_finder');

  // r-plain: 2 + 5 + 25 = 32. r-has-email: 2 + 25 = 27. Cached and suppressed: 0.
  assert.equal(plan.totals.credits_estimated, 59);
  const cached = plan.rows.find((r) => r.row_id === 'r-cached');
  assert.equal(cached.credits_estimated, 0);
  assert.ok(cached.hops.every((h) => h.action === 'skipped_cache'));
  const suppressed = plan.rows.find((r) => r.row_id === 'r-suppressed');
  assert.ok(suppressed.hops.every((h) => h.action === 'skipped_suppressed'));

  const text = renderPlanText(plan);
  assert.match(text, /cached \(not charged\)/);
  assert.match(text, /suppressed \(dropped\)/);
  assert.match(text, /TOTAL:\s+59 credits/);

  // Fail closed: a suppressed row is journalled with its terminal status, never as
  // `pending` — a pending suppressed row is one resume away from being enriched.
  const written = writeDryRun({ plan, dir, client: explodingClient() });
  const state = summarize(readJournal(written.path).lines);
  const suppressedStatuses = [...state.values()]
    .filter((u) => u.row_id === 'r-suppressed')
    .map((u) => u.status);
  assert.deepEqual(suppressedStatuses, ['skipped_suppressed', 'skipped_suppressed', 'skipped_suppressed']);
  const resume = planResume({ lines: readJournal(written.path).lines, units: plan.units });
  assert.ok(
    resume.todo.every((u) => u.row_id !== 'r-suppressed'),
    'a resume never picks a suppressed row back up',
  );
  assert.ok(
    resume.todo.every((u) => u.row_id !== 'r-cached'),
    'a resume never re-pays for a cache hit',
  );
});

test('actual spend matches the plan within the stated 10% tolerance', async () => {
  const dir = tmpGtmDir('t7-reconcile');
  const rows = descriptors(100, (i) => (i % 10 === 0 ? { cached: ['email_finder'] } : {}));
  const waterfall = [
    { endpoint: 'company_enrich' },
    { endpoint: 'email_finder', only_if_missing: 'email' },
  ];
  const plan = buildPlan({ runId: 'run-rec', rows, waterfall, catalog: catalogFixture });
  // 100 x company_enrich @2 = 200; 90 x email_finder @5 = 450 (10 cached, not charged).
  assert.equal(plan.totals.credits_estimated, 650);
  assert.equal(plan.totals.estimate_is_ceiling, false, 'no conditional hop, so this is exact');

  const journal = new RunJournal({ runId: 'run-rec', dir });
  writeDryRun({ plan, journal, client: explodingClient() });

  // The user approves the plan; the executor fills it in.
  const resume = planResume({ lines: readJournal(journal.path).lines, units: plan.units });
  assert.equal(resume.todo.length, 190, 'the approved plan is what runs');

  const price = { company_enrich: 2, email_finder: 5 };
  const ledger = [];
  await runWaterfall({
    journal,
    units: resume.todo,
    client: {
      async call(ctx) {
        const billed = price[ctx.endpoint];
        // email_finder omits the billing field (11 of 21 metered endpoints do).
        const verifiable = catalogFixture.endpoints[ctx.endpoint].pricing.billing_field_present_in_response;
        ledger.push({
          schema_version: 1,
          ts: new Date().toISOString(),
          run_id: 'run-rec',
          endpoint: ctx.endpoint,
          credits_estimated: billed,
          credits_actual: verifiable ? billed : null,
          cost_status: verifiable ? 'actual' : 'estimated_unverifiable',
          result_count: 1,
          balance_after: null,
          balance_source: 'unknown',
          http_status: 200,
        });
        return { body: { ok: true }, credits_actual: verifiable ? billed : null, provider: 'vendor_a' };
      },
    },
  });

  for (const line of ledger) assertValid(line, LEDGER_SCHEMA, 'ledger line');

  const rec = reconcile({ plan, ledgerLines: ledger, tolerance: TOLERANCE });
  assert.equal(rec.planned, 650);
  assert.equal(rec.actual, 650);
  assert.equal(rec.drift, 0);
  assert.equal(rec.within_tolerance, true);
  assert.equal(rec.tolerance, TOLERANCE);
  // Law 4: email_finder's response has no billing field, so this total is honest about
  // being partly estimated. An estimate is never echoed back as an actual.
  assert.equal(rec.cost_status, 'estimated_unverifiable');
  assert.equal(rec.unverifiable_lines, 90);
});

test('reconciliation reports drift honestly on either side of the tolerance', () => {
  const plan = buildPlan({
    runId: 'run-drift',
    rows: descriptors(10),
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
  });
  assert.equal(plan.totals.credits_estimated, 20);

  const ledgerAt = (total) => Array.from({ length: 10 }, () => ({
    schema_version: 1,
    ts: '2026-08-28T00:00:00.000Z',
    run_id: 'run-drift',
    endpoint: 'company_enrich',
    credits_estimated: total / 10,
    credits_actual: total / 10,
    cost_status: 'actual',
    balance_source: 'unknown',
    http_status: 200,
  }));

  const near = reconcile({ plan, ledgerLines: ledgerAt(21.6), tolerance: TOLERANCE }); // +8%
  assert.equal(near.within_tolerance, true);
  assert.equal(near.cost_status, 'actual');

  const far = reconcile({ plan, ledgerLines: ledgerAt(25), tolerance: TOLERANCE }); // +25%
  assert.equal(far.within_tolerance, false);
  assert.equal(far.drift, 5);
  assert.equal(Math.round(far.drift_pct * 100), 25);
});

test('a conditional hop makes the total a stated ceiling, with a floor beside it', () => {
  const plan = buildPlan({
    runId: 'run-ceiling',
    rows: descriptors(10),
    waterfall: waterfallFixture, // phone_finder is conditional on the prior hop
    catalog: catalogFixture,
  });
  assert.equal(plan.totals.estimate_is_ceiling, true);
  assert.equal(plan.totals.credits_estimated, 10 * (2 + 5 + 25));
  assert.equal(plan.totals.credits_estimated_floor, 10 * (2 + 5));
  assert.match(renderPlanText(plan), /ceiling; floor 70/);
});

test('no ETA is published while the API publishes no rate-limit quota', () => {
  const plan = buildPlan({
    runId: 'run-eta',
    rows: descriptors(60),
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
  });
  assert.equal(plan.eta.available, false);
  assert.match(plan.eta.reason, /no per-endpoint rate-limit quota/,
    'the reason a user reads must explain itself. It used to cite an internal ask '
    + 'number that no public document explains.');
  assert.equal(plan.eta.reason, ETA_UNAVAILABLE.reason);
  assert.match(renderPlanText(plan), /ETA:\s+unavailable/);

  // Once the quotas land, the same plan yields a real number — no code change needed.
  const withQuotas = buildPlan({
    runId: 'run-eta',
    rows: descriptors(60),
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
    rateLimits: { company_enrich: { requests_per_minute: 60 } },
  });
  assert.equal(withQuotas.eta.available, true);
  assert.equal(withQuotas.eta.seconds, 60);

  // A partially known quota table still refuses to guess.
  const partial = buildPlan({
    runId: 'run-eta',
    rows: descriptors(5),
    waterfall: waterfallFixture,
    catalog: catalogFixture,
    rateLimits: { company_enrich: { requests_per_minute: 60 } },
  });
  assert.equal(partial.eta.available, false);
  assert.match(partial.eta.reason, /quota missing/);
});

test('an unknown price is reported as unknown, never as zero', () => {
  const plan = buildPlan({
    runId: 'run-unknown',
    rows: descriptors(3),
    waterfall: [{ endpoint: 'mystery_endpoint' }],
    catalog: catalogFixture,
  });
  assert.equal(plan.totals.credits_unknown_calls, 3);
  assert.equal(plan.totals.credits_estimated, 0);
  assert.match(renderPlanText(plan), /cost UNKNOWN, not zero/);
  assert.equal(priceCall(catalogFixture.endpoints.mystery_endpoint).credits, null);
});

test('a disabled_by_default endpoint cannot be planned by accident', () => {
  const build = (allowDisabled) => buildPlan({
    runId: 'run-disabled',
    rows: descriptors(1),
    waterfall: [{ endpoint: 'post_keyword_search', expected_results: 10000 }],
    catalog: catalogFixture,
    allowDisabled,
  });
  assert.throws(() => build(false), (err) => err instanceof PlanContractError && /disabled_by_default/.test(err.message));
  const forced = build(true);
  assert.equal(forced.totals.credits_estimated, 60000, 'the 60,000-credit worst case is shown, not hidden');
  assert.equal(forced.per_hop[0].bounded, false, 'unbounded endpoints are flagged for page-gating');
  assert.match(renderPlanText(forced), /UNBOUNDED — page-gated/);
});

test('the planner refuses contact data — it takes row descriptors, not rows', () => {
  const attempt = (row) => () => buildPlan({
    runId: 'run-pii',
    rows: [row],
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
  });
  assert.throws(attempt({ row_id: 'r1', email: 'ada@example.com' }), PlanContractError);
  assert.throws(attempt({ row_id: 'r1', full_name: 'Ada Lovelace' }), PlanContractError);
  assert.throws(attempt({ row_id: 'r1', linkedin_url: 'https://linkedin.com/in/ada' }), PlanContractError);
  assert.throws(attempt({ has: ['email'] }), PlanContractError);
  // The descriptor form is accepted.
  assert.doesNotThrow(attempt({ row_id: 'r1', has: ['email'], cached: [], suppressed: false, segment: 'icp_a' }));
});

test('an endpoint the catalog does not know cannot be planned (Law 1)', () => {
  assert.throws(
    () => buildPlan({
      runId: 'run-nope',
      rows: descriptors(1),
      waterfall: [{ endpoint: 'invented_endpoint' }],
      catalog: catalogFixture,
    }),
    (err) => err instanceof PlanContractError && /not in the catalog/.test(err.message),
  );
});

test('the plan carries the catalog provenance it was priced from', () => {
  const plan = buildPlan({
    runId: 'run-prov',
    rows: descriptors(1),
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
  });
  assert.equal(plan.catalog_provenance.spec_sha256, catalogFixture.spec_sha256);
  assert.equal(plan.catalog_provenance.spec_version, '1.4.2-fixture');
});
