// enrich_company takes a LinkedIn company, not a website.
//
// Measured against the live API on 2026-09-18, one endpoint, four input forms:
//
//   url=https://www.linkedin.com/company/stripe  -> 200, the company
//   url=stripe                 (the universalName) -> 200, the same company
//   url=stripe.com                                 -> 404
//   url=https://stripe.com                         -> 503 "upstream unavailable"
//
// RECORD_MAPPINGS.enrich_company used to read
// `url ?? company_website ?? website ?? company_domain ?? domain`, so four of its five
// branches supplied the one kind of value the endpoint cannot answer. A domain-keyed
// list — the ordinary case for a CRM export — planned every row as runnable and then
// missed every one. Nothing was charged (a non-2xx is unbilled), which is exactly why
// it survived: the run cost nothing and returned nothing, and the receipt could only
// report the 404s after the fact.
//
// A row the endpoint cannot answer is now refused on the PLAN, with the resolution
// step named in the refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRequest, linkedinCompanyRef } from '../../_lib/client.mjs';

test('a LinkedIn company URL and its bare slug both build', () => {
  assert.deepEqual(buildRequest('enrich_company', { url: 'https://www.linkedin.com/company/stripe' }),
    { ok: true, payload: { url: 'https://www.linkedin.com/company/stripe' } });
  assert.deepEqual(buildRequest('enrich_company', { url: 'stripe' }),
    { ok: true, payload: { url: 'stripe' } });

  // The column a CRM export actually carries for this.
  assert.deepEqual(buildRequest('enrich_company', { company_linkedin_url: 'https://linkedin.com/company/acme' }),
    { ok: true, payload: { url: 'https://linkedin.com/company/acme' } });
});

test('a website or a bare domain is refused on the plan, not spent on the wire', () => {
  for (const row of [{ domain: 'stripe.com' }, { website: 'https://stripe.com' },
    { company_website: 'stripe.com' }, { company_domain: 'stripe.com' }, { url: 'stripe.com' }]) {
    const r = buildRequest('enrich_company', row);
    assert.equal(r.ok, false, `${JSON.stringify(row)} planned as runnable`);
    assert.match(r.reason, /LinkedIn company URL or its universalName slug/);
    assert.match(r.reason, /find_website_by_company_name/);   // the way forward, named
  }
});

test('linkedinCompanyRef tells a company apart from a domain', () => {
  assert.ok(linkedinCompanyRef('https://www.linkedin.com/company/stripe'));
  assert.ok(linkedinCompanyRef('linkedin.com/company/stripe/about'));
  assert.ok(linkedinCompanyRef('stripe'));
  assert.equal(linkedinCompanyRef('stripe.com'), null);       // the dot makes it a domain
  assert.equal(linkedinCompanyRef('https://stripe.com'), null);
  assert.equal(linkedinCompanyRef('https://www.linkedin.com/in/someone'), null);  // a person
  assert.equal(linkedinCompanyRef(''), null);
  assert.equal(linkedinCompanyRef(null), null);
});
