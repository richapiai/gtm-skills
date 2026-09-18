// CLI defects found by the live recipe runs (2026-09-17).
//
//   8.  `richapi search <endpoint> --help` was parsed as a RUN — `help` is not a
//       value-taking flag, so it became `flags.help = true`, the endpoint positional
//       stood, and the command planned a search which was then declined for want of a
//       prompt. A help request must never reach a planner.
//   6c. `enrich --help` typed a credit price into the usage text (law 1).
//   6d. a verify step with no email to verify was reported as `FAILED 1:
//       input_insufficient` — an API failure the user would go and chase.
//   9.  `setup` did not create every directory a shipped skill writes into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp, okJson } from '../helpers/index.mjs';
import { runEnrich, loadCatalog } from '../../_lib/enrich.mjs';
import { RichApiClient } from '../../_lib/client.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { GTM_SUBDIRS, ensureGtmTree } from '../../_lib/pii.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'bin', 'richapi.mjs');
const CATALOG = loadCatalog(REPO);

function cli (args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });
}

// ---------------------------------------------------------------------------
// 8. --help prints usage and exits 0, before any planning
// ---------------------------------------------------------------------------

test('--help prints usage and exits 0 for every subcommand', () => {
  for (const args of [
    ['search', 'people_search', '--help'],
    ['search', '--help'],
    ['call', 'email_verifier', '--help'],
    ['enrich', 'list.csv', '--help'],
    ['enrich', '--help'],
    ['doctor', '--help'],
    ['gates', '--help'],
    ['catalog', '--help'],
    ['preflight', '--help'],
    ['call', 'email_verifier', '-h'],
  ]) {
    // execFileSync throws on a non-zero exit, so "it exits 0" is the call not throwing.
    const out = cli(args);
    assert.match(out, /richapi — GTM waterfall runtime/, args.join(' '));
    assert.match(out, /Usage/, args.join(' '));
  }
});

test('--help never reaches a planner: no state tree is touched and nothing is declined', () => {
  const tree = makeGtmTree({ prefix: 'help-' });
  try {
    const out = execFileSync(process.execPath, [CLI, 'search', 'people_search', '--help', '--dir', path.join(tree.root, 'gtm')],
      { encoding: 'utf8', cwd: tree.root });
    assert.doesNotMatch(out, /DRY RUN|Plan not approved|needs approval/);
  } finally { tree.cleanup(); }
});

// ---------------------------------------------------------------------------
// 6c. law 1 — no credit price is typed into the CLI's own text
// ---------------------------------------------------------------------------

test('the usage text types no credit price', () => {
  const usage = cli(['help']);
  assert.doesNotMatch(usage, /\d+\s*credits?\s*\/\s*call/i,
    'a hard-typed price is stale within a quarter — phone_finder went 3 -> 25 credits');
  // The flag is still documented; only the number is gone.
  assert.match(usage, /--phone/);
  assert.match(usage, /catalog/);
});

// ---------------------------------------------------------------------------
// 7b. `call --batch` is honoured
// ---------------------------------------------------------------------------

test('the CLI documents --batch on call, and --no-batch still wins', () => {
  const usage = cli(['help']);
  assert.match(usage, /--batch\s/, '--batch was parsed and then read by nothing');
  assert.match(usage, /--no-batch/);
  const src = fs.readFileSync(CLI, 'utf8');
  // --no-batch is checked FIRST, so an override can only ever be more conservative.
  assert.ok(src.indexOf('flags.no_batch ? { gates: await batchGates(false) }')
    < src.indexOf('flags.batch ? { gates: await batchGates(true) }'));
});

// ---------------------------------------------------------------------------
// 6d. a unit that never reached the wire is SKIPPED, not FAILED
// ---------------------------------------------------------------------------

test('a verify step with no email to verify is reported as skipped, not failed', async (t) => {
  const tree = makeGtmTree({ prefix: 'skipped-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const input = path.join(tree.root, 'l.csv');
  fs.writeFileSync(input, 'linkedin_url\nhttps://linkedin.com/in/a\n');

  const http = createFakeHttp({
    fallback: (call) => (call.endpoint === 'email_finder'
      // A 2xx that found nothing: no email, so the verifier hop has nothing to verify.
      ? okJson({ result: { email: null, status: 'not_found' } })
      : okJson({ firstname: 'A', lastname: 'B', headline: 'VP', entityUrn: '1' })),
  });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 100,
    api: new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch }),
    verify: true, confirm: async () => true,
  });

  assert.equal(res.failures.input_insufficient, undefined, 'a skip is not a failure');
  assert.equal(res.skipped_units.input_insufficient, 1);
  assert.equal(Object.keys(res.failures).length, 0, `unexpected failures: ${JSON.stringify(res.failures)}`);
});

// ---------------------------------------------------------------------------
// 9. setup creates every directory a shipped skill writes into
// ---------------------------------------------------------------------------

/** Every `gtm/<dir>/` a shipped skill mentions. Derived, so it cannot go stale. */
function dirsSkillsWriteTo () {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(md|mjs|sh|js)$/.test(e.name)) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/gtm\/([a-z-]+)\//g)) out.add(m[1]);
    }
  };
  walk(path.join(REPO, 'skills'));
  return [...out].sort();
}

test('every gtm/ directory a skill writes to is in the state tree setup creates', () => {
  const want = dirsSkillsWriteTo();
  assert.ok(want.includes('calls'), 'the derivation itself must find /call-intel\'s gtm/calls/');
  const missing = want.filter((d) => !GTM_SUBDIRS.includes(d));
  assert.deepEqual(missing, [],
    'a skill writing outside the tree writes outside the erase sweep and the TTL sweep too (law 7)');
});

test('ensureGtmTree really creates them on disk', (t) => {
  const tree = makeGtmTree({ prefix: 'tree-' });
  t.after(() => tree.cleanup());
  ensureGtmTree(tree.root);
  for (const d of ['calls', 'lists', 'runs', 'cost', 'exports']) {
    assert.ok(fs.existsSync(path.join(tree.root, 'gtm', d)), `gtm/${d} was not created`);
  }
});
