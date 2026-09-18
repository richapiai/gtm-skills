// tests/skills/account-research/null-enum.test.mjs
//
// Law 6, made mechanical for a research brief.
//
// The failure this skill exists to prevent is a brief that asserts something it never
// fetched. Its quieter twin is a brief that OMITS what it fetched and did not find:
// a reader cannot tell "checked, empty" from "never checked", so an omission reads as
// a plausible fact-shaped hole and the rep fills it in on the call.
//
// So a not-found fact must be RENDERED, and rendered with the one explicit null enum in
// `_lib/dual-contract.schema.json` — never as a blank, a dash, "N/A", or a missing row.
// The three tokens are read out of the schema rather than retyped, because the schema is
// frozen shared property and this test must fail if it moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, section, invokedEndpoints } from './helpers.mjs';
import { loadDualContractSchema, NULL_ENUM, nullAliases } from '../../../_lib/dual-contract.mjs';

const SCHEMA = loadDualContractSchema();
const BODY = skillBody();

/** The rendered example brief: the fenced block inside the brief-writing section. */
function briefBlock () {
  const s = section(/Write the brief/i);
  const m = s.text.match(/```\n([\s\S]*?)```/);
  assert.ok(m, 'the brief-writing section must show a rendered brief, not just describe one');
  return m[1];
}

test('the null enum this skill uses is the schema\'s, not a local invention', () => {
  assert.deepEqual([...NULL_ENUM].sort(), ['not_applicable', 'not_found', 'not_verifiable']);
  assert.deepEqual([...(SCHEMA['x-null-enum'] || [])].sort(), [...NULL_ENUM].sort(),
    'dual-contract.schema.json and its implementation disagree on the enum');
  for (const token of NULL_ENUM) {
    assert.ok(BODY.includes(token), `the skill never mentions the explicit null \`${token}\``);
  }
  assert.match(BODY, /_lib\/dual-contract\.schema\.json/,
    'the skill must name where its null enum comes from');
});

/** Every field row of the rendered brief: the indented lines under the account name. */
function briefRows () {
  return briefBlock().split('\n')
    .filter(l => /^\s{2,}\S/.test(l))
    .map(l => l.replace(/\s+$/, ''));
}

test('a not-found fact is RENDERED in the brief, not omitted', () => {
  const rows = briefRows();
  // Pinned, so DELETING a gap row fails here. An omitted field is the failure this test
  // exists for: a reader cannot tell "checked, empty" from "never checked", and the whole
  // point of the enum is that the difference is visible.
  const labels = rows.map(l => l.trim().split(/\s{2,}/)[0]);
  assert.deepEqual(labels, [
    'Headcount band',
    'Industry',
    'HQ',
    'Marketing stack',
    'Retargeting live',
    'Published pricing',
    'Last funding round',
    'Monthly visits',
    'Store reviews',
  ], 'a row was added to or removed from the example brief — a removed gap row is the bug');

  const nulled = rows.filter(l => NULL_ENUM.some(t => l.includes(t)));
  assert.equal(nulled.length, 4,
    'the example brief demonstrates four gaps; dropping one turns a rendered gap into silence');
  // Each of the three kinds is demonstrated, because they are not interchangeable.
  for (const token of NULL_ENUM) {
    assert.ok(rows.some(l => l.includes(token)),
      `the example brief never demonstrates \`${token}\``);
  }
});

test('every rendered row — including every gap — carries its source endpoint', () => {
  const invoked = invokedEndpoints(BODY);
  const rows = briefRows();
  assert.ok(rows.length >= 6, 'the example brief is too thin to demonstrate anything');
  for (const row of rows) {
    // Deliberately over EVERY row, not only the ones that already have a bracket:
    // stripping a source line must fail, and filtering on `[` would hide exactly that.
    const m = row.match(/\[([^\]]+)\]$/);
    assert.ok(m, `brief row has no trailing source line: ${row.trim()}`);
    for (const name of m[1].split(',').map(s => s.trim())) {
      assert.ok(invoked.has(name),
        `brief row cites \`${name}\`, which this skill never invokes: ${row.trim()}`);
    }
  }
});

test('no abolished null alias is used as a value anywhere in the brief', () => {
  const aliases = nullAliases(SCHEMA);
  const block = briefBlock();
  for (const line of block.split('\n')) {
    // The value column is everything between the label and the source line.
    const m = line.match(/^\s{2}\S.*?\s{2,}(.+?)\s{2,}\[/);
    if (!m) continue;
    const value = m[1].trim();
    assert.ok(!aliases.has(value.toLowerCase()),
      `"${value}" is an abolished null alias — use one of ${NULL_ENUM.join(' | ')}`);
    assert.notEqual(value, '', 'an empty value cell is exactly what the null enum replaces');
  }
});

test('the skill says out loud that silence is not one of the options', () => {
  const s = section(/Write the brief/i);
  assert.match(s.text, /Silence is not one of the three/i,
    'omitting a checked-and-empty field must be forbidden explicitly, not just discouraged');
  assert.match(s.text, /never in the fact table|never merged into a field/i,
    'inference must never be allowed to fill a gap that carries a source endpoint');
});

test('each null kind is defined, so they are not used interchangeably', () => {
  const s = section(/Write the brief/i);
  assert.match(s.text, /`not_found`\s+—[^\n]*call ran/i,
    'not_found = looked, nothing there');
  assert.match(s.text, /`not_verifiable`\s+—[^\n]*cannot confirm|`not_verifiable`\s+—[^\n]*confirm/i,
    'not_verifiable = something there, cannot be confirmed');
  assert.match(s.text, /`not_applicable`\s+—[^\n]*does not apply/i,
    'not_applicable = the question does not apply to this account');
});
