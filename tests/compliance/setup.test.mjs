// PII verify criterion #1: `setup` REFUSES to run on a git-tracked `gtm/`.
// Built against a real temp git repo — the refusal is worthless if it only holds
// against a mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp, write, initGitRepo, git, runSetup } from './helpers.mjs';
import { gtmTrackedFiles } from '../../_lib/pii.mjs';

test.after(cleanupTmp);

test('setup REFUSES (exit 2) in a real git repo where gtm/ is already tracked', () => {
  const root = tmpRoot('compliance-tracked-');
  initGitRepo(root);
  write(root, 'README.md', '# fixture\n');
  write(root, 'gtm/lists/leads.csv', 'email,company\nbob@acme.com,Acme\n');
  git(root, ['add', '-A', '-f']);
  git(root, ['commit', '-q', '-m', 'oops: committed gtm/']);

  assert.ok(gtmTrackedFiles(root).includes('gtm/lists/leads.csv'), 'precondition: gtm/ is tracked');

  const r = runSetup(['--root', root]);
  assert.equal(r.code, 2, 'setup must exit 2, not 0 and not a warning');
  assert.match(r.stderr, /REFUSING TO RUN/);
  assert.match(r.stderr, /gtm\/lists\/leads\.csv/);
  assert.match(r.stderr, /git rm -r --cached gtm/, 'refusal carries remediation');
  // It refused, so it must not have written anything.
  assert.equal(existsSync(join(root, 'gtm', 'suppression.jsonl')), false, 'no writes after a refusal');
});

test('setup REFUSES on a gtm/ that is only staged, not yet committed', () => {
  const root = tmpRoot('compliance-staged-');
  initGitRepo(root);
  write(root, 'gtm/research/acme.md', 'bob@acme.com is the champion\n');
  git(root, ['add', '-f', 'gtm']);

  const r = runSetup(['--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /REFUSING TO RUN/);
});

test('setup REFUSES even when .gitignore already lists gtm/ (tracking beats ignoring)', () => {
  const root = tmpRoot('compliance-both-');
  initGitRepo(root);
  write(root, 'gtm/lists/a.csv', 'email\nbob@acme.com\n');
  git(root, ['add', '-f', 'gtm']);
  git(root, ['commit', '-q', '-m', 'tracked']);
  write(root, '.gitignore', 'gtm/\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-q', '-m', 'ignore']);

  const r = runSetup(['--root', root]);
  assert.equal(r.code, 2, 'a .gitignore entry does not untrack an already-tracked path');
});

test('setup succeeds on a clean repo: writes gtm/ to .gitignore and builds the tree', () => {
  const root = tmpRoot('compliance-clean-');
  initGitRepo(root);
  write(root, 'README.md', '# clean\n');

  const r = runSetup(['--root', root]);
  assert.equal(r.code, 0, r.stderr);

  const gi = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(gi, /^gtm\/$/m, '.gitignore gained the gtm/ guard');
  assert.match(gi, /PII GUARD/, 'the guard says why it is there');

  for (const p of ['gtm/lists', 'gtm/enrichment-cache', 'gtm/research', 'gtm/copy',
                   'gtm/org-maps', 'gtm/deals', 'gtm/ads', 'gtm/runs',
                   'gtm/suppression.jsonl', 'gtm/tombstones.jsonl']) {
    assert.ok(existsSync(join(root, p)), `created ${p}`);
  }
  assert.equal(readFileSync(join(root, 'gtm', 'suppression.jsonl'), 'utf8'), '',
    'suppression store starts EMPTY and honest');
  assert.match(r.stdout, /0 API calls made, 0 credits spent/, 'Law 3: setup makes no paid calls');

  // git now ignores it
  const status = git(root, ['status', '--porcelain', '--ignored=no']);
  assert.equal(/gtm\//.test(status), false, 'gtm/ is invisible to git after setup');
});

test('setup is idempotent and does not duplicate the .gitignore entry', () => {
  const root = tmpRoot('compliance-idem-');
  initGitRepo(root);
  runSetup(['--root', root]);
  const first = readFileSync(join(root, '.gitignore'), 'utf8');
  const r2 = runSetup(['--root', root]);
  assert.equal(r2.code, 0);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), first);
});

test('setup works outside a git repo (nothing to track) and --check writes nothing', () => {
  const root = tmpRoot('compliance-nogit-');
  const r = runSetup(['--root', root, '--check']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(join(root, 'gtm')), false, '--check made no writes');
  assert.equal(existsSync(join(root, '.gitignore')), false, '--check made no writes');

  const r2 = runSetup(['--root', root]);
  assert.equal(r2.code, 0);
  assert.ok(existsSync(join(root, 'gtm', 'suppression.jsonl')));
});

test('setup reports the fail-closed TTL table it will enforce', () => {
  const root = tmpRoot('compliance-ttlreport-');
  const r = runSetup(['--root', root]);
  assert.match(r.stdout, /firmographics\s+90d/);
  assert.match(r.stdout, /funding_tech\s+30d/);
  assert.match(r.stdout, /email_verification\s+7d/);
  assert.match(r.stdout, /posts_activity\s+1d/);
  assert.match(r.stdout, /unknown\s+1d\s+<- unknown endpoints fail closed/);
});

test('setup --json is machine-readable and marks the refusal reason', () => {
  const root = tmpRoot('compliance-json-');
  initGitRepo(root);
  write(root, 'gtm/deals/d.json', '{"email":"bob@acme.com"}');
  git(root, ['add', '-f', 'gtm']);
  git(root, ['commit', '-q', '-m', 'x']);
  const r = runSetup(['--root', root, '--json']);
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.refused, true);
  assert.equal(parsed.refusal.reason, 'gtm_is_git_tracked');

  // and after untracking, it proceeds
  git(root, ['rm', '-r', '-q', '--cached', 'gtm']);
  rmSync(join(root, 'gtm'), { recursive: true, force: true });
  git(root, ['commit', '-q', '-m', 'untrack']);
  const r2 = runSetup(['--root', root, '--json']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).refused, false);
});
