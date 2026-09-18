// The three FROZEN shared contracts, bound to the validator.
//
// CLAUDE.md: amending a frozen contract is a deliberate, announced change. This
// module is how the other suites consume them, and tests/contracts/frozen.test.mjs
// is how an unannounced edit gets caught.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, assertValidJsonSchema, formatErrors } from './schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const CONTRACTS_DIR = join(REPO_ROOT, '_lib', 'contracts');

/** The frozen set. Adding one is a deliberate, announced change. */
export const CONTRACT_NAMES = Object.freeze(['api-catalog', 'journal-line', 'ledger-line']);

const cache = new Map();

/** Absolute path to a contract file. */
export function contractPath (name) {
  assertKnown(name);
  return join(CONTRACTS_DIR, `${name}.schema.json`);
}

function assertKnown (name) {
  if (!CONTRACT_NAMES.includes(name)) {
    throw new Error(`unknown contract "${name}". Known: ${CONTRACT_NAMES.join(', ')}`);
  }
}

/** Raw file text, exactly as on disk. */
export function contractSource (name) {
  return readFileSync(contractPath(name), 'utf8');
}

/** Parsed schema, cached. */
export function loadContract (name) {
  assertKnown(name);
  if (!cache.has(name)) cache.set(name, JSON.parse(contractSource(name)));
  return cache.get(name);
}

/** sha256 of the contract file's bytes — the freeze guard's input. */
export function contractSha256 (name) {
  return createHash('sha256').update(readFileSync(contractPath(name))).digest('hex');
}

/** { 'api-catalog': '<sha>', ... } for all frozen contracts. */
export function allContractHashes () {
  return Object.fromEntries(CONTRACT_NAMES.map(n => [n, contractSha256(n)]));
}

/**
 * Validate an object against a frozen contract.
 * @param {'api-catalog'|'journal-line'|'ledger-line'} contract
 * @param {unknown} object
 * @returns {{valid: boolean, errors: Array<{path:string,message:string}>}}
 */
export function conformsTo (contract, object) {
  return validate(loadContract(contract), object);
}

/**
 * Throw unless `object` conforms to the named frozen contract.
 * The message names the contract, the failing pointers, and the object, so a
 * failure in another suite is actionable without opening this file.
 *
 * @param {'api-catalog'|'journal-line'|'ledger-line'} contract
 * @param {unknown} object
 * @param {string} [message] extra context, e.g. "resumed journal line for row 380"
 */
export function assertConformsTo (contract, object, message = '') {
  const { valid, errors } = conformsTo(contract, object);
  if (valid) return object;
  const head = message ? `${message}: ` : '';
  const err = new Error(
    `${head}object does not conform to the frozen contract "${contract}" (_lib/contracts/${contract}.schema.json)\n` +
    `${formatErrors(errors)}\n` +
    `  value: ${JSON.stringify(object)}`
  );
  err.name = 'ContractViolation';
  err.contract = contract;
  err.errors = errors;
  throw err;
}

/**
 * Throw if `object` DOES conform. For negative tests — proving that a
 * fabricated actual, a bare number in a gate, or a PII-bearing render is
 * actually rejected rather than merely believed to be.
 */
export function assertViolates (contract, object, message = '') {
  const { valid } = conformsTo(contract, object);
  if (!valid) return object;
  const head = message ? `${message}: ` : '';
  const err = new Error(`${head}expected this object to VIOLATE contract "${contract}", but it conformed: ${JSON.stringify(object)}`);
  err.name = 'ContractViolationExpected';
  throw err;
}

/** Assert a frozen contract is itself a schema this validator fully enforces. */
export function assertContractIsValidSchema (name) {
  return assertValidJsonSchema(loadContract(name), `_lib/contracts/${name}.schema.json`);
}

export default {
  CONTRACT_NAMES, CONTRACTS_DIR, REPO_ROOT,
  contractPath, contractSource, loadContract, contractSha256, allContractHashes,
  conformsTo, assertConformsTo, assertViolates, assertContractIsValidSchema
};
