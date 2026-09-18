// tests/skills/outreach-expert/endpoint-set-and-export-boundary.test.mjs
//
// Three things nothing else checks for this skill:
//
//   1. The endpoint set. `_lib/endpoint-owners.yaml` gives /outreach-expert nothing,
//      which is correct — deliverability advice is reasoning. An advisory skill that
//      quietly acquires a paid endpoint acquires a bill, silently.
//   2. Phantom endpoints. The validator only resolves names written in call form, so a
//      name in prose is unchecked. The API lost 13 endpoints in four months and
//      a rewritten skill carries the old names forward by accident.
//   3. Sole writer. /launch is the sole writer of a sender-format export. This skill discusses
//      sending tools for a living, which puts it closest of any skill in the pack to
//      the fuzzy heuristic's trip wire. The suite's bar is zero warnings, so the
//      heuristic is re-run here instead of being left to a whole-repo run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillBody, section, invokedEndpoints, backtickedIdentifiers, ownedEndpoints,
  loadCatalog, loadOwners, senderExportParagraphs,
} from '../crm-sync-expert/helpers.mjs';

const NAME = 'outreach-expert';
const body = skillBody(NAME);
const catalog = loadCatalog();
const mode = section(body, /^##.*inference mode/im);

// Empty on purpose. Every backticked snake_case token in this skill is an endpoint
// name, and it should stay that way: an entry added here is a claim that needs a
// justification next to it.
const NOT_ENDPOINTS = new Set([]);

test('the owners file assigns this skill no endpoints at all', () => {
  assert.deepEqual([...ownedEndpoints(NAME)].sort(), []);
});

test('the SKILL.md invokes nothing — zero paid calls, and the body proves it', () => {
  assert.deepEqual([...invokedEndpoints(body)].sort(), [],
    'this skill claims to make zero API calls; the body invokes an endpoint');
});

test('every endpoint the prose names actually exists in the generated catalog', () => {
  const suspects = [...backtickedIdentifiers(body)].filter(t => !NOT_ENDPOINTS.has(t));
  assert.ok(suspects.length > 0, 'the token scan found nothing; the regex has stopped working');
  for (const tok of suspects) {
    assert.ok(catalog.endpoints[tok],
      `\`${tok}\` reads as an endpoint but is not in _lib/api-catalog.json`);
  }
});

test('the endpoints it points at are the two that genuinely help before a send', () => {
  const named = [...backtickedIdentifiers(body)].filter(t => catalog.endpoints[t]).sort();
  assert.ok(named.includes('email_verifier'), 'verification is the cheapest bounce control there is');
  assert.ok(named.includes('identify_email_type'), 'role and disposable addresses drive complaints');
});

test('it names the OWNER of every endpoint it mentions, and does not claim them', () => {
  const owners = loadOwners();
  for (const tok of [...backtickedIdentifiers(body)].filter(t => catalog.endpoints[t] && t !== 'ai_enrich')) {
    const owning = owners.endpoints[tok] || [];
    assert.ok(!owning.includes(NAME), `${NAME} must not own ${tok}`);
    assert.ok(owning.some(s => body.includes(`/${s}`)),
      `${tok} is mentioned but none of its owners (${owning.join(', ')}) is routed to`);
  }
});

test('no retired endpoint name is named anywhere in the body', () => {
  for (const dead of ['find_emails', 'verify_emails', 'person_enricher', 'ad_search',
                      'company_enricher', 'email_validator']) {
    assert.doesNotMatch(body, new RegExp(`\\b${dead}\\b`),
      `${dead} is not in the pinned spec; it is a retired endpoint name`);
  }
});

test('the "spends nothing" claim is made explicitly, not left to inference', () => {
  assert.match(body, /^##.*what it spends/im);
  assert.match(body, /zero paid calls|makes no paid call/i);
});

// --- local inference --------------------------------------------------------

test('the skill states its inference mode, and it is local', () => {
  assert.ok(mode.length > 0, 'no `## Inference mode` section');
  assert.match(mode, /Mode:/);
  assert.match(mode, /\blocal\b/i);
  assert.match(mode, /free|already runs inside|waste/i, 'the WHY must be recorded');
});

test('both permitted exceptions are named and ruled out', () => {
  assert.match(mode, /web grounding|Perplexity/i);
  assert.match(mode, /batch/i);
  assert.match(mode, /cannot arise|never will be|does not apply|do not apply/i);
});

test('no LLM hop is invoked anywhere in the body', () => {
  assert.doesNotMatch(body, /`ai_enrich\(/);
  assert.doesNotMatch(body, /\boutput_schema\b/);
});

// --- the sole sender-export writer -------------------------------------------

test('the body never names the sender-export writer', () => {
  assert.doesNotMatch(body, /\bwriteSenderExport\b/,
    'only /launch may reference writeSenderExport; this is a hard validator error');
});

test('no paragraph trips the validator\'s sender-export heuristic', () => {
  const hits = senderExportParagraphs(body);
  assert.deepEqual(hits, [],
    'a paragraph describes writing a contact list to a sender:\n' + hits.join('\n---\n'));
});

test('the skill hands the export off rather than quietly avoiding the subject', () => {
  assert.match(body, /sole writer/i);
  assert.match(body, /\/launch/);
  assert.match(body, /PASS verdict/,
    'the export is bound to a verdict; a handoff that omits the gate is half a handoff');
});

test('the four deliverability thresholds are cited from the namespace, not described', () => {
  // WAS: "the gate keys it requests are stated as a request, not cited as if they
  // existed". That was correct while `skills.outreach_expert` did not exist — rule 4
  // fails on a citation that does not resolve, so the skill named the shape of each
  // rule and no value. The cost of that was the skill answering none of the four
  // questions it exists to answer. The namespace has landed, so the obligation is now
  // the opposite one, and this test holds the new side of it.
  const requested = section(body, /^##.*refuses to hand-type/im);
  assert.ok(requested.length > 0, 'the section naming the four thresholds is gone');
  assert.match(requested, /_lib\/gates\.yaml/, 'say where the value lives');
  for (const key of ['max_sends_per_mailbox_per_day', 'warmup_min_days',
                     'spam_complaint_max_pct', 'unsubscribe_max_pct']) {
    assert.match(requested, new RegExp(`gates\\.yaml:skills\\.outreach_expert\\.${key}\\b`),
      `the section must cite gates.yaml:skills.outreach_expert.${key}, not describe its shape`);
  }
  // The honest caveat has to survive the numbers. This skill executes nothing: three
  // of the four values are platform convention, not published receiver policy, and a
  // confident wrong number here costs a domain rather than a credit.
  assert.match(requested, /platform/i,
    'the user must still be sent to their own sending platform to confirm the value');
  assert.doesNotMatch(requested, /do not invent values|Until those keys exist/i,
    'the keys exist; prose saying otherwise is the stale-absence-claim bug (law 6)');
});

test('it does not redesign the cadence that /sequence-builder owns', () => {
  // /sequence-builder landed in parallel with this skill and owns step count,
  // spacing and channel — and has already requested gate keys for the first two. Two
  // skills asking for the same threshold under two names is how one of them goes stale
  // without anyone noticing, so this skill routes instead of restating.
  assert.match(body, /\]\(\.\.\/sequence-builder\/SKILL\.md\)/,
    'the cadence owner must be linked, not shadowed');
  const step6 = section(body, /^##.*Step 6/im);
  assert.match(step6, /sequence-builder/,
    'the hygiene section must hand cadence design over in the section that touches it');
  const requested = section(body, /^##.*refuses to hand-type/im);
  // Only the TABLE ROWS are the request. The prose around it says why step count and
  // spacing are absent, which is the part that has to survive a future edit.
  const rows = requested.split('\n').filter(l => /^\|/.test(l) && !/^\|\s*-/.test(l));
  assert.ok(rows.length >= 4, 'the requested-keys table is gone or unrecognisable');
  for (const row of rows) {
    assert.doesNotMatch(row, /step count|spacing|cadence/i,
      `this suite must not request a threshold /sequence-builder already owns: ${row.trim()}`);
  }
  assert.match(requested, /sequence-builder/,
    'the reason those two are absent must be recorded, or the next author adds them back');
});
