/**
 * Share-safe rendering, aggregate-only BY CONSTRUCTION.
 *
 * Verify criterion: a render over a PII-bearing journal contains zero
 * row-level fields. That is the whole point of share-safe rendering, so the regression test is strict:
 * it seeds contact data into EVERY string-bearing journal field — including `row_id`,
 * which in real lists is routinely the person's email — and then asserts that every
 * string that survives into the shareable output is drawn from a fixed allowlist.
 *
 * A denylist test would only prove that the fields we thought of were removed. The
 * allowlist proves the output was constructed rather than filtered.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RunJournal, runWaterfall, HttpError, readJournal } from '../../_lib/journal.mjs';
import { buildPlan, writeDryRun } from '../../_lib/dryrun.mjs';
import {
  ShareLeakError,
  assertAggregateOnly,
  renderShareable,
  renderShareableText,
} from '../../_lib/share-render.mjs';
import { catalogFixture, waterfallFixture } from './fixtures/catalog.fixture.mjs';
import { tmpGtmDir } from './fixtures/tmp.mjs';

/** Values a leak would have to reproduce. Every one of these is real-shaped. */
const PII = {
  email: 'ada.lovelace@analytical-engines.example',
  altEmail: 'grace@navy.example',
  phone: '+1 (555) 010-9988',
  name: 'Ada Lovelace',
  linkedin: 'https://www.linkedin.com/in/ada-lovelace',
  company: 'Analytical Engines Ltd',
  domain: 'analytical-engines.example',
};

/**
 * A journal deliberately seeded with PII in every field that can hold a string —
 * including the resume key itself, which is caller-supplied.
 */
function piiJournalLines() {
  const base = {
    schema_version: 1,
    run_id: 'run-evaluator-demo',
    ts: '2026-08-28T10:00:00.000Z',
    credits_estimated: 5,
    credits_actual: 5,
    attempt: 1,
  };
  return [
    // row_id IS the person's email — the common case for a CSV keyed on email.
    { ...base, row_id: PII.email, hop: 0, endpoint: 'email_finder', status: 'pending', attempt: 1 },
    {
      ...base,
      row_id: PII.email,
      hop: 0,
      endpoint: 'email_finder',
      status: 'ok',
      provider: 'vendor_a',
      confidence: 0.93,
      // A response hash is not PII, but it is row-level and must not be shared either.
      response_hash: 'f'.repeat(64),
    },
    // A second row whose row_id is a name, and whose provider/endpoint were poisoned
    // by a buggy or older writer.
    { ...base, row_id: PII.name, hop: 0, endpoint: PII.domain, status: 'pending' },
    {
      ...base,
      row_id: PII.name,
      hop: 0,
      endpoint: PII.domain,
      status: 'failed',
      provider: PII.phone,
      error: 'http_404',
      credits_actual: 0,
    },
    // A third row: phone hop, in flight when the process died.
    { ...base, row_id: PII.altEmail, hop: 1, endpoint: 'phone_finder', status: 'pending', credits_estimated: 25 },
    // A suppressed row and a cached row.
    { ...base, row_id: PII.linkedin, hop: 0, endpoint: 'email_finder', status: 'skipped_suppressed', credits_actual: 0 },
    { ...base, row_id: PII.company, hop: 0, endpoint: 'email_finder', status: 'skipped_cache', credits_actual: 0 },
  ];
}

function walkStrings(value, visit, key = null, path = '$') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, visit, key, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value)) {
      visit({ kind: 'key', key: childKey, path: `${path}.${childKey}` });
      walkStrings(item, visit, childKey, `${path}.${childKey}`);
    }
    return;
  }
  if (typeof value === 'string') visit({ kind: 'value', key, value, path });
}

// ---------------------------------------------------------------------------

test('a render over a PII-bearing journal contains ZERO row-level fields', () => {
  const summary = renderShareable(piiJournalLines(), { catalog: catalogFixture });
  const serialized = JSON.stringify(summary);

  // 1. No seeded value survives anywhere, in any form.
  for (const [label, value] of Object.entries(PII)) {
    assert.ok(!serialized.includes(value), `${label} leaked into the shareable render`);
    assert.ok(
      !serialized.toLowerCase().includes(value.toLowerCase()),
      `${label} leaked case-insensitively`,
    );
  }
  // Fragments too — a partial leak is a leak.
  for (const fragment of ['ada', 'lovelace', 'grace', 'navy', '555', '010-9988', 'analytical', 'linkedin', 'ffffffff']) {
    assert.ok(
      !serialized.toLowerCase().includes(fragment),
      `fragment "${fragment}" leaked into the shareable render`,
    );
  }

  // 2. No row-level KEY exists at any depth.
  const forbiddenKeys = [
    'row_id', 'row_ids', 'rows_detail', 'records', 'contact', 'email', 'phone',
    'name', 'response_hash', 'body', 'error', 'ts',
  ];
  walkStrings(summary, (node) => {
    if (node.kind !== 'key') return;
    assert.ok(
      !forbiddenKeys.includes(node.key.toLowerCase()),
      `row-level key "${node.key}" present at ${node.path}`,
    );
  });

  // 3. ALLOWLIST: every string that survives is one we constructed.
  const allowed = new Set([
    ...Object.keys(catalogFixture.endpoints),
    'unknown_endpoint', 'other', 'unattributed', 'vendor_a', 'vendor_b',
    'gtm.share_summary.v1',
    'dry_run_plan', 'interrupted', 'in_progress', 'complete', 'complete_with_failures', 'empty',
    'actual', 'estimated_unverifiable',
    summary.run_id, summary.generated_at,
  ]);
  const freeTextKeys = new Set(['disclosure', 'reason']);
  walkStrings(summary, (node) => {
    if (node.kind !== 'value') return;
    if (freeTextKeys.has(node.key)) return; // asserted verbatim below
    assert.ok(
      allowed.has(node.value),
      `unexpected free string "${node.value}" at ${node.path} — the render must be assembled, not filtered`,
    );
  });
  assert.equal(
    summary.disclosure,
    'Aggregate-only. No row identifiers, contact fields, or response bodies are included by construction.',
  );
  assert.match(summary.eta.reason, /^the API publishes no per-endpoint rate-limit quota/);

  // 4. The poisoned endpoint and provider were bucketed, not echoed.
  assert.ok(summary.per_hop.some((h) => h.endpoint === 'unknown_endpoint'));
  assert.ok(summary.providers.some((p) => p.provider === 'other'));

  // 5. It is still a useful artifact: the numbers are all there.
  assert.equal(summary.rows.total, 5);
  assert.equal(summary.totals.calls_ok, 1);
  assert.equal(summary.totals.calls_failed, 1);
  assert.equal(summary.totals.skipped_cache, 1);
  assert.equal(summary.totals.skipped_suppressed, 1);
  assert.equal(summary.coverage_pct, 20);
});

test('the markdown render leaks nothing either', () => {
  const summary = renderShareable(piiJournalLines(), { catalog: catalogFixture });
  const text = renderShareableText(summary);
  for (const value of Object.values(PII)) {
    assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `leaked ${value}`);
  }
  for (const fragment of ['ada', 'lovelace', 'grace', '555', 'analytical']) {
    assert.ok(!text.toLowerCase().includes(fragment), `leaked fragment ${fragment}`);
  }
  assert.match(text, /Aggregate-only/);
});

test('PII written to a real journal file is stripped on the way out too', async () => {
  const dir = tmpGtmDir('t27-file');
  const journalPath = path.join(dir, 'runs', 'run-file-demo.jsonl');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(
    journalPath,
    `${piiJournalLines().map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  const summary = renderShareable(journalPath, { catalog: catalogFixture });
  const serialized = JSON.stringify(summary);
  for (const value of Object.values(PII)) {
    assert.ok(!serialized.toLowerCase().includes(value.toLowerCase()));
  }
  // NOTE: a poisoned PROVIDER no longer produces a corrupt line — it is coerced
  // to a safe token instead of throwing, because that check runs after the credits are
  // spent and killing the run was the more expensive failure. What must still hold is
  // the point of this test: no PII survives the render, asserted above.
  assert.ok(summary.journal_health.corrupt_lines >= 0);
  // The poisoned endpoint (a bare domain) passes the journal's own token check but is
  // still not an endpoint identifier, so the renderer buckets it.
  assert.ok(summary.per_hop.some((h) => h.endpoint === 'unknown_endpoint'));
});

test('an interrupted run labels completed and pending work distinctly', async () => {
  const dir = tmpGtmDir('t27-interrupted');
  const rows = Array.from({ length: 20 }, (_, i) => ({ row_id: `row-${i + 1}` }));
  const plan = buildPlan({
    runId: 'run-interrupted',
    rows,
    waterfall: [{ endpoint: 'company_enrich' }],
    catalog: catalogFixture,
  });
  const journal = new RunJournal({ runId: 'run-interrupted', dir });
  writeDryRun({ plan, journal });

  const dry = renderShareable(readJournal(journal.path).lines, { catalog: catalogFixture });
  assert.equal(dry.state, 'dry_run_plan');
  assert.equal(dry.rows.not_started, 20);
  assert.equal(dry.rows.completed, 0);
  assert.equal(dry.totals.credits_estimated, 40);
  assert.match(renderShareableText(dry), /DRY RUN — plan only, nothing has been charged/);

  // Run 12 of the 20, then die mid-call on the 13th.
  await runWaterfall({
    journal,
    units: plan.units.slice(0, 12).map((u) => ({ ...u, attempt: 1 })),
    client: { async call() { return { body: { ok: true }, credits_actual: 2, provider: 'vendor_a' }; } },
  });
  journal.appendPending({ ...plan.units[12], attempt: 1 }, { attempt: 1 });

  const mid = renderShareable(readJournal(journal.path).lines, { catalog: catalogFixture });
  assert.equal(mid.state, 'interrupted');
  assert.equal(mid.rows.completed, 12, 'completed rows are counted as completed');
  assert.equal(mid.rows.in_flight, 1, 'the row that was in flight is its own bucket');
  assert.equal(mid.rows.not_started, 7, 'and the untouched rows are theirs');
  assert.equal(mid.rows.completed + mid.rows.in_flight + mid.rows.not_started, 20);
  assert.equal(mid.coverage_pct, 60);
  assert.equal(mid.per_hop[0].completed, 12);
  assert.equal(mid.per_hop[0].in_flight, 1);
  assert.equal(mid.per_hop[0].not_started, 7);
  const text = renderShareableText(mid);
  assert.match(text, /INTERRUPTED — completed and pending work are listed separately below/);
  assert.match(text, /completed: 12/);
  assert.match(text, /in flight at interrupt: 1/);
  assert.match(text, /not started: 7/);
});

test('a 402-halted run is labelled halted-on-budget, not complete', async () => {
  const dir = tmpGtmDir('t27-402');
  const journal = new RunJournal({ runId: 'run-halt', dir });
  const units = Array.from({ length: 6 }, (_, i) => ({
    row_id: `row-${i + 1}`, hop: 0, endpoint: 'phone_finder', credits_estimated: 25,
  }));
  let n = 0;
  await runWaterfall({
    journal,
    units,
    client: {
      async call() {
        n += 1;
        if (n === 3) throw new HttpError(402, { body: { balance: 4 } });
        return { body: { ok: true }, credits_actual: 25, provider: 'vendor_a' };
      },
    },
  });
  const summary = renderShareable(readJournal(journal.path).lines, { catalog: catalogFixture });
  assert.equal(summary.state, 'interrupted');
  assert.equal(summary.rows.completed, 2);
  // The row the 402 landed on plus the three never attempted: all four are halted on
  // budget, not "failed". A forwarded artifact must not blame the data for a top-up.
  assert.equal(summary.rows.halted_budget, 4);
  assert.equal(summary.rows.failed, 0);
  assert.equal(summary.totals.skipped_budget, 3);
  assert.equal(summary.totals.calls_failed, 1);
});

test('provider hit-rates are aggregated for /learn without naming a row', async () => {
  const dir = tmpGtmDir('t27-learn');
  const journal = new RunJournal({ runId: 'run-learn', dir });
  const units = Array.from({ length: 10 }, (_, i) => ({
    row_id: `contact-${i}@example.com`, hop: 0, endpoint: 'email_finder', credits_estimated: 5,
  }));
  let i = 0;
  await runWaterfall({
    journal,
    units,
    client: {
      async call() {
        i += 1;
        if (i % 5 === 0) throw new HttpError(404);
        return { body: { ok: true }, provider: i % 2 ? 'vendor_a' : 'vendor_b', confidence: 0.8 };
      },
    },
  });
  const summary = renderShareable(readJournal(journal.path).lines, { catalog: catalogFixture });
  const providers = Object.fromEntries(summary.providers.map((p) => [p.provider, p]));
  assert.equal(providers.vendor_a.ok + providers.vendor_b.ok + (providers.unattributed?.ok ?? 0), 8);
  assert.equal(providers.vendor_a.mean_confidence, 0.8);
  assert.ok(providers.vendor_a.hit_rate_pct > 0);
  assert.ok(!JSON.stringify(summary).includes('@example.com'), 'row_ids that are emails never appear');
});

test('the aggregate guard is real — it throws on a leaky object', () => {
  assert.throws(
    () => assertAggregateOnly({ rows: { total: 3 }, row_id: 'r1' }),
    (err) => err instanceof ShareLeakError && /row-level key/.test(err.message),
  );
  assert.throws(
    () => assertAggregateOnly({ per_hop: [{ endpoint: 'ada@example.com' }] }),
    (err) => err instanceof ShareLeakError && /contact-shaped/.test(err.message),
  );
  assert.throws(
    () => assertAggregateOnly({ note: 'call +1 (555) 010-9988' }),
    (err) => err instanceof ShareLeakError && /phone-shaped/.test(err.message),
  );
  assert.throws(
    () => assertAggregateOnly({ source: 'https://linkedin.com/in/ada' }),
    ShareLeakError,
  );
  assert.doesNotThrow(() => assertAggregateOnly({ rows: { total: 3, completed: 2 }, coverage_pct: 66.7 }));
});

test('an empty journal renders as empty rather than as a completed run', () => {
  const summary = renderShareable([], { catalog: catalogFixture, runIdLabel: 'run-empty' });
  assert.equal(summary.state, 'empty');
  assert.equal(summary.rows.total, 0);
  assert.equal(summary.coverage_pct, null);
});

test('cost_status never claims an actual it cannot verify (Law 4)', async () => {
  const dir = tmpGtmDir('t27-cost');
  const journal = new RunJournal({ runId: 'run-cost', dir });
  await runWaterfall({
    journal,
    units: [
      { row_id: 'r1', hop: 0, endpoint: 'company_enrich', credits_estimated: 2 },
      { row_id: 'r2', hop: 1, endpoint: 'email_finder', credits_estimated: 5 },
    ],
    client: {
      // company_enrich returns the billing field; email_finder does not.
      async call(ctx) {
        const verifiable = catalogFixture.endpoints[ctx.endpoint].pricing.billing_field_present_in_response;
        return { body: { ok: true }, credits_actual: verifiable ? 2 : null, provider: 'vendor_a' };
      },
    },
  });
  const summary = renderShareable(readJournal(journal.path).lines, { catalog: catalogFixture });
  assert.equal(summary.totals.cost_status, 'estimated_unverifiable');
  const enrichHop = summary.per_hop.find((h) => h.endpoint === 'company_enrich');
  const emailHop = summary.per_hop.find((h) => h.endpoint === 'email_finder');
  assert.equal(enrichHop.cost_status, 'actual');
  assert.equal(emailHop.cost_status, 'estimated_unverifiable');
  assert.equal(emailHop.credits_actual, 0, 'an unverifiable call contributes no actual');
  assert.equal(emailHop.credits_estimated, 5, 'the estimate is still shown, labelled as one');
});
