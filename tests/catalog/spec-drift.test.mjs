// The pinned spec vs the RUNNING SERVER, and the response maps vs the keys
// the catalog publishes.
//
// HISTORY, KEPT SO IT IS NOT REPEATED. On 2026-08-30 an earlier pass of this file
// asserted the exact opposite of what is asserted below. It had diffed the pinned spec
// against the RichAPI backend's *working copy* — the generated
// catalog/richapi-endpoints.manifest.json, the migrations, the MCP tool registry, the
// Postman collection, the docs — and concluded that `company_enricher` was missing from
// our spec and that `profile_social_metrics` was a phantom. Those are PRE-DEPLOYMENT,
// CURATED artefacts. Only one of the two conclusions survived contact with the wire.
//
// THE EVIDENCE THAT DECIDES IT, re-runnable and free (no API key is sent, and the API
// bills 2xx only, so nothing is charged):
//
//   $ curl -s https://api.richapi.ai/api/v1/catalog
//     -> 200  {tools:[...68 rows...], total:68}
//        `profile_social_metrics` IS one of the 68. Its description is the
//        auto-generated "API endpoint: profile_social_metrics" — which is exactly why
//        the curated artefacts omit it. It is an uncurated passthrough, not a phantom.
//        `company_enricher` is NOT one of the 68.
//
//   $ curl -s -o /dev/null -w "%{http_code}" -X POST \
//       https://api.richapi.ai/api/v1/<name> -H 'Content-Type: application/json' -d '{}'
//     -> profile_social_metrics  401   the router matched; auth rejected
//     -> enrich_company          401   control, a known-good route
//     -> company_enricher        404   no such route
//
//   401 = the route exists behind auth. 404 = the route is absent. So
//   `company_enricher` was removed from the spec, the catalog, the taxonomy and the
//   owners table, and `profile_social_metrics` is a normal enabled, claimed endpoint.
//
// WHAT THIS FILE DOES NOT DO. The live check is `bin/richapi-catalog-drift.mjs`: it
// fetches that same public catalog and blocks on REMOVED_UNMAPPED when a pinned
// endpoint is not on the wire. This file is OFFLINE and does not reimplement it. What
// it holds is the offline half of the same invariant — the pinned catalog and the
// pinned spec describe exactly the same endpoint set, so the drift oracle is comparing
// the thing the pack actually routes through — plus the two named regressions above.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import YAML from 'yaml';

import { RESPONSE_MAPS } from '../../_lib/client.mjs';
import { parseChecksumFile } from '../../_lib/catalog/generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SPEC = path.join(ROOT, 'spec', 'openapi.yaml');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));

// ---------------------------------------------------------------- the pin

test('A: spec/openapi.yaml.sha256 matches spec/openapi.yaml', () => {
  const actual = createHash('sha256').update(fs.readFileSync(SPEC)).digest('hex');
  const pinned = parseChecksumFile(fs.readFileSync(`${SPEC}.sha256`, 'utf8'));
  assert.equal(
    actual,
    pinned,
    'the spec moved without the pin. Changing the spec is a deliberate act: re-pin with\n' +
      '  shasum -a 256 spec/openapi.yaml | awk \'{print $1"  openapi.yaml"}\' > spec/openapi.yaml.sha256'
  );
});

test('A: the committed catalog was generated from the spec that is on disk now', () => {
  const actual = createHash('sha256').update(fs.readFileSync(SPEC)).digest('hex');
  assert.equal(CATALOG.spec_sha256, actual, 'run `npm run catalog:gen`');
});

// ------------------------------------------- the endpoint set the oracle defends

test('A: the pinned catalog names exactly the operations the pinned spec declares', () => {
  // The offline half of the drift invariant. `bin/richapi-catalog-drift.mjs` checks the
  // pinned catalog against the live server; that check is only meaningful if the pinned
  // catalog is a faithful projection of the pinned spec, with nothing hand-added and
  // nothing quietly dropped. Derived on both sides — no endpoint list is typed here, so
  // this does not need editing when the spec legitimately changes.
  const doc = YAML.parse(fs.readFileSync(SPEC, 'utf8'));
  const fromSpec = Object.entries(doc.paths ?? {})
    .filter(([, item]) => item?.post)
    .map(([, item]) => item.post.operationId)
    .sort();
  assert.deepEqual(
    Object.keys(CATALOG.endpoints).sort(),
    fromSpec,
    'the catalog and the spec disagree on the endpoint set. Either run `npm run catalog:gen`,\n' +
      'or an endpoint was hand-edited into one file and not the other — which is the exact\n' +
      'shape of the company_enricher bug this file was rewritten to prevent.'
  );
});

test('A: company_enricher is absent — the live server 404s it (see the header)', () => {
  // Regression pin for the reversal. This name was added to the spec, the catalog, the
  // enrichment taxonomy and the owners table on the strength of backend-repo artefacts,
  // and the wire says there is no such route. Re-verify with the curl in the header
  // before ever putting it back.
  const doc = YAML.parse(fs.readFileSync(SPEC, 'utf8'));
  assert.equal(doc.paths['/company_enricher'], undefined, 'back in the spec');
  assert.equal(CATALOG.endpoints.company_enricher, undefined, 'back in the catalog');
});

test('A: profile_social_metrics is a live, enabled, callable endpoint', () => {
  // The other half of the reversal. Absence from a curated artefact is not absence from
  // the wire: this one answers 401, not 404. Three shipped SKILL.md files
  // (/evidence-score, /account-research, /pre-meeting-briefing) route through it and
  // were correct all along; disabling it turned three green suites red and would have
  // taken a working paid capability off the shelf.
  const e = CATALOG.endpoints.profile_social_metrics;
  assert.ok(e, 'dropped from the catalog');
  assert.equal(e.pricing.disabled_by_default, false, 're-disabled — re-run the curls first');
  assert.equal(e.pricing.disabled_reason, null);
});

test('A: web_sitemap requires `limit`, and it is the live server that says so too', () => {
  // HELD, AND NO LONGER A DELTA. The earlier pass called this a deliberate one-endpoint
  // tightening — "the backend requires only ['url']" — on the strength of the backend
  // working copy. The live catalog disagrees with the working copy and agrees with us.
  // Measured 2026-08-30, GET https://api.richapi.ai/api/v1/catalog:
  //
  //   web_sitemap.input_schema = { url: {required:true}, limit: {required:true},
  //                                cache: {required:false} }
  //
  // so `richapi-catalog-drift` reports no REQUIRED_FIELD_* change at all on this row,
  // and the stricter form costs nothing to hold.
  //
  // It is still worth holding deliberately rather than by accident, because the reason
  // survives even if the server relaxes: web_sitemap bills per RESULT on `count` at 1
  // credit each with no server-side ceiling, and a sitemap can hold tens of thousands of
  // URLs. `required_request_fields` is the pack's client-side precondition, not a claim
  // about server validation — the frozen contract already says an empty list is "a KNOWN
  // HAZARD, not a green light: the runtime must supply its own validation". Requiring
  // `limit` IS that validation, written where the runtime reads it. Law 5, fail closed.
  // If the spec is ever regenerated from a looser source this would be lost silently.
  // That is what this test is for.
  const e = CATALOG.endpoints.web_sitemap;
  assert.deepEqual(e.required_request_fields, ['limit', 'url']);
  assert.equal(e.pricing.model, 'per_result');
  assert.equal(e.pricing.result_count_field, 'count');
  assert.equal(e.pricing.bounded, true, 'the whole point of requiring the bound');
});

// -------------------------------------------------- RESPONSE_MAPS vs reality

test('every RESPONSE_MAPS key is a key the catalog says the API answers with', () => {
  // THE EMPTY-COLUMN CLASS. A map key that is not in the response produces no column, silently,
  // on a paid call.
  //
  // Derived, never pinned: `_lib/client.mjs` keeps growing, so this states the
  // invariant every present and future entry must satisfy rather than freezing
  // today's six. (
  // tests/response-maps/response-map-coverage.test.mjs guards the mirror image — keys the API
  // publishes that the map never reads. This one is the catalog side of the contract
  // and stays here because this directory tests what the catalog publishes.)
  const offenders = [];
  for (const [endpoint, map] of Object.entries(RESPONSE_MAPS)) {
    const e = CATALOG.endpoints[endpoint];
    assert.ok(e, `RESPONSE_MAPS has an entry for ${endpoint}, which is not in the catalog`);
    for (const k of Object.keys(map)) {
      if (!(e.field_map_keys ?? []).includes(k)) offenders.push(`${endpoint}.${k}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'RESPONSE_MAPS reads keys the documented 200 example does not contain. Each one is a\n' +
      'column that will silently never populate on a paid call — a billed call that delivers no data.'
  );
});

test('RESPONSE_MAPS never acquires an endpoint with no published keys', () => {
  // The precondition that makes the test above able to see anything at all. An endpoint
  // whose `field_map_keys` is null publishes nothing to check a hand-written map
  // against, so mapping it is unfalsifiable. Capture a live fixture first.
  for (const endpoint of Object.keys(RESPONSE_MAPS)) {
    const e = CATALOG.endpoints[endpoint];
    assert.ok(e, `RESPONSE_MAPS has an entry for ${endpoint}, which is not in the catalog`);
    assert.ok(
      Array.isArray(e.field_map_keys) && e.field_map_keys.length > 0,
      `${endpoint} has a hand-written response map and NO published response keys — ` +
        'nothing can check the map. Capture a live fixture before mapping it.'
    );
  }
});

test('A: find_personal_email — the capture settled the disagreement, in the spec\'s favour', () => {
  // The spec declared an async job envelope; the backend manifest recorded a resolved
  // payload ({first_personal_email, message}). They could not both be right, so the
  // endpoint stayed unmapped and loud. The 2026-08-31 capture answered it: the server
  // sends the envelope, RESOLVED — {id, data:{email, status, verifier}, status}.
  //
  // The catalog now publishes the recorded scalar paths rather than the spec's
  // top-level key names, so `data` is replaced by the three fields inside it.
  const e = CATALOG.endpoints.find_personal_email;
  assert.equal(e.field_map_status, 'live_fixture');
  assert.equal(e.live_envelope, 'data');
  assert.deepEqual(e.field_map_keys, ['data.email', 'data.status', 'data.verifier', 'id', 'status']);
  assert.ok(!e.field_map_keys.includes('first_personal_email'),
    'the backend manifest\'s shape is the one the recording ruled out');
});
