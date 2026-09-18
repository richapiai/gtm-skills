// Law 5 across the `--param` seam.
//
// `richapi call email_verifier --param email=a@b.com` is not an exotic invocation —
// it is the example in `richapi --help`. For that form there is no input list, so
// `_lib/run.mjs` builds `records = [{}]` and the row is an EMPTY object. The address
// lives in `params`, which `buildRequestFor` merges into the payload.
//
// The suppression check read the record. The record was `{}`. So it found no
// identifiers, reported "0 suppressed", and planned a paid call against a contact
// who had unsubscribed. Measured on one address, one store:
//
//     --in    -> 1 suppressed (dropped), 0 calls, 0 credits
//     --param -> 0 suppressed,           1 call,  2 credits
//
// With `--yes --budget` that plan sends. A fail-OPEN on the one law the pack
// describes as un-overridable.
//
// The fix checks the union of the record's identifiers and the built PAYLOAD's,
// because the payload is precisely the thing that reaches the API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planRowCall } from '../../_lib/run.mjs';
import { loadSuppressionStore } from '../../_lib/suppression.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { loadGates } from '../../_lib/gates.mjs';

const SUPPRESSED = 'jane@acme.com';
const CLEAN = 'bob@globex.com';

function storeWith (entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'param-sup-'));
  fs.mkdirSync(path.join(root, 'gtm'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'gtm', 'suppression.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  return loadSuppressionStore({ root, path: path.join(root, 'gtm', 'suppression.jsonl') });
}

function plan ({ records, params }) {
  return planRowCall({
    runId: 'test-run',
    endpoint: 'email_verifier',
    records,
    catalog: loadCatalog(),
    store: storeWith([{ email: SUPPRESSED, reason: 'unsubscribe' }]),
    cache: { enabled: false, has: () => false },
    gates: loadGates(),
    params,
  });
}

const suppressedCount = (p) => p.prepared.filter((u) => u.descriptor.suppressed).length;

test('a suppressed address passed via --param is dropped, not billed', () => {
  const p = plan({ records: [{}], params: { email: SUPPRESSED } });
  assert.equal(
    suppressedCount(p), 1,
    'the record is {} for a --param call, so the address is only visible in the '
    + 'payload. If this is 0 the pack plans a paid call against someone who '
    + 'unsubscribed — and `--param` is the form printed in `richapi --help`.',
  );
});

test('a clean address passed via --param still plans normally', () => {
  const p = plan({ records: [{}], params: { email: CLEAN } });
  assert.equal(suppressedCount(p), 0,
    'checking the payload must not over-block: an address that is not on the store runs');
});

test('the --in path is unchanged', () => {
  assert.equal(suppressedCount(plan({ records: [{ email: SUPPRESSED }], params: {} })), 1);
  assert.equal(suppressedCount(plan({ records: [{ email: CLEAN }], params: {} })), 0);
});

test('a record identifier the request does not send still suppresses', () => {
  // The record is read on its own as well as the payload, because a row can carry
  // an address in a column the request contract never sends. Suppressing on that
  // is correct: the contact is still the contact.
  const p = plan({
    records: [{ personal_email: SUPPRESSED, email: CLEAN }],
    params: {},
  });
  assert.equal(suppressedCount(p), 1,
    'an identifier present on the row but absent from the wire body still counts');
});
