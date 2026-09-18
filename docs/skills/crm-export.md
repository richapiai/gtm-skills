# /crm-export

A CRM import file in your CRM's own column names, with the people who opted out stripped
out as it is written, and a note beside it saying what personal data is inside.

## The problem this solves

You have a list the pack cleaned and enriched, and now it has to get into HubSpot.
HubSpot will not take the file as it stands. It wants `firstname`, not `First Name`, and
one file for people, a different one for companies. Last time somebody did this by hand,
a few hundred rows arrived with nothing in the dedupe column, so the importer created
duplicates instead of updating the records already there. Nobody noticed until a
pipeline report came back wrong. One of those rows had unsubscribed in March.

## When to use it

- "Get this list into HubSpot."
- "I need a CSV I can import into Salesforce without editing the headers first."
- "Load the enriched accounts in as companies, not as contacts."
- "Give me the file, but do not include anyone who unsubscribed."
- "RevOps wants to know which columns are in this and where each one came from."

## When NOT to use it

- **You want the file your sending tool reads.** That is [`/launch`](launch.md), and only
  against a PASS verdict from [`/campaign-review`](campaign-review.md). This skill refuses
  any target the pack has already classified as a sending tool, including two that
  everyone calls CRMs, Apollo and Outreach, and routes you to `/launch` by name. "Just
  give me a CSV I can paste into my sequencer" is that route, not this one.
- **You want the mapping designed.** Which object, which dedupe key, what wins on a
  collision, what your CRM silently truncates: that is
  [`/crm-sync-expert`](crm-sync-expert.md). The default maps here are a starting point
  and are labelled as one.
- **You want the records written into your CRM.** Nothing in this pack writes to a CRM.
  There is no endpoint for it. Your importer does the write, under your credentials, and
  the pack cannot see the result.
- **You want the missing emails and titles filled in.** That is
  [`/enrich-waterfall`](enrich-waterfall.md), which prices the work first. Importing the
  gaps makes them permanent.
- **You want the list cleaned, deduplicated or flattened.** That is
  [`/list-hygiene`](list-hygiene.md), and before the export is the only cheap time. A row
  with a nested value is refused here, because the suppression filter cannot read inside
  one, and a row it cannot read is a row it cannot clear.
- **You want a `consent` column.** This skill has not established a lawful basis and will
  not imply one by writing a column it cannot back. [`/comply`](comply.md) owns that
  question.

## What it costs

Free. This skill owns no endpoints and makes no paid calls, with or without an API key.
Everything it needs is already on disk, and deciding that a column called `co_name` is
the company name is reasoning over a file, which the model you are already talking to
does at no charge.

If a column you need is empty, that is an enrichment question with its own price and its
own approved plan. It belongs to [`/enrich-waterfall`](enrich-waterfall.md), not here.

## What you get

Two files, always written together.

1. **The import file**, at the path you name, in your CRM's column names. People and
   companies are separate files with different dedupe keys. Suppressed contacts are
   filtered out as the file is written, not before, so somebody who unsubscribed this
   morning is still caught. Only fetched values go in it: no inferred seniority, no
   guessed industry, no score. Every row carries `source_endpoint` and `fetched_at`, so
   two years from now the record can still say where it came from.
2. **The manifest**, `<your-file>.manifest.json`, beside it. It records the target, the
   object, the upsert key, the columns, rows in, rows written, rows suppressed, the
   source list's content hash, and a plain statement that the file holds personal data.
   The binding lives here rather than in a comment line at the top of the file, because a
   CRM importer reads line one as the header row and a comment would break every import.

The run also prints the number most people skip: what percentage of written rows carry
the upsert key. Rows without it do not update anything, they create duplicates. That
percentage is compared against `quality_stops.coverage_min_pct` in `_lib/gates.yaml`.

Say one thing out loud when you hand the file over. Once imported, those records are
outside the pack: no longer swept on a TTL, no longer reachable by `/comply erase`. A
later erasure request has to be carried out twice, once here and once in your CRM.

## How to run it

Ask Claude in plain English:

> "Export this list as a HubSpot contacts import file."

> "Write the enriched accounts as a Salesforce companies file, and use the mapping we
> agreed."

> "Which of these rows will create duplicates when I import them?"

There is no `richapi export` verb. The CLI verbs are `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`, and none of them writes this file. The skill carries
its own script and Claude runs it from the pack root. Targets are `hubspot`,
`salesforce`, `pipedrive`, `close`, `attio`, or `generic_crm` for a CRM it does not know
by name.

The one command worth running yourself is the free health check:

```console
$ richapi preflight
```

`SUPPRESSION: OK` is the line that matters. `API_KEY_SET: no` does not block anything
here.

## What it needs first

`./setup` has been run once, so there is a readable do-not-contact store. Without it
nothing is written at all.

Before this, in order: [`/list-hygiene`](list-hygiene.md) to flatten and deduplicate,
[`/enrich-waterfall`](enrich-waterfall.md) to fill the dedupe key on the rows that would
otherwise land as duplicates, and [`/crm-sync-expert`](crm-sync-expert.md) if the mapping
matters more than the defaults. If the plan is to import these records and then sequence
them from inside the CRM, that is an outbound campaign and it needs
[`/campaign-review`](campaign-review.md) first.
