// The $R CLI and `enrich`, the first end-to-end paid path.
//
// The three verify criteria:
//   1. `enrich --dry-run` makes ZERO calls and prints a plan
//   2. the real run writes a journal line AND a ledger line per hop
//   3. kill at row 380 of 500, resume pays for 120
//
// Zero-call is proven with a client that CANNOT call (throws on any access), not a
// counter that reports zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp, okJson, okWithoutBillingField, insufficientCredits, tooManyRequests } from '../helpers/index.mjs';
import { runEnrich, loadCatalog, rowIdFor, parseCsv, toDescriptor, buildWaterfall } from '../../_lib/enrich.mjs';
import { buildRequest, RichApiClient, MissingApiKey } from '../../_lib/client.mjs';
import { ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore } from '../../_lib/suppression.mjs';
import { readJournal } from '../../_lib/journal.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

/** A tree with a suppression store, plus an input list. Never the repo's own gtm/. */
function fixture (t, { rows, suppress = [] } = {}) {
  const tree = makeGtmTree({ prefix: 't31-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: tree.root });
  const header = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const csv = [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n') + '\n';
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, csv);
  return { tree, input };
}

const person = (i) => ({
  first_name: `First${i}`,
  last_name: `Last${i}`,
  company_domain: `acme${i}.example`,
  linkedin_url: `https://linkedin.com/in/person-${i}`,
});

/** A client that cannot make a call. Any use is a test failure, not a counted zero. */
const cannotCall = () => new Proxy({}, {
  get () { throw new Error('ZERO-CALL VIOLATION: the dry run touched the HTTP client'); },
});

// ---------------------------------------------------------------------------
// 1. dry run
// ---------------------------------------------------------------------------

test('enrich --dry-run makes ZERO calls and produces a reviewable plan', async (t) => {
  const { tree, input } = fixture(t, { rows: Array.from({ length: 25 }, (_, i) => person(i)) });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, budget: 1000,
    api: cannotCall(),
  });

  assert.equal(res.mode, 'dry-run');
  assert.equal(res.calls_made, 0);

  // The plan is reviewable: hops, per-row cost, and a total, not just a number.
  assert.ok(res.plan.totals.calls_planned > 0, 'a plan with no calls proves nothing');
  assert.equal(res.plan.rows.length, 25);
  assert.ok(res.plan.per_hop.every(h => typeof h.credits_estimated === 'number'));
  assert.match(res.text, /credits/i);
  assert.equal(res.plan.dry_run, true);

  // Every planned unit is journalled `pending` with attempt 0 = planned, never attempted.
  const { lines } = readJournal(res.journal_path);
  assert.equal(lines.length, res.plan.units.length);
  assert.ok(lines.every(l => l.attempt === 0), 'a dry-run line must never look like an attempt');
  assert.ok(lines.every(l => l.credits_actual === null || l.credits_actual === 0));

  // No ledger at all: nothing was spent, so there is nothing to account for.
  assert.equal(fs.existsSync(path.join(tree.root, 'gtm', 'api-calls.jsonl')), false);
});

test('the dry-run plan prices every hop from the CATALOG, never a typed number', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(1)] });
  const res = await runEnrich({ input, root: tree.root, catalog: CATALOG, dryRun: true, api: cannotCall() });

  for (const hop of res.plan.per_hop) {
    if (hop.calls_planned === 0) continue;
    const fromCatalog = CATALOG.endpoints[hop.endpoint].pricing.credits_per_call;
    assert.equal(hop.unit_credits, fromCatalog,
      `${hop.endpoint} priced at ${hop.unit_credits} but the catalog says ${fromCatalog}`);
  }
  assert.equal(res.plan.catalog_provenance.spec_sha256, CATALOG.spec_sha256,
    'the plan must name the spec it was priced against');
});

// ---------------------------------------------------------------------------
// 2. the real run
// ---------------------------------------------------------------------------

test('a real run writes a journal line AND a ledger line per hop', async (t) => {
  const { tree, input } = fixture(t, { rows: Array.from({ length: 5 }, (_, i) => person(i)) });
  const http = createFakeHttp({
    fallback: (call) => (call.endpoint === 'email_finder'
      ? okJson({ email: `found@${call.endpoint}.example`, provider: 'provider_a', confidence: 'high', credits_charged: 5 })
      : okJson({ title: 'VP Sales', company_name: 'Acme', credits_charged: 1 })),
  });
  const api = new RichApiClient({ apiKey: 'test-key', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 1000, api,
    verify: false, confirm: async () => true,
    output: 'out.csv',
  });

  assert.equal(res.mode, 'run');
  assert.ok(res.exec.ok > 0, 'nothing succeeded');

  const { lines } = readJournal(res.journal_path);
  const results = lines.filter(l => l.status !== 'pending');
  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);

  // One ledger line per HTTP call; journal carries a before and an after for each.
  assert.equal(ledger.length, res.http_calls, 'every call must reach the ledger');
  assert.equal(lines.filter(l => l.status === 'pending').length, res.http_calls, 'missing a BEFORE write');
  assert.equal(results.filter(l => l.status === 'ok').length, res.http_calls, 'missing an AFTER write');

  // Provider attribution is journalled — this is the whole input to /learn.
  const emailHops = results.filter(l => l.endpoint === 'email_finder');
  assert.ok(emailHops.length > 0);
  assert.ok(emailHops.every(l => l.provider === 'provider_a'), 'provider must be journalled per hop');

  // The output list exists and went through the suppression filter.
  assert.ok(fs.existsSync(path.join(tree.root, 'out.csv')));
  assert.equal(res.output.suppressed, 0);
});

test('an unverifiable charge is never written as an actual', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(1)] });
  // A 200 that carries no billing field at all.
  const http = createFakeHttp({ fallback: okWithoutBillingField({ title: 'CTO', company_name: 'Acme' }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api, verify: false, confirm: async () => true,
  });

  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(ledger.length > 0);
  for (const l of ledger) {
    if (l.cost_status === 'actual') {
      assert.notEqual(l.credits_actual, null, 'an `actual` row must carry a real number');
    } else {
      assert.equal(l.cost_status, 'estimated_unverifiable');
      assert.equal(l.credits_actual, null, 'an estimate must never be dressed up as an actual');
    }
  }
  assert.ok(res.ledger_totals.lines > 0);
});

// ---------------------------------------------------------------------------
// 3. resume — the headline criterion
// ---------------------------------------------------------------------------

test('killed at row 380 of 500, the resume pays for 120 and not 500', async (t) => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ ...person(i), email: `p${i}@acme${i}.example` }));
  const { tree, input } = fixture(t, { rows });

  // Succeed 380 times, then the credits run out. A 402 aborts the run and journals
  // every remaining unit `skipped_budget`, which is exactly the state a kill leaves.
  let served = 0;
  const http = createFakeHttp({
    fallback: () => (served++ < 380
      ? okJson({ title: 'VP', company_name: 'Acme', credits_charged: 1 })
      : insufficientCredits({ balance: '0', reserved: '1' })),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const first = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, confirm: async () => true, runId: 'run-kill-test',
  });

  // Rows already carry an email, so email_finder is not applicable: one unit per row.
  assert.equal(first.plan.units.length, 500, 'expected exactly one unit per row');
  assert.equal(first.exec.ok, 380);
  assert.ok(first.exec.aborted, 'a 402 must abort the run, not keep spending');
  assert.equal(first.exec.abort_reason, 'insufficient_credits');

  // Now resume. Same list, same run id.
  const http2 = createFakeHttp({ fallback: okJson({ title: 'VP', company_name: 'Acme', credits_charged: 1 }) });
  const api2 = new RichApiClient({ apiKey: 'k', fetchImpl: http2.fetch });
  const second = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api: api2,
    verify: false, confirm: async () => true, resume: 'run-kill-test',
  });

  assert.equal(second.resume.stats.units_done, 380, 'the 380 completed rows must not be re-paid');
  assert.equal(second.resume.stats.units_todo, 120);
  assert.equal(second.http_calls, 120, `resume made ${second.http_calls} calls; it must make 120, not 500`);
  assert.equal(api2.callCount, 120);
});

test('a resume never re-pays a suppressed or already-ok row', async (t) => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...person(i), email: `p${i}@acme${i}.example` }));
  const { tree, input } = fixture(t, { rows, suppress: ['p3@acme3.example'] });

  let served = 0;
  const http = createFakeHttp({
    fallback: () => (served++ < 4 ? okJson({ title: 'VP', credits_charged: 1 }) : insufficientCredits()),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api,
    verify: false, confirm: async () => true, runId: 'run-sup',
  });

  const http2 = createFakeHttp({ fallback: okJson({ title: 'VP', credits_charged: 1 }) });
  const api2 = new RichApiClient({ apiKey: 'k', fetchImpl: http2.fetch });
  const second = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api: api2,
    verify: false, confirm: async () => true, resume: 'run-sup', output: 'out.csv',
  });

  const endpoints = http2.calls.map(c => c.endpoint);
  assert.equal(endpoints.length, second.http_calls);
  // 10 rows, 1 suppressed => at most 9 can ever be called across both runs.
  const { lines } = readJournal(second.journal_path);
  const suppressedLines = lines.filter(l => l.status === 'skipped_suppressed');
  assert.ok(suppressedLines.length >= 1, 'the suppressed row must be journalled as skipped');
  assert.equal(second.output.written, 9, 'the suppressed contact must not reach the output list');
});

// ---------------------------------------------------------------------------
// gates, suppression, and the request contract
// ---------------------------------------------------------------------------

test('no suppression store means no run, and no call', async (t) => {
  const tree = makeGtmTree({ prefix: 't31-nosup-' });
  t.after(() => tree.cleanup());
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, 'first_name,last_name,company_domain\nA,B,acme.example\n');

  await assert.rejects(
    () => runEnrich({ input, root: tree.root, catalog: CATALOG, budget: 100, api: cannotCall(), confirm: async () => true }),
    (err) => err.name === 'SuppressionUnavailableError',
    'a suppression check we could not run is not a passing one',
  );
});

test('phone_finder always asks, even with budget to spare', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(1)] });
  let asked = null;
  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 100000, api: cannotCall(),
    phone: true, verify: false,
    confirm: async ({ gate }) => { asked = gate; return false; },
  });
  assert.equal(res.mode, 'declined');
  assert.equal(res.calls_made, 0, 'declining must spend nothing');
  assert.ok(asked, 'phone_finder must prompt regardless of remaining budget');
  assert.ok(asked.confirms.some(c => /phone_finder/.test(JSON.stringify(c))),
    'the confirm must name phone_finder as the reason');
});

test('the request contract refuses an empty POST on the 25-credit call', () => {
  // The spec declares NO required fields for phone_finder and sets
  // requestBody.required = false, so an empty POST is spec-valid. It must never happen.
  assert.equal(buildRequest('phone_finder', {}).ok, false);
  assert.equal(buildRequest('phone_finder', { first_name: 'A' }).ok, false);
  assert.equal(buildRequest('phone_finder', { first_name: 'A', last_name: 'B' }).ok, false);
  assert.equal(buildRequest('phone_finder', { linkedin_url: 'https://x' }).ok, true);
  assert.equal(buildRequest('phone_finder', { first_name: 'A', last_name: 'B', domain: 'acme.example' }).ok, true);

  // email_finder names it company_domain, phone_finder names it domain, and a list CSV
  // uses whichever it likes. Same concept, so RECORD_MAPPINGS fills one from the other:
  // a rename, not a semantic guess. Refusing it would make a `domain` column unusable.
  assert.equal(buildRequest('email_finder', { first_name: 'A', last_name: 'B', domain: 'acme.example' }).ok, true);
  assert.equal(buildRequest('email_finder', { first_name: 'A', last_name: 'B', company_domain: 'acme.example' }).ok, true);
  assert.equal(buildRequest('phone_finder', { first_name: 'A', last_name: 'B', company_domain: 'acme.example' }).ok, true);
  // But an ABSENT value is never invented, on any endpoint.
  assert.equal(buildRequest('email_finder', { first_name: 'A', last_name: 'B' }).ok, false);
  assert.equal(buildRequest('enrich_profile', {}).ok, false);
  // linkedin_url -> url is the mapping that the planner and executor must share.
  assert.equal(buildRequest('enrich_profile', { linkedin_url: 'https://linkedin.com/in/x' }).ok, true);
  assert.deepEqual(buildRequest('enrich_profile', { linkedin_url: 'https://x' }).payload, { url: 'https://x' });

  // Empty strings are not values.
  assert.equal(buildRequest('email_verifier', { email: '   ' }).ok, false);
  assert.equal(buildRequest('email_verifier', { email: 'a@b.example' }).ok, true);
});

test('row_id carries no contact data, so the journal cannot leak one', async (t) => {
  const rec = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', linkedin_url: 'https://linkedin.com/in/ada' };
  const id = rowIdFor(rec, 7);
  for (const v of Object.values(rec)) {
    assert.ok(!id.includes(v), `row_id leaked ${v}`);
  }
  assert.match(id, /^r\d{5}-[a-f0-9]{12}$/);
  assert.equal(rowIdFor(rec, 7), id, 'row_id must be stable, or resume breaks');

  const { tree, input } = fixture(t, { rows: [rec] });
  const res = await runEnrich({ input, root: tree.root, catalog: CATALOG, dryRun: true, api: cannotCall() });
  const raw = fs.readFileSync(res.journal_path, 'utf8');
  for (const v of Object.values(rec)) {
    assert.ok(!raw.includes(v), `the journal contains contact data: ${v}`);
  }
});

test('a 429 storm retries with Retry-After and charges the unit once', async (t) => {
  const { tree, input } = fixture(t, { rows: [{ ...person(1), email: 'p1@acme1.example' }] });
  let n = 0;
  const http = createFakeHttp({
    fallback: () => (n++ < 2 ? tooManyRequests({ retryAfter: 0 }) : okJson({ title: 'VP', credits_charged: 1 })),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 100, api, verify: false,
    confirm: async () => true, sleep: async () => {},
  });

  assert.equal(res.exec.retries, 2);
  assert.equal(res.exec.ok, 1);
  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const charged = ledger.filter(l => (l.credits_actual ?? 0) > 0);
  assert.equal(charged.length, 1, '3 HTTP attempts must charge the unit once, not three times');
});

// ---------------------------------------------------------------------------
// the CLI itself
// ---------------------------------------------------------------------------

test('the CLI runs, and refuses clearly without an API key', () => {
  const bin = path.join(REPO, 'bin', 'richapi.mjs');
  const help = execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  assert.match(help, /richapi enrich/);
  assert.match(help, /--dry-run/);

  const gates = execFileSync(process.execPath, [bin, 'gates', 'session_budget.fractions.stop'], { encoding: 'utf8' });
  assert.equal(gates.trim(), '1');

  // An unknown command fails loudly rather than doing something surprising.
  assert.throws(() => execFileSync(process.execPath, [bin, 'nonsense'], { encoding: 'utf8', stdio: 'pipe' }));

  // A key is required for a real call, but never for --dry-run.
  const c = new RichApiClient({ apiKey: null });
  assert.throws(() => c.requireKey(), (e) => e instanceof MissingApiKey);
});

// --- `--yes` may not run uncapped ------------------------------------------
//
// Found by a RevOps review and reproduced before this test was written:
//
//   createSession with no budget  -> budget_credits: null
//   gates.budgetPrompt(session)   -> CONFIRM, not STOP
//   bin/richapi.mjs `if (flags.yes) return true`  -> accepts it
//   run.mjs checkBudget `if (budget === null) return null`  -> no ceiling
//
// So `richapi enrich list.csv --yes` spent with no cap at all, on the very path
// the help text documents for scripts. Every gate in gates.yaml fires on a
// FRACTION of the session budget, so a null budget is not "no gate crossed" —
// it is no gate. Interactively a human answers the prompt; unattended there is
// nobody to ask, so the run must refuse rather than proceed uncapped.

test('`--yes` without `--budget` is refused, and nothing is written', (t) => {
  const { tree, input } = fixture(t, { rows: [person(1)] });
  const bin = path.join(REPO, 'bin', 'richapi.mjs');
  const out = path.join(tree.root, 'out.csv');

  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [bin, 'enrich', input, '--yes', '--out', out],
      { encoding: 'utf8', stdio: 'pipe', cwd: tree.root,
        env: { ...process.env, richapi_API_KEY: 'must-never-be-used' } });
  } catch (e) {
    status = e.status;
    stderr = String(e.stderr ?? '');
  }

  assert.equal(status, 2, 'a usage error, not a run');
  assert.match(stderr, /--yes requires --budget/);
  assert.match(stderr, /uncapped/);
  assert.equal(fs.existsSync(out), false, 'the run never started, so it wrote no output');
});

test('`--dry-run --yes` needs no budget, because it cannot spend', (t) => {
  const { tree, input } = fixture(t, { rows: [person(1)] });
  const bin = path.join(REPO, 'bin', 'richapi.mjs');

  // Must NOT be the usage error above. A dry run makes zero calls, so requiring
  // a ceiling on it would block the one command that prices a run for free.
  const outText = execFileSync(process.execPath, [bin, 'enrich', input, '--yes', '--dry-run'],
    { encoding: 'utf8', stdio: 'pipe', cwd: tree.root });
  assert.doesNotMatch(outText, /--yes requires --budget/);
});

test('descriptors never carry contact values into the planner', (t) => {
  const tree = makeGtmTree({ prefix: 't31-desc-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const store = loadSuppressionStore({ root: tree.root });
  const rec = { first_name: 'Ada', last_name: 'L', email: 'ada@example.com', company_domain: 'x.example' };
  const { descriptor } = toDescriptor(rec, 0, { store });

  assert.deepEqual(Object.keys(descriptor).sort(), ['cached', 'has', 'row_id', 'suppressed']);
  const json = JSON.stringify(descriptor);
  for (const v of Object.values(rec)) assert.ok(!json.includes(v), `descriptor leaked ${v}`);
});

test('the waterfall order is cheapest-capable, and phone is opt-in', () => {
  const base = buildWaterfall({});
  assert.deepEqual(base.map(h => h.endpoint), ['enrich_profile', 'email_finder', 'email_verifier']);
  assert.ok(!base.some(h => h.endpoint === 'phone_finder'), 'the 25-credit hop is never on by default');

  const withPhone = buildWaterfall({ phone: true });
  assert.ok(withPhone.some(h => h.endpoint === 'phone_finder'));

  // NOT price-sorted, and it must not be. "Cheapest capable" means picking the
  // cheapest endpoint capable of each job, not ordering the jobs by price: you cannot
  // verify an email (2cr) before finding it (5cr). What must hold is the dependency
  // order, and that the free local work happens before the expensive remote work.
  const order = base.map(h => h.endpoint);
  assert.ok(order.indexOf('email_finder') < order.indexOf('email_verifier'),
    'you cannot verify an email before finding one');
  assert.ok(order.indexOf('enrich_profile') < order.indexOf('email_finder'),
    'profile enrichment (1cr) can supply the company that email_finder (5cr) needs');

  // The single most expensive call in the API is never reached without an explicit ask.
  const phoneCost = CATALOG.endpoints.phone_finder.pricing.credits_per_call;
  const maxDefault = Math.max(...base.map(h => CATALOG.endpoints[h.endpoint].pricing.credits_per_call));
  assert.ok(phoneCost > maxDefault, 'phone_finder should be the outlier that justifies opt-in');
});

test('parseCsv handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('first_name,company_name\r\n"Ada","Acme, Inc."\r\n"Say ""hi""",Beta\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].company_name, 'Acme, Inc.');
  assert.equal(rows[1].first_name, 'Say "hi"');
});
