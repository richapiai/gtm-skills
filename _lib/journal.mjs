/**
 * _lib/journal.mjs — the run journal + resume.
 *
 * One JSONL line per row per hop at `gtm/runs/{run-id}.jsonl`, conforming exactly to
 * the FROZEN `_lib/contracts/journal-line.schema.json`.
 *
 * Why it exists: a 500-row phone pass at 25 credits/call is 12,500 credits. With no
 * record of which rows completed, a crash means paying twice. So:
 *
 *   - A line is written BEFORE each call (`pending`) and AFTER it (terminal status).
 *     A kill mid-call therefore leaves an orphan `pending` — recoverable, and bounded
 *     to `concurrency` rows rather than to the whole list.
 *   - `row_id` is the stable resume key; `(row_id, hop)` is the unit key.
 *   - Row-level contact data NEVER enters this file. `append()` throws on any field
 *     not declared by the frozen schema, and pattern-checks the free-text fields
 *     (`error`, `provider`, `response_hash`) so an error message cannot smuggle a
 *     contact in. That is the write-side half of the PII boundary; `share-render.mjs`
 *     is the read-side half.
 *
 * Encoding note (contract gap, reported not patched): the frozen schema has no
 * "this line was produced by --dry-run" flag. Interim encoding: dry-run pending lines
 * carry `attempt: 0` ("planned, never attempted"); execution pending lines carry
 * `attempt >= 1`. Only the latter can be an orphan-pending suspect.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { billingVerdict } from './ledger.mjs';

export const SCHEMA_VERSION = 1;

/** Exactly the property names declared by journal-line.schema.json. */
export const JOURNAL_FIELDS = Object.freeze([
  'schema_version', 'run_id', 'row_id', 'hop', 'endpoint', 'status', 'ts',
  'credits_estimated', 'credits_actual', 'response_hash', 'provider',
  'confidence', 'error', 'attempt',
  // Declared in journal-line.schema.json. They were missing here, so sanitizeLine
  // threw on them with the message "not in journal-line.schema.json" — which was
  // false, and told anyone coding to the contract the opposite of the truth.
  'dry_run', 'list_key',
]);

export const REQUIRED_FIELDS = Object.freeze([
  'schema_version', 'run_id', 'row_id', 'hop', 'endpoint', 'status', 'ts',
]);

export const STATUSES = Object.freeze([
  'pending', 'ok', 'failed', 'skipped_cache', 'skipped_suppressed', 'skipped_budget',
]);

/**
 * Resume semantics, stated once and depended on everywhere:
 *
 *   TERMINAL_DONE  — never re-planned. The work is done, or must never be done.
 *   REPLANNABLE    — re-planned on resume. The condition that stopped it is transient.
 *
 * `skipped_budget` is deliberately REPLANNABLE: the user tops up credits and resumes.
 * `skipped_suppressed` is deliberately TERMINAL: fail closed — a suppressed contact is
 * not enriched on a later pass either.
 */
export const TERMINAL_DONE = Object.freeze(['ok', 'skipped_cache', 'skipped_suppressed']);
export const REPLANNABLE = Object.freeze(['failed', 'skipped_budget', 'pending']);

const SAFE_TOKEN = /^[A-Za-z0-9_.:\-/]{1,64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class JournalContractError extends Error {
  constructor(message) { super(message); this.name = 'JournalContractError'; }
}

export class ConcurrentRunError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ConcurrentRunError';
    Object.assign(this, details || {});
  }
}

/** Thrown by an injected client to signal a transport-level failure. */
export class HttpError extends Error {
  constructor(status, { retryAfter = null, body = null, code = null } = {}) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.body = body;
    this.code = code;
  }
}

/** Squeeze any vendor string into a SAFE_TOKEN, or null if nothing survives. */
export function coerceToken(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return t === '' ? null : t;
}

export function sha256(value) {
  const material = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return createHash('sha256').update(material).digest('hex');
}

export function unitKey(rowId, hop) {
  return JSON.stringify([rowId, hop]);
}

/**
 * A run id becomes a FILE PATH, and `--resume` is user input, so this is stricter
 * than SAFE_TOKEN: no dot, no slash, no colon. SAFE_TOKEN permits `.` and `/`, which
 * made `../../../../tmp/pwn` a valid run id and turned the journal writer into an
 * arbitrary-file-append outside gtm/ — not gitignored, not swept, not erasable.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function runJournalPath(dir, runId) {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new JournalContractError(
      `unsafe run_id: ${JSON.stringify(runId)} — letters, digits, underscore and hyphen only`,
    );
  }
  const file = path.join(dir, 'runs', `${runId}.jsonl`);
  // Belt and braces: prove the result is inside the state tree before anyone writes.
  const root = path.resolve(dir);
  if (!path.resolve(file).startsWith(root + path.sep)) {
    throw new JournalContractError(`run journal would escape ${root}`);
  }
  return file;
}

/**
 * Build a schema-conforming line, or throw. This is the write-side PII guard:
 * an undeclared key is a hard error, never a silent drop, because a silent drop lets
 * a caller believe it stored something it did not.
 */
export function sanitizeLine(input) {
  if (!input || typeof input !== 'object') {
    throw new JournalContractError('journal line must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!JOURNAL_FIELDS.includes(key)) {
      throw new JournalContractError(
        `field "${key}" is not in journal-line.schema.json — row-level data must never enter the journal`,
      );
    }
  }
  const line = {
    dry_run: input.dry_run === true,
    list_key: input.list_key ?? null,
    schema_version: SCHEMA_VERSION,
    run_id: input.run_id,
    row_id: input.row_id,
    hop: input.hop,
    endpoint: input.endpoint,
    status: input.status,
    ts: input.ts ?? new Date().toISOString(),
    credits_estimated: input.credits_estimated ?? null,
    credits_actual: input.credits_actual ?? null,
    response_hash: input.response_hash ?? null,
    provider: input.provider ?? null,
    confidence: input.confidence ?? null,
    error: input.error ?? null,
    attempt: input.attempt ?? 1,
  };
  for (const key of REQUIRED_FIELDS) {
    if (line[key] === undefined || line[key] === null) {
      throw new JournalContractError(`missing required field "${key}"`);
    }
  }
  if (input.schema_version !== undefined && input.schema_version !== SCHEMA_VERSION) {
    throw new JournalContractError(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (typeof line.run_id !== 'string' || !SAFE_TOKEN.test(line.run_id)) {
    throw new JournalContractError('run_id must be a safe token string');
  }
  if (typeof line.row_id !== 'string' || line.row_id.length === 0) {
    throw new JournalContractError('row_id must be a non-empty string');
  }
  if (!Number.isInteger(line.hop) || line.hop < 0) {
    throw new JournalContractError('hop must be an integer >= 0');
  }
  if (typeof line.endpoint !== 'string' || !SAFE_TOKEN.test(line.endpoint)) {
    throw new JournalContractError('endpoint must be a safe token string');
  }
  if (!STATUSES.includes(line.status)) {
    throw new JournalContractError(`status must be one of ${STATUSES.join('|')}`);
  }
  if (typeof line.ts !== 'string' || Number.isNaN(Date.parse(line.ts))) {
    throw new JournalContractError('ts must be an ISO date-time string');
  }
  for (const key of ['credits_estimated', 'credits_actual']) {
    if (line[key] !== null && typeof line[key] !== 'number') {
      throw new JournalContractError(`${key} must be a number or null`);
    }
  }
  if (line.response_hash !== null && !SHA256_HEX.test(line.response_hash)) {
    throw new JournalContractError(
      'response_hash must be sha256 hex or null — never a response body',
    );
  }
  if (line.list_key !== null && line.list_key !== undefined) {
    // A list key is a filesystem path in practice, which routinely carries a company
    // or person name. Hash it: the journal needs to CORRELATE, not to remember.
    line.list_key = sha256(String(line.list_key)).slice(0, 32);
  }
  if (line.provider !== null && !SAFE_TOKEN.test(String(line.provider))) {
    // COERCE, never throw. This runs on the AFTER write, i.e. after the credits are
    // spent. Real waterfall vendors are called "Acme Data Labs" and
    // "Beta Enrich (waterfall)"; throwing here killed the run mid-flight and left an
    // orphan `pending` that a resume re-paid. A vendor name is attribution, not
    // identity - losing its exact spelling is nothing, losing the run is expensive.
    line.provider = coerceToken(line.provider);
  }
  if (line.error !== null && !SAFE_TOKEN.test(String(line.error))) {
    throw new JournalContractError(
      'error must be a short code (e.g. http_429), never a message — a message can carry a contact',
    );
  }
  if (line.confidence !== null
      && typeof line.confidence !== 'number'
      && !(typeof line.confidence === 'string' && SAFE_TOKEN.test(line.confidence))) {
    throw new JournalContractError('confidence must be a number, a safe token, or null');
  }
  if (!Number.isInteger(line.attempt) || line.attempt < 0) {
    throw new JournalContractError('attempt must be an integer >= 0');
  }
  return line;
}

/**
 * Append-only journal writer. Each `append` is one `fs.appendFileSync` of one complete
 * newline-terminated line, so an O_APPEND write from a second process interleaves
 * between lines, never inside one.
 */
export class RunJournal {
  constructor({ runId, dir = 'gtm', now = () => new Date().toISOString() }) {
    this.runId = runId;
    this.dir = dir;
    this.now = now;
    this.path = runJournalPath(dir, runId);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
  }

  append(partial) {
    const line = sanitizeLine({ run_id: this.runId, ts: this.now(), ...partial });
    fs.appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    return line;
  }

  /** The BEFORE write. attempt 0 = planned by --dry-run; >= 1 = about to make a call. */
  appendPending(unit, { attempt = 1 } = {}) {
    return this.append({
      row_id: unit.row_id,
      hop: unit.hop,
      endpoint: unit.endpoint,
      status: 'pending',
      credits_estimated: unit.credits_estimated ?? null,
      attempt,
    });
  }

  /** The AFTER write. */
  appendResult(unit, result) {
    return this.append({
      row_id: unit.row_id,
      hop: unit.hop,
      endpoint: unit.endpoint,
      credits_estimated: unit.credits_estimated ?? null,
      ...result,
    });
  }

  read() { return readJournal(this.path); }

  static hash(body) { return sha256(body); }
}

/**
 * Tolerant JSONL reader — a damaged journal must still yield a resume plan rather than
 * wedge the run.
 *
 * Returns { lines, corrupt, truncatedTail }. A partial final line is the expected
 * damage from a kill mid-write; a mid-file corrupt line is reported too, and the
 * affected row is surfaced as a suspect by `planResume` rather than silently trusted.
 */
export function readJournal(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], corrupt: [], truncatedTail: false };
    throw err;
  }
  const lines = [];
  const corrupt = [];
  const endsClean = raw.length === 0 || raw.endsWith('\n');
  const parts = raw.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  let truncatedTail = false;
  parts.forEach((text, i) => {
    const isLast = i === parts.length - 1;
    if (text.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      corrupt.push({ line_no: i + 1, reason: 'unparseable_json', salvaged: salvageRowId(text) });
      if (isLast && !endsClean) truncatedTail = true;
      return;
    }
    try {
      lines.push(sanitizeLine(parsed));
    } catch (err) {
      corrupt.push({
        line_no: i + 1,
        reason: `contract_violation:${err.message}`,
        salvaged: salvageRowId(text),
      });
    }
  });
  return { lines, corrupt, truncatedTail };
}

/**
 * Best-effort row_id recovery from a truncated line, so a damaged tail names the row
 * it damaged instead of silently disappearing. Recovery is used only to WARN — never
 * to decide that a row is done.
 */
function salvageRowId(text) {
  const m = /"row_id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  const hopMatch = /"hop"\s*:\s*(\d+)/.exec(text);
  try {
    return { row_id: JSON.parse(`"${m[1]}"`), hop: hopMatch ? Number(hopMatch[1]) : null };
  } catch {
    return null;
  }
}

/**
 * Fold the journal into per-unit state. Later lines win, which is what makes the
 * before/after pair work: `pending` then `ok` collapses to `ok`.
 */
export function summarize(lines) {
  const units = new Map();
  for (const line of lines) {
    const key = unitKey(line.row_id, line.hop);
    let unit = units.get(key);
    if (!unit) {
      unit = {
        row_id: line.row_id,
        hop: line.hop,
        endpoint: line.endpoint,
        status: null,
        attempts: 0,
        max_attempt: 0,
        credits_estimated: null,
        credits_actual: null,
        provider: null,
        confidence: null,
        error: null,
        lines: 0,
      };
      units.set(key, unit);
    }
    unit.lines += 1;
    unit.endpoint = line.endpoint;
    unit.status = line.status;
    unit.max_attempt = Math.max(unit.max_attempt, line.attempt);
    if (line.attempt >= 1) unit.attempts = Math.max(unit.attempts, line.attempt);
    if (line.credits_estimated !== null) unit.credits_estimated = line.credits_estimated;
    if (line.status !== 'pending') {
      unit.credits_actual = line.credits_actual;
      unit.provider = line.provider;
      unit.confidence = line.confidence;
      unit.error = line.error;
    }
  }
  return units;
}

/**
 * What a run is actually charged for. One unit is charged at most once no matter how
 * many 429 retries it took: retries write `failed` lines with zero credits, and only
 * the last line per unit counts.
 */
export function chargedUnits(lines) {
  const units = summarize(lines);
  let credits = 0;
  let calls = 0;
  const perEndpoint = new Map();
  for (const unit of units.values()) {
    if (unit.status !== 'ok') continue;
    const amount = unit.credits_actual ?? unit.credits_estimated ?? 0;
    credits += amount;
    calls += 1;
    const bucket = perEndpoint.get(unit.endpoint) ?? { calls: 0, credits: 0 };
    bucket.calls += 1;
    bucket.credits += amount;
    perEndpoint.set(unit.endpoint, bucket);
  }
  return { calls, credits, per_endpoint: Object.fromEntries(perEndpoint) };
}

/**
 * Re-plan only what is not done.
 *
 * `units` is the full plan (usually the dry-run's pending lines, or a freshly built
 * plan). For each unit the journal's last status decides:
 *
 *   ok / skipped_cache / skipped_suppressed  -> done, never re-planned, never re-charged
 *   failed / skipped_budget                  -> re-planned (transient), until maxAttempts
 *   pending with attempt >= 1, no terminal   -> ORPHAN: killed mid-call. Re-planned AND
 *                                               reported in `suspect`, so the operator is
 *                                               told "at most N rows may be charged twice"
 *                                               instead of finding out from the invoice.
 *   pending with attempt 0                   -> a --dry-run plan line: simply not run yet
 *   absent                                   -> never attempted
 */
export function planResume({ lines = [], corrupt = [], units = null, maxAttempts = 3 } = {}) {
  const state = summarize(lines);
  let planned = units;
  if (!planned) {
    planned = [];
    for (const unit of state.values()) {
      planned.push({
        row_id: unit.row_id,
        hop: unit.hop,
        endpoint: unit.endpoint,
        credits_estimated: unit.credits_estimated,
      });
    }
    planned.sort((a, b) => (a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : a.hop - b.hop));
  }
  const todo = [];
  const done = [];
  const exhausted = [];
  const suspect = [];
  const suspectFromCorruption = new Set();
  for (const entry of corrupt) {
    if (entry.salvaged?.row_id) suspectFromCorruption.add(entry.salvaged.row_id);
  }
  for (const unit of planned) {
    const prior = state.get(unitKey(unit.row_id, unit.hop));
    const resolved = {
      ...unit,
      credits_estimated: unit.credits_estimated ?? prior?.credits_estimated ?? null,
    };
    if (prior && TERMINAL_DONE.includes(prior.status)) {
      done.push({ ...resolved, status: prior.status });
      continue;
    }
    if (prior && prior.status === 'pending' && prior.max_attempt >= 1) {
      suspect.push({
        row_id: unit.row_id,
        hop: unit.hop,
        reason: 'orphan_pending_killed_mid_call',
      });
    }
    if (suspectFromCorruption.has(unit.row_id)) {
      suspect.push({ row_id: unit.row_id, hop: unit.hop, reason: 'corrupt_journal_line' });
    }
    const attemptsSoFar = prior?.attempts ?? 0;
    if (attemptsSoFar >= maxAttempts) {
      exhausted.push({ ...resolved, attempts: attemptsSoFar, error: prior?.error ?? null });
      continue;
    }
    todo.push({ ...resolved, attempt: attemptsSoFar + 1, prior_status: prior?.status ?? null });
  }
  const creditsToSpend = todo.reduce((sum, u) => sum + (u.credits_estimated ?? 0), 0);
  return {
    todo,
    done,
    exhausted,
    suspect,
    corrupt,
    stats: {
      units_planned: planned.length,
      units_done: done.length,
      units_todo: todo.length,
      units_exhausted: exhausted.length,
      rows_todo: new Set(todo.map((u) => u.row_id)).size,
      rows_done: new Set(done.map((u) => u.row_id)).size,
      credits_estimated_remaining: creditsToSpend,
      suspect_max_double_charge_rows: new Set(suspect.map((s) => s.row_id)).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Concurrency: one active run per input list.
// ---------------------------------------------------------------------------

export function listLockPath(dir, listKey) {
  return path.join(dir, 'runs', '.locks', `${sha256(listKey).slice(0, 32)}.lock`);
}

/**
 * Two concurrent runs over one list is a double-charge in disguise: the second run
 * cannot see the first run's in-flight rows, because they live in a different journal.
 * So the second run is refused, and the refusal names the run to resume instead.
 */
export function acquireListLock({
  dir = 'gtm', listKey, runId, staleMs = 6 * 60 * 60 * 1000, now = Date.now,
}) {
  const lockPath = listLockPath(dir, listKey);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = { run_id: runId, pid: process.pid, started_at: new Date(now()).toISOString() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { held = null; }
    const age = held ? now() - Date.parse(held.started_at) : Infinity;
    const holderAlive = held?.pid ? isProcessAlive(held.pid) : false;
    const stale = !held || age > staleMs;
    // INVERTED before: `holderAlive || !stale` meant a lock left by a CRASHED process
    // (holderAlive false, age < staleMs) still refused, so a run killed at row 400
    // could not be resumed for six hours — and the realistic workaround was a fresh
    // run that re-paid for all 400 rows. The probe could only ever ADD refusals, so it
    // never enabled the takeover it was written for. Refuse only for a LIVE holder.
    if (holderAlive && !stale) {
      throw new ConcurrentRunError(
        `another run (${held?.run_id ?? 'unknown'}) is already active on this list — `
        + 'resume that run instead of starting a second one; two runs over one list double-charge',
        { held_run_id: held?.run_id ?? null, held_pid: held?.pid ?? null, lock_path: lockPath },
      );
    }
    fs.writeFileSync(lockPath, JSON.stringify({ ...payload, took_over_from: held?.run_id ?? null }));
  }
  return {
    path: lockPath,
    release() { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } },
  };
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

const DEFAULT_SLEEP = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// 429 backoff
// ---------------------------------------------------------------------------
//
// `Retry-After` arrives off the wire. It used to be multiplied by 1000 and slept on
// with no ceiling, so a 429 carrying `Retry-After: 86400` wedged the CLI for 24 hours
// per attempt, per unit — a server-controlled denial of service against its own client.
//
// The same three lines held the opposite bug: with no usable header the wait was
// `sleep(0)`, i.e. three immediate re-hammers per unit under a burst, which makes the
// rate limit that produced the 429 strictly worse.
//
// THE POLICY
//
//   header present and > 0   honour it, CLAMPED to RETRY_AFTER_MAX_MS (60s).
//                            The server knows its own window and we should respect it,
//                            but the client keeps the last word on how long it hangs.
//                            60s is one full attempt at the client's own request
//                            timeout, so the worst case for a 3-attempt unit is ~2min
//                            of waiting rather than 3 days.
//
//   header absent, 0, or     exponential backoff with decorrelating jitter:
//   unparseable                attempt 1 -> 0.5-1s, attempt 2 -> 1-2s, attempt 3 -> 2-4s,
//                            doubling to a BACKOFF_MAX_MS (30s) ceiling.
//                            Jitter is half the window, so N units that 429ed in the
//                            same instant do not come back in the same instant — that
//                            synchronised second wave is what turns a rate limit into
//                            a rate-limit storm.
//
// `Retry-After: 0` counts as "no usable guidance" and takes the backoff branch on
// purpose. A server that says "retry immediately" while returning 429 is not giving
// advice worth following, and the old code's answer to it was the zero-backoff bug.

/** Hard ceiling on a server-supplied Retry-After. The client keeps the last word. */
export const RETRY_AFTER_MAX_MS = 60_000;
/** First-attempt backoff window when there is no usable Retry-After. */
export const BACKOFF_BASE_MS = 1_000;
/** Ceiling on the exponential backoff window. */
export const BACKOFF_MAX_MS = 30_000;

/**
 * How long to wait before retrying a 429.
 *
 * @param {number|string|null|undefined} retryAfter  seconds, straight off the wire
 * @param {number} attempt                           the attempt that just failed (1-based)
 * @param {{jitter?: () => number}} [opts]           injectable for deterministic tests
 * @returns {number} milliseconds, always > 0 and always <= max(RETRY_AFTER_MAX_MS, BACKOFF_MAX_MS)
 */
export function retryDelayMs (retryAfter, attempt = 1, { jitter = Math.random } = {}) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.round(seconds * 1000), RETRY_AFTER_MAX_MS);
  }
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const ceiling = Math.min(BACKOFF_BASE_MS * (2 ** (n - 1)), BACKOFF_MAX_MS);
  const half = ceiling / 2;
  const raw = typeof jitter === 'function' ? Number(jitter()) : 0;
  const roll = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  return Math.round(half + roll * half);
}

/**
 * Is this HTTP status worth another attempt? 429 (rate limit) and any 5xx: the billing
 * rule is that a non-2xx deducts nothing, and a 503 is the server saying "not now",
 * exactly as a 429 is. A 503 used to be terminal on the first try.
 */
export function isRetryableStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/**
 * Terminal failures by error code, from journal lines (last line per unit wins, so a
 * retried-then-ok unit is not a failure). `{ http_503: 1 }`.
 */
export function failureSummary(lines, { ignore = [] } = {}) {
  const out = {};
  for (const u of summarize(lines).values()) {
    if (u.status !== 'failed') continue;
    const code = u.error ?? 'error';
    if (ignore.includes(code)) continue;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

/** Did the API (or the transport) fail a unit? Those are the failures a script must see. */
export function hasApiFailure(failures) {
  return Object.keys(failures ?? {}).some((c) => c.startsWith('http_') || c === 'network_error');
}

function errorCode(err) {
  if (err instanceof HttpError) return `http_${err.status}`;
  if (typeof err?.code === 'string' && SAFE_TOKEN.test(err.code)) return err.code.toLowerCase();
  return 'error';
}

function readBalance(body) {
  if (!body || typeof body !== 'object') return null;
  const value = body.balance ?? body.credits_balance ?? body.remaining ?? null;
  return typeof value === 'number' ? value : null;
}

/**
 * Execute a plan against an injected client, journalling before and after every call.
 *
 * client.call({ endpoint, row_id, hop, attempt }) resolves to
 *   { body, provider?, confidence?, credits_actual? }
 * or rejects with HttpError.
 *
 * 429: retried up to maxAttempts honouring Retry-After. Each failed attempt writes a
 *      zero-credit `failed` line, so the ledger sees one charge for the unit, not four.
 * 402: aborts the whole run immediately. The remaining planned units are journalled
 *      `skipped_budget` (REPLANNABLE), so a resume after a top-up picks them all up.
 */
export async function runWaterfall({
  journal,
  units,
  client,
  maxAttempts = 3,
  sleep = DEFAULT_SLEEP,
  onUnit = null,
}) {
  const result = {
    aborted: false,
    abort_reason: null,
    balance: null,
    ok: 0,
    failed: 0,
    skipped_cache: 0,
    skipped_suppressed: 0,
    skipped_budget: 0,
    // Units handed to the API, counted once per unit however many retries it took.
    // `calls_made` counts calls; printing it as "units attempted" read "attempted 7, ok 8".
    attempted: 0,
    calls_made: 0,
    retries: 0,
    waited_ms: 0,
    // A 2xx whose body says `billed: false` — the provider errored. Counted apart
    // from `failed` so a run can say "12 rows were never looked up" rather than
    // reporting them as genuine not-founds.
    provider_error: 0,
  };

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (result.aborted) break;

    if (unit.skip === 'cache' || unit.skip === 'suppressed') {
      const status = unit.skip === 'cache' ? 'skipped_cache' : 'skipped_suppressed';
      journal.appendResult(unit, { status, credits_actual: 0, attempt: 0 });
      result[status] += 1;
      continue;
    }

    let attempt = unit.attempt ?? 1;
    let settled = false;
    result.attempted += 1;
    while (!settled) {
      journal.appendPending(unit, { attempt }); // BEFORE
      let response;
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await client.call({
          endpoint: unit.endpoint, row_id: unit.row_id, hop: unit.hop, attempt,
        });
        result.calls_made += 1;
      } catch (err) {
        result.calls_made += 1;
        const code = errorCode(err);
        const status = err instanceof HttpError ? err.status : null;

        if (isRetryableStatus(status) && attempt < maxAttempts) {
          journal.appendResult(unit, { // AFTER — retryable, zero-charge
            status: 'failed', error: code, credits_actual: 0, attempt,
          });
          result.retries += 1;
          // Clamped when the server named a delay, real exponential backoff when it
          // did not. Never `sleep(0)`, never `sleep(86400s)`.
          const ms = retryDelayMs(err.retryAfter, attempt);
          result.waited_ms += ms;
          // eslint-disable-next-line no-await-in-loop
          await sleep(ms);
          attempt += 1;
          continue;
        }

        journal.appendResult(unit, { // AFTER — terminal failure
          status: 'failed', error: code, credits_actual: 0, attempt,
        });
        result.failed += 1;
        settled = true;

        if (status === 402) {
          result.aborted = true;
          result.abort_reason = 'insufficient_credits';
          result.balance = readBalance(err.body);
          for (const remaining of units.slice(i + 1)) {
            journal.appendResult(remaining, {
              status: 'skipped_budget', credits_actual: 0, error: 'http_402', attempt: 0,
            });
            result.skipped_budget += 1;
          }
        }
        break;
      }

      // A 200 that says it was not billed is NOT a success. Live 2026-09-17:
      // email_finder returned `{ok:false, billed:false, why:"2/5 providers returned
      // an error — retry later"}` and the pack journalled `ok`, which is TERMINAL_DONE
      // — so a resume never retried the row and the receipt called it a not-found.
      // `failed` is REPLANNABLE, which is exactly what "retry later" asks for.
      if (billingVerdict(response?.body, 200).billed === false) {
        journal.appendResult(unit, {
          status: 'failed', error: 'provider_error', credits_actual: 0, attempt,
        });
        result.provider_error += 1;
        result.failed += 1;
        settled = true;
        break;
      }

      journal.appendResult(unit, { // AFTER — success
        status: 'ok',
        credits_actual: response?.credits_actual ?? null,
        response_hash: sha256(response?.body ?? null),
        provider: response?.provider ?? null,
        confidence: response?.confidence ?? null,
        attempt,
      });
      result.ok += 1;
      settled = true;
    }
    if (onUnit) onUnit(unit, result);
  }
  return result;
}
