# RichAPI GTM Skills

**The only GTM agent pack that shows you the bill before it spends your money.**

Every other GTM skill library orchestrates somebody else's API, so it cannot tell you
what a run will cost until the invoice arrives. This one owns the data plane: it prices
every call from a generated catalog, per row and per hop, and **refuses to make one until
you approve the total.** There is no opt-out, not even at setup.

34 go-to-market skills sit on top of that runtime (ICP through export) and 11 of them
never spend a credit at all.

![status](https://img.shields.io/badge/status-2.0.0--alpha.0-orange)
![node](https://img.shields.io/badge/node-%E2%89%A5%2018.20.8-brightgreen)
![tests](https://img.shields.io/badge/tests-passing%20locally-brightgreen)
![paid calls before approval](https://img.shields.io/badge/paid%20calls%20before%20approval-0-blue)
![skill format](https://img.shields.io/badge/format-SKILL.md-blueviolet)
![license](https://img.shields.io/badge/license-MIT-blue)

**Runs in Claude Code · Cursor · Windsurf · Codex · Copilot · Cline · Continue · Zed** —
anything that reads the [`SKILL.md`](https://agentskills.io) format. The CLI underneath
works in every other agent too, and on its own.
[**Install →**](docs/INSTALL.md)

Every skill and every dry run costs nothing before you set an API key. Not a trial, not a
quota: without `richapi_API_KEY` in the environment the pack plans, prices, gates and
refuses, and never calls. 11 of the 34 skills never make a paid call at all, with or
without a key.

|  |  |
|---|---|
| **For you if** | You run B2B GTM on RichAPI and want the API driven by a repeatable, costed process instead of one-off calls. |
| **Not for you if** | You want a sender, a dialer, a CRM writer, or a hosted product. This pack stops at the send button — [on purpose](#what-this-pack-will-not-do). |
| **You need** | An agent that reads `SKILL.md` (Claude Code, Cursor, Windsurf, Codex and [20+ others](docs/INSTALL.md)), plus Node >= 18.20.8 and `jq`. A RichAPI account with credits is needed only by the 22 skills that can spend. |
| **Maturity** | `2.0.0-alpha.0`. [How finished this is](#where-this-actually-stands) — read it, the caveats are real. |

---

## Install

Do this first. The free command below needs the state tree that `setup` creates, and
exits 5 without it.

**Requirements:** Node >= 18.20.8 — the exact lowest version the suite has been run green
on, not an aspiration — and `jq`, which the preflight shells out to for every check that
reads JSON. Without `jq` those checks report `unknown` rather than `no`, and
`JQ_MISSING: yes` names the real cause: a check that could not run is not a failing
check.

```console
$ git clone https://github.com/richapiai/gtm-skills
$ cd gtm-skills
$ npm ci
$ npm link                 # puts `richapi` and `richapi-setup` on your PATH
$ ./setup                  # creates ./gtm/ — 0 API calls, 0 credits
```

### Or let your agent do it

Paste this into Claude Code, Cursor, Codex or any agent with a terminal. Every exit code
below is real; the agent should stop and report rather than guess.

```text
Install the RichAPI GTM skills pack in the current directory and verify it works.

1. Check Node: `node --version`. The pack needs 18.20.8 or newer. If node is missing
   or older, stop and tell me how to install it for my OS. Do not continue.
2. `git clone https://github.com/richapiai/gtm-skills && cd gtm-skills && npm ci`
3. `npm link` so `richapi` and `richapi-setup` are on my PATH.
4. `./setup --root .` to create the ./gtm/ workspace. This makes zero API calls and
   spends zero credits. Exit 127 = Node missing, exit 1 = Node too old; in either case
   stop and report the message rather than working around it.
5. `richapi doctor` and read the report back to me. Exit 0 is healthy, exit 3 means
   something is blocking. "No API key" and "Credit balance: unknown" are both normal
   and are NOT failures.
6. Show me a priced plan that costs nothing to produce:
   `printf 'email\na@example.com\n' > sample.csv && richapi enrich sample.csv --dry-run`
   A dry run makes zero API calls. Report the credit total it prints.
7. Read llms.txt and tell me which skills fit what I do. It lists every skill and
   marks the ones that never spend a credit, so I can try those with no account.

Rules: never run a command that spends credits without showing me the dry-run total
first and waiting for me to approve it. Never pass `--yes`. If any step fails, stop and
show me the exact output and exit code.
```

Once that finishes, `/gtm-onboard` teaches the pack what you sell, which is what
`/personalize` reads before it writes anything. It costs nothing.

To install the skills into Claude Code — the plugin marketplace, or symlinks from a
checkout — see **[`docs/INSTALL.md`](docs/INSTALL.md)**. The CLI and the
skills install separately and both are needed; the preflight stops on a version mismatch
between them rather than failing later with `command not found`.

`setup` writes `gtm/` into `.gitignore`, creates the state tree, and creates an empty
suppression store, all under whichever directory you point it at. It makes **zero API
calls and spends zero credits** — law 3 has no carve-out for setup. It refuses to run at
all in a repo where `gtm/` is already git-tracked, because that means personal data is
already in your git history. From an npm install the same command is `richapi-setup`;
from a checkout, `./setup`.

Check the runtime any time:

```console
$ richapi doctor           # abridged
[  ok  ] Catalog loaded — 68 endpoints
[  ok  ] Do-not-contact store is readable
[  ok  ] No API key — dry runs still work
[  ok  ] Credit balance: unknown

Everything checks out. Nothing here spends a credit until you approve a plan.
```

Every finding comes with the fix. `richapi preflight` gives the same checks as a stable
`KEY: value` contract for scripts; `richapi doctor --report` renders a paste-able block
for a bug report, carrying no list data, no file paths, no API key and no install
fingerprint.

Two lines people misread. **`No API key`** is fine — dry runs are free and are the thing
worth trying first. **`Credit balance: unknown`** is the honest state, not a failure: with
no key set there is no account to have a balance, and with one the number only appears
after a background probe of `GET /usage` has answered.

To give an agent the skills, follow [`docs/INSTALL.md`](docs/INSTALL.md).
Start it with [`/richapi-gtm`](skills/richapi-gtm/SKILL.md), which routes to everything
else.

### Choosing where state lives

`--root` names the *parent*; `--dir` names the *state tree itself*, which is the `gtm/`
directory inside that parent. They are one level apart, so the flags do not take the same
value:

```console
$ ./setup --root ~/lists                                # creates ~/lists/gtm/
$ richapi enrich leads.csv --dry-run --dir ~/lists/gtm   # reads ~/lists/gtm/
```

`--dir` defaults to `./gtm`, so after a plain `./setup` you can drop the flag entirely.
Pass the parent by mistake and nothing is guessed and nothing is called:

```console
$ richapi enrich leads.csv --dry-run --dir ~/lists
richapi: suppression store unreadable — failing closed, no call made.
  suppression store missing at ~/lists/suppression.jsonl — STOP. Run `setup` to create
  it. A missing store is never read as "nothing suppressed".
```

Exit 5. That is the fail-closed rule working, not a bug — but if you see it straight
after a clean setup, `--dir` is pointing one level too high.

---

## Start with the free command

You have run `./setup`. Nothing from here spends a credit until you have seen the bill.

**Before the price, the list.** `--explain-my-list` makes zero calls, needs no key, and
answers the question that comes before "what does it cost":

```console
$ richapi enrich leads.csv --explain-my-list        # abridged

LIST QUALITY — leads.csv   (no calls made, no credits spent)

Rows analysed        500
  enrichable         160  (32%)  <- the rows worth paying for
  nothing to buy     340  (68%)  no hop can run on these
  suppressed           0  (0%)   never contacted, never priced

Missing inputs  (the fixable half — these are columns your CRM may already have)
  no linkedin_url      340  (68%)
```

340 of those rows cannot be enriched by any vendor on earth, because they carry no
identifier. That is worth knowing **before** you look at a total, not after. If a cap
stops the read it says so on the first line — a truncated count is never rendered as a
total.

Then the dry run. Also **zero API calls**, also no key, and it prints the whole plan:

```console
$ richapi enrich leads.csv --dry-run        # abridged

DRY RUN — plan for run enrich-mthammoe-14464b (no calls made)

Waterfall: 0:enrich_profile -> 1:email_finder? -> 2:email_verifier?

Per hop:
  hop 0  enrich_profile               2 calls @ 1cr  = 2cr  | 1 n/a
  hop 1  email_finder                 3 calls @ 5cr  = 15cr
  hop 2  email_verifier               3 calls @ 2cr  = 6cr

Rows:
  r00000-bf780ecee54b  enrich_profile=1cr, email_finder=5cr, email_verifier=2cr  => 8cr
  r00001-fb8bf32b6c03  enrich_profile=1cr, email_finder=5cr, email_verifier=2cr  => 8cr
  r00002-6c0f3b1e61ca  enrich_profile=not_applicable, email_finder=5cr, email_verifier=2cr  => 7cr

Rows:        3 (0 suppressed/dropped, 0 fully cached)
Calls:       8 (0 cache hits skipped, not charged)
TOTAL:       23 credits (ceiling; floor 2 if no conditional hop fires)

Billed on a miss:
  only a non-2xx is unbilled — a 2xx that found nothing is a successful call and is charged in full.
  hop 1  email_finder                 3 calls @ 5cr  = 15cr charged even if none of them finds anything  | conditional: fires on an earlier hop's find, bills on its own miss
  If every one of those 8 calls misses you still pay 23 credits and get 0 records.
  Cost per found record is reported by the receipt, after the run.

ZERO calls made. Journal: gtm/runs/enrich-mthammoe-14464b.jsonl

hops not attempted:
  enrich_profile       1  no linkedin_url to enrich from
```

Four things in that output are the point of the whole pack.

**The total is a ceiling, not an estimate.** 23 is what you pay if every conditional hop
fires. 2 is the floor if none do. Both numbers come from the generated catalog.

**A conditional hop bills on its own miss.** `email_finder` fires only when an earlier hop
found something — but once it fires, a 2xx that returns no email is a successful call and
is charged in full. The plan names which hops behave that way before you approve it, and
the receipt afterwards divides what you actually spent by the records you actually got.

**`hops not attempted` is a list problem, not an API problem.** Row three has no LinkedIn
URL, so no vendor on earth can run a profile enrichment on it. Better to know that before
you pay for the other two.

**Adding a hop re-prices the plan in front of you.** `--phone` on the same three rows
takes the ceiling from 23 credits to 98, because `phone_finder` is 25 credits a call. It
is opt-in, and it confirms every time even when your budget is untouched.

Then approve the plan and run it:

```console
$ export richapi_API_KEY=...
$ richapi enrich leads.csv --out enriched.csv
```

You get `enriched.csv`, a per-hop ledger, and a receipt. That is the activation path: one
command, one list, under 30 credits, a file you wanted.

If it dies at row 380 of 500, resume — it pays for the 120 rows that did not finish, not
for all 500:

```console
$ richapi enrich leads.csv --resume <run-id> --out enriched.csv
```

> A 30-second terminal recording belongs here. It has not been recorded yet; the exact
> commands, the expected output at each beat, and the capture invocation are in
> [`docs/demo-script.md`](docs/demo-script.md).

---

## What a credit costs

Credits are bought from RichAPI: **<https://richapi.ai>**. What a credit costs in money
is not stated anywhere in this repository and is **deliberately not guessed here** — the
pinned spec documents the API host and nothing else, so any figure would be invented.
Check the site.

What this pack *can* tell you honestly, because every number below is read from the
pinned spec and from [`_lib/gates.yaml`](_lib/gates.yaml) rather than typed:

| | |
|---|---|
| Free grant on a new account | **25 credits** |
| A contact through the default waterfall | ~8 credits (profile 1 + email 5 + verify 2) |
| So the free grant buys | **about three contacts.** Not a trial you can run a list through. |
| `phone_finder` | 25 credits a call — the entire grant, in one keystroke. Opt-in, and it always confirms. |

That is why there is no absolute credit gate in this pack. A gate at 20 or 50 credits
would fire dozens of times during a 100-row run and be clicked through by row ten. Gates
fire instead on cumulative session spend as a *fraction* of a budget you name once, and
an unattended run must name one: `--yes` without `--budget` is refused, because a null
budget is not "no gate crossed", it is no gate.

---

## What is different about this

**Every paid call is named and costed before it runs.** Not a budget warning after the
fact — a plan artifact, per row and per hop, that you approve. There is no opt-out, not
even at setup.

**Credit numbers are generated, never typed.** They come from `x-pricing` in the pinned
OpenAPI spec, through `_lib/api-catalog.json`, into the plan. This is not fastidiousness:
16 of the 53 endpoints that survived the last four months were repriced in that window,
and `phone_finder` went from 3 credits to 25, an 8.3x rise, with nothing in the old pack
noticing. Every skill is linted for a bare hand-typed number and CI fails on one.

**A suppressed contact cannot reach an output.** The store is checked when the plan is
built and again at write time, because someone may have unsubscribed in between. A store
that is missing, unreadable or corrupt reads as STOP, never as "nothing suppressed". In
the run above, suppressing one domain drops the ceiling from 23 credits to 16 and that
row costs zero.

**Response maps come from recorded responses, not from the spec.** The spec's own 200
examples were wrong about where the payload lives, and following them cost the email on
every paid `email_finder` call until 2026-09-02. Every mapped field is now a path a
recorded response actually contained, the build replays those recordings on every run,
and a *partial* read (some columns, but not the one the call was bought for) is a loud
failure rather than a silent pass. [The measurements](LIMITATIONS.md).

**Nothing fabricates an actual.** 11 of the API's 21 per-result endpoints never report
what they charged. A run touching those reports a range, "at least X, up to Y", with
the basis of the estimate recorded on the ledger line. A charge is only promoted to
`actual` when the response carries `credits_charged`. A 402 or a 429 is `known_zero`,
not a verified zero.

**The catalog absorbs API churn instead of rotting.** `richapi catalog diff` classifies
every spec change by severity. Renames and small repricings warn; a >=2x repricing, a
removed endpoint that something still claims, and a change in billing *semantics* block.
A binary gate at ~30% churn per quarter would be red every month and switched off by
month two.

---

## The skills

Generated from each `SKILL.md`'s frontmatter `description`. Every skill states what it
will not do, links onward, and, if it can spend, cites the dry run or the gate key that
bounds it. `npm run validate` enforces all four.

**11 of the 34 never make a paid call**, marked `free` below. They read what is already
on disk (a ledger, a run journal, a list, a transcript) and reach no endpoint, so they
work in full against a checkout with no API key and no RichAPI account. The other 23 can
reach a metered endpoint, and every one of them shows you a priced plan first. The split
is derived, not counted by hand: a skill is `free` when `_lib/endpoint-owners.yaml` gives
it no metered endpoint and its own `SKILL.md` invokes none, and a contract test fails if
this list and that derivation disagree.

**Start here**

- [`/richapi-gtm`](skills/richapi-gtm/SKILL.md) — **free.** Entry point for the RichAPI GTM pack. Classifies what the user is trying to do, dispatches to the right skill, and closes the session with a real spend receipt read from the ledger.
- [`/gtm-kickoff`](skills/gtm-kickoff/SKILL.md) — **free.** The entry point for a new GTM engagement. Interrogates the motion before a single credit is spent.
- [`/gtm-onboard`](skills/gtm-onboard/SKILL.md) — Teaches the pack who YOU are. Captures the seller (company, website, what you sell, the wedge, what you may cite, how outreach should read, who owns which inbound) into `gtm/profile.yaml`.

**Target**

- [`/icp-review`](skills/icp-review/SKILL.md) — Tests an ICP against accounts that actually closed, and writes the anchor artifact every downstream skill reads.
- [`/tam-map`](skills/tam-map/SKILL.md) — Sizes a total addressable market and breaks it into segments the rest of the pipeline can act on.
- [`/build-prospect-list`](skills/build-prospect-list/SKILL.md) — Turns a plain-English ICP (or a target account.
- [`/local-business-prospecting`](skills/local-business-prospecting/SKILL.md) — Sources brick-and-mortar and SMB prospects from maps and directories rather than from LinkedIn — "what and where" instead of "title and industry".

**Enrich**

- [`/enrich-waterfall`](skills/enrich-waterfall/SKILL.md) — Waterfall enrichment over a contact list (profile, work email, phone, verification), with the cost shown and approved before anything is spent.
- [`/list-hygiene`](skills/list-hygiene/SKILL.md) — Dedupe, validate and suppress a contact list before anyone spends enrichment credits on it.

**Research**

- [`/account-research`](skills/account-research/SKILL.md) — Everything knowable about one account, assembled into a brief a rep can act on.
- [`/org-map`](skills/org-map/SKILL.md) — Maps the buying committee at one account (who reports to whom, who influences, who signs), as a graph where every edge carries its provenance and a line nobody observed is drawn as a line nobody observed.
- [`/competitive-intel`](skills/competitive-intel/SKILL.md) — What a competitor is actually doing (the ads they are buying, the stack and pixels on their site, what they publish, and where their traffic and demand come from).
- [`/research-agent`](skills/research-agent/SKILL.md) — Answers a freeform research question across a list — the escape hatch for questions no specific skill covers.
- [`/evidence-score`](skills/evidence-score/SKILL.md) — Grades how well-evidenced a claim about an account or person actually is, and rolls those grades into an auditable 0-100 readiness score across fit, timing, influence, engagement and reachability.
- [`/pre-meeting-briefing`](skills/pre-meeting-briefing/SKILL.md) — A call sheet on the humans you are about to meet, built inside a ten-minute box and a plan you approve once.

**Compose**

- [`/personalize`](skills/personalize/SKILL.md) — Writes personalised outreach (first lines and short email bodies) grounded in a research brief, where every claim traces to a source line and an unsupported claim is refused rather than written.
- [`/sequence-builder`](skills/sequence-builder/SKILL.md) — **free.** Designs the outreach sequence (how many steps, how far apart, on which channel, and what each step is for) and writes a copy skeleton with the merge-tag syntax of the sender the team already uses.
- [`/play-design`](skills/play-design/SKILL.md) — Designs a repeatable GTM play — the trigger that starts it, the audience it applies to, the sequence of existing skills that runs, and the number that says whether it worked.
- [`/outreach-expert`](skills/outreach-expert/SKILL.md) — **free.** Advises on outreach setup up to (and only up to) the send button: domain and mailbox strategy, SPF/DKIM/DMARC, warmup, sender rotation, deliverability diagnosis, bounce handling and sequence hygiene.

**Gate**

- [`/comply`](skills/comply/SKILL.md) — The hard compliance gate. Resolves the jurisdiction of every contact, clears a lawful basis under GDPR, CCPA/CPRA or CASL before anything is contacted.
- [`/campaign-review`](skills/campaign-review/SKILL.md) — **free.** Reviews a contact list against the pack's quality.

**Ship**

- [`/launch`](skills/launch/SKILL.md) — Writes the sender-format export (the last artifact the pack controls) and only against a PASS verdict bound to the list's content hash.
- [`/crm-export`](skills/crm-export/SKILL.md) — **free.** Writes the pack's data out as a CRM import file.
- [`/crm-sync-expert`](skills/crm-sync-expert/SKILL.md) — **free.** Designs a CRM synchronisation before anyone runs one — which object a row belongs to, which key deduplicates it, what wins on a collision, and what the CRM will silently truncate, coerce or drop on import.
- [`/ads-audience`](skills/ads-audience/SKILL.md) — Turns a list the pack already holds into a matched audience an ad platform will actually accept — suppression-filtered, hashed, and checked against the platform's own minimum BEFORE a credit is spent.

**Always on**

- [`/signal-watch`](skills/signal-watch/SKILL.md) — Watches a list of accounts for the moment they become buyable.
- [`/inbound`](skills/inbound/SKILL.md) — Routes one inbound lead (a demo request, a trial signup, a contact form) to the right owner in under five minutes, on a fixed, flat-priced recipe that was named and costed before the lead ever arrived.
- [`/reply-triage`](skills/reply-triage/SKILL.md) — Classifies inbound replies pasted or exported out of a sender (interested, objection, not now, wrong person, unsubscribe) and routes each one.
- [`/call-intel`](skills/call-intel/SKILL.md) — Turns a call transcript into structured intel a team can act on (objections raised, next steps agreed, competitors named, commitments made), with every item anchored to a verbatim line of the transcript.
- [`/scheduled-workflow`](skills/scheduled-workflow/SKILL.md) — Runs a saved workflow on a schedule, under an envelope the user approved in advance for a bounded, named set of work.

**Measure**

- [`/measure`](skills/measure/SKILL.md) — **free.** Reports what a GTM run actually did — coverage first, then spend as an honest range, then hit rates by hop and provider.
- [`/cost-optimizer`](skills/cost-optimizer/SKILL.md) — **free.** Finds where the credits went and what to do about it, from the real ledger.
- [`/gtm-retro`](skills/gtm-retro/SKILL.md) — **free.** A retrospective across many runs and campaign arms, ending in decisions: stop this play, keep that one, scale the third.
- [`/learn`](skills/learn/SKILL.md) — **free.** The local learnings flywheel. Records aggregate provider and hop hit rates from a run journal into gtm/learnings.jsonl.

---

## Recipes: a whole job in one ask

Some jobs take several skills in a row. A recipe names that chain, so you can ask for the
job in plain words and [`/richapi-gtm`](skills/richapi-gtm/SKILL.md) routes you to it.
Each skill in the chain still shows its own priced plan and asks before it spends.

| Ask for | Recipe | Ends with |
|---|---|---|
| The people who engaged with a LinkedIn post, qualified and verified | [`post-engagers-to-list`](skills/build-prospect-list/SKILL.md#post-engagers-to-list) | a send-ready export |
| Decision makers and verified emails at a list of domains | [`domains-to-decision-makers`](skills/build-prospect-list/SKILL.md#domains-to-decision-makers) | a contact list |
| A brief on one account, with its buying committee | [`account-brief`](skills/account-research/SKILL.md#account-brief) | a brief |
| An ICP turned into a sized, scored account and contact list | [`icp-to-scored-list`](skills/tam-map/SKILL.md#icp-to-scored-list) | a CRM import file |
| Accounts like your closed-won deals, and their buyers | [`lookalikes-from-won-deals`](skills/tam-map/SKILL.md#lookalikes-from-won-deals) | a CRM import file |
| Champions who moved to a new company | [`champion-moved`](skills/signal-watch/SKILL.md#champion-moved) | a send-ready export |
| Accounts now hiring your buyer or changing their stack | [`hiring-or-stack-change-outbound`](skills/signal-watch/SKILL.md#hiring-or-stack-change-outbound) | a send-ready export |
| An enriched, routed form submission with a drafted reply | [`inbound-form-route`](skills/inbound/SKILL.md#inbound-form-route) | a routed lead |
| Local businesses with contacts and a review-based pitch | [`local-business-outbound`](skills/local-business-prospecting/SKILL.md#local-business-outbound) | a send-ready export |
| A cleaned, filled CRM export | [`crm-cleanup`](skills/list-hygiene/SKILL.md#crm-cleanup) | a CRM import file |
| More people to bring in after a call, and the next-step email | [`post-call-follow-up`](skills/call-intel/SKILL.md#post-call-follow-up) | contacts and a draft |

A CRM import file is not clearance to contact anyone: run
[`/comply`](skills/comply/SKILL.md) and [`/campaign-review`](skills/campaign-review/SKILL.md)
before any send. `tests/skills/recipes.test.mjs` fails if a recipe names a skill that does
not exist or sends without the pack's gate order.

---

## The CLI under the skills

Every skill drives the same runtime, so everything above gets the same dry run, gates,
journal, ledger, cache and resume.

| Command | What it does |
|---|---|
| `richapi enrich <list> --explain-my-list` | **Free.** How much of this list is worth paying for |
| `richapi enrich <list>` | The waterfall: profile -> email -> phone -> verify |
| `richapi call <endpoint>` | Any one catalog endpoint over a list of rows. `--out` gets mapped columns plus the full body; an endpoint with no response map writes the raw body (`response` in JSONL, `response_json` in CSV) with `response_mapped: false` |
| `richapi search <endpoint>` | One endpoint across N pages, each page priced and gated |
| `richapi preflight` | The health contract: catalog, key, suppression, balance |
| `richapi doctor` | The same checks in English, with the fix. `--report` gives a paste-able block |
| `richapi gates [key]` | Every threshold and the key it comes from |
| `richapi catalog diff` | What changed in the API, by severity |

Exit codes are scriptable:

| | | | |
|---|---|---|---|
| `0` ran or planned | `2` usage | `3` blocked by a gate | `4` no API key |
| `5` suppression store unreadable | `6` another run holds this list | `7` plan not approved | `8` the API failed a unit (after retries) |

A declined plan exits 7, not 0, so a script can tell it from success.

---

## What this pack will not do

The ceiling is the API's ceiling, and stating it is the point. Full list in
[`ROADMAP.md` — Out of scope](ROADMAP.md#out-of-scope).

**External forever.** Sending execution — owning sending means owning spam complaints.
LinkedIn actions, on ToS risk. Dialing and live calling. Direct mail and gifting. Inbox
hosting. These are not backlog items; the pack takes you up to the send button and stops.

**Blocked on endpoints that do not exist.** The designs are written; the API is not there
yet. Visitor de-anonymization. Real-time event triggers. Third-party intent data. Bulk
email find and verify. Phone verification. **True two-way CRM sync** — there is no
CRM-write endpoint, so [`/crm-sync-expert`](skills/crm-sync-expert/SKILL.md) designs the
sync and [`/crm-export`](skills/crm-export/SKILL.md) writes a file you import. Nothing in
this pack writes into your CRM.

**Batching is built and tested but off by default.** The bulk endpoints take LinkedIn URNs
where the single forms take URLs, and nothing in the API converts one to the other, so
for an ordinary list of profile URLs the bulk person path is unreachable. Where it does
apply, the response shape is not yet verified against the live API, which would make
attribution positional — one contact's data on another contact's row. `--batch` exists
for when that has been proven.

---

## Where this actually stands

**What works, today.** The runtime works end to end and is covered: **2,632 tests, 0
failing** (`npm test`, 2026-09-17), with `npm run validate` clean across all 34 skills
and the catalog up to date against the pinned spec. Dry runs, gates, the journal, the
ledger, the cache, resume, suppression and the exit codes are all exercised, and every
response map is replayed against a recorded live response on every run.

Two honest notes about that sentence, because it has been wrong before. The count is the
last line of `npm test` on the day it was written; a contract test
(`tests/contracts/no-stale-catalog-claims.test.mjs`) fails when it drifts far from the
number of declared tests, which is why an earlier stale *1,819* was caught. It checks a
**band**, not an exact match — so on 2026-09-01 this line read *2,372* while the suite
had 2,393, and nothing failed. **Nothing at all guards the "0 failing" half**: three
tests were red on that date while this sentence claimed none were. Run `npm test`
yourself rather than trusting the number; that is the only guarantee on offer.

**What is not proven.** Every caveat below is written up at length, with the measurement
behind it, in [`LIMITATIONS.md`](LIMITATIONS.md).

| | |
|---|---|
| **Unpublished** | Not yet on npm. `2.0.0-alpha.0`, install from a checkout or the plugin marketplace. |
| **CI has never run on a hosted runner** | The workflow is written and the gates are wired; the repo has no remote, so GitHub has never executed it. |
| **Two capture runs, one sample each** | 2026-08-31 and 2026-09-17; 5 of 68 endpoints still have no usable recorded success shape. Rate limits, error bodies and shape variation are unverified. |
| **No run is reconciled against the provider** | The API now documents `GET /usage` (team consumption and `credits_remaining`). Preflight probes it in the background for `BALANCE`; nothing compares a run's ledger against it yet. |
| **`jq` is a hard dependency** | Without it three checks report `unknown` and `JQ_MISSING: yes` names the cause. Install it. |

The two that change what you should expect from the output:

**The first capture run found a defect that had shipped.** On 2026-08-31 the harness
recorded 55 live responses (35 usable `200`s) against a real key. The response maps had
all been derived from the spec's 200 examples, and the spec was wrong about where the
payload lives:

| endpoint | price | columns delivered | what was lost |
|---|---|---|---|
| `email_finder` | 5cr | 1 of 3 | **the email address** |
| `email_verifier` | 2cr | 0 of 5 | everything |
| `phone_finder` | **25cr** | 0 of 2 | **the phone number** |
| `enrich_profile` | 1cr | 4 of 11 | title, company, url, location |

The default waterfall returned the email in **zero** cases. Fixed on 2026-09-02: maps are
now dotted paths taken from the recordings (the same waterfall delivers 69 columns where
it delivered 10), the build replays every recording on every run, and a *partial* read —
some columns but not the one the call was bought for — is now its own loud status instead
of counting as success. The whole story, with the three root causes, is
[`LIMITATIONS.md` §1](LIMITATIONS.md).

**Almost all of the surface is recorded; five endpoints are still the spec's guess.** The
catalog says which is which, per endpoint:

- `live_fixture` — 63 of 68. Scalar paths read off a real recorded 2xx response.
- `keys_from_spec_example` — 5 of 68. Still the spec's guess, which is the state that
  produced the defect above: `geo_id_search` (the sample missed),
  `google_ad_transparency_scraper_sync` and `linkedin_ad_search` (403 for this team),
  `google_maps_reviews_scraper_sync` (empty body), `slack_channel_members` (no capture
  input).
- `TODO_no_usable_example` — 0 of 68.

The waterfall hops are all in the first group. `--batch` still stays off, for the
separate reason in [`LIMITATIONS.md` §3](LIMITATIONS.md).

**29 of 68 endpoints turn their answer into columns; the rest are delivered raw.** Eleven
live recipe runs on 2026-09-17 found 21 endpoints that skills already call answering with
real data and no `RESPONSE_MAPS` entry, so the whole body arrived unnormalised. They are
mapped now, off the recordings. The remainder stay raw for a reason that is tested rather
than asserted — an array body that is N rows and not one, a recording that is a miss, or
no usable recording at all — and raw delivery is reported as
`DELIVERED UNMAPPED (raw body, N keys)`, **not** as a mapping failure. See
[`LIMITATIONS.md` §2](LIMITATIONS.md).

**No endpoint reports what it charged.** Across all 65 recorded 2xx bodies, not one
carries a `credits_charged`, `credits_used`, `credits`, `charge` or `cost`. Every credit
figure this pack prints is an estimate from the catalog price, and every ledger line
reads `estimated_unverifiable`. Until 2026-09-17 the catalog claimed 57 of 68 endpoints
reported their charge — a claim derived from spec examples and from "flat is verifiable
by construction", which contradicted every receipt those calls produced.
[`LIMITATIONS.md` §4](LIMITATIONS.md).

**CI has never executed on a runner.** Every step of the workflow has been run locally
instead, and the whole matrix (18.20.8, 20.19.0, 22.0.0, 24.5.0) has been executed by
hand on each of those versions. That is how the packaging bug was found, so the
distinction between "CI is green" and "the matrix was actually run" is not pedantry here:
the rows are pinned to exact versions rather than to `"20"`, because a floating major
resolves to the newest patch, and the pack was broken on Node 18 and 20.0-20.9 — every
executable was extensionless, which Node cannot load as ESM before 20.10 — while a `"20"`
row would have passed and certified an engine floor that was never true.

---

## Repo map

| Path | |
|---|---|
| [`skills/`](skills) | The 34 skills. One directory, one `SKILL.md`. |
| [`_lib/`](_lib) | Runtime: catalog, gates, ledger, journal, suppression, PII, enrich. |
| `bin/` | The CLI and the catalog/absorption tooling. |
| [`_lib/gates.yaml`](_lib/gates.yaml) | Every threshold the pack enforces, one file. |
| [`spec/`](spec) | The pinned OpenAPI spec and its checksum. |
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) | **Start here if you are not a developer.** Installs Node, reaches a free dry run, explains credits. |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Every error a first-timer hits, with the real message and the fix. |
| [`docs/validation.md`](docs/validation.md) | What has been run against the live API, what it found, and how to reproduce it. |
| [`docs/skills/`](docs/skills) | One plain-English page per skill: the problem it solves, when not to use it, what it costs. |
| [`docs/skill-shape.md`](docs/skill-shape.md) | The four rules every `SKILL.md` must satisfy. |
| [`docs/claims.yaml`](docs/claims.yaml) | Every number the docs may state about the pack, and where it is derived from. |
| [`docs/INSTALL.md`](docs/INSTALL.md) | Installing into Claude Code, Cursor, Windsurf, Codex and the rest — plus what MCP does and does not give you. |
| [`CLAUDE.md`](CLAUDE.md) | The seven laws, and why each one exists. |
| [`ROADMAP.md`](ROADMAP.md) | What is built, what is next, and what is out of scope. |
| [`LIMITATIONS.md`](LIMITATIONS.md) | What it cannot do or cannot verify, and the measurement behind each one. |
| [`SECURITY.md`](SECURITY.md) | Threat model, controls, and the known unscoped-`allowed-tools` gap. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the checks, and what a change is held to. |

`npm test` runs the suite. `npm run check` runs the absorption gates, the skill validator
and the tests together. MIT licensed.
