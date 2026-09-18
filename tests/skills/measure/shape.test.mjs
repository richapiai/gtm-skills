// docs/skill-shape.md, asserted for /measure and /learn.
//
// The four rules are checked by running the REAL validator, but inside a sandbox
// holding only this suite's two skills and the transitive closure of their link
// targets. Many skills are written in parallel into one skills/ directory; this suite being green
// must not depend on another skill's in-progress, half-written SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT, SKILL_MD, skillBody, frontmatterBlock, headings,
  validatorSandbox, runValidator, linkClosure,
} from './helpers.mjs';
import { loadGates, hasGate } from '../../../_lib/gates.mjs';

const GATES = loadGates();

const SKILLS = ['measure', 'learn'];

test('both skills exist where the pack expects them', () => {
  for (const s of SKILLS) assert.ok(existsSync(SKILL_MD(s)), `skills/${s}/SKILL.md is missing`);
});

test('the real validator passes both skills (all four shape rules)', () => {
  const { dir, names } = validatorSandbox(SKILLS);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed:\n${out}`);
  assert.match(out, new RegExp(`${names.length} skill\\(s\\) validated`));
  // The sandbox must actually contain this suite's work, or a green run means nothing.
  assert.ok(names.includes('measure') && names.includes('learn'), names.join(','));
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

  test(`${skill}: rule 4 — every cited gate key resolves (checked by the real validator above)`, () => {
    // Belt and braces: no citation may point at a key the pack does not ship. The
    // validator enforces this; asserting the citation set here makes a regression name
    // the offending key instead of printing a wall of validator output.
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
    assert.match(body, /##\s+Inference mode\s+—\s+local/i, 'the skill must state its inference mode');
    assert.match(body, /ai_enrich/, 'the local-inference rule wants the ai_enrich decision named explicitly');
    assert.match(body, /[Zz]ero API calls/, 'say that nothing is spent, not just that it is local');
  });

  test(`${skill}: does not invent a CLI verb the runtime does not ship`, () => {
    const SHIPPED = ['enrich', 'call', 'search', 'preflight', 'catalog', 'gates', 'help'];
    // A line that says "there is no `richapi measure` verb" is the OPPOSITE of the
    // failure this guards; law 6 wants the absence stated, not hidden.
    for (const line of skillBody(skill).split('\n')) {
      if (/\bno `?richapi/i.test(line)) {
        assert.match(line, /\bverb\b/, 'a denial must say plainly that the verb does not exist');
        continue;
      }
      for (const m of line.matchAll(/\brichapi\s+([a-z][a-z-]+)/g)) {
        assert.ok(SHIPPED.includes(m[1]),
          `references \`richapi ${m[1]}\`, which the CLI does not ship (law 6): ${line.trim()}`);
      }
    }
  });

  test(`${skill}: states plainly that there is no CLI verb for it`, () => {
    assert.match(skillBody(skill), new RegExp(`no \`richapi ${skill}\` verb`, 'i'),
      'law 6: say the verb does not exist rather than letting a reader assume it does');
  });
}

test('the two skills route to each other — the flywheel is not a dead end', () => {
  assert.match(skillBody('measure'), /\]\(\.\.\/learn\/SKILL\.md\)/);
  assert.match(skillBody('learn'), /\]\(\.\.\/measure\/SKILL\.md\)/);
});

test('the link closure is small and fully resolvable — no cross-skill contamination', () => {
  const names = linkClosure(SKILLS);
  for (const n of names) assert.ok(existsSync(SKILL_MD(n)), `closure names ${n}, which has no SKILL.md`);
});
