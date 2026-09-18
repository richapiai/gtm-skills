// The freeze guard.
//
// Several workstreams write in parallel against three shared schemas. The failure this
// prevents is quiet: one workstream widens an enum or drops a `required` to make its
// own code pass, everything stays green in that branch, and the mismatch
// surfaces at merge — or worse, at runtime, in the workstream that assumed the
// other shape. A content hash turns that into a named test failure in the offending
// commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_NAMES, contractSha256, contractPath } from '../helpers/contracts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS_FILE = join(HERE, 'frozen-contracts.sha256');

function readPins () {
  const out = new Map();
  for (const line of readFileSync(PINS_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [hash, name] = trimmed.split(/\s+/);
    out.set(name, hash);
  }
  return out;
}

test('every frozen contract still hashes to its pinned value', () => {
  const pins = readPins();
  for (const name of CONTRACT_NAMES) {
    const pinned = pins.get(name);
    assert.ok(pinned, `no pinned hash for "${name}" in tests/contracts/frozen-contracts.sha256`);
    const actual = contractSha256(name);
    assert.equal(
      actual, pinned,
      `FROZEN CONTRACT CHANGED: ${contractPath(name)}\n` +
      `  pinned: ${pinned}\n  actual: ${actual}\n\n` +
      'A contract is shared by more than one module and may not be changed unilaterally (CLAUDE.md).\n' +
      'If the change is intended and agreed: update tests/contracts/frozen-contracts.sha256 in the\n' +
      'SAME commit and say why in the message. If it is not intended, revert the schema edit.'
    );
  }
});

test('the pin file lists exactly the frozen contracts — no more, no fewer', () => {
  const pins = readPins();
  assert.deepEqual(
    [...pins.keys()].sort(), [...CONTRACT_NAMES].sort(),
    'a contract was added or removed without updating the pin file; adding a shared schema is a deliberate, announced change'
  );
});

test('the guard actually detects a change (it is not vacuously green)', () => {
  // Prove the mechanism by hashing a mutated copy rather than the file on disk.
  const src = readFileSync(contractPath('ledger-line'), 'utf8');
  const mutated = src.replace('"estimated_unverifiable"', '"actual_probably"');
  assert.notEqual(mutated, src, 'the mutation must actually change the source');
  const mutatedHash = createHash('sha256').update(mutated).digest('hex');
  assert.notEqual(mutatedHash, contractSha256('ledger-line'));
});
