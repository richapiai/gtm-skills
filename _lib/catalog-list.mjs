// _lib/catalog-list.mjs — `richapi catalog list`: what can I call, and what does it cost?
//
// WHY THIS EXISTS
//
// Until now a user had no way to SEE the endpoint surface. `doctor` said "Catalog
// loaded — 68 endpoints" and stopped there; `catalog gen` and `catalog diff` are
// maintainer verbs. So "what can this thing actually do, and what does each call cost"
// had no answer short of reading a 156KB spec.
//
// TWO SOURCES, AND THE DIFFERENCE MATTERS.
//
//   local (default)  `_lib/api-catalog.json`, generated from the pinned spec. Offline,
//                    free, no key, and it is the SAME table the runtime prices a plan
//                    from. What you see here is what a dry run will quote you.
//
//   --live           `GET /api/v1/catalog` on the API itself. This is the account's own
//                    view: an endpoint your team is not entitled to is the one that
//                    answers 403 at run time, and the pinned catalog cannot know that.
//                    It is a free, unauthenticated GET; it spends no credits.
//
// Neither is "more correct". The local table is what you will be BILLED against,
// because that is what the plan is priced from. The live table is what the server will
// actually LET you call. When they disagree, that disagreement is the finding, which is
// why `--live` diffs them rather than quietly replacing one with the other.

import { readFileSync } from 'node:fs';
import { CATALOG_PATH } from './paths.mjs';

/** Credits for one call, as a display string. Never invents a number. */
export function priceLabel (pricing) {
  if (!pricing) return 'unknown';
  const per = pricing.credits_per_call ?? null;
  const each = pricing.credits_per_result ?? null;
  const base = pricing.credits_base ?? null;
  if (per !== null && per !== undefined) return per === 0 ? 'free' : `${per}/call`;
  if (each !== null && each !== undefined) {
    return base ? `${base} + ${each}/result` : `${each}/result`;
  }
  return 'unknown';
}

export function loadLocal (path = CATALOG_PATH) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  return Object.entries(c.endpoints).map(([name, e]) => ({
    name,
    group: e.capability_group ?? 'other',
    price: priceLabel(e.pricing),
    bounded: e.pricing?.bounded !== false,
    status: e.field_map_status ?? 'unknown',
  })).sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name));
}

/**
 * The account's own view. Returns `{ names, error }` — a failure here is reported, not
 * thrown: this command must still work offline, and "could not reach the API" is a
 * legitimate answer rather than a crash.
 */
export async function fetchLive (origin = 'https://api.richapi.ai', timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/api/v1/catalog`, { signal: ac.signal });
    if (!res.ok) return { names: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    const tools = body.tools ?? [];
    return { names: new Set(tools.map((t) => t.name)), error: null };
  } catch (e) {
    return { names: null, error: e.name === 'AbortError' ? 'timed out' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export function render (rows, { live = null, liveError = null, color = false, style } = {}) {
  const c = style ? style(color) : { dim: (s) => s, bold: (s) => s, green: (s) => s, yellow: (s) => s, gray: (s) => s };
  const out = [];
  const width = Math.max(...rows.map((r) => r.name.length));

  out.push(`${c.bold(`${rows.length} endpoints`)} ${c.dim('— priced from the local catalog, the same table a dry run quotes')}`);
  out.push('');

  let group = null;
  for (const r of rows) {
    if (r.group !== group) { group = r.group; out.push(c.dim(`  ${group}`)); }
    const flags = [];
    if (!r.bounded) flags.push(c.yellow('unbounded'));
    if (r.status === 'keys_from_spec_example') flags.push(c.gray('shape unverified'));
    if (live && !live.has(r.name)) flags.push(c.yellow('not in your account'));
    out.push(`    ${r.name.padEnd(width)}  ${c.green(r.price.padStart(14))}${flags.length ? `  ${flags.join(' ')}` : ''}`);
  }

  out.push('');
  if (liveError) {
    out.push(c.dim(`  live account view unavailable (${liveError}) — the local table above still stands`));
  } else if (live) {
    const missing = rows.filter((r) => !live.has(r.name)).length;
    out.push(c.dim(missing === 0
      ? '  Every endpoint above is present in your account view.'
      : `  ${missing} endpoint(s) are in the pinned catalog but not in your account view.`));
  } else {
    out.push(c.dim('  Add --live to compare against what your own account can call.'));
  }
  out.push(c.dim('  No credits were spent. Prices are per call before any page multiplier.'));
  return out.join('\n');
}
