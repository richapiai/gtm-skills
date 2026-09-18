// Runs the gate script that ships INSIDE skills/comply/SKILL.md.
//
// Same reasoning as tests/skills/launch/skill-runner.mjs, and deliberately the same
// shape: the /comply gate is only real if the thing the user runs is the thing that
// refuses. So this extracts the fenced script out of the shipped SKILL.md and runs it
// verbatim. A skill whose script rots fails here rather than passing on a helper.
//
// Lives under tests/skills/comply/ because it serves only this directory; it does not touch tests/skills/launch/skill-runner.mjs, which it imports
// for the other two scripts.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PACK_ROOT, runScript } from '../launch/skill-runner.mjs';

export { PACK_ROOT, runScript };

export const COMPLY_SKILL_MD = path.join(PACK_ROOT, 'skills', 'comply', 'SKILL.md');

/** Pull the fenced ```js block whose first line carries `marker` out of comply's SKILL.md. */
export function extractComplyScript (marker = '==== gtm-comply v1 ====') {
  const src = fs.readFileSync(COMPLY_SKILL_MD, 'utf8');
  const blocks = [...src.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.split('\n', 1)[0].includes(marker));
  if (!hit) {
    throw new Error('skills/comply/SKILL.md no longer carries a ```js block marked "' + marker + '". '
      + 'The gate the tests exercise is the one the skill ships; if the script moved, move these tests with it.');
  }
  return hit;
}

export const COMPLY_SCRIPT = () => extractComplyScript();
export const runComply = (env) => runScript(COMPLY_SCRIPT(), env);

/** The `stopped[]` rows of a verdict on disk, keyed by row number. */
export function readVerdictFile (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every suppression entry, raw, so a test can assert exactly what was written. */
export function suppressionLines (root) {
  const file = path.join(root, 'gtm', 'suppression.jsonl');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export { spawnSync };

// ---------------------------------------------------------------------------
// Fixture rows.
//
// Every existing list fixture in the pack predates the compliance gate having a
// mechanism, so none of them carries a jurisdiction signal and all of them are
// refused by the shipped table (correctly — an unresolved jurisdiction is a stop).
// These builders produce a list that CAN clear, so a test can then break exactly one
// thing and see exactly one refusal.
// ---------------------------------------------------------------------------

export const LIST_COLS = [
  'email', 'first_name', 'last_name', 'company_name', 'website', 'linkedin_url',
  'email_verification_status', 'subject_country', 'subject_region', 'lawful_basis', 'consent_kind',
  'consent_event', 'consent_timestamp', 'consent_record_id', 'lia_record_id',
  'data_source', 'unsubscribe_mechanism', 'objection', 'notice_at_collection',
  // `phone` is empty by default, so it changes no hash (listContentHash skips empty
  // values) and no existing verdict. It exists so a test can build a CALL list — a row
  // with a number and no address — which is the list /comply could never clear.
  'phone',
  'address_type',
];

/** One GDPR row that clears every condition in the shipped table. */
export function clearRow (n, over = {}) {
  const base = {
    email: `p${n}@e${n}.example`,
    first_name: `First${n}`, last_name: `Last${n}`, company_name: `Co${n}`,
    website: `e${n}.example`, linkedin_url: `https://li/${n}`, email_verification_status: 'valid',
    subject_country: 'DE', subject_region: '',
    lawful_basis: 'legitimate_interest', consent_kind: '', consent_event: '',
    consent_timestamp: '', consent_record_id: '', lia_record_id: `LIA-${n}`,
    data_source: 'conference-list-2026', unsubscribe_mechanism: 'true', phone: '',
    objection: '', notice_at_collection: '', address_type: '',
  };
  const row = { ...base, ...over };
  return LIST_COLS.map((c) => String(row[c] ?? '')).join(',');
}

export const csvOf = (rows) => [LIST_COLS.join(','), ...rows].join('\n') + '\n';
