# /signal-watch

A dated list of what changed at the accounts you care about, plus a weekly price for
the watching that you agree to before the first cycle runs.

## The problem this solves

You have 200 target accounts and no idea which three are in market this week. Somebody
checks LinkedIn by hand on a Friday, or nobody checks, and you find out Acme hired six
SDRs when a competitor's rep already has the meeting. Monitoring tools fix this by
billing you every month forever, and you stop reading the alerts by week three. This
skill watches the list, writes down only what moved, and tells you what the watching
costs per cycle, per week and per month before it starts costing it.

## When to use it

- "Tell me when one of these accounts starts hiring for the role we sell into."
- "What changed at my top 50 accounts this week?"
- "Which of our customers is about to churn?" (customer mode: the champion who bought
  you just left, or a competing tool appeared in their stack)
- "Did they raise money, and did anyone write it up?"
- "I want a Monday digest instead of a rep tab-hopping through LinkedIn."

## When NOT to use it

- **You want it to run on a clock.** This skill never starts a clock. Handing a cycle to
  a runner is [`/scheduled-workflow`](../../skills/scheduled-workflow/SKILL.md), and
  until you do that, the watch is not running.
- **You want the full story on one account.** A trigger is a diff, not a brief. Use
  [`/account-research`](account-research.md).
- **You want emails and phone numbers for the people it finds.** The people watch
  returns names and profile URLs and stops there.
  [`/enrich-waterfall`](enrich-waterfall.md) does contact data, and
  nothing in this pack sends anything.
- **You want it to decide what to do about a trigger.** `triggers.jsonl` is a feed. The
  play is [`/play-design`](../../skills/play-design/SKILL.md), the copy is
  [`/personalize`](personalize.md).
- **You want a one-shot look at a competitor.** Same ad and stack endpoints, no standing
  charge: [`/competitive-intel`](competitive-intel.md).
- **You want everything switched on daily.** No flag turns all seven watches on, and it
  will not poll below the cadence floor. Faster is either a cache read that detects
  nothing or a repeat purchase of a fact that has not moved.

## What it costs

Paid, and it is the only recurring charge in the pack. Seven watches, each priced,
cadenced and toggled on its own:

| Watch | Endpoint | Price shape |
|---|---|---|
| News (on by default) | `search_bing` | flat per call, page-gated, exact at page one |
| Stack (on by default) | `web_tech_stack` | flat per call, exact |
| Hiring | `linkedin_job_search`, then `linkedin_job_detail` | per result, page-gated |
| Ads | `linkedin_ad_search` | per result, page-gated |
| Voice | `linkedin_company_posts` | per result, page-gated |
| Money | `crunchbase_company_scraper_sync`, `google_search_scraper_sync` | flat, plus one row nobody can reconcile |
| People | `lead_search` | base plus per result, page-gated |

The two defaults are the two that can be priced exactly. The other five bill per result
on a count nobody can predict in advance, so they are quoted as a range with the
assumption named, never as one tidy figure.

Every number comes from the dry run, which makes zero calls, costs nothing, needs no API
key, and always runs first. It produces the subscription line: cost per cycle, per week
and per month, by watch. Ask for that before you agree to anything. No credit price is
written on this page on purpose; prices live in `_lib/api-catalog.json` and move.

One size ceiling and one cadence floor, both read from `_lib/gates.yaml` under
`watchlist`: a watchlist over **250 entities** asks before it proceeds and **1000** is a
hard stop, and no watch polls faster than **every 24 hours**. Those are the values in the
file today. Print them yourself with `richapi gates watchlist`.

One approval covers the subscription, not the calls inside it. A page confirm or a
budget confirm still fires mid-cycle, and each one still needs a person.

## What you get

- `gtm/signals/watchlists/<id>.json`: the accounts and the identifier each watch needs.
- `gtm/signals/snapshots/<id>.json`: the state the next cycle diffs against.
- `gtm/signals/triggers.jsonl`: one line per change, each naming the endpoint it came
  from, the cycle, and both sides of the change.
- A digest per cycle: movers first, quiet accounts listed by name, then a footer with
  this cycle's cost, **what the watch has cost since it started**, the next cycle date
  per watch, and any reprice since you approved the line.

The first cycle emits no triggers. It captures the baseline, says so, and real triggers
start on cycle two. A watch that has no identifier for an account is written
`not_applicable` permanently, so a quiet account and an unwatchable one never look alike.

## How to run it

Say it in plain English: *"Watch these 40 accounts for hiring and funding, weekly"*, or
*"what changed this week"*, or *"watch my customers for churn signals"*.

There is no `richapi signal-watch` command, by design. Underneath, the skill prices each
watch with the shared verbs:

```console
$ richapi call web_tech_stack --param url=https://acme.com --dry-run
$ richapi search linkedin_job_search --param company=Acme --pages 1 --dry-run
$ richapi gates watchlist
```

## What it needs first

`./setup` once. Then a list of accounts: your own CSV, or one built by
[`/build-prospect-list`](build-prospect-list.md) or
[`/tam-map`](tam-map.md), or a customer export from your CRM if you
are running customer mode. Bring the identifiers with the list where you have them: a
LinkedIn company URL, a domain, a Crunchbase URL. A watch with no identifier is a watch
that quietly watches nothing.
