#!/usr/bin/env node
// Lints every SKILL.md: required frontmatter, semver, name matches dir,
// preflight preamble present, relative SKILL.md links resolve, and tool
// invocations (fn-call style or "MCP tool `x`") exist in api-catalog.json.
//
// Tool names are checked against _lib/api-catalog.json, which catalog-gen produces
// from the pinned openapi.yaml. Also runs the dual-contract check
// (_lib/dual-contract.mjs) and the bare-credit-number scan.
// Exits non-zero on any failure.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkillDualContract } from '../_lib/dual-contract.mjs';
import { scanForBareNumbers, loadGates, hasGate } from '../_lib/gates.mjs';

// Loaded once. An unloadable gates.yaml yields a sentinel whose every lookup
// fails, so rule 4 below turns a broken gates file into a loud validation
// failure rather than a silently permissive one.
const GATES = loadGates();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const SKILLS    = join(ROOT, 'skills');
const CATALOG   = join(ROOT, '_lib', 'api-catalog.json');

const REQUIRED_FRONTMATTER = ['name', 'version', 'description', 'allowed-tools', 'triggers'];
const PREAMBLE_MARKER      = 'richapi-skills-preflight';
const SEMVER_RE            = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

const errors = [];
const warnings = [];

function err (skill, msg) { errors.push(`✗ ${skill}: ${msg}`); }
function warn(skill, msg) { warnings.push(`! ${skill}: ${msg}`); }

if (!existsSync(CATALOG)) {
  console.error(`✗ missing ${CATALOG} — run: node bin/richapi-catalog-gen.mjs`);
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
// api-catalog.json keys endpoints by name; the legacy MCP tool-list catalog format used a tools[] array.
const knownTools = new Set(
  catalog.endpoints ? Object.keys(catalog.endpoints) : (catalog.tools || []).map(t => t.name)
);

function parseFrontmatter(src) {
  src = src.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { ok: false, reason: 'no frontmatter fence' };
  const end = src.indexOf('\n---\n', 4);
  if (end < 0) return { ok: false, reason: 'unterminated frontmatter fence' };
  const block = src.slice(4, end);
  const body  = src.slice(end + 5);
  const out = {};
  let pendingList = null;
  let pendingMultiline = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (pendingMultiline && (line.startsWith('  ') || line === '')) {
      out[pendingMultiline] = (out[pendingMultiline] || '') + line.trim() + ' ';
      continue;
    } else if (pendingMultiline) {
      pendingMultiline = null;
    }
    if (pendingList) {
      if (line.startsWith('  - ')) { pendingList.push(line.slice(4).trim()); continue; }
      if (line.startsWith('- '))    { pendingList.push(line.slice(2).trim()); continue; }
      pendingList = null;
    }
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!m) continue;
    const [ , key, val ] = m;
    if (val === '') {
      pendingList = [];
      out[key] = pendingList;
    } else if (val === '|' || val === '|-' || val === '>') {
      pendingMultiline = key;
      out[key] = '';
    } else {
      out[key] = val;
    }
  }
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = out[k].trim();
  }
  return { ok: true, frontmatter: out, body };
}

function inspectSkill(dir) {
  const label    = `skills/${dir}`;
  const skillDir = join(SKILLS, dir);
  const skillMd  = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return err(label, 'missing SKILL.md');

  const src = readFileSync(skillMd, 'utf8');
  const parsed = parseFrontmatter(src);
  if (!parsed.ok) return err(label, `frontmatter: ${parsed.reason}`);
  const { frontmatter: fm, body } = parsed;

  for (const key of REQUIRED_FRONTMATTER) {
    if (!(key in fm) || (Array.isArray(fm[key]) ? fm[key].length === 0 : !fm[key])) {
      err(label, `missing required frontmatter key: ${key}`);
    }
  }
  if (fm.name && fm.name !== dir)            err(label, `frontmatter name "${fm.name}" does not match directory "${dir}"`);
  if (fm.version && !SEMVER_RE.test(fm.version)) err(label, `version "${fm.version}" is not semver (x.y.z)`);
  if (!body.includes(PREAMBLE_MARKER))        err(label, `missing preflight preamble (grep "${PREAMBLE_MARKER}")`);

  // Only flag unambiguous invocations: `name(` or "MCP tool `name`".
  // Bare backticked identifiers are slot names / JSON keys / CRM fields, not tools.
  const invocationPatterns = [
    /`([a-z_][a-z0-9_]{3,})\(/g,
    /\bMCP tool\s+`([a-z_][a-z0-9_]{3,})`/g,
    /`([a-z_][a-z0-9_]{3,})`\s+MCP tool/g,
  ];
  let m;
  for (const re of invocationPatterns) {
    while ((m = re.exec(body)) !== null) {
      const tok = m[1];
      if (!knownTools.has(tok)) err(label, `invocation "${tok}" is not in api-catalog.json`);
    }
  }

  const linkRe = /\]\((\.\.\/[^)]+\/SKILL\.md)\)/g;
  while ((m = linkRe.exec(body)) !== null) {
    const target = resolve(skillDir, m[1]);
    if (!existsSync(target)) err(label, `broken link: ${m[1]}`);
  }

  // --- cross-module rules ---

  // Every ai_enrich template must $ref the dual contract and use the
  // one explicit null enum. `ai_enrich`'s output_schema only *guides* structured
  // output, so the pack has to enforce the shape itself.
  for (const msg of checkSkillDualContract({ label, body })) err(label, msg);

  // /launch is the sole writer of sender exports. Sending is external, so the
  // export file is the last artifact the pack controls; if anything can write it,
  // /comply and /campaign-review are advice rather than gates.
  //
  // Exact, not heuristic: naming the writer is unambiguous, so this is an ERROR.
  if (dir !== 'launch' && /\bwriteSenderExport\b/.test(body)) {
    err(label, 'references writeSenderExport, but only /launch may write a sender export. '
      + 'Hand off to /launch instead of writing the file.');
  }
  // The fuzzy case is a warning, because /sequence-builder legitimately discusses
  // sender-native syntax without ever writing a contact list.
  if (dir !== 'launch' && dir !== 'sequence-builder') {
    const SENDERS = /\b(smartlead|instantly|lemlist|woodpecker|reply\.io)\b/i;
    for (const para of body.split(/\n\s*\n/)) {
      if (SENDERS.test(para) && /\b(write|export|upload|push)\b/i.test(para) && /\b(csv|list|contacts|file)\b/i.test(para)) {
        warn(label, 'describes writing a contact list to a sender. Only /launch may do that; '
          + 'it writes the export bound to a PASS verdict and the list content hash.');
        break;
      }
    }
  }

  // A skill must never hand-roll a loop over an endpoint that has a bulk form.
  // The runtime chunks automatically and no skill ever chooses, because the credits
  // are IDENTICAL either way (enrich_profile 1cr/call vs enrich_profiles_bulk
  // 1cr/result) and only the latency and 429 exposure differ. A cost gate cannot see
  // this, so the validator has to. Heuristic, hence a warning rather than an error.
  const LOOPY = /\b(for each|loop over|loop through|iterate|one at a time|row by row|per row|per contact)\b/i;
  for (const para of body.split(/\n\s*\n/)) {
    if (!LOOPY.test(para)) continue;
    for (const [name, def] of Object.entries(catalog.endpoints ?? {})) {
      if (!def.bulk_variant) continue;
      if (!new RegExp(`\\b${name}\\b`).test(para)) continue;
      warn(label, `describes looping over \`${name}\`, which has a bulk form `
        + `(\`${def.bulk_variant}\`, max ${def.max_batch}). The runtime batches this; `
        + `a skill that loops it pays ~${def.max_batch}x the latency for the same credits.`);
    }
  }

  // --- BODY SHAPE CONTRACT ---------------------------------------------------
  //
  // Everything above this comment is a NEGATIVE law: don't type a credit
  // number, don't loop a bulk endpoint, don't write a sender export. None of
  // them say what a skill must actually CONTAIN, and the first two skills
  // drifted apart — /enrich-waterfall runs
  // "Before anything else / Step 1-4 / What this skill will not do / Related"
  // while /richapi-gtm runs "First, be honest / Route / Health check /
  // Closing a session / Related". Only `## Related` was common to both.
  //
  // With 33 skills that becomes 33 shapes, and the
  // dry-run -> approve -> run -> report sequence gets reinvented every time.
  // The spine below is deliberately thin: three rules, each one a thing a user
  // relies on being present, not a style preference.
  //
  // The contract and its rationale live in docs/skill-shape.md.

  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());

  // 1. Every skill says where to go next. A pack of 33 skills is unusable if
  //    each one is a dead end.
  if (!headings.some(h => /^related\b/i.test(h))) {
    err(label, 'missing a `## Related` section — every skill must route onward (docs/skill-shape.md)');
  }

  // 2. Every skill states its boundary. The pack's ceiling is the API's
  //    ceiling, and a skill that never says what it will not do invites the
  //    user to assume it does the thing that is deliberately external forever
  //    (sending, LinkedIn actions, dialing).
  if (!headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h))) {
    err(label, 'missing a boundary section (e.g. `## What this skill will not do`) — '
      + 'the pack ships a stated ceiling, and an unstated one reads as a promise (docs/skill-shape.md)');
  }

  // 3. LAW 3 — every paid call is named and costed before it runs. A skill that
  //    invokes a metered endpoint must show the user a plan first. We accept
  //    either a dry-run reference or a gates.yaml citation as evidence that it
  //    does; what we refuse is a skill that spends with neither.
  const meteredInvoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)]
    .map(m => m[1])
    .filter(t => {
      const def = catalog.endpoints?.[t];
      return def && def.pricing && def.pricing.metered !== false;
    });
  if (meteredInvoked.length > 0) {
    const showsPlan = /dry[- ]?run/i.test(body) || /gates\.yaml/.test(body);
    if (!showsPlan) {
      err(label, `invokes metered endpoint(s) ${[...new Set(meteredInvoked)].join(', ')} `
        + 'but never references a dry-run plan or a gates.yaml threshold — law 3 requires '
        + 'every paid call be named and costed before it runs (docs/skill-shape.md)');
    }
  }

  // 4. A cited gate key must actually resolve. This is what turns a gates.yaml
  //    key lost in a merge into a red CI run instead of a
  //    skill that silently reads STOP on every guarded call (law 5).
  for (const m of body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)) {
    if (!hasGate(GATES, m[1])) {
      err(label, `cites gates.yaml:${m[1]}, which does not resolve. `
        + 'Either the key was never added or a merge dropped it; a missing key reads as STOP (law 5).');
    }
  }

  // Law #1 — no skill carries a bare credit number. Thresholds live in
  // _lib/gates.yaml. A hand-typed number is stale within a quarter: 16 of 53
  // surviving endpoints were repriced in four months, phone_finder 3 -> 25.
  for (const hit of scanForBareNumbers(body, { file: `${label}/SKILL.md` })) {
    err(label, typeof hit === 'string' ? hit : (hit.message || JSON.stringify(hit)));
  }
}

const dirs = existsSync(SKILLS)
  ? readdirSync(SKILLS).filter(f => statSync(join(SKILLS, f)).isDirectory())
  : [];
if (dirs.length === 0) {
  // An empty skills/ (a runtime-only checkout) is reported, not failed.
  console.log('skills/: empty (expected in a runtime-only checkout). Catalog + rules loaded OK.');
  process.exit(0);
}
for (const d of dirs) inspectSkill(d);

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) console.log('  ' + w);
  console.log('');
}

if (errors.length > 0) {
  console.error('Errors:');
  for (const e of errors) console.error('  ' + e);
  console.error(`\nFailed: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`✓ ${dirs.length} skill(s) validated. ${warnings.length} warning(s).`);
