# /org-map

A buying committee map for one account where a reporting line somebody stated and a
reporting line we guessed do not look the same on the page.

## The problem this solves

You are about to multithread an account and you need to know who signs. So somebody draws
an org chart, it looks authoritative, and most of it is guesswork hung off the CEO,
because every charting tool needs a parent for every box and the CEO is the one name it
always has. Then a rep says "you report to Dana, right?" on a call and finds out they do
not. This skill draws the lines it can prove, marks the inferred ones with a different
glyph, and leaves the rest unplaced.

## When to use it

- "Who actually signs this? I have been talking to the wrong person for a month."
- "Map the committee at Acme before we multithread it."
- "Who does the SDR team report into?"
- "I have a list of names from research. Now show me the shape."

## When NOT to use it

- **You gave it a company name or a domain.** It owns no resolution endpoint and will
  not guess which Acme you meant. Get the LinkedIn company URL from
  [`/account-research`](account-research.md) or
  [`/build-prospect-list`](../../skills/build-prospect-list/SKILL.md) and come back.
- **You want a confident answer where the evidence is thin.** In a six-person company
  where the CEO is the only exec on the roster, the manager of the new SDR comes back
  `not_found`. Reaching a parent by elimination is banned outright, at any confidence
  value. That is the point of the skill and it is not configurable.
- **You want the firmographics and the site read.** That is
  [`/account-research`](account-research.md). This skill maps people.
- **You want emails and phones for the committee, or a ranking of who to contact first.**
  It stops at names and profile URLs. Those are
  [`/enrich-waterfall`](enrich-waterfall.md) and
  [`/evidence-score`](../../skills/evidence-score/SKILL.md). Nothing here sends anything.
- **You want hierarchy read out of a Slack channel.** Membership is participation, never
  a reporting line, and it runs only for a shared Slack Connect channel with the account.
- **You want the whole roster enriched.** The shortlist is the bill, and it is chosen.
- **You want to know whether contacting these people is lawful.** Mapping is a data
  question. That is [`/comply`](../../skills/comply/SKILL.md).

## What it costs

Paid, and unusually for this pack there is no free version of the core step: no endpoint
prices a roster flat, so even the default pass has a ceiling rather than an exact total.

- **The roster, the default pass.** Either `linkedin_company_employees_search`, which
  returns everyone unfiltered in LinkedIn's order, or `lead_search`, which charges a
  per-call base on top of a higher per-result rate and gives you thirty-odd server-side
  filters for it. On a small company the filters are waste; on a large one you pay the
  base once, then pay for the seniority bands that can hold a committee instead of four
  thousand employees. Both lines are priced from the catalog and shown to you.
- **The shortlist, opt-in.** `enrich_profiles_bulk` for tenure, role start date and
  previous companies. It bills per result on a field absent from the response, so its
  ledger line is always `estimated_unverifiable`: you cannot reconcile it afterwards,
  only bound it beforehand, and the bound is the shortlist you hand it.
- **Participation, opt-in and conditional.** `slack_channel_members`, only for a shared
  channel with the account.
- **Grounding, opt-in and rare.** `ai_enrich`, only for web grounding or batch scale.
  Ranking job titles is done locally at no marginal cost, so paying per call to do it is
  a billing error. What the paid hop returns is an inferred edge, never a source line.

Every number comes from the dry run, which makes zero calls, costs nothing, needs no API
key, and always runs first. No credit price is written on this page: prices live in
`_lib/api-catalog.json` and are read at plan time.

Three ceilings bound the spend, all in `_lib/gates.yaml` under `skills.org_map`:
`max_pages_per_run` counts pages across both people endpoints in one map,
`committee_max_profiles` caps the shortlist handed to the bulk enrich, and
`ai_enrich_batch_min_rows` is the row count below which the paid LLM route stays shut. If
one stops resolving, the path it guards closes and the map comes back thinner. Print the
current value rather than trusting a number in a doc:

```console
$ richapi gates skills.org_map.committee_max_profiles
```

## What you get

`gtm/org-maps/<account>.md`. A rendered map where the glyph on the line carries the
provenance, not a footnote:

```
  A. Okonkwo — Chief Executive Officer
  ├── C. Duval — Account Executive          [observed · linkedin_company_employees_search]
  ╌?╌ F. Lindqvist — Product Designer       [inferred · title_neighborhood · confidence 0.55]

  B. Marek — Sales Development Representative
  └·· manager: not_found                    [no same-department senior; CEO by elimination — refused]
```

Strip every bracket off that block and `├──` and `╌?╌` still look different. That is the
test. A person nobody could place is drawn with `not_found` above them, never omitted,
because silence reads as "we did not check" and a rep fills that in out loud on a call.

The headline is edge counts by provenance, not "nine people mapped", which hides the only
number that matters. You also get the one question on your next call that would upgrade an
inferred edge to an observed one.

## How to run it

Ask Claude in plain English:

> "Map the buying committee at Acme. Here is the LinkedIn company URL, and who is the
> economic buyer? Tell me how sure you are."

There is no `richapi org-map` command. Underneath, the skill prices each step with the
shared verbs, and every one of these makes zero calls:

```console
$ richapi search linkedin_company_employees_search --param company_linkedin_url=<url> --pages 1 --dry-run
$ richapi call enrich_profiles_bulk --in shortlist.csv --dry-run
```

## What it needs first

`./setup` once. This skill does not run at all without a readable do-not-contact store,
because its whole output is named people at a named account. `richapi preflight` tells
you: `SUPPRESSION: OK` is the line that matters. Then a LinkedIn company URL, which
normally comes from [`/account-research`](account-research.md). That skill also gives you
the headcount band that picks between the two people endpoints, so running it first makes
this one cheaper.
