// tests/skills/sequence-builder/no-endpoints.test.mjs
//
// /sequence-builder owns ZERO endpoints, deliberately: sequence design is thinking, not
// fetching. Everything a design needs — the evidence, the copy, the audience — was
// already bought by a skill upstream, so a fetch here is a re-buy.
//
// "Owns zero" is easy to write and easy to erode. The erosion is always the same shape:
// somebody adds "and while we're here, pull the company's headcount". So the absence is
// asserted in three independent ways — against the owners file, against the validator's
// own invocation pattern, and against the catalog's full endpoint name list, because an
// endpoint mentioned in prose is the step before an endpoint invoked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const body = skillBody();

test('the owners file assigns this skill no endpoints at all', () => {
  assert.deepEqual([...ownedEndpoints()], [],
    `${SKILL} must own zero endpoints — design is thinking, not fetching`);
});

test('the SKILL.md invokes no endpoint', () => {
  assert.deepEqual([...invokedEndpoints(body)], [],
    'a zero-endpoint skill must contain no `endpoint(` invocation');
});

test('the SKILL.md does not so much as name an endpoint', () => {
  const named = Object.keys(CATALOG.endpoints)
    .filter(n => new RegExp(`\\b${n}\\b`).test(body))
    .sort();
  assert.deepEqual(named, [],
    `names endpoint(s): ${named.join(', ')} — naming one here is the step before calling one. `
    + 'If the design needs that fact, the fetch belongs to the skill that owns it.');
});

test('it therefore reaches no unclaimed or disabled endpoint either', () => {
  for (const name of Object.keys(OWNERS.unclaimed || {})) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(body), `${name} is unclaimed and must not appear`);
  }
});

test('inference mode is local, and the paid LLM hop is unreachable from here', () => {
  assert.ok(!ownedEndpoints().has('ai_enrich'), 'the owners file gives ai_enrich to other skills');
  assert.ok(!/ai_enrich/.test(body), 'a zero-endpoint skill must not even name the paid LLM hop');
  assert.match(body, /Inference mode: local/i,
    'a local-inference skill states its inference mode and why');
  assert.match(body, /Perplexity web grounding/i,
    'the local-inference rule requires the two justifying conditions be addressed by name');
  assert.match(body, /[Bb]atch scale/,
    'the local-inference rule requires the two justifying conditions be addressed by name');
});

test('it spends nothing, and says so', () => {
  assert.match(body, /zero endpoints, zero API calls/i,
    'the boundary section must state the zero-spend fact plainly');
  assert.match(body, /API_KEY_SET: no/,
    'a zero-spend skill must say that a missing key is not a blocker');
});
