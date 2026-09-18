# /research-agent

One answer per row for a question no other skill covers, with the cost shown per row and
for the whole list before anything runs, and an explicit "not found" where the answer
does not exist.

## The problem this solves

Somebody hands you a list of 400 accounts and a sentence: "find out which of these offer
a free trial." No column answers it and no tool has a button for it. It normally goes one
of two bad ways: you write a prompt, press go, and learn the cost after the credits are
gone, or you get 400 confident answers with no way to tell which were made up. This skill
recognises the shape of the question, routes it to a known endpoint at a known price,
multiplies by your row count, and shows you that number before spending anything.

## When to use it

- "Find out whether each of these companies offers a free trial."
- "I need a custom column and there is no skill for it."
- "Here is the research-column prompt we run in another tool today. Can this pack do it, and for how much?"
- "Who is the parent company? Do that for all 300 rows."
- "Check whether any of them mention us on their site."

## When NOT to use it

- **The answer is not findable by anyone.** Private revenue, ARR, burn, headcount by team,
  salaries, whois and DNS records, the text of a filing, internal reporting lines. The
  skill keeps a register of those shapes, checks it before routing, and answers
  `not_found` for free. Reporting lines have a destination: [`/org-map`](org-map.md) maps
  what is observable and marks what is not.
- **The question is a judgement.** "Is their website any good" comes back
  `not_applicable`. An opinion with a source line is still an opinion.
- **The question matches no template.** It is refused with the reason, not attempted
  with a guess. An improvised route is an unpriced route.
- **Another skill owns the endpoint.** Firmographics and tech stack go to
  [`/account-research`](account-research.md); emails and phones to
  [`/enrich-waterfall`](enrich-waterfall.md); "who works there" to
  [`/build-prospect-list`](../../skills/build-prospect-list/SKILL.md); domain health and
  column cleanup to [`/list-hygiene`](list-hygiene.md); hiring signals to
  [`/signal-watch`](signal-watch.md); ad libraries to
  [`/competitive-intel`](competitive-intel.md); "every company in this industry" to
  [`/tam-map`](../../skills/tam-map/SKILL.md). Those are handoffs, and a handoff spends
  nothing here.
- **You want one account in depth, not one field across many.** That is
  [`/account-research`](account-research.md). Asked every week rather than once, it is
  [`/signal-watch`](signal-watch.md).
- **You want the email written.** Copy is
  [`/personalize`](../../skills/personalize/SKILL.md), and it only asserts what
  [`/evidence-score`](evidence-score.md) graded supported.

## What it costs

Paid on some questions, free on others, and the sorting happens before the money. Three
routes cost nothing and are checked first: a question in the undiscoverable register, a
question answerable from columns the row already carries, and a question that hands off to
another skill. Measured against 175 real custom-research prompts in `research-question-corpus.json`, that
covers most of them: 34 were reformatting over existing columns, 50 belonged to another
skill, 16 were not reachable by anything.

The paid routes name their endpoints. `crunchbase_company_scraper_sync` for funding.
`find_sitemap_urls` then `web_scrape` to find and read one page on a domain.
`website_intelligence` for a site sweep. `google_search_scraper_sync` or `search_bing`
for an open-web question. The four `youtube_*` endpoints for channel and video presence.
`ai_enrich` for an answer that is on the web behind no single URL, and only with
Perplexity web grounding on.

No credit price is written here on purpose. Prices live in `_lib/api-catalog.json` and
are read at plan time by the dry run, which makes zero calls, costs nothing and needs no
API key. Four things to know before you approve it:

- **Rows times fan-out is the number that matters**, not per row. A question that sounds
  like one call is two hops across 500 rows. The plan shows both lines.
- **A pilot slice always runs first**, and the remainder is re-priced from what the pilot
  measured. That is a second approval, and on a long list it is the difference between an
  experiment and a bill. Print the slice size with
  `richapi gates skills.research_agent.pilot_rows`.
- **Two clamps sit above the plan**, both from `_lib/gates.yaml`:
  `skills.research_agent.max_rows_per_run` and
  `skills.research_agent.max_endpoints_per_row`. Width is the one people miss.
- **`google_search_scraper_sync` can never be reconciled.** It bills per result and its
  response never reports the count, so its ledger line stays an estimate. That is marked
  on the plan, not discovered in the receipt.

## What you get

One record per row, in the file you name with `--out`. Four fields on each: `result`,
`confidence` as a number, `reasoning`, and `source` naming the hop or the URL it came
from. Every record is validated against `_lib/dual-contract.schema.json` before it lands.
`result` is a real value or one of three words: `not_found`, `not_verifiable`,
`not_applicable`. Never a blank, never a dash, never a sentence that means no. "Not
publicly disclosed" is `not_found` wearing prose, and it is rejected.

You also get the answered fraction, which on a freeform question is the actual result:
rows that produced a value, companies that genuinely have no such page, rows the route
missed, and rows that were another skill's job. Those last three look identical in a
spreadsheet and lead to opposite decisions.

## How to run it

Ask Claude in plain English, with the list:

> "For each company in this CSV, find out whether they publish a pricing page and what
> the tiers are."

There is no `richapi research` verb. Underneath, the skill prices each template with the
shared verbs, and both of these make zero calls:

```console
$ richapi call find_sitemap_urls --in accounts.csv --param keywords=pricing --dry-run
$ richapi call google_search_scraper_sync --in accounts.csv --param limit=5 --dry-run
```

## What it needs first

`./setup` once, so there is a readable do-not-contact store. Company-level questions run
without it; a question about a named person does not, because its output is a row keyed
to that person. Check with `richapi preflight`.

Bring the column the template needs: a domain for a site lookup, a company name for an
open-web search, a Crunchbase organisation URL for funding, a page URL for a page read. A
missing column answers `not_found` rather than guessing, because a guessed Crunchbase slug
researches whichever company owns that slug. [`/list-hygiene`](list-hygiene.md) first is
cheap insurance on a list you did not build.
