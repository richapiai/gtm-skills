// docs/skill-shape.md, asserted for /scheduled-workflow and /cost-optimizer.
//
// The four rules are checked by running the REAL validator, but inside a sandbox
// holding only this suite's two skills and the transitive closure of their link targets.
// Several skills are written in parallel into one skills/ directory; this suite being green must not
// depend on another skill's in-progress, half-written or entirely absent SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT, SKILL_MD, skillBody, skillSource, frontmatterBlock, headings,
  validatorSandbox, runValidator,
} from './helpers.mjs';
import { loadGates, hasGate } from '../../../_lib/gates.mjs';

const GATES = loadGates();

const SKILLS = ['scheduled-workflow', 'cost-optimizer'];

test('both skills exist where the pack expects them', () => {
  for (const s of SKILLS) assert.ok(existsSync(SKILL_MD(s)), `skills/${s}/SKILL.md is missing`);
});

test('the real validator passes both skills (all four shape rules)', () => {
  const { dir, names } = validatorSandbox(SKILLS);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed:\n${out}`);
  assert.match(out, new RegExp(`${names.length} skill\\(s\\) validated`));
  assert.ok(names.includes('scheduled-workflow') && names.includes('cost-optimizer'),
    `the sandbox must contain this suite's work or a green run means nothing: ${names.join(',')}`);
});

for (const skill of SKILLS) {
  test(`${skill}: frontmatter carries every required key and the name matches the directory`, () => {
    const block = frontmatterBlock(skill);
    for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
      assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
    }
    assert.match(block, new RegExp(`^name: ${skill}$`, 'm'));
    assert.match(block, /^version: \d+\.\d+\.\d+$/m);
    const triggers = block.split('\n').filter((l) => /^\s+- /.test(l));
    assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
  });

  test(`${skill}: rule 1 — a \`## Related\` section whose links all resolve`, () => {
    const body = skillBody(skill);
    assert.ok(headings(body).some((h) => /^related\b/i.test(h)), 'missing `## Related`');
    const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map((m) => m[1]);
    assert.ok(links.length > 0, '`## Related` must link to at least one other skill');
    for (const rel of links) {
      assert.ok(existsSync(join(REPO_ROOT, 'skills', skill, rel)), `broken link: ${rel}`);
    }
  });

  test(`${skill}: rule 2 — a boundary section that names what stays external`, () => {
    const body = skillBody(skill);
    assert.ok(headings(body).some((h) => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
      'missing a boundary section');
    const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
    assert.match(boundary, /API call/i, 'the boundary must state that nothing is spent');
    assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
  });

  test(`${skill}: rule 3 — the preflight preamble is present`, () => {
    assert.match(skillBody(skill), /richapi-skills-preflight/);
  });

  test(`${skill}: rule 4 — no citation points at a gate key the pack does not ship`, () => {
    // The validator enforces this; asserting the citation set here makes a regression
    // name the offending key instead of printing a wall of validator output. This suite's
    // own thresholds are GATE KEY REQUESTs, so they are read by the script (where a
    // missing key correctly fails closed) and never CITED in the prose.
    const cited = [...skillBody(skill).matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)]
      .map((m) => m[1]);
    // This asserted a DENYLIST of namespaces — a proxy for "these keys are not shipped
    // yet" that was true while the suite was pending and became false the moment they
    // merged. The check the comment above describes is the real one: every cited key
    // must RESOLVE. That is correct in both directions and cannot go stale.
    for (const key of cited) {
      assert.ok(hasGate(GATES, key),
        `${skill} cites gates.yaml:${key}, which does not resolve. A cited key that is `
        + 'not shipped reads as STOP at runtime (law 5), so the citation is worse than '
        + 'no citation — it silently disables the check it claims to configure.');
    }
  });

  test(`${skill}: states its inference mode and why`, () => {
    const body = skillBody(skill);
    assert.ok(headings(body).some((h) => /inference mode/i.test(h)),
      'the local-inference rule requires each skill to state its mode');
    const section = body.slice(body.search(/^#{2,3}\s+.*inference mode/im));
    assert.match(section, /local/i, 'the mode must be named');
    assert.match(section, /zero API calls/i, 'and the claim must be concrete');
    assert.match(section, /ai_enrich/,
      'the local-inference rule is specifically about not buying inference the agent already does for free');
  });

  test(`${skill}: no bare credit number survives outside a code fence`, () => {
    // Belt and braces over the validator's own scan (law 1). A hand-typed price is
    // stale within a quarter and these skills replace two earlier versions that were full of them.
    const body = skillBody(skill);
    let inFence = false;
    for (const [i, line] of body.split('\n').entries()) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      if (/gates\.yaml/.test(line)) continue;
      assert.ok(!/(?<!\w)\d[\d,]*(?:\.\d+)?\s*(?:credits?|cr)\b/i.test(line),
        `${skill}:${i + 1} carries a bare credit number: ${line.trim()}`);
    }
  });
}

test('the shipped scripts are the ones the tests exercise', () => {
  // These suites extract the fenced js block from the SKILL.md and run it. If a skill
  // ever stops shipping its script, the extraction throws — assert it here too so the
  // failure names the cause rather than surfacing as a cryptic error in another file.
  assert.match(skillSource('scheduled-workflow'), /==== gtm-schedule v1 ====/);
  assert.match(skillSource('cost-optimizer'), /==== gtm-cost-optimizer v1 ====/);
});
