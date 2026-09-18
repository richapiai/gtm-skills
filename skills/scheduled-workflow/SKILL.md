---
name: scheduled-workflow
version: 1.0.0
description: >
  Runs a saved workflow on a schedule, under an envelope the user approved in advance
  for a bounded, named set of work. Use when asked to "run this every week", "schedule
  this", "automate this refresh", "do this nightly", or "set up a recurring enrichment".
  The scheduled run re-derives the plan before it spends, compares it against what was
  approved, and STOPS on any divergence — a repricing, a bigger plan, an exhausted
  envelope, an expired approval, or any gate that would have asked a human. Makes zero
  API calls itself. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Bash(node:*), Bash(rm:*), Bash(touch:*), Bash(printf:*), Bash(grep:*), Read, Write
triggers:
  - run this every week
  - schedule this workflow
  - automate this refresh
  - nightly enrichment
  - recurring gtm run
  - set up a cron for this
  - stop my schedule
---

# Run a workflow on a schedule

Law 3 says every paid call is named and costed before it runs. That law assumes a human
is present. A schedule's entire purpose is that nobody is.

You cannot fix this by dropping the gate, and you cannot fix it by prompting into the
void at three in the morning. What works is moving the approval **earlier in time**
rather than removing it, and then refusing to run when the world has changed since.

## The rule this skill is built on

> **Unattended, `confirm` collapses to `stop`.**

That single line is the whole resolution, and it makes the gate *stronger* than it is
for an attended run, not weaker.

Attended, the pack has three verdicts: `allow`, `confirm`, `stop`. `confirm` means *a
human decides*. With no human there is no third verdict, so anything that is not
`allow` is `stop`. A scheduled run may therefore only ever execute work that:

1. the user approved **as a named, priced plan** — not as a budget, a plan; and
2. the gate engine would wave through **outright**, with no question asked.

That has teeth, and the teeth are visible immediately. Every endpoint in
`gates.yaml:always_ask.endpoints` returns `confirm` regardless of remaining budget, so
**no schedule in this pack may ever contain one of them.** The skill refuses at
scheduling time, not at three in the morning. The same applies past
`gates.yaml:unbounded_endpoints.pages_before_confirm`: an unattended page-walk is
bounded at the last page a human did not have to approve.

A budget alone would not be enough and it is worth saying why, because "give it a
monthly cap" is the obvious answer and it is the wrong one. A cap answers *how much*. It
does not answer *on what*. Law 3 is a naming law before it is a costing law, and a cap
with an unnamed call set behind it is an opt-out paid call with a ceiling on it.

### The one carve-out, stated rather than buried

`gates.yaml:session_budget` confirms are accepted unattended. Every other confirm stops.

A `session_budget` confirm asks one question — *do you want to spend this much of the
budget you set?* — and the envelope approval is literally the answer to it. The user was
shown this plan, priced at this ceiling, and typed the ceiling out. Asking again, in the
middle of the night, with nobody to answer, protects nothing and makes every schedule
impossible.

It answers that question and no other. `gates.yaml:always_ask.reason` says those
endpoints confirm "regardless of remaining budget" — they are cost outliers and personal
data reach, and a budget approval cannot answer a consent question. The page gate stops
too, and that one matters most: for an unbounded endpoint the planned ceiling rests on
`gates.yaml:unbounded_endpoints.assumed_results_per_page`, so it is not a real ceiling at
all. An envelope cannot bound what the catalog cannot price.

The `session_budget` **stop** is untouched and fires as normal, here and again inside the
runtime.

Note the scope, because [`/signal-watch`](../signal-watch/SKILL.md) draws the line
differently for its own standing approval and says the spend fractions "cannot be
pre-approved away". Attended, that is right and this skill does not contradict it: an
interactive cycle still confirms. What is being carved out here is narrower — a single
run, whose `--budget` is the ceiling of a plan the user was shown and typed the total
of, at a moment when no confirm can be answered at all. If the two readings ever need to
be one reading, this is the narrower of them.

## Inference mode — local

This skill runs on **local inference only**. It makes **zero API calls**, metered or
free, and never calls `ai_enrich`. Arming a schedule, checking one before it fires,
recording what it spent and reporting the burndown are all arithmetic over files the
pack already wrote: a dry-run plan, the generated catalog, the gate file and the ledger.
Nothing here needs a model's opinion, let alone a paid one.

The *scheduled run itself* spends — through `richapi enrich`, `richapi call` or
`richapi search`, gated exactly as an attended run would be. This skill decides whether
that command is allowed to start.

## Before anything else

```bash
richapi-skills-preflight
```

Read the keys. `API_KEY_SET: no` does not block this skill — nothing here calls the API
— but it does mean the scheduled command will fail at its first call, so say so rather
than arming a schedule that cannot run. `BALANCE: unknown` is expected and is reported
as unknown; the envelope is a bound on what a run may plan, never a claim about what is
left in the account. `SUPPRESSION: STOP` blocks the scheduled run itself, fail-closed,
inside the runtime — do not arm around it.

There is **no `richapi schedule` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. Scheduling is local work over state the pack already
has, so it is the script below and nothing else. Do not tell the user to run a command
that does not exist.

## What this reads, and what it must never re-derive

| Question | Answer comes from | Never |
|---|---|---|
| What will this run cost? | `_lib/dryrun.mjs` → `buildPlan`, via `richapi ... --dry-run --json` | a second pricing pass |
| Would a gate object? | `_lib/run.mjs` → `gatePlanFor` | a hand-rolled gate list |
| Is a `confirm` acceptable? | never, unattended | treating silence as consent |
| Has the price moved? | `_lib/api-catalog.json` → the `pricing` block, fingerprinted | a remembered price |
| What did the run actually cost? | `_lib/ledger.mjs` → `Ledger.totals`, then `_lib/receipt.mjs` → `buildReceipt` | the plan estimate |
| May the report claim that figure? | `_lib/receipt.mjs` → `assertNeverOverstates` | catching that error |

The envelope burns down by the receipt **ceiling**, never the floor. Eleven metered
endpoints never report their charge, so their floor is zero; a schedule that burned the
floor would run forever on unverifiable spend and report that it had spent nothing. The
ceiling is the only figure that cannot let a schedule overspend its envelope.

## Step 1 — dry-run the work you want to repeat

Free, zero calls, and it is the artifact everything downstream is bound to.

```bash
richapi call enrich_company --in accounts.csv --dry-run --json > plan.json
```

Read the plan with the user. This is the *named set of work*: which endpoints, how many
calls, what each one costs, which rows are already cached, and whether the total is a
ceiling because a hop is conditional. If they would not approve this plan attended, they
must not approve it unattended.

## Step 2 — approve an envelope, not a budget

```bash
ROOT=. MODE=arm ID=weekly-accounts PLAN=plan.json RUNS=8 EVERY_HOURS=168 \
  CMD='["richapi","call","enrich_company","--in","accounts.csv","--out","enriched.csv"]' \
  APPROVE=<the exact envelope total the script prints> \
  node --input-type=module -e "${GTM_SCHEDULE:?set this to the gtm-schedule script below}"
```

where `$GTM_SCHEDULE` is the script below, in every mode. Write it to a file and run
it if that is easier; it is the same script either way.

`arm` refuses more often than it accepts, and each refusal is the point:

- Any endpoint the gate engine would `confirm` — an always-ask endpoint, a page past
  the free page, a single call worth a large fraction of the budget — refuses here,
  named, with the gate key that refused it.
- Any endpoint in `gates.yaml:disabled` refuses.
- A per-run ceiling outside `gates.yaml:session_budget.min_credits` and
  `gates.yaml:session_budget.max_credits` refuses; that ceiling becomes the run's
  `--budget`, so it has to be a budget the pack will accept.
- A run count above `gates.yaml:skills.scheduled_workflow.max_runs_per_approval`, an
  interval below `gates.yaml:skills.scheduled_workflow.min_interval_hours`, or a total
  above `gates.yaml:skills.scheduled_workflow.max_envelope_credits` refuses. The session
  budget bounds one run; these bound the whole standing approval, which is the thing
  that actually runs away. All three are read, never typed — and if one cannot be read,
  nothing is armed.
- The approval is typed, not clicked. `APPROVE` must be the **exact** envelope total,
  by the same rule the CLI uses for an attended plan — the check is
  `confirmAccepted` from `bin/richapi.mjs`, imported rather than re-implemented, so "y"
  cannot approve a schedule any more than it can approve a run.

What gets written to `gtm/schedules/<id>/envelope.json` is the whole contract: the
command, the endpoint set, the per-run ceiling and floor, the run count, the total
envelope, an expiry, and a **price fingerprint** taken from the catalog's `pricing`
block for every endpoint in the plan.

## Step 3 — what the scheduled run does when nobody is watching

The trigger — Claude's own scheduler, `cron`, a CI timer, whatever the user already has
— runs three things in order. It must not run the second without the first.

```bash
# 1. Re-plan. Free, zero calls. The plan is re-derived, never remembered.
richapi call enrich_company --in accounts.csv --dry-run --json > fresh.json

# 2. Check the fresh plan against the approved envelope. Exit 3 means STOP; the only
#    line on stdout is the budget, and a stop prints none, so there is nothing to run on.
VERDICT=$(ROOT=. MODE=check ID=weekly-accounts PLAN=fresh.json \
  node --input-type=module -e "${GTM_SCHEDULE:?set this to the gtm-schedule script below}") || exit 0
eval "$(printf '%s\n' "$VERDICT" | grep '^RICHAPI_SCHEDULE_BUDGET=')"

# 3. Only now. --budget is the per-run ceiling the user approved.
richapi call enrich_company --in accounts.csv --out enriched.csv \
  --budget "$RICHAPI_SCHEDULE_BUDGET" --yes --json > run.json

# 4. Burn the envelope down by what the ledger says, not by what the plan said.
ROOT=. MODE=record ID=weekly-accounts \
  RUN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("run.json","utf8")).run_id)')" \
  node --input-type=module -e "${GTM_SCHEDULE:?set this to the gtm-schedule script below}"
```

`--yes` in step 3 is not "skip the gate". It is "the gate already ran, at approval time,
against this exact plan, and step 2 has just confirmed the plan has not moved". Remove
step 2 and `--yes` becomes an opt-out paid call, which law 3 forbids outright.

`check` stops (exit 3, nothing spent) on every one of these:

| Divergence | Why it stops rather than adapts |
|---|---|
| `disarmed` | `gtm/schedules/DISARMED` exists. Whoever created it wins. |
| `no_envelope` | The envelope is missing, unparseable, or not the schema it claims. A schedule that cannot read its own contract has no contract. Fail closed. |
| `approval_expired` | An approval is not perpetual: it ages out at `gates.yaml:skills.scheduled_workflow.approval_max_age_days`. Sixteen of fifty-three surviving endpoints repriced in four months; an old approval is an approval of a world that no longer exists. |
| `runs_exhausted` | The approved run count is spent, and it could never exceed `gates.yaml:skills.scheduled_workflow.max_runs_per_approval`. `gates.yaml:session_budget.on_stop` is `raise_or_abort`, and an envelope does not roll over either. |
| `too_soon` | The cadence floor, `gates.yaml:skills.scheduled_workflow.min_interval_hours`. A trigger that misfires is a trigger that spends the envelope by lunchtime. |
| `repriced` | The catalog's pricing block for an approved endpoint no longer fingerprints the same. Named, with both readings printed. |
| `plan_drift` | The fresh plan reaches an endpoint the user never approved. |
| `envelope_exceeded` | The fresh plan's ceiling is above the approved per-run ceiling. |
| `envelope_exhausted` | The fresh plan's ceiling is above what remains. |
| `gate_stop` / `gate_confirm` | `gatePlanFor` returned anything other than `allow`, on any endpoint or any planned page. |
| `halted` | A previous run came in over its per-run ceiling. The schedule halts itself. |

**A repricing stops the run even when the new price is lower.** That is deliberate, and
it is the case people argue with. The approval was of a plan whose cost basis no longer
exists; direction is not the test. A price that reads cheaper per unit while
`result_count_field` moved underneath it bills *more*, and the pack has already been
bitten once by billing semantics changing rather than billing numbers —
`post_keyword_search` once billed per result on the total match count rather than the
page, and was disabled until the spec changed that. The
fingerprint therefore covers the whole pricing block, not the credit figure. Re-approve;
it is one dry run and one typed total.

**Stop means stop, not "spend the envelope and stop there."** A truncated run buys a
partial list nobody asked for, and the pack has no way to tell the user which half they
got until they come back. The whole run does not start.

## Step 4 — what the user sees when they come back

```bash
ROOT=. MODE=status ID=weekly-accounts node --input-type=module -e "${GTM_SCHEDULE:?set this to the gtm-schedule script below}"
```

`gtm/schedules/<id>/runs.jsonl` gets a line for **every fire**, including the ones that
stopped. This is the part unattended systems get wrong: a silent stop and a silent
success look identical from a distance, so a schedule that has been refusing to run for
six weeks reads as a schedule that is working. A stop is written as loudly as a run.

Report the status verbatim, in this order, and do not reshuffle it into good news first:

- **Stops first, with their reason codes.** If the last fire stopped, that is the
  headline and the reason names its own fix.
- **The spend as the receipt states it.** The wording comes from `spendPhrase`, which is
  where every spend claim in this pack is worded. If it says *at least X, up to Y*, say
  that. Never average, never round to the ceiling and call it the cost.
- **The burndown is a ceiling burndown.** Say so. Remaining envelope is what remains
  against the worst case, so the schedule may well have more room than the number
  suggests — and that is the direction the error must point.
- **Unverifiable lines, counted.** If most of a schedule's spend is on endpoints that
  never report a charge, the user should learn that from the status page rather than
  from an invoice.

## Stopping a schedule you did not write

The person who has to stop a runaway schedule at the weekend is rarely the person who
armed it, and they will not have read this page. So there is no verb to learn, no flag
to remember, and nothing to parse:

```bash
touch gtm/schedules/DISARMED        # every schedule in this workspace, next fire
rm -rf gtm/schedules/weekly-accounts   # just this one, permanently
```

Both work because the envelope is read **fail closed**. A `check` that cannot find, read
or validate its envelope stops; it never falls back to "no envelope, no limit". Deleting
the contract deletes the permission. That is the same law 5 shape as a missing gate key,
applied to the one file a schedule cannot run without.

Revoking the API key also stops all spend, everywhere, immediately. It is the blunt
instrument and it is worth naming, because at two in the morning blunt is fine.

## The script

```js
// ==== gtm-schedule v1 ====
// Schedules as an approved envelope over a named plan. ZERO API calls.
// Run from the pack root.
//
// The design in one sentence: this file NEVER decides what a call costs, whether a
// gate objects, or what a run actually spent. It asks dryrun/gates/ledger/receipt and
// refuses on their answer. Its own arithmetic is comparison and subtraction.
//
// env: MODE        arm | check | record | status
//      ROOT        project root holding gtm/            (default .)
//      ID          schedule id
//      PLAN        a `richapi ... --dry-run --json` file (arm, check)
//      RUNS        runs approved                         (arm)
//      EVERY_HOURS cadence, in hours                     (arm)
//      CMD         the scheduled command, JSON array     (arm)
//      APPROVE     the exact envelope total, typed       (arm)
//      RUN         run id whose ledger lines to record   (record)
//      GATES_FILE / CATALOG_FILE / NOW                   (test seams)
//
// exit 0 = go / ok · 2 = usage or input · 3 = STOP (and nothing was spent)

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGates, gateValue, createSession, setBudget, MissingGateKey, STOP, CONFIRM }
  from './_lib/gates.mjs';
import { gatePlanFor } from './_lib/run.mjs';
import { Ledger } from './_lib/ledger.mjs';
import { buildReceipt, assertNeverOverstates, spendPhrase } from './_lib/receipt.mjs';
import { confirmAccepted } from './bin/richapi.mjs';

const ENVELOPE_SCHEMA = 'gtm.schedule_envelope.v1';
const ROOT = path.resolve(process.env.ROOT || '.');
const GTM = path.join(ROOT, 'gtm');
const SCHEDULES = path.join(GTM, 'schedules');
const MODE = (process.env.MODE || '').trim();
const ID = (process.env.ID || '').trim();
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();

const die = (code, msg) => { console.error('schedule: ' + msg); process.exit(code); };
const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const dir = () => path.join(SCHEDULES, ID);
const envelopePath = () => path.join(dir(), 'envelope.json');
const logPath = () => path.join(dir(), 'runs.jsonl');

if (!['arm', 'check', 'record', 'status'].includes(MODE)) {
  die(2, 'MODE must be arm | check | record | status');
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ID)) {
  die(2, 'ID must be a short lowercase slug — it is a directory name under gtm/schedules/');
}

// --- everything policy-shaped is read, never typed --------------------------
// A MissingGateKey anywhere below is a STOP, not a default (law 5). The four
// skills.scheduled_workflow.* keys are read here and cited in the prose above in
// their gates.yaml: form; inside gateValue() they are bare because the argument is
// a key path, not a citation. If one ever stops resolving, this script fails closed
// and no schedule can be armed. That is the correct state for a skill that spends
// unattended: half-configured is not configured.
const gates = loadGates(process.env.GATES_FILE || undefined);
function policy () {
  return {
    maxAgeDays: Number(gateValue(gates, 'skills.scheduled_workflow.approval_max_age_days')),
    maxRuns: Number(gateValue(gates, 'skills.scheduled_workflow.max_runs_per_approval')),
    minIntervalHours: Number(gateValue(gates, 'skills.scheduled_workflow.min_interval_hours')),
    maxEnvelope: Number(gateValue(gates, 'skills.scheduled_workflow.max_envelope_credits')),
    budgetMin: Number(gateValue(gates, 'session_budget.min_credits')),
    budgetMax: Number(gateValue(gates, 'session_budget.max_credits')),
    onStop: String(gateValue(gates, 'session_budget.on_stop')),
  };
}

const catalogPath = process.env.CATALOG_FILE
  || path.join(path.resolve('.'), '_lib', 'api-catalog.json');
function catalog () {
  try { return JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch (e) {
    die(3, 'cannot read the catalog at ' + catalogPath + ' — without it no call can be '
      + 'costed, so this is a STOP: ' + e.message);
  }
}

// --- the price fingerprint --------------------------------------------------
// The WHOLE pricing block, not the credit figure. A per-result price that reads
// cheaper while result_count_field moved underneath it bills more, and that class of
// change is what once disabled post_keyword_search. Direction is not the test; identity is.
const PRICING_KEYS = ['model', 'credits_per_call', 'credits_base', 'credits_per_result',
  'result_count_field', 'billing_field_present_in_response', 'bounded', 'page_gated',
  'disabled_by_default'];

function pricingOf (def) {
  const p = def?.pricing ?? null;
  if (!p) return null;
  return Object.fromEntries(PRICING_KEYS.map((k) => [k, p[k] ?? null]));
}
function fingerprint (def) {
  const p = pricingOf(def);
  if (!p) return null;
  return createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
}

// --- the plan artifact ------------------------------------------------------
function readPlan (which) {
  const file = process.env.PLAN;
  if (!file) die(2, which + ' needs PLAN=<a `richapi ... --dry-run --json` file>');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) {
    die(2, 'cannot read PLAN at ' + file + ': ' + e.message);
  }
  const plan = doc.plan ?? doc;
  if (plan?.schema !== 'gtm.dryrun_plan.v1') {
    die(2, 'PLAN is not a gtm.dryrun_plan.v1 artifact. Produce it with '
      + '`richapi <verb> ... --dry-run --json`; do not hand-write it.');
  }
  if (doc.mode && doc.mode !== 'dry-run') {
    die(2, 'PLAN came from a run that actually spent (mode=' + doc.mode + '). '
      + 'An envelope must be bound to a dry run, which is free and makes zero calls.');
  }
  const endpoints = plan.per_hop.filter((h) => h.calls_planned > 0).map((h) => h.endpoint);
  return {
    plan,
    kind: doc.kind ?? 'rows',
    pages: Array.isArray(doc.pages) ? doc.pages : [],
    endpoints: [...new Set(endpoints)],
    ceiling: round(plan.totals.credits_estimated),
    floor: round(plan.totals.credits_estimated_floor ?? plan.totals.credits_estimated),
  };
}

// --- the unattended gate ----------------------------------------------------
//
// gatePlanFor is the pack's gate engine, unchanged. The only thing added here is the
// collapse: with nobody present, a `confirm` has no one to answer it, so it is a stop.
//
// ONE CARVE-OUT, and it is the only line on this page anyone could call a weakening,
// so it is stated in full rather than buried.
//
// `session_budget.*` confirms are accepted. Every other confirm stops. The reason is
// that a session_budget confirm asks exactly one question — "do you want to spend this
// much of the budget you set?" — and the envelope approval IS the answer to it: the
// user was shown this plan, priced at this ceiling, and typed that ceiling out. Asking
// again, at three in the morning, with no one to answer, is not a control; it would
// make every schedule impossible while protecting nothing, and gate fatigue is how the
// only control there is gets killed.
//
// It answers that question and NO OTHER. `always_ask` explicitly says it fires
// "regardless of remaining budget", so a budget approval cannot answer it — those are
// per-call cost outliers and personal-data reach, and they stop. The page gate stops
// too, and that one matters most: for an unbounded endpoint the planned ceiling is
// built on an ASSUMED results-per-page, so it is not a real ceiling at all, and the
// human between pages is the only actual bound. An envelope cannot bound what the
// catalog cannot price.
//
// The session_budget STOP is untouched and still fires: if the plan exceeds the
// budget, the run is stopped by the engine, here and again inside the runtime.
const BUDGET_GATE = /^session_budget\b/;

function unattendedGate (fresh, budget, cat) {
  const session = createSession({ gates, runId: 'schedule:' + ID });
  const set = setBudget(session, budget);
  if (set.decision === STOP) return [{ code: 'gate_stop', why: set.reason }];
  const g = gatePlanFor({ plan: fresh.plan, catalog: cat, session, pages: fresh.pages });
  const out = [];
  for (const d of g.stops) {
    out.push({ code: 'gate_stop', why: (d.endpoint ?? '?') + ': ' + d.reason + ' [' + d.gate + ']' });
  }
  for (const d of g.confirms) {
    if (BUDGET_GATE.test(String(d.gate ?? ''))) continue;   // answered by the envelope
    out.push({
      code: 'gate_confirm',
      why: (d.endpoint ?? '?') + ': the gate asks a human here — ' + d.reason + ' [' + d.gate
        + ']. Unattended there is no human, so a confirm is a stop. The envelope answered '
        + 'the budget question; it did not answer this one. This workflow cannot be '
        + 'scheduled as written; narrow it until every non-budget gate allows it outright.',
    });
  }
  return out;
}

// --- the log ----------------------------------------------------------------
// A stop is written as loudly as a run. Silence is how an unattended system lies.
function log (line) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.appendFileSync(logPath(), JSON.stringify({ ts: NOW.toISOString(), ...line }) + '\n', 'utf8');
}
function readLog () {
  try {
    return fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// --- the envelope, read fail closed -----------------------------------------
// Missing, unparseable or wrong-schema is a STOP, never "no envelope, no limit".
// That is what makes `rm -rf gtm/schedules/<id>` a kill switch nobody has to learn.
function readEnvelope () {
  let raw;
  try { raw = fs.readFileSync(envelopePath(), 'utf8'); } catch {
    return { ok: false, why: 'no envelope at ' + envelopePath() + '. A schedule with no '
      + 'approved envelope has no approval; nothing runs.' };
  }
  let e;
  try { e = JSON.parse(raw); } catch (err) {
    return { ok: false, why: 'envelope is unparseable (' + err.message + '). A schedule '
      + 'that cannot read its own contract has no contract.' };
  }
  if (e?.schema !== ENVELOPE_SCHEMA) {
    return { ok: false, why: 'envelope schema is "' + e?.schema + '", expected ' + ENVELOPE_SCHEMA };
  }
  return { ok: true, envelope: e };
}
function writeEnvelope (e) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(envelopePath(), JSON.stringify(e, null, 2) + '\n', 'utf8');
}

// --- the divergence check ---------------------------------------------------
function divergences (e, fresh, cat, pol) {
  const stops = [];
  const push = (code, why) => stops.push({ code, why });

  if (e.halted) {
    push('halted', 'this schedule halted itself: ' + e.halted
      + '. Re-arm it deliberately once you know why.');
  }
  const expires = Date.parse(e.expires_at);
  if (!Number.isFinite(expires)) push('approval_expired', 'envelope has no readable expiry');
  else if (NOW.getTime() > expires) {
    push('approval_expired', 'the approval expired at ' + e.expires_at
      + '. Sixteen of fifty-three surviving endpoints repriced in four months, so an old '
      + 'approval is an approval of a world that no longer exists. Re-dry-run and re-arm.');
  }
  if (e.runs_used >= e.runs_approved) {
    push('runs_exhausted', e.runs_used + ' of ' + e.runs_approved
      + ' approved runs are spent, and an envelope does not roll over (policy: ' + pol.onStop + ')');
  }
  const last = readLog().filter((l) => l.outcome === 'ran').pop();
  if (last) {
    const gapH = (NOW.getTime() - Date.parse(last.ts)) / 3600000;
    if (Number.isFinite(gapH) && gapH < e.every_hours) {
      push('too_soon', 'last run was ' + round(gapH) + 'h ago; this schedule fires no more '
        + 'often than every ' + e.every_hours + 'h. A misfiring trigger spends the whole '
        + 'envelope before anyone is awake.');
    }
  }

  // Repricing. Named, with both readings, for every approved endpoint.
  for (const [ep, recorded] of Object.entries(e.price_fingerprint ?? {})) {
    const def = cat.endpoints?.[ep];
    if (!def) {
      push('repriced', ep + ' is no longer in the catalog. It was approved; it cannot be priced.');
      continue;
    }
    const now = fingerprint(def);
    if (now !== recorded) {
      push('repriced', ep + ' repriced since approval.\n'
        + '      approved: ' + JSON.stringify(e.pricing_at_approval?.[ep] ?? null) + '\n'
        + '      now:      ' + JSON.stringify(pricingOf(def)) + '\n'
        + '      This stops the run whether the new price is higher or lower: the approval '
        + 'was of a plan whose cost basis no longer exists. Re-dry-run and re-arm.');
    }
  }

  if (fresh) {
    const approved = new Set(e.endpoints);
    for (const ep of fresh.endpoints) {
      if (!approved.has(ep)) {
        push('plan_drift', 'the fresh plan reaches ' + ep + ', which is not in the approved '
          + 'endpoint set (' + e.endpoints.join(', ') + '). Nobody named that call.');
      }
    }
    if (fresh.ceiling > e.per_run_ceiling_credits + 1e-9) {
      push('envelope_exceeded', 'the fresh plan\'s ceiling is ' + fresh.ceiling
        + ' against an approved per-run ceiling of ' + e.per_run_ceiling_credits
        + '. The run does not start. It is not truncated to fit: a half-bought list is a '
        + 'partial charge for something nobody asked for.');
    }
    const remaining = round(e.envelope_credits - e.credits_spent_ceiling);
    if (fresh.ceiling > remaining + 1e-9) {
      push('envelope_exhausted', 'the fresh plan\'s ceiling is ' + fresh.ceiling
        + ' and only ' + remaining + ' remains of the approved envelope');
    }
    const budget = Math.min(e.per_run_ceiling_credits, Math.max(remaining, 0));
    if (budget > 0) for (const d of unattendedGate(fresh, budget, cat)) push(d.code, d.why);
  }
  return stops;
}

function reportStops (stops, where) {
  console.error('schedule ' + ID + ': STOP — nothing was spent.');
  for (const s of stops) console.error('  [' + s.code + '] ' + s.why);
  log({ outcome: 'stopped', where, stop_codes: stops.map((s) => s.code),
    reasons: stops.map((s) => s.code + ': ' + s.why.split('\n')[0]) });
}

// --- modes ------------------------------------------------------------------

function armMode () {
  const pol = policy();
  const cat = catalog();
  const fresh = readPlan('arm');
  const runs = Number(process.env.RUNS);
  const every = Number(process.env.EVERY_HOURS);
  let cmd = null;
  try { cmd = JSON.parse(process.env.CMD || 'null'); } catch { /* reported below */ }

  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((s) => typeof s === 'string')) {
    die(2, 'CMD must be a JSON array of strings — the exact command the schedule runs. '
      + 'A schedule whose command is described in prose is a schedule nobody can audit.');
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > pol.maxRuns) {
    die(2, 'RUNS must be a whole number of runs within the pack\'s per-approval maximum');
  }
  if (!Number.isFinite(every) || every < pol.minIntervalHours) {
    die(2, 'EVERY_HOURS is below the pack\'s cadence floor');
  }
  if (fresh.ceiling <= 0) {
    die(2, 'this plan spends nothing — there is no envelope to approve. If every row is '
      + 'cached or suppressed, schedule it when it has work to do.');
  }
  if (fresh.ceiling < pol.budgetMin || fresh.ceiling > pol.budgetMax) {
    die(2, 'the per-run ceiling falls outside the session-budget bounds in gates.yaml, and '
      + 'it becomes this run\'s --budget, so the pack would refuse it at run time');
  }
  const envelope = round(fresh.ceiling * runs);
  if (envelope > pol.maxEnvelope) {
    die(2, 'the total envelope exceeds the pack\'s maximum for one approval');
  }

  // The same unattended gate the scheduled run will face. Refusing here, in front of
  // the user, is the whole point: a schedule that could never run must not be armed.
  const blocked = unattendedGate(fresh, fresh.ceiling, cat);
  if (blocked.length > 0) {
    console.error('schedule ' + ID + ': cannot be armed.');
    for (const b of blocked) console.error('  [' + b.code + '] ' + b.why);
    console.error('\nNothing was written. Narrow the workflow, or run it attended.');
    process.exit(3);
  }

  console.log('Schedule ' + ID);
  console.log('  command        ' + cmd.join(' '));
  console.log('  endpoints      ' + fresh.endpoints.join(', '));
  console.log('  per run        floor ' + fresh.floor + ', ceiling ' + fresh.ceiling
    + (fresh.plan.totals.estimate_is_ceiling ? ' (ceiling — conditional work may not fire)' : ''));
  console.log('  runs approved  ' + runs + ' every ' + every + 'h');
  console.log('  ENVELOPE       ' + envelope + ' (ceiling x runs)');
  const unverifiable = fresh.endpoints
    .filter((ep) => cat.endpoints?.[ep]?.pricing?.billing_field_present_in_response !== true);
  console.log('');
  console.log('The envelope burns down by the receipt CEILING, never the floor.');
  console.log(unverifiable.length
    ? '  unverifiable   ' + unverifiable.join(', ')
      + '\n  These never report their charge, so their floor is zero and a floor'
      + '\n  burndown would never end. Expect the burndown to overstate.'
    : '  unverifiable   none — every endpoint here reports its charge, so the'
      + '\n  ceiling is also the actual and the burndown is exact.');
  console.log('');

  if (!confirmAccepted(process.env.APPROVE, envelope)) {
    die(3, 'not approved. Re-run with APPROVE set to the exact envelope total printed '
      + 'above. Typing the total IS the approval — "yes" is not one.');
  }

  const expires = new Date(NOW.getTime() + pol.maxAgeDays * 86400000).toISOString();
  writeEnvelope({
    schema: ENVELOPE_SCHEMA,
    id: ID,
    created_at: NOW.toISOString(),
    expires_at: expires,
    command: cmd,
    endpoints: fresh.endpoints,
    kind: fresh.kind,
    pages: fresh.pages,
    per_run_ceiling_credits: fresh.ceiling,
    per_run_floor_credits: fresh.floor,
    estimate_is_ceiling: Boolean(fresh.plan.totals.estimate_is_ceiling),
    runs_approved: runs,
    every_hours: every,
    envelope_credits: envelope,
    runs_used: 0,
    credits_spent_ceiling: 0,
    unverifiable_endpoints: unverifiable,
    pricing_at_approval: Object.fromEntries(
      fresh.endpoints.map((ep) => [ep, pricingOf(cat.endpoints?.[ep])])),
    price_fingerprint: Object.fromEntries(
      fresh.endpoints.map((ep) => [ep, fingerprint(cat.endpoints?.[ep])])),
    catalog_provenance: fresh.plan.catalog_provenance ?? null,
    halted: null,
  });
  log({ outcome: 'armed', envelope_credits: envelope, runs_approved: runs,
    per_run_ceiling_credits: fresh.ceiling, expires_at: expires });
  console.log('armed. envelope ' + envelopePath());
  console.log('disarm: touch ' + path.join(SCHEDULES, 'DISARMED') + '   |   rm -rf ' + dir());
  process.exit(0);
}

function checkMode () {
  if (fs.existsSync(path.join(SCHEDULES, 'DISARMED'))) {
    reportStops([{ code: 'disarmed', why: path.join(SCHEDULES, 'DISARMED')
      + ' exists. Someone stopped every schedule in this workspace; that wins.' }], 'check');
    process.exit(3);
  }
  const read = readEnvelope();
  if (!read.ok) {
    reportStops([{ code: 'no_envelope', why: read.why }], 'check');
    process.exit(3);
  }
  const e = read.envelope;
  const pol = policy();
  const cat = catalog();
  const fresh = readPlan('check');
  const stops = divergences(e, fresh, cat, pol);
  if (stops.length > 0) { reportStops(stops, 'check'); process.exit(3); }

  const remaining = round(e.envelope_credits - e.credits_spent_ceiling);
  const budget = Math.min(e.per_run_ceiling_credits, remaining);
  log({ outcome: 'cleared', plan_ceiling: fresh.ceiling, budget, envelope_remaining: remaining });
  console.log('RICHAPI_SCHEDULE_BUDGET=' + budget);
  console.log('schedule ' + ID + ': GO. plan ceiling ' + fresh.ceiling
    + ', envelope remaining ' + remaining + ' of ' + e.envelope_credits + '.');
  process.exit(0);
}

function recordMode () {
  const runId = (process.env.RUN || '').trim();
  if (!runId) die(2, 'record needs RUN=<run id>');
  const read = readEnvelope();
  if (!read.ok) die(3, read.why);
  const e = read.envelope;

  const ledgerFile = path.join(GTM, 'api-calls.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((l) => l && l.run_id === runId);
  } catch { lines = []; }

  // The pack has exactly one cost calculation and this is not a second one.
  const ledger = Object.assign(new Ledger({ dir: GTM }), { lines });
  const receipt = buildReceipt({ ledger, gates, runLabel: runId });
  assertNeverOverstates(receipt, ledger);   // deliberately not wrapped in a try

  const burn = receipt.credits_ceiling;     // ceiling, never floor
  e.runs_used += 1;
  e.credits_spent_ceiling = round(e.credits_spent_ceiling + burn);
  const over = burn > e.per_run_ceiling_credits + 1e-9;
  if (over) {
    e.halted = 'run ' + runId + ' cost up to ' + burn + ' against a per-run ceiling of '
      + e.per_run_ceiling_credits + '. Halted rather than allowed to repeat.';
  }
  writeEnvelope(e);
  log({ outcome: 'ran', run_id: runId, calls: receipt.calls,
    credits_floor: receipt.credits_floor, credits_ceiling: receipt.credits_ceiling,
    exact: receipt.exact, unverifiable_lines: receipt.unverifiable_lines,
    spend_phrase: spendPhrase(receipt),
    envelope_remaining: round(e.envelope_credits - e.credits_spent_ceiling),
    halted: e.halted });

  console.log('run ' + runId + ': ' + spendPhrase(receipt));
  console.log('envelope: burned ' + burn + ' (ceiling), '
    + round(e.envelope_credits - e.credits_spent_ceiling) + ' of ' + e.envelope_credits
    + ' remaining, ' + e.runs_used + ' of ' + e.runs_approved + ' runs used.');
  if (over) { console.error('schedule ' + ID + ': HALTED — ' + e.halted); process.exit(3); }
  process.exit(0);
}

function statusMode () {
  const read = readEnvelope();
  if (!read.ok) { console.error('schedule ' + ID + ': ' + read.why); process.exit(3); }
  const e = read.envelope;
  const entries = readLog();
  const stopped = entries.filter((l) => l.outcome === 'stopped');
  const ran = entries.filter((l) => l.outcome === 'ran');
  const L = [];
  L.push('# Schedule ' + ID);
  L.push('');
  if (e.halted) L.push('**HALTED.** ' + e.halted);
  if (fs.existsSync(path.join(SCHEDULES, 'DISARMED'))) {
    L.push('**DISARMED.** ' + path.join(SCHEDULES, 'DISARMED') + ' exists; nothing fires.');
  }
  const lastStop = stopped[stopped.length - 1];
  if (lastStop && (!ran.length || Date.parse(lastStop.ts) > Date.parse(ran[ran.length - 1].ts))) {
    L.push('');
    L.push('**The last fire STOPPED.** ' + (lastStop.reasons ?? []).join(' | '));
    L.push('A stop is not a pause. It repeats every fire until the cause is fixed.');
  }
  L.push('');
  L.push('- command: `' + (e.command ?? []).join(' ') + '`');
  L.push('- endpoints: ' + e.endpoints.join(', '));
  L.push('- approved: ' + e.created_at + ', expires ' + e.expires_at);
  L.push('- runs: ' + e.runs_used + ' of ' + e.runs_approved + ', every ' + e.every_hours + 'h');
  L.push('- envelope: ' + e.credits_spent_ceiling + ' burned of ' + e.envelope_credits
    + ', ' + round(e.envelope_credits - e.credits_spent_ceiling) + ' remaining');
  L.push('- fires: ' + ran.length + ' ran, ' + stopped.length + ' stopped');
  L.push('');
  L.push('The burndown above is a CEILING burndown. '
    + (e.unverifiable_endpoints?.length
      ? 'These endpoints never report their charge, so their floor is zero and only the '
        + 'ceiling can bound them: ' + e.unverifiable_endpoints.join(', ') + '.'
      : 'Every endpoint here reports its charge, so the ceiling is also the actual.'));
  L.push('');
  L.push('| when | outcome | detail |');
  L.push('|---|---|---|');
  for (const l of entries.slice(-20)) {
    const detail = l.outcome === 'ran' ? l.spend_phrase
      : l.outcome === 'stopped' ? (l.stop_codes ?? []).join(', ')
      : l.outcome === 'armed' ? ('envelope ' + l.envelope_credits)
      : 'plan ceiling ' + (l.plan_ceiling ?? '?');
    L.push('| ' + l.ts + ' | ' + l.outcome + ' | ' + String(detail).replace(/\|/g, '/') + ' |');
  }
  const text = L.join('\n') + '\n';
  const out = process.env.OUT || path.join(dir(), 'status.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.log(text);
  process.exit(0);
}

try {
  if (MODE === 'arm') armMode();
  else if (MODE === 'check') checkMode();
  else if (MODE === 'record') recordMode();
  else statusMode();
} catch (err) {
  if (err instanceof MissingGateKey) {
    die(3, err.message + '\n  A missing gate key is a STOP, not "no gate" (law 5). '
      + 'Nothing was armed and nothing was spent.');
  }
  throw err;
}
// ==== end gtm-schedule v1 ====
```

## Do not build a watchlist here

[`/signal-watch`](../signal-watch/SKILL.md) has its own recurring-cost problem and its
own machinery for *what to watch* — the entity list, its ceilings in
`gates.yaml:watchlist.max_entities` and `gates.yaml:watchlist.max_entities_hard_stop`,
the refresh batching, the per-watch cadence floor at
`gates.yaml:watchlist.min_refresh_interval_hours`, and the dedupe that stops a signal
being reported twice. None of that belongs here and this skill must not grow a second
copy of it.

The split is clean, and both pages state it the same way: **`/signal-watch` decides what
to look at and what the standing charge is; this skill decides whether a run may start
when nobody is watching.** A recurring watch is armed like anything else — dry-run one
cycle, approve the envelope, let `check` gate each fire. It composes because a watch
cycle is page one only, which the page gate allows outright.

The two skills hold overlapping but differently-scoped approvals — a subscription
projection there, a per-run envelope here — and neither should grow into the other. If a
watch ever needs a per-fire cost control it should take this envelope rather than invent
one: two envelope implementations means two answers to "may this spend", and this pack
has already caught two modules computing the same set and getting different answers.

## What this skill will not do

- **It will not make an API call.** Zero, metered or free. Arming, checking, recording
  and reporting are arithmetic over files the pack already wrote.
- **It will not run unattended work a human would have been asked about.** Every
  always-ask endpoint and every page past the free page is a `confirm`, and unattended a
  `confirm` is a `stop`. The single carve-out is `gates.yaml:session_budget`, for the
  reason given above and for no other reason. This is the constraint people will most
  want relaxed and it is the one thing on this page that is not negotiable.
- **It will not start a run whose plan is over the envelope, and it will not truncate
  one to fit.** There is no partial mode, because a half-bought list is a full charge for
  work nobody approved and the pack cannot say which half arrived. Be precise about the
  other case, though: if reality diverges *during* a run — a per-result endpoint returns
  more than the plan assumed — the runtime's own
  `gates.yaml:session_budget.fractions.stop` halts it at the approved ceiling, mid-run.
  That is a truncation, it is the correct backstop, and `record` reports it and halts the
  schedule rather than letting it repeat.
- **It will not proceed through a repricing and reconcile afterwards.** Sixteen of
  fifty-three surviving endpoints repriced in four months. Repricing is routine, and
  "spend first, apologise in the morning" is not a cost control.
- **It will not treat an approval as perpetual.** Approvals expire. Re-approving is one
  dry run and one typed total.
- **It will not burn the envelope by the floor.** Eleven metered endpoints never report
  their charge; a floor burndown on those never ends.
- **It will not create the trigger for you.** Cron, a CI timer or Claude's own scheduler
  fires the command; this skill decides whether the command may spend. It does not
  install itself into anything, because a scheduler this skill cannot see is a scheduler
  it cannot honestly claim to have disarmed.
- **It will not send, post, dial or upload.** Sending execution, LinkedIn actions,
  dialing and direct mail are outside the pack permanently, on a schedule as much as by
  hand.
- **It will not decide the cadence for you.** How stale your data is allowed to get is a
  business judgement. The pack enforces a floor on how often a schedule may fire, not an
  opinion on how often it should.

## Related

- [`/cost-optimizer`](../cost-optimizer/SKILL.md) — where the envelope went, and whether
  the recurring work was worth what it cost
- [`/signal-watch`](../signal-watch/SKILL.md) — the standing charge and the watchlist;
  it declines to schedule itself and hands the clock here
- [`/measure`](../measure/SKILL.md) — what one scheduled run actually did, coverage first
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the most commonly scheduled
  workflow, and the dry-run pattern an envelope is bound to
- [`/comply`](../comply/SKILL.md) — retention and erasure keep running while the schedule
  does; an unattended schedule is still writing PII
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt
- `richapi gates` prints every threshold and the key it comes from
