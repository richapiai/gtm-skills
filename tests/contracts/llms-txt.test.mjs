// tests/contracts/llms-txt.test.mjs
//
// llms.txt IS GENERATED, AND STAYS GENERATED.
//
// llms.txt (https://llmstxt.org) is what an agent reads instead of the 557-line README.
// A hand-maintained index of 33 skills is a stale index within one release, and a stale
// index that an AGENT reads is worse than one a human reads: the human notices.
//
// So it is derived by scripts/gen-llms-txt.mjs, and this test re-runs the generator and
// fails on any difference. Adding a skill, repricing an endpoint or editing a SKILL.md
// description turns this red until `node scripts/gen-llms-txt.mjs` is run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { render, ROOT } from '../../scripts/gen-llms-txt.mjs';
import { spendSplit, skillNames } from '../../_lib/spend-split.mjs';

const OUT = join(ROOT, 'llms.txt');

test('llms.txt is in sync with the generator', () => {
  assert.ok(existsSync(OUT), 'llms.txt is missing — run: node scripts/gen-llms-txt.mjs');
  assert.equal(readFileSync(OUT, 'utf8'), render(),
    'llms.txt is stale — run: node scripts/gen-llms-txt.mjs');
});

test('every skill appears exactly once, with its file linked', () => {
  const txt = readFileSync(OUT, 'utf8');
  for (const name of skillNames()) {
    const hits = txt.split(`](skills/${name}/SKILL.md)`).length - 1;
    assert.equal(hits, 1, `${name} appears ${hits} times in llms.txt, expected once`);
  }
});

test('the free markers agree with the derived split', () => {
  const txt = readFileSync(OUT, 'utf8');
  const { free, spends } = spendSplit();
  const marked = new Set();
  for (const m of txt.matchAll(/\[\/([a-z0-9-]+)\]\(skills\/[a-z0-9-]+\/SKILL\.md\) \(free\)/g)) {
    marked.add(m[1]);
  }
  assert.deepEqual([...marked].sort(), free,
    'llms.txt free markers disagree with the derived split — regenerate, do not re-count');
  for (const name of spends) {
    assert.ok(!marked.has(name), `${name} can reach a metered endpoint and must not be marked free`);
  }
});

test('every path llms.txt links to exists', () => {
  const txt = readFileSync(OUT, 'utf8');
  const missing = [];
  for (const m of txt.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    if (!existsSync(join(ROOT, target.split('#')[0]))) missing.push(target);
  }
  assert.deepEqual(missing, [], 'llms.txt links a file that does not exist');
});
