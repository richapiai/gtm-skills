// tests/skills/reply-triage/skill-shape.test.mjs
//
// The four frozen rules of docs/skill-shape.md, run through the real validator inside a
// sandbox (so another skill's in-progress skill directory cannot decide whether this suite is
// green), plus per-rule assertions that name WHICH rule broke.
//
// The last two tests cover the shape decisions specific to this skill: the five buckets
// the design specifies, and the fact that no inbox endpoint exists — which
// is a permanent ceiling, not a gap waiting to be filled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hasGate, loadGates, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  SKILL, SKILL_DIR, SKILL_MD, skillBody, frontmatterText, sections, section, proseOnly,
  validatorSandbox, runValidator,
} from './helpers.mjs';

const GATES = loadGates();
const body = skillBody();
const flat = (t) => t.replace(/\s+/g, ' ');

test('the real validator passes on this suite\'s skills and everything they link to', () => {
  const dir = validatorSandbox([SKILL, 'signal-watch']);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, /skill\(s\) validated/);
});

test('rule 1 — `## Related` exists and every relative link resolves', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)));
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 5);
  for (const rel of links) assert.ok(existsSync(join(SKILL_DIR, rel)), `broken link: ${rel}`);
  assert.ok(links.includes('../comply/SKILL.md'),
    'the suppression store this skill writes into is /comply\'s, and the route there is not optional');
});

test('rule 2 — the boundary section states what is permanently outside', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)));
  const f = flat(section(/will not do/i, body).text);
  assert.match(f, /will not send anything/i, 'sending is deliberately external, permanently');
  assert.match(f, /will not connect to a mailbox/i);
});

test('rule 3 — a metered endpoint is invoked, and the plan is visible', () => {
  const invoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.ok(invoked.includes('ai_enrich'));
  assert.ok(/dry[- ]?run/i.test(body), 'law 3: every paid call is named and costed before it runs');
  assert.ok(/gates\.yaml/.test(body));
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]));
  assert.ok(cited.size >= 3);
  for (const key of cited) assert.ok(hasGate(GATES, key), `gates.yaml:${key} does not resolve`);
});

test('law 1 — no hand-typed credit numbers or thresholds', () => {
  const findings = scanForBareNumbers(body, { file: SKILL_MD });
  assert.deepEqual(findings, [], findings.map(f => `${f.line}: ${f.message}`).join('\n'));
});

test('the statute escape is used only where a statute is actually named', () => {
  const prose = proseOnly(body);
  for (const line of prose.split('\n')) {
    if (!/\b\d/.test(line)) continue;
    if (/gates\.yaml/.test(line)) continue;
    // The only numeric prose lines left must carry a named regime on the same line.
    const numericThreshold = /\b(?:at least|minimum of|within|no fewer than)\s+\d/.test(line);
    if (!numericThreshold) continue;
    assert.match(line, /\b(?:GDPR|CCPA|CPRA|CASL|PECR|CAN-?SPAM)\b|\bArticle\s*\d+/,
      `numeric period with no named regime on the line: ${line.trim()}`);
  }
  assert.match(flat(body), /CAN-SPAM requires an opt-out be honoured within 10 business days/,
    'the statutory window is a fact about the law, not a policy this pack sets');
  assert.match(flat(body), /GDPR Article 21/);
  assert.match(flat(body), /The pack does not use that window/i,
    'the entry is written immediately; a statutory deadline is not a licence to wait');
});

test('frontmatter satisfies the validator\'s required keys', () => {
  const fm = frontmatterText();
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, /^name: reply-triage$/m);
  assert.match(fm, /^version: \d+\.\d+\.\d+/m);
});

test('the preflight preamble is present', () => {
  assert.match(body, /richapi-skills-preflight/, 'the validator greps for this literally');
});

test('the spine is the pack\'s spine, with the compliance gate ahead of the sorting', () => {
  const headings = sections(body).map(s => s.heading);
  const idx = (re) => headings.findIndex(h => re.test(h));
  const gate = idx(/Stage A/i);
  const classify = idx(/Stage B/i);
  const mode = idx(/Inference mode/i);
  const report = idx(/report honestly/i);
  const boundary = idx(/will not do/i);
  const related = idx(/^related/i);
  assert.ok(gate > 0 && classify > gate && mode > classify && report > mode
    && boundary > report && related > boundary,
    `unexpected order: ${JSON.stringify({ gate, classify, mode, report, boundary, related })}`);
});

test('the five reply buckets from the design are all present', () => {
  const f = flat(body);
  for (const bucket of ['Interested', 'Objection', 'Not now', 'Wrong person']) {
    assert.ok(new RegExp(`\\*\\*${bucket}\\*\\*`, 'i').test(f), `missing bucket: ${bucket}`);
  }
  assert.match(f, /out of office/i, 'the plan names OOO; it lands in "not now", not "interested"');
  assert.match(f, /An out-of-office is `not now`, not `interested`/i);
  assert.match(f, /An objection is engagement/i);
  assert.match(f, /Never invent the named colleague/i,
    'a wrong-person reply produces a name, not a contact');
});

test('the absence of inbox endpoints is stated as a permanent ceiling', () => {
  const f = flat(body);
  assert.match(f, /no inbox endpoints in this API/i);
  assert.match(f, /paste, or a reply export/i);
  assert.match(f, /inbox hosting is deliberately outside the ceiling, permanently/i);
});
