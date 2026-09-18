// tests/skills/list-hygiene/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill. The four rules are checked by
// running the REAL validator, but inside a sandbox holding only this suite's skill
// and its link targets — many skills are written in parallel into one skills/
// directory, and this suite being green must not depend on another skill's in-progress
// half-written SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, SKILL_MD, skillSource, skillBody, validatorSandbox, runValidator, linkClosure }
  from './helpers.mjs';

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(SKILL_MD), 'skills/list-hygiene/SKILL.md is missing');
});

test('the real validator passes this skill (all four shape rules)', () => {
  // The closure is DERIVED (see linkClosure), so its size changes whenever a sibling
  // link is added — that is the documented point of deriving it. Asserting a literal
  // count re-introduced exactly the brittleness the derivation removed: the old
  // /3 skill\(s\)/ matched "33 skill(s)" by substring and went red at 34.
  const closure = linkClosure(['list-hygiene']);
  const dir = validatorSandbox(closure);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed:\n${out}`);
  assert.match(out, new RegExp(`\\b${closure.length} skill\\(s\\) validated`),
    `the sandbox must lint exactly the ${closure.length}-skill closure`);
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource().replace(/\r\n/g, '\n');
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const block = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, /^name: list-hygiene$/m);
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  const triggers = block.split('\n').filter(l => /^\s+- /.test(l));
  assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
});

test('rule 1 — a `## Related` section that routes onward, with links that resolve', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, '`## Related` must link to at least one other skill');
  for (const rel of links) {
    const target = join(REPO_ROOT, 'skills', 'list-hygiene', rel);
    assert.ok(existsSync(target), `broken link: ${rel}`);
  }
});

test('rule 2 — a boundary section that names what stays external', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const idx = body.search(/^#{2,3}\s+.*will not/im);
  const boundary = body.slice(idx);
  assert.match(boundary, /suppress/i, 'the boundary must restate the suppression stop');
  assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(skillBody(), /richapi-skills-preflight/);
});

test('the skill is honest that there is no CLI verb for this pipeline yet', () => {
  const body = skillBody();
  assert.match(body, /no `richapi hygiene` verb yet/i,
    'law 6: do not imply a command the runtime does not ship');
});

test('the pipeline puts suppression and dedupe ahead of every paid step', () => {
  const body = skillBody();
  const at = re => body.search(re);
  const suppression = at(/^##.*suppression cross-check/im);
  const dedupe      = at(/^##.*dedupe/im);
  const approval    = at(/^##.*name and cost every paid call/im);
  const paid        = at(/^##.*paid checks/im);
  assert.ok(suppression > -1 && dedupe > -1 && approval > -1 && paid > -1,
    'the documented pipeline steps are not all present');
  assert.ok(suppression < dedupe, 'suppression must run before dedupe');
  assert.ok(dedupe < approval, 'dedupe before approval — duplicates are rows paid for twice');
  assert.ok(approval < paid, 'approval must precede the first paid call (law 3)');
});

test('the verifier table carries the recorded status, ranked above catch_all', async () => {
  // A live run found `ok` missing from this table. The recorded verdict is the source.
  const { readFileSync } = await import('node:fs');
  const rec = JSON.parse(readFileSync(
    join(REPO_ROOT, 'tests', 'fixtures', 'live', 'email_verifier.json'), 'utf8'));
  const recorded = rec.body.result.status;
  const body = skillBody();
  const table = body.slice(body.indexOf('| Verifier status |'));
  const rows = table.split('\n').filter(l => l.startsWith('| `'));
  const at = (v) => rows.findIndex(l => l.includes('`' + v + '`'));
  assert.ok(at(recorded) >= 0, `the table has no row for the recorded status "${recorded}"`);
  assert.ok(at(recorded) < at('catch_all'), 'the recorded verdict must rank above catch_all');
  assert.match(body, /email_verification_status/, 'name the column the verdict lands in');
});
