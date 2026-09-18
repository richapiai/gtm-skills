// Verify: a non-conforming LLM response is stored `ai_inferred_invalid` and NEVER
// as verified. All four result cases round-trip. Common alternative null
// conventions are rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp } from './helpers.mjs';
import {
  loadDualContractSchema, validateDualContract, storeLlmResult, newArtifact,
  readArtifactField, checkSkillDualContract, isExplicitNull,
  NULL_ENUM, STATUS_VALID, STATUS_INVALID, SCHEMA_PATH,
} from '../../_lib/dual-contract.mjs';

test.after(cleanupTmp);

const NOW = new Date('2026-08-28T12:00:00.000Z');
const ok = (result) => ({
  result,
  confidence: 0.82,
  reasoning: 'The careers page lists a VP Engineering hiring for platform roles.',
  source: 'https://acme.com/careers',
});

// --- the schema itself -----------------------------------------------------

test('the schema file defines exactly ONE explicit null enum with three members', () => {
  const s = loadDualContractSchema();
  assert.deepEqual(s['x-null-enum'], ['not_found', 'not_verifiable', 'not_applicable']);
  assert.deepEqual(NULL_ENUM, s['x-null-enum']);
  assert.deepEqual(s.required, ['result', 'confidence', 'reasoning', 'source']);
  assert.equal(s.additionalProperties, false);
  assert.equal(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')).$id,
    'https://richapi.ai/schemas/dual-contract.schema.json');
});

// --- the four result cases -------------------------------------------------

test('all four result cases round-trip: three explicit nulls + a real value', () => {
  const root = tmpRoot('compliance-dc-');
  const file = join(root, 'artifact.jsonl');
  const cases = [...NULL_ENUM, 'Acme uses Snowflake'];

  const lines = [];
  for (const c of cases) {
    const res = validateDualContract(ok(c));
    assert.equal(res.valid, true, `${c}: ${res.errors.join('; ')}`);
    const artifact = newArtifact();
    const stored = storeLlmResult(artifact, 'tech_stack', ok(c), { now: NOW });
    assert.equal(stored.status, STATUS_VALID);
    lines.push(JSON.stringify(artifact));
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  // read back off disk: still valid, still marked ai_inferred, still not verified
  const back = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(back.length, 4);
  back.forEach((artifact, i) => {
    const rec = artifact.ai_inferred.tech_stack;
    assert.equal(rec.result, cases[i]);
    assert.equal(rec.provenance, STATUS_VALID);
    assert.equal(validateDualContract({
      result: rec.result, confidence: rec.confidence, reasoning: rec.reasoning,
      source: rec.source, provenance: rec.provenance,
    }).valid, true, 'a stored record re-validates against the contract');
    assert.deepEqual(artifact.verified, {});
    assert.deepEqual(artifact.ai_inferred_invalid, []);
  });

  assert.equal(isExplicitNull(ok('not_found')), true);
  assert.equal(isExplicitNull(ok('Acme uses Snowflake')), false);
});

// --- the rejections --------------------------------------------------------

const REJECTED = {
  'JSON null (common null convention #1)':            { ...ok('x'), result: null },
  'empty string (common null convention #2)':         { ...ok('x'), result: '' },
  '"N/A" (common null convention #3)':                { ...ok('x'), result: 'N/A' },
  '"unknown" (common null convention #4)':            { ...ok('x'), result: 'unknown' },
  '"not found" free text':                     { ...ok('x'), result: 'not found' },
  '"none"':                                    { ...ok('x'), result: 'none' },
  '"-"':                                       { ...ok('x'), result: '-' },
  'empty array':                               { ...ok('x'), result: [] },
  'empty object':                              { ...ok('x'), result: {} },
  'string confidence':                         { ...ok('x'), confidence: 'high' },
  'confidence out of range':                   { ...ok('x'), confidence: 87 },
  'missing reasoning':                         { result: 'x', confidence: 0.5, source: 'url' },
  'empty reasoning':                           { ...ok('x'), reasoning: '' },
  'missing source':                            { result: 'x', confidence: 0.5, reasoning: 'because' },
  'value-status shape {value,status}':                 { value: 'x', status: 'not found' },
  'extra sidecar null field':                  { ...ok('x'), status: 'not_found' },
  'not an object':                             'not_found',
  'array response':                            [ok('x')],
};

test('every alternative null convention and malformed shape is rejected', () => {
  for (const [label, response] of Object.entries(REJECTED)) {
    const { valid, errors } = validateDualContract(response);
    assert.equal(valid, false, `${label} must be rejected`);
    assert.ok(errors.length > 0, `${label} must explain why`);
  }
});

test('a NON-CONFORMING response is stored ai_inferred_invalid and NEVER as verified', () => {
  for (const [label, response] of Object.entries(REJECTED)) {
    const artifact = newArtifact({ verified: { email: 'bob@acme.com' } });
    const stored = storeLlmResult(artifact, 'hiring_signal', response, { now: NOW });

    assert.equal(stored.status, STATUS_INVALID, label);
    assert.equal(stored.valid, false, label);
    assert.equal(artifact.ai_inferred.hiring_signal, undefined,
      `${label}: an invalid response never becomes a usable inferred value`);
    assert.deepEqual(artifact.verified, { email: 'bob@acme.com' },
      `${label}: verified fields are untouched`);
    assert.equal(artifact.ai_inferred_invalid.length, 1);
    const q = artifact.ai_inferred_invalid[0];
    assert.equal(q.status, STATUS_INVALID);
    assert.equal(q.field, 'hiring_signal');
    assert.equal(q.source_endpoint, 'ai_enrich');
    assert.ok(q.errors.length > 0, `${label}: the quarantine record carries the reasons`);
    assert.deepEqual(q.raw, response, `${label}: the raw response is preserved for debugging`);
    assert.equal(readArtifactField(artifact, 'hiring_signal').provenance, 'absent');
  }
});

test('a VALID response is marked ai_inferred and is never mixed into verified fields', () => {
  const artifact = newArtifact({ verified: { company: 'Acme', email: 'bob@acme.com' } });
  storeLlmResult(artifact, 'company', ok('Acme Holdings Ltd'), { now: NOW });

  assert.equal(artifact.verified.company, 'Acme', 'the verified value wins and is not overwritten');
  assert.equal(artifact.ai_inferred.company.result, 'Acme Holdings Ltd');
  assert.equal(artifact.ai_inferred.company.provenance, STATUS_VALID);
  assert.equal(artifact.ai_inferred.company.source_endpoint, 'ai_enrich');
  assert.equal(artifact.ai_inferred.company.fetched_at, NOW.toISOString(),
    'inferred values carry PII provenance too');

  assert.deepEqual(readArtifactField(artifact, 'company'), { value: 'Acme', provenance: 'verified' });
  const inferredOnly = readArtifactField(artifact, 'tech_stack');
  assert.equal(inferredOnly.provenance, 'absent');
  storeLlmResult(artifact, 'tech_stack', ok('Snowflake'), { now: NOW });
  assert.deepEqual(readArtifactField(artifact, 'tech_stack'),
    { value: 'Snowflake', provenance: STATUS_VALID, confidence: 0.82, source: 'https://acme.com/careers' });
});

test('confidence boundaries and value types the contract does allow', () => {
  for (const c of [0, 0.5, 1]) assert.equal(validateDualContract({ ...ok('x'), confidence: c }).valid, true);
  for (const v of ['Snowflake', 42, true, ['a', 'b'], { size: 200 }]) {
    assert.equal(validateDualContract(ok(v)).valid, true, JSON.stringify(v));
  }
  assert.equal(validateDualContract({ ...ok('x'), provenance: 'ai_inferred' }).valid, true);
  assert.equal(validateDualContract({ ...ok('x'), provenance: 'verified' }).valid, false,
    'a response may not declare itself verified');
});

// --- the skill-lint rule (needs wiring into scripts/validate-skills.mjs) ----

test('checkSkillDualContract flags LLM skills that do not enforce the contract', () => {
  const noContract = 'Call `ai_enrich(prompt, output_schema)` and write the result to the row.';
  const errs = checkSkillDualContract({ label: 'skills/x', body: noContract });
  assert.ok(errs.some(e => /dual-contract\.schema\.json/.test(e)));

  const commonNulls = 'Use `ai_enrich(...)`. Validate against `_lib/dual-contract.schema.json`. '
    + 'If nothing is found return "N/A" or "unknown".';
  const errs2 = checkSkillDualContract({ label: 'skills/x', body: commonNulls });
  assert.equal(errs2.length, 2, 'both abolished null conventions are flagged');
  assert.ok(errs2.every(e => /abolished null convention/.test(e)));

  const stringConfidence = 'Run `ai_enrich(...)` per `_lib/dual-contract.schema.json`; set confidence: "high".';
  assert.ok(checkSkillDualContract({ label: 'skills/x', body: stringConfidence })
    .some(e => /numeric 0\.\.1/.test(e)));

  const compliant = 'Run `ai_enrich(...)`. Every response is validated against '
    + '`_lib/dual-contract.schema.json`; a failure is stored `ai_inferred_invalid`. '
    + 'Inferred values are never mixed into verified fields.';
  assert.deepEqual(checkSkillDualContract({ label: 'skills/x', body: compliant }), []);

  const noLlm = 'Call `enrich_company(domain)` and write the firmographics.';
  assert.deepEqual(checkSkillDualContract({ label: 'skills/y', body: noLlm }), [],
    'skills with no LLM hop are not the rule\'s business');
});
