#!/usr/bin/env node
// bin/richapi.mjs — the $R CLI. Installs as the `richapi` command.
//
// One command that runs the waterfall end to end with a
// dry-run plan, a ledger write, a journal line, and a resume. Everything it does is
// composition; the logic lives in _lib/.
//
// Law 3 in practice: `enrich` costs the run and shows the plan BEFORE it spends
// anything, and `--dry-run` is free and makes zero calls.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hasApiFailure } from '../_lib/journal.mjs';
import { UnsafeOrigin } from '../_lib/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USAGE = `
richapi — GTM waterfall runtime

Usage
  richapi enrich <list.csv|list.jsonl> [options]
  richapi enrich <list.csv> --explain-my-list      (free: is any of this worth buying?)
  richapi call <endpoint> [options]
  richapi search <endpoint> [options]
  richapi preflight
  richapi doctor [--report]
  richapi catalog list [--live]                    (free: what can I call, and what does it cost?)
  richapi catalog gen|diff [-- <args>]
  richapi gates [<dotted.key>]
  richapi help

call — one catalog endpoint over a list of rows (or a single ad-hoc call).
       Everything 'enrich' gets, for every other skill: a dry-run plan, the gates
       evaluated on the PLAN, a journal line before and after each call, a ledger
       line per call, the read-through cache, resume, and auto-batching.

  richapi call <endpoint> --in <list.csv> --out <enriched.csv> --dry-run
  richapi call email_verifier --param email=a@b.com --budget 50 --yes

  --in <file>            Input rows (.csv or .jsonl). Omit for one call from --param.
  --param k=v            Request parameter, repeatable. Merged into every row.
                         'k:=<json>' sends raw JSON instead of a string.
  --field <name>         Extra input column allowed into the request body, repeatable.
                         Only required fields and named params are sent otherwise.
  --batch                Use the catalog's bulk variant where one exists and the
                         callable (uncached) rows carry the identifier it takes.
  --no-batch             Never use a bulk variant, even where every row qualifies.
  --expect <n>           Results per call, for pricing a per-result endpoint.

search — one endpoint across N pages. Every page is priced and page-gated on the plan.

  richapi search people_search --param title=CTO --pages 3 --dry-run

  --param k=v            Search parameters, repeatable (same forms as call).
  --pages <n>            Pages to plan. Default 1: extra pages are opted into.
  --start-page <n>       First page number. Default 1 (people_search counts from 0).
  --page-size <n>        Results per page. Default: gates.yaml:unbounded_endpoints.assumed_results_per_page
  --all-pages            Buy every planned page even after one comes back short.

Options shared by call and search
  --dry-run --out --resume --budget --no-cache --yes --json --dir

enrich options
  --dry-run              Plan only. Makes ZERO calls and spends nothing.
  --out <file>           Write the enriched list (.csv or .jsonl).
  --resume <run-id>      Continue a killed run; pays only for unfinished rows.
  --budget <credits>     Session credit budget. Asked once if omitted; REQUIRED with --yes.
  --phone                Include phone_finder. Its price is read from the catalog and
                         shown in the plan — it always confirms.
  --no-verify            Skip the email_verifier hop.
  --no-cache             Ignore the read-through cache and re-pay for everything.
  --batch                Use bulk endpoints where possible. OFF by default: the bulk
                         response shape is unverified, so attribution is positional.
  --yes                  Approve the plan without prompting (for scripts). Needs --budget.
  --json                 Machine-readable result on stdout.

Exit codes
  0 ran (or planned)   2 usage / input      3 blocked by a gate
  4 no API key         5 suppression store unreadable
  6 another run holds this list        7 plan not approved
  8 ran, but the API failed one or more units (e.g. http_503 after retries);
    nothing was charged for them and --resume retries exactly those
  --dir <gtm>            State tree location (default: gtm).

Cost is read from the generated catalog, never typed. See _lib/gates.yaml for
every threshold; no number in this CLI is hard-coded.
`.trimStart();

/**
 * Does this answer approve the spend?
 *
 * Typing the exact total is the whole gate: "y", "yes" and a stray newline must not
 * spend money, and a near-miss like "160" for a 16-credit plan must not either. This
 * is the last thing between a user and an unintended charge, so it is exported and
 * tested rather than living inline in a prompt callback.
 */
export function confirmAccepted (answer, total) {
  if (answer === null || answer === undefined) return false;
  const a = String(answer).trim().replace(/,/g, '');
  if (a === '') return false;
  return a === String(total);
}

// A flag that takes the NEXT argv when it is not written as --flag=value. A boolean
// flag must never swallow a positional.
const NEEDS_VALUE = [
  'out', 'resume', 'budget', 'dir',
  // `call` / `search`
  'in', 'param', 'field', 'pages', 'start_page', 'page_size', 'expect',
  // `--explain-my-list`. A value-taking flag missing from this list does NOT error —
  // it silently becomes `true` and its value falls through to the positionals, so
  // `--max-rows 2` read as `Number(true)` === 1 and analysed one row while reporting a
  // cap of two. Any new flag that takes a value belongs here.
  'max_rows',
];
// Repeatable flags collect into an array. `--param` is the whole reason: a request body
// has more than one field, and the last-one-wins overwrite silently dropped the rest.
const REPEATABLE = ['param', 'field'];

/**
 * Every flag any command accepts.
 *
 * WHY THIS EXISTS. An unknown flag used to be accepted silently and ignored, which is a
 * money bug, not a tidiness one: `richapi enrich list.csv --dryrun --yes --budget 50`
 * reads as a REAL run, because `--dryrun` is not `--dry-run` and nothing said so. The
 * budget caps the damage; it does not prevent it. A typo must not be the difference
 * between pricing a run and paying for it.
 *
 * Keys are the normalised form parseArgs produces (hyphens become underscores).
 * `tests/regression/unknown-flags.test.mjs` re-derives this list from the source and
 * fails when a flag the code reads is missing here, so the guard cannot rot into a
 * denylist of yesterday's flags.
 */
export const KNOWN_FLAGS = new Set([
  // planning and approval
  'dry_run', 'yes', 'budget', 'json', 'help',
  // io and workspace
  'out', 'in', 'dir', 'resume',
  // request shaping
  'param', 'field', 'expect', 'pages', 'page_size', 'start_page', 'all_pages',
  // waterfall and runtime
  'phone', 'no_verify', 'batch', 'no_batch', 'no_cache', 'max_rows', 'explain_my_list',
  // doctor
  'report', 'no_color',
  // catalog list
  'live',
  // version
  'version',
]);

/** The first unknown flag, or null. Reported one at a time: a user fixes one typo. */
export function unknownFlag (flags) {
  for (const k of Object.keys(flags)) if (!KNOWN_FLAGS.has(k)) return k;
  return null;
}

/** `--dryrun` -> `--dry-run`. One edit distance, so only a real typo matches. */
export function suggestFlag (name) {
  const known = [...KNOWN_FLAGS];
  const squash = (x) => x.replace(/_/g, '');
  const hit = known.find((k) => squash(k) === squash(name));
  return hit ? `--${hit.replace(/_/g, '-')}` : null;
}

export function parseArgs (argv) {
  const out = { _: [], flags: {} };
  const set = (key, value) => {
    if (!REPEATABLE.includes(key)) { out.flags[key] = value; return; }
    (out.flags[key] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inline = eq === -1 ? undefined : a.slice(eq + 1);
      const key = k.replace(/-/g, '_');
      // `--param k=v` splits on the FIRST `=` only, so `k:={"a":1}` and a value that
      // itself contains `=` both survive.
      if (inline !== undefined) set(key, inline);
      else if (NEEDS_VALUE.includes(key)) { set(key, argv[i + 1]); i += 1; }
      else set(key, true);
    } else out._.push(a);
  }
  return out;
}

/**
 * `--param` values into a request body.
 *
 *   k=v      a string (numeric-looking values become numbers, "true"/"false" booleans)
 *   k:=json  parsed as JSON, for a list or a nested filter object
 *
 * Coercion matters: `limit` and `page` are numbers in every search endpoint, and
 * sending them as strings is a 400 the user pays nothing for but cannot explain.
 */
export function parseParams (list) {
  const out = {};
  for (const raw of list ?? []) {
    if (raw === true || raw === undefined) throw new Error('--param needs a key=value');
    const s = String(raw);
    const jsonAt = s.indexOf(':=');
    if (jsonAt > 0) {
      const key = s.slice(0, jsonAt);
      try { out[key] = JSON.parse(s.slice(jsonAt + 2)); } catch (e) {
        throw new Error(`--param ${key}:= is not valid JSON (${e.message})`);
      }
      continue;
    }
    const eq = s.indexOf('=');
    if (eq < 1) throw new Error(`--param "${s}" is not key=value`);
    const key = s.slice(0, eq);
    const value = s.slice(eq + 1);
    if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
    else if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else out[key] = value;
  }
  return out;
}

function fail (msg, code = 1) {
  process.stderr.write(`richapi: ${msg}\n`);
  process.exit(code);
}

/** The pack's own version, read from VERSION. Never typed into a doc or a skill. */
function packVersion () {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); }
  catch { return 'unknown'; }
}

/**
 * `richapi doctor` — the preflight, in English, with the fix.
 *
 * Makes ZERO network calls and spends ZERO credits: it reads the preflight's own output
 * and the local state tree. Exit codes are scriptable and mirror the pack's convention —
 * 0 healthy or merely warned, 3 blocked, so a wrapper can tell "usable" from "stop".
 */
async function cmdDoctor (argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')).map(a => a.slice(2)));
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : './gtm';
  const doctor = await import('../_lib/doctor.mjs');

  const stdout = doctor.runPreflight(path.join(ROOT, 'bin', 'richapi-skills-preflight'), process.env, ['--dir', dir]);
  const keys = doctor.parsePreflight(stdout);
  const stateTreeExists = fs.existsSync(dir) ? true : false;
  const findings = doctor.diagnose(keys, { stateTreeExists });
  const verdict = doctor.overall(findings);

  if (flags.has('report')) {
    process.stdout.write(`${doctor.renderReport(keys, findings, {
      version: packVersion(),
      // No argument: the counters live in the install-scoped state dir, not in gtm/.
      activation: doctor.readActivation(),
    })}\n`);
  } else {
    // `--report` output is pasted into issues, so it is NEVER styled. The human-facing
    // render opts in, and tty.js suppresses it on a pipe, under NO_COLOR, or with
    // --no-color.
    const { colorEnabled } = await import('../_lib/tty.mjs');
    const color = !flags.has('no-color') && colorEnabled(process.stdout);
    process.stdout.write(`${doctor.render(findings, { version: packVersion(), verdict, color })}\n`);
  }
  process.exit(verdict === doctor.STOP ? 3 : 0);
}

function delegate (script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------

async function cmdEnrich (argv) {
  const { _, flags } = parseArgs(argv);
  const input = _[0];
  if (!input) fail('enrich needs an input list.\n\n' + USAGE, 2);

  // --explain-my-list: the free, zero-call read of the list itself. Handled before
  // anything else because it needs no key, no budget and no plan — and because the
  // question it answers ("is any of this worth paying for?") comes before the price.
  if (flags.explain_my_list) {
    const { explainList, renderExplain, DEFAULT_MAX_ROWS } = await import('../_lib/explain.mjs');
    const { loadSuppressionStore } = await import('../_lib/suppression.mjs');
    const { loadCache } = await import('../_lib/enrich.mjs');
    const dir = flags.dir ?? 'gtm';
    const root = process.cwd();
    let store;
    try {
      store = loadSuppressionStore({ root, path: path.resolve(root, dir, 'suppression.jsonl') });
    } catch (err) {
      // Same fail-closed rule as a real run: a list cannot be judged safe to enrich
      // when the do-not-contact store cannot be read, and this command reports on
      // suppression, so a missing store would understate it.
      fail(`suppression store unreadable — failing closed, nothing analysed.\n  ${err.message}`, 5);
    }
    const maxRows = flags.max_rows !== undefined ? Number(flags.max_rows) : DEFAULT_MAX_ROWS;
    if (!Number.isFinite(maxRows) || maxRows < 1) fail('--max-rows must be a positive number', 2);
    const result = explainList(input, { store, cache: loadCache({ dir: path.resolve(root, dir) }), maxRows });
    process.stdout.write(`${renderExplain(result, { file: input })}\n`);
    process.exit(0);
  }

  const { runEnrich, EnrichError, MissingApiKey } = await import('../_lib/enrich.mjs');
  await loadReceiptRenderer();
  const { renderPlanText } = await import('../_lib/dryrun.mjs');

  const dryRun = Boolean(flags.dry_run);
  const budget = flags.budget !== undefined ? Number(flags.budget) : null;
  if (budget !== null && !Number.isFinite(budget)) fail('--budget must be a number', 2);

  // `--yes` with no `--budget` was an UNCAPPED run, and it is the documented
  // scripted path. The chain: createSession leaves budget_credits null ->
  // budgetPrompt returns CONFIRM (not STOP) -> `if (flags.yes) return true`
  // accepts it -> run.mjs checkBudget returns null for a null budget, so the
  // ceiling disables itself. Every fraction gate in gates.yaml fires on a
  // fraction OF THE BUDGET, so with no budget there is nothing to take a
  // fraction of and the only spend control in the pack is silently absent.
  // Interactively this is fine: the prompt asks and a human answers. Unattended
  // there is nobody to ask, so refuse rather than run without a ceiling.
  if (!dryRun && flags.yes && budget === null) {
    fail('--yes requires --budget. Unattended runs must name a credit ceiling: '
      + 'every gate fires on a fraction of it, so without one the run is uncapped. '
      + 'Use --dry-run to price it first (that spends nothing).', 2);
  }

  const confirm = async ({ plan, gate }) => {
    if (flags.yes) return true;
    if (!process.stdin.isTTY) {
      process.stderr.write('richapi: plan needs approval but stdin is not a TTY. Re-run with --yes, or --dry-run first.\n');
      return false;
    }
    process.stdout.write(renderPlanText(plan) + '\n');
    for (const c of gate.confirms) process.stdout.write(`  ! ${c.gate}: ${c.reason}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const total = plan.totals.credits_estimated;
    const ceiling = plan.totals.estimate_is_ceiling ? ' (ceiling — conditional hops may not fire)' : '';
    const answer = await rl.question(`\nSpend up to ${total} credits${ceiling}? Type the number to confirm: `);
    rl.close();
    return confirmAccepted(answer, total);
  };

  try {
    const res = await runEnrich({
      input,
      output: flags.out ?? null,
      dir: flags.dir ?? 'gtm',
      root: process.cwd(),
      dryRun,
      resume: flags.resume ?? null,
      phone: Boolean(flags.phone),
      verify: !flags.no_verify,
      noCache: Boolean(flags.no_cache),
      batch: Boolean(flags.batch),
      budget,
      confirm,
    });

    if (flags.json) {
      const { text, ...rest } = res;
      process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
    } else {
      process.stdout.write(report(res) + '\n');
    }
    // Distinct codes so a script can tell these apart. `declined` exiting 0 meant a
    // run that refused to spend looked identical to one that enriched everything.
    process.exit(exitCodeFor(res));
  } catch (err) {
    if (err instanceof MissingApiKey) fail(`${err.message}`, 4);
    if (err?.name === 'SuppressionUnavailableError') {
      fail(`suppression store unreadable — failing closed, no call made.\n  ${err.message}\n  Fix: run \`richapi-setup\` (installed from npm) or \`./setup\` (from a checkout).`, 5);
    }
    if (err?.name === 'ConcurrentRunError') fail(err.message, 6);
    if (err instanceof EnrichError || err?.name === 'PlanContractError') fail(err.message, 2);
    throw err;
  }
}

/**
 * The scriptable exit code for a finished command. A run whose API calls failed used
 * to exit 0 with no error text — indistinguishable from success.
 */
export function exitCodeFor (res) {
  const EXIT = { blocked: 3, declined: 7 };
  if (EXIT[res?.mode]) return EXIT[res.mode];
  return hasApiFailure(res?.failures) ? 8 : 0;
}

let renderReceiptText = () => '';
export async function loadReceiptRenderer () {
  const m = await import('../_lib/receipt.mjs');
  renderReceiptText = (r) => m.renderReceipt(r, { upgradeUrl: 'https://richapi.ai/pricing' });
}

function report (res) {
  const L = [];
  const p = res.plan;
  L.push(`run ${res.run_id}  (${res.mode})`);
  L.push('');

  if (res.mode === 'dry-run') {
    L.push(res.text);
    L.push('');
    if (res.cache?.enabled && res.plan.totals.skipped_cache > 0) {
      L.push(`${res.plan.totals.skipped_cache} hop(s) already cached — shown above as skipped, not charged.`);
    }
    L.push(`ZERO calls made. Journal: ${res.journal_path}`);
    L.push(`  ${res.pending_written} units planned, ${res.skipped_written} written terminal (suppressed or cached).`);
  } else if (res.mode === 'blocked') {
    L.push('BLOCKED before any call:');
    for (const r of res.reasons) L.push(`  - ${r}`);
  } else if (res.mode === 'declined') {
    L.push('Plan not approved. Nothing was spent.');
  } else {
    const e = res.exec;
    // http_calls is the authoritative count: units rejected before HTTP (a verifier
    // hop with no email to verify) never reach the wire, so `calls_made` counts them
    // as attempts while the transport counter does not.
    L.push(`http calls      ${res.http_calls ?? '?'}`);
    L.push(`units attempted ${e.attempted ?? e.calls_made}   (ok ${e.ok}, failed ${e.failed}, retries ${e.retries})`);
    L.push(`skipped         cache ${e.skipped_cache}, suppressed ${e.skipped_suppressed}, budget ${e.skipped_budget}`);
    for (const f of Object.entries(res.failures ?? {})) L.push(`FAILED          ${f[1]} unit(s): ${f[0]}`);
    // Units that never reached the wire: a verify hop with no email to verify is a
    // SKIP, not a failure, and was reported as `FAILED 1: input_insufficient`.
    for (const f of Object.entries(res.skipped_units ?? {})) {
      L.push(`SKIPPED         ${f[1]} unit(s): ${f[0]}  — never reached the API, never charged.`);
    }
    if (e.aborted) L.push(`ABORTED: ${e.abort_reason}${e.balance !== null ? ` (balance ${e.balance})` : ''}`);
    const t = res.ledger_totals ?? {};
    L.push('');
    L.push(`credits verified  ${t.credits_actual ?? 0}   (${t.verified_lines ?? 0} call(s) whose charge the response confirmed)`);
    if (t.unverifiable_lines) {
      L.push(`credits estimated ${t.credits_estimated_unverifiable ?? 0}   (${t.unverifiable_lines} call(s) UNVERIFIABLE — the response carries no billing field)`);
    }
    L.push(`ledger total      ${t.ledger_total ?? 0}`);
    const c = res.cache;
    if (c) {
      L.push(c.enabled
        ? `cache             ${c.hits ?? 0} hit, ${c.writes ?? 0} written, ${c.expired ?? 0} expired  (TTLs from ${c.ttl_source ?? 'defaults'})`
        : 'cache             disabled (--no-cache): everything was re-paid');
    }
    L.push(`journal  ${res.journal_path}`);
    L.push(`ledger   ${res.ledger_path}`);
    if (res.output) {
      L.push(`output   ${res.output.file}  (${res.output.written} rows, ${res.output.suppressed} suppressed)`);
      if (res.output.unmapped_rows) {
        L.push(`unmapped_rows: ${res.output.unmapped_rows}  (no response map — the raw body is in \`response\` / CSV \`response_json\`, response_mapped: false)`);
      }
    }
    if (res.resume) {
      const s = res.resume.stats;
      L.push('');
      L.push(`resumed: ${s.units_done} units already done, ${s.units_todo} paid for this time`);
      if (s.suspect_max_double_charge_rows > 0) {
        L.push(`  note: at most ${s.suspect_max_double_charge_rows} row(s) may have been charged twice (killed mid-call)`);
      }
    }
  }

  if (res.receipt) {
    L.push('');
    L.push('--- receipt ---');
    L.push(renderReceiptText(res.receipt));
  }

  // Notes the run collected — including the server's own explanation of a refusal,
  // which used to reach the terminal as the bare token `http_422`.
  for (const n of res.batch_notes ?? []) L.push(`  ! ${n}`);

  const skips = res.skip_reasons ?? {};
  if (Object.keys(skips).length) {
    L.push('');
    L.push('hops not attempted:');
    for (const [ep, reasons] of Object.entries(skips)) {
      for (const [reason, n] of Object.entries(reasons)) L.push(`  ${ep.padEnd(16)} ${String(n).padStart(5)}  ${reason}`);
    }
  }
  if (p?.totals?.credits_unknown_calls) {
    L.push('');
    L.push(`${p.totals.credits_unknown_calls} call(s) have no known cost in the catalog and were not priced.`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// `call` and `search` — the gated surface every skill that is not
// /enrich-waterfall has to use. Thin: every decision is in _lib/run.mjs.
// ---------------------------------------------------------------------------

async function cmdRun (kind, argv) {
  const { _, flags } = parseArgs(argv);
  const endpoint = _[0];
  if (!endpoint) fail(`${kind} needs an endpoint name. See \`richapi help\`.`, 2);

  const run = await import('../_lib/run.mjs');
  const { renderPlanText } = await import('../_lib/dryrun.mjs');
  await loadReceiptRenderer();

  let params;
  try { params = parseParams(flags.param); } catch (e) { fail(e.message, 2); }

  const budget = flags.budget !== undefined ? Number(flags.budget) : null;
  if (budget !== null && !Number.isFinite(budget)) fail('--budget must be a number', 2);
  const numeric = (name, v) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`--${name.replace(/_/g, '-')} must be a number`, 2);
    return n;
  };

  const confirm = async ({ plan, gate, batch }) => {
    if (flags.yes) return true;
    if (!process.stdin.isTTY) {
      process.stderr.write('richapi: plan needs approval but stdin is not a TTY. Re-run with --yes, or --dry-run first.\n');
      return false;
    }
    process.stdout.write(renderPlanText(plan) + '\n');
    const b = run.renderBatch(batch);
    if (b) process.stdout.write(`  ${b}\n`);
    for (const c of gate.confirms) process.stdout.write(`  ! ${c.gate}: ${c.reason}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const total = plan.totals.credits_estimated;
    const ceiling = plan.totals.estimate_is_ceiling ? ' (ceiling — conditional calls may not fire)' : '';
    const answer = await rl.question(`\nSpend up to ${total} credits${ceiling}? Type the number to confirm: `);
    rl.close();
    return confirmAccepted(answer, total);
  };

  const common = {
    endpoint,
    params,
    output: flags.out ?? null,
    dir: flags.dir ?? 'gtm',
    root: process.cwd(),
    dryRun: Boolean(flags.dry_run),
    noCache: Boolean(flags.no_cache),
    resume: flags.resume ?? null,
    budget,
    confirm,
  };

  try {
    const res = kind === 'search'
      ? await run.runSearch({
        ...common,
        pages: numeric('pages', flags.pages) ?? 1,
        startPage: numeric('start_page', flags.start_page) ?? 1,
        pageSize: numeric('page_size', flags.page_size) ?? null,
        stopOnShortPage: !flags.all_pages,
      })
      : await run.runCall({
        ...common,
        input: flags.in ?? null,
        fields: Array.isArray(flags.field) ? flags.field : [],
        expectedResults: numeric('expect', flags.expect) ?? null,
        // Batching is decided by the catalog, the rows and gates.yaml. --no-batch is
        // the only override, and it can only ever make the run more conservative.
        // --no-batch wins over --batch: an override may only ever make a run more
        // conservative. Neither flag can batch rows the catalog or the identifiers
        // refuse — `planBatching` still decides, over the CALLABLE (uncached) rows.
        ...(flags.no_batch ? { gates: await batchGates(false) }
          : flags.batch ? { gates: await batchGates(true) }
          : {}),
      });

    if (flags.json) {
      const { text, ...rest } = res;
      process.stdout.write(JSON.stringify(rest, null, 2) + '\n');
    } else {
      process.stdout.write(run.renderRunText(res, { renderReceiptText }) + '\n');
    }
    process.exit(exitCodeFor(res));
  } catch (err) {
    if (err?.name === 'MissingApiKey') fail(err.message, 4);
    if (err?.name === 'MissingGateKey') {
      fail(`${err.message}\n  A missing gate key is a STOP, not "no gate" (law 5). Nothing was called.`, 3);
    }
    if (err?.name === 'SuppressionUnavailableError') {
      fail(`suppression store unreadable — failing closed, no call made.\n  ${err.message}\n  Fix: run \`richapi-setup\` (installed from npm) or \`./setup\` (from a checkout).`, 5);
    }
    if (err?.name === 'ConcurrentRunError') fail(err.message, 6);
    if (err?.name === 'PlanContractError' && /disabled_by_default/.test(err.message)) fail(err.message, 3);
    if (err?.name === 'PlanContractError' || err?.name === 'RunError' || err?.name === 'EnrichError') fail(err.message, 2);
    throw err;
  }
}

/**
 * `--batch` / `--no-batch`: the gate key that enables auto-batching, forced for this run.
 *
 * `richapi call --batch` used to be silently inert — the flag parsed, nothing read it,
 * and the run fell back to gates.yaml (which fails closed to single calls). A user who
 * asked for batching got 500 single calls and no explanation.
 */
async function batchGates (auto) {
  const { loadGates } = await import('../_lib/gates.mjs');
  const g = loadGates();
  if (!g || g.__unloadable) return g;
  return { ...g, runtime: { ...(g.runtime ?? {}), batch: { ...(g.runtime?.batch ?? {}), auto } } };
}

async function cmdGates (argv) {
  const { _ } = parseArgs(argv);
  const { loadGates, gateValue, gateKeys } = await import('../_lib/gates.mjs');
  const gates = loadGates();
  if (_[0]) {
    process.stdout.write(JSON.stringify(gateValue(gates, _[0]), null, 2) + '\n');
    return;
  }
  for (const k of gateKeys(gates)) {
    process.stdout.write(`${k} = ${JSON.stringify(gateValue(gates, k))}\n`);
  }
}

// ---------------------------------------------------------------------------

// Only dispatch when this file IS the entry point. Importing it (to test parseArgs
// and the spend-confirmation rule) must not run a command.
//
// The comparison must go through realpath, and that is not a detail.
//
// `npm install` puts every `bin` entry on PATH as a SYMLINK
// (…/bin/richapi -> …/lib/node_modules/@richapi/gtm-skills/bin/richapi.mjs). Node
// resolves symlinks for the entry point, so `import.meta.url` is the real file while
// `process.argv[1]` is still the symlink. `path.resolve` normalises a path but does
// NOT follow symlinks, so the two never matched, `invokedDirectly` was false, and the
// INSTALLED `richapi` command parsed nothing, printed nothing and exited 0 — a silent
// no-op, which is worse than a crash because it looks like success.
//
// This never surfaced before because the file used to be extensionless and died in
// the module loader long before reaching this line.
const entryPoint = (() => {
  if (!process.argv[1]) return null;
  const abs = path.resolve(process.argv[1]);
  try { return fs.realpathSync(abs); } catch { return abs; }
})();
const invokedDirectly = entryPoint
  && fs.realpathSync(fileURLToPath(import.meta.url)) === entryPoint;

const [cmd, ...rest] = invokedDirectly ? process.argv.slice(2) : ['__noop__'];

// `--help` PRINTS AND EXITS, whatever the subcommand and wherever it appears.
//
// `richapi search people_search --help` used to be parsed as a real run: `help` is not
// a value-taking flag, so it became `flags.help = true`, the endpoint positional stood,
// and the command planned a search — which was then DECLINED for want of a prompt. A
// help request must never reach a planner, let alone a confirmation.
const helpArgs = rest.slice(0, rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--'));
if (invokedDirectly && cmd !== 'help' && helpArgs.some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
// An unknown flag is a REFUSAL, not something to ignore. See KNOWN_FLAGS.
if (invokedDirectly && cmd !== undefined && !['help', '--help', '-h'].includes(cmd)) {
  const bad = unknownFlag(parseArgs(rest).flags);
  if (bad) {
    const hint = suggestFlag(bad);
    fail(`unknown flag "--${bad.replace(/_/g, '-')}"${hint ? `. Did you mean ${hint}?` : ''}\n\n`
      + 'Nothing was planned and nothing was called.', 2);
  }
}

// A REFUSED ORIGIN IS A REFUSAL, NOT A CRASH.
//
// _lib/client.mjs deliberately does not catch UnsafeOrigin — a security control that
// swallows its own refusal is not a control. But reaching the user as an uncaught
// exception meant the carefully-worded message ("Nothing was sent. There is NO
// fallback") arrived buried under a stack trace, below a `throw` line and above six
// frames of internal paths. Those paths also carry the user's home directory into
// anything they paste into an issue. Catching it HERE changes presentation only: the
// call still never happens, and the key still never leaves the machine.
if (!invokedDirectly) { /* imported for tests */ } else
try {

switch (cmd) {
  case 'enrich':
    await cmdEnrich(rest);
    break;
  case 'call':
    await cmdRun('call', rest);
    break;
  case 'search':
    await cmdRun('search', rest);
    break;
  case 'preflight': {
    const r = spawnSync(path.join(ROOT, 'bin', 'richapi-skills-preflight'), rest, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
    break;
  }
  case 'doctor':
    await cmdDoctor(rest);
    break;
  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(`${packVersion()}\n`);
    break;
  case 'catalog': {
    const sub = rest[0];
    if (sub === 'gen') delegate('bin/richapi-catalog-gen.mjs', rest.slice(1));
    else if (sub === 'diff') delegate('bin/richapi-catalog-diff.mjs', rest.slice(1));
    else if (sub === 'list') {
      // The only user-facing catalog verb. `gen` and `diff` are maintainer tools; until
      // this existed a user had no way to see what the pack can call or what it costs.
      const cl = await import('../_lib/catalog-list.mjs');
      const { colorEnabled, style } = await import('../_lib/tty.mjs');
      const wantLive = rest.includes('--live');
      const rows = cl.loadLocal();
      const live = wantLive ? await cl.fetchLive() : { names: null, error: null };
      process.stdout.write(`${cl.render(rows, {
        live: live.names,
        liveError: live.error,
        color: !rest.includes('--no-color') && colorEnabled(process.stdout),
        style,
      })}\n`);
    }
    else fail(`unknown catalog subcommand "${sub ?? ''}" (want: list | gen | diff)`, 2);
    break;
  }
  case 'gates':
    await cmdGates(rest);
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    process.stdout.write(USAGE);
    break;
  default:
    fail(`unknown command "${cmd}"\n\n${USAGE}`, 2);
}

} catch (e) {
  if (e instanceof UnsafeOrigin) fail(e.message, 2);
  throw e;
}
