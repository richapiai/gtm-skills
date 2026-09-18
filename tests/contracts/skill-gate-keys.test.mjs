// tests/contracts/skill-gate-keys.test.mjs
//
// The enforcer two files already claimed existed.
//
//   _lib/gates.yaml, rule 4 of the `skills:` namespace:
//     "`tests/contracts/skill-gate-keys.test.mjs` asserts that every
//      `gates.yaml:<key>` cited by a shipped SKILL.md actually resolves."
//   docs/skill-shape.md says the same thing.
//
// Until this file was written, neither sentence was true. That is the failure
// class this file exists to close, and it is bigger than one missing test:
//
//   1. `_lib/activation.mjs` read seven `activation.*` keys that gates.yaml did
//      not declare. Every read failed closed, so every band rendered
//      "YELLOW / thresholds not configured" forever. Code read config nobody
//      wrote.
//   2. `request_page_multipliers` was declared with thirty lines of reasoning
//      and a test asserting it is DECLARED. No runtime file read it. Config
//      nobody wrote code for.
//   3. Thirteen skills shipped prose saying a gate key was "not yet merged into
//      _lib/gates.yaml" about keys that had since landed. Prose describing a
//      state of the world that stopped being true.
//
// Every one of these is the same shape: the description of a control and the
// control itself were written by different agents, and only the description was
// reviewed. Four directions, one per side of the join:
//
//   cited     every `gates.yaml:<key>` a shipped SKILL.md CITES resolves.
//   absent    no SKILL.md claims a key is ABSENT when it resolves.
//   read      every key a shipped skill or a `_lib/`/`bin/` module READS is declared.
//   declared  every key gates.yaml DECLARES is read by something.
//
// The cited-key check is duplicated from scripts/validate-skills.mjs on purpose: a lint that is
// not also a test dies quietly the day someone loosens the validator, and this
// half of the contract is the half two files promise in writing.
//
// EVERYTHING IS DERIVED. The key list comes from gates.yaml, the skill list from
// the filesystem, the reader list from the source. There is no hard-coded array
// of skill names or of keys anywhere below except the ALLOWANCES table, which is
// dated, reasoned, and self-deleting (see the allowance hygiene test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGates, gateKeys, hasGate } from '../../_lib/gates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT   = resolve(__dirname, '..', '..');
const SKILLS = join(ROOT, 'skills');

const GATES = loadGates();
/** Every declared leaf, dotted. From gates.yaml — never a literal. */
const LEAVES = gateKeys(GATES);
/** Every top-level block name in gates.yaml. The alphabet a gate key starts with. */
const ROOTS  = Object.keys(GATES).filter(k => k !== '__unloadable');

// --- reading the tree ------------------------------------------------------

/** Shipped skills, from the filesystem. A skill added tomorrow is covered tomorrow. */
function shippedSkills () {
  return readdirSync(SKILLS)
    .filter(d => statSync(join(SKILLS, d)).isDirectory())
    .filter(d => existsSync(join(SKILLS, d, 'SKILL.md')))
    .sort();
}

function skillBody (dir) {
  return readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
}

function walkFiles (dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** `_lib/` and `bin/` sources: .mjs modules plus extensionless executables. */
function runtimeSources () {
  return [...walkFiles(join(ROOT, '_lib')), ...walkFiles(join(ROOT, 'bin'))]
    .filter(p => /\.mjs$/.test(p) || !/\./.test(p.split('/').pop()))
    .sort();
}

// --- what counts as naming a gate key --------------------------------------

// A dotted path whose FIRST segment is a top-level block of gates.yaml. The
// alphabet is read out of gates.yaml, so a new block is covered the day it lands.
const DOTTED_KEY = new RegExp(
  `(?<![\\w.:/-])(?:${ROOTS.join('|')})(?:\\.[a-z0-9_]+)+(?![\\w-])`, 'gi');

// `activation.json` and `gates.yaml` are filenames that happen to start with a
// block name. A trailing file extension is never a gate key.
const LOOKS_LIKE_A_FILENAME = /\.(?:json|jsonl|mjs|cjs|js|ts|yaml|yml|md|csv|tsv|txt|sh|html|lock|py|log)$/i;

/** The canonical citation form the validator and docs/skill-shape.md know. */
const CITATION = /gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)*)/gi;

/** Dotted gate keys named anywhere in a chunk of text, citation form or bare. */
function keysNamedIn (text) {
  const out = new Set();
  for (const m of String(text).matchAll(CITATION)) out.add(m[1]);
  for (const m of String(text).matchAll(DOTTED_KEY)) {
    const k = m[0];
    if (LOOKS_LIKE_A_FILENAME.test(k)) continue;
    out.add(k);
  }
  return out;
}

/** Keys cited in the canonical `gates.yaml:<key>` form only. */
function citationsIn (text) {
  return new Set([...String(text).matchAll(CITATION)].map(m => m[1]));
}

/** `gateValue(g, 'k')` / `hasGate(g, 'k')` with a literal key. A read, unambiguously. */
function callSiteReads (text) {
  const out = new Set();
  for (const m of String(text).matchAll(
    /\b(?:gateValue|hasGate)\s*\(\s*[^,()]*,\s*(['"`])([^'"`]+)\1/g)) out.add(m[2]);
  return out;
}

/**
 * Every key a RUNTIME source reads. Call sites, plus dotted key literals — the
 * `GATE_KEYS = Object.freeze({...})` tables in `_lib/activation.mjs` and
 * `_lib/setup-sweep.mjs` hold their keys as plain strings, and finding 1 lived
 * in exactly that shape. A dotted string starting with a gates.yaml block name,
 * inside a module, is a gate key: there is nothing else it could be.
 */
function runtimeReads (src) {
  const out = new Set(callSiteReads(src));
  for (const m of src.matchAll(/(['"`])((?:[a-z0-9_]+)(?:\.[a-z0-9_]+)+)\1/gi)) {
    const k = m[2];
    if (LOOKS_LIKE_A_FILENAME.test(k)) continue;
    if (!ROOTS.includes(k.split('.')[0])) continue;
    out.add(k);
  }
  return out;
}

// A SKILL.md is mostly prose, and the pack's convention is to name a key it does
// NOT yet have bare, in a request block (see skills/research-agent/SKILL.md). So
// for a skill, only an explicit call site counts as a READ. Whether the bare
// mention is honest is the absence-claim check's job, not the read check's.
const skillReads = callSiteReads;

// ---------------------------------------------------------------------------
// cited — every cited key resolves
// ---------------------------------------------------------------------------

test('every gates.yaml:<key> cited by a shipped SKILL.md resolves', () => {
  const findings = [];
  for (const dir of shippedSkills()) {
    for (const key of citationsIn(skillBody(dir))) {
      if (!hasGate(GATES, key)) findings.push(`skills/${dir}/SKILL.md cites gates.yaml:${key}`);
    }
  }
  assert.deepEqual(findings, [],
    'a cited gate key does not resolve. A missing key reads as STOP (law 5), so the skill '
    + 'refuses every call the key guards while its own tests stay green. Either the key was '
    + 'never added or a merge dropped the hunk:\n\n  - ' + findings.join('\n  - ') + '\n');
});

test('the cited-key check is a TEST and not only a lint, and the files that promise it still name it', () => {
  // The whole reason this file exists is that two files described a control by
  // filename and the file was not there. Close the loop in the only direction a
  // test can: if this file is renamed or deleted, whoever does it is told which
  // two sentences they have just made false again.
  // `_lib/gates.yaml` names this file. `docs/skill-shape.md` rule 4 states the same
  // contract without naming a file, so it is not asserted here — it goes stale by a
  // different route, and the cited-key check itself is what keeps its claim true.
  const promisers = ['_lib/gates.yaml'];
  const silent = promisers.filter(p => !readFileSync(join(ROOT, p), 'utf8').includes('skill-gate-keys.test.mjs'));
  assert.deepEqual(silent, [],
    'these files used to promise tests/contracts/skill-gate-keys.test.mjs by name and no '
    + 'longer do. Either the promise was dropped (fine — say so here too) or this file was '
    + 'renamed and the promise is stale again, which is the exact bug it was written for.');

  // scripts/validate-skills.mjs enforces the same rule as a lint. A lint runs when
  // somebody runs it; the two sentences above promise a TEST.
  const validator = readFileSync(join(ROOT, 'scripts', 'validate-skills.mjs'), 'utf8');
  assert.ok(validator.includes('hasGate('),
    'validate-skills.mjs no longer resolves cited gate keys — the cited-key test above is now the only '
    + 'enforcement of rule 4 of docs/skill-shape.md, so the duplication note is stale');
  assert.ok(shippedSkills().length >= 2, 'a one-skill tree cannot exercise a cross-skill contract');
});

// ---------------------------------------------------------------------------
// absent — no SKILL.md claims a key is absent when it resolves
// ---------------------------------------------------------------------------
//
// THE PREDICATE, in one sentence: a finding is a gate key that RESOLVES and is
// named inside the region governed by an ASSERTIVE, PRESENT-TENSE claim that
// gates.yaml does not (yet) carry it.
//
// The three parts each carry weight:
//
//   ASSERTIVE. "Requested and not yet merged into `_lib/gates.yaml`" states a
//   fact about the tree. "If this key is missing the skill stops" states a rule
//   about behaviour, and is required by law 5 — every skill in the pack says
//   some version of it, and it stays legal forever because it is true whether
//   or not the key is there. The discriminator is the CONDITIONAL: a sentence
//   scoped by if / when / whenever / where / unless / should, or built around
//   the noun phrase "a missing gate key", is a fail-closed instruction and is
//   never a claim of absence. That single rule is what separates
//
//       "Four thresholds do not exist in `_lib/gates.yaml` yet."     -> a claim
//       "`/comply` refuses when the gate key does not exist."        -> a rule
//
//   GOVERNED REGION. Claims and keys are usually not in the same sentence. The
//   pack's house style is a paragraph of claim followed by a fenced list or a
//   table of keys ("## Thresholds this skill needs"), or a comment block inside
//   a shipped script followed by the reader that uses them. So a claim governs:
//   the keys in its own sentence, plus the block that immediately follows its
//   paragraph, plus — for a claim inside a code fence — the lines after the
//   comment run, stopping at a blank line or the next comment.
//
//   RESOLVES. A claim about a key that really is absent is honest and must stay
//   legal. skills/local-business-prospecting/SKILL.md says it needs its own
//   clamp key under its own namespace and does not have one; the only key it
//   NAMES in that paragraph is `gates.yaml:skills.tam_map.directory_max_pages_per_request`,
//   cited as something the pack ALREADY holds. Sentence-scoping keeps the cited
//   key out of the claim's region, and the un-named key it actually lacks cannot
//   be flagged because there is nothing to look up. Both are correct.
//
// The predicate is exercised against its own fixtures below, so a future
// widening that starts shouting at fail-closed prose fails here, in this file,
// rather than in somebody's review.

/** Present-tense assertions that gates.yaml does not carry a key. */
const ABSENCE_CLAIM = [
  // "Requested and not yet merged into `_lib/gates.yaml`", "NOT YET IN gates.yaml"
  /\bnot\s+yet\s+(?:merged|added|applied|present|in|declared)\b/i,
  // "Four thresholds do not exist in `_lib/gates.yaml` yet"
  // The gaps allow dots: the thing between the noun and the phrase is usually a
  // dotted key or `_lib/gates.yaml`, and excluding dots is what made the first
  // draft of this predicate silently miss every claim that named its key.
  /\b(?:threshold|thresholds|key|keys|gate|gates)\b[^;]{0,120}?\bdo(?:es)?\s+not\s+exist\b/i,
  // "there is no `skills.tam_map.max_pages_per_run` key yet"
  /\b(?:there\s+is|there\s+are)\s+no\b[^;]{0,90}?\bkeys?\b[^;]{0,24}?\byet\b/i,
  /\bno\s+such\s+(?:gate\s+)?keys?\b/i,
  // "until the orchestrator adds them", "until they land"
  /\buntil\s+(?:the\s+orchestrator|they|these|them|it|the\s+merge)\b[^.;]{0,90}?\b(?:add|adds|added|apply|applies|applied|merge|merges|merged|land|lands|landed|has\s+applied)\b/i,
  // "citing an absent one is a broken citation", "citing an unresolvable key"
  /\bcit(?:e|ing)\s+an?\s+(?:absent|unresolvable|nonexistent)\b/i,
  // "requested rather than added", "requested and not yet merged"
  /\brequested\s+(?:rather\s+than\s+added|instead\s+of\s+added)\b/i,
];

/**
 * What turns an absence-shaped sentence back into a fail-closed instruction.
 * These are required prose (law 5) and must never be flagged.
 */
const CONDITIONAL = /\b(?:if|when|whenever|where|unless|should|were)\b/i;
const MISSING_KEY_RULE = /\b(?:a|any|the)\s+missing\s+(?:gate\s+)?keys?\b/i;

/** Sentence-ish units. `gates.yaml`'s dot is never followed by a space, so it survives. */
const sentences = (text) => String(text).split(/(?<=[.!?;])\s+/).filter(s => s.trim());

function isAbsenceClaim (sentence) {
  if (MISSING_KEY_RULE.test(sentence)) return null;
  for (const re of ABSENCE_CLAIM) {
    const m = re.exec(sentence);
    if (!m) continue;
    // A conditional anywhere BEFORE the phrase scopes it: "…refuses when the
    // gate key it reads does not exist" is a rule, not a claim.
    if (CONDITIONAL.test(sentence.slice(0, m.index))) continue;
    return m[0].trim();
  }
  return null;
}

const isCommentLine  = (l) => /^\s*(?:#|\/\/|--|\*|\/\*)/.test(l);
const isFenceDelim   = (l) => /^\s*(?:```|~~~)/.test(l);
const isTableLine    = (l) => /^\s*\|/.test(l);
const isListOrHeading = (l) => /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s)/.test(l);

/**
 * A SKILL.md as an ordered list of units:
 *   { kind: 'prose', text }        one paragraph or one list item, rewrapped
 *   { kind: 'block', lines }       one fenced block, or one run of table rows
 * Blocks keep their lines because an in-fence claim governs by line proximity.
 */
function unitsOf (src) {
  let s = String(src).replace(/\r\n/g, '\n');
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---\n', 4);
    if (end >= 0) s = s.slice(end + 5);
  }
  const lines = s.split('\n');
  const units = [];
  let prose = null;
  const flushProse = () => {
    if (prose && prose.trim()) units.push({ kind: 'prose', text: prose.replace(/\s+/g, ' ').trim() });
    prose = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceDelim(line)) {
      flushProse();
      const body = [];
      for (i++; i < lines.length && !isFenceDelim(lines[i]); i++) body.push(lines[i]);
      units.push({ kind: 'block', lines: body });
      continue;
    }
    if (isTableLine(line)) {
      flushProse();
      const body = [];
      for (; i < lines.length && isTableLine(lines[i]); i++) body.push(lines[i]);
      i--;
      units.push({ kind: 'block', lines: body });
      continue;
    }
    if (!line.trim()) { flushProse(); continue; }
    if (isListOrHeading(line) || prose === null) { flushProse(); prose = line; }
    else prose += ' ' + line;
  }
  flushProse();
  return units;
}

/** How far an in-fence comment's claim reaches down the block. */
const FENCE_WINDOW = 8;

/**
 * Every false key-absence claim in one SKILL.md.
 * @returns {{claim:string, key:string, where:string}[]}
 */
export function falseKeyAbsenceClaims (src, resolves = (k) => hasGate(GATES, k)) {
  const units = unitsOf(src);
  const out = [];
  const record = (claim, keys, where) => {
    for (const key of keys) {
      if (!resolves(key)) continue;                 // still-true claim: honest, leave it
      // Only a declared LEAF is reported. A namespace ("the four
      // skills.scheduled_workflow.* keys") resolves as an object and naming it in
      // the finding says nothing a reader can act on; the leaves under it, picked
      // up from the lines the claim governs, do.
      if (!LEAVES.includes(key)) continue;
      if (out.some(f => f.claim === claim && f.key === key)) continue;
      out.push({ claim, key, where });
    }
  };

  units.forEach((unit, idx) => {
    if (unit.kind === 'prose') {
      const next = units[idx + 1];
      let governsNext = false;
      for (const sentence of sentences(unit.text)) {
        const claim = isAbsenceClaim(sentence);
        if (!claim) continue;
        record(claim, keysNamedIn(sentence), 'the sentence itself');
        governsNext = true;
      }
      // A claim paragraph immediately followed by a fence or a table governs it:
      // that block IS the enumeration the claim is about.
      if (governsNext && next && next.kind === 'block') {
        const claim = sentences(unit.text).map(isAbsenceClaim).find(Boolean);
        record(claim, keysNamedIn(next.lines.join('\n')), 'the block it introduces');
      }
      return;
    }

    // A claim inside a fence: a comment run, then the lines it governs.
    for (let i = 0; i < unit.lines.length; i++) {
      if (!isCommentLine(unit.lines[i])) continue;
      const run = [];
      while (i < unit.lines.length && isCommentLine(unit.lines[i])) run.push(unit.lines[i++]);
      const text = run.map(l => l.replace(/^\s*(?:#|\/\/|--|\*\/?|\/\*)\s?/, '')).join(' ')
        .replace(/\s+/g, ' ').trim();
      const claim = sentences(text).map(isAbsenceClaim).find(Boolean);
      if (!claim) { i--; continue; }
      record(claim, keysNamedIn(text), 'the comment itself');
      const governed = [];
      for (let j = i; j < unit.lines.length && governed.length < FENCE_WINDOW; j++) {
        if (!unit.lines[j].trim()) break;            // a blank line ends the region
        if (isCommentLine(unit.lines[j])) break;     // the next comment starts a new one
        governed.push(unit.lines[j]);
      }
      record(claim, keysNamedIn(governed.join('\n')), 'the lines it governs');
      i--;
    }
  });
  return out;
}

test('no SKILL.md claims a gate key is absent when it resolves', () => {
  const findings = [];
  for (const dir of shippedSkills()) {
    for (const f of falseKeyAbsenceClaims(skillBody(dir))) {
      if (STALE_CLAIM_ALLOWANCES.some(a => a.file === `skills/${dir}/SKILL.md` && a.key === f.key)) continue;
      findings.push(`skills/${dir}/SKILL.md — "${f.claim}" (${f.where}), but gates.yaml:${f.key} resolves`);
    }
  }
  assert.deepEqual(findings, [],
    'a skill describes a gate key as not yet in gates.yaml, and the key is there. The next\n'
    + 'reader trusts the prose, refuses the path the key guards, and reasons about a gate that\n'
    + 'landed. Cite the key with `gates.yaml:<key>` and delete the request block:\n\n  - '
    + findings.join('\n  - ') + '\n');
});

test('absence-claim predicate: catches the claims that actually shipped false', () => {
  const shipped = [
    // The inline form.
    'There is no `skills.tam_map.max_pages_per_run` key yet, so the ceiling is enforced here.',
    // The house style: a claim paragraph governing a fenced list of bare keys.
    'Requested and not yet merged into `_lib/gates.yaml` — this skill may not edit that file, so\n'
    + 'these are named as dotted keys here and cited as `gates.yaml:` keys only once the\n'
    + 'orchestrator has applied them. Until then, treat each as fail-closed: no key, no cycle.\n\n'
    + '```\nskills.signal_watch.baseline_first   first cycle emits no triggers\n```\n',
    // A claim paragraph governing a table of citation-form keys.
    'Four thresholds do not exist in `_lib/gates.yaml` yet. This skill may not edit that file, so\n'
    + 'they are requested rather than added.\n\n'
    + '| Key | What it bounds |\n|---|---|\n'
    + '| `gates.yaml:skills.competitive_intel.max_pages_per_run` | Pages across one run |\n',
    // A claim in a comment inside a shipped script, governing the reader below it.
    '```js\n'
    + '// Requested, NOT YET IN gates.yaml. Named bare on purpose: citing an unresolvable\n'
    + '// key would fail rule 4 of docs/skill-shape.md.\n'
    + 'max_rows_gate: skills.research_agent.max_rows_per_run\n'
    + '```\n',
    '```js\n'
    + '// These two skills.cost_optimizer.* keys are read here and are NOT cited in the prose\n'
    + '// above, because a skill may not add a gate key and citing an absent one is a broken\n'
    + '// citation rather than an honest request.\n'
    + "MIN_EVIDENCE = Number(gateValue(gates, 'skills.cost_optimizer.min_evidence_calls'));\n"
    + '```\n',
  ];
  for (const s of shipped) {
    assert.ok(falseKeyAbsenceClaims(s).length > 0, `predicate missed a false absence claim:\n${s}`);
  }
});

test('absence-claim predicate: a fail-closed instruction stays legal', () => {
  const honest = [
    // Law 5 boilerplate. Every skill in the pack carries some version of this.
    'A missing gate key reads as STOP, never as "no gate" (law 5).',
    '- a missing gate key is a STOP and never "no gate" (law 5).',
    '`/comply` refuses when the gate key it reads does not exist — a missing key is STOP.',
    'If `gates.yaml:skills.launch.max_export_rows` does not exist, the export is refused.',
    'Where `gates.yaml:unbounded_endpoints.hard_page_ceiling` does not exist, the page gate stops.',
    'Should `gates.yaml:quality_stops.coverage_min_pct` not exist, say the list was not checked.',
    'It will not apply a prior without the thresholds. A missing gate key reads as STOP.',
    // The whole point of citing a key is that it is there.
    'Compare live coverage against `gates.yaml:quality_stops.coverage_min_pct` and say so.',
    // An honest claim about a key that really is absent.
    '`skills.crystal_ball.max_visions` is not yet merged into `_lib/gates.yaml`.',
    'There is no `skills.crystal_ball.max_visions` key yet, so the path stays closed.',
    // local-business-prospecting: the named key is cited as PRESENT; the key it
    // lacks is never named, so there is nothing to look up. Both are correct.
    'The pack already holds this clamp as a value: `_lib/gates.yaml` carries\n'
    + '`gates.yaml:skills.tam_map.directory_max_pages_per_request` for the identical reason on\n'
    + 'the identical endpoint. That key is scoped to `/tam-map` and this skill needs its own\n'
    + 'under its own namespace; until the orchestrator adds it, the clamp above is enforced by\n'
    + 'this page and by the tests behind it rather than by a key. **A missing gate key reads\n'
    + 'as STOP, never as "no gate"** (law 5).\n\n'
    + '```bash\nrichapi search directory_yellowpages --pages 1 --dry-run\n```\n',
    // An in-fence claim must not reach past the comment that answers it.
    '```yaml\n'
    + '# Requested, NOT YET IN gates.yaml.\n'
    + 'max_rows_gate: skills.crystal_ball.max_visions\n'
    + '# This one DOES resolve today.\n'
    + 'pilot_answer_rate_gate: quality_stops.coverage_min_pct\n'
    + '```\n',
    // A capability ceiling that happens to mention a threshold.
    '**It will not report ad spend.** No endpoint in this pack returns it.',
  ];
  for (const s of honest) {
    assert.deepEqual(falseKeyAbsenceClaims(s), [], `predicate flagged honest prose:\n${s}`);
  }
});

// ---------------------------------------------------------------------------
// read — everything the code reads is declared
// ---------------------------------------------------------------------------

test('every gate key a runtime module or a shipped skill reads is declared', () => {
  const findings = [];
  for (const p of runtimeSources()) {
    for (const key of runtimeReads(readFileSync(p, 'utf8'))) {
      if (!hasGate(GATES, key)) findings.push(`${relative(ROOT, p)} reads ${key}`);
    }
  }
  for (const dir of shippedSkills()) {
    for (const key of skillReads(skillBody(dir))) {
      if (!hasGate(GATES, key)) findings.push(`skills/${dir}/SKILL.md reads ${key} via gateValue()/hasGate()`);
    }
  }
  assert.deepEqual(findings, [],
    'code reads a gate key gates.yaml does not declare. Law 5 turns that into a permanent\n'
    + 'STOP — or, where the reader is allowed to degrade, into a control that is decorative\n'
    + 'forever. `_lib/activation.mjs` read seven undeclared keys and every activation band\n'
    + 'rendered YELLOW for the life of the branch:\n\n  - ' + findings.join('\n  - ') + '\n');
});

test('the read check sees the GATE_KEYS tables, not only the call sites', () => {
  // The regression guard for finding 1. `_lib/activation.mjs` holds its keys in a
  // frozen table of plain strings and reads them through an injected gateValue, so
  // a predicate that only matched `gateValue(g, '...')` call sites would have seen
  // nothing at all — which is precisely how the bands stayed dark.
  const src = readFileSync(join(ROOT, '_lib', 'activation.mjs'), 'utf8');
  const seen = runtimeReads(src);
  assert.ok(seen.size >= 7, `expected the activation GATE_KEYS table to be visible, saw ${seen.size}`);
  assert.ok([...seen].every(k => k.startsWith('activation.')),
    `activation.mjs should only read activation.* keys, saw: ${[...seen].join(', ')}`);
  assert.ok(!seen.has('activation.json'), 'a filename is not a gate key');
});

// ---------------------------------------------------------------------------
// declared — everything declared is read
// ---------------------------------------------------------------------------
//
// The inverse of the read check, and the one `request_page_multipliers` fails. A key with
// thirty lines of reasoning and no reader is not a control; it is a memo. Worse
// than a memo, because a reviewer who greps gates.yaml finds it and concludes
// the hazard is handled.
//
// A key counts as READ when a `_lib/` or `bin/` source reads it, or when a
// shipped SKILL.md names it at all — citing it, or naming it bare in a request
// block. Naming is enough here because a skill that names a key is a reader in
// the only sense this pack has: the agent following the skill looks the key up.
// Whether the surrounding sentence tells the truth about it is the absence-claim check's job.
//
// Prefix semantics: reading `disabled` or `cache_ttl.classes` reads every leaf
// beneath it, because the reader gets the whole map.

function everythingRead () {
  const readers = new Map();               // key -> Set(where)
  const add = (k, where) => {
    if (!readers.has(k)) readers.set(k, new Set());
    readers.get(k).add(where);
  };
  for (const p of runtimeSources()) {
    const where = relative(ROOT, p);
    for (const k of runtimeReads(readFileSync(p, 'utf8'))) add(k, where);
  }
  for (const dir of shippedSkills()) {
    const where = `skills/${dir}/SKILL.md`;
    for (const k of keysNamedIn(skillBody(dir))) add(k, where);
  }
  return readers;
}

const READERS = everythingRead();
const isRead = (leaf) => [...READERS.keys()].some(r => r === leaf || leaf.startsWith(r + '.'));

/**
 * Declared keys with no reader, each one deliberately left that way for a stated
 * reason, on a stated date, by a stated owner.
 *
 * THIS TABLE IS NOT A WHITELIST. The allowance hygiene test below deletes it for
 * you: an entry whose key has since acquired a reader FAILS, so an exemption
 * cannot outlive the gap it documents. An entry for a key that no longer exists
 * fails too. The only way to keep an entry is for the hole to still be open.
 */
const UNREAD_ALLOWANCES = [
  {
    key: 'schema_version',
    since: '2026-08-29',
    owner: 'permanent',
    why: 'the document format marker, not a gate. Nothing reads it today; a reader is what a '
       + 'future migration would ADD, and pinning it as a control would be a category error.',
  },
  // --- finding 2: CLOSED 2026-08-29 by the runtime clamp ----------------------
  // The five request_page_multipliers entries that used to sit here are gone
  // because the hole they documented is gone: `_lib/run.mjs` reads the policy and
  // the endpoint map in `pageMultiplierFor`, and `clampPageMultiplier` applies the
  // clamp inside `buildRequestFor` before the payload is built, failing closed on
  // a listed endpoint whose field or clamp is missing. Measured on
  // `google_search_scraper_sync --param limit=100`: the ledger recorded 1000
  // credits before, 10 after. This test deleting its own exemption is exactly the
  // handover it was written to signal.
  // --- same shape, found by the declared-key check itself the day it landed ----
  {
    key: 'skills.account_research.deep_pass_requires_explicit_opt_in',
    since: '2026-08-29',
    owner: '/account-research',
    why: 'TODO: declared in gates.yaml, named by nothing. The opt-in is real but it is enforced '
       + 'by prose ("Pass 2 — the committee (opt-in)"), so setting this key to false today changes '
       + 'nothing at all. Either the skill cites it as gates.yaml:<key> next to the pass gate, or '
       + 'the key comes out — a boolean nobody reads is the most convincing kind of decoration.',
  },
];

test('every key gates.yaml declares is read by something', () => {
  const allowed = new Set(UNREAD_ALLOWANCES.map(a => a.key));
  const orphans = LEAVES.filter(l => !isRead(l) && !allowed.has(l));
  assert.deepEqual(orphans, [],
    'these keys are declared in gates.yaml and read by nothing — not a _lib/ module, not a\n'
    + 'bin/ script, not a SKILL.md. A gate nobody reads is a gate that does not fire, and it\n'
    + 'reads as protection to the next person who greps for it. Either wire it or delete it;\n'
    + 'if it is deliberately pending, add a dated entry to UNREAD_ALLOWANCES:\n\n  - '
    + orphans.join('\n  - ') + '\n');
});

test('unread-key allowances expire on their own', () => {
  const stale = [];
  for (const a of UNREAD_ALLOWANCES) {
    if (!hasGate(GATES, a.key)) {
      stale.push(`${a.key} — allowed as unread, but the key is gone from gates.yaml. Delete the entry.`);
      continue;
    }
    if (isRead(a.key)) {
      stale.push(`${a.key} — now read by ${[...(READERS.get(a.key) ?? [])].join(', ') || 'a prefix read'}. `
        + `Delete the entry (owner: ${a.owner}, since ${a.since}).`);
    }
    if (!a.why || !a.since || !a.owner) stale.push(`${a.key} — an allowance needs a why, a since and an owner.`);
  }
  assert.deepEqual(stale, [],
    'an exemption outlived the gap it documents:\n\n  - ' + stale.join('\n  - ') + '\n');
});

/**
 * Absence-claim exemptions. Same contract as UNREAD_ALLOWANCES: dated, owned, and deleted
 * by the hygiene test the moment the prose is fixed.
 */
const STALE_CLAIM_ALLOWANCES = [];

test('absence-claim allowances expire on their own', () => {
  const stale = [];
  for (const a of STALE_CLAIM_ALLOWANCES) {
    const dir = a.file.split('/')[1];
    const live = shippedSkills().includes(dir)
      ? falseKeyAbsenceClaims(skillBody(dir)).some(f => f.key === a.key)
      : false;
    if (!live) stale.push(`${a.file} / ${a.key} — the claim is fixed or gone. Delete the entry.`);
    if (!a.why || !a.since || !a.owner) stale.push(`${a.file} / ${a.key} — needs a why, a since and an owner.`);
  }
  assert.deepEqual(stale, [],
    'an exemption outlived the claim it documents:\n\n  - ' + stale.join('\n  - ') + '\n');
});

// ---------------------------------------------------------------------------
// The load-bearing invariant: none of the four directions is derived from a list
// ---------------------------------------------------------------------------

test('every direction derives its inputs, and none of them is empty', () => {
  const self = readFileSync(join(__dirname, 'skill-gate-keys.test.mjs'), 'utf8');
  const body = self.slice(self.indexOf('function shippedSkills'));

  assert.ok(LEAVES.length > 100, `gates.yaml should declare a real key set, saw ${LEAVES.length}`);
  assert.ok(ROOTS.length >= 10, `gates.yaml should have its top-level blocks, saw ${ROOTS.join(', ')}`);
  assert.ok(shippedSkills().length >= 20, 'the skill inventory came back suspiciously small');
  assert.ok(READERS.size > 50, `the reader index found only ${READERS.size} keys — the scanner is broken`);
  assert.ok(runtimeSources().length > 5, 'no runtime sources found — the read check would pass vacuously');

  // The bug this whole file is about is a check that quietly stops checking.
  // A hard-coded skill or key list is how that happens, so forbid both.
  const afterAllowances = body.replace(/const UNREAD_ALLOWANCES[\s\S]*?\n\];/, '')
    .replace(/const STALE_CLAIM_ALLOWANCES[\s\S]*?\];/, '')
    .replace(/test\('absence-claim predicate[\s\S]*?\n\}\);/g, '');
  assert.ok(!/readdirSync\s*\(\s*['"]/.test(afterAllowances), 'skills/ must be read by path, not by literal');
  assert.ok(!/\bskills\.[a-z_]+\.[a-z_]+\b/.test(afterAllowances.replace(/^\s*\/\/.*$/gm, '')),
    'no direction may name a specific skill gate key outside the allowance tables');
});
