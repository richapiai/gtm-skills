// tests/skills/list-hygiene/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for
// which endpoint, and CI already fails on an endpoint owned by nobody. It cannot see
// the other direction: a SKILL.md that quietly calls something it does not own, or
// that silently drops an endpoint the owners file says it is responsible for.
//
// The pack hit exactly this class once — two components independently computing "the 11
// unbounded endpoints" and getting different sets — so the set is asserted, not eyeballed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { REPO_ROOT, skillBody, invokedEndpoints } from './helpers.mjs';

const SKILL = 'list-hygiene';

const owners = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));

/** Every endpoint the owners file assigns to this skill. */
const owned = new Set(
  Object.entries(owners.endpoints)
    .filter(([, skills]) => skills.includes(SKILL))
    .map(([name]) => name)
);

test('the owners file assigns this skill a non-trivial endpoint set', () => {
  assert.ok(owned.size > 0, 'endpoint-owners.yaml assigns list-hygiene nothing');
  // Guards against a merge that quietly reassigns the skill's whole surface.
  assert.deepEqual([...owned].sort(), [
    'clean_domain',
    'count_occurrences',
    'email_verifier',
    'extract_urls_emails',
    'find_redirect',
    'identify_email_type',
    'normalize_company',
    'normalize_list',
    'normalize_phone',
    'remove_whitespace',
    'web_meta_tags',
  ]);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(skillBody());
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra   = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(catalog.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled or unclaimed', () => {
  const invoked = invokedEndpoints(skillBody());
  for (const name of invoked) {
    assert.ok(!(name in (owners.unclaimed || {})),
      `${name} is unclaimed (${owners.unclaimed?.[name]}) and must not be invoked`);
    const pricing = catalog.endpoints[name].pricing || {};
    assert.notEqual(pricing.disabled_by_default, true,
      `${name} is disabled by default (${pricing.disabled_reason})`);
  }
});

test('the metered endpoints it invokes are covered by a visible plan (law 3)', () => {
  const body = skillBody();
  const metered = [...invokedEndpoints(body)].filter(n => {
    const p = catalog.endpoints[n].pricing;
    return p && p.metered !== false;
  });
  assert.ok(metered.length > 0, 'this skill does spend credits; the fixture must reflect that');
  assert.ok(/dry[- ]?run/i.test(body) && /gates\.yaml/.test(body),
    'a skill that invokes a metered endpoint must show a dry-run plan or a gates.yaml threshold');
});

test('the paid liveness endpoints are named as metered, not slipped in as free', () => {
  const body = skillBody();
  // The two dead-domain endpoints the owners file flags. Both cost credits, so the
  // skill must not let them ride along inside the "free probe" paragraph.
  for (const name of ['find_redirect', 'web_meta_tags']) {
    assert.ok(body.includes(`${name}()`), `${name}() is not invoked`);
  }
  const para = body.split(/\n\s*\n/).find(p => p.includes('find_redirect()'));
  assert.ok(para, 'find_redirect() must appear in a paragraph of its own');
  assert.match(para, /\bmetered\b|\bpaid\b/i,
    'the paragraph invoking the paid liveness endpoints must say they cost credits');
});

test('classification runs before verification, and both are named', () => {
  const body = skillBody();
  const classify = body.indexOf('identify_email_type()');
  const verify   = body.indexOf('email_verifier()');
  assert.ok(classify > -1 && verify > -1);
  assert.ok(classify < verify,
    'identify_email_type() must be introduced before email_verifier() — classifying first '
    + 'drops role and disposable rows before the dearer verifier is paid for them');
});
