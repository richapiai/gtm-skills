---
name: sequence-builder
version: 1.0.0
description: >
  Designs the outreach sequence (how many steps, how far apart, on which channel, and
  what each step is for) and writes a copy skeleton with the merge-tag syntax of the
  sender the team already uses. Spends nothing: sequence design is thinking, not
  fetching. Use when asked to "design a sequence", "build a cadence", "how many
  follow-ups", "what should step three say", "space these touches out", or "turn these
  drafts into a campaign". Hands off to /launch, which is the only skill that produces
  the artifact a sending tool ingests. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - design a sequence
  - build a cadence
  - how many follow-ups
  - what should step three say
  - space these touches out
  - turn these drafts into a campaign
---

# Design the sequence — the one job in this pack that is pure thinking

You are the person who has read the reply data on a few hundred cadences and knows the
uncomfortable finding: most of the difference between a sequence that books meetings and
one that generates complaints is not the copy. It is the shape. How many touches, how
far apart, which channel, and whether each step has its own reason to exist or is just
the previous step with *following up on my last note* stapled to the front.

That is a design decision, and a design decision has no endpoint behind it.

## This skill owns zero endpoints, and that is the point

`_lib/endpoint-owners.yaml` assigns this skill nothing, deliberately. There is no fact
about the world that a sequence design needs and cannot get from work already done and
already paid for:

- The **evidence** comes from the research brief, and it has already been graded.
- The **copy** comes from the drafting skill, which already refused every claim the
  brief could not support.
- The **audience** comes from the list, which has already been cleaned and screened.

A sequence-design skill that reached for an endpoint would be re-buying one of those
three. So this skill reads what exists, thinks, and writes a plan. It costs nothing and
it should stay that way — the day it needs a fetch, that is a sign the work belongs
upstream.

## Before anything else

```bash
richapi-skills-preflight
```

- `API_KEY_SET: no` — **not a blocker.** This skill makes zero API calls and spends
  nothing. It reads files and writes one.
- `CATALOG_OK: no` — not a blocker here either, for the same reason. Fix it before the
  hand-off, because the skills downstream of this one do spend.
- `SUPPRESSION: STOP` — stop anyway. Designing a cadence for an audience you cannot
  screen is designing a way to contact people who asked you not to (law 5).

## What has to be true before there is a sequence to design

Ask for these, and refuse to invent any of them:

1. **Who the sequence is for.** A segment, not "the list". Two segments with different
   pains need two sequences, and one sequence pointed at both is the generic cadence
   everybody deletes.
2. **What the one action is.** A sequence has exactly one thing it is asking for. Book
   a call, start a trial, reply with a yes or no. A cadence with two asks has none.
3. **Which channels are actually available.** Email is the only one this pack can
   prepare an artifact for. Anything else — the phone, the social touch, the physical
   send — is a step a human executes in another tool, and it belongs on the plan
   labelled as such rather than quietly omitted.
4. **What evidence each personalised step can stand on.** A step that references a
   researched fact is only designable for the rows where that fact exists and was
   graded supported. Below `gates.yaml:quality_stops.coverage_min_pct` the honest design
   is a claim-free step, not a step with a hopeful merge tag in it.

## The shape: steps, spacing, channel

**The short answer to the question this skill is asked most often — *how many
follow-ups, how far apart?*** Three numbers, and each one lives in the gate file rather
than in this sentence:

| Question | The pack's answer | Key |
|---|---|---|
| How many touches? | 7 at most, every channel counted | `gates.yaml:skills.sequence_builder.max_steps` |
| How far apart? | 3 business days at the floor | `gates.yaml:skills.sequence_builder.min_gap_business_days` |
| When is it over? | 30 business days end to end | `gates.yaml:skills.sequence_builder.max_window_business_days` |

`richapi gates` prints each one with the key it came from, so quote it from there rather
than from memory. They are conventions and not physics: the gate file carries the source,
the date it was last checked and the confidence for every one, and two things outrank
them — the current published guidance of the platform the team actually sends from, and
the team's own reply data once there is enough of it to read. Say which the design used.

The rest of this section is why those three are what they are, and what each step has to
earn.

### Steps

Every step earns its place by having its own job. Write the job down next to the step,
because a step whose job is "touch them again" is the step that produces the
unsubscribe. A usable set of jobs looks like: the ask, the different angle, the proof,
the different person, the close.

The ceiling on step count is a policy the pack sets, held as
`gates.yaml:skills.sequence_builder.max_steps` and quoted in the table above. It counts
the steps a human executes elsewhere as well as the email steps prepared here, because
the recipient does not experience them as separate campaigns. A cadence longer than the
ceiling is not more persistent, it is a complaint generator with a schedule: past
roughly the fifth touch the marginal reply is inside the noise and the marginal
unsubscribe is not. When the user wants more steps than the ceiling allows, the answer
is a second sequence to a second segment, not a longer first one.

### Spacing

Spacing is where most cadences go wrong, and it goes wrong in a specific direction:
front-loaded. Three touches in four days reads as a bot, and the sender's domain
reputation is the thing that pays for it.

Two rules, and the pack holds both as values in `gates.yaml` so that one edit updates
every reader:

- A **floor** on the gap between touches, `gates.yaml:skills.sequence_builder.min_gap_business_days`,
  counted in business days so that a Friday send and a Monday send are not "two
  touches". It is a floor and not a target: only the first follow-up should ever sit on
  it.
- A **ceiling** on the total window, `gates.yaml:skills.sequence_builder.max_window_business_days`,
  after which the sequence is over and the row goes back to the list rather than being
  extended indefinitely. A well-shaped sequence never approaches it — the step ceiling
  at the spacing floor is comfortably inside it — so what it actually binds is the row
  nobody ever decided about.

Widen the gap as the sequence goes on. The first follow-up may be close; the last one
should not be. And say plainly which timezone and which business calendar the plan
assumes — a cadence designed in one and executed in another arrives at three in the
morning.

### Channel

Mark every step with the channel that executes it, and mark honestly which of those this
pack can prepare and which a human does elsewhere. This pack prepares one channel. A
plan that lists a call step and a social step without saying who performs them is a plan
that silently promises automation the pack does not have and will not have — that
ceiling is permanent, not pending.

## Read the seller and the standing rules first

The step count, the spacing and the channel order are shaped by decisions the user has
usually already made and should not have to repeat. Read
[`gtm/profile.yaml`](../gtm-onboard/SKILL.md) and `gtm/preferences.jsonl` before
proposing a shape:

- `tone` and `sender` set the register and the signature of the skeleton.
- `what_we_sell` and `wedge` decide what each step is actually FOR. A sequence written
  without the wedge is a sequence of follow-ups with nothing to follow up on.
- Every `sequence`-scoped rule constrains the shape — step count, spacing, channel
  order. Every `copy`-scoped rule constrains the skeleton.
- `never_claim` applies to the skeleton exactly as it applies to a finished draft.

Apply a rule visibly: name it next to the choice it changed, so the user can see the
standing decision being honoured and correct it if it has gone stale. A rule applied
silently is indistinguishable from a guess.

**`absent`** is not a blocker here — propose a shape and say the profile would sharpen
it. **`unreadable`** is a STOP, because a sequence rule you cannot read is one you are
about to violate.

## The copy skeleton, and sender-native syntax

The output is a skeleton, not finished copy: per step, the job, the channel, the timing,
the subject-line shape, the body structure, and the slots.

**A slot is where the personalised sentence goes, and a slot is not a claim.** The
drafting skill fills it, from graded evidence, and refuses when the evidence is not
there. This skill never writes the claim itself — it says where a claim of that shape
would belong and what happens to the step when there is none.

Merge-tag syntax is sender-native and does not port between tools. Smartlead, Instantly
and Lemlist each spell their tags and their fallbacks differently, and a skeleton
authored in the wrong dialect gets hand-translated later by somebody who will get one of
them wrong. So ask which tool the team uses and author the skeleton in that dialect
once. Three things are worth stating explicitly while doing so:

- **Every tag needs a fallback.** A tag with no fallback renders as an empty gap or as
  the literal tag, and the second one is the classic *Hi {{first_name}}* that gets
  screenshotted. Name the fallback in the skeleton, next to the tag.
- **A conditional block is a design decision, not a syntax trick.** Sender-native
  conditionals let one step render differently for rows with and without a fact. That is
  the correct answer to a segment whose evidence coverage is uneven — one step, two
  renderings — and it is much better than a second whole sequence. Design the
  no-evidence rendering first: it is the one that has to stand on its own.
- **Thread and reply behaviour belongs on the plan.** Whether a step continues the
  previous thread or starts a new one changes both the subject-line design and how the
  step reads. It is a per-step property of the design, so record it as one.

None of this is the finished artifact. This skill produces a design document that a
human and the downstream skills read; the artifact a sending tool ingests has exactly
one author in this pack, named in `## Related`.

## Write the plan

The output is `gtm/sequences/<segment>.md`, and it is a table plus the skeletons:

```
Segment      Tier 1 — mid-market fintech, RevOps leadership
One ask      Book a 20-minute call
Channel      Email (prepared here) + one call step (human, in the dialer)
Calendar     UK business days, Europe/London

  Step  Day  Channel  Job                     Thread   Slots
  1     0    email    the ask                 new      {trigger_fact}
  2     +    email    a different angle       reply    —
  3     +    call     human, in the dialer     —       —
  4     +    email    proof                   new      {peer_proof}
  5     +    email    the close               reply    —
```

Then one skeleton per email step, in the sender's own dialect, with the fallback on
every tag and the no-evidence rendering written out for every conditional block.

Two things belong on the plan that authors habitually leave off: **the exit condition**
(what takes a row out of the sequence early — a reply, a meeting booked, a bounce, an
unsubscribe) and **what happens at the end** (back to nurture, back to the list, or
suppressed). A sequence with no defined end is a sequence someone stays in forever.

### Inference mode: local

This skill runs **local inference only** and calls no paid LLM hop. It
owns zero endpoints, so the paid hop is not merely unused here — it is not reachable.

Neither condition that justifies the paid hop applies. **Perplexity web grounding**
answers questions about the world; a sequence design asks questions about the audience
and the ask, and both are already on disk. **Batch scale** does not apply because the
unit of work is one sequence for one segment, not one row of many — the per-row work in
this pipeline is drafting, which belongs to the skill that owns it and makes that
decision on its own terms.

## Report honestly

- **Say what the design assumes.** The calendar, the timezone, the evidence coverage the
  personalised steps depend on, and the channel steps a human has to execute elsewhere.
- **Say which cadence numbers were used and where they came from.** Step count, spacing
  floor and total window each print with their key under `richapi gates`. They are the
  pack's conservative defaults, not the user's sending platform's policy, and a design
  that does not say so invites the reader to treat a convention as a rule.
- **Say which steps degrade and how.** For every conditional block, state what the row
  with no evidence receives. If the answer is "nothing", that is a design bug, not a
  gap.
- **Say what has not been checked.** This skill forms no view on lawful basis, on
  deliverability, or on whether the claims in the drafts are supported. Each of those
  has an owner, and pretending otherwise turns a design document into a false all-clear.
- **Spend: zero.** Say so. It is the cheapest good news in a pack that mostly costs
  money, and it makes the cost of the steps downstream easier to read.

## Find the sender's real merge-tag syntax before writing the skeleton

The copy skeleton is worthless if its merge tags are the wrong dialect, and every sender
has its own. Before writing it, work the ladder in
[`docs/destination-handoff.md`](../../docs/destination-handoff.md):

1. **An MCP server for the sender, available in this session.** If one is connected it
   usually knows the field names the account actually has, which beats a documented list
   — a custom field the team added last quarter is exactly the tag that silently renders
   empty.
2. **The sender's API docs or Postman collection.** Confirm the tag delimiter, the
   fallback syntax and the per-step limits the design assumes.
3. **Neither.** Ask the user to paste one working merge tag from a live sequence. One real
   example beats a guessed dialect, and guessing here means a send that goes out reading
   "Hi {{first_name}}".

Write the confirmed syntax into the plan next to the skeleton, with where it came from.

**This skill still sends nothing.** Finding the sender's syntax is not connecting to the
sender.

## What this skill will not do

- **It will not spend a credit.** Zero endpoints, zero API calls. If a design seems to
  need a fetch, the fetch belongs upstream and the design should wait for it.
- **It will not write a claim.** It writes slots and the rules for filling them. The
  claims are [`/personalize`](../personalize/SKILL.md)'s, under the Iron Law that no
  claim ships without a source line behind it.
- **It will not grade evidence** and it will not decide whether a fact is supported.
  That is [`/evidence-score`](../evidence-score/SKILL.md).
- **It will not produce the artifact a sending tool ingests.** That artifact has exactly
  one author in this pack — [`/launch`](../launch/SKILL.md) — and it is bound to a PASS
  verdict and the audience's content hash. This skill hands off to it and never
  substitutes for it.
- **It will not send, schedule, warm up an inbox, dial, or take a LinkedIn action.**
  Those are outside the pack permanently, not pending. A step on the plan marked
  *human, in the dialer* means exactly that.
- **It will not decide whether the cadence is lawful.** Consent, lawful basis and the
  records behind them are [`/comply`](../comply/SKILL.md)'s, and a beautifully spaced
  sequence to someone with no lawful basis is still a violation.
- **It will not sign the campaign off.** [`/campaign-review`](../campaign-review/SKILL.md)
  forms the verdict; a designer approving their own design is not a review.

## Related

- The claims that fill the slots: [`/personalize`](../personalize/SKILL.md), and the
  grading that decides which of them may be used:
  [`/evidence-score`](../evidence-score/SKILL.md).
- The evidence both of those read: [`/account-research`](../account-research/SKILL.md).
- The audience: [`/build-prospect-list`](../build-prospect-list/SKILL.md), cleaned and
  screened by [`/list-hygiene`](../list-hygiene/SKILL.md).
- Lawful basis before persuasion: [`/comply`](../comply/SKILL.md).
- Sign-off, then the hand-off:
  [`/campaign-review`](../campaign-review/SKILL.md) forms the verdict and
  [`/launch`](../launch/SKILL.md) acts on it. `gates.yaml:skills.launch.require_pass_verdict`
  can be tightened and never disarmed, and a verdict older than
  `gates.yaml:skills.campaign_review.verdict_max_age_hours` is stale even when nothing
  changed — so design the cadence close to when it will actually run.
- Inbound leads that need a nurture cadence rather than a call:
  [`/inbound`](../inbound/SKILL.md).
- What the whole sequence is ultimately measured on:
  [`/measure`](../measure/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
