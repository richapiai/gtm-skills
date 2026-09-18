// tests/skills/competitive-intel/skill-shape.test.mjs
//
// The four enforced rules of docs/skill-shape.md, plus the real validator run in an
// isolated sandbox holding only this suite's skills (and the siblings they link to).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SKILL, SKILL_DIR, REPO_ROOT, skillSource, skillBody, sections,
  validatorSandbox, runValidator, catalog, linkClosure,
} from './helpers.mjs';
import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';

const GATES = loadGates();
const BODY = skillBody();
const HEADINGS = sections(BODY).map(s => s.heading);

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const fm = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, new RegExp(`^name: ${SKILL}$`, 'm'));
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m);
});

test('rule 1 — `## Related` is present and every relative link resolves', () => {
  assert.ok(HEADINGS.some(h => /^related\b/i.test(h)), 'missing a `## Related` section');
  const links = [...BODY.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 3, 'a skill in a 33-skill pack that routes nowhere is a dead end');
  for (const l of links) assert.ok(existsSync(resolve(SKILL_DIR, l)), `broken relative link: ${l}`);
});

test('rule 2 — a boundary section is present and states the ceilings that matter here', () => {
  assert.ok(HEADINGS.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const b = sections(BODY).find(s => /will not/i.test(s.heading));
  assert.match(b.text, /sending is deliberately external/i,
    "the pack's permanent ceiling must be stated, not implied");
  assert.match(b.text, /will not run the whole menu/i,
    'the central boundary of a fifteen-endpoint skill is that no flag runs all of it');
  assert.match(b.text, /will not sweep several competitors in one run/i,
    'the multiplier is this skill\'s own hazard and belongs in its stated ceiling');
  assert.match(b.text, /will not report ad spend/i,
    'no endpoint returns spend; the boundary must say so before a user asks');
});

test('rule 3 — metered calls are covered by a visible plan', () => {
  const CATALOG = catalog();
  const invoked = [...BODY.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  const metered = invoked.filter(t => {
    const def = CATALOG.endpoints[t];
    return def && def.pricing && def.pricing.metered !== false;
  });
  assert.ok(metered.length > 0, 'this skill does spend credits');
  assert.ok(/dry[- ]?run/i.test(BODY), 'no dry-run reference');
  assert.ok(/gates\.yaml/.test(BODY), 'no gates.yaml citation');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = [...BODY.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 10, 'a fifteen-endpoint spending skill that cites few thresholds is hiding them');
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
});

test('the gate keys this skill reads are merged, and are cited properly', () => {
  // Was: the four keys were a request, named as bare dotted paths because a
  // `gates.yaml:` citation of a key that does not resolve is a rule-4 error. They are
  // merged now, so the citation form flips with them — each must be cited as
  // `gates.yaml:<key>` AND must resolve. The pairing is the point: a citation without a
  // key is rule 4's error, and a key nobody cites is a threshold the reader cannot
  // trace back to the file that sets it. The fail-closed direction these keys guard is
  // asserted in tier-discipline.test.mjs against a gates object with the block
  // stripped, which is what keeps law 5 covered now that the real file has the keys.
  const keys = [
    'skills.competitive_intel.max_competitors_per_sweep',
    'skills.competitive_intel.max_pages_per_run',
    'skills.competitive_intel.ad_details_max_per_competitor',
    'skills.competitive_intel.profile_activities_max_profiles',
  ];
  for (const key of keys) {
    assert.ok(BODY.includes(`gates.yaml:${key}`),
      `${key} resolves now, so the skill must cite it as gates.yaml:${key}`);
    assert.ok(hasGate(GATES, key), `${key} must resolve now that it is merged`);
  }
  const s = sections(BODY).find(x => /gate keys this skill still needs/i.test(x.heading));
  assert.ok(s, 'the skill must keep the table naming each key and what it bounds');
  for (const key of keys) assert.ok(s.text.includes(key), `the table never lists ${key}`);
});

test('law 1 — no bare credit, TTL or quality number is typed into the prose', () => {
  const findings = scanForBareNumbers(BODY, { file: `skills/${SKILL}/SKILL.md` });
  assert.deepEqual(findings, [], findings.map(f => `line ${f.line}: ${f.message}`).join('\n'));
});

test('earlier hand-typed prices are gone, not merely refreshed', () => {
  // An earlier version wrote "0.2/result", "2 credits", "5 credits", "6 credits" straight into the
  // prose, and `web_tech_stack` at "2 credits" was already wrong by the time this pack
  // was built. Law 1 exists for exactly that.
  assert.ok(!/\d\s*credits?\b/i.test(BODY.replace(/```[\s\S]*?```/g, '')),
    'a credit number is typed into the prose');
  assert.match(BODY, /read out of that catalog at plan time|straight out of the generated catalog/i,
    'the skill must say where prices come from instead of carrying them');
});

test('the preflight preamble is present, and says what each failing key means', () => {
  assert.match(BODY, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(BODY.includes(key), `the preamble never says what ${key} means for this skill`);
  }
  // Company-level tiers still run without a suppression store; the tier that surfaces
  // named executives does not.
  assert.match(BODY, /SUPPRESSION: STOP[\s\S]{0,300}Tier 3/,
    'the preamble must say which tier stops on an unreadable suppression store');
});

test('the skill never hand-rolls a paid call — everything goes through the runtime', () => {
  assert.ok(!/\bcurl\b/i.test(BODY), 'a paid call must not be described as a curl');
  assert.ok(!/api\.richapi/i.test(BODY), 'the skill must not name a raw API URL');
  assert.match(BODY, /richapi call /);
  assert.match(BODY, /richapi search /);
});

test('every page-gated endpoint is invoked through `richapi search`, never `richapi call`', () => {
  // The `call` verb prices one call; `search` is what plans and gates PAGES. Telling a
  // user to `richapi call linkedin_ad_search` is how a page-gated endpoint gets walked
  // without the gate ever being consulted.
  const CATALOG = catalog();
  for (const line of BODY.split('\n')) {
    const m = line.match(/^richapi (call|search) ([a-z_]+)/);
    if (!m) continue;
    const [, verb, endpoint] = m;
    const def = CATALOG.endpoints[endpoint];
    if (!def) continue;
    assert.equal(def.pricing.page_gated === true, verb === 'search',
      `\`richapi ${verb} ${endpoint}\`: page_gated=${def.pricing.page_gated} wants the other verb`);
  }
});

test('the CLI verbs this skill instructs actually exist in bin/richapi', () => {
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'richapi.mjs'), 'utf8');
  for (const verb of ['call', 'search', 'gates', 'catalog']) {
    assert.match(cli, new RegExp(`case '${verb}':`),
      `the SKILL.md tells the user to run \`richapi ${verb}\`, which bin/richapi does not dispatch`);
  }
  for (const flag of ['dry-run', 'param', 'pages']) {
    assert.ok(cli.includes(flag), `the SKILL.md uses --${flag}, which bin/richapi does not parse`);
  }
});

test('the real validator passes on this skill in an isolated sandbox', () => {
  const dir = validatorSandbox([SKILL]);
  const population = linkClosure([SKILL]);
  assert.ok(population.includes('org-map'), 'the two account-depth skills route to each other');
  assert.ok(population.includes('richapi-gtm'), 'every skill routes back to the router');
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`${population.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});
