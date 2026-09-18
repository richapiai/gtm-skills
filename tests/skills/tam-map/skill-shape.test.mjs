// tests/skills/tam-map/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill. The four rules are checked by running
// the REAL validator, but inside a sandbox holding only this suite's skill and its link
// targets — many skills are written in parallel into one skills/ directory, and this
// suite being green must not depend on another skill's in-progress half-written SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT, SKILL, SKILL_MD, skillSource, skillBody, validatorSandbox, runValidator,
  linkClosure, directLinks,
} from './helpers.mjs';

/**
 * This skill plus every skill reachable from it by relative link, transitively. That is
 * the smallest population in which the validator can resolve all four rules for THIS
 * suite; anything outside it is another skill's in-progress work and must not decide whether
 * this suite is green.
 */
const CLOSURE = linkClosure();

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(SKILL_MD), 'skills/tam-map/SKILL.md is missing');
});

test('the real validator passes this skill (all four shape rules), in isolation', () => {
  assert.ok(CLOSURE.includes(SKILL) && CLOSURE.length > 1,
    'the sandbox population is not this skill plus its link closure');
  const dir = validatorSandbox(CLOSURE);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed:\n${out}`);
  assert.match(out, new RegExp(`${CLOSURE.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const block = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, /^name: tam-map$/m);
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
    assert.ok(existsSync(join(REPO_ROOT, 'skills', SKILL, rel)), `broken link: ${rel}`);
  }
  // The sandbox population must actually cover the links, or the isolated run above is
  // green only because it never resolved them.
  for (const name of directLinks(body)) {
    assert.ok(CLOSURE.includes(name), `${name} is linked but missing from the sandbox population`);
  }
  // A TAM map that does not route to the two skills that consume it is a dead end.
  for (const must of ['build-prospect-list', 'enrich-waterfall']) {
    assert.ok(directLinks(body).includes(must), `\`## Related\` must route onward to /${must}`);
  }
});

test('rule 2 — a boundary section that names what stays external', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /suppress/i, 'the boundary must restate the suppression stop');
  assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
  assert.match(boundary, /ai_enrich/, 'the local-inference rule: the boundary must state that no LLM hop is bought');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(skillBody(), /richapi-skills-preflight/);
});

test('the skill states its inference mode and why', () => {
  const body = skillBody();
  const idx = body.search(/^##\s+.*inference mode/im);
  assert.ok(idx > -1, 'no inference-mode section');
  const section = body.slice(idx, body.indexOf('\n## ', idx + 4));
  assert.match(section, /local/i, 'the mode itself must be named');
  assert.match(section, /ai_enrich/, 'the section must name the endpoint it is declining to call');
  assert.match(section, /perplexity/i,
    'the local-inference rule allows ai_enrich for Perplexity grounding or batch scale — say why neither applies');
  assert.match(section, /batch/i);
});

test('the documented steps run plan-before-spend, in that order (law 3)', () => {
  const body = skillBody();
  const at = re => body.search(re);
  const preflight = at(/^##\s+Before anything else/im);
  const dryRun    = at(/^##\s+Step 3 —/im);
  const spend     = at(/^##\s+Step 4 —/im);
  const report    = at(/^##\s+Step 6 —/im);
  assert.ok(preflight > -1 && dryRun > -1 && spend > -1 && report > -1,
    'the documented pipeline steps are not all present');
  assert.ok(preflight < dryRun, 'preflight must precede the first plan');
  assert.ok(dryRun < spend, 'the dry-run plan must precede the fan-out spend (law 3)');
  assert.ok(spend < report, 'reporting comes last');
});

test('it never claims a CLI verb the runtime does not ship', () => {
  const body = skillBody();
  const VERBS = new Set(['enrich', 'call', 'search', 'preflight', 'catalog', 'gates', 'help']);
  const used = new Set([...body.matchAll(/\brichapi\s+([a-z-]+)/g)].map(m => m[1]));
  used.delete('gates');
  for (const v of used) {
    assert.ok(VERBS.has(v), `\`richapi ${v}\` is not a verb bin/richapi ships`);
  }
  // The count-only gap is real and must be named as a gap, not written as a flag.
  assert.match(body, /count-only mode/i,
    'law 6: the missing count-only verb must be named as missing');
  assert.ok(!/--count-only/.test(body),
    'do not write a flag the CLI does not ship as though it existed');
});
