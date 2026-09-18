// tests/contracts/no-internal-leak.test.mjs
//
// THE PUBLIC TREE CARRIES NO INTERNAL PLUMBING.
//
// Everything a stranger can read — shipped code, skills, docs, tests, config — describes
// what the pack does. It does not name systems outside this repository, and it does not
// carry planning bookkeeping: task ids, build work-stream names, session logs, unsent
// requests, or references to a private working journal.
//
// TWO KINDS OF MARKER:
//
//   PLANNING markers are generic shapes (a `T##` task id, "Lane C", a session heading).
//   They are listed as plain patterns; nothing about them is private.
//
//   PRIVATE names — files, symbols and documents that live outside this repository — are
//   stored only as SHA-256 hashes of the exact token, so this guard does not itself
//   disclose them. To add one:  printf %s '<token>' | shasum -a 256
//
// Excluded from the scan: the pinned spec and the recorded fixtures (never edited, law 2),
// and this file, which must contain the planning patterns it looks for. The hand-written
// spec fixtures under tests/fixtures/spec/ are NOT recordings, so they are scanned.
//
// Private names are matched exactly and also lower-cased, so a capitalised spelling of a
// lower-case private name is caught too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ROOT, shippedFiles } from '../helpers/shipped-files.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SELF = 'tests/contracts/no-internal-leak.test.mjs';
const EXCLUDED = [/^spec\//, /^tests\/fixtures\/live\//, /\.(png|ico|jpg)$/];

const FILES = shippedFiles().filter((rel) => rel !== SELF && !EXCLUDED.some((re) => re.test(rel)));

// --- planning markers ---------------------------------------------------------------

const PLANNING_MARKERS = [
  { pattern: /^#{1,6}\s*Session \d/m, why: 'a dated build-session log heading' },
  { pattern: /autonomous (window|build|session)/i, why: 'a build-session log' },
  { pattern: /\bLanes? [A-G]\d?\b/, why: 'a build work-stream name' },
  { pattern: /\bT\d{1,2}\b(?!\d)/, why: 'a plan-task id: say what the work is instead' },
  { pattern: /API ask(s)?\s*#?\d/i, why: 'a request that was never sent to anyone' },
  { pattern: /Upstream defect/i, why: 'an undisclosed upstream defect writeup' },
  { pattern: /supersedes the \d{4}-\d{2}-\d{2}/i, why: 'journal bookkeeping' },
  { pattern: /Open product decisions|Deferred hardening|Still open, and why/i,
    why: 'an internal decision-log heading' },
  { pattern: /Blocked on you/i, why: 'a section addressed to one person, not to a reader' },
  { pattern: /plan of record|MERGE NOTE/i, why: 'planning bookkeeping' },
  { pattern: /\bPhase \d\b/, why: 'a build-phase label' },
];

/** First line matching each marker in `src`. */
function planningHits (src) {
  const found = [];
  for (const { pattern, why } of PLANNING_MARKERS) {
    const m = pattern.exec(src);
    if (!m) continue;
    const line = src.slice(0, m.index).split('\n').length;
    found.push(`line ${line}: ${JSON.stringify(m[0])} (${why})`);
  }
  return found;
}

// --- private names, by hash ---------------------------------------------------------

const PRIVATE = new Set([
  '1ba872dead566c749d7d9048ed8ebbb2b562296e5d970ea3244bcd878e2964eb', // backend symbol
  '6e3c85de96569eb62ef793d9aebb3c03756f3ab7065bd6c1a3067b72f9126c0a', // backend table
  'ccdb2bd3e55478bc894b0645d32a9cd71fe4105eccb0a506050fd6bfe08d648d', // MCP server handler
  'a095484765d32c678564960cb6d4e5cdbbd0ba70f5d10c0fbb0a7080c5fd2a22', // MCP server handler
  '4b1dea8b9fd23ed584d10f38c30c1054c27734a50a83515d647d656c6df0d3be', // MCP server handler
  '6494a58e4a05c5e12ed332d6ab6dd3a70611fc383b35247b54c5b52181d2b9d7', // backend source path
  '3e422231c1ae1a4d45b00a3cc6fa9d9783eef91cc520b3dd07ba584f3d8d41bd', // MCP server source path
  '83a47ce39584ce9ace2ce562f674aed791737d067c941bd6cdd1f16e836f1c74', // private planning document
  '7a35f480dc912d692c7ab2a6ad4d10e771a0b58e7a7af23266373e08abe390df', // machine task record
  '3ccd200e309f3f845da0c453f5f86239b0ebdaec527b74fdbebf4cd8fd31e633', // retired pack name
  '80319d662ae7c2a9961852eb6bfe524e7fdbf131a303a2e9c0bab5a701152f4a', // retired vendor name
]);

// Token shapes a private name can take: an identifier, a hyphenated word, a two-part
// path, an upper-case document name.
const TOKEN_SHAPES = [
  /[A-Za-z_][A-Za-z0-9_]*/g,
  /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g,
  /[a-z][a-z0-9-]*\/[a-z][a-z0-9_]*/g,
  /[A-Z][A-Z0-9-]+\.md/g,
];
const memo = new Map();
const sha = (t) => {
  if (!memo.has(t)) memo.set(t, createHash('sha256').update(t).digest('hex'));
  return memo.get(t);
};

function privateHits (src, banned = PRIVATE) {
  const found = [];
  src.split('\n').forEach((line, i) => {
    for (const shape of TOKEN_SHAPES) {
      for (const m of line.matchAll(shape)) {
        if (banned.has(sha(m[0])) || banned.has(sha(m[0].toLowerCase()))) found.push(`line ${i + 1}`);
      }
    }
  });
  return [...new Set(found)];
}

// --- the contract -------------------------------------------------------------------

test('the scan covers code, skills, docs, tests and config', () => {
  for (const must of ['README.md', 'ROADMAP.md', 'LIMITATIONS.md', '_lib/run.mjs',
    'skills/richapi-gtm/SKILL.md', 'tests/contracts/frozen-contracts.sha256',
    '.github/workflows/validate.yml', '.gitignore', 'bin/richapi.mjs']) {
    assert.ok(FILES.includes(must), `${must} is not scanned`);
  }
  assert.ok(!FILES.some((f) => f.startsWith('tests/fixtures/live/')), 'recordings must not be scanned');
  assert.ok(FILES.includes('tests/fixtures/spec/manifest.json'), 'hand-written spec fixtures must be scanned');
});

test('no public file carries planning bookkeeping', () => {
  const findings = [];
  for (const rel of FILES) {
    for (const h of planningHits(read(rel))) findings.push(`${rel} ${h}`);
  }
  assert.deepEqual(findings, [],
    'rewrite each as a statement about the pack, not about how it was built:\n  - '
    + findings.join('\n  - ') + '\n');
});

test('no public file names a system outside this repository', () => {
  const findings = [];
  for (const rel of FILES) {
    for (const h of privateHits(read(rel))) findings.push(`${rel} ${h}`);
  }
  assert.deepEqual(findings, [],
    'describe the behaviour, never the private file, symbol or document behind it:\n  - '
    + findings.join('\n  - ') + '\n');
});

test('the guards are not vacuous', () => {
  const journal = planningHits('## Session 4 — overnight autonomous build\nT5 blocks Lane D; see API ask #8.');
  assert.ok(journal.length >= 4, `planning markers matched only ${journal.length} known lines`);
  // A probe token stands in for a private name, so the hash path is proven without one.
  const probe = new Set(['ed8eaa9ef69804baebb89c1cd379ef365507200c43b015240440d19cfbbaf7da']);
  assert.deepEqual(privateHits('see zzleakprobe for details', probe), ['line 1']);
  assert.deepEqual(privateHits('see ZzLeakProbe for details', probe), ['line 1'],
    'a capitalised spelling of a private name must be caught');
  const honest = [
    'There is no `richapi retro` verb.',
    'Sending execution stays external: owning sending means owning spam complaints.',
    'Nothing in this pack writes into your CRM.',
  ].join('\n');
  assert.deepEqual(planningHits(honest), []);
  assert.deepEqual(privateHits(honest), []);
});

// --- the local journal stays local -------------------------------------------------

const PKG = JSON.parse(read('package.json'));
// Built at runtime so this guard does not itself mention the file.
const JOURNAL = ['todo', 'md'].join('.');

test('the local journal is not shipped in the tarball', () => {
  const files = PKG.files ?? [];
  assert.ok(!files.includes(JOURNAL), `\`${JOURNAL}\` is in package.json "files:"`);
  for (const entry of files) {
    assert.notEqual(entry, '.', '`files: ["."]` would ship the local journal');
    assert.notEqual(entry, '*', '`files: ["*"]` would ship the local journal');
  }
});

test('no public file mentions the local journal', () => {
  const re = new RegExp(`\\b${JOURNAL.replace('.', '\\.')}\\b`);
  const dead = FILES.filter((rel) => re.test(read(rel)));
  assert.deepEqual(dead, [], `these files mention \`${JOURNAL}\`, which no reader has:\n  - `
    + dead.join('\n  - ') + '\n');
});

// --- the public roadmap and limits exist, ship, and say something ------------------

for (const rel of ['ROADMAP.md', 'LIMITATIONS.md']) {
  test(`${rel} exists, is shipped, and is not a stub`, () => {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is missing`);
    assert.ok((PKG.files ?? []).includes(rel),
      `${rel} is not in package.json "files:", so the README links to a file the tarball lacks`);
    assert.ok(read(rel).length > 1500, `${rel} is a stub`);
  });
}
