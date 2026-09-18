// Shared fixtures for the budget and page-multiplier suites.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp } from '../helpers/index.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { loadGates } from '../../_lib/gates.mjs';
import { RichApiClient } from '../../_lib/client.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CATALOG = loadCatalog(REPO);
export const GATES = loadGates();

/** A throwaway project root with a readable suppression store. Never the repo's gtm/. */
export function fixture (t, { rows = null, name = 'list.csv' } = {}) {
  const tree = makeGtmTree({ prefix: 'f3-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  let input = null;
  if (rows) {
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n') + '\n';
    input = path.join(tree.root, name);
    fs.writeFileSync(input, csv);
  }
  return { tree, input };
}

/** A real RichApiClient over a recording fake transport, so callCount is the truth. */
export function apiOver (fake) {
  return new RichApiClient({ apiKey: 'test-key', fetchImpl: (u, i) => fake.fetch(u, i) });
}

export function fakeHttp (opts) { return createFakeHttp(opts); }

/** A client that CANNOT make a call. Any use is a failure, not a counted zero. */
export function cannotCall () {
  return new Proxy({}, {
    get () { throw new Error('ZERO-CALL VIOLATION: this code path touched the HTTP client'); },
  });
}

/** Plan-only stubs, for the pure planners. */
export const noCache = { enabled: false, has: () => false, get: () => null };
export const noStore = { has: () => false };
