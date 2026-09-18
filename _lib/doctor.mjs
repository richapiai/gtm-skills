// _lib/doctor.mjs — `richapi doctor`: the preflight, in English, with the fix.
//
// WHY THIS EXISTS.
//
// `richapi-skills-preflight` emits a stable KEY: VALUE contract, which is the right
// shape for a machine and the wrong shape for the person reading their first screen of
// this pack. Two of those lines used to be actively misleading — `CATALOG_STALE: yes`
// on a fresh install, and `BALANCE: 0` with no API key — and even after both were fixed,
// `CATALOG_OK: unknown` still needs a sentence to be actionable.
//
// docs/TROUBLESHOOTING.md already holds every key-to-fix mapping. Nothing executed it.
// This does.
//
// It makes ZERO network calls and spends ZERO credits. It reads the preflight's stdout
// and the local state tree, and nothing else. Law 3 has no carve-out for diagnostics.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { spendSplit, skillNames } from './spend-split.mjs';
import { style, chip, banner } from './tty.mjs';

/**
 * "N of M skills never spend at all", counted at runtime.
 *
 * Degrades to a claim-free sentence rather than a guessed number: a doctor that invents
 * a count to fill a sentence is the defect this whole pack argues against.
 */
function freeSkillClaim () {
  try {
    const { free } = spendSplit();
    return `${free.length} of the ${skillNames().length} skills never spend at all.`;
  } catch {
    return 'Several skills never spend at all.';
  }
}

// The activation store's own path helper, so `doctor` and the recorder can never
// disagree about where the counters live. Importing the constant beats re-deriving it.
import { activationPath, ACTIVATION_FILE } from './activation.mjs';

export const OK = 'ok';
export const WARN = 'warn';
export const STOP = 'stop';
export const UNKNOWN = 'unknown';

/** Parse the preflight's `KEY: value` contract. Unknown keys are kept, never dropped. */
export function parsePreflight (stdout) {
  const out = {};
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Every check, in the order a first-timer should read them.
 *
 * Ordered by what blocks what: a missing `jq` makes three later checks unreadable, so
 * it is first and says so. Each row returns a level, a sentence in plain English, and —
 * when something is wrong — the exact command that fixes it. A finding with no fix is a
 * finding the reader cannot act on.
 */
export function diagnose (keys, { stateTreeExists = null } = {}) {
  const findings = [];
  const add = (id, level, title, detail, fix = null) =>
    findings.push({ id, level, title, detail, fix });

  const jqMissing = keys.JQ_MISSING === 'yes';
  if (jqMissing) {
    add('jq', STOP,
      'jq is not installed',
      'Every check that reads JSON shells out to jq. Without it those checks cannot run, '
      + 'and they report "unknown" rather than pretending they looked. Nothing below that '
      + 'says "unknown" is necessarily broken — it is unmeasured.',
      'macOS: brew install jq   ·   Debian/Ubuntu: sudo apt install jq');
  } else {
    add('jq', OK, 'jq is installed', 'Every JSON check below could actually run.');
  }

  if (keys.CATALOG_OK === 'yes') {
    add('catalog', OK, `Catalog loaded — ${keys.CATALOG_TOOLS} endpoints`,
      'Every credit price the pack quotes is read from here, never typed by hand.');
  } else if (keys.CATALOG_OK === 'unknown') {
    add('catalog', UNKNOWN, 'Catalog not checked',
      'jq is missing, so nothing read the catalog. This is almost certainly NOT a catalog '
      + 'problem — install jq and look again before regenerating anything.',
      'Install jq, then: richapi doctor');
  } else {
    add('catalog', STOP, 'Catalog missing or unreadable',
      'Nothing can be priced or routed without it, so no skill will run.',
      'richapi catalog gen');
  }

  if (keys.CATALOG_STALE === 'yes') {
    add('staleness', WARN, 'Catalog has not been checked against the API recently',
      'Prices move — one endpoint went from 3 credits to 25 in a single quarter — so a '
      + 'catalog nobody has re-checked may quote an old number.',
      'richapi catalog diff');
  } else {
    add('staleness', OK,
      keys.CATALOG_AGE === 'never' ? 'Catalog is the shipped one' : 'Catalog is current',
      keys.CATALOG_AGE === 'never'
        ? 'It has never been re-synced, which is fine on a fresh install: the committed '
          + 'catalog is checked against the pinned spec on every build.'
        : 'Last checked within the freshness window.');
  }

  if (keys.SUPPRESSION === 'OK') {
    add('suppression', OK, 'Do-not-contact store is readable',
      'Suppressed contacts are dropped before any credit is spent, and again at write time.');
  } else if (keys.SUPPRESSION === 'STOP') {
    add('suppression', STOP, 'Do-not-contact store is unreadable',
      'Nothing will enrich until this is fixed. A missing store is never read as "nobody '
      + 'has unsubscribed" — that is the fail-closed rule, not a bug. If you have just run '
      + 'setup, you are probably running from the wrong directory: setup takes --root (the '
      + 'parent), the commands take --dir (the gtm/ folder inside it).',
      './setup --root <your project>     # then re-run from that project');
  } else {
    add('suppression', UNKNOWN, 'Do-not-contact store not checked',
      `The preflight reported "${keys.SUPPRESSION ?? 'nothing'}".`);
  }

  if (keys.API_KEY_SET === 'yes') {
    add('key', OK, 'API key is set', 'Paid calls are possible. Every one is priced and approved first.');
  } else {
    add('key', OK, 'No API key — dry runs still work',
      'This is not a problem. Dry runs make zero calls, cost nothing, print the full priced '
      // DERIVED. This sentence used to hand-type "11 of the 33 skills", which law 6 forbids
      // in prose and forbids harder in shipped code: it went stale the moment a 34th skill
      // landed, and the CLI carried on stating it to every user.
      + `plan, and are the thing worth trying first. ${freeSkillClaim()}`,
      'richapi enrich <your-list.csv> --dry-run');
  }

  if (keys.BALANCE === 'unknown') {
    add('balance', OK, 'Credit balance: unknown',
      'The honest answer, not a failure. The pack will not guess a balance. A number appears '
      + 'only after a background GET /usage probe has answered (key set) or a run has seen a 402.');
  } else {
    add('balance', OK, `Credit balance: ${keys.BALANCE}`,
      'Last known value, cached from a 402 or from a background GET /usage probe. Treat it '
      + 'as a hint rather than a guarantee.');
  }

  if (stateTreeExists === false) {
    add('state', STOP, 'No gtm/ state tree here',
      'Runs write their journal, ledger, cache and suppression store into gtm/. Without one '
      + 'there is nowhere to record what you spent.',
      './setup --root .');
  }

  return findings;
}

/** The worst level present. Drives the exit code. */
export function overall (findings) {
  if (findings.some(f => f.level === STOP)) return STOP;
  if (findings.some(f => f.level === WARN)) return WARN;
  if (findings.some(f => f.level === UNKNOWN)) return UNKNOWN;
  return OK;
}

const MARK = { [OK]: '  ok  ', [WARN]: ' warn ', [STOP]: ' STOP ', [UNKNOWN]: '  ??  ' };

/**
 * `color` defaults to OFF, not to auto-detect.
 *
 * Deliberate: this function is called by tests, by `renderReport` consumers and by
 * anything piping doctor into an issue. A default that sniffed the TTY would make the
 * return value depend on ambient state, and the escape codes would show up in whatever
 * a caller did with the string. The CLI opts in; everyone else gets plain text.
 */
export function render (findings, { version = null, verdict = null, color = false } = {}) {
  const c = style(color);
  const lines = [];

  if (color) {
    // Tagline only. The version stays in the header line in BOTH renders, so the styled
    // and plain outputs carry identical text once the escapes are stripped — pinned by
    // tests/cli/tty.test.mjs. Styling changes presentation; it must never change content.
    const b = banner({ enabled: true, tagline: 'the bill, before you pay it' });
    if (b) lines.push(b);
  }
  lines.push(`${c.bold('richapi doctor')}${version ? `  ${c.dim(`(${version})`)}` : ''}`);
  lines.push('');
  for (const f of findings) {
    lines.push(`${color ? chip(f.level, c) : `[${MARK[f.level]}]`} ${f.title}`);
    for (const l of wrap(f.detail, 74)) lines.push(`          ${c.dim(l)}`);
    if (f.fix) lines.push(`          ${c.cyan(`fix: ${f.fix}`)}`);
    lines.push('');
  }
  const v = verdict ?? overall(findings);
  const paint = { [OK]: c.green, [WARN]: c.yellow, [UNKNOWN]: c.gray, [STOP]: c.red }[v] ?? ((x) => x);
  lines.push(paint({
    [OK]: 'Everything checks out. Nothing here spends a credit until you approve a plan.',
    [WARN]: 'Usable, with one or more warnings above.',
    [UNKNOWN]: 'Some checks could not run. Fix those first — they are unmeasured, not failed.',
    [STOP]: 'Something is blocking. Fix the STOP lines above before running a skill.',
  }[v]));
  lines.push('');
  lines.push(c.dim('No API calls were made and no credits were spent.'));
  return lines.join('\n');
}

function wrap (text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The paste-able report (8A).
 *
 * The pack sends no telemetry and `SECURITY.md` commits to that, so the only way a
 * maintainer learns where people get stuck is if the person who got stuck can hand over
 * a diagnosis. This renders one.
 *
 * It carries NO list data, NO file paths under the user's home, and NO API key — only
 * the preflight's own key contract, which is booleans and counts, plus the local
 * activation counters if any exist. Anything that could identify a contact is out of
 * scope by construction: this function never reads gtm/lists, gtm/runs or the ledger.
 */
export function renderReport (keys, findings, { version = null, activation = null } = {}) {
  const safe = {};
  for (const k of ['JQ_MISSING', 'CATALOG_OK', 'CATALOG_TOOLS', 'CATALOG_AGE',
    'CATALOG_STALE', 'FILTERS_OK', 'API_KEY_SET', 'SKILLS_VERSION', 'NET',
    'SUPPRESSION', 'UPGRADE']) {
    if (keys[k] !== undefined) safe[k] = keys[k];
  }
  // BALANCE is deliberately reduced to whether one is known. The number is an account
  // fact and nobody needs it to debug an install.
  safe.BALANCE_KNOWN = keys.BALANCE && keys.BALANCE !== 'unknown' ? 'yes' : 'no';

  const lines = [
    '```',
    `richapi doctor --report   ${version ?? ''}`.trim(),
    `node ${process.version}  platform ${process.platform}`,
    '',
    ...Object.entries(safe).map(([k, v]) => `${k}: ${v}`),
  ];
  if (activation && typeof activation === 'object') {
    lines.push('', '-- activation (local counters) --');
    // ALLOWLIST, not "every scalar". The activation store also holds `install_id`, a
    // stable per-install UUID. It exists so the LOCAL bands can tell one install's runs
    // apart across time; it is not a counter, and this block is written to be pasted
    // into a public issue. A stable unique ID in a public paste is a fingerprint that
    // links every report a person ever files, which is precisely what SECURITY.md's
    // `## No telemetry` section promises the pack does not do.
    //
    // Timestamps stay: an install date and a last-run date are what make "installed,
    // never ran" distinguishable from "ran once and stopped", which is the whole
    // question the report exists to answer.
    for (const k of ['schema_version', 'installed_at', 'first_run_at', 'first_run_mode',
      'second_run_at', 'last_run_at', 'runs', 'dry_runs', 'paid_runs']) {
      if (activation[k] === undefined || activation[k] === null) continue;
      const v = activation[k];
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        lines.push(`${k}: ${v}`);
      }
    }
  }
  const problems = findings.filter(f => f.level === STOP || f.level === WARN);
  if (problems.length) {
    lines.push('', '-- findings --');
    for (const f of problems) lines.push(`[${f.level}] ${f.title}`);
  }
  lines.push('```');
  lines.push('');
  lines.push('No list data, no file paths and no API key are in the block above. '
    + 'Paste it into an issue: https://github.com/richapiai/gtm-skills/issues');
  return lines.join('\n');
}

/**
 * Read the local activation counters. Never throws.
 *
 * They live in the INSTALL-SCOPED state dir (`~/.richapi-skills`), NOT in the `gtm/`
 * tree — `_lib/activation.mjs:activationPath()` defaults to `ledger.stateDir()`, and
 * that is where `createActivationRecorder()` writes on every run. This function first
 * read `<gtm>/activation.json`, which is never written, so `doctor --report` silently
 * carried no counters at all and the one signal the report exists to surface was
 * always absent. Caught by /review 2026-09-02.
 *
 * `dir` is accepted as an override so a test can point at a temporary tree.
 */
export function readActivation (dir = null) {
  try {
    const p = dir
      ? path.join(dir, ACTIVATION_FILE)
      : activationPath();
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Run the preflight and return its stdout. Never throws; a failure reads as no keys. */
export function runPreflight (preflightPath, env = process.env, args = []) {
  const r = spawnSync(preflightPath, args, { encoding: 'utf8', env });
  return r.stdout ?? '';
}

export default { parsePreflight, diagnose, overall, render, renderReport, readActivation, runPreflight, OK, WARN, STOP, UNKNOWN };
