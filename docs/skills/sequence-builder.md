# /sequence-builder

A written cadence for one segment: how many steps, how many days apart, on which channel,
what each step is for, and a copy skeleton in your sending tool's own merge-tag syntax.

## The problem this solves

Someone asks how many follow-ups the campaign should have and the answer is whatever the
last rep set up. So the sequence is five emails in nine days, three of them opening with
"just following up on my last note", nobody knows what takes a person out of it, and the
unsubscribes are climbing. The shape of a cadence decides more of the outcome than the
copy does, and the shape is usually the part nobody wrote down. This skill writes it
down, with the reasoning next to each number.

## When to use it

- "How many follow-ups should this be, and how far apart?"
- "What is step three even supposed to say?"
- "We have the drafts. Turn them into a campaign."
- "Our sequence is three emails in four days and people are unsubscribing."
- "Half this segment has a researched fact and half does not. What do I send them?"

## When NOT to use it

- **You want the copy itself.** This skill writes slots and the rules for filling them.
  The sentences are [`/personalize`](personalize.md)'s, and it refuses any claim the
  research cannot source.
- **You want to know whether a fact is usable.** That is
  [`/evidence-score`](evidence-score.md).
- **You want the file your sending tool imports.** One skill in this pack writes that,
  [`/launch`](../../skills/launch/SKILL.md), and only against a passing review. A design
  document is not an import file.
- **You want the campaign signed off.** That is
  [`/campaign-review`](../../skills/campaign-review/SKILL.md). A designer approving their
  own design is not a review.
- **You want the emails sent, an inbox warmed, a number dialled or a LinkedIn action
  taken.** All permanently outside this pack. A call step on the plan means a human runs
  it in your dialer.
- **You want to know whether the cadence is lawful.** That is
  [`/comply`](../../skills/comply/SKILL.md). Good spacing is not consent.
- **You want to know why the mail is landing in spam.** That is deliverability, and it is
  [`/outreach-expert`](outreach-expert.md).

## What it costs

Free. Zero endpoints, zero API calls, with or without an API key. Sequence design is
thinking over work that has already been done and paid for: the evidence came from the
research brief, the copy from the drafting skill, the audience from the list. A design
that needs a fresh lookup is a sign the lookup belongs upstream.

## What you get

A markdown file at `gtm/sequences/<segment>.md`, containing:

- **A step table**: step number, day, channel, the job that step does, whether it
  continues the previous thread or starts a new one, and which slots it uses. A step whose
  job is "touch them again" is the step that produces the unsubscribe, so every step has
  to name a different one.
- **A skeleton per email step**, written in the merge-tag dialect of the tool your team
  actually sends from. Smartlead, Instantly and Lemlist each spell tags and fallbacks
  differently, and a skeleton in the wrong dialect gets hand-translated later by someone
  who will get one of them wrong. Every tag carries its fallback, because an empty merge
  in a subject line is the thing that gets screenshotted.
- **The no-evidence rendering for every conditional step.** When only part of the segment
  has a researched fact, the honest answer is one step with two renderings, and the
  version with no fact is the one that has to stand on its own.
- **An exit condition and an ending.** What pulls a row out early (a reply, a meeting, a
  bounce, an unsubscribe) and where the row goes when the sequence is over. A cadence with
  no defined end is a cadence someone stays in forever.
- **The assumptions, written out**: the timezone and business calendar, the evidence
  coverage the personalised steps depend on, and which steps a human executes elsewhere.

Three numbers shape the plan, and each is read from the gate file with its key, its
source, the date it was last checked and its confidence: the maximum number of touches,
the floor on the gap between them in business days, and the total window. They are
conventions, not physics. Your sending platform's current published guidance and your own
reply data both outrank them, and the plan says which it used.

## How to run it

Ask Claude in plain English:

> "Design a five-step sequence for mid-market RevOps leaders. One ask: book a call."

> "How many follow-ups, how far apart, and what is each one for?"

> "Turn these drafts into a cadence for Smartlead."

There is no CLI verb for this and there is not meant to be. The one command worth running
prints the three cadence numbers with the key each came from:

```console
$ richapi gates skills.sequence_builder
```

## What it needs first

Nothing that costs money, and four answers you have to supply:

1. **Which segment.** Not "the list". Two segments with different pains need two
   sequences, and one sequence aimed at both is the cadence everyone deletes.
2. **The one ask.** Book a call, start a trial, reply yes or no. A cadence with two asks
   has none.
3. **Which channels you can actually run.** This pack prepares email. Anything else goes
   on the plan marked as a human step in another tool.
4. **What the personalised steps can stand on**, which comes from
   [`/account-research`](account-research.md) and
   [`/evidence-score`](evidence-score.md). Thin coverage is not a reason to skip the
   design, it is a reason to design the claim-free step first.

Run it before [`/personalize`](personalize.md) if you want the drafts to have a defined
slot to land in, and before
[`/campaign-review`](../../skills/campaign-review/SKILL.md) and
[`/launch`](../../skills/launch/SKILL.md), which are the sign-off and the export.
