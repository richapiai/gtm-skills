// tests/skills/icp-review/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill, plus the honesty rules that matter most
// for a skill that spends: the stated API ceiling, the unverified field map, and the
// separation between an inferred value and a verified one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { checkSkillDualContract } from '../../../_lib/dual-contract.mjs';
import { SKILL_DIR, SKILL_MD, SKILL_NAME, skillSource, skillBody,
         validatorSandbox, runValidator, linkClosure } from './helpers.mjs';

const LINKED = linkClosure(['icp-review', 'gtm-kickoff']);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(SKILL_MD), 'skills/icp-review/SKILL.md is missing');
});

test('the real validator passes this suite, isolated from every other skill', () => {
  assert.ok(LINKED.includes('icp-review') && LINKED.includes('gtm-kickoff'),
    `the sandbox must contain both of this suite's skills; got ${LINKED.join(', ')}`);
  const dir = validatorSandbox(LINKED);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed over ${LINKED.join(', ')}:\n${out}`);
  assert.match(out, new RegExp(`${LINKED.length} skill\\(s\\) validated`));
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const block = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, new RegExp(`^name: ${SKILL_NAME}$`, 'm'));
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  assert.ok(block.split('\n').filter(l => /^\s+- /.test(l)).length >= 3);
});

test('rule 1 — a `## Related` section whose relative links all resolve', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0);
  for (const rel of links) assert.ok(existsSync(join(SKILL_DIR, rel)), `broken link: ${rel}`);
  assert.ok(links.some(l => l.includes('gtm-kickoff')), 'must route back to the skill that produces its input');
  assert.ok(links.some(l => l.includes('build-prospect-list')),
    'must route to the consumer of gtm/icp.yaml, and to the owner of the resolve this skill cannot do');
});

test('rule 2 — a boundary section that names the real ceilings, not just the obvious ones', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /send/i, 'sending is deliberately external forever');
  assert.match(boundary, /linkedin company url/i,
    'the boundary must state that this skill cannot resolve a domain or name into the '
    + 'LinkedIn company URL enrich_company() requires — an unstated ceiling reads as a promise');
  assert.match(boundary, /ai_inferred|model/i,
    'the boundary must state that inferred values are not evidence');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(skillBody(), /richapi-skills-preflight/);
});

test('rule 3 — the metered endpoints it invokes are covered by a visible plan (law 3)', () => {
  const body = skillBody();
  assert.match(body, /dry[- ]?run/i);
  assert.match(body, /gates\.yaml/);
  // Both paid steps must show a plan command, not merely mention planning.
  assert.match(body, /richapi call enrich_company[^\n]*--dry-run/);
  assert.match(body, /richapi call ai_enrich[\s\S]{0,200}--dry-run/);
});

test('rule 4 — every gate key the skill cites resolves against the real gates.yaml', () => {
  const gates = loadGates();
  const cited = [...skillBody().matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 3, 'a skill that spends must cite the policy it runs under');
  for (const key of cited) {
    assert.ok(hasGate(gates, key), `gates.yaml:${key} does not resolve — a missing key reads as STOP (law 5)`);
  }
  for (const key of ['cache_ttl.endpoints.ai_enrich', 'cache_ttl.endpoints.enrich_company',
                     'session_budget.fractions.single_call_confirm']) {
    assert.ok(cited.includes(key), `the skill does not cite gates.yaml:${key}`);
  }
});

test('law 1 — no hand-typed credit number, threshold, TTL or percentage in the prose', () => {
  const hits = scanForBareNumbers(skillBody(), { file: `skills/${SKILL_NAME}/SKILL.md` });
  assert.deepEqual(hits, [], hits.map(h => `line ${h.line}: ${h.message}`).join('\n'));
});

test('the dual-contract lint passes on the shipped body', () => {
  // Run the shipped rule directly as well as through the validator, so a failure here
  // names the LLM-hop problem instead of appearing as one line of validator output.
  const msgs = checkSkillDualContract({ label: SKILL_NAME, body: skillBody() });
  assert.deepEqual(msgs, [], msgs.join('\n'));
});

test('an inferred value is never merged into a verified one, and the skill says so', () => {
  const body = skillBody();
  assert.match(body, /never (merged|mixed)/i);
  assert.match(body, /dual-contract\.schema\.json|dual contract/i);
  assert.match(body, /storeLlmResult/,
    'validation must be delegated to the shipped engine, never re-implemented in a skill');
});

test('law 2 — the skill does not promise response columns it cannot verify', () => {
  const body = skillBody();
  assert.match(body, /field_map_status|field map/i,
    'enrich_company has no usable spec example; the skill must say the field map is unverified');
  assert.match(body, /report which .{0,30}absent|came back absent|reported as absent/i,
    'the honest report is "these came back absent", not a promised column set');
});

test('the documented steps run in the order the skill claims', () => {
  const body = skillBody();
  const at = re => body.search(re);
  const mode    = at(/^##.*inference mode/im);
  const inputs  = at(/^##.*read the inputs/im);
  const sample  = at(/^##.*sample, do not survey/im);
  const local   = at(/^##.*synthesise locally/im);
  const write   = at(/^##.*write .*icp\.yaml/im);
  assert.ok([mode, inputs, sample, local, write].every(i => i > -1), 'a documented step is missing');
  assert.ok(inputs < sample, 'you cannot sample before you know what the sample is drawn from');
  assert.ok(sample < local, 'the local synthesis reads the sample');
  assert.ok(local < write, 'the free reasoning happens before the artifact, and before any optional spend');
});

test('the paid sample is planned before it runs, in the prose order too', () => {
  const body = skillBody();
  const plan = body.indexOf('richapi call enrich_company --in gtm/icp/sample-won.csv --dry-run');
  const run  = body.indexOf('--out gtm/icp/won-enriched.csv');
  assert.ok(plan > -1 && run > -1, 'both the plan and the run command must be shown');
  assert.ok(plan < run, 'law 3: the plan is shown before the command that spends');
});

test('the skill does not describe hand-rolling a per-account loop when a bulk endpoint exists', () => {
  const body = skillBody();
  const LOOPY = /\b(for each|loop over|loop through|iterate|one at a time|row by row|per row|per contact)\b/i;
  for (const para of body.split(/\n\s*\n/)) {
    if (para.includes('enrich_company')) {
      assert.doesNotMatch(para, LOOPY,
        'the runtime chunks; a skill that describes looping pays the latency for the same credits');
    }
  }
  assert.match(body, /runtime decides whether to batch|never chooses/i,
    'the skill must say the batching decision belongs to the runtime');
});
