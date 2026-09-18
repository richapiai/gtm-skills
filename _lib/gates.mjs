// _lib/gates.mjs — the spend and quality gate engine.
//
// Two laws are load-bearing here:
//
//   LAW 5 — FAIL CLOSED. A missing gates.yaml key reads as STOP, never as
//   "no gate". Every leaf read goes through gateValue(), which THROWS
//   MissingGateKey; every check wraps itself in closed(), which converts that
//   throw into { decision: 'stop', failed_closed: true }. There is no code
//   path where an absent key silently permits a paid call.
//
//   LAW 1 — no bare numbers. Every threshold in this file is read from
//   gates.yaml. scanForBareNumbers() is the enforcement hook the SKILL.md
//   validator calls.
//
// Gates fire on cumulative session spend as a FRACTION of a user-set budget,
// not on absolute credit counts. See the header of gates.yaml for why.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GATES_PATH = join(__dirname, 'gates.yaml');

export class MissingGateKey extends Error {
  constructor (key, detail) {
    super(`gates.yaml key missing: ${key}${detail ? ` (${detail})` : ''}`);
    this.name = 'MissingGateKey';
    this.key = key;
  }
}

// --- loading ---------------------------------------------------------------

/**
 * Load gates.yaml. A missing or unparseable file does NOT throw here — it
 * returns a sentinel whose every lookup throws MissingGateKey, so the failure
 * surfaces as a STOP at the gate that needed it rather than as a crash the
 * caller might catch and shrug off.
 */
export function loadGates (path = DEFAULT_GATES_PATH) {
  let raw;
  try {
    if (!existsSync(path)) return unloadable(path, 'file not found');
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return unloadable(path, e.message);
  }
  let doc;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    return unloadable(path, `unparseable YAML: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') return unloadable(path, 'empty document');
  Object.defineProperty(doc, '__source', { value: path, enumerable: false });
  return doc;
}

function unloadable (path, why) {
  const marker = { __unloadable: `${path}: ${why}` };
  Object.defineProperty(marker, '__source', { value: path, enumerable: false });
  return marker;
}

/**
 * Strict dotted-path read. Throws MissingGateKey for an absent key, a null
 * value, or a gates object that failed to load. Never returns a default —
 * a default IS the failure mode this law exists to prevent.
 */
export function gateValue (gates, dotted) {
  if (!gates || typeof gates !== 'object') throw new MissingGateKey(dotted, 'no gates loaded');
  if (gates.__unloadable) throw new MissingGateKey(dotted, gates.__unloadable);
  let node = gates;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) {
      throw new MissingGateKey(dotted);
    }
    node = node[part];
  }
  if (node === null || node === undefined) throw new MissingGateKey(dotted, 'null value');
  return node;
}

/** Non-throwing probe, for reporting only. Never use it to make a decision. */
export function hasGate (gates, dotted) {
  try { gateValue(gates, dotted); return true; } catch { return false; }
}

// --- decisions -------------------------------------------------------------

export const ALLOW = 'allow';
export const CONFIRM = 'confirm';
export const STOP = 'stop';
const RANK = { [ALLOW]: 0, [CONFIRM]: 1, [STOP]: 2 };

const allow   = (gate, reason, extra = {}) => ({ decision: ALLOW,   gate, reason, ...extra });
const confirm = (gate, reason, extra = {}) => ({ decision: CONFIRM, gate, reason, ...extra });
const stop    = (gate, reason, extra = {}) => ({ decision: STOP,    gate, reason, ...extra });

/** Wraps a check so a MissingGateKey becomes a STOP instead of an exception. */
function closed (fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MissingGateKey) {
      return stop(e.key, `${e.message} — failing closed (law 5)`, { failed_closed: true });
    }
    throw e;
  }
}

/** Worst decision wins. */
export function worst (decisions) {
  const fired = decisions.filter(Boolean);
  if (fired.length === 0) return allow('none', 'no gate applies');
  return fired.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
}

// --- session ---------------------------------------------------------------

/**
 * A session holds the budget (asked once) and cumulative spend. Gates read
 * spend/budget; nothing else in the pack may mutate `spent` directly —
 * use recordSpend() so the crossing arithmetic stays in one place.
 */
export function createSession ({ gates, budgetCredits = null, runId = null, spent = 0 } = {}) {
  return {
    gates: gates ?? loadGates(),
    run_id: runId,
    budget_credits: budgetCredits,
    budget_asked: budgetCredits !== null,
    spent_credits: spent,
    notified_fractions: [],
    waterfall_runs: {}
  };
}

/** True on the first paid call of a session, when the budget is still unset. */
export function needsBudgetPrompt (session) {
  return closed(() => {
    const askOnce = gateValue(session.gates, 'session_budget.ask_once_per_session');
    return askOnce ? !session.budget_asked : false;
  }) === true || (!session.budget_asked);
}

/** The prompt payload. Suggestion is offered, never applied silently. */
export function budgetPrompt (session) {
  return closed(() => ({
    decision: CONFIRM,
    gate: 'session_budget',
    reason: 'Session credit budget not set. Asked once, at the top of the session.',
    suggestion_credits: gateValue(session.gates, 'session_budget.suggestion_credits'),
    min_credits: gateValue(session.gates, 'session_budget.min_credits'),
    max_credits: gateValue(session.gates, 'session_budget.max_credits')
  }));
}

export function setBudget (session, credits) {
  return closed(() => {
    const min = gateValue(session.gates, 'session_budget.min_credits');
    const max = gateValue(session.gates, 'session_budget.max_credits');
    if (!Number.isFinite(credits) || credits < min || credits > max) {
      return stop('session_budget', `budget ${credits} outside [${min}, ${max}]`);
    }
    session.budget_credits = credits;
    session.budget_asked = true;
    return allow('session_budget', `session budget set to ${credits} credits`);
  });
}

export function recordSpend (session, credits) {
  session.spent_credits += Number(credits) || 0;
  return session.spent_credits;
}

// --- the spend-fraction gate ----------------------------------------------

/**
 * Fires on the fraction of the session budget a call would push cumulative
 * spend across. This is the gate that replaces absolute credit thresholds.
 */
export function checkSessionSpend (session, estimatedCredits) {
  return closed(() => {
    if (!session.budget_asked || session.budget_credits === null) {
      return stop('session_budget', 'no session budget set — ask before the first paid call', { needs_budget: true });
    }
    const budget = session.budget_credits;
    const est = Number(estimatedCredits) || 0;
    const before = session.spent_credits;
    const after = before + est;

    const fStop    = gateValue(session.gates, 'session_budget.fractions.stop');
    const fConfirm = gateValue(session.gates, 'session_budget.fractions.confirm');
    const fNotify  = gateValue(session.gates, 'session_budget.fractions.notify');
    const fSingle  = gateValue(session.gates, 'session_budget.fractions.single_call_confirm');
    const onStop   = gateValue(session.gates, 'session_budget.on_stop');

    const ctx = {
      budget_credits: budget,
      spent_before: before,
      estimated_credits: est,
      projected_after: after,
      projected_fraction: budget > 0 ? after / budget : Infinity
    };

    if (after > budget * fStop) {
      return stop('session_budget.fractions.stop',
        `this call would take session spend to ${after} of a ${budget}-credit budget (${pct(after / budget)}). Policy: ${onStop}.`,
        ctx);
    }
    if (after === budget * fStop) {
      return confirm('session_budget.fractions.stop',
        `this call exhausts the session budget exactly (${after} of ${budget}). Policy beyond it: ${onStop}.`,
        ctx);
    }
    if (est >= budget * fSingle) {
      return confirm('session_budget.fractions.single_call_confirm',
        `one call estimated at ${est} credits — ${pct(est / budget)} of the whole session budget`, ctx);
    }
    if (after >= budget * fConfirm && before < budget * fConfirm) {
      return confirm('session_budget.fractions.confirm',
        `this call crosses ${pct(fConfirm)} of the session budget (${after} of ${budget})`, ctx);
    }
    if (after >= budget * fNotify && before < budget * fNotify) {
      return allow('session_budget.fractions.notify',
        `session spend passes ${pct(fNotify)} of budget (${after} of ${budget})`, { ...ctx, notify: true });
    }
    return allow('session_budget', `within budget (${after} of ${budget})`, ctx);
  });
}

const pct = (f) => `${Math.round(f * 100)}%`;

// --- per-endpoint gates ----------------------------------------------------

export function checkDisabled (gates, endpoint) {
  return closed(() => {
    const disabled = gateValue(gates, 'disabled');
    if (Object.prototype.hasOwnProperty.call(disabled, endpoint)) {
      const d = disabled[endpoint] || {};
      return stop(`disabled.${endpoint}`,
        `${endpoint} is disabled by default: ${d.reason || 'no reason recorded'}`,
        { api_ask: d.api_ask ?? null });
    }
    return allow('disabled', `${endpoint} is not disabled`);
  });
}

export function checkAlwaysAsk (gates, endpoint) {
  return closed(() => {
    const list = gateValue(gates, 'always_ask.endpoints');
    if (!Array.isArray(list)) throw new MissingGateKey('always_ask.endpoints', 'not a list');
    if (list.includes(endpoint)) {
      return confirm('always_ask.endpoints',
        `${endpoint} always asks, regardless of remaining budget: ${gateValue(gates, 'always_ask.reason')}`);
    }
    return allow('always_ask', `${endpoint} is not an always-ask endpoint`);
  });
}

export function isUnbounded (gates, endpoint) {
  const list = gateValue(gates, 'unbounded_endpoints.endpoints');
  if (!Array.isArray(list)) throw new MissingGateKey('unbounded_endpoints.endpoints', 'not a list');
  return list.includes(endpoint);
}

/**
 * Page gate. For the 11 per-result endpoints with no request field that
 * bounds the total charge, the human between pages IS the bound.
 */
export function checkPageGate (gates, endpoint, page = 1) {
  return closed(() => {
    if (!isUnbounded(gates, endpoint)) {
      return allow('unbounded_endpoints', `${endpoint} is bounded by a request field`);
    }
    const policy   = gateValue(gates, 'unbounded_endpoints.policy');
    const free     = gateValue(gates, 'unbounded_endpoints.pages_before_confirm');
    const ceiling  = gateValue(gates, 'unbounded_endpoints.hard_page_ceiling');
    const p = Number(page) || 1;
    if (p > ceiling) {
      return stop('unbounded_endpoints.hard_page_ceiling',
        `page ${p} exceeds the hard ceiling of ${ceiling} for unbounded endpoint ${endpoint}`,
        { endpoint, page: p, policy });
    }
    if (p > free) {
      return confirm('unbounded_endpoints.policy',
        `${endpoint} is unbounded — confirm before fetching page ${p} (one page at a time)`,
        { endpoint, page: p, policy });
    }
    return allow('unbounded_endpoints.policy',
      `${endpoint} page ${p} runs; every page after this one asks`,
      { endpoint, page: p, policy, page_gated: true });
  });
}

export function assumedResultsPerPage (gates) {
  return gateValue(gates, 'unbounded_endpoints.assumed_results_per_page');
}

// --- quality stops ---------------------------------------------------------

export function checkCoverage (gates, coveragePct) {
  return closed(() => {
    const min = gateValue(gates, 'quality_stops.coverage_min_pct');
    if (!Number.isFinite(coveragePct)) {
      return stop('quality_stops.coverage_min_pct', 'coverage not measured — cannot clear the gate');
    }
    return coveragePct < min
      ? stop('quality_stops.coverage_min_pct', `coverage ${coveragePct}% is below the ${min}% floor`, { coverage_pct: coveragePct, min })
      : allow('quality_stops.coverage_min_pct', `coverage ${coveragePct}% clears the ${min}% floor`);
  });
}

export function checkVerificationFailRate (gates, { failPct, hardBouncePct = null } = {}) {
  return closed(() => {
    const maxFail = gateValue(gates, 'quality_stops.verification_max_fail_rate_pct');
    const maxHard = gateValue(gates, 'quality_stops.verification_max_hard_bounce_pct');
    if (!Number.isFinite(failPct)) {
      return stop('quality_stops.verification_max_fail_rate_pct', 'fail rate not measured — cannot clear the gate');
    }
    if (failPct > maxFail) {
      return stop('quality_stops.verification_max_fail_rate_pct',
        `verification fail rate ${failPct}% exceeds ${maxFail}% — the source list is the problem, not the verifier`,
        { fail_pct: failPct, max: maxFail });
    }
    if (hardBouncePct !== null && Number.isFinite(hardBouncePct) && hardBouncePct > maxHard) {
      return stop('quality_stops.verification_max_hard_bounce_pct',
        `hard-bounce rate ${hardBouncePct}% exceeds ${maxHard}%`, { hard_bounce_pct: hardBouncePct, max: maxHard });
    }
    return allow('quality_stops', `verification fail rate ${failPct}% is within ${maxFail}%`);
  });
}

export function checkWaterfallReruns (gates, session, key = 'default') {
  return closed(() => {
    const max = gateValue(gates, 'quality_stops.max_waterfall_reruns');
    const runs = (session.waterfall_runs?.[key] ?? 0);
    if (runs >= max) {
      return stop('quality_stops.max_waterfall_reruns',
        `waterfall already re-run ${runs} time(s) for "${key}" (max ${max}) — a re-run recharges every tier`,
        { runs, max });
    }
    return allow('quality_stops.max_waterfall_reruns', `waterfall run ${runs + 1} of ${max + 1} allowed for "${key}"`);
  });
}

export function noteWaterfallRun (session, key = 'default') {
  session.waterfall_runs[key] = (session.waterfall_runs[key] ?? 0) + 1;
  return session.waterfall_runs[key];
}

// --- platform + watchlist --------------------------------------------------

export function checkAudienceMinimum (gates, platform, size) {
  return closed(() => {
    const mins = gateValue(gates, 'audience_minimums');
    const key = String(platform ?? '').toLowerCase();
    // No `default` key exists on purpose: an unknown platform fails closed.
    if (!Object.prototype.hasOwnProperty.call(mins, key)) {
      throw new MissingGateKey(`audience_minimums.${key}`, 'unknown platform');
    }
    const min = mins[key];
    return size < min
      ? stop(`audience_minimums.${key}`,
          `audience of ${size} is below ${platform}'s ${min} floor — the platform rejects it after the credits are spent`,
          { platform: key, size, min })
      : allow(`audience_minimums.${key}`, `audience of ${size} clears ${platform}'s ${min} floor`);
  });
}

export function checkWatchlistSize (gates, count) {
  return closed(() => {
    const soft = gateValue(gates, 'watchlist.max_entities');
    const hard = gateValue(gates, 'watchlist.max_entities_hard_stop');
    if (count > hard) {
      return stop('watchlist.max_entities_hard_stop', `watchlist of ${count} exceeds the hard ceiling of ${hard}`, { count, hard });
    }
    if (count > soft) {
      return confirm('watchlist.max_entities', `watchlist of ${count} exceeds the ${soft}-entity ceiling; every refresh recosts it`, { count, soft });
    }
    return allow('watchlist.max_entities', `watchlist of ${count} is within ${soft}`);
  });
}

// --- cache TTL -------------------------------------------------------------
// Shape shared with _lib/pii.mjs (it reads the same `cache_ttl`
// block for the PII retention sweep). A value is a class name OR a duration.

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i;
const DURATION_DAYS = { s: 1 / 86400, m: 1 / 1440, h: 1 / 24, d: 1, w: 7 };

/** "90d" -> 90 (days). Returns null for anything that is not a duration. */
export function parseDuration (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = DURATION_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * DURATION_DAYS[m[2].toLowerCase()];
}

/**
 * Resolution order: endpoints -> capability_groups -> the fail-closed floor.
 *
 * FAIL CLOSED, twice over. A missing key STOPs, as everywhere else. And an
 * endpoint with no entry resolves to the SHORTEST TTL, never the longest:
 * the unmatched case is clamped to min(classes.unknown, every other class),
 * so editing `unknown` upward can never widen an unmatched endpoint's cache.
 */
export function cacheTtlDays (gates, { endpoint = null, capabilityGroup = null } = {}) {
  return closed(() => {
    const classes = gateValue(gates, 'cache_ttl.classes');
    if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
      throw new MissingGateKey('cache_ttl.classes', 'not a map');
    }

    // Every class must be a parseable duration, or we cannot know the floor.
    const classDays = {};
    for (const [name, value] of Object.entries(classes)) {
      const d = parseDuration(value);
      if (d === null) throw new MissingGateKey(`cache_ttl.classes.${name}`, `unparseable duration "${value}"`);
      classDays[name] = d;
    }
    const unknownDays = classDays.unknown;
    if (unknownDays === undefined) throw new MissingGateKey('cache_ttl.classes.unknown');
    const shortest = Math.min(...Object.values(classDays));

    // A class name or a literal duration, from either map.
    const resolve = (value, keyPath) => {
      const literal = parseDuration(value);
      if (literal !== null) return { days: literal, via: `${keyPath} (literal ${value})` };
      const named = classDays[value];
      if (named === undefined) {
        throw new MissingGateKey(`cache_ttl.classes.${value}`, `referenced by ${keyPath}`);
      }
      return { days: named, via: `${keyPath} -> class ${value}` };
    };

    const byEndpoint = gateValue(gates, 'cache_ttl.endpoints');
    if (endpoint && Object.prototype.hasOwnProperty.call(byEndpoint, endpoint)) {
      const r = resolve(byEndpoint[endpoint], `cache_ttl.endpoints.${endpoint}`);
      return allow('cache_ttl.endpoints', `${endpoint} caches for ${r.days}d (${r.via})`, { ttl_days: r.days, via: r.via });
    }

    const byGroup = gateValue(gates, 'cache_ttl.capability_groups');
    if (capabilityGroup && Object.prototype.hasOwnProperty.call(byGroup, capabilityGroup)) {
      const r = resolve(byGroup[capabilityGroup], `cache_ttl.capability_groups.${capabilityGroup}`);
      return allow('cache_ttl.capability_groups', `${capabilityGroup} caches for ${r.days}d (${r.via})`, { ttl_days: r.days, via: r.via });
    }

    // Unmatched: the shortest TTL there is, never the longest.
    const days = Math.min(unknownDays, shortest);
    return allow('cache_ttl.classes.unknown',
      `no TTL entry for ${endpoint ?? capabilityGroup ?? 'this call'} — falling back to the shortest TTL, ${days}d`,
      { ttl_days: days, via: 'fail-closed floor', unmatched: true });
  });
}

export function cacheTtlSeconds (gates, opts) {
  const d = cacheTtlDays(gates, opts);
  if (d.decision === STOP) return d;
  return { ...d, ttl_seconds: Math.round(d.ttl_days * 86400) };
}

// --- the composite check every paid call goes through ----------------------

/**
 * The one entry point a skill uses before a paid call.
 * `catalogEntry` is an endpoint from _lib/api-catalog.json (per
 * api-catalog.schema.json). This codes against the SCHEMA, not the generator.
 */
export function checkCall (session, {
  endpoint,
  catalogEntry = null,
  estimatedCredits = null,
  page = 1
} = {}) {
  const gates = session.gates;
  const fired = [];

  fired.push(checkDisabled(gates, endpoint));

  // Unknown pricing is an unknown cost, which fails closed like a missing key.
  if (catalogEntry) {
    const model = catalogEntry?.pricing?.model;
    if (!model || model === 'unknown') {
      fired.push(stop('catalog.pricing.model',
        `${endpoint} has no known pricing model in the catalog — cannot cost the call, failing closed`,
        { failed_closed: true }));
    }
    if (catalogEntry?.pricing?.disabled_by_default === true) {
      fired.push(stop('catalog.pricing.disabled_by_default',
        `${endpoint} is disabled_by_default in the catalog: ${catalogEntry.pricing.disabled_reason ?? 'no reason recorded'}`));
    }
  }

  fired.push(checkAlwaysAsk(gates, endpoint));
  fired.push(checkPageGate(gates, endpoint, page));

  if (needsBudgetPrompt(session)) {
    fired.push({ ...budgetPrompt(session), needs_budget: true });
  } else {
    fired.push(checkSessionSpend(session, estimatedCredits ?? 0));
  }

  const decision = worst(fired);
  return {
    ...decision,
    endpoint,
    page,
    estimated_credits: estimatedCredits,
    fired: fired.filter(f => f.decision !== ALLOW || f.notify || f.page_gated)
  };
}

// --- LAW 1 enforcement hook (for scripts/validate-skills.mjs) --------------

/** Every leaf gate key, dotted. Used by the validator and by `--explain`. */
export function gateKeys (gates = loadGates()) {
  const out = [];
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object') { out.push(prefix); return; }
    if (Array.isArray(node)) { out.push(prefix); return; }
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  if (gates && !gates.__unloadable) walk(gates, '');
  return out.filter(Boolean).sort();
}

const BARE_NUMBER_PATTERNS = [
  { re: /(?<!\w)(\d[\d,]*(?:\.\d+)?)\s*(?:credits?|cr)\b/gi,               what: 'credit cost' },
  { re: /\b(?:budget|spend|cost|charge)s?\s+(?:of\s+)?(\d[\d,]*(?:\.\d+)?)/gi, what: 'spend threshold' },
  { re: /\b(?:at least|minimum of|min|no fewer than|floor of)\s+(\d[\d,]*)/gi, what: 'audience minimum' },
  { re: /\b(?:coverage|fail rate|bounce rate)\D{0,20}?(\d[\d,]*(?:\.\d+)?)\s*%/gi, what: 'quality threshold' },
  { re: /(\d[\d,]*)\s*(?:day|days|hour|hours)\s+(?:TTL|cache|stale)/gi,     what: 'cache TTL' },
  { re: /\b(?:TTL|cache|caches|cached)\b\D{0,40}?(\d[\d,]*)\s*(?:d|day|days|h|hours?)\b/gi, what: 'cache TTL' }
];

// A line that names the gate key it is quoting is not a bare number.
const CITES_GATE = /gates\.yaml|\{\{\s*gates\./i;

// A line that cites a STATUTE is not a bare number either, and must not be
// forced to pretend it came from gates.yaml.
//
// WHY. Law 1 exists because prices rot: 16 of 53
// surviving endpoints repriced in four months, phone_finder 3 -> 25 credits. A
// statutory period does not rot that way, and it is not a knob an operator may
// tune — "CASL requires consent records be retained for at least 3 years" is a
// fact about the law, not a policy this pack sets.
//
// Without this escape the /comply skill cannot state the rules it enforces:
// measured against real compliance prose, the `audience minimum` pattern
// claimed both "at least 3 years" and "no fewer than 10 business days", and the
// validator promotes those to ERRORS. The only other way out would be to write
// `gates.yaml` on the line, which would be false — and an escape token used
// falsely is worse than no escape, because it teaches authors to sprinkle it
// and quietly disarms law 1 everywhere it does matter.
//
// Deliberately narrow: it wants a named regime or an explicit article/section
// reference on the SAME line as the number. "GDPR" alone in a heading three
// lines up does not exempt anything below it.
const CITES_STATUTE = new RegExp([
  '\\b(?:GDPR|CCPA|CPRA|CASL|PECR|LGPD|CAN-?SPAM|HIPAA|COPPA|PIPEDA)\\b',
  '\\b(?:Article|Art\\.|Section|Sec\\.|§)\\s*\\d+',
  '\\bstatutor(?:y|ily)\\b',
  '\\b(?:regulation|directive)\\s+\\(?[A-Z]{2}\\)?\\s*\\d',
].join('|'), 'i');

/**
 * Scans a SKILL.md (or any doc) for hand-typed thresholds. A number is only
 * allowed where the same line cites the gates.yaml key it came from.
 * Returns [] when clean; the validator fails the file on any finding.
 */
export function scanForBareNumbers (text, { file = null } = {}) {
  const findings = [];
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;                  // code blocks are examples, not policy
    if (CITES_GATE.test(line)) return;    // cites its source
    if (CITES_STATUTE.test(line)) return; // cites the law, not a tunable policy
    for (const { re, what } of BARE_NUMBER_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({
          file, line: i + 1, kind: what, value: m[1], text: line.trim(),
          message: `bare ${what} "${m[0].trim()}" — move it to gates.yaml and cite the key (law 1)`
        });
      }
    }
  });
  return findings;
}

export default {
  loadGates, gateValue, hasGate, gateKeys, MissingGateKey,
  createSession, needsBudgetPrompt, budgetPrompt, setBudget, recordSpend,
  checkSessionSpend, checkDisabled, checkAlwaysAsk, isUnbounded, checkPageGate,
  assumedResultsPerPage, checkCoverage, checkVerificationFailRate,
  checkWaterfallReruns, noteWaterfallRun, checkAudienceMinimum,
  checkWatchlistSize, cacheTtlDays, cacheTtlSeconds, parseDuration, checkCall,
  scanForBareNumbers, worst, ALLOW, CONFIRM, STOP, DEFAULT_GATES_PATH
};
