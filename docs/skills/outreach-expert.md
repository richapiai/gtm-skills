# /outreach-expert

A straight answer on your sending setup: domains, mailboxes, SPF/DKIM/DMARC, warmup,
send rates, and why the mail is going to spam. Advice you execute, not a thing it runs.

## The problem this solves

Replies dried up three weeks ago and nobody knows when it started. Or you are standing up
outbound from scratch and the setup checklist you found online has nine steps in no
particular order. A bad sending configuration does not fail loudly. Reputation decays over
weeks, and by the time it is obvious the fix is buying new domains and waiting out another
warmup. This skill tells you what to check, in the order that matters, and which of the
things you are worried about are not actually the problem.

## When to use it

- "Our emails are going to spam and I do not know why."
- "How many mailboxes do I need to send 400 a day?"
- "Do I need a separate domain for cold outbound, or can I use ours?"
- "Someone said set DMARC to reject. Is that right?"
- "Bounces went from 2% to 9% this week."
- "Is my open rate dropping because of Apple, or because we have a real problem?"

## When NOT to use it

- **You want it to send, warm up, or configure anything.** No endpoint in this pack
  delivers a message, and that is permanent. Warmup is sending, so it can describe a ramp
  and cannot run one.
- **You want DNS changed or a mailbox created.** It tells you which record to check and
  the command to check it with. You make the change.
- **You want LinkedIn touches, dials, or direct mail.** All permanently outside this pack.
- **You want the sequence designed.** Step count, spacing and channel belong to
  [`/sequence-builder`](sequence-builder.md). This skill only rules on the parts of a
  cadence that decide whether the mail arrives.
- **You want the list cleaned or the addresses verified.** Those have owners:
  [`/list-hygiene`](list-hygiene.md) for dead domains, role and disposable addresses, and
  [`/enrich-waterfall`](enrich-waterfall.md) for the verification hop.
- **You want the export or the sign-off.**
  [`/campaign-review`](../../skills/campaign-review/SKILL.md) forms the verdict and
  [`/launch`](../../skills/launch/SKILL.md) writes the file your sending tool reads.
- **You want a ruling on consent, records or lawful basis.** That is
  [`/comply`](../../skills/comply/SKILL.md), and neither skill is legal advice.

## What it costs

Free. It owns no endpoints and makes no API calls, with or without a key. Deliverability
advice is reasoning over a DNS record, a dashboard reading and a sequence you paste in,
and this pack already runs inside a model that reads those for nothing.

The four numbers it quotes come out of `_lib/gates.yaml`, under this skill's namespace,
where each one carries its source, the date it was last checked and how much to trust it:

| Rule | Key |
|---|---|
| Sends per mailbox per day | `skills.outreach_expert.max_sends_per_mailbox_per_day` |
| Minimum warmup ramp | `skills.outreach_expert.warmup_min_days` |
| Spam complaint ceiling | `skills.outreach_expert.spam_complaint_max_pct` |
| Unsubscribe ceiling | `skills.outreach_expert.unsubscribe_max_pct` |

Read them rather than trusting a number in a doc:

```console
$ richapi gates skills.outreach_expert
```

Only the complaint ceiling has a published receiver source, and even that one is measured
in the receiver's own postmaster tooling, never here. The other three are platform
convention pinned at the conservative end of their range. The current guidance of the
platform you actually send from beats all of them, in both directions.

## What you get

A written review, in the session. This skill reads and reasons; it writes no file and
changes nothing, and that is why the review always closes in two halves:

- **Decided**: the domain and mailbox plan, the authentication state, the mailbox count
  the volume needs, the metrics you are watching and the threshold on each, and the
  sequence hygiene changes.
- **Not done**: no DNS record changed, no mailbox created, no warmup started, no message
  sent, nothing configured in any sending tool. All of that is yours to perform.

For a live problem you get the diagnosis in cheapest-first order, because the cheap causes
are also the common ones: authentication on the domain that is actually sending, then
blocklists, then list quality, then warmup state, then the real per-mailbox send rate,
then what the receiver's own dashboard says, and only then the copy. Two answers show up
often and both are unwelcome: pause and re-warm, which costs weeks, and stop sending this
list, which is a sourcing problem that no amount of setup tuning fixes.

You also get told which numbers not to chase. Open rate is one: Apple Mail Privacy
Protection prefetches tracking pixels, so on most B2B lists it measures the prefetcher.

## How to run it

Ask Claude in plain English:

> "Our cold emails are going to spam. Where do I start?"

> "I need to send 400 a day. How many domains and mailboxes, and what do I set up first?"

> "Here is my DMARC record and my sequence. Tell me what is wrong with it."

There is no CLI verb for deliverability, and there will not be one, because the pack does
not send. The commands that come up are the gate lookup above and DNS checks you run
yourself, for example:

```console
$ dig txt <selector>._domainkey.<yourdomain>
```

## What it needs first

Nothing in this pack has to run before it. You can ask it on day zero, before a domain
exists, and getting the infrastructure order right then is the cheapest version of this
conversation.

Two things make the answer better: [`/list-hygiene`](list-hygiene.md) over the list you
plan to send, because a high bounce rate is a list problem and not a setup one, and
[`/comply`](../../skills/comply/SKILL.md) before any of it. Run `./setup` once so the
do-not-contact store exists. The advice works without it; the send does not.
