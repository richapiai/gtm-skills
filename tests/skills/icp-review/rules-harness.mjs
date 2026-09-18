// tests/skills/icp-review/rules-harness.mjs — the executable form of the ICP review gate.
//
// WHY THIS FILE EXISTS
//
// "Every ICP attribute must name its evidence — no vibes" is a rule, and a rule that
// exists only as prose cannot be tested. Asserting that the sentence is present proves
// the sentence is present; it does not prove that an unevidenced attribute is refused.
//
// So the rule table lives in skills/icp-review/SKILL.md as a fenced `icp-rules` block
// and this file runs it. The RULES are the skill's; only the glue is here. Dropping a
// required evidence field, or letting `ai_inferred` count as evidence, turns these
// tests red instead of quietly shipping a wrong anchor artifact.
//
// It cannot fail open by accident:
//   * the table is loaded or it throws — there is no built-in fallback
//   * an attribute that fails any check falls to `default_state` / `default_verdict`
//   * the rejected-null-alias set is imported from the shipped _lib/dual-contract.mjs
//   * every reason this harness emits must be declared in `refuse_when` (asserted)

import { nullAliases, NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import { loadIcpRules } from './helpers.mjs';

export { loadIcpRules, NULL_ENUM };

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = v => v === null || v === undefined
  || (typeof v === 'string' && v.trim() === '')
  || (Array.isArray(v) && v.length === 0);

/**
 * Review one proposed ICP attribute against the shipped table.
 *
 * @param attr {{name, state, proposed_tier, proposed_verdict, actionable_via, evidence}}
 * @returns {{state: string, verdict: string, tier: string|null, reasons: string[]}}
 */
export function reviewAttribute (attr, rules = loadIcpRules()) {
  const reasons = [];
  const add = r => { if (!reasons.includes(r)) reasons.push(r); };
  const aliases = nullAliases();

  const ev = isPlainObject(attr?.evidence) ? attr.evidence : {};
  const required = rules.evidence_required_fields || [];

  if (required.includes('sample_definition') && isBlank(ev.sample_definition)) add('sample_definition_missing');
  if (required.includes('sample_size') && !Number.isFinite(ev.sample_size)) add('sample_size_absent');

  // Absent and zero are different answers, and conflating them is how a review either
  // refuses its best evidence or accepts its worst.
  const isCount = v => Array.isArray(v) || Number.isFinite(v);
  const sizeOf  = v => (Array.isArray(v) ? v.length : v);
  if (required.includes('observed_in')) {
    if (!isCount(ev.observed_in)) add('observed_in_absent');
    else if (sizeOf(ev.observed_in) === 0
             && !(rules.empty_support_states || []).includes(attr?.state)) {
      // Zero support in the WON sample is the absence of the observation. It can
      // support `refuted` and nothing else.
      add('observed_in_empty');
    }
  }

  // An attribute present in the won set at the same rate as the lost set describes the
  // market, not the ICP. Contrast is required, so its absence is a refusal — but a
  // contrast of zero is a measurement, not an absence.
  if (rules.requires_contrast === true) {
    if (!isCount(ev.contrast_observed_in)) add('contrast_absent');
    if (!Number.isFinite(ev.contrast_sample_size)) add('contrast_absent');
  }

  if (isBlank(ev.provenance)) add('provenance_absent');
  else if (!(rules.provenance_values || []).includes(ev.provenance)) add('provenance_unknown');
  else if (!(rules.provenance_sufficient_for_evidenced || []).includes(ev.provenance)) {
    // A model that agrees with your ICP is not a customer who bought.
    add('provenance_ai_inferred_only');
  }

  for (const v of Object.values(ev)) {
    if (typeof v === 'string' && aliases.has(v.trim().toLowerCase())) {
      add('evidence_field_is_null_alias');
      break;
    }
  }

  // Can the pack act on this attribute? `not_applicable` is a real answer; blank is not.
  const opField = rules.operability?.field || 'actionable_via';
  const opValue = attr?.[opField];
  if (isBlank(opValue)) add('actionable_via_absent');

  const states = rules.attribute_states || [];
  const proposedState = attr?.state;
  if (proposedState !== undefined && !states.includes(proposedState)) add('unknown_state');

  const tiers = rules.tiering?.tiers || [];
  const proposedTier = attr?.proposed_tier;
  if (proposedTier !== undefined && proposedTier !== null && !tiers.includes(proposedTier)) add('unknown_tier');

  const verdicts = rules.verdicts || [];
  const proposedVerdict = attr?.proposed_verdict;
  if (proposedVerdict !== undefined && !verdicts.includes(proposedVerdict)) add('unknown_verdict');

  const cleared = reasons.length === 0;
  const state = cleared && states.includes(proposedState) ? proposedState : rules.default_state;

  let tier = null;
  if (proposedTier !== undefined && proposedTier !== null && tiers.includes(proposedTier)) {
    if (state === rules.tiering?.requires_state) tier = proposedTier;
    else add('tier_requires_evidenced');
  }

  const verdict = (reasons.length === 0 && verdicts.includes(proposedVerdict))
    ? proposedVerdict
    : rules.default_verdict;

  return { state, verdict, tier, reasons };
}

/**
 * Review a whole candidate `gtm/icp.yaml`. Approval is a document-level fact, so it
 * lives here rather than on each attribute.
 */
export function reviewIcp (doc, rules = loadIcpRules()) {
  const reasons = [];
  if (rules.write_requires_explicit_approval === true && doc?.approved !== true) {
    reasons.push('not_approved');
  }
  const attributes = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const reviewed = attributes.map(a => ({ name: a?.name, ...reviewAttribute(a, rules) }));
  const writable = reasons.length === 0;
  return { writable, reasons, attributes: reviewed };
}

/** An attribute whose evidence is complete and verified. Tests mutate a clone. */
export function goodAttribute () {
  return {
    name: 'headcount_band_201_500',
    state: 'evidenced',
    proposed_tier: 'tier_1',
    proposed_verdict: 'keep',
    actionable_via: 'company_size',
    evidence: {
      observed_in: ['Acme', 'Beta Ltd', 'Corvus', 'Delta GmbH'],
      sample_size: 12,
      sample_definition: 'closed-won in the last four quarters, excluding renewals',
      contrast_observed_in: ['Zeta'],
      contrast_sample_size: 14,
      provenance: 'verified',
    },
  };
}

export function goodIcp () {
  return { approved: true, version: 2, supersedes: 1, attributes: [goodAttribute()] };
}
