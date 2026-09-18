// tests/skills/inbound/skill-shape.test.mjs
//
// docs/skill-shape.md is FROZEN and enforces four rules, all errors. This runs the real
// validator over a sandbox containing this skill and its link closure, and asserts that
// no error and no WARNING names this skill.
//
// It filters by skill label rather than asserting on the exit code on purpose: the
// validator lints every skill in the tree it is handed, and the link closure necessarily
// drags in siblings other skills own. Asserting on the global exit code turns this suite
// red for another skill's in-progress edit, which is exactly the failure
// tests/skills/account-research/helpers.mjs documents from 2026-08-28.
//
// The four rules are ALSO asserted directly, so a future relaxation of the validator
// cannot quietly relax this skill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL, REPO_ROOT, skillSource, skillBody, citedGateKeys,
  validatorSandbox, runValidator, linesFor,
} from './helpers.mjs';

const body = skillBody();
const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());

test('the real validator reports neither an error nor a warning for this skill', () => {
  const dir = validatorSandbox([SKILL]);
  const { code, out } = runValidator(dir);
  const mine = linesFor(out, SKILL);
  assert.deepEqual(mine, [], `validator output naming ${SKILL}:\n${mine.join('\n')}`);
  // A clean sandbox should also be globally clean; report it, but do not fail this
  // suite on a sibling's line.
  if (code !== 0) {
    assert.ok(!out.includes(`skills/${SKILL}`),
      `sandbox failed and mentions ${SKILL}:\n${out}`);
  }
});

test('rule 1 — `## Related` exists and every relative link resolves', () => {
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing a `## Related` section');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, 'a skill that routes onward has at least one link');
  for (const rel of links) {
    const target = join(REPO_ROOT, 'skills', SKILL, rel);
    assert.ok(existsSync(target), `broken link: ${rel}`);
  }
});

test('rule 2 — a boundary section exists', () => {
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section — an unstated ceiling reads as a promise');
});

test('rule 3 — a metered call is accompanied by a visible plan', () => {
  const invoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.ok(invoked.length > 0, 'this skill does spend, so the rule must actually be exercised');
  assert.ok(/dry[- ]?run/i.test(body) || /gates\.yaml/.test(body),
    'a spending skill must show a dry-run plan or cite a gates.yaml threshold (law 3)');
  // Stronger than the validator: this skill must do BOTH.
  assert.ok(/dry[- ]?run/i.test(body), 'the plan is a dry-run, and it runs on every lead');
  assert.ok(/gates\.yaml/.test(body), 'the gates that still fire must be cited by key');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', async () => {
  const { loadGates, hasGate } = await import(join(REPO_ROOT, '_lib', 'gates.mjs'));
  const g = loadGates();
  const cited = citedGateKeys(body);
  assert.ok(cited.length > 0, 'this skill cites thresholds, so the rule must be exercised');
  for (const key of cited) {
    assert.ok(hasGate(g, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
});

test('the frontmatter carries what the validator requires', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'frontmatter fence');
  const fm = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, /^name: inbound$/m, 'frontmatter name must match the directory');
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m, 'version must be semver');
  assert.ok(body.includes('richapi-skills-preflight'), 'missing the preflight preamble');
});

test('paid calls go through the gated call surface, with the verbs that exist', () => {
  // `richapi call` and `richapi search` are the whole surface. A hand-rolled call has
  // no gate, no journal line, no ledger line and no cache.
  assert.match(body, /```bash[\s\S]*?richapi call [a-z_]+[\s\S]*?--dry-run/,
    'the plan must be shown as a real `richapi call ... --dry-run` invocation');
  const verbs = [...body.matchAll(/\brichapi ([a-z-]+)/g)].map(m => m[1]);
  const known = new Set(['call', 'search', 'enrich', 'preflight', 'catalog', 'gates', 'help',
    'skills-preflight']);
  for (const v of verbs) {
    assert.ok(known.has(v), `invented CLI verb: richapi ${v}`);
  }
});
