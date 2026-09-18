// tests/skills/outreach-expert/boundary.test.mjs
//
// The failure this file exists to prevent: a user finishes a session with a complete,
// confident sending plan and believes something was put into effect. Nothing was. No
// DNS record changed, no mailbox was created, no warmup started, no message left.
//
// Nothing in the runtime can catch that — the skill makes zero calls, so there is no
// journal line and no gate to fire. The prose is the only defence, so the prose is
// asserted, and the central claim is pinned to DATA: the catalog is checked for the
// sending endpoint the skill says does not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, boundarySection, loadCatalog, completedActionClaims } from '../crm-sync-expert/helpers.mjs';

const NAME = 'outreach-expert';
const body = skillBody(NAME);
const boundary = boundarySection(body);

test('the catalog really does contain no sending endpoint', () => {
  const catalog = loadCatalog();
  const SENDY = /(send_email|send_message|email_send|sequence|campaign_send|smtp|mailbox|warmup|dial|call_)/i;
  const offenders = Object.keys(catalog.endpoints).filter(n => SENDY.test(n));
  assert.deepEqual(offenders, [],
    `the catalog now has ${offenders.join(', ')}; /outreach-expert claims nothing here sends`);
});

test('the catalog contains no LinkedIn ACTION endpoint, only reads', () => {
  // An earlier version claimed the pack could drive profile views, likes and connection
  // requests "when paired with the automation layer". Every linkedin_* endpoint in the
  // pinned spec is a search or a read.
  const catalog = loadCatalog();
  const ACTIONS = /(connect|invite|message|dm|like|follow|post_create|visit)/i;
  const offenders = Object.keys(catalog.endpoints).filter(n => /linkedin/i.test(n) && ACTIONS.test(n));
  assert.deepEqual(offenders, [], `LinkedIn action endpoints appeared: ${offenders.join(', ')}`);
});

test('the boundary states that sending does not happen, and why', () => {
  assert.match(boundary, /will not send|does not send/i,
    'the boundary must say in plain words that nothing is sent');
  assert.match(boundary, /spam complaints/i,
    'the README gives the reason — owning sending means owning spam complaints — and it belongs here');
  assert.match(boundary, /deliberately external forever|permanent/i,
    'this is not a gap waiting to close; say which kind of absence it is');
  // The citation moved from the internal backlog to the README on 2026-09-01: that was
  // the developers' build log, and 14 skills were sending USERS into it. The law-6
  // requirement is unchanged — cite the stated boundary rather than asserting it —
  // only the target is now a document written for the reader.
  assert.match(boundary, /README\.md#what-this-pack-will-not-do/i,
    'cite the stated boundary rather than asserting it (law 6)');
});

test('the boundary closes the four adjacent doors a user will try next', () => {
  for (const [what, re] of [
    ['warmup execution', /warm/i],
    ['inbox hosting / mailbox creation', /inbox|mailbox/i],
    ['LinkedIn actions', /LinkedIn/i],
    ['dialing and direct mail', /dial/i],
  ]) {
    assert.match(boundary, re, `the boundary never closes ${what}; an unstated ceiling reads as a promise`);
  }
  assert.match(boundary, /ToS|terms of service/i,
    'LinkedIn actions are out on ToS grounds; the reason is the part that stops the argument');
  assert.match(boundary, /DNS/i, 'the skill reads DNS advice; it must say it changes nothing');
});

test('the earlier false capability claim is named and retracted', () => {
  // An earlier version of the skill said the pack supported "the LinkedIn half of this ... when paired
  // with the richapi automation layer". No such layer exists. A silent correction lets
  // the same sentence come back in the next rewrite.
  assert.match(body, /automation layer/i,
    'the retraction must name the false claim, or the next author reinstates it');
  assert.match(body, /there is no automation layer|never was one/i);
});

test('the skill never itself claims something was sent, warmed or configured', () => {
  const hits = completedActionClaims(body, [
    /\b(?:has been|have been|was|were|successfully)\s+(?:sent|delivered|warmed|configured|scheduled)\b/i,
    /\b(?:we|it|this skill) (?:sent|warmed|configured|scheduled)\b/i,
    /\bcampaign is (?:now )?live\b/i,
  ]);
  assert.deepEqual(hits, [],
    'these lines read as completed actions:\n' + hits.join('\n'));
});

test('the closing report is required to state what did NOT happen', () => {
  assert.match(body, /Not done:/,
    'a session that lists only decisions reads as a session that executed them');
  assert.match(body, /no message was sent/i);
  assert.match(body, /no DNS record was changed/i);
});

test('compliance is routed to the gate, not restated as a chapter', () => {
  assert.match(body, /\/comply/, '/comply owns the compliance verdict');
  assert.match(body, /gate/i);
  assert.match(body, /legal advice/i,
    'an outreach skill that discusses CAN-SPAM must disclaim, as /comply does');
});

test('statutory periods are the only quantities, and they cite the regime', () => {
  // Stricter than the shipped scanner on purpose. `scanForBareNumbers` matches a fixed
  // set of shapes (credits, spend, coverage, TTL) and none of them cover the numbers
  // THIS skill is tempted by — "warm for 14 days", "50 sends a mailbox", "200 per
  // variant". So the suite checks its own class of quantity, and permits exactly the two
  // escapes docs/skill-shape.md allows: a gate key, or a named statute on the same line.
  const QUANTITY = /\b\d[\d,]*\s+(?:\w+\s+)?(?:%|percent|days?|weeks?|months?|years?|hours?|sends?|emails?|messages?|mailboxes|domains?|steps?|variants?|contacts?|rows?|credits?)\b/i;
  const PERCENT = /\b\d[\d,]*(?:\.\d+)?\s*%/;
  const CITES_GATE = /gates\.yaml|\{\{\s*gates\./i;
  const CITES_STATUTE = /\b(?:GDPR|CCPA|CPRA|CASL|PECR|LGPD|CAN-?SPAM|HIPAA|COPPA|PIPEDA)\b/i;
  let inFence = false;
  const loose = [];
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!QUANTITY.test(line) && !PERCENT.test(line)) continue;
    if (CITES_GATE.test(line) || CITES_STATUTE.test(line)) continue;
    loose.push(line.trim());
  }
  assert.deepEqual(loose, [],
    'a quantity appears with neither a gate key nor a statute on the same line:\n' + loose.join('\n'));
});
