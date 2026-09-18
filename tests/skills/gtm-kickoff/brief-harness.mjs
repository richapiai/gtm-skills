// tests/skills/gtm-kickoff/brief-harness.mjs — the executable form of the brief contract.
//
// WHY THIS FILE EXISTS
//
// /gtm-kickoff's only durable output is an artifact that every later skill reads. A
// prose description of that artifact cannot be tested: asserting on prose proves a
// sentence exists, not that breaking the rule fails.
//
// So the contract lives in skills/gtm-kickoff/SKILL.md as a fenced `kickoff-brief`
// block and this file runs it. The RULES are the skill's; only the glue is here.
// Deleting a required field, dropping the approval flag or widening an enum is a red
// run, not a silent change to what downstream skills may rely on.
//
// It cannot fail open by accident: the contract is loaded or it throws, an unenumerated
// field is refused (`default_verdict: refuse`), and the null-alias set is imported from
// the shipped _lib/dual-contract.mjs rather than re-typed here.

import { nullAliases, NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import { loadBriefContract } from './helpers.mjs';

export { loadBriefContract, NULL_ENUM };

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function isEmptyValue (v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function isExplicitNull (v, contract) {
  return typeof v === 'string' && contract.null_enum.includes(v);
}

/** Every string that appears anywhere under a value, for the alias sweep. */
function strings (v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isPlainObject(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/**
 * Run one candidate brief through the shipped contract.
 * @returns {{ok: boolean, refusals: Array<{reason: string, field: string|null}>}}
 */
export function validateBrief (brief, contract = loadBriefContract()) {
  const refusals = [];
  const refuse = (reason, field = null) => refusals.push({ reason, field });

  if (!isPlainObject(brief)) {
    refuse('missing_field', null);
    return { ok: false, refusals };
  }

  const aliases = nullAliases();
  const required = contract.required || [];
  const allowed = new Set([...required, 'approved']);

  // The brief is written only after explicit approval. Plan section 4, A1.
  if (contract.write_requires_explicit_approval === true && brief.approved !== true) {
    refuse('not_approved', 'approved');
  }

  for (const key of Object.keys(brief)) {
    if (!allowed.has(key)) refuse('unknown_field', key);
  }

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(brief, key)) refuse('missing_field', key);
  }

  for (const key of contract.required_non_null || []) {
    if (!Object.prototype.hasOwnProperty.call(brief, key)) continue; // already reported
    const v = brief[key];
    if (isExplicitNull(v, contract)) refuse('null_not_permitted', key);
    else if (isEmptyValue(v)) refuse('empty_not_permitted', key);
  }

  // A blank, a dash or a cheerful placeholder is the same failure wearing different
  // clothes. The rejected set is the shipped one, never a copy.
  for (const key of Object.keys(brief)) {
    if (key === 'approved') continue;
    for (const s of strings(brief[key])) {
      if (aliases.has(s.trim().toLowerCase())) { refuse('null_alias', key); break; }
    }
  }

  // One decision per question.
  for (const [key, values] of Object.entries(contract.enums || {})) {
    if (!Object.prototype.hasOwnProperty.call(brief, key)) continue;
    const v = brief[key];
    if (isExplicitNull(v, contract)) continue;
    if (Array.isArray(v)) { refuse('more_than_one_decision', key); continue; }
    if (!values.includes(v)) refuse('not_in_enum', key);
  }

  const entryFields = contract.evidence_entry_fields || [];
  if (Array.isArray(brief.evidence)) {
    for (const e of brief.evidence) {
      if (!isPlainObject(e) || entryFields.some(f => isEmptyValue(e[f]))) {
        refuse('missing_field', 'evidence');
        continue;
      }
      if (!(contract.evidence_sources || []).includes(e.source)) {
        refuse('unknown_evidence_source', 'evidence');
      }
    }
  }

  const challengeFields = contract.premise_challenge_fields || [];
  if (Array.isArray(brief.premise_challenges)) {
    for (const c of brief.premise_challenges) {
      const missing = !isPlainObject(c)
        || challengeFields.some(f => !Object.prototype.hasOwnProperty.call(c, f))
        || isEmptyValue(c.premise) || isEmptyValue(c.challenge);
      if (missing) refuse('malformed_premise_challenge', 'premise_challenges');
    }
  }

  return { ok: refusals.length === 0, refusals };
}

/** Reason codes only, for terse assertions. */
export function reasonsOf (result) {
  return [...new Set(result.refusals.map(r => r.reason))].sort();
}

/** A brief that clears the contract. Tests mutate a clone of this. */
export function goodBrief () {
  return {
    approved: true,
    motion: 'sales_led',
    icp_hypothesis: 'Series B fintechs in the EU running an in-house compliance team',
    wedge: 'Quarterly audit evidence is assembled by hand and the auditor rejects it',
    demand_reality: 'existing_category',
    channel_hypothesis: 'Outbound email plus the compliance practitioner communities',
    constraints: { team: 'two founders', budget_posture: 'set at session start' },
    premise_challenges: [
      {
        premise: 'Every Series B fintech has this problem',
        challenge: 'Which of the last closed-won accounts actually had an auditor reject evidence?',
        response: 'Three of five did',
        changed: false,
      },
    ],
    open_questions: ['Whether the EU-only constraint is real or habit'],
    evidence: [
      { claim: 'Auditors rejected evidence at three accounts', source: 'won_deal' },
      { claim: 'The buyer is the Head of Compliance', source: 'assertion' },
    ],
  };
}
