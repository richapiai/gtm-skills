// Shared fixtures for the tests of the general gated call surface.

import fs from 'node:fs';
import { liveEnrichProfile } from '../helpers/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp } from '../helpers/index.mjs';
import { ensureSuppressionStore, addSuppressionEntry } from '../../_lib/suppression.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { loadGates } from '../../_lib/gates.mjs';
import { RichApiClient } from '../../_lib/client.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CATALOG = loadCatalog(REPO);

/**
 * Gates with the auto-batching key present.
 *
 * `runtime.batch.auto` does not exist in gates.yaml yet — it is a GATE KEY REQUEST, and
 * until it is merged the surface fails closed to single calls. Tests that need to prove
 * the batched path inject it, which also means the fail-closed branch is exercised by
 * every test that does NOT inject it.
 */
export function gatesWithBatching (auto = true) {
  const g = loadGates();
  return { ...g, runtime: { ...(g.runtime ?? {}), batch: { ...(g.runtime?.batch ?? {}), auto } } };
}

/** A throwaway project root with a readable suppression store. Never the repo's gtm/. */
export function fixture (t, { rows = null, suppress = [], name = 'l.csv' } = {}) {
  const tree = makeGtmTree({ prefix: 's8-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: tree.root });
  let input = null;
  if (rows) {
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n') + '\n';
    input = path.join(tree.root, name);
    fs.writeFileSync(input, csv);
  }
  return { tree, input: rows ? name : null };
}

/** A client that CANNOT make a call. Any use is a failure, not a counted zero. */
export function cannotCall () {
  return new Proxy({}, {
    get () { throw new Error('ZERO-CALL VIOLATION: this code path touched the HTTP client'); },
  });
}

/** A real RichApiClient over a recording fake transport, so callCount is the truth. */
export function apiOver (fake, { apiKey = 'test-key' } = {}) {
  return new RichApiClient({ apiKey, fetchImpl: (u, i) => fake.fetch(u, i) });
}

export function fakeHttp (opts) { return createFakeHttp(opts); }

export const person = (i) => ({
  first_name: `First${i}`,
  last_name: `Last${i}`,
  company_domain: `acme${i}.example`,
  linkedin_url: `https://linkedin.com/in/person-${i}`,
});

/** A row that already carries the LinkedIn URN the bulk endpoints need. */
export const personWithUrn = (i) => ({ ...person(i), urn: `urn:li:fsd_profile:${1000 + i}` });

/**
 * A profile body whose keys RESPONSE_MAPS actually recognises.
 *
 * REWRITTEN 2026-09-02 to the RECORDED shape. It previously used the spec's key names
 * (`currentTitle`, `currentCompany`), which the server does not send — so this helper
 * agreed with the production map and both were wrong together, which is exactly how the
 * defect stayed invisible while the suite was green.
 */
export const profileBody = (i) => liveEnrichProfile({
  entityUrn: String(1000 + i),
  firstname: `First${i}`,
  lastname: `Last${i}`,
  positionGroups: [{
    company: { id: i, name: `Acme ${i}`, logo: 'https://media.example/a.png', url: 'https://www.linkedin.com/company/acme', domain: `acme${i}.example`, profileType: 'COMPANY' },
    date: { start: '2019-01-01T00:00:00.000Z' },
    profilePositions: [{ company: `Acme ${i}`, title: 'CTO', date: { start: '2019-01-01T00:00:00.000Z' } }],
  }],
});

export function readJsonl (file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
