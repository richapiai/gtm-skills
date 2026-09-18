# Shared test helpers

Shared test helpers, used across the suite. Zero runtime dependencies.

```js
import {
  withGtmTree, createFakeHttp, createThrowingHttp,
  insufficientCredits, tooManyRequests,
  assertConformsTo, specFixture
} from '../helpers/index.mjs';
```

---

## Running the tests

```bash
node --test 'tests/**/*.test.mjs'              # everything
node --test 'tests/runs/**/*.test.mjs'       # one area
```

> **Quote the glob. Do not pass a bare directory.**
> On Node 24.5.0, `node --test tests/contracts/` treats the directory argument
> as a *test file* and reports `'test failed'` with no useful output. This has
> bitten more than once. `npm test` already uses the glob form.

Node ≥ 18, ESM, `node:test`, `node:assert/strict`. No `npm install` is needed
and none should become needed: CI has no install step, so a dependency here
makes the suite fail on a fresh clone — the exact wedge the fixtures exist to
prevent.

---

## `tmp-tree.mjs` — throwaway `gtm/` trees

`gtm/` is PII (law 7). A test must never touch the developer's real one, and
must never leave a stray tree behind.

```js
makeGtmTree(opts?) -> GtmTree           // manual; call tree.cleanup()
withGtmTree(t, opts?) -> GtmTree        // cleanup bound to a node:test context
liveTreeCount() -> number               // trees created and not yet cleaned up
DEFAULT_GTM_DIRS = ['runs','enrichment-cache','lists','exports']
```

`opts`:

| key | meaning |
|---|---|
| `files` | `{ 'rel/path': string \| object \| array }` — string written as-is, array as JSONL, object as pretty JSON |
| `dirs` | subdirectories of `gtm/` (default `DEFAULT_GTM_DIRS`) |
| `git` | `git init` the root — for setup's "refuses on a tracked `gtm/`" test |
| `gitignore` | write `gtm/` into `.gitignore` (default: same as `git`) |
| `prefix` | mkdtemp prefix |

`GtmTree`:

```js
tree.root                       // absolute repo root
tree.gtm                        // absolute <root>/gtm
tree.path(...seg)               // resolve under root  (throws if it escapes)
tree.gtmPath(...seg)            // resolve under gtm/
tree.write(rel, contents)       // -> absolute path
tree.writeJson(rel, value)
tree.writeJsonl(rel, lines)     // array of objects or pre-rendered strings
tree.read(rel) / readJson(rel) / readJsonl(rel)
tree.exists(rel)
tree.list(rel = '.')            // recursive, sorted, relative paths
tree.mkdir(rel)
tree.git(...args)               // run git in the tree; throws if not a repo
tree.cleanup()                  // idempotent
```

Every tree is also registered for removal on process exit and on
`SIGINT`/`SIGTERM`, so a crashed run leaves nothing behind.

```js
test('resume pays for 120 rows, not 500', (t) => {
  const tree = withGtmTree(t, { files: { 'gtm/runs/r1.jsonl': journalLines } });
  // ... tree is removed when this test finishes, pass or fail
});
```

---

## `fake-http.mjs` — injectable HTTP client

```js
createFakeHttp(opts?) -> fake
createThrowingHttp(reason?) -> fake     // any call throws ZeroCallViolation
ZeroCallViolation, UnexpectedCallError
```

`opts`:

| key | meaning |
|---|---|
| `queue` | FIFO responses, one consumed per call |
| `routes` | `[[matcher, response], …]` — matcher is an endpoint name, a URL substring, a `RegExp`, or a predicate over the `RecordedCall`; a response may be a function of the call |
| `fallback` | catch-all. **Omit it** and an unmatched call throws `UnexpectedCallError` — the safer default, since a silent 200 turns a missing assertion into a passing test |
| `throwOnCall` | truthy → every call throws `ZeroCallViolation`; pass a string to name the invariant |

`fake`:

```js
await fake.fetch(url, init)     // WHATWG-fetch-shaped; pass wherever a `fetch` is taken
fake.calls                      // RecordedCall[]  {url, endpoint, method, headers, body, bodyText, at}
fake.callCount
fake.calledEndpoints()          // ['email_finder', 'email_verifier']
fake.callsTo(matcher)
fake.on(matcher, response)      // routes registered earlier win
fake.enqueue(...responses)
fake.setFallback(response)
fake.forbidCalls(reason?)       // flip into throw-on-any-call mid-test
fake.allowCalls()
fake.reset()                    // clears calls + queue, keeps routes
fake.assertNoCalls(message?)    // throws, naming the calls that were made
```

`endpoint` is the last path segment, so `routes: [['email_finder', …]]` works
without writing full URLs.

### Proving `--dry-run`'s zero-call claim

Use `createThrowingHttp`, not a call count. A recorder that reports zero proves
only that *this* path did not call; a client that cannot make a request proves
it *could not*.

```js
const http = createThrowingHttp('--dry-run must make zero calls');
const plan = await renderDryRunPlan(rows, { fetch: http.fetch });
// if any hop called out, the test fails here with the endpoint named
assert.equal(plan.total_credits, 812);
```

The attempted call is still recorded, so the failure message can name the
offender.

---

## `responses.mjs` — canned RichAPI responses

Transcribed from the Error Handling and Credits & Pricing sections of
`spec/openapi.yaml`.

```js
okJson(body, {status, headers}?)
okWithoutBillingField(body?)             // the 11-of-21 case: no billing field
insufficientCredits({balance, reserved}?) // 402
tooManyRequests({retryAfter}?)            // 429 + Retry-After header
unauthorized({status}?)                   // 401/403
unknownEndpoint(name?)                    // 404
underMaintenance()                        // 503 + code ENDPOINT_UNDER_MAINTENANCE
upstreamError({status}?)                  // 502/504
serverError()                             // 500
usage({months, total_credits, apis}?)     // GET /usage
FakeResponse, FakeHeaders
```

Two details that are load-bearing, not cosmetic:

- **the 402 body carries `reserved` and `balance` as *strings***
  (`{"error":"Insufficient credits","reserved":"5","balance":"2.5"}`). A ledger
  that assumes numbers mis-reads the one free balance refresh there is.
- **429 carries `Retry-After` as a header, not in the body.** The body is only
  `{"error":"Too Many Requests"}`.

`FakeResponse` exposes `status`, `ok`, `statusText`, `headers.get()`, `json()`,
`text()`, `clone()`. `json()` returns a structuredClone, so one test cannot
mutate another's canned body.

---

## `schema.mjs` + `contracts.mjs` — the frozen contracts

```js
// contracts.mjs
CONTRACT_NAMES                          // ['api-catalog','journal-line','ledger-line']
loadContract(name)                      // parsed, cached
contractSource(name) / contractPath(name)
contractSha256(name) / allContractHashes()
conformsTo(contract, object)            // -> {valid, errors:[{path, message}]}
assertConformsTo(contract, object, msg?) // throws ContractViolation; returns object
assertViolates(contract, object, msg?)   // throws if it CONFORMS — for negative tests
assertContractIsValidSchema(name)

// schema.mjs (for anything not in the frozen three)
validate(schema, data) -> {valid, errors}
assertValidJsonSchema(schema, label?)
formatErrors(errors)
```

`assertConformsTo` failure messages name the contract, its file path, the
failing JSON pointer, and the value — actionable from another suite
without opening this directory.

```js
assertConformsTo('journal-line', line, 'resumed row 380');
assertViolates('ledger-line', { ...row, cost_status: 'actual' },
  'an estimate must never be written as an actual');
```

### The validator is deliberately small

It covers draft 2020-12's structural keywords plus assertive `format`
(`date-time`, `date`, `uri`, `email`). `assertValidJsonSchema` **throws on any
keyword it does not enforce**, on an unresolvable local `$ref`, and on an
uncompilable `pattern`. So a frozen contract cannot quietly grow a keyword that
validation ignores — it fails `tests/contracts/` instead.

If your change needs an unsupported keyword: implement it in `schema.mjs` in the
same change. Do not work around it.

### Contracts are frozen

`tests/contracts/frozen.test.mjs` recomputes each contract's sha256 against
`tests/contracts/frozen-contracts.sha256`. Editing a schema without agreeing the
change and updating that pin in the same commit is a test failure, by design.

---

## `fixtures.mjs` — the pinned corpus

```js
SPEC_FIXTURE_NAMES                       // ['current','endpoint-added','endpoint-removed','price-changed','malformed']
specFixture(name)                        // parsed  (throws YamlError for 'malformed', on purpose)
specFixtureText(name) / specFixturePath(name)
specFixtureManifest() / expectationsFor(name)
pathBlocks(yamlText)                     // Map<'/path', verbatimBlockText>
pinnedSpec() / pinnedSpecSha256() / actualSpecSha256()
fieldMap(endpoint) / allFieldMaps() / PLACEHOLDER_FIELD_MAPS
```

Read declared severities from `expectationsFor(name)` rather than hard-coding
endpoint names — that way changing a fixture forces changing its declared
expectation in the same commit. See `tests/fixtures/README.md`.

---

## `yaml.mjs` — minimal YAML subset parser

```js
parseYaml(text) -> any
parseYamlFile(path) -> Promise<any>
YamlError
```

`yq` is not installed and CLAUDE.md forbids shelling out to it. This covers
exactly what `spec/openapi.yaml` and the fixtures use: block mappings and
sequences, plain / single- / double-quoted scalars (including multi-line
continuations), folded `>` and literal `|` block scalars with `-`/`+` chomping,
single-line flow collections, and `#` comments.

**It throws on anything else** — anchors, aliases, tags, merge keys, multi-doc
streams, multi-line flow collections, tab indentation, duplicate keys. A parser
that silently mis-reads an `x-pricing` block is worse than one that refuses.

Verified against the real 4,790-line spec: 68 paths, every `operationId` and
`x-pricing` block recovered, `0.5` stays a number, `1.0.0` and `4XX` stay
strings.
