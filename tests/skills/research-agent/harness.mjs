// tests/skills/research-agent/harness.mjs — the executable form of /research-agent.
//
// WHY THIS FILE EXISTS
//
// Two rules in this skill fail in ways prose cannot catch.
//
//   The Iron Law — a question with no findable answer yields the explicit null. Its
//   failure mode is a confident number for a private company's ARR, quoted back in a
//   meeting a week later. Asserting on the prose would prove a sentence exists.
//
//   The fan-out — a freeform question over a list is per-row cost times rows, and the
//   user does not know that when they ask. Its failure mode is a bill.
//
// So the routing table lives in `skills/research-agent/SKILL.md` as a fenced,
// machine-readable `research-routes` block and this file runs that block — the same
// technique /comply, /personalize and /call-intel use. The RULES are the skill's.
//
// WHAT THIS HARNESS IS NOT. It is not a research agent. Fetching is the runtime's job
// and reasoning is the surrounding model's, so there is nothing here to stub. What the
// harness does is enforce the CONTRACT around both: which template a question routes
// to, what that route costs before it runs, and what the answer may be when the route
// comes back empty.
//
// Delegated, never re-implemented:
//   the null enum + validation -> _lib/dual-contract.mjs
//   prices                     -> _lib/dryrun.mjs priceCall(), off the generated catalog
//   thresholds                 -> _lib/gates.mjs (gateValue; MissingGateKey => STOP)

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../../_lib/gates.mjs';
import { priceCall } from '../../../_lib/dryrun.mjs';
import { NULL_ENUM, validateDualContract, isExplicitNull } from '../../../_lib/dual-contract.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'research-agent', 'SKILL.md');
export const CORPUS_MAP_PATH = join(REPO, 'skills', 'research-agent', 'research-question-corpus.json');

export { NULL_ENUM, validateDualContract, isExplicitNull, MissingGateKey, STOP, loadGates, gateValue };

export const ANSWER_NULL = 'answer_null';
export const LOCAL = 'local';
export const HANDOFF = 'handoff';
export const ROUTE = 'route';
export const REFUSE = 'refuse';

export const NOT_FOUND = 'not_found';
export const NOT_VERIFIABLE = 'not_verifiable';
export const NOT_APPLICABLE = 'not_applicable';

export class ResearchRoutesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'ResearchRoutesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the routing table OUT OF THE SKILL, and refuse a fail-open edit.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+research-routes[ \t]*$/m;

export function loadResearchRoutes ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new ResearchRoutesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new ResearchRoutesUnavailable('unterminated `research-routes` fence');
  if (blocks.length === 0) {
    throw new ResearchRoutesUnavailable(
      'skills/research-agent/SKILL.md carries no ```yaml research-routes block — the table is the router');
  }
  if (blocks.length > 1) {
    throw new ResearchRoutesUnavailable(`${blocks.length} research-routes blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new ResearchRoutesUnavailable(`research-routes is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new ResearchRoutesUnavailable('research-routes is empty');

  // Law 5, at load time. Every check below is the Iron Law or the fan-out gate in a
  // different place; flipping any one word would disarm it silently in production
  // while the happy-path tests stayed green.
  if (doc.default_decision !== REFUSE) {
    throw new ResearchRoutesUnavailable(
      `default_decision is ${JSON.stringify(doc.default_decision)}; it must be "${REFUSE}" — law 5`);
  }
  if (doc.unmatched_question_action !== REFUSE) {
    throw new ResearchRoutesUnavailable(
      'unmatched_question_action must be "refuse" — an improvised route is an unpriced route');
  }
  const enums = new Set(doc.null_enum || []);
  if (enums.size !== NULL_ENUM.length || NULL_ENUM.some(n => !enums.has(n))) {
    throw new ResearchRoutesUnavailable(
      `null_enum must be exactly ${NULL_ENUM.join(' | ')} — the dual contract has one null enum, not two`);
  }
  if (doc.free_text_null_allowed !== false
      || !Array.isArray(doc.banned_result_strings) || doc.banned_result_strings.length === 0) {
    throw new ResearchRoutesUnavailable(
      'free_text_null_allowed must be false and banned_result_strings must be non-empty — '
      + '"not publicly disclosed" is a null wearing prose, and the dual contract\'s generic '
      + 'alias list does not carry the phrasings a research answer reaches for');
  }

  const reg = doc.undiscoverable;
  if (!reg || reg.checked_before_routing !== true) {
    throw new ResearchRoutesUnavailable(
      'undiscoverable.checked_before_routing must be true — a refusal that routes first is a refusal that spends');
  }
  if (reg.spend !== 'none' || reg.planned_calls !== 0) {
    throw new ResearchRoutesUnavailable('the undiscoverable register must cost nothing — refusing must be free');
  }
  if (!Array.isArray(reg.shapes) || reg.shapes.length === 0) {
    throw new ResearchRoutesUnavailable('the undiscoverable register is empty — the Iron Law has no teeth');
  }
  for (const s of reg.shapes) {
    if (!NULL_ENUM.includes(s.answers_null)) {
      throw new ResearchRoutesUnavailable(
        `undiscoverable shape ${s.id} answers ${JSON.stringify(s.answers_null)}, which is not one of the explicit nulls`);
    }
    if (!Array.isArray(s.asks_for) || s.asks_for.length === 0) {
      throw new ResearchRoutesUnavailable(`undiscoverable shape ${s.id} matches nothing`);
    }
    if (!s.why) throw new ResearchRoutesUnavailable(`undiscoverable shape ${s.id} gives no reason`);
  }
  // THE case the Iron-Law suite recorded before this skill existed.
  const financials = reg.shapes.find(s => s.id === 'private_financials');
  if (!financials || financials.answers_null !== NOT_FOUND) {
    throw new ResearchRoutesUnavailable(
      'the register must carry private_financials answering not_found — that IS the Iron Law');
  }

  if (!Array.isArray(doc.templates) || doc.templates.length === 0) {
    throw new ResearchRoutesUnavailable('there are no templates — this skill is a library, not a loop');
  }

  const fo = doc.fan_out || {};
  for (const k of ['show_per_row', 'show_list_total', 'approval_required_before_first_call',
    'pilot_required_before_full_run']) {
    if (fo[k] !== true) {
      throw new ResearchRoutesUnavailable(
        `fan_out.${k} must be true — the plan IS the safety mechanism for a freeform question`);
    }
  }
  if (fo.on_missing_key !== 'stop') {
    throw new ResearchRoutesUnavailable('fan_out.on_missing_key must be "stop" — law 5');
  }
  for (const k of ['max_rows_gate', 'max_endpoints_per_row_gate', 'pilot_rows_gate', 'pilot_answer_rate_gate']) {
    if (typeof fo[k] !== 'string' || !fo[k].includes('.')) {
      throw new ResearchRoutesUnavailable(`fan_out.${k} must name a dotted gate key`);
    }
  }

  const inf = doc.inference || {};
  if (inf.mode !== 'local') {
    throw new ResearchRoutesUnavailable('inference.mode must be "local" — the local-inference rule names this skill explicitly');
  }
  if (inf.paid_hop_default !== 'off') {
    throw new ResearchRoutesUnavailable('inference.paid_hop_default must be "off"');
  }
  const reasons = inf.paid_hop_allowed_reasons || [];
  if (reasons.length !== 1 || reasons[0] !== 'perplexity_web_grounding') {
    throw new ResearchRoutesUnavailable(
      'the only reason ai_enrich earns its price here is perplexity_web_grounding — '
      + `saw ${JSON.stringify(reasons)}`);
  }
  if (inf.batch_scale_allowed !== false || !inf.batch_scale_reason) {
    throw new ResearchRoutesUnavailable(
      'batch_scale_allowed must be false, with the reason stated — this skill\'s unit of work '
      + 'is a fetch, not a model call');
  }
  if (inf.llm_output_merged_into_verified !== false) {
    throw new ResearchRoutesUnavailable('an LLM-derived value is never merged into a verified field');
  }
  if (inf.confidence !== 'numeric_0_1') {
    throw new ResearchRoutesUnavailable('confidence is numeric 0..1 — a worded confidence was abolished');
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Classify. Free answers first, so a refusal and a reformat never reach a plan.
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-phrase match, so "arr" does not fire on "arrangement". */
function mentions (question, phrase) {
  const p = norm(phrase);
  if (!p) return false;
  return new RegExp(`(?:^|[^a-z0-9])${esc(p)}(?:$|[^a-z0-9])`, 'i').test(norm(question));
}

function firstMatch (question, phrases = []) {
  for (const p of phrases) if (mentions(question, p)) return p;
  return null;
}

/**
 * One question -> one route. The order IS the design: undiscoverable, then local,
 * then somebody else's endpoint, then a template, then refuse.
 *
 * @returns {{decision, template, tier, null, why, matched, handoff_to?, planned_calls}}
 */
export function classifyQuestion ({ question, row = {}, routes = loadResearchRoutes() } = {}) {
  const q = String(question ?? '');
  if (!q.trim()) {
    return { decision: REFUSE, template: null, tier: null, null: null, planned_calls: 0,
      why: 'no question asked' };
  }

  // 1. The undiscoverable register, checked BEFORE routing and free.
  for (const shape of routes.undiscoverable.shapes) {
    const hit = firstMatch(q, shape.asks_for);
    if (!hit) continue;
    const escape = shape.escape;
    if (escape && escape.requires_row_field && row[escape.requires_row_field]) {
      return {
        decision: ROUTE, template: escape.route, tier: 'grounded', null: null, matched: hit,
        planned_calls: perRowCalls(routes, escape.route),
        why: `${shape.id} escaped via ${escape.id}: the row carries ${escape.requires_row_field}`,
      };
    }
    return {
      decision: ANSWER_NULL, template: 'undiscoverable', tier: 'unreachable',
      null: shape.answers_null, matched: hit, shape: shape.id, planned_calls: 0, spend: 'none',
      why: shape.why,
    };
  }

  // 2. Local — no fetch at all.
  const local = routes.templates.find(t => t.id === 'local_reasoning');
  const localHit = local && firstMatch(q, local.answers);
  if (localHit) {
    return { decision: LOCAL, template: 'local_reasoning', tier: 'local', null: null,
      matched: localHit, planned_calls: 0, spend: 'none',
      why: 'derivable from columns the row already carries; the agent does this at no marginal cost' };
  }

  // 3. Somebody else's endpoint.
  const handoff = routes.templates.find(t => t.id === 'handoff');
  if (handoff) {
    for (const [skill, phrases] of Object.entries(handoff.targets || {})) {
      const hit = firstMatch(q, phrases);
      if (!hit) continue;
      return { decision: HANDOFF, template: 'handoff', tier: 'routed', null: null,
        matched: hit, handoff_to: skill, planned_calls: 0, spend: 'none', why: handoff.reason };
    }
  }

  // 4. A template.
  for (const t of routes.templates) {
    if (['local_reasoning', 'handoff'].includes(t.id)) continue;
    const hit = firstMatch(q, t.answers || []);
    if (!hit) continue;
    return { decision: ROUTE, template: t.id, tier: t.tier, null: null, matched: hit,
      planned_calls: t.per_row_calls, why: `matched template ${t.id} on "${hit}"` };
  }

  // 5. Nothing. Refuse — never improvise.
  return {
    decision: REFUSE, template: null, tier: null, null: null, planned_calls: 0,
    why: 'no template recognises this question. An improvised route is an unpriced route; '
      + 'say what column or narrower question would make it answerable.',
  };
}

function perRowCalls (routes, templateId) {
  const t = routes.templates.find(x => x.id === templateId);
  return t ? t.per_row_calls : 0;
}

// ---------------------------------------------------------------------------
// 3. The fan-out plan. Per row AND in total, before anything runs.
// ---------------------------------------------------------------------------

function gateOrStop (gates, key, stops) {
  try { return { ok: true, value: gateValue(gates, key) }; }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    stops.push({ gate: key, decision: STOP, failed_closed: true, reason: e.message });
    return { ok: false, value: null };
  }
}

/**
 * Price the whole fan-out. Pure: makes no calls, writes nothing, spends nothing.
 *
 * The three lines a user must see are all here and none is optional:
 *   per_row      — every hop for ONE row, named, priced from the catalog
 *   per_row_credits
 *   list_total_credits — per row x rows. This is the number a freeform ask hides.
 */
export function planFanOut ({
  question, rows = 1, row = {}, catalog, gates = loadGates(), routes = loadResearchRoutes(),
  expectedResults = null,
} = {}) {
  if (!catalog || !catalog.endpoints) throw new Error('planFanOut needs the generated catalog');
  const cls = classifyQuestion({ question, row, routes });
  const stops = [];

  const plan = {
    question: String(question ?? ''),
    dry_run: true,
    calls_made: 0,
    decision: cls.decision,
    template: cls.template,
    tier: cls.tier,
    null: cls.null,
    why: cls.why,
    handoff_to: cls.handoff_to ?? null,
    rows,
    per_row: [],
    per_row_calls: 0,
    per_row_credits: 0,
    list_total_credits: 0,
    unverifiable_hops: [],
    unpriced_hops: [],
    optional_hops: [],
    requires_approval: false,
    stops,
    gates_read: [],
  };

  // The free decisions never reach a gate and never reach a price.
  if (cls.decision === ANSWER_NULL || cls.decision === LOCAL
      || cls.decision === HANDOFF || cls.decision === REFUSE) {
    plan.spend = 'none';
    return plan;
  }

  const tmpl = routes.templates.find(t => t.id === cls.template);
  if (!tmpl) { stops.push({ gate: 'templates', decision: STOP, reason: `no template ${cls.template}` }); return plan; }

  for (const hop of tmpl.route || []) {
    const def = catalog.endpoints[hop.endpoint];
    if (!def) { stops.push({ gate: 'catalog', decision: STOP, reason: `${hop.endpoint} is not in the catalog` }); continue; }
    const priced = priceCall(def, { expectedResults });
    const line = {
      endpoint: hop.endpoint,
      credits: priced.credits,
      basis: priced.basis,
      known: priced.known,
      optional: hop.optional === true,
      must_set: hop.must_set || [],
      // law 4: a hop whose billing field is absent can never be reconciled.
      actual_verifiable: def.pricing?.billing_field_present_in_response !== false,
    };
    plan.per_row.push(line);
    if (!line.actual_verifiable) plan.unverifiable_hops.push(hop.endpoint);
    if (line.optional) plan.optional_hops.push(hop.endpoint);
    if (!line.known) {
      // An unpriced hop cannot be approved, so it STOPs rather than costing zero.
      // per_result endpoints reach this whenever the caller gave no result count:
      // "the limit you set IS the estimate basis, so an unset limit is an unpriced
      // call". A plan with an unknown line is not a plan.
      plan.unpriced_hops.push(hop.endpoint);
      stops.push({
        gate: 'fan_out.show_per_row', decision: STOP, failed_closed: true,
        reason: `${hop.endpoint} is priced ${def.pricing?.model} and no result count was set — `
          + 'an unset limit is an unpriced call, and an unpriced line cannot be approved',
      });
    }
    if (!line.optional) {
      plan.per_row_calls += 1;
      if (line.known && plan.per_row_credits != null) plan.per_row_credits += line.credits;
      else plan.per_row_credits = null;
    }
  }

  plan.list_total_credits = plan.per_row_credits == null ? null : plan.per_row_credits * rows;
  plan.requires_approval = routes.fan_out.approval_required_before_first_call === true;

  // The structural clamps. Both read a key that is not merged yet, so both STOP.
  const fo = routes.fan_out;
  const maxRows = gateOrStop(gates, fo.max_rows_gate, stops);
  plan.gates_read.push(fo.max_rows_gate);
  if (maxRows.ok && rows > maxRows.value) {
    stops.push({ gate: fo.max_rows_gate, decision: STOP,
      reason: `${rows} rows exceeds the per-run ceiling of ${maxRows.value}` });
  }
  const maxWidth = gateOrStop(gates, fo.max_endpoints_per_row_gate, stops);
  plan.gates_read.push(fo.max_endpoints_per_row_gate);
  if (maxWidth.ok && plan.per_row.length > maxWidth.value) {
    stops.push({ gate: fo.max_endpoints_per_row_gate, decision: STOP,
      reason: `${plan.per_row.length} hops per row exceeds the fan-out width ceiling of ${maxWidth.value}` });
  }
  const pilot = gateOrStop(gates, fo.pilot_rows_gate, stops);
  plan.gates_read.push(fo.pilot_rows_gate);
  plan.pilot_rows = pilot.ok ? Math.min(pilot.value, rows) : null;

  plan.blocked = stops.length > 0;
  return plan;
}

/**
 * The pilot verdict. An answered fraction below the coverage floor is a STOP: a
 * question that answers one row in ten is not worth the other four hundred and ninety.
 */
export function pilotVerdict ({ answered, total, gates = loadGates(), routes = loadResearchRoutes() } = {}) {
  const key = routes.fan_out.pilot_answer_rate_gate;
  let floor;
  try { floor = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return { decision: STOP, gate: key, failed_closed: true, reason: e.message };
  }
  if (!total) return { decision: STOP, gate: key, reason: 'an empty pilot answers nothing' };
  const pct = (answered / total) * 100;
  return {
    decision: pct >= floor ? 'continue' : STOP,
    gate: key, floor, answered_pct: pct,
    reason: pct >= floor
      ? `${answered}/${total} answered, at or above the floor`
      : `${answered}/${total} answered, below the floor — a better question, not more rows`,
  };
}

// ---------------------------------------------------------------------------
// 4. The answer. A real value or ONE member of the enum. Never a sentence.
// ---------------------------------------------------------------------------

export function checkResultShape (result, routes = loadResearchRoutes()) {
  if (NULL_ENUM.includes(result)) return { ok: true };
  if (typeof result === 'string') {
    const flat = result.trim().toLowerCase().replace(/[.!]+$/, '');
    const banned = (routes.banned_result_strings || []).map(x => String(x).toLowerCase());
    if (banned.some(b => flat === b || flat.startsWith(b))) {
      return { ok: false, reason: `${JSON.stringify(result)} is a null wearing prose — `
        + `use the explicit enum (${NULL_ENUM.join(' | ')})` };
    }
  }
  return { ok: true };
}

/**
 * One row -> one dual-contract record.
 *
 * @param {{classification, finding, source, confidence, routes}} args
 *        `finding` is whatever the route came back with. undefined/null/'' means the
 *        route ran and found nothing, which is not_found — never a guess.
 */
export function answerRow ({
  classification, finding = undefined, source = null, confidence = null,
  routes = loadResearchRoutes(),
} = {}) {
  const cls = classification;
  if (!cls) throw new Error('answerRow needs a classification');

  let result, reasoning, src, conf;

  if (cls.decision === ANSWER_NULL) {
    result = cls.null;
    reasoning = cls.why;
    src = `undiscoverable_register:${cls.shape}`;
    conf = 1;
  } else if (cls.decision === REFUSE) {
    result = NOT_FOUND;
    reasoning = cls.why;
    src = 'research-routes:unmatched_question_action=refuse';
    conf = 1;
  } else if (cls.decision === HANDOFF) {
    result = NOT_APPLICABLE;
    reasoning = `${cls.why} Hand off to /${cls.handoff_to}.`;
    src = `handoff:${cls.handoff_to}`;
    conf = 1;
  } else if (finding === undefined || finding === null || finding === '') {
    const tmpl = routes.templates.find(t => t.id === cls.template) || {};
    result = tmpl.answer_absent_null || NOT_FOUND;
    reasoning = tmpl.answer_absent_reason
      || `the route ran and the fact was not there (${cls.template})`;
    src = source || `template:${cls.template}`;
    conf = 1;
  } else {
    result = finding;
    reasoning = `answered from ${source || cls.template}`;
    src = source || `template:${cls.template}`;
    conf = confidence == null ? 0.8 : confidence;
  }

  const shape = checkResultShape(result, routes);
  if (!shape.ok) throw new Error(`research-agent produced a result this skill forbids: ${shape.reason}`);

  const record = { result, confidence: conf, reasoning, source: src };
  const v = validateDualContract(record);
  if (!v.valid) {
    throw new Error(`research-agent produced a record the dual contract rejects: ${v.errors.join('; ')}`);
  }
  return { record, result, null: isExplicitNull(record) ? result : null, decision: cls.decision };
}

// ---------------------------------------------------------------------------
// 5. Local inference. The paid LLM hop, as a decision rather than as a call.
// ---------------------------------------------------------------------------

export function planLlmHop ({
  reason, useWebSearch = false, provider = null,
  gates = loadGates(), routes = loadResearchRoutes(),
} = {}) {
  const inf = routes.inference;
  const allowed = inf.paid_hop_allowed_reasons || [];
  if (!allowed.includes(reason)) {
    return {
      decision: REFUSE, mode: 'local', gate: 'inference.paid_hop_allowed_reasons',
      reason: `"${reason}" is not one of ${allowed.join(' | ')} — this skill's unit of work is a `
        + 'fetch, and the reasoning over what came back is already free',
    };
  }
  const key = inf.paid_hop_requires_grounding_gate;
  let required;
  try { required = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return {
      decision: REFUSE, mode: 'local', gate: key, failed_closed: true,
      reason: `${e.message} — failing closed (law 5); the grounded route is unavailable until the key is merged`,
    };
  }
  if (required === true && (useWebSearch !== true || provider !== 'perplexity')) {
    return {
      decision: REFUSE, mode: 'local', gate: key,
      reason: 'without provider=perplexity and use_web_search the hop is the local model at a price',
    };
  }
  return { decision: 'emit', mode: 'paid', gate: key, reason, requires_dry_run: true };
}

export function loadCorpusMap ({ path = CORPUS_MAP_PATH } = {}) {
  if (!existsSync(path)) throw new ResearchRoutesUnavailable(`no research-question-corpus.json at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export default {
  loadResearchRoutes, classifyQuestion, planFanOut, pilotVerdict, answerRow,
  checkResultShape, planLlmHop, loadCorpusMap,
  ANSWER_NULL, LOCAL, HANDOFF, ROUTE, REFUSE,
  NULL_ENUM, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE, ResearchRoutesUnavailable,
};
