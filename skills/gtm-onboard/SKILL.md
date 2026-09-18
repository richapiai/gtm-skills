---
name: gtm-onboard
version: 1.0.0
description: >
  Teaches the pack who YOU are. Captures the seller (company, website, what you sell,
  the wedge, what you may cite, how outreach should read, who owns which inbound) into
  `gtm/profile.yaml`, and records standing dos and don'ts into `gtm/preferences.jsonl`
  so the next session starts knowing them. Optionally pre-fills the profile from your
  own website, priced and declinable like every other paid call. Use when asked "set me
  up", "onboard me", "remember this", "never do X again", "always do Y", or when any
  skill needs the offer and nothing on disk states it. Proactively invoke on a first
  run, before /gtm-kickoff. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - onboard me
  - set me up
  - gtm onboard
  - remember this
  - never do that again
  - always do this
  - who are we
  - update our profile
  - what do you know about us
---

# Onboard — teach the pack who you are

Every other skill in this pack knows the buyer. `gtm/icp.yaml` says who to target,
`gtm/learnings.jsonl` says which provider found them. Nothing knows the **seller**, and
that is not a small gap: [`/personalize`](../personalize/SKILL.md) refuses to write a
claim it cannot source, and until this skill runs there is no source on disk for the one
claim every email makes — what you are offering and why it matters.

So this session is short, free by default, and it is about you.

Two artifacts come out of it:

| File | What it is | Written how |
|---|---|---|
| `gtm/profile.yaml` | the seller. One document. | overwritten, whole |
| `gtm/preferences.jsonl` | your standing dos and don'ts | **append-only, never edited** |

Both are local, both are gitignored under `gtm/` (law 7), and neither is ever uploaded.
There is no network in the module behind them and no place to add one.

## Before anything else

```bash
richapi-skills-preflight
```

- `API_KEY_SET: no` — **not a blocker.** The interview and both writes cost nothing. It
  only blocks the optional website pre-fill in Step 3, which you can decline anyway.
- `SUPPRESSION: STOP` — not a blocker here; this skill writes no contact list. Say it
  once, because it blocks everything downstream and `./setup` is cheaper to run now than
  at the moment the first list is due.
- `CATALOG_OK: no` — only matters if you reach Step 3; regenerate with
  `richapi catalog gen`.

## Inference mode — local, until Step 3 says otherwise

Steps 1, 2 and 4 make **zero API calls**. They are an interview and two file writes. The
only step that can spend is Step 3, it is opt-in, it is priced before it runs, and
declining it costs nothing and loses nothing that Step 1 did not already capture.

## Step 1 — the interview

Ask one question per turn. A user who answers five at once has answered one and guessed
four — the same rule [`/gtm-kickoff`](../gtm-kickoff/SKILL.md) runs on, for the same
reason.

| Slot | What you are actually trying to find out | Required |
|---|---|---|
| `company` | The selling company's name, as a stranger would see it. | yes |
| `what_we_sell` | One sentence, **in the user's own words**. Not a positioning statement. If they cannot say it in one sentence, that is a finding worth reflecting back. | yes |
| `wedge` | The problem urgent enough that a stranger replies. Not the best feature — the thing that is on fire. | yes |
| `website` | The domain. The one input Step 3 can use. | no |
| `proof` | Customers, numbers and logos they are **allowed** to cite. Ask about permission explicitly; a named logo somebody has not cleared is a legal problem, not a copy problem. | no |
| `tone` | How outreach should read. Ask for an example of something they liked, not an adjective. | no |
| `sender` | Name, title, and the signature that goes on the bottom. | no |
| `routing` | Who owns which inbound. Feeds [`/inbound`](../inbound/SKILL.md). | no |
| `never_claim` | Things a draft must never assert. Compliance limits, unreleased features, a competitor comparison legal has refused. | no |

Two rules that decide whether the profile is worth anything:

- **`proof` empty is a legitimate answer.** A seller with nothing citable is a real and
  common state, especially pre-launch. Recording an empty list is honest; inventing a
  customer to fill the field manufactures exactly the evidence
  [`/personalize`](../personalize/SKILL.md) exists to refuse.
- **Never infer the wedge from the product.** If the user describes a feature, ask again
  for the problem. The gap between the two is where most outbound dies.

## Step 2 — write the profile

Only after the user has read it back and said yes. Write the whole document:

```
gtm/profile.yaml
```

Then state plainly which required slots are filled and which are not. An incomplete
profile is a legible state — the runtime reports it as `PROFILE: incomplete` and names
the missing slots — but a reader treats a missing `what_we_sell` as "ask the user", not
as "write something plausible".

## Step 3 — pre-fill from the website (OPT-IN, PRICED, DECLINABLE)

Only if the user gave a `website`, and only if they ask for it or accept the offer. The
pack can read the user's own site and propose values for `what_we_sell`, `proof` and
`tone`.

**This is a paid call during onboarding, and law 3 has no carve-out for onboarding.** So
it follows the same sequence as every other spend in this pack, with no shortcut for the
fact that it feels like setup:

```bash
richapi call website_intelligence --param url=<the user's site> --dry-run
```

The dry run names every call and prints the total before anything is reached. Show the
user that total, in credits, read from the plan — never from this page, and never from
memory. Then they approve it or they do not.

`web_meta_tags(...)` and `web_tech_stack(...)` are the cheaper alternatives if the user
wants a smaller answer; price them the same way, in the same dry run, and let the user
pick from a plan rather than from prose.

Three rules on what comes back:

- **Everything it proposes is a proposal.** Write nothing into `gtm/profile.yaml` that
  the user has not read and confirmed. A value scraped from a homepage is marketing copy,
  which is exactly the register outbound should not be written in.
- **A miss is reported as a miss.** If the site yields nothing usable, say so and go back
  to Step 1. Do not pad the profile with the meta description.
- **Declining costs nothing and blocks nothing.** The interview already produced a valid
  profile. Say that out loud, because a user who thinks the paid step is mandatory will
  either pay for it resentfully or abandon onboarding.

## Step 4 — record a standing rule

Any time the user says "never do X", "always do Y", or corrects the same thing twice,
that is a preference and it belongs on disk. Append one line:

```
gtm/preferences.jsonl
```

Each line carries the `scope` that decides who reads it, the `rule` in the user's own
words, and `why` — which is the field that stops a rule from being obeyed long after it
stopped making sense.

| Scope | Who reads it |
|---|---|
| `copy` | [`/personalize`](../personalize/SKILL.md), [`/sequence-builder`](../sequence-builder/SKILL.md) |
| `targeting` | [`/build-prospect-list`](../build-prospect-list/SKILL.md), [`/icp-review`](../icp-review/SKILL.md) |
| `sequence` | [`/sequence-builder`](../sequence-builder/SKILL.md), [`/outreach-expert`](../outreach-expert/SKILL.md) |
| `routing` | [`/inbound`](../inbound/SKILL.md), [`/reply-triage`](../reply-triage/SKILL.md) |
| `compliance` | [`/comply`](../comply/SKILL.md) — **on top of** its rules, never instead of them |
| `spend` | [`/cost-optimizer`](../cost-optimizer/SKILL.md) |

**Append-only, and that is deliberate.** A rule is never edited in place and never
deleted. Superseding one means adding a new line that says what changed and why —
"we used to do X and stopped" is the part worth keeping. The history is the artifact.

**A preference never changes what a run costs.** It may inform copy, ordering and
routing. It may not add a hop, remove one the user approved, change an endpoint, or take
effect after approval. That is the same boundary
[`/learn`](../learn/SKILL.md) holds its priors to, for the same reason: a standing rule
that can move spend is a paid call nobody named.

## When the files cannot be read

`absent` and `unreadable` are different states and must never collapse into each other.

- **absent** — a new install. Not an error. Say `PROFILE: none`, offer this skill, carry
  on with whatever the user actually asked for.
- **unreadable** — corrupt YAML, a truncated JSONL line, a preference with no rule. This
  is a **STOP** (law 5). A broken `preferences.jsonl` read as "no rules" silently drops a
  standing "never contact X", which is the missing-suppression-store failure wearing
  different clothes. Repair it, or move it aside deliberately. Never proceed as if the
  user had no rules.

## What this skill will not do

- **It will not invent the offer.** An empty `what_we_sell` stays empty. Every downstream
  skill would rather ask than read a plausible sentence nobody wrote.
- **It will not claim proof the user has not cleared.** A logo on a website is not
  permission to name it in an email.
- **It will not spend without a plan.** Step 3 is the only step that can spend, it is
  opt-in, and it is priced in a dry run first. Onboarding gets no exemption from law 3.
- **It will not upload anything.** No network, no sync, no shared profile. `gtm/` is PII
  and stays on the machine.
- **It will not edit or delete a preference.** Append-only. Superseding is a new line.
- **It will not make a preference into a gate.** Rules inform; they do not authorise,
  suppress or spend. [`/comply`](../comply/SKILL.md) owns whether a contact may be
  contacted, and a `compliance`-scoped preference is added on top of that verdict, never
  in place of it.
- **It will not replace the strategy brief.** [`/gtm-kickoff`](../gtm-kickoff/SKILL.md)
  interrogates the motion and the buyer. This one records the seller. They answer
  different questions and both are worth running.

## Related

- [`/gtm-kickoff`](../gtm-kickoff/SKILL.md) — the buyer-side interview; run this one
  first so the kickoff does not have to re-ask who you are
- [`/personalize`](../personalize/SKILL.md) — the skill that is incomplete without
  `gtm/profile.yaml`; it reads the offer, the proof and `never_claim`
- [`/sequence-builder`](../sequence-builder/SKILL.md) — reads `tone`, `sender` and every
  `copy` and `sequence` preference
- [`/outreach-expert`](../outreach-expert/SKILL.md) — reads `sender` and the `sequence`
  rules when advising on setup
- [`/inbound`](../inbound/SKILL.md) — reads `routing` to decide who owns a new lead
- [`/reply-triage`](../reply-triage/SKILL.md) — reads `routing` to route a reply
- [`/icp-review`](../icp-review/SKILL.md) — the buyer-side anchor, `gtm/icp.yaml`
- [`/learn`](../learn/SKILL.md) — the other memory in the pack: what worked, measured,
  rather than what you decided
- [`/comply`](../comply/SKILL.md) — the erase path that reaches both files
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session receipt
