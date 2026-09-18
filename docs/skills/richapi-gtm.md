# /richapi-gtm

The front door. You describe the job in your own words and it names the one skill that
does it, then closes the session with the real spend receipt.

## The problem this solves

There are 33 skills. You have a CSV, a quota, and no interest in reading 33 files to
work out which one you want. The expensive version of this problem is not picking the
wrong skill, it is picking the right skill at the wrong point in the order: enriching a
list before cleaning it pays full price for rows that were never going to work, and
sizing a market off an ICP nobody tested sizes the wrong market precisely. This skill
picks for you, in stage order, and tells you when the answer is "nothing here does that".

## When to use it

- "What can this thing actually do?"
- "I have a list of leads and I do not know what to do with them next."
- "Help me with outbound." (Say that and you get routed, not lectured.)
- "I want to do X. Is there a skill for it, or am I on my own?"
- "We are done. What did today cost me?"

## When NOT to use it

- **You already know the skill you want.** Go straight to it. The router adds a step and
  no information.
- **You want it to do the work.** It hands off. It will not run another skill's steps or
  repeat that skill's gates from memory, because the gates only hold when the skill that
  owns them runs.
- **You want a skill that does not exist.** It names the closest thing and stops. It will
  not describe a workflow the pack cannot perform.
- **You want to send.** Sending, LinkedIn actions, dialing and direct mail are outside
  the pack permanently. [`/launch`](../../skills/launch/SKILL.md) writes the file your
  sender ingests, and that is the last artifact the pack controls.
- **You want something written into your CRM.** No endpoint here does that.
  [`/crm-sync-expert`](crm-sync-expert.md) designs the sync,
  [`/crm-export`](crm-export.md) writes the import file, you or the CRM importer does the
  rest.
- **You want your credit balance.** The balance comes only from a background probe of
  `GET /usage`, so `BALANCE: unknown` is the honest answer and nothing here estimates
  around it.

## What it costs

Free. Zero API calls, metered or free, and it works with no API key set. Routing costs
nothing. Every credit in this pack is spent by the skill you land on, after that skill
has shown you a priced plan you approved.

## What you get

Not a file. Two things:

**A route.** The name of the skill, why that one, and what it will cost you before you
open it. When two skills fit, it prefers the earlier stage.

**A receipt at the end of the session,** read out of the ledger the runtime wrote, not
composed from memory. Two rules it holds to there: a range stays a range, because most
endpoints never report what they charged and flattening "at least X, up to Y" into one
number is the exact dishonesty the ledger exists to prevent. And it says what was not
found before it says what was, because coverage is what decides whether the run was
worth repeating.

## How to run it

Say any of this to Claude:

> What can you do with RichAPI?

> I have a list of 400 leads with no email addresses.

> How much has this session cost?

There is no `richapi richapi-gtm` command. The runtime ships `enrich`, `call`, `search`,
`preflight`, `catalog` and `gates`, and routing is not one of them. Three commands the
router will reach for, all free:

```console
$ richapi preflight                      # is the install healthy
$ richapi gates                          # every threshold and the key it comes from
$ richapi enrich leads.csv --dry-run     # what would this cost, zero calls made
```

`richapi preflight` is the one to read before anything else. `API_KEY_SET: no` means dry
runs and the 11 zero-call skills still work in full. `SUPPRESSION: STOP` means no
do-not-contact store exists and nothing touching a contact list will run until `./setup`
has. `BALANCE: unknown` is expected, not a fault.

## What it needs first

`./setup`, once, which creates `gtm/` and the suppression store, makes zero API calls and
spends zero credits. Nothing else. This is the skill you start from, and on a brand new
motion it will send you to [`/gtm-kickoff`](gtm-kickoff.md) before anything is spent.
