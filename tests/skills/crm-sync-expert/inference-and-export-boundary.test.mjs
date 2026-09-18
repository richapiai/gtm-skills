// tests/skills/crm-sync-expert/inference-and-export-boundary.test.mjs
//
// Two rules that have no home in the shape contract but are law for this pack:
//
//   Local inference — every skill states its inference mode and why. ai_enrich is 2 credits and
//         this pack already runs inside an LLM that infers for free, so a skill that
//         states no mode is the one that quietly starts paying for it.
//
//   Sole writer — /launch is the sole writer of a sender-format export. The validator has an
//         exact rule (an error) and a fuzzy one (a warning). This suite's definition of
//         done is zero warnings, so the fuzzy rule is asserted here rather than left to
//         a whole-repo run where another skill's output can bury the line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, section, senderExportParagraphs, RULED_SENDERS } from './helpers.mjs';

const NAME = 'crm-sync-expert';
const body = skillBody(NAME);
const mode = section(body, /^##.*inference mode/im);

test('the skill has a section that states its inference mode', () => {
  assert.ok(mode.length > 0,
    'no `## Inference mode` section — the local-inference rule requires every skill to state its mode and why');
  assert.match(mode, /Mode:/, 'the mode must be declared in a form a reader cannot miss');
  assert.match(mode, /\blocal\b/i);
});

test('the section says WHY, not just what', () => {
  assert.match(mode, /free|already runs inside|waste/i,
    'the reason must be recorded: the pack already runs inside a model that infers for free');
});

test('it names both permitted exceptions and rules both out', () => {
  assert.match(mode, /web grounding|Perplexity/i, 'the grounding exception is not named');
  assert.match(mode, /batch/i, 'the batch-scale exception is not named');
  assert.match(mode, /cannot arise|never will be|does not apply|do not apply/i,
    'naming the exceptions without ruling them out invites a future author to use one');
});

test('no LLM hop is invoked anywhere in the body', () => {
  assert.doesNotMatch(body, /`ai_enrich\(/, 'invokes ai_enrich(); this skill has no LLM hop');
  assert.doesNotMatch(body, /\boutput_schema\b/,
    'describes a structured LLM output; there is no LLM hop here to structure');
});

test('the body never names the sender-export writer', () => {
  assert.doesNotMatch(body, /\bwriteSenderExport\b/,
    'only /launch may reference writeSenderExport; this is a hard validator error');
});

test('no paragraph trips the validator\'s sender-export heuristic', () => {
  const hits = senderExportParagraphs(body);
  assert.deepEqual(hits, [],
    'a paragraph describes writing a contact list to a sender:\n' + hits.join('\n---\n'));
});

test('the skill names /launch as the sole writer, rather than merely avoiding it', () => {
  // Silence passes the linter. What the user needs is the route.
  assert.match(body, /sole writer/i, 'the skill must say who owns the sender export');
  assert.match(body, /\/launch/, 'and name it');
});

test('the sender-platform vocabulary is absent on purpose, and stays absent', () => {
  // This skill has no reason to name a sending tool. Keeping it that way is what keeps
  // the sole-writer heuristic quiet no matter how the copy is later edited.
  assert.doesNotMatch(body, RULED_SENDERS,
    'a sending platform is named in a CRM skill; that is /outreach-expert\'s territory');
});

test('it does not duplicate the export writer that another skill owns', () => {
  // /crm-export landed in parallel with this skill. It is the sole writer of the
  // CRM import file and it reads a mapping document as MAP=, so the handoff has to name
  // that seam rather than describing a file this skill could produce itself.
  assert.match(body, /\]\(\.\.\/crm-export\/SKILL\.md\)/,
    'the file writer must be linked so nobody improvises a second one');
  assert.match(body, /`MAP=`/,
    'the seam /crm-export offers for this skill\'s output must be named, or the mapping is a dead document');
  assert.match(body, /does not write the file|will not write the import file/i,
    'naming the writer without disclaiming the role invites a second writer');
});
