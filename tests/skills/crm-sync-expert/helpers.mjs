// tests/skills/crm-sync-expert/helpers.mjs — test helpers.
//
// Scoped to two skills (/crm-sync-expert and /outreach-expert).
// tests/skills/outreach-expert/ IMPORTS this file rather than copying it: two copies
// of a validator sandbox drift, and a drifted sandbox is a green run that proves
// nothing. Nothing here lives in the shared tests/helpers/.
//
// Nothing here re-implements a shipped engine. Gate lookups go through _lib/gates.mjs
// and the catalog is read from _lib/api-catalog.json, so a change to either surfaces
// here as a failing test rather than as two copies of a rule quietly disagreeing.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** The two advisory CRM/outreach skills. Both are advisory; neither owns an endpoint. */
export const SUITE_SKILLS = ['crm-sync-expert', 'outreach-expert'];

export const skillDir = (name) => join(REPO_ROOT, 'skills', name);
export const skillMd  = (name) => join(skillDir(name), 'SKILL.md');

export function skillSource (name) {
  return readFileSync(skillMd(name), 'utf8').replace(/\r\n/g, '\n');
}

/** The SKILL.md body, frontmatter stripped. Every shape rule applies to the body. */
export function skillBody (name) {
  const src = skillSource(name);
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

export function frontmatterBlock (name) {
  const src = skillSource(name);
  if (!src.startsWith('---\n')) throw new Error(`${name}: no frontmatter fence`);
  const end = src.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(`${name}: unterminated frontmatter fence`);
  return src.slice(4, end);
}

export function headings (body) {
  return [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
}

/** The section under the first heading matching `re`, up to the next `##`. */
export function section (body, re) {
  const start = body.search(re);
  if (start < 0) return '';
  const rest = body.slice(start + 1);
  const end = rest.search(/^##\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}

export const boundarySection = (body) =>
  section(body, /^#{2,3}\s+.*(will not|won't do|not in scope|boundar|limitations)/im);

/**
 * Endpoint INVOCATIONS, using the SAME unambiguous form the validator resolves against
 * the catalog. Copying its regex is deliberate: any other pattern here would let the
 * test and the linter disagree about what "invokes" means.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

/**
 * Every bare `snake_case` token the body sets in backticks. The validator does NOT
 * check these — it treats a bare backticked identifier as a slot name or a CRM field,
 * which is right for its purposes and wrong for ours: an advisory skill that names no
 * endpoint in call form can still invent one in prose, and that is exactly the defect
 * found in both earlier versions of these skills.
 */
export function backtickedIdentifiers (body) {
  return new Set([...body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(m => m[1]));
}

export function loadCatalog () {
  return JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
}

export function loadOwners () {
  return parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
}

/** Endpoints `_lib/endpoint-owners.yaml` assigns to `name`. */
export function ownedEndpoints (name) {
  const owners = loadOwners();
  return new Set(
    Object.entries(owners.endpoints)
      .filter(([, skills]) => Array.isArray(skills) && skills.includes(name))
      .map(([endpoint]) => endpoint)
  );
}

// ---------------------------------------------------------------------------
// Sandbox — so this suite's green is attributable to this suite
// ---------------------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'crm-sync-expert-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
export function cleanupTmp () {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on('exit', cleanupTmp);

/**
 * A throwaway copy of the package holding ONLY the named skills, so the REAL validator
 * can run over this suite's output without another skill's in-progress SKILL.md deciding
 * whether this suite is green. Many skills land in one skills/ directory at once, and
 * at the time of writing the unrelated `inbound` skill links to a
 * `sequence-builder` that does not exist yet — which fails the whole-repo run and says
 * nothing at all about these two files.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('crm-sync-expert-validate-');
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs',
                   'dual-contract.mjs', 'dual-contract.schema.json']) {
    cpSync(join(REPO_ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  for (const name of skillNames) {
    cpSync(join(REPO_ROOT, 'skills', name), join(dir, 'skills', name), { recursive: true });
  }
  return dir;
}

/**
 * The transitive closure of `../<skill>/SKILL.md` links reachable from `seeds`.
 * Rule 1 makes the validator resolve every relative link, so the sandbox needs every
 * link target — and copying the closure proves that everything this suite points at
 * actually exists, while staying isolated from skills this suite does not reference.
 */
export function linkClosure (seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const md = join(REPO_ROOT, 'skills', name, 'SKILL.md');
    if (!existsSync(md)) continue;          // reported by the validator, not swallowed here
    seen.add(name);
    for (const m of readFileSync(md, 'utf8').matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)) {
      queue.push(m[1]);
    }
  }
  return [...seen].sort();
}

export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ---------------------------------------------------------------------------
// /launch is the sole writer of a sender-format export
// ---------------------------------------------------------------------------

/**
 * The validator's own sole-writer heuristic, re-run here. The linter emits it as a WARNING and
 * the suite's definition of done is "zero warnings", so a warning that only ever shows
 * up in a whole-repo run — where another skill's noise can bury it — is not enough.
 * These two regexes are copied verbatim from scripts/validate-skills.mjs.
 */
export const RULED_SENDERS = /\b(smartlead|instantly|lemlist|woodpecker|reply\.io)\b/i;

export function senderExportParagraphs (body) {
  return body.split(/\n\s*\n/).filter(p =>
    RULED_SENDERS.test(p) && /\b(write|export|upload|push)\b/i.test(p) && /\b(csv|list|contacts|file)\b/i.test(p));
}

// ---------------------------------------------------------------------------
// "Did we just claim the thing we cannot do?"
// ---------------------------------------------------------------------------

const NEGATOR = /\b(?:no|not|nothing|never|neither|nor|without|cannot|refuses?|forbid\w*)\b/i;

/**
 * Lines that read as a COMPLETED action, ignoring the ones that deny it.
 *
 * Both of this suite's skills are advisory, so their most useful sentences are denials
 * — "no message was sent", "nothing was configured". A naive scan flags exactly those
 * and pushes an author towards vaguer copy, which is the opposite of the point. A match
 * is therefore only a finding when no negation precedes it on the same line.
 */
export function completedActionClaims (body, patterns) {
  const found = [];
  for (const line of body.split('\n')) {
    for (const re of patterns) {
      const m = re.exec(line);
      re.lastIndex = 0;
      if (!m) continue;
      if (NEGATOR.test(line.slice(0, m.index))) continue;
      found.push(line.trim());
      break;
    }
  }
  return found;
}
