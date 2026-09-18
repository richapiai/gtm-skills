// tests/skills/build-prospect-list — behavioural tests for /build-prospect-list.
//
// These are not smoke tests. Each one asserts a promise the skill makes to the user
// or to another skill, and each one fails on a specific regression that has already
// happened once in this pack:
//
//   * an endpoint set that drifts from _lib/endpoint-owners.yaml (a skill quietly
//     spending on an endpoint another skill owns, or silently dropping one of its own)
//   * a gate key lost in a merge — MissingGateKey reads as STOP (law 5), so the failure
//     mode is a skill that refuses to run in production while its own tests stay green
//   * a hand-typed credit number (law 1: 16 of 53 endpoints repriced in four months)
//   * the three earlier defects this skill exists to fix: the dangling geo_id_search, the
//     unwired recently_changed_jobs filter, and the missing account-first path
//   * the camelCase / nested-`exclude` request shape from the retired MCP surface, which
//     the REST API accepts and silently ignores

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadOwners } from '../../../_lib/catalog/owners.mjs';
import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'build-prospect-list');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const SKILL_NAME = 'build-prospect-list';

const src = fs.readFileSync(SKILL_MD, 'utf8').replace(/\r\n/g, '\n');
const owners = loadOwners(path.join(ROOT, '_lib', 'endpoint-owners.yaml'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
const gates = loadGates();

// --- tiny helpers ----------------------------------------------------------------

function split(text) {
  assert.ok(text.startsWith('---\n'), 'SKILL.md must open with a frontmatter fence');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'SKILL.md frontmatter fence must terminate');
  return { fm: text.slice(4, end), body: text.slice(end + 5) };
}
const { fm, body } = split(src);

/** Endpoints invoked in the unambiguous `name(` form the validator recognises. */
function invocations(text) {
  return new Set([...text.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]));
}

/** `## Heading` → text up to the next `## `. Sub-headings stay with their parent. */
function sections(text) {
  const out = new Map();
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    out.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
  return out;
}
const SECTIONS = sections(body);

function sectionMatching(re) {
  for (const [heading, text] of SECTIONS) if (re.test(heading)) return { heading, text };
  return null;
}

const OWNED = Object.entries(owners.endpoints)
  .filter(([, skills]) => skills.includes(SKILL_NAME))
  .map(([name]) => name);

// --- 1. the endpoint set is exactly the one the owners file assigns ----------------

test('the owners file actually assigns this skill a non-trivial endpoint set', () => {
  assert.ok(OWNED.length > 0, '_lib/endpoint-owners.yaml assigns nothing to ' + SKILL_NAME);
  // Guards a rename in the owners file silently emptying the set.
  for (const name of OWNED) {
    assert.ok(catalog.endpoints[name], `${name} is owned but absent from api-catalog.json`);
  }
});

test('every endpoint the owners file assigns to this skill is invoked by the skill', () => {
  const invoked = invocations(body);
  const missing = OWNED.filter(n => !invoked.has(n));
  assert.deepEqual(missing, [],
    'owned but never invoked — an endpoint claimed in endpoint-owners.yaml and unreachable '
    + 'in the skill is the drift the owners file exists to prevent');
});

test('the skill invokes no endpoint it does not own', () => {
  const invoked = [...invocations(body)];
  const ownedSet = new Set(OWNED);
  const trespass = invoked.filter(n => catalog.endpoints[n] && !ownedSet.has(n));
  assert.deepEqual(trespass, [],
    'invokes an endpoint owned by another skill — route to that skill instead');
});

test('every invocation resolves to a real catalog endpoint', () => {
  for (const name of invocations(body)) {
    assert.ok(catalog.endpoints[name],
      `\`${name}(\` is not in api-catalog.json — a renamed or hallucinated endpoint`);
  }
});

// --- 2. law 1: no credit number is ever typed by hand ------------------------------

test('carries no hand-typed credit, spend or threshold number', () => {
  const findings = scanForBareNumbers(body, { file: 'skills/build-prospect-list/SKILL.md' });
  assert.deepEqual(findings.map(f => `line ${f.line}: ${f.message}`), []);
});

test('sends the reader to the generated catalog for price, not to prose', () => {
  assert.match(body, /_lib\/api-catalog\.json/,
    'the skill must name the catalog as the source of cost and routing (law 1)');
});

// --- 3. page gating is cited, and cited against keys that resolve -------------------

test('every gates.yaml key the skill cites resolves against the real gates file', () => {
  const cited = [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length > 0, 'a skill that spends must cite at least one threshold');
  const unresolved = cited.filter(k => !hasGate(gates, k));
  assert.deepEqual(unresolved, [],
    'a cited key that does not resolve reads as STOP on every guarded call (law 5)');
});

test('both of this skill\'s own gate keys are cited', () => {
  const own = Object.keys(gates.skills?.[SKILL_NAME.replace(/-/g, '_')] ?? {});
  assert.ok(own.length > 0, 'gates.yaml has no skills.build_prospect_list block');
  for (const key of own) {
    assert.match(body, new RegExp(`gates\\.yaml:skills\\.build_prospect_list\\.${key}\\b`),
      `gates.yaml defines skills.build_prospect_list.${key} but the skill never cites it — `
      + 'an uncited threshold is a threshold nobody applies');
  }
});

test('every unbounded endpoint the skill invokes is page-gated in the body', () => {
  const unbounded = new Set(gates.unbounded_endpoints?.endpoints ?? []);
  const invoked = [...invocations(body)].filter(n => unbounded.has(n));
  assert.ok(invoked.length > 0,
    'this skill lives on the unbounded per-result searches; if none are invoked the test is stale');

  // The page-gate machinery itself must be cited, not merely described.
  assert.match(body, /gates\.yaml:unbounded_endpoints\.pages_before_confirm/,
    'page 1 runs and every page after it asks — that rule must be cited, not paraphrased');
  assert.match(body, /gates\.yaml:unbounded_endpoints\.hard_page_ceiling/,
    'a confirm loop with no ceiling is not a ceiling');

  // And each unbounded endpoint must actually be named somewhere in the skill, so a
  // reader can tell which of their calls the gate applies to.
  for (const name of invoked) {
    assert.match(body, new RegExp(`\\b${name}\\b`), `${name} is page-gated but never named`);
  }
});

test('the plan is written before the pages are walked', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1]);
  const planAt = headings.findIndex(h => /\bplan\b/i.test(h));
  const walkAt = headings.findIndex(h => /walk pages|execute|approval/i.test(h));
  assert.ok(planAt >= 0, 'no planning section — law 3 requires a named, costed plan first');
  assert.ok(walkAt >= 0, 'no execution section');
  assert.ok(planAt < walkAt, 'the plan section must come before the execution section');
  assert.match(body, /gtm\/plans\//, 'the plan must be a written artifact, not a spoken number');
});

// --- 4. defect: the account-first path (new in this port) ---------------------------

test('the account-first path exists as its own routed path', () => {
  const intro = body.split(/^## /m)[0];
  assert.match(intro, /account-first/i,
    'account-first must be announced up front — a path only findable mid-document is a path '
    + 'the model will not take');

  const route = sectionMatching(/route|search/i);
  assert.ok(route, 'no routing section');
  assert.match(route.text, /###\s*Path B[^\n]*account-first/i,
    'the account-first motion must be a first-class route, not a footnote on the persona path');
});

test('the account-first path is wired end to end, not just mentioned', () => {
  const route = sectionMatching(/route|search/i).text;
  const pathB = route.split(/^### /m).find(s => /^Path B/i.test(s));
  assert.ok(pathB, 'Path B (account-first) section not found');

  const invoked = invocations(pathB);
  assert.ok(invoked.has('linkedin_company_search'),
    'account-first must be able to DISCOVER accounts, which is linkedin_company_search');
  assert.ok(invoked.has('linkedin_company_employees_search'),
    'account-first must be able to reach the PEOPLE inside an account');

  // The chain only works through this one field pair; nothing in the pack converts a
  // company name into a company LinkedIn URL.
  assert.match(pathB, /linkedinUrl/,
    'the company search result field that feeds the employee search must be named');
  assert.match(pathB, /company_linkedin_url/,
    'the employee search request field must be named — it is the required field');

  // The alternative route for "specific roles across many accounts" must be present,
  // because one unfiltered page-walk per account is the expensive mistake here.
  assert.match(pathB, /current_companies/,
    'lead_search with current_companies is the cheap route for role-filtered account lists');
});

test('the account fan-out shares the per-run page ceiling', () => {
  const route = sectionMatching(/route|search/i).text;
  assert.match(route, /gates\.yaml:skills\.build_prospect_list\.max_pages_per_run/,
    'an account list is an unbounded fan-out; it must be bound by the per-run page ceiling');
});

// --- 5. defect: recently_changed_jobs is wired --------------------------------------

test('recently_changed_jobs is wired as a lead_search filter, not treated as an endpoint', () => {
  assert.ok(!catalog.endpoints.recently_changed_jobs,
    'guard: if the API ever ships this as an endpoint, this skill must be re-routed');
  assert.ok(!invocations(body).has('recently_changed_jobs'),
    'recently_changed_jobs is a request-body boolean on lead_search; invoking it as an '
    + 'endpoint is the earlier mistake');

  const play = sectionMatching(/job-change/i);
  assert.ok(play, 'no job-change section — the highest-intent signal the API exposes');
  assert.match(play.text, /recently_changed_jobs/);
  assert.ok(invocations(play.text).has('lead_search'),
    'the section must name the one endpoint that exposes the filter');
});

test('the job-change filter is mapped from an ICP slot and forces the lead_search route', () => {
  const parse = sectionMatching(/parse the ICP/i);
  assert.ok(parse, 'no ICP parsing section');
  assert.match(parse.text, /recently_changed_jobs/,
    'the slot table must map to the filter — an earlier version mapped a slot and then never used it');

  const play = sectionMatching(/job-change/i).text;
  assert.match(play, /forces the lead-search route|lead-search route/i,
    'no other endpoint exposes the filter, so turning it on is a routing decision with a bill');
});

test('recently_changed_jobs is listed as having no exclusion counterpart', () => {
  const excl = sectionMatching(/exclu/i);
  assert.ok(excl, 'no exclusions section');
  const [, cannot = ''] = excl.text.split(/have none|no counterpart/i);
  assert.match(cannot, /recently_changed_jobs/,
    'placing it inside an exclusion is silently ignored by the API — the user must be told');
  for (const field of ['years_of_experience', 'company_size', 'profile_languages']) {
    assert.match(cannot, new RegExp(field),
      `${field} has no exclusion counterpart and must be listed as client-side`);
  }
});

// --- 6. defect: geo_id_search is resolved, not dangling ------------------------------

test('geo_id_search is invoked and its consumers are named', () => {
  assert.ok(invocations(body).has('geo_id_search'),
    'geo_id_search is owned by this skill; an earlier version referenced it without ever wiring it');

  const geo = sectionMatching(/resolve labels|geograph/i);
  assert.ok(geo, 'no label/geography resolution section');
  const tail = geo.text.slice(geo.text.search(/Geograph/i));
  assert.ok(tail.length > 0, 'no geography subsection');

  // A resolve with no named consumer is the dangling reference all over again.
  for (const field of ['geo_ids', 'geo_id']) {
    assert.match(tail, new RegExp(`\`${field}\``),
      `the request field \`${field}\` that consumes the resolved ID must be named`);
  }
  for (const consumer of ['lead_search', 'profile_search', 'linkedin_company_search']) {
    assert.match(tail, new RegExp(`\\b${consumer}\\b`),
      `${consumer} takes a geo id and must appear in the resolution table`);
  }
  // people_search takes location names only — spending a resolve for it buys nothing.
  assert.match(tail, /people_search/,
    'people_search must be called out as having no geo-id field, so no resolve is bought for it');
});

// --- 7. the retired MCP request shape must not survive the port ----------------------

test('uses the REST snake_case request shape, not the retired camelCase one', () => {
  const stale = [
    'currentJobTitles', 'pastJobTitles', 'currentCompanies', 'pastCompanies',
    'recentlyChangedJobs', 'profileLanguages', 'yearsOfExperience',
    'yearsAtCurrentCompany', 'salesNavUrl', 'geoIds',
  ];
  // A camelCase name may appear ONLY on a line that flags it as the retired shape.
  // Anywhere else it reads as an instruction to send it, and the REST API will accept
  // the request and ignore the field.
  const FLAGGED = /old MCP|retired|no longer|does not take|silently ignored/i;
  const offending = [];
  body.split('\n').forEach((line, i) => {
    if (FLAGGED.test(line)) return;
    for (const tok of stale) if (line.includes(tok)) offending.push(`line ${i + 1}: ${tok}`);
  });
  assert.deepEqual(offending, [],
    'retired camelCase field names presented as usable — the REST API does not take them');

  // …and the migration note itself must survive, because a silent rename is exactly
  // how a user of the old shape builds a list with every filter ignored.
  assert.ok(stale.some(t => body.includes(t)),
    'the port must name the retired camelCase fields so a user of the old shape recognises them');
});

test('warns that the nested exclude object is silently ignored', () => {
  assert.match(body, /flat `exclude_\*` fields|flat exclude|flat sibling fields/i,
    'exclusions are flat sibling fields; a nested `exclude` object is accepted and ignored, '
    + 'which produces a wrong list that looks right');
});

test('does not point at the retired MCP catalog', () => {
  assert.ok(!/mcp-catalog\.json/.test(body),
    'cost and routing come from _lib/api-catalog.json now');
});

// --- 8. shape contract, asserted locally so a merge cannot quietly break it -----------

test('frontmatter is complete and matches the directory', () => {
  const get = k => {
    const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  assert.equal(get('name'), SKILL_NAME, 'frontmatter name must match the directory');
  assert.match(get('version') ?? '', /^\d+\.\d+\.\d+(-[\w.]+)?$/, 'version must be semver');
  for (const key of ['description', 'allowed-tools', 'triggers']) {
    assert.ok(new RegExp(`^${key}:`, 'm').test(fm), `missing frontmatter key: ${key}`);
  }
  const triggers = fm.split(/^triggers:\s*$/m)[1] ?? '';
  const lines = triggers.split('\n').filter(l => /^\s+-\s+\S/.test(l));
  assert.ok(lines.length >= 3, 'a skill nobody can trigger is a skill nobody runs');
});

test('runs the preflight before anything else', () => {
  assert.match(body, /richapi-skills-preflight/, 'missing the preflight preamble');
  const first = body.split(/^## /m)[1] ?? '';
  assert.match(first, /richapi-skills-preflight/,
    'the preflight belongs in the first section, not buried after a spend step');
});

test('states a boundary, and states the permanent ones', () => {
  const bound = sectionMatching(/will not|won't do|not in scope|boundar|limitations/i);
  assert.ok(bound, 'missing a boundary section (docs/skill-shape.md rule 2)');
  assert.match(bound.text, /suppress/i, 'fail-closed suppression is a stated boundary (law 5)');
  assert.match(bound.text, /LinkedIn/i,
    'LinkedIn actions are permanently external; an unstated ceiling reads as a promise');
  assert.match(bound.text, /enrich/i, 'sourcing is not enriching — say where enrichment lives');
});

test('routes onward, and every relative link resolves', () => {
  const rel = sectionMatching(/^related\b/i);
  assert.ok(rel, 'missing `## Related` (docs/skill-shape.md rule 1)');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, 'a skill with no outbound link is a dead end');
  for (const href of links) {
    assert.ok(fs.existsSync(path.resolve(SKILL_DIR, href)), `broken link: ${href}`);
  }
  assert.match(rel.text, /enrich-waterfall/,
    'a list without emails is unusable; the handoff must be named');
});
