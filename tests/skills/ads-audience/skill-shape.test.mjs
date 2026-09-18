// tests/skills/ads-audience/skill-shape.test.mjs
//
// The four enforced rules of docs/skill-shape.md, plus the real validator run in an
// isolated sandbox holding only this suite's skill and the siblings it links to.
//
// Running `node scripts/validate-skills.mjs` against the live tree would make this
// suite's result depend on every other in-progress skill — on 2026-08-29 the tree carried
// five skill directories with no SKILL.md in them yet. The sandbox is the technique
// tests/skills/account-research/ established; it is copied deliberately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SKILL, SKILL_DIR, REPO_ROOT, skillSource, skillBody, sections,
  validatorSandbox, runValidator, catalog, linkClosure, tmpRoot,
} from './helpers.mjs';
import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { loadAudienceRules, AudienceRulesUnavailable, SKILL_PATH } from './harness.mjs';

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
  assert.ok(links.some(l => l.includes('/launch/')), 'the export owner must be routed to, not just mentioned');
  assert.ok(links.some(l => l.includes('/comply/')), 'lawful basis for ad targeting belongs to /comply');
});

test('rule 2 — a boundary section is present and states real ceilings', () => {
  assert.ok(HEADINGS.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
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
  assert.ok(cited.length >= 5, 'a credit-spending skill that cites almost no thresholds is hiding them');
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
  // The three platform floors specifically: the skill must not quote one from memory.
  for (const p of ['linkedin', 'meta', 'google']) {
    assert.ok(cited.includes(`audience_minimums.${p}`), `the ${p} floor is not cited by key`);
  }
});

test('law 1 — no bare credit, minimum, TTL or quality number is typed into the prose', () => {
  const findings = scanForBareNumbers(BODY, { file: `skills/${SKILL}/SKILL.md` });
  assert.deepEqual(findings, [], findings.map(f => `line ${f.line}: ${f.message}`).join('\n'));
});

test('the gate keys this skill reads are merged, and are cited properly', () => {
  // Naming them `gates.yaml:...` would fail rule 4 today and ship a skill that reads
  // STOP forever if the merge never happens. Naming them bare is the idiom
  // skills/personalize/SKILL.md established for a key still in flight.
  for (const key of ['skills.ads_audience.pre_match_headroom_multiple', 'skills.ads_audience.max_fill_rows']) {
    assert.ok(BODY.includes(key), `the requested key ${key} is not named in the skill`);
    assert.ok(BODY.includes(`gates.yaml:${key}`),
      `${key} resolves now, so the skill must cite it as gates.yaml:${key}`);
    assert.equal(hasGate(GATES, key), true,
      `${key} must resolve — a key a skill reads but gates.yaml lacks is a skill `
      + 'permanently failing closed, which is safe and useless');
  }
});

test('the preflight preamble is present, and says what each failing key means', () => {
  assert.match(BODY, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(BODY.includes(key), `the preamble never says what ${key} means for this skill`);
  }
});

test('the skill never hand-rolls a paid call — everything goes through the runtime', () => {
  assert.ok(!/\bcurl\b/i.test(BODY), 'a paid call must not be described as a curl');
  assert.ok(!/api\.richapi|https?:\/\/[^\s)]*\/(?:email_finder|identify_email_type)/i.test(BODY),
    'the skill must not name a raw API URL for a paid endpoint');
  assert.match(BODY, /richapi call /, 'the `call` verb is how this skill spends');
});

test('the CLI verbs and flags this skill instructs actually exist in bin/richapi', () => {
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'richapi.mjs'), 'utf8');
  for (const verb of ['call', 'gates', 'catalog']) {
    assert.match(cli, new RegExp(`case '${verb}':`),
      `the SKILL.md tells the user to run \`richapi ${verb}\`, which bin/richapi does not dispatch`);
  }
  for (const flag of ['--dry-run', '--in']) {
    if (BODY.includes(flag)) {
      assert.ok(cli.includes(flag.replace(/^--/, '')), `the SKILL.md uses ${flag}, which bin/richapi does not parse`);
    }
  }
  // No invented verbs. `upload`, `audience` and `push` are not part of the surface.
  for (const invented of ['richapi upload', 'richapi audience', 'richapi push', 'richapi export']) {
    assert.ok(!BODY.includes(invented), `the SKILL.md invents the verb "${invented}"`);
  }
});

test('there is exactly one audience-rules block, and it parses', () => {
  const fences = readFileSync(SKILL_PATH, 'utf8').split('\n')
    .filter(l => /^```yaml[ \t]+audience-rules[ \t]*$/.test(l));
  assert.equal(fences.length, 1);
  assert.equal(typeof loadAudienceRules(), 'object');
});

test('a permissive rules table is refused at load time (law 5)', () => {
  const src = readFileSync(SKILL_PATH, 'utf8');
  const weakened = src.replace('default_decision: refuse', 'default_decision: build');
  assert.notEqual(weakened, src);
  // Written and read back through the loader rather than parsed inline, so the test
  // exercises the same path the harness uses.
  const p = join(tmpRoot('ads-weakened-'), 'SKILL.md');
  writeFileSync(p, weakened, 'utf8');
  try {
    assert.throws(() => loadAudienceRules({ path: p }), (e) => e instanceof AudienceRulesUnavailable);
  } finally { rmSync(p, { force: true }); }
});

test('the real validator passes on this skill in an isolated sandbox, with zero warnings', () => {
  const dir = validatorSandbox([SKILL]);
  const population = linkClosure([SKILL]);
  assert.ok(population.includes('launch') && population.includes('richapi-gtm'),
    'this skill must route onward to /launch and the router');
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`${population.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});
