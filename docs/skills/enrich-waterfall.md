# /enrich-waterfall

Takes a list of people you already have and fills in the missing work email, phone,
profile and verification, after showing you the bill and waiting for you to approve it.

## The problem this solves

You exported 500 leads out of LinkedIn, or a list came back from a partner, and 300 of
them have a name and a company and nothing you can send to. You have used a vendor
before that quoted a coverage number, ran the whole list, and charged you for every
lookup whether it found an address or not. This skill runs the same lookups in a fixed
order, but it prints the plan first: which rows it can work on, which lookups it will
make, what the ceiling is, and which of those lookups charge you even when they come
back empty.

## When to use it

- "I have a list of names and companies and I need their work emails."
- "Half my CRM rows have no phone number and the SDRs keep asking."
- "Someone sent me a list and I want to know what it will cost to make it usable."
- "My coverage is 40% and I do not know whether that is the vendor or my list."
- "The run died at row 380 and I do not want to pay for the first 379 again."

## When NOT to use it

- **Your list is dirty, duplicated, or full of rows with no email, no domain and no
  LinkedIn URL.** Enriching that pays full price for rows that were never going to
  work. Run [`/list-hygiene`](list-hygiene.md) first. It is the cheapest fix for a bad
  hit rate and most of it costs nothing.
- **You want a promised hit rate before you spend.** Nobody can give you one. The API
  publishes none and the plan will not invent one. You get a ceiling before, and a real
  cost per found record after.
- **You want a refund on a lookup that found nothing.** There is no credit-back path in
  this API. The only way not to pay for a miss is not to make the call, which is what
  a suppressed row, a cached row, and a row with no usable input each do for you.
- **You want a column the API does not return.** It maps documented fields only. If the
  column you want is missing, the answer is which endpoint would supply it, not a guess.
- **You want to know whether you may lawfully contact these people.** That is
  [`/comply`](../../skills/comply/SKILL.md). A full email column is not permission.
- **You want the emails sent.** This pack stops at the send button, permanently. The
  export is [`/launch`](../../skills/launch/SKILL.md).

## What it costs

Paid. The lookups it can make are `enrich_profile`, `email_finder`, `email_verifier`,
and `phone_finder`, which is opt-in behind `--phone` because it is the price outlier in
the API and always asks before it runs.

Every number you need comes from the dry run, which is free, makes zero API calls, works
without an API key, and always runs first. It prints the cost per lookup, the cost per
row, a total ceiling, a floor, and a `Billed on a miss` block that names every lookup you
pay for even when it answers empty. No credit price is written on this page on purpose:
prices are read from `_lib/api-catalog.json` at run time, and one endpoint in this pack's
history repriced by more than eight times in a single quarter.

## What you get

- `enriched.csv` (or whatever you pass to `--out`), suppression-filtered again at the
  moment it is written, in case someone unsubscribed while the run was going.
- A receipt printed at the end with a **cost per found record** block: what you spent,
  how many emails and phones you actually got, and the credits per record obtained.
  That number is what you budget against, not the per-lookup price.
- A coverage report: what was not found, and which missing input caused it.
- A run journal and a per-hop ledger under `gtm/runs/`, which is what makes a killed run
  resumable and what [`/cost-optimizer`](../../skills/cost-optimizer/SKILL.md) and
  [`/measure`](../../skills/measure/SKILL.md) read later.

## How to run it

Ask Claude in plain English:

> "Enrich this list and find work emails for everyone. Show me the cost first."

> "Same list, but include phone numbers this time."

The CLI, if you would rather type it:

```console
$ richapi enrich leads.csv --dry-run                       # free, zero calls, prints the plan
$ richapi enrich leads.csv --out enriched.csv              # after you approve the plan
$ richapi enrich leads.csv --resume <run-id> --out enriched.csv
```

A resume pays only for the rows that did not finish. Restarting pays for all of them
again.

## What it needs first

1. `./setup` has been run once, so there is a readable do-not-contact store. Without one
   this skill refuses to run at all. `richapi preflight` tells you.
2. [`/list-hygiene`](list-hygiene.md) on the list. Every duplicate you remove there is a
   row you do not pay to enrich twice, and every row with no usable identifier is spend
   you avoid entirely.
3. An API key in the environment, but only for the real run. The dry run works without
   one and is where the decision actually gets made.
