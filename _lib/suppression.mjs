// _lib/suppression.mjs — the fail-closed suppression store.
//
// Law 5: **Fail closed.** A suppressed contact never reaches an output list.
//
// `gtm/suppression.jsonl` starts EMPTY AND HONEST — no suppression sources exist
// today, and pretending otherwise would be worse than nothing. Empty is a valid,
// readable store meaning "zero entries". MISSING is not: a missing or unreadable
// store is STOP, never "nothing suppressed". Unproven fail-closed suppression is one
// of the gaps that had no test and no error handling before this module.
//
// Entry shapes (one JSON object per line):
//   {"email":"a@b.com","reason":"unsubscribe","added_at":"2026-08-28T00:00:00Z","source":"manual"}
//   {"domain":"acme.com","reason":"do_not_contact"}
//   {"email_sha256":"…"}      <- what `/comply erase` downgrades a plaintext entry to
//   {"domain_sha256":"…"}
//
// Hashed entries keep a person suppressed after their address has been erased. A
// lookup therefore matches on the normalised value OR on its sha256.
//
// Zero runtime deps. Node >= 18, ESM.

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GTM_DIR, SUPPRESSION_FILE } from './pii.mjs';
// One CSV escaper for the whole pack. This writer used to keep a private copy that
// quoted /[",\n]/ while the shared helper quoted /[",\n\r]/, so a bare CR was quoted
// by one and left raw by the other — and Excel and most CRM importers treat a lone CR
// as a row break, splitting one record into two. Two opinions about what a field is,
// at the one point that writes the file.
import { escapeField } from './csv.mjs';

export class SuppressionUnavailableError extends Error {
  constructor(msg, { path = null, cause = null } = {}) {
    super(msg);
    this.name = 'SuppressionUnavailableError';
    this.path = path;
    this.verdict = 'STOP';
    if (cause) this.cause = cause;
  }
}

export function sha256(s) { return createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/**
 * A contact, masked for a terminal: `ada@acme.example` -> `a***@acme.example`.
 *
 * Every skill that refuses a row wants to name the row it refused, and the obvious
 * way — printing the address — writes personal data into scrollback, CI logs and
 * whatever ticket the operator pastes it into. None of those are `gtm/`, so none of
 * them are gitignored, TTL-swept or reachable by `/comply erase` (law 7).
 *
 * The mask keeps what an operator needs to recognise the record (the domain, the
 * first character, and the row number the caller prints beside it) and destroys the
 * local part, which is the identifying half. It is one-way and is NEVER a key: match
 * on the normalised value or its sha256, never on this.
 */
export function maskContact(value) {
  const v = String(value ?? '').trim();
  if (v === '') return '';
  const at = v.lastIndexOf('@');
  if (at >= 1) return v[0] + '***@' + v.slice(at + 1);
  // A phone number keeps its last four digits and nothing else. `+***` was technically
  // masked and operationally useless: on a phone-only list every stop printed the same
  // three characters, so the operator could not tell which row the gate was refusing.
  // Four trailing digits are how a person recognises their own number on a receipt, and
  // they cannot be dialled — the country code, area code and prefix are all destroyed.
  if (PHONEISH.test(v)) {
    const digits = v.replace(/\D/g, '');
    if (digits.length >= 7) return '***' + digits.slice(-4);
  }
  return v[0] + '***';                              // a domain, or a bare token
}

/** Punctuation a written phone number uses, and nothing an e-mail or domain does. */
const PHONEISH = /^[+()\-.\s\d]+$/;

/**
 * Where the store lives. `dir` is the run's `--dir <gtm>` state-tree name; omitting it
 * means the default `gtm/`.
 *
 * This takes `dir` because `_lib/run.mjs` honours `--dir` and had to hand-build the
 * path (`path.resolve(root, dir, 'suppression.jsonl')`) to do it — a second opinion
 * about where the store is, next to the one place that is supposed to know.
 */
export function suppressionPath(root = process.cwd(), dir = GTM_DIR) {
  const name = typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : GTM_DIR;
  // resolve, not join: an absolute `--dir /x/gtm` is that directory, and join() glued
  // it under root (`<root>/x/gtm`), which fails closed on a store that exists.
  return resolve(root, name, SUPPRESSION_FILE);
}

/**
 * Normalise an address to the bare mailbox, lowercased.
 *
 * This unwraps the RFC 5322 name-addr form, and that is not cosmetic — it is law 5.
 * An opt-out arrives as a `From:` header, which is `"Jane Doe" <jane@acme.com>` far
 * more often than it is a bare address. `addSuppressionEntry` accepts whatever the
 * reply handler passes it, so without this the store learns
 * `"jane doe" <jane@acme.com>` while every prospect list on disk carries
 * `jane@acme.com` — the two never match, `isSuppressed` answers false, and a person
 * who unsubscribed is contacted again.
 *
 * That failure is silent in the worst way: the stored form matches ITSELF, so a test
 * that round-trips one string through both halves passes while the real pairing
 * (header in, list out) is broken.
 *
 * Fixing it here rather than at the write path is deliberate. `normEmail` is the one
 * function the load path (line ~116), the probe (`isSuppressed`) and the two write
 * paths in `addSuppressionEntry` all share, so both sides converge on the same key —
 * and a store that ALREADY contains wrapped entries starts matching correctly the
 * next time it is loaded, with no migration.
 */
function normEmail(s) {
  const raw = String(s).trim().toLowerCase();
  // name-addr: take the last angle-bracket group, which is the addr-spec. A display
  // name may itself contain brackets, so the last group wins, not the first.
  const open = raw.lastIndexOf('<');
  if (open !== -1) {
    const close = raw.indexOf('>', open + 1);
    if (close > open) {
      const inner = raw.slice(open + 1, close).trim();
      // Only unwrap when what we found is actually an address. Anything else means
      // this was not a name-addr and the caller's own string is the safer key.
      if (inner.includes('@') && !inner.startsWith('@')) return inner;
    }
  }
  return raw;
}
function normDomain(s) {
  return String(s).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^@/, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}
function domainOfEmail(e) {
  const at = e.lastIndexOf('@');
  return at < 0 ? '' : normDomain(e.slice(at + 1));
}

/**
 * Load the suppression store.
 * Throws SuppressionUnavailableError (verdict STOP) when the file is missing,
 * unreadable, or contains a line we cannot parse. There is no "assume empty" path:
 * an empty FILE is empty; an ABSENT file is a stop.
 */
export function loadSuppressionStore({ root = process.cwd(), dir = null, path = null } = {}) {
  const file = path || suppressionPath(root, dir ?? GTM_DIR);
  if (!existsSync(file)) {
    throw new SuppressionUnavailableError(
      `suppression store missing at ${file} — STOP. Run \`setup\` to create it. `
      + 'A missing store is never read as "nothing suppressed".',
      { path: file },
    );
  }
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (e) {
    throw new SuppressionUnavailableError(
      `suppression store unreadable at ${file} (${e.code || e.message}) — STOP`,
      { path: file, cause: e },
    );
  }
  const store = {
    path: file,
    emails: new Set(), domains: new Set(),
    emailHashes: new Set(), domainHashes: new Set(),
    entries: [], count: 0,
  };
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) {
      throw new SuppressionUnavailableError(
        `suppression store corrupt at ${file}:${i + 1} — STOP (refusing to run an output list `
        + 'against a store we cannot fully read)',
        { path: file, cause: e },
      );
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new SuppressionUnavailableError(
        `suppression store corrupt at ${file}:${i + 1}: not an object — STOP`, { path: file });
    }
    let recognised = false;
    if (typeof obj.email === 'string' && obj.email.trim()) {
      const e = normEmail(obj.email);
      store.emails.add(e); store.emailHashes.add(sha256(e)); recognised = true;
    }
    if (typeof obj.domain === 'string' && obj.domain.trim()) {
      const d = normDomain(obj.domain);
      store.domains.add(d); store.domainHashes.add(sha256(d)); recognised = true;
    }
    if (typeof obj.email_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(obj.email_sha256)) {
      store.emailHashes.add(obj.email_sha256.toLowerCase()); recognised = true;
    }
    if (typeof obj.domain_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(obj.domain_sha256)) {
      store.domainHashes.add(obj.domain_sha256.toLowerCase()); recognised = true;
    }
    if (!recognised) {
      throw new SuppressionUnavailableError(
        `suppression store has an unrecognised entry at ${file}:${i + 1} — STOP. `
        + 'Expected one of: email, domain, email_sha256, domain_sha256.',
        { path: file },
      );
    }
    store.entries.push(obj);
    store.count++;
  }
  return store;
}

/**
 * Preflight-style probe. Never throws — returns a verdict.
 * `{ status: 'OK', count }` or `{ status: 'STOP', reason }`.
 */
export function suppressionStatus({ root = process.cwd(), dir = null, path = null } = {}) {
  try {
    const store = loadSuppressionStore({ root, dir, path });
    return { status: 'OK', count: store.count, path: store.path };
  } catch (e) {
    return { status: 'STOP', reason: e.message, path: e.path || (path || suppressionPath(root, dir ?? GTM_DIR)) };
  }
}

/** `a.b.example` -> ['a.b.example', 'b.example'] (suffixes of >= 2 labels). */
function domainSuffixes(d) {
  const parts = d.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 <= parts.length; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/** A domain is suppressed if it, or any parent domain of it, is in the store. */
function domainSuppressed(store, d) {
  if (!d) return false;
  for (const suffix of domainSuffixes(d)) {
    if (store.domains.has(suffix)) return true;
    if (store.domainHashes.size && store.domainHashes.has(sha256(suffix))) return true;
  }
  return false;
}

/** Is this email/domain suppressed? `store` must be a loaded store. */
export function isSuppressed(store, value) {
  if (!store || !(store.emails instanceof Set)) {
    throw new SuppressionUnavailableError('isSuppressed: no suppression store loaded — STOP');
  }
  if (typeof value !== 'string' || value.trim() === '') return false;
  const v = value.trim().toLowerCase();
  if (v.includes('@') && !v.startsWith('@')) {
    const e = normEmail(v);
    if (store.emails.has(e) || store.emailHashes.has(sha256(e))) return true;
    return domainSuppressed(store, domainOfEmail(e));
  }
  return domainSuppressed(store, normDomain(v));
}

const DEFAULT_FIELDS = ['email', 'work_email', 'personal_email', 'email_address', 'domain', 'company_domain', 'website'];

/** `Work Email` / `EMAIL` / `contact-email` all normalise to `workemail` / `email` / `contactemail`. */
function normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
const DEFAULT_KEYSET = new Set(DEFAULT_FIELDS.map(normKey));

/** Looks like an email or a bare domain. Used to scan values we were not told about. */
const EMAILISH  = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const DOMAINISH = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*)?$/i;

/**
 * How deep, and how much, the scan will read.
 *
 * `run.mjs` in `pages` mode writes RAW API JSON: `readResultRows` unwraps
 * `elements[]` / `results[]` / `data[]`, and `people_search`, `lead_search` and
 * `linkedin_company_employees_search` all nest the contact one or two levels under
 * that (`elements[].profile.contact.emails[]`). A top-level-only scan returned []
 * for every one of them and the run reported `0 suppressed` — a fail-OPEN with the
 * artifact that proves enforcement claiming it was enforced.
 *
 * So the scan recurses. Bounds exist only so a hostile or runaway payload cannot hang
 * the writer, and are set far above anything a real response reaches. Measured on
 * full live responses (2026-09-17): the deepest address sits 8 levels into a bulk
 * profile body, and a 50-post company feed page is ~4,900 nodes. `richapi call` then
 * wraps the body one level down in a row's `response` field.
 *   MAX_DEPTH  16     — twice the deepest recorded address (8), plus the wrapper.
 *   MAX_NODES  100000 — ~20x the largest recorded page; still a bounded, fast walk.
 * Cycles are cut by object identity, so a self-referencing payload terminates.
 *
 * Honest about the residual: exhausting the budget stops the scan, which is fail-OPEN
 * for the unscanned remainder. The bounds are set where no real payload reaches them,
 * and the alternative — throwing — was rejected because it fails loudly rather than
 * closed. If a real shape is ever found near a bound, raise the bound; do not narrow
 * the scan.
 */
const MAX_DEPTH = 16;
const MAX_NODES = 100000;

/**
 * Every candidate identifier on a row, at any nesting depth.
 *
 * SCAN-ALL is the default, and the column list is only an optimisation hint. The law
 * is "a suppressed contact never reaches an output list", and a real CSV comes out of
 * Salesforce or HubSpot with `Email`, `Work Email` or `EMAIL`. Matching an exact
 * lowercase key let an unsubscribed contact through under five of six ordinary
 * spellings, which is a fail-OPEN at the one place the law is enforced.
 *
 * So: normalise the key (case and punctuation), additionally test every string value
 * that LOOKS like an email or a domain whatever its column is called, and walk into
 * nested objects and arrays rather than skipping them. Recursion fails CLOSED — the
 * buried address is found and the row is dropped — where refusing the row would only
 * fail loudly, and where skipping it fails open in silence.
 *
 * An array element inherits its parent's key, so `{ "Work Email": ["a@b.com"] }` is
 * read the same way as `{ "Work Email": "a@b.com" }`.
 */
export function rowIdentifiers(row, fields = DEFAULT_FIELDS) {
  if (typeof row === 'string') return [row];
  if (!row || typeof row !== 'object') return [];
  const wanted = fields === DEFAULT_FIELDS ? DEFAULT_KEYSET : new Set(fields.map(normKey));
  const out = new Set();
  const seen = new Set();   // cycle guard: object identity, not deep equality
  let budget = MAX_NODES;

  const visit = (node, key, depth) => {
    if (budget <= 0) return;
    budget -= 1;
    if (typeof node === 'string') {
      const val = node.trim();
      if (!val) return;
      if (wanted.has(normKey(key)) || EMAILISH.test(val) || DOMAINISH.test(val)) out.add(val);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (depth >= MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { if (budget <= 0) return; visit(item, key, depth + 1); }
    } else {
      for (const [k, v] of Object.entries(node)) { if (budget <= 0) return; visit(v, k, depth + 1); }
    }
  };
  visit(row, '', 0);
  return [...out];
}

/**
 * Filter an output list. THIS is the enforcement point — no output list is built
 * any other way. Fails closed: without a readable store nothing passes.
 * Dropped rows map to the journal's `skipped_suppressed` status.
 */
export function filterOutputList(rows, { store = null, root = process.cwd(), dir = null, fields = DEFAULT_FIELDS } = {}) {
  const s = store || loadSuppressionStore({ root, dir }); // throws => STOP
  const kept = [], dropped = [];
  for (const row of rows) {
    const ids = rowIdentifiers(row, fields);
    const hit = ids.find(id => isSuppressed(s, id));
    if (hit) dropped.push({ row, matched: hit, status: 'skipped_suppressed' });
    else kept.push(row);
  }
  return { kept, dropped, store: s };
}

/**
 * Write an output list (.jsonl or .csv) through the suppression filter.
 * There is no unfiltered writer: a suppressed contact cannot reach an output list
 * because the only way to produce one runs this function, and this function refuses
 * to run without a readable store.
 */
// An object cell (run.mjs's `response_json`) is serialised HERE, after the suppression
// scan above has walked it as an object — never before, or a nested address hides in a string.
const csvCell = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

export function writeOutputList(file, rows, {
  root = process.cwd(), dir = null, store = null, fields = DEFAULT_FIELDS, format = null, columns = null,
} = {}) {
  const { kept, dropped, store: s } = filterOutputList(rows, { store, root, dir, fields });
  const fmt = format || (file.toLowerCase().endsWith('.csv') ? 'csv' : 'jsonl');
  mkdirSync(dirname(file), { recursive: true });
  let body;
  if (fmt === 'csv') {
    const cols = columns || [...new Set(kept.flatMap(r => Object.keys(r || {})))];
    // escapeField, not a local copy: it neutralises a leading =, +, -, @, TAB or CR so
    // the file cannot execute when the rep opens it in Excel, Sheets, HubSpot or
    // Salesforce, and it quotes CR the same way the reader does. Header cells go
    // through it too — in `pages` mode the column names are raw API keys.
    body = [cols.map(escapeField).join(','),
      ...kept.map(r => cols.map(c => escapeField(csvCell(r?.[c]))).join(','))].join('\n') + '\n';
  } else {
    body = kept.map(r => JSON.stringify(r)).join('\n');
    if (body) body += '\n';
  }
  writeFileSync(file, body, 'utf8');
  return { file, written: kept.length, suppressed: dropped.length, dropped, store_count: s.count };
}

/** Append a suppression entry. Normalises and de-duplicates. */
export function addSuppressionEntry(entry, { root = process.cwd(), dir = null, path = null, now = new Date() } = {}) {
  const file = path || suppressionPath(root, dir ?? GTM_DIR);
  const rec = { schema_version: 1 };
  if (typeof entry === 'string') {
    const v = entry.trim();
    if (v.includes('@') && !v.startsWith('@')) rec.email = normEmail(v);
    else rec.domain = normDomain(v);
  } else if (entry && typeof entry === 'object') {
    if (entry.email) rec.email = normEmail(entry.email);
    if (entry.domain) rec.domain = normDomain(entry.domain);
    if (entry.email_sha256) rec.email_sha256 = String(entry.email_sha256).toLowerCase();
    if (entry.domain_sha256) rec.domain_sha256 = String(entry.domain_sha256).toLowerCase();
    if (entry.reason) rec.reason = String(entry.reason);
    if (entry.source) rec.source = String(entry.source);
  }
  if (!rec.email && !rec.domain && !rec.email_sha256 && !rec.domain_sha256) {
    throw new Error('addSuppressionEntry: need one of email, domain, email_sha256, domain_sha256');
  }
  rec.added_at = (now instanceof Date ? now : new Date(now)).toISOString();
  if (!existsSync(file)) {
    throw new SuppressionUnavailableError(
      `suppression store missing at ${file} — run \`setup\` before adding entries`, { path: file });
  }
  appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** Create the store if absent. Called by `setup`; starts empty and honest. */
export function ensureSuppressionStore(root = process.cwd(), dir = GTM_DIR) {
  const file = suppressionPath(root, dir);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '', 'utf8');
  return file;
}
