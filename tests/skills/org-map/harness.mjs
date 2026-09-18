// tests/skills/org-map/harness.mjs — the executable form of /org-map.
//
// WHY THIS FILE EXISTS
//
// The Iron Law — *inferred edges are labelled inferred, and never default to the CEO*
// — is a rule whose failure mode is a drawn line that looks exactly like a real one.
// A law that exists only as prose cannot be tested, and asserting on the prose would
// prove that a sentence exists rather than that breaking the rule fails.
//
// So the edge rules live in `skills/org-map/SKILL.md` as a fenced, machine-readable
// `org-map-rules` block and this file runs that block — the same technique /comply
// uses for its gate table and /personalize for its copy rules. The RULES are the
// skill's; this file only executes them.
//
// Delegated, never re-implemented:
//   the null enum -> _lib/dual-contract.mjs  (NULL_ENUM, validateDualContract)
//   thresholds    -> _lib/gates.mjs          (gateValue; MissingGateKey => STOP)

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../../_lib/gates.mjs';
import { NULL_ENUM, validateDualContract } from '../../../_lib/dual-contract.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'org-map', 'SKILL.md');

export { NULL_ENUM, validateDualContract, MissingGateKey, STOP };

export const OBSERVED = 'observed';
export const INFERRED = 'inferred';
export const DRAW = 'draw';
export const REFUSE = 'refuse';
export const NOT_FOUND = 'not_found';
export const NOT_VERIFIABLE = 'not_verifiable';
export const NOT_APPLICABLE = 'not_applicable';

export class OrgMapRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'OrgMapRulesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the edge rules OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+org-map-rules[ \t]*$/m;

export function loadOrgMapRules ({ path = SKILL_PATH, src = null } = {}) {
  let text = src;
  if (text === null) {
    if (!existsSync(path)) throw new OrgMapRulesUnavailable(`no SKILL.md at ${path}`);
    text = readFileSync(path, 'utf8');
  }
  text = text.replace(/\r\n/g, '\n');

  const blocks = [];
  let open = null;
  for (const line of text.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new OrgMapRulesUnavailable('unterminated `org-map-rules` fence');
  if (blocks.length === 0) {
    throw new OrgMapRulesUnavailable(
      'skills/org-map/SKILL.md carries no ```yaml org-map-rules block — the block is the gate');
  }
  if (blocks.length > 1) {
    throw new OrgMapRulesUnavailable(`${blocks.length} org-map-rules blocks; there must be exactly one`);
  }

  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new OrgMapRulesUnavailable(`org-map-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new OrgMapRulesUnavailable('org-map-rules parsed to nothing');

  for (const key of ['default_decision', 'evidence_sources', 'iron_law', 'inferred_edge',
    'ceo_default', 'render', 'inference']) {
    if (doc[key] === undefined) throw new OrgMapRulesUnavailable(`org-map-rules is missing \`${key}\``);
  }

  // Fail closed on a rules edit that disarmed the law itself. Every one of these is a
  // one-word change that would otherwise leave the whole suite green.
  if (doc.default_decision !== 'refuse') {
    throw new OrgMapRulesUnavailable(
      `default_decision is "${doc.default_decision}" — law 5 says the default is "refuse"`);
  }
  if (doc.ceo_default?.banned !== true) {
    throw new OrgMapRulesUnavailable('ceo_default.banned is not true — the Iron Law is disarmed');
  }
  if (doc.inferred_edge?.assertable !== false) {
    throw new OrgMapRulesUnavailable('inferred_edge.assertable is not false — an inference is not a fact');
  }
  if (doc.render?.marker_on_edge_line !== true) {
    throw new OrgMapRulesUnavailable(
      'render.marker_on_edge_line is not true — a label in a footnote is not a label');
  }
  for (const kind of ['only_remaining_executive', 'elimination', 'graph_must_be_connected']) {
    if (!(doc.evidence_sources?.never || []).includes(kind)) {
      throw new OrgMapRulesUnavailable(`evidence_sources.never no longer bans \`${kind}\``);
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Titles: department and seniority. Deliberately a lexicon, not an LLM call —
//    Inference is local, and "local" for a test harness means DETERMINISTIC.
// ---------------------------------------------------------------------------

const low = (v) => String(v ?? '').trim().toLowerCase();

/** Order matters: "Account Executive" must not read as an executive. */
const DEPARTMENT_RULES = [
  [/\b(chief executive officer|ceo|founder|co-?founder|owner|managing director|general partner|president)\b/, 'executive'],
  [/\b(design|designer|ux|ui)\b/, 'design'],
  [/\b(sdr|bdr|sales development|business development|account executive|account manager|sales|revenue|cro)\b/, 'sales'],
  [/\b(marketing|demand gen|growth|brand|content|seo|communications|cmo)\b/, 'marketing'],
  [/\b(product manager|product owner|product|cpo)\b/, 'product'],
  [/\b(engineer|engineering|developer|software|devops|sre|infrastructure|platform|architect|data scientist|cto)\b/, 'engineering'],
  [/\b(finance|accounting|controller|treasur|cfo)\b/, 'finance'],
  [/\b(people|human resources|\bhr\b|talent|recruit|chro)\b/, 'people'],
  [/\b(legal|counsel|compliance)\b/, 'legal'],
  [/\b(customer success|support|onboarding)\b/, 'customer_success'],
  [/\b(operations|ops|logistics|supply)\b/, 'operations'],
];

export function departmentOf (title) {
  const t = low(title);
  for (const [re, dept] of DEPARTMENT_RULES) if (re.test(t)) return dept;
  return 'unknown';
}

/** A ladder, not a score. Only the ORDER is load-bearing. */
export const SENIORITY = Object.freeze({
  intern: 1, ic: 2, senior_ic: 3, manager: 4, director: 5, vp: 6, cxo: 7, top_of_house: 8,
});

const SENIORITY_RULES = [
  [/\b(chief executive officer|ceo|founder|co-?founder|owner|managing director|general partner|president)\b/, SENIORITY.top_of_house],
  [/\b(chief [a-z]+ officer|c[a-z]o)\b/, SENIORITY.cxo],
  [/\b(svp|evp|senior vice president|executive vice president)\b/, SENIORITY.cxo],
  [/\b(vp|vice president)\b/, SENIORITY.vp],
  [/\b(head of|director)\b/, SENIORITY.director],
  [/\b(manager|lead)\b/, SENIORITY.manager],
  [/\b(senior|staff|principal|sr\.?)\b/, SENIORITY.senior_ic],
  [/\b(intern|junior|jr\.?|apprentice|trainee)\b/, SENIORITY.intern],
];

export function seniorityOf (title) {
  const t = low(title);
  for (const [re, rank] of SENIORITY_RULES) if (re.test(t)) return rank;
  return SENIORITY.ic;
}

export function isTopOfHouse (title, rules) {
  const t = low(title);
  return (rules?.ceo_default?.top_of_house_titles || []).some(x => t.includes(low(x)));
}

// ---------------------------------------------------------------------------
// 3. One edge: may this line be drawn, and as which kind?
// ---------------------------------------------------------------------------

/**
 * Confidence for an inferred edge. Deterministic, and deliberately capped well below
 * anything a reader would mistake for certainty — an inferred edge is NEVER assertable
 * at any value, so the number is a rendering detail rather than a gate.
 */
function inferredConfidence ({ candidates, gap }) {
  let c = 0.55;
  if (candidates === 1) c += 0.1;
  c -= 0.1 * Math.max(0, gap - 1);
  return Math.max(0.1, Math.min(0.8, Number(c.toFixed(2))));
}

/**
 * Plan the `reports_to` edge for one person.
 *
 * @returns {{decision:string, provenance:(string|null), manager:(string|null),
 *            evidence_kind:(string|null), rejected:object[], contract:object}}
 *          `contract` always validates against _lib/dual-contract.schema.json.
 */
export function planManagerEdge ({ report, roster = [], evidence = [], rules } = {}) {
  if (!rules) throw new OrgMapRulesUnavailable('planManagerEdge: no rules loaded — STOP');

  const src = rules.evidence_sources || {};
  const observedKinds = (src.observed || []).map(low);
  const inferredKinds = (src.inferred || []).map(low);
  const neverKinds = (src.never || []).map(low);

  const mine = evidence.filter(e => low(e.report) === low(report.name));
  const rejected = mine.filter(e => neverKinds.includes(low(e.kind)))
    .map(e => ({ kind: e.kind, manager: e.manager, why: 'evidence_sources.never' }));

  const usable = mine.filter(e => !neverKinds.includes(low(e.kind)));

  // --- observed -----------------------------------------------------------
  const obs = usable.find(e => observedKinds.includes(low(e.kind)));
  if (obs) {
    return draw({
      report, manager: obs.manager, provenance: OBSERVED, evidence_kind: obs.kind,
      confidence: 1, source: obs.source,
      reasoning: `${obs.kind} names ${obs.manager} as the manager of ${report.name}`,
      rejected,
    });
  }

  // --- an inference the LLM hop supplied is STILL an inference -------------
  const grounded = usable.find(e => inferredKinds.includes(low(e.kind)) && e.manager);
  if (grounded) {
    return draw({
      report, manager: grounded.manager, provenance: INFERRED, evidence_kind: grounded.kind,
      confidence: 0.4, source: grounded.source || 'ai_enrich',
      reasoning: `${grounded.kind} suggests ${grounded.manager}; nothing states it, so the edge is inferred`,
      rejected,
    });
  }

  // --- title neighbourhood ------------------------------------------------
  if (!inferredKinds.includes('title_neighborhood')) {
    return refuse({ report, nul: NOT_FOUND, rejected,
      reasoning: 'title_neighborhood is not an accepted inference source in org-map-rules' });
  }

  const dept = departmentOf(report.title);
  const rank = seniorityOf(report.title);
  const others = roster.filter(p => low(p.name) !== low(report.name));

  const sameDept = others.filter(p => departmentOf(p.title) === dept);
  const above = sameDept.filter(p => seniorityOf(p.title) > rank);

  // THE CEO DEFAULT, encoded. If the only thing left above the report is a
  // top-of-house title, the edge was reached by elimination and is refused.
  const nonTop = above.filter(p => !isTopOfHouse(p.title, rules));
  if (above.length > 0 && nonTop.length === 0) {
    return refuse({
      report, rejected,
      nul: rules.ceo_default?.on_only_candidate || NOT_FOUND,
      reasoning: `the only same-department candidate above ${report.title} is a top-of-house title `
        + '(reached by elimination) — ceo_default.banned refuses that edge',
      ceo_default_refused: true,
    });
  }

  if (nonTop.length === 0) {
    // Nobody in the same department outranks them. The graph stays disconnected, and
    // that is the correct map.
    const onlyTop = others.filter(p => isTopOfHouse(p.title, rules));
    return refuse({
      report, rejected, nul: NOT_FOUND,
      reasoning: onlyTop.length > 0
        ? `no same-department candidate outranks ${report.title}; the only senior person on the `
          + 'roster is top-of-house and may not be reached by elimination'
        : `no same-department candidate outranks ${report.title}`,
      ceo_default_refused: onlyTop.length > 0,
    });
  }

  // Nearest neighbour above, in the same department.
  const best = nonTop.slice().sort((a, b) => seniorityOf(a.title) - seniorityOf(b.title))[0];
  const gap = seniorityOf(best.title) - rank;
  return draw({
    report, manager: best.name, provenance: INFERRED, evidence_kind: 'title_neighborhood',
    confidence: inferredConfidence({ candidates: nonTop.length, gap }),
    source: 'linkedin_company_employees_search',
    reasoning: `${best.title} is the nearest ${dept} title above ${report.title}; nobody stated the line`,
    rejected,
  });
}

function draw ({ report, manager, provenance, evidence_kind, confidence, reasoning, source, rejected }) {
  const contract = { result: manager, confidence, reasoning, source };
  return {
    decision: DRAW, provenance, manager, evidence_kind, rejected,
    report: report.name, assertable: provenance === OBSERVED, contract,
  };
}

function refuse ({ report, nul, reasoning, rejected, ceo_default_refused = false }) {
  const contract = {
    result: nul,
    confidence: 0,
    reasoning,
    source: 'linkedin_company_employees_search',
  };
  return {
    decision: REFUSE, provenance: null, manager: null, evidence_kind: null, rejected,
    report: report.name, assertable: false, ceo_default_refused, contract,
  };
}

// ---------------------------------------------------------------------------
// 4. The whole map, and its rendering.
// ---------------------------------------------------------------------------

export function buildOrgMap ({ company = 'the account', roster = [], evidence = [], rules } = {}) {
  const plans = roster.map(p => ({ person: p, plan: planManagerEdge({ report: p, roster, evidence, rules }) }));
  const edges = plans.filter(x => x.plan.decision === DRAW)
    .map(x => ({ from: x.plan.manager, to: x.person.name, ...x.plan }));
  const orphans = plans.filter(x => x.plan.decision === REFUSE)
    .map(x => ({ person: x.person, ...x.plan }));
  return { company, roster, edges, orphans, plans };
}

const titleOf = (map, name) => (map.roster.find(p => low(p.name) === low(name)) || {}).title || '';

/**
 * Render the map. The whole point of this function is rule 1 of the skill: the
 * provenance marker sits on the EDGE LINE, so stripping every `[...]` annotation and
 * the legend still leaves observed and inferred visibly different.
 */
export function renderOrgMap (map, rules) {
  const r = rules.render || {};
  const obs = r.observed_marker;
  const inf = r.inferred_marker;
  const orphan = r.orphan_marker;
  if (!obs || !inf || !orphan) throw new OrgMapRulesUnavailable('render markers are not all defined');
  if (obs === inf) throw new OrgMapRulesUnavailable('observed and inferred markers are identical');

  const out = [];
  out.push(`${map.company} — buying committee`);
  out.push('');

  const managers = [...new Set(map.edges.map(e => e.from))];
  for (const m of managers) {
    out.push(`  ${m} — ${titleOf(map, m)}`);
    for (const e of map.edges.filter(x => x.from === m)) {
      const marker = e.provenance === OBSERVED ? obs : inf;
      const ann = `[${e.provenance} · ${e.evidence_kind} · confidence ${e.contract.confidence} · ${e.contract.source}]`;
      out.push(`  ${marker} ${e.to} — ${titleOf(map, e.to)}   ${ann}`);
    }
    out.push('');
  }

  // An unplaced person is DRAWN, never omitted. Silence reads as "not checked".
  for (const o of map.orphans) {
    out.push(`  ${o.person.name} — ${o.person.title}`);
    out.push(`  ${orphan} manager: ${o.contract.result}   [${o.contract.reasoning}]`);
    out.push('');
  }

  if (r.legend_required) {
    out.push('  Legend');
    out.push(`    ${obs}   observed   an external source stated this line`);
    out.push(`    ${inf}   inferred   the roster's shape supports it; nobody stated it`);
    out.push(`    ${orphan}   not_found  we looked and could not place this person`);
  }
  return out.join('\n');
}

/**
 * The rendered map with every annotation and the legend removed — what a reader sees
 * if they skim. `observed` and `inferred` rows must STILL be distinguishable here.
 */
export function stripAnnotations (rendered) {
  return rendered
    .split('\n')
    .filter(l => !/^\s{2,4}(Legend|[^\s]+\s{3}(observed|inferred|not_found)\b)/.test(l))
    .map(l => l.replace(/\s*\[[^\]]*\]\s*$/, ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 5. Slack participation. It produces node ATTRIBUTES and never an edge.
// ---------------------------------------------------------------------------

export function planParticipation ({ shared_connect_channel = false, members = [], roster = [], rules } = {}) {
  if (!rules) throw new OrgMapRulesUnavailable('planParticipation: no rules loaded — STOP');
  const never = (rules.evidence_sources?.never || []).map(low);
  if (!never.includes('slack_channel_membership')) {
    throw new OrgMapRulesUnavailable(
      'evidence_sources.never no longer bans slack_channel_membership as hierarchy evidence');
  }
  if (!shared_connect_channel) {
    return {
      decision: REFUSE, edges: [], attributes: [],
      contract: {
        result: NOT_APPLICABLE, confidence: 0,
        reasoning: 'slack_channel_members runs only for a shared Slack Connect channel with this '
          + 'account; an internal channel is a paid read of a member list the user already has',
        source: 'slack_channel_members',
      },
    };
  }
  const names = new Set(roster.map(p => low(p.name)));
  const attributes = members
    .filter(m => names.has(low(m)))
    .map(m => ({ person: m, attribute: 'in_deal_channel', source: 'slack_channel_members' }));
  return {
    decision: DRAW, edges: [], attributes,
    contract: {
      result: attributes.map(a => a.person),
      confidence: 1,
      reasoning: 'channel membership is observed participation; it is never a reporting edge',
      source: 'slack_channel_members',
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Local inference — where inference runs — and the gate keys that are not there yet.
// ---------------------------------------------------------------------------

export function inferenceMode (rules) { return (rules.inference || {}).mode; }

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
    if (!key) return { decision: STOP, reason: 'org-map-rules names no batch_scale_gate_key', failed_closed: true };
    let min;
    try { min = gateValue(gates, key); }
    catch (e) {
      if (e instanceof MissingGateKey) {
        return { decision: STOP, gate: key, reason: `${e.message} — failing closed (law 5)`, failed_closed: true };
      }
      throw e;
    }
    if (Number(rowCount) < Number(min)) {
      return { decision: STOP, gate: key, reason: `${rowCount} accounts is below the batch-scale floor — infer locally` };
    }
  }
  // Whatever comes back is ai_inferred, and an ai_inferred reporting line is an
  // INFERRED edge. There is no path from the paid hop to an asserted line.
  return { decision: 'allow', reason: `ai_enrich permitted for ${r}`, requires_plan: true, edge_provenance: INFERRED };
}

/** The cross-endpoint page ceiling. Missing key => STOP => one people endpoint per run. */
export function peopleEndpointBudget ({ endpoints = [], gates = loadGates() } = {}) {
  const key = 'skills.org_map.max_pages_per_run';
  let max;
  try { max = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return endpoints.length <= 1
      ? { decision: 'allow', gate: key, failed_closed: true, max_pages: 1,
          reason: `${key} is absent; one page-gated people endpoint per run (law 5)` }
      : { decision: STOP, gate: key, failed_closed: true,
          reason: `${key} is absent, so a run may walk only one page-gated people endpoint (law 5)` };
  }
  return { decision: 'allow', gate: key, failed_closed: false, max_pages: Number(max) };
}

/** The bulk-enrich shortlist ceiling. Missing key => STOP => the hop is refused. */
export function bulkEnrichDecision ({ shortlistSize = 0, gates = loadGates() } = {}) {
  const key = 'skills.org_map.committee_max_profiles';
  let max;
  try { max = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return { decision: STOP, gate: key, failed_closed: true,
      reason: `${e.message} — enrich_profiles_bulk is refused; its charge is absent from the response` };
  }
  if (Number(shortlistSize) > Number(max)) {
    return { decision: STOP, gate: key, reason: `shortlist of ${shortlistSize} exceeds ${key}` };
  }
  return { decision: 'allow', gate: key, max: Number(max) };
}

export default {
  loadOrgMapRules, departmentOf, seniorityOf, isTopOfHouse, planManagerEdge,
  buildOrgMap, renderOrgMap, stripAnnotations, planParticipation,
  inferenceMode, aiEnrichDecision, peopleEndpointBudget, bulkEnrichDecision,
  OBSERVED, INFERRED, DRAW, REFUSE, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE,
  NULL_ENUM, SKILL_PATH, REPO, OrgMapRulesUnavailable,
};
