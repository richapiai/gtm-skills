// tests/skills/research-agent/skill-shape.test.mjs
//
// The four enforced rules of docs/skill-shape.md, plus the real validator run in an
// isolated sandbox holding only this suite's skill and the siblings it links to.
//
// Running `node scripts/validate-skills.mjs` against the live tree would make this
// suite's result depend on every other in-progress skill. The sandbox is the technique
// tests/skills/account-research/ established; it is copied deliberately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SKILL, SKILL_DIR, REPO_ROOT, skillSource, skillBody, sections,
  validatorSandbox, runValidator, catalog, linkClosure, REQUESTED_GATES,
} from './helpers.mjs';
import { loadGates, hasGate, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { loadResearchRoutes, ResearchRoutesUnavailable, SKILL_PATH } from './harness.mjs';

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
  // The handoff targets that carry the most of the research-prompt corpus must be reachable from here,
  // or "hand it off" is advice with no address on it.
  for (const must of ['/account-research/', '/enrich-waterfall/', '/list-hygiene/',
    '/build-prospect-list/', '/play-design/']) {
    assert.ok(links.some(l => l.includes(must)), `nothing routes onward to ${must}`);
  }
});

test('rule 2 — a boundary section is present and states the real ceilings', () => {
  assert.ok(HEADINGS.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const b = sections(BODY).find(s => /will not/i.test(s.heading));
  const flat = b.text.replace(/\s+/g, ' ');
  assert.match(flat, /will not answer a question whose answer is not findable/i,
    'the Iron Law belongs in the boundary section too — that is where a user checks');
  assert.match(flat, /will not improvise a route/i,
    'the library-not-a-loop decision is a ceiling, and an unstated ceiling reads as a promise');
  assert.match(flat, /will not run without showing the fan-out per row and the list total/i,
    'the fan-out plan is the entire safety mechanism for this skill');
  assert.match(flat, /sending .*is deliberately external/i,
    'the pack\'s permanent ceiling must be stated, not implied');
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
  assert.ok(cited.length >= 4, 'the gates that fire inside a run must be named');
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
  for (const key of ['session_budget.fractions.confirm', 'session_budget.fractions.stop',
    'session_budget.fractions.single_call_confirm', 'quality_stops.coverage_min_pct']) {
    assert.ok(cited.includes(key), `${key} is not cited`);
  }
});

test('law 1 — no bare credit, minimum, TTL or quality number is typed into the prose', () => {
  const findings = scanForBareNumbers(BODY, { file: `skills/${SKILL}/SKILL.md` });
  assert.deepEqual(findings, [], findings.map(f => `line ${f.line}: ${f.message}`).join('\n'));
});

test('the gate keys this skill reads are merged, and are cited properly', () => {
  // Was: the keys were pending, so the skill named them BARE — a `gates.yaml:` citation
  // of a key that does not resolve fails rule 4, and shipping one anyway would promise
  // a threshold that reads STOP forever if the merge never happened.
  //
  // They are merged now, so the assertion inverts: each key must be named, must
  // RESOLVE, and must resolve at the value this suite's plan arithmetic assumes. The
  // pin is the load-bearing half — presence alone would let a ceiling be edited to
  // anything while every test here stayed green. The fail-closed direction these keys
  // guard is asserted in fan-out.test.mjs against a gates object with the block
  // stripped, which is what keeps law 5 covered now that the real file has the keys.
  for (const [key, expected] of Object.entries(REQUESTED_GATES.research_agent)) {
    const dotted = `skills.research_agent.${key}`;
    assert.ok(BODY.includes(dotted), `the key ${dotted} is not named in the skill`);
    assert.equal(hasGate(GATES, dotted), true, `${dotted} does not resolve`);
    assert.equal(gateValue(GATES, dotted), expected,
      `${dotted} shipped as ${gateValue(GATES, dotted)}, not ${expected} — this suite is `
      + 'calibrated to the second number; reconcile it deliberately');
  }
  // At least one is cited in the resolvable `gates.yaml:` form: rule 4 only checks that
  // citations resolve, so without this a skill could name every threshold bare and
  // never be traceable back to the file that sets it.
  assert.ok(/gates\.yaml:skills\.research_agent\./.test(BODY),
    'now that the block is merged the skill must cite at least one key as gates.yaml:<key>');
});

test('the preflight preamble is present, and says what each failing key means', () => {
  assert.match(BODY, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(BODY.includes(key), `the preamble never says what ${key} means for this skill`);
  }
});

test('the skill never hand-rolls a paid call — everything goes through the runtime', () => {
  assert.ok(!/\bcurl\b/i.test(BODY), 'a paid call must not be described as a curl');
  assert.ok(!/api\.richapi|https?:\/\/[^\s)]*\/(?:ai_enrich|web_scrape|search_bing)/i.test(BODY),
    'the skill must not name a raw API URL for a paid endpoint');
  assert.match(BODY, /richapi call /, 'the `call` verb is how this skill spends');
});

test('the CLI verbs and flags this skill instructs actually exist in bin/richapi', () => {
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'richapi.mjs'), 'utf8');
  for (const verb of ['call', 'gates', 'catalog']) {
    assert.match(cli, new RegExp(`case '${verb}':`),
      `the SKILL.md tells the user to run \`richapi ${verb}\`, which bin/richapi does not dispatch`);
  }
  for (const flag of ['--dry-run', '--in', '--out', '--param']) {
    if (BODY.includes(flag)) {
      assert.ok(cli.includes(flag.replace(/^--/, '')), `the SKILL.md uses ${flag}, which bin/richapi does not parse`);
    }
  }
  for (const invented of ['richapi research', 'richapi ask', 'richapi answer', 'richapi agent']) {
    assert.ok(!BODY.includes(invented), `the SKILL.md invents the verb "${invented}"`);
  }
});

test('there is exactly one research-routes block, and it parses', () => {
  const fences = readFileSync(SKILL_PATH, 'utf8').split('\n')
    .filter(l => /^```yaml[ \t]+research-routes[ \t]*$/.test(l));
  assert.equal(fences.length, 1);
  assert.equal(typeof loadResearchRoutes(), 'object');
  // And a SKILL.md with no table at all is a STOP, not a permissive default.
  assert.throws(() => loadResearchRoutes({ path: join(REPO_ROOT, 'README.md') }),
    (e) => e instanceof ResearchRoutesUnavailable);
});

test('the Iron Law is stated where a reader cannot miss it, and named as the Iron Law', () => {
  assert.ok(HEADINGS.some(h => /iron law/i.test(h)), 'the Iron Law needs its own section');
  const flat = BODY.replace(/\s+/g, ' ');
  assert.match(flat, /A question with no findable answer yields the explicit null/i);
  // The adversarial case is quoted in the skill, so the reader sees the hard case
  // rather than only the rule.
  assert.match(flat, /exact ARR/i, 'the recorded adversarial case is not quoted in the skill');
});

test('the inference mode is stated with its reason, as the pack requires', () => {
  const flat = BODY.replace(/\s+/g, ' ');
  assert.match(flat, /Inference mode: local/i, 'a local-inference skill states its inference mode and why');
  assert.match(flat, /batch scale is not an escape here/i,
    'this skill differs from /personalize and /call-intel on the batch escape; the difference must be argued');
});

test('the real validator passes on this skill in an isolated sandbox, with zero warnings', () => {
  const dir = validatorSandbox([SKILL]);
  const population = linkClosure([SKILL]);
  assert.ok(population.includes('account-research') && population.includes('richapi-gtm'));
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`${population.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});
