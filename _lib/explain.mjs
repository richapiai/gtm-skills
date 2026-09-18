// _lib/explain.mjs — `richapi enrich <list> --explain-my-list`.
//
// The free, zero-call answer to the question a GTM operator actually asks first:
// **how much of this list is worth paying for?**
//
// The dry run already computes it — `hops not attempted` is exactly this information —
// but it arrives at the bottom of a priced plan, after the number that makes people
// stop reading. A list whose rows carry no LinkedIn URL and no company domain cannot be
// enriched by any vendor on earth, and finding that out before you look at a total is
// worth more than finding it out after.
//
// ZERO API calls. No key needed. Reads the CSV, the suppression store and the cache.
//
// THE TRUNCATION RULE (law 5, and the reason for the `analysed` block below).
//
// The use case this exists for is a 40,000-row CRM export, which is the largest input
// the pack will ever see. If a cap stops the read, "160 of 500 rows are enrichable" and
// "160 of the first 500 rows we looked at" are DIFFERENT SENTENCES, and an operator
// deciding whether to spend on the rest will act on the first. So a truncated analysis
// is never rendered as a total: `truncated` is carried on the result and the renderer
// leads with it.

import { readInputRows, toDescriptor, loadCache } from './enrich.mjs';
import { urnOf } from './client.mjs';

/** How many rows are analysed before the read is capped and SAID to be capped. */
export const DEFAULT_MAX_ROWS = 50000;

/**
 * The hops a row could buy, and why each one cannot run when it cannot.
 *
 * Derived from `toDescriptor`, which is the same function the planner uses — deliberately,
 * because a second implementation of "is this row doable?" is how the planner and the
 * executor came to disagree on 2026-08-28 and 500 of 500 units failed while the plan
 * looked perfect.
 */
export const HOPS = Object.freeze(['enrich_profile', 'email_finder', 'email_verifier', 'phone_finder']);

/**
 * The endpoint that would actually run for the `enrich_profile` hop on this row.
 *
 * THE GATE THAT TURNED PAID WORK AWAY. A list of post engagers carries a `urn` and a
 * name and nothing else — no profile URL, no domain. `--explain-my-list` asked
 * `toDescriptor` WITHOUT `batch`, so the single-call contract (`url` required) refused
 * every row and the command answered "NOTHING IN THIS LIST CAN BE ENRICHED — 0 of 5".
 * `richapi enrich --batch` then planned all five through `enrich_profiles_bulk`, which
 * takes `urns`, and found four emails. The first screen a customer sees told them to
 * throw away a list the runtime enriches fine.
 *
 * So the question the view asks is "can ANY planned hop run on this row", which
 * includes the bulk path — and it names the hop, because "enrichable" without the
 * endpoint that would do it is not actionable.
 */
export const BULK_PROFILE_HOP = 'enrich_profiles_bulk';

/**
 * Classify a list without calling anything.
 *
 * @returns {{
 *   rows_total: number, rows_analysed: number, truncated: boolean,
 *   enrichable: number, suppressed: number, cached: number, dead: number,
 *   reasons: Record<string, number>, hop_reach: Record<string, number>,
 *   columns: string[], missing_inputs: Record<string, number>
 * }}
 */
export function explainList (file, { store, cache = loadCache(), maxRows = DEFAULT_MAX_ROWS } = {}) {
  const all = readInputRows(file);
  const rowsTotal = all.length;
  const rows = all.slice(0, maxRows);
  const truncated = rowsTotal > rows.length;

  const reasons = {};
  const hopReach = Object.fromEntries([...HOPS, BULK_PROFILE_HOP].map(h => [h, 0]));
  const missingInputs = { linkedin_url: 0, company_domain: 0, email: 0, name: 0 };
  let enrichable = 0; let suppressed = 0; let cached = 0; let dead = 0;

  const columns = rows.length ? [...new Set(rows.flatMap(r => Object.keys(r)))].sort() : [];

  rows.forEach((record, i) => {
    // `batch: true` — the SAME question the planner asks. See BULK_PROFILE_HOP.
    const { descriptor, skipReasons } = toDescriptor(record, i, { store, cache, batch: true });

    if (descriptor.suppressed) { suppressed += 1; return; }

    // Which hops would actually issue a call for this row.
    const reachable = HOPS.filter(h => !skipReasons[h]);
    for (const h of reachable) hopReach[h] += 1;
    // A urn-only row reaches `enrich_profile` only through its bulk form. Name it, so
    // "enrichable" comes with the endpoint that would do the enriching.
    const viaBulk = reachable.includes('enrich_profile') && Boolean(urnOf(record));
    if (viaBulk) hopReach[BULK_PROFILE_HOP] += 1;

    // Every hop already answered from cache is a hop this list does not need to buy
    // again. A row with nothing left to buy is `cached`, not `dead` — the distinction
    // matters because one is good news and the other is a list problem.
    if (reachable.length === 0) {
      const everyHopCached = descriptor.cached.length > 0
        && HOPS.every(h => descriptor.cached.includes(h) || skipReasons[h]);
      if (everyHopCached) cached += 1; else dead += 1;
    } else {
      enrichable += 1;
    }

    // The REASONS a hop could not run, tallied. This is the actionable half: "340 rows
    // have no linkedin_url" is a thing an operator can go and fix in their CRM.
    for (const [, reason] of Object.entries(skipReasons)) {
      if (reason === 'already enriched' || reason === 'row already has an email'
        || reason === 'row already has a phone') continue;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }

    if (!record.linkedin_url) missingInputs.linkedin_url += 1;
    if (!record.company_domain && !record.domain && !record.company_website) missingInputs.company_domain += 1;
    if (!record.email) missingInputs.email += 1;
    if (!(record.first_name && record.last_name) && !record.full_name && !record.name) missingInputs.name += 1;
  });

  return {
    rows_total: rowsTotal,
    rows_analysed: rows.length,
    truncated,
    enrichable, suppressed, cached, dead,
    reasons, hop_reach: hopReach,
    columns, missing_inputs: missingInputs,
  };
}

/**
 * Render it.
 *
 * Two properties this text must have, both learned the expensive way:
 *
 *   1. A ZERO result and a PERFECT result must not look alike. "0 of 40,000 rows are
 *      enrichable" is the single most valuable sentence this command can produce, and
 *      rendering it as a quiet table row is how it gets skimmed past.
 *   2. A TRUNCATED analysis leads with the truncation, never buries it. See the header
 *      comment.
 */
export function renderExplain (r, { file = 'the list' } = {}) {
  const L = [];
  const pct = (n) => (r.rows_analysed ? `${Math.round((n / r.rows_analysed) * 100)}%` : '0%');

  L.push(`LIST QUALITY — ${file}   (no calls made, no credits spent)`);
  L.push('');

  if (r.truncated) {
    L.push(`!! PARTIAL READ. ${r.rows_total} rows in the file; the first ${r.rows_analysed} were analysed.`);
    L.push('   Every number below describes THOSE ROWS ONLY, not the whole file.');
    L.push('   Raise the cap with --max-rows, or split the file.');
    L.push('');
  }

  if (r.rows_total === 0) {
    L.push('The file has no data rows. Nothing to price and nothing to fix here —');
    L.push('check the file is the one you meant, and that it has a header row.');
    return L.join('\n');
  }

  if (r.enrichable === 0) {
    L.push(`NOTHING IN THIS LIST CAN BE ENRICHED. 0 of ${r.rows_analysed} rows can reach any hop.`);
    L.push('This is a list problem, not an API problem: no vendor can enrich a row that');
    L.push('carries no identifier. The reasons are below — fix those and re-run.');
    L.push('');
  }

  L.push(`Rows analysed        ${r.rows_analysed}`);
  L.push(`  enrichable         ${r.enrichable}  (${pct(r.enrichable)})  <- the rows worth paying for`);
  L.push(`  nothing to buy     ${r.dead}  (${pct(r.dead)})  no hop can run on these`);
  L.push(`  already cached     ${r.cached}  (${pct(r.cached)})  answered from a previous run, free`);
  L.push(`  suppressed         ${r.suppressed}  (${pct(r.suppressed)})  never contacted, never priced`);
  L.push('');

  L.push('Reach, per hop  (how many rows each hop could actually be called for)');
  for (const [hop, n] of Object.entries(r.hop_reach)) {
    const via = hop === BULK_PROFILE_HOP ? '  <- the bulk form, one call per 50 rows, from `urn`' : '';
    L.push(`  ${hop.padEnd(20)} ${String(n).padStart(6)}  (${pct(n)})${via}`);
  }
  if (r.hop_reach[BULK_PROFILE_HOP] > 0) {
    L.push(`  ${r.hop_reach[BULK_PROFILE_HOP]} row(s) carry a LinkedIn \`urn\` and no profile URL. They are`);
    L.push(`  enrichable through \`${BULK_PROFILE_HOP}\` — run \`richapi enrich <list> --batch\`.`);
  }
  L.push('');

  const missing = Object.entries(r.missing_inputs).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (missing.length) {
    L.push('Missing inputs  (the fixable half — these are columns your CRM may already have)');
    for (const [k, n] of missing) L.push(`  no ${k.padEnd(17)} ${String(n).padStart(6)}  (${pct(n)})`);
    L.push('');
  }

  const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    L.push('Why a hop was unreachable');
    for (const [reason, n] of reasons) L.push(`  ${String(n).padStart(6)}  ${reason}`);
    L.push('');
  }

  L.push(`Columns seen: ${r.columns.join(', ') || '(none)'}`);
  L.push('');
  const batchFlag = r.hop_reach[BULK_PROFILE_HOP] > 0 ? ' --batch' : '';
  L.push(r.enrichable > 0
    ? `Next: price it. \`richapi enrich <list>${batchFlag} --dry-run\` costs nothing and shows the bill.`
    : 'Next: add a linkedin_url, a LinkedIn urn or a company domain to these rows. Until'
      + '\n      then there is nothing to price.');
  return L.join('\n');
}

export default { explainList, renderExplain, HOPS, BULK_PROFILE_HOP, DEFAULT_MAX_ROWS };
