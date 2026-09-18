// tests/skills/personalize/harness.mjs — the executable form of /personalize.
//
// WHY THIS FILE EXISTS
//
// The Iron Law — *no claim in copy without a source line in the research brief* — is
// the one rule in this pack whose failure mode is a confident falsehood sent to a
// stranger under the user's name. A law that exists only as prose cannot be tested,
// and asserting on the prose would prove that a sentence exists rather than that
// breaking the rule fails.
//
// So the copy rules live in `skills/personalize/SKILL.md` as a fenced, machine-
// readable `personalize-rules` block and this file runs that block — the same
// technique `/comply` uses for its gate table. The RULES are the skill's.
//
// Grading is NOT re-implemented here. `/personalize` does not grade its own claims;
// it consumes /evidence-score's grades, and this harness imports that harness for
// exactly the reason the skill delegates: a writer marking its own work is how the
// Iron Law gets talked around.
//
// Delegated, never re-implemented:
//   grading      -> tests/skills/evidence-score/harness.mjs (which runs the skill's table)
//   dual contract-> _lib/dual-contract.mjs
//   suppression  -> _lib/suppression.mjs   (loadSuppressionStore / isSuppressed)
//   thresholds   -> _lib/gates.mjs         (gateValue; MissingGateKey => STOP)

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../../_lib/gates.mjs';
import { NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import { isSuppressed, rowIdentifiers, SuppressionUnavailableError }
  from '../../../_lib/suppression.mjs';
import {
  loadEvidenceRules, gradeClaim,
  SUPPORTED, WEAK, UNSUPPORTED, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE,
} from '../evidence-score/harness.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'personalize', 'SKILL.md');

export {
  NULL_ENUM, MissingGateKey, STOP, SuppressionUnavailableError,
  SUPPORTED, WEAK, UNSUPPORTED, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE,
  loadEvidenceRules, gradeClaim,
};

export const EMIT = 'emit';
export const REFUSE = 'refuse';

export class PersonalizeRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'PersonalizeRulesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the copy rules OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+personalize-rules[ \t]*$/m;

export function loadPersonalizeRules ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new PersonalizeRulesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new PersonalizeRulesUnavailable('unterminated `personalize-rules` fence');
  if (blocks.length === 0) {
    throw new PersonalizeRulesUnavailable(
      'skills/personalize/SKILL.md carries no ```yaml personalize-rules block — the table is the gate');
  }
  if (blocks.length > 1) {
    throw new PersonalizeRulesUnavailable(`${blocks.length} personalize-rules blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new PersonalizeRulesUnavailable(`personalize-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new PersonalizeRulesUnavailable('personalize-rules parsed to nothing');
  for (const key of ['default_decision', 'claim_gate', 'pre_emit', 'banned_phrases', 'inference']) {
    if (doc[key] === undefined) throw new PersonalizeRulesUnavailable(`personalize-rules is missing \`${key}\``);
  }
  if (doc.default_decision !== REFUSE) {
    throw new PersonalizeRulesUnavailable(
      `personalize-rules default_decision is "${doc.default_decision}" — law 5 says the default is "${REFUSE}"`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. One claim: may this sentence be written?
// ---------------------------------------------------------------------------

const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * The Iron Law, for one claim.
 *
 * A claim may be asserted only when /evidence-score graded it `supported` AND its
 * provenance and source line satisfy the claim gate. Everything else is a refusal
 * carrying one of the three explicit nulls — never a hedged sentence, never silence.
 *
 * @returns {{decision:string, result:(string|*), grade:string, null:(string|null),
 *            reasons:string[], source:(string|undefined)}}
 */
export function planClaim (brief, field, {
  rules, evidenceRules, gates = loadGates(), now = new Date(),
} = {}) {
  if (!rules) throw new PersonalizeRulesUnavailable('planClaim: no copy rules loaded — STOP');
  if (!evidenceRules) throw new PersonalizeRulesUnavailable('planClaim: no grading table loaded — STOP');
  const gate = rules.claim_gate || {};

  // Fail closed on a rules edit that disarmed the law itself.
  if (gate.require_source_line !== true) {
    return {
      decision: REFUSE, result: NOT_VERIFIABLE, grade: UNSUPPORTED, null: NOT_VERIFIABLE,
      reasons: ['claim_gate.require_source_line is not true — the Iron Law is disarmed'],
      failed_closed: true, field,
    };
  }

  const g = gradeClaim(brief, field, { rules: evidenceRules, gates, now });

  const assertableGrades = (gate.assertable_grades || []).map(low);
  const assertableProv = (gate.assertable_provenance || []).map(low);
  const byGrade = gate.refusal_null_by_grade || {};

  const gradeOk = assertableGrades.includes(low(g.grade));
  const provOk = assertableProv.includes(low(g.provenance));
  const hasSource = !!String(g.source ?? '').trim();

  if (gradeOk && provOk && hasSource) {
    return {
      decision: EMIT, result: g.value, grade: g.grade, null: null,
      reasons: [], source: g.source, field,
    };
  }

  // The refusal's explicit null. A null the brief already recorded wins — carrying it
  // through is the difference between "we looked and there is nothing" and "we could
  // not certify it", and a caller that flattens the two loses the only useful signal.
  let nul = g.null;
  if (!NULL_ENUM.includes(nul)) nul = byGrade[low(g.grade)] || NOT_FOUND;
  if (gate.carry_through_brief_nulls !== false && g.reasons.includes('brief_recorded_explicit_null')) {
    nul = g.null;
  }
  if (!provOk && low(g.provenance) === 'ai_inferred') nul = byGrade[WEAK] || NOT_VERIFIABLE;

  const reasons = [...g.reasons];
  if (!hasSource && !reasons.includes('source_line_missing')) reasons.push('source_line_missing');

  return {
    decision: REFUSE, result: nul, grade: g.grade, null: nul, reasons,
    source: g.source, failed_closed: !!g.failed_closed, field,
  };
}

/** A claim the record cannot have at all. `not_applicable` is a real answer. */
export function planInapplicableClaim (field, { rules } = {}) {
  const nul = (rules?.claim_gate || {}).inapplicable_null || NOT_APPLICABLE;
  return {
    decision: REFUSE, result: nul, grade: UNSUPPORTED, null: nul,
    reasons: ['claim_does_not_apply_to_this_record'], field,
  };
}

// ---------------------------------------------------------------------------
// 3. Banned phrases.
// ---------------------------------------------------------------------------

const normalise = (s) => String(s ?? '')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[–—]/g, '-')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

export function bannedPhraseHits (text, rules) {
  const hay = normalise(text);
  return (rules.banned_phrases || []).filter(p => hay.includes(normalise(p)));
}

// ---------------------------------------------------------------------------
// 4. The pre-emit verification gate. Runs on the RENDERED text.
// ---------------------------------------------------------------------------

const SLOT_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function templateSlots (template) {
  return [...String(template ?? '').matchAll(SLOT_RE)].map(m => m[1]);
}

export function renderDraft (template, values) {
  return String(template ?? '').replace(SLOT_RE, (whole, name) =>
    (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole));
}

/**
 * Check one draft before it is written or shown.
 *
 * `store` is REQUIRED whenever a contact row is given: /personalize does not draft for
 * a contact it cannot screen. A missing store throws, exactly as it does in /comply —
 * a suppression check that could not run is not a passing suppression check (law 5).
 *
 * @returns {{decision:string, violations:string[], claims:object[], text:(string|null),
 *            refusals:object[]}}
 */
export function checkDraft ({
  template, slots = [], brief, contact = null, store = null,
  rules, evidenceRules, gates = loadGates(), now = new Date(),
} = {}) {
  if (!rules) throw new PersonalizeRulesUnavailable('checkDraft: no copy rules loaded — STOP');
  if (!evidenceRules) throw new PersonalizeRulesUnavailable('checkDraft: no grading table loaded — STOP');
  const pre = rules.pre_emit || {};
  const violations = [];

  if (contact) {
    if (!store || !(store.emails instanceof Set)) {
      throw new SuppressionUnavailableError(
        'checkDraft: no suppression store loaded — STOP. A draft written for a contact '
        + 'nobody screened is the one mistake in this pack that cannot be taken back.');
    }
    if (rowIdentifiers(contact).some(id => isSuppressed(store, id))) {
      return {
        decision: REFUSE, violations: ['contact_suppressed'], claims: [], refusals: [],
        text: null,
      };
    }
  }

  const declared = new Map(slots.map(s => [s.name, s]));
  for (const name of templateSlots(template)) {
    if (!declared.has(name)) violations.push(`undeclared_slot:${name}`);
  }

  const claims = [];
  const refusals = [];
  const values = {};
  for (const slot of slots) {
    const plan = slot.inapplicable
      ? planInapplicableClaim(slot.field ?? slot.name, { rules })
      : planClaim(brief, slot.field ?? slot.name, { rules, evidenceRules, gates, now });
    claims.push({ slot: slot.name, section: slot.section || 'body', ...plan });
    if (plan.decision === EMIT) {
      values[slot.name] = plan.result;
      if (pre.every_claim_has_source_line !== false && !String(plan.source ?? '').trim()) {
        violations.push(`claim_without_source_line:${slot.name}`);
      }
    } else {
      refusals.push(plan);
      violations.push(`claim_not_supported:${slot.name}:${plan.null}`);
    }
  }

  // Claim budget. An opener that stacks claims reads as a dossier.
  const budget = rules.claim_budget || {};
  const perSection = {};
  for (const c of claims) {
    if (c.decision !== EMIT) continue;
    perSection[c.section] = (perSection[c.section] || 0) + 1;
  }
  if (pre.claim_budget_respected !== false) {
    for (const [section, count] of Object.entries(perSection)) {
      const max = budget[section];
      if (max === undefined) { violations.push(`claim_budget_undefined:${section}`); continue; }
      if (count > Number(max)) violations.push(`claim_budget_exceeded:${section}`);
    }
  }

  const text = renderDraft(template, values);
  if (pre.no_unresolved_slots !== false && templateSlots(text).length > 0) {
    violations.push(`unresolved_slot:${templateSlots(text).join(',')}`);
  }

  if (low(rules.banned_phrase_action) !== 'warn') {
    for (const hit of bannedPhraseHits(text, rules)) violations.push(`banned_phrase:${hit}`);
  }

  return {
    decision: violations.length === 0 ? EMIT : REFUSE,
    violations, claims, refusals,
    text: violations.length === 0 ? text : null,
  };
}

// ---------------------------------------------------------------------------
// 5. Local inference — where inference runs.
// ---------------------------------------------------------------------------

export function inferenceMode (rules) { return (rules.inference || {}).mode; }

/**
 * May this run reach for `ai_enrich`?
 *
 * Two reasons, both named in the skill's table: Perplexity web grounding and batch
 * scale. Everything else — drafting, rewriting, grading, filling a gap the brief left
 * — is refused, because the pack already runs inside a model that does those for free
 * and `ai_enrich` is metered per call.
 *
 * The batch-scale threshold is a gate key; a key that does not resolve is STOP, which
 * keeps drafting local. That is the direction this check is meant to fail in.
 */
export function aiEnrichDecision ({ reason, rowCount = 0, rules, gates = loadGates() } = {}) {
  const inf = rules.inference || {};
  const allowed = (inf.ai_enrich_allowed_when || []).map(low);
  const never = (inf.ai_enrich_never_for || []).map(low);
  const r = low(reason);

  if (never.includes(r)) {
    return { decision: STOP, reason: `ai_enrich is never called for ${r} — inference is local` };
  }
  if (!allowed.includes(r)) {
    return { decision: STOP, reason: `"${reason}" is not one of ${allowed.join(' | ')} — refused (law 5)` };
  }
  if (r === 'batch_scale') {
    const key = inf.batch_scale_gate_key;
    if (!key) return { decision: STOP, reason: 'personalize-rules names no batch_scale_gate_key', failed_closed: true };
    let min;
    try { min = gateValue(gates, key); }
    catch (e) {
      if (e instanceof MissingGateKey) {
        return { decision: STOP, gate: key, reason: `${e.message} — failing closed (law 5)`, failed_closed: true };
      }
      throw e;
    }
    if (Number(rowCount) < Number(min)) {
      return { decision: STOP, gate: key, reason: `${rowCount} rows is below the batch-scale floor — draft locally` };
    }
  }
  return { decision: 'allow', reason: `ai_enrich permitted for ${r}`, requires_plan: true };
}

export default {
  loadPersonalizeRules, planClaim, planInapplicableClaim, bannedPhraseHits,
  templateSlots, renderDraft, checkDraft, inferenceMode, aiEnrichDecision,
  EMIT, REFUSE, SKILL_PATH, REPO, PersonalizeRulesUnavailable,
};
