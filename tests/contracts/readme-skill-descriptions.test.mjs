// tests/contracts/readme-skill-descriptions.test.mjs
//
// THE README SAYS ITS SKILL TABLE IS "GENERATED FROM EACH `SKILL.md`'s FRONTMATTER
// `description`". IT IS NOT GENERATED. IT IS COPIED BY HAND.
//
// That is fine as long as the copy stays true, and nothing was checking it. Two ways it
// goes wrong, both silent:
//
//   1. A description is edited and the README is not, so the front door describes a
//      skill that no longer behaves that way. An agent routes off the frontmatter, a
//      human buys off the README, and they disagree.
//   2. The README is edited "to read better" and drifts into a claim the skill never
//      made. This one already happened during a prose pass: a mechanical em-dash fix
//      inserted a comma the frontmatter does not contain, six times.
//
// THE CONTRACT, which matches how the table is actually curated: the README line is a
// TRUNCATION of the frontmatter description. Strip its trailing period and it must be a
// prefix of the description, whitespace-normalised. That allows the README to be shorter
// (it is, deliberately — one sentence rather than a routing paragraph) while making any
// difference in wording a build failure.
//
// It also pins the `free` markers to the derived spend split, so the money claim on the
// front page cannot drift either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { spendSplit, skillNames } from '../../_lib/spend-split.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

const LINE = /^- \[`\/([a-z0-9-]+)`\]\(skills\/[a-z0-9-]+\/SKILL\.md\) — (.+)$/gm;

function readmeEntries () {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  return [...readme.matchAll(LINE)].map(([, name, text]) => ({
    name,
    free: /^\*\*free\.\*\* /.test(text),
    text: norm(text.replace(/^\*\*free\.\*\* /, '')),
  }));
}

function description (name) {
  const src = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  return norm(YAML.parse(/^---\n([\s\S]*?)\n---/.exec(src)[1]).description);
}

test('the README lists every skill exactly once', () => {
  const entries = readmeEntries();
  const listed = entries.map((e) => e.name).sort();
  assert.deepEqual(listed, skillNames(),
    'the README skill table and skills/ disagree about which skills exist');
  assert.equal(new Set(listed).size, listed.length, 'a skill is listed twice');
});

test('every README description is a truncation of the frontmatter, word for word', () => {
  const drifted = [];
  for (const { name, text } of readmeEntries()) {
    const desc = description(name);
    const stem = text.replace(/\.$/, '');
    if (!desc.startsWith(stem)) {
      drifted.push(`/${name}\n    README: ${stem.slice(0, 100)}\n    SKILL:  ${desc.slice(0, 100)}`);
    }
  }
  assert.deepEqual(drifted, [],
    'These README lines are not a prefix of their SKILL.md description. Either the '
    + 'description changed and the README did not, or the README was edited into a claim '
    + `the skill does not make:\n\n${drifted.join('\n\n')}`);
});

test('a README description never outruns the frontmatter it quotes', () => {
  for (const { name, text } of readmeEntries()) {
    assert.ok(text.replace(/\.$/, '').length <= description(name).length,
      `/${name}: the README says more than the SKILL.md description does`);
  }
});

test('the `free` markers match the derived spend split', () => {
  const { free, spends } = spendSplit();
  const marked = readmeEntries().filter((e) => e.free).map((e) => e.name).sort();
  assert.deepEqual(marked, free,
    'README `free` markers disagree with the derived split — re-derive, do not re-count');
  for (const name of spends) {
    assert.ok(!marked.includes(name), `${name} can reach a metered endpoint and is marked free`);
  }
});

test('the guard is actually reading the table, not an empty match', () => {
  const entries = readmeEntries();
  assert.ok(entries.length >= 30, `only matched ${entries.length} README skill lines`);
  assert.ok(entries.some((e) => e.free), 'no free marker found — the regex has drifted');
});
