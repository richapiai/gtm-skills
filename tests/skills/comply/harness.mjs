// tests/skills/comply/harness.mjs — the executable form of the /comply gate.
//
// WHY THIS FILE EXISTS
//
// `/comply` is a gate, not advice, and a gate that is only prose cannot be tested.
// Asserting on the prose would be worse than no test: prose assertions rot, and they
// prove that a sentence exists, not that breaking the rule fails.
//
// So the rule table lives in `skills/comply/SKILL.md` as a fenced, machine-readable
// `comply-rules` block, and this file is the conformance harness that runs it. The
// RULES are the skill's; the glue is here. Three consequences:
//
//   1. Editing a verdict in the skill changes what the evals see. An edit that fails
//      open turns tests/evals/comply/ red.
//   2. Deleting the block, renaming a jurisdiction, or dropping a refusal condition
//      is a red run, not a silent policy change.
//   3. The harness cannot fail open by accident: every lookup that misses returns
//      `stop`, and every fact that cannot be computed counts as fired.
//
// Everything with real consequences is delegated to the shipped engines and never
// re-implemented here:
//   suppression  -> _lib/suppression.mjs   (loadSuppressionStore / isSuppressed)
//   erasure      -> _lib/pii.mjs           (erase + eraseDecision + countErasableRows;
//                                          measuring is always a dry run)
//   thresholds   -> _lib/gates.mjs         (gateValue; MissingGateKey => STOP)

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { gateValue, MissingGateKey, ALLOW, CONFIRM, STOP } from '../../../_lib/gates.mjs';
import { loadSuppressionStore, isSuppressed, rowIdentifiers, SuppressionUnavailableError }
  from '../../../_lib/suppression.mjs';
import { countErasableRows, eraseDecision } from '../../../_lib/pii.mjs';
import { isCountryCode, countryOfSubdivision } from '../../../_lib/jurisdiction.mjs';
import { NULL_ENUM } from '../../../_lib/dual-contract.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'comply', 'SKILL.md');

export { ALLOW, CONFIRM, STOP, NULL_ENUM, MissingGateKey, SuppressionUnavailableError };

/** The three ways this pack is allowed to say "no answer". */
export const NOT_FOUND = 'not_found';
export const NOT_APPLICABLE = 'not_applicable';

export class ComplyRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'ComplyRulesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the gate table OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+comply-rules[ \t]*$/m;

/**
 * Extract and parse the `comply-rules` block from skills/comply/SKILL.md.
 * A missing, duplicated or unparseable block throws — the harness has no default
 * table, because a default table is exactly how a deleted gate goes unnoticed.
 */
export function loadComplyRules ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new ComplyRulesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const blocks = [];
  let open = null;
  for (const line of lines) {
    if (open === null) {
      if (FENCE_RE.test(line)) open = [];
      continue;
    }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new ComplyRulesUnavailable('unterminated `comply-rules` fence');
  if (blocks.length === 0) {
    throw new ComplyRulesUnavailable(
      'skills/comply/SKILL.md carries no ```yaml comply-rules block — the gate table is the gate');
  }
  if (blocks.length > 1) {
    throw new ComplyRulesUnavailable(`${blocks.length} comply-rules blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new ComplyRulesUnavailable(`comply-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new ComplyRulesUnavailable('comply-rules parsed to nothing');
  for (const key of ['default_verdict', 'detection', 'jurisdictions', 'channels', 'default_channel']) {
    if (doc[key] === undefined) throw new ComplyRulesUnavailable(`comply-rules is missing \`${key}\``);
  }
  if (doc.default_verdict !== STOP) {
    throw new ComplyRulesUnavailable(
      `comply-rules default_verdict is "${doc.default_verdict}" — law 5 says the default is "${STOP}"`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Jurisdiction detection. Unknown fails closed.
// ---------------------------------------------------------------------------

const up = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function emailDomain (row) {
  const e = low(row.email);
  const at = e.lastIndexOf('@');
  return at < 0 ? '' : e.slice(at + 1);
}

/**
 * Which regimes apply to this row.
 *
 * `on_conflict: all_apply` — signals are not ranked into a winner. Every regime any
 * signal names applies, and each must clear independently. Picking one would mean
 * choosing which law to ignore.
 *
 * Returns { jurisdictions: [...], signals: {regime: signal}, unresolved, declared_unknown }.
 */
export function resolveJurisdictions (row, rules) {
  const det = rules.detection || {};
  const known = new Set(Object.keys(rules.jurisdictions || {}));
  const matched = new Map();       // regime -> the signal that named it
  const note = (regime, signal) => { if (known.has(regime) && !matched.has(regime)) matched.set(regime, signal); };

  // A regime the operator declares outright is authoritative — including when it is
  // one this pack has no rule set for. "We wrote no rules for this place" is not a
  // finding that the place has no rules.
  const declared = low(row.jurisdiction || row.declared_jurisdiction);
  if (declared) {
    if (!known.has(declared)) {
      return { jurisdictions: [], signals: {}, unresolved: true, declared_unknown: declared, located: [] };
    }
    note(declared, 'declared');
  }

  const subdivisions = det.subdivisions || {};
  const region = up(row.subject_region);
  if (region && subdivisions[region]) note(low(subdivisions[region]), 'subject_region');

  // Every country code the row STATES, matched or not: a stated country with no rule
  // set and a row that states no country are different refusals with opposite fixes.
  const countries = det.countries || {};
  const located = [];
  const pairs = [['subject_region', det.subdivision_implies_country ? countryOfSubdivision(region) : null]];
  for (const f of ['subject_country', 'phone_country', 'company_hq_country']) pairs.push([f, up(row[f])]);
  for (const [field, code] of pairs) {
    if (!code) continue;
    if (isCountryCode(code)) located.push(code);
    if (subdivisions[code]) { note(low(subdivisions[code]), field); continue; }
    for (const [regime, list] of Object.entries(countries)) {
      if (Array.isArray(list) && list.map(up).includes(code)) note(low(regime), field);
    }
  }

  const domain = emailDomain(row);
  if (domain) {
    for (const [regime, list] of Object.entries(det.tlds || {})) {
      if (!Array.isArray(list)) continue;
      if (list.some(t => domain.endsWith(low(t)))) note(low(regime), 'email_tld');
    }
  }

  const jurisdictions = [...matched.keys()].sort();
  return {
    jurisdictions,
    signals: Object.fromEntries(matched),
    unresolved: jurisdictions.length === 0,
    declared_unknown: null,
    located: [...new Set(located)],
  };
}

// ---------------------------------------------------------------------------
// 3. Facts. Computed from the row, never asserted. Uncomputable => fired.
// ---------------------------------------------------------------------------

const isTrue = (v) => v === true || low(v) === 'true' || low(v) === 'yes';

function addMonths (date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp a rolled-over short month (31 Jan + 1 month must not become 3 March).
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

export function isPersonalInbox (row, rules) {
  if (low(row.address_type) === 'personal') return true;
  const domain = emailDomain(row);
  if (!domain) return false;
  return (rules.personal_inbox_domains || []).map(low).includes(domain);
}

/**
 * CASL implied consent, s.10(9)(a). Fail closed at every branch: an unnamed event,
 * an event with no configured window, and an unparseable timestamp are all expired.
 */
function impliedConsentExpired (row, jur, now) {
  if (low(row.consent_kind) !== 'implied') return false;
  const windows = jur.implied_consent_windows || {};
  const event = low(row.consent_event);
  if (!event) return true;
  if (!Object.prototype.hasOwnProperty.call(windows, event)) return true;
  const win = windows[event];
  if (win === 'none' || win === null) return false;         // published address: no clock
  const months = win && typeof win === 'object' ? Number(win.months) : NaN;
  if (!Number.isFinite(months)) return true;
  const ts = Date.parse(row.consent_timestamp);
  if (Number.isNaN(ts)) return true;
  return addMonths(new Date(ts), months).getTime() < now.getTime();
}

/**
 * Every named fact, for one regime. `suppressed` comes from the real engine.
 * Anything a fact needs and cannot get resolves to `true` when it is a refusal
 * condition — an unanswerable check is a failed check.
 */
export function computeFacts (row, rules, jurName, { suppressed, now }) {
  const jur = rules.jurisdictions[jurName] || {};
  const basisField = jur.basis_field;
  const declaredBasis = basisField ? low(row[basisField]) : '';
  return {
    suppressed: suppressed === true,
    objection_recorded: isTrue(row.objection),
    source_undisclosed: !String(row.data_source ?? '').trim(),
    personal_inbox_without_consent: isPersonalInbox(row, rules) && declaredBasis !== 'consent',
    no_unsubscribe_mechanism: !isTrue(row.unsubscribe_mechanism),
    no_physical_postal_address: !String(row.sender_postal_address ?? '').trim(),
    notice_at_collection_missing: !isTrue(row.notice_at_collection),
    opt_out_of_sale_recorded: isTrue(row.opt_out_sale),
    sensitive_pi_without_notice: isTrue(row.sensitive_pi) && !isTrue(row.sensitive_pi_notice),
    implied_consent_expired: impliedConsentExpired(row, jur, now),
    published_address_refuses_cem:
      low(row.consent_event) === 'published_address' && isTrue(row.published_address_refuses_cem),
    role_irrelevant:
      low(row.consent_event) === 'published_address' && !isTrue(row.role_relevant),
  };
}

// ---------------------------------------------------------------------------
// 3b. The channel dimension. Mirrors the shipped script exactly.
//
// A verdict is per CHANNEL because a precondition is: CAN-SPAM's postal address is a
// rule about a commercial e-mail, and it was firing on lists with no email on them.
// Both mechanisms fail closed — a rule set governs only the channels it names, and a
// scoped condition applies only when one of its channels is in play.
// ---------------------------------------------------------------------------

export class UnknownChannel extends Error {
  constructor (msg) { super(msg); this.name = 'UnknownChannel'; this.complyCode = 'unknown_channel'; }
}

/** The channels in play: one named channel, or every channel for `mixed`. */
export function resolveChannels (rules, channel) {
  const all = (rules.channels || []).map(low).filter(Boolean);
  if (all.length === 0) throw new ComplyRulesUnavailable('comply-rules names no `channels`');
  const asked = low(channel) || low(rules.default_channel);
  if (asked === 'mixed') return [...all].sort();
  if (!all.includes(asked)) {
    throw new UnknownChannel(`channel ${JSON.stringify(asked)} is not one of: ${all.join(', ')}, mixed`);
  }
  return [asked];
}

/** Does this rule set govern this channel? A rule set naming no channels governs none. */
export function governs (rules, regime, channel) {
  const named = rules.jurisdictions?.[regime]?.channels;
  return Array.isArray(named) && named.map(low).includes(channel);
}

// ---------------------------------------------------------------------------
// 4. One regime's rule set.
// ---------------------------------------------------------------------------

function checkOneJurisdiction (row, rules, jurName, { suppressed, now, channels }) {
  const jur = rules.jurisdictions[jurName];
  if (!jur) {
    return { verdict: STOP, basis: NOT_FOUND, reasons: ['no_rule_set'], citation: null };
  }
  const reasons = [];
  const accepted = Array.isArray(jur.accepted_basis) ? jur.accepted_basis.map(low) : [];
  let basis;

  if (accepted.length === 0) {
    // Not a consent regime. The basis question does not apply, and is answered with
    // the explicit null rather than a borrowed one from another regime.
    basis = low(jur.absent_basis_is) || NOT_APPLICABLE;
    if (!NULL_ENUM.includes(basis)) {
      reasons.push('absent_basis_is_not_an_explicit_null');
      basis = NOT_FOUND;
    }
  } else {
    const raw = low(row[jur.basis_field]);
    if (!raw) {
      basis = NOT_FOUND;
      reasons.push('basis_not_recorded');
    } else if (!accepted.includes(raw)) {
      basis = NOT_FOUND;
      reasons.push(`basis_not_accepted:${raw}`);
    } else {
      basis = raw;
      const needed = (jur.evidence_required || {})[raw] || [];
      for (const field of needed) {
        if (!String(row[field] ?? '').trim()) {
          reasons.push(`evidence_missing:${field}`);
          basis = NOT_FOUND;
        }
      }
    }
  }

  const facts = computeFacts(row, rules, jurName, { suppressed, now });
  // Scope before uncomputability: a condition that is not in play for this channel is
  // not a check that failed, it is a check that does not apply. Mirrors the shipped
  // script; `tests/skills/comply/shipped-gate.test.mjs` asserts the two never disagree.
  const scope = rules.channel_conditions || {};
  for (const name of jur.refuse_when || []) {
    const only = scope[name];
    if (Array.isArray(only) && !only.map(low).some(c => channels.includes(c))) continue;
    if (facts[name] === undefined) { reasons.push(`fact_uncomputable:${name}`); continue; }
    if (facts[name]) reasons.push(name);
  }

  return {
    verdict: reasons.length ? STOP : ALLOW,
    basis,
    reasons,
    citation: typeof jur.citation === 'string' ? jur.citation.trim() : null,
    facts,
  };
}

// ---------------------------------------------------------------------------
// 5. The gate, for one row.
// ---------------------------------------------------------------------------

/**
 * `store` is REQUIRED. The suppression check is part of the gate, and running the
 * gate without it would be the fail-open this whole skill exists to prevent.
 *
 * @returns {{verdict:string, jurisdiction:string, jurisdictions:string[],
 *            basis:string, reasons:string[], per_jurisdiction:object}}
 */
export function checkRow (row, { rules, store, now = new Date(), channel } = {}) {
  if (!rules) throw new ComplyRulesUnavailable('checkRow: no rule table loaded — STOP');
  const channels = resolveChannels(rules, channel);
  if (!store || !(store.emails instanceof Set)) {
    throw new SuppressionUnavailableError(
      'checkRow: no suppression store loaded — STOP. A gate that skipped the suppression '
      + 'check did not run.');
  }
  const suppressed = rowIdentifiers(row).some(id => isSuppressed(store, id));

  const det = resolveJurisdictions(row, rules);
  if (det.unresolved) {
    const located = det.located || [];
    const reasons = det.declared_unknown
      ? [`no_rule_set:${det.declared_unknown}`]
      : located.length
        ? [`no_rule_set:${located.join('+').toLowerCase()}`]
        : ['unknown_jurisdiction'];
    if (suppressed) reasons.unshift('suppressed');
    return {
      verdict: rules.detection?.unresolved_verdict === ALLOW ? ALLOW : STOP,
      jurisdiction: low(rules.detection?.unresolved_jurisdiction) || NOT_FOUND,
      jurisdictions: [],
      basis: NOT_FOUND,
      reasons,
      per_jurisdiction: {},
      channels,
      channels_cleared: [],
      suppressed,
    };
  }

  // A channel nothing governs is a refusal, never a quiet clearance.
  const ungoverned = channels.filter(c => !det.jurisdictions.some(j => governs(rules, j, c)));
  if (ungoverned.length > 0) {
    return {
      verdict: low(rules.detection?.ungoverned_channel_verdict) === ALLOW ? ALLOW : STOP,
      jurisdiction: det.jurisdictions[0],
      jurisdictions: det.jurisdictions,
      basis: NOT_FOUND,
      reasons: ungoverned.map(c => `no_rule_set_for_channel:${c}`),
      per_jurisdiction: {},
      channels,
      channels_cleared: [],
      suppressed,
    };
  }

  const governing = det.jurisdictions.filter(j => channels.some(c => governs(rules, j, c)));
  const per = {};
  for (const j of governing) per[j] = checkOneJurisdiction(row, rules, j, { suppressed, now, channels });

  const refusing = governing.filter(j => per[j].verdict !== ALLOW);
  const primary = refusing[0] || governing[0];
  return {
    verdict: refusing.length ? STOP : ALLOW,
    jurisdiction: primary,
    jurisdictions: det.jurisdictions,
    basis: per[primary].basis,
    reasons: refusing.flatMap(j => per[j].reasons.map(r => `${j}:${r}`)),
    per_jurisdiction: per,
    signals: det.signals,
    channels,
    channels_cleared: refusing.length ? [] : [...channels],
    suppressed,
  };
}

/**
 * Screen a whole list. Loads the real suppression store, which THROWS when it is
 * missing or corrupt (law 5). Rows are returned split; nothing is written here —
 * writing an output list is `writeOutputList`'s job and only its job.
 */
export function screenList (rows, { root, rules = loadComplyRules(), now = new Date(), channel } = {}) {
  const store = loadSuppressionStore({ root });   // throws => STOP
  const cleared = [], refused = [];
  for (const row of rows) {
    const verdict = checkRow(row, { rules, store, now, channel });
    (verdict.verdict === ALLOW ? cleared : refused).push({ row, verdict });
  }
  return { cleared, refused, store };
}

// ---------------------------------------------------------------------------
// 6. Erasure: two confirmations, both fail closed.
//
// NOT IMPLEMENTED HERE ANY MORE. `countErasableRows` and `eraseDecision` used to live
// in this file, and this file is a TEST harness: `package.json:files[]` does not ship
// `tests/`, so the only implementation of the `erase_confirm_fraction` gate was one
// that never reached a user. Shipped `erase()` loaded no gates and asked nothing.
//
// They now live in `_lib/pii.mjs`, next to the deletion they guard, and this file
// re-exports them so the harness still measures the SAME code the CLI runs. If these
// two names ever drift back into this file, the gate has stopped shipping again.
// ---------------------------------------------------------------------------

export { countErasableRows, eraseDecision };

export default {
  loadComplyRules, resolveJurisdictions, resolveChannels, governs, computeFacts, checkRow, screenList,
  countErasableRows, eraseDecision, isPersonalInbox,
  ALLOW, CONFIRM, STOP, NULL_ENUM, NOT_FOUND, NOT_APPLICABLE, SKILL_PATH, REPO,
};
