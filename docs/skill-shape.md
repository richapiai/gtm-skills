# The SKILL.md shape contract

**Status: stable.** Every rule here is enforced by a test, so changing the document
without changing the enforcement does nothing. Propose a change in a pull request that
moves both together — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Why this exists

Three JSON Schemas (`api-catalog`, `journal-line`, `ledger-line`) were content-hash
frozen before the pack fanned out, and every disagreement about them arrived as an explicit
change request rather than a merge surprise.

`skills/` had no equivalent contract, and the drift had already started with only two
skills shipped:

```
  /enrich-waterfall            /richapi-gtm
  ──────────────────           ──────────────────
  Before anything else         First, be honest about the state of the pack
  Step 1 — always dry-run      Route
  Step 2 — get approval        Health check before you route anywhere
  Step 3 — run it              Closing a session
  Step 4 — report honestly     Related
  What this skill will not do
  Related                      ← only this heading was common to both
```

Two skills, one shared heading. Thirty-three skills authored in parallel against no
contract gives thirty-three shapes, and the dry-run → approve → run → report sequence
gets reinvented every time.

## The spine — four enforced rules

Enforced by `scripts/validate-skills.mjs`. All four are **errors**, not warnings.
Deliberately thin: each rule is something a *user* relies on being present, never a
style preference. There is no rule about heading wording, ordering, or prose voice.

### 1. `## Related` is required

Every skill routes onward. A pack of 33 skills where each one is a dead end is a pack
nobody can navigate. Link with relative paths (`../other-skill/SKILL.md`) — the
validator resolves them and fails on a broken link.

### 2. A boundary section is required

Any heading matching `will not` / `won't do` / `not in scope` / `boundar` /
`limitations`.

The pack's ceiling is the API's ceiling, and some things are outside it permanently:
sending execution, LinkedIn actions, dialing, direct mail, inbox hosting. A skill that
never states what it will not do invites the user to assume it does the thing that is
deliberately external forever. An unstated ceiling reads as a promise.

### 3. A metered call requires a visible plan

If the body invokes an endpoint that the catalog marks metered, the body must also
reference either a dry-run or a `gates.yaml` threshold.

This is law 3 — *every paid call is named and costed before it runs* — made mechanical.
The validator accepts either form of evidence; what it refuses is a skill that spends
with neither. It cannot check that your plan is *good*; it can check that you have one.

### 4. Every cited gate key must resolve

Write a threshold as `gates.yaml:skills.comply.erase_confirm_fraction`. The validator
resolves it against the real file and fails if it does not exist.

This rule is the reason a lost merge hunk cannot ship. `gateValue()` throws
`MissingGateKey` on an absent leaf and every check converts that into STOP (law 5) — so
a gate key dropped in a merge produces no conflict marker and no red test, just a skill
that silently refuses to run in production while its own tests stay green. Rule 4
turns that into a red CI run.

## Thresholds: the `skills:` namespace

Every number a skill needs lives in `_lib/gates.yaml` under `skills.<skill_name>`, with
dashes turned into underscores (`skills/list-hygiene/` → `skills.list_hygiene`).

**Keys are add-only and never renamed.** A rename is a silent STOP for any skill still
citing the old name, and a skill that cannot read its gate refuses to run. Add the key
and its sourcing comment in the same change as the skill that reads it.

Two escapes exist for a number written in prose, and only two:

| Escape | Example | When |
|---|---|---|
| Cite the gate key | ``Stops below `gates.yaml:quality_stops.coverage_min_pct`.`` | Any policy threshold the pack sets |
| Cite the statute | `CASL requires records be kept for at least 3 years.` | A legal period the pack does not set |

Nothing else. A credit number, a cache TTL or a quality percentage written bare is an
error, because hand-typed numbers rot: 16 of 53 surviving endpoints repriced in four
months and `phone_finder` went 3 → 25 credits. The statute escape is narrow on purpose —
it wants a named regime (GDPR, CCPA, CASL, …) or an explicit article/section reference on
the *same line* as the number. An escape token used reflexively stops being a signal, and
disarming law 1 is how those 16 numbers went stale the first time.

## The reference implementation

`skills/enrich-waterfall/SKILL.md` is the pattern for any skill that spends credits:

```
   Before anything else   →  preflight keys, what a missing key means
   Step 1  dry-run first  →  a plan artifact, zero calls, exact per-hop cost
   Step 2  get approval   →  the user approves the PLAN, not just a number
   Step 3  run it         →  journal before and after each call; resumable
   Step 4  report honestly→  a range stays a range; coverage before wins
   What this skill will not do
   Related
```

`skills/richapi-gtm/SKILL.md` is the pattern for a skill that spends nothing: route,
report health, close the session, state the boundary.

Copy the spine, not the prose. Two skills that make paid calls should feel like the same
tool; two skills that do different jobs should not read like the same paragraph.

## What is NOT enforced, on purpose

- Heading wording and order. `## Step 1 — dry-run first` and `## Plan the run` both pass.
- Prose length or voice.
- Section count.
- Whether a skill has tests. That is the definition of done in `CLAUDE.md`, checked by
  review, not by a linter — a linter that counted test files would be satisfied by an
  empty one.
