// _lib/batch.mjs — auto-batching.
//
// Why this cannot be left to prose, and why no skill ever chooses:
//
//   enrich_profile       1 credit / CALL
//   enrich_profiles_bulk 1 credit / RESULT,  max_batch 50
//
// A 500-row per-row loop and 10 bulk calls cost the SAME credits. The loop pays 50x
// the latency and 50x the 429 exposure for nothing. A cost gate will never catch it,
// because the cost is identical — which is exactly why the executor decides and the
// skill never does.
//
// Execution is HOP-MAJOR: every row completes hop N before any row starts hop N+1.
// That is what makes batching possible at all, and it preserves the result flow a
// waterfall needs (email_finder must fill in an email before email_verifier reads it).

import { runWaterfall, sha256, retryDelayMs, isRetryableStatus } from './journal.mjs';
// The one thing this executor borrows from the gate layer: the name of a stop. The
// decision itself is made by the client, which owns the session.
import { STOP } from './gates.mjs';

// Fields a bulk element identifies itself by. Compared on the trailing segment, so
// `urn:li:fsd_profile:ACo…`, `ACo…` and a numeric company id all meet on the same key.
const BULK_ID_FIELDS = ['entityUrn', 'objectUrn', 'urn', 'entity_urn', 'id', 'companyId', 'company_id', 'identifier'];
const idKey = (v) => String(v).trim().split(':').pop();

/**
 * Match bulk response elements to the requested identifiers BY IDENTITY, never by
 * position. The live bulk endpoints do not answer in request order (recorded
 * 2026-09-17: three profiles sent A,B,C came back B,C,A), so a positional match hands
 * one contact another contact's data.
 *
 * Returns an array the length of `ids`: the element that carries that identifier, or
 * null when none does. Each element is used at most once; duplicates in the request
 * each take their own copy if the response repeats it, and null otherwise.
 */
export function alignBulkRows (ids, rows) {
  if (!Array.isArray(ids)) return [];
  if (!Array.isArray(rows)) return ids.map(() => null);
  const keysOf = rows.map((row) => {
    const keys = new Set();
    for (const f of BULK_ID_FIELDS) {
      const v = row?.[f];
      if (v === null || v === undefined || v === '' || v === 0) continue;
      keys.add(idKey(v));
    }
    return keys;
  });
  const used = new Set();
  return ids.map((id) => {
    if (id === null || id === undefined || id === '') return null;
    const want = idKey(id);
    const at = keysOf.findIndex((keys, i) => !used.has(i) && keys.has(want));
    if (at < 0) return null;
    used.add(at);
    return rows[at];
  });
}

/**
 * The journal error token for a run stopped by its OWN session budget.
 *
 * Deliberately not `http_402`. A 402 is the vendor saying "your account is empty";
 * this is the pack saying "you set 500 and the next call takes it past 500". Both
 * journal the remainder `skipped_budget` — REPLANNABLE, so a resume after a raise
 * picks it all up — but a receipt that cannot tell them apart sends the user to top
 * up an account that has plenty in it.
 */
export const BUDGET_STOP = 'budget_stop';

/** Own-property lookup. See the note in `bulkVariantFor`. */
function own (obj, key) {
  return obj != null && (typeof key === 'string' || typeof key === 'number')
    && Object.prototype.hasOwnProperty.call(obj, key);
}

/** The bulk form of an endpoint, or null. Read from the catalog, never hard-coded. */
export function bulkVariantFor (catalog, endpoint) {
  // OWN properties only. A bare `endpoints['__proto__']` answers with
  // Object.prototype and `endpoints['constructor']` with the Object function, so
  // both used to pass this membership check on their way to a request nobody
  // asked for. Same fix as `_lib/gates.mjs` already applies everywhere.
  const eps = catalog?.endpoints;
  const def = own(eps, endpoint) ? eps[endpoint] : null;
  if (!def?.bulk_variant) return null;
  const bulkDef = own(eps, def.bulk_variant) ? eps[def.bulk_variant] : null;
  if (!bulkDef) return null; // declared but absent: fail safe to single calls
  const maxBatch = Number(def.max_batch ?? bulkDef.max_batch ?? 0);
  if (!Number.isFinite(maxBatch) || maxBatch < 2) return null;
  return { endpoint: def.bulk_variant, maxBatch, def: bulkDef };
}

export function chunk (arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Units grouped by hop, in hop order. */
export function byHop (units) {
  const hops = new Map();
  for (const u of units) {
    if (!hops.has(u.hop)) hops.set(u.hop, []);
    hops.get(u.hop).push(u);
  }
  return [...hops.entries()].sort((a, b) => a[0] - b[0]);
}

const EMPTY = () => ({
  aborted: false, abort_reason: null, balance: null,
  ok: 0, failed: 0, skipped_cache: 0, skipped_suppressed: 0, skipped_budget: 0,
  attempted: 0, calls_made: 0, retries: 0, waited_ms: 0,
  batched_calls: 0, batched_rows: 0, unaligned_batches: 0,
});

function merge (into, from) {
  for (const k of Object.keys(into)) {
    if (typeof into[k] === 'number' && typeof from?.[k] === 'number') into[k] += from[k];
  }
  if (from?.aborted) { into.aborted = true; into.abort_reason = from.abort_reason; into.balance = from.balance; }
  // Only ever SET, never defaulted, so a run that did not abort keeps the shape it had.
  if (from?.abort_note) into.abort_note = from.abort_note;
  return into;
}

/** The journal token for whatever stopped this run: the vendor's 402, or our own cap. */
function abortToken (result) {
  return result?.abort_reason === 'session_budget' ? BUDGET_STOP : 'http_402';
}

/**
 * Ask the client whether the session budget can afford the next call.
 *
 * Optional by design: a client that does not implement `checkBudget` — every test
 * double that hand-rolls `call()` — runs exactly as it did before. The check itself
 * lives in the client because that is where the session, the catalog entry and the
 * observed cost of the last call all are; this file only decides what to do about it.
 */
function budgetStop (client, probe) {
  if (typeof client?.checkBudget !== 'function') return null;
  const d = client.checkBudget(probe);
  return d && d.decision === STOP ? d : null;
}

/**
 * Run one hop's units through the bulk endpoint.
 *
 * Journalling stays PER ROW — one before line and one after line each — so resume,
 * per-row cost attribution and /learn all keep working exactly as they do for single
 * calls. Only the HTTP call is shared.
 */
export async function runBatchedHop ({
  journal, units, client, bulk, maxAttempts = 3, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
  const result = EMPTY();
  const callable = [];

  for (const unit of units) {
    if (unit.skip === 'cache' || unit.skip === 'suppressed') {
      const status = unit.skip === 'cache' ? 'skipped_cache' : 'skipped_suppressed';
      journal.appendResult(unit, { status, credits_actual: 0, attempt: 0 });
      result[status] += 1;
    } else callable.push(unit);
  }

  for (const group of chunk(callable, bulk.maxBatch)) {
    // THE CAP. Checked before the call, not after: `recordSpend` was write-only
    // for the life of a run, so nothing ever read cumulative spend back to make a
    // decision and the session budget was a plan-time estimate check and nothing more.
    if (!result.aborted) {
      const stop = budgetStop(client, { endpoint: bulk.endpoint, units: group });
      if (stop) {
        result.aborted = true;
        result.abort_reason = 'session_budget';
        result.abort_note = stop.reason;
      }
    }
    if (result.aborted) {
      for (const u of group) {
        journal.appendResult(u, { status: 'skipped_budget', credits_actual: 0, error: abortToken(result), attempt: 0 });
        result.skipped_budget += 1;
      }
      continue;
    }

    let attempt = 1;
    let settled = false;
    result.attempted += group.length;
    while (!settled) {
      for (const u of group) journal.appendPending(u, { attempt }); // BEFORE, per row
      let res;
      try {
        res = await client.callBulk({ endpoint: bulk.endpoint, units: group, attempt });
        result.calls_made += 1;
        result.batched_calls += 1;
        result.batched_rows += group.length;
      } catch (err) {
        result.calls_made += 1;
        const status = err?.status ?? null;

        if (isRetryableStatus(status) && attempt < maxAttempts) {
          for (const u of group) {
            journal.appendResult(u, { status: 'failed', error: `http_${status}`, credits_actual: 0, attempt });
          }
          result.retries += 1;
          // Clamped when the server named a delay, real exponential backoff when it
          // did not. Never `sleep(0)`, never `sleep(86400s)`. The policy and
          // its reasoning live in `retryDelayMs` in _lib/journal.mjs, shared so the
          // batched and single paths cannot drift apart.
          const wait = retryDelayMs(err.retryAfter, attempt);
          result.waited_ms += wait;
          await sleep(wait);
          attempt += 1;
          continue;
        }

        const code = status ? `http_${status}` : (typeof err?.code === 'string' ? err.code : 'error');
        for (const u of group) {
          journal.appendResult(u, { status: 'failed', error: code, credits_actual: 0, attempt });
          result.failed += 1;
        }
        settled = true;

        if (status === 402) {
          result.aborted = true;
          result.abort_reason = 'insufficient_credits';
          result.balance = err?.body?.balance != null ? Number(err.body.balance) : null;
        }
        break;
      }

      // `res.results` is already matched to the request by identity (alignBulkRows):
      // one entry per unit, null where the response carried nothing for that row. A
      // missing or mis-sized answer cannot be attributed at all, and guessing would give
      // one contact another's data, so those rows are journalled failed with a named
      // code; the charge is still real and still recorded, because we did pay for it.
      const rows = Array.isArray(res?.results) ? res.results : null;
      const miscounted = Number.isInteger(res?.returned) && res.returned !== group.length;
      if (miscounted) result.unaligned_batches += 1;
      if (!rows || rows.length !== group.length) {
        result.unaligned_batches += 1;
        for (const u of group) {
          journal.appendResult(u, { status: 'failed', error: 'bulk_unaligned', credits_actual: 0, attempt });
          result.failed += 1;
        }
        settled = true;
        break;
      }

      const perRow = res.credits_per_row ?? null;
      group.forEach((u, i) => {
        const row = rows[i] ?? null;
        if (!row) {
          journal.appendResult(u, {
            status: 'failed', error: miscounted ? 'bulk_unaligned' : 'bulk_unmatched', credits_actual: 0, attempt,
          });
          result.failed += 1;
          return;
        }
        journal.appendResult(u, {
          status: 'ok',
          credits_actual: perRow,
          response_hash: sha256(row),
          provider: row?.provider ?? null,
          confidence: row?.confidence ?? null,
          attempt,
        });
        result.ok += 1;
      });
      settled = true;
    }
  }
  return result;
}

/**
 * One SINGLE-CALL hop, unit by unit, with the session budget checked before each call.
 *
 * WHY THIS EXISTS RATHER THAN A CHANGE TO `runWaterfall`. `runWaterfall` (_lib/journal.mjs) is
 * the journalling executor and it aborts on one thing: the vendor's 402. The cap this
 * pack needed is a different authority — the budget the USER set — and it belongs to
 * whoever owns the session, not to the journal. So the loop is lifted here, `_lib/
 * journal.mjs` is untouched, and each unit still goes through the very same
 * `runWaterfall` for its BEFORE line, its 429 retries and its AFTER line.
 *
 * Only used when the client offers `checkBudget`. Everything else takes the original
 * whole-hop path, byte for byte.
 *
 * On a stop, THIS unit and every unit after it in the hop are journalled
 * `skipped_budget` — the same terminal state a 402 produces, and REPLANNABLE, so
 * `richapi ... --resume` after `--budget <higher>` buys exactly the remainder.
 *
 * It does NOT prompt. `_lib/run.mjs` explains at length why gating is plan-time: at
 * ~8 credits a contact a 100-row list would ask dozens of times and gate fatigue kills
 * the only control there is. This is a cap. It stops; it does not ask.
 */
async function runCappedHop ({ journal, units, client, maxAttempts, sleep }) {
  const result = EMPTY();

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];

    if (!unit.skip) {
      const stop = budgetStop(client, { endpoint: unit.endpoint, row_id: unit.row_id, hop: unit.hop });
      if (stop) {
        result.aborted = true;
        result.abort_reason = 'session_budget';
        const remaining = units.slice(i);
        result.abort_note = `${stop.reason} ${remaining.length} unit(s) journalled skipped_budget: `
          + 'raise the budget and resume to buy exactly those.';
        for (const u of remaining) {
          journal.appendResult(u, { status: 'skipped_budget', credits_actual: 0, error: BUDGET_STOP, attempt: 0 });
          result.skipped_budget += 1;
        }
        break;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    const one = await runWaterfall({ journal, units: [unit], client, maxAttempts, ...(sleep ? { sleep } : {}) });
    merge(result, one);

    if (one.aborted) {
      // A 402 mid-hop. `runWaterfall` journals the remainder of the units IT was given,
      // and it was given one — so the rest of the hop is journalled here instead, which
      // is what the whole-hop path would have done.
      for (const u of units.slice(i + 1)) {
        journal.appendResult(u, { status: 'skipped_budget', credits_actual: 0, error: 'http_402', attempt: 0 });
        result.skipped_budget += 1;
      }
      break;
    }
  }
  return result;
}

/**
 * Hop-major execution. Batches the hops the catalog says can be batched and hands the
 * rest to journal.mjs's single-call executor unchanged.
 *
 * When a hop aborts on 402 — or on the session budget — every unit of every LATER hop
 * is journalled `skipped_budget` too; otherwise a resume would not know they were ever
 * planned.
 */
export async function runHopMajor ({
  journal, units, client, catalog, maxAttempts = 3, sleep = undefined,
}) {
  const total = EMPTY();
  const hops = byHop(units);

  for (let i = 0; i < hops.length; i += 1) {
    const [, hopUnits] = hops[i];
    if (total.aborted) {
      for (const u of hopUnits) {
        if (u.skip) continue;
        journal.appendResult(u, { status: 'skipped_budget', credits_actual: 0, error: abortToken(total), attempt: 0 });
        total.skipped_budget += 1;
      }
      continue;
    }

    const endpoint = hopUnits[0]?.endpoint;
    const callableCount = hopUnits.filter(u => !u.skip).length;

    // The catalog says whether a bulk form EXISTS; the client says whether these
    // particular rows can feed it. Both must agree, because the bulk endpoints take a
    // different identifier (`urns`) than their single counterparts (`url`).
    let bulk = null;
    if (client.callBulk && callableCount > 1) {
      const eligible = client.bulkEligible
        ? client.bulkEligible({ endpoint, units: hopUnits })
        : { ok: true, bulk: bulkVariantFor(catalog, endpoint) };
      if (eligible.ok) bulk = eligible.bulk ?? bulkVariantFor(catalog, endpoint);
    }

    const capped = typeof client.checkBudget === 'function';
    const res = (bulk && callableCount > 1)
      ? await runBatchedHop({ journal, units: hopUnits, client, bulk, maxAttempts, ...(sleep ? { sleep } : {}) })
      : capped
        ? await runCappedHop({ journal, units: hopUnits, client, maxAttempts, sleep })
        : await runWaterfall({ journal, units: hopUnits, client, maxAttempts, ...(sleep ? { sleep } : {}) });

    merge(total, res);
  }
  return total;
}
