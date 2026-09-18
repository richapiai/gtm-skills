// tests/skills/competitive-intel/harness.mjs — the executable form of /competitive-intel.
//
// WHY THIS FILE EXISTS
//
// Fifteen endpoints is a menu, not a workflow, and the whole design of this skill is
// the line between the tier that runs by default and the tiers a user opts into. That
// line is only real if the default tier CANNOT reach a page-gated endpoint, and that is
// a property of a data structure rather than of a paragraph — so the tier map lives in
// `skills/competitive-intel/SKILL.md` as a fenced `competitive-intel-tiers` block and
// this file runs it.
//
// The second hazard is the one no other skill in the pack has: this one runs against a
// SET of rivals, so every line on the plan carries a silent multiplier. The ceiling
// that bounds it does not exist in _lib/gates.yaml yet (these tests may not edit that file),
// so the sweep fails closed and this harness is where that is asserted.
//
// Delegated, never re-implemented:
//   page-gating  -> _lib/gates.mjs  (isUnbounded, gateValue; MissingGateKey => STOP)
//   pricing      -> _lib/api-catalog.json

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadGates, gateValue, isUnbounded, MissingGateKey, STOP } from '../../../_lib/gates.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'competitive-intel', 'SKILL.md');
export { MissingGateKey, STOP };

export const ALLOW = 'allow';

export class TierMapUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'TierMapUnavailable'; this.verdict = STOP; }
}

const FENCE_RE = /^```yaml[ \t]+competitive-intel-tiers[ \t]*$/m;

export function loadTierMap ({ path = SKILL_PATH, src = null } = {}) {
  let text = src;
  if (text === null) {
    if (!existsSync(path)) throw new TierMapUnavailable(`no SKILL.md at ${path}`);
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
  if (open !== null) throw new TierMapUnavailable('unterminated `competitive-intel-tiers` fence');
  if (blocks.length === 0) {
    throw new TierMapUnavailable(
      'skills/competitive-intel/SKILL.md carries no ```yaml competitive-intel-tiers block');
  }
  if (blocks.length > 1) {
    throw new TierMapUnavailable(`${blocks.length} tier blocks; there must be exactly one`);
  }

  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new TierMapUnavailable(`the tier block is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new TierMapUnavailable('the tier block parsed to nothing');
  for (const key of ['default_tier', 'tiers', 'pending_gate_keys', 'inference']) {
    if (doc[key] === undefined) throw new TierMapUnavailable(`the tier block is missing \`${key}\``);
  }

  const names = Object.keys(doc.tiers);
  if (!names.includes(doc.default_tier)) {
    throw new TierMapUnavailable(`default_tier "${doc.default_tier}" is not one of ${names.join(', ')}`);
  }
  const defaults = names.filter(n => doc.tiers[n].default === true);
  if (defaults.length !== 1 || defaults[0] !== doc.default_tier) {
    throw new TierMapUnavailable(
      `exactly one tier may be the default and it must be ${doc.default_tier}; saw [${defaults.join(', ')}]`);
  }
  for (const [name, t] of Object.entries(doc.tiers)) {
    if (!Array.isArray(t.endpoints) || t.endpoints.length === 0) {
      throw new TierMapUnavailable(`tier ${name} lists no endpoints`);
    }
    if (t.default !== true && t.opt_in !== true) {
      throw new TierMapUnavailable(`tier ${name} is neither the default nor opt-in — say which`);
    }
  }
  if (doc.inference?.mode !== 'local_agent') {
    throw new TierMapUnavailable(`inference.mode is "${doc.inference?.mode}" — the local-inference rule says local_agent`);
  }
  if (doc.inference?.ai_enrich_owned !== false) {
    throw new TierMapUnavailable('ai_enrich_owned is not false — this skill does not own the paid LLM hop');
  }
  return doc;
}

export const defaultTier = (map) => map.tiers[map.default_tier];
export const tierEndpoints = (map, name) => [...(map.tiers[name]?.endpoints || [])];
export const allTierEndpoints = (map) =>
  [...new Set(Object.values(map.tiers).flatMap(t => t.endpoints))].sort();

/** The page-gated subset of a tier, read from gates.yaml rather than from the block. */
export function pageGatedIn (map, name, gates = loadGates()) {
  return tierEndpoints(map, name).filter(e => isUnbounded(gates, e)).sort();
}

/**
 * Plan one tier for one or more competitors.
 *
 * The multiplier is the point. Without
 * `skills.competitive_intel.max_competitors_per_sweep` a sweep of more than one rival
 * is STOP, because the per-endpoint page gate bounds a page and nothing bounds the
 * number of times the whole plan is run.
 */
export function planSweep ({ tier, competitors = [], map, gates = loadGates() } = {}) {
  if (!map) throw new TierMapUnavailable('planSweep: no tier map loaded — STOP');
  if (!map.tiers[tier]) return { decision: STOP, reason: `"${tier}" is not a tier in the block` };

  const n = competitors.length;
  if (n === 0) return { decision: STOP, reason: 'no competitor named' };

  const key = map.one_competitor_per_run_until;
  if (!key) return { decision: STOP, reason: 'the tier block names no sweep-ceiling key', failed_closed: true };

  let max;
  try { max = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    if (n > 1) {
      return {
        decision: STOP, gate: key, failed_closed: true, competitors: n,
        reason: `${e.message} — a multi-competitor sweep multiplies every line on the plan `
          + 'and has no ceiling; one competitor per run (law 5)',
      };
    }
    return {
      decision: ALLOW, gate: key, failed_closed: true, competitors: n, tier,
      endpoints: tierEndpoints(map, tier),
      page_gated: pageGatedIn(map, tier, gates),
      reason: `${key} is absent; one competitor per run`,
    };
  }
  if (n > Number(max)) {
    return { decision: STOP, gate: key, competitors: n, reason: `${n} competitors exceeds ${key}` };
  }
  return {
    decision: ALLOW, gate: key, failed_closed: false, competitors: n, tier,
    endpoints: tierEndpoints(map, tier),
    page_gated: pageGatedIn(map, tier, gates),
  };
}

/** A generic missing-key check for the block's other pending ceilings. */
export function pendingCeiling ({ key, requested = 0, gates = loadGates(), map } = {}) {
  const declared = map?.pending_gate_keys?.[key];
  if (!declared) return { decision: STOP, reason: `${key} is not declared in pending_gate_keys`, failed_closed: true };
  let max;
  try { max = gateValue(gates, key); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return { decision: STOP, gate: key, failed_closed: true, closed_behaviour: declared.closed_behaviour,
      reason: `${e.message} — ${declared.closed_behaviour}` };
  }
  return Number(requested) > Number(max)
    ? { decision: STOP, gate: key, reason: `${requested} exceeds ${key}` }
    : { decision: ALLOW, gate: key, max: Number(max) };
}

export default {
  loadTierMap, defaultTier, tierEndpoints, allTierEndpoints, pageGatedIn,
  planSweep, pendingCeiling, TierMapUnavailable, ALLOW, STOP, SKILL_PATH, REPO,
};
