---
name: ads-audience
version: 1.0.0
description: >
  Turns a list the pack already holds into a matched audience an ad platform will
  actually accept — suppression-filtered, hashed, and checked against the platform's
  own minimum BEFORE a credit is spent, because an upload under the floor is rejected
  after the money is gone. Use when asked to "build a LinkedIn matched audience",
  "make a Meta custom audience", "Google Customer Match list", "retarget this list",
  "upload these contacts to ads", or "why did the platform reject my audience".
  Refuses on an unknown platform, refuses below the floor, and never writes a sender
  export. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write
triggers:
  - build a matched audience
  - linkedin matched audience
  - meta custom audience
  - google customer match
  - retarget this list
  - upload this list to ads
  - why did the platform reject my audience
---

# Build a matched audience the platform will accept

You are the person who has watched somebody spend a real enrichment budget filling in
emails for a list, upload it, and get one line back from the ad platform: *audience too
small*. No refund. No partial credit. The money was spent on the pack's side and the
rejection happened on theirs, hours later, in a different tab.

That failure is entirely preventable, and preventing it is most of this skill. The
platform floor is knowable before the first call. So the arithmetic runs first, the
spend runs second, and if the arithmetic says the audience cannot clear the floor, the
answer is no and nothing was bought.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `SUPPRESSION: STOP` — there is no readable suppression store. Run `./setup`.
  This is not a soft failure here. An audience file is PII leaving the pack, and a
  person who unsubscribed or asked to be erased must not be handed to an ad platform
  for retargeting. A check that cannot run is not a passing check (law 5), so with no
  store this skill writes nothing at all.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. Every price in the plan
  below is read out of that catalog at plan time. No price is written in this document.
- `API_KEY_SET: no` — you can still build an audience from emails the list already
  carries, and you can still see the whole plan for the paid fill. Say which of the two
  you are doing.

`BALANCE: unknown` is normal.
The balance comes only from a background probe of `GET /usage`.

## The money gate, stated plainly

`gates.yaml:audience_minimums` holds one floor per platform:
`gates.yaml:audience_minimums.linkedin`, `gates.yaml:audience_minimums.meta` and
`gates.yaml:audience_minimums.google`. Read them with `richapi gates audience_minimums`
and quote the number back to the user from that read — never from memory.

Three things about that block matter more than the values in it.

**It has no `default` key, and that is deliberate.** An unfamiliar platform name does
not fall through to a permissive default; the lookup fails and
`gates.mjs:checkAudienceMinimum` converts the failure into a STOP (law 5). So
"audience for TikTok" is a refusal with a named reason — *there is no floor recorded
for that platform, and this pack will not guess one* — and the fix is a gate key, not
a workaround. Guessing a floor here would be the worst kind of wrong: plausible,
unverifiable, and only discovered after the credits are gone.

**The floor is checked against a ceiling before it is checked against a result.** The
ceiling is the number of rows that could *possibly* end up in the audience: every row
in the source list, minus suppressed rows, minus rows with no usable identifier and no
way to acquire one. If that ceiling is already under the platform floor, the audience
is impossible and no amount of enrichment fixes it. That check costs nothing and it
runs first. This is the entire reason this skill exists.

**Clearing the floor on your side is not the same as clearing it on theirs.** You
upload identifiers; the platform matches them against its own accounts and only the
matches count. The realised audience is always smaller than the file, sometimes much
smaller, and the platform does not tell you which rows matched. So an audience sized
exactly at the floor is an audience that will be rejected. Say this to the user in the
plan, propose headroom, and record what you assumed. The headroom the ceiling must
clear over the platform floor is `gates.yaml:skills.ads_audience.pre_match_headroom_multiple`
— read it at run time, never type it. If that key does not resolve the fill is refused,
because a margin the pack cannot back is worse than no margin at all.

## Step 1 — the free work, and the refusal that comes out of it

Nothing in this step spends a credit (no endpoint is called at all), and it is where
most runs end.

1. **Read the source list.** This skill does not build lists. It consumes one that
   already exists — see `## Related` for where lists come from.
2. **Run the suppression pass.** Every row, before anything is counted. The store is
   `_lib/suppression.mjs` and it is the only writer of an output list in this pack;
   there is no unfiltered path and this skill does not add one.
3. **Screen the obvious role addresses locally.** A row with a role address — `info@`,
   `sales@`, `support@`, `no-reply@` and their kin — can never match: no ad platform
   holds a person behind a shared inbox. Reading a local part costs nothing, so do it
   here, and drop only the ones that are unambiguous. This is a screen, not the
   classification; it is deliberately conservative, so the count it leaves behind is an
   **upper bound** and a refusal computed from it is safe.
4. **Count the optimistic ceiling and check the floor.** Rows surviving suppression and
   the local screen, plus rows that carry a name and a company domain and could
   therefore be filled. Compare that total against the platform's key in
   `gates.yaml:audience_minimums`, with the headroom from
   `gates.yaml:skills.ads_audience.pre_match_headroom_multiple` applied.

If that ceiling is under the floor, **stop here and say so**, with all four numbers: the
source list size, how many rows suppression removed, how many the local screen dropped,
and the floor you are measuring against with the gate key it came from. The best case
does not clear the bar, so no purchase can rescue it. Then offer the two real options —
widen the source list, or pick a platform whose floor this list can clear — and make it
explicit that neither of them is *spend more and try again*.

## Step 2 — the classifier, which is the first call that costs anything

Only reachable when the optimistic ceiling clears the floor. **This step spends.**

The local screen catches the obvious role addresses and misses the rest — a shared
mailbox on a name-shaped local part looks exactly like a person. `identify_email_type()`
is the endpoint that resolves the remainder. It is flat-priced and bounded, and it is
the cheapest call in this skill by a wide margin, but it is metered and it is charged
per row, so it is planned and approved like any other spend (law 3):

```bash
richapi call identify_email_type --in gtm/lists/q3-uk.csv --dry-run
```

`--dry-run` makes **zero calls**. Show the user the exact row count and the exact total,
say that it buys a classification rather than an audience, and take an approval before
the first call. Never fold this into the fill's approval — one nod covering two
endpoints is how the cheap call becomes invisible.

Then re-count the ceiling on what the classifier actually returned and re-check the
floor. A ceiling built on the local screen was optimistic by construction; this is the
first count that is not. If the audience is impossible on the bought classification,
stop here (before the fill, which is the expensive half), and report the two counts
side by side so the user can see what the classifier changed.

## Step 3 — dry-run the fill, then take one approval

Only reachable when the ceiling built on the bought classification clears the floor.

The fill is `email_finder()`, and it is the expensive part of this skill by an order of
magnitude compared with the classifier. It is flat-priced per call, so the plan total is
exact rather than a range — one of the few places in this pack where that is true. Use
it: put the exact number in front of the user before the first call.

```bash
richapi call email_finder --in gtm/lists/q3-uk-missing.csv --dry-run
```

`--dry-run` makes **zero calls**. Read the plan with the user and say four things:

- **What the fill buys, in rows.** Not in credits alone: "this takes the audience from
  the ceiling you can reach today to the ceiling you can reach after", against the
  floor. A credit total with no audience number attached is not a decision anybody can
  make.
- **That the fill is per row and finds nothing for some of them.** A row that comes
  back empty was still a call. The plan total is what you pay; the realised audience is
  smaller than the plan implies, and it is smaller again after the platform matches.
- **What the session gates will do.** Cumulative spend crossing
  `gates.yaml:session_budget.fractions.confirm` asks before the call that crosses it,
  `gates.yaml:session_budget.fractions.stop` is a hard stop, and a single fill large
  enough to cross `gates.yaml:session_budget.fractions.single_call_confirm` asks on its
  own however little the session has spent. These fire inside the run and cannot be
  pre-approved away.
- **That `find_personal_email` is not in this skill.** It is in
  `gates.yaml:always_ask.endpoints` and it reaches a personal address. Personal
  addresses do not belong in an ad audience assembled from a business list, and this
  skill has no route to that endpoint — see `## Related` for the one that does.

`gates.yaml:skills.ads_audience.max_fill_rows` bounds how many rows one run may put
through the fill. Read it; a fill above it is split into runs that each clear it and
re-approved, never waved through. If the key does not resolve the check reads STOP and
the fill does not run. Then take **one approval for the whole plan**, not a nod per
row.

## Step 4 — write the audience, and say exactly what is in it

The output is two files: `gtm/audiences/<name>.<platform>.csv` and a sidecar
`gtm/audiences/<name>.<platform>.manifest.json`. Both are inside `gtm/`, which is PII:
gitignored, TTL-swept and erasable (law 7).

**What is in the audience file.** One column: the SHA-256 hex digest of the email
address, lowercased and trimmed before hashing. Nothing else. Not because a platform
would reject more, but because more is not needed to match a person and everything
extra is PII you exported for no reason.

**What is not in it, and will not be put in it:**

- Names, job titles, seniority, company names, phone numbers, LinkedIn URLs, or any
  other enriched field. None of them improve a match on an email-keyed audience.
- Plaintext email addresses. The digest matches; the address is the thing you would
  regret leaking.
- Any suppressed row. Enforced by construction — the write goes through
  `_lib/suppression.mjs`, which refuses to run without a readable store and drops
  matches on the way past, so there is no code path that produces a file containing one.
- Any role address. The obvious ones went at Step 1 and the rest at Step 2; neither
  kind can match, so neither reaches the file.
- Any row from a source list this skill cannot name in the manifest.

**What is in the manifest**, which is the part a human reads later: the platform, the
floor and the gate key it was read from, the source list's content hash, the ceiling
count, the count actually written, how many rows suppression removed, the hash
algorithm, and the timestamp. No identifiers of any kind. The manifest is what lets
somebody six weeks later answer *where did this audience come from and was it clean*
without opening the audience.

**Re-check the floor against the realised count before you hand the file over.** The
fill under-delivers; a run that cleared the floor on the ceiling can land beneath it on
the result. That second check is the same gate call on a different number, and failing
it is a normal outcome, not an error — report the shortfall, keep the manifest, and do
not pretend the file is uploadable.

## Step 5 — report honestly

- **Report the funnel, not the total.** Source rows, suppressed, role addresses,
  already had an email, filled, not found, written. Seven numbers, and the user can see
  where their list went. A single "audience: N" hides the entire story.
- **Never state a match rate.** You do not have one and cannot get one. The platform
  knows how many rows matched and it does not tell the pack. Anything you say about it
  is `not_verifiable`, and it is written that way.
- **Say what the platform will do next.** Matching takes time on their side and the
  audience may sit below the floor in their UI even after it cleared here. That is
  expected, not a bug in the file, and telling the user in advance stops a support
  round-trip.
- **Pass the receipt through.** Every fill call is journalled and ledgered by the
  runtime. Read the receipt it prints; do not restate an estimate as an actual (law 4).

## The boundary with /launch, and why this is not a second export path

An ads audience is a file of contacts leaving the pack, and `/launch` is the sole
writer of sender-format exports. Taking that seriously is not optional here, so
the question gets an answer rather than a shrug.

**The two artifacts are different in kind, and the test that separates them is
concrete: can the recipient of this file put a message in a named person's inbox
because they have it?**

For a sender export the answer is yes, and that is its entire purpose — it carries
addressable rows into a tool whose job is to send to them, under the user's identity.
That is the irreversible act the sender-export gate exists to hold, which is why it is bound to a PASS
verdict and to the list's content hash.

For a matched audience the answer is no. The platform ingests digests, intersects them
against its own account base, and returns a *segment*. It never reports which rows
matched. Nothing addressed to an individual can be composed from it, by the platform or
by the user. What you buy is reach against a population; what a sender export buys is
access to a mailbox. Refusing to build the first because the second is gated would not
protect anybody — it would mean the pack cannot do paid social at all on the grounds
that paid social involves a list, which is over-application, not caution.

**But the discipline the sender-export gate encodes is about a controlled exit for PII, not about the word
"sender", and that half is inherited in full rather than routed around:**

- This skill never calls the sender-export writer and never emits sender-format
  columns. The rule holds with no exemption asked for and none needed.
- The suppression pass is mandatory, fails closed, and runs through the same single
  writer `/launch` uses. There is exactly one way to produce an output list in this
  pack and this skill did not add a second.
- The file is bound to the source list's content hash in the manifest, so an audience
  cannot quietly outlive the list it was built from.
- If what the user actually wants is to send, this skill refuses and routes to
  `/launch`. **An ads audience is not a workaround for a FAIL verdict**, and when the
  request arrives in that shape — "review blocked me, can we just upload it to ads
  instead" — say so out loud rather than quietly obliging.

The one place the two deliberately diverge is the verdict. `/launch` requires a PASS
from `/campaign-review`; this skill does not, because that review grades *sendability*
— deliverability, copy, cadence, bounce risk — and none of it describes an upload that
sends nothing. Requiring it would be the over-application. What this skill requires
instead, unconditionally, is the suppression pass and the platform floor, and lawful
basis for advertising to these people is a question for `/comply`, which owns it.

### Inference mode: local

This skill runs no LLM hop, and `ai_enrich` is not in its endpoint set. Every decision
it makes is arithmetic on a list: count the rows, subtract the suppressed, subtract the
role addresses, compare against a gate key, hash a string. There is nothing here for a
language model to infer and nothing a paid inference call could add — a model asked to
judge whether an audience clears a floor would be a slower, costlier and less reliable
way of doing a subtraction. The judgement calls that *are* judgement
calls (which platform, whether to widen the list) go to the user, not to a model.

## The rules, machine-readable

The table below is the gate, not a summary of it. `tests/skills/ads-audience/` loads
this block and runs it, so a rule weakened here is a red test rather than a quiet
policy change.

```yaml audience-rules
schema_version: 1

# Law 5. Anything this table does not enumerate is a refusal.
default_decision: refuse
decisions: [build, refuse]

# Platform floors come from gates.yaml:audience_minimums. This list mirrors the
# keys that exist there; it is not a second source of truth, and the harness
# asserts the two agree. An unknown platform is a STOP, never a default floor.
platforms: [linkedin, meta, google]
unknown_platform: refuse
gate_key_prefix: audience_minimums

minimum_gate:
  # THE money rule: the floor is checked against what the audience could reach at
  # BEST, before a credit is spent. An impossible audience is refused for free.
  check_ceiling_before_spend: true
  ceiling_basis: rows_after_suppression_minus_role_addresses
  # And again on what was actually produced, because the fill under-delivers.
  recheck_realised_after_fill: true
  # Neither check may be skipped by a flag, an override or an approved plan.
  overridable: false

suppression:
  required: true
  fail_closed: true
  writer: _lib/suppression.mjs
  # No second writer. This skill does not build an output list any other way.
  alternate_writers_allowed: false

paid_fill:
  endpoint: email_finder
  requires_dry_run: true
  requires_plan_approval: true
  only_after_ceiling_clears_floor: true

classifier:
  endpoint: identify_email_type
  role_address_action: drop
  role_addresses_can_match: false

file:
  format: csv
  columns: [sha256_email]
  hash: sha256
  normalise: [trim, lowercase]
  plaintext_email_allowed: false
  manifest_suffix: .manifest.json

# Everything the audience file must NOT carry. PII leaving the pack is minimised
# by construction, not by review.
excluded_fields:
  - email
  - first_name
  - last_name
  - full_name
  - job_title
  - seniority
  - company
  - company_domain
  - phone
  - linkedin_url
  - notes

manifest_fields:
  - platform
  - floor_gate_key
  - floor_value
  - source_list_hash
  - ceiling_count
  - written_count
  - suppressed_count
  - role_address_count
  - hash_algorithm
  - created_at
manifest_carries_identifiers: false

# /launch is the sole writer of sender exports. This skill is not a second export path and does not pretend to be one.
sender_export:
  written_by_this_skill: false
  owner: launch
  # An ads audience is never offered as a way around a review verdict.
  substitute_for_failed_verdict: false

reporting:
  match_rate_claimable: false
  match_rate_null: not_verifiable
  null_enum: [not_found, not_verifiable, not_applicable]

inference_mode: local
llm_hop: none
```

## What this skill will not do

- **It will not guess a platform floor.** No floor in `gates.yaml:audience_minimums`
  means no audience for that platform, and the fix is a gate key added by the
  orchestrator, not a number invented here. A guessed floor is a wrong answer that
  costs money to discover.
- **It will not spend to reach a floor it cannot reach.** The ceiling check runs before
  the classifier, which is the first call that costs anything, and again on the bought
  classification before the fill. Every time, and no flag turns it off.
- **It will not build the source list.** It consumes one. A skill that could both
  invent a list and export it is one keystroke away from exporting a list nobody
  reviewed.
- **It will not write a sender-format export, and it is not a route around one.**
  `/launch` owns the irreversible act. If the ask is to send, the answer is `/launch`
  and a PASS verdict, not a differently-named file.
- **It will not upload anything.** The pack writes a file; you upload it in the
  platform's own UI. Ad platform APIs, campaign creation, budgets and bidding are
  deliberately external to this pack, permanently — as is sending.
- **It will not claim a match rate**, an audience size on the platform's side, or any
  other number the platform did not give it. Those are `not_verifiable` and are written
  that way.
- **It will not include a suppressed contact.** Not through a flag, not through a
  "just this once", not through a second writer. There is one writer and it fails
  closed.
- **It will not decide whether advertising to these people is lawful.** Consent for
  email and consent for ad targeting are not the same permission, and `/comply` owns
  that question.

## Related

- Where the list comes from before it gets here:
  [`/build-prospect-list`](../build-prospect-list/SKILL.md).
- Clean, normalise and dedupe the source list first — a duplicate row is a wasted fill
  and a smaller realised audience: [`/list-hygiene`](../list-hygiene/SKILL.md).
- Fill emails at depth, including the endpoints this skill deliberately does not reach:
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md).
- Lawful basis, consent records and erasure — ask before you target, not after:
  [`/comply`](../comply/SKILL.md).
- The sole writer of a sender-format export, and the PASS verdict that authorises it:
  [`/launch`](../launch/SKILL.md).
- The verdict itself: [`/campaign-review`](../campaign-review/SKILL.md).
- Structured intel from a call, including the accounts worth retargeting:
  [`/call-intel`](../call-intel/SKILL.md).
- Session start, routing and the closing receipt:
  [`/richapi-gtm`](../richapi-gtm/SKILL.md).
- Every threshold this skill cites, printed with the key it came from: `richapi gates`.
