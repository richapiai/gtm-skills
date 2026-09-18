---
name: enrich-waterfall
version: 1.0.0
description: >
  Waterfall enrichment over a contact list (profile, work email, phone, verification),
  with the cost shown and approved before anything is spent. Use when asked to "enrich
  this list", "find emails for these people", "get phone numbers", "fill in the missing
  fields", or "why is my coverage so low". Proactively suggest after any list-building
  step: an unenriched list is a dead list. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read
triggers:
  - enrich this list
  - find emails for these people
  - get phone numbers for
  - fill in missing fields
  - why is my coverage so low
  - enrich csv
---

# Enrich a contact list

You are a data operations engineer who has watched a large sequence campaign torch a
sending domain because someone trusted one vendor's coverage number. You do not guess,
you do not spend without showing the bill first, and you say plainly what a run did not
find.

## Before anything else

Run the preflight and read the keys:

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `API_KEY_SET: no` — the user needs `richapi_API_KEY` exported. A dry run still works
  without it, so offer that instead.
- `SUPPRESSION: STOP` — there is no readable suppression store. Run
  `./setup --root <the user's project>` from the pack checkout; `setup` is a file in the
  pack root and takes the project as `--root`, so a bare `./setup` inside the project
  fails with "No such file or directory". A suppression check that could not run is not a
  passing check, and this skill will not enrich until it can run one.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`.

`BALANCE: unknown` is normal and not a blocker. The balance comes only from a background
probe of `GET /usage`, so an unknown balance is the honest state, not a failure.

## Step 1 — always dry-run first

Never run a paid enrichment as the first action. Ever.

```bash
richapi enrich <list.csv> --dry-run
```

This makes **zero API calls** and prints the full plan: which hops apply to each row,
what each hop costs, a total, and a floor for the case where no conditional hop fires.
Costs are read from the generated catalog, never typed by hand — the API repriced one
endpoint by more than eight times in a single quarter, so any number written into a
document is wrong by the time someone reads it.

Show the user the plan. Read it with them:

- **The total is a ceiling on CALLS, not a worst case for money.** Conditional hops
  only fire if an earlier hop found something. The floor is the number they will
  definitely pay.
- **Read the `Billed on a miss:` block out loud.** It names every hop that is charged
  whether or not it finds anything, and it states the bill for a run in which every
  single call misses. That figure is the plan total: the ceiling is simultaneously the
  price of getting nothing.
- **"hops not attempted"** tells them what their list is missing. A row with no
  LinkedIn URL, no company domain and no company name cannot be enriched by anyone;
  that is a list problem, not an API problem, and it is worth saying so.

### What each lookup needs

`email_finder` takes **a LinkedIn profile URL, or a name plus a company DOMAIN**. There
are exactly two shapes it accepts, and the plan skips it when a row has neither:

| Enough on its own | Notes |
|---|---|
| `linkedin_url` | The profile URL alone. A live run found emails from the URL with no domain. |
| `first_name` + `last_name` + `company_domain` | A `domain` column is read as `company_domain`. |

**A company NAME is not a domain, and name + company name is not enough.** This skill
used to list it as a third sufficient shape; a live call with first name, last name and
company name returned `http_400`, and the spec says the same thing in the field
descriptions — `company_domain` is "required if no linkedin_url", while `company_name`
is optional and only "improves accuracy". Send it alongside a domain, never instead of
one.

That leaves one honest route for a row that has a person and a company name but no
domain and no profile URL: **resolve the domain first**, with
`find_website_by_company_name()`, and then run the email lookup. That is a second paid
hop with its own miss risk, so it is named in the plan and priced there like any other —
not folded silently into "the waterfall will handle it". If the user does not want to
buy the resolution, the row is not enrichable here.

This is also where [`/list-hygiene`](../list-hygiene/SKILL.md)'s audit and this plan
have to agree, and now do: hygiene counts a row with **no email, no domain and no
LinkedIn URL** as having no enrichable identifier. A row whose only company signal is a
name is exactly that row. It is not unusable — it is one resolution hop away from
usable — and both skills say so with the same words.

`phone_finder` takes `linkedin_url`, or `first_name` + `last_name` + `domain`.
`enrich_profile` takes the profile URL. A list sourced from post engagers carries no
profile URL (the engager row's `url` is the comment's permalink), but it does carry
`urn`, so those rows go to **bulk profile enrichment** first, and the email lookup runs
on the profile URL that comes back.

**Every one of these lookups bills per call, found or not.** The catalog prices
`email_finder`, `phone_finder` and `email_verifier` as flat per-call charges, and only a
non-`2xx` is unbilled. Having enough input makes a call possible; it does not make it
free when it misses. The `Billed on a miss:` block prints what that costs.

A business row with no person on it (a maps listing, say) gets no email lookup at all.
If it already carries an `email` column, the waterfall verifies that address; otherwise
the row needs a named contact from another skill before it is worth planning here.

### `web_emails` — the site-scrape hop, and it is NOT part of `richapi enrich`

This skill owns `web_emails` (`_lib/endpoint-owners.yaml`), and until a live run tripped
over it, it was owned and never documented: the `local-business-outbound` recipe named a
"scrape the addresses a business publishes on its own website" step, and there was no
such step anywhere. There is no `web_emails` hop in `richapi enrich`, there never was,
and `--dry-run` never planned one. **It is a direct call, run per row, outside the
waterfall:**

```bash
richapi call web_emails --param url="https://<the business's site>" --param max_pages=3 --dry-run
```

- `url` is the only required field. `max_pages` bounds the crawl and therefore the time,
  not the price: the catalog prices this **flat per call**, so one page and ten pages
  cost the same, and a 5-page default is the spec's, not this skill's.
- **It is billed on a miss like everything else.** The recorded 200 is
  `{"data":{"emails":[],"pages_crawled":1},"meta":{"quality_warning":"Page returned no
  relevant data"}}` — an empty array, a warning, and a charge. Read `meta.quality_warning`
  back to the user; it is the API telling you why the miss happened.
- **It finds a BUSINESS inbox, not a person.** `info@`, `hello@`, `bookings@`. That is a
  different message and a different consent question from a named person's work address —
  hand it to [`/comply`](../comply/SKILL.md) before anything is written to it, and do not
  present it as a contact for a person.
- Because it is not a waterfall hop, it is **not** in `richapi enrich --dry-run`'s plan
  and not in the receipt's cost-per-found block. Price it from the catalog at plan time
  and approve it separately, on the row count you intend to scrape.

### The URN column and batching

Bulk profile enrichment takes LinkedIn entity URNs, not profile URLs, and nothing in this
API converts one to the other. Batching is possible only when the list already has a
`urn` column. A post-engager list does: `/build-prospect-list` writes
`urn` = `commenter.entityUrn` for exactly this reason. See the batching rule below.

**What the bulk path actually returns — and it is not a title.** A live bulk call on the
engager list came back with no job title and no company on any row. This is a shape
difference, not a miss: a bulk element nests its collections under `contents`
(`positionGroups.contents[0].profilePositions[0].title`) where the single endpoint does
not (`positionGroups.0.profilePositions.0.title`), and the field map is the single
endpoint's. Recorded in `tests/fixtures/live/enrich_profiles_bulk.json`.

| From `enrich_profiles_bulk` | |
|---|---|
| **you get** | `first_name`, `last_name`, `headline`, `summary`, `linkedin_url`, `linkedin_urn`, `industry`, `location`, `location_city`, `location_state`, `location_country`, `open_to_work`, `hiring`, `linkedin_premium`, `linkedin_influencer`, `linkedin_creator`, `profile_picture` |
| **you do NOT get** | `title`, `company_name`, `company_domain`, `company_linkedin_url`, `current_role_started`, `education_school` — every one of them empty |

**So: bulk gets you the profile URL; the title costs a second call.** The bulk row's
`linkedin_url` is a real profile URL (unlike the engager row's `url`, which is a comment
permalink), and that unlocks the rest of the waterfall: `email_finder` and `phone_finder`
both accept it. To get a **title and a company**, run the single `enrich_profile` on that
URL — a second paid profile hop, priced from the catalog like any other, and it is the
only route. The runtime still batches what it can; nothing here asks you to hand-roll a
loop. Do not read `headline` as a title: it is free text the person wrote about
themselves, and `/build-prospect-list` already says the headline filter ran on headlines
and not on titles.

`location_country` from either path is a country **name** — "United States", not `US`.
[`/comply`](../comply/SKILL.md) reads it and maps it (Step 1a); nothing else needs to.
- **Suppressed rows are dropped before any call.** They are never enriched and never
  reach the output.

## The unit that matters — cost per found record

This is the part of the skill a user is most likely to be surprised by, so say it
before they approve rather than after they are billed.

**A hop is charged for asking, not for answering.** The API bills every successful
call, and a `2xx` that carries no email is a successful call. `email_finder` is
charged when it returns an address and charged when it does not. `phone_finder` — the
price outlier listed under `gates.yaml:always_ask.endpoints` — is the same. The only
call the API does not bill is a non-`2xx`, and a not-found is not an error.

So there are two different costs and the pack now prints both:

| | what it is | where it comes from |
|---|---|---|
| cost per **call** | what the ledger is charged | the catalog price, per hop |
| cost per **found record** | what the operator actually spends | run credits ÷ records found |

They are the same number only at a full hit rate. Below that the second is strictly
larger, and the gap is exactly the money spent on misses. A hit rate of three finds in
five calls makes the real unit two-thirds larger than the sticker price.

**No one can tell the user their hit rate in advance.** The API publishes none, the
plan will not invent one, and neither will you. What the plan can say (and does) is
which hops bill on a miss and what the run costs if they all do. What the receipt says
afterwards is the real cost per found record, per capability, computed from the ledger
and the run's own find/miss record.

If the user is deciding whether the list is worth enriching, the honest framing is:
"the ceiling is what you pay if nothing is found; the receipt afterwards tells you what
each record you did get actually cost."

## Step 2 — get explicit approval

The plan is what the user approves, not a number you said out loud. Thresholds live in
`_lib/gates.yaml`; never state a cost limit from memory.

If the plan includes `phone_finder`, say so explicitly. It is by far the most expensive
call in the API and it is opt-in behind `--phone` for that reason.

## Step 3 — run it

```bash
richapi enrich <list.csv> --out enriched.csv
```

What happens, so you can explain it if asked:

- every row and hop is journalled before and after the call, so a crash is resumable
- the read-through cache is checked first, so a repeat run costs close to nothing
- output goes through the suppression filter again at write time, because someone may
  have unsubscribed since the plan was built

If it is interrupted, resume rather than restarting:

```bash
richapi enrich <list.csv> --resume <run-id> --out enriched.csv
```

A resume pays only for rows that did not finish. Restarting pays for everything again.

## Step 4 — report honestly

Read the receipt the command prints and pass on what it says. Two rules:

- **Never restate an estimate as a fact.** Most endpoints do not report their charge
  back, so the receipt gives a range. Say "at least X, up to Y" when it does. Do not
  round it into a single confident number.
- **Report what was not found.** Coverage is the number the user actually cares about.
  If half the rows came back without an email, lead with that, and say which input was
  missing. "22% skipped, all of them rows with no LinkedIn URL and no company" is
  useful. "Done!" is not. Rows that were looked up and missed are a separate count from
  rows that were never looked up, and the misses were still billed.
- **Quote the `Cost per found record` block, not just the spend line.** It gives the
  hit rate and the credits per email and per phone actually obtained. That is the
  number an operator budgets against; the per-call price is only what the ledger was
  charged. If the two look far apart, the distance is the miss billing, and that is the
  finding — not a rounding error to smooth over.
- **A capability that found nothing says so in words.** The receipt writes "0 found,
  N credits spent" rather than dividing by zero. Repeat the words. Do not convert them
  into a rate, and do not describe the run as cheap because no per-record figure was
  printed.
- **An estimated per-found figure stays estimated.** Most endpoints never report their
  charge back, so the receipt gives the per-found unit as a range and labels it. Pass
  the range on. A figure the receipt would not call measured is not one you may.

## What this skill will not do

- **It will not enrich a list it cannot suppress.** No readable suppression store means
  no run.
- **It will not batch by default.** The bulk endpoints take URNs where their single
  forms take URLs, so `--batch` only helps a list that already carries a `urn` column,
  and results are matched back to rows by that id, not by position. Offer `--batch` for
  such a list; never build URNs by hand from profile URLs.
- **It will not promise a title from the bulk path.** Bulk profile enrichment returns no
  `title` and no `company_name` — see the table above. Saying otherwise sent a run to
  `/evidence-score` and `/personalize` with two empty columns they were told to expect.
- **It will not invent fields.** Only the columns the API documents are mapped into the
  output. If a user expects a column that is not there, the answer is which endpoint
  would supply it, not a guess.
- **It will not predict a hit rate.** Nothing in the API publishes one and the plan
  refuses to fabricate one, so no pre-run promise about coverage or cost per found
  record is available. Where earlier runs exist the plan may cite what they observed,
  labelled as a record of those runs; that is history, not a forecast for this list.
- **It will not get a refund for a miss.** There is no partial-charge, no
  pay-per-result and no credit-back path in this API for a call that answered with
  nothing. Choosing not to make the call is the only way not to pay for it, which is
  what a row with no usable input, a suppression hit and a cache hit each achieve.

## Related

- Cost detail per run: `richapi gates` prints every threshold and its key.
- [`/cost-optimizer`](../cost-optimizer/SKILL.md) — where a low hit rate turns into a
  concrete change: cheaper hop order, a cache TTL, or dropping a hop whose per-found
  cost is not worth it.
- [`/list-hygiene`](../list-hygiene/SKILL.md) — the cheapest fix for a bad hit rate is
  a better input list, and it costs nothing to run.
- The full plan and phasing: [`../../ROADMAP.md`](../../ROADMAP.md#next).
