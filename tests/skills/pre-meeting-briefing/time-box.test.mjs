// tests/skills/pre-meeting-briefing/time-box.test.mjs
//
// This skill only earns its place next to /account-research because of a constraint:
// it is time-boxed and person-centred. The constraint is the product. If it erodes —
// "just add the funding round", "while we're here, map the committee" — what is left is
// a second, worse /account-research with the same endpoint surface and none of the
// gates, and nothing else in the repo would notice.
//
// So the box is asserted here, and asserted AGAINST /account-research's own text rather
// than against a list typed into this file. The forbidden set is whatever that skill's
// market pass currently reaches for: if it grows an endpoint, this suite demands this
// skill forbid the new one too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillBody, skillProse, section, subsection, invokedEndpoints, catalog, citedGateKeys,
} from './helpers.mjs';
import { loadGates, gateValue, isUnbounded } from '../../../_lib/gates.mjs';

const GATES = loadGates();
const body  = skillBody();
const prose = skillProse();

const AR = skillBody('account-research');
/** The endpoints /account-research's market pass reaches for, read from its own file. */
const marketPass = [...invokedEndpoints(section(/^Pass 4\b/, AR).text)].sort();
/** The endpoints /account-research's committee pass reaches for. */
const committeePass = [...invokedEndpoints(section(/^Pass 2\b/, AR).text)].sort();

test('the market pass is a real set, and this skill invokes none of it', () => {
  assert.ok(marketPass.length >= 4,
    `/account-research Pass 4 now reaches ${marketPass.length} endpoint(s) — re-read the box`);
  const invoked = invokedEndpoints(body);
  for (const e of marketPass) {
    assert.ok(!invoked.has(e), `${e} is invoked here but belongs to the market pass`);
  }
});

test('every market-pass endpoint is named as forbidden, not merely left out', () => {
  // Silence is not a boundary. A reader has to be able to tell "we chose not to" from
  // "nobody thought of it", and the next author has to hit a sentence before adding it.
  const box = section(/forbidden/i, body);
  for (const e of marketPass) {
    assert.ok(box.text.includes(e),
      `the box never names ${e}. /account-research Pass 4 reaches it; say why this skill does not.`);
  }
  assert.match(box.text, /permanently|never runs/i,
    'the market rule has to read as a rule, not as a default that a flag could change');
});

test('the committee pass is refused too, and the page-gated half of it is named', () => {
  const invoked = invokedEndpoints(body);
  for (const e of committeePass) {
    assert.ok(!invoked.has(e), `${e} is invoked here but belongs to the committee pass`);
  }
  const box = section(/forbidden/i, body);
  const gated = committeePass.filter(e => isUnbounded(GATES, e));
  assert.ok(gated.length > 0, 'the committee pass must still contain page-gated endpoints');
  for (const e of gated) {
    assert.ok(box.text.includes(e), `the box never names the page-gated ${e} it refuses to walk`);
  }
  assert.ok(box.text.includes('gates.yaml:unbounded_endpoints.endpoints'),
    'name the gate that page-gates them, so the refusal is checkable rather than asserted');
});

test('no page-gated endpoint is reachable from this skill at all', () => {
  const gated = Object.keys(catalog.endpoints).filter(e => isUnbounded(GATES, e));
  const invoked = invokedEndpoints(body);
  const leaked = gated.filter(e => invoked.has(e)).sort();
  assert.deepEqual(leaked, [],
    `page-gated endpoint(s) ${leaked.join(', ')} are invoked directly. A brief written under time `
    + 'pressure must never own a call whose total is a ceiling rather than a total.');
});

test('the one unbounded call it permits is capped by the gate that owns it', () => {
  const p = catalog.endpoints.profile_activities.pricing;
  // The three facts that make it dangerous, asserted against the catalog so the prose
  // starts failing the moment any of them changes.
  assert.equal(p.model, 'per_result');
  assert.equal(p.billing_field_present_in_response, false);
  assert.ok(isUnbounded(GATES, 'profile_activities'));
  assert.ok(gateValue(GATES, 'always_ask.endpoints').includes('profile_activities'));

  const box = section(/forbidden/i, body);
  assert.ok(box.text.includes('gates.yaml:skills.account_research.profile_activities_max_profiles'),
    'the ceiling must be cited by key, and it belongs to the skill that owns the endpoint');
  assert.match(box.text, /estimated_unverifiable/,
    'law 4: the ledger line cannot be reconciled, and the skill must say so');
  assert.match(box.text, /always_ask/,
    'it confirms on every call however low session spend is — cite that, do not imply it');
  assert.match(box.text, /one\s+profile/i, 'the call must be singular, in words a reader cannot miss');
});

test('the cross-endpoint page ceiling is inherited explicitly, not left to each endpoint', () => {
  // hard_page_ceiling is per-endpoint, so without a run-level ceiling several page-gated
  // endpoints can each walk to it and multiply the bill without any single gate firing.
  assert.ok(body.includes('gates.yaml:skills.account_research.max_pages_per_run'),
    'no run-level page ceiling is cited');
  assert.ok(body.includes('gates.yaml:unbounded_endpoints.pages_before_confirm'),
    'the per-page human gate is what turns an estimate into a bound; cite it');
  for (const key of citedGateKeys(body)) {
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
});

test('the single-call fraction is cited, because one call can blow the whole box', () => {
  for (const key of ['session_budget.fractions.single_call_confirm',
    'session_budget.fractions.confirm', 'session_budget.fractions.stop']) {
    assert.ok(body.includes(`gates.yaml:${key}`), `never cites gates.yaml:${key}`);
  }
});

test('the brief carries no contact details, so it cannot become an outreach list', () => {
  assert.match(prose, /never carries an email address or a phone number/i,
    'the no-contact-details rule must be stated, not implied');
  // And the worked example must obey it: no address, no phone column.
  const sheet = body.match(/```\nCALL SHEET[\s\S]*?```/);
  assert.ok(sheet, 'the skill must ship a worked call sheet — a format nobody can see is a format');
  assert.ok(!/@[a-z0-9.-]+\.[a-z]{2,}/i.test(sheet[0]),
    'the sample call sheet contains an email address');
  assert.ok(!/\bphone\b/i.test(sheet[0]), 'the sample call sheet contains a phone field');
  assert.match(sheet[0], /NOT CHECKED/,
    'a call sheet is defined by what it left out; the block is required');
});

test('the do-not-contact check fails closed', () => {
  const s = subsection(/do-not-contact/i, body);
  assert.match(s.text, /suppression store/i, 'the check must name the store it reads');
  assert.match(s.text, /without any\s*\n?\s*suggested follow-up|did not run/i,
    'an unreadable store must withhold the follow-up, not silently pass');
  assert.match(s.text, /law 5/,
    'a check that could not run is not a passing check — cite the law rather than paraphrasing it');
});

test('the justification against /account-research is in the file, not just in a review', () => {
  const s = section(/not `?\/account-research`?/i, body);
  assert.match(s.text, /person, not an account|unit is a person/i,
    'the person-vs-account difference is the load-bearing one and must be stated');
  assert.match(s.text, /twenty-three|owns .* endpoints/i,
    'name what /account-research already covers, so the overlap is acknowledged rather than hidden');
  assert.match(s.text, /route/i,
    'the section must end in a route, or it is a justification with no exit');
});

test('inference mode is local, and the originally proposed ai_enrich pass is refused out loud', () => {
  const s = subsection(/inference mode/i, body);
  assert.match(s.text, /local/i);
  assert.ok(!body.includes('ai_enrich('), 'ai_enrich must never be invoked here');
  assert.match(s.text, /local-inference rule/i, 'cite the rule the refusal rests on');
  assert.match(s.text, /Perplexity/i, 'name the first condition that would justify the paid hop');
  assert.match(s.text, /[Bb]atch scale/, 'name the second condition');
  assert.match(s.text, /declined|does not call/i,
    'an earlier design proposed an ai_enrich synthesis pass here; reversing it silently is worse '
    + 'than reversing it loudly');
});

test('the wrong-person gate exists and precedes any spend on activity', () => {
  const step1 = section(/the humans/i, body);
  assert.match(step1.text, /confirm the match before spending/i);
  assert.match(step1.text, /stops and asks/i, 'a bare common name must stop, not guess');
  const idx = (re) => body.search(re);
  assert.ok(idx(/wrong-person gate/i) < idx(/## Step 2/),
    'the identity gate must come before the section that spends on activity');
});
