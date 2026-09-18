# /campaign-review

The sign-off before a list leaves the pack: a PASS or a FAIL, with every failure named
alongside the thing that fixes it.

## The problem this solves

The list looks finished. It has been cleaned, enriched and cleared, and now somebody has
to say "yes, send this", usually you, usually on a Friday. What you actually want to
know is whether the coverage is high enough to be worth sending, whether anyone verified
the addresses, whether a person who unsubscribed in March has crept back in, and whether
the compliance step really ran or was skipped in a hurry. This checks all of that in one
pass and puts the answer in a file, so the sign-off is a record instead of a memory.

## When to use it

- "Is this ready to send or not?"
- "Sign off on this before I hand it to the sender."
- "Why did the export refuse?"
- "How much of this list actually has an email address?"
- "I changed a few rows after the last check. Does that still count?"

## When NOT to use it

- **You want it to judge the campaign.** It checks the floors the pack can measure.
  Whether the copy is any good, whether the offer makes sense and whether these are the
  right people are human calls, and a PASS says nothing about any of them.
- **You want it to decide a lawful basis.** [`/comply`](comply.md) owns that rule table
  and there is exactly one implementation of it on purpose. This skill reads that
  verdict; it will not second-guess it, and there is no flag here that clears a row
  `/comply` stopped.
- **You want it to write the send file.** [`/launch`](launch.md) is the only skill that
  writes a sender export, and it does it against a verdict this one produced.
- **You want it to pass a gate it could not run.** An unreadable do-not-contact store,
  a list where nothing carries a verification result, a missing compliance verdict, a
  threshold key that does not resolve: every one of those is a FAIL, not a shrug. A
  check that could not run is not a passing check.
- **You want it to fix what it found.** It reports and stops. Gaps in coverage and
  verification go back to [`/enrich-waterfall`](enrich-waterfall.md); duplicates go to
  [`/list-hygiene`](list-hygiene.md); compliance stops go to [`/comply`](comply.md).
- **You want it to review a list you described to it.** It binds to the content hash of
  the rows it actually read. It cannot vouch for a file it never opened.
- **You want it to buy the missing data mid-review.** It spends nothing. If a gate needs
  data the list does not carry, the answer is to go enrich and come back.

## What it costs

Free. Zero API calls, no exceptions. It reads a list, reads a compliance verdict, and
writes a file. `API_KEY_SET: no` is not a blocker, and `BALANCE: unknown` is irrelevant
here.

## What you get

A **verdict**, a JSON file at `gtm/reviews/<list>.verdict.json`, saying PASS or FAIL.

A FAIL is never just "failed". It is a list of named gates, each with the threshold key
it came from and the fix. The gates it runs:

- **Suppression.** Every row, always, against your do-not-contact store. Anyone on both
  lists is a stop.
- **Compliance.** It looks for `/comply`'s verdict for this list and checks three
  things: it says PASS, it covers this exact list, and it has not expired. Missing reads
  as a stop, never as "no compliance finding".
- **Coverage.** How many rows have an email address, against the floor in
  `_lib/gates.yaml`.
- **Verification.** The failure rate among rows that carry a verification result. A list
  nobody verified has an unmeasured rate, and unmeasured is a stop, not a zero.

Duplicates and an over-size list are reported as notes rather than stops, because other
skills own those.

Two fields make the verdict mean something. The **content hash** covers every row, so
one edited contact voids it. The **issue time** expires it against
`skills.campaign_review.verdict_max_age_hours` in `_lib/gates.yaml` even when the hash
still matches, because people unsubscribe and mailboxes stop resolving underneath a list
that has not itself changed. Run `richapi gates
skills.campaign_review.verdict_max_age_hours` for the current value.

It will also tell you whether it read every row or a sample. Above
`skills.campaign_review.full_read_max_rows` the row tallies run over a sample; the hash,
the duplicate scan and the suppression check always cover the whole list. "Reviewed a
sample" and "reviewed every row" are different claims and you are entitled to know which
one you got.

## How to run it

Ask Claude in plain English:

> "Review this list before we send it. What is blocking it?"

> "Sign this off for launch."

> "Launch refused this. Tell me why."

There is no `richapi campaign-review` verb. The skill runs a script that ships inside its
own `SKILL.md`; Claude runs it, you do not type it. What you might type is free:

```console
$ richapi preflight
$ richapi gates skills.campaign_review.verdict_max_age_hours
```

If you change anything after a PASS, the answer is always the same: make the change,
then run this again. A verdict costs nothing, which is exactly why the binding is strict.

## What it needs first

[`/comply`](comply.md) must have run over this exact list, and recently. Without a live
clearance this skill FAILs the list, and it will not form the compliance opinion itself.

Before that, in the usual order: [`/list-hygiene`](list-hygiene.md) to drop the rows
nobody should pay for, then [`/enrich-waterfall`](enrich-waterfall.md) to fill and verify
the addresses, then `/comply`, then this. `./setup` must have run once so the
do-not-contact store is readable: `SUPPRESSION: OK` in `richapi preflight` is the line
that matters.
