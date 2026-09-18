// _lib/enrich.mjs — the enrichment waterfall, end to end.
//
// One command that composes the independent modules below. Nothing here re-implements them.
//
//   plan      dryrun.buildPlan          cost from the generated catalog, never typed
//   gates     gates.checkCall           session budget, always-ask, disabled, page-gate
//   suppress  suppression.filterOutput  fail-closed, before any call
//   journal   journal.RunJournal        before AND after each call; the resume key
//   execute   journal.runWaterfall      429 Retry-After, 402 abort
//   ledger    ledger.Ledger             never fabricates an actual
//   output    suppression.writeOutput   the only writer; refuses without a store
//
// The read-through cache (`_lib/cache.mjs`) plugs in through `descriptor.cached`,
// which buildPlan honours, so a cache hit is visible in the plan before any call.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { RunJournal, readJournal, planResume, runWaterfall, acquireListLock, HttpError, failureSummary, summarize } from './journal.mjs';
import { buildPlan, writeDryRun, renderPlanText, reconcile } from './dryrun.mjs';
import { Ledger, estimate as estimateCost, billingVerdict } from './ledger.mjs';
import { buildReceipt, assertNeverOverstates, assertMappingSurfaced } from './receipt.mjs';
import { loadGates, createSession, setBudget, checkCall, checkSessionSpend, recordSpend, isUnbounded, STOP, CONFIRM } from './gates.mjs';
import { loadSuppressionStore, isSuppressed, rowIdentifiers, writeOutputList } from './suppression.mjs';
import { RichApiClient, buildRequest, readAttribution, mapResponse, inspectResponse, urnOf, MissingApiKey, noteRemediation } from './client.mjs';
import { createCache, nullCache } from './cache.mjs';
import { appendPiiRow, readPiiJsonl } from './pii.mjs';
import { parseCsv as parseCsvShared } from './csv.mjs';
import { CATALOG_PATH } from './paths.mjs';
import { runHopMajor, bulkVariantFor, alignBulkRows } from './batch.mjs';
import { createMappingAudit, nullMappingAudit } from './mapping-audit.mjs';
import { createActivationRecorder } from './activation.mjs';
import { NULL_ENUM } from './dual-contract.mjs';

export class EnrichError extends Error {
  constructor (msg) { super(msg); this.name = 'EnrichError'; }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// CSV parsing lives in _lib/csv.mjs so erase and the reader cannot disagree about
// what a row is. They did, and erase corrupted files as a result.
export { parseCsv } from './csv.mjs';

/**
 * Header spellings every CRM export uses, mapped to the name the runtime reads.
 *
 * Deliberately small. `RECORD_MAPPINGS` in `_lib/client.mjs` already aliases
 * `website`/`company_website`/`domain` onto the wire fields; it simply never fired,
 * because a HubSpot export spells the column `Website URL` and nothing upstream
 * turned that into `website_url`. So the job here is spelling, not semantics, and
 * only the handful of cases `canonicalKey` alone cannot reach are listed.
 */
const HEADER_ALIASES = Object.freeze({
  website_url: 'website', company_website_url: 'website', web_site: 'website',
  person_linkedin_url: 'linkedin_url', linkedin: 'linkedin_url',
  linkedin_profile: 'linkedin_url', linkedin_profile_url: 'linkedin_url',
  li_profile_url: 'linkedin_url', profile_url: 'linkedin_url',
  email_address: 'email', work_email: 'email', business_email: 'email',
  firstname: 'first_name', given_name: 'first_name',
  lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
  account_name: 'company_name', organization: 'company_name',
  organisation: 'company_name', company: 'company_name',
});

/** `First Name` -> `first_name`, `Website URL` -> `website_url`, `E-Mail` -> `e_mail`. */
function canonicalKey (h) {
  return String(h).trim().toLowerCase()
    .replace(/[\s\-./]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Add canonical aliases for a row's columns, keeping the originals.
 *
 * Every mainstream CRM exports Title Case with spaces — `First Name`, `Company
 * Name`, `LinkedIn URL`. The planner reads exact lowercase snake_case. So the most
 * common input in the entire GTM world planned as ZERO calls and reported every row
 * as "no linkedin_url to enrich from": a header-parsing failure, worded as an
 * accusation about the user's data. Silent, free, and wrong in the direction that
 * looks like the user's fault.
 *
 * Originals are preserved rather than replaced, so an export written back out keeps
 * the columns it arrived with, and anything reading a raw header still sees it.
 * An alias NEVER overwrites a key the row already has: if a file somehow carries
 * both `Email` and `email`, the one already in canonical form wins and the other is
 * left alone rather than silently deciding which address is real.
 */
function withCanonicalKeys (row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const [k, v] of Object.entries(row)) {
    const canon = canonicalKey(k);
    if (canon && canon !== k && !(canon in out)) out[canon] = v;
    const alias = HEADER_ALIASES[canon];
    if (alias && !(alias in out)) out[alias] = v;
  }
  return out;
}

export function readInputRows (file) {
  if (!fs.existsSync(file)) throw new EnrichError(`input list not found: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.csv')) return parseCsvShared(text).map(withCanonicalKeys);
  return text.split('\n').filter(l => l.trim()).map((l, i) => {
    let parsed;
    try { parsed = JSON.parse(l); } catch { throw new EnrichError(`${file}:${i + 1} is not valid JSON`); }
    return withCanonicalKeys(parsed);
  });
}

const sha = s => createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * The pack's own EXPLICIT EMPTY MARKERS — `_lib/dual-contract.mjs:NULL_ENUM`.
 *
 * The skills write `not_found` into a column to say "we looked and there is nothing
 * here". Every presence test in the runtime read it as a VALUE, because it is a
 * non-empty string. Measured on the 2026-09-17 runs: a row whose `email` column read
 * `not_found` was planned as "row already has an email" (so email_finder was skipped)
 * and then handed to `email_verifier` as the address to verify — a paid call on the
 * literal string "not_found", for every such row.
 *
 * So the marker is ABSENCE everywhere a value is tested for presence. It is the pack's
 * own vocabulary, not the user's data: a column that genuinely contains the text
 * "not_found" is not a thing any real CRM export carries.
 */
const EMPTY_MARKERS = new Set(NULL_ENUM);

/** Non-empty scalar, with the pack's explicit empty markers counted as absent. */
export function present (v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  const s = String(v).trim();
  return s !== '' && !EMPTY_MARKERS.has(s.toLowerCase());
}

export const NOT_A_FAILURE = Object.freeze(['input_insufficient', 'search_exhausted']);

/**
 * Units the journal marked `failed` with a code that means "this never reached the
 * wire", counted by code.
 *
 * `input_insufficient` is the email_verifier hop with no email to verify, and the live
 * runs reported it as `FAILED 1: input_insufficient` — which reads as an API error the
 * user should chase, next to a receipt that (correctly) charged nothing for it. It is a
 * SKIP: nothing was attempted, nothing was billed, and a retry would do the same thing.
 */
export function skippedSummary (lines) {
  const out = {};
  for (const u of summarize(lines).values()) {
    if (u.status !== 'failed') continue;
    const code = u.error ?? 'error';
    if (!NOT_A_FAILURE.includes(code)) continue;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

/**
 * A copy of `record` with every explicit empty marker removed.
 *
 * Applied to what goes ON THE WIRE, because `client.buildRequest` has its own
 * (unexported) `present` that does not know the marker vocabulary — so without this a
 * `not_found` would satisfy a request contract and be billed. Dropping the key makes
 * the contract fail closed with `input_insufficient`, which is the truth.
 */
export function withoutEmptyMarkers (record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && EMPTY_MARKERS.has(v.trim().toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Own-property lookup on a plain object used as a MAP, and the catalog entry it guards.
 *
 * The same prototype-key hardening `_lib/gates.mjs`, `_lib/batch.mjs` and `_lib/run.mjs` already
 * carry: `catalog.endpoints['__proto__']` answers with Object.prototype and
 * `['constructor']` with the Object function, so a bare lookup returns a truthy
 * "endpoint" with no `pricing` — which prices at zero and gates against nothing. The
 * waterfall's endpoint names come from a fixed list here rather than from a caller, so
 * this is defence in depth, not a live hole; it is applied anyway so that the next hop
 * added from a config file does not have to remember.
 */
function own (obj, key) {
  return obj != null && (typeof key === 'string' || typeof key === 'number')
    && Object.prototype.hasOwnProperty.call(obj, key);
}

function catalogEntry (catalog, endpoint) {
  const eps = catalog?.endpoints;
  return own(eps, endpoint) ? eps[endpoint] : null;
}

/**
 * A stable, NON-PII row id. Deliberately not the email.
 *
 * A caller-supplied `row_id` is often the email in practice, which quietly puts a
 * contact into the run journal and into anything derived from it. Hashing the
 * identity keeps the journal free of contact values by construction and still
 * survives a re-ordered input file, so resume keeps working.
 */
export function rowIdFor (record, index) {
  const identity = record.row_id
    ?? record.linkedin_url
    ?? record.email
    ?? [record.first_name, record.last_name, record.company_domain, record.domain, record.company_name]
      .filter(Boolean).join('|');
  const basis = String(identity || `index:${index}`).trim().toLowerCase();
  return `r${String(index).padStart(5, '0')}-${sha(basis).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// The waterfall
// ---------------------------------------------------------------------------

/**
 * Cheapest capable hop order. `only_if_missing` keys are also used to mark a hop
 * inapplicable when the row cannot satisfy that endpoint's request contract — the
 * per-row reason is carried separately in `skipReasons` so the report stays honest.
 *
 * `conditional: true` means the hop depends on an earlier hop's output, so the plan
 * total is a CEILING, and buildPlan says so.
 */
export function buildWaterfall ({ phone = false, verify = true } = {}) {
  const hops = [
    { endpoint: 'enrich_profile', only_if_missing: 'profile' },
    { endpoint: 'email_finder', only_if_missing: 'email', conditional: true },
  ];
  if (phone) hops.push({ endpoint: 'phone_finder', only_if_missing: 'phone', conditional: true });
  if (verify) hops.push({ endpoint: 'email_verifier', only_if_missing: 'email_verified', conditional: true });
  return hops;
}

/** `--no-cache` yields a cache that always misses. */
export function loadCache (opts = {}) {
  return opts.enabled === false ? nullCache('--no-cache') : createCache(opts);
}

/**
 * Row record -> plan descriptor. buildPlan rejects any key that is not in its
 * allow-list, so contact values cannot reach the planner at all.
 */
export function toDescriptor (record, index, { store, cache = loadCache(), batch = false }) {
  const row_id = rowIdFor(record, index);
  const has = [];
  const skipReasons = {};

  // `record` still carries the markers (they are the user's columns and are written
  // back out); only the PRESENCE tests below treat them as absent. See `present`.
  record = { ...record };
  const hasProfile = present(record.title) && present(record.company_name);
  const hasEmail = present(record.email);
  const hasPhone = present(record.phone);
  const clean = withoutEmptyMarkers(record);

  if (hasProfile) { has.push('profile'); skipReasons.enrich_profile = 'already enriched'; }
  // With --batch, a URN is all enrich_profiles_bulk needs. Requiring a linkedin_url as
  // well made a urn-only list plan zero profile calls and never reach the bulk path.
  else if (!buildRequest('enrich_profile', clean).ok && !(batch && urnOf(clean))) {
    has.push('profile'); skipReasons.enrich_profile = 'no linkedin_url to enrich from';
  }

  // A urn-only row that the bulk profile hop will enrich gets the finder's inputs
  // (linkedin_url, name, company_domain) from that hop, so the later hops stay planned
  // — as conditional hops, which is what they already are.
  const profileFeeds = batch && Boolean(urnOf(clean)) && !has.includes('profile');
  if (hasEmail) { has.push('email'); skipReasons.email_finder = 'row already has an email'; }
  else if (!buildRequest('email_finder', clean).ok && !profileFeeds) {
    has.push('email'); skipReasons.email_finder = 'insufficient input (need linkedin_url, or name + company)';
  }

  if (hasPhone) { has.push('phone'); skipReasons.phone_finder = 'row already has a phone'; }
  else if (!buildRequest('phone_finder', clean).ok && !profileFeeds) {
    has.push('phone'); skipReasons.phone_finder = 'insufficient input (need linkedin_url, or name + domain)';
  }

  // email_verifier can only run if an email exists or one is expected from email_finder.
  if (!hasEmail && has.includes('email') && skipReasons.email_finder !== 'row already has an email') {
    has.push('email_verified'); skipReasons.email_verifier = 'no email, and none can be found';
  }

  const ids = rowIdentifiers(record);
  const suppressed = ids.some(id => isSuppressed(store, id));

  // A cache hit is decided at PLAN time, so the plan can show it as
  // skipped-not-charged and the executor never issues the call at all.
  //
  // THE KEY MUST BE BUILT THE WAY THE EXECUTOR BUILT IT, hop by hop.
  //
  // The cache key IS the request payload (cache.mjs), and the executor derives every
  // hop's payload from `merged(row_id)` — the input row PLUS every earlier hop's
  // mapped output — then writes the response under that key BEFORE folding this hop's
  // own output in (`createExecClient.call`). So `email_finder`'s stored key carries
  // `first_name`, `last_name`, `company_name` and the rest of hop 1's answer.
  //
  // Looking all four hops up against the RAW record therefore missed every hop after
  // the first, forever: a different key, so a permanent miss, so a repeat run re-paid
  // 7 of every 8 credits (enrich_profile 1cr hit; email_finder 5cr and email_verifier
  // 2cr re-bought) while the cache reported itself healthy. `/cost-optimizer` saw the
  // writes with no hits and blamed the TTL.
  //
  // Folding each hit forward reproduces the write key byte for byte. It is read-side
  // only: nothing here changes what is called, written or charged.
  const cachedHops = [];
  const cachedData = {};
  let lookup = clean;
  for (const ep of ['enrich_profile', 'email_finder', 'phone_finder', 'email_verifier']) {
    if (!cache.has(ep, lookup)) continue;   // a miss stops the fold: an uncached hop's
    cachedHops.push(ep);                    // output cannot be predicted, so no later
    const mapped = mapResponse(ep, cache.get(ep, lookup) ?? {});  // key can be either.
    Object.assign(cachedData, mapped);
    lookup = { ...lookup, ...mapped };
  }

  return { descriptor: { row_id, has, suppressed, cached: cachedHops }, skipReasons, record, cachedData };
}

/**
 * Per-row hop output, persisted.
 *
 * The journal deliberately cannot hold this — it carries row ids and response hashes,
 * never contact values. But without a second artifact a resume is silently WRONG:
 * `results` lived only in memory, so resuming a killed 500-row run wrote the output
 * file without the emails the first run already paid for. Thousands of credits spent,
 * zero enriched rows delivered.
 *
 * It is PII, so it lives under gtm/, is stamped with its source endpoint and fetch
 * time, and is swept and erased by the same machinery as everything else there.
 */
export function resultsPath (dir, runId) {
  return path.join(dir, 'runs', `${runId}.results.jsonl`);
}

export function appendResult (dir, runId, rowId, endpoint, fields) {
  if (!fields || Object.keys(fields).length === 0) return null;
  return appendPiiRow(resultsPath(dir, runId), { row_id: rowId, fields }, { endpoint, key: rowId });
}

/** Rebuild the in-memory results map from disk. Later rows win, matching hop order. */
export function loadResults (dir, runId) {
  const out = new Map();
  const file = resultsPath(dir, runId);
  if (!fs.existsSync(file)) return out;
  let rows = [];
  // Non-strict: a damaged line loses one hop's output, which the resume can re-buy.
  // Throwing here would wedge the resume entirely, which is the worse failure.
  try { ({ rows } = readPiiJsonl(file, { strict: false })); } catch { return out; }
  for (const r of rows) {
    if (!r.row_id || !r.fields) continue;
    out.set(r.row_id, { ...(out.get(r.row_id) ?? {}), ...r.fields });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Execution client — adapts RichApiClient to runWaterfall's call contract
// ---------------------------------------------------------------------------

/**
 * runWaterfall calls `client.call({endpoint, row_id, hop, attempt})`. It never sees a
 * contact record: the record lives here, keyed by row_id, and never enters the journal.
 *
 * Every call writes a ledger line, including a failure, because "we tried and were
 * charged nothing" is itself an accounting fact.
 */
export function createExecClient ({ api, catalog, ledger, records, results, session, notes = [], cache = null, dir = null, runId = null, mappingAudit = null }) {
  // The empty-column tripwire. Every 2xx response is classified here, so a
  // response that maps to nothing is recorded as a MAPPING FAILURE rather than
  // written out as a blank column and called done.
  const audit = mappingAudit ?? nullMappingAudit();
  const persist = (rowId, endpoint, fields) => { if (dir && runId) appendResult(dir, runId, rowId, endpoint, fields); };
  // The explicit empty markers are stripped from the INPUT half only, exactly as
  // `toDescriptor` strips them before it decides what is callable — so the plan and the
  // executor agree, and the cache key is byte-identical to the one the plan looked up.
  // Without this, `email: "not_found"` satisfied the email_verifier contract and was
  // billed as an address (live, 2026-09-17).
  const merged = (row_id) => ({ ...withoutEmptyMarkers(records.get(row_id) ?? {}), ...(results.get(row_id) ?? {}) });
  // What the LAST call really cost. The forward estimate is the larger of this and the
  // catalog price, so a hop that turns out dearer than the plan cannot walk the budget
  // off a cliff under a stale forecast. See createCallClient in _lib/run.mjs for the
  // full note on why the cap exists at all.
  let lastCallCredits = 0;

  return {

    /**
     * THE RUNTIME CAP. Checked before every call; it never asks the user anything.
     *
     * `gatePlan` runs `checkCall` once, on the plan, before a credit moves. After that
     * `recordSpend` accumulated into `session.spent_credits` and NOTHING read it back:
     * the session budget was a check on an estimate and the vendor's 402 was the only
     * runtime authority. This reads it back.
     *
     * Deliberately not a prompt — gatePlan's own comment explains why: at ~8 credits a
     * contact, prompting per call fires dozens of times during the trial that decides
     * whether the user ever pays. A cap stops; it does not ask.
     *
     * Null when no budget was set: there is no number to enforce, and the plan gate has
     * already asked for one.
     */
    checkBudget ({ endpoint, units = null } = {}) {
      const budget = session?.budget_credits;
      if (budget === null || budget === undefined) return null;
      const entry = catalogEntry(catalog, endpoint);
      const forward = units
        ? estimateCost(entry, { resultCount: units.length }).credits ?? 0
        : Math.max(estimateCost(entry, {}).credits ?? 0, lastCallCredits);

      const d = checkSessionSpend(session, forward);
      if (d.decision !== STOP) return null;
      return {
        decision: STOP,
        gate: d.gate,
        estimate: forward,
        spent: session.spent_credits,
        budget,
        reason: `session budget reached BEFORE this call, not after it: ${session.spent_credits} of `
          + `${budget} credits already spent and the next ${endpoint} call is estimated at ${forward}, `
          + `which would take the run to ${session.spent_credits + forward}. Stopped.`,
      };
    },
    /**
     * Can this hop be batched?
     *
     * The bulk endpoints take `urns`, not the `url` their single counterparts take,
     * and nothing in the API converts a profile URL into a person URN. So batching
     * fires only when the rows ALREADY carry one. When they do not, the reason is
     * recorded and surfaced — 500 single calls with no explanation is how a 50x
     * latency penalty goes unnoticed.
     */
    bulkEligible ({ endpoint, units }) {
      const bulk = bulkVariantFor(catalog, endpoint);
      if (!bulk) return { ok: false, reason: `${endpoint} has no bulk variant in the catalog` };
      const callable = units.filter(u => !u.skip);
      const missing = callable.filter(u => !urnOf(merged(u.row_id))).length;
      if (missing > 0) {
        const reason = `${bulk.endpoint} needs \`urns\`, but ${missing} of ${callable.length} rows carry no LinkedIn URN `
          + `(a profile URL is not a URN, and no endpoint converts one). Falling back to ${callable.length} single calls.`;
        notes.push(reason);
        return { ok: false, reason };
      }
      return { ok: true, bulk };
    },

    /** One HTTP call for up to max_batch rows. Journalling stays per row. */
    async callBulk ({ endpoint, units }) {
      const urns = units.map(u => urnOf(merged(u.row_id)));
      const req = buildRequest(endpoint, { urns: urns.filter(Boolean) });
      if (!req.ok) {
        const e = new Error(req.reason); e.code = 'input_insufficient'; throw e;
      }
      const entry = catalogEntry(catalog, endpoint);
      let res;
      try {
        res = await api.post(endpoint, req.payload);
      } catch (err) {
        if (err?.status === 402) ledger.recordInsufficientCredits({ endpoint, body: err.body ?? {}, catalogEntry: entry });
        else if (err?.status) {
          const e = estimateCost(entry, { resultCount: units.length });
          ledger.record({ endpoint, catalogEntry: entry, estimatedCredits: e.credits, estimateBasis: e.basis, responseBody: err.body, httpStatus: err.status });
        }
        throw err;
      }

      const rows = Array.isArray(res.body) ? res.body
        : Array.isArray(res.body?.data) ? res.body.data
        : Array.isArray(res.body?.results) ? res.body.results
        : null;

      // ONE ledger line per bulk CALL, with result_count so a per-result charge is
      // accounted correctly. The journal still carries one line per row.
      const count = rows ? rows.length : units.length;
      const est = estimateCost(entry, { resultCount: count });
      const line = ledger.record({
        endpoint, catalogEntry: entry,
        estimatedCredits: est.credits, estimateBasis: est.basis,
        responseBody: res.body, httpStatus: res.status,
        resultCount: count,
      });
      lastCallCredits = line.credits_actual ?? line.credits_estimated ?? 0;
      recordSpend(session, lastCallCredits);

      const aligned = rows ? alignBulkRows(urns, rows) : null;
      if (aligned) {
        // The bulk endpoint's elements carry the SINGLE endpoint's field names, so
        // both the response map and the cache key are the single endpoint's.
        const single = Object.entries(catalog.endpoints).find(([, d]) => d.bulk_variant === endpoint)?.[0];
        units.forEach((u, i) => {
          if (!aligned[i]) return;
          const reqRecord = merged(u.row_id);            // capture BEFORE results.set,
          const prior = results.get(u.row_id) ?? {};     // or the cache key is computed
          const insp = audit.record(inspectResponse(single ?? endpoint, aligned[i]), { row_id: u.row_id, hop: 'bulk', billing: billingVerdict(res.body, res.status) });
          const mapped = insp.columns;
          results.set(u.row_id, { ...prior, ...mapped });
          persist(u.row_id, single ?? endpoint, mapped);
          if (cache?.enabled && single) cache.put(single, reqRecord, aligned[i]);
        });
      }

      const perRow = entry?.pricing?.credits_per_result ?? null;
      return { results: aligned, returned: rows ? rows.length : null, credits_per_row: perRow, credits_actual: line.credits_actual };
    },

    async call ({ endpoint, row_id, hop }) {
      const req = buildRequest(endpoint, merged(row_id));
      if (!req.ok) {
        // No HTTP call, no charge. Deliberately NOT an HttpError: journal.errorCode
        // maps any HttpError to `http_<status>`, and this is not a transport failure.
        // A plain Error with a `code` journals the short machine code instead, which
        // the journal-line contract requires (`error` is a pattern, never free text).
        //
        // This fires for a genuinely dynamic case the plan cannot pre-compute: the
        // email_verifier hop when email_finder found nothing. `api.callCount` is the
        // authoritative call count precisely because units like this never reach HTTP.
        const e = new Error(req.reason);
        e.code = 'input_insufficient';
        throw e;
      }

      const entry = catalogEntry(catalog, endpoint);
      let res;
      try {
        res = await api.post(endpoint, req.payload);
      } catch (err) {
        if (err instanceof HttpError && err.status === 402) {
          ledger.recordInsufficientCredits({ endpoint, body: err.body ?? {}, catalogEntry: entry });
        } else if (err instanceof HttpError) {
          // EVERY attempted call reaches the ledger, including status 0. Excluding
          // timeouts meant a call the API may have billed was recorded as zero spend
          // and then re-paid on resume.
          const e = estimateCost(entry, {});
          ledger.record({ endpoint, catalogEntry: entry, estimatedCredits: e.credits, estimateBasis: e.basis, rowId: row_id, hop, responseBody: err.body, httpStatus: err.status ?? 0 });
        }
        // The server's own explanation of the refusal, echo-scrubbed by the client and
        // dropped on the floor until now: a live 422 reached the terminal as `http_422`
        // and nothing else. The journal token is untouched (it must stay a SAFE_TOKEN);
        // this is the human-facing half. See run.mjs:noteRemediation.
        noteRemediation(notes, err);
        throw err;
      }

      // A real estimate, not null. For the 11 endpoints whose charge is never
      // verifiable this is the ONLY number that will ever exist, so writing 0 here
      // would silently report a run as free.
      const est = estimateCost(entry, {});
      const line = ledger.record({
        endpoint,
        catalogEntry: entry,
        estimatedCredits: est.credits,
        estimateBasis: est.basis,
        rowId: row_id,
        hop,
        responseBody: res.body,
        httpStatus: res.status,
      });
      lastCallCredits = line.credits_actual ?? line.credits_estimated ?? 0;
      recordSpend(session, lastCallCredits);

      // Write through, so the next identical run is free.
      if (cache?.enabled) cache.put(endpoint, merged(row_id), res.body);

      // Carry findings forward so a later hop can use them (email_finder -> verifier).
      const attribution = readAttribution(res.body);
      const prior = results.get(row_id) ?? {};
      // inspectResponse both maps AND classifies. A 2xx whose body carries data but
      // produces no column is a mapping failure, not an empty result — see the tripwire in client.mjs.
      const insp = audit.record(inspectResponse(endpoint, res.body), { row_id, hop, billing: billingVerdict(res.body, res.status) });
      const mapped = insp.columns;
      results.set(row_id, { ...prior, ...mapped });
      persist(row_id, endpoint, mapped);

      return {
        body: res.body,
        mapping: { status: insp.status, columns: insp.column_count, is_mapping_failure: insp.is_mapping_failure },
        credits_actual: line.credits_actual,
        provider: attribution.provider,
        confidence: attribution.confidence,
      };
    },
  };
}

// Response -> output columns is per-endpoint and lives in client.mjs (RESPONSE_MAPS),
// because the API answers in camelCase and each endpoint names things differently.
// A single flat allowlist silently dropped everything two of the four hops returned.

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * The catalog ships WITH the package. Resolving it against the caller's cwd meant the
 * CLI only ran from inside the repo checkout — `richapi enrich` from any real project
 * died with "no catalog at <cwd>/_lib/api-catalog.json".
 */
/**
 * Which hops `--batch` will actually send to a bulk endpoint, priced from the catalog.
 * Mirrors the executor's rule (createExecClient.bulkEligible + runHopMajor): a hop is
 * batched only when it has a bulk variant, more than one callable row, and EVERY
 * callable row carries a URN. Shown on the dry run, because the bulk endpoint is a
 * different, differently-priced call from the one the plan table names.
 */
export function planEnrichBatch ({ plan, catalog, recordOf, batch = false }) {
  if (!batch) return [];
  const out = [];
  for (const endpoint of new Set(plan.units.map(u => u.endpoint))) {
    const bulk = bulkVariantFor(catalog, endpoint);
    if (!bulk) continue;
    const callable = plan.units.filter(u => u.endpoint === endpoint && !u.skip);
    const withUrn = callable.filter(u => urnOf(recordOf(u.row_id))).length;
    const batched = callable.length > 1 && withUrn === callable.length;
    const est = batched ? estimateCost(bulk.def, { resultCount: callable.length }) : null;
    out.push({
      endpoint,
      bulk_variant: bulk.endpoint,
      max_batch: bulk.maxBatch,
      rows: callable.length,
      rows_with_urn: withUrn,
      batched,
      calls: batched ? Math.ceil(callable.length / bulk.maxBatch) : 0,
      credits_estimated: est ? est.credits : null,
      basis: est ? est.basis : null,
      reason: batched ? null
        : callable.length <= 1 ? 'one row or fewer to call: a single call, not a batch'
        : `${callable.length - withUrn} of ${callable.length} rows carry no URN: single calls`,
    });
  }
  return out;
}

export function renderEnrichBatch (lines) {
  return lines.map(b => (b.batched
    ? `batch: ${b.endpoint} x${b.rows} row(s) -> ${b.bulk_variant}, ${b.calls} call(s) `
      + `(max ${b.max_batch}/call), est. ${b.credits_estimated} credits (${b.basis})`
    : `batch: ${b.endpoint} NOT batched via ${b.bulk_variant} — ${b.reason}`));
}

export function loadCatalog (root = null) {
  const p = root ? path.join(root, '_lib', 'api-catalog.json') : CATALOG_PATH;
  if (!fs.existsSync(p)) throw new EnrichError(`no catalog at ${p} — run: node bin/richapi-catalog-gen.mjs`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Gate the plan BEFORE any call, rather than prompting per call.
 *
 * This is the shape decision that matters: /enrich-waterfall is ~8 credits a contact,
 * so a 100-person list is ~800 credits, 32x the whole 25-credit free grant.
 * Prompting per call would fire dozens of times during the trial that decides whether
 * the user ever pays, and gate fatigue kills the only control there is. So the user
 * approves ONE plan, and after that the API's 402 is the authority that stops a run.
 */
export function gatePlan ({ plan, catalog, session }) {
  const decisions = [];
  const seen = new Set();
  for (const hop of plan.per_hop) {
    if (hop.calls_planned === 0 || seen.has(hop.endpoint)) continue;
    seen.add(hop.endpoint);

    // `page: 1` is correct HERE and nowhere near as safe as it looks.
    //
    // An enrichment waterfall does not page: each hop is one call about one row.
    // Today the waterfall is enrich_profile, email_finder, phone_finder and
    // email_verifier, none of which appear in gates.yaml:unbounded_endpoints,
    // so there is no page to gate and page 1 is the honest answer.
    //
    // But `pages_before_confirm` is 1 — page 1 runs, every page after it asks —
    // so a hard-coded page 1 is also, exactly, the value that can never trigger
    // a page gate. The day someone adds a page-gated endpoint to the waterfall,
    // this line would wave it straight through, silently, on an endpoint whose
    // only real cost ceiling is a human between pages. profile_activities is 2
    // credits a result on an unbounded total with no charge in the response;
    // that is what this would be waving through.
    //
    // So it fails loudly instead. Paging belongs to `richapi search`
    // (_lib/run.mjs), which gates each planned page individually.
    if (isUnbounded(session.gates, hop.endpoint)) {
      throw new Error(
        `gatePlan cannot gate ${hop.endpoint}: it is page-gated `
        + '(gates.yaml:unbounded_endpoints.endpoints) and an enrichment waterfall has no page '
        + 'to gate, so this call would bypass the only ceiling it has. Route paging through '
        + '`richapi search` (_lib/run.mjs), which gates every planned page.');
    }

    // An endpoint the catalog does not carry has no known cost, so it cannot be gated.
    // `checkCall` treats a null catalogEntry as "the caller did not supply one" — which
    // is right for the (plan total) line and wrong here, so the refusal is made
    // explicit rather than left to a null that reads as consent. Before the
    // own-property fix this branch was unreachable for a prototype name: the lookup
    // returned Object.prototype, whose absent `pricing.model` happened to STOP.
    const entry = catalogEntry(catalog, hop.endpoint);
    if (!entry) {
      decisions.push({
        decision: STOP,
        gate: 'catalog.endpoint',
        endpoint: hop.endpoint,
        reason: `"${hop.endpoint}" is not in the catalog, so its cost cannot be known and the `
          + 'call cannot be gated — failing closed (law 5)',
        failed_closed: true,
      });
      continue;
    }

    decisions.push(checkCall(session, {
      endpoint: hop.endpoint,
      catalogEntry: entry,
      estimatedCredits: hop.credits_estimated,
      page: 1,
    }));
  }
  // The whole-plan spend check, once, against the session budget.
  decisions.push(checkCall(session, {
    endpoint: '(plan total)',
    estimatedCredits: plan.totals.credits_estimated,
  }));
  const stops = decisions.filter(d => d.decision === STOP);
  const confirms = decisions.filter(d => d.decision === CONFIRM);
  return { decisions, stops, confirms, blocked: stops.length > 0 };
}

/**
 * Run (or plan, or resume) an enrichment.
 *
 * `confirm` is the approval callback. It is only ever consulted for a real run;
 * a dry run spends nothing and asks nothing.
 */
export async function runEnrich ({
  input,
  output = null,
  dir = 'gtm',
  root = process.cwd(),
  dryRun = false,
  noCache = false,
  batch = false,
  resume = null,
  phone = false,
  verify = true,
  budget = null,
  api = null,
  catalog = null,
  gates = null,
  confirm = async () => false,
  now = () => new Date().toISOString(),
  runId = null,
  maxAttempts = 3,
  sleep = undefined,
  // Local-only activation counters. Injectable so tests never touch the real
  // state dir; `createActivationRecorder()` disables itself under `node --test`.
  activation = null,
} = {}) {
  const act = activation ?? createActivationRecorder();
  const cat = catalog ?? loadCatalog();
  const gateCfg = gates ?? loadGates();

  // Fail closed: no readable suppression store, no run. loadSuppressionStore throws.
  // The store must follow --dir. Reading it from a hard-coded gtm/ while journalling
  // into a different tree would let a run use one project's suppression list and
  // another's state, which is the quiet version of emailing a suppressed contact.
  const store = loadSuppressionStore({ root, path: path.resolve(root, dir, 'suppression.jsonl') });

  const records = readInputRows(input);
  if (!records.length) throw new EnrichError(`input list is empty: ${input}`);

  const cache = loadCache({ root, dir, enabled: !noCache });
  const prepared = records.map((r, i) => toDescriptor(r, i, { store, cache, batch }));
  const descriptors = prepared.map(p => p.descriptor);
  const byId = new Map(prepared.map(p => [p.descriptor.row_id, p.record]));

  const id = resume ?? runId ?? `enrich-${Date.now().toString(36)}-${sha(input).slice(0, 6)}`;
  const waterfall = buildWaterfall({ phone, verify });
  const plan = buildPlan({ runId: id, rows: descriptors, waterfall, catalog: cat, now });

  const session = createSession({ gates: gateCfg, runId: id });
  if (budget !== null) {
    const set = setBudget(session, budget);
    if (set.decision === STOP) throw new EnrichError(set.reason);
  }

  // ---- dry run: zero calls, by construction ----
  if (dryRun) {
    const journal = new RunJournal({ runId: id, dir: path.resolve(root, dir) });
    const written = writeDryRun({ plan, journal, dir: path.resolve(root, dir) });
    const gate = gatePlan({ plan, catalog: cat, session });
    const batchPlan = planEnrichBatch({ plan, catalog: cat, recordOf: (rid) => byId.get(rid) ?? {}, batch });
    return {
      mode: 'dry-run', run_id: id, plan, gate,
      batch: batchPlan,
      journal_path: written.path,
      cache: { enabled: cache.enabled, ttl_source: cache.ttl_source ?? null, ...cache.stats },
      pending_written: written.pending_written,
      skipped_written: written.skipped_written,
      calls_made: 0,
      skip_reasons: collectSkipReasons(prepared, waterfall),
      text: [renderPlanText(plan), ...renderEnrichBatch(batchPlan)].join('\n'),
      activation: act.run({ mode: 'dry-run', calls: 0, wroteOutput: false }),
    };
  }

  // ---- real run ----
  const gate = gatePlan({ plan, catalog: cat, session });
  if (gate.blocked) {
    return { mode: 'blocked', run_id: id, plan, gate, calls_made: 0, reasons: gate.stops.map(s => s.reason), activation: act.run({ mode: 'blocked' }) };
  }
  if (gate.confirms.length) {
    const approved = await confirm({ plan, gate });
    if (!approved) return { mode: 'declined', run_id: id, plan, gate, calls_made: 0, activation: act.run({ mode: 'declined' }) };
  }

  const gtmDir = path.resolve(root, dir);
  const lock = acquireListLock({ dir: gtmDir, listKey: path.resolve(input), runId: id });
  try {
    const journal = new RunJournal({ runId: id, dir: gtmDir });
    let units = plan.units;
    let resumeInfo = null;
    if (resume) {
      const { lines, corrupt } = readJournal(journal.path);
      resumeInfo = planResume({ lines, corrupt, units: plan.units, maxAttempts });
      units = resumeInfo.todo;
    }

    const ledger = new Ledger({ dir: gtmDir, runId: id });
    const apiClient = api ?? new RichApiClient();
    // Check the key BEFORE spending the run. Without this, MissingApiKey is thrown
    // per call and caught as a unit failure, so the user is told "3 units failed"
    // instead of "set richapi_API_KEY" — and on a long list, once per row.
    if (typeof apiClient.requireKey === 'function') apiClient.requireKey();
    // A resume MUST rebuild what earlier runs already bought, or the output file is
    // written without it and the credits are wasted twice over.
    const results = resume ? loadResults(gtmDir, id) : new Map();
    // Seed from the cache so a hop that was skipped as cached still feeds the next one.
    for (const p of prepared) {
      if (p.cachedData && Object.keys(p.cachedData).length) results.set(p.descriptor.row_id, { ...p.cachedData, ...(results.get(p.descriptor.row_id) ?? {}) });
    }
    const batchNotes = [];
    const mappingAudit = createMappingAudit();
    const client = createExecClient({ api: apiClient, catalog: cat, ledger, records: byId, results, session, notes: batchNotes, cache, dir: gtmDir, runId: id, mappingAudit });

    // Batching is OPT-IN. The bulk endpoints have no 200 example in the spec, so the
    // response shape is unknown and attribution is positional. A response with the
    // right COUNT in a different order silently hands contact A contact B's email —
    // written to the output list and cached under the wrong key, with nothing in the
    // journal, ledger or receipt showing anything wrong. Enable it only once
    // bin/richapi-capture-fixtures.mjs has proved the shape carries a correlatable id.
    if (!batch) {
      delete client.callBulk;
      delete client.bulkEligible;
    }

    // Hop-major: every row finishes hop N before any row starts hop N+1. That is
    // what makes batching possible, and it preserves the waterfall's result flow.
    const exec = await runHopMajor({ journal, units, client, catalog: cat, maxAttempts, ...(sleep ? { sleep } : {}) });

    // Output is written through the suppression filter. There is no other writer.
    let outputInfo = null;
    if (output) {
      const rows = prepared
        .filter(p => !p.descriptor.suppressed)
        .map(p => ({ ...p.record, ...(results.get(p.descriptor.row_id) ?? {}) }));
      outputInfo = writeOutputList(path.resolve(root, output), rows, { root, store });
      // store is passed explicitly, so writeOutputList never re-derives a different one.
    }

    const journalLines = readJournal(journal.path).lines;
    const rec = reconcile({ plan, ledgerLines: ledger.lines });

    // The receipt is built here, from the ledger, so the receipt cannot drift from the cost
    // math. assertNeverOverstates throws rather than returning false: a silently
    // wrong receipt is exactly the failure it exists to prevent.
    const mapping = mappingAudit.summary();
    const receipt = buildReceipt({
      ledger, gates: gateCfg, runLabel: id,
      balance: ledger.balance, balanceSource: ledger.balanceSource,
      mapping,
    });
    assertNeverOverstates(receipt, ledger);
    // The tripwire's own guard: a receipt that spent money may not stay quiet about a
    // response it could not read. Recomputed from the audit's raw counters, not from
    // the fields buildReceipt already derived, because a guard must be able to fire.
    assertMappingSurfaced(receipt, mapping);
    return {
      mode: resume ? 'resume' : 'run',
      run_id: id, plan, gate, exec, resume: resumeInfo,
      journal_path: journal.path,
      ledger_path: ledger.path,
      ledger_totals: ledger.totals(),
      receipt,
      http_calls: apiClient.callCount ?? null,
      reconcile: rec,
      output: outputInfo,
      calls_made: exec.calls_made,
      failures: failureSummary(journalLines, { ignore: NOT_A_FAILURE }),
      // Reported as SKIPPED, not failed: these units never reached HTTP and were
      // never billed. See `skippedSummary`.
      skipped_units: skippedSummary(journalLines),
      batch_notes: batchNotes,
      // Set only when the SESSION BUDGET stopped the run, so a 402 abort reads exactly
      // as it did before. The remainder is journalled skipped_budget and replannable.
      budget_stop: exec.abort_reason === 'session_budget'
        ? { note: exec.abort_note ?? null, budget: session.budget_credits, spent: session.spent_credits }
        : null,
      cache: { enabled: cache.enabled, ttl_source: cache.ttl_source ?? null, ...cache.stats },
      skip_reasons: collectSkipReasons(prepared, waterfall),
      // Empty-column tripwire. `mapping.total_blackout` is the "paid for calls, delivered
      // zero columns" case; `mapping_issues` carries the raw response key sets that
      // are the only evidence that fixes RESPONSE_MAPS.
      mapping,
      mapping_issues: mappingAudit.issues,
      activation: act.run({
        mode: resume ? 'resume' : 'run',
        calls: apiClient.callCount ?? 0,
        wroteOutput: Boolean(outputInfo?.written),
      }),
    };
  } finally {
    lock.release();
  }
}

function collectSkipReasons (prepared, waterfall = null) {
  // Only hops actually in THIS run's waterfall. Otherwise a run without --phone
  // still reports why phone_finder was skipped, which reads as a problem.
  const inRun = waterfall ? new Set(waterfall.map(h => h.endpoint)) : null;
  const out = {};
  for (const p of prepared) {
    for (const [ep, reason] of Object.entries(p.skipReasons)) {
      if (inRun && !inRun.has(ep)) continue;
      out[ep] ??= {};
      out[ep][reason] = (out[ep][reason] ?? 0) + 1;
    }
  }
  return out;
}

export { MissingApiKey };
