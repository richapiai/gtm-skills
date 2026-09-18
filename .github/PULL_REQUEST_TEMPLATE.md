## What this changes

<!-- One concern per PR. A skill change and a runtime change are two PRs. -->

## Why

<!-- What was wrong, or what could not be done before. -->

## How it was verified

<!--
  Law 6: evidence over vibes. Paste the numbers, not an adjective.
  "Ran `bash scripts/ci-local.sh` on Node 22.0.0 — 2205/2205, validate 33/0" is a
  report. "Should be fine" is not.
-->

```console
$ bash scripts/ci-local.sh
```

## Checklist

- [ ] `npm run check` passes (catalog diff + validate + tests).
- [ ] `bash scripts/ci-local.sh` passes, and I named the Node version I ran it on.
- [ ] `node scripts/validate-skills.mjs` is still clean — every skill, zero warnings.
- [ ] Every change carries a test. A task without a passing test is not done.
- [ ] No credit number, price, cache TTL, or quality threshold is typed by hand
      anywhere (law 1). Thresholds cite a `gates.yaml` key; a legal period cites the
      statute on the same line.
- [ ] Nothing from `gtm/` is in the diff (law 7).

## Does this make a paid call possible where none was before?

- [ ] No.
- [ ] Yes — and the PR title says so. Describe the dry-run plan and the gate that
      bounds it below (law 3: every paid call is named and costed before it runs).

## Frozen contracts

- [ ] This PR does not touch `_lib/contracts/*.schema.json`.
- [ ] It does — and `tests/contracts/frozen-contracts.sha256` is updated **in this same
      commit**, with an `AMENDED <date>` note saying which consumer asked for the change
      and why. See CONTRIBUTING.md, *Changing a frozen contract*.

## Anything a reviewer should look at first

<!-- The part you are least sure about. Name it; it saves a round trip. -->
