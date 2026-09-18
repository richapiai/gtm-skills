// tests/skills/signal-watch/skill-shape.test.mjs
//
// docs/skill-shape.md is FROZEN and its four rules are enforced by
// scripts/validate-skills.mjs. Running the real validator here — inside a sandbox
// holding only this suite's skills and their transitive link closure — means this suite
// is judged by the same code CI runs, and is not turned red by another skill's in-progress
// skill directory.
//
// The per-rule assertions below are not redundant with that run: they say WHICH rule
// broke when it breaks, and they cover the two things the validator deliberately does
// not check (customer mode, and the originally designed shape this skill was ported from).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hasGate, loadGates } from '../../../_lib/gates.mjs';
import {
  SKILL, SKILL_DIR, skillBody, frontmatterText, sections, section, proseOnly,
  validatorSandbox, runValidator, REPO_ROOT,
} from './helpers.mjs';

const GATES = loadGates();
const body = skillBody();
const flat = (t) => t.replace(/\s+/g, ' ');

test('the real validator passes on this suite\'s skills and everything they link to', () => {
  const dir = validatorSandbox([SKILL, 'reply-triage']);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, /skill\(s\) validated/);
});

test('rule 1 — `## Related` exists and every relative link resolves', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'a skill without `## Related` is a dead end');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 5, 'a skill in the middle of the pack routes onward in more than one direction');
  for (const rel of links) {
    assert.ok(existsSync(join(SKILL_DIR, rel)), `broken link: ${rel}`);
  }
});

test('rule 2 — the boundary section states what is permanently outside', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)));
  const f = flat(section(/will not do/i, body).text);
  assert.match(f, /will not schedule itself/i,
    'there is no scheduler in this pack, and a recurring skill that implies one is the '
    + 'single easiest way to leave a user believing a watch is running when it is not');
  assert.match(f, /sending is deliberately external|deliberately external/i);
  assert.match(f, /will not decide the play/i);
});

test('rule 3 — metered endpoints are invoked, and the plan is visible', () => {
  const invoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.ok(invoked.length > 0);
  assert.ok(/dry[- ]?run/i.test(body), 'law 3: every paid call is named and costed before it runs');
  assert.ok(/gates\.yaml/.test(body));
  assert.ok(/--dry-run/.test(body), 'the plan is produced by a real command, not by a promise');
  assert.ok(/makes \*\*zero calls\*\*|makes zero calls/i.test(flat(body)));
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = new Set([...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]));
  assert.ok(cited.size >= 10, 'a cost-careful recurring skill leans on more than a couple of keys');
  for (const key of cited) assert.ok(hasGate(GATES, key), `gates.yaml:${key} does not resolve`);
});

test('frontmatter satisfies the validator\'s required keys', () => {
  const fm = frontmatterText();
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, /^name: signal-watch$/m, 'frontmatter name must match the directory');
  assert.match(fm, /^version: \d+\.\d+\.\d+/m);
  assert.ok(existsSync(join(REPO_ROOT, 'skills', SKILL, 'SKILL.md')));
});

test('the preflight preamble is present, and says what each failure means', () => {
  assert.match(body, /richapi-skills-preflight/, 'the validator greps for this literally');
  const s = flat(section(/before anything else/i, body).text);
  assert.match(s, /CATALOG_OK/);
  assert.match(s, /API_KEY_SET/);
  assert.match(s, /SUPPRESSION: STOP/);
  assert.match(s, /BALANCE: unknown/);
});

test('the spine is the pack\'s spine: plan, approve, run, report', () => {
  const headings = sections(body).map(s => s.heading);
  const idx = (re) => headings.findIndex(h => re.test(h));
  const plan = idx(/subscription line/i);
  const run = idx(/run a cycle/i);
  const report = idx(/report honestly/i);
  const boundary = idx(/will not do/i);
  const related = idx(/^related/i);
  assert.ok(plan > 0 && run > plan && report > run && boundary > report && related > boundary,
    `expected plan < run < report < boundary < related, got ${JSON.stringify({ plan, run, report, boundary, related })}`);
});

test('customer mode is covered as a mode, not deferred to a future skill (plan E11)', () => {
  const s = section(/customer mode/i, body);
  const f = flat(s.text);
  assert.match(f, /mode, not a second skill/i);
  assert.match(f, /churn|renewal risk/i, 'the retention half of E11');
  assert.match(f, /expansion/i, 'the growth half of E11');
  assert.match(f, /`lead_search\(\)`/,
    'champion departure is a lead_search query, and naming the endpoint is what makes it real');
  assert.match(f, /past_companies/);
  assert.match(f, /current_companies/);
  assert.match(f, /recently_changed_jobs/,
    'the request field that makes champion tracking possible at all');
  assert.match(f, /Never infer the customer list/i,
    'a prospect list quietly reused as a customer list produces churn alerts about strangers');
  assert.match(f, /[Ss]uppression still applies/,
    'being a customer is not consent to be prospected');
});

test('the skill states the honest limits of the port it came from', () => {
  const f = flat(body);
  assert.match(f, /no date field at all/i,
    'linkedin_job_search has no datePosted; hiring recency comes only from the diff, and an '
    + 'earlier version claimed otherwise');
  assert.match(f, /baseline/i);
  assert.match(f, /A trigger is a change, not a state/i);
});

test('the three explicit null tokens are used, and no alias is offered', () => {
  const f = flat(body);
  for (const tok of ['not_found', 'not_verifiable', 'not_applicable']) {
    assert.ok(f.includes(tok), `the explicit null enum must include ${tok}`);
  }
  assert.match(f, /_lib\/dual-contract\.schema\.json/,
    'the null enum has one home and the skill points at it');
  const prose = proseOnly(body);
  for (const alias of ['"N/A"', '"n/a"', '"unknown"', '"none"', '"TBD"', '"no data"']) {
    assert.ok(!prose.includes(alias), `abolished null alias offered: ${alias}`);
  }
});
