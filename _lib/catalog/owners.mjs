// _lib/endpoint-owners.yaml: load, enforce, and render the coverage table.
//
// The gate is UNMAPPED, not untagged: every endpoint the spec ships must be claimed by
// at least one skill or explicitly unclaimed WITH A REASON. That distinction is the
// whole point — "39% of tools unused" was never a coverage statistic, it was an absence
// of any record of which gaps were on purpose.

import fs from 'node:fs';
import YAML from 'yaml';

import { GROUP_ORDER } from './taxonomy.mjs';

export function loadOwners(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  return {
    defaults_by_capability_group: doc.defaults_by_capability_group ?? {},
    endpoints: doc.endpoints ?? {},
    unclaimed: doc.unclaimed ?? {},
  };
}

/**
 * @param {object} owners  parsed endpoint-owners.yaml
 * @param {object} catalog generated api-catalog.json
 * @returns {{ok: boolean, problems: Array<{code: string, endpoint?: string, message: string}>, counts: object}}
 */
export function checkOwners(owners, catalog) {
  const problems = [];
  const specNames = Object.keys(catalog.endpoints ?? {});
  const specSet = new Set(specNames);
  const claimed = owners.endpoints ?? {};
  const unclaimed = owners.unclaimed ?? {};

  for (const name of specNames) {
    const inClaimed = Object.prototype.hasOwnProperty.call(claimed, name);
    const inUnclaimed = Object.prototype.hasOwnProperty.call(unclaimed, name);
    if (!inClaimed && !inUnclaimed) {
      problems.push({
        code: 'UNMAPPED',
        endpoint: name,
        message:
          `${name} (${catalog.endpoints[name].capability_group}) is in the spec but appears ` +
          `under neither endpoints: nor unclaimed: in _lib/endpoint-owners.yaml. Claim it, ` +
          `or list it under unclaimed: with a one-line reason.`,
      });
      continue;
    }
    if (inClaimed && inUnclaimed) {
      problems.push({
        code: 'DOUBLE_LISTED',
        endpoint: name,
        message: `${name} is listed under both endpoints: and unclaimed:.`,
      });
    }
    if (inClaimed) {
      const owners_ = claimed[name];
      if (!Array.isArray(owners_) || owners_.length === 0 || owners_.some((s) => typeof s !== 'string' || !s.trim())) {
        problems.push({
          code: 'EMPTY_OWNERS',
          endpoint: name,
          message: `${name} is claimed but its owner list is empty or malformed.`,
        });
      }
    }
    if (inUnclaimed) {
      const reason = unclaimed[name];
      if (typeof reason !== 'string' || reason.trim().length < 10) {
        problems.push({
          code: 'MISSING_REASON',
          endpoint: name,
          message:
            `${name} is unclaimed without a usable reason. A deliberate gap and an ` +
            `accidental gap must never look alike.`,
        });
      }
    }
  }

  for (const name of Object.keys(claimed)) {
    if (!specSet.has(name)) {
      problems.push({
        code: 'STALE_CLAIM',
        endpoint: name,
        message: `${name} is claimed but no longer exists in the spec — a skill is routing to a dead endpoint.`,
      });
    }
  }
  for (const name of Object.keys(unclaimed)) {
    if (!specSet.has(name)) {
      problems.push({
        code: 'STALE_UNCLAIMED',
        endpoint: name,
        message: `${name} is listed as unclaimed but no longer exists in the spec; drop the row.`,
      });
    }
  }

  const groupsInCatalog = new Set(Object.values(catalog.endpoints ?? {}).map((e) => e.capability_group));
  for (const g of groupsInCatalog) {
    if (!owners.defaults_by_capability_group?.[g]) {
      problems.push({
        code: 'NO_GROUP_DEFAULT',
        message: `capability group "${g}" has no entry in defaults_by_capability_group.`,
      });
    }
  }

  problems.sort((a, b) => a.code.localeCompare(b.code) || (a.endpoint ?? '').localeCompare(b.endpoint ?? ''));
  return {
    ok: problems.length === 0,
    problems,
    counts: {
      spec_endpoints: specNames.length,
      claimed: specNames.filter((n) => Object.prototype.hasOwnProperty.call(claimed, n)).length,
      unclaimed: specNames.filter((n) => Object.prototype.hasOwnProperty.call(unclaimed, n)).length,
      unmapped: problems.filter((p) => p.code === 'UNMAPPED').length,
    },
  };
}

/** Credits, formatted from the catalog. No credit number is ever typed by hand. */
function priceLabel(pricing) {
  switch (pricing.model) {
    case 'flat':
      return pricing.credits_per_call === 0 ? 'free' : `${pricing.credits_per_call} / call`;
    case 'per_result':
      return `${pricing.credits_per_result} / result`;
    case 'base_plus_per_result':
      return `${pricing.credits_base} + ${pricing.credits_per_result} / result`;
    default:
      return 'unknown';
  }
}

/** GENERATED. Do not hand-edit the output of this function. */
export function renderCoverage(owners, catalog) {
  const eps = catalog.endpoints ?? {};
  const names = Object.keys(eps).sort();
  const check = checkOwners(owners, catalog);

  const lines = [];
  lines.push('<!-- GENERATED by _lib/catalog/owners-check.mjs --write-coverage. Do not edit. -->');
  lines.push('');
  lines.push('# Endpoint coverage');
  lines.push('');
  lines.push(
    `Generated from \`_lib/endpoint-owners.yaml\` + \`_lib/api-catalog.json\` ` +
      `(spec ${catalog.spec_version}, sha \`${String(catalog.spec_sha256).slice(0, 12)}\`).`
  );
  lines.push('');
  const reporting = Object.values(catalog.endpoints ?? {})
    .filter((e) => e.pricing?.billing_field_present_in_response === true).length;
  lines.push(
    reporting === 0
      ? '**No endpoint reports its charge.** Across every recorded 2xx response, none carries a '
        + 'credits/charge field, so every credit figure in this table is an ESTIMATE from the '
        + 'catalog price and every ledger line reads `estimated_unverifiable`.'
      : `${reporting} endpoint(s) report their charge in the response; every other credit figure `
        + 'here is an estimate and its ledger line reads `estimated_unverifiable`.'
  );
  lines.push('');
  lines.push(
    `**${check.counts.spec_endpoints} endpoints** — ${check.counts.claimed} claimed, ` +
      `${check.counts.unclaimed} deliberately unclaimed, ${check.counts.unmapped} unmapped.`
  );
  lines.push('');
  lines.push(
    '> Coverage is not the goal. This table exists to make drift visible, not to chase 100%.'
  );
  lines.push('');

  const byGroup = new Map();
  for (const n of names) {
    const g = eps[n].capability_group;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(n);
  }
  const order = [...GROUP_ORDER.filter((g) => byGroup.has(g)), ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)).sort()];

  for (const g of order) {
    const def = owners.defaults_by_capability_group?.[g];
    lines.push(`## ${g}${def ? `  — default owner: ${def.join(', ')}` : ''}`);
    lines.push('');
    lines.push('| Endpoint | Credits | Owning skills | Notes |');
    lines.push('|---|---|---|---|');
    for (const n of byGroup.get(g)) {
      const e = eps[n];
      const claimedBy = owners.endpoints?.[n];
      const reason = owners.unclaimed?.[n];
      const ownersCell = Array.isArray(claimedBy)
        ? claimedBy.map((s) => `\`/${s}\``).join(', ')
        : reason
          ? '_unclaimed_'
          : '**UNMAPPED**';
      const notes = [];
      if (reason) notes.push(reason);
      if (e.pricing.disabled_by_default) notes.push('**disabled by default**');
      if (e.pricing.bounded === false) {
        notes.push(
          e.max_batch ? `unbounded per-result - input capped at ${e.max_batch}` : 'unbounded - page-gated'
        );
      }
      // NOT a per-row note any more. Since the flag became evidence-derived it is
      // false for all 68 rows, so a per-row "actuals unverifiable" was 68 copies of
      // one sentence — noise that reads as a per-endpoint distinction that does not
      // exist. It is stated once, above the tables, and a row only gets the note back
      // if some endpoint ever DOES report its charge.
      if (e.pricing.billing_field_present_in_response === true) notes.push('charge reported in response');
      if (e.bulk_variant) notes.push(`bulk: \`${e.bulk_variant}\` (max ${e.max_batch})`);
      if (e.required_request_fields.length === 0) notes.push('no required fields in spec');
      if (e.deprecated) notes.push('DEPRECATED');
      lines.push(`| \`${n}\` | ${priceLabel(e.pricing)} | ${ownersCell} | ${notes.join('; ')} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}
