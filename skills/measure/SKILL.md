---
name: measure
version: 1.0.0
description: >
  Reports what a GTM run actually did — coverage first, then spend as an honest range,
  then hit rates by hop and provider. Use when asked "how did that run go", "what did
  that cost", "what's my hit rate", "credits per meeting", "measure this play", or
  "was that worth it". Reads the ledger and the run journal; makes zero API calls and
  spends nothing. Can also write an aggregate-only artifact that is safe to forward.
  (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - how did that run go
  - what did that run cost
  - what is my hit rate
  - measure this play
  - credits per meeting
  - was that run worth it
  - gtm report
---

# Measure a run

You are the accountant, not the salesperson. Your output is what the run actually did,
in the order that matters to the person paying for it: **what was not found, then what
it cost, then what worked.**

Two rules outrank everything else on this page, and both of them cost you a nicer
number:

1. **A range stays a range.** Most metered endpoints never report their charge back.
   For those the pre-call estimate is the only figure that will ever exist, and turning
   an estimate into a "you spent" is a lie with a decimal point on it. The report says
   *at least X, up to Y* and says which lines are which.
2. **Coverage before wins.** What the run did not find is the number that decides
   whether it was worth running. It is also the number a reporting tool is most tempted
   to bury under a hit-rate table. It goes first, above the money.

## Inference mode — local

This skill runs on **local inference only**. It makes **zero API calls**, metered or
otherwise, and never calls `ai_enrich`. Everything it reports is arithmetic over files
the pack already wrote: the ledger, the run journal, and the local activation store.
There is nothing here a model needs to be paid to infer — the pack already runs inside
an agent that can read a JSONL file for free, and buying an opinion about your own
ledger would be the silliest credit this pack could spend.

## Before anything else

Run the preflight and read the keys:

```bash
richapi-skills-preflight
```

None of them can block this skill, and it is worth saying why rather than skipping the
step. `API_KEY_SET: no` is fine — nothing here calls the API. `BALANCE: unknown` is
expected and is reported as unknown, never inferred. `SUPPRESSION: STOP` does not block
a report either; it does mean the run you are measuring may not have been filtered, so
say that out loud in your summary rather than presenting the coverage number as clean.

There is **no `richapi measure` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`; measuring is local work over state the pack already
has, so it is the script below and nothing else. Do not tell the user to run a command
that does not exist.

## What this reads, and what it must never re-derive

| Question | Answer comes from | Never |
|---|---|---|
| What did it cost? | `_lib/ledger.mjs` → `Ledger.totals` and `Ledger.reconcile` | a second cost calculation |
| Is that figure provable? | `_lib/receipt.mjs` → `buildReceipt`, `spendPhrase` | rounding a range into a number |
| Did the report overstate? | `_lib/receipt.mjs` → `assertNeverOverstates` | catching that error |
| Who was covered? | `_lib/journal.mjs` → `summarize` | reading contact rows |
| Hit rates by hop and provider | `_lib/share-render.mjs` → `renderShareable` | filtering rows by hand |
| Activation and kill/scale bands | `_lib/activation.mjs` → `evaluateBands` | inventing a verdict |

The pack has exactly one cost calculation and this skill is not allowed to be the
second one. `Ledger.totals` already separates verified actuals from unverifiable
estimates; `buildReceipt` already turns that into a floor and a ceiling; and
`assertNeverOverstates` recomputes from the raw ledger lines and **throws** if the
report claims more than the ledger can support. The script below calls that guard
before it renders a single character, and it does not wrap it in a `try`. A report that
cannot be proven is not printed.

## Step 1 — pick the run

One report covers one run. Cross-run rollups are deliberately out of scope (see the
boundary section): the journal's resume key is `(row_id, hop)` and that key is only
unique *within* a run, so folding two journals together silently merges rows that are
not the same row. A wrong denominator is worse than a missing report.

With no `RUN` given, the script measures the most recently written journal under
`gtm/runs/`. Say which run you measured. "Your last run" and "the run you are asking
about" are not reliably the same thing.

## Step 2 — run the report

From the pack root. It spends nothing, calls nothing, and writes one file:

```bash
ROOT=/path/to/project RUN=run-2026-08-28-abc node --input-type=module -e "${GTM_MEASURE:?set this to the gtm-measure script below}"
```

where `$GTM_MEASURE` is the script below. Write it to a file and run it if that is
easier; it is the same script either way.

```js
// ==== gtm-measure v1 ====
// What a run actually did. ZERO API calls. Run from the pack root.
//
// The whole design of this file is "do not recompute anything the pack already
// computed". Money comes from the Ledger and the receipt; coverage and hit rates come
// from the journal via the share renderer; the activation bands come from
// activation.mjs. This file's own arithmetic is limited to counting rows and dividing
// a spend range by a self-reported outcome count.
//
// env: ROOT      (default .)   project root holding gtm/
//      RUN       (default: newest journal under gtm/runs/)
//      OUT       (default gtm/measure/<run>-report.md)
//      SHARE     ("1" also writes gtm/measure/<run>-share.md, aggregate-only)
//      OUTCOMES  (optional .json of SELF-REPORTED counts, e.g. {"meetings": 3})
//      USAGE     (optional .json body from GET /usage, for reconciliation)
//      GATES_FILE(alternate gates.yaml; test seam)
//      NOW       (ISO instant; test seam, so a clock is never implicit)
//
// exit 0 = report written · 2 = nothing to measure · 3 = written, coverage below floor

import fs from 'node:fs';
import path from 'node:path';
import { Ledger, readBalanceCache } from './_lib/ledger.mjs';
import { buildReceipt, assertNeverOverstates, spendPhrase, renderReceipt } from './_lib/receipt.mjs';
import { renderShareable, renderShareableText, assertAggregateOnly } from './_lib/share-render.mjs';
import { readJournal, summarize } from './_lib/journal.mjs';
import { loadGates, gateValue, checkCoverage, MissingGateKey, STOP } from './_lib/gates.mjs';
import { readActivation, activationPath, snapshot, localCohort, evaluateBands, renderActivation } from './_lib/activation.mjs';

const ROOT = path.resolve(process.env.ROOT || '.');
const GTM = path.join(ROOT, 'gtm');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const gates = loadGates(process.env.GATES_FILE || undefined);

const die = (code, msg) => { console.error('measure: ' + msg); process.exit(code); };

// --- which run -------------------------------------------------------------
const runsDir = path.join(GTM, 'runs');
function newestRun () {
  let names = [];
  try { names = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  for (const n of names) {
    const st = fs.statSync(path.join(runsDir, n));
    if (!best || st.mtimeMs > best.mtimeMs) best = { id: n.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
  }
  return best?.id ?? null;
}
const RUN = process.env.RUN || newestRun();
if (!RUN) die(2, 'no run journal found under ' + runsDir + ' — there is nothing to measure yet.');

const journalPath = path.join(runsDir, RUN + '.jsonl');
if (!fs.existsSync(journalPath)) die(2, 'no journal for run "' + RUN + '" at ' + journalPath);
const journal = readJournal(journalPath);
if (journal.lines.length === 0 && journal.corrupt.length === 0) die(2, 'journal for run "' + RUN + '" is empty.');

// --- coverage, from the journal (aggregate-only, by construction) ----------
// row_id is used ONLY as a Set key for cardinality. It is caller-supplied and is
// routinely an email or a CRM record id, so it is never emitted anywhere below —
// the same discipline share-render.mjs applies.
const units = summarize(journal.lines);
const rowsSeen = new Set();
const rowsWithAnyOk = new Set();
for (const u of units.values()) {
  rowsSeen.add(u.row_id);
  if (u.status === 'ok') rowsWithAnyOk.add(u.row_id);
}
const rowsTotal = rowsSeen.size;
const rowsFound = rowsWithAnyOk.size;
const rowsNotFound = rowsTotal - rowsFound;

let catalog = null;
try { catalog = JSON.parse(fs.readFileSync('./_lib/api-catalog.json', 'utf8')); } catch { catalog = null; }

// The aggregate view. This is also what the shareable artifact is built from, so a
// field that is not in here can never reach a forwarded file.
const share = renderShareable(journal.lines, {
  catalog,
  runIdLabel: RUN,
  now: () => NOW.toISOString(),
});
assertAggregateOnly(share);

// --- money: the ledger's own arithmetic, never a second copy of it ---------
const ledger = new Ledger({ dir: GTM, runId: RUN });     // adopts this run's lines
const cachedBalance = readBalanceCache();
const receipt = buildReceipt({
  ledger,
  balance: cachedBalance?.balance ?? null,
  balanceSource: cachedBalance?.source ?? 'unknown',
  gates,
  runLabel: RUN,
});
// THE GUARD. Not wrapped, not caught: a report that cannot be proven is not printed.
assertNeverOverstates(receipt, ledger);

let usageBody = null;
if (process.env.USAGE) {
  try { usageBody = JSON.parse(fs.readFileSync(process.env.USAGE, 'utf8')); } catch { usageBody = null; }
}
const reconciliation = ledger.reconcile(usageBody);

// --- the coverage gate, read from gates.yaml, never typed here -------------
let coverageGate;
try { coverageGate = checkCoverage(gates, share.coverage_pct); }
catch (e) {
  if (!(e instanceof MissingGateKey)) throw e;
  coverageGate = { decision: STOP, gate: e.key, reason: e.message + ' — failing closed (law 5)' };
}

// --- activation + kill/scale bands: surfaced, not reimplemented ------------
const act = snapshot(readActivation(activationPath()));
const bands = evaluateBands({
  cohort: localCohort(readActivation(activationPath()), { now: () => NOW }),
  gates,
  gateValue,
});

// --- outcomes: SELF-REPORTED, never observed by the pack -------------------
// The pack cannot see a send, a reply or a meeting: sending is external forever. So
// these are counts the operator typed, they are labelled as such, and nothing here
// promotes them to something the pack verified. Law 4's shape, applied past credits.
let outcomes = null;
if (process.env.OUTCOMES) {
  try {
    const raw = JSON.parse(fs.readFileSync(process.env.OUTCOMES, 'utf8'));
    outcomes = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (/^[a-z][a-z0-9_]{0,31}$/.test(k) && Number.isFinite(Number(v))) outcomes[k] = Number(v);
    }
    if (Object.keys(outcomes).length === 0) outcomes = null;
  } catch { outcomes = null; }
}

// --- the spend block, and the guard that the block never overstates --------
const spendBlock = renderReceipt(receipt);
function assertBlockWithinLedger (text, r) {
  const cap = r.credits_ceiling;
  for (const m of text.matchAll(/(?:spent|at least|up to)\s+([\d.,]+)/gi)) {
    const claimed = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(claimed) && claimed > cap + 1e-9) {
      throw new Error('measure: the report claims ' + claimed + ' credits, above the ledger ceiling of ' + cap);
    }
  }
}
assertBlockWithinLedger(spendBlock, receipt);

// --- render ----------------------------------------------------------------
const rate = (hits, n) => (n > 0 ? Math.round((hits / n) * 1000) / 10 + '% (n=' + n + ')' : 'n/a (n=0)');
const L = [];
L.push('# Measure — run ' + RUN);
L.push('');
L.push('Generated ' + NOW.toISOString() + ' from the ledger and the run journal. Zero API calls.');
L.push('');

// 1. COVERAGE FIRST. What was not found decides whether the run was worth it.
L.push('## Coverage — what this run did NOT find');
L.push('');
L.push('- rows in the run:  ' + rowsTotal);
L.push('- **not found:      ' + rowsNotFound + '**   <- the number that decides whether the run was worth it');
L.push('- found (any hop):  ' + rowsFound);
L.push('- coverage:         ' + (share.coverage_pct === null ? 'n/a' : share.coverage_pct + '%'));
L.push('- state:            ' + share.state);
L.push('');
L.push('Rows that never completed are counted as not found, because from the operator\'s '
  + 'side of the desk an in-flight row and a missing row are the same missing row:');
L.push('');
L.push('- in flight at interrupt: ' + share.rows.in_flight);
L.push('- not started:            ' + share.rows.not_started);
L.push('- failed:                 ' + share.rows.failed);
L.push('- halted on budget:       ' + share.rows.halted_budget);
L.push('- dropped by suppression: ' + share.rows.dropped_suppressed);
L.push('');
L.push('Coverage gate `' + coverageGate.gate + '`: ' + coverageGate.decision.toUpperCase() + ' — ' + coverageGate.reason);
if (journal.corrupt.length > 0) {
  L.push('');
  L.push('Journal health: ' + journal.corrupt.length + ' unreadable line(s). Coverage above is a '
    + 'LOWER bound on what was attempted; a damaged line is not evidence of a completed row.');
}
L.push('');

// 2. Money, as a range unless every line is verifiable.
L.push('## Spend');
L.push('');
L.push(spendBlock);
L.push('');
L.push('Reconciliation against `GET /usage`: ' + reconciliation.status);
L.push('');
L.push('```');
L.push(reconciliation.report);
L.push('```');
L.push('');
if (!receipt.exact) {
  L.push('The figure above is a RANGE and stays one. ' + receipt.unverifiable_lines
    + ' of ' + receipt.calls + ' call(s) hit an endpoint that does not report its charge, '
    + 'so the estimate is the only number that will ever exist for them. Do not quote the '
    + 'ceiling as a spend.');
  L.push('');
}

// 3. Only now: what worked.
//
// The per-hop credit column comes from the JOURNAL, not from the ledger, so it is
// labelled as such and is never a spend claim. The ledger is the money record of
// record; if the two disagree the divergence is printed rather than hidden behind
// whichever number reads better.
L.push('## What worked — by hop');
L.push('');
L.push('| hop | endpoint | planned | done | failed | hit rate | journal est. credits |');
L.push('|---|---|---|---|---|---|---|');
let journalCredits = 0;
for (const h of share.per_hop) {
  const credits = h.cost_status === 'actual' ? String(h.credits_actual) : '~' + h.credits_estimated + ' (est)';
  journalCredits += h.cost_status === 'actual' ? h.credits_actual : h.credits_estimated;
  L.push('| ' + h.hop + ' | ' + h.endpoint + ' | ' + h.planned + ' | ' + h.completed + ' | '
    + h.failed + ' | ' + rate(h.completed, h.completed + h.failed) + ' | ' + credits + ' |');
}
L.push('');
L.push('The credit column above is the **journal\'s** per-hop figure, kept here for '
  + 'attribution. The spend section is the money record; nothing in this table is a spend claim.');
if (journalCredits > receipt.credits_ceiling + 1e-9) {
  L.push('');
  L.push('DIVERGENCE: the journal accounts for ' + Math.round(journalCredits * 1000) / 1000
    + ' credits across these hops while the ledger can support at most '
    + receipt.credits_ceiling + '. The LEDGER figure governs. A gap this way round usually '
    + 'means journal lines exist for calls the ledger never recorded — treat the run as '
    + 'partially unaccounted rather than as cheaper than it looks.');
}
L.push('');
L.push('## What worked — by provider');
L.push('');
if (share.providers.length === 0) {
  L.push('No provider was attributed on any hop. That is a gap in the data, not a result.');
} else {
  L.push('| provider | attempts | hits | hit rate | mean confidence |');
  L.push('|---|---|---|---|---|');
  for (const p of share.providers) {
    L.push('| ' + p.provider + ' | ' + p.attempts + ' | ' + p.ok + ' | ' + rate(p.ok, p.attempts)
      + ' | ' + (p.mean_confidence === null ? 'n/a' : p.mean_confidence) + ' |');
  }
}
L.push('');
L.push('Every rate above carries its denominator. A rate without an `n` invites a decision '
  + 'the sample cannot support, which is the same mistake the kill/scale bands refuse to make.');
L.push('');

// 4. Outcomes and credit ROI — self-reported, and labelled every time.
L.push('## Outcomes — self-reported, not observed');
L.push('');
if (!outcomes) {
  L.push('None supplied. The pack cannot see a send, a reply or a meeting — sending is external '
    + 'forever — so it reports no outcome rather than inferring one. Supply counts via OUTCOMES '
    + 'if you want the credit-ROI line.');
} else {
  for (const [k, v] of Object.entries(outcomes)) L.push('- ' + k + ': ' + v + '  (self-reported)');
  const denom = Number(outcomes.meetings ?? outcomes.replies ?? 0);
  const label = outcomes.meetings !== undefined ? 'meeting' : 'reply';
  if (denom > 0) {
    const lo = Math.round((receipt.credits_floor / denom) * 100) / 100;
    const hi = Math.round((receipt.credits_ceiling / denom) * 100) / 100;
    L.push('');
    L.push(receipt.exact
      ? '- credits per ' + label + ': ' + hi
      : '- credits per ' + label + ': between ' + lo + ' and ' + hi
        + ' — the spend is a range, so the ROI is a range too.');
  }
  L.push('');
  L.push('These counts came from the operator, not from the API. Nothing above verified them.');
}
L.push('');

// 5. Activation, straight from activation.mjs.
L.push('## Activation and kill/scale bands');
L.push('');
L.push('```');
L.push(renderActivation(act, bands));
L.push('```');
L.push('');
L.push('Bands are computed by `_lib/activation.mjs` from thresholds in the gate file. A band '
  + 'below its minimum sample, or with no thresholds configured, reads YELLOW and never RED: '
  + 'absence of data is not evidence of failure.');
L.push('');
L.push('_Coverage is stated before wins on purpose. Row identifiers, contact fields and '
  + 'response bodies appear nowhere in this report._');

const text = L.join('\n') + '\n';
const out = process.env.OUT || path.join(GTM, 'measure', RUN + '-report.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');

// --- the shareable artifact, built from journal METADATA only --------------
let sharePath = null;
if (process.env.SHARE === '1') {
  const body = renderShareableText(share) + '\n\n' + spendPhrase(receipt) + '\n';
  assertAggregateOnly({ rendered_share_artifact: body });
  assertBlockWithinLedger(body, receipt);
  sharePath = path.join(GTM, 'measure', RUN + '-share.md');
  fs.mkdirSync(path.dirname(sharePath), { recursive: true });
  fs.writeFileSync(sharePath, body, 'utf8');
}

console.log('run        ' + RUN);
console.log('coverage   not found ' + rowsNotFound + ' of ' + rowsTotal
  + ' (' + (share.coverage_pct === null ? 'n/a' : share.coverage_pct + '%') + ' covered)');
console.log('spend      ' + spendPhrase(receipt));
console.log('reconciled ' + reconciliation.status);
console.log('report     ' + out);
if (sharePath) console.log('share      ' + sharePath);
process.exit(coverageGate.decision === STOP ? 3 : 0);
// ==== end gtm-measure v1 ====
```

## Step 3 — report it in the order the file is written in

Read the file back in order. Do not reshuffle it into "here's the good news first".

- **Lead with what was not found.** Then the coverage percentage, then the gate verdict.
  If the coverage gate STOPped, that is the headline and the fix is named by the gate
  key, not by you.
- **Quote the spend line verbatim.** If it says *at least X, up to Y*, that is what you
  say. Never average the two, never round to the ceiling, never round to the floor, and
  never describe the ceiling as "roughly what it cost". The script refuses to print a
  figure above the ledger ceiling; you must not reintroduce one in your summary.
- **Say `unreconciled` when it says `unreconciled`.** `GET /usage` is documented in prose
  and absent from the spec's paths, so an unreconciled ledger is the normal case. It
  means the total is the pack's own arithmetic and nothing has checked it.
- **Carry the `n` with every rate.** A hop that went one-for-one is not a hundred
  percent hit rate; it is one call.
- **The per-hop credit column is not a spend.** It is the journal's own figure, kept for
  attribution. If the report prints a DIVERGENCE line, the ledger governs and the run is
  partially unaccounted for — say that, rather than quoting whichever total reads better.
- **Outcomes are the operator's word.** Repeat them as such or leave them out.

## Sharing a report

`SHARE=1` writes a second file that is safe to forward. It is built from the same
aggregate object the report uses, which is produced by the pack's share renderer from
journal *metadata* — counts, sums and percentages the renderer computed itself. No
journal line is ever copied into it, `row_id` is used only as a set key and never
emitted, and the finished object is re-inspected and throws on any row-shaped key or
contact-shaped value before it reaches disk.

Send people that file. Do not paste the private report into a channel because "it looks
fine" — the difference between the two files is a guarantee versus a glance.

## What this skill will not do

- **It will not make an API call.** Zero, metered or free. Measuring is arithmetic over
  files the pack already wrote, and buying a number you already own is not measurement.
- **It will not turn an estimate into an actual.** Most metered endpoints never report
  their charge. Those lines stay `estimated_unverifiable`, the report stays a range, and
  the never-overstate guard throws rather than let a friendlier convention through. It
  will also not invent a second wording for "spent" — the phrasing comes from the
  receipt module so no caller can soften it.
- **It will not report a spend it cannot support.** The guard recomputes from the raw
  ledger lines, and the script does not catch it. A claim above the ledger ceiling
  crashes the report rather than shipping it.
- **It will not roll up several runs into one report.** The journal's unit key is unique
  within a run only, so a cross-run merge silently collapses distinct rows and hands you
  a confident wrong denominator. Run it once per run.
- **It will not observe a send, a reply, a meeting or a deal.** Sending execution,
  LinkedIn actions, dialing and direct mail are outside the pack permanently. Outcome
  counts are typed in by the operator and are always labelled self-reported.
- **It will not put a contact in a shareable file.** The share artifact is aggregate by
  construction, not by filtering — a filter is one new field away from leaking.
- **It will not judge the campaign.** It can tell you what a run cost and what it found.
  Whether the offer, the copy or the targeting was any good is a human call.

## Related

- [`/learn`](../learn/SKILL.md) — turns the hit rates in this report into priors for the
  next run, locally
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the run this skill measures, and
  where a low-coverage verdict sends you back to
- [`/campaign-review`](../campaign-review/SKILL.md) — the pre-launch gate; this skill is
  its after-the-fact twin
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt
- `richapi gates` prints every threshold and the key it comes from
