// tests/skills/icp-review/helpers.mjs — test helpers for /icp-review.
//
// The generic pieces come from the sibling directory rather than being copied: both
// directories belong to this suite, and two copies of a validator sandbox drift into a
// green run that proves nothing. Nothing here reaches into another skill's tests, and
// the shared tests/helpers/ is untouched.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { REPO_ROOT, tmpRoot, validatorSandbox, runValidator, linkClosure,
         invokedEndpoints, fencedBlock } from '../gtm-kickoff/helpers.mjs';

export { REPO_ROOT, tmpRoot, validatorSandbox, runValidator, linkClosure,
         invokedEndpoints, fencedBlock };

export const SKILL_NAME = 'icp-review';
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL_NAME);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource () {
  return readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
}

export function skillBody () {
  const src = skillSource();
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

/**
 * The `icp-rules` table, loaded out of the shipped SKILL.md. There is no default:
 * a default rule table is exactly how a deleted rule goes unnoticed.
 */
export function loadIcpRules ({ path = SKILL_MD } = {}) {
  if (!existsSync(path)) throw new Error(`no SKILL.md at ${path}`);
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const doc = parseYaml(fencedBlock(src, 'icp-rules', path));
  if (!doc || typeof doc !== 'object') throw new Error('the icp-rules block did not parse to a map');
  return doc;
}
