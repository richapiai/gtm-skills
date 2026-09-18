// Catalog diff + severity classification.
//
// CALIBRATION, and why it is not a binary gate.
// Measured churn between the 2026-05 catalog and the 2026-08 spec is 13 endpoints gone,
// 15 new, 16 of 53 survivors repriced — roughly 30% of the surface per four months.
// A gate that blocked on "anything moved" would be red every month and switched off by
// month two, at which point it protects nothing. So the classes below are sized so a
// typical cycle costs about ONE human decision:
//
//   BLOCK   REPRICED_MAJOR             >=2x price INCREASE. 1 of 16 repricings hit this
//                                      (phone_finder 3 -> 25, 8.3x).
//   BLOCK   REMOVED_UNMAPPED           gone, and no rename candidate. Most of the 13
//                                      removals were renames and get absorbed below.
//   BLOCK   PRICING_SEMANTICS_CHANGED  the money is computed a different way now. This
//                                      already bit us once: per-success/soft-fail tiers
//                                      became a flat credits_per_call and the pack's
//                                      cost model silently inherited a new meaning.
//   warn    RENAMED                    fuzzy-matched old -> new. Auto-PR-able.
//   warn    REPRICED_MINOR             <2x, or any decrease. Decreases are deliberately
//                                      NOT major: "several went down" and spending a
//                                      human decision on a price cut is how a gate
//                                      loses its credibility.
//   warn    DEPRECATED                 deprecated flag newly set.
//   info    ADDED / UNCHANGED
//
// Only BLOCK classes make the CLI exit non-zero.

import { capabilityGroupFor } from './taxonomy.mjs';

export const SEVERITY = {
  RENAMED: 'warn',
  REPRICED_MINOR: 'warn',
  REPRICED_MAJOR: 'block',
  REMOVED_UNMAPPED: 'block',
  PRICING_SEMANTICS_CHANGED: 'block',
  DEPRECATED: 'warn',
  ADDED: 'info',
  UNCHANGED: 'info',
};

export const BLOCKING = Object.entries(SEVERITY)
  .filter(([, s]) => s === 'block')
  .map(([k]) => k);

/** Price change at or above this multiple is MAJOR. */
export const MAJOR_RATIO = 2;

/** Minimum combined similarity for an old->new pair to be called a rename. */
export const RENAME_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Fuzzy rename matching
// ---------------------------------------------------------------------------

// Renames in this API are morphological, not arbitrary: find_emails -> email_finder,
// person_enricher -> enrich_profile, ad_search -> linkedin_ad_search,
// google_maps_places_scraper -> google_maps_places_scraper_keyword. Stemming the
// agent/verb forms onto one root is what lets a token-set score see them as the same.
const STEM = new Map(
  Object.entries({
    enricher: 'enrich',
    enrichment: 'enrich',
    enriched: 'enrich',
    finder: 'find',
    finding: 'find',
    verifier: 'verify',
    verification: 'verify',
    searcher: 'search',
    scraping: 'scraper',
    scrape: 'scraper',
    emails: 'email',
    profiles: 'profile',
    companies: 'company',
    people: 'person',
    persons: 'person',
    leads: 'lead',
    places: 'place',
    posts: 'post',
    urls: 'url',
    checks: 'check',
  })
);

export function tokens(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => STEM.get(t) ?? t)
    .filter((t) => t !== 'sync' && t !== 'v1' && t !== 'api');
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const pool = new Map();
  for (const g of A) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of B) {
    const c = pool.get(g) ?? 0;
    if (c > 0) {
      hits += 1;
      pool.set(g, c - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

/** 0..1 name similarity, blending token-set overlap with character bigram overlap. */
export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  return 0.65 * jaccard(ta, tb) + 0.35 * dice(ta.join(''), tb.join(''));
}

/**
 * Pair removed endpoints with added ones.
 *
 * Guardrails, because a wrong rename silently reroutes a skill to a different endpoint:
 * the pair must score above the threshold and, when both groups are actually KNOWN,
 * must share a capability group. The "known" qualifier matters — a departed endpoint is
 * by definition absent from the current taxonomy, so its group is a heuristic guess.
 * Gating on a guess turned `ad_search -> linkedin_ad_search` and
 * `google_search_scraper -> google_search_scraper_sync` into REMOVED_UNMAPPED BLOCKs on
 * the real diff. A guess carries no information; it must not veto a strong name match.
 *
 * Each added endpoint can be claimed once, best score first, so two removals never
 * collapse onto the same replacement.
 */
export function matchRenames(removed, added, oldEndpoints, newEndpoints, threshold = RENAME_THRESHOLD) {
  const candidates = [];
  for (const from of removed) {
    const fromKnown = !capabilityGroupFor(from).provisional;
    for (const to of added) {
      const toKnown = !capabilityGroupFor(to).provisional;
      if (
        fromKnown &&
        toKnown &&
        oldEndpoints[from].capability_group !== newEndpoints[to].capability_group
      ) {
        continue;
      }
      const score = similarity(from, to);
      if (score >= threshold) candidates.push({ from, to, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const usedFrom = new Set();
  const usedTo = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedFrom.has(c.from) || usedTo.has(c.to)) continue;
    usedFrom.add(c.from);
    usedTo.add(c.to);
    pairs.push(c);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Pricing comparison
// ---------------------------------------------------------------------------

/**
 * The comparable number for one endpoint's price.
 *
 * Flat endpoints compare on credits_per_call. Per-result endpoints compare on the
 * per-result rate, with the base folded in only when it exists, because that is the
 * term that scales with a run. Two endpoints with different models are never compared
 * numerically — that is a semantics change, handled separately.
 */
export function comparablePrice(pricing) {
  if (!pricing) return null;
  switch (pricing.model) {
    case 'flat':
      return pricing.credits_per_call;
    case 'per_result':
    case 'base_plus_per_result':
      return pricing.credits_per_result;
    default:
      return null;
  }
}

/**
 * A change in HOW the bill is computed, not how much. Any of these means every cost
 * estimate the pack has ever written for this endpoint used a different formula.
 */
export function semanticsChange(oldP, newP) {
  const reasons = [];
  if (oldP.model !== newP.model) reasons.push(`pricing model ${oldP.model} -> ${newP.model}`);
  // Only fires when the OLD catalog knew which field it was billed on. null -> "elements"
  // is the pack learning where the count lives, not the API changing the bill; treating
  // it as a BLOCK produced 8 false alarms on the real 2026-05 -> 2026-08 diff, which is
  // precisely how a gate gets switched off.
  const oldRcf = oldP.result_count_field ?? null;
  const newRcf = newP.result_count_field ?? null;
  if (oldRcf !== null && oldRcf !== newRcf) {
    reasons.push(`result_count_field ${oldRcf} -> ${newRcf ?? 'none'}`);
  }
  if (oldP.billing_field_present_in_response === true && newP.billing_field_present_in_response === false) {
    reasons.push('billing field disappeared from the response — actuals become unverifiable');
  }
  if (oldP.bounded === true && newP.bounded === false) {
    reasons.push('lost its result-limit parameter — spend is no longer bounded per call');
  }
  // A base appearing or vanishing changes the formula even when the model label holds.
  const oldBase = oldP.credits_base ?? null;
  const newBase = newP.credits_base ?? null;
  if (oldBase !== null && newBase !== null && oldBase !== newBase && (oldBase === 0 || newBase === 0)) {
    reasons.push(`per-call base ${oldBase} -> ${newBase}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * @param {object} oldCatalog
 * @param {object} newCatalog
 * @returns {{changes: Array, summary: object, blocking: Array, exitCode: number}}
 */
export function diffCatalogs(oldCatalog, newCatalog, opts = {}) {
  const majorRatio = opts.majorRatio ?? MAJOR_RATIO;
  const oldE = oldCatalog?.endpoints ?? {};
  const newE = newCatalog?.endpoints ?? {};
  const oldNames = Object.keys(oldE);
  const newNames = Object.keys(newE);

  const removed = oldNames.filter((n) => !(n in newE)).sort();
  const added = newNames.filter((n) => !(n in oldE)).sort();
  const kept = oldNames.filter((n) => n in newE).sort();

  const changes = [];
  const renames = matchRenames(removed, added, oldE, newE, opts.renameThreshold ?? RENAME_THRESHOLD);
  const renamedFrom = new Set(renames.map((r) => r.from));
  const renamedTo = new Set(renames.map((r) => r.to));

  for (const r of renames) {
    const oldP = oldE[r.from].pricing ?? {};
    const newP = newE[r.to].pricing ?? {};
    changes.push({
      class: 'RENAMED',
      severity: SEVERITY.RENAMED,
      endpoint: r.to,
      from: r.from,
      score: Number(r.score.toFixed(3)),
      detail:
        `${r.from} -> ${r.to} (similarity ${r.score.toFixed(2)}, ` +
        (oldE[r.from].capability_group === newE[r.to].capability_group
          ? `same capability group "${newE[r.to].capability_group}"`
          : `groups ${oldE[r.from].capability_group} -> ${newE[r.to].capability_group}, ` +
            `at least one is a heuristic guess`) +
        ')',
      auto_prable: true,
    });
    // A rename can also carry a price or semantics change; classify that on its own.
    changes.push(...comparePricing(r.to, oldP, newP, majorRatio, ` (renamed from ${r.from})`));
  }

  for (const n of removed) {
    if (renamedFrom.has(n)) continue;
    changes.push({
      class: 'REMOVED_UNMAPPED',
      severity: SEVERITY.REMOVED_UNMAPPED,
      endpoint: n,
      detail:
        `${n} is gone from the spec and no added endpoint in capability group ` +
        `"${oldE[n].capability_group}" matched it. Every skill routing to it now fails at ` +
        `call time. Remap or retire it deliberately.`,
    });
  }

  for (const n of added) {
    if (renamedTo.has(n)) continue;
    changes.push({
      class: 'ADDED',
      severity: SEVERITY.ADDED,
      endpoint: n,
      detail: `${n} is new (${newE[n].capability_group}). Claim it in _lib/endpoint-owners.yaml.`,
    });
  }

  for (const n of kept) {
    const o = oldE[n];
    const w = newE[n];
    if (o.deprecated !== true && w.deprecated === true) {
      changes.push({
        class: 'DEPRECATED',
        severity: SEVERITY.DEPRECATED,
        endpoint: n,
        detail: `${n} is now marked deprecated. Every skill preflight that uses it must warn.`,
      });
    }
    changes.push(...comparePricing(n, o.pricing ?? {}, w.pricing ?? {}, majorRatio, ''));
  }

  changes.sort(
    (a, b) => a.class.localeCompare(b.class) || a.endpoint.localeCompare(b.endpoint)
  );

  const summary = {};
  for (const c of changes) summary[c.class] = (summary[c.class] ?? 0) + 1;
  const blocking = changes.filter((c) => c.severity === 'block');
  return { changes, summary, blocking, exitCode: blocking.length > 0 ? 1 : 0 };
}

function comparePricing(name, oldP, newP, majorRatio, suffix) {
  const out = [];
  const reasons = semanticsChange(oldP, newP);
  if (reasons.length) {
    out.push({
      class: 'PRICING_SEMANTICS_CHANGED',
      severity: SEVERITY.PRICING_SEMANTICS_CHANGED,
      endpoint: name,
      detail: `${name}: ${reasons.join('; ')}${suffix}. Every cost estimate for this endpoint used the old formula.`,
      reasons,
    });
    return out; // A formula change subsumes the number change; do not double-report.
  }
  const a = comparablePrice(oldP);
  const b = comparablePrice(newP);
  if (a === null || b === null || a === b) return out;

  // A price appearing from zero has no finite ratio; treat any non-zero as major.
  const ratio = a === 0 ? (b === 0 ? 1 : Infinity) : b / a;
  const major = ratio >= majorRatio;
  out.push({
    class: major ? 'REPRICED_MAJOR' : 'REPRICED_MINOR',
    severity: major ? SEVERITY.REPRICED_MAJOR : SEVERITY.REPRICED_MINOR,
    endpoint: name,
    from_credits: a,
    to_credits: b,
    ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : null,
    detail:
      `${name}: ${a} -> ${b} credits` +
      (Number.isFinite(ratio) ? ` (${ratio.toFixed(2)}x)` : ' (was free)') +
      `${suffix}`,
  });
  return out;
}

/** Human-readable report. */
export function formatReport(result, { oldLabel = 'old', newLabel = 'new' } = {}) {
  const lines = [];
  lines.push(`catalog diff  ${oldLabel} -> ${newLabel}`);
  const order = ['PRICING_SEMANTICS_CHANGED', 'REPRICED_MAJOR', 'REMOVED_UNMAPPED', 'RENAMED', 'REPRICED_MINOR', 'DEPRECATED', 'ADDED'];
  const counts = order
    .filter((k) => result.summary[k])
    .map((k) => `${k}=${result.summary[k]}`)
    .join('  ');
  lines.push(counts ? `  ${counts}` : '  no changes');
  for (const cls of order) {
    const rows = result.changes.filter((c) => c.class === cls);
    if (!rows.length) continue;
    const mark = SEVERITY[cls] === 'block' ? 'BLOCK' : SEVERITY[cls] === 'warn' ? 'warn ' : 'info ';
    lines.push('');
    lines.push(`${mark} ${cls} (${rows.length})`);
    for (const r of rows) lines.push(`  - ${r.detail}`);
  }
  lines.push('');
  lines.push(
    result.blocking.length
      ? `${result.blocking.length} blocking change(s) need a human decision before this catalog lands.`
      : 'No blocking changes. Warnings above are informational.'
  );
  return lines.join('\n');
}
