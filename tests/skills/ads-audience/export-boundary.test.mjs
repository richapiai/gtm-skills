// tests/skills/ads-audience/export-boundary.test.mjs
//
// /launch is the SOLE writer of a sender-format export. An ads audience is also a
// file of contacts leaving the pack, so this suite had to answer a question rather than
// assume one: is this the same artifact under a different name, or a genuinely
// different one?
//
// The answer the skill defends is "different in kind, same discipline", and both halves
// are asserted here, because either half failing alone is a real failure:
//
//   * Different in kind — the audience carries digests to a platform that intersects
//     and returns a segment. Nothing addressed to an individual can be composed from
//     it. Refusing to build it because /launch exists would be over-application.
//   * Same discipline — this skill must never become a second export path. It does not
//     name the writer, does not reach the sender-export module, does not emit
//     sender-format columns, and does not offer itself as a way around a verdict.
//
// If a future edit turns the audience into an addressable file, the assertions on the
// bytes below are what fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { ensureSuppressionStore, sha256 } from '../../../_lib/suppression.mjs';
import { writeSenderExport, listContentHash, SenderExportRefused }
  from '../../../_lib/sender-export.mjs';
import { loadAudienceRules, planAudience, buildAudience, BUILD } from './harness.mjs';
import { SKILL, SKILL_MD, skillBody, sections, REPO_ROOT, tmpRoot } from './helpers.mjs';

const RULES = loadAudienceRules();
const GATES = loadGates();
const BODY = skillBody();
const FLOOR = gateValue(GATES, 'audience_minimums.linkedin');

// ---------------------------------------------------------------------------
// Same discipline: this skill is not a second export path.
// ---------------------------------------------------------------------------

test('the SKILL.md never names the sender-export writer — the validator rule holds unaided', () => {
  // Exact, not heuristic: the validator makes this an ERROR for any skill but /launch.
  assert.ok(!/\bwriteSenderExport\b/.test(BODY),
    'naming the writer is how a second export path starts');
});

test('the SKILL.md never describes pushing a contact list to a sender', () => {
  // The validator's warning-level heuristic, re-run here so a rewording that trips it
  // fails in this suite rather than in a merge. Zero warnings is a done-when.
  const SENDERS = /\b(smartlead|instantly|lemlist|woodpecker|reply\.io)\b/i;
  for (const para of BODY.split(/\n\s*\n/)) {
    if (SENDERS.test(para) && /\b(write|export|upload|push)\b/i.test(para) && /\b(csv|list|contacts|file)\b/i.test(para)) {
      assert.fail(`paragraph reads as writing a contact list to a sender:\n${para}`);
    }
  }
});

test('the harness does not reach the sender-export module', () => {
  const src = readFileSync(join(REPO_ROOT, 'tests', 'skills', SKILL, 'harness.mjs'), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.ok(!imports.some(i => /sender-export/.test(i)),
    'the executable form of this skill must not import the sender export writer either');
  assert.ok(imports.includes('../../../_lib/suppression.mjs'),
    'the audience must be written through the pack\'s single output-list writer');
});

test('the rules table declares /launch the owner, and refuses to substitute for a verdict', () => {
  assert.equal(RULES.sender_export.written_by_this_skill, false);
  assert.equal(RULES.sender_export.owner, 'launch');
  assert.equal(RULES.sender_export.substitute_for_failed_verdict, false,
    'an ads audience offered as a way around a FAIL verdict IS the second export path');
});

test('the pack itself refuses an ads-audience actor at the sender export — belt and braces', (t) => {
  const root = tmpRoot('ads-export-');
  ensureSuppressionStore(root);
  const rows = [{ email: 'a@acme.example', first_name: 'A' }];
  const file = join(root, 'send.csv');
  const verdict = { status: 'PASS', list_hash: listContentHash(rows), issued_at: new Date().toISOString() };

  assert.throws(
    () => writeSenderExport({ file, rows, platform: 'smartlead', verdict, root, actor: SKILL }),
    (e) => e instanceof SenderExportRefused,
    'even if this skill tried, the writer must refuse a non-launch actor');
  assert.equal(existsSync(file), false, 'a refused export leaves nothing behind');
});

test('the boundary section answers the question rather than asserting a difference', () => {
  const b = sections(BODY).find(s => /boundary with .?\/launch/i.test(s.heading));
  assert.ok(b, 'there is no section that states the /launch boundary');
  // Prose is hard-wrapped, so the claims are matched against a whitespace-collapsed
  // copy. These are assertions about the ANSWER being present, not about its wording:
  // each one names a decision the suite had to make, and a rewrite that drops the
  // decision should fail here.
  const flat = b.text.replace(/\s+/g, ' ');
  assert.match(flat, /never reports which rows matched/i,
    'the load-bearing claim — the platform does not report which rows matched, so no individual is addressable');
  assert.match(flat, /segment/i, 'the artifact the platform returns must be named');
  assert.match(flat, /not a workaround for a FAIL verdict/i,
    'the skill must refuse to be the route around a verdict, in words a reader will hit');
  assert.match(flat, /over-application/i,
    'the other failure direction — refusing a legitimately different feature — must be named too');
});

test('the boundary is also stated where a user will actually look for it', () => {
  const b = sections(BODY).find(s => /will not/i.test(s.heading));
  assert.ok(b, 'missing a boundary section');
  assert.match(b.text, /will not write a sender-format export/i);
  assert.match(b.text, /sending is deliberately external|deliberately external to this pack/i,
    'the pack\'s permanent ceiling must be stated, not implied');
  assert.match(b.text, /will not upload anything/i,
    'the pack writes a file; it does not touch an ad platform API');
});

// ---------------------------------------------------------------------------
// Different in kind: what the audience file actually is.
// ---------------------------------------------------------------------------

test('the audience file is not addressable — no sender-format column survives the write', () => {
  const root = tmpRoot('ads-export-file-');
  ensureSuppressionStore(root);
  const rows = Array.from({ length: FLOOR }, (_, i) => ({
    email: `p${i}@acme.example`, first_name: `P${i}`, last_name: 'Doe',
    company: 'Acme', company_domain: 'acme.example',
  }));
  const plan = planAudience({ rows, platform: 'linkedin', gates: GATES, root, rules: RULES });
  assert.equal(plan.decision, BUILD);
  const file = join(root, 'gtm', 'audiences', 'q3.linkedin.csv');
  buildAudience({ plan, file, root, gates: GATES, rules: RULES, call: () => null });

  const body = readFileSync(file, 'utf8');
  // The columns a sender needs to address a human being. None of them are here, and
  // that is the difference between the two artifacts made testable.
  // Whole column names: `sha256_email` contains `email` as a substring and must not
  // fail this for the wrong reason.
  const cols = body.split('\n')[0].split(',');
  for (const col of ['email', 'first_name', 'last_name', 'company', 'website', 'custom']) {
    assert.ok(!cols.includes(col), `sender-format column \`${col}\` is present`);
  }
  assert.ok(!body.includes('@'), 'an addressable file is a sender export by another name');
  assert.ok(body.includes(sha256('p0@acme.example')), 'the digest is what the platform matches on');
});

test('this skill needs no PASS verdict, and says why — that divergence is deliberate', () => {
  assert.ok(!/require_pass_verdict/.test(BODY),
    'ads-audience does not read /launch\'s verdict gate');
  const b = sections(BODY).find(s => /boundary with .?\/launch/i.test(s.heading));
  assert.match(b.text.replace(/\s+/g, ' '), /sendability/i,
    'the reason a campaign-review verdict does not apply must be stated, not assumed');
  assert.match(b.text.replace(/\s+/g, ' '), /suppression pass and the platform floor/i,
    'what IS required unconditionally must be named in the same breath');
});
