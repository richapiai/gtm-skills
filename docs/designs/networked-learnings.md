# Networked learnings: design note

**Status:** design complete, **NOT cleared to build as specified**. This note gates any
implementation of networked learnings, including a pack-side API client. No code for it
may be written until this note is reviewed and its preconditions (§9) are met. Nothing in
the shipped pack depends on it.

> **Headline.** "Networked learnings" is two different products wearing one name. One of them
> (a hit-rate index built from RichAPI's **own server-side API logs**) is buildable,
> cheap, and carries almost none of the risk this note was commissioned to examine. The
> other (a client-uploaded, fine-grained, per-segment index) is **statistically dead at
> any install count this pack will plausibly reach**, and buys signal the server can
> already derive. This note recommends building the first, deferring the second behind a
> measurement, and cancelling three pieces outright (§8).

## Source convention (law 6)

Every claim below is tagged. `src:` = verified against a file or a recorded measurement
in this repo. `assert:` = my judgement or an outside convention, stated as such and
therefore contestable. There are no untagged claims.

---

## 1. What networked learnings is, restated precisely

These constraints are already decided and are not re-litigated here:

- A RichAPI-hosted index aggregates anonymized provider hit-rates across installs.
- Contributions are **strip-mined client-side** — aggregate rows only; raw
  `learnings.jsonl` lines never leave the machine.
- Contribution consent is a **separate toggle** from usage telemetry.
- Uploads **queue and warn but never wedge a run**.
- Ships only after the pack itself is published and in use.
- It is RichAPI's **first write endpoint**; auth, abuse and schema governance are new
  server scope.

Those six are constraints on the design, not questions the design gets to reopen. What
follows is everything they leave open.

### 1.1 The keystone rule, stated once

> **Local evidence always outranks network evidence.** A network prior is consulted only
> for a `(segment, endpoint)` pair where the local journal holds fewer than
> `LOCAL_N_FLOOR = 30` terminal observations. At 30 it is dropped and never consulted for
> that pair again.

Everything hard about networked learnings is bounded by this one rule, so it is worth stating before the
mechanisms rather than after. Taxonomy drift, poisoning, staleness and a broken migration
all share the same blast radius: **an install with no local data, until it has some.**
An install that has run the waterfall thirty times in a segment is immune to every attack
in §4 by construction.

`30` is chosen to match the pack's existing habit of pre-committing a sample floor rather
than eyeballing one — the kill/scale bands use `min_n` floors of 50 and 30
— *src: `_lib/gates.yaml` `activation.*.min_n`*. — *assert: the specific value 30 is a judgement; it should be
tuned by the §9.3 experiment, not defended on principle.*

---

## 2. Data flow and the strip-mine boundary

```
  ONE INSTALL (the user's machine)                     │  RICHAPI (operator)
 ──────────────────────────────────────────────────────┼──────────────────────────────
                                                       │
  gtm/runs/{run-id}.jsonl          gtm/learnings.jsonl │
  the run journal:                 /learn:             │
   row_id, endpoint, status,        decayed confidence,│
   provider, confidence,            per-segment memory │
   credits_*, response_hash         ── NEVER UPLOADED  │
        │                                    ▲         │
        │                                    │         │
        ▼                                    │         │
  ┌─ strip-miner ──────────────────────────────────┐   │
  │ Reads counters only. Emits nothing it did not  │   │
  │ compute itself. Same construction as           │   │
  │ _lib/share-render.mjs, not a new one:          │   │
  │   (segment_key, endpoint, provider_enum)       │   │
  │      -> observations, hits                     │   │
  │ assertAggregateOnly() is the last statement.   │   │
  └────────────────────────────────────────────────┘   │
        │                                              │
        │  consent.networked_learnings === true ?       │
        │     queue  :  drop on the floor (no queue)    │
        ▼                                              │
  gtm/learnings-queue.jsonl                            │
  bounded: 512 rows / 1 MiB / 30 d, oldest evicted     │
        │                                              │
        │ END OF RUN ONLY. After the output file is    │
        │ written. Detached. 2 s connect / 5 s total.  │
        │ At most one attempt per run. Never retried   │
        │ inline. Any non-2xx = keep queued, continue. │
        └─── POST /v1/learnings/contribute ────────────┼──►  ingest
                                                       │       │
                                                       │       ▼
                                                       │  ANCHOR CHECK: does the
                                                       │  operator's own API log show
                                                       │  this account paying for
                                                       │  these calls in this epoch?
                                                       │  No  -> drop, count, alarm.
                                                       │       │
                                                       │       ▼
                                                       │  per-ACCOUNT cell rates
                                                       │  (cap 1000 obs/cell/epoch)
                                                       │       │
                                                       │       ▼
                                                       │  median across accounts,
                                                       │  published iff k>=5 accounts
                                                       │  AND n>=50 observations
                                                       │       │
  snapshot cache (7 d TTL,                             │       ▼
  stale-if-error, fail-open  ◄── GET /v1/learnings/ ───┼──  published snapshot
  to NO priors)                    snapshot            │    rates only, 2 s.f.,
        │                                              │    no counts, no account ids
        ▼                                              │
  prior applied ONLY where local n < 30                │
  journalled with the snapshot sha256                  │
  shown in the --dry-run diff BEFORE any spend         │
```

Two properties of that diagram are load-bearing and both are copied from work already
shipped rather than invented here:

1. **Aggregate-only by construction, not by filter.** `_lib/share-render.mjs` already
   solves the identical problem for the shareable run summary and states why: *"it must be aggregate-only BY
   CONSTRUCTION — not by filtering a row-level render, because a filter is one new field
   away from leaking and a construction is not"* — *src: `_lib/share-render.mjs` header*.
   The strip-miner must reuse that module's `assertAggregateOnly`, `FORBIDDEN_KEYS`
   and the `IDENTIFIER` token check, not re-implement them. A second implementation of
   the PII boundary is a second thing to get wrong. — *assert.*
2. **The upload is never on the critical path of a paid call.** It runs after the output
   file exists. An ingest outage therefore cannot stall a run, cannot cause a retry, and
   cannot produce a double-charge — the failure mode the journal exists to prevent
   — *src: `_lib/journal.mjs` header, "a 500-row phone pass at 25 credits/call is 12,500
   credits… a crash means paying twice"*.

---

## 3. The trust boundary — and the finding that reshapes the whole design

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BOUNDARY 1 — the machine                                            │
   │                                                                     │
   │ Never crosses: contact rows, emails, phones, domains, company       │
   │ names, row_ids, response bodies, response hashes, list keys,        │
   │ gtm/learnings.jsonl, anything in gtm/lists|research|copy|org-maps.  │
   │ Enforced by construction (§2), regression-tested like share-render. │
   └─────────────────────────────────────────────────────────────────────┘
                    │  crosses: (segment enum, endpoint, provider enum,
                    │            observations, hits, epoch, versions)
                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BOUNDARY 2 — the operator (RichAPI)                                 │
   │                                                                     │
   │ Sees: the above + the contributing account id.                      │
   │                                                                     │
   │ *** LEARNS NOTHING IT DID NOT ALREADY HAVE. ***                     │
   │ RichAPI served every one of those calls. It already logged the      │
   │ endpoint, the account, the provider that answered, and whether an   │
   │ email came back. The upload re-tells the operator its own logs.     │
   └─────────────────────────────────────────────────────────────────────┘
                    │  crosses: median-of-accounts rate, k>=5 accounts,
                    │           n>=50 obs, 2 significant figures,
                    │           NO counts, NO volumes, NO account ids
                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ BOUNDARY 3 — every other install                                    │
   │                                                                     │
   │ THE ONLY BOUNDARY THAT MATTERS. A competitor buys one seat and      │
   │ reads whatever we publish here. Every anonymization decision in     │
   │ §5 is a decision about this boundary and no other.                  │
   └─────────────────────────────────────────────────────────────────────┘
```

### 3.1 Finding: the client upload is mostly redundant

RichAPI is the provider of `email_finder`. The response carries `provider` and
`confidence`, and the pack journals them *because RichAPI returned them*
— *src: `_lib/client.mjs` `readAttribution()`, and `_lib/contracts/journal-line.schema.json`
`provider` description: "email_finder returns this; the input to /learn's per-segment
hit-rate memory"*.

So the operator can compute "which provider answers, at what rate, for what kind of
request" **from its own server logs, for every account, with no client, no consent
toggle, no strip-miner, no offline queue, and no upload endpoint.**

What the server genuinely cannot derive from its own logs:

| Signal | Server-derivable? | Why |
|---|---|---|
| provider hit-rate per endpoint | **Yes** | it served the call and returned the provider |
| hit-rate by request shape (domain vs name+company) | **Yes** | the request body is its own |
| waterfall hop ordering and where the waterfall stopped | Partly | it sees the call sequence per key, not the pack's intent |
| the user's **segment label** for a row | **No** | labelling happens in the pack, from the user's ICP |
| downstream verification outcome from a non-RichAPI verifier | **No** | never touches RichAPI |
| bounce/reply outcome after send | **No** | sending is deliberately external forever — *src: `ROADMAP.md`, Out of scope* |
| suppression rate per segment | **No** | the suppression store is local |

This splits networked learnings in two, and the split should be made explicit:

- **Tier A — server-derived.** Built from existing API logs. No new client code, no new
  privacy surface at boundary 1, no poisoning surface at all (§4.1), and it works on day
  one at full install count because it does not need contributions. It is not a "network
  effect" in the moat sense — it is RichAPI analysing its own traffic — but it delivers
  the user-visible outcome the idea exists for: *"install #10,000 starts smarter than
  install #1"*.
- **Tier B — client-contributed.** Only the four "No" rows above. This is the tier that
  needs consent, strip-mining, anonymization, poisoning defence and an offline queue —
  i.e. everything a pack-side client would have to build.

**Recommendation: build Tier A first and gate Tier B on Tier A proving the loop is worth
anything (§9.3).** — *assert: this is a design judgement, and it is the most consequential
one in this note. It removes roughly the whole of the pack-side client's scope.*

The rest of this note specifies Tier B in full anyway, because Tier B is what this note was
commissioned to make safe and because Tier A's publication side (§5, §7) is shared.

---

## 4. Data poisoning and the trust model

Concrete before general: a mitigation that is a promise to notice is not a mitigation.

### 4.1 Tier A: poisoning costs money at RichAPI's own price list

For Tier A the attacker cannot report anything. To move a number they must **make real
calls and pay for them**, and the operator observes the outcome itself rather than
accepting a claim about it.

`email_finder` is 5 credits per call — *src: `_lib/api-catalog.json`,
`email_finder.pricing.credits_per_call = 5`*. With the caps in §4.3:

| Attack | Accounts needed | Observations needed | Credits |
|---|---|---|---|
| move a cell at the k=5 floor | 3 (median of 5) | 3 × 1,000 | **15,000** |
| move a cell with 21 contributors | 11 | 11 × 1,000 | **55,000** |

Cost scales linearly with the cell's contributor count, is denominated in the operator's
own price list, is fully attributable to billed accounts, and buys the attacker only a
shift in an advisory prior that expires at 30 local observations (§1.1). — *assert: the
arithmetic is exact given the caps; whether it is a sufficient deterrent is a business
call, not an engineering one.*

### 4.2 Tier B: no un-anchored claim is ever aggregated

A client can lie for free. Therefore:

> **Hard requirement.** A contributed row is discarded unless the operator's own API log
> shows that account paying for a matching volume of matching calls in that epoch. A
> claim the server cannot anchor to a call it served is not aggregated, not stored, and
> not counted toward `k`.

This reduces Tier B poisoning to "pay for real calls, then lie about their downstream
outcome" — which is bounded by §4.1's cost table plus §4.3's estimator. It also kills the
cheapest attack outright: an attacker with a free key and a loop.

### 4.3 Bounded-influence aggregation

Three mechanisms, all mandatory:

1. **One account, one vote.** The cell value is the **median over contributing accounts**
   of that account's rate in the cell — never a pooled rate over raw observations. A
   pooled rate lets the highest-volume account own the number. The median has a 50%
   breakdown point: an adversary must control a majority of a cell's accounts to move it
   at all. — *src: standard robust-statistics property of the median; assert: applied here.*
2. **Per-account, per-cell, per-epoch observation cap** `CONTRIB_CAP = 1000`. Bounds cost
   per unit of influence and stops one heavy install dominating a cell's `n`.
3. **Publication floors** `k >= 5` contributing accounts **and** `n >= 50` observations,
   whichever binds later (§5).

### 4.4 Detection is the backstop, not the mitigation

Per-account **divergence** — distance from the cell median — is tracked per epoch (§7). A
coordinated push shows up as a growing tail of high-divergence accounts *before* it moves
the median, because moving the median requires a majority. That ordering is the only
reason detection is worth instrumenting at all. — *assert.*

### 4.5 What we cannot stop

**Sybil accounts.** `k >= 5 accounts` is not `k >= 5 organizations`. One company with five
funded API keys satisfies every threshold in this note, for both anonymity and poisoning.
The only lever is binding contribution eligibility to a **paid account with a payment
instrument**, which raises cost without changing the shape of the attack.
**This is an unsolved residual and must be written into the design's limitations, not
buried.** — *assert.*

### 4.6 Failure mode

| | |
|---|---|
| **What breaks** | A coarse cell's prior is wrong by up to the attacker's shift. |
| **What the user sees** | Nothing. Their first runs in that segment try providers in a worse order. Slightly lower hit rate, slightly higher spend. Silent. |
| **Recoverable?** | Yes, automatically, at 30 local observations (§1.1). |
| **Unrecoverable?** | Credits already spent on the mis-ordered hops. Bounded, because a prior may only re-rank hops inside an **already-approved** plan and appears in the `--dry-run` diff before any spend — law 3, *src: `CLAUDE.md` law 3, "Every paid call is named and costed before it runs"*. A prior that could *add* a hop, or reorder after approval, would convert a poisoned number directly into unapproved spend. **That is forbidden** (§8.3). |

---

## 5. Shared segment taxonomy

### 5.1 Do not invent one — it already exists and is already server-issued

`_lib/filters-catalog.json` is a snapshot of the `search_reference_data` endpoint,
regenerated by `richapi-skills sync` — *src: its `$comment`*. It carries closed enums:
**434 industries, 9 `companySize` bands, 26 `functions`, 10 `seniority` levels**, plus
`profileLanguages` — *src: measured from the file, `generated_at: 2026-04-17`*.

The index's taxonomy is a **coarsening of that catalog**, published by the same server
that publishes the catalog. Any second taxonomy invented for the index would immediately disagree with
the one `/build-prospect-list` filters on, and the pack would mean two things by "mid-market
SaaS". — *assert.*

### 5.2 The cell-count arithmetic, which decides the whole shape

The naive tuple is unusable:

```
  434 industries × 9 size bands × 10 seniority × 26 functions   = 1,015,560 cells
  × even a coarse 8-way geography                               = 8,124,480 cells
```
*src: multiplied out from `_lib/filters-catalog.json`.*

Against that, the plausible contributor population. The index ships only after the pack
is published and in use (§1), and at the time of writing the pack is unpublished with
**zero installs** — *src: `SECURITY.md`, "Nothing is published to npm yet"*.
Take an optimistic 1,000 consenting installs each working 3 segments: 3,000 account-cell
pairs. Spread perfectly over 8.1M cells, the mean cell has **0.00037 contributors**. To
reach `k>=5` in even 480 cells you need 2,400 perfectly-spread account-cell pairs, and
real ICP distributions are Zipf, not uniform — the head fills and the tail never does.

> **Conclusion: a fine-grained per-segment networked index cannot reach its own privacy
> threshold. It is not a privacy risk we mitigate; it is a product that returns
> "suppressed" forever.** — *assert, from the arithmetic above.*

### 5.3 The shape that survives the arithmetic

Publish **marginals plus a small joint head**, not a dense cube:

```
  TIER 0  global                        1 cell     always populated first
  TIER 1  industry_group               ~20 cells   } one-dimensional marginals:
          size_band                      4 cells   } 30 cells total, each pooling
          region_group                   6 cells   } across all other dimensions
  TIER 2  industry_group × size_band    ~80 cells   populated only where k passes
  TIER 3  the full tuple                        —   NOT PUBLISHED. EVER. (§8.1)
```

`industry_group` is a server-published many-to-one map from the 434 industry labels to
~20 groups. `size_band` collapses the 9 `companySize` values to 4. `region_group` is ~6
multi-country groups, never a country — a country is identifying at these volumes.
— *assert on every specific number here; they are the smallest sizes that keep the labels
meaningful, and should be tuned against real contributor counts before launch.*

Client lookup walks **down** the tiers and stops at the first populated one, so a request
for a Tier-2 cell that never passed `k` silently receives the Tier-1 answer.

### 5.4 Versioning: three independent integers, never coerced

| Version | Meaning | Bumped when |
|---|---|---|
| `payload_schema` | which **fields** cross boundary 1 | any field added/removed/retyped |
| `taxonomy_version` | what the **labels mean** | any group added, split, merged, renamed |
| `snapshot_version` | which **published artifact** | every epoch |

All three are sent on every request. **The server never silently coerces an unknown
version** — it returns `409` naming the supported range, and the client stops (contributions)
or applies no priors (snapshots). Silent coercion is how two installs come to mean
different things by the same label. — *assert; the mirror of the pack's fail-closed law,
src: `CLAUDE.md` law 5.*

### 5.5 Migration is a reset, not a remap

When `taxonomy_version` bumps, aggregates are **not** remapped into the new labels.

Why: a merge (`fintech` + `insurtech` → `financial_services`) can be summed, but a split
cannot be un-summed, and a relabel is silently either. Remapping across a split invents
precision that was never measured, and the invented number is indistinguishable from a
measured one downstream. — *assert.*

So: a bump opens a **new aggregation namespace**. The old namespace keeps serving,
frozen, until the new one reaches `k` in the tiers that matter, then retires. Clients on
a retired version get **no priors**, not stale ones.

### 5.6 Failure mode

| | |
|---|---|
| **What breaks** | Two installs label the same company differently (the taxonomy is coarse and the labelling is the user's), so a cell averages incomparable things. |
| **What the user sees** | Nothing. A slightly wrong prior. |
| **Recoverable?** | Yes — §1.1, and Tier-1 marginals are far more robust to mislabelling than Tier-2 joints, which is a second reason the cube is not published. |
| **Unrecoverable?** | A **stalled migration**: contributors split across two `taxonomy_version`s, neither reaching `k`, so the index goes dark for everyone. Detected before users see it by §7.4 — the old namespace is not retired until the new one has coverage. |

---

## 6. Anonymization and small-cell suppression

### 6.1 The thresholds

| Parameter | Value | Why |
|---|---|---|
| `k` (distinct contributing accounts) | **5** | outside convention for small-cell suppression in statistical disclosure control is a threshold of 5–10; 5 is the floor of that range — *assert: convention, not a legal requirement, and this data is not personal data (§6.5)* |
| `n` (observations in the cell) | **50** | a hit-rate over a dozen calls is noise regardless of privacy; matches the kill/scale bands' `min_n` of 50 — *src: `_lib/gates.yaml` `activation.metric_a_install_to_first_run.min_n`* |
| Published precision | **2 significant figures** | fewer bits to difference against |
| Published volumes | **none** | see §6.3 |
| Epoch | **7 days** | matches the existing weekly-canary cadence  |

Both floors must hold. `k` alone admits 5 accounts with 3 calls each; `n` alone admits one
account with 5,000.

### 6.2 Suppression must be unobservable

Naive suppression leaks by omission. If a client asks for cell C and is told "suppressed",
it has learned *at least one and fewer than five installs work C* — which for a narrow
segment is itself the competitive intelligence we were protecting.

```
   NAIVE (leaks)                        THIS DESIGN (does not)
   ────────────────────────             ──────────────────────────────────
   GET cell C                           snapshot = a COMPLETE Tier-0/1 table
     -> {"status":"suppressed"}                  + a SPARSE Tier-2 table
        ^^^^^^^^^^^^^^^^^^^^^^                     containing only cells
        "someone is in C, but                      that passed k
         fewer than 5 of them"
                                        client asks for a Tier-2 cell,
                                        does not find it, walks up to Tier 1.

                                        Absence of a Tier-2 cell means
                                        "nobody, OR below k" — the two are
                                        indistinguishable from outside.
```

The client must therefore never receive a per-cell status code, an error, or a "try a
broader segment" hint. It receives one artifact and reads what is in it. — *assert.*

### 6.3 What an attacker with one install can infer from the improvements they receive

This is the question this note exists to answer, answered directly.

**They can obtain:** the full published snapshot — coarse hit-rate priors, each a median
over >= 5 accounts and >= 50 observations, rounded to 2 s.f.

**They cannot obtain, by construction:** any person, email, phone, domain, company name,
row identifier, list identifier, or response body. None of these exist anywhere in the
payload schema (§7.1) and `assertAggregateOnly` throws on any of them
— *src: `_lib/share-render.mjs` `FORBIDDEN_KEYS`, `CONTACT_SHAPED_VALUE`, `PHONE_SHAPED_VALUE`.*

**They can attempt, and here is how far each gets:**

| Attack | Reach | Mitigation |
|---|---|---|
| **Self-subtraction.** Attacker contributes to cell C, knows their own rate, subtracts it. | Against a *mean*, this yields the mean of the other 4. Against a **median of 5 accounts**, knowing your own value tells you only which side of the median you sit on. | Median-of-accounts (§4.3) is an anonymization mechanism as well as an anti-poisoning one. |
| **Differencing across epochs.** Cell C is published at epoch 1 with 5 accounts, epoch 2 with 6. The delta is attributable to the joiner. | Real and cheap against a naive publisher. | **Epoch freezing:** a published cell's value is **repeated verbatim** unless its contributor set has changed by `>= k` members since it was last recomputed. A single joiner never moves a published number. |
| **Existence probing.** Attacker enumerates narrow segments to find which ones exist. | Blocked. | §6.2 — absence is ambiguous, and Tier 3 is never published at all. |
| **Active probing.** Attacker injects an extreme value and watches whether the median moves, learning the cell's distribution shape. | Partially succeeds over many epochs. | 2 s.f. + epoch freezing + `CONTRIB_CAP` slow it. **Not eliminated.** What leaks is the shape of a *coarse* hit-rate distribution — commercially mild. — *assert.* |
| **Volume inference** — "how many people target DACH SaaS?" | Blocked. | No counts, no `n`, no contributor counts, no "top segments" list is ever published. The cost is real: the client cannot weight a prior by its sample size. Accepted. |

### 6.4 This is k-anonymity, not differential privacy — deliberately

No DP noise is added. At the contributor counts of §5.2, noise calibrated to any
defensible epsilon would exceed the signal by an order of magnitude, and a private index
that returns pure noise has the same product value as no index while costing the same to
build and audit. — *assert.*

The honest consequence: **there is no formal privacy guarantee here.** The defence is that
the payload contains no personal data at all, so the worst realistic outcome is a
competitor learning approximate hit-rates for a coarse market segment. If that is
unacceptable to the business, networked learnings should not ship — noise will not rescue it.

### 6.5 The compliance property that makes networked learnings tenable

`/comply erase <email|domain>` sweeps the **entire** `gtm/` tree and appends a tombstone
— *src: `_lib/pii.mjs` `erase()`*. A networked index that contained contact-derived data
would put a copy of a data subject's data beyond the reach of that sweep, permanently, on
someone else's server. That would break law 7 in the one way it cannot be patched later.

Because the contribution payload contains **no third-party personal data by construction**,
an erasure request has nothing to reach for in the index, and `erase()` needs no network
call, no server round-trip, and no "we have requested deletion from the index" caveat.
**This property is the reason networked learnings is buildable at all, and any payload change that weakens
it invalidates this note.** — *assert, resting on `src: CLAUDE.md` law 7.*

### 6.6 Failure mode

| | |
|---|---|
| **What breaks** | A cell passes `k=5` with five accounts belonging to one organization (§4.5), or a coarse segment turns out to be narrow in practice. |
| **What the user sees** | Nothing — the disclosure is to a competitor, not to them. |
| **Recoverable?** | **No. A published aggregate cannot be unpublished from the machines that already fetched it.** This is the one genuinely unrecoverable failure in this design and it is why §9 gates launch on a manual review of the first snapshot rather than an automated one. |

---

## 7. Consent UX and revocation semantics

### 7.1 Separate toggle, separate file, separate default

Required to be separate from telemetry (§1).

- **Both default OFF.** No opt-out data flow, ever, in either direction. This is the same
  principle that keeps every paid call opt-in: an opt-out data flow would violate the
  keystone every-paid-call-is-named-and-costed law — *src: `CLAUDE.md` law 3*.
- Consent lives in an **append-only** `gtm/consent.jsonl` — grant and revoke are both new
  lines; nothing is ever rewritten. This is exactly the tombstone pattern already in the
  codebase — *src: `_lib/pii.mjs` `TOMBSTONE_FILE`, `ERASE_EXCLUDED`, "Never rewritten by
  erase — it IS the audit trail of erasures"*.
- It stores **no identity** — only `{ts, action, payload_schema, client_version}`. There is
  nothing in it for `erase()` to match, and nothing for a leak to expose.
- **Unreadable or corrupt consent file = OFF.** Never "assume last known good"
  — *src: `CLAUDE.md` law 5, fail closed.*

> **Changes this design needs outside this file.**
> 1. `gtm/consent.jsonl` must be added to `ERASE_EXCLUDED` in `_lib/pii.mjs` — otherwise
>    `erase()`'s whole-tree sweep can rewrite the consent ledger, and erasing a *contact*
>    would silently alter the *operator's* consent record.
> 2. It must be excluded from the TTL sweep for the same reason.
> 3. `journal-line.schema.json` (FROZEN) needs `prior_applied` and `prior_snapshot_sha256`
>    so an applied prior is diagnosable after the fact (§7.5, §8.4). Contract change.

### 7.2 Consent is bound to a payload schema version

A grant covers `payload_schema: 1`. If the schema bumps, **new data is leaving the
machine that the user did not agree to send**, so contributions pause and the toggle
returns to unconsented until re-granted. A taxonomy bump does **not** re-prompt — the
fields are unchanged. — *assert.*

### 7.3 The consent copy

The task's hardest requirement is that the copy must not imply a withdrawal that cannot
happen. Proposed text, to be shipped verbatim:

```
  Contribute anonymous hit-rate statistics?  [y/N]

  What is sent, and nothing else:
    which endpoint was called, which provider answered, whether it found a
    result, and a coarse market segment (industry group, size band, region
    group). Counts only.

  What is never sent:
    any contact, email, phone, company, domain, list, or file. Not your
    learnings file, not your journal, not your lists. Aggregates are computed
    on this machine; raw rows never leave it.

  In return: starting hit-rate estimates for segments you have not run yet.
  Estimates are advisory. They never add a call to a plan and never change what
  a run costs without showing you first. Your own results always override them.

  Revoking:
    turning this off stops all future contributions immediately.
  >>> Statistics already contributed CANNOT be withdrawn. <<<
    They are already merged with at least four other accounts, and removing one
    account's share from a merged figure would reveal that account's share. Your
    account is dropped from the contributor list within 7 days, and every figure
    published after that excludes you. Figures already published stay published.

  This is a separate setting from usage telemetry. Both are off unless you
  turn them on. You can change either at any time with:
      richapi consent
```

Two lines in that copy are doing the hard work:

- `>>> Statistics already contributed CANNOT be withdrawn. <<<` — plain, not hedged, and
  the reason is given in one sentence a non-specialist can check. Subtracting one
  account's contribution from a k=5 aggregate *is itself a disclosure of that account's
  contribution*, so "we could remove it if you asked" would be a privacy regression sold
  as a privacy feature. — *assert.*
- "within 7 days" — the epoch, not "immediately". Promising immediate removal from a
  weekly recompute would be a lie by one epoch. — *src: §6.1 epoch = 7 days.*

### 7.4 What revocation actually does

| | |
|---|---|
| **Immediately, locally** | The strip-miner stops running. The queue is **deleted, not flushed** — queued-but-unsent rows are the clearest case of data the user has changed their mind about. |
| **Immediately, server-side** | A revoke beacon is best-effort only. Revocation must be fully effective **without** it, because the client simply stops sending. |
| **Within one epoch (<= 7 d)** | The account is dropped from every contributor roster; the next recompute excludes its history entirely; cells that fall below `k` as a result drop out of the next snapshot. |
| **Never** | Already-published snapshots are not recalled. Third parties have already fetched them. |

### 7.5 Failure mode

| | |
|---|---|
| **What breaks** | Consent state is ambiguous — file missing, corrupt, or written by a newer client. |
| **What the user sees** | Contribution silently stops. One line in the run report: `networked learnings: off (consent unreadable)`. |
| **Recoverable?** | Yes — `richapi consent` rewrites it. |
| **Unrecoverable?** | Contribution made under a consent the user did not actually give. Prevented only by the fail-closed default; **there is no way to un-send.** This is why the default is OFF and why a schema bump re-prompts. |

---

## 8. What should NOT be built

Four cancellations. Each is a recommendation against something the idea currently implies.

### 8.1 Do not build the fine-grained per-segment index (Tier 3)

The motivating example is *"which waterfall orders actually find emails, which
segments verify badly"* at the granularity of "mid-market SaaS in DACH". At the cell
counts in §5.2 against any plausible contributor population, **the fine-grained cube never
reaches `k` and never will.** Building it produces a system whose correct behaviour is to
return nothing, and whose incorrect behaviour is a privacy incident. Build Tier 0–2 only;
Tier 3 is not "later", it is **no**. — *assert, defended by the arithmetic in §5.2.*

### 8.2 Do not network copy, template, reply or conversion learnings

The idea lists *"which signals converted, which templates/angles got replies"* as
learnings. Two reasons these must not cross
boundary 1:

1. **The pack cannot observe them.** Sending execution is *"deliberately external forever"*
   — *src: `ROADMAP.md`, Out of scope*. Any reply data would arrive via an import the user pasted in,
   with unknown provenance and no anchor check (§4.2) — un-anchorable by definition, and
   therefore un-aggregatable under this design's own rule.
2. **Copy is the user's competitive asset,** and template-level aggregates over few
   contributors are near-attributable. A user who discovers their best-performing angle
   was averaged into a figure their competitor read will not accept "it was anonymized".
   — *assert.*

Local `/learn` keeps all of this. It just never leaves the machine.

### 8.3 Do not let a network prior change what a run costs

A prior may **re-rank hops within an already-approved plan** and nothing else. It may not
add a hop, remove a hop the user approved, change an endpoint, or take effect after
approval. Otherwise a poisoned or drifted number in a server we control silently changes
what a user's machine spends, which is a direct breach of the pack's keystone law
— *src: `CLAUDE.md` law 3, "Every paid call is named and costed before it runs. No opt-out
paid calls, ever."* The prior must be visible in the `--dry-run` diff, attributed, before
approval. — *assert, following from law 3.*

### 8.4 Do not publish RichAPI's provider names to every install

The learnings signal is keyed on `provider`, and the recorded real value of that field is
a **vendor name**: `"Acme Data Labs"` — *src: `_lib/journal.mjs`, the `provider` coercion comment: a free-text vendor name once
killed a paid run, and is now coerced to a safe token, never fatal*.
Publishing per-provider hit-rates in a snapshot every install can fetch therefore
discloses RichAPI's supply chain, its vendor mix, and each vendor's relative performance
to anyone who buys one seat.

Two consequences, both mandatory:

- The snapshot must publish **provider slots** (`slot_1`, `slot_2`) or the recommended
  waterfall **ordering** — not vendor identities — unless the business explicitly decides
  to disclose its supply chain. This is a business call the design should force, not
  absorb. — *assert.*
- Regardless: the contribution payload must carry a **server-issued provider enum**, not
  the free-text field. That failed run is direct evidence that this field arrives as unbounded
  third-party text; an unbounded string in an aggregation key is both a taxonomy break and
  an injection surface. Anything outside the enum is dropped, not passed through — the
  same discipline `share-render.mjs` already applies to `endpoint`/`provider`
  — *src: `_lib/share-render.mjs`, "anything unrecognised collapses to `unknown_endpoint`
  / `other`, so a poisoned journal cannot smuggle a value out"*.

---

## 9. Server contract, observability, and preconditions

### 9.1 Wire format

Two endpoints. JSON over TLS. Versions on every request; `409` and stop on any mismatch
(§5.4).

**`POST /v1/learnings/contribute`** — body is a bounded array of rows:

```json
{
  "payload_schema": 1,
  "client_version": "1.3.0",
  "epoch": "2026-W36",
  "taxonomy_version": 3,
  "rows": [
    { "segment": {"industry_group":"software","size_band":"51_200","region_group":"dach"},
      "endpoint": "email_finder",
      "provider": "slot_1",
      "observations": 137,
      "hits": 94 }
  ]
}
```

That is the **complete** field list. There is no free-text field anywhere in it, which is
what makes the boundary-1 assertion in §3 checkable rather than aspirational.

Responses: `202` accepted (with per-row accept/drop counts and reasons) · `409`
version unsupported (client stops contributing, warns **once**, never loops) · `429`
with `Retry-After` (queue and continue) · `5xx` (queue and continue). **No response code
causes a retry inside a run.**

**`GET /v1/learnings/snapshot?taxonomy_version=3&payload_schema=1`** — returns the complete
Tier 0/1 table plus the sparse Tier 2 table, its `snapshot_version`, its `generated_at`,
and its own sha256. Kilobytes, because §5.3 keeps it small — one file, cacheable, no
per-cell queries, and therefore no query log that could reveal which segments an install
is interested in. That last property is a reason to prefer a whole-snapshot fetch over a
query API even though a query API is easier. — *assert.*

### 9.2 Client behaviour when the server is down or the schema moves

| Condition | Behaviour |
|---|---|
| Ingest unreachable / `5xx` / `429` | Queue, continue, one line in the report. Never blocks, never retries in-run. |
| Queue full (512 rows / 1 MiB / 30 d) | Evict oldest, count the eviction, report it. **Never** grow unbounded, never fail the run. |
| Ingest returns `409` | Stop contributing. Warn once. Do not re-prompt for consent — the user consented; the client is out of date. |
| Snapshot fetch fails | Serve the cached snapshot, marked stale. |
| Cached snapshot older than 7 d and refresh failing | Keep serving, marked stale, up to 30 d; then **drop to no priors**. |
| No snapshot at all | Run exactly as the pack runs today: local evidence only. |
| Snapshot sha256 mismatch | Discard, no priors, alarm locally. A snapshot changes what a paid waterfall does; it gets integrity-checked like the pinned spec — *src: `_lib/paths.mjs` `SPEC_SHA_PATH`, the existing spec-checksum discipline.* |

**Every row of that table ends in "the run completes".** That is the hard requirement
that uploads never wedge a run (§1), and it is satisfied
because the only two network calls are a best-effort post after the output is written and
a cached read that fails open.

### 9.3 Server-side observability

The operator must see a problem before users do. Six signals, each tied to a specific
failure from §4–§6:

| Signal | Detects | Alarm |
|---|---|---|
| Accept/drop counts by reason (unknown schema, unknown taxonomy, **un-anchored**, cap-exceeded, malformed) per epoch | a broken client rollout; an attacker probing the ingest | un-anchored rate > 1% of rows |
| Per-account **divergence from cell median**, distribution per epoch | poisoning **in progress**, before the median moves (§4.4) | a rising high-divergence tail |
| New-contributor burst per cell | Sybil recruitment against a specific cell | > `k` new accounts in one cell in one epoch → **hold that cell** |
| **Snapshot diff gate**: any published cell moving > `X` points between epochs is **held for manual release, not auto-published** | poisoning that succeeded; a genuine market shift; an aggregation bug | any hold, every time |
| Migration coverage: contributions and k-passing cells per `taxonomy_version` | a **stalled** taxonomy migration (§5.6) | new namespace has < 50% of old namespace's k-passing cells after 4 epochs → do not retire the old one |
| Cell census: cells passing `k`, cells at `k-1`, cells never populated | the §5.2 arithmetic being wrong in either direction | census flat or falling across 4 epochs → **the index is not working; say so and stop** |

Two structural points about this table:

- The **snapshot diff gate is the only mechanism that puts a human between a bad number
  and every install.** Everything else is a dashboard. It must be a release gate, not an
  alert. — *assert.*
- Observability depends on the client-side journal change requested in §7.1: without
  `prior_snapshot_sha256` on the journal line, a support case reading "our hit rate
  dropped last week" is **not reproducible**, because nobody can determine which snapshot
  that run used. The journal field is a prerequisite for server observability, not a nicety.

RichAPI's own installs should form a **canary cohort** receiving each snapshot one epoch early. — *assert.*

### 9.4 What has to be true before networked learnings ships

Ordered. Each is a gate, not a wish.

1. **`provider` is proven to exist and be stable in live responses.** Today **68 of 68
   endpoints have a null `field_map`**. 63 report `field_map_status: "live_fixture"`,
   read off one recorded 2xx each; 5 (`geo_id_search`,
   `google_ad_transparency_scraper_sync`, `google_maps_reviews_scraper_sync`,
   `linkedin_ad_search`, `slack_channel_members`) carry only
   `"keys_from_spec_example"` — the top-level key names the spec's 200 example declares,
   with no type, no meaning and no presence guarantee — and 0 carry
   `"TODO_no_usable_example"` — *src: measured from `_lib/api-catalog.json`*. A key list is
   not evidence that `provider` is populated, typed or stable, and one recorded sample
   per endpoint is not evidence of stability either — *src: `LIMITATIONS.md` §1*.
   **The single field the entire signal rests on is not yet proven stable.** If
   `provider` turns out to be absent, inconsistent, or free-text-only, there is nothing to
   aggregate and this note is moot.
2. **A server-issued provider enum exists** (§8.4). The failed run in §8.4 is the evidence
   that the raw field cannot be used as an aggregation key — *src: `_lib/journal.mjs`*.
3. **Tier A is built and measured first** (§3.1). It needs no consent, no client, and no
   privacy surface.
4. **An experiment proves waterfall ordering matters.** Nothing in this repo has yet
   measured whether re-ordering hops changes hit rate at all. If the effect is under ~2
   points, the entire risk surface buys a rounding error and should be cancelled. **This
   experiment is the real gate on a pack-side client and it does not exist yet.** — *assert.*
5. **A real cell census clears `k`.** Measured on live contributions, not projected from
   §5.2's optimistic arithmetic.
6. **Contract amendments landed** (§7.1): `ERASE_EXCLUDED` + TTL exclusion for
   `gtm/consent.jsonl`; `prior_applied` and `prior_snapshot_sha256` on the frozen
   journal-line contract.
7. **Legal review of the ToS basis for Tier A**, since Tier A aggregates existing
   server-side logs with no per-user consent prompt.
8. **The first snapshot is released by a human**, not by the pipeline (§9.3).

### 9.5 What this design does not solve

- **Sybil accounts** defeat both `k` and the median (§4.5). Unsolved.
- **No formal privacy guarantee.** This is k-anonymity with suppression, not differential
  privacy, and it is chosen deliberately (§6.4). An adversary with auxiliary knowledge is
  not modelled.
- **Publication is irreversible** (§6.6). Nothing recalls a fetched snapshot.
- **Cold start.** Tier B cannot bootstrap itself; only Tier A can, and Tier A is not a
  network effect.
- **The moat claim is unvalidated.** *"Install #10,000 starts smarter than install #1"*
  is an assertion nothing has measured. Precondition 4 is the experiment
  that would make it a fact or kill it.
- **Segment labelling quality.** Two users can label the same company differently and the
  design has no way to know; it only limits the damage (§5.6).

---

## 10. Summary of recommendations

| # | Recommendation | Basis |
|---|---|---|
| R1 | Split networked learnings into **Tier A (server-derived)** and **Tier B (client-contributed)**. Build A first. | §3.1 |
| R2 | Gate Tier B and the pack-side client on a measured effect size for waterfall reordering. | §9.4.4 |
| R3 | Publish **marginals + a small joint head**. Never the full tuple. | §5.2, §8.1 |
| R4 | `k >= 5` accounts **and** `n >= 50` observations; **median across accounts**, not a pooled rate. | §4.3, §6.1 |
| R5 | Make suppression unobservable — complete coarse table, sparse fine table, no per-cell status. | §6.2 |
| R6 | Anchor every contributed row against the operator's own API log, or drop it. | §4.2 |
| R7 | Separate, append-only, fail-closed consent bound to `payload_schema`; ship the §7.3 copy verbatim. | §7 |
| R8 | Priors are advisory, re-rank only inside an approved plan, and appear in the dry-run diff. | §8.3 |
| R9 | Provider **slots**, not vendor names, in anything published. | §8.4 |
| R10 | The snapshot diff gate is a **release gate with a human in it**, not an alert. | §9.3 |
| R11 | Never network copy, template, reply or conversion data. | §8.2 |

## Related

- `../../CLAUDE.md` — the seven laws (3, 5, 6, 7 are load-bearing above)
- `../skill-shape.md` — the SKILL.md shape contract
- `../../_lib/share-render.mjs` — the aggregate-only-by-construction pattern this reuses
- `../../_lib/pii.mjs` — retention, TTL, erase, tombstones; the consent ledger copies its pattern
- `../../_lib/contracts/journal-line.schema.json` — FROZEN; §7.1 requests two fields
