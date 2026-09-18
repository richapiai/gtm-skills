# Contributing

This pack spends real money on someone else's behalf. A skill that quietly runs one
extra call is not a style problem, it is a bill. Most of what follows is about that.

Read [`README.md`](README.md) first for what the pack is, and
[`docs/skill-shape.md`](docs/skill-shape.md) for the SKILL.md contract in full.

## The seven laws

These are kept as law. A change
that contradicts one of them is not a small change; say so in the PR and expect the
discussion to be about the law, not the diff.

1. **The catalog is the source of truth for cost and routing.** No credit number is
   ever typed by hand into a skill or a doc. Anything hand-typed is stale within a
   quarter — measured: 16 of 53 surviving endpoints repriced in 4 months,
   `phone_finder` 3 → 25 credits (8.3x).
2. **The spec is a cost-and-route source, NOT a schema source.** 39 of 68 response
   examples are ≥40% the literal string `"example"`; both bulk enrich endpoints have
   no example at all. Field maps come from recorded live fixtures, not from the spec.
3. **Every paid call is named and costed before it runs.** No opt-out paid calls,
   ever — including at setup.
4. **Never fabricate an actual.** No endpoint reports its charge: across all 65
   recorded 2xx bodies, none carries a credits/charge/cost field. Every credit figure
   is an estimate and every ledger line is written `estimated_unverifiable`.
5. **Fail closed.** A missing `gates.yaml` key reads as STOP, not as "no gate". A
   suppressed contact never reaches an output list.
6. **Evidence over vibes.** No speculating; claims carry a source line.
7. **`gtm/` is PII.** Gitignored, TTL-swept, erasable. `setup` refuses to run where
   `gtm/` is already git-tracked.

Law 6 has teeth in the test suite. `tests/contracts/no-stale-self-claims.test.mjs`
fails when a skill's prose says another skill is unbuilt and that skill exists — the
router once shipped saying "one skill is implemented" while thirty-two others sat
beside it.

## Setting up

```console
$ git clone <repo> richapi-gtm-skills
$ cd richapi-gtm-skills
$ npm ci
$ ./setup                  # creates gtm/, the suppression store, the gitignore entry
```

`./setup` makes **zero** API calls (law 3) and needs no key. It refuses to run in a
repo where `gtm/` is already git-tracked (law 7) — that refusal is not a bug, it means
PII is in your history and untracking it comes first.

Without `./setup` there is no suppression store, and every command that could touch a
contact exits 5 with `suppression store unreadable — failing closed`. That is law 5
working, not a broken install.

Node ≥ 18.20.8. That is the exact lowest version the suite has been run green on, not
an aspiration, and it is the first row of the CI matrix.

## Running the checks

Three commands, in increasing order of cost:

```console
$ npm test                 # the whole node:test suite
$ npm run check            # catalog diff + skill validation + tests
$ bash scripts/ci-local.sh # every step of .github/workflows/validate.yml, in order
```

`scripts/ci-local.sh` is the one that matters before you open a PR. It runs the
workflow's steps in the workflow's order and stops at the first failure exactly as CI
would. It is deliberately offline-safe: `npm ci --offline`, and the catalog drift gate
prints `SKIPPED` and exits 0 with no route rather than wedging. Run it with a network
and the drift gate does the real comparison against `api.richapi.ai`.

Two things it cannot reproduce, and says so rather than pretending:

- the Node version matrix (18.20.8, 20.19.0, 22.0.0, 24.5.0). Your machine has one
  runtime; the script names it and states that the other rows are unverified. Those
  rows are pinned to exact patch versions on purpose — a floating `"20"` row resolves
  to the newest 20.x, which is precisely how a bug that made every executable
  unloadable on Node 18 and 20.0–20.9 survived green CI.
- `actions/checkout`. CI tests a clean checkout; this tests your working tree.

`npm test` and the CI test step must stay byte-identical invocations; a test asserts
it, because CI proving something no contributor can reproduce locally is worse than no
CI.

## Adding or changing a skill

A skill is a directory under `skills/<name>/` containing `SKILL.md`. Frontmatter
requires `name` (matching the directory), `version` (semver), `description`,
`allowed-tools`, and `triggers`. `node scripts/validate-skills.mjs` enforces all of it
and must stay at 33 skills, 0 warnings — plus whatever you add.

Four body rules are **errors**, not warnings. They are deliberately thin: each one is
something a *user* relies on being present, never a style preference. There is no rule
about heading wording, ordering, or prose voice.

1. **`## Related` is required.** Every skill routes onward; link with relative paths
   (`../other-skill/SKILL.md`), which the validator resolves and fails on if broken. A
   pack of 33 skills where each one is a dead end is a pack nobody can navigate.
2. **A boundary section is required** — any heading matching `will not` / `won't do` /
   `not in scope` / `boundar` / `limitations`. Some things are outside the API's
   ceiling permanently: sending execution, LinkedIn actions, dialing, direct mail,
   inbox hosting. An unstated ceiling reads as a promise.
3. **A metered call requires a visible plan.** If the body invokes an endpoint the
   catalog marks metered, the body must also reference a dry-run or a `gates.yaml`
   threshold. This is law 3 made mechanical. The validator cannot check that your plan
   is *good*; it checks that you have one.
4. **Every cited gate key must resolve.** Write a threshold as
   `gates.yaml:skills.comply.erase_confirm_fraction` and the validator resolves it
   against the real file. Without this rule, a gate key lost in a merge produces no
   conflict marker and no red test — just a skill that silently refuses to run in
   production while its own tests stay green.

Numbers in prose: every threshold lives in `_lib/gates.yaml` under `skills.<skill_name>`
(dashes become underscores). Exactly two escapes exist for a bare number — cite the
gate key, or cite the statute on the same line (`CASL requires records be kept for at
least 3 years.`). Nothing else. A credit number, cache TTL, or quality percentage
written bare is a validation error.

Copy the spine, not the prose. `skills/enrich-waterfall/SKILL.md` is the reference for
anything that spends; `skills/richapi-gtm/SKILL.md` for anything that does not.

## Changing a frozen contract

Three JSON Schemas in `_lib/contracts/` — `api-catalog`, `journal-line`, `ledger-line`
— are frozen. `tests/contracts/frozen.test.mjs` recomputes each sha256 against
`tests/contracts/frozen-contracts.sha256` and fails if one moved.

The failure this prevents is quiet: someone widens an enum or drops a `required` to
make their own code pass, everything stays green in that branch, and the mismatch
surfaces at merge or at runtime in whichever consumer assumed the other shape. It has
already caught two independent computations of "the 11 unbounded endpoints" that
produced *different sets* — a disagreement that would otherwise have arrived as a
billing surprise.

Amending one is a deliberate, announced act:

1. Propose the change. These are shared contracts; more than one consumer reads them.
2. Edit `_lib/contracts/<name>.schema.json`.
3. Recompute and update the hash **in the same commit**, with the reason in the
   message and an `AMENDED <date>` note in the pin file's header — the existing notes
   are the model. `shasum -a 256 _lib/contracts/*.schema.json`.
4. Re-run `npm test`.

Adding or removing a contract is itself a cross-cutting act: a second test asserts the
pin file lists exactly the frozen contracts, no more and no fewer.

## Pull requests

- One concern per PR. A skill change and a runtime change are two PRs.
- Every change carries a test. A task without a passing test is not done — that is the
  repo's definition of done, and it is checked by review rather than by a linter,
  because a linter that counted test files would be satisfied by an empty one.
- Say what you verified and how. "Ran `bash scripts/ci-local.sh` on Node 22.0.0,
  2205/2205" is a report; "should be fine" is not (law 6).
- Do not hand-type a credit number, a price, or a threshold anywhere (law 1).
- If your change makes a paid call possible where none was possible before, say so in
  the PR title.
- Never commit anything from `gtm/`. It is gitignored for a reason (law 7); if you
  find a path that writes PII outside `gtm/`, that is a security report — see
  [`SECURITY.md`](SECURITY.md).

## Reporting endpoint drift

The API surface moves: 16 of 53 surviving endpoints repriced in four months. If you
see a price, a rename, or a removal that the pinned catalog does not know about, open
an **Endpoint drift** issue rather than editing `_lib/api-catalog.json` by hand — the
catalog is generated, and a hand edit is reverted by the next `catalog:gen`.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
