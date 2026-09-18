// Three defects the 2026-09-17 live recipe runs found, all on the surface a customer
// touches first. Each test fails against the behaviour that shipped.
//
//   1. `--explain-my-list` refused a list the runtime enriches.
//   2. A comment permalink was written into `linkedin_url`, and then billed against.
//   5. A 4xx body that named the accepted fields reached the terminal as `http_422`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson } from '../helpers/index.mjs';
import { REPO, CATALOG, fixture, apiOver, fakeHttp } from './helpers.mjs';
import { explainList, renderExplain, BULK_PROFILE_HOP } from '../../_lib/explain.mjs';
import { normalisePageRow, isPersonProfileUrl } from '../../_lib/run.mjs';
import { runCall } from '../../_lib/run.mjs';
import { extractRemediation, renderRemediation, httpErrorFor, noteRemediation } from '../../_lib/client.mjs';
import { loadSuppressionStore } from '../../_lib/suppression.mjs';
import { nullCache } from '../../_lib/cache.mjs';

const liveFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'live', `${name}.json`), 'utf8'));

// ---------------------------------------------------------------------------
// 1. THE FIRST GATE REJECTED A LIST THE RUNTIME CAN ENRICH
// ---------------------------------------------------------------------------
//
// LIVE: a post-engagers list whose rows carry `urn` + names and nothing else.
// `--explain-my-list` answered "NOTHING IN THIS LIST CAN BE ENRICHED — 0 of 5"; the
// very next command, `richapi enrich --batch`, planned all five through
// `enrich_profiles_bulk` and found four emails.

function explainOf (t, rows, name) {
  const { tree } = fixture(t, { rows, name });
  const input = path.join(tree.root, name);   // the helper returns the bare name
  const store = loadSuppressionStore({ root: tree.root, path: path.join(tree.root, 'gtm', 'suppression.jsonl') });
  return { result: explainList(input, { store, cache: nullCache('test') }), input };
}

test('a urn-only list is ENRICHABLE, and the view names the hop that would run', (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    urn: `ACoAAA${i}xxxx`, first_name: `First${i}`, last_name: `Last${i}`,
  }));
  const { result, input } = explainOf(t, rows, 'engagers.csv');

  assert.equal(result.enrichable, 5, 'all five rows reach the bulk profile hop');
  assert.equal(result.dead, 0);
  assert.equal(result.hop_reach[BULK_PROFILE_HOP], 5,
    'the hop that would actually run is named, not merely counted');

  const text = renderExplain(result, { file: input });
  assert.ok(!text.includes('NOTHING IN THIS LIST CAN BE ENRICHED'),
    'the sentence that sent a paying customer away from a list that enriches fine');
  assert.match(text, new RegExp(BULK_PROFILE_HOP));
  assert.match(text, /--batch/, 'the view tells the user the flag that makes it run');
});

test('a list with no identifier at all is still refused, and still says so loudly', (t) => {
  const rows = [
    { notes: 'met at a conference' },
    { notes: 'follow up in Q3' },
  ];
  const { result, input } = explainOf(t, rows, 'nothing.csv');

  assert.equal(result.enrichable, 0);
  assert.equal(result.hop_reach[BULK_PROFILE_HOP], 0);
  const text = renderExplain(result, { file: input });
  assert.match(text, /NOTHING IN THIS LIST CAN BE ENRICHED/);
  assert.match(text, /LinkedIn urn/, 'the fix list now includes the identifier that would have worked');
});

// ---------------------------------------------------------------------------
// 2. A COMMENT PERMALINK IS NOT A PROFILE URL
// ---------------------------------------------------------------------------
//
// `post_activities` rows carry `url` = the comment permalink and the person under
// `commenter.entityUrn`. The recorded fixture's `url` is a person profile (the capture
// redactor rewrote it); the LIVE 2026-09-17 run answered the permalink below verbatim.

const LIVE_PERMALINK = 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7506353323579457536'
  + '?commentUrn=urn%3Ali%3Acomment%3A%28ugcPost%3A7506353323579457536%2C7506381025418231808%29';

test('a /feed/update/ comment permalink never becomes linkedin_url', () => {
  const recorded = liveFixture('post_activities').body.content[0];
  // The recorded KEYS (law 2), with the URL the live run actually returned.
  const row = { ...recorded, url: LIVE_PERMALINK };

  const out = normalisePageRow(row);
  assert.equal(out.linkedin_url, undefined,
    'a comment permalink in linkedin_url is a paid enrichment call against a post');
  assert.equal(out.source_url, LIVE_PERMALINK, 'it is kept, under a name no hop reads');
  assert.equal(out.urn, recorded.commenter.entityUrn, 'the PERSON, from commenter.entityUrn');
  assert.equal(out.first_name, recorded.commenter.firstName);
  // The raw row is untouched.
  for (const [k, v] of Object.entries(row)) assert.deepEqual(out[k], v, k);
});

test('the recorded post_activities row still yields linkedin_url, because its url IS a profile', () => {
  const recorded = liveFixture('post_activities').body.content[0];
  assert.ok(isPersonProfileUrl(recorded.url), 'the recording carries a /in/ URL');
  const out = normalisePageRow(recorded);
  assert.equal(out.linkedin_url, recorded.url);
  assert.equal(out.source_url, undefined, 'nothing left over to record');
});

test('isPersonProfileUrl accepts /in/ and nothing else', () => {
  assert.ok(isPersonProfileUrl('https://www.linkedin.com/in/satyanadella/'));
  assert.ok(isPersonProfileUrl('http://linkedin.com/in/handle'));
  for (const no of [
    LIVE_PERMALINK,
    'https://www.linkedin.com/company/microsoft/',
    'https://www.linkedin.com/posts/someone_activity-123',
    'https://www.linkedin.com/in/',
    'https://example.com/in/handle',
    '', null, undefined, 42,
  ]) assert.equal(isPersonProfileUrl(no), false, String(no));
});

// ---------------------------------------------------------------------------
// 5. THE SERVER'S OWN ERROR BODY REACHES THE USER
// ---------------------------------------------------------------------------
//
// Both recorded 4xx bodies in tests/fixtures/live/ carry the same shape — `error` plus
// `supported_fields: {accepted, required}` — and the runtime discarded all of it. A
// live 422 from `web_emails` and a 400 from `lead_search` printed as five characters.

const RECORDED_4XX = liveFixture('google_ad_transparency_scraper_sync').body;

test('a recorded error body becomes a sentence, for any status', () => {
  for (const status of [400, 422]) {
    const rem = extractRemediation(RECORDED_4XX, { google_ad_url: 'https://example.invalid/x' });
    assert.ok(rem, 'the body carries remediation');
    assert.equal(rem.error, RECORDED_4XX.error);
    assert.deepEqual(rem.supported_fields.required, RECORDED_4XX.supported_fields.required);

    const text = renderRemediation(rem, { endpoint: 'web_emails', status });
    assert.match(text, new RegExp(`HTTP ${status}`));
    assert.match(text, /Access to the requested resource is currently restricted/);
    assert.match(text, /requires: google_ad_url, limit/);
  }
});

test('supported_fields never echoes a value the caller sent', () => {
  const body = { error: 'Unknown input field(s): secret-co.example', supported_fields: { accepted: ['url', 'secret-co.example'] } };
  const rem = extractRemediation(body, { url: 'secret-co.example' });
  assert.ok(!JSON.stringify(rem).includes('secret-co.example'), JSON.stringify(rem));
});

test('a paged/lead_search-shaped 400 with no message still names the fields', () => {
  const body = liveFixture('linkedin_ad_search').body;   // recorded: elements + supported_fields
  const rem = extractRemediation(body, { search_query: 'CTO' });
  assert.ok(rem.supported_fields.accepted.includes('countries'));
  assert.match(renderRemediation(rem, { endpoint: 'lead_search', status: 400 }), /accepts only: /);
});

test('the remediation reaches the run notes instead of dying with the exception', async (t) => {
  const { tree, input } = fixture(t, { rows: [{ url: 'https://example.invalid/' }], name: 'sites.csv' });
  const fake = fakeHttp({ fallback: () => okJson(RECORDED_4XX, { status: 422 }) });

  const res = await runCall({
    endpoint: 'web_emails', input, root: tree.root, dir: 'gtm',
    catalog: CATALOG, api: apiOver(fake), budget: 50, confirm: async () => true,
    runId: 'lgr-422',
  });

  assert.equal(res.failures.http_422, 1, 'still journalled as the SAFE_TOKEN, unchanged');
  const note = (res.notes ?? []).find((n) => n.includes('Access to the requested resource'));
  assert.ok(note, `the server's own sentence, got ${JSON.stringify(res.notes)}`);
  assert.match(note, /HTTP 422/);
  assert.match(note, /requires: google_ad_url, limit/);
});

test('noteRemediation is a no-op without a hint, and never repeats itself', () => {
  const notes = [];
  noteRemediation(notes, new Error('plain'));
  assert.deepEqual(notes, []);
  const err = httpErrorFor(422, { body: RECORDED_4XX, endpoint: 'web_emails', payload: {} });
  noteRemediation(notes, err);
  noteRemediation(notes, err);
  assert.equal(notes.length, 1, '500 identical failures must not print 500 identical notes');
});
