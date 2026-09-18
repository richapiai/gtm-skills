// tests/skills/enrich-waterfall/inputs — the skill's input claims match the code.
//
// A live run found the skill implying "no company domain, no email lookup", while
// email_finder accepted a LinkedIn URL alone and found emails from it. These tests tie
// the skill's "enough on its own" table to REQUEST_CONTRACTS, and its billing claim to
// the catalog, so neither can drift back.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REQUEST_CONTRACTS, buildRequest, urnOf } from '../../../_lib/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const body = fs.readFileSync(path.join(ROOT, 'skills', 'enrich-waterfall', 'SKILL.md'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));

test('email_finder takes a profile URL or a name + DOMAIN, and the skill says only that', () => {
  assert.equal(buildRequest('email_finder', { linkedin_url: 'https://www.linkedin.com/in/x/' }).ok, true);
  assert.equal(buildRequest('email_finder', { company_domain: 'acme.example' }).ok, false);
  const section = body.slice(body.indexOf('### What each lookup needs'));

  // The two shapes the LIVE endpoint accepts. Each pins the company with something
  // resolvable — a profile URL or a domain.
  const ACCEPTED = [['linkedin_url'], ['first_name', 'last_name', 'company_domain']];
  for (const combo of ACCEPTED) {
    const row = '| ' + combo.map((f) => '`' + f + '`').join(' + ') + ' |';
    assert.ok(section.includes(row), `the table is missing the accepted input ${row}`);
  }
  // And the shape that does NOT work. A live call with first name, last name and
  // company name returned http_400; the spec agrees, calling company_domain "required
  // if no linkedin_url" and company_name merely an accuracy aid. The table must not
  // offer it as sufficient.
  assert.ok(!section.includes('| `first_name` + `last_name` + `company_name` |'),
    'the table still offers name + company NAME as enough for email_finder — a live call 400s on it');
  assert.match(section, /company NAME is not a domain/i);
  assert.match(section, /http_400/);
  // The route out for such a row is named, and it is a priced hop, not magic.
  assert.match(section, /find_website_by_company_name\(\)/);

  // The shared request contract agrees with the live endpoint: a company NAME alone
  // never satisfies it, so a row that carries only a name is refused before the call
  // is paid for rather than 400ing at the API.
  const combos = REQUEST_CONTRACTS.email_finder.requires.map((c) => c.join('+'));
  assert.ok(!combos.includes('first_name+last_name+company_name'),
    'client.mjs accepts name + company NAME again — a live call 400s on it');
  assert.deepEqual(combos, ['linkedin_url', 'first_name+last_name+company_domain']);

  assert.doesNotMatch(body, /no company domain.{0,40}(stop|skip)/i);
});

test('the skill says each lookup bills per call on a miss, as the catalog prices it', () => {
  for (const ep of ['email_finder', 'phone_finder', 'email_verifier']) {
    assert.equal(catalog.endpoints[ep].pricing.model, 'flat', `${ep} is no longer flat-priced`);
  }
  assert.match(body, /bills per call, found or not/);
  assert.match(body, /Billed on a miss:/);
});

test('a urn column is what makes a row batchable, and the skill names it', () => {
  assert.equal(urnOf({ urn: 'urn:li:fsd_profile:ACoX' }), 'urn:li:fsd_profile:ACoX');
  assert.equal(urnOf({ linkedin_url: 'https://www.linkedin.com/in/x/' }), null);
  assert.match(body, /`urn` = `commenter\.entityUrn`/);
});
