---
name: learn
version: 1.0.0
description: >
  The local learnings flywheel. Records aggregate provider and hop hit rates from a run
  journal into gtm/learnings.jsonl, and applies them as decayed, attributed priors so
  the next run starts better than the last. Use when asked "remember what worked",
  "which provider wins", "apply what we learned", "reorder the waterfall", or "what do
  we know so far". Strictly local: no server, no upload, no consent toggle, no network
  call of any kind. Makes zero API calls. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - remember what worked
  - which provider wins
  - apply what we learned
  - reorder the waterfall
  - what do we know so far
  - learnings
---

# Learn from a run, locally

The pack gets better by remembering which hops and which providers actually found
things, and by saying so out loud the next time it plans a run. That is the whole
skill. It records aggregates, it decays them, and it hands the next run an *ordering*
with an attribution line attached.

## Local means local

There is no network in this skill and there is no place to add one. It reads a run
journal on this machine and appends to a file on this machine. It does not upload, does
not fetch a snapshot, does not ask for consent to share, and does not depend on a server
being up, reachable, or built.

That is not a temporary state pending a client. `docs/designs/networked-learnings.md`
examined the networked version and its own conclusions constrain this file:

- **Copy, templates, replies and conversions are never networked** — the pack cannot
  observe them, and copy is the operator's competitive asset. Locally they are also out
  of scope here for a simpler reason: the journal does not carry them, and this skill
  only records what the journal already holds.
- **A prior may re-rank hops inside an already-approved plan and nothing else.** It may
  not add a hop, remove one the user approved, change an endpoint, or take effect after
  approval. A learning that can change what a run costs is a paid call nobody named,
  which is the one law this pack does not bend.
- **A prior is advisory and always attributed.** "Prior learning applied: X" is printed
  next to the change, before approval, or the prior does not apply.

The fine-grained per-segment index in that note is not "later", it is no. Nothing on
this page builds toward it.

## Inference mode — local

Local inference only. **Zero API calls**, and `ai_enrich` is never called. Ranking a
handful of hit rates is division; the pack already runs inside an agent that can do
that for free, and paying an endpoint to rank your own history would be a credit spent
to learn nothing new.

## Before anything else

```bash
richapi-skills-preflight
```

Nothing here can be blocked by it, and that is worth stating rather than skipping.
`API_KEY_SET: no` is irrelevant — no call is made. `BALANCE: unknown` is irrelevant —
nothing is spent. There is **no `richapi learn` verb**; the runtime ships `enrich`,
`call`, `search`, `preflight`, `catalog` and `gates`. This is the script below.

## What gets written, and what can never get in

`gtm/learnings.jsonl`, append-only, one JSON line per observation. Each line is a
**count, a rate and a timestamp** — never a contact.

That is guaranteed by construction, not by filtering. The observations are read off the
pack's aggregate share renderer, which builds counts, sums and percentages from journal
metadata and never copies a journal line; `row_id` is used only as a set key inside it
and is never emitted. Every line this skill writes is then re-inspected by the same
`assertAggregateOnly` gate before it touches disk, so a row-shaped key or a
contact-shaped value throws instead of landing in a file that outlives the run.

`gtm/` is PII by law, so this file is gitignored, TTL-swept and erasable like everything
else under it — even though by design there is nothing in it to erase.

## Step 1 — record what a run learned

```bash
ROOT=/path/to/project RUN=run-2026-08-28-abc MODE=record node --input-type=module -e "${GTM_LEARN:?set this to the gtm-learn script below}"
```

where `$GTM_LEARN` is the script below, in both modes. Write it to a file and run it if
that is easier; it is the same script either way.

Recording is idempotent per run: a second record pass over the same run appends nothing,
so re-running it cannot inflate a denominator.

## Step 2 — apply what is known, with attribution

```bash
ROOT=/path/to/project MODE=apply HOPS=email_finder,find_personal_email node --input-type=module -e "${GTM_LEARN:?set this to the gtm-learn script below}"
```

`HOPS` is the set of hops the user has **already approved**. The output is that same set
in a different order, plus one attribution line per reordering. If the ordering it
returns is not a permutation of what you gave it, something is wrong — throw the result
away and say so.

Three keys decide whether any prior is allowed to move anything, and the script reads
all three rather than carrying any of them:
`gates.yaml:skills.learn.confidence_half_life_days` sets how fast an observation's
weight decays, so a provider that won six months ago does not outvote one that won last
week; `gates.yaml:skills.learn.min_observations_to_apply` is the decayed-n floor, below
which a thin sample may not steer a paid run; and
`gates.yaml:skills.learn.min_confidence_to_apply` requires the newest observation's own
decay weight to clear a floor, so a fully decayed history cannot re-rank on the strength
of its age alone. If any of the three cannot be read, the APPLY path fails closed and
the approved order stands.

## The script

```js
// ==== gtm-learn v1 ====
// The local learnings flywheel. ZERO API calls, ZERO network. Run from the pack root.
//
// There is no fetch, no http, no https, no net, no dns and no child process in this
// file, and there is no URL in it either. That is asserted by the test suite at the
// source level as well as at runtime, because "learnings" is a word that grows an
// uploader the moment nobody is watching.
//
// env: ROOT  (default .)      project root holding gtm/
//      MODE  record | apply | both      (default record)
//      RUN   (record: default newest journal under gtm/runs/)
//      HOPS  (apply: comma-separated endpoints already approved by the user)
//      FILE  (default gtm/learnings.jsonl)
//      GATES_FILE (alternate gates.yaml; test seam)
//      NOW   (ISO instant; test seam)
//      JSON  ("1" prints the apply result as JSON)
//
// exit 0 = done (including "recorded but not applied") · 2 = nothing to read

import fs from 'node:fs';
import path from 'node:path';
import { readJournal } from './_lib/journal.mjs';
import { renderShareable, assertAggregateOnly } from './_lib/share-render.mjs';
import { loadGates, gateValue, MissingGateKey } from './_lib/gates.mjs';

const ROOT = path.resolve(process.env.ROOT || '.');
const GTM = path.join(ROOT, 'gtm');
const FILE = process.env.FILE || path.join(GTM, 'learnings.jsonl');
const MODE = (process.env.MODE || 'record').toLowerCase();
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const SCHEMA_VERSION = 1;
const gates = loadGates(process.env.GATES_FILE || undefined);

// Gate keys this skill needs. All three resolve in gates.yaml under skills.learn and
// are cited in the prose in their gates.yaml: form; here they are bare because each
// value is a key path handed to gateValue(). If one ever stops resolving the read
// throws MissingGateKey and the APPLY path fails closed (law 5) with the key named.
// Recording needs none of them: writing down what happened is never the risky half.
const KEYS = {
  half_life_days: 'skills.learn.confidence_half_life_days',
  min_observations: 'skills.learn.min_observations_to_apply',
  min_confidence: 'skills.learn.min_confidence_to_apply',
};

const readLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
};

// --- record ----------------------------------------------------------------

function newestRun () {
  const dir = path.join(GTM, 'runs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  for (const n of names) {
    const st = fs.statSync(path.join(dir, n));
    if (!best || st.mtimeMs > best.mtimeMs) best = { id: n.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
  }
  return best?.id ?? null;
}

function record () {
  const runId = process.env.RUN || newestRun();
  if (!runId) { console.error('learn: no run journal under ' + path.join(GTM, 'runs')); process.exit(2); }
  const journalPath = path.join(GTM, 'runs', runId + '.jsonl');
  if (!fs.existsSync(journalPath)) { console.error('learn: no journal for run "' + runId + '"'); process.exit(2); }

  let catalog = null;
  try { catalog = JSON.parse(fs.readFileSync('./_lib/api-catalog.json', 'utf8')); } catch { catalog = null; }

  const journal = readJournal(journalPath);
  // Aggregate-only by construction: counts and rates the renderer computed itself.
  const share = renderShareable(journal.lines, {
    catalog, runIdLabel: runId, now: () => NOW.toISOString(),
  });

  const observed = [];
  for (const p of share.providers) {
    if (p.attempts <= 0) continue;
    observed.push({
      schema_version: SCHEMA_VERSION,
      kind: 'provider_hit_rate',
      key: 'provider:' + p.provider,
      run_id: share.run_id,
      observed_at: NOW.toISOString(),
      n: p.attempts,
      hits: p.ok,
      hit_rate_pct: p.hit_rate_pct,
      mean_confidence: p.mean_confidence,
    });
  }
  for (const h of share.per_hop) {
    const n = h.completed + h.failed;
    if (n <= 0) continue;
    observed.push({
      schema_version: SCHEMA_VERSION,
      kind: 'hop_hit_rate',
      key: 'endpoint:' + h.endpoint,
      run_id: share.run_id,
      observed_at: NOW.toISOString(),
      hop: h.hop,
      n,
      hits: h.completed,
      hit_rate_pct: h.hit_rate_pct,
    });
  }

  // The read-side PII gate, applied to the exact objects that are about to be written.
  assertAggregateOnly({ observations: observed });

  // Append-only, and idempotent per run: never rewrite, never double-count.
  const existing = readLines(FILE);
  const seen = new Set(existing.map((l) => l.kind + '|' + l.key + '|' + l.run_id));
  const fresh = observed.filter((o) => !seen.has(o.kind + '|' + o.key + '|' + o.run_id));
  if (fresh.length > 0) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, fresh.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  }
  console.log('recorded   ' + fresh.length + ' observation(s) from run ' + share.run_id
    + (fresh.length < observed.length ? '  (' + (observed.length - fresh.length) + ' already recorded)' : ''));
  console.log('file       ' + FILE);
  return { run_id: share.run_id, written: fresh.length, skipped: observed.length - fresh.length };
}

// --- apply -----------------------------------------------------------------

const DAY_MS = 86400000;

function apply () {
  const hops = String(process.env.HOPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = readLines(FILE);

  let halfLife, minObs, minConf;
  try {
    halfLife = Number(gateValue(gates, KEYS.half_life_days));
    minObs = Number(gateValue(gates, KEYS.min_observations));
    minConf = Number(gateValue(gates, KEYS.min_confidence));
  } catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    const out = {
      applied: false,
      failed_closed: true,
      reason: e.message + ' — failing closed (law 5). Nothing was re-ranked.',
      missing_key: e.key,
      required_keys: Object.values(KEYS),
      ordering: hops,          // unchanged: exactly what was approved
      attribution: [],
    };
    report(out);
    return out;
  }

  // Decayed confidence. An observation's weight halves every half-life, so a provider
  // that won six months ago does not outvote one that won last week.
  const agg = new Map();
  for (const r of rows) {
    const age = (NOW.getTime() - Date.parse(r.observed_at)) / DAY_MS;
    if (!Number.isFinite(age)) continue;
    const w = Math.pow(0.5, Math.max(0, age) / halfLife);
    const cur = agg.get(r.key) ?? { key: r.key, kind: r.kind, weighted_n: 0, weighted_hits: 0, raw_n: 0, raw_hits: 0, runs: new Set(), newest_weight: 0 };
    cur.weighted_n += r.n * w;
    cur.weighted_hits += r.hits * w;
    cur.raw_n += r.n;
    cur.raw_hits += r.hits;
    cur.runs.add(r.run_id);
    cur.newest_weight = Math.max(cur.newest_weight, w);
    agg.set(r.key, cur);
  }

  const scored = new Map();
  for (const a of agg.values()) {
    const enough = a.weighted_n >= minObs;
    const confident = a.newest_weight >= minConf;
    scored.set(a.key, {
      ...a,
      runs: a.runs.size,
      rate: a.weighted_n > 0 ? a.weighted_hits / a.weighted_n : 0,
      usable: enough && confident,
      why_not: enough ? (confident ? null : 'every observation has decayed below the confidence floor')
        : 'not enough decayed observations to support a re-rank',
    });
  }

  // The ordering is a PERMUTATION of what was approved. Nothing is added, nothing is
  // dropped, no endpoint is substituted — so the plan's cost cannot move.
  const keyed = (ep) => scored.get('endpoint:' + ep);
  const ordering = [...hops].sort((a, b) => {
    const A = keyed(a), B = keyed(b);
    const ua = A?.usable ? A.rate : -1;
    const ub = B?.usable ? B.rate : -1;
    if (ub !== ua) return ub - ua;
    return hops.indexOf(a) - hops.indexOf(b);
  });

  const attribution = [];
  for (const ep of ordering) {
    const s = keyed(ep);
    if (!s?.usable) continue;
    if (ordering.indexOf(ep) === hops.indexOf(ep)) continue;
    attribution.push('Prior learning applied: ' + ep + ' moved from position ' + (hops.indexOf(ep) + 1)
      + ' to ' + (ordering.indexOf(ep) + 1) + ' — ' + s.raw_hits + '/' + s.raw_n
      + ' observed across ' + s.runs + ' run(s), decayed hit rate '
      + Math.round(s.rate * 1000) / 10 + '%.');
  }

  const out = {
    applied: attribution.length > 0,
    failed_closed: false,
    reason: attribution.length > 0
      ? 'advisory re-rank inside the approved hop set'
      : 'no prior cleared the observation and confidence floors; the approved order is unchanged',
    ordering,
    attribution,
    unchanged: JSON.stringify(ordering) === JSON.stringify(hops),
    considered: [...scored.values()].map((s) => ({
      key: s.key, kind: s.kind, runs: s.runs, raw_n: s.raw_n, raw_hits: s.raw_hits,
      decayed_hit_rate_pct: Math.round(s.rate * 1000) / 10,
      decayed_n: Math.round(s.weighted_n * 100) / 100,
      usable: s.usable, why_not: s.why_not,
    })),
  };
  report(out);
  return out;
}

function report (out) {
  if (process.env.JSON === '1') { console.log(JSON.stringify(out, null, 2)); return; }
  if (out.failed_closed) {
    console.log('apply      NOT APPLIED — ' + out.reason);
    console.log('           needs: ' + out.required_keys.join(', '));
  } else {
    console.log('apply      ' + (out.applied ? 're-ranked' : 'unchanged') + ' — ' + out.reason);
  }
  console.log('order      ' + (out.ordering.length ? out.ordering.join(' -> ') : '(none given)'));
  for (const a of out.attribution) console.log('  ' + a);
}

if (MODE === 'record' || MODE === 'both') record();
if (MODE === 'apply' || MODE === 'both') apply();
// ==== end gtm-learn v1 ====
```

## Step 3 — show the prior before the plan is approved

A prior that appears after approval is a change the user did not agree to. So:

- Print the attribution lines **in the dry-run plan**, next to the hop that moved.
- If the apply step reports `failed_closed`, say so plainly: name the gate key it could
  not read, and say that nothing was re-ranked and the approved order stands. That is
  the correct outcome, not a bug to work around, and it is never worked around by typing
  a number in here instead.
- If no prior cleared the floors, say that too. "We do not know yet" is a real answer
  and it is the honest one for the first several runs on a fresh install.
- Never present a prior as a guarantee. It is a decayed average over a handful of runs
  on one machine, and it says so.

## What this skill will not do

- **It will not talk to a server.** No upload, no download, no consent toggle, no queue,
  no "it will sync later". There is no network client in this skill and adding one is a
  separate, gated decision that this page does not anticipate.
- **It will not make an API call.** Zero, metered or free. Nothing here spends.
- **It will not change what a run costs.** A prior re-ranks hops inside a set the user
  already approved. It cannot add a hop, drop a hop, swap an endpoint, or apply after
  approval. If it ever returns something that is not a permutation of what it was given,
  discard it.
- **It will not record anything row-level.** Observations are counts and rates built
  from journal metadata by the pack's aggregate renderer and re-checked before they are
  written. No contact, no row identifier, no response body, ever.
- **It will not learn from copy, templates, replies or conversions.** The pack cannot
  observe them (sending is external forever), so anything it "learned" about them
  would be a number with no source.
- **It will not apply a prior without the thresholds.** A missing gate key reads as
  STOP, not as "no gate". The decay half-life, the observation floor and the confidence
  floor come from the gate file or the re-rank does not happen.
- **It will not decide for you.** The ordering is advisory and attributed. The user
  approves the plan.

## Related

- [`/measure`](../measure/SKILL.md) — the report these observations come out of; run it
  first
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the run that produces the
  journal, and the plan a prior may re-rank inside
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router
- `richapi gates` prints every threshold and the key it comes from
