# /crm-sync-expert

A written mapping document that decides, before anyone imports anything, which object
each row belongs to, which key deduplicates it, what wins when two values collide, and
what your CRM will quietly damage on the way in.

## The problem this solves

A botched CRM import is not an error you see. It is a quarter of enrichment landing in
the wrong column, a picklist that grew four new one-off values, and a duplicate
population nobody notices until someone runs a report against it. The second import is
worse: the same file loaded twice either duplicates every record or silently rolls back
every edit your reps made since the first load, depending on a setting nobody chose on
purpose. This skill is the half hour that stops the day of cleanup.

## When to use it

- "Why did my last import create four hundred duplicates?"
- "We are loading enriched data into Salesforce. What breaks?"
- "Should the dedupe key be email or something else?"
- "If we re-run this next month, what happens to the records a rep already edited?"
- "Someone said we need two-way sync. Do we?"

## When NOT to use it

- **You want the sync executed.** It cannot be. No endpoint in this pack writes to
  HubSpot, Salesforce, Pipedrive or anything else, and every one of them reads. True
  two-way sync is blocked on an endpoint that does not exist, not scheduled. Every write
  is done by you, your CRM's importer, or an integration platform you own.
- **You want the file written.** That is [`/crm-export`](crm-export.md), the pack's only
  writer of a CRM import file. Hand it this skill's mapping document and it overrides the
  built-in defaults. Two skills writing the same artifact is how two files with the same
  name end up disagreeing.
- **You want the file your sending tool reads.** That is [`/launch`](launch.md), gated on
  a PASS verdict from [`/campaign-review`](campaign-review.md).
- **You want to know whether these people may be contacted.** [`/comply`](comply.md) owns
  that. A CRM import does not inherit a verdict, and a CRM is a sending machine with a
  database attached: once a suppressed contact is inside it, its own workflows will
  re-sequence that person and never consult the pack's suppression store again.
- **You want a rate limit, an API version or a plan price for your CRM.** Those rot
  faster than this file is revised, so it will not state one from memory. It sends you to
  the vendor's current documentation.
- **You want a mapping written from what the API "returns".** The pack cannot verify
  response field names yet. The mapping is derived from the column headers in your actual
  file on disk, or it is guesswork with a table drawn around it.

## What it costs

Free. This skill owns no endpoints, so it makes no paid calls and there is no plan to
approve. That is not an omission. Designing a mapping is reasoning over a file that
already exists, and paying an endpoint to re-read a CSV header is the waste the pack is
built to stop.

If the mapping turns out to need a column your file does not carry, that is an enrichment
question and it belongs to [`/enrich-waterfall`](enrich-waterfall.md), which prices it
before it runs.

## What you get

A mapping document, written where you can commit it next to the rest of your operating
docs. Every row has five columns: **target field, source column, transform, collision
rule, and what an explicit null becomes.**

Four decisions are recorded in it, and each one is a failure you have already had or are
about to have.

- **The object.** People and accounts are different files with different keys. One
  imported as the other takes a day to unpick.
- **The dedupe key.** Email is the default in most CRMs and a poor stable identifier,
  because changing jobs is the first thing that changes it, and job changers are exactly
  the population this pack keeps finding. An id you assign is better. A LinkedIn URL is
  next. If it is email, it gets lower-cased and trimmed first, because `Jane@Acme.com`
  and `jane@acme.com` are two contacts in every CRM that matters.
- **The collision rule.** `create_only`, `update_blank_only`, `overwrite` or `append`,
  and which one your second import will use. `update_blank_only` is the recommended
  default: it fills gaps and never overwrites a value a human typed. Overwriting a rep's
  own job title with a stale enriched one destroys the better value and leaves no trace.
- **What gets silently damaged.** Picklist values outside the defined set, dropped or
  coerced or added depending on the CRM. Long text fields truncated with no warning. A
  `+` eaten off a phone number by a spreadsheet, leading zeros gone from postcodes. A
  byte-order mark that makes the first column unmappable with an error message that never
  says so. And the pack's own explicit nulls, `not_found`, `not_verifiable` and
  `not_applicable`, which must never reach a CRM text field, because that is how
  `not_found` becomes four hundred people's job title inside a merge tag in an email.

What you do not get is a synchronised CRM. The words this skill is allowed to use are
mapped, prepared, planned and handed off. If you ever read "synced" in its output, that
is a bug, not a status.

## How to run it

Ask Claude in plain English:

> "We are importing this into HubSpot next week. Design the mapping and tell me what will
> break."

> "What should the dedupe key be for this list, and what happens on the second run?"

There is no CLI verb for it, and there is not going to be one, because there is nothing
to execute. The verbs are `enrich`, `call`, `search`, `preflight`, `catalog` and `gates`.
Two free commands are worth running while you work.

```console
$ richapi preflight
$ head -1 gtm/lists/your-list.csv | tr ',' '\n' | cat -n
```

The second one lists the real column names in your file. That list, not a remembered API
response, is the left-hand side of the mapping.

## What it needs first

A file to map. That normally means [`/list-hygiene`](list-hygiene.md) has run, and
[`/enrich-waterfall`](enrich-waterfall.md) if the columns you want to map do not exist
yet.

`./setup` has been run once, so there is a readable do-not-contact store. Not for the
conversation, which needs nothing, but for the handoff: no file leaves the pack without
that check, and [`/crm-export`](crm-export.md) refuses to write one.
