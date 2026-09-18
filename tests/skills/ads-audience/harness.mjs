// tests/skills/ads-audience/harness.mjs — the executable form of /ads-audience.
//
// WHY THIS FILE EXISTS
//
// The money rule — *an upload under the platform floor is rejected AFTER the credits
// are spent* — cannot be tested by reading the prose that states it. Asserting the
// paragraph exists proves a sentence exists. What has to be proven is that a list that
// cannot clear the floor produces a refusal and ZERO paid calls, and that an unknown
// platform fails closed rather than falling through to a default.
//
// So the rules live in `skills/ads-audience/SKILL.md` as a fenced, machine-readable
// `audience-rules` block and this file runs that block — the same technique /comply and
// /personalize use. The RULES are the skill's; this file is only the interpreter.
//
// Delegated, never re-implemented:
//   platform floors -> _lib/gates.mjs  (checkAudienceMinimum; MissingGateKey => STOP)
//   suppression     -> _lib/suppression.mjs (filterOutputList / writeOutputList)
//   hashing         -> _lib/suppression.mjs (sha256)
//
// NOTHING here makes an HTTP call. The paid fill is injected as a `call` function so a
// test can prove the refusal path never reaches it.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import {
  loadGates, gateValue, hasGate, checkAudienceMinimum, MissingGateKey, STOP, ALLOW,
} from '../../../_lib/gates.mjs';
import {
  sha256, filterOutputList, writeOutputList, SuppressionUnavailableError,
} from '../../../_lib/suppression.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILL_PATH = join(REPO, 'skills', 'ads-audience', 'SKILL.md');

export { STOP, ALLOW, SuppressionUnavailableError, sha256, MissingGateKey };

export const BUILD = 'build';
export const REFUSE = 'refuse';

export class AudienceRulesUnavailable extends Error {
  constructor (msg) { super(msg); this.name = 'AudienceRulesUnavailable'; this.verdict = STOP; }
}

/** Thrown when a caller tries to run a plan that was refused. */
export class AudienceRefused extends Error {
  constructor (plan) {
    super(`ads-audience refused: ${plan.gate} — ${plan.reason}`);
    this.name = 'AudienceRefused';
    this.plan = plan;
  }
}

// ---------------------------------------------------------------------------
// 1. Load the rules OUT OF THE SKILL.
// ---------------------------------------------------------------------------

const FENCE_RE = /^```yaml[ \t]+audience-rules[ \t]*$/m;

export function loadAudienceRules ({ path = SKILL_PATH } = {}) {
  if (!existsSync(path)) throw new AudienceRulesUnavailable(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  let open = null;
  for (const line of src.split('\n')) {
    if (open === null) { if (FENCE_RE.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (open !== null) throw new AudienceRulesUnavailable('unterminated `audience-rules` fence');
  if (blocks.length === 0) {
    throw new AudienceRulesUnavailable(
      'skills/ads-audience/SKILL.md carries no ```yaml audience-rules block — the table is the gate');
  }
  if (blocks.length > 1) {
    throw new AudienceRulesUnavailable(`${blocks.length} audience-rules blocks; there must be exactly one`);
  }
  let doc;
  try { doc = parseYaml(blocks[0]); }
  catch (e) { throw new AudienceRulesUnavailable(`audience-rules is not parseable YAML: ${e.message}`); }
  if (!doc || typeof doc !== 'object') throw new AudienceRulesUnavailable('audience-rules is empty');

  // Law 5, at load time. A table whose default is permissive is not a gate, and a
  // gate that can be switched off by editing one word is not one either.
  if (doc.default_decision !== REFUSE) {
    throw new AudienceRulesUnavailable(
      `default_decision is ${JSON.stringify(doc.default_decision)}; it must be "${REFUSE}" — law 5`);
  }
  if (doc.unknown_platform !== REFUSE) {
    throw new AudienceRulesUnavailable(
      'unknown_platform must be "refuse" — audience_minimums has no default key on purpose (law 5)');
  }
  for (const k of ['check_ceiling_before_spend', 'recheck_realised_after_fill']) {
    if (doc.minimum_gate?.[k] !== true) {
      throw new AudienceRulesUnavailable(`minimum_gate.${k} must be true — that check is the skill`);
    }
  }
  if (doc.minimum_gate?.overridable !== false) {
    throw new AudienceRulesUnavailable('minimum_gate.overridable must be false — a money gate with an override is advice');
  }
  if (doc.suppression?.required !== true || doc.suppression?.fail_closed !== true) {
    throw new AudienceRulesUnavailable('suppression must be required and fail_closed (law 5)');
  }
  if (doc.sender_export?.written_by_this_skill !== false) {
    throw new AudienceRulesUnavailable('sender_export.written_by_this_skill must be false — /launch owns that');
  }
  if (doc.file?.plaintext_email_allowed !== false) {
    throw new AudienceRulesUnavailable('file.plaintext_email_allowed must be false — the digest matches, the address leaks');
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. Classification.
//
// In production the corporate/role/personal split is BOUGHT from
// `identify_email_type`. The harness takes the classification as an input rather than
// faking the endpoint: a test that stubs an API and then asserts the stub is a test of
// the stub. `defaultClassify` is a local-part heuristic used only where a test does not
// care which rows are role addresses.
// ---------------------------------------------------------------------------

export const ROLE_LOCAL_PARTS = Object.freeze([
  'info', 'sales', 'support', 'hello', 'contact', 'admin', 'help', 'team',
  'office', 'enquiries', 'inquiries', 'billing', 'accounts', 'noreply', 'no-reply',
]);

export function emailOf (row) {
  if (typeof row === 'string') return row;
  for (const k of ['email', 'work_email', 'email_address']) {
    if (typeof row?.[k] === 'string' && row[k].trim()) return row[k].trim();
  }
  return null;
}

export function normaliseEmail (value) {
  return String(value ?? '').trim().toLowerCase();
}

export function defaultClassify (row) {
  const e = emailOf(row);
  if (!e) return 'missing';
  const local = normaliseEmail(e).split('@')[0];
  return ROLE_LOCAL_PARTS.includes(local) ? 'role' : 'corporate';
}

/** Can this row be filled by the paid hop? Needs something to search on. */
export function isFillable (row) {
  if (emailOf(row)) return false;
  const name = row?.first_name || row?.full_name || row?.last_name;
  const domain = row?.company_domain || row?.domain || row?.website;
  return Boolean(name && domain);
}

// ---------------------------------------------------------------------------
// 3. The plan. FREE. Makes no calls, spends nothing, writes nothing.
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   decision: 'build'|'refuse', gate: string, reason: string, failed_closed: boolean,
 *   platform: string, counts: object, floor: {key:string,value:number}|null,
 *   spend: {endpoint:string, planned_calls:number, dry_run_required:true}|null
 * }}
 */
export function planAudience ({
  rows, platform, gates = loadGates(), root, rules = loadAudienceRules(),
  classify = defaultClassify,
} = {}) {
  const source = Array.isArray(rows) ? rows : [];

  // Suppression first, and it throws without a readable store. A check we could not
  // run is not a passing check (law 5).
  const { kept, dropped } = filterOutputList(source, { root });

  let role = 0;
  const ready = [];
  const fillable = [];
  for (const row of kept) {
    if (classify(row) === 'role') { role += 1; continue; }
    if (emailOf(row)) { ready.push(row); continue; }
    if (isFillable(row)) fillable.push(row);
  }

  const counts = {
    source: source.length,
    suppressed: dropped.length,
    role,
    ready: ready.length,
    fillable: fillable.length,
    ceiling: ready.length + fillable.length,
  };

  const key = String(platform ?? '').toLowerCase();
  const floorKey = `${rules.gate_key_prefix}.${key}`;

  // THE money gate. Checked against the ceiling — the best the audience could ever be
  // — so an impossible audience is refused before a credit moves. An unknown platform
  // has no key here, `gateValue` throws MissingGateKey, and `closed()` turns that into
  // a STOP. There is no default floor and this harness does not invent one.
  const gate = checkAudienceMinimum(gates, key, counts.ceiling);
  const floor = hasGate(gates, floorKey) ? { key: floorKey, value: gateValue(gates, floorKey) } : null;

  const base = {
    platform: key,
    counts,
    gate: gate.gate,
    reason: gate.reason,
    failed_closed: gate.failed_closed === true,
    floor,
    rows: { ready, fillable },
  };

  if (gate.decision === STOP) return { ...base, decision: REFUSE, spend: null };

  return {
    ...base,
    decision: BUILD,
    spend: { endpoint: rules.paid_fill.endpoint, planned_calls: fillable.length, dry_run_required: true },
  };
}

// ---------------------------------------------------------------------------
// 4. The build. The ONLY thing here that can spend, and it refuses a refused plan
//    before it looks at anything else.
// ---------------------------------------------------------------------------

/**
 * @param {function(string, object): (string|null)} call
 *        the injected paid hop. Receives (endpoint, row) and returns an email or null.
 *        A refused plan must never reach it — that is what the tests assert.
 */
export function buildAudience ({
  plan, file, root, gates = loadGates(), rules = loadAudienceRules(),
  call = () => { throw new Error('buildAudience: no paid-call function injected'); },
  now = new Date(),
} = {}) {
  if (!plan || plan.decision !== BUILD) throw new AudienceRefused(plan ?? { gate: 'none', reason: 'no plan' });

  const calls = [];
  const filled = [];
  for (const row of plan.rows.fillable) {
    calls.push({ endpoint: rules.paid_fill.endpoint, row });
    const found = call(rules.paid_fill.endpoint, row);
    if (found) filled.push({ ...row, email: found });
  }

  const all = [...plan.rows.ready, ...filled];

  // Re-check the floor on what was actually produced. The fill under-delivers, so a
  // run that cleared on the ceiling can land beneath it on the result.
  const realised = checkAudienceMinimum(gates, plan.platform, all.length);
  if (realised.decision === STOP) {
    return {
      decision: REFUSE, code: 'REALISED_BELOW_FLOOR', gate: realised.gate, reason: realised.reason,
      file: null, manifest: null, written: 0, suppressed: 0, calls,
      counts: { ...plan.counts, realised: all.length },
    };
  }

  // Rows carry the plaintext address so `_lib/suppression.mjs` can match on it, and
  // `columns` restricts what actually lands in the file to the digest. One writer, and
  // the file never carries an address.
  const outRows = all.map(r => {
    const e = normaliseEmail(emailOf(r));
    return { email: e, sha256_email: sha256(e) };
  });
  const res = writeOutputList(file, outRows, { root, columns: rules.file.columns });

  const manifestPath = file + rules.file.manifest_suffix;
  const manifest = {
    schema_version: 1,
    platform: plan.platform,
    floor_gate_key: plan.floor?.key ?? null,
    floor_value: plan.floor?.value ?? null,
    source_list_hash: listContentHash(plan.rows.ready.concat(plan.rows.fillable)),
    ceiling_count: plan.counts.ceiling,
    written_count: res.written,
    suppressed_count: plan.counts.suppressed + res.suppressed,
    role_address_count: plan.counts.role,
    hash_algorithm: rules.file.hash,
    created_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    decision: BUILD, code: 'WRITTEN', gate: realised.gate, reason: realised.reason,
    file, manifest: manifestPath, manifest_body: manifest,
    written: res.written, suppressed: res.suppressed, calls,
    counts: { ...plan.counts, realised: all.length },
  };
}

/** A stable content hash for the source list, so an audience cannot outlive its list. */
export function listContentHash (rows) {
  const h = createHash('sha256');
  for (const r of rows) h.update(normaliseEmail(emailOf(r) ?? JSON.stringify(r)) + '\n');
  return h.digest('hex');
}

export default {
  loadAudienceRules, planAudience, buildAudience, listContentHash,
  defaultClassify, isFillable, emailOf, normaliseEmail,
  BUILD, REFUSE, AudienceRulesUnavailable, AudienceRefused, ROLE_LOCAL_PARTS,
};
