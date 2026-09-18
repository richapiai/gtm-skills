// _lib/pii.mjs — PII retention enforced by the runtime, not advised.
//
// Law 7: `gtm/` is PII. Gitignored, TTL-swept, erasable.
//
// Five mechanisms live here:
//   1. Provenance   — every PII artifact carries `source_endpoint` + `fetched_at`.
//                     The writer stamps them; the reader refuses rows without them.
//   2. TTL sweep    — `sweepEnrichmentCache()` drops expired `gtm/enrichment-cache/`
//                     rows against per-endpoint TTLs. FAIL CLOSED: an endpoint we do
//                     not recognise gets the SHORTEST TTL, never the longest.
//   3. setup refusal— see `../setup.mjs` (uses `gtmIsGitTracked()` from this module).
//   4. erase        — `erase()` purges every artifact holding a person across the
//                     whole `gtm/` tree and appends a tombstone so the erasure is
//                     itself auditable. Idempotent; reports what it touched.
//   5. erase gates  — `eraseDecision()` + the two-label target floor. Erasure is
//                     irreversible, so it is never implicit and never wide by
//                     accident. This used to live in tests/, which is not shipped.
//
// Two of these exist because the same failure happened twice: a control that was
// declared in config and reasoned about in prose, with no code behind it. The TTL
// sweep (2) and the erase gates (5) are both that bug, caught four months apart.
//
// Why this file exists: governance that lives in prose disappears — `enrichment-cache/`
// and its TTL once silently vanished from a written design. This is code.
//
// WHICH TREE: the state tree is `gtm/` by default, but the CLI's `--dir <gtm>` moves
// it and `_lib/run.mjs` honours that for a run. Every function below therefore takes
// `dir` and goes through `resolveStateTree()`, which REFUSES when the tree it was
// pointed at is not the one holding the data. Sweeping the wrong tree is silent: it
// touches nothing and reports success, which for erase means a tombstone recording an
// erasure that did not happen.
//
// Zero runtime deps. Node >= 18, ESM.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, relative, resolve, sep, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';
import { CATALOG_PATH, GATES_PATH } from './paths.mjs';
import { parseRows, stringifyRows } from './csv.mjs';
import { loadGates, gateValue, MissingGateKey, ALLOW, CONFIRM, STOP } from './gates.mjs';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PiiProvenanceError extends Error {
  constructor(msg) { super(msg); this.name = 'PiiProvenanceError'; }
}

/**
 * The erase target is too broad to be a deletion request.
 *
 * Its own class because the CLI has to distinguish "you typed nothing" (usage) from
 * "what you typed would match a third of the internet" (refusal).
 */
export class EraseTargetTooBroadError extends Error {
  constructor(msg, { target = null, labels = null } = {}) {
    super(msg);
    this.name = 'EraseTargetTooBroadError';
    this.target = target;
    this.labels = labels;
  }
}

/**
 * A compliance operation was pointed at a state tree that is not the one holding
 * the data.
 *
 * The CLI takes `--dir <gtm>` and a run honours it (`_lib/run.mjs`), so state can
 * live at `gtm-acme/` while every function here derived `root + 'gtm'`. An erase
 * then swept an empty default tree, matched nothing, and appended a tombstone
 * recording a successful erasure — a documented lie, which is worse than a crash.
 * So this is thrown instead: fail closed, naming both paths.
 */
export class StateTreeMismatchError extends Error {
  constructor(msg, { requested = null, candidates = [], root = null, operation = null } = {}) {
    super(msg);
    this.name = 'StateTreeMismatchError';
    this.verdict = 'STOP';
    this.requested = requested;
    this.candidates = candidates;
    this.root = root;
    this.operation = operation;
  }
}

// ---------------------------------------------------------------------------
// The `gtm/` tree — the full erase sweep surface.
// ---------------------------------------------------------------------------

export const GTM_DIR = 'gtm';

/** Directories created by `setup` and swept by `erase`. */
export const GTM_SUBDIRS = [
  'lists',             // output lists (csv/jsonl) — the thing suppression protects
  'enrichment-cache',  // TTL-swept read-through cache
  'research',          // per-account research notes (md/json)
  'copy',              // generated sequence copy (md/json)
  'org-maps',          // buying-committee maps (json)
  'deals',             // deal/opportunity state (json/jsonl)
  'ads',               // ad-platform audience exports (csv)
  'runs',              // the run journal, one .jsonl per run (contract: journal-line)

  // Every OTHER directory a shipped skill writes into. Derived, not guessed:
  //   git grep "gtm/" skills/ | grep -o "gtm/[a-z-]*/" | sort -u
  // `tests/compliance/setup-sweep.test.mjs` re-derives the same list and fails when a
  // skill starts writing somewhere setup does not create.
  //
  // This is not cosmetic. `setup` created the tree and these were missing, so
  // /call-intel wrote gtm/calls/ itself — outside the tree the erase sweep walks and
  // outside the TTL sweep, which is a compliance hole (law 7), not an untidy folder.
  'audiences',         // audience definitions and exports
  'calls',             // call intelligence notes (/call-intel)
  'competitive',       // competitor teardowns
  'copy',              // (already above) generated sequence copy
  'cost',              // cost reports (/cost-optimizer)
  'exports',           // CRM-bound exports
  'icp',               // ICP definitions
  'measure',           // measurement snapshots
  'plans',             // saved run plans
  'plays',             // play definitions
  'retro',             // run retrospectives
  'reviews',           // review artifacts
  'schedules',         // scheduled run definitions
  'sequences',         // sequence definitions
  'signals',           // buying-signal captures
  'strategy',          // strategy notes
].filter((d, i, a) => a.indexOf(d) === i);

export const SUPPRESSION_FILE = 'suppression.jsonl';
export const TOMBSTONE_FILE   = 'tombstones.jsonl';
export const LEDGER_FILE      = 'api-calls.jsonl';

/** Never rewritten by erase — it IS the audit trail of erasures. */
// Files an erase sweep must never rewrite.
//
// TOMBSTONE_FILE is the record that an erase happened; destroying it destroys
// the proof of compliance the erase exists to create.
//
// CONSENT_FILE is the OPERATOR's own record of what they consented to share
// not data about any contact. It is here pre-emptively, ahead of the
// client that writes it, because the failure is silent and severe in a way that
// is hard to notice after the fact: erase() sweeps the whole tree and rewrites
// any line matching the identifier, so erasing one CONTACT could quietly alter
// the operator's consent ledger — and consent is append-only with tombstones
// precisely so that it cannot be rewritten. Guarding it costs one line now and
// is easy to forget once the writer lands.
export const CONSENT_FILE = 'consent.jsonl';
export const ERASE_EXCLUDED = new Set([TOMBSTONE_FILE, CONSENT_FILE]);

/**
 * What makes a directory a state tree rather than any other folder next to it.
 *
 * Both files are created by `ensureGtmTree()`/`setup`, and `_lib/run.mjs` refuses to
 * run at all without a readable `suppression.jsonl` in the tree it was given. So a
 * tree that has actually held data has at least one of these; a `dist/` or `node_modules/`
 * has neither. Deliberately narrow: a false positive here refuses a legitimate erase.
 */
export const STATE_TREE_MARKERS = [SUPPRESSION_FILE, TOMBSTONE_FILE];

/** Absolute paths of the immediate children of `root` that look like a state tree. */
export function findStateTrees(root = process.cwd()) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    if (STATE_TREE_MARKERS.some(m => existsSync(join(p, m)))) out.push(p);
  }
  return out.sort();
}

/**
 * The tree a compliance operation must act on — or a refusal.
 *
 * `dir` is the CLI's `--dir <gtm>`, the same value `_lib/run.mjs` resolves for a run.
 * Passing it makes the operation act on the tree the run actually wrote to.
 *
 * Omitting it means "the default `gtm/`", and that is only an answer when no OTHER
 * state tree exists beside it. If one does, the request is ambiguous and the wrong
 * choice is unobservable — a clean sweep of an empty tree looks exactly like a clean
 * sweep of a clean tree. Ambiguous is therefore STOP, not a guess.
 *
 * An explicitly named tree that does not exist, while other trees do, is the same
 * mistake typed out loud (a mistyped `--dir`), and is refused too.
 */
export function resolveStateTree({ root = process.cwd(), dir = null, operation = 'this operation' } = {}) {
  const explicit = typeof dir === 'string' && dir.trim() !== '';
  const target = resolve(root, explicit ? dir.trim() : GTM_DIR);
  const others = findStateTrees(root).filter(p => p !== target);
  if (others.length === 0) return target;

  const list = others.map(p => `  - ${p}`).join('\n');
  if (!explicit) {
    throw new StateTreeMismatchError(
      `${operation}: refusing to run against ${target} — state tree(s) holding data exist elsewhere:\n`
      + `${list}\n`
      + 'A sweep of the wrong tree touches nothing and reports success, which is a false '
      + 'compliance record. Name the tree explicitly (`--dir <name>`), the same value the '
      + 'run used.',
      { requested: target, candidates: others, root, operation },
    );
  }
  if (!existsSync(target)) {
    throw new StateTreeMismatchError(
      `${operation}: state tree ${target} does not exist, but these do:\n`
      + `${list}\n`
      + 'Refusing rather than sweeping an absent tree and reporting a clean result.',
      { requested: target, candidates: others, root, operation },
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// 1. Provenance: source endpoint + fetched_at, impossible to omit
// ---------------------------------------------------------------------------

export const PROVENANCE_FIELDS = ['source_endpoint', 'fetched_at'];

/**
 * Stamp a PII record with its provenance. Throws if the caller cannot name the
 * endpoint the data came from — that is the point: you may not write PII you
 * cannot attribute.
 */
export function stampPii(record, { endpoint, now = new Date(), key = null } = {}) {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new PiiProvenanceError(
      'stampPii: `endpoint` is required — every PII artifact carries its source endpoint',
    );
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new PiiProvenanceError('stampPii: record must be a plain object');
  }
  const out = {
    schema_version: 1,
    source_endpoint: endpoint.trim(),
    fetched_at: toIso(now),
    ...record,
  };
  // Caller-supplied provenance never wins over the stamp.
  out.source_endpoint = endpoint.trim();
  out.fetched_at = record.fetched_at ? toIso(record.fetched_at) : toIso(now);
  if (key !== null && out.key === undefined) out.key = key;
  return out;
}

/** Throws unless the record carries BOTH provenance fields. */
export function assertPiiProvenance(record, where = 'record') {
  if (record === null || typeof record !== 'object') {
    throw new PiiProvenanceError(`${where}: not an object`);
  }
  for (const f of PROVENANCE_FIELDS) {
    const v = record[f];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new PiiProvenanceError(`${where}: missing PII provenance field \`${f}\``);
    }
  }
  if (Number.isNaN(Date.parse(record.fetched_at))) {
    throw new PiiProvenanceError(`${where}: \`fetched_at\` is not a parseable date`);
  }
  return record;
}

/** Append one stamped PII row to a .jsonl artifact. Creates parent dirs. */
export function appendPiiRow(file, record, { endpoint, now = new Date(), key = null } = {}) {
  const stamped = stampPii(record, { endpoint, now, key });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(stamped) + '\n', 'utf8');
  return stamped;
}

/**
 * Read a PII .jsonl artifact.
 * strict (default): a row without provenance throws — you cannot silently consume
 * unattributed personal data. Non-strict returns them under `.unprovenanced`.
 */
export function readPiiJsonl(file, { strict = true } = {}) {
  if (!existsSync(file)) return { rows: [], unprovenanced: [], malformed: [] };
  const rows = [], unprovenanced = [], malformed = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { malformed.push({ line: i + 1, raw: line }); continue; }
    try { assertPiiProvenance(obj, `${file}:${i + 1}`); rows.push(obj); }
    catch (e) {
      if (strict) throw e;
      unprovenanced.push({ line: i + 1, row: obj });
    }
  }
  return { rows, unprovenanced, malformed };
}

// ---------------------------------------------------------------------------
// 2. Per-endpoint cache TTLs — fail closed
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The four retention classes:
 *   firmographics ~90d · funding/tech ~30d · email verification ~7d · posts/activity ~1d
 * `unknown` exists so that an endpoint nobody classified gets the SHORTEST TTL.
 */
export const DEFAULT_TTL_CLASSES = Object.freeze({
  firmographics:      90 * DAY_MS,
  funding_tech:       30 * DAY_MS,
  email_verification:  7 * DAY_MS,
  posts_activity:      1 * DAY_MS,
  unknown:             1 * DAY_MS, // fail closed: shortest, never longest
});

/** The class whose TTL an unclassified endpoint gets. */
export const FAIL_CLOSED_CLASS = 'unknown';

/**
 * Default endpoint -> retention class. Deliberately conservative: an endpoint that
 * is not here is NOT given a long TTL, it is given the shortest one.
 * `_lib/gates.yaml` is the policy authority and overrides this table when present.
 *
 * Rationale for the person-level endpoints sitting in `email_verification` (7d):
 * contactability decays with job changes, which is the same weekly clock as email
 * verification. Shorter is the fail-closed direction, so they go there rather than
 * into firmographics.
 */
export const DEFAULT_ENDPOINT_CLASS = Object.freeze({
  // --- firmographics: company-level, slow-changing (90d) ---
  enrich_company: 'firmographics',
  enrich_companies_bulk: 'firmographics',
  normalize_company: 'firmographics',
  clean_domain: 'firmographics',
  find_website_by_company_name: 'firmographics',
  website_intelligence: 'firmographics',
  linkedin_company_search: 'firmographics',
  crunchbase_company_scraper_sync: 'firmographics',
  google_maps_places_scraper_keyword: 'firmographics',
  google_maps_places_scraper_sync_using_url: 'firmographics',
  directory_yellowpages: 'firmographics',
  web_meta_tags: 'firmographics',
  web_json_ld: 'firmographics',
  web_social_links: 'firmographics',
  web_sitemap: 'firmographics',
  find_sitemap_urls: 'firmographics',
  geo_id_search: 'firmographics',
  search_reference_data: 'firmographics',

  // --- funding / tech / hiring / ads signals (30d) ---
  web_tech_stack: 'funding_tech',
  web_pixels: 'funding_tech',
  similarweb_scraper_sync: 'funding_tech',
  linkedin_job_search: 'funding_tech',
  linkedin_job_detail: 'funding_tech',
  linkedin_ad_search: 'funding_tech',
  linkedin_ad_details: 'funding_tech',
  google_ad_transparency_scraper_sync: 'funding_tech',
  meta_ads_library_scraper_sync: 'funding_tech',
  search_google_trends: 'funding_tech',
  youtube_channel: 'funding_tech',

  // --- contact / email verification, person identity (7d) ---
  email_verifier: 'email_verification',
  email_finder: 'email_verification',
  find_personal_email: 'email_verification',
  identify_email_type: 'email_verification',
  phone_finder: 'email_verification',
  find_linkedin_url_by_email: 'email_verification',
  find_linkedin_url_by_name: 'email_verification',
  enrich_profile: 'email_verification',
  enrich_profiles_bulk: 'email_verification',
  profile_search: 'email_verification',
  people_search: 'email_verification',
  lead_search: 'email_verification',
  linkedin_company_employees_search: 'email_verification',
  web_emails: 'email_verification',
  extract_urls_emails: 'email_verification',
  // Catalog `utilities`, but the INPUT is a person: a name to infer a gender from, a
  // phone number to normalise. `utilities` maps to firmographics (90d), so leaving
  // these unclassified retained a named person's attributes for a quarter — and,
  // being absent from this table, they had no built-in to be measured against either.
  predict_gender: 'email_verification',
  normalize_phone: 'email_verification',

  // --- posts / activity / anything scraped live (1d) ---
  linkedin_company_posts: 'posts_activity',
  post_activities: 'posts_activity',
  post_details: 'posts_activity',
  post_keyword_search: 'posts_activity',
  profile_activities: 'posts_activity',
  profile_social_metrics: 'posts_activity',
  google_search_scraper_sync: 'posts_activity',
  google_maps_reviews_scraper_sync: 'posts_activity',
  search_bing: 'posts_activity',
  youtube_channel_videos: 'posts_activity',
  youtube_search: 'posts_activity',
  youtube_video: 'posts_activity',
  slack_channel_members: 'posts_activity',
  web_scrape: 'posts_activity',
  ai_enrich: 'posts_activity',
});

/**
 * Endpoints whose payload identifies a NAMED PERSON.
 *
 * This is the set on which GDPR art. 5(1)(e) storage limitation bites hardest, and the
 * set for which a policy file may TIGHTEN the built-in class but never loosen it. A
 * widening here is not a tuning decision, it is the exposure a regulator finds first,
 * so it is reported through `notes` — the same channel as "I could not honour this
 * policy" — rather than through the routine `widenings` log.
 *
 * Derived, not hand-listed, from the class that already means "person": everything
 * built-in-classed `email_verification` is contactability or identity resolution.
 * Added by hand on top: the profile- and member-scoped endpoints, which sit in
 * `posts_activity` for freshness reasons but are still about one named person.
 */
export const PERSON_IDENTITY_ENDPOINTS = Object.freeze(new Set([
  ...Object.entries(DEFAULT_ENDPOINT_CLASS)
    .filter(([, cls]) => cls === 'email_verification')
    .map(([ep]) => ep),
  'profile_activities',
  'profile_social_metrics',
  'post_activities',
  'slack_channel_members',
]));

/**
 * Minimal indentation-based YAML reader for the config subset gates.yaml needs.
 * Deliberately NOT a general YAML parser: anything it does not understand throws,
 * and the caller then falls back to the documented defaults. That is the safe
 * direction — an unreadable policy file must never widen a TTL.
 * (`yq` is not installed and we take no runtime dependency; see CLAUDE.md.)
 */
export function parseSimpleYaml(src) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) {
      throw new Error(`yaml:${i + 1}: tab indentation is not supported`);
    }
    const indent = raw.length - raw.trimStart().length;
    let body = raw.trim();
    const hash = findCommentStart(body);
    if (hash >= 0) body = body.slice(0, hash).trim();
    if (body === '') continue;
    if (/^(---|\.\.\.)$/.test(body)) continue;
    if (body.startsWith('- ')) {
      // sequences: supported only as scalar lists under the current key
      const parent = stack[stack.length - 1];
      if (!Array.isArray(parent.list)) throw new Error(`yaml:${i + 1}: unexpected sequence item`);
      parent.list.push(coerceScalar(body.slice(2).trim()));
      continue;
    }
    const m = body.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^:]+):(.*)$/);
    if (!m) throw new Error(`yaml:${i + 1}: unsupported line \`${body}\``);
    const key = unquote(m[1].trim());
    const rest = m[2].trim();
    if (/[&*]/.test(rest) || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      throw new Error(`yaml:${i + 1}: unsupported YAML construct (anchor/alias/block scalar)`);
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child, list: [] });
      // If the following non-blank line is a sequence item, the value is a list.
      const next = nextMeaningful(lines, i + 1);
      if (next && next.trim().startsWith('- ')) {
        const arr = [];
        parent[key] = arr;
        stack[stack.length - 1] = { indent, node: child, list: arr };
      }
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      throw new Error(`yaml:${i + 1}: flow collections are not supported`);
    } else {
      parent[key] = coerceScalar(rest);
    }
  }
  return root;
}

function nextMeaningful(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() === '' || lines[i].trimStart().startsWith('#')) continue;
    return lines[i];
  }
  return null;
}
function findCommentStart(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return i;
  }
  return -1;
}
function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function coerceScalar(s) {
  const v = unquote(s);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** `90d`, `36h`, `7 d`, `604800` (seconds), or a raw number of ms via `{ms: n}`. */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000; // seconds
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] || 's').toLowerCase()) {
    case 'ms': return n;
    case 's':  return n * 1000;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    case 'd':  return n * DAY_MS;
    case 'w':  return n * 7 * DAY_MS;
    default:   return null;
  }
}

/**
 * Load the TTL table. Reads `_lib/gates.yaml` when it exists, and falls back to the documented
 * default table otherwise. Accepted gates.yaml shape:
 *
 *   cache_ttl:
 *     classes:
 *       firmographics: 90d
 *       funding_tech: 30d
 *       email_verification: 7d
 *       posts_activity: 1d
 *     endpoints:
 *       enrich_company: firmographics   # class name
 *       phone_finder: 3d                # or a literal duration
 *
 * Anything unparseable => defaults, and `source: 'defaults'` in the result. An
 * unreadable policy file must never be able to WIDEN a TTL.
 */
export function loadTtlTable({ gatesPath = null, root = process.cwd() } = {}) {
  const table = {
    classes: { ...DEFAULT_TTL_CLASSES },
    endpoints: { ...DEFAULT_ENDPOINT_CLASS },
    policyEndpoints: {},
    groups: {},
    source: 'defaults',
    notes: [],
    // Every endpoint the loaded policy retains LONGER than its built-in class. See
    // annotateWidenings().
    widenings: [],
  };
  // gates.yaml ships with the PACKAGE. Looking for it under the user's project meant
  // the TTL sweep never found the operator's policy and silently ran on defaults,
  // while the cache read path (which resolved it correctly) used the real one.
  const path = gatesPath || GATES_PATH;
  if (!existsSync(path)) {
    table.notes.push(`no gates.yaml at ${path}; using built-in defaults`);
    return table;
  }
  let parsed;
  try {
    // Was `parseSimpleYaml`, a deliberately minimal reader written before
    // gates.yaml existed. It THREW on the real file (unsupported
    // construct at line 59) and silently fell back to defaults, so the entire
    // retention policy was ignored. `yaml` is a real dependency now; use it.
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    table.notes.push(`gates.yaml unparseable (${e.message}); using built-in defaults`);
    return table;
  }
  // Current shape: `cache_ttl_days:` keyed by the catalog's own capability_group
  // enum, values in whole days. Preferred, because the group axis is the one the catalog
  // actually emits per endpoint. The older `cache_ttl:` classes shape is
  // still accepted so an older policy file keeps working.
  const daysCfg = parsed && parsed.cache_ttl_days;
  if (daysCfg && typeof daysCfg === 'object' && !Array.isArray(daysCfg)) {
    table.source = path;
    const asMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * DAY_MS : null);
    for (const [group, days] of Object.entries(daysCfg.by_capability_group || {})) {
      const ms = asMs(days);
      if (ms === null) { table.notes.push(`group \`${group}\`: unusable value \`${days}\`, ignored`); continue; }
      table.groups[group] = ms;
    }
    for (const [ep, days] of Object.entries(daysCfg.by_endpoint || {})) {
      const ms = asMs(days);
      if (ms === null) { table.notes.push(`endpoint \`${ep}\`: unusable value \`${days}\`, ignored`); continue; }
      table.policyEndpoints[ep] = `${days}d`;
    }
    // NOTE: `cache_ttl_days.default` is deliberately NOT used as the unknown
    // fallback. A policy file may set it to 7d while the shortest configured TTL is 1d, and
    // fail-closed means an unclassified endpoint gets the SHORTEST, never a
    // middling default. Recorded for visibility, never applied.
    if (daysCfg.default !== undefined) {
      table.notes.push(`gates.yaml cache_ttl_days.default=${daysCfg.default}d recorded but NOT used as the unknown fallback (fail-closed uses the shortest TTL)`);
    }
    annotateWidenings(table);
    return table;
  }

  const cfg = parsed && parsed.cache_ttl;
  if (!cfg || typeof cfg !== 'object') {
    table.notes.push('gates.yaml has no `cache_ttl_days:` or `cache_ttl:` block; using built-in defaults');
    return table;
  }
  table.source = path;
  if (cfg.classes && typeof cfg.classes === 'object' && !Array.isArray(cfg.classes)) {
    for (const [name, dur] of Object.entries(cfg.classes)) {
      const ms = parseDuration(dur);
      if (ms === null) { table.notes.push(`class \`${name}\`: unparseable duration \`${dur}\`, kept default`); continue; }
      table.classes[name] = ms;
    }
  }
  // Policy endpoints go in their OWN map, never into `endpoints` (the built-in
  // fallback table). Merging them is what let a built-in default shadow an
  // operator's policy file.
  if (cfg.endpoints && typeof cfg.endpoints === 'object' && !Array.isArray(cfg.endpoints)) {
    for (const [ep, val] of Object.entries(cfg.endpoints)) {
      table.policyEndpoints[ep] = val; // class name or literal duration; resolved at lookup
    }
  }
  // gates.yaml `capability_groups:` maps the catalog's capability_group enum to a
  // class. This is what makes a NEW endpoint inherit a sane TTL automatically
  // instead of sitting on the 1d floor until someone hand-maps it.
  if (cfg.capability_groups && typeof cfg.capability_groups === 'object' && !Array.isArray(cfg.capability_groups)) {
    for (const [group, val] of Object.entries(cfg.capability_groups)) {
      const ms = resolveClassOrDuration(val, table);
      if (ms === null) { table.notes.push(`capability_group \`${group}\`: unusable value \`${val}\`, ignored`); continue; }
      table.groups[group] = ms;
    }
  }
  // The fail-closed floor may be tightened by policy but never removed.
  if (!Number.isFinite(table.classes[FAIL_CLOSED_CLASS])) {
    table.classes[FAIL_CLOSED_CLASS] = DEFAULT_TTL_CLASSES[FAIL_CLOSED_CLASS];
  }
  annotateWidenings(table);
  return table;
}

/**
 * Record every endpoint the loaded policy retains LONGER than its built-in class.
 *
 * WHY THIS EXISTS. `capability_groups` is the CATALOG's taxonomy, and the catalog's
 * axis is "what does this endpoint do", not "whose data does it hold". The shipped
 * config mapped the `enrichment` group to `firmographics` (90d) and, because the group
 * resolves ahead of the built-in table, that silently overrode the built-in reasoning
 * — recorded a few dozen lines above — that person-level endpoints belong in
 * `email_verification` (7d) because contactability decays with job changes. Measured
 * effect on the shipped file: `enrich_profile` 7d -> 90d, `find_linkedin_url_by_email`
 * 7d -> 90d, `profile_social_metrics` 1d -> 90d. `table.notes` was `[]`. The operator
 * was never told, and the config comment claimed this key was not even read here.
 *
 * A widening is not always wrong — the built-in table is a fail-closed DEFAULT, not a
 * ceiling, and policy legitimately outranks it. What is never acceptable is a SILENT
 * one. So every widening is logged:
 *
 *   table.widenings  — all of them, structured, for the operator and the sweep output.
 *   table.notes      — additionally, the ones on PERSON_IDENTITY_ENDPOINTS, which is
 *                      the storage-limitation exposure and belongs in the same channel
 *                      as a policy the loader could not honour.
 *
 * Only endpoints the built-in table classifies can be measured: an endpoint with no
 * built-in has nothing to be wider THAN. That gap is why `predict_gender` and
 * `normalize_phone` were added to the built-in table above.
 */
export function annotateWidenings(table) {
  if (!table || table.source === 'defaults') return table;   // no policy, nothing to compare
  table.widenings = [];
  for (const [endpoint, cls] of Object.entries(DEFAULT_ENDPOINT_CLASS)) {
    const builtin = DEFAULT_TTL_CLASSES[cls];
    if (!Number.isFinite(builtin)) continue;
    const resolved = ttlForEndpoint(endpoint, table);
    if (!Number.isFinite(resolved) || resolved <= builtin) continue;
    const via = table.policyEndpoints?.[endpoint] !== undefined
      ? `cache_ttl.endpoints.${endpoint}`
      : `cache_ttl.capability_groups.${capabilityGroupOf(endpoint) ?? '?'}`;
    const w = {
      endpoint,
      builtin_class: cls,
      builtin_days: builtin / DAY_MS,
      resolved_days: resolved / DAY_MS,
      factor: Number((resolved / builtin).toFixed(2)),
      via,
      person_identity: PERSON_IDENTITY_ENDPOINTS.has(endpoint),
    };
    table.widenings.push(w);
    if (w.person_identity) {
      table.notes.push(
        `PII RETENTION WIDENED: \`${endpoint}\` is a person-identity endpoint whose built-in `
        + `class is \`${cls}\` (${w.builtin_days}d), but ${via} resolves it to `
        + `${w.resolved_days}d (${w.factor}x). Storage limitation is a fail-closed `
        + 'direction: tighten the policy or pin this endpoint in cache_ttl.endpoints.');
    }
  }
  return table;
}

/** A policy value is either a class name or a literal duration. null if neither. */
export function resolveClassOrDuration(value, table) {
  if (typeof value === 'string' && table?.classes?.[value] !== undefined) return table.classes[value];
  return parseDuration(value);
}

let _groupIndex = null;
let _groupIndexOk = false;
/**
 * endpoint -> capability_group, read from the generated `_lib/api-catalog.json`.
 * Cached per process. Missing or unreadable catalog yields an empty index, which
 * fails closed (every endpoint then resolves to the shortest TTL).
 */
export function capabilityGroupOf(endpoint, table = null, { root = null } = {}) {
  if (_groupIndex === null) {
    _groupIndex = {};
    try {
      const raw = readFileSync(root ? join(root, '_lib', 'api-catalog.json') : CATALOG_PATH, 'utf8');
      const cat = JSON.parse(raw);
      for (const [name, def] of Object.entries(cat.endpoints || {})) {
        if (def && typeof def.capability_group === 'string') _groupIndex[name] = def.capability_group;
      }
      _groupIndexOk = Object.keys(_groupIndex).length > 0;
    } catch { _groupIndexOk = false; }
  }
  return _groupIndex[endpoint] || null;
}

/** Test seam: drop the cached endpoint->group index. */
export function _resetCapabilityGroupCache() { _groupIndex = null; _groupIndexOk = false; }

/** True once the catalog was read successfully. False means group lookup must fail closed. */
export function capabilityIndexUsable() { if (_groupIndex === null) capabilityGroupOf('__probe__'); return _groupIndexOk; }

/** Shortest TTL known to the table — what an unknown endpoint gets. */
export function shortestTtlMs(table = loadTtlTable()) {
  // Only POSITIVE durations count toward "shortest". A configured 0 is a
  // never-serve-from-cache sentinel (a policy may set `ai: 0` because ai_enrich output is
  // non-deterministic), not a retention period. Letting a 0 win here would make every
  // UNCLASSIFIED endpoint uncacheable too, which burns credits without improving
  // retention safety — the fail-closed floor is `classes.unknown`, not zero.
  const vals = [...Object.values(table.classes), ...Object.values(table.groups || {})]
    .filter(v => Number.isFinite(v) && v > 0);
  const floor = table.classes[FAIL_CLOSED_CLASS];
  return Math.min(...(vals.length ? vals : [DAY_MS]), Number.isFinite(floor) ? floor : DAY_MS);
}

/**
 * TTL for an endpoint, in ms. FAIL CLOSED: an endpoint the table does not know
 * gets the SHORTEST TTL in the table, not the longest and not "no expiry".
 */
export function ttlForEndpoint(endpoint, table = loadTtlTable()) {
  const short = shortestTtlMs(table);
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return short;
  const name = endpoint.trim();

  // Precedence, highest first. The policy FILE always outranks the built-in table:
  // shipping a default that silently shadows an operator's gates.yaml is how a
  // whole retention policy once went unnoticed.
  //   1. gates.yaml by_endpoint   (explicit operator policy for this endpoint)
  //   2. gates.yaml by_capability_group via the catalog
  //   3. built-in DEFAULT_ENDPOINT_CLASS  (fallback when no policy file exists)
  //   4. shortest positive TTL    (fail closed)
  const rawPolicy = table.policyEndpoints?.[name];
  if (rawPolicy !== undefined) {
    const fromPolicy = resolveClassOrDuration(rawPolicy, table);
    if (fromPolicy !== null) return fromPolicy;
    return short; // named in policy but unusable => still fail closed
  }

  const group = capabilityGroupOf(name);
  const byGroup = group && table.groups ? table.groups[group] : undefined;
  if (Number.isFinite(byGroup)) return byGroup; // a policy 0 means "never cache" and is honoured

  // FAIL CLOSED, properly. The built-in DEFAULT_ENDPOINT_CLASS is the fallback for
  // when there is NO policy file at all. Once an operator's gates.yaml IS loaded,
  // falling through to the built-ins can hand back a LONGER TTL than their policy —
  // measured at up to 12x for 18 endpoints when the catalog lookup failed. If we
  // cannot resolve the group under a live policy, the answer is the shortest TTL.
  const underPolicy = table.source && table.source !== 'defaults';
  if (underPolicy && !capabilityIndexUsable()) return short;

  const mapped = table.endpoints[name];
  if (mapped === undefined) return short;
  if (underPolicy && Object.keys(table.groups || {}).length > 0) {
    // A policy defines groups but this endpoint resolved to none of them: the
    // built-in class is not the operator's answer, so do not substitute it.
    return short;
  }
  if (typeof mapped === 'string' && table.classes[mapped] !== undefined) return table.classes[mapped];
  const literal = parseDuration(mapped);
  if (literal !== null) return literal;
  return short; // known name, unusable value => still fail closed
}

/** True when a stamped row is past its endpoint's TTL. Unstamped rows are expired. */
export function isExpired(row, { now = new Date(), table = loadTtlTable() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!row || typeof row !== 'object') return true;
  const fetchedAt = Date.parse(row.fetched_at);
  if (Number.isNaN(fetchedAt)) return true;                 // no clock => cannot prove fresh
  const ep = typeof row.source_endpoint === 'string' ? row.source_endpoint : '';
  if (ep.trim() === '') return true;                         // no provenance => expired
  return nowMs - fetchedAt > ttlForEndpoint(ep, table);
}

/**
 * Sweep `<state tree>/enrichment-cache/` — drop expired rows, keep fresh ones.
 * Called by preflight (`bin/richapi-skills-preflight`).
 * Rows that are malformed or missing provenance are dropped: fail closed.
 *
 * `dir` is the run's `--dir <gtm>`. Omitting it means the default `gtm/`, and
 * `resolveStateTree()` THROWS rather than sweeping it when another state tree exists
 * beside it: a retention sweep of the wrong tree reports zero expired rows, which is
 * indistinguishable from a tree with nothing to expire. The TTL then stops being
 * enforced and nothing says so.
 */
export function sweepEnrichmentCache({
  root = process.cwd(), dir: stateDir = null, now = new Date(), table = null, dryRun = false,
} = {}) {
  const ttl = table || loadTtlTable({ root });
  const gtm = resolveStateTree({ root, dir: stateDir, operation: 'retention sweep' });
  const dir = join(gtm, 'enrichment-cache');
  const report = {
    dir, ttl_source: ttl.source, dry_run: dryRun,
    // A retention sweep that will not say "your policy keeps this person 90 days"
    // is reporting on the wrong thing.
    ttl_notes: ttl.notes || [],
    ttl_widenings: ttl.widenings || [],
    files_scanned: 0, files_rewritten: 0,
    rows_kept: 0, rows_expired: 0, rows_unprovenanced: 0, rows_malformed: 0,
    by_endpoint: {},
  };
  if (!existsSync(dir)) return report;
  for (const file of walkFiles(dir)) {
    if (extname(file) !== '.jsonl') continue;
    report.files_scanned++;
    const kept = [];
    let changed = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let row;
      try { row = JSON.parse(line); }
      catch { report.rows_malformed++; report.rows_expired++; changed = true; continue; }
      const ep = typeof row.source_endpoint === 'string' && row.source_endpoint.trim()
        ? row.source_endpoint.trim() : null;
      if (!ep) { report.rows_unprovenanced++; report.rows_expired++; changed = true; continue; }
      const bucket = report.by_endpoint[ep] || (report.by_endpoint[ep] = { kept: 0, expired: 0, ttl_ms: ttlForEndpoint(ep, ttl) });
      if (isExpired(row, { now, table: ttl })) { bucket.expired++; report.rows_expired++; changed = true; }
      else { bucket.kept++; report.rows_kept++; kept.push(line); }
    }
    if (changed && !dryRun) {
      writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      report.files_rewritten++;
    } else if (changed) {
      report.files_rewritten++;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 3. git-tracked gtm/ detection (used by `setup`'s hard refusal)
// ---------------------------------------------------------------------------

/** True when `root` is inside a git work tree. */
export function isGitRepo(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === 'true';
  } catch { return false; }
}

/**
 * Files under the state tree (`dir`, default `gtm/`) that git already tracks
 * (index or HEAD).
 * A non-empty list means personal data is already in git history — `setup` REFUSES.
 */
export function gtmTrackedFiles(root, dir = GTM_DIR) {
  if (!isGitRepo(root)) return [];
  const name = typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : GTM_DIR;
  const seen = new Set();
  for (const args of [
    ['-C', root, 'ls-files', '--', `${name}/`],
    ['-C', root, 'ls-files', '--cached', '--', name],
  ]) {
    try {
      const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const l of out.split('\n')) if (l.trim()) seen.add(l.trim());
    } catch { /* not fatal: the other probe still runs */ }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// 4. /comply erase <email|domain>
// ---------------------------------------------------------------------------

export function sha256(s) { return createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/**
 * The floor on an erase target, in dot-separated labels.
 *
 * `com` and `io` are legal domain-matcher inputs and they match every address at
 * every `.com` and every `.io` URL in the tree. Two labels is the smallest thing
 * that can name an organisation; one label is only ever a public suffix, and a
 * public suffix is never a data subject. There is no undo, so this is a refusal
 * rather than a confirmation.
 *
 * It is a FLOOR, not a proof of narrowness: `co.uk` and `com.au` are two labels and
 * are still public suffixes. Blast radius above the floor is the fraction gate's job
 * (`eraseDecision`); this only removes the inputs no fraction could rescue.
 */
export const MIN_TARGET_LABELS = 2;

/** Normalise an erase target and build its boundary-safe matcher. */
export function makeTargetMatcher(rawTarget) {
  const t = String(rawTarget ?? '').trim().toLowerCase();
  if (t === '') throw new Error('erase: a target email or domain is required');
  const kind = t.includes('@') && !t.startsWith('@') ? 'email' : 'domain';
  let norm = t;
  if (kind === 'domain') {
    norm = norm.replace(/^https?:\/\//, '').replace(/^@/, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
    norm = norm.replace(/\.+$/, '');   // a trailing root dot is not a label
  }
  if (norm === '') throw new Error('erase: a target email or domain is required');
  if (kind === 'domain') {
    const labels = norm.split('.').filter(l => l !== '');
    if (labels.length < MIN_TARGET_LABELS) {
      throw new EraseTargetTooBroadError(
        `erase: \`${norm}\` is a bare TLD, not an erasure target — it matches every address `
        + `at every ${norm.startsWith('.') ? norm : '.' + norm} domain in gtm/. `
        + `An erase target needs at least ${MIN_TARGET_LABELS} labels (e.g. \`acme.${norm}\`).`,
        { target: norm, labels: labels.length },
      );
    }
  }
  const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // email: exact token, not a suffix of a longer local part (`xa@b.com` must not match `a@b.com`)
  // domain: the domain itself, any subdomain of it, or any address at it
  const re = kind === 'email'
    ? new RegExp(`(?<![\\w.+-])${esc}(?![\\w.-])`, 'gi')
    : new RegExp(`(?<![\\w.-])(?:[\\w.+-]+@)?(?:[\\w-]+\\.)*${esc}(?![\\w.-])`, 'gi');
  return {
    raw: rawTarget, kind, normalized: norm, sha256: sha256(norm),
    test: (s) => { re.lastIndex = 0; return typeof s === 'string' && re.test(s); },
    redact: (s) => String(s).replace(new RegExp(re.source, 'gi'), '[erased]'),
    count: (s) => { const m = String(s).match(new RegExp(re.source, 'gi')); return m ? m.length : 0; },
  };
}

/** Deep string search: does any string anywhere inside `v` match the target? */
export function valueMentions(v, matcher, depth = 0) {
  if (depth > 40) return false;
  if (typeof v === 'string') return matcher.test(v);
  if (Array.isArray(v)) return v.some(x => valueMentions(x, matcher, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some(x => valueMentions(x, matcher, depth + 1));
  return false;
}

/** Prune matching elements out of arrays, recursively. Returns [value, removedCount]. */
function pruneValue(v, matcher, depth = 0) {
  if (depth > 40) return [v, 0];
  if (Array.isArray(v)) {
    let removed = 0;
    const out = [];
    for (const el of v) {
      if (valueMentions(el, matcher, 0)) { removed++; continue; }
      const [pv, r] = pruneValue(el, matcher, depth + 1);
      removed += r; out.push(pv);
    }
    return [out, removed];
  }
  if (v && typeof v === 'object') {
    let removed = 0;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const [pv, r] = pruneValue(val, matcher, depth + 1);
      removed += r; out[k] = pv;
    }
    return [out, removed];
  }
  return [v, 0];
}

/** Recursively list files under a directory. */
export function walkFiles(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

const TEXT_LIKE = new Set(['.md', '.txt', '.html', '.htm', '.yaml', '.yml', '.tsv', '.log', '']);

// ---------------------------------------------------------------------------
// The blast-radius denominator.
//
// `erase_confirm_fraction` is a fraction, and for four months there was nothing in
// shipped code to divide by: the skill told the agent to divide the dry run's output
// by "the number of erasable rows stored under gtm/", a number the dry run did not
// return and nobody defined. Two agents computed two different denominators for the
// same gate, and neither number gated anything, because the gate was prose.
//
// So: ONE unit, defined here, counted the same way on both sides of the division.
//
// A UNIT is one erasable artifact:
//   .jsonl / .ndjson  one unit per non-blank line          (a cache row, a journal line)
//   .csv              one unit per data RECORD, not per physical line — a quoted field
//                     may span newlines, and miscounting that is the bug that once
//                     half-deleted a record and reported success
//   .json             an array is one unit per element; any other document is one unit
//   anything else     one unit per file (a research note, a copy draft)
//
// EXCLUDED from the denominator, because an erase cannot destroy them:
//   tombstones.jsonl  never rewritten — it IS the audit trail of erasures
//   consent.jsonl     the operator's own record, in ERASE_EXCLUDED for the same reason
//   suppression.jsonl entries are downgraded to hashes, not deleted
// Leaving any of them in would inflate the denominator, shrink the fraction and make
// the gate fire LESS often. Fail closed means the SMALLER denominator.
// ---------------------------------------------------------------------------

/** Files that an erase cannot destroy, and so cannot appear in the denominator. */
export const ERASE_DENOMINATOR_EXCLUDED = new Set([...ERASE_EXCLUDED, SUPPRESSION_FILE]);

/** How many erasable units one file holds. See the block comment above. */
export function erasableUnits(file) {
  const ext = extname(file).toLowerCase();
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return 1; }
  if (ext === '.jsonl' || ext === '.ndjson') {
    return src.split('\n').filter(l => l.trim() !== '').length;
  }
  if (ext === '.csv') {
    const rows = parseRows(src);
    return Math.max(0, rows.length - 1);   // minus the header
  }
  if (ext === '.json') {
    try { const d = JSON.parse(src); return Array.isArray(d) ? d.length : 1; }
    catch { return 1; }
  }
  return 1;
}

/**
 * The denominator: every erasable unit stored under `gtm/`.
 *
 * This is the number `erase_confirm_fraction` is a fraction OF. `erase()` returns it
 * as `erasable_rows_total` on every run, dry or live, measured BEFORE the sweep.
 */
export function countErasableRows(root = process.cwd(), { dir = null, gtm: gtmPath = null } = {}) {
  const gtm = gtmPath || resolveStateTree({ root, dir, operation: 'blast-radius count' });
  if (!existsSync(gtm)) return 0;
  let total = 0;
  for (const file of walkFiles(gtm)) {
    const rel = relative(gtm, file).split(sep).join('/');
    if (ERASE_DENOMINATOR_EXCLUDED.has(rel)) continue;
    total += erasableUnits(file);
  }
  return total;
}

/**
 * `/comply erase <email|domain>` — purge every artifact holding that person across
 * the whole `gtm/` tree and append a tombstone.
 *
 * Sweep coverage (the WHOLE tree, not a hand-listed subset — a directory added later
 * is swept automatically):
 *   gtm/lists/ · gtm/enrichment-cache/ · gtm/research/ · gtm/copy/ · gtm/org-maps/ ·
 *   gtm/deals/ · gtm/ads/ · gtm/runs/ (the run journal) · gtm/api-calls.jsonl and any
 *   other file in the tree.
 * Special cases:
 *   - gtm/tombstones.jsonl  — NEVER rewritten; it is the audit trail of erasures.
 *   - gtm/suppression.jsonl — plaintext identifiers are DOWNGRADED to their sha256
 *     (`email_sha256`/`domain_sha256`) rather than deleted: the person stays
 *     suppressed (they asked not to be contacted) without their address being
 *     retained in the clear.
 *
 * Idempotent: a second run finds nothing, changes no data file, and appends a second
 * tombstone recording that an erase request was made and matched zero artifacts.
 */
export function erase(target, { root = process.cwd(), dir = null, now = new Date(), dryRun = false, actor = null } = {}) {
  const matcher = makeTargetMatcher(target);
  // Resolved BEFORE the matcher's work is used and before anything is written, so a
  // mismatch throws instead of producing a report and a tombstone. Non-negotiable:
  // an erase that cannot see the real tree must not record a success.
  const gtm = resolveStateTree({ root, dir, operation: 'erase' });
  const report = {
    target: matcher.normalized,
    target_kind: matcher.kind,
    target_sha256: matcher.sha256,
    root, gtm_dir: gtm, dry_run: dryRun, ts: toIso(now),
    files_scanned: 0,
    files_touched: [],      // [{ path, action, count }]
    rows_removed: 0,
    occurrences_redacted: 0,
    artifacts_redacted: 0,  // UNITS altered in place, in the denominator's unit
    files_deleted: 0,
    suppression_hashed: 0,
    // Blast radius, in the unit `countErasableRows` counts. Measured BEFORE the
    // sweep so a live run reports the same fraction its own dry run did.
    erasable_rows_total: countErasableRows(root, { gtm }),
    impacted_rows: 0,
    impact_fraction: 0,
    tombstone_path: join(gtm, TOMBSTONE_FILE),
    tombstone: null,
  };

  if (existsSync(gtm)) {
    for (const file of walkFiles(gtm)) {
      const rel = relative(gtm, file).split(sep).join('/');
      if (ERASE_EXCLUDED.has(rel)) continue;
      report.files_scanned++;
      if (rel === SUPPRESSION_FILE) { eraseSuppression(file, rel, matcher, report, dryRun); continue; }
      const ext = extname(file).toLowerCase();
      if (ext === '.jsonl' || ext === '.ndjson') eraseJsonl(file, rel, matcher, report, dryRun);
      else if (ext === '.json')                  eraseJson(file, rel, matcher, report, dryRun);
      else if (ext === '.csv')                   eraseCsv(file, rel, matcher, report, dryRun);
      else if (TEXT_LIKE.has(ext))               eraseText(file, rel, matcher, report, dryRun);
      else                                       eraseText(file, rel, matcher, report, dryRun);
    }
  }

  // The numerator, in the SAME unit as the denominator. A redacted artifact counts:
  // the file survives but the personal data in it does not, and counting only outright
  // deletions would understate the sweep — the fail-open direction on a gate whose job
  // is to notice a sweep that is too wide.
  report.impacted_rows = report.rows_removed + report.files_deleted + report.artifacts_redacted;
  report.impact_fraction = report.erasable_rows_total > 0
    ? report.impacted_rows / report.erasable_rows_total
    : (report.impacted_rows > 0 ? 1 : 0);

  const tombstone = {
    schema_version: 1,
    ts: toIso(now),
    action: 'erase',
    target_kind: matcher.kind,
    target_sha256: matcher.sha256,   // hashed on purpose: the audit trail is not a PII store
    actor: actor || null,
    dry_run: dryRun,
    files_scanned: report.files_scanned,
    files_touched: report.files_touched.length,
    rows_removed: report.rows_removed,
    occurrences_redacted: report.occurrences_redacted,
    files_deleted: report.files_deleted,
    suppression_hashed: report.suppression_hashed,
    // The measured blast radius, so the audit trail records how wide the sweep was
    // and not merely that it happened.
    erasable_rows_total: report.erasable_rows_total,
    impacted_rows: report.impacted_rows,
    impact_fraction: report.impact_fraction,
    paths: report.files_touched.map(f => ({ path: f.path, action: f.action, count: f.count })),
    matched: report.files_touched.length > 0,
    tool: '@richapi/gtm-skills',
  };
  report.tombstone = tombstone;
  if (!dryRun) {
    mkdirSync(gtm, { recursive: true });
    appendFileSync(report.tombstone_path, JSON.stringify(tombstone) + '\n', 'utf8');
  }
  return report;
}

function touch(report, path, action, count) {
  report.files_touched.push({ path, action, count });
}

function eraseJsonl(file, rel, matcher, report, dryRun) {
  const src = readFileSync(file, 'utf8');
  const kept = [];
  let removed = 0;
  for (const line of src.split('\n')) {
    if (line.trim() === '') continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { /* unparseable: fall back to raw text match */ }
    const hit = obj === null ? matcher.test(line) : valueMentions(obj, matcher);
    if (hit) { removed++; continue; }
    kept.push(line);
  }
  if (removed === 0) return;
  if (!dryRun) writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  report.rows_removed += removed;
  touch(report, rel, 'rows_removed', removed);
}

function eraseJson(file, rel, matcher, report, dryRun) {
  const src = readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(src); } catch { return eraseText(file, rel, matcher, report, dryRun); }
  // A document whose own top-level scalars name the target IS about that person.
  const topLevelHit = doc && typeof doc === 'object' && !Array.isArray(doc)
    && Object.values(doc).some(v => typeof v === 'string' && matcher.test(v));
  if (topLevelHit) {
    if (!dryRun) rmSync(file, { force: true });
    report.files_deleted++;
    touch(report, rel, 'file_deleted', 1);
    return;
  }
  const [pruned, removed] = pruneValue(doc, matcher);
  if (removed === 0) {
    if (!valueMentions(doc, matcher)) return;
    // Mentioned only in scalar leaves inside nested objects: redact those strings.
    const [red, n] = redactStrings(doc, matcher);
    if (n === 0) return;
    if (!dryRun) writeFileSync(file, JSON.stringify(red, null, 2) + '\n', 'utf8');
    report.occurrences_redacted += n;
    // In denominator units: an array document is counted per element, so charge the
    // elements that actually mention the target; any other document is one unit.
    report.artifacts_redacted += Array.isArray(doc)
      ? doc.filter(el => valueMentions(el, matcher)).length
      : 1;
    touch(report, rel, 'redacted', n);
    return;
  }
  if (!dryRun) writeFileSync(file, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
  report.rows_removed += removed;
  touch(report, rel, 'rows_removed', removed);
}

function redactStrings(v, matcher, depth = 0) {
  if (depth > 40) return [v, 0];
  if (typeof v === 'string') {
    const n = matcher.count(v);
    return n ? [matcher.redact(v), n] : [v, 0];
  }
  if (Array.isArray(v)) {
    let n = 0; const out = [];
    for (const el of v) { const [rv, c] = redactStrings(el, matcher, depth + 1); n += c; out.push(rv); }
    return [out, n];
  }
  if (v && typeof v === 'object') {
    let n = 0; const out = {};
    for (const [k, val] of Object.entries(v)) { const [rv, c] = redactStrings(val, matcher, depth + 1); n += c; out[k] = rv; }
    return [out, n];
  }
  return [v, 0];
}

/**
 * Erase RECORDS, not physical lines.
 *
 * The pack's own writer quotes any value containing a newline and its reader accepts
 * them, so a record can span two physical lines. Splitting on newlines deleted the
 * half carrying the email and kept the name, phone and company, left an unterminated
 * quote that corrupted the rest of the file, and reported success. A deletion request
 * is the wrong place to be approximate.
 */
function eraseCsv(file, rel, matcher, report, dryRun) {
  const src = readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const rows = parseRows(src);
  if (rows.length === 0) return;

  const header = rows[0];
  const out = [header];
  let removed = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every(c => String(c).trim() === '')) continue;
    if (matcher.test(cells.join('\u0000'))) { removed++; continue; }
    out.push(cells);
  }

  const headerHits = matcher.count(header.join(','));
  if (removed === 0 && headerHits === 0) return;
  if (headerHits) out[0] = header.map(h => matcher.redact(h));
  if (!dryRun) writeFileSync(file, stringifyRows(out, eol), 'utf8');
  if (removed) { report.rows_removed += removed; touch(report, rel, 'rows_removed', removed); }
  if (headerHits) {
    report.occurrences_redacted += headerHits;
    // A column NAME is not a data row, so it has no unit of its own — but the file was
    // still rewritten, and a sweep that rewrote a file must not measure as zero. One
    // unit, the fail-closed direction on a blast-radius gate.
    report.artifacts_redacted += 1;
    touch(report, rel, 'redacted', headerHits);
  }
}

function eraseText(file, rel, matcher, report, dryRun) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { return; }
  const n = matcher.count(src);
  if (n === 0) return;
  if (!dryRun) writeFileSync(file, matcher.redact(src), 'utf8');
  report.occurrences_redacted += n;
  report.artifacts_redacted += 1;   // a research note or a copy draft is one unit
  touch(report, rel, 'redacted', n);
}

/**
 * suppression.jsonl: keep the person suppressed, drop the plaintext.
 * `{"email":"a@b.com"}` becomes `{"email_sha256":"…","erased_at":"…"}`.
 */
function eraseSuppression(file, rel, matcher, report, dryRun) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  let hashed = 0;
  for (const line of src.split('\n')) {
    if (line.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(line); } catch {
      if (matcher.test(line)) { hashed++; continue; } // unparseable + matching: drop it
      out.push(line); continue;
    }
    if (!valueMentions(obj, matcher)) { out.push(line); continue; }
    const next = { schema_version: obj.schema_version ?? 1 };
    if (typeof obj.email === 'string' && matcher.test(obj.email)) next.email_sha256 = sha256(obj.email.trim().toLowerCase());
    else if (typeof obj.email_sha256 === 'string') next.email_sha256 = obj.email_sha256;
    if (typeof obj.domain === 'string' && matcher.test(obj.domain)) next.domain_sha256 = sha256(obj.domain.trim().toLowerCase());
    else if (typeof obj.domain_sha256 === 'string') next.domain_sha256 = obj.domain_sha256;
    if (!next.email_sha256 && !next.domain_sha256) {
      // matched somewhere else in the record (e.g. a note): hash the target itself
      if (matcher.kind === 'email') next.email_sha256 = matcher.sha256;
      else next.domain_sha256 = matcher.sha256;
    }
    next.reason = typeof obj.reason === 'string' ? obj.reason : 'erasure_request';
    next.added_at = typeof obj.added_at === 'string' ? obj.added_at : null;
    next.erased_at = toIso(new Date());
    out.push(JSON.stringify(next));
    hashed++;
  }
  if (hashed === 0) return;
  if (!dryRun) writeFileSync(file, out.length ? out.join('\n') + '\n' : '', 'utf8');
  report.suppression_hashed += hashed;
  touch(report, rel, 'suppression_hashed', hashed);
}

/** Read the tombstone log (audit trail of every erase request). */
export function readTombstones({ root = process.cwd(), dir = null } = {}) {
  const p = join(dir ? resolve(root, dir) : join(root, GTM_DIR), TOMBSTONE_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 5. The erase gates — in the engine, not in the prose.
//
// `gates.yaml:skills.comply.erase_confirm_fraction` was declared early and the
// only implementation of it lived in `tests/skills/comply/harness.mjs`, which
// `package.json:files[]` does not publish. Shipped `erase()` loaded no gates, computed
// no fraction and asked nothing; the sole defence was a paragraph telling the agent to
// do the arithmetic. This file's own header says why that is not a defence:
// "Governance that lives in prose disappears. This is code."
//
// So the decision lives here, next to the thing it guards, and every caller — the CLI,
// the skill, a script, a future caller — gets it whether or not it read the SKILL.md.
// ---------------------------------------------------------------------------

export { ALLOW, CONFIRM, STOP };

export const ERASE_CONFIRM_GATE  = 'skills.comply.erase_requires_explicit_confirm';
export const ERASE_FRACTION_GATE = 'skills.comply.erase_confirm_fraction';

/**
 * Should this erase run?
 *
 * Gate 1 — `erase_requires_explicit_confirm`: erasure is irreversible, so it is never
 *          implicit. Unconfirmed target => CONFIRM, and nothing is measured or written.
 * Gate 2 — `erase_confirm_fraction`: measure with a DRY RUN (writes nothing, deletes
 *          nothing, appends no tombstone) and ask AGAIN when the sweep would take a
 *          larger share of stored units than the gate allows. This is the gate that
 *          stops a typo'd domain from emptying the cache in one keystroke.
 *
 * A missing or unusable gate key is STOP, never "no gate" (law 5). A sweep that cannot
 * be measured is CONFIRM, never ALLOW. A target below the label floor is STOP: no
 * amount of confirming makes `com` a data subject.
 */
export function eraseDecision({
  root = process.cwd(), dir = null, target, confirmed = false, sweepConfirmed = false,
  gates = loadGates(), now = new Date(),
} = {}) {
  // Gate 0.5 — which tree? Before any measurement, because an unmeasurable sweep and
  // a sweep measured against the wrong tree look identical from here: both report
  // zero. A mismatch is STOP, not CONFIRM: no amount of confirming makes the empty
  // default tree the one holding the data.
  try { resolveStateTree({ root, dir, operation: 'erase' }); }
  catch (e) {
    if (e instanceof StateTreeMismatchError) {
      return {
        verdict: STOP, gate: 'erase.state_tree', reason: e.message, failed_closed: true,
        requested: e.requested, candidates: e.candidates, target,
      };
    }
    throw e;
  }
  let requiresConfirm, threshold;
  try {
    requiresConfirm = gateValue(gates, ERASE_CONFIRM_GATE);
    threshold = gateValue(gates, ERASE_FRACTION_GATE);
  } catch (e) {
    if (e instanceof MissingGateKey) {
      return { verdict: STOP, gate: e.key, reason: `${e.message} — failing closed (law 5)`, failed_closed: true };
    }
    throw e;
  }
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return { verdict: STOP, gate: ERASE_FRACTION_GATE, reason: 'threshold is not a number', failed_closed: true };
  }

  // The label floor is not a confirmation, it is a refusal. Checked before gate 1 so
  // that `erase com` cannot be walked through by confirming twice.
  try { makeTargetMatcher(target); }
  catch (e) {
    if (e instanceof EraseTargetTooBroadError) {
      return { verdict: STOP, gate: 'erase.min_target_labels', reason: e.message, failed_closed: true, target };
    }
    // Anything else (empty target, unbuildable matcher) is unmeasurable, not refused.
    return { verdict: CONFIRM, gate: ERASE_FRACTION_GATE, reason: `sweep could not be measured (${e.message})`, failed_closed: true };
  }

  if (requiresConfirm !== false && confirmed !== true) {
    return {
      verdict: CONFIRM,
      gate: ERASE_CONFIRM_GATE,
      reason: 'erasure is irreversible and was not explicitly confirmed',
      target,
    };
  }

  // Measure without touching anything.
  let preview;
  try { preview = erase(target, { root, dir, now, dryRun: true }); }
  catch (e) {
    return { verdict: CONFIRM, gate: ERASE_FRACTION_GATE, reason: `sweep could not be measured (${e.message})`, failed_closed: true };
  }
  const impacted = preview.impacted_rows;
  const total = preview.erasable_rows_total;
  const fraction = preview.impact_fraction;

  if (fraction > threshold && sweepConfirmed !== true) {
    return {
      verdict: CONFIRM,
      gate: ERASE_FRACTION_GATE,
      reason: 'the sweep would take a larger share of stored rows than the gate allows',
      fraction, threshold, impacted, total, target, preview,
    };
  }
  return { verdict: ALLOW, fraction, threshold, impacted, total, target, preview };
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function toIso(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) throw new PiiProvenanceError(`unparseable date: ${d}`);
  return dt.toISOString();
}

/**
 * Create the state-tree skeleton (used by `setup`).
 *
 * `dir` names the tree, defaulting to `gtm`. No mismatch check here: creating a tree
 * beside an existing one is exactly what `--dir` is for. The refusal belongs on the
 * operations that SWEEP a tree, where picking the wrong one is silent.
 */
export function ensureGtmTree(root, dir = GTM_DIR) {
  const gtm = resolve(root, typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : GTM_DIR);
  mkdirSync(gtm, { recursive: true });
  for (const d of GTM_SUBDIRS) mkdirSync(join(gtm, d), { recursive: true });
  for (const f of [SUPPRESSION_FILE, TOMBSTONE_FILE]) {
    const p = join(gtm, f);
    if (!existsSync(p)) writeFileSync(p, '', 'utf8');
  }
  return gtm;
}

// ---------------------------------------------------------------------------
// CLI — `node _lib/pii.mjs erase <email|domain> [--root DIR] [--dir NAME] [--dry-run]`
//        `node _lib/pii.mjs sweep [--root DIR] [--dir NAME] [--dry-run]`
// `--dir` is the run's `--dir <gtm>`. Both commands REFUSE when it is omitted and more
// than one state tree exists under --root: see resolveStateTree().
// `/comply erase` shells out to this.
// ---------------------------------------------------------------------------

const USAGE_ERASE =
  'usage: pii.mjs erase <email|domain> [--root DIR] [--dir NAME] [--dry-run] [--json] [--confirm-sweep]';

function main(argv) {
  const cmd = argv[0];
  // `dir` stays null when unset. null means "the default gtm/, but only if it is
  // unambiguously the tree" — see resolveStateTree(). It is NOT the same as
  // `--dir gtm`, which asserts that gtm/ is the tree to sweep.
  const flags = { root: process.cwd(), dir: null, dryRun: false, json: false, confirmSweep: false };
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') flags.root = argv[++i];
    else if (a === '--dir') flags.dir = argv[++i];
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--confirm-sweep') flags.confirmSweep = true;
    else rest.push(a);
  }
  if (cmd === 'erase') {
    if (!rest[0]) { console.error(USAGE_ERASE); return 2; }

    // Gate 0 — the label floor. `erase com` is refused outright; there is no flag
    // that makes a bare TLD a data subject.
    try { makeTargetMatcher(rest[0]); }
    catch (e) {
      if (e instanceof EraseTargetTooBroadError) { console.error(`REFUSED: ${e.message}`); return 3; }
      console.error(String(e.message)); return 2;
    }

    // Gate 0.5 — which tree? Checked here too, and before --dry-run is honoured: a dry
    // run against the wrong tree prints "nothing matched", which reads as "already
    // erased" and is the exact wrong thing to tell someone about a live erasure request.
    try { resolveStateTree({ root: flags.root, dir: flags.dir, operation: 'erase' }); }
    catch (e) {
      if (e instanceof StateTreeMismatchError) { console.error(`REFUSED (STOP): ${e.message}`); return 3; }
      throw e;
    }

    // Gate 2 — blast radius. The CLI does its OWN dry run and its OWN arithmetic:
    // the caller may be a script, a skill, or a person, and none of them can be
    // relied on to have divided two numbers correctly before an irreversible write.
    // A missing gate key is STOP (law 5), never a bypass.
    //
    // Gate 1 (`erase_requires_explicit_confirm`) is about a conversation — the target
    // read back to the user — and the CLI cannot observe one. It is enforced by
    // `eraseDecision()` above, which the skill calls before it gets here. The CLI still
    // READS the key so that losing it in a merge stops the run rather than opening it.
    if (!flags.dryRun) {
      const d = eraseDecision({
        root: flags.root, dir: flags.dir, target: rest[0], confirmed: true,
        sweepConfirmed: flags.confirmSweep,
      });
      if (d.verdict !== ALLOW) {
        const pct = (v) => `${(v * 100).toFixed(1)}%`;
        console.error(`REFUSED (${d.verdict}): ${d.reason}`);
        console.error(`  gate: gates.yaml:${d.gate}`);
        if (typeof d.fraction === 'number') {
          console.error(`  the sweep would take ${d.impacted} of ${d.total} erasable row(s) `
            + `= ${pct(d.fraction)}, over the ${pct(d.threshold)} ceiling`);
          console.error('  re-run with --dry-run --json to see exactly what it would touch,');
          console.error('  then --confirm-sweep to proceed. Nothing has been written.');
        }
        return 3;
      }
    }

    const r = erase(rest[0], { root: flags.root, dir: flags.dir, dryRun: flags.dryRun });
    if (flags.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`erase ${r.target_kind} sha256:${r.target_sha256.slice(0, 12)}…  (${flags.dryRun ? 'DRY RUN' : 'applied'})`);
    console.log(`  scanned ${r.files_scanned} file(s) under ${r.gtm_dir}`);
    for (const f of r.files_touched) console.log(`  - ${f.path}: ${f.action} x${f.count}`);
    if (r.files_touched.length === 0) console.log('  - nothing matched (already erased, or never held)');
    console.log(`  blast radius: ${r.impacted_rows} of ${r.erasable_rows_total} erasable row(s) `
      + `= ${(r.impact_fraction * 100).toFixed(1)}%`);
    console.log(`  tombstone -> ${r.tombstone_path}`);
    return 0;
  }
  if (cmd === 'sweep') {
    let r;
    try { r = sweepEnrichmentCache({ root: flags.root, dir: flags.dir, dryRun: flags.dryRun }); }
    catch (e) {
      if (e instanceof StateTreeMismatchError) { console.error(`REFUSED (STOP): ${e.message}`); return 3; }
      throw e;
    }
    if (flags.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`cache sweep: kept ${r.rows_kept}, expired ${r.rows_expired} `
      + `(${r.rows_unprovenanced} unprovenanced, ${r.rows_malformed} malformed) `
      + `across ${r.files_scanned} file(s); ttl source: ${r.ttl_source}`);
    // A retention policy that RETAINS LONGER than the built-in class is the one thing
    // an operator must never learn about from a regulator first.
    for (const n of r.ttl_notes || []) console.log(`  ! ${n}`);
    for (const w of r.ttl_widenings || []) {
      console.log(`  · ${w.endpoint}: policy keeps ${w.resolved_days}d vs built-in `
        + `${w.builtin_days}d (${w.factor}x, via ${w.via})`);
    }
    return 0;
  }
  console.error('usage: pii.mjs <erase|sweep> [--root DIR] [--dir NAME] [...]');
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith(`${sep}pii.mjs`)) {
  process.exit(main(process.argv.slice(2)));
}
