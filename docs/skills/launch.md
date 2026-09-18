# /launch

Writes the file you upload to Smartlead or Instantly, and refuses to write it, by name,
when the list is not cleared.

## The problem this solves

This is the step where a spreadsheet stops being a spreadsheet and becomes email landing
in strangers' inboxes. It is the one action in the whole process you cannot take back.
The usual failure is small and boring: someone exports a slightly older copy of the
list, or a copy from before the compliance check, or a copy where two rows got pasted in
after the sign-off. This skill will not write that file. It re-checks the list against
the sign-off in front of it, re-runs the do-not-contact filter at the moment of writing,
and stamps the file so a hand-edited copy is detectable later.

## When to use it

- "Export this for Smartlead."
- "The list is signed off. Give me the file."
- "Why won't this export?"
- "Get this into Instantly, but I want to know what got dropped."
- "Is the file on my desktop the one that was actually reviewed?"

## When NOT to use it

- **You want it to send.** It does not. Sending execution, inbox hosting, warmup,
  LinkedIn actions, dialing and direct mail are outside this pack permanently, not
  pending. The pack's job ends at the file on disk. Uploading and scheduling happen in
  your sender, on your account, against your domain reputation.
- **You want it to review the list.** It reads a verdict, it does not form one. If you
  want a different answer the route is [`/campaign-review`](campaign-review.md), not
  this skill.
- **You want to override a refusal.** There is no flag, because an override flag is the
  whole gate. Every refusal below names its own fix instead.
- **You want the CRM import file.** That is [`/crm-export`](crm-export.md), which needs
  no verdict by design: filing a record is not sending a message.
- **You want it to keep the file tidy.** It will not strip the binding header line, and
  it will not write a sender file anywhere other than the path it just told you about.

The refusals, each reported with its code and its fix:

| It refuses when | What to do |
|---|---|
| There is no verdict for this list | Run [`/campaign-review`](campaign-review.md) |
| The verdict says FAIL | Fix what the verdict names as blocking, then review again |
| The list changed after the review | Review again. A row edited, added or removed voids a PASS |
| The verdict has gone stale | Review again. It costs nothing |
| The compliance clearance does not cover this list | Run [`/comply`](comply.md) over this exact list, then review again |
| The list is over `skills.launch.max_export_rows` | Split it. Run `richapi gates skills.launch.max_export_rows` for the value |

The last compliance case is worth understanding, because people try to route around it.
A row `/comply` stopped cannot reach this file by any path. The review will not PASS
while the row is on the list, and taking the row off changes the list, which voids both
verdicts and forces a fresh run over the list as it now stands.

## What it costs

Free. Zero API calls. Everything it needs is already on disk: a list, a verdict, and
your do-not-contact store. `API_KEY_SET: no` is not a blocker.

## What you get

One file, at the path you named, normally under `gtm/exports/`. Smartlead and Instantly
are the featured formats; Apollo, Outreach, Lemlist and plain CSV also work.

Two things about that file you should know before you upload it.

**It may hold fewer rows than the list that was reviewed.** The export re-runs the
do-not-contact filter at write time, because somebody may have unsubscribed between the
sign-off and now. That is the gate working, and the count is reported to you, so you
learn your audience shrank here rather than in the sender.

**The first line is a comment** binding the platform, the list hash, the verdict and the
write time. Every supported sender skips a leading comment line, so it costs you
nothing. Leave it. It is the only thing that makes a hand-edited export detectable
afterwards, and if the list is edited later you can still check the file against it: the
hash will no longer match, and that mismatch is the finding.

## How to run it

Ask Claude in plain English:

> "Export this for Smartlead."

> "Write the send file for the list we just signed off."

> "Launch refused. What is blocking it?"

There is no `richapi launch` verb. The skill runs a script that ships inside its own
`SKILL.md`; Claude runs it, you do not type it. What you might type is free:

```console
$ richapi preflight
$ richapi gates skills.launch.max_export_rows
```

Before it writes anything it tells you which list, how many rows, which sender platform,
where the file goes, and which verdict authorises it. If any of those five is not what
you expected, stop there.

## What it needs first

A PASS verdict from [`/campaign-review`](campaign-review.md), bound to this exact list
and not yet expired. That review in turn needs a live clearance from
[`/comply`](comply.md). This is the last step in the chain, so the whole chain has to be
current: hygiene, enrichment, comply, review, then this.

`./setup` must have run once so the do-not-contact store is readable. The export runs a
final suppression pass at write time, and a check that cannot run is not a passing
check, so `SUPPRESSION: STOP` in `richapi preflight` blocks the write.
