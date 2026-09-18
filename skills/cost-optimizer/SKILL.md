---
name: cost-optimizer
version: 1.0.0
description: >
  Finds where the credits went and what to do about it, from the real ledger. Use when
  asked "where did my credits go", "why is this so expensive", "how do I spend less",
  "what is wasting credits", or "audit my spend". Reports savings as ranges bounded by
  what the ledger can prove, names the evidence under every recommendation, and says
  when that evidence is an estimate. Makes zero API calls and spends nothing.
  (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - where did my credits go
  - why is this so expensive
  - how do I spend less
  - what is wasting credits
  - audit my credit spend
  - cost optimization
  - reduce my api costs
---

# Find where the credits went

You are auditing money that has already been spent. That makes this the easiest skill in
the pack to make dishonest, because a saving is a number nobody checks and everybody
enjoys.

One rule outranks everything else here, and it costs you every impressive number:

> **A saving computed against a fabricated actual is a fabricated saving.**

Eleven of the pack's metered endpoints never report their charge. For those the pre-call
estimate is the only figure that will ever exist. If you subtract an estimate from an
estimate and call the difference a saving, you have invented money — and you have
invented it in the direction that flatters you, which is how honor-system arithmetic
always fails. So every saving on this page is a **range with a floor of what the ledger
can prove**, and for an unverifiable line that floor is zero.

"You would have saved at most X, and the ledger can prove none of it" is an
uncomfortable sentence. It is also the true one.

## Inference mode — local

This skill runs on **local inference only**. It makes **zero API calls**, metered or
free, and never calls `ai_enrich`. Everything it reports is arithmetic over files the
pack already wrote: `gtm/api-calls.jsonl`, the run journals under `gtm/runs/`, the
generated catalog and the gate file. Paying an endpoint for an opinion about your own
ledger would be the single silliest credit this pack could spend, and it would show up
in the next audit as a finding.

## Before anything else

```bash
richapi-skills-preflight
```

None of the keys can block this skill and it is worth saying why. `API_KEY_SET: no` is
fine — nothing here calls the API. `BALANCE: unknown` is expected; this skill reports
what was spent, not what is left, and it never infers one from the other.
`SUPPRESSION: STOP` does not block an audit, but it does mean the runs you are auditing
may not have been filtered, so the wasted-spend findings may be understated.

There is **no `richapi cost` verb**. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. Cost analysis is local work over state the pack
already has, so it is the script below and nothing else.

## Where every number comes from

| Question | Answer comes from | Never |
|---|---|---|
| What was spent? | `_lib/ledger.mjs` → `Ledger.totals` | a second cost calculation |
| Floor, ceiling, and is it exact? | `_lib/receipt.mjs` → `buildReceipt` | rounding a range into a number |
| How is a spend worded? | `_lib/receipt.mjs` → `spendPhrase` | a friendlier wording |
| May a figure be claimed? | `_lib/receipt.mjs` → `assertNeverOverstates` | catching that error |
| What did a hop achieve? | `_lib/journal.mjs` → `readJournal`, `summarize` | reading contact rows |
| How long is a fact cacheable? | `_lib/gates.mjs` → `cacheTtlDays` | a remembered TTL |
| What does an endpoint cost? | `_lib/api-catalog.json` → the `pricing` block | a price from training data |

**A saving is priced by the receipt, not by this skill.** Each finding collects the
ledger lines it rests on, hands exactly those lines to `buildReceipt`, and takes the
floor and ceiling it gets back. `assertNeverOverstates` then runs against that same line
set. So a finding's saving is computed by the same code that prices a run's receipt,
under the same floor/ceiling convention, and there is no second arithmetic that could
drift from it or be tuned to look better.

### The guard, and why the obvious one is not enough

`assertNeverOverstates` protects a single figure against a single line set. The way a
savings report inflates is not by overstating one finding; it is by **counting the same
credit twice**. A hop that never hit is also, often, a hop whose results were bought
again next week — cite the same ledger line under both findings, add the two savings up,
and the total quietly exceeds the run.

Overlap is not a bug in the data; it is what the data looks like. So the script does not
refuse overlapping findings — it makes the *later* finding lose the credit. Findings are
evaluated in a fixed order, each one may only claim a ledger line no earlier finding
claimed, and where a finding was reduced the report says so. The alternative, splitting
the credit or letting both claim it, is how a savings report ends up larger than the run
it audits.

On top of that, three assertions, none of them caught:

1. every finding's own saving is within the lines it cites — `assertNeverOverstates`,
   imported, not reimplemented;
2. no ledger line is claimed by two findings — the invariant the claim order exists to
   maintain, checked rather than assumed;
3. the union of all findings is within the whole-ledger receipt, and the findings sum to
   exactly their union.

A report that cannot pass all three is not written. This is the same discipline
`/measure` applies to a spend claim, extended to the one thing a spend claim cannot
catch.

## What it will not let you say

- **Never a saving with no floor stated.** If the floor is zero, the sentence says the
  ledger can prove none of it.
- **Never "you wasted X".** Waste is a judgement about intent. The report says *these
  calls were charged and produced nothing readable*, which is a fact, and lets the
  reader draw the conclusion.
- **Never a saving from switching to a bulk endpoint.** See below; the catalog says the
  credits are identical, and claiming otherwise would be a hand-typed price beating a
  generated one.
- **Never a cross-run join on the journal.** The journal's unit key is unique within a
  run only, so folding two journals together merges rows that are not the same row.
  Money is summed across runs from the *ledger*, which is per-call and carries
  `run_id`; hit rates are computed per run and never merged.

## The findings it looks for

Two thresholds decide whether a pattern is a finding at all, and the script reads both
rather than carrying either. `gates.yaml:skills.cost_optimizer.min_evidence_calls` is the
evidence floor — a pattern seen fewer times than that is an anecdote, not a
recommendation. `gates.yaml:skills.cost_optimizer.min_saving_credits` is the noise floor
— a saving below it costs more attention than it returns. Neither is ever typed into a
finding, and if either stops resolving the run is a STOP rather than a report with no
floor under it (law 5).

### Cache TTLs you are not benefiting from

The cheapest credit is one the cache already answered. The finding is concrete: the same
endpoint charged for the same row more than once, with the two charges closer together
than the endpoint's own TTL from `cacheTtlDays`. You paid twice for a fact the pack's
own policy says had not moved.

The usual causes are all fixable: `--no-cache` left on, a state tree moved with `--dir`
so the cache went with it, or a run under a different project root. Evidence is the
later ledger line, and the saving is that line priced by the receipt.

### Waterfall hops that never hit

A hop that was charged and returned nothing, every time, across a run. Evidence is the
journal (attempts with no `ok`) crossed with the ledger lines for that hop. Note that
a hop failing with a non-2xx costs nothing at all: the billing rule is that a non-2xx
deducts no credits, the ledger writes those lines `known_zero`, and a finding built on
them would claim a saving on credits that were never charged. Only lines the ledger
records as charged count as evidence, which is why the saving is often much smaller than
the failure count suggests.

### Pages that came back empty

For a page-gated endpoint on a `base_plus_per_result` price, an empty page still costs
the base. The evidence is a ledger line with a result count the response actually
reported as zero — never a null, which means *unknown*, not *none*. The fix is already
in the runtime: a search stops when a page comes back short unless `--all-pages`
overrode it, so this finding usually reads as "the override cost you this much".

### Charged twice for the same unit

Same run, same row, same hop, charged more than once. This is the orphan case the
journal's resume logic warns about — a run killed mid-call, where the pack cannot know
whether the server billed it. Evidence is the duplicate ledger line.

### Bulk variants — and why this is an anti-recommendation

An earlier version of this skill told users to always switch to a bulk endpoint. On
this API that advice is wrong twice over, and the catalog says so:

- **The credits are identical.** `enrich_profile` is flat per call and
  `enrich_profiles_bulk` is per result, at the same rate. Batching buys latency and
  reduced rate-limit exposure. It does not buy credits, and this skill must not book a
  saving it cannot substantiate from the catalog.
- **Bulk is strictly worse for accountability.** The single endpoints report their
  charge in the response; the bulk pair do not — their result-count field appears in
  zero responses. Batching converts verified actuals into unverifiable estimates. Under
  the never-fabricate-an-actual law, that is a real cost paid in the one currency this
  skill spends: certainty.

`gates.yaml:runtime.batch.auto` is off, and for a third reason again: bulk attribution
is positional and the response shape is unverified, so a correctly-sized response in the
wrong order attaches one person's data to another. The report states all three and books
zero credits.

## Run it

From the pack root. Spends nothing, calls nothing, writes one file.

```bash
ROOT=/path/to/project node --input-type=module -e "${GTM_COST:?set this to the gtm-cost-optimizer script below}"
```

where `$GTM_COST` is the script below. Write it to a file and run it if that is easier;
it is the same script either way.

```js
// ==== gtm-cost-optimizer v1 ====
// Where the credits went, from the real ledger. ZERO API calls.
// Run from the pack root.
//
// The whole design is "do not compute a saving; ask the receipt to price a line set".
// This file selects ledger lines and explains why they were selected. Every credit
// figure it prints came out of buildReceipt over exactly the lines cited, and three
// uncaught assertions stand between a selection and a rendered report.
//
// env: ROOT        project root holding gtm/   (default .)
//      OUT         report path                 (default gtm/cost/optimizer.md)
//      GATES_FILE / CATALOG_FILE / NOW         (test seams)
//
// exit 0 = report written · 2 = nothing to analyse · 3 = a gate key is missing

import fs from 'node:fs';
import path from 'node:path';
import { Ledger } from './_lib/ledger.mjs';
import { buildReceipt, assertNeverOverstates } from './_lib/receipt.mjs';
import { readJournal, summarize } from './_lib/journal.mjs';
import { loadGates, gateValue, cacheTtlDays, MissingGateKey } from './_lib/gates.mjs';

const ROOT = path.resolve(process.env.ROOT || '.');
const GTM = path.join(ROOT, 'gtm');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const gates = loadGates(process.env.GATES_FILE || undefined);
const die = (code, msg) => { console.error('cost-optimizer: ' + msg); process.exit(code); };
const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** A saving that claims more than the ledger can support. Never caught. */
class SavingOverstated extends Error {
  constructor (m) { super(m); this.name = 'SavingOverstated'; }
}

// --- inputs -----------------------------------------------------------------
const ledgerFile = path.join(GTM, 'api-calls.jsonl');
let LINES = [];
try {
  LINES = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch {
  die(2, 'no ledger at ' + ledgerFile + ' — nothing has been spent here yet, so there is '
    + 'nothing to optimise. That is a good problem.');
}
if (LINES.length === 0) die(2, 'the ledger is empty. Nothing to optimise.');

const catalogPath = process.env.CATALOG_FILE
  || path.join(path.resolve('.'), '_lib', 'api-catalog.json');
let CATALOG = { endpoints: {} };
try { CATALOG = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch {
  die(3, 'cannot read the catalog at ' + catalogPath
    + '. Prices come from the catalog and nowhere else, so without it there is no audit.');
}

// --- pricing a line set, by asking the receipt ------------------------------
//
// This is the ONLY place a credit figure is produced. It hands the cited lines to the
// same buildReceipt that prices a session receipt and runs the same never-overstate
// guard over them. No branch of this file adds, scales or rounds a credit itself.
function priceLines (idxs) {
  const lines = idxs.map((i) => LINES[i]);
  const led = Object.assign(new Ledger({ dir: GTM }), { lines });
  const r = buildReceipt({ ledger: led, gates });
  assertNeverOverstates(r, led);            // deliberately not wrapped in a try
  return {
    floor: r.credits_floor,
    ceiling: r.credits_ceiling,
    exact: r.exact,
    calls: r.calls,
    unverifiable_lines: r.unverifiable_lines,
  };
}

/** How a saving is allowed to be spoken about. One place, so no finding invents wording. */
function savingPhrase (s) {
  if (s.ceiling === 0) return 'No credits were charged on these calls, so there is nothing to save.';
  if (s.exact) return 'Saves ' + s.floor + ', verified against the charge the API reported.';
  if (s.floor === 0) {
    return 'Saves at most ' + s.ceiling + ' — ESTIMATE. None of these ' + s.unverifiable_lines
      + ' call(s) report their charge, so the ledger can prove none of this saving.';
  }
  return 'Saves at least ' + s.floor + ', at most ' + s.ceiling + ' — PART ESTIMATE. '
    + s.unverifiable_lines + ' of ' + s.calls + ' call(s) do not report a charge.';
}

// --- thresholds, read and never typed ---------------------------------------
// Fail closed: a missing key is a STOP, not "no threshold" (law 5). These two
// skills.cost_optimizer.* keys resolve in _lib/gates.yaml and are cited in the prose
// above in their gates.yaml: form; here they are bare because the argument to
// gateValue() is a key path, not a citation.
let MIN_EVIDENCE, MIN_SAVING;
try {
  MIN_EVIDENCE = Number(gateValue(gates, 'skills.cost_optimizer.min_evidence_calls'));
  MIN_SAVING = Number(gateValue(gates, 'skills.cost_optimizer.min_saving_credits'));
} catch (err) {
  if (err instanceof MissingGateKey) {
    die(3, err.message + '\n  A missing gate key is a STOP, not "no gate" (law 5). Without a '
      + 'noise floor this skill would report a pattern seen once as a recommendation, which '
      + 'is how a flywheel becomes a superstition.');
  }
  throw err;
}

// --- the whole-ledger receipt, which bounds everything below ----------------
const allLedger = Object.assign(new Ledger({ dir: GTM }), { lines: LINES });
const total = buildReceipt({ ledger: allLedger, gates });
assertNeverOverstates(total, allLedger);

// A line only counts as evidence if the ledger says it was CHARGED. `known_zero` is a
// non-2xx, which the billing rule says deducts nothing; a saving on those is a saving
// on money that was never spent.
const charged = (l) => l.cost_status === 'actual' || l.cost_status === 'estimated_unverifiable';

// --- findings ---------------------------------------------------------------
//
// Findings are evaluated in order and each one may only claim a ledger line no earlier
// finding claimed. This is not tidiness; it is the whole anti-double-count discipline.
// Overlap is REAL in real data — a hop that never hits is often also a hop whose
// results were bought again next week — so the second finding must lose the credit
// rather than the report gaining it. The overlap is disclosed rather than swallowed:
// the reader is told a finding was reduced and by how much.
const findings = [];
const claimed = new Set();
const addFinding = (f) => {
  const raw = [...new Set(f.evidence)];
  const evidence = raw.filter((i) => !claimed.has(i));
  const overlap = raw.length - evidence.length;
  if (evidence.length < MIN_EVIDENCE) return;
  const saving = priceLines(evidence);
  if (saving.ceiling < MIN_SAVING) return;
  for (const i of evidence) claimed.add(i);
  findings.push({ ...f, evidence, overlap, detail: f.detail(evidence.length) , saving });
};

// Finding: repeat purchases inside the endpoint's own cache window.
{
  const byKey = new Map();
  LINES.forEach((l, i) => {
    if (!charged(l) || l.row_id === null || l.row_id === undefined) return;
    const k = l.endpoint + '\u001f' + l.row_id;
    (byKey.get(k) ?? byKey.set(k, []).get(k)).push(i);
  });
  const evidence = [];
  const endpoints = new Set();
  let pairs = 0;
  for (const [k, idxs] of byKey) {
    if (idxs.length < 2) continue;
    const endpoint = k.split('\u001f')[0];
    let ttlDays = null;
    const d = cacheTtlDays(gates, { endpoint });
    if (d.decision !== 'stop') ttlDays = d.ttl_days;
    if (!ttlDays) continue;                       // 0d means never cached, by policy
    const sorted = idxs.slice().sort((a, b) => Date.parse(LINES[a].ts) - Date.parse(LINES[b].ts));
    for (let n = 1; n < sorted.length; n += 1) {
      const gapDays = (Date.parse(LINES[sorted[n]].ts) - Date.parse(LINES[sorted[n - 1]].ts)) / 86400000;
      if (!Number.isFinite(gapDays) || gapDays > ttlDays) continue;
      evidence.push(sorted[n]);
      endpoints.add(endpoint);
      pairs += 1;
    }
  }
  addFinding({
    id: 'cache_ttl_unused',
    title: 'Paid twice for a fact the cache TTL says had not moved',
    detail: (n) => n + ' repeat charge(s) across ' + [...endpoints].join(', ')
      + ' (' + pairs + ' found). Each was charged again inside that endpoint\'s own TTL '
      + 'from the gate file, so the read-through cache should have answered it for nothing.',
    fix: 'Check for --no-cache, and for runs pointed at a different --dir or project root: '
      + 'the cache lives in the state tree, so moving the tree loses the hits, not the data.',
    evidence,
  });
}

// Finding: hops that were charged and never produced anything, per run (never across runs).
{
  const runsDir = path.join(GTM, 'runs');
  let files = [];
  try { files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
  const evidence = [];
  const dead = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, '');
    let units;
    try { units = summarize(readJournal(path.join(runsDir, f)).lines); } catch { continue; }
    const perHop = new Map();
    for (const u of units.values()) {
      const k = u.hop + '\u001f' + u.endpoint;
      const b = perHop.get(k) ?? { hop: u.hop, endpoint: u.endpoint, attempts: 0, ok: 0 };
      b.attempts += 1;
      if (u.status === 'ok') b.ok += 1;
      perHop.set(k, b);
    }
    for (const b of perHop.values()) {
      if (b.ok !== 0 || b.attempts === 0) continue;
      const idxs = [];
      LINES.forEach((l, i) => {
        if (l.run_id === runId && l.hop === b.hop && l.endpoint === b.endpoint && charged(l)) idxs.push(i);
      });
      if (idxs.length === 0) continue;   // charged nothing: a non-2xx is not billed
      evidence.push(...idxs);
      dead.push(b.endpoint + ' (hop ' + b.hop + ', run ' + runId + ')');
    }
  }
  addFinding({
    id: 'dead_hop',
    title: 'A hop that was charged and returned nothing',
    detail: (n) => dead.join('; ') + '. Every unit at these hops finished without a result, '
      + 'and the ledger still carries ' + n + ' charged line(s) for them.',
    fix: 'Drop the hop from the waterfall, or move it behind a condition so it only fires '
      + 'where the input it needs is present. Re-dry-run before you re-run: the plan will '
      + 'show the difference before you pay for it.',
    evidence,
  });
}

// Finding: pages that came back empty and were charged anyway.
{
  const evidence = [];
  const endpoints = new Set();
  LINES.forEach((l, i) => {
    if (!charged(l)) return;
    if (l.result_count !== 0) return;            // null is UNKNOWN, not none
    const p = CATALOG.endpoints?.[l.endpoint]?.pricing;
    if (!p || (p.model !== 'base_plus_per_result' && p.model !== 'per_result')) return;
    evidence.push(i);
    endpoints.add(l.endpoint);
  });
  addFinding({
    id: 'empty_pages',
    title: 'Pages bought that returned no rows',
    detail: (n) => n + ' charged call(s) to ' + [...endpoints].join(', ')
      + ' reported zero results. On a base-plus-per-result price the base is charged anyway.',
    fix: 'The runtime already stops a walk when a page comes back short. If these came from '
      + '--all-pages, that override is what they cost.',
    evidence,
  });
}

// Finding: the same unit charged more than once inside one run.
{
  const seen = new Map();
  const evidence = [];
  LINES.forEach((l, i) => {
    if (!charged(l) || l.row_id === null || l.row_id === undefined) return;
    const k = [l.run_id, l.row_id, l.hop, l.endpoint].join('\u001f');
    if (seen.has(k)) evidence.push(i); else seen.set(k, i);
  });
  addFinding({
    id: 'double_charged_unit',
    title: 'The same unit charged more than once in one run',
    detail: (n) => n + ' duplicate charge(s). This is the orphan shape a killed run leaves '
      + 'behind: the pack cannot know whether the server billed the interrupted call, so a '
      + 'resume may pay for it again.',
    fix: 'Resume rather than re-run, and treat a run killed mid-call as suspect spend — the '
      + 'journal reports it as such rather than leaving it to the invoice.',
    evidence,
  });
}

// --- the three guards, none of them caught ----------------------------------
// (1) is inside priceLines, per finding. (2) and (3) are here.
const owner = new Map();
for (const f of findings) {
  for (const i of f.evidence) {
    if (owner.has(i)) {
      throw new SavingOverstated('ledger line ' + i + ' is cited by both "' + owner.get(i)
        + '" and "' + f.id + '". Adding both savings would count the same credit twice, '
        + 'which is how a savings report exceeds the run it audits.');
    }
    owner.set(i, f.id);
  }
}
const unionIdx = [...owner.keys()].sort((a, b) => a - b);
const unionSaving = unionIdx.length ? priceLines(unionIdx)
  : { floor: 0, ceiling: 0, exact: true, calls: 0, unverifiable_lines: 0 };
if (unionSaving.ceiling > total.credits_ceiling + 1e-9) {
  throw new SavingOverstated('total identified saving (' + unionSaving.ceiling
    + ') exceeds what the whole ledger can support (' + total.credits_ceiling + ')');
}
const sumCeilings = round(findings.reduce((s, f) => s + f.saving.ceiling, 0));
if (sumCeilings > unionSaving.ceiling + 1e-6) {
  throw new SavingOverstated('the findings sum to ' + sumCeilings + ' but their union is only '
    + unionSaving.ceiling + ' — a line is being counted twice');
}

// --- catalog-derived notes that book NO saving ------------------------------
const bulkNotes = [];
for (const [name, def] of Object.entries(CATALOG.endpoints ?? {})) {
  if (!def.bulk_variant) continue;
  if (!LINES.some((l) => l.endpoint === name && charged(l))) continue;
  const single = def.pricing ?? {};
  const bulk = CATALOG.endpoints?.[def.bulk_variant]?.pricing ?? {};
  bulkNotes.push({
    endpoint: name,
    bulk: def.bulk_variant,
    max_batch: def.max_batch,
    single_price: JSON.stringify({ model: single.model, per_call: single.credits_per_call,
      per_result: single.credits_per_result }),
    bulk_price: JSON.stringify({ model: bulk.model, per_call: bulk.credits_per_call,
      per_result: bulk.credits_per_result }),
    single_verifiable: single.billing_field_present_in_response === true,
    bulk_verifiable: bulk.billing_field_present_in_response === true,
  });
}

// --- render -----------------------------------------------------------------
const L = [];
L.push('# Where the credits went');
L.push('');
L.push('Ledger: ' + ledgerFile + ' · ' + LINES.length + ' line(s) · read ' + NOW.toISOString());
L.push('');
L.push('## What was spent');
L.push('');
L.push('- floor (the ledger can prove this): ' + total.credits_floor);
L.push('- ceiling (the honest upper bound):  ' + total.credits_ceiling);
L.push('- calls: ' + total.calls + ', of which ' + total.unverifiable_lines
  + ' do not report their charge');
L.push('');
if (!total.exact) {
  L.push('This is a RANGE and stays one. ' + total.unverifiable_lines + ' of ' + total.calls
    + ' call(s) hit an endpoint that never reports its charge, so for those the pre-call '
    + 'estimate is the only number that will ever exist. Every saving below inherits that: '
    + 'a saving against an unverifiable line has a floor of zero, because the ledger cannot '
    + 'prove the credit was charged in the first place.');
  L.push('');
}
L.push('| endpoint | calls | verified | estimated |');
L.push('|---|---|---|---|');
for (const [ep, e] of Object.entries(total.by_endpoint).sort((a, b) => b[1].calls - a[1].calls)) {
  L.push('| ' + ep + ' | ' + e.calls + ' | ' + round(e.verified) + ' | ' + round(e.unverifiable) + ' |');
}
L.push('');

L.push('## What to do about it');
L.push('');
if (findings.length === 0) {
  L.push('Nothing found that clears the evidence and saving floors in the gate file. That is '
    + 'a real result, not an empty one: a pattern seen once is not a recommendation, and a '
    + 'saving below the noise floor costs more attention than it returns.');
} else {
  L.push('Total identified: ' + savingPhrase(unionSaving).replace(/^Saves/, 'saves'));
  L.push('');
  L.push('That total is the UNION of the evidence below, not the sum of the rows. Two '
    + 'findings that touch the same charged call are counted once.');
  L.push('');
  for (const f of findings) {
    L.push('### ' + f.title);
    L.push('');
    L.push('**' + savingPhrase(f.saving) + '**');
    L.push('');
    L.push(f.detail);
    L.push('');
    L.push('- evidence: ' + f.evidence.length + ' ledger line(s) — ' + f.saving.calls
      + ' charged call(s), ' + f.saving.unverifiable_lines + ' of them unverifiable');
    if (f.overlap > 0) {
      L.push('- reduced: ' + f.overlap + ' more line(s) match this pattern but were already '
        + 'claimed by a finding above. A credit is counted once, by the first finding that '
        + 'claims it, so this saving is smaller than the pattern alone would suggest.');
    }
    L.push('- fix: ' + f.fix);
    L.push('');
  }
}

if (bulkNotes.length > 0) {
  L.push('## Bulk variants — no credit saving, and a cost in certainty');
  L.push('');
  L.push('| endpoint | bulk form | single price | bulk price | charge readable, single | charge readable, bulk |');
  L.push('|---|---|---|---|---|---|');
  for (const b of bulkNotes) {
    L.push('| ' + b.endpoint + ' | ' + b.bulk + ' | ' + b.single_price + ' | ' + b.bulk_price
      + ' | ' + (b.single_verifiable ? 'yes' : 'no') + ' | ' + (b.bulk_verifiable ? 'yes' : 'no') + ' |');
  }
  L.push('');
  L.push('Read the two price columns before recommending a switch. Where they are equal the '
    + 'saving is zero and this report books zero; what batching buys is latency and less '
    + 'rate-limit exposure. Where the last two columns differ, batching also converts a '
    + 'verified actual into an estimate nobody can check — which is a cost, paid in the only '
    + 'currency an audit has.');
  L.push('');
}

L.push('## What this report is not');
L.push('');
L.push('Every figure above came from the ledger through the same receipt that prices a run. '
  + 'No saving here was computed against an invented actual, no ledger line is counted under '
  + 'two findings, and the total is bounded by the whole-ledger receipt. Nothing above was '
  + 'measured against what the run was WORTH — whether the data was useful is a human call, '
  + 'and a cheaper run that finds nothing is not an optimisation.');

const text = L.join('\n') + '\n';
const out = process.env.OUT || path.join(GTM, 'cost', 'optimizer.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, 'utf8');

console.log('spend      floor ' + total.credits_floor + ', ceiling ' + total.credits_ceiling
  + ' over ' + total.calls + ' call(s)');
console.log('findings   ' + findings.length + (findings.length ? ' — ' + savingPhrase(unionSaving) : ''));
console.log('report     ' + out);
process.exit(0);
// ==== end gtm-cost-optimizer v1 ====
```

## Report it the way the file is written

- **Lead with the range, not the ceiling.** If the report says *floor 12, ceiling 96*,
  the spend is not "about 96". Quote both and say how many lines cannot be verified.
- **Read each saving with its label.** `ESTIMATE` and `PART ESTIMATE` are not decoration.
  A saving whose floor is zero is a saving nobody can prove, and the user is entitled to
  weigh it accordingly before rewriting a workflow around it.
- **Give the total as the union.** Do not add the findings up yourself. The script
  already refused to, and for the reason it states.
- **Name the evidence.** Every recommendation carries a ledger line count. A
  recommendation without one is not from this skill.
- **A cheap run that finds nothing is not an optimisation.** Pair any change with
  `/measure` on the next run: coverage first, then the money.

## What this skill will not do

- **It will not make an API call.** Zero, metered or free. Auditing spend by spending
  would be its own first finding.
- **It will not fabricate an actual.** Eleven metered endpoints never report their
  charge. Those lines stay `estimated_unverifiable`, savings against them have a floor of
  zero, and `assertNeverOverstates` throws rather than let a friendlier convention
  through. The script does not catch it.
- **It will not let two findings claim the same credit.** Where a charged call matches
  two patterns the later finding loses it and the report says it was reduced. The
  no-double-claim invariant is then asserted, and a violation throws before anything is
  written. Double-counting is the specific way a savings report exceeds the run it
  audits.
- **It will not claim a credit saving for batching.** The catalog prices the single and
  bulk forms the same. It reports the latency win, the accountability loss, and zero
  credits.
- **It will not join two runs' journals.** The unit key is unique within a run only.
  Money is summed from the ledger; hit rates are computed per run.
- **It will not put a contact in the report.** Row identifiers are used only as grouping
  keys and are never printed — the same discipline the share renderer applies.
- **It will not change anything.** It reads the ledger and writes a markdown file. It
  does not edit a workflow, disable an endpoint, or clear a cache; those are decisions
  with consequences and they stay with the user.
- **It will not tell you whether the spend was worth it.** It can tell you what was
  charged and what it produced. Whether that was a good trade is not a number the pack
  holds.
- **It will not price a send, a reply or a meeting.** Sending execution, LinkedIn
  actions, dialing and direct mail are outside the pack permanently, so cost-per-outcome
  needs counts the operator supplies — `/measure` is where that lives, labelled
  self-reported.

## Related

- [`/measure`](../measure/SKILL.md) — one run, coverage first, then the same honest
  spend range; this skill is the cross-run money view
- [`/scheduled-workflow`](../scheduled-workflow/SKILL.md) — where recurring spend is
  bounded before it happens, rather than audited after
- [`/signal-watch`](../signal-watch/SKILL.md) — the pack's standing charge; a recurring
  watch is usually the largest single line in this report
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the dry-run plan is where a
  saving is realised; findings here are hypotheses until a plan proves them
- [`/learn`](../learn/SKILL.md) — turns hop hit rates into a better provider order,
  locally and without adding a hop
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt
- `richapi gates` prints every threshold and the key it comes from
