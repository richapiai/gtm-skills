// _lib/dual-contract.mjs — enforcement for `_lib/dual-contract.schema.json`.
//
// `ai_enrich`'s `output_schema` is specified as *"used to guide structured output"* —
// guidance, not enforcement. So the runtime validates every LLM response itself.
//
//   valid   -> stored under `artifact.ai_inferred[field]`, stamped provenance
//              `ai_inferred`. NEVER merged into `artifact.verified`.
//   invalid -> stored under `artifact.ai_inferred_invalid[]` with the raw response and
//              the validation errors. NEVER lands in an artifact as verified.
//
// The validator interprets the schema FILE (a small, explicit JSON-Schema subset), so
// the schema stays the single source of truth rather than a decorative sibling.
// Zero runtime deps. Node >= 18, ESM.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(__dirname, 'dual-contract.schema.json');

let _schema = null;
export function loadDualContractSchema(path = SCHEMA_PATH) {
  if (_schema && path === SCHEMA_PATH) return _schema;
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (path === SCHEMA_PATH) _schema = s;
  return s;
}

export const NULL_ENUM = Object.freeze(['not_found', 'not_verifiable', 'not_applicable']);

/** The common alternative null conventions this contract abolishes. */
export function nullAliases(schema = loadDualContractSchema()) {
  return new Set((schema['x-null-aliases-rejected'] || []).map(s => String(s).trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// A deliberately small JSON-Schema subset validator
// keywords: type · required · properties · additionalProperties(false) · enum ·
//           const · oneOf · minimum · maximum · minLength · x-forbidden-null-aliases
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string | number | boolean | object | undefined
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

export function validateAgainstSchema(value, schema, { path = '', aliases = null } = {}) {
  const errors = [];
  const at = path || '(root)';
  const alias = aliases || nullAliases();

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some(x => (x === 'number' ? (t === 'number' && Number.isFinite(value)) : x === t));
    if (!ok) errors.push(`${at}: expected type ${types.join('|')}, got ${t}`);
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.not !== undefined) {
    if (validateAgainstSchema(value, schema.not, { path, aliases: alias }).length === 0) {
      errors.push(`${at}: ${JSON.stringify(value)} is explicitly disallowed here`);
    }
  }
  if (schema['x-forbidden-null-aliases'] === true) {
    const t = typeOf(value);
    if (t === 'string' && value.trim() !== '' && alias.has(value.trim().toLowerCase())) {
      errors.push(`${at}: "${value}" is a null alias — use the explicit null enum `
        + `(${NULL_ENUM.join(' | ')}) instead`);
    }
    if (t === 'string' && value.trim() === '') errors.push(`${at}: empty string is not a value — use the explicit null enum`);
    if (t === 'array' && value.length === 0) errors.push(`${at}: empty array is not a value — use the explicit null enum`);
    if (t === 'object' && Object.keys(value).length === 0) errors.push(`${at}: empty object is not a value — use the explicit null enum`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
  }
  if (Array.isArray(schema.required) && typeOf(value) === 'object') {
    for (const k of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(`${at}: missing required property \`${k}\``);
    }
  }
  if (schema.properties && typeOf(value) === 'object') {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        errors.push(...validateAgainstSchema(value[k], sub, { path: path ? `${path}.${k}` : k, aliases: alias }));
      }
    }
  }
  if (schema.additionalProperties === false && typeOf(value) === 'object') {
    const known = new Set(Object.keys(schema.properties || {}));
    for (const k of Object.keys(value)) {
      if (!known.has(k)) {
        errors.push(`${at}: unexpected property \`${k}\` — the dual contract is exactly `
          + `{ ${Object.keys(schema.properties || {}).join(', ')} }`);
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(sub =>
      validateAgainstSchema(value, sub, { path, aliases: alias }).length === 0);
    if (matches.length === 0) {
      errors.push(`${at}: ${JSON.stringify(value)} matches none of the allowed forms `
        + `(an explicit null — ${NULL_ENUM.join(' | ')} — or a real non-empty value)`);
    } else if (matches.length > 1) {
      errors.push(`${at}: ambiguous — matches ${matches.length} allowed forms`);
    }
  }
  return errors;
}

/**
 * Validate one LLM response against the dual contract.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateDualContract(response, { schema = loadDualContractSchema() } = {}) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    return { valid: false, errors: [`(root): expected a dual-contract object, got ${typeOf(response)}`] };
  }
  const errors = validateAgainstSchema(response, schema, { aliases: nullAliases(schema) });
  return { valid: errors.length === 0, errors };
}

/** True when the response is an explicit null rather than a value. */
export function isExplicitNull(response) {
  return !!response && NULL_ENUM.includes(response.result);
}

// ---------------------------------------------------------------------------
// Storage — the separation between inferred and verified
// ---------------------------------------------------------------------------

export const STATUS_VALID   = 'ai_inferred';
export const STATUS_INVALID = 'ai_inferred_invalid';

/** A fresh artifact with the two buckets kept apart by construction. */
export function newArtifact(base = {}) {
  return { verified: {}, ai_inferred: {}, ai_inferred_invalid: [], ...base };
}

/**
 * Store one LLM response on an artifact.
 * - valid   -> `artifact.ai_inferred[field]`, stamped `provenance: 'ai_inferred'`
 * - invalid -> appended to `artifact.ai_inferred_invalid[]` with the errors
 * `artifact.verified` is NEVER written by this function. Ever.
 */
export function storeLlmResult(artifact, field, response, {
  endpoint = 'ai_enrich', now = new Date(), schema = loadDualContractSchema(),
} = {}) {
  if (!artifact || typeof artifact !== 'object') throw new Error('storeLlmResult: artifact required');
  if (typeof field !== 'string' || field.trim() === '') throw new Error('storeLlmResult: field name required');
  if (!artifact.ai_inferred) artifact.ai_inferred = {};
  if (!Array.isArray(artifact.ai_inferred_invalid)) artifact.ai_inferred_invalid = [];
  if (!artifact.verified) artifact.verified = {};

  const verifiedBefore = JSON.stringify(artifact.verified);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const { valid, errors } = validateDualContract(response, { schema });

  let record;
  if (valid) {
    record = {
      ...response,
      provenance: STATUS_VALID,
      field,
      source_endpoint: endpoint,
      fetched_at: ts,
      status: STATUS_VALID,
    };
    artifact.ai_inferred[field] = record;
  } else {
    record = {
      status: STATUS_INVALID,
      field,
      source_endpoint: endpoint,
      fetched_at: ts,
      errors,
      raw: response,
    };
    artifact.ai_inferred_invalid.push(record);
  }

  // Belt and braces: an implementation bug that touched `verified` is a compliance
  // failure, not a typo. Fail loudly rather than silently promoting inferred data.
  if (JSON.stringify(artifact.verified) !== verifiedBefore) {
    throw new Error('storeLlmResult: refused — an LLM-derived value must never be written into `verified`');
  }
  return { status: record.status, valid, errors, record, artifact };
}

/**
 * Merge inferred values into a flat view for rendering. Verified always wins, and
 * every inferred value keeps its `ai_inferred` marker — they are never blended.
 */
export function readArtifactField(artifact, field) {
  if (artifact?.verified && Object.prototype.hasOwnProperty.call(artifact.verified, field)) {
    return { value: artifact.verified[field], provenance: 'verified' };
  }
  const inf = artifact?.ai_inferred?.[field];
  if (inf) return { value: inf.result, provenance: STATUS_VALID, confidence: inf.confidence, source: inf.source };
  return { value: undefined, provenance: 'absent' };
}

// ---------------------------------------------------------------------------
// Skill-lint rule — wired into scripts/validate-skills.mjs
// ---------------------------------------------------------------------------

/**
 * Validator rule for `scripts/validate-skills.mjs`, shipped as a standalone export so it
 * can be tested on its own.
 *
 * Wiring, inside `inspectSkill(dir)` after the link checks:
 *
 *     import { checkSkillDualContract } from '../_lib/dual-contract.mjs';
 *     ...
 *     for (const msg of checkSkillDualContract({ label, body })) err(label, msg);
 *
 * Flags a SKILL.md that uses an LLM hop but (a) never references the dual contract, or
 * (b) instructs the model to emit one of the abolished null conventions.
 *
 * @param {{label: string, body: string}} args
 * @returns {string[]} error messages (empty = pass)
 */
export function checkSkillDualContract({ label, body } = {}) {
  const out = [];
  const src = String(body || '');
  const usesLlm = /\bai_enrich\s*\(/.test(src)
    || /\bMCP tool\s+`ai_enrich`/.test(src)
    || /\boutput_schema\b/.test(src);
  if (!usesLlm) return out;

  if (!/dual-contract\.schema\.json|dual contract/i.test(src)) {
    out.push('uses an LLM hop (ai_enrich / output_schema) but does not reference '
      + '_lib/dual-contract.schema.json — LLM output must be validated, not merely guided');
  }
  const aliasRe = /"(?:N\/A|n\/a|NA|none|null|unknown|not found|no data|TBD|-)"/g;
  const seen = new Set();
  let m;
  while ((m = aliasRe.exec(src)) !== null) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(`instructs the abolished null convention ${tok} — the dual contract has exactly one `
      + `explicit null enum (${NULL_ENUM.join(' | ')})`);
  }
  if (/\bconfidence\b\s*[:=]\s*"?(?:high|medium|low)"?/i.test(src)) {
    out.push('uses a string confidence (high/medium/low) — the dual contract requires numeric 0..1');
  }
  if (/\bverified\b[^\n]{0,40}\bai_(?:enrich|inferred)\b/i.test(src)
      && !/never (?:mixed|merged)/i.test(src)) {
    out.push('appears to merge LLM-derived values into verified fields — ai_inferred values are '
      + 'never mixed into verified fields');
  }
  return out;
}

export default {
  loadDualContractSchema, validateDualContract, storeLlmResult, newArtifact,
  readArtifactField, checkSkillDualContract, NULL_ENUM, STATUS_VALID, STATUS_INVALID,
};
