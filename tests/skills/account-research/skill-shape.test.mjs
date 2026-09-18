// tests/skills/account-research/skill-shape.test.mjs
//
// The four enforced rules of docs/skill-shape.md, plus the real validator run in an
// isolated sandbox holding only this suite's skill (and the siblings it links to).
//
// Running `node scripts/validate-skills.mjs` against the live tree would make this
// suite's test result depend on ten other skills' in-progress SKILL.md files. The sandbox
// is the technique tests/skills/list-hygiene/ established; it is copied deliberately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

import {
  SKILL, SKILL_DIR, SKILL_MD, skillSource, skillBody, sections,
  validatorSandbox, runValidator, catalog, linkClosure,
} from './helpers.mjs';
import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';

const GATES = loadGates();
const BODY = skillBody();
const HEADINGS = sections(BODY).map(s => s.heading);

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const end = src.indexOf('\n---\n', 4);
  const fm = src.slice(4, end);
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
  for (const l of links) {
    assert.ok(existsSync(resolve(SKILL_DIR, l)), `broken relative link: ${l}`);
  }
});

test('rule 2 — a boundary section is present and states real ceilings', () => {
  assert.ok(HEADINGS.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const b = sections(BODY).find(s => /will not/i.test(s.heading));
  assert.match(b.text, /sending is deliberately external|sending .*external/i,
    'the pack\'s permanent ceiling (sending execution) must be stated, not implied');
  assert.match(b.text, /will not run the whole menu/i,
    'the central boundary of a 23-endpoint skill is that no flag runs all of it');
});

test('rule 3 — metered calls are covered by a visible plan', () => {
  const CATALOG = catalog();
  const invoked = [...BODY.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  const metered = invoked.filter(t => {
    const def = CATALOG.endpoints[t];
    return def && def.pricing && def.pricing.metered !== false;
  });
  assert.ok(metered.length > 0, 'this skill does spend credits; the fixture must reflect that');
  assert.ok(/dry[- ]?run/i.test(BODY), 'no dry-run reference');
  assert.ok(/gates\.yaml/.test(BODY), 'no gates.yaml citation');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = [...BODY.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 8, 'a credit-spending skill that cites almost no thresholds is hiding them');
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
});

test('law 1 — no bare credit, TTL or quality number is typed into the prose', () => {
  const findings = scanForBareNumbers(BODY, { file: `skills/${SKILL}/SKILL.md` });
  assert.deepEqual(findings, [],
    findings.map(f => `line ${f.line}: ${f.message}`).join('\n'));
});

test('the preflight preamble is present, and says what each failing key means', () => {
  assert.match(BODY, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(BODY.includes(key), `the preamble never says what ${key} means for this skill`);
  }
});

test('the skill never hand-rolls a paid call — everything goes through the runtime', () => {
  // A curl, a fetch, or a bare path into the API is the failure: the gated runtime is
  // what journals, ledgers, page-gates and reads through the cache.
  assert.ok(!/\bcurl\b/i.test(BODY), 'a paid call must not be described as a curl');
  assert.ok(!/api\.richapi|https?:\/\/[^\s)]*\/(?:enrich_company|lead_search)/i.test(BODY),
    'the skill must not name a raw API URL for a paid endpoint');
  assert.match(BODY, /richapi call /, 'the `call` verb is how a non-waterfall skill spends');
  assert.match(BODY, /richapi search /, 'the `search` verb is how a page-gated endpoint spends');
});

test('the CLI verbs this skill instructs actually exist in bin/richapi', () => {
  const cli = readFileSync(join(dirname(SKILL_MD), '..', '..', 'bin', 'richapi.mjs'), 'utf8');
  for (const verb of ['call', 'search', 'gates', 'catalog']) {
    assert.match(cli, new RegExp(`case '${verb}':`),
      `the SKILL.md tells the user to run \`richapi ${verb}\`, which bin/richapi does not dispatch`);
  }
  for (const flag of ['--dry-run', '--param', '--pages']) {
    assert.ok(BODY.includes(flag) ? cli.includes(flag.replace(/^--/, '')) : true,
      `the SKILL.md uses ${flag}, which bin/richapi does not parse`);
  }
});

test('the real validator passes on this skill in an isolated sandbox', () => {
  // Seeded with this skill alone: validatorSandbox() closes over the links transitively,
  // so a sibling's own routing cannot break this suite and a new link cannot silently
  // fall out of the sandbox.
  const dir = validatorSandbox([SKILL]);
  const population = linkClosure([SKILL]);
  assert.ok(population.includes('enrich-waterfall') && population.includes('richapi-gtm'),
    'this skill must route onward to the enrichment waterfall and the router');
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`${population.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});
