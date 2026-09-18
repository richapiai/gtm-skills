// tests/evals/research-agent/no-findable-answer.test.mjs
//
// THE Iron-Law case for /research-agent, and the case the design names by hand:
//
//   law:  'a question with no findable answer yields the explicit null'
//   ask:  "What is this 4-person company's exact ARR?"
//   must: 'return not_found. Private ARR is not discoverable.'
//
// That fixture is inherited VERBATIM from tests/evals/iron-laws.test.mjs
// PENDING_FIXTURES['research-agent'], which was written before this skill existed
// precisely so the author would not get to invent an easier case. The three strings
// below are copied character for character, and the last test in this file re-reads
// the Iron-Law suite and fails if they ever diverge.
//
// Every assertion is on the DECISION and the explicit-null enum value. None is on the
// prose — a prose assertion passes forever the moment somebody rewords a paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadResearchRoutes, classifyQuestion, planFanOut, answerRow,
  ANSWER_NULL, ROUTE, NOT_FOUND, NULL_ENUM, REPO,
} from '../../skills/research-agent/harness.mjs';
import { catalog, gatesWithRequestedKeys } from '../../skills/research-agent/helpers.mjs';
import { loadGates } from '../../../_lib/gates.mjs';

/** Verbatim from PENDING_FIXTURES['research-agent'] in tests/evals/iron-laws.test.mjs. */
const FIXTURE = Object.freeze({
  law: 'a question with no findable answer yields the explicit null',
  ask: "What is this 4-person company's exact ARR?",
  must: 'return not_found. Private ARR is not discoverable.',
});

const ROUTES = loadResearchRoutes();
const CATALOG = catalog();
const GATES = gatesWithRequestedKeys(loadGates());

test('a question the pack CAN answer is routed — so every refusal below is specific', () => {
  const cls = classifyQuestion({ question: 'find their pricing page and summarise the plans', routes: ROUTES });
  assert.equal(cls.decision, ROUTE);
  assert.equal(cls.template, 'site_page_lookup');
  assert.equal(cls.null, null);
});

test('THE case — "What is this 4-person company\'s exact ARR?" yields the explicit null', () => {
  const cls = classifyQuestion({ question: FIXTURE.ask, routes: ROUTES });

  assert.equal(cls.decision, ANSWER_NULL, 'the register must catch this before any routing');
  assert.equal(cls.null, NOT_FOUND, `must ${FIXTURE.must}`);
  assert.ok(NULL_ENUM.includes(cls.null), 'the refusal must use the one explicit null enum');
  assert.equal(cls.shape, 'private_financials');

  const answered = answerRow({ classification: cls, routes: ROUTES });
  assert.equal(answered.result, NOT_FOUND);
  assert.equal(answered.null, NOT_FOUND);
  assert.equal(answered.record.result, NOT_FOUND, 'the record itself carries the enum, not prose about it');
  assert.equal(typeof answered.record.confidence, 'number', 'a worded confidence was abolished');
  assert.ok(answered.record.reasoning.length > 0, 'a null with no reasoning is indistinguishable from a failed call');
});

test('refusing is FREE — the register is checked before routing and plans zero calls', () => {
  // A refusal that costs money is a refusal users learn to avoid, and a skill whose
  // guardrail has a price is a skill whose guardrail gets switched off.
  const plan = planFanOut({ question: FIXTURE.ask, rows: 500, catalog: CATALOG, gates: GATES, routes: ROUTES });
  assert.equal(plan.decision, ANSWER_NULL);
  assert.equal(plan.calls_made, 0);
  assert.equal(plan.per_row.length, 0);
  assert.equal(plan.per_row_credits, 0);
  assert.equal(plan.list_total_credits, 0);
  assert.equal(plan.spend, 'none');
  assert.equal(plan.null, NOT_FOUND);
});

test('the refusal cannot be laundered by rephrasing the same question', () => {
  const rephrasings = [
    "What is this 4-person company's exact ARR?",
    'what is their ARR',
    'estimate their ARR for me',
    'roughly what is their annual recurring revenue',
    'how much revenue does this company make',
    'what is their MRR',
    'what is their gross margin',
    'what is their burn rate',
    'what is their valuation',
    'what is their churn rate',
  ];
  for (const q of rephrasings) {
    const cls = classifyQuestion({ question: q, routes: ROUTES });
    assert.equal(cls.decision, ANSWER_NULL, `"${q}" was not refused`);
    assert.equal(cls.null, NOT_FOUND, `"${q}" returned ${cls.null}`);
    assert.equal(answerRow({ classification: cls, routes: ROUTES }).result, NOT_FOUND);
  }
});

test('the refusal cannot be laundered by asking a route to answer it anyway', () => {
  // The tempting failure: run the open-web search, get a directory page full of
  // guessed revenue bands, and return one. A route that comes back empty is not a
  // licence to fill the gap.
  const cls = classifyQuestion({ question: 'find any recent news about them', routes: ROUTES });
  assert.equal(cls.decision, ROUTE);
  for (const empty of [undefined, null, '']) {
    const answered = answerRow({ classification: cls, finding: empty, routes: ROUTES });
    assert.equal(answered.result, NOT_FOUND, `an empty finding rendered as ${JSON.stringify(answered.result)}`);
    assert.ok(NULL_ENUM.includes(answered.result));
  }
});

test('a plausible sentence is not an answer — the prose nulls are rejected outright', () => {
  const cls = classifyQuestion({ question: 'find any recent news about them', routes: ROUTES });
  for (const prose of ['not publicly disclosed', 'Could not find it.', 'unable to determine',
    'no information available', 'likely around $2M']) {
    assert.throws(
      () => answerRow({ classification: cls, finding: prose, routes: ROUTES }),
      /null wearing prose|dual contract rejects/,
      `${JSON.stringify(prose)} was accepted as an answer`);
  }
});

test('the register is specific, not a blanket refusal — a filer with a ticker routes', () => {
  // A register that refused every money question would be safe and useless. The escape
  // needs the ticker IN THE ROW; guessing that a company is public is how a register
  // gets talked out of a refusal.
  const withTicker = classifyQuestion({
    question: 'what is their revenue', row: { public_ticker: 'ACME' }, routes: ROUTES,
  });
  assert.equal(withTicker.decision, ROUTE);
  assert.equal(withTicker.template, 'open_web_fact');

  const withoutTicker = classifyQuestion({ question: 'what is their revenue', row: {}, routes: ROUTES });
  assert.equal(withoutTicker.decision, ANSWER_NULL);
  assert.equal(withoutTicker.null, NOT_FOUND);
});

test('the whole undiscoverable register answers with the enum and never with a value', () => {
  const asks = [
    'who does the new SDR report to',           // internal_org_edges
    'when was the domain registered',            // infrastructure_records
    'what does their 10-K say about AI',         // gated_document_bodies
    'what is their fleet size',                  // private_operations
    'how good is their website design',          // subjective_judgement
  ];
  for (const q of asks) {
    const cls = classifyQuestion({ question: q, routes: ROUTES });
    assert.equal(cls.decision, ANSWER_NULL, `"${q}" was not caught by the register`);
    assert.ok(NULL_ENUM.includes(cls.null), `"${q}" returned ${cls.null}`);
    assert.equal(cls.planned_calls, 0, `"${q}" planned a paid call to produce a refusal`);
    const answered = answerRow({ classification: cls, routes: ROUTES });
    assert.ok(NULL_ENUM.includes(answered.result));
  }
});

test('an unrecognised question is REFUSED, not improvised into a route', () => {
  const cls = classifyQuestion({ question: 'what colour is their office carpet', routes: ROUTES });
  assert.equal(cls.decision, 'refuse');
  assert.equal(cls.template, null);
  assert.equal(cls.planned_calls, 0);
  assert.equal(answerRow({ classification: cls, routes: ROUTES }).result, NOT_FOUND);
});

test('the fixture is still character-identical to the one the Iron-Law suite recorded', () => {
  // The whole point of writing the case down before the skill existed was that nobody
  // would later re-invent it into something easier to pass. Once the orchestrator
  // deletes PENDING_FIXTURES['research-agent'] this test goes quiet; while it is still
  // there, a divergence is a failure.
  const p = join(REPO, 'tests', 'evals', 'iron-laws.test.mjs');
  if (!existsSync(p)) return;
  const src = readFileSync(p, 'utf8');
  const block = src.match(/'research-agent':\s*\{([\s\S]*?)\n\s*\},/);
  if (!block) return;                       // already removed — nothing to compare against
  const field = (name) => {
    const m = block[1].match(new RegExp(`${name}:\\s*(['"])([\\s\\S]*?)\\1,`));
    return m ? m[2] : null;
  };
  assert.equal(field('law'), FIXTURE.law, 'the Iron Law text drifted from the recorded fixture');
  assert.equal(field('ask'), FIXTURE.ask, 'the adversarial question drifted from the recorded fixture');
  assert.equal(field('must'), FIXTURE.must, 'the required answer drifted from the recorded fixture');
});
