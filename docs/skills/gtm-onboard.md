# /gtm-onboard

Two files on disk that make the pack stop asking you who you are: `gtm/profile.yaml`
(the seller) and `gtm/preferences.jsonl` (your standing dos and don'ts). The interview
costs nothing.

## The problem this solves

The pack knows a great deal about the people you are selling **to** and nothing about
you. `gtm/icp.yaml` holds the buyer. `gtm/learnings.jsonl` holds which provider found
them. There is no endpoint that returns "what does this user sell", so nothing in the
pack's generation ever produced that artifact — and the hole shows up exactly where it
costs most.

[`/personalize`](personalize.md) refuses to write a claim it cannot source. Until this
skill runs, there is no source on disk for the one claim every email makes: what you are
offering and why anyone should care. So the offer got re-supplied by hand every session,
or quietly invented.

The second file solves the other half. "Never mention pricing in step one." "We do not
contact Series A." "Marie owns anything from France." Those are decisions you make once
and then repeat to an agent forever, because nothing wrote them down.

## When to use it

- First run, before [`/gtm-kickoff`](gtm-kickoff.md). It takes a few minutes.
- "Never do that again" — any correction you have now given twice.
- Your positioning moved, you launched something, or the wedge changed.
- A skill just asked you what you sell and you have answered that before.

## When NOT to use it

- **You want the buyer defined.** That is [`/gtm-kickoff`](gtm-kickoff.md) for the
  hypothesis and [`/icp-review`](icp-review.md) for testing it against closed deals.
  This skill records the seller; they are different questions.
- **You want the pack to learn on its own.** [`/learn`](learn.md) does that from run
  journals — which provider and which hop actually found things. This one records what
  you *decided*, not what was *measured*. Both are memory; only one of them is an
  opinion.
- **You want a shared team profile.** There is no sync. Both files are local, gitignored
  and never uploaded.

## What it writes

| File | Shape | How |
|---|---|---|
| `gtm/profile.yaml` | company, website, what_we_sell, wedge, proof, tone, sender, routing, never_claim | overwritten whole |
| `gtm/preferences.jsonl` | one rule per line: `scope`, `rule`, `why`, `ts` | **append-only** |

`company`, `what_we_sell` and `wedge` are required — they are the three a reader would
otherwise have to invent. `proof` is deliberately optional: a seller with nothing they
are cleared to cite is a real state, and forcing a value there would manufacture exactly
the evidence `/personalize` exists to refuse.

Preferences are append-only on purpose. A rule is never edited and never deleted;
superseding one means adding a line that says what changed. "We used to do X and
stopped" is the part worth keeping.

## The one step that can spend

If you give a website, the skill can pre-fill `what_we_sell`, `proof` and `tone` by
reading your own site. That is a paid call, and onboarding gets no exemption from law 3:
it is opt-in, it is priced in a dry run that makes zero calls, you see the total before
anything is reached, and declining costs nothing and loses nothing the interview did not
already capture.

Everything it proposes is a proposal. Nothing reaches `gtm/profile.yaml` that you have
not read and confirmed — a homepage is marketing copy, which is the one register
outbound should not be written in.

## absent vs unreadable

These never collapse into each other.

- **absent** — a new install. Not an error. The runtime says `PROFILE: none` and carries
  on.
- **unreadable** — corrupt YAML, a truncated JSONL line, a preference with no rule. This
  is a **STOP**. A broken `preferences.jsonl` read as "no rules" silently drops a
  standing "never contact X", which is the missing-suppression-store failure wearing
  different clothes.

## Who reads what

| Scope | Read by |
|---|---|
| `copy` | [`/personalize`](personalize.md), [`/sequence-builder`](sequence-builder.md) |
| `targeting` | [`/build-prospect-list`](build-prospect-list.md), [`/icp-review`](icp-review.md) |
| `sequence` | [`/sequence-builder`](sequence-builder.md), [`/outreach-expert`](outreach-expert.md) |
| `routing` | [`/inbound`](inbound.md), [`/reply-triage`](reply-triage.md) |
| `compliance` | [`/comply`](comply.md) — on top of its verdict, never instead of it |
| `spend` | [`/cost-optimizer`](cost-optimizer.md) |

A preference informs copy, ordering and routing. It may not add a hop, remove one you
approved, change an endpoint, or take effect after approval — the same boundary
[`/learn`](learn.md) holds its priors to. A standing rule that can move spend is a paid
call nobody named.

## Related

- [`/gtm-kickoff`](gtm-kickoff.md) — the buyer-side interview
- [`/personalize`](personalize.md) — the skill that is incomplete without the profile
- [`/learn`](learn.md) — the measured half of the pack's memory
- [`/comply`](comply.md) — the erase path that reaches both files
