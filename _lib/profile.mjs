// _lib/profile.mjs — the SELLER, and the user's standing rules.
//
// WHY THIS MODULE EXISTS
//
// The pack was built API-first, so every artifact it persists is the output of a paid
// call: `gtm/icp.yaml` because searches produce it, `gtm/learnings.jsonl` because the
// run journal produces it. There is no endpoint that returns "who is the user and what
// do they sell", so nothing in that process was ever going to create one — and the hole
// showed up where it hurts most. /personalize grounds every claim in research about the
// PROSPECT and refuses unsupported claims, while nothing in the pack tells it what the
// user is offering. The offer got re-supplied by hand every session, or invented.
//
// Two files, both local, both plain, neither produced by an endpoint:
//
//   gtm/profile.yaml       the seller. One document, overwritten.
//   gtm/preferences.jsonl  the standing dos and don'ts. Append-only, never rewritten.
//
// THE READ SEMANTICS ARE THE POINT (law 5).
//
//   absent     -> a legible state, NOT a stop. A pack that refused to run without a
//                 profile would be a pack nobody could try. Readers say so out loud and
//                 carry on, except where carrying on would mean inventing the offer.
//   unreadable -> STOP. Corrupt YAML, a truncated line, a preference the reader cannot
//                 parse: never "no rules". Silently reading a broken "never contact
//                 Series A" file as an empty rule set is the suppression failure mode
//                 wearing different clothes, and it is the one this pack exists to
//                 prevent.
//
// Neither file is ever uploaded. There is no network in this module and no place to add
// one. `gtm/` is PII (law 7): profile.yaml carries the user's own company details and
// preferences.jsonl can quote a customer, so both live inside the tree the TTL sweep
// walks and `/comply` can erase.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import YAML from 'yaml';

import { GTM_DIR } from './pii.mjs';

export const PROFILE_FILE = 'profile.yaml';
export const PREFERENCES_FILE = 'preferences.jsonl';

export const profilePath = (root = process.cwd(), dir = GTM_DIR) => join(root, dir, PROFILE_FILE);
export const preferencesPath = (root = process.cwd(), dir = GTM_DIR) => join(root, dir, PREFERENCES_FILE);

/**
 * Fields a profile may carry. Everything is optional EXCEPT the three a reader would
 * otherwise have to invent — see REQUIRED below. Unknown keys are preserved on write
 * rather than dropped, because a user who hand-edits this file is doing the right thing.
 */
export const PROFILE_FIELDS = [
  'company',        // the selling company's name
  'website',        // its domain — the one input the pre-fill step can use
  'what_we_sell',   // one sentence, in the user's words
  'wedge',          // the problem urgent enough that a stranger replies
  'proof',          // list: customers, numbers, logos the user is allowed to cite
  'tone',           // how outreach should read
  'sender',         // name, title, signature block
  'routing',        // who owns which inbound
  'never_claim',    // list: things the user must never let a draft assert
  'updated',        // ISO date, set on write
];

/**
 * The three a draft cannot be written without. `proof` is deliberately NOT here: a
 * seller with no citable proof is a real and common state, and forcing a value would
 * manufacture one — which is the defect /personalize already refuses.
 */
export const REQUIRED = ['company', 'what_we_sell', 'wedge'];

/** A preference line. `scope` names who reads it; `rule` is the user's own words. */
export const PREFERENCE_SCOPES = [
  'copy',        // how drafts read: tone, banned phrases, what never to claim
  'targeting',   // who to include or exclude, beyond what the ICP encodes
  'sequence',    // step count, spacing, channel order
  'routing',     // who gets which inbound or reply
  'compliance',  // standing instructions the user imposes on top of /comply
  'spend',       // standing budget posture
];

/**
 * Read the seller profile.
 *
 * @returns {{status:'ok'|'absent'|'unreadable', profile:object|null, missing:string[], reason:string|null, path:string}}
 */
export function loadProfile ({ root = process.cwd(), dir = null, path = null } = {}) {
  const p = path ?? profilePath(root, dir ?? GTM_DIR);
  if (!existsSync(p)) {
    return { status: 'absent', profile: null, missing: [...REQUIRED], reason: null, path: p };
  }

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { status: 'unreadable', profile: null, missing: [], reason: `cannot read: ${e.code ?? e.message}`, path: p };
  }

  let doc;
  try {
    doc = YAML.parse(raw);
  } catch (e) {
    // NOT "absent". A profile the reader cannot parse is a profile whose `never_claim`
    // list it also cannot read, and proceeding would drop a standing prohibition.
    return { status: 'unreadable', profile: null, missing: [], reason: `invalid YAML: ${e.message}`, path: p };
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 'unreadable', profile: null, missing: [], reason: 'not a YAML mapping', path: p };
  }

  const missing = REQUIRED.filter((k) => {
    const v = doc[k];
    return v === undefined || v === null || String(v).trim() === '';
  });

  return { status: 'ok', profile: doc, missing, reason: null, path: p };
}

/** Write the profile, stamping `updated`. Creates gtm/ if setup has not run. */
export function writeProfile (profile, { root = process.cwd(), dir = null, path = null, now = new Date() } = {}) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('writeProfile: a profile must be an object');
  }
  const p = path ?? profilePath(root, dir ?? GTM_DIR);
  mkdirSync(dirname(p), { recursive: true });

  // Known fields first, in declared order, then anything the user added by hand.
  const out = {};
  for (const k of PROFILE_FIELDS) if (k !== 'updated' && profile[k] !== undefined) out[k] = profile[k];
  for (const k of Object.keys(profile)) if (!(k in out) && k !== 'updated') out[k] = profile[k];
  out.updated = now.toISOString().slice(0, 10);

  writeFileSync(p, YAML.stringify(out), 'utf8');
  return { path: p, profile: out };
}

/**
 * Append one standing rule. Append-only: a preference is never edited in place, because
 * "we used to do X and stopped" is itself the useful record. Supersede by adding a new
 * line that says so.
 */
export function addPreference (entry, { root = process.cwd(), dir = null, path = null, now = new Date() } = {}) {
  const { scope, rule, why = null, source = 'user' } = entry ?? {};
  if (!PREFERENCE_SCOPES.includes(scope)) {
    throw new TypeError(`addPreference: scope must be one of ${PREFERENCE_SCOPES.join(', ')}`);
  }
  if (typeof rule !== 'string' || rule.trim() === '') {
    throw new TypeError('addPreference: a rule needs the user\'s own words');
  }
  const p = path ?? preferencesPath(root, dir ?? GTM_DIR);
  mkdirSync(dirname(p), { recursive: true });

  const line = { ts: now.toISOString(), scope, rule: rule.trim(), why, source };
  appendFileSync(p, `${JSON.stringify(line)}\n`, 'utf8');
  return line;
}

/**
 * Read the standing rules, newest last.
 *
 * A single unparseable line makes the WHOLE read `unreadable`. Skipping it would mean
 * silently dropping one of the user's standing prohibitions, and the caller has no way
 * to know which one it was.
 *
 * @returns {{status:'ok'|'absent'|'unreadable', preferences:object[], reason:string|null, path:string}}
 */
export function loadPreferences ({ root = process.cwd(), dir = null, path = null, scope = null } = {}) {
  const p = path ?? preferencesPath(root, dir ?? GTM_DIR);
  if (!existsSync(p)) return { status: 'absent', preferences: [], reason: null, path: p };

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    return { status: 'unreadable', preferences: [], reason: `cannot read: ${e.code ?? e.message}`, path: p };
  }

  const out = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { status: 'unreadable', preferences: [], reason: `line ${i + 1} is not JSON`, path: p };
    }
    if (row === null || typeof row !== 'object' || typeof row.rule !== 'string' || !PREFERENCE_SCOPES.includes(row.scope)) {
      return { status: 'unreadable', preferences: [], reason: `line ${i + 1} is not a preference`, path: p };
    }
    out.push(row);
  }

  return {
    status: 'ok',
    preferences: scope ? out.filter((r) => r.scope === scope) : out,
    reason: null,
    path: p
  };
}

/**
 * One line for a preflight or a skill header, so "the pack does not know who you are"
 * is visible rather than inferred from bland output.
 */
export function profileStatus (opts = {}) {
  const prof = loadProfile(opts);
  const prefs = loadPreferences(opts);

  if (prof.status === 'unreadable') return { state: 'STOP', text: `PROFILE: unreadable — ${prof.reason}` };
  if (prefs.status === 'unreadable') return { state: 'STOP', text: `PREFERENCES: unreadable — ${prefs.reason}` };
  if (prof.status === 'absent') return { state: 'ABSENT', text: 'PROFILE: none — run /gtm-onboard (0 credits)' };
  if (prof.missing.length > 0) return { state: 'PARTIAL', text: `PROFILE: incomplete — missing ${prof.missing.join(', ')}` };
  return { state: 'OK', text: `PROFILE: ok${prefs.preferences.length ? ` — ${prefs.preferences.length} standing rule(s)` : ''}` };
}
