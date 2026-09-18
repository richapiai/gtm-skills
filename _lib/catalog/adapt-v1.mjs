// Adapter: the legacy MCP tool-list catalog format (a `tools[]` array) -> the v2
// catalog shape, so `richapi-catalog-diff` can diff a legacy catalog against a current
// one rather than only synthetic fixtures.
//
// The legacy format encodes price as prose ("2 success / 1 soft-fail / 0 hard-fail",
// "0.05 / review"). Those tiered forms have NO representation in the new x-pricing
// vocabulary, which is the point: they map to model "unknown", and "unknown" -> "flat"
// is reported as PRICING_SEMANTICS_CHANGED. That change already happened silently once.

import { capabilityGroupFor } from './taxonomy.mjs';

const TIERED = /soft-fail|hard-fail|success/i;

/** "0.1 / result" -> 0.1 · "2 / call (5 for Perplexity)" -> 2 · "0 (free)" -> 0 */
function leadingNumber(s) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
}

export function isV1Catalog(json) {
  return Array.isArray(json?.tools) && json.endpoints === undefined;
}

export function adaptV1(json) {
  const endpoints = {};
  for (const tool of json.tools) {
    const credits = leadingNumber(tool.credits);
    let model = 'unknown';
    let perCall = null;
    let perResult = null;

    if (TIERED.test(String(tool.credits ?? '')) || tool.billing === 'per_success' || tool.billing === 'waterfall') {
      model = 'unknown'; // per-success / soft-fail tiers: no vocabulary in x-pricing
    } else if (tool.billing === 'per_result') {
      model = 'per_result';
      perResult = credits;
    } else if (tool.billing === 'per_call' || tool.billing === 'free') {
      model = 'flat';
      perCall = credits;
    }

    endpoints[tool.name] = {
      name: tool.name,
      path: `/${tool.name}`,
      capability_group: capabilityGroupFor(tool.name).group,
      spec_tag: tool.category ?? null,
      pricing: {
        model,
        credits_per_call: perCall,
        credits_base: null,
        credits_per_result: perResult,
        // v1 never recorded which field the charge came from.
        result_count_field: model === 'per_result' ? null : null,
        // The v1 payload carries no response body, so it is no evidence that a charge
        // comes back. Fail closed (law 5) and let the drift runner carry the pinned
        // value forward; `model === 'flat'` here used to manufacture a `true` out of a
        // pricing model, which is the fabrication law 4 forbids.
        billing_field_present_in_response: false,
        bounded: model === 'flat',
        disabled_by_default: false,
        disabled_reason: null,
      },
      required_request_fields: [],
      request_body_required: true,
      bulk_variant: tool.bulk_variant ?? null,
      max_batch: tool.max_batch ?? null,
      field_map: null,
      field_map_status: 'TODO_no_usable_example',
      deprecated: false,
    };
  }
  const sorted = {};
  for (const k of Object.keys(endpoints).sort()) sorted[k] = endpoints[k];
  return {
    schema_version: 1,
    generated_at: json.generated_at ?? null,
    spec_sha256: null,
    spec_version: json.version ?? 'v1',
    endpoints: sorted,
  };
}

/** Accept either shape. */
export function normalizeCatalog(json) {
  return isV1Catalog(json) ? adaptV1(json) : json;
}
