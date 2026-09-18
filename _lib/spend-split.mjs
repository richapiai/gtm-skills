// _lib/spend-split.mjs — which skills can spend a credit, derived.
//
// _lib/spend-split.mjs — extracted from tests/contracts/no-stale-catalog-claims.test.mjs so the README guard
// and the llms.txt generator read ONE implementation of the predicate. docs/claims.yaml
// says why that matters: a second, divergent implementation of "is this skill free" is
// worse than none, because the two would disagree silently about money.
//
// The README's `free` markers are a promise about money, so they are derived from
// the two places that actually decide it and compared, never hand-counted:
//
//   a. `_lib/endpoint-owners.yaml` maps the skill to an endpoint that costs credits.
//   b. The skill's own SKILL.md reaches one — as `endpoint_name(...)`, which is the
//      form scripts/validate-skills.mjs lints, or as `richapi call|search <endpoint>`.
//
// Neither source alone is right: /enrich-waterfall drives `richapi enrich` and names
// no endpoint call, /local-business-prospecting calls four maps endpoints it does not
// own, and /pre-meeting-briefing spends only through `richapi call`. The union is the
// conservative answer, and conservative here means "assume it can spend".

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
const CATALOG = JSON.parse(readFileSync(join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));

/** Does this endpoint cost credits? Zero-credit endpoints (search_reference_data) do not. */
export function costsCredits (name) {
  const p = CATALOG.endpoints?.[name]?.pricing;
  if (!p) return false;
  return (p.credits_per_call ?? 0) > 0 || (p.credits_base ?? 0) > 0 || (p.credits_per_result ?? 0) > 0;
}

export function skillNames () {
  return readdirSync(SKILLS).filter((f) => statSync(join(SKILLS, f)).isDirectory()).sort();
}

/** @returns {{spends:string[], free:string[]}} */
export function spendSplit () {
  const owners = YAML.parse(readFileSync(join(ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
  const names = skillNames();
  const spends = new Set();

  for (const [endpoint, list] of Object.entries(owners.endpoints ?? {})) {
    if (!costsCredits(endpoint)) continue;
    for (const owner of [].concat(list ?? [])) spends.add(owner);
  }
  for (const name of names) {
    const body = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    for (const m of body.matchAll(/([a-z_][a-z0-9_]{3,})\(/g)) {
      if (costsCredits(m[1])) spends.add(name);
    }
    for (const m of body.matchAll(/richapi\s+(?:call|search)\s+([a-z_][a-z0-9_]{3,})/g)) {
      if (costsCredits(m[1])) spends.add(name);
    }
  }

  return {
    spends: names.filter((n) => spends.has(n)),
    free: names.filter((n) => !spends.has(n))
  };
}
