// Shared test substrate for the core runtime suites.
//
//   import {
//     withGtmTree, createFakeHttp, createThrowingHttp,
//     insufficientCredits, tooManyRequests,
//     assertConformsTo, specFixture
//   } from '../helpers/index.mjs';
//
// See tests/helpers/README.md for the full API surface and how to run the suite.

export {
  makeGtmTree, withGtmTree, DEFAULT_GTM_DIRS, liveTreeCount, trackedTmp,
} from './tmp-tree.mjs';

export {
  createFakeHttp, createThrowingHttp, ZeroCallViolation, UnexpectedCallError
} from './fake-http.mjs';

export {
  FakeResponse, FakeHeaders, okJson, okWithoutBillingField, insufficientCredits,
  tooManyRequests, unauthorized, unknownEndpoint, underMaintenance,
  upstreamError, serverError, usage,
  // Live-shaped success bodies. Prefer these over a hand-rolled literal for any
  // enrichment endpoint — see the comment above them in responses.mjs.
  liveEmailFinder, liveEmailVerifier, livePhoneFinder,
  liveEnrichProfile, liveEnrichCompany, liveFindPersonalEmail
} from './responses.mjs';

export {
  validate, assertValidJsonSchema, formatErrors, SchemaSupportError
} from './schema.mjs';

export {
  CONTRACT_NAMES, CONTRACTS_DIR, contractPath, contractSource, loadContract,
  contractSha256, allContractHashes, conformsTo, assertConformsTo,
  assertViolates, assertContractIsValidSchema
} from './contracts.mjs';

export {
  SPEC_FIXTURE_NAMES, SPEC_FIXTURES_DIR, LIVE_FIXTURES_DIR, FIELD_MAPS_DIR,
  specFixturePath, specFixtureText, specFixture, specFixtureManifest,
  expectationsFor, pinnedSpec, pinnedSpecSha256, actualSpecSha256, pathBlocks,
  fieldMap, allFieldMaps, PLACEHOLDER_FIELD_MAPS
} from './fixtures.mjs';

export { parseYaml, parseYamlFile, YamlError } from './yaml.mjs';
