// skills/evidence-score/score.mjs — the executable form of /evidence-score.
//
// Shipped inside the skill so an installed package can run it. Usage:
//   node <pack>/skills/evidence-score/score.mjs briefs.json [--gates <gates.yaml>]
// briefs.json holds one dual-contract brief or an array of them. Prints one JSON
// result per brief to stdout. Exit 2 on unreadable input or a missing rule table.
//
// WHY THIS FILE EXISTS
//
// /evidence-score decides whether a claim may be asserted, and a decision engine that
// is only prose cannot be tested. Asserting on the prose would be worse than no test:
// prose assertions rot, and they prove a sentence exists rather than that breaking the
// rule fails.
//
// So the grading table lives in `skills/evidence-score/SKILL.md` as a fenced,
// machine-readable `evidence-rules` block, and this file is the conformance harness
// that runs it — the same technique `/comply` uses for its gate table. The RULES are
// the skill's; the glue is here. Three consequences:
//
//   1. Editing a grade in the skill changes what the evals see. An edit that fails
//      open turns tests/evals/evidence-score/ red.
//   2. Deleting the block, renaming a grade, or dropping a refusal condition is a red
//      run, not a silent policy change.
//   3. The harness cannot fail open by accident: the default grade is `unsupported`,
//      every missing gate key is STOP, and every check that cannot be run counts as
//      failed.
//
// Everything with real consequences is delegated to the shipped engines:
//   dual contract -> _lib/dual-contract.mjs  (readArtifactField / storeLlmResult)
//   thresholds    -> _lib/gates.mjs          (gateValue; MissingGateKey => STOP)

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, MissingGateKey, STOP } from '../../_lib/gates.mjs';
import { readArtifactField, NULL_ENUM, STATUS_INVALID } from '../../_lib/dual-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const SKILL_PATH = join(HERE, 'SKILL.md');

export { NULL_ENUM, MissingGateKey, STOP, STATUS_INVALID };

/** The three grades. There is no fourth, and `unsupported` is the default. */
export const SUPPORTED = 'supported';
export const WEAK = 'weak';
export const UNSUPPORTED = 'unsupported';

/** The three ways this pack is allowed to say "no answer". */
export const NOT_FOUND = 'not_found';
export const NOT_VERIFIABLE = 'not_verifiable';
export const NOT_APPLICABLE = 'not_applicable';

export class EvidenceRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'EvidenceRulesUnavailable'; this.verdict = STOP; }
}

// ---------------------------------------------------------------------------
// 1. Load the grading table OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+evidence-rules[ \t]*$/m;

/**
 * Extract and parse the `evidence-rules` block from skills/evidence-score/SKILL.md.
 * A missing, duplicated or unparseable block throws — the harness carries no default
 * table, because a default table is exactly how a deleted rule goes unnoticed.
 */
export function loadEvidenceRules ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new EvidenceRulesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new EvidenceRulesUnavailable('unterminated `evidence-rules` fence');
  if (blocks.length === 0) {
    throw new EvidenceRulesUnavailable(
      'skills/evidence-score/SKILL.md carries no ```yaml evidence-rules block — the table is the grader');
  }
  if (blocks.length > 1) {
    throw new EvidenceRulesUnavailable(`${blocks.length} evidence-rules blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new EvidenceRulesUnavailable(`evidence-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new EvidenceRulesUnavailable('evidence-rules parsed to nothing');
  for (const key of ['default_grade', 'provenance', 'thresholds', 'dimensions', 'bands']) {
    if (doc[key] === undefined) throw new EvidenceRulesUnavailable(`evidence-rules is missing \`${key}\``);
  }
  if (doc.default_grade !== UNSUPPORTED) {
    throw new EvidenceRulesUnavailable(
      `evidence-rules default_grade is "${doc.default_grade}" — law 5 says the default is "${UNSUPPORTED}"`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Reading one field out of a research brief.
// ---------------------------------------------------------------------------

const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * A research brief IS a dual-contract artifact: `{ verified, ai_inferred,
 * ai_inferred_invalid }`. A verified entry may be a bare value or an evidence record
 * `{ value, source, fetched_at, confidence }`. A bare value carries no source line,
 * which is a grading outcome rather than a parse error.
 */
export function readClaim (brief, field) {
  const rd = readArtifactField(brief, field);
  if (rd.provenance === 'absent') return { provenance: 'absent' };

  if (rd.provenance === 'verified') {
    const raw = rd.value;
    const isRecord = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      && Object.prototype.hasOwnProperty.call(raw, 'value');
    return {
      provenance: 'verified',
      value: isRecord ? raw.value : raw,
      source: isRecord ? raw.source : undefined,
      fetched_at: isRecord ? raw.fetched_at : undefined,
      // Absent on purpose when the record does not carry one: a direct endpoint read
      // is the fact, and inventing a confidence for it would be its own fabrication.
      confidence: isRecord && Object.prototype.hasOwnProperty.call(raw, 'confidence')
        ? raw.confidence : undefined,
    };
  }

  return {
    provenance: 'ai_inferred',
    value: rd.value,
    source: rd.source,
    confidence: rd.confidence,
    fetched_at: brief?.ai_inferred?.[field]?.fetched_at,
  };
}

// ---------------------------------------------------------------------------
// 3. Grading one claim. Everything unanswerable lands on a refusal.
// ---------------------------------------------------------------------------

function readThreshold (rules, name, gates) {
  const spec = (rules.thresholds || {})[name];
  if (!spec || !spec.gate_key) {
    return { ok: false, key: `thresholds.${name}`, reason: `evidence-rules names no gate key for ${name}` };
  }
  try {
    return { ok: true, key: spec.gate_key, value: gateValue(gates, spec.gate_key) };
  } catch (e) {
    if (e instanceof MissingGateKey) return { ok: false, key: spec.gate_key, reason: e.message };
    throw e;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grade one claim against one brief.
 *
 * @returns {{grade:string, null:(string|null), assertable:boolean, reasons:string[],
 *            provenance:string, source:(string|undefined), failed_closed:boolean}}
 */
export function gradeClaim (brief, field, { rules, gates = loadGates(), now = new Date() } = {}) {
  if (!rules) throw new EvidenceRulesUnavailable('gradeClaim: no rule table loaded — STOP');
  const provRules = rules.provenance || {};
  const refuse = (grade, nul, reasons, extra = {}) => ({
    field, grade, null: nul, assertable: false, reasons, ...extra,
  });

  const claim = readClaim(brief, field);

  // (a) nothing there at all. Includes a response quarantined as ai_inferred_invalid:
  //     readArtifactField reports it absent, so a malformed answer can never render.
  if (claim.provenance === 'absent') {
    const p = provRules.absent || {};
    const quarantined = (brief?.ai_inferred_invalid || []).some(r => r.field === field);
    return refuse(p.grade || UNSUPPORTED, p.null || NOT_FOUND,
      [quarantined ? 'response_quarantined_ai_inferred_invalid' : 'field_absent'],
      { provenance: 'absent', quarantined });
  }

  // (b) the brief already answered with an explicit null. Carry it through unchanged.
  if (rules.carry_through_brief_nulls !== false
      && typeof claim.value === 'string' && NULL_ENUM.includes(claim.value)) {
    return refuse(UNSUPPORTED, claim.value, ['brief_recorded_explicit_null'],
      { provenance: claim.provenance, source: claim.source });
  }

  // (c) an LLM-derived value is never assertable, however confident the model was.
  if (claim.provenance === 'ai_inferred') {
    const p = provRules.ai_inferred || {};
    if (p.assertable === true) {
      // A rules edit that made inferred values assertable is a fail-open. Refuse it.
      return refuse(UNSUPPORTED, NOT_VERIFIABLE, ['rules_would_assert_ai_inferred'],
        { provenance: 'ai_inferred', failed_closed: true });
    }
    const reasons = ['provenance_ai_inferred'];
    if (!String(claim.source ?? '').trim()) reasons.push('source_line_missing');
    else if ((rules.unattributable_sources || []).map(low).includes(low(claim.source))) {
      reasons.push('source_unattributable');
    }
    return refuse(p.grade || WEAK, p.null || NOT_VERIFIABLE, reasons,
      { provenance: 'ai_inferred', source: claim.source, confidence: claim.confidence });
  }

  // (d) verified. Structural checks first — none of them needs a threshold.
  const reasons = [];
  let failedClosed = false;

  const src = String(claim.source ?? '').trim();
  if (!src) reasons.push('source_line_missing');
  else if ((rules.unattributable_sources || []).map(low).includes(low(src))) {
    reasons.push('source_unattributable');
  }

  // Freshness. An undated fact is stale, not fresh (evidence-rules.undated_evidence_is).
  const age = readThreshold(rules, 'max_age_days', gates);
  if (!age.ok) {
    reasons.push(`gate_missing:${age.key}`);
    failedClosed = true;
  } else {
    const ts = Date.parse(claim.fetched_at);
    if (Number.isNaN(ts)) {
      if (low(rules.undated_evidence_is) !== 'fresh') reasons.push('evidence_undated');
    } else if ((now.getTime() - ts) > Number(age.value) * DAY_MS) {
      reasons.push('evidence_stale');
    }
  }

  // Confidence, only when the record carries one. A direct endpoint read does not.
  if (claim.confidence !== undefined && claim.confidence !== null) {
    const floor = readThreshold(rules, 'min_confidence', gates);
    if (!floor.ok) {
      reasons.push(`gate_missing:${floor.key}`);
      failedClosed = true;
    } else if (!(Number(claim.confidence) >= Number(floor.value))) {
      reasons.push('below_confidence_floor');
    }
  }

  if (reasons.length > 0) {
    return refuse(rules.missing_source_grade || WEAK, rules.missing_source_null || NOT_VERIFIABLE,
      reasons, { provenance: 'verified', source: claim.source, confidence: claim.confidence,
        failed_closed: failedClosed });
  }

  return {
    field, grade: SUPPORTED, null: null, assertable: true, reasons: [],
    provenance: 'verified', source: claim.source, confidence: claim.confidence,
    value: claim.value, failed_closed: false,
  };
}

// ---------------------------------------------------------------------------
// 4. Scoring a record. Zero supported signals is zero points, never a guess.
// ---------------------------------------------------------------------------

const cap = (n, max) => Math.max(0, Math.min(Number(n) || 0, Number(max) || 0));

function scoreOneDimension (brief, name, def, ctx) {
  const supporting = [];
  let points = 0;

  if (low(def.kind) === 'banded') {
    const g = gradeClaim(brief, def.band_field, ctx);
    if (g.grade === SUPPORTED) {
      const key = low(g.value) || String(g.value);
      const table = def.value_points || {};
      const pts = Object.prototype.hasOwnProperty.call(table, key)
        ? Number(table[key])
        : Number(def.unmapped_value_points ?? 0);   // an unrecognised band scores 0
      points += pts;
      supporting.push({ field: def.band_field, points: pts, source: g.source, value: g.value });
    }
    for (const adj of def.adjustments || []) {
      const a = gradeClaim(brief, adj.field, ctx);
      if (a.grade !== SUPPORTED) continue;
      points += Number(adj.points) || 0;
      supporting.push({ field: adj.field, points: Number(adj.points) || 0, source: a.source });
    }
  } else {
    for (const sig of def.signals || []) {
      const g = gradeClaim(brief, sig.field, ctx);
      if (g.grade !== SUPPORTED) continue;
      points += Number(sig.points) || 0;
      supporting.push({ field: sig.field, points: Number(sig.points) || 0, source: g.source });
    }
  }

  const score = cap(points, def.max);
  const top = supporting.slice().sort((a, b) => b.points - a.points)[0] || null;
  return {
    dimension: name,
    score,
    // Zero supported signals is not a low score, it is an unmeasured dimension.
    measured: supporting.length > 0,
    null: supporting.length > 0 ? null : NOT_FOUND,
    supporting,
    why: top ? { field: top.field, source: top.source ?? null } : null,
  };
}

/**
 * Score one record against the rubric in the skill.
 *
 * The total is REFUSED — `total: null`, `total_status: 'refused'` — when fewer than
 * `skills.evidence_score.min_dimensions_scored` dimensions carry a supported signal,
 * and when that gate key does not resolve. A 0-100 built out of one dimension is a
 * coincidence with a decimal point, and reporting it as 0 would sort the record as
 * "measured and bad" rather than "not measured".
 */
export function scoreRecord (brief, { rules, gates = loadGates(), now = new Date() } = {}) {
  if (!rules) throw new EvidenceRulesUnavailable('scoreRecord: no rule table loaded — STOP');
  const ctx = { rules, gates, now };
  const dimensions = {};
  for (const [name, def] of Object.entries(rules.dimensions || {})) {
    dimensions[name] = scoreOneDimension(brief, name, def, ctx);
  }
  const measured = Object.values(dimensions).filter(d => d.measured).length;
  const subtotal = Object.values(dimensions).reduce((a, d) => a + d.score, 0);

  const minDims = readThreshold(rules, 'min_dimensions_scored', gates);
  if (!minDims.ok) {
    return {
      dimensions, dimensions_measured: measured, total: null, total_status: 'refused',
      band: null, band_status: 'refused', failed_closed: true,
      reasons: [`gate_missing:${minDims.key}`],
    };
  }
  if (measured < Number(minDims.value)) {
    return {
      dimensions, dimensions_measured: measured, total: null, total_status: 'refused',
      band: null, band_status: 'refused', failed_closed: false,
      reasons: ['too_few_dimensions_measured'],
    };
  }

  const banded = bandFor(subtotal, dimensions.reachability?.score ?? 0, { rules, gates });
  return {
    dimensions, dimensions_measured: measured, total: subtotal, total_status: 'reported',
    band: banded.band, band_status: banded.status, failed_closed: banded.failed_closed,
    reasons: banded.reasons,
  };
}

/**
 * Band a total. Every cutoff is a gate key; a key that does not resolve refuses the
 * band rather than defaulting it. A record cannot be banded hot on paper it cannot be
 * contacted through.
 */
export function bandFor (total, reachability, { rules, gates = loadGates() } = {}) {
  const bands = rules.bands || {};
  const reasons = [];
  const read = (key) => {
    try { return { ok: true, value: gateValue(gates, key) }; }
    catch (e) {
      if (e instanceof MissingGateKey) return { ok: false, key };
      throw e;
    }
  };

  const cutoffs = {};
  for (const name of ['hot', 'warm', 'watch']) {
    const key = bands[name]?.min_gate_key;
    if (!key) return { band: null, status: 'refused', failed_closed: true, reasons: [`bands.${name} names no gate key`] };
    const r = read(key);
    if (!r.ok) return { band: null, status: 'refused', failed_closed: true, reasons: [`gate_missing:${r.key}`] };
    cutoffs[name] = Number(r.value);
  }

  const floorKey = bands.hot_requires_reachability_gate_key;
  let floor = null;
  if (floorKey) {
    const r = read(floorKey);
    if (!r.ok) return { band: null, status: 'refused', failed_closed: true, reasons: [`gate_missing:${r.key}`] };
    floor = Number(r.value);
  }

  let band;
  if (total >= cutoffs.hot) band = 'hot';
  else if (total >= cutoffs.warm) band = 'warm';
  else if (total >= cutoffs.watch) band = 'watch';
  else band = 'drop';

  if (band === 'hot' && floor !== null && reachability < floor) {
    band = 'warm';
    reasons.push('demoted_below_reachability_floor');
  }
  return { band, status: 'reported', failed_closed: false, reasons };
}

export default {
  loadEvidenceRules, readClaim, gradeClaim, scoreRecord, bandFor,
  SUPPORTED, WEAK, UNSUPPORTED, NOT_FOUND, NOT_VERIFIABLE, NOT_APPLICABLE,
  NULL_ENUM, SKILL_PATH, REPO, EvidenceRulesUnavailable,
};

// ---------------------------------------------------------------------------
// 5. CLI. Resolve both paths so the guard also fires through an npm symlink.
// ---------------------------------------------------------------------------

function isMain () {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

export function main (argv = process.argv.slice(2)) {
  const gi = argv.indexOf('--gates');
  const gatesPath = gi >= 0 ? argv[gi + 1] : undefined;
  const file = argv.find((a, i) => !a.startsWith('--') && (gi < 0 || i !== gi + 1));
  if (!file) {
    process.stderr.write('usage: score.mjs <briefs.json> [--gates <gates.yaml>]\n');
    return 2;
  }
  let briefs;
  try { briefs = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { process.stderr.write(`STOP: cannot read ${file}: ${e.message}\n`); return 2; }
  let rules;
  try { rules = loadEvidenceRules(); }
  catch (e) { process.stderr.write(`STOP: ${e.message}\n`); return 2; }
  const gates = gatesPath ? loadGates(gatesPath) : loadGates();
  const out = (Array.isArray(briefs) ? briefs : [briefs])
    .map((b) => scoreRecord(b, { rules, gates }));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

if (isMain()) process.exitCode = main();
