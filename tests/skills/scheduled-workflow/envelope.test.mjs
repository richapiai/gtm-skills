// The tests that bite for /scheduled-workflow.
//
// Every one of them runs the script the SKILL.md actually ships, extracted verbatim and
// invoked the way the page tells the user to invoke it. A test-only reimplementation
// would stay green while the shipped skill rotted, and the whole property being asserted
// here is "the thing that runs at three in the morning refuses".
//
// The plan artifacts are produced by the REAL CLI (`richapi ... --dry-run --json`), so a
// plan shape the runtime never emits cannot make these pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  projectWith, planFile, gatesWithRequestedKeys, gatesFileWith, gatesFileWithout,
  catalogFileWith, runSchedule, lline, REQUESTED_SCHEDULE_GATES,
} from './helpers.mjs';
import { loadGates, hasGate, gateValue } from '../../../_lib/gates.mjs';

/** A project with two input lists and an armed schedule over the small one. */
function armed ({ runs = 4, everyHours = 168, now = '2026-08-01T00:00:00.000Z', mutateGates } = {}) {
  const proj = projectWith({});
  // enrich_company takes a LinkedIn company, not a domain — measured live 2026-09-18,
  // a bare domain answers 404. A domain-keyed fixture plans as zero calls now, which is
  // the point of the refusal and would make every envelope below vacuous.
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\nhttps://www.linkedin.com/company/globex\n');
  fs.writeFileSync(path.join(proj.root, 'big.csv'),
    'company_linkedin_url\n' + Array.from({ length: 9 },
      (_, i) => `https://www.linkedin.com/company/c${i}`).join('\n') + '\n');
  const small = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv'], 'plan.json');
  const big = planFile(proj, ['call', 'enrich_company', '--in', 'big.csv'], 'big.json');
  const gatesFile = gatesWithRequestedKeys(proj.root, mutateGates);
  const perRun = small.doc.plan.totals.credits_estimated;
  const env = { ROOT: proj.root, ID: 'weekly', GATES_FILE: gatesFile };
  const res = runSchedule({
    ...env,
    MODE: 'arm',
    PLAN: small.path,
    RUNS: runs,
    EVERY_HOURS: everyHours,
    CMD: JSON.stringify(['richapi', 'call', 'enrich_company', '--in', 'accounts.csv']),
    APPROVE: String(perRun * runs),
    NOW: now,
  });
  assert.equal(res.status, 0, `arm should have succeeded:\n${res.out}`);
  return { proj, env, small, big, perRun, envelope: perRun * runs, gatesFile };
}

const logLines = (proj) => proj.readJsonl('gtm/schedules/weekly/runs.jsonl');
const envelopeDoc = (proj) => JSON.parse(proj.read('gtm/schedules/weekly/envelope.json'));

// --- the headline: over the envelope means STOP, and nothing spent ----------

test('a scheduled run whose plan exceeds the approved envelope STOPS and spends nothing', () => {
  const { proj, env, big } = armed();
  const r = runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });

  assert.equal(r.status, 3, `expected a STOP exit:\n${r.out}`);
  assert.match(r.out, /envelope_exceeded/);
  assert.match(r.out, /nothing was spent/i);
  // It must NOT hand a budget back to the caller. The scheduled command reads
  // RICHAPI_SCHEDULE_BUDGET from this output; printing one on a stop would let the
  // shell run step 3 anyway.
  assert.ok(!/RICHAPI_SCHEDULE_BUDGET/.test(r.out),
    'a stop must not emit a budget the next command could pick up');
  // And nothing was consumed: the envelope is untouched.
  const e = envelopeDoc(proj);
  assert.equal(e.runs_used, 0);
  assert.equal(e.credits_spent_ceiling, 0);
});

test('a plan over the envelope is not truncated to fit', () => {
  const { env, big, perRun } = armed();
  const r = runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.match(r.out, /not truncated to fit/i);
  // No partial budget of any size is offered.
  assert.ok(!new RegExp(`BUDGET=${perRun}`).test(r.out));
});

test('a plan that still fits but exhausts the remaining envelope stops on exhaustion', () => {
  const { proj, env, small, perRun, envelope } = armed({ runs: 2 });
  // Burn the whole envelope through the ledger, honestly.
  proj.write('gtm/api-calls.jsonl',
    Array.from({ length: envelope / perRun }, (_, i) => JSON.stringify(
      lline({ runId: `spent-${i}`, endpoint: 'enrich_company', estimated: perRun,
        actual: perRun, costStatus: 'actual' }))).join('\n') + '\n');
  for (let i = 0; i < envelope / perRun; i += 1) {
    const rec = runSchedule({ ...env, MODE: 'record', RUN: `spent-${i}`,
      NOW: new Date(Date.parse('2026-08-02T00:00:00.000Z') + i * 864000000).toISOString() });
    assert.equal(rec.status, 0, rec.out);
  }
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2027-01-01T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /runs_exhausted|envelope_exhausted/);
});

// --- repricing --------------------------------------------------------------

test('a repricing since approval is detected and stops the run, naming the endpoint', () => {
  const { proj, env, small } = armed();
  const dearer = catalogFileWith(proj.root, (d) => {
    d.endpoints.enrich_company.pricing.credits_per_call = 9;
  });
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, CATALOG_FILE: dearer,
    NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /\[repriced\]/);
  assert.match(r.out, /enrich_company/);
  assert.match(r.out, /approved:/);
  assert.match(r.out, /now:/);
  assert.equal(envelopeDoc(proj).runs_used, 0);
});

test('a repricing DOWNWARD stops the run too — direction is not the test', () => {
  const { env, small, proj } = armed();
  const cheaper = catalogFileWith(proj.root, (d) => {
    d.endpoints.enrich_company.pricing.credits_per_call = 0.25;
  });
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, CATALOG_FILE: cheaper,
    NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3, 'a cheaper price is still a plan whose cost basis moved');
  assert.match(r.out, /\[repriced\]/);
  assert.match(r.out, /higher or lower/i);
});

test('a change to billing SEMANTICS with no change to the number also stops', () => {
  // The failure that once disabled post_keyword_search: the credit figure held still while
  // what it was charged against moved. A fingerprint over the credit alone misses it.
  const { env, small, proj } = armed();
  const moved = catalogFileWith(proj.root, (d) => {
    d.endpoints.enrich_company.pricing.result_count_field = 'totalElements';
    d.endpoints.enrich_company.pricing.billing_field_present_in_response = false;
  });
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, CATALOG_FILE: moved,
    NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /\[repriced\]/);
});

test('an endpoint that vanished from the catalog stops the run', () => {
  const { env, small, proj } = armed();
  const gone = catalogFileWith(proj.root, (d) => { delete d.endpoints.enrich_company; });
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, CATALOG_FILE: gone,
    NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /no longer in the catalog/);
});

// --- unattended, confirm is stop -------------------------------------------

test('an always-ask endpoint cannot be armed as a schedule at all', () => {
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'people.csv'),
    'linkedin_url\nhttps://linkedin.com/in/a\nhttps://linkedin.com/in/b\n');
  const plan = planFile(proj, ['call', 'phone_finder', '--in', 'people.csv'], 'phone.json');
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const r = runSchedule({
    ROOT: proj.root, ID: 'phones', GATES_FILE: gatesFile, MODE: 'arm', PLAN: plan.path,
    RUNS: 2, EVERY_HOURS: 168, CMD: JSON.stringify(['x']),
    APPROVE: String(plan.doc.plan.totals.credits_estimated * 2), NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /gate_confirm/);
  assert.match(r.out, /always_ask\.endpoints/);
  assert.ok(!proj.exists('gtm/schedules/phones/envelope.json'),
    'a refusal must write no envelope');
});

test('a multi-page search cannot be armed — the page gate asks a human per page', () => {
  const proj = projectWith({});
  const plan = planFile(proj,
    ['search', 'people_search', '--param', 'title=CTO', '--pages', '3'], 'search.json');
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const r = runSchedule({
    ROOT: proj.root, ID: 'sweep', GATES_FILE: gatesFile, MODE: 'arm', PLAN: plan.path,
    RUNS: 2, EVERY_HOURS: 168, CMD: JSON.stringify(['x']),
    APPROVE: String(plan.doc.plan.totals.credits_estimated * 2), NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /unbounded_endpoints\.policy/);
  assert.match(r.out, /page 2/);
});

test('the session_budget carve-out is exactly that — a carve-out, not a hole', () => {
  // A session_budget CONFIRM is accepted (the envelope answered it). A session_budget
  // STOP is not: the same gate family still refuses when the plan is over budget.
  const { env, big, small } = armed();
  const ok = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(ok.status, 0, `the small plan exhausts its budget exactly, which is a `
    + `session_budget CONFIRM; the envelope answered it:\n${ok.out}`);
  const stopped = runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(stopped.status, 3);
  assert.match(stopped.out, /session_budget\.fractions\.stop/,
    'the budget STOP must still fire; only the confirm is answered in advance');
});

// --- fail closed ------------------------------------------------------------

test('the keys this skill reads are merged, at the values this suite is calibrated to', () => {
  // Pinning the VALUES, not just their presence: this suite moves each of them in a
  // gates FILE and watches the arming arithmetic move with it, so a silent edit to the
  // shipped numbers must be a red run rather than a quiet change of what a schedule
  // may spend while nobody is awake.
  const gates = loadGates();
  for (const [k, expected] of Object.entries(REQUESTED_SCHEDULE_GATES)) {
    const dotted = `skills.scheduled_workflow.${k}`;
    assert.ok(hasGate(gates, dotted), `${dotted} does not resolve`);
    assert.equal(gateValue(gates, dotted), expected,
      `${dotted} shipped as ${gateValue(gates, dotted)}, not ${expected} — reconcile deliberately`);
  }
});

test('a missing gate key is a STOP, not "no gate"', () => {
  // Was: run with no --gates at all, because the shipped file carried no
  // skills.scheduled_workflow block. It carries one now, so the fail-closed input is
  // MADE: a copy of the real file with that block deleted. Same law-5 path, but it
  // stays true after this merge and after every future one, because nothing about it
  // depends on what the shipped file happens to contain.
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const stripped = gatesFileWithout(proj.root, 'scheduled_workflow');

  // The strip is asserted directly — a no-op strip would make this test green and
  // vacuous, which is the one way a fail-closed assertion rots without anyone noticing.
  const doc = parseYaml(fs.readFileSync(stripped, 'utf8'));
  assert.equal('scheduled_workflow' in (doc.skills ?? {}), false,
    'the stripped gates file still carries skills.scheduled_workflow');

  const r = runSchedule({
    ROOT: proj.root, ID: 'weekly', MODE: 'arm', PLAN: plan.path, RUNS: 2, EVERY_HOURS: 168,
    CMD: JSON.stringify(['x']), APPROVE: '2', NOW: '2026-08-01T00:00:00.000Z',
    GATES_FILE: stripped,
  });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /gates\.yaml key missing: skills\.scheduled_workflow\./);
  assert.match(r.out, /law 5/);
  assert.ok(!proj.exists('gtm/schedules/weekly/envelope.json'),
    'nothing may be armed off a gates file that cannot bound it');
});

test('and on the SHIPPED gates.yaml the same arm succeeds — the keys are merged', () => {
  // The counterpart, on the default path a real install takes: no GATES_FILE at all.
  // Without it the STOP above could be any refusal; with it, the STOP is provably the
  // missing block and nothing else.
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const r = runSchedule({
    ROOT: proj.root, ID: 'weekly', MODE: 'arm', PLAN: plan.path, RUNS: 2, EVERY_HOURS: 168,
    CMD: JSON.stringify(['x']), APPROVE: '2', NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /gates\.yaml key missing/);
  assert.ok(proj.exists('gtm/schedules/weekly/envelope.json'));
});

test('a deleted envelope is a stop, never "no envelope, no limit"', () => {
  const { proj, env, small } = armed();
  fs.rmSync(path.join(proj.root, 'gtm', 'schedules', 'weekly', 'envelope.json'));
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /no_envelope/);
});

test('a corrupted envelope is a stop', () => {
  const { proj, env, small } = armed();
  proj.write('gtm/schedules/weekly/envelope.json', '{ not json');
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /unparseable/);
});

test('anyone can stop every schedule in the workspace with one file', () => {
  const { proj, env, small } = armed();
  proj.write('gtm/schedules/DISARMED', '');
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /disarmed/);
});

test('an approval expires', () => {
  const { env, small } = armed();
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2027-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /approval_expired/);
});

test('the expiry comes from the gate file, not from the script', () => {
  const short = armed({
    now: '2026-08-01T00:00:00.000Z',
    mutateGates: (doc) => { doc.skills.scheduled_workflow.approval_max_age_days = 1; },
  });
  const r = runSchedule({ ...short.env, MODE: 'check', PLAN: short.small.path,
    NOW: '2026-08-03T00:00:00.000Z' });
  assert.equal(r.status, 3, 'with a one-day approval life, two days later must be expired');
  assert.match(r.out, /approval_expired/);
});

test('a plan reaching an endpoint nobody approved stops as drift', () => {
  const { proj, env, small } = armed();
  // Rewrite the envelope's approved endpoint set, which is the same shape as a fresh
  // plan growing a hop the user never saw.
  const e = envelopeDoc(proj);
  e.endpoints = ['email_verifier'];
  e.price_fingerprint = { email_verifier: e.price_fingerprint.enrich_company };
  proj.write('gtm/schedules/weekly/envelope.json', e);
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-09T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /plan_drift/);
  assert.match(r.out, /Nobody named that call/);
});

// --- approval discipline ----------------------------------------------------

test('arming needs the exact envelope total typed — "yes" is not an approval', () => {
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\nhttps://www.linkedin.com/company/globex\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const base = {
    ROOT: proj.root, ID: 'weekly', GATES_FILE: gatesFile, MODE: 'arm', PLAN: plan.path,
    RUNS: 4, EVERY_HOURS: 168, CMD: JSON.stringify(['x']), NOW: '2026-08-01T00:00:00.000Z',
  };
  for (const answer of ['y', 'yes', '', 'YES', '80']) {
    const r = runSchedule({ ...base, APPROVE: answer });
    assert.equal(r.status, 3, `"${answer}" must not approve a schedule`);
    assert.ok(!proj.exists('gtm/schedules/weekly/envelope.json'));
  }
  const ok = runSchedule({ ...base, APPROVE: '8' });
  assert.equal(ok.status, 0, ok.out);
  assert.ok(proj.exists('gtm/schedules/weekly/envelope.json'));
});

test('the schedule command must be given as an exact argv, not prose', () => {
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const r = runSchedule({
    ROOT: proj.root, ID: 'weekly', GATES_FILE: gatesFile, MODE: 'arm', PLAN: plan.path,
    RUNS: 2, EVERY_HOURS: 168, CMD: 'enrich the accounts every week', APPROVE: '2',
    NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 2);
  assert.match(r.out, /nobody can audit/);
});

test('an envelope may only be bound to a dry run, never to a run that spent', () => {
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const doc = JSON.parse(proj.read('plan.json'));
  doc.mode = 'run';
  proj.write('ran.json', doc);
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const r = runSchedule({
    ROOT: proj.root, ID: 'weekly', GATES_FILE: gatesFile, MODE: 'arm',
    PLAN: path.join(proj.root, 'ran.json'), RUNS: 2, EVERY_HOURS: 168,
    CMD: JSON.stringify(['x']), APPROVE: '2', NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 2);
  assert.match(r.out, /free and makes zero calls/);
  assert.ok(plan.doc.mode === 'dry-run');
});

// --- burndown honesty -------------------------------------------------------

test('the envelope burns down by the receipt CEILING, never the floor', () => {
  const { proj, env, perRun } = armed();
  // One verified credit, one unverifiable estimate. Floor 1, ceiling 2.
  proj.write('gtm/api-calls.jsonl', [
    lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' }),
    lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: null,
      costStatus: 'estimated_unverifiable' }),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const r = runSchedule({ ...env, MODE: 'record', RUN: 'r1', NOW: '2026-08-02T00:00:00.000Z' });
  assert.equal(r.status, 0, r.out);
  const e = envelopeDoc(proj);
  assert.equal(e.credits_spent_ceiling, 2, 'burned the ceiling, not the floor of 1');
  assert.equal(e.runs_used, 1);
  // And the spend is spoken about by the receipt, as a range.
  assert.match(r.out, /at least 1 credits, up to 2/);
  assert.equal(perRun, 2);
});

test('a run that came in over its per-run ceiling halts the schedule', () => {
  const { proj, env, small } = armed();
  proj.write('gtm/api-calls.jsonl', Array.from({ length: 6 }, (_, i) => JSON.stringify(
    lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' }),
  )).join('\n') + '\n');
  const rec = runSchedule({ ...env, MODE: 'record', RUN: 'r1', NOW: '2026-08-02T00:00:00.000Z' });
  assert.equal(rec.status, 3, rec.out);
  assert.match(rec.out, /HALTED/);
  // And the next fire refuses, rather than repeating whatever went wrong.
  const nxt = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-09-02T00:00:00.000Z' });
  assert.equal(nxt.status, 3);
  assert.match(nxt.out, /halted/);
});

test('a run recorded with no ledger lines burns nothing and claims nothing', () => {
  const { proj, env } = armed();
  const r = runSchedule({ ...env, MODE: 'record', RUN: 'never-happened',
    NOW: '2026-08-02T00:00:00.000Z' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Nothing was spent/);
  assert.equal(envelopeDoc(proj).credits_spent_ceiling, 0);
});

// --- visibility -------------------------------------------------------------

test('every fire is logged, including the ones that stopped', () => {
  const { proj, env, small, big } = armed();
  runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });
  runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-16T00:00:00.000Z' });
  runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-23T00:00:00.000Z' });

  const lines = logLines(proj);
  assert.equal(lines.filter((l) => l.outcome === 'armed').length, 1);
  assert.equal(lines.filter((l) => l.outcome === 'stopped').length, 2);
  assert.equal(lines.filter((l) => l.outcome === 'cleared').length, 1);
  for (const s of lines.filter((l) => l.outcome === 'stopped')) {
    assert.ok(s.stop_codes.includes('envelope_exceeded'), JSON.stringify(s));
  }
});

test('status leads with the fact that the last fire stopped', () => {
  const { proj, env, big } = armed();
  runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });
  const r = runSchedule({ ...env, MODE: 'status', NOW: '2026-08-10T00:00:00.000Z' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /The last fire STOPPED/);
  assert.match(r.out, /A stop is not a pause/);
  assert.match(r.out, /CEILING burndown/);
});

test('status on a schedule that was deleted reports it rather than inventing one', () => {
  const { proj, env } = armed();
  fs.rmSync(path.join(proj.root, 'gtm', 'schedules', 'weekly'), { recursive: true });
  const r = runSchedule({ ...env, MODE: 'status', NOW: '2026-08-10T00:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /no envelope/);
});

// --- cadence ----------------------------------------------------------------

test('a schedule that fires again too soon stops', () => {
  const { proj, env, small } = armed();
  proj.write('gtm/api-calls.jsonl', JSON.stringify(
    lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' }),
  ) + '\n');
  runSchedule({ ...env, MODE: 'record', RUN: 'r1', NOW: '2026-08-02T00:00:00.000Z' });
  const r = runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-02T01:00:00.000Z' });
  assert.equal(r.status, 3);
  assert.match(r.out, /too_soon/);
});

test('the cadence floor is read from the gate file', () => {
  const proj = projectWith({});
  fs.writeFileSync(path.join(proj.root, 'accounts.csv'),
    'company_linkedin_url\nhttps://www.linkedin.com/company/acme\n');
  const plan = planFile(proj, ['call', 'enrich_company', '--in', 'accounts.csv']);
  const gatesFile = gatesFileWith(proj.root, (doc) => {
    doc.skills ??= {};
    doc.skills.scheduled_workflow = {
      approval_max_age_days: 30, max_runs_per_approval: 26,
      min_interval_hours: 999, max_envelope_credits: 20000,
    };
  });
  const r = runSchedule({
    ROOT: proj.root, ID: 'weekly', GATES_FILE: gatesFile, MODE: 'arm', PLAN: plan.path,
    RUNS: 2, EVERY_HOURS: 24, CMD: JSON.stringify(['x']), APPROVE: '2',
    NOW: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.status, 2);
  assert.match(r.out, /cadence floor/);
});

// --- no PII in the artifacts ------------------------------------------------

test('nothing this skill writes carries a contact', () => {
  const { proj, env, small, big } = armed();
  runSchedule({ ...env, MODE: 'check', PLAN: big.path, NOW: '2026-08-09T00:00:00.000Z' });
  runSchedule({ ...env, MODE: 'check', PLAN: small.path, NOW: '2026-08-16T00:00:00.000Z' });
  runSchedule({ ...env, MODE: 'status', NOW: '2026-08-17T00:00:00.000Z' });
  const blob = proj.read('gtm/schedules/weekly/envelope.json')
    + proj.read('gtm/schedules/weekly/runs.jsonl')
    + proj.read('gtm/schedules/weekly/status.md');
  assert.ok(!/@[a-z0-9.-]+\.(com|example|org)/i.test(blob),
    'a schedule artifact must not carry a contact');
  assert.ok(!/row_id/.test(blob), 'row identifiers are never written into a schedule artifact');
});
