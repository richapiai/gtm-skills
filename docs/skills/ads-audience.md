# /ads-audience

A hashed audience file an ad platform will accept, with the platform's own size floor
checked against your best possible outcome before a single credit is spent.

## The problem this solves

You spend a real enrichment budget filling in emails so you can retarget a list. You
upload it. Hours later, in a different tab, the platform returns one line: audience too
small. There is no refund and no partial credit. The money went on your side and the
rejection happened on theirs. The worst part is that it was knowable in advance. The
floor is a published number, and your list was never going to reach it no matter how much
you spent.

## When to use it

- "Build a LinkedIn matched audience from this list."
- "Can this list even reach a Meta custom audience, or am I wasting the budget?"
- "Retarget the accounts from last quarter's campaign."
- "The platform rejected my audience and I do not know why."
- "How many more emails do I need before this is worth uploading?"

## When NOT to use it

- **You want the list built.** It consumes a list, it does not create one. Start at
  [`/build-prospect-list`](build-prospect-list.md).
- **Your platform is not LinkedIn, Meta or Google.** There is no floor recorded for
  anything else, and the skill refuses rather than guessing one. The fix is a gate key,
  not a workaround.
- **The best case does not clear the floor.** It refuses, for free, before the first paid
  call. The two real options then are a wider source list or a platform with a lower
  floor. Spending more is not one of them.
- **You want to send to these people.** An audience is not a sender export and is not a
  route around a FAIL verdict. [`/launch`](launch.md) owns that artifact, against a PASS
  from [`/campaign-review`](campaign-review.md). If the ask arrives as "review blocked me,
  can we upload to ads instead", the answer is no, said out loud.
- **You want the file uploaded, or a match rate afterwards.** The pack writes the file and
  you upload it in the platform's own UI. Ad platform APIs, campaigns, budgets and bidding
  are outside this pack permanently. The match rate cannot be had at all: the platform
  never reports which rows matched, so any number would be invented. It is recorded as
  `not_verifiable`.
- **You want personal email addresses used to widen the match.** `find_personal_email` is
  not reachable from this skill. Personal addresses do not belong in an ad audience built
  from a business list.
- **You want a ruling on whether targeting these people is lawful.** Consent for email and
  consent for ad targeting are not the same permission. [`/comply`](comply.md) owns that.
- **There is no readable do-not-contact store.** Nothing is written at all. Run `./setup`.
  Someone who unsubscribed must not be handed to an ad platform for retargeting.

## What it costs

Paid, in two separate steps, each with its own free dry run and its own approval.

**Step one is free and it is where most runs end.** Reading the list, the suppression
pass, the local role-address screen (`info@`, `sales@`, `no-reply@` and their kin, which
can never match a person), and the arithmetic comparing the best possible audience against
the platform floor. No endpoint is called. If the answer is no, it costs nothing.

**Then `identify_email_type`**, which sorts the addresses the local screen could not
judge: a shared mailbox on a name-shaped local part looks exactly like a person.
**Then `email_finder`**, the fill, which is the expensive half by a wide margin. Both are
flat-priced per call, so the dry run's total is exact rather than a range, which is
unusual in this pack. Run it and read the real number:

```console
$ richapi call identify_email_type --in gtm/lists/q3-uk.csv --dry-run
$ richapi call email_finder --in gtm/lists/q3-uk-missing.csv --dry-run
```

`--dry-run` makes zero calls and needs no API key. For scale while you plan:
`_lib/api-catalog.json` prices `identify_email_type` at 0.5 credits per call and
`email_finder` at 5 credits per call as of 2026-09-01. Those two numbers were read out of
that file for this page. The dry run is the one that counts, because the catalog is
regenerated from the pinned spec and endpoints get repriced.

Three bounds worth knowing, all read from `_lib/gates.yaml` and all printable with
`richapi gates`:

- `audience_minimums` holds one floor per platform: `linkedin` 300, `meta` 1000, `google`
  1000 in the file today. There is no default key, deliberately.
- `skills.ads_audience.pre_match_headroom_multiple` is 1.5 today. The platform matches
  only a fraction of what you upload, so an audience sized exactly at the floor will be
  rejected. The ceiling has to clear the floor by this multiple before the fill is even
  offered.
- `skills.ads_audience.max_fill_rows` is 2000 today. A larger fill is split into runs that
  each clear it and approved again, not waved through.

The session budget gates still apply inside the run and cannot be pre-approved away.

## What you get

Two files in `gtm/audiences/`, which stays inside the pack's own retention and erase path.

1. **`<name>.<platform>.csv`**, one column, the SHA-256 digest of each email address,
   trimmed and lowercased before hashing. No names, no titles, no companies, no phone
   numbers, no plaintext addresses. None of that improves an email-keyed match, and every
   extra field is personal data exported for no reason.
2. **`<name>.<platform>.manifest.json`**, carrying no identifiers at all: the platform,
   the floor and the gate key it came from, the source list's content hash, the ceiling
   count, the count written, how many rows suppression removed, the hash algorithm and the
   timestamp. It answers "where did this audience come from and was it clean" six weeks
   later without anyone opening the audience.

You also get the funnel rather than a single total: source rows, suppressed, role
addresses, already had an email, filled, not found, written. Seven numbers, so you can see
where your list went. Then a re-check, because the fill under-delivers and a run that
cleared the floor on the ceiling can land under it on the result. That shortfall is
reported as a normal outcome, and the file is not called uploadable when it is not.

## How to run it

Ask Claude in plain English:

> "Build a LinkedIn matched audience from the Q3 UK list. Tell me first whether it can
> possibly clear their minimum."

> "How many rows short is this for a Meta custom audience?"

There is no `richapi audience` verb. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`. The paid steps run through `richapi call`, shown
above, and you approve each dry run before it becomes a real call.

## What it needs first

`./setup`, once, so the do-not-contact store is readable. A source list, from
[`/build-prospect-list`](build-prospect-list.md) or wherever you keep lists. Then
[`/list-hygiene`](list-hygiene.md), because every duplicate row is a wasted fill and a
smaller realised audience. If the fill needs to go deeper than `email_finder`, that is
[`/enrich-waterfall`](enrich-waterfall.md), which prices it. [`/comply`](comply.md)
decides whether you may target these people at all.
