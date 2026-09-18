// tests/skills/recipes — the `yaml recipe` blocks inside SKILL.md files.
//
// A recipe is a named chain of existing skills for a common GTM job. It adds no
// capability, so the only ways it can be wrong are structural: a step that is not a
// skill, a send that skips the pack's gate order, a CRM file that reads as cleared to
// contact, or a recipe the router cannot find. Each test fails on one of those.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const SKILLS = fs.readdirSync(SKILLS_DIR).filter((d) => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md')));

// The pack's gate order before anything is sent (play-design stages.act).
const SEND_CHAIN = ['personalize', 'sequence-builder', 'comply', 'campaign-review', 'launch'];
const INPUTS = new Set(['post_url', 'domains', 'icp_text', 'watchlist', 'form_row', 'won_accounts',
  'maps_query', 'csv_list', 'transcript']);
const CRM_NOTE = 'Cleared for CRM, not for contact: run /comply and /campaign-review before any send.';
const EXPECTED = 11;

const recipes = [];
for (const skill of SKILLS) {
  const src = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  for (const m of src.matchAll(/^```yaml recipe\n([\s\S]*?)^```$/gm)) {
    recipes.push({ host: skill, src, doc: YAML.parse(m[1]) });
  }
}

test('the pack ships the expected set of recipes, uniquely named', () => {
  assert.equal(recipes.length, EXPECTED, 'a recipe was added or lost — update EXPECTED deliberately');
  const names = recipes.map((r) => r.doc.name);
  assert.equal(new Set(names).size, names.length, `duplicate recipe name in ${names}`);
  for (const n of names) assert.match(n, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${n} is not kebab-case`);
});

test('every recipe carries exactly the documented keys', () => {
  for (const { host, doc } of recipes) {
    const keys = Object.keys(doc).sort();
    const want = ['ends', 'input', 'job', 'name', 'steps', ...(doc.note !== undefined ? ['note'] : [])].sort();
    assert.deepEqual(keys, want, `${host}/${doc.name}`);
    assert.ok(typeof doc.job === 'string' && doc.job.length > 0, `${doc.name} has no job`);
    assert.ok(INPUTS.has(doc.input), `${doc.name}: unknown input "${doc.input}"`);
    assert.ok(['send', 'deliverable'].includes(doc.ends), `${doc.name}: ends must be send|deliverable`);
    assert.ok(Array.isArray(doc.steps) && doc.steps.length > 0, `${doc.name} has no steps`);
  }
});

test('every step is a real skill, and the host skill is one of them', () => {
  for (const { host, doc } of recipes) {
    for (const s of doc.steps) assert.ok(SKILLS.includes(s), `${doc.name}: "${s}" is not a skill`);
    assert.ok(doc.steps.includes(host), `${doc.name} is documented in ${host} but never runs it`);
    assert.equal(new Set(doc.steps).size, doc.steps.length, `${doc.name} repeats a step`);
  }
});

test('a send recipe ends with the full gate chain, in order; a deliverable never launches', () => {
  for (const { doc } of recipes) {
    if (doc.ends === 'send') {
      assert.deepEqual(doc.steps.slice(-SEND_CHAIN.length), SEND_CHAIN,
        `${doc.name} sends without the pack's gate order`);
    } else {
      for (const s of ['launch', 'campaign-review', 'sequence-builder']) {
        assert.ok(!doc.steps.includes(s), `${doc.name} is a deliverable but runs ${s}`);
      }
    }
  }
});

test('hygiene runs before enrichment whenever both appear', () => {
  for (const { doc } of recipes) {
    const h = doc.steps.indexOf('list-hygiene');
    const e = doc.steps.indexOf('enrich-waterfall');
    if (h >= 0 && e >= 0) assert.ok(h < e, `${doc.name} enriches before cleaning`);
  }
});

test('a recipe that writes a CRM file says it is not cleared for contact', () => {
  for (const { doc } of recipes) {
    if (doc.steps.includes('crm-export')) assert.equal(doc.note, CRM_NOTE, doc.name);
    else assert.equal(doc.note, undefined, `${doc.name} carries a note it does not need`);
  }
});

test('each recipe sits under a Recipes section, with its own heading', () => {
  for (const { host, src, doc } of recipes) {
    const recipesAt = src.indexOf('\n## Recipes\n');
    assert.ok(recipesAt >= 0, `${host} has recipes but no "## Recipes" section`);
    const headingAt = src.indexOf(`\n### ${doc.name}\n`);
    assert.ok(headingAt > recipesAt, `${doc.name} needs a "### ${doc.name}" heading under Recipes`);
  }
});

test('the router names every recipe, so a plain request can reach it', () => {
  const router = fs.readFileSync(path.join(SKILLS_DIR, 'richapi-gtm', 'SKILL.md'), 'utf8');
  for (const { host, doc } of recipes) {
    assert.match(router, new RegExp('`' + doc.name + '`'), `richapi-gtm never mentions ${doc.name}`);
    assert.match(router, new RegExp(`\\.\\./${host}/SKILL\\.md#${doc.name}\\b`),
      `richapi-gtm must link ${doc.name} to its host, ${host}`);
  }
});

test('a step that does not write a contact list says what feeds /enrich-waterfall', () => {
  // signal-watch writes a trigger feed, org-map a Markdown file, and a maps listing has
  // no person on it. The waterfall reads a list and looks up people by linkedin_url or
  // name + company, so the recipe prose must name the column that bridges the gap.
  const NOT_A_PEOPLE_LIST = new Set(['signal-watch', 'org-map', 'local-business-prospecting']);
  for (const { src, doc } of recipes) {
    const e = doc.steps.indexOf('enrich-waterfall');
    if (e <= 0 || !NOT_A_PEOPLE_LIST.has(doc.steps[e - 1])) continue;
    const from = src.indexOf(`\n### ${doc.name}\n`);
    const next = src.slice(from + 1).search(/\n##+ /);
    const prose = src.slice(from, next < 0 ? undefined : from + 1 + next);
    assert.match(prose, /`(linkedin_url|email)`/, `${doc.name} never says what the waterfall reads`);
  }
});

// --- what a recipe costs -----------------------------------------------------
//
// A recipe chains skills that each price themselves, which made it easy to write a
// chain whose FIRST step is the expensive one and say nothing about it. A live run
// approved `domains-to-decision-makers` and met a per-page base charge plus a
// per-result charge on a page whose size nobody could predict — after the approval.
//
// So a recipe containing a page-gated, per-result step has to say what the charge
// looks like before it runs, in the shape of the charge and never as a typed price:
// prices come from the catalog at plan time (law 1), and one written here is stale
// within a quarter.

// Skills whose own SKILL.md prices a step per result on a page.
const PAGE_GATED = new Set(['build-prospect-list', 'tam-map', 'signal-watch',
  'account-research', 'local-business-prospecting']);

function proseOf (src, name) {
  const from = src.indexOf(`\n### ${name}\n`);
  const next = src.slice(from + 1).search(/\n##+ /);
  return src.slice(from, next < 0 ? undefined : from + 1 + next);
}

test('a recipe with a per-result page step says what it costs, before it is approved', () => {
  let named = 0;
  for (const { host, src, doc } of recipes) {
    if (!doc.steps.some((s) => PAGE_GATED.has(s))) continue;
    named += 1;
    const prose = proseOf(src, doc.name);
    assert.match(prose, /\*\*What this costs/,
      `${host}/${doc.name} chains a per-result page step and never says what that costs`);
    assert.match(prose, /per page|per result|per-result|per row|per call/i,
      `${doc.name}: name the SHAPE of the charge, not just that there is one`);
    assert.match(prose, /catalog/i,
      `${doc.name}: say where the figure comes from — the catalog, at plan time`);
  }
  assert.ok(named >= 8, `only ${named} recipes were checked — the page-gated set looks wrong`);
});

test('a cost line never types a price', () => {
  // Law 1: the catalog is the source of truth for cost. A recipe that quotes "10
  // credits" is wrong the next time an endpoint reprices, and nothing catches it.
  for (const { host, src, doc } of recipes) {
    const prose = proseOf(src, doc.name);
    const i = prose.indexOf('**What this costs');
    if (i < 0) continue;
    const line = prose.slice(i);
    assert.doesNotMatch(line, /\b\d+(\.\d+)?\s*(credits?|cr\b)/i,
      `${host}/${doc.name} types a price into a recipe — read it from the catalog instead`);
  }
});
