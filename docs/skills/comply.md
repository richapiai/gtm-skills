# /comply

Decides, per contact, whether you are allowed to email this person, and writes that
decision to a file the rest of the pack has to obey.

## The problem this solves

You have a list with people in Berlin, Toronto and San Diego on it, and three different
sets of rules apply to those three rows. Nobody can tell you where the consent record
for row 7 is, or whether "we bought it from a vendor" counts. The usual outcome is that
somebody sends anyway, and you find out when the domain gets blacklisted or a lawyer
writes to your CEO. This skill makes the call before the send, and it refuses rather
than guessing.

## When to use it

- "Is this list actually safe to send?"
- "We have EU contacts on here. Can we mail them?"
- "Someone replied asking us to delete their data. Do that."
- "Where did these contacts come from? Can we prove it?"
- "Legal asked what our basis for contacting these people is."

## When NOT to use it

- **You want legal advice.** This enforces a rule table the pack ships, covering
  exactly the regimes listed under `skills.comply.jurisdictions` in `_lib/gates.yaml`.
  A regulator reads the statute, not this file. Coverage here is not an opinion that
  you are compliant, and a gap here is not an opinion that you are not.
- **You want a row cleared that it stopped.** There is no override flag and no second
  opinion. [`/campaign-review`](campaign-review.md) will not overrule it and
  [`/launch`](launch.md) will not export around it. The route past a refusal is fixing
  the record, or dropping the row.
- **You want it to guess a country.** A row with no country, region, phone country code
  or recognisable domain gets refused, not assumed. It reads a free-text location like
  "Berlin, Germany" into a country code, but "San Francisco Bay Area", "Remote" and
  "Vancouver" resolve to nothing and stay refused.
- **You want the deduping and the dead-domain check.** That is
  [`/list-hygiene`](list-hygiene.md). A clean list is not a cleared list, and the
  reverse is also true.
- **You want the send file.** [`/launch`](launch.md) is the only skill that writes one,
  and it needs a review that carries this skill's clearance. Sending itself is outside
  the pack permanently.
- **You want an erasure to cover your CRM.** It deletes inside `gtm/` only. Your CRM,
  sending platform and warehouse hold their own copies, and the request is not finished
  until someone handles those too.
- **You want to un-suppress someone, or undo an erasure.** Neither has a path. Both are
  one-way on purpose.
- **You want the CRM import file gated.** It is not, by design. See
  [`/crm-export`](crm-export.md): filing a record is not sending a message. An
  objection still blocks it, because that runs through the suppression store.

## What it costs

Free. Zero API calls, with or without an API key. It reads a list you already have and
writes a file. `API_KEY_SET: no` in `richapi preflight` is not a blocker here.

## What you get

A **compliance verdict**, a JSON file at `gtm/reviews/<list>.comply.json`. It says PASS
or FAIL for the whole list, and for every stopped row it gives you the row number, the
contact, which regime stopped it, and the fix. One stopped row fails the list, because
the list is the thing that gets exported.

Two things bind it and both matter to you. It carries the **content hash** of the list,
so editing, adding or removing one contact voids it. And it carries the time it was
issued, so it expires against `skills.campaign_review.verdict_max_age_hours` in
`_lib/gates.yaml` even when nothing changed. Run `richapi gates
skills.campaign_review.verdict_max_age_hours` for the value. Re-running is free, which
is why the binding is that strict.

Refusals come in two kinds and the difference is the whole thing:

- **Paperwork.** A missing `data_source` column, a sequence with no unsubscribe link, a
  legitimate-interest assessment that lives in a filing cabinet. These block this run
  and nothing else. Fix the record, run again, the row clears. Nothing is written about
  the contact anywhere.
- **The contact said no.** An objection goes into the do-not-contact store, which is
  append-only and has no removal path in this pack. That person stops reaching any
  output from that moment: sender export, CRM file, ads audience. This is not undoable
  and the skill will say so out loud when it happens.

An erasure also writes a tombstone to `gtm/tombstones.jsonl`: files scanned, rows
removed, occurrences redacted. The erased address is stored there as a hash, because an
audit trail of a deletion should not be the place the deleted address survives.

## How to run it

Ask Claude in plain English:

> "Is this list safe to send? Check it against GDPR before we do anything."

> "This person emailed asking us to delete their data. Erase them."

> "Which rows on here have no lawful basis and what do I need to add?"

There is no `richapi comply` verb. The skill runs a script that ships inside its own
`SKILL.md`; Claude runs it, you do not type it. The two commands you might type
yourself are both free:

```console
$ richapi preflight                 # SUPPRESSION: OK is the line that matters
$ richapi gates skills.comply.jurisdictions
```

An erasure is the one place you get asked twice. Once to confirm the target, read back
in full, and again if the sweep would remove more than
`skills.comply.erase_confirm_fraction` of everything stored under `gtm/`. That second
question stops `acme.co` typed for `acme.com` from emptying the cache.

## What it needs first

`./setup` has been run once, so there is a readable do-not-contact store. Without it
this skill stops rather than reporting "nothing suppressed".

Run this **before** [`/campaign-review`](campaign-review.md), and run it again after any
edit to the list. It is normally the last free step before the review, after
[`/list-hygiene`](list-hygiene.md) and after
[`/enrich-waterfall`](enrich-waterfall.md) have finished changing rows, since every one
of those changes voids the clearance.
