# Roadmap

What is built, what is next, and what this pack will deliberately never do. Written for
someone deciding whether to adopt it or contribute to it.

The honest caveats behind everything below live in [`LIMITATIONS.md`](LIMITATIONS.md).
Read that one before you point this at money; read this one before you plan around it.

Status: `2.0.0-alpha.0`, unpublished, clone-only.

---

## Built

All of it is on disk, validated and covered by the suite. `npm run check` runs the
catalog drift oracle, the skill validator and the tests together.

**The 33 skills.** The full loop — ICP, TAM, list building, enrichment, verification,
research, copy, compliance, review, export, measurement, and the always-on plays
(triggers, reply triage, call intel, scheduled workflows). The README lists every one
with a link. 11 of them never make a paid call, with or without a key.

**The runtime under them.** One code path, so every skill gets the same behaviour:

- a dry run that prices the whole plan before anything is called, and makes zero calls;
- gates — every threshold in one file, [`_lib/gates.yaml`](_lib/gates.yaml), read
  strictly, with a missing key failing closed rather than defaulting;
- a per-run journal and a per-call credit ledger, with cost status recorded honestly
  (`actual` where the response reports the charge, `estimated_unverifiable` where it
  does not);
- a read-through enrichment cache with a TTL, and resumable runs with a per-list lock;
- suppression enforced before spend, not after, and PII stamped with the endpoint it
  came from;
- scriptable exit codes — a *declined* plan exits 7, not 0, so a script can tell a
  refusal from a success.

**The catalog contract.** [`spec/openapi.yaml`](spec/openapi.yaml) is pinned and
checksummed. `richapi catalog diff` classifies every change by severity, and the drift
oracle fails the build when the pinned spec and the live catalog disagree on names,
paths or pricing. 68 endpoints, generated — never hand-listed.

**The community and packaging surface.** [`CONTRIBUTING.md`](CONTRIBUTING.md),
[`SECURITY.md`](SECURITY.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md),
[`CHANGELOG.md`](CHANGELOG.md), issue and PR templates, a publish-time guard that stops a
placeholder repository URL reaching a registry, and contract tests over the package
metadata itself.

---

## Next

In order. The first item gates most of the rest.

### 1. ~~Live fixture capture~~ — DONE 2026-08-31, absorbed 2026-09-02

It was the highest-value item, and it paid for itself immediately: the run recorded 55
responses and showed the spec-derived response maps were **dropping the email, the phone
number and the verification verdict on every paid call**. The default waterfall returned
an email in zero cases. [`LIMITATIONS.md` §1](LIMITATIONS.md) has the table.

A second run on 2026-09-17 re-recorded the surface against the re-pinned spec. 63 of
68 endpoints now read `field_map_status: live_fixture`. The maps were rewritten from the
recordings, the build replays every recording on every run, and a partial read is now its
own loud status.

**What is left of this item:** 5 endpoints still read `keys_from_spec_example`.
`geo_id_search` needs an input that hits and `google_maps_reviews_scraper_sync` one that
returns reviews; `slack_channel_members` needs a capture input at all; and
`google_ad_transparency_scraper_sync` and `linkedin_ad_search` answered `403` for the
capturing team, so they need a team with access, not more credits.

### 2. Turn on the weekly contract canary

[`bin/richapi-canary.mjs`](bin/richapi-canary.mjs) is written, tested and **ships
disabled**, as does `.github/workflows/canary.yml`. Once a week, against real
credentials, on the cheapest endpoints the catalog knows about, it asserts two things:
that the live response's top-level key set still matches the catalog's `field_map_keys`,
and that what the call was billed still matches what the pinned pricing said it would.
A blocking finding opens an issue. It is the only place in the pack that would ever look
at the live API on a schedule.

It computes the run's cost from the catalog *before* calling anything and refuses a
selection that reaches its weekly ceiling. Against the pinned catalog on 2026-08-31 the
default selection of 8 endpoints costs 1.41 credits per run.

**Why it is off, and exactly what turns it on:** its first assertion compares against
`field_map_keys`. That used to be spec-derived on 65 endpoints, so asserting against it
would have flagged near-everything as drift on the very first live run — and a weekly
gate that is red in week one is switched off in week two.

Item 1 has now landed, so **this is unblocked for any endpoint reading
`field_map_status: live_fixture`** (63 of 68, including every waterfall hop). Turning it
on means restricting the default selection to those, which is a small change to the
selection logic rather than new machinery. It stays off until someone makes that change
and watches one run.

### 3. Flip auto-batching on

The capture answered the question this was blocked on: `enrich_profiles_bulk` does not
answer in request order, and every result carries a URN. The runtime now joins bulk
results to rows by that identity (`alignBulkRows`). `runtime.batch.auto` stays `false`
until one real batched run through the runtime has been checked end to end. See
[`LIMITATIONS.md` §3](LIMITATIONS.md).

### 4. ~~Scope the `allowed-tools` grants~~ — DONE 2026-09-02

Landed ahead of the public launch, because a one-command install puts the pack in front
of people who will not read `SECURITY.md` first. Every grant is now derived from the
commands that skill's own fences invoke; a bare `Bash` fails the build. What is left is
`Bash(node:*)` on six skills, where `node -e` is arbitrary execution and the grant is a
formality. [`SECURITY.md`](SECURITY.md#the-narrowed-grant-and-the-hole-it-does-not-close)
has the table and the reasoning.

### 5. Run CI on a real runner, then publish

No workflow in `.github/` has finished green on GitHub yet; the matrix has been run by
hand on all four pinned Node versions instead. Next: one green manual run of
`validate.yml`, then a first npm publish.

---

## Deferred until something triggers them

Buildable today, deliberately not built yet. Each waits on a signal rather than a date,
because building them before the signal is guessing at demand.

- **`/comply` jurisdiction expansion** — PECR, further US state laws, LGPD. The rule
  engine already takes additional rule sets; only the rules and their evals are missing.
  *Trigger:* the first UK or Brazil list, or the first user who asks.
- **More sender export formats** — Apollo and Outreach, with golden files. The export
  writer is format-agnostic; each new format is a mapping plus a fixture.
  *Trigger:* a meaningful share of users on a sender that is not already covered.

- **Record the post-engagers response.** `post_details` and `post_activities` still map
  from the spec's example, so `/build-prospect-list` Path C says its title filter may be
  reading a headline. *Trigger:* the next capture run with a key; then map the fields
  and drop the caveat.
- **New API endpoints into the skills** — domain-only company enrichment, headcount
  trends, company news, deeper funding, catch-all domain checks and video captions each
  have a named consumer (`/enrich-waterfall`, `/signal-watch`, `/account-research`,
  `/list-hygiene`, `/research-agent`, `/competitive-intel`). *Trigger:*
  `richapi catalog diff` shows the endpoint, and a live recording of it exists.
- **Plays that start from an input, and plays that end in a file.** `/play-design` plays
  start only from `/signal-watch` and end only at `/launch`; recipes cover the other
  shapes today. *Trigger:* a runner that executes a saved play from `gtm/plays/`.

## Out of scope

Not a backlog. This is the stated boundary, and stating it is the point: the pack's
ceiling is the API's ceiling.

### Deliberately external, permanently

These will not be built here, whatever the API grows.

| | Why |
|---|---|
| **Sending execution** | Owning sending means owning spam complaints, deliverability, and someone else's domain reputation. The pack takes you up to the send button and stops. |
| **LinkedIn actions** | Automating connections, messages or profile actions is a terms-of-service risk borne by the user's account, not by this repository. |
| **Dialer / live calling** | A different product with different compliance (recording consent, call-time rules) and different failure modes. `/call-intel` reads a transcript you already have. |
| **Direct mail and gifting** | Physical fulfilment, vendor contracts, address quality — nothing an agent pack is the right shape for. |
| **Inbox hosting** | Mailbox provisioning, warmup and IP reputation are an infrastructure business. |

The pack exports. Something else sends.

### Blocked on the API growing

The designs exist; the endpoints do not. If these ship server-side, they become
buildable; until then, nothing here pretends otherwise.

- **Visitor de-anonymization** — no IP-to-company endpoint exists.
- **Real-time event triggers** — no webhooks; `/signal-watch` polls.
- **Third-party intent data** — no intent source in the catalog.
- **Bulk email find and verify** — `email_finder` and `email_verifier` are single-row
  only; there is no async or bulk variant anywhere in the surface.
- **Phone verification** — `phone_finder` exists; nothing verifies what it returns.
- **True two-way CRM sync.** There is no CRM-write endpoint in the catalog.
  [`/crm-sync-expert`](skills/crm-sync-expert/SKILL.md) designs the sync and
  [`/crm-export`](skills/crm-export/SKILL.md) writes a file you import. **Nothing in this
  pack writes into your CRM.**
- **Product-usage signals** — no endpoint returns them.

### Bounded by the same ceiling

Two limits worth naming here because they read as missing features rather than as
missing endpoints: **no run is reconciled against the provider's usage record** — the
spec now documents `GET /usage`, but the pack only probes it for `BALANCE` and never
compares a ledger against it; and **11 of the 21 metered
endpoints never report their charge**, so those ledger lines are honest ceilings rather
than receipts, permanently. Both are in [`LIMITATIONS.md`](LIMITATIONS.md) §4–5.

---

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup, the checks, and the seven laws every
change is held to. The shortest useful contributions right now:

- **Endpoint drift.** If the live API disagrees with the pinned spec, that is a report
  worth filing — see [Reporting endpoint drift](CONTRIBUTING.md#reporting-endpoint-drift).
- **A skill that is wrong about the world.** Every `SKILL.md` claim about pricing, gates
  or endpoints is derived and tested, so a wrong one is a test that should exist.
- **The live capture in item 1**, if you have a key and are willing to spend a few
  credits. It unblocks items 2 and 3 at once.
