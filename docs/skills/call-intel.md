# /call-intel

A structured read of one call transcript: the objections raised, the next steps agreed,
the competitors named, and what your side committed to. Every item quotes the line it
came from.

## The problem this solves

You had a 45-minute discovery call. Three days later someone asks what the objection
was, and you are scrolling a transcript trying to remember whether they actually said
the budget was frozen or whether you inferred it. Meanwhile the summary tools that
promise to fix this are the exact tools that will hand you a confident, plausible
objection nobody raised. This skill will not do that. Every item it reports is anchored
to a verbatim line, and a call that produced no objection returns no objections rather
than a likely-sounding one.

## When to use it

- "Summarise this call."
- "What were the objections?"
- "Pull the next steps out of this transcript."
- "Who did they mention — did a competitor come up?"
- "What did we actually commit to on that call?"

## When NOT to use it

- **Recording, dialling or transcribing.** There is no telephony and no speech
  recognition in this pack, permanently. Bring a transcript your existing tool made.
- **Logging the call to your CRM.** That is a field-mapping job with its own duplicate
  problem. [`/crm-sync-expert`](crm-sync-expert.md) designs it;
  [`/crm-export`](crm-export.md) writes a file you import.
- **Sending the follow-up.** Sending is external to this pack, permanently. The next
  steps are input to someone else's send.
- **Deciding whether the deal is good.** It reports what was said. The judgement is
  yours.

If you already use Gong, Fathom or Granola, they cover a lot of this and they are
already in your workflow. The thing this adds is the refusal to invent, and the
explicit null.

## What it costs

**Free by default.** Reading the transcript and marking the spans is local work — zero
API calls, no key needed.

There is one optional paid step for batch scale, and it is opt-in. Like everything in
the pack, it is named and priced in a dry run before it runs, and the price comes from
the generated catalog rather than from anything written in a document.

## What you get

A structured record per call: objections, next steps, competitors mentioned,
commitments made. Each item carries the verbatim line it came from. Where the call
produced nothing for a field, you get an explicit null that says "analysed, nothing
there" rather than a missing field that reads as "not analysed".

That distinction is the point. A field left out and a field found empty look identical
to a reader, and only one of them is honest.

## How to run it

Paste or point at the transcript and ask:

> Here's the transcript from my call with Acme. What were the objections and what did
> we commit to?

There is no CLI verb for this. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates` — call intelligence is reading, not fetching.

## What it needs first

Nothing. A transcript is the only input. If you want to know who was on the call before
it happens rather than after, that is
[`/pre-meeting-briefing`](pre-meeting-briefing.md).
