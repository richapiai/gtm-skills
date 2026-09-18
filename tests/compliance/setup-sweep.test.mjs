// The own-domain sweep at setup.
//
// Three verify criteria, each asserted rather than described:
//
//   1. DECLINING SPENDS EXACTLY ZERO. Proven, not counted: every decline path runs
//      with an HTTP client that throws on any property access, so a single touch of
//      it fails the test with a stack trace instead of quietly incrementing a
//      counter that someone then asserts is small.
//   2. A TYPO'D OR UNCONFIRMED COMPANY DOES NOT PROCEED. `acme-inc` does not confirm
//      `acme`, and neither does "y".
//
// WHAT THE SWEEP ASKS FOR CHANGED ON 2026-09-18. It used to offer to enrich the DOMAIN
// it inferred from package.json, the git remote or your git e-mail. Measured against
// the live API that day, `enrich_company` answers a LinkedIn company and nothing else:
// a bare domain is a 404, so every sweep the pack ever offered would have returned
// nothing. It costs zero — a non-2xx is unbilled — which is why it survived. The sweep
// now asks for the company, which setup cannot infer, so it runs only when the operator
// names it on the flag and declines otherwise. Domain resolution is still tested below:
// it is what the decline uses to say "yours looks like ...".
//   3. SETUP NEVER WEDGES. Real child processes against real sockets: a refused
//      connection, a server that never answers, a 402, a 500, and no API key at all.
//      Every one exits 0 with a complete gtm/ tree.
//
// The sweep's two gate keys (`setup_sweep.timeout_ms`, `setup_sweep.max_credits`) are
// now MERGED into `_lib/gates.yaml`, so the shipped file makes the sweep available.
// That is asserted. The fail-closed half — law 5, no key means no sweep — is asserted
// against a gates object and a gates FILE with the whole `setup_sweep:` block STRIPPED
// back out, never against "the real file happens not to have the key yet". The strip
// itself is asserted directly (`gatesWithoutSweep` throws on a no-op strip, and one
// test proves neither key resolves after it), so the fail-closed input cannot rot into
// a vacuous pass the day the block is renamed or moved.
//
// `setup.mjs --gates PATH` is the seam for the child-process half: the working cases
// point at a copy of the real file, the fail-closed case at a copy with the block gone.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { tmpRoot, cleanupTmp, write, initGitRepo, git, REPO_ROOT, SETUP_BIN } from './helpers.mjs';
import { GTM_DIR, GTM_SUBDIRS, SUPPRESSION_FILE, TOMBSTONE_FILE, ensureGtmTree } from '../../_lib/pii.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { loadGates, hasGate, gateValue } from '../../_lib/gates.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { estimate } from '../../_lib/ledger.mjs';
import * as sweep from '../../_lib/setup-sweep.mjs';

// The company the sweep is offered for in these tests. A LinkedIn company URL and its
// universalName slug — the two forms enrich_company answers.
const COMPANY_URL = 'https://www.linkedin.com/company/acme';
const COMPANY_SLUG = 'acme';

test.after(cleanupTmp);

const CATALOG = loadCatalog(REPO_ROOT);
const SHIPPED_GATES = loadGates();

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A client that CANNOT make a call. Any use is a failure, not a counted zero. */
function cannotCall () {
  return new Proxy({}, {
    get (_t, prop) {
      throw new Error(`ZERO-CALL VIOLATION: the decline path touched the HTTP client (.${String(prop)})`);
    },
  });
}

/** A runCall that must never be reached. */
function cannotRun () {
  return async () => { throw new Error('ZERO-CALL VIOLATION: the decline path called runCall'); };
}

/**
 * Gates with the sweep's keys pinned to the values this file's arithmetic assumes.
 *
 * The block IS in the shipped file now, so this is no longer "add the missing keys" —
 * it is a pin, so a later edit to `setup_sweep.max_credits` re-prices a quote here as a
 * red run rather than silently changing what these tests mean.
 */
function gatesWithSweep ({ timeout_ms = 20000, max_credits = 5 } = {}) {
  const g = loadGates();
  return { ...g, setup_sweep: { timeout_ms, max_credits } };
}

/**
 * The shipped gates with the whole `setup_sweep:` block DELETED — the fail-closed
 * input, made rather than found.
 *
 * Throws on a no-op strip. A fail-closed test fed a gates object that still has the
 * block would pass while proving nothing, so the strip has to be load-bearing.
 */
function gatesWithoutSweep () {
  const g = JSON.parse(JSON.stringify(loadGates()));
  if (!Object.prototype.hasOwnProperty.call(g, 'setup_sweep')) {
    throw new Error('gatesWithoutSweep: there is no `setup_sweep:` block to strip — has it moved?');
  }
  delete g.setup_sweep;
  return g;
}

/** A copy of the real gates.yaml on disk, optionally mutated, for the child processes. */
function gatesFileWith (mutate) {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8'));
  mutate(doc);
  const dir = tmpRoot('compliance-gates-');
  const p = join(dir, 'gates.yaml');
  writeFileSync(p, stringifyYaml(doc), 'utf8');
  return p;
}

/** The working file: the real block, with this file's values pinned onto it. */
function gatesFile ({ timeout_ms = 20000, max_credits = 5 } = {}) {
  return gatesFileWith((doc) => {
    if (!doc.setup_sweep) throw new Error('gatesFile: the shipped `setup_sweep:` block is gone');
    doc.setup_sweep = { ...doc.setup_sweep, timeout_ms, max_credits };
  });
}

/** The fail-closed file: the same, with the block stripped back out. */
function gatesFileWithoutSweep () {
  return gatesFileWith((doc) => {
    if (!doc.setup_sweep) throw new Error('gatesFileWithoutSweep: nothing to strip — has the block moved?');
    delete doc.setup_sweep;
  });
}

/** A project root that already has a built gtm/ tree, ready for a sweep. */
function preparedRoot (prefix = 'compliance-sweep-') {
  const root = tmpRoot(prefix);
  ensureGtmTree(root);
  ensureSuppressionStore(root);
  return root;
}

/** Run setup.mjs as a real child process with a controlled environment. */
function runSetupEnv (args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SETUP_BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, richapi_API_KEY: '', richapi_API_ORIGIN: '', ...env },
      timeout: 60_000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Start a throwaway HTTP origin. `mode` decides how it misbehaves. */
async function origin (t, mode) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'Acme Inc', domain: 'acme.com', credits_charged: 1 }));
      } else if (mode === '402') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ balance: '0', reserved: '1' }));
      } else if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream exploded' }));
      } else if (mode === 'hang') {
        // Deliberately no response, ever. This is the wedge the timeout exists for.
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

/** Every path a finished install must have. */
const TREE = [
  GTM_DIR,
  ...GTM_SUBDIRS.map((d) => `${GTM_DIR}/${d}`),
  `${GTM_DIR}/${SUPPRESSION_FILE}`,
  `${GTM_DIR}/${TOMBSTONE_FILE}`,
];

function assertCompleteTree (root, why) {
  for (const p of TREE) assert.ok(existsSync(join(root, p)), `${why}: missing ${p}`);
}

// ---------------------------------------------------------------------------
// 0. Law 1 — the number comes from the catalog, and law 5 — no key, no sweep
// ---------------------------------------------------------------------------

test('the quoted price is the catalog\'s price, not a number typed into the sweep', () => {
  const price = sweep.priceSweep({ catalog: CATALOG, gates: gatesWithSweep() });
  const fromCatalog = estimate(CATALOG.endpoints[sweep.SWEEP_ENDPOINT], { resultCount: 1 });
  assert.equal(price.available, true, price.reason);
  assert.equal(price.credits, fromCatalog.credits);
  assert.equal(price.basis, fromCatalog.basis);
  assert.equal(price.verifiable, fromCatalog.verifiable);
  // Nothing about the sweep may be true only because the current catalog says so.
  assert.ok(Number.isFinite(price.credits) && price.credits > 0);
});

test('on the SHIPPED gates.yaml the sweep is available — the keys are merged', () => {
  // Was: "the keys are a GATE KEY REQUEST, so on the shipped file there is no sweep."
  // The block is now in gates.yaml, so the assertion inverts. The fail-closed half
  // it used to carry now lives in the two tests below, against a STRIPPED gates object
  // rather than against the real file happening to lack a key.
  for (const dotted of ['setup_sweep.timeout_ms', 'setup_sweep.max_credits']) {
    assert.equal(hasGate(SHIPPED_GATES, dotted), true, `${dotted} does not resolve`);
  }
  const price = sweep.priceSweep({ catalog: CATALOG, gates: SHIPPED_GATES });
  assert.equal(price.available, true, price.reason);
  assert.ok(Number.isFinite(price.credits) && price.credits > 0);
  assert.ok(price.credits <= gateValue(SHIPPED_GATES, 'setup_sweep.max_credits'),
    'the shipped quote must sit under the shipped ceiling, or setup offers nothing');
});

test('strip the block and neither key resolves — the fail-closed input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs. If
  // `gatesWithoutSweep()` ever became a no-op — the block renamed, moved, nested under
  // `skills:` — the law-5 tests below would go green while proving nothing at all.
  const stripped = gatesWithoutSweep();
  for (const dotted of ['setup_sweep.timeout_ms', 'setup_sweep.max_credits']) {
    assert.equal(hasGate(stripped, dotted), false, `${dotted} survived the strip`);
  }
});

test('with the setup_sweep block stripped the sweep fails closed (law 5)', () => {
  const price = sweep.priceSweep({ catalog: CATALOG, gates: gatesWithoutSweep() });
  assert.equal(price.available, false, 'no setup_sweep keys, so no sweep');
  assert.match(price.reason, /setup_sweep\.(max_credits|timeout_ms) is missing/);
  assert.match(price.reason, /fails closed/);
});

test('a stripped block refuses the sweep outright, without touching the HTTP client', async () => {
  // Law 5 and the zero-call rule at once: a missing floor is not a cheaper sweep, it is
  // no sweep, and it must decline before anything can be spent.
  const r = await sweep.offerSweep({
    root: preparedRoot('compliance-sweep-nogate-'),
    enabled: true, explicitDomain: COMPANY_URL, confirmDomain: COMPANY_SLUG,
    env: { richapi_API_KEY: 'k' }, catalog: CATALOG, gates: gatesWithoutSweep(),
    api: cannotCall(), runCall: cannotRun(),
  });
  assert.equal(r.ran, false);
  assert.equal(r.calls_made ?? 0, 0);
  assert.match(r.reason, /fails closed/);
});

test('a catalog reprice above the ceiling withdraws the offer rather than raising the quote', () => {
  // Law 1's own evidence: phone_finder went 3 -> 25 credits in four months. A
  // regenerated catalog must not be able to silently make this prompt expensive.
  const price = sweep.priceSweep({ catalog: CATALOG, gates: gatesWithSweep({ max_credits: 0.5 }) });
  assert.equal(price.available, false);
  assert.match(price.reason, /above the gates\.yaml:setup_sweep\.max_credits ceiling/);
});

test('an unpriceable endpoint is never offered — it cannot be named AND costed', () => {
  const broken = { endpoints: { [sweep.SWEEP_ENDPOINT]: { pricing: { model: 'unknown' } } } };
  const price = sweep.priceSweep({ catalog: broken, gates: gatesWithSweep() });
  assert.equal(price.available, false);
  assert.match(price.reason, /not priceable from the catalog/);
});

// ---------------------------------------------------------------------------
// 1. Domain resolution and normalisation
// ---------------------------------------------------------------------------

test('normalizeDomain reduces URLs, emails and noise to one registrable host', () => {
  for (const [input, want] of [
    ['acme.com', 'acme.com'],
    ['  ACME.com  ', 'acme.com'],
    ['https://www.acme.com/about?x=1#top', 'acme.com'],
    ['http://user:pw@acme.com:8443/', 'acme.com'],
    ['mailto:dana@acme.co.uk', 'acme.co.uk'],
    ['dana@sub.acme.com', 'sub.acme.com'],
    ['acme.com.', 'acme.com'],
  ]) assert.equal(sweep.normalizeDomain(input), want, `normalize ${input}`);

  for (const bad of ['', '   ', null, undefined, 'acme', 'localhost', 'http://localhost:3000',
    '127.0.0.1', '192.168.1.1', 'acme.1', 'acme.c', '-acme.com', 'ac me.com', '::1']) {
    assert.equal(sweep.normalizeDomain(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('spellDomain splits the name from the TLD so a one-letter typo is visible', () => {
  assert.deepEqual(sweep.spellDomain('acme.com'), { label: 'acme', tld: 'com' });
  assert.deepEqual(sweep.spellDomain('acme.co'), { label: 'acme', tld: 'co' });
  assert.deepEqual(sweep.spellDomain('acme.co.uk'), { label: 'acme', tld: 'co.uk' });
  assert.deepEqual(sweep.spellDomain('shop.acme.com'), { label: 'shop.acme', tld: 'com' });
});

test('the own domain is read from package.json homepage, and the source is reported', () => {
  const root = tmpRoot('compliance-dom-pkg-');
  write(root, 'package.json', { name: 'x', homepage: 'https://www.acme.com/docs' });
  const r = sweep.resolveOwnDomain({ root, env: {} });
  assert.equal(r.domain, 'acme.com');
  assert.equal(r.source, 'package.json:homepage');
});

test('a homepage or remote pointing at a code forge is NOT treated as the company', () => {
  const root = tmpRoot('compliance-dom-forge-');
  write(root, 'package.json', { name: 'x', homepage: 'https://github.com/acme/x#readme' });
  initGitRepo(root);
  git(root, ['remote', 'add', 'origin', 'git@github.com:acme/x.git']);
  git(root, ['config', 'user.email', 'dana@gmail.com']);
  const r = sweep.resolveOwnDomain({ root, env: {} });
  assert.equal(r.domain, null, 'github.com is where the code lives, not who the user is');
  assert.ok(r.tried.some((x) => x.source === 'package.json:homepage' && x.accepted === false));
});

test('a self-hosted git remote resolves; a consumer mailbox never does', () => {
  const a = tmpRoot('compliance-dom-remote-');
  initGitRepo(a);
  git(a, ['remote', 'add', 'origin', 'git@git.acme.com:team/app.git']);
  assert.equal(sweep.resolveOwnDomain({ root: a, env: {} }).domain, 'git.acme.com');

  const b = tmpRoot('compliance-dom-mail-');
  initGitRepo(b);
  git(b, ['config', 'user.email', 'dana@gmail.com']);
  assert.equal(sweep.resolveOwnDomain({ root: b, env: {} }).domain, null);

  const c = tmpRoot('compliance-dom-workmail-');
  initGitRepo(c);
  git(c, ['config', 'user.email', 'dana@acme.com']);
  const r = sweep.resolveOwnDomain({ root: c, env: {} });
  assert.equal(r.domain, 'acme.com');
  assert.equal(r.source, 'git:user.email');
  assert.match(sweep.sourceProse(r.source), /GUESS/, 'the weakest source says so in the prompt');
});

test('--sweep-domain beats every inference, and a garbage one resolves to nothing', () => {
  const root = tmpRoot('compliance-dom-flag-');
  write(root, 'package.json', { homepage: 'https://other.com' });
  assert.equal(sweep.resolveOwnDomain({ root, env: {}, explicit: 'https://acme.io/x' }).domain, 'acme.io');
  const bad = sweep.resolveOwnDomain({ root, env: {}, explicit: 'not a domain' });
  assert.equal(bad.domain, null);
  assert.match(bad.error, /not a readable domain/);
});

// ---------------------------------------------------------------------------
// 2. The prompt copy — law 3 lives or dies here
// ---------------------------------------------------------------------------

test('the offer names the endpoint, the body and the PRICE before it asks anything', () => {
  const price = sweep.priceSweep({ catalog: CATALOG, gates: gatesWithSweep() });
  const company = sweep.sweepCompany(COMPANY_URL);
  const text = sweep.renderSweepOffer({ domain: company.url, source: 'flag', price, ttlDays: 90, company });
  const question = sweep.sweepQuestion(company.url, company);

  assert.match(text, /POST \/enrich_company/, 'the endpoint is named');
  assert.match(text, /\{"url": "https:\/\/www\.linkedin\.com\/company\/acme"\}/, 'the exact request body is shown');
  assert.match(text, new RegExp(`${price.credits} credit`), 'the price is shown');
  assert.match(text, /api-catalog\.json/, 'and where the price came from');
  assert.match(text, /optional/i);
  assert.match(text, /universalName "acme"/, 'the company is spelled out for confirmation');
  assert.match(text, /gtm\/enrichment-cache\/enrich_company\.jsonl/, 'it says what gets written');
  assert.match(text, /personal data, TTL 90d/, 'and that it is PII with a TTL');

  // Order matters as much as content: a price after the question is not a price.
  const priceAt = text.indexOf(`${price.credits} credit`);
  const askAt = text.indexOf('To run it, type "acme" back');
  assert.ok(priceAt > -1 && askAt > -1 && priceAt < askAt, 'the number precedes the ask');
  assert.match(question, /^\s+Type "acme" to run it, or press Enter to skip: $/);
});

test('the offer states that doing nothing declines', () => {
  const price = sweep.priceSweep({ catalog: CATALOG, gates: gatesWithSweep() });
  const text = sweep.renderSweepOffer({ domain: COMPANY_URL, source: 'flag', price, company: sweep.sweepCompany(COMPANY_URL) });
  assert.match(text, /off by default/);
  assert.match(text, /doing nothing declines it/);
  assert.match(text, /declines and spends 0 credits/);
});

// ---------------------------------------------------------------------------
// 3. Confirmation — a typo must not proceed
// ---------------------------------------------------------------------------

test('only the company confirms the company', () => {
  const c = sweep.sweepCompany(COMPANY_URL);
  assert.equal(sweep.checkCompanyConfirmation('acme', c).ok, true);
  assert.equal(sweep.checkCompanyConfirmation('  ACME ', c).ok, true, 'case and space are not a typo');
  assert.equal(sweep.checkCompanyConfirmation(COMPANY_URL, c).ok, true, 'the URL confirms too — it is what was shown');

  for (const answer of ['', '   ', 'y', 'Y', 'yes', 'YES', 'ok', 'sure', 'n', 'no']) {
    const r = sweep.checkCompanyConfirmation(answer, c);
    assert.equal(r.ok, false, `"${answer}" must not confirm a company`);
  }
  assert.equal(sweep.checkCompanyConfirmation('y', c).code, 'yes_is_not_a_company');
  assert.equal(sweep.checkCompanyConfirmation('', c).code, 'no_answer');
});

test('a neighbouring slug does not confirm, and the refusal says which is which', () => {
  const c = sweep.sweepCompany(COMPANY_URL);
  const r = sweep.checkCompanyConfirmation('acme-inc', c);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'mismatch');
  assert.match(r.reason, /"acme-inc" is not "acme"/);
  assert.match(r.reason, /nothing was spent/);

  // A domain is not a company, however much it looks like one.
  assert.equal(sweep.checkCompanyConfirmation('acme.com', c).code, 'unreadable');
});

test('sweepCompany reads the two forms the endpoint answers, and nothing else', () => {
  // Measured live 2026-09-18: the company URL and the bare universalName both answer
  // 200; a domain answers 404. The regex half matters as much as the accept half —
  // normalizeDomain would reduce the URL to "linkedin.com", which is a domain.
  for (const good of [COMPANY_URL, 'linkedin.com/company/acme', 'https://linkedin.com/company/acme/about', 'acme']) {
    assert.equal(sweep.sweepCompany(good)?.slug, 'acme', `${good} is a company`);
  }
  for (const bad of ['acme.com', 'https://acme.com', 'https://www.linkedin.com/in/someone', '', null, undefined]) {
    assert.equal(sweep.sweepCompany(bad), null, `${bad} is not a company`);
  }
  assert.equal(sweep.normalizeDomain(COMPANY_URL), 'linkedin.com',
    'which is exactly why sweepCompany runs first');
});

// ---------------------------------------------------------------------------
// 4. VERIFY #1 — declining spends EXACTLY zero
// ---------------------------------------------------------------------------

const DECLINES = [
  ['Enter / empty answer', async () => ''],
  ['"y"', async () => 'y'],
  ['"yes"', async () => 'yes'],
  ['a one-letter typo (acme-inc)', async () => 'acme-inc'],
  ['a different company entirely', async () => 'evilcorp'],
  ['the domain instead of the company', async () => 'acme.com'],
  ['gibberish', async () => 'asdf'],
];

for (const [label, ask] of DECLINES) {
  test(`declining with ${label} makes ZERO calls`, async () => {
    const root = preparedRoot();
    const r = await sweep.offerSweep({
      root,
      enabled: true,
      explicitDomain: COMPANY_URL,
      env: { richapi_API_KEY: 'k' },
      catalog: CATALOG,
      gates: gatesWithSweep(),
      api: cannotCall(),        // touching it at all throws
      runCall: cannotRun(),     // and so does reaching the call surface
      ask,
    });
    assert.equal(r.offered, true, 'the offer was made');
    assert.equal(r.ran, false, 'and declined');
    assert.equal(r.calls_made, 0, 'ZERO calls, not a small number');
    assert.equal(r.credits, 0, 'ZERO credits');
    assert.ok(r.reason, 'the decline says why');
    // Nothing was written to the enrichment cache either.
    assert.equal(existsSync(join(root, 'gtm', 'enrichment-cache', 'enrich_company.jsonl')), false);
  });
}

test('not opting in at all makes zero calls and never even resolves a domain', async () => {
  const r = await sweep.offerSweep({
    root: preparedRoot(), enabled: false, api: cannotCall(), runCall: cannotRun(),
    ask: async () => { throw new Error('must not prompt when the sweep was not requested'); },
  });
  assert.equal(r.offered, false);
  assert.equal(r.ran, false);
  assert.equal(r.calls_made, 0);
  assert.match(r.reason, /opt-in/);
});

test('--check never sweeps, whatever else is passed', async () => {
  const r = await sweep.offerSweep({
    root: preparedRoot(), check: true, enabled: true, explicitDomain: COMPANY_URL,
    confirmDomain: COMPANY_SLUG, env: { richapi_API_KEY: 'k' },
    catalog: CATALOG, gates: gatesWithSweep(), api: cannotCall(), runCall: cannotRun(),
  });
  assert.equal(r.ran, false);
  assert.equal(r.calls_made, 0);
  assert.match(r.reason, /--check/);
});

test('a mismatched --confirm-domain does not proceed, with zero calls', async () => {
  const r = await sweep.offerSweep({
    root: preparedRoot(), enabled: true,
    explicitDomain: COMPANY_URL, confirmDomain: 'acme-inc',
    env: { richapi_API_KEY: 'k' }, catalog: CATALOG, gates: gatesWithSweep(),
    api: cannotCall(), runCall: cannotRun(),
  });
  assert.equal(r.ran, false);
  assert.equal(r.declined_code, 'mismatch');
  assert.equal(r.calls_made, 0);
});

test('no terminal and no --confirm-domain means the offer stands but nothing runs', async () => {
  const r = await sweep.offerSweep({
    root: preparedRoot(), enabled: true, explicitDomain: COMPANY_URL,
    env: { richapi_API_KEY: 'k' }, catalog: CATALOG, gates: gatesWithSweep(),
    api: cannotCall(), runCall: cannotRun(), ask: null,
  });
  assert.equal(r.offered, true);
  assert.equal(r.ran, false);
  assert.equal(r.calls_made, 0);
  assert.match(r.reason, /--confirm-domain acme/);
});

test('the zero-call proof is real: confirming DOES touch the client', async () => {
  // Without this, every test above would pass against a sweep that can never call.
  const r = await sweep.offerSweep({
    root: preparedRoot(), enabled: true, explicitDomain: COMPANY_URL, confirmDomain: COMPANY_SLUG,
    env: { richapi_API_KEY: 'k' }, catalog: CATALOG, gates: gatesWithSweep(),
    api: cannotCall(),
  });
  assert.equal(r.ran, true, 'a confirmed offer reaches the call surface');
  assert.equal(r.result.ok, false);
  assert.match(r.result.message, /ZERO-CALL VIOLATION/,
    'the throwing client fired, so the decline tests were proving something');
});

// ---------------------------------------------------------------------------
// 5. The sweep actually working, over the real gated call surface
// ---------------------------------------------------------------------------

test('a confirmed sweep makes exactly one call and writes a PII-stamped cache row', async (t) => {
  const root = preparedRoot('compliance-sweep-ok-');
  const base = await origin(t, 'ok');
  const { RichApiClient } = await import('../../_lib/client.mjs');
  const api = new RichApiClient({ apiKey: 'k', baseUrl: `${base}/api/v1` });

  const r = await sweep.offerSweep({
    root, enabled: true, explicitDomain: COMPANY_URL, confirmDomain: COMPANY_SLUG,
    env: { richapi_API_KEY: 'k' }, catalog: CATALOG, gates: gatesWithSweep(), api,
  });

  assert.equal(r.ran, true, r.reason ?? '');
  assert.equal(r.result.ok, true, r.result.message ?? '');
  assert.equal(r.calls_made, 1, 'one call, not two');
  assert.equal(api.callCount, 1);
  assert.equal(r.credits_quoted, 1);

  const cacheFile = join(root, 'gtm', 'enrichment-cache', 'enrich_company.jsonl');
  assert.ok(existsSync(cacheFile), 'the sweep left a real record behind');
  const row = JSON.parse(readFileSync(cacheFile, 'utf8').trim().split('\n')[0]);
  assert.equal(row.source_endpoint, 'enrich_company', 'law 7: provenance is stamped');
  assert.ok(row.fetched_at, 'law 7: and so is the fetch time, for the TTL sweep');
});

// ---------------------------------------------------------------------------
// 6. VERIFY #3 — setup never wedges (real child processes)
// ---------------------------------------------------------------------------

test('setup exits 0 with a complete tree when the sweep cannot connect at all', async () => {
  const root = tmpRoot('compliance-wedge-conn-');
  // Port 1 on loopback: nothing is listening, so the very first fetch throws.
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, `setup must not wedge on a dead API: ${r.stderr}`);
  assertCompleteTree(root, 'connection refused');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.ran, true, 'it tried');
  assert.equal(out.sweep.result.ok, false, 'and failed');
  // Law 4: a network error is NOT recorded as free. `_lib/run.mjs` ledgers a status-0
  // attempt as an unverifiable estimate on purpose, and setup quotes the ledger rather
  // than inventing a cheerful zero. What matters here is that the install survived.
  assert.equal(out.credits_spent, 1, 'the unverifiable attempt is reported, not hidden');
});

test('setup exits 0 with a complete tree when the sweep TIMES OUT', async (t) => {
  const root = tmpRoot('compliance-wedge-hang-');
  const base = await origin(t, 'hang');   // accepts the socket, answers never
  const started = Date.now();
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile({ timeout_ms: 600 }), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: base });
  assert.equal(r.code, 0, `setup must not wedge on a hung API: ${r.stderr}`);
  assertCompleteTree(root, 'timeout');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.result.code, 'sweep_timeout', 'the bound that fired is named');
  assert.equal(out.credits_spent, 0);
  // The point of the bound: it did not sit there for the client's own 60s ceiling.
  assert.ok(Date.now() - started < 30_000, 'the timeout actually bounded the wait');
});

test('setup exits 0 with a complete tree when the sweep 402s (out of credits)', async (t) => {
  const root = tmpRoot('compliance-wedge-402-');
  const base = await origin(t, '402');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: base });
  assert.equal(r.code, 0, `a 402 at setup is not an installation failure: ${r.stderr}`);
  assertCompleteTree(root, '402');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.result.ok, false);
  assert.equal(out.credits_spent, 0, 'a 402 charges nothing and must be recorded as nothing');
});

test('setup exits 0 with a complete tree when the sweep 500s', async (t) => {
  const root = tmpRoot('compliance-wedge-500-');
  const base = await origin(t, '500');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: base });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, '500');
  assert.equal(JSON.parse(r.stdout).sweep.result.ok, false);
});

test('setup exits 0 with a complete tree when there is NO API KEY', async () => {
  const root = tmpRoot('compliance-wedge-nokey-');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: '' });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, 'no api key');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.ran, false);
  assert.equal(out.paid_calls, 0);
  assert.match(out.sweep.reason, /richapi_API_KEY is not set/);
});

test('setup exits 0 with a complete tree when the sweep gate keys are missing', async () => {
  const root = tmpRoot('compliance-wedge-nogate-');
  // Was: "no --gates, because the shipped file has no setup_sweep block". It has one
  // now, so the fail-closed input is MADE: --gates points at a copy of the real file
  // with the block deleted. Same law-5 path, but it stays true after the merge — and
  // after every future merge, because nothing about it depends on the shipped contents.
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFileWithoutSweep(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, 'missing gate keys');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.ran, false);
  assert.equal(out.paid_calls, 0);
  assert.match(out.sweep.reason, /fails closed/);
});

test('and with NO --gates at all the shipped file lets the sweep through', async () => {
  // The counterpart to the test above, on the default path a real install takes. The
  // sweep must actually reach the network now that the block is merged — proven by the
  // attempt failing on a refused connection rather than on a missing key.
  const root = tmpRoot('compliance-wedge-shipped-');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG, '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, 'shipped gates');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.ran, true, 'the merged keys mean the sweep is offered and tried');
  assert.equal(out.sweep.result.ok, false, 'nothing is listening on port 1');
  assert.doesNotMatch(JSON.stringify(out.sweep), /fails closed/,
    'the shipped file must not be refusing on a missing key any more');
});

test('setup exits 0 with a complete tree when the domain cannot be inferred', async () => {
  const root = tmpRoot('compliance-wedge-nodomain-');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, 'no domain');
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.ran, false);
  assert.equal(out.paid_calls, 0);
  assert.match(out.sweep.reason, /--sweep-domain/);
});

// ---------------------------------------------------------------------------
// 7. Setup's own reporting stays honest
// ---------------------------------------------------------------------------

test('a plain non-interactive setup still reports zero calls and never offers', async () => {
  const root = tmpRoot('compliance-plain-');
  const r = await runSetupEnv(['--root', root], { richapi_API_KEY: 'k' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 API calls made, 0 credits spent \(Law 3/);
  assert.doesNotMatch(r.stdout, /POST \/enrich_company/, 'no offer without a terminal or --sweep');
});

test('--no-sweep suppresses the offer entirely', async () => {
  const root = tmpRoot('compliance-nosweep-');
  const r = await runSetupEnv(
    ['--root', root, '--no-sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile(), '--json'],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.sweep.offered, false);
  assert.equal(out.paid_calls, 0);
});

test('a declined offer prints the price and then reports zero spend', async () => {
  const root = tmpRoot('compliance-decline-print-');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', 'y',
      '--gates', gatesFile()],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST \/enrich_company\s+\{"url": "https:\/\/www\.linkedin\.com\/company\/acme"\}/);
  assert.match(r.stdout, /1 credit/);
  assert.match(r.stdout, /does not confirm a company/);
  assert.match(r.stdout, /0 API calls made, 0 credits spent/);
  assert.match(r.stdout, /setup complete\./);
});

test('a successful sweep is reported honestly, and the tree is still complete', async (t) => {
  const root = tmpRoot('compliance-sweep-e2e-');
  const base = await origin(t, 'ok');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile()],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: base });
  assert.equal(r.code, 0, r.stderr);
  assertCompleteTree(root, 'successful sweep');
  assert.match(r.stdout, /sweep: enriched https:\/\/www\.linkedin\.com\/company\/acme/);
  assert.match(r.stdout, /1 API call\(s\) made/);
  assert.doesNotMatch(r.stdout, /0 API calls made, 0 credits spent/,
    'the zero-spend line must not survive a run that did spend');
  assert.ok(existsSync(join(root, 'gtm', 'enrichment-cache', 'enrich_company.jsonl')));
});

test('the refusal still wins: a tracked gtm/ exits 2 and never reaches the sweep', async (t) => {
  const root = tmpRoot('compliance-sweep-refuse-');
  initGitRepo(root);
  write(root, 'gtm/lists/leads.csv', 'email\nbob@acme.com\n');
  git(root, ['add', '-A', '-f']);
  git(root, ['commit', '-q', '-m', 'oops']);
  const base = await origin(t, 'ok');
  const r = await runSetupEnv(
    ['--root', root, '--sweep', '--sweep-domain', COMPANY_URL, '--confirm-domain', COMPANY_SLUG,
      '--gates', gatesFile()],
    { richapi_API_KEY: 'k', richapi_API_ORIGIN: base });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stdout, /enrich_company/, 'the PII refusal precedes any offer');
  assert.equal(existsSync(join(root, 'gtm', 'enrichment-cache', 'enrich_company.jsonl')), false);
});
