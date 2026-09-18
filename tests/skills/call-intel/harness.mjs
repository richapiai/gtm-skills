// tests/skills/call-intel/harness.mjs — the executable form of /call-intel.
//
// WHY THIS FILE EXISTS
//
// The Iron Law — *a transcript with no objection must not produce an objection* — is
// the one rule in this skill whose failure mode is a rep walking into the next call
// apologising for a concern the buyer never raised. A law that exists only as prose
// cannot be tested, and asserting on the prose would prove a sentence exists rather
// than that breaking the rule fails.
//
// So the extraction rules live in `skills/call-intel/SKILL.md` as a fenced,
// machine-readable `call-intel-rules` block and this file runs that block — the same
// technique /comply and /personalize use. The RULES are the skill's.
//
// WHAT THIS HARNESS IS NOT. It is not an extractor. Extraction is the model's job and
// this skill's inference mode is local, so there is nothing here to stub. What the
// harness does is enforce the CONTRACT on whatever the model proposed: a candidate is
// only an item if a verbatim span of the transcript supports it, and a field with no
// surviving item gets the explicit null rather than a plausible sentence.
//
// Delegated, never re-implemented:
//   the null enum + validation -> _lib/dual-contract.mjs (which interprets the schema)
//   thresholds                 -> _lib/gates.mjs (gateValue; MissingGateKey => STOP)
//   suppression                -> _lib/suppression.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../../_lib/gates.mjs';
import {
  NULL_ENUM, validateDualContract, isExplicitNull,
} from '../../../_lib/dual-contract.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'call-intel', 'SKILL.md');

export { NULL_ENUM, validateDualContract, isExplicitNull, MissingGateKey, STOP, loadGates, gateValue };

export const EMIT = 'emit';
export const REFUSE = 'refuse';
export const NOT_FOUND = 'not_found';
export const NOT_VERIFIABLE = 'not_verifiable';
export const NOT_APPLICABLE = 'not_applicable';

export const FIELDS = Object.freeze(['objections', 'next_steps', 'competitors', 'commitments']);

export class CallIntelRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'CallIntelRulesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the rules OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+call-intel-rules[ \t]*$/m;

export function loadCallIntelRules ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new CallIntelRulesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new CallIntelRulesUnavailable('unterminated `call-intel-rules` fence');
  if (blocks.length === 0) {
    throw new CallIntelRulesUnavailable(
      'skills/call-intel/SKILL.md carries no ```yaml call-intel-rules block — the table is the gate');
  }
  if (blocks.length > 1) {
    throw new CallIntelRulesUnavailable(`${blocks.length} call-intel-rules blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new CallIntelRulesUnavailable(`call-intel-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new CallIntelRulesUnavailable('call-intel-rules is empty');

  // Law 5, at load time. Every one of these is the Iron Law in a different place, and
  // flipping any single word would disarm it silently in production while the suite's
  // own happy-path tests stayed green.
  if (doc.default_decision !== REFUSE) {
    throw new CallIntelRulesUnavailable(
      `default_decision is ${JSON.stringify(doc.default_decision)}; it must be "${REFUSE}" — law 5`);
  }
  if (doc.anchor_gate?.require_verbatim_span !== true) {
    throw new CallIntelRulesUnavailable('anchor_gate.require_verbatim_span must be true — that IS the Iron Law');
  }
  if (doc.anchor_gate?.unanchored_action !== 'drop') {
    throw new CallIntelRulesUnavailable('anchor_gate.unanchored_action must be "drop" — a hedge is still a claim');
  }
  if (doc.anchor_gate?.hedged_item_allowed !== false || doc.anchor_gate?.paraphrase_as_quote_allowed !== false) {
    throw new CallIntelRulesUnavailable('a hedge and a paraphrase-as-quote are both inventions; both must be false');
  }
  if (doc.empty_field_action !== 'explicit_null' || doc.omit_empty_field !== false) {
    throw new CallIntelRulesUnavailable(
      'an empty field must render as the explicit null and must never be omitted — '
      + 'an omitted field reads as "not analysed"');
  }
  const enums = new Set(doc.null_enum || []);
  if (enums.size !== NULL_ENUM.length || NULL_ENUM.some(n => !enums.has(n))) {
    throw new CallIntelRulesUnavailable(
      `null_enum must be exactly ${NULL_ENUM.join(' | ')} — the dual contract has one null enum, not two`);
  }
  for (const f of FIELDS) {
    if (!doc.fields?.[f]) throw new CallIntelRulesUnavailable(`no rules for the \`${f}\` field`);
    for (const k of ['empty_null', 'partial_null']) {
      if (!NULL_ENUM.includes(doc.fields[f][k])) {
        throw new CallIntelRulesUnavailable(
          `fields.${f}.${k} = ${JSON.stringify(doc.fields[f][k])} is not one of the explicit nulls`);
      }
    }
  }
  if (doc.free_text_result_allowed !== false || !Array.isArray(doc.banned_result_strings) || doc.banned_result_strings.length === 0) {
    throw new CallIntelRulesUnavailable(
      'free_text_result_allowed must be false and banned_result_strings must be non-empty — '
      + '"no objections" is a null wearing prose, and the dual contract\'s generic alias list '
      + 'does not carry the domain phrasings a call summary reaches for');
  }
  if (doc.inference?.mode !== 'local') {
    throw new CallIntelRulesUnavailable('inference.mode must be "local" — the local-inference rule names this skill explicitly');
  }
  if (doc.inference?.llm_output_merged_into_verified !== false) {
    throw new CallIntelRulesUnavailable('an LLM-derived value is never merged into a verified field');
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. The anchor gate. One candidate at a time.
// ---------------------------------------------------------------------------

const WS = /\s+/g;
/** Transcripts wrap, get re-flowed and get pasted. Whitespace is not evidence. */
function flatten (s) { return String(s ?? '').replace(WS, ' ').trim(); }

/**
 * Is this candidate supported by the transcript?
 * @returns {{decision:'emit'|'refuse', reason:string, null:(string|null)}}
 */
export function anchorItem ({ transcript, item, rules = loadCallIntelRules() } = {}) {
  const gate = rules.anchor_gate;
  const refuse = (reason) => ({ decision: REFUSE, reason, null: gate.unanchored_null });

  if (!item || typeof item !== 'object') return refuse('candidate is not an object');
  const quote = flatten(item.quote);
  if (!quote) return refuse('no quote — an item with nothing to cite cites nothing');

  const hay = gate.case_sensitive ? flatten(transcript) : flatten(transcript).toLowerCase();
  const needle = gate.case_sensitive ? quote : quote.toLowerCase();
  if (!hay.includes(needle)) {
    return refuse(`quote is not a verbatim span of the transcript: ${JSON.stringify(item.quote)}`);
  }
  if (gate.require_speaker && !String(item.speaker ?? '').trim()) {
    return refuse('no speaker — an unattributed quote puts words in somebody\'s mouth');
  }
  return { decision: EMIT, reason: 'anchored to a verbatim span', null: null };
}

/** Does an anchored candidate carry everything the field requires of an item? */
export function isComplete (field, item, rules = loadCallIntelRules()) {
  const spec = rules.fields[field] || {};
  for (const key of spec.require || []) {
    if (item[key] === undefined || item[key] === null || String(item[key]).trim() === '') return false;
  }
  if (spec.require_named === true && !String(item.name ?? '').trim()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 3. One field -> one dual-contract record.
// ---------------------------------------------------------------------------

/**
 * A field carries anchored items or ONE member of the null enum. Never a sentence.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE DUAL CONTRACT. The contract's rejected-alias list
 * is generic — `n/a`, `none`, `unknown`, `no data` — and it cannot enumerate every
 * domain's way of writing an empty answer in prose. `"no objections"` passes
 * `validateDualContract` today as a perfectly good string value, and `"no objections"`
 * is exactly the free-text null a call summary reaches for. So the domain check lives
 * here, where the domain is known, and the rules table is what it reads.
 */
export function checkResultShape (result, rules = loadCallIntelRules()) {
  if (NULL_ENUM.includes(result)) return { ok: true };
  if (Array.isArray(result) && result.length > 0) return { ok: true };
  if (typeof result === 'string') {
    if (rules.free_text_result_allowed !== true) {
      const flat = result.trim().toLowerCase().replace(/[.!]+$/, '');
      const banned = (rules.banned_result_strings || []).map(x => String(x).toLowerCase());
      return {
        ok: false,
        reason: banned.includes(flat)
          ? `${JSON.stringify(result)} is a null wearing prose — use the explicit enum (${NULL_ENUM.join(' | ')})`
          : `${JSON.stringify(result)} is free text; a field carries anchored items or one explicit null`,
      };
    }
  }
  return { ok: false, reason: `${JSON.stringify(result)} is neither anchored items nor an explicit null` };
}

/**
 * @returns {{
 *   field: string, decision: 'emit'|'refuse',
 *   record: object,          // validates against _lib/dual-contract.schema.json
 *   result: *,               // the record's result: items, or one explicit null
 *   null: string|null,
 *   dropped: Array<{item:object, reason:string, null:string}>,
 *   partial: object[]
 * }}
 */
export function extractField ({
  transcript, field, candidates = [], rules = loadCallIntelRules(),
} = {}) {
  if (!FIELDS.includes(field)) throw new Error(`unknown field: ${field}`);
  const spec = rules.fields[field];

  const dropped = [];
  const partial = [];
  const items = [];

  for (const c of candidates) {
    const a = anchorItem({ transcript, item: c, rules });
    if (a.decision === REFUSE) { dropped.push({ item: c, reason: a.reason, null: a.null }); continue; }
    if (!isComplete(field, c, rules)) { partial.push(c); continue; }
    items.push({ ...c, quote: c.quote, speaker: c.speaker });
  }

  let result, nullValue, reasoning;
  if (items.length > 0) {
    result = items;
    nullValue = null;
    reasoning = `${items.length} item(s), each anchored to a verbatim span of the transcript`;
  } else if (partial.length > 0) {
    // The topic was live and the specifics never landed. That is `not_found`, and it
    // is a different fact about the call from "nobody raised it".
    nullValue = spec.partial_null;
    result = nullValue;
    reasoning = `${partial.length} candidate(s) were anchored but incomplete `
      + `(missing ${(spec.require || ['a name']).join('/')}); the specifics were never stated`;
  } else {
    // Nothing survived. Dropping an invention does not make the call ambiguous — it
    // makes it a call that had none. So the field falls to its own empty_null, NOT to
    // the drop list's not_verifiable.
    nullValue = spec.empty_null;
    result = nullValue;
    reasoning = dropped.length
      ? `${dropped.length} candidate(s) had no verbatim support and were dropped; `
        + `the transcript contains no ${field.replace('_', ' ')}`
      : `the transcript contains no ${field.replace('_', ' ')}`;
    if (spec.empty_reason) reasoning += ` — ${spec.empty_reason}`;
  }

  const record = {
    result,
    confidence: 1,          // verbatim, or verifiably absent. Numeric, per the contract.
    reasoning,
    source: 'transcript',
  };
  const v = validateDualContract(record);
  if (!v.valid) throw new Error(`call-intel produced a record the dual contract rejects: ${v.errors.join('; ')}`);
  const shape = checkResultShape(result, rules);
  if (!shape.ok) throw new Error(`call-intel produced a result this skill forbids: ${shape.reason}`);

  return {
    field,
    decision: items.length > 0 ? EMIT : REFUSE,
    record, result, null: nullValue, dropped, partial,
  };
}

/** Every field, always all four, never a subset. An omitted field reads as unanalysed. */
export function extractIntel ({ transcript, candidates = {}, rules = loadCallIntelRules() } = {}) {
  const out = { fields: {}, dropped: [] };
  for (const field of FIELDS) {
    const r = extractField({ transcript, field, candidates: candidates[field] || [], rules });
    out.fields[field] = r;
    out.dropped.push(...r.dropped.map(d => ({ field, ...d })));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. The two paid hops, as decisions rather than as calls.
// ---------------------------------------------------------------------------

/**
 * Local inference. Is the paid LLM hop justified? Local is the default and the answer is almost
 * always no. `MissingGateKey` on the batch threshold is a STOP, not a fallback to
 * "sure, go ahead" — the route is unavailable until the key is merged.
 */
export function planLlmHop ({
  reason, transcripts = 1, gates = loadGates(), rules = loadCallIntelRules(),
} = {}) {
  const allowed = rules.inference.paid_hop_allowed_reasons || [];
  if (!allowed.includes(reason)) {
    return {
      decision: REFUSE, mode: 'local', gate: 'inference.paid_hop_allowed_reasons',
      reason: `"${reason}" is not one of ${allowed.join(' | ')} — the transcript is already in context`,
    };
  }
  if (reason === 'batch_scale') {
    const key = rules.inference.paid_hop_batch_gate;
    let min;
    try { min = gateValue(gates, key); }
    catch (e) {
      if (!(e instanceof MissingGateKey)) throw e;
      return {
        decision: REFUSE, mode: 'local', gate: key, failed_closed: true,
        reason: `${e.message} — failing closed (law 5); the batch route is unavailable until the key is merged`,
      };
    }
    if (transcripts < min) {
      return {
        decision: REFUSE, mode: 'local', gate: key,
        reason: `${transcripts} transcript(s) is below ${min}; reading them locally is free`,
      };
    }
  }
  return { decision: EMIT, mode: 'paid', gate: 'inference.paid_hop_allowed_reasons', reason, requires_dry_run: true };
}

/** The attendee-resolution hop. A profile URL or nothing; never a search by name. */
export function planAttendeeResolution ({
  attendee = {}, gates = loadGates(), rules = loadCallIntelRules(),
} = {}) {
  const spec = rules.attendee_resolution;
  if (!String(attendee.linkedin_url ?? '').trim()) {
    return {
      decision: REFUSE, gate: 'attendee_resolution.requires_profile_url',
      reason: 'no profile URL. This skill does not search for a person by a name heard on a call — '
        + 'the wrong person attached to a commitment is worse than an unattributed commitment.',
      spend: null,
    };
  }
  let max;
  try { max = gateValue(gates, spec.max_per_run_gate); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return {
      decision: REFUSE, gate: spec.max_per_run_gate, failed_closed: true,
      reason: `${e.message} — failing closed (law 5)`, spend: null,
    };
  }
  return {
    decision: EMIT, gate: spec.max_per_run_gate,
    reason: `within ${max} resolution(s) per run`,
    spend: { endpoint: spec.endpoint, planned_calls: 1, dry_run_required: true },
  };
}

export default {
  loadCallIntelRules, anchorItem, isComplete, checkResultShape, extractField, extractIntel,
  planLlmHop, planAttendeeResolution,
  FIELDS, EMIT, REFUSE, NULL_ENUM, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE,
  CallIntelRulesUnavailable,
};
