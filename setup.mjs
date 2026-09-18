#!/usr/bin/env node
// setup — prepare a repo for the RichAPI GTM skills.
//
// Law 7: `gtm/` is PII. Gitignored, TTL-swept, erasable.
// Law 3: no opt-out paid calls, ever — including at setup. This script makes ZERO
//        network calls and spends ZERO credits, UNLESS the user opts in to the
//        own-domain sweep AND types their own domain back to confirm it.
//        Both are required; either one missing means zero. See _lib/setup-sweep.mjs.
//
// What it does, in order:
//   1. HARD REFUSAL — if `gtm/` is already git-tracked, setup refuses to run. A
//      tracked `gtm/` means personal data is already in git history; carrying on
//      would write more of it into the same place.
//   2. Writes `gtm/` into `.gitignore` (with the PII-guard header) if absent.
//   3. Creates the `gtm/` tree and the empty-and-honest suppression store.
//   4. Reports the cache TTL policy source (`_lib/gates.yaml` when present,
//      the built-in fail-closed defaults otherwise).
//   5. OPTIONAL, OPT-IN, PRICED FIRST: offers one enrichment call on the user's own
//      company domain so a new install has a real record instead of an empty tree.
//      Declining is the default and spends exactly zero. The sweep can fail in every
//      way a network call can and setup still exits 0 with a complete tree — the
//      tree is the product, the sweep is a bonus.
//
// Usage: ./setup [--root DIR] [--check] [--quiet] [--json]
//              [--sweep | --no-sweep] [--sweep-domain D] [--confirm-domain D]
//   --check           report only, write nothing (the refusal still exits non-zero)
//   --sweep           offer the own-domain sweep even when stdin is not a terminal
//   --no-sweep        never offer it, not even interactively
//   --sweep-domain D  skip domain inference and offer D instead
//   --confirm-domain D  the non-interactive confirmation; must EQUAL the offered
//                     domain, or nothing is called
//   --gates PATH      read thresholds from PATH instead of `_lib/gates.yaml`. The
//                     sweep needs `setup_sweep.timeout_ms` and `setup_sweep.max_credits`;
//                     if either is absent, per law 5, the sweep refuses to run at all.
//                     This flag is how an operator with a vendored policy file points
//                     at it.
// Exit codes: 0 ok · 2 REFUSED (tracked gtm/) · 1 unexpected error

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  GTM_DIR, GTM_SUBDIRS, SUPPRESSION_FILE, TOMBSTONE_FILE,
  gtmTrackedFiles, isGitRepo, ensureGtmTree, loadTtlTable, DAY_MS,
} from './_lib/pii.mjs';
import { ensureSuppressionStore, suppressionStatus } from './_lib/suppression.mjs';
import { offerSweep, renderSweepOutcome } from './_lib/setup-sweep.mjs';
import { loadGates } from './_lib/gates.mjs';
import { profileStatus } from './_lib/profile.mjs';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';

const GITIGNORE_BLOCK = [
  '# ---------------------------------------------------------------------------',
  '# PII GUARD — gtm/ holds personal data. It must NEVER be tracked.',
  '# `setup` refuses to run in a repo where gtm/ is already git-tracked.',
  '# ---------------------------------------------------------------------------',
  `${GTM_DIR}/`,
  '',
].join('\n');

function parseArgs(argv) {
  const o = {
    root: process.cwd(), check: false, quiet: false, json: false,
    // `sweep` is deliberately a TRISTATE. null = "not mentioned", which means offer
    // it only where there is a terminal to read the price on and a human to decline.
    // A boolean default here would have to pick between never offering and offering
    // in CI, and both are wrong.
    sweep: null, sweepDomain: null, confirmDomain: null, gatesPath: null,
  };
  // A value-taking flag accepts BOTH `--root DIR` and `--root=DIR`. bin/richapi.mjs
  // has always accepted the `=` form, so setup rejecting it as `unknown argument:
  // --root=/tmp/x` meant the pack's FIRST documented command disagreed with the rest of
  // its own CLI, on the form most people type. Reported from a real first run.
  const VALUE_FLAGS = new Set(['--root', '--sweep-domain', '--confirm-domain', '--gates']);
  const KEY = { '--root': 'root', '--sweep-domain': 'sweepDomain', '--confirm-domain': 'confirmDomain', '--gates': 'gatesPath' };

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) { inline = a.slice(eq + 1); a = a.slice(0, eq); }

    if (VALUE_FLAGS.has(a)) {
      // A missing value used to reach resolve(undefined) and print a raw Node stack
      // trace. A flag with no value is a usage error and reads like one.
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v === '') { o.error = `${a} needs a value (e.g. ${a} ./my-workspace)`; return o; }
      o[KEY[a]] = v;
    }
    else if (inline !== undefined) { o.error = `${a} takes no value`; return o; }
    else if (a === '--check' || a === '--dry-run') o.check = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--json') o.json = true;
    else if (a === '--sweep') o.sweep = true;
    else if (a === '--no-sweep') o.sweep = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else { o.error = `unknown argument: ${a}`; return o; }
  }
  o.root = resolve(o.root);
  return o;
}

function gitignoreHasGtm(root) {
  const p = join(root, '.gitignore');
  if (!existsSync(p)) return false;
  return readFileSync(p, 'utf8')
    .split('\n')
    .some(l => {
      const t = l.trim();
      return t === `${GTM_DIR}/` || t === `/${GTM_DIR}/` || t === GTM_DIR || t === `/${GTM_DIR}`;
    });
}

/** gtm/ paths that exist somewhere in git history even if not tracked now. */
function gtmInHistory(root) {
  if (!isGitRepo(root)) return false;
  try {
    const out = execFileSync('git', ['-C', root, 'rev-list', '--all', '--max-count=1', '--', GTM_DIR],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out !== '';
  } catch { return false; }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const out = [];
  const say = (s) => { out.push(s); if (!opts.quiet && !opts.json) console.log(s); };
  const result = {
    root: opts.root, check: opts.check, refused: false, refusal: null,
    gitignore: null, created: [], warnings: [], ttl_source: null, suppression: null,
    paid_calls: 0, credits_spent: 0, sweep: null,
  };

  if (opts.help) {
    console.log('usage: setup [--root DIR] [--check] [--quiet] [--json]');
    console.log('             [--sweep | --no-sweep] [--sweep-domain D] [--confirm-domain D]');
    console.log('             [--gates PATH]');
    console.log('');
    console.log('  The own-domain sweep is OPT-IN and priced before it asks. Declining');
    console.log('  spends 0 credits; so does every way it can fail.');
    return 0;
  }
  if (opts.error) { console.error(`✗ ${opts.error}`); return 1; }

  // -- 1. HARD REFUSAL -------------------------------------------------------
  const tracked = gtmTrackedFiles(opts.root);
  if (tracked.length > 0) {
    result.refused = true;
    result.refusal = {
      reason: 'gtm_is_git_tracked',
      tracked_count: tracked.length,
      tracked_sample: tracked.slice(0, 10),
    };
    const lines = [
      '',
      '✗ REFUSING TO RUN — `gtm/` is already git-tracked in this repo.',
      '',
      `  ${tracked.length} tracked path(s) under ${GTM_DIR}/:`,
      ...tracked.slice(0, 10).map(t => `    - ${t}`),
      ...(tracked.length > 10 ? [`    … and ${tracked.length - 10} more`] : []),
      '',
      '  `gtm/` holds personal data (contacts, emails, enrichment results). Tracked',
      '  means it is in git history, and history is not something setup can fix.',
      '  This is a refusal, not a warning: continuing would write more personal data',
      '  into a directory that is being committed.',
      '',
      '  To resolve, in this order:',
      `    1. git rm -r --cached ${GTM_DIR}`,
      `    2. echo '${GTM_DIR}/' >> .gitignore && git add .gitignore && git commit -m "gitignore gtm/"`,
      '    3. Purge the history that already contains it (git filter-repo / BFG), and',
      '       force-push. Anything already pushed must be treated as disclosed.',
      '    4. Re-run ./setup',
      '',
    ];
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else for (const l of lines) console.error(l);
    return 2;
  }

  say(`RichAPI GTM skills — setup (${opts.check ? 'check only' : 'apply'})`);
  say(`  root: ${opts.root}`);
  say(`  git:  ${isGitRepo(opts.root) ? 'repo detected' : 'not a git repo (nothing to track)'}`);
  say(`  gtm/ tracked by git: no  ✓`);

  if (gtmInHistory(opts.root)) {
    const w = `\`${GTM_DIR}/\` appears in git HISTORY even though it is untracked now — `
      + 'treat anything already pushed as disclosed and purge the history.';
    result.warnings.push(w);
    say(`  ! WARNING: ${w}`);
  }

  // -- 2. .gitignore ---------------------------------------------------------
  //
  // The root has to EXIST before anything is written into it. `./setup` in a checkout
  // always had one (the cwd), so this was invisible until someone used the documented
  // `--root DIR` to point at a workspace that did not exist yet: the .gitignore write
  // was the first write, and it died with a raw ENOENT stack trace before creating a
  // single directory. `--check` passed the whole time, because check mode never writes.
  if (!opts.check && !existsSync(opts.root)) {
    mkdirSync(opts.root, { recursive: true });
    result.created.push('<root>');
    say(`  created root: ${opts.root}`);
  }

  const gi = join(opts.root, '.gitignore');
  if (gitignoreHasGtm(opts.root)) {
    result.gitignore = 'already-present';
    say(`  .gitignore already ignores ${GTM_DIR}/  ✓`);
  } else if (opts.check) {
    result.gitignore = 'would-add';
    say(`  .gitignore would gain ${GTM_DIR}/ (check mode: not written)`);
  } else {
    const prev = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const sep = prev === '' || prev.endsWith('\n') ? '' : '\n';
    writeFileSync(gi, prev + sep + (prev ? '\n' : '') + GITIGNORE_BLOCK, 'utf8');
    result.gitignore = 'added';
    say(`  .gitignore: added ${GTM_DIR}/  ✓`);
  }

  // -- 3. gtm/ tree + suppression store --------------------------------------
  if (opts.check) {
    const missing = [GTM_DIR, ...GTM_SUBDIRS.map(d => `${GTM_DIR}/${d}`),
      `${GTM_DIR}/${SUPPRESSION_FILE}`, `${GTM_DIR}/${TOMBSTONE_FILE}`]
      .filter(p => !existsSync(join(opts.root, p)));
    result.created = missing;
    say(`  gtm/ tree: ${missing.length === 0 ? 'complete ✓' : `${missing.length} path(s) would be created`}`);
  } else {
    ensureGtmTree(opts.root);
    ensureSuppressionStore(opts.root);
    result.created = [GTM_DIR, ...GTM_SUBDIRS.map(d => `${GTM_DIR}/${d}`),
      `${GTM_DIR}/${SUPPRESSION_FILE}`, `${GTM_DIR}/${TOMBSTONE_FILE}`];
    say(`  gtm/ tree: ${GTM_SUBDIRS.join(', ')}  ✓`);
    const st = suppressionStatus({ root: opts.root });
    result.suppression = st;
    say(`  suppression store: ${st.status} (${st.count ?? 0} entries — empty and honest; `
      + 'a missing store reads as STOP, never as "nothing suppressed")');
  }

  // -- 4. TTL policy ---------------------------------------------------------
  const ttl = loadTtlTable({ root: opts.root, ...(opts.gatesPath ? { gatesPath: opts.gatesPath } : {}) });
  result.ttl_source = ttl.source;
  say(`  cache TTL policy: ${ttl.source === 'defaults' ? 'built-in defaults' : ttl.source}`);
  for (const [k, v] of Object.entries(ttl.classes)) {
    const days = (v / DAY_MS).toFixed(v % DAY_MS === 0 ? 0 : 2);
    const tag = k === 'unknown' ? '  <- unknown endpoints fail closed to the shortest TTL' : '';
    say(`      ${k.padEnd(19)} ${String(days).padStart(3)}d${tag}`);
  }
  if (ttl.notes.length && !opts.quiet) for (const n of ttl.notes) say(`      note: ${n}`);

  // -- 5. OPTIONAL own-domain sweep ------------------------------------------
  //
  // Everything above this line is the product. Everything below is a bonus, and it is
  // wrapped so that no outcome of it can change the exit code or the tree. The offer
  // itself is opt-in: `--sweep` forces it, `--no-sweep` forbids it, and unmentioned
  // means "only where a human can read the price and press Enter to decline".
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const sweepEnabled = opts.sweep === true
    || (opts.sweep === null && interactive && !opts.json && !opts.quiet);

  let rl = null;
  const ask = (opts.confirmDomain === null && interactive)
    ? async (q) => {
      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    }
    : null;

  try {
    result.sweep = await offerSweep({
      root: opts.root,
      check: opts.check,
      enabled: sweepEnabled,
      explicitDomain: opts.sweepDomain,
      confirmDomain: opts.confirmDomain,
      ttlDays: ttl.classes.firmographics ? ttl.classes.firmographics / DAY_MS : null,
      ask,
      say: (s) => { if (!opts.quiet && !opts.json) console.log(s); },
      ...(opts.gatesPath ? { loadGates: () => loadGates(opts.gatesPath) } : {}),
    });
  } catch (e) {
    // offerSweep documents that it never throws. This is the belt for that braces:
    // a bonus feature may not take an installation down even if it breaks its own
    // contract.
    result.sweep = { offered: false, ran: false, calls_made: 0, credits: 0,
      reason: `the sweep crashed and was ignored (${e && e.message ? e.message : e})` };
  } finally {
    if (rl) rl.close();
  }

  result.paid_calls = result.sweep?.calls_made ?? 0;
  result.credits_spent = result.sweep?.credits ?? 0;

  const line = renderSweepOutcome(result.sweep);
  if (line && sweepEnabled) say(line);

  say('');
  if (result.paid_calls === 0) {
    say('  0 API calls made, 0 credits spent (Law 3: no opt-out paid calls, ever).');
  } else {
    say(`  ${result.paid_calls} API call(s) made, ~${result.credits_spent} credit(s) spent — `
      + 'the own-domain sweep you opted into and confirmed by name.');
    say('  (Law 3 holds: it was named and costed before it ran, and declining was the default.)');
  }
  // NEXT STEP. setup creates the tree and then used to stop, which left a first run with
  // a workspace and no idea what to do with it — and, more specifically, with a pack that
  // knew nothing about the user. `gtm/profile.yaml` is the one artifact no endpoint can
  // produce, so nothing but an explicit prompt was ever going to create it.
  const profile = profileStatus({ root: opts.root });
  result.profile = profile.state;
  if (!opts.check && profile.state === 'ABSENT') {
    say('');
    say('  Next: run /gtm-onboard (0 credits) so the pack knows what you sell.');
    say('  Without it /personalize has no source for the offer and will have to ask every session.');
  }

  say(opts.check ? '  check complete.' : '  setup complete.');

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`✗ setup failed: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  },
);
