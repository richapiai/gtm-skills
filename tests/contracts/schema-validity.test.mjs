// Every frozen contract must itself be a valid, fully-enforced JSON Schema.
//
// A schema with a dangling $ref, an uncompilable pattern, or a keyword the
// validator ignores does not fail — it passes everything. That is the worst
// possible outcome for a file whose whole job is to reject bad data, so it is
// checked before any conformance assertion runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_NAMES, loadContract, contractSource, assertContractIsValidSchema
} from '../helpers/contracts.mjs';

for (const name of CONTRACT_NAMES) {
  test(`${name}.schema.json is well-formed JSON`, () => {
    assert.doesNotThrow(() => JSON.parse(contractSource(name)));
  });

  test(`${name}.schema.json is a valid JSON Schema this repo fully enforces`, () => {
    // Throws SchemaSupportError on any keyword tests/helpers/schema.mjs does
    // not enforce, any unresolvable local $ref, and any invalid regex.
    assert.equal(assertContractIsValidSchema(name), true);
  });

  test(`${name}.schema.json declares draft 2020-12, an $id and a title`, () => {
    const s = loadContract(name);
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(s.$id, /^https:\/\/richapi\.ai\/schemas\/.+\.schema\.json$/);
    assert.ok(s.title && s.title.length > 0);
    assert.equal(s.type, 'object');
    assert.ok(Array.isArray(s.required) && s.required.length > 0, 'a contract with no required fields constrains nothing');
  });

  test(`${name}.schema.json pins schema_version as a const`, () => {
    const s = loadContract(name);
    assert.ok(s.required.includes('schema_version'), 'schema_version must be required');
    assert.equal(typeof s.properties.schema_version.const, 'number',
      'schema_version must be a const, so a v2 line cannot be silently read as v1');
  });
}

test('the three contracts have distinct $ids', () => {
  const ids = CONTRACT_NAMES.map(n => loadContract(n).$id);
  assert.equal(new Set(ids).size, ids.length);
});
