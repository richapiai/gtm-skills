---
name: gtm-retro
version: 1.0.0
description: >
  A retrospective across many runs and campaign arms, ending in decisions: stop this
  play, keep that one, scale the third. Groups runs by the journal's hashed list key,
  compares arms on coverage and on credits-per-outcome as ranges, and refuses to
  declare a winner whose range overlaps the loser's. Use when asked "what should we
  stop doing", "which campaign is working", "retro on last quarter", "compare these
  two plays", or "where is the budget going". Reads the ledger, the run journals and
  the activation store; makes zero API calls and spends nothing. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - what should we stop doing
  - which campaign is working
  - retro on last month
  - retro on last quarter
  - compare these two plays
  - where is the budget going
  - gtm retrospective
---

# Retro across runs, and end on a decision

You are the person who has to say "we are not doing that again" out loud, with the
arithmetic behind it. A retro that ends in a chart is not a retro; it is a second
report. This one ends in a short list of decisions, each one carrying the sample it
rests on and the reason it could be wrong.

Two rules outrank everything else on this page, and both of them cost you a cleaner
story:

1. **A range stays a range, and a comparison between two ranges usually has no
   winner.** Most metered endpoints never report their charge, so most arms in this
   report have a spend floor and a spend ceiling rather than a spend. Two arms whose
   cost-per-outcome ranges overlap are *not separable*, and this skill says so instead
   of picking whichever midpoint reads better.
2. **Rows are never deduplicated across runs.** The journal's unit key is
   `(row_id, hop)` and it is unique *within a run only*. Folding two journals together
   at the row level silently merges rows that are not the same row and hands you a
   confident wrong denominator. So this skill sums row-attempts per run and labels the
   total as attempts, never as people.

## Why this skill exists next to `/measure` and `/learn`

Three skills read the same journals, and the honest question is whether the third one
earns its page. It does, and the line is sharp:

| | Unit of analysis | Output | Can it change what a future run costs? |
|---|---|---|---|
| [`/measure`](../measure/SKILL.md) | **one run** | a report | no |
| [`/learn`](../learn/SKILL.md) | **one hop**, across runs | an ordering inside an already-approved plan | no, by design |
| **this skill** | **one arm**, across runs and time | a decision | **yes — that is the point** |

Read down the third column. `/measure` deliberately refuses to roll up more than one
run, and says why: the row key is not unique across runs. `/learn` deliberately cannot
add, drop or substitute a hop, because a learning that changes a plan's cost is a paid
call nobody named. Both of those refusals are correct, and between them they leave the
campaign-level question unanswered: *which of the things we have been doing should we
stop paying for?* Nothing in the pack answers it, and it is the only question whose
answer actually moves the bill.

Three things make that safe to attempt here and unsafe in the other two:

- **The grouping key already exists and is not `row_id`.** `_lib/journal.mjs` hashes
  `list_key` to a fixed-width hex token before it is written, so it is a stable,
  non-identifying handle for *the same list across runs*. Neither `/measure` nor
  `/learn` reads it. Grouping on it is the cross-run join the row key cannot support,
  and it is aggregate-safe by construction rather than by filtering.
- **Money is per-run and then added, never recomputed.** One receipt per run, each one
  put through the pack's own never-overstate guard, then floors added to floors and
  ceilings to ceilings. There is still exactly one cost calculation in the pack.
- **A decision is gated on sample size and on range separation**, so the usual answer
  is "not separable yet, and here is how many more rows would separate it". A retro
  that always produces a verdict is a retro that is guessing.

If your question is about one run, use `/measure`. If it is "which provider should the
waterfall try first", use `/learn` — this skill will not re-rank a hop. If it is "which
of these two plays deserves next month's budget", it is this one.

### What it reuses rather than recomputing

| Question | Answered by | Never |
|---|---|---|
| What did run R cost? | `_lib/ledger.mjs` → `Ledger.totals` | a second cost calculation |
| Is that figure provable? | `_lib/receipt.mjs` → `buildReceipt`, `spendPhrase` | rounding a range into a number |
| Did the retro overstate? | `_lib/receipt.mjs` → `assertNeverOverstates` | catching that error |
| Coverage and hit rates for run R | `_lib/share-render.mjs` → `renderShareable` | reading contact rows |
| Is the output safe to forward? | `_lib/share-render.mjs` → `assertAggregateOnly` | filtering a row-level render |
| Are we activating at all? | `_lib/activation.mjs` → `localCohort`, `evaluateBands`, `renderActivation` | inventing a verdict |
| Coverage floor | `_lib/gates.mjs` → `checkCoverage` | typing a percentage |

The only arithmetic this skill owns is the part nothing else does: adding per-run
floors and ceilings, dividing each by a self-reported outcome count, and testing
whether two intervals overlap.

## Inference mode — local

Local inference only. **Zero API calls**, metered or otherwise, and `ai_enrich` is
never called. This skill owns no endpoints in `_lib/endpoint-owners.yaml` and that is
deliberate. Everything it reports is arithmetic over files the pack already wrote, and
the narrative around that arithmetic is written by the agent this pack already runs
inside, for free. Neither reason to buy the LLM hop applies: **Perplexity web
grounding** answers questions that have no endpoint behind them, and every number here
came from a local file with a name; **batch scale** does not arise because a retro
reads a handful of run summaries, not a corpus. Paying an endpoint for an opinion about
your own ledger is the silliest credit in the pack, and it would be the second silliest
if `/measure` had not already refused it.

## Before anything else

```bash
richapi-skills-preflight
```

None of the keys can block this skill, and it is worth saying why rather than skipping
the step. `API_KEY_SET: no` is fine — nothing here calls the API. `BALANCE: unknown` is
expected and is reported as unknown, never inferred. `SUPPRESSION: STOP` does not block
a retro either, but it does mean some of the runs being compared may not have been
filtered, so say that in the summary rather than presenting their coverage as clean.

There is **no `richapi retro` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. A retro is local work over state the pack already
has, so it is the script below and nothing else. Do not tell the user to run a command
that does not exist.

## Step 1 — choose the window and the arms

Two decisions, both made out loud before the script runs.

**The window.** How far back the retro reads. The bound is
`gates.yaml:skills.gtm_retro.retro_max_window_days`, read from the gate file and never
typed here. Three more keys bound the decision half:
`gates.yaml:skills.gtm_retro.min_runs_to_compare` (below it a comparison is an anecdote),
`gates.yaml:skills.gtm_retro.min_rows_per_arm_to_decide` (below it a verdict is noise in
the costume of signal) and `gates.yaml:skills.gtm_retro.max_decisions` (a retro handing
back thirty decisions has handed back none). If any of the four stops resolving, the
decision half of this skill does not run at all and says so — describing what happened
needs no key, deciding does.

**The arms.** An *arm* is the thing being compared: a play, a segment, a list, a
quarter. The pack cannot see a campaign — there is no campaign field anywhere in the
journal — so an arm is formed one of two ways:

- **From the hashed list key.** Runs that enriched the same list carry the same
  `list_key`, hashed by `_lib/journal.mjs` before it reaches disk. This is the default,
  it needs no input from the operator, and it is the only grouping the pack can
  actually observe.
- **From an operator-supplied map.** `ARMS` names each arm and lists the run ids in it.
  This is how you compare "October" against "November", or "the founder-led play"
  against "the SDR play". It is **self-reported**, exactly like the outcome counts, and
  it is labelled that way in the report. Nothing in the pack verified that those runs
  belong together.

An arm with runs from both sources is not built. Pick one grouping per retro, so the
denominator has one definition.

## Step 2 — run the retro

From the pack root. It spends nothing, calls nothing, and writes one file:

```bash
ROOT=/path/to/project WINDOW_DAYS=90 OUT=gtm/retro/q3.md \
  node --input-type=module -e "${GTM_RETRO:?set this to the gtm-retro script below}"
```

`$GTM_RETRO` is the script below; write it to a file and run that if it is easier.

```js
// ==== gtm-retro v1 ====
// A retrospective ACROSS runs and arms, ending in decisions. ZERO API calls.
// Run from the pack root.
//
// The design rule is the same one /measure follows: do not recompute anything the pack
// already computed. Money comes from one Ledger + one receipt PER RUN, each put through
// assertNeverOverstates, and this file only ever ADDS floors to floors and ceilings to
// ceilings. Coverage and hit rates come from the aggregate share renderer. The
// activation bands come from activation.mjs. This file's own arithmetic is: summing
// per-run ranges, dividing a range by a self-reported outcome count, and asking whether
// two intervals overlap.
//
// The second design rule is unique to this file, because it is the reason /measure
// refuses to do this job: ROWS ARE NEVER DEDUPLICATED ACROSS RUNS. `(row_id, hop)` is
// unique within a run only. Every row figure below is a row-ATTEMPT total and is
// labelled as one.
//
// env: ROOT        (default .)   project root holding gtm/
//      RUNS        (optional) comma-separated run ids; default every run in the window
//      WINDOW_DAYS (optional) override the gate-file window, for a narrower retro
//      ARMS        (optional .json) { "<arm>": ["run-a","run-b"] } — SELF-REPORTED
//      OUTCOMES    (optional .json) { "<arm>": {"meetings": 3} } — SELF-REPORTED
//      OUT         (default gtm/retro/<stamp>-retro.md)
//      GATES_FILE  (alternate gates.yaml; test seam)
//      NOW         (ISO instant; test seam, so a clock is never implicit)
//      JSON        ("1" also prints the decision object)
//
// exit 0 = written with decisions · 2 = nothing to compare
//      3 = written, decisions FAILED CLOSED (a gate key is missing — law 5)

import fs from 'node:fs';
import path from 'node:path';
import { Ledger, readBalanceCache } from './_lib/ledger.mjs';
import { buildReceipt, assertNeverOverstates, spendPhrase } from './_lib/receipt.mjs';
import { renderShareable, assertAggregateOnly } from './_lib/share-render.mjs';
import { readJournal } from './_lib/journal.mjs';
import { loadGates, gateValue, checkCoverage, MissingGateKey, STOP } from './_lib/gates.mjs';
import {
  readActivation, activationPath, localCohort, evaluateBands, renderActivation, snapshot,
} from './_lib/activation.mjs';

const ROOT = path.resolve(process.env.ROOT || '.');
const GTM = path.join(ROOT, 'gtm');
const RUNS_DIR = path.join(GTM, 'runs');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const gates = loadGates(process.env.GATES_FILE || undefined);
const DAY_MS = 86400000;

const die = (code, msg) => { console.error('retro: ' + msg); process.exit(code); };

// Gate keys this skill needs to DECIDE anything. All four resolve in gates.yaml and
// are cited in the prose above in their gates.yaml: form; here they are bare because
// each value is a key path handed to gateValue(). If one ever stops resolving the read
// throws MissingGateKey and the decision half fails closed (law 5) with the key named.
// Describing what happened needs none of them: reporting is never the risky half.
// Deciding is.
const KEYS = {
  window_days: 'skills.gtm_retro.retro_max_window_days',
  min_runs: 'skills.gtm_retro.min_runs_to_compare',
  min_rows: 'skills.gtm_retro.min_rows_per_arm_to_decide',
  max_decisions: 'skills.gtm_retro.max_decisions',
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
// Arm labels reach a forwardable artifact, so they are constrained to bare
// identifiers. assertAggregateOnly rejects anything with a separator in it anyway;
// rejecting here means the operator is told, instead of the render throwing.
const SAFE_ARM = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

// A list_key is hex, and a hex string routinely contains a run of ten or more digits.
// The pack's share guard rejects a long digit run wherever it appears in a string —
// correctly, because that is the shape of a phone number — so a raw hex label makes
// the guard throw on a sentence that merely MENTIONS an arm. Mapping each hex digit
// onto a letter keeps the label unique and unambiguous while removing digits from it
// entirely. Found by the guard, not by review; it is doing its job.
const hexToAlpha = (hex) =>
  String(hex).toLowerCase().replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// --- which runs -------------------------------------------------------------

let catalog = null;
try { catalog = JSON.parse(fs.readFileSync('./_lib/api-catalog.json', 'utf8')); } catch { catalog = null; }

function allRuns () {
  let names = [];
  try { names = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return names.map((n) => ({
    id: n.replace(/\.jsonl$/, ''),
    file: path.join(RUNS_DIR, n),
    mtimeMs: fs.statSync(path.join(RUNS_DIR, n)).mtimeMs,
  })).sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// The window is a gate key. Without it we still READ everything and still report;
// what we do not do is decide. An env override narrows, and is recorded as an override.
let windowDays = null;
let windowSource = null;
try { windowDays = Number(gateValue(gates, KEYS.window_days)); windowSource = 'gates.yaml:' + KEYS.window_days; }
catch (e) { if (!(e instanceof MissingGateKey)) throw e; }
if (process.env.WINDOW_DAYS) {
  windowDays = Number(process.env.WINDOW_DAYS);
  windowSource = 'WINDOW_DAYS override (operator-supplied)';
}

const explicit = String(process.env.RUNS || '').split(',').map((s) => s.trim()).filter(Boolean);
let runs = allRuns();
if (explicit.length) runs = runs.filter((r) => explicit.includes(r.id));
else if (Number.isFinite(windowDays)) {
  runs = runs.filter((r) => (NOW.getTime() - r.mtimeMs) / DAY_MS <= windowDays);
}
if (runs.length === 0) die(2, 'no run journals to compare under ' + RUNS_DIR + '.');

// --- per run: the aggregate view and the receipt ----------------------------
//
// One Ledger and one receipt PER RUN. The ledger adopts only lines whose run_id
// matches, so a run's range is bounded by that run's own lines and nothing else.

const perRun = [];
for (const r of runs) {
  const journal = readJournal(r.file);
  const share = renderShareable(journal.lines, {
    catalog, runIdLabel: r.id, now: () => NOW.toISOString(),
  });
  assertAggregateOnly(share);

  const ledger = new Ledger({ dir: GTM, runId: r.id });
  const receipt = buildReceipt({
    ledger,
    balance: null,
    balanceSource: 'unknown',
    gates,
    runLabel: r.id,
  });
  // THE GUARD, per run. Not wrapped, not caught: a run whose receipt cannot be proven
  // does not get added into a total that is then quoted at a budget meeting.
  assertNeverOverstates(receipt, ledger);

  // The cross-run grouping key. Already a hash by the time it reaches disk
  // (_lib/journal.mjs), so it is a handle for "the same list" and not a list.
  const keys = new Map();
  for (const l of journal.lines) {
    if (!l.list_key) continue;
    keys.set(l.list_key, (keys.get(l.list_key) ?? 0) + 1);
  }
  let listKey = null;
  for (const [k, n] of keys) if (!listKey || n > keys.get(listKey)) listKey = k;

  perRun.push({
    run_id: share.run_id,
    at: new Date(r.mtimeMs).toISOString(),
    list_key: listKey,
    // Row ATTEMPTS. Not people. See the module header.
    row_attempts: share.rows.total,
    rows_found: share.rows.completed,
    coverage_pct: share.coverage_pct,
    state: share.state,
    corrupt_lines: share.journal_health.corrupt_lines,
    calls: receipt.calls,
    credits_floor: receipt.credits_floor,
    credits_ceiling: receipt.credits_ceiling,
    exact: receipt.exact,
    unverifiable_lines: receipt.unverifiable_lines,
    spend_phrase: spendPhrase(receipt),
    per_hop: share.per_hop,
  });
}

// --- the whole-ledger ceiling, recomputed from raw lines --------------------
//
// The twin of assertNeverOverstates, one level up. Each per-run receipt is already
// guarded against its own run's lines; this guards the SUM against the raw ledger
// file, so an arm total can never exceed what the ledger can support even if the
// grouping logic above were to double-count a run.
function ledgerCeilingFor (runIds) {
  const want = new Set(runIds);
  let actual = 0, estimated = 0;
  let raw = '';
  try { raw = fs.readFileSync(path.join(GTM, 'api-calls.jsonl'), 'utf8'); } catch { return 0; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!want.has(o.run_id)) continue;
    if (o.cost_status === 'actual') actual += Number(o.credits_actual ?? 0);
    else if (o.cost_status === 'estimated_unverifiable') estimated += Number(o.credits_estimated ?? 0);
  }
  return round(actual + estimated);
}

// --- arms --------------------------------------------------------------------

const armsFile = process.env.ARMS ? readJson(process.env.ARMS) : null;
const arms = new Map();
let armSource;

if (armsFile && typeof armsFile === 'object') {
  armSource = 'operator-supplied (ARMS) — SELF-REPORTED, nothing verified these runs belong together';
  for (const [name, ids] of Object.entries(armsFile)) {
    if (!SAFE_ARM.test(name)) { console.error('retro: arm name "' + name + '" rejected — use a bare identifier'); continue; }
    const members = perRun.filter((p) => Array.isArray(ids) && ids.includes(p.run_id));
    if (members.length) arms.set(name, members);
  }
} else {
  armSource = 'the journal\'s hashed list_key — the only grouping the pack can observe';
  for (const p of perRun) {
    const name = p.list_key ? 'list_' + hexToAlpha(String(p.list_key).slice(0, 12)) : 'unassigned';
    const safe = SAFE_ARM.test(name) ? name : 'unassigned';
    if (!arms.has(safe)) arms.set(safe, []);
    arms.get(safe).push(p);
  }
}
if (arms.size === 0) die(2, 'no arm could be formed from the selected runs.');

const outcomesFile = process.env.OUTCOMES ? readJson(process.env.OUTCOMES) : null;

const armRows = [];
for (const [name, members] of arms) {
  const ids = members.map((m) => m.run_id);
  // Floors add to floors, ceilings to ceilings. Never a midpoint, never an average.
  const floor = round(members.reduce((s, m) => s + m.credits_floor, 0));
  const ceiling = round(members.reduce((s, m) => s + m.credits_ceiling, 0));
  const cap = ledgerCeilingFor(ids);
  if (ceiling > cap + 1e-9) {
    throw new Error('retro: arm "' + name + '" claims up to ' + ceiling
      + ' credits, above the ' + cap + ' its ledger lines can support');
  }
  const attempts = members.reduce((s, m) => s + m.row_attempts, 0);
  const found = members.reduce((s, m) => s + m.rows_found, 0);
  const raw = outcomesFile?.[name] ?? null;
  let outcomes = null;
  if (raw && typeof raw === 'object') {
    outcomes = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && Number.isFinite(Number(v))) outcomes[k] = Number(v);
    }
    if (Object.keys(outcomes).length === 0) outcomes = null;
  }
  const denom = Number(outcomes?.meetings ?? outcomes?.replies ?? 0);
  armRows.push({
    arm: name,
    runs: members.length,
    run_ids: ids,
    // ATTEMPTS across runs. Deduplicating these would require row_id to be unique
    // across runs, and it is not — that is why /measure refuses this job.
    row_attempts: attempts,
    rows_found: found,
    coverage_pct: attempts > 0 ? Math.round((found / attempts) * 1000) / 10 : null,
    credits_floor: floor,
    credits_ceiling: ceiling,
    exact: members.every((m) => m.exact),
    unverifiable_lines: members.reduce((s, m) => s + m.unverifiable_lines, 0),
    outcome_label: outcomes ? (outcomes.meetings !== undefined ? 'meeting' : 'reply') : null,
    outcome_count: denom > 0 ? denom : null,
    cpo_floor: denom > 0 ? round(floor / denom) : null,
    cpo_ceiling: denom > 0 ? round(ceiling / denom) : null,
  });
}
armRows.sort((a, b) => b.credits_ceiling - a.credits_ceiling);

// --- decisions, which is the whole reason this skill exists ------------------

let minRuns, minRows, maxDecisions, failedClosed = null;
try {
  minRuns = Number(gateValue(gates, KEYS.min_runs));
  minRows = Number(gateValue(gates, KEYS.min_rows));
  maxDecisions = Number(gateValue(gates, KEYS.max_decisions));
  if (!Number.isFinite(windowDays)) throw new MissingGateKey(KEYS.window_days);
} catch (e) {
  if (!(e instanceof MissingGateKey)) throw e;
  failedClosed = {
    missing_key: e.key ?? KEYS.window_days,
    required_keys: Object.values(KEYS),
    reason: 'a gate key this skill needs did not resolve — failing closed (law 5). '
      + 'No decision was produced; the comparison above still stands.',
  };
}

const decisions = [];
const notSeparable = [];
let coverageGate = null;

if (!failedClosed) {
  try { coverageGate = checkCoverage(gates, 100); }
  catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    coverageGate = { decision: STOP, gate: e.key, reason: e.message + ' — failing closed (law 5)' };
  }
  let coverageFloor = null;
  try { coverageFloor = Number(gateValue(gates, 'quality_stops.coverage_min_pct')); }
  catch (e) { if (!(e instanceof MissingGateKey)) throw e; }

  const eligible = armRows.filter((a) => a.runs >= minRuns && a.row_attempts >= minRows);
  const tooThin = armRows.filter((a) => !eligible.includes(a));

  // 1. STOP on the coverage floor. This one needs no outcome data at all, which is
  //    what gives the skill teeth on the first retro anybody runs.
  if (coverageFloor !== null) {
    for (const a of eligible) {
      if (a.coverage_pct !== null && a.coverage_pct < coverageFloor) {
        decisions.push({
          verdict: 'STOP',
          arm: a.arm,
          because: 'coverage ' + a.coverage_pct + '% is below the floor at '
            + 'gates.yaml:quality_stops.coverage_min_pct across ' + a.runs + ' run(s), '
            + a.row_attempts + ' row-attempt(s). Sourcing is the problem, not the copy.',
        });
      }
    }
  }

  // 2. SCALE / STOP on cost-per-outcome, and ONLY where the two ranges do not touch.
  //    Law 4 makes most of these unanswerable, and saying so is the honest output.
  const priced = eligible.filter((a) => a.cpo_floor !== null);
  for (let i = 0; i < priced.length; i += 1) {
    for (let j = 0; j < priced.length; j += 1) {
      if (i === j) continue;
      const A = priced[i], B = priced[j];
      if (A.cpo_ceiling < B.cpo_floor) {
        decisions.push({
          verdict: 'SCALE',
          arm: A.arm,
          because: A.arm + ' costs at most ' + A.cpo_ceiling + ' credits per ' + A.outcome_label
            + ' and ' + B.arm + ' costs at least ' + B.cpo_floor + '. The ranges do not overlap, '
            + 'so the ordering holds even at the worst reading of ' + A.arm
            + ' and the best reading of ' + B.arm + '. Outcome counts are SELF-REPORTED.',
        });
        decisions.push({
          verdict: 'STOP',
          arm: B.arm,
          because: 'beaten outright by ' + A.arm + ' on credits per ' + A.outcome_label
            + ', ranges disjoint. Outcome counts are SELF-REPORTED.',
        });
      } else if (i < j) {
        notSeparable.push({
          pair: [A.arm, B.arm],
          because: 'cost-per-' + A.outcome_label + ' ranges overlap ('
            + A.arm + ': ' + A.cpo_floor + '-' + A.cpo_ceiling + ', '
            + B.arm + ': ' + B.cpo_floor + '-' + B.cpo_ceiling + '). '
            + 'The spend is a range because these endpoints do not report their charge, '
            + 'so no ordering is supportable.',
        });
      }
    }
  }

  // 3. What to try next: name what is missing, in rows, rather than inventing a play.
  for (const a of tooThin) {
    notSeparable.push({
      pair: [a.arm, '(sample floor)'],
      because: a.arm + ' has ' + a.runs + ' run(s) and ' + a.row_attempts
        + ' row-attempt(s); a decision needs the run and row floors at '
        + 'gates.yaml:' + KEYS.min_runs + ' and gates.yaml:' + KEYS.min_rows + '. '
        + 'Run it again before judging it.',
    });
  }

  // Dedupe and cap. A retro that hands back thirty decisions has handed back none.
  //
  // The bound is checked BEFORE the push, not after. Checking after admits one
  // decision at every cap including zero, which quietly breaks the only setting
  // that means "show me nothing" — the setting an operator reaches for precisely
  // when they do not trust the verdicts yet.
  const seen = new Set();
  const capped = [];
  for (const d of decisions) {
    if (capped.length >= maxDecisions) break;
    const k = d.verdict + '|' + d.arm;
    if (seen.has(k)) continue;
    seen.add(k);
    capped.push(d);
  }
  decisions.length = 0;
  decisions.push(...capped);
}

// --- activation, surfaced not reimplemented ---------------------------------
const act = snapshot(readActivation(activationPath()));
const bands = evaluateBands({
  cohort: localCohort(readActivation(activationPath()), { now: () => NOW }),
  gates,
  gateValue,
});

// --- the forwardable core, re-checked before it is rendered ------------------
const core = {
  schema: 'gtm.retro.v1',
  generated_at: NOW.toISOString(),
  window_days: Number.isFinite(windowDays) ? windowDays : null,
  window_source: windowSource,
  arm_source: armSource,
  runs_compared: perRun.length,
  arms: armRows,
  decisions,
  not_separable: notSeparable,
  failed_closed: failedClosed,
};
assertAggregateOnly(core);

// --- render ------------------------------------------------------------------
const L = [];
const totalFloor = round(armRows.reduce((s, a) => s + a.credits_floor, 0));
const totalCeiling = round(armRows.reduce((s, a) => s + a.credits_ceiling, 0));
const allExact = armRows.every((a) => a.exact);

L.push('# Retro — ' + perRun.length + ' run(s), ' + armRows.length + ' arm(s)');
L.push('');
L.push('Generated ' + NOW.toISOString() + ' from the ledger and the run journals. Zero API calls.');
L.push('Window: ' + (core.window_days === null ? 'unbounded (no window resolved)' : core.window_days + ' days')
  + '  ·  basis: ' + windowSource);
L.push('Arms formed from: ' + armSource);
L.push('');

L.push('## Decisions');
L.push('');
if (failedClosed) {
  L.push('**NOT PRODUCED — failed closed.** ' + failedClosed.reason);
  L.push('');
  L.push('Missing: `' + failedClosed.missing_key + '`. This skill needs all of:');
  for (const k of failedClosed.required_keys) L.push('- `gates.yaml:' + k + '`');
  L.push('');
  L.push('That is the correct outcome, not a bug. A missing gate key reads as STOP, never '
    + 'as "no gate" (law 5), and the fix is the key rather than a number typed into the skill.');
} else if (decisions.length === 0) {
  L.push('None. No arm cleared both the run floor and the row floor with a separable range.');
  L.push('"We do not know yet" is a real answer and it is the honest one for the first '
    + 'several retros on a fresh install.');
} else {
  for (const d of decisions) L.push('- **' + d.verdict + ' `' + d.arm + '`** — ' + d.because);
}
L.push('');
if (notSeparable.length > 0) {
  L.push('### Not separable — and what would separate it');
  L.push('');
  for (const n of notSeparable) L.push('- ' + n.pair.join(' vs ') + ': ' + n.because);
  L.push('');
}

L.push('## Spend across the window — a range, and it stays one');
L.push('');
L.push(allExact
  ? 'Spent ' + totalFloor + ' credits across ' + perRun.length + ' run(s).'
  : 'Spent at least ' + totalFloor + ' credits and up to ' + totalCeiling + ' across '
    + perRun.length + ' run(s). The gap is calls whose charge never comes back in the '
    + 'response; for those the estimate is the only figure that will ever exist. Do not '
    + 'quote the ceiling as a spend and do not average the two.');
L.push('');
L.push('| arm | runs | row-attempts | coverage | spend floor | spend ceiling | per-outcome |');
L.push('|---|---|---|---|---|---|---|');
for (const a of armRows) {
  const cpo = a.cpo_floor === null ? 'n/a'
    : (a.exact ? String(a.cpo_ceiling) : a.cpo_floor + '-' + a.cpo_ceiling)
      + ' /' + a.outcome_label;
  L.push('| ' + a.arm + ' | ' + a.runs + ' | ' + a.row_attempts + ' | '
    + (a.coverage_pct === null ? 'n/a' : a.coverage_pct + '%') + ' | '
    + a.credits_floor + ' | ' + a.credits_ceiling + ' | ' + cpo + ' |');
}
L.push('');
L.push('`row-attempts` is row-attempts summed per run, NOT distinct people. The journal\'s '
  + 'unit key is unique within a run only, so deduplicating across runs would merge rows '
  + 'that are not the same row and produce a confident wrong denominator.');
L.push('');

L.push('## Per run');
L.push('');
L.push('| run | when | arm | row-attempts | coverage | state | spend |');
L.push('|---|---|---|---|---|---|---|');
for (const p of perRun) {
  const arm = [...arms.entries()].find(([, ms]) => ms.some((m) => m.run_id === p.run_id))?.[0] ?? 'unassigned';
  L.push('| ' + p.run_id + ' | ' + p.at + ' | ' + arm + ' | ' + p.row_attempts + ' | '
    + (p.coverage_pct === null ? 'n/a' : p.coverage_pct + '%') + ' | ' + p.state + ' | '
    + p.spend_phrase + ' |');
}
L.push('');
const corrupt = perRun.reduce((s, p) => s + p.corrupt_lines, 0);
if (corrupt > 0) {
  L.push('Journal health: ' + corrupt + ' unreadable line(s) across the window. Every coverage '
    + 'figure above is a LOWER bound on what was attempted.');
  L.push('');
}

L.push('## Activation');
L.push('');
L.push('```');
L.push(renderActivation(act, bands));
L.push('```');
L.push('');
L.push('Bands come from `_lib/activation.mjs` and the gate file. A band below its minimum '
  + 'sample, or with no thresholds configured, reads YELLOW and never RED: absence of data '
  + 'is not evidence of failure, and that rule applies to every arm above as well.');
L.push('');
L.push('_Outcome counts and any operator-supplied arm map are SELF-REPORTED. The pack cannot '
  + 'observe a send, a reply or a meeting. Row identifiers, contact fields and response '
  + 'bodies appear nowhere in this report._');

const stamp = NOW.toISOString().slice(0, 10);
const out = process.env.OUT
  ? path.resolve(ROOT, process.env.OUT)
  : path.join(GTM, 'retro', stamp + '-retro.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, L.join('\n') + '\n', 'utf8');

if (process.env.JSON === '1') console.log(JSON.stringify(core, null, 2));
console.log('runs       ' + perRun.length + ' compared across ' + armRows.length + ' arm(s)');
console.log('spend      ' + (allExact ? totalFloor : 'at least ' + totalFloor + ', up to ' + totalCeiling));
console.log('decisions  ' + (failedClosed ? 'NOT PRODUCED — ' + failedClosed.missing_key + ' missing' : decisions.length));
console.log('report     ' + out);
process.exit(failedClosed ? 3 : 0);
// ==== end gtm-retro v1 ====
```

## Step 3 — read it out in the order it is written

Do not reshuffle it into good news first, and do not soften a refusal into a lean.

- **Lead with the decisions, including the absence of them.** "No arm was separable" is
  the result on most first retros and it is worth more than a confident guess. If the
  report says `failed closed`, name the gate key the script printed as missing, say that
  nothing was decided because a threshold could not be read, and say that this is the
  system working rather than a bug to route around.
- **Quote the spend line verbatim.** Where it says a floor and a ceiling, that is what
  you say. Never average them, never round to the ceiling, never call the ceiling
  "roughly what it cost". The script refuses to print an arm total above what the raw
  ledger lines can support; do not reintroduce one in your summary.
- **Say "row-attempts", not "contacts".** Every row figure in this report is attempts
  summed per run. Calling it people overstates reach by however much the arms overlap,
  and the pack cannot measure that overlap.
- **Repeat "self-reported" every time an outcome or an operator-supplied arm map is
  mentioned.** The pack cannot observe a send, a reply or a meeting; sending is external
  forever. A retro that quietly promotes a typed-in meeting count to a measurement is
  the same honour-system arithmetic in a nicer format.
- **A `STOP` is a recommendation to a human, not an action.** This skill changes no
  file outside its own report, disables no play, and edits no plan.

## Step 4 — hand the decision somewhere it can be acted on

A retro that ends in a document nobody opens again has failed. Each verdict has one
natural next step, and naming it is part of the output:

- `STOP` on the coverage floor → the sourcing is thin, so the next move is
  [`/icp-review`](../icp-review/SKILL.md) or [`/tam-map`](../tam-map/SKILL.md), not
  better copy.
- `STOP` on cost-per-outcome → [`/campaign-review`](../campaign-review/SKILL.md) before
  the next launch, so the same arm does not get funded on momentum.
- `SCALE` → [`/build-prospect-list`](../build-prospect-list/SKILL.md) and
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md), with the plan approved fresh. A
  retro verdict is not an approval to spend.
- Not separable → run the arm again. The report already says how far it is from the
  floors.

## What this skill will not do

- **It will not make an API call.** Zero, metered or free. It owns no endpoints in
  `_lib/endpoint-owners.yaml`, and buying an opinion about your own ledger is not a
  retrospective.
- **It will not turn an estimate into an actual.** Eleven of the pack's metered
  endpoints never report their charge, so most arms carry a floor and a ceiling. Every
  per-run receipt goes through the pack's never-overstate guard, the arm totals are
  re-checked against the raw ledger lines, and a claim above what those lines support
  throws rather than shipping.
- **It will not deduplicate rows across runs.** `(row_id, hop)` is unique within a run
  only. Every row figure is attempts, labelled as attempts. This is the exact refusal
  `/measure` makes, and honouring it is what makes a cross-run report defensible.
- **It will not report one run.** A single run is [`/measure`](../measure/SKILL.md),
  which does it better and does not need an arm.
- **It will not re-rank a hop or touch a plan.** Reordering an approved waterfall is
  [`/learn`](../learn/SKILL.md)'s job, it is advisory and attributed there, and this
  skill does not duplicate it or override it.
- **It will not decide without the thresholds.** The window, the run floor, the row
  floor and the decision cap come from the gate file or no decision is produced. A
  missing key reads as STOP, never as "no gate".
- **It will not declare a winner whose range overlaps the loser's.** Two overlapping
  intervals are not an ordering, however much anyone wants one.
- **It will not verify an outcome.** Meetings, replies and revenue are typed in by the
  operator and are labelled self-reported everywhere they appear. Sending execution,
  LinkedIn actions, dialing and direct mail are outside this pack permanently, so the
  events that would verify them are unobservable by construction.
- **It will not name a contact.** The report is built from aggregates the pack's share
  renderer produced, and the finished object is re-inspected before it is written.
- **It will not judge the copy or the offer.** It can say which arm cost more per
  self-reported meeting. Why is a human call.

## Related

- [`/measure`](../measure/SKILL.md) — one run, reported honestly. Run it per run; this
  skill reads across the runs it measured.
- [`/learn`](../learn/SKILL.md) — the hop-level flywheel. A retro decides which arm to
  fund; `/learn` decides which provider the waterfall tries first. Neither substitutes
  for the other.
- [`/campaign-review`](../campaign-review/SKILL.md) — the pre-launch gate a `STOP`
  verdict should reach before the next send.
- [`/icp-review`](../icp-review/SKILL.md) and [`/tam-map`](../tam-map/SKILL.md) — where
  a coverage-floor `STOP` actually gets fixed.
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt.
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
