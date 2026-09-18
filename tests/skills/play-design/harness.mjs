// tests/skills/play-design/harness.mjs — the executable form of /play-design.
//
// WHY THIS FILE EXISTS
//
// The design rules that new motions become PLAYS, not skills, and this skill
// is what makes that true. Its failure mode is therefore specific and quiet: a play
// that stops composing and starts reimplementing. Nobody notices, because a play has
// no tests of its own — it just drifts from the six skills it shadows until the two
// disagree about what a sendable list is.
//
// So the composition contract lives in `skills/play-design/SKILL.md` as a fenced,
// machine-readable `play-spec` block and this file runs that block against real play
// records. A stage that names a skill the pack does not have, a stage that carries its
// own routing or copy rules, an Act chain in the wrong order, an endpoint outside the
// two this skill owns, a play with no measurement — all of them are refusals here.
//
// Delegated, never re-implemented:
//   thresholds -> _lib/gates.mjs (gateValue; MissingGateKey => STOP)
//   prices     -> _lib/dryrun.mjs priceCall(), off the generated catalog

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../../_lib/gates.mjs';
import { priceCall } from '../../../_lib/dryrun.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'play-design', 'SKILL.md');

export { MissingGateKey, STOP, loadGates, gateValue };

export const SAVE = 'save';
export const REFUSE = 'refuse';

/** The two endpoints _lib/endpoint-owners.yaml gives this skill. */
export const OWNED = Object.freeze(['linkedin_job_search', 'web_tech_stack']);

export class PlaySpecUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'PlaySpecUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the composition contract OUT OF THE SKILL, and refuse a fail-open edit.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+play-spec[ \t]*$/m;
const SKILLS_DIR = join(REPO, 'skills');

export function shippedSkills () {
  return new Set(readdirSync(SKILLS_DIR).filter(d => existsSync(join(SKILLS_DIR, d, 'SKILL.md'))));
}

export function loadPlaySpec ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new PlaySpecUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new PlaySpecUnavailable('unterminated `play-spec` fence');
  if (blocks.length === 0) {
    throw new PlaySpecUnavailable(
      'skills/play-design/SKILL.md carries no ```yaml play-spec block — the schema is the contract');
  }
  if (blocks.length > 1) throw new PlaySpecUnavailable(`${blocks.length} play-spec blocks; there must be exactly one`);

  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new PlaySpecUnavailable(`play-spec is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new PlaySpecUnavailable('play-spec is empty');

  // Law 5, at load time.
  if (doc.default_decision !== REFUSE) {
    throw new PlaySpecUnavailable(`default_decision is ${JSON.stringify(doc.default_decision)}; must be "refuse"`);
  }
  const wanted = ['trigger', 'audience', 'prepare', 'act', 'measure'];
  if (!Array.isArray(doc.required_stages) || doc.required_stages.join(',') !== wanted.join(',')) {
    throw new PlaySpecUnavailable(
      `required_stages must be exactly ${wanted.join(' -> ')} — a play missing one is a step somebody forgets`);
  }
  if (doc.stage_order_fixed !== true) throw new PlaySpecUnavailable('stage_order_fixed must be true');

  const shipped = shippedSkills();
  for (const stage of wanted) {
    const s = doc.stages?.[stage];
    if (!s || !Array.isArray(s.runs) || s.runs.length === 0) {
      throw new PlaySpecUnavailable(`stage ${stage} runs no skill — a stage that runs nothing is a stage that lies`);
    }
    for (const name of s.runs) {
      if (!shipped.has(name)) {
        throw new PlaySpecUnavailable(`stage ${stage} names /${name}, which is not a shipped skill`);
      }
    }
  }
  if (doc.stages.act.order_fixed !== true) {
    throw new PlaySpecUnavailable('stages.act.order_fixed must be true — that order IS the pack\'s gate order');
  }
  if (doc.stages.act.runs[doc.stages.act.runs.length - 1] !== 'launch') {
    throw new PlaySpecUnavailable('/launch must be last in the Act chain — it is the sole writer of the export');
  }
  if (doc.stages.measure.required !== true) {
    throw new PlaySpecUnavailable('the measure stage is required — a motion with no number is a habit');
  }

  const c = doc.composition || {};
  if (c.stage_must_name_an_existing_skill !== true) {
    throw new PlaySpecUnavailable('composition.stage_must_name_an_existing_skill must be true');
  }
  if (c.stage_may_redefine_composed_behaviour !== false) {
    throw new PlaySpecUnavailable(
      'composition.stage_may_redefine_composed_behaviour must be false — that IS the reimplementation rule');
  }
  const may = [...(c.play_may_call_endpoints || [])].sort();
  if (may.join(',') !== [...OWNED].sort().join(',')) {
    throw new PlaySpecUnavailable(
      `a play may call only ${OWNED.join(', ')} — saw ${JSON.stringify(may)}`);
  }
  if (!Array.isArray(c.forbidden_in_a_play_record) || c.forbidden_in_a_play_record.length === 0) {
    throw new PlaySpecUnavailable('composition.forbidden_in_a_play_record is empty');
  }

  const tp = doc.trigger_probe || {};
  if (tp.on_missing_key !== 'stop') throw new PlaySpecUnavailable('trigger_probe.on_missing_key must be "stop"');
  if (typeof tp.endpoints?.hiring?.max_pages_gate !== 'string') {
    throw new PlaySpecUnavailable('the page-gated probe must name a max-pages gate key');
  }
  if (tp.endpoints.hiring.unbounded !== true) {
    throw new PlaySpecUnavailable('linkedin_job_search IS unbounded; saying otherwise is how a probe becomes a walk');
  }

  const g = doc.guardrails || {};
  if (g.on_missing_key !== 'stop') throw new PlaySpecUnavailable('guardrails.on_missing_key must be "stop" — law 5');
  for (const k of ['min_audience_gate', 'max_age_gate', 'require_measure_before_rerun_gate']) {
    if (typeof g[k] !== 'string' || !g[k].includes('.')) {
      throw new PlaySpecUnavailable(`guardrails.${k} must name a dotted gate key`);
    }
  }

  if (doc.measurement?.declared_before_first_run !== true) {
    throw new PlaySpecUnavailable(
      'the metric is declared before the first run — one chosen afterwards is chosen to flatter the numbers');
  }
  if (doc.measurement.cost_is_a_range !== true) {
    throw new PlaySpecUnavailable('a play\'s cost stays a range (law 4)');
  }
  if (doc.inference?.mode !== 'local' || doc.inference.paid_hop !== 'none') {
    throw new PlaySpecUnavailable('inference.mode must be "local" with no paid hop, per the local-inference rule');
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Validate a play record. This is the composition contract, executed.
// ---------------------------------------------------------------------------

const REIMPLEMENTATION_KEYS = [
  'endpoints', 'endpoint', 'waterfall', 'routing', 'copy_rules', 'scoring', 'rubric',
  'compliance_rules', 'verification_threshold', 'export', 'sender', 'sequence_copy',
];

/**
 * @returns {{decision:'save'|'refuse', violations: string[], stops: object[]}}
 */
export function validatePlay (play, { spec = loadPlaySpec(), gates = loadGates() } = {}) {
  const violations = [];
  const stops = [];
  const shipped = shippedSkills();

  if (!play || typeof play !== 'object') return { decision: REFUSE, violations: ['not a play record'], stops };
  if (!play.name) violations.push('unnamed_play');

  // Stage presence and order.
  const given = Object.keys(play.stages || {});
  for (const stage of spec.required_stages) {
    if (!given.includes(stage)) violations.push(`missing_stage:${stage}`);
  }
  if (spec.stage_order_fixed && given.join(',') !== spec.required_stages.join(',')
      && given.length === spec.required_stages.length) {
    violations.push(`stage_order:${given.join('>')}`);
  }

  for (const [stage, body] of Object.entries(play.stages || {})) {
    const allowed = spec.stages[stage];
    if (!allowed) { violations.push(`unknown_stage:${stage}`); continue; }

    // A stage names a skill, and the skill has to exist.
    const runs = body?.runs || [];
    if (runs.length === 0) violations.push(`stage_runs_nothing:${stage}`);
    for (const name of runs) {
      if (!shipped.has(name)) violations.push(`unknown_skill:${stage}:${name}`);
      else if (!allowed.runs.includes(name)) violations.push(`skill_not_allowed_in_stage:${stage}:${name}`);
    }

    // A stage never re-describes what the skill it names already does.
    for (const key of Object.keys(body || {})) {
      if (REIMPLEMENTATION_KEYS.includes(key)) violations.push(`reimplements:${stage}:${key}`);
    }

    // No endpoint outside the two this skill owns may appear anywhere in a play.
    for (const e of collectEndpointNames(body)) {
      if (!spec.composition.play_may_call_endpoints.includes(e)) {
        violations.push(`endpoint_not_owned:${stage}:${e}`);
      }
    }
  }

  // The Act chain is the pack's gate order and may not be reordered or shortened.
  const act = play.stages?.act?.runs;
  if (Array.isArray(act) && act.join(',') !== spec.stages.act.runs.join(',')) {
    violations.push(`act_chain:${act.join('>')}`);
  }

  // Measurement, declared up front.
  if (!play.measurement?.primary_metric) violations.push('no_primary_metric');
  if (play.measurement && play.measurement.declared_before_first_run !== true) {
    violations.push('metric_declared_after_the_fact');
  }

  // Guardrails. Every one reads a gate key, and a key that does not resolve is STOP.
  const g = spec.guardrails;
  const readGate = (key) => {
    try { return { ok: true, value: gateValue(gates, key) }; }
    catch (e) {
      if (!(e instanceof MissingGateKey)) throw e;
      stops.push({ gate: key, decision: STOP, failed_closed: true, reason: e.message });
      return { ok: false };
    }
  };
  const minRows = readGate(g.min_audience_gate);
  if (minRows.ok && Number(play.audience_rows ?? 0) < minRows.value) {
    violations.push(`audience_below_floor:${play.audience_rows}`);
  }
  const maxAge = readGate(g.max_age_gate);
  if (maxAge.ok && play.approved_at) {
    const ageDays = (Date.now() - Date.parse(play.approved_at)) / 86400000;
    if (ageDays > maxAge.value) violations.push('play_stale_reapprove');
  }
  const needMeasure = readGate(g.require_measure_before_rerun_gate);
  if (needMeasure.ok && needMeasure.value === true && play.rerun === true && play.last_run_measured !== true) {
    violations.push('rerun_before_last_run_measured');
  }

  return {
    decision: (violations.length === 0 && stops.length === 0) ? SAVE : REFUSE,
    violations, stops,
  };
}

/** Every endpoint-shaped string anywhere in a stage body. */
function collectEndpointNames (node, out = new Set()) {
  if (node == null) return out;
  if (typeof node === 'string') {
    if (/^[a-z][a-z0-9_]{3,}$/.test(node) && node.includes('_')) out.add(node);
    return out;
  }
  if (Array.isArray(node)) { for (const v of node) collectEndpointNames(v, out); return out; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'runs') continue;                    // skill names, not endpoints
      collectEndpointNames(v, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The trigger probe. The only thing this skill spends on, and only to size it.
// ---------------------------------------------------------------------------

export function planTriggerProbe ({
  kind = 'hiring', pages = 1, rows = 1, catalog, gates = loadGates(), spec = loadPlaySpec(),
  expectedResults = null,
} = {}) {
  if (!catalog?.endpoints) throw new Error('planTriggerProbe needs the generated catalog');
  const cfg = spec.trigger_probe.endpoints[kind];
  if (!cfg) return { decision: REFUSE, reason: `no probe defined for trigger kind "${kind}"`, stops: [] };

  const def = catalog.endpoints[cfg.endpoint];
  const stops = [];
  const plan = {
    dry_run: true, calls_made: 0, kind, endpoint: cfg.endpoint, pages, rows,
    unbounded: cfg.unbounded === true, stops,
  };

  const priced = priceCall(def, { expectedResults });
  plan.credits_per_call = priced.credits;
  plan.basis = priced.basis;
  plan.known = priced.known;
  plan.actual_verifiable = def.pricing?.billing_field_present_in_response !== false;
  plan.total_credits = priced.known ? priced.credits * pages * rows : null;
  if (!priced.known) {
    stops.push({ gate: 'trigger_probe', decision: STOP, failed_closed: true,
      reason: `${cfg.endpoint} is priced ${def.pricing?.model} and no result count was given — `
        + 'an unpriced probe cannot be approved' });
  }

  if (cfg.max_pages_gate) {
    try {
      const max = gateValue(gates, cfg.max_pages_gate);
      plan.max_pages = max;
      if (pages > max) {
        stops.push({ gate: cfg.max_pages_gate, decision: STOP,
          reason: `${pages} pages exceeds the design-time probe ceiling of ${max} — sizing a trigger is not buying one` });
      }
    } catch (e) {
      if (!(e instanceof MissingGateKey)) throw e;
      stops.push({ gate: cfg.max_pages_gate, decision: STOP, failed_closed: true, reason: e.message });
    }
  }

  // The pack-wide page gate still applies on top, and it is read from gates.yaml.
  if (cfg.unbounded) {
    try {
      const before = gateValue(gates, 'unbounded_endpoints.pages_before_confirm');
      plan.pages_before_confirm = before;
      plan.confirms_required = Math.max(0, pages - before);
    } catch (e) {
      if (!(e instanceof MissingGateKey)) throw e;
      stops.push({ gate: 'unbounded_endpoints.pages_before_confirm', decision: STOP, failed_closed: true,
        reason: e.message });
    }
  }

  plan.decision = stops.length === 0 ? 'plan' : REFUSE;
  plan.blocked = stops.length > 0;
  return plan;
}

export default {
  loadPlaySpec, validatePlay, planTriggerProbe, shippedSkills,
  SAVE, REFUSE, OWNED, PlaySpecUnavailable,
};
