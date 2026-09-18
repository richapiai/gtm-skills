# /list-hygiene

Tells you what is actually in a contact list, removes the rows nobody should pay to
enrich, and cross-checks every address against your do-not-contact store before anything
else happens.

## The problem this solves

Someone hands you a spreadsheet that is two exports stapled together, sitting in a folder
since last quarter. A third of it is duplicates. Some of the companies no longer exist.
There are `info@` and `sales@` boxes in the email column, a few rows with a first name and
nothing else, and at least one person who unsubscribed in March. Every one of those rows
costs the same to enrich as a good one, and the last one is the mistake you cannot take
back once the email goes out.

## When to use it

- "Two people sent me lists and I think they overlap. How much?"
- "Before we spend anything on this, is it even a real list?"
- "Prep this for the campaign. I do not want to mail anyone who opted out."
- "Half these companies look dead. Can we check before we pay to enrich them?"
- "My last send bounced hard and I need to know whether the source is the problem."

## When NOT to use it

- **There is no do-not-contact store yet.** This skill stops rather than running a
  check it cannot perform. Run `./setup --root <your project>` from the pack checkout
  first. A list whose suppression step was skipped is worse than an uncleaned one,
  because it now looks audited.
- **You want a ruling on whether contacting these people is lawful.** Hygiene is a data
  question. Lawful basis, GDPR, CCPA and CASL belong to
  [`/comply`](../../skills/comply/SKILL.md). A clean list is not legal cover.
- **You want a domain marked dead because a check timed out.** Slow is not dead. A
  timeout comes back `unknown`, stays in the list, and gets flagged. Scoring slow
  domains as dead quietly deletes good rows.
- **You want same-name duplicates merged automatically.** Two people with the same name
  at the same company is rare and real, and losing one is not recoverable. Those pairs
  get shown to you and you decide.
- **You want personal addresses dropped by default.** Recruiting and creator outreach
  want them. That call is yours.
- **You want the missing emails filled in.** That is
  [`/enrich-waterfall`](enrich-waterfall.md). Hygiene decides which rows deserve to get
  there.
- **You want a file for your sending tool.** That is
  [`/launch`](../../skills/launch/SKILL.md). Nothing here sends anything.

## What it costs

Mostly free, with an opt-in paid half.

**Free, and it is most of the value:** the audit (rows in, blank counts, duplicate
counts, rows with no enrichable identifier at all), the suppression cross-check, the
dedupe, and the domain liveness probe. The probe is a DNS, MX and HTTP lookup, not a
metered call, run once per distinct domain rather than once per row.

**Paid, and only on the rows that need it:** the tidy-up and classification endpoints,
`clean_domain`, `normalize_company`, `normalize_phone`, `normalize_list`,
`remove_whitespace`, `count_occurrences`, `extract_urls_emails`, then
`identify_email_type` to tell a company mailbox from a personal one (that is what it
returns — flags, not a `role` or `disposable` verdict; role boxes are matched locally
off the username it hands back), and
`email_verifier` last on the survivors. Two more, `find_redirect` and `web_meta_tags`,
settle the handful of domains the free probe cannot classify.

There is no `richapi hygiene` verb, so there is no single dry run that prices the whole
pipeline. Every paid call still gets named, counted and totalled from the generated
catalog before the first one runs, and you approve the batch once. No credit price is
written on this page: costs live in `_lib/api-catalog.json` and are read at run time.
Unusually for this pack, all eleven endpoints here report what they charged, so the
hygiene receipt is normally exact rather than a range.

Two bounds worth knowing, both read from `_lib/gates.yaml`: a list above
`skills.list_hygiene.max_rows_per_run` is refused rather than truncated (split it and run
the halves), and the domain probe is bounded by
`skills.list_hygiene.domain_probe_timeout_ms` and `domain_probe_concurrency`. Run
`richapi gates skills.list_hygiene.max_rows_per_run` to see the current value.

## What you get

Three files, always:

1. **The clean list**, filtered against the do-not-contact store at write time as well as
   at plan time.
2. **The dropped list, with a reason per row**: duplicate, dead domain, role box,
   invalid. One exception, and it is absolute. Suppressed rows are counted,
   never listed, not even here. This report gets pasted around, and a do-not-contact
   list that ships the addresses is the exact failure it exists to prevent.
3. **The summary**: rows in, rows out, and every subtraction in between in the order it
   happened, so you can check the arithmetic. "A fifth of your list was dead domains" is
   the finding. "Ready to send" is not.

If the failure rate, the hard bounce rate or the survivor rate crosses the floors in
`_lib/gates.yaml` under `quality_stops`, it stops and tells you the source list is broken
instead of spending the rest of the budget proving it.

## How to run it

Ask Claude in plain English:

> "Clean this list before we enrich it. Tell me what you threw away and why."

> "Dedupe these two exports and check them against the suppression list."

> "Are any of these companies dead?"

There is no CLI verb for hygiene. The runtime today wraps the enrichment waterfall, not
this pipeline, and the skill says so rather than pretending otherwise. The closest command
is the waterfall dry run on the cleaned file, which is free and makes zero calls:

```console
$ richapi enrich clean.csv --dry-run
```

## What it needs first

`./setup` has been run once, so there is a readable do-not-contact store. Nothing else.
This is normally the first thing you run on a list, before
[`/enrich-waterfall`](enrich-waterfall.md), before scoring, before anything that spends.
Check with `richapi preflight`: `SUPPRESSION: OK` is the line that matters.
