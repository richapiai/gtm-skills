---
name: outreach-expert
version: 1.0.0
description: >
  Advises on outreach setup up to (and only up to) the send button: domain and mailbox
  strategy, SPF/DKIM/DMARC, warmup, sender rotation, deliverability diagnosis, bounce
  handling and sequence hygiene. Use when asked "my emails go to spam", "how do I warm
  up a domain", "SPF DKIM DMARC", "how many mailboxes", "sender rotation", "how many
  steps in the sequence", "bounces are climbing", or "review my sending setup". It never
  sends, warms, or configures anything — sending execution is outside this pack
  permanently. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Read
triggers:
  - my emails go to spam
  - domain warmup
  - spf dkim dmarc
  - sender rotation
  - how many mailboxes do i need
  - bounces are climbing
  - review my sending setup
  - outreach sequence hygiene
---

# Outreach setup — everything up to the send button

A bad sending configuration does not fail loudly. It burns a domain: reputation decays
over weeks, replies stop arriving, and by the time anyone notices, the fix is buying new
domains and waiting out a warmup. That is an expensive, slow, entirely preventable
failure, and preventing it is what this skill is for.

What it is not for is sending. Read the next section before anything else, because the
gap it describes is permanent and this skill is useless if a user misreads it.

## The one thing this skill cannot do, and never will

**It does not send.** Nothing in this skill causes an email to leave. There is no
sending endpoint in [`_lib/api-catalog.json`](../../_lib/api-catalog.json) — every
endpoint in this pack reads data; none of them delivers a message. That is deliberate
and it is permanent. The README lists sending execution under [*External
forever*](../../README.md#what-this-pack-will-not-do), for a reason worth restating in full: **owning sending means owning spam
complaints.** A data API that also sends inherits every customer's list hygiene, and one
bad sender takes down the shared reputation of everyone else on it.

That same section puts four more things permanently outside this pack, and
all four are things an outreach advisor gets asked for:

- **Inbox hosting.** The pack does not create, own or operate mailboxes.
- **Warmup execution.** Warmup *is* sending. This skill can tell you what a ramp should
  look like; it cannot run one, and no part of this pack can.
- **LinkedIn actions** — profile views, connection requests, DMs. ToS risk, and out
  permanently. An earlier version of this skill claimed the pack could drive the
  LinkedIn half of a multi-channel play "when paired with the automation layer". There
  is no automation layer, there never was one in this pack, and that sentence is the
  reason this section is this long.
- **Dialer and live calling**, and **direct mail**.

So this skill produces decisions, checks and a written setup review. Every one of them
is executed by the user, inside their own sending tool, under their own domain
reputation. Say that at the end of every session rather than letting a confident plan
imply it has been put into effect.

## What it spends

Nothing. This skill owns **no endpoints** —
[`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml) assigns it none, which is
right: deliverability advice is reasoning, and the two data checks that genuinely help
before a send already belong to skills that own them and price them. It makes zero paid
calls. Law 3 asks that every paid call be named and costed before it runs; naming none
is how this skill satisfies it.

The pack's real pre-send contributions, and who owns them:

| Check | Owner |
|---|---|
| Verify each address before it is ever mailed | [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — the `email_verifier` hop |
| Separate role, free and disposable addresses | [`/list-hygiene`](../list-hygiene/SKILL.md) — `identify_email_type` |
| Drop dead domains before they bounce | [`/list-hygiene`](../list-hygiene/SKILL.md) |
| Decide the list may be contacted at all | [`/comply`](../comply/SKILL.md) |

Route to those. Do not re-implement them here, and do not describe their cost — the
catalog is the source of truth for that and it changes.

## Inference mode — local, always

**Mode: local inference only. Zero LLM hops.**

`ai_enrich` is not in this skill's endpoint set and never will be. Reading a DMARC
record, spotting that a subject line has three brackets in it, or noticing that a
sequence has no break-up step is reasoning over text in front of you, and this pack
already runs inside a model that does that for free. Paying an endpoint to re-read a
sentence you were handed is the waste local inference exists to stop.

Neither permitted exception reaches this skill. **Perplexity web grounding** does not
apply: a live deliverability question is answered by the user's own sender dashboards
and DNS, not by a web search — and where a vendor's current documentation genuinely is
the answer, the honest move is to tell the user to read it. **Batch scale** does not
apply: there is no per-row work here at all. A sending setup is one configuration, not
a list.

## Before anything else

```bash
richapi-skills-preflight
```

- `API_KEY_SET: no` — **not a blocker.** No paid call happens in this skill. Say so
  rather than sending the user off for a key.
- `SUPPRESSION: STOP` — **not a blocker for the advice, and a hard blocker for the
  send.** A suppression check that could not run is not a passing check (law 5). If the
  user is about to configure a real campaign, `./setup` now is cheaper than
  discovering it at launch.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen` before naming any endpoint,
  even in passing. An endpoint name should be read, never recalled.

## Step 1 — name which of the six questions this is

Outreach questions arrive tangled. Answer the load-bearing one first and stack the rest;
a reply that covers all six covers none.

| Bucket | Sounds like |
|---|---|
| **Infrastructure** | new domain, mailbox count, SPF/DKIM/DMARC, tracking domain, rotation |
| **Deliverability diagnosis** | "we're in spam", replies dried up, bounces climbing |
| **Sequence hygiene** | how many steps, what cadence, when to stop, break-up |
| **Copy** | subject lines, first lines, merge tags and their fallbacks |
| **Tool selection** | which sending platform, what to look for in one |
| **Compliance** | unsubscribe, consent, records. Route it — see below |

## Step 2 — infrastructure, in dependency order

Infrastructure is the only part of outreach where the ordering is not a matter of taste.
Each item below is a precondition for the one after it, and doing them out of order
wastes the warmup.

1. **Sending domains are separate from the primary domain.** A blocklisting on the
   company's main domain takes support, billing and inbound sales with it. Cold sending
   happens from lookalike domains that can be abandoned.
2. **Authentication is complete on every sending domain before a single message goes
   out.** SPF must list every service that sends as the domain, and only those. DKIM
   must be published and verifiable — `dig txt <selector>._domainkey.<domain>` is the
   check, and running it is the difference between believing it works and knowing.
   DMARC starts in monitoring mode (`p=none`) with a reporting address someone reads,
   moves to `p=quarantine` once the reports are clean, and never starts at `p=reject`
   on a live domain.
3. **Click tracking uses a dedicated tracking domain**, not the sending platform's
   shared one. On a shared tracking host your links inherit the reputation of everyone
   else using it, and you cannot see or influence that.
4. **Then, and only then, warmup.** Warming an unauthenticated domain teaches the
   receivers nothing except that an unauthenticated domain is sending.
5. **Volume scales by adding mailboxes, never by raising per-mailbox volume.** Rotation
   distributes a day's sends across mailboxes so that no single one exceeds a safe rate.
   At the very top that rate is 50 (`gates.yaml:skills.outreach_expert.max_sends_per_mailbox_per_day`),
   and step 5 says where the number comes from and how much to trust it. Mailboxes needed is daily
   volume divided by that ceiling, rounded up, with the per-mailbox figure kept well
   under it on anything new.

## Step 3 — the metrics that decide whether to keep sending

Open rate is not one of them. Since Apple Mail Privacy Protection began prefetching
tracking pixels, open rate measures Apple's prefetcher on any list with a meaningful
share of Apple clients, which is most B2B lists. Optimising it optimises a proxy for
nothing.

Four numbers matter, and the pack has an opinion about three of them:

| Signal | Where the threshold lives |
|---|---|
| Positive reply rate | The hero metric. No pack threshold; it is a target, not a gate |
| **Hard bounce rate** | `gates.yaml:quality_stops.verification_max_hard_bounce_pct` |
| **Verification fail rate on the source list** | `gates.yaml:quality_stops.verification_max_fail_rate_pct` |
| **Spam complaint rate** | `gates.yaml:skills.outreach_expert.spam_complaint_max_pct`, measured on the receiver's own postmaster tooling and nowhere else |

The first two gate keys are not decoration: they are the same thresholds
[`/campaign-review`](../campaign-review/SKILL.md) enforces before
[`/launch`](../launch/SKILL.md) will write anything. A list that fails them is not a
deliverability problem to be tuned around — it is a sourcing problem, and continuing to
send it is how a domain gets burned to prove a point that was already proven.

## Step 4 — diagnosing a live deliverability problem

Cheapest check first, because the cheap ones are also the most common causes.

1. **Authentication.** Re-verify SPF, DKIM and DMARC on the domain that is actually
   sending, not the one that was set up. A service added later that is missing from SPF
   is the single most common cause.
2. **Blocklists.** Check the sending domain and the sending IPs.
3. **List quality.** Re-run [`/list-hygiene`](../list-hygiene/SKILL.md) over the list.
   If the hard-bounce rate is over `gates.yaml:quality_stops.verification_max_hard_bounce_pct`,
   stop sending it; nothing about the sending configuration will fix a bad list.
4. **Warmup state.** Read the sender's own warmup dashboard. A ramp that was paused and
   never resumed looks exactly like a healthy one in every other view, and a ramp
   shorter than `gates.yaml:skills.outreach_expert.warmup_min_days` has not finished
   however healthy it looks.
5. **Send rate per mailbox.** Divide yesterday's volume by the number of live mailboxes
   and compare it with `gates.yaml:skills.outreach_expert.max_sends_per_mailbox_per_day`.
   Rotation makes a total look fine while one mailbox carries most of it.
6. **Reputation at the receiver.** Google Postmaster Tools and Microsoft SNDS report
   what the receiver actually thinks, which is the only opinion that decides delivery.
7. **Only then, copy and content.** Modern filters are statistical, not keyword lists,
   so the old spam-word folklore is mostly cargo cult. What genuinely still hurts:
   tracked links on first contact, image-heavy HTML, URL shorteners, attachments on a
   cold first message, and a display name that does not match the reply-to domain.

If the answer is "pause and re-warm", say that plainly. It is a slow, boring, correct
answer and users talk themselves out of it because it costs weeks.

## Step 5 — the four numbers this skill refuses to hand-type, and reads from a key

An outreach advisor wants to say "warm for this many days" and "cap each mailbox at this
many sends a day". This skill says both, and it says neither from memory: the values live
in `_lib/gates.yaml` under this skill's namespace, where one edit updates every reader
and every number carries its source, the date it was last checked, and its confidence.

| Rule | Value | Key |
|---|---|---|
| Per-mailbox daily ceiling | 50 sends per mailbox per day | `gates.yaml:skills.outreach_expert.max_sends_per_mailbox_per_day` |
| Warmup minimum | 21 days of ramp before real traffic | `gates.yaml:skills.outreach_expert.warmup_min_days` |
| Spam complaint ceiling | 0.1% of delivered mail | `gates.yaml:skills.outreach_expert.spam_complaint_max_pct` |
| Unsubscribe ceiling | 1% of delivered mail | `gates.yaml:skills.outreach_expert.unsubscribe_max_pct` |

**Why these are values when a credit price may never be one.** Law 1 forbids a
hand-typed number because prices reprice quarterly — the pack's own proof is
`phone_finder`, which repriced more than eight-fold inside four months, and the
catalog is the only place its cost may be read. That is an argument about
volatility, and it does not carry to receiver policy: per-mailbox send ceilings, warmup
ramps and complaint thresholds are conventions revised on a scale of years, and the
bulk-sender requirements that reset the field landed once, in early 2024. So the file
holds them as numbers, and law 1 still holds where it was aimed — not one credit number
appears in this skill.

**What that does not buy is certainty, and the honest caveat survives the numbers.**
This skill executes nothing; every figure above is advice the user applies inside their
own sending tool, under their own domain reputation. Only one of the four has a
published receiver source (the complaint ceiling, from the bulk-sender requirements and
readable only in the receiver's own postmaster tooling). The other three are platform
convention, pinned at the conservative end of their range. So state the number, name the
key it came from, and tell the user to check it against the current published guidance
of the platform they actually send from — that guidance wins, in both directions. A
confident wrong number here costs a domain.

Step count and spacing are not on that list on purpose. Those belong to
[`/sequence-builder`](../sequence-builder/SKILL.md), which owns the cadence and holds
its own keys under its own namespace. Two skills carrying the same threshold under two
names is how one of them silently goes stale.

## Step 6 — sequence hygiene, which is not sequence design

[`/sequence-builder`](../sequence-builder/SKILL.md) designs the cadence: how many steps,
how far apart, on which channel, and what each step is for. Do not redesign it here.
What belongs here is the narrow set of sequence properties that decide whether the
messages arrive at all:

- **Plain text on first contact.** Signatures, images and tracking pixels on a cold
  first message are a deliverability cost paid for a reporting benefit that Apple Mail
  Privacy Protection already destroyed.
- **Tracking off, or on a dedicated domain, for step one.** Same reasoning as step 2.
- **Every merge tag has a fallback.** An empty merge in a subject line is the clearest
  possible signal that nobody read this before it went out. Validate that the list has a
  value for every tag *before* the campaign is configured —
  [`/list-hygiene`](../list-hygiene/SKILL.md) is where that check lives.
- **A defined end.** A cadence with no last step keeps mailing people who have already
  decided, and their complaints are what the receiver measures.
- **Reply handling is staffed.** A campaign nobody answers produces complaints instead
  of meetings, and complaints are the metric that closes a domain.

Personalisation depth should match deal size rather than ambition, and
[`/personalize`](../personalize/SKILL.md) owns that decision and the evidence behind it.

## Compliance is a gate, and it is not this skill

Do not restate compliance rules here. [`/comply`](../comply/SKILL.md) is the gate; it
returns a verdict and a `stop` from it ends the run. The regimes it has rule sets for
are exactly `gates.yaml:skills.comply.jurisdictions`, and a jurisdiction with no rule
set is a refusal, not a pass.

Three points are genuinely sender-configuration questions and belong here:

- Every cold message needs a working unsubscribe path.
  CAN-SPAM requires an opt-out request be honoured within 10 business days.
- An unsubscribe must suppress across the whole account, not one sequence. Feed it back
  into the pack's suppression store or the next list will re-import them.
- A one-click list-unsubscribe header is now effectively mandatory for bulk senders at
  the large receivers. It is a sender setting; check it is on.

Anything else (consent basis, records, retention) route to [`/comply`](../comply/SKILL.md).
**Neither skill is legal advice.** This one enforces nothing at all; it advises, and a
regulator reads the statute rather than this file.

## Step 7 — report what was decided, and what did not happen

Close every session with both halves:

- **Decided:** the domain and mailbox plan, the authentication state, the metrics being
  watched and their thresholds, the sequence changes.
- **Not done:** no DNS record was changed, no mailbox was created, no warmup was
  started, no message was sent, and nothing was configured in any sending tool. Those
  are all the user's to perform.

If a campaign is genuinely ready to go out, the route is
[`/campaign-review`](../campaign-review/SKILL.md) for the verdict and then
[`/launch`](../launch/SKILL.md), which writes the file the sending tool reads — and only
against a PASS verdict no older than
`gates.yaml:skills.campaign_review.verdict_max_age_hours`. This skill does not write
that file and must not be asked to.

## Step 7b — the standing rules the user has already set

Before advising, read `gtm/preferences.jsonl` for `sequence`-scoped rules and
[`gtm/profile.yaml`](../gtm-onboard/SKILL.md) for `sender`. Advice that contradicts a
decision the user already made and recorded is advice they have to spend a turn
rejecting, and it erodes trust in everything else in the session.

Where a standing rule and this skill's recommendation genuinely conflict, say so
explicitly — name the rule, name the recommendation, and let the user decide. Do not
quietly follow the rule, and do not quietly override it. A recorded decision deserves an
argument, not a silent edit.

**`unreadable`** is a STOP. **`absent`** is normal and not worth more than a sentence.

## Step 8 — check what the stack can already reach

Advice the user cannot execute is advice that does not land. Once the recommendations
exist, work the ladder in
[`docs/destination-handoff.md`](../../docs/destination-handoff.md) against the tools
named in them:

1. **An MCP server for the sender, the DNS provider or the inbox provider, available in
   this session.** If the DNS provider is reachable, the SPF/DKIM/DMARC records in Step 2
   stop being a checklist the user retypes and become something they can verify in place.
   Name the tool and ask; do not change a DNS record because you can.
2. **The provider's API docs or Postman collection.** For a deliverability diagnosis this
   is often the fastest route to the number that settles it — bounce classification,
   per-domain reputation, sending limits.
3. **Neither.** Give the manual path, which for DNS and warmup is the normal one anyway,
   and say what you checked.

**Nothing here moves the send button.** This skill's boundary is unchanged: it advises up
to the send and never sends, and an available integration does not extend that.

## What this skill will not do

- **It will not send anything, ever.** No endpoint in this pack delivers a message.
  Sending execution is [*External forever*](../../README.md#what-this-pack-will-not-do) because owning
  sending means owning spam complaints. Every plan produced here is executed by the user
  in their own tool.
- **It will not warm a domain or a mailbox.** Warmup is sending. It can describe a ramp;
  it cannot run one.
- **It will not host, create or configure an inbox**, and it will not touch DNS. It
  tells the user which records to check and how to check them.
- **It will not take a LinkedIn action.** Profile views, connection requests and DMs are
  out permanently on ToS grounds. Any earlier claim that this pack automates them was
  wrong.
- **It will not dial anyone or post physical mail.** Both are permanently out.
- **It will not design the sequence.** Step count, spacing and channel belong to
  [`/sequence-builder`](../sequence-builder/SKILL.md). This skill only rules on the
  parts of a cadence that decide whether the messages are delivered.
- **It will not write the sender export.** [`/launch`](../launch/SKILL.md) is the sole
  writer of that artifact, bound to a PASS verdict and the list's content hash. A second
  writer would make every review upstream of it advisory.
- **It will not clear a list for sending.** [`/comply`](../comply/SKILL.md) does that and
  can refuse a campaign this skill helped design.
- **It will not spend credits.** It owns no endpoints and makes no paid calls.
- **It will not type a warmup ramp, a per-mailbox volume or a complaint threshold from
  memory.** Those four values live in `_lib/gates.yaml` under this skill's namespace and
  are read from there, with the key named alongside every one of them.
- **It will not present those four as settled fact.** Three of them are platform
  convention pinned at the conservative end of a range, not published receiver policy,
  and the pack cannot measure any of them. The current guidance of the platform the user
  sends from outranks this file, and the skill says so every time it quotes one.

## Related

- [`/list-hygiene`](../list-hygiene/SKILL.md) — normalisation, dead domains and address
  typing; the cheapest deliverability work there is
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — finds and verifies the addresses,
  with a dry-run plan and a per-hop cost
- [`/comply`](../comply/SKILL.md) — the hard gate on whether a contact may be contacted
- [`/campaign-review`](../campaign-review/SKILL.md) — the verdict a list needs before any
  outbound artifact exists
- [`/launch`](../launch/SKILL.md) — the sole writer of the sender-format export, and the
  last point at which the pack can still refuse
- [`/sequence-builder`](../sequence-builder/SKILL.md) — owns the cadence itself: step
  count, spacing, channel and the sender-native copy skeleton
- [`/personalize`](../personalize/SKILL.md) — how much personalisation the deal size
  actually justifies
- [`/measure`](../measure/SKILL.md) — reads what came back, once the user has the
  campaign running in their own tool
- [`/crm-sync-expert`](../crm-sync-expert/SKILL.md) — the storage-side counterpart:
  mapping, dedupe keys and what a CRM silently damages, also advisory
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session receipt
- The stated boundary, in full: [`../../ROADMAP.md`](../../ROADMAP.md#out-of-scope)
