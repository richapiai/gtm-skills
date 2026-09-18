// tests/skills/pre-meeting-briefing/helpers.mjs — test helpers.
// (Kept inside tests/skills/pre-meeting-briefing/ rather than the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export const SKILL = 'pre-meeting-briefing';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const SKILL_DIR = join(REPO_ROOT, 'skills', SKILL);
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

export function skillSource (name = SKILL) {
  return readFileSync(join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
}

/** The SKILL.md body, frontmatter stripped. Shape rules apply to the body only. */
export function skillBody (name = SKILL) {
  const src = skillSource(name);
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

/** The body with fenced code blocks removed — for prose-only assertions. */
export function skillProse (name = SKILL) {
  return skillBody(name).replace(/^```[\s\S]*?^```$/gm, '');
}

export const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));
export const owners  = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));

/** Every endpoint `_lib/endpoint-owners.yaml` assigns to a skill. */
export function ownedEndpoints (name = SKILL) {
  return new Set(
    Object.entries(owners.endpoints)
      .filter(([, skills]) => skills.includes(name))
      .map(([e]) => e)
  );
}

/**
 * Endpoint invocations in a SKILL.md body, using the SAME pattern the validator uses.
 * Copying the regex would let the two drift; this is deliberately the one unambiguous
 * form (`name(`), which is what the validator resolves against the catalog.
 */
export function invokedEndpoints (body) {
  return new Set([...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

/** Catalog endpoint names mentioned anywhere in the text, invoked or merely named. */
export function mentionedEndpoints (text) {
  const out = new Set();
  for (const name of Object.keys(catalog.endpoints ?? {})) {
    if (new RegExp(`\\b${name}\\b`).test(text)) out.add(name);
  }
  return out;
}

/** Gate keys the SKILL.md cites, as dotted paths. */
export function citedGateKeys (body) {
  return new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]));
}

/**
 * Split a body into `## ` sections: [{ heading, text }] in document order.
 * `###` subsections stay inside their parent.
 */
export function sections (body) {
  const out = [];
  let cur = { heading: '(preamble)', text: '' };
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { out.push(cur); cur = { heading: m[1].trim(), text: '' }; continue; }
    cur.text += line + '\n';
  }
  out.push(cur);
  return out;
}

/** The one section of `body` whose heading matches `re`. Throws if it is not unique. */
export function section (re, body) {
  const hits = sections(body).filter(s => re.test(s.heading));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one section matching ${re}, found ${hits.length}`
      + ` (${hits.map(h => h.heading).join(' | ')})`);
  }
  return hits[0];
}

/** Split a body into `###` subsections, so a `###` can be asserted on independently. */
export function subsections (body) {
  const out = [];
  let cur = { heading: '(preamble)', text: '' };
  for (const line of body.split('\n')) {
    const m = line.match(/^###\s+(.+)$/);
    if (m) { out.push(cur); cur = { heading: m[1].trim(), text: '' }; continue; }
    if (/^##\s+/.test(line)) { out.push(cur); cur = { heading: line.replace(/^##\s+/, '').trim(), text: '' }; continue; }
    cur.text += line + '\n';
  }
  out.push(cur);
  return out;
}

/** The one `##`-or-`###` block whose heading matches `re`. Throws if it is not unique. */
export function subsection (re, body) {
  const hits = subsections(body).filter(s => re.test(s.heading));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one sub/section matching ${re}, found ${hits.length}`
      + ` (${hits.map(h => h.heading).join(' | ')})`);
  }
  return hits[0];
}

/** The skills this body links to directly. */
export function directLinks (body) {
  return [...new Set([...body.matchAll(/\]\(\.\.\/([a-z0-9-]+)\/SKILL\.md\)/g)].map(m => m[1]))];
}

// --- sandbox ---------------------------------------------------------------

const tmpRoots = [];
export function tmpRoot (prefix = 'q5-pmb-') {
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
 * Every skill reachable from `roots` by `../<name>/SKILL.md` links, roots included.
 * Skills with no SKILL.md on disk are skipped, not queued as copies.
 */
export function linkClosure (roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const md = join(REPO_ROOT, 'skills', name, 'SKILL.md');
    if (!existsSync(md)) continue;
    seen.add(name);
    for (const m of readFileSync(md, 'utf8').matchAll(/\]\(\.\.\/([^/)]+)\/SKILL\.md\)/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return [...seen];
}

/**
 * A throwaway copy of the package holding ONLY the skills named (plus their link
 * closure), so the real validator can be run against this suite's output without other
 * skills' in-progress directories deciding whether this suite is green.
 */
export function validatorSandbox (skillNames) {
  const dir = tmpRoot('q5-pmb-validate-');
  mkdirSync(join(dir, '_lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  for (const f of ['api-catalog.json', 'gates.yaml', 'gates.mjs',
    'dual-contract.mjs', 'dual-contract.schema.json']) {
    cpSync(join(REPO_ROOT, '_lib', f), join(dir, '_lib', f));
  }
  cpSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), join(dir, 'scripts', 'validate-skills.mjs'));
  cpSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  for (const name of linkClosure(skillNames)) {
    cpSync(join(REPO_ROOT, 'skills', name), join(dir, 'skills', name), { recursive: true });
  }
  return dir;
}

/** Runs the real validator inside a sandbox. Returns { code, out }. */
export function runValidator (dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'validate-skills.mjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * Validator error/warning lines attributable to `label`.
 *
 * The sandbox is transitively closed, so it can still contain another skill
 * that links to something not yet written. Those errors are labelled with the LINKING
 * skill, so filtering by label is exact: a broken link in MY file is still my failure,
 * and a broken link in a neighbour's file is not.
 */
export function linesFor (out, label) {
  return out.split('\n').filter(l => l.includes(`skills/${label}:`)).map(l => l.trim());
}
