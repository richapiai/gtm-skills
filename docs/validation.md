# What has been run against the live API

Every claim below was produced by running this pack against the real RichAPI API on
**2026-09-17** and **2026-09-18** with a real key, and paying for it. Roughly 570 credits
were spent on the first day and 13 on the second. The
per-run artefacts hold real people's data and are deliberately not in this repository;
what is here is the evidence that outlives them: the recordings under
`tests/fixtures/live/`, the response maps derived from them, and the tests that replay
them on every build.

Read [`LIMITATIONS.md`](../LIMITATIONS.md) beside this. This page says what was
exercised; that one says what is still not proven.

## The surface

| | |
|---|---|
| Endpoints recorded from a live 2xx | **63 of 68** |
| Recorded but unmappable, delivered raw | the bulk pair, the array-bodied scrapers |
| Never recorded | `geo_id_search` (a miss), `google_maps_reviews_scraper_sync` (empty), `linkedin_ad_search` and `google_ad_transparency_scraper_sync` (403, not enabled for the account used), `slack_channel_members` (needs the caller's own workspace credentials) |
| Endpoints whose response reports its own charge | **0 of 68**, so every ledger line is an estimate and says so. A `credits_charged` field is on the API's roadmap; the ledger already reads it, and every line it appears on will be recorded as a verified actual rather than an estimate, with no change here |

## The recipes

Each recipe was run end to end by an agent reading only the skill files, with a credit
cap, on public inputs. Three failed on the first pass, were fixed, and were rerun.

| Recipe | Result | What it proved |
|---|---|---|
| `post-engagers-to-list` | runs end to end | post → engagers → dedupe → filter → bulk enrich → 4 of 5 emails → verify → the send is blocked by compliance for named reasons |
| `domains-to-decision-makers` | runs | one filtered search page is the expensive step, and the recipe says so before it runs |
| `account-brief` | runs | the brief reports its own thinness rather than padding it |
| `icp-to-scored-list` | runs | market size, list, score and a CRM file, with the coverage floor enforced |
| `lookalikes-from-won-deals` | runs | filter-match, stated as filter-match, never as a lookalike model |
| `champion-moved` | runs | a first cycle is a baseline and produces no triggers, as the skill says |
| `hiring-or-stack-change-outbound` | runs | same, and the second cycle costs nothing because the cache holds |
| `inbound-form-route` | runs | one row enriched, routed, and a reply drafted but held with no address to send to |
| `local-business-outbound` | runs | a call list clears compliance for the phone channel while e-mail stays blocked |
| `crm-cleanup` | runs | dedupe, normalise, fill, and a CRM file that refuses below the coverage floor |
| `post-call-follow-up` | runs | transcript intel and a follow-up whose every claim cites a transcript line |

## What the live runs found, and what changed

The runs existed to find defects, and they did. Each fix carries a test that fails
against the behaviour that shipped before it.

- **Paid searches returned nothing.** Three endpoints' rows were billed and written as
  an empty file, because the runtime did not recognise their result container.
- **Bulk enrichment would have mixed people up.** The live bulk endpoint answers out of
  request order. Results are matched by identity now; a row the response does not name
  fails rather than taking a neighbour's data.
- **Spend was overstated.** Calls the API said it did not bill were counted at full
  price. One recorded run's ledger read 41.5 credits where the receipt read 13.5.
- **A provider error read as a not-found.** It is reported as itself now, retried on
  resume, and never cached.
- **An unbilled call crashed the receipt**, so the user saw a stack trace instead of the
  server's message.
- **`richapi call` delivered no data for unmapped endpoints.** The body is delivered
  raw and marked unmapped; 21 response maps were added from recordings.
- **Page walks ended early and were mispriced.** Exhaustion is read from the response;
  pages are priced from the size actually delivered.
- **Compliance could not locate a US row outside California, and printed addresses.**
  US rows resolve to the federal baseline, verdicts are per channel, and console output
  is masked.
- **Skill text was wrong in ten places** against the live API: an engager's URL, the
  inputs an email lookup needs, what bulk enrichment returns, a reviews URL shape
  settled by measurement, and more.

## The second day: the MCP surface, and what enrich_company takes

2026-09-18, against `https://mcp.richapi.ai/mcp` and the API, for 13 credits.

**The MCP path had never been tested.** Everything above ran through this pack's CLI,
and customers can arrive through RichAPI's hosted MCP server instead. Measured: the MCP
server exposes all 68 endpoints, its field names are `snake_case` exactly as the skills
write them, and the same endpoint returns the same body through either path. The skills'
knowledge carries over. Their guard rails do not, and that is by design — see
[`docs/INSTALL.md`](INSTALL.md#about-mcp) for the table and the two rows measured that
day: MCP accepts an empty `phone_finder` call (25 credits, nothing required) and takes
each endpoint's own field names rather than the ones on your list.

**`enrich_company` takes a LinkedIn company, not a domain.**

| input | result |
|---|---|
| `https://www.linkedin.com/company/richapi` | 200, 15 columns, 1 credit |
| `richapi` (the `universalName`) | 200, the same company |
| `richapi.ai`, `acme.com`, `github.com` | 404 |
| `https://stripe.com` | 503 |

The skills already said so. The runtime did not: it mapped `company_website`, `website`,
`company_domain` and `domain` onto the request, so a domain-keyed list — an ordinary CRM
export — planned every row as runnable and then missed every one. It cost nothing, since
a non-2xx is unbilled, which is exactly why it survived a full day of validation: a free
run that returns nothing looks like a company with no data. Those rows are refused on the
plan now, naming the resolution step.

The `setup` sweep was built on the same wrong premise and inherited it: it offered to
enrich the DOMAIN it inferred from `package.json`, the git remote or your git e-mail, so
every sweep the pack ever offered would have 404'd. It asks for the LinkedIn company now
and declines when all it has is a domain. Verified end to end against the live API.

Not done, deliberately: stripping the TLD and sending the label as a slug. `acme` answers
200 with **"Acme Home Loans"**, which has nothing to do with acme.com — a paid, confident,
wrong company written into the operator's `gtm/`. The 404 is the better answer.

**Compliance, rechecked from a customer's project rather than the pack checkout.** A US
row resolves from a country NAME ("United States", "US", "United States of America") to
the federal baseline; addresses are masked on stdout; an unbilled call prints a receipt
instead of a stack trace. Two defects surfaced: a stop on a phone list printed
"(no address)" against every row, and an objection on a row with no e-mail address was
reported in the verdict while nothing was written to the suppression store. Both fixed,
both with a test.

## How to reproduce

```bash
npm ci && npm run check          # the whole suite, offline, no key
node bin/richapi-capture-fixtures.mjs        # prices a capture run, calls nothing
node bin/richapi-capture-fixtures.mjs --run  # re-records, with a key, for a few credits
```

Every recording is redacted at capture time: contact details, what a person wrote,
pictures of them, and the names of the upstream providers behind a waterfall.
