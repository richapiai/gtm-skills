# /reply-triage

Every reply out of your sender sorted into buckets a rep can act on, with every opt-out
written into the do-not-contact store before anything else happens.

## The problem this solves

You sent 800 emails and 60 came back. Most of it is noise: out-of-office, "wrong person,
try Jane", one furious "take me off this list". Somebody skims the pile on a Thursday,
forwards two to the AE, and misses the one that asked to be removed. That person gets
the next campaign, files a spam complaint, and now it is not a missed lead. It is your
sending domain and somebody's definition of consent.

## When to use it

- "Here are 40 replies from last week's send. What did people actually say?"
- "Who is interested, and which of these do I have to answer today?"
- "Someone asked to be taken off. Make sure that actually sticks."
- "Half of these look like auto-replies. Sort them."
- "Is this an objection I should answer, or a real no?"

## When NOT to use it

- **You want it to read your inbox.** There are no inbox endpoints in this API, and
  inbox hosting is permanently outside what this pack does. Replies arrive as a paste,
  or as the reply export you pull out of your own sender.
- **You want the replies sent.** It drafts. It does not send, and that includes the
  reply to an interested prospect. The one file this pack writes for a sending tool
  belongs to [`/launch`](launch.md).
- **You want somebody un-suppressed.** Reversing an entry is erasure-shaped and belongs
  to [`/comply`](comply.md), behind an explicit confirmation.
- **Your suppression store is unreadable.** No triage, no drafts, no routing. An opt-out
  it cannot record is an opt-out that gets lost. Run `./setup`.
- **You want the address of the colleague a wrong-person reply names.** A name is a name.
  Sourcing Jane is a separate priced decision: [`/enrich-waterfall`](enrich-waterfall.md).
- **You want a ruling on whether the original send was lawful.** Triage reads what came
  back. Lawful basis and consent records are [`/comply`](comply.md).
- **You want to screen a list before it goes out.** That is
  [`/list-hygiene`](list-hygiene.md), then [`/campaign-review`](campaign-review.md).
- **You want to know why so many people are opting out.** A wave of opt-outs is usually
  a copy or deliverability problem: [`/outreach-expert`](outreach-expert.md), with the
  pattern across a quarter in [`/gtm-retro`](gtm-retro.md).
- **You have a call recording, not an email.** Same job, different input:
  [`/call-intel`](../../skills/call-intel/SKILL.md).

## What it costs

Free on the default path, and that is the most surprising thing about this skill. Zero
paid calls, no API key, nothing on the ledger. A whole batch can be read, suppressed and
routed against a checkout with no RichAPI account at all, because reading a two-line
email and deciding what it says is something the agent already does at no marginal cost.

There is exactly one paid escape and only volume switches it on. Past
`skills.reply_triage.ai_enrich_batch_min_rows`, holding every reply in context stops
being the right tool and the classification is batched out to the `ai_enrich` endpoint.
That threshold is **200 replies**, and one batch is capped at
`skills.reply_triage.max_replies_per_run`, which is **1000**. Both are read from
`_lib/gates.yaml`; print them with `richapi gates skills.reply_triage`. Below that first
line the paid hop is never justified.

What a batch costs comes from the dry run, which makes zero calls, costs nothing, needs
no key and always runs first. No credit price is written on this page on purpose: prices
live in `_lib/api-catalog.json` and they are read at plan time.

Two things about that hop matter on an inbox you triage weekly. Its output is never
served from cache, because non-deterministic output cannot honestly be cached, so every
batch is paid in full every time. And the opt-out decision never goes through it, at any
scale: a batched call that times out or comes back unparseable leaves a hole, and a hole
in the opt-out pass is an unsubscribe nobody recorded and nothing can detect afterwards.

## What you get

Three things, in this order, and the order is the point.

**Entries in `gtm/suppression.jsonl`**, written before any draft is composed and before
any list is produced. Each carries a reason and a source, so the line is auditable a year
later. A run that dies after drafting and before suppressing has produced exactly the
failure this skill exists to prevent. The other order costs you a re-run and nothing else.

**A triage report that leads with suppressions**, and splits the count two ways: plain
opt-outs, and replies the skill could not read confidently and suppressed anyway. That
second number is the one to watch. If it is large, either the copy is provoking replies
nobody can interpret or the fail-closed rule is costing you real leads, and you cannot
tell which without seeing the split. Scope is named per entry, address or domain, because
a domain entry removes everybody at that account including the champion who said nothing.

**The buckets, each with the line it was decided from.** Interested, objection, not now,
wrong person. Interested replies are named individually with their quote, because those
are the rows somebody is going to act on today. An out-of-office is filed as "not now",
never as interest, because counting auto-replies as engagement makes a reply rate
useless. An objection is filed as engagement, because a reply that argues with you read
you. A bucket with no quotable line behind it does not get written.

A reply with no address is written `not_applicable`. It can be read. It cannot be
suppressed, and the report says so rather than quietly classifying it.

## How to run it

Say it in plain English: *"Triage these replies"*, then paste them. Or *"process my
inbox"*, *"handle unsubscribes"*, *"who replied and what did they say?"*

There is no `richapi reply-triage` command, and the default path uses no CLI verb at all,
because nothing it does reaches an endpoint. Only the batch path touches the runtime, and
only past the row count above:

```console
$ richapi gates skills.reply_triage
$ richapi call ai_enrich --in replies.csv --out classified.csv \
    --param provider=<provider> --param output_type=json --dry-run
```

## What it needs first

`./setup` once, and here that is not the formality it is elsewhere. The suppression store
is where the opt-outs go, so `SUPPRESSION: STOP` from `richapi preflight` stops the whole
run rather than letting it triage now and record later. Then the replies themselves,
pasted or exported out of your sender. Nothing else has to have run, and the interested
ones hand off to [`/inbound`](inbound.md) for an owner.
