// tests/skills/play-design/skill-shape.test.mjs
//
// The four enforced rules of docs/skill-shape.md, the endpoint set, and the real
// validator run in an isolated sandbox holding only this suite's skill and the siblings
// it links to — which for this skill is most of the pack, because composing them is
// the job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SKILL, SKILL_DIR, REPO_ROOT, skillSource, skillBody, sections, catalog, owners,
  ownedEndpoints, invokedEndpoints, validatorSandbox, runValidator, linkClosure,
  REQUESTED_GATES,
} from './helpers.mjs';
import { loadGates, hasGate, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { loadPlaySpec, PlaySpecUnavailable, SKILL_PATH, OWNED } from './harness.mjs';

const GATES = loadGates();
const CATALOG = catalog();
const OWNERS = owners();
const BODY = skillBody();
const HEADINGS = sections(BODY).map(s => s.heading);
const owned = ownedEndpoints();
const invoked = invokedEndpoints(BODY);

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

test('the owners file assigns this skill exactly two endpoints, and it invokes both', () => {
  assert.deepEqual([...owned].sort(), [...OWNED].sort());
  assert.equal(owned.size, 2);
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [], `owned but never invoked: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `invoked but not owned by ${SKILL}: ${extra.join(', ')}`);
  for (const name of invoked) {
    assert.ok(CATALOG.endpoints[name], `${name} is not in the catalog`);
    assert.ok(!(name in (OWNERS.unclaimed || {})), `${name} is unclaimed`);
  }
});

test('the page-gated endpoint is named as page-gated, because that is the trap', () => {
  // linkedin_job_search is in gates.yaml:unbounded_endpoints.endpoints: per result,
  // page only, no bound. A skill that reaches for it without saying so turns a probe
  // into a walk.
  const unbounded = new Set(gateValue(GATES, 'unbounded_endpoints.endpoints'));
  assert.ok(unbounded.has('linkedin_job_search'));
  assert.ok(!unbounded.has('web_tech_stack'));
  const flat = BODY.replace(/\s+/g, ' ');
  assert.match(flat, /page-gated and unbounded/i, 'the unbounded probe endpoint is not flagged as such');
});

test('rule 1 — `## Related` is present and every relative link resolves', () => {
  assert.ok(HEADINGS.some(h => /^related\b/i.test(h)), 'missing a `## Related` section');
  const links = [...BODY.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 10, 'a composition skill that links to three things is not composing much');
  for (const l of links) assert.ok(existsSync(resolve(SKILL_DIR, l)), `broken relative link: ${l}`);
  for (const must of ['/signal-watch/', '/enrich-waterfall/', '/campaign-review/', '/measure/',
    '/launch/', '/comply/', '/scheduled-workflow/', '/research-agent/']) {
    assert.ok(links.some(l => l.includes(must)), `nothing routes onward to ${must}`);
  }
});

test('rule 2 — a boundary section is present and states the real ceilings', () => {
  assert.ok(HEADINGS.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const flat = sections(BODY).find(s => /will not/i.test(s.heading)).text.replace(/\s+/g, ' ');
  assert.match(flat, /will not reimplement a skill it composes/i,
    'the composition rule is the skill\'s main ceiling and belongs where a user checks');
  assert.match(flat, /will not run the play/i, 'designing and running are separate acts');
  assert.match(flat, /will not reorder the Act chain/i, 'the export boundary and the gate order are permanent');
  assert.match(flat, /deliberately external to this pack, permanently/i,
    'the pack\'s permanent ceiling must be stated, not implied');
});

test('rule 3 — metered calls are covered by a visible plan', () => {
  const metered = [...invoked].filter(t => {
    const def = CATALOG.endpoints[t];
    return def && def.pricing && def.pricing.metered !== false;
  });
  assert.ok(metered.length > 0, 'the trigger probe does spend credits');
  assert.ok(/dry[- ]?run/i.test(BODY), 'no dry-run reference');
  assert.ok(/gates\.yaml/.test(BODY), 'no gates.yaml citation');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = [...BODY.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 5, 'the gates that fire inside a probe and a cycle must be named');
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
  for (const key of ['unbounded_endpoints.pages_before_confirm', 'unbounded_endpoints.hard_page_ceiling',
    'unbounded_endpoints.assumed_results_per_page', 'session_budget.fractions.confirm',
    'session_budget.fractions.stop']) {
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
  // RESOLVE, and must resolve at the value this suite's composition rules assume. The
  // pin is the load-bearing half — presence alone would let a ceiling be edited to
  // anything while every test here stayed green. The fail-closed direction these keys
  // guard is asserted in composition.test.mjs against a gates object with the block
  // stripped, which is what keeps law 5 covered now that the real file has the keys.
  for (const [key, expected] of Object.entries(REQUESTED_GATES.play_design)) {
    const dotted = `skills.play_design.${key}`;
    assert.ok(BODY.includes(dotted), `the key ${dotted} is not named in the skill`);
    assert.equal(hasGate(GATES, dotted), true, `${dotted} does not resolve`);
    assert.equal(gateValue(GATES, dotted), expected,
      `${dotted} shipped as ${gateValue(GATES, dotted)}, not ${expected} — this suite is `
      + 'calibrated to the second number; reconcile it deliberately');
  }
  // At least one is cited in the resolvable `gates.yaml:` form: rule 4 only checks that
  // citations resolve, so without this a skill could name every threshold bare and
  // never be traceable back to the file that sets it.
  assert.ok(/gates\.yaml:skills\.play_design\./.test(BODY),
    'now that the block is merged the skill must cite at least one key as gates.yaml:<key>');
});

test('the preflight preamble is present, and says what each failing key means', () => {
  assert.match(BODY, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(BODY.includes(key), `the preamble never says what ${key} means for this skill`);
  }
});

test('the CLI verbs and flags this skill instructs actually exist in bin/richapi', () => {
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'richapi.mjs'), 'utf8');
  for (const verb of ['call', 'search', 'enrich', 'gates', 'catalog']) {
    if (!BODY.includes(`richapi ${verb} `)) continue;
    assert.match(cli, new RegExp(`case '${verb}':`),
      `the SKILL.md tells the user to run \`richapi ${verb}\`, which bin/richapi does not dispatch`);
  }
  for (const flag of ['--dry-run', '--in', '--pages', '--param']) {
    if (BODY.includes(flag)) {
      assert.ok(cli.includes(flag.replace(/^--/, '')), `the SKILL.md uses ${flag}, which bin/richapi does not parse`);
    }
  }
  for (const invented of ['richapi play', 'richapi plays', 'richapi run-play', 'richapi schedule']) {
    assert.ok(!BODY.includes(invented), `the SKILL.md invents the verb "${invented}"`);
  }
  assert.ok(!/\bcurl\b/i.test(BODY), 'a paid call must not be described as a curl');
});

test('there is exactly one play-spec block, and it parses', () => {
  const fences = readFileSync(SKILL_PATH, 'utf8').split('\n')
    .filter(l => /^```yaml[ \t]+play-spec[ \t]*$/.test(l));
  assert.equal(fences.length, 1);
  assert.equal(typeof loadPlaySpec(), 'object');
  assert.throws(() => loadPlaySpec({ path: join(REPO_ROOT, 'README.md') }),
    (e) => e instanceof PlaySpecUnavailable);
});

test('the inference mode is stated with its reason, and there is no paid hop', () => {
  const spec = loadPlaySpec();
  assert.equal(spec.inference.mode, 'local');
  assert.equal(spec.inference.paid_hop, 'none');
  assert.ok(spec.inference.reason && /local-inference rule/i.test(spec.inference.reason));
  assert.ok(!owned.has('ai_enrich'), 'this skill does not own the LLM hop and must not describe calling it');
  assert.ok(!/`ai_enrich\(/.test(BODY), 'the skill invokes an endpoint it does not own');
});

test('the real validator passes on this skill in an isolated sandbox, with zero warnings', () => {
  const dir = validatorSandbox([SKILL]);
  const population = linkClosure([SKILL]);
  for (const must of ['signal-watch', 'measure', 'launch', 'richapi-gtm', 'research-agent']) {
    assert.ok(population.includes(must), `${must} is not reachable from this skill`);
  }
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`${population.length} skill\\(s\\) validated`));
  assert.match(out, /0 warning\(s\)/);
});
