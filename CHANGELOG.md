# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) applies from `2.0.0` final;
until then see *What `2.0.0-alpha.0` promises* in [`SECURITY.md`](SECURITY.md) for what
may break between alphas.

> **Nothing has been published yet.** `npm view @richapi/gtm-skills` returns 404. The
> version in `package.json` and `VERSION` is `2.0.0-alpha.0`, and it has never left
> this repository. Every entry below is therefore a change to unreleased software, and
> the release dates are the dates the work landed on `main`, not registry dates.
>
> Compare links are omitted until the first tagged release of
> `richapiai/gtm-skills`; there is nothing to compare against before it.

## Unreleased — 2026-09-18 (public-release pass)

### Removed

- **Third-party company and personal data out of the pinned spec.** The response
  examples carried a real company's LinkedIn posts, logo CDN paths, numeric company id
  and post URLs, plus a named individual with their profile URL and opaque member URN.
  All replaced with neutral example values; keys, shapes and every derived
  `field_map_key` unchanged, verified by regenerating the catalog (63 endpoints still
  `live_fixture`). The four hand-written spec fixtures got the same treatment, since
  they must stay byte-identical slices of the spec.

### Fixed

- **An unknown CLI flag is now a refusal, not a silent no-op.** This was a money bug:
  `richapi enrich list.csv --dryrun --yes --budget 50` is one hyphen from `--dry-run`,
  and with a valid key it ran for real while the user believed they were pricing. The
  budget capped the damage; it never prevented it. Unknown flags exit 2, suggest a
  near-miss (`--dryrun` -> `--dry-run`) and never invent one. `KNOWN_FLAGS` is checked
  against the flags the source actually reads, so it cannot rot into a denylist.
- **A refused API origin reached the terminal as an uncaught exception.** The control
  worked (the key was never sent) but the message arrived under a `throw` line, a caret,
  six stack frames and the Node crash footer, which reads as a crash in the pack rather
  than the pack protecting the key. Those frames also carried the user's home directory
  into anything pasted into an issue. `_lib/client.mjs` still does not catch it; the CLI
  boundary now renders it as a refusal and exits 2.
- **`scripts/` no longer ships to every npm consumer.** Four maintainer-only files
  (`ci-local.sh`, `test-each-file.sh`, `validate-skills.mjs`, `gen-llms-txt.mjs`) that
  nothing in `bin/`, `_lib/` or `skills/` reads at runtime. They stay in the repository
  for contributors. `docs/claims.yaml` and `docs/demo-script.md` were unshipped too and
  then restored: the README links to both, and a dead link on the package page costs
  more than the 10KB — caught by the existing README-link guard, not by inspection.
- **`richapi doctor` hand-typed "11 of the 33 skills"** in shipped code and kept saying
  it after the 34th landed. Derived now, degrading to a claim-free sentence rather than
  a guessed number.
- **The README's "The other 22 can reach a metered endpoint" was unguarded** and stale
  at 23. Both halves of the spend split are pinned now.
- **Em-dash clusters in the README**, 120 down to 104 with prose clusters at zero. The
  slop scan found nothing else: no banned vocabulary, no binary contrasts, no puffery.
- Two assertions that hardcoded counts in files which derive everything else.

### Changed

- **Prose pass across the 34 skills.** Em-dash clusters in every frontmatter
  `description` (44 dashes down to 14) and in single-line body prose (61 cluster lines
  down to 12), plus three pieces of banned vocabulary. `game changer` in
  `/personalize` was left alone on purpose: it sits in the list of phrases the skill
  REFUSES to write, so removing it would let the pack emit it.
- **The README skill table is pinned to the frontmatter.** The README says the table is
  "generated from each SKILL.md's frontmatter description"; it is copied by hand, and
  nothing checked the copy. `tests/contracts/readme-skill-descriptions.test.mjs` now
  requires each README line to be a word-for-word truncation of the description it
  quotes, and pins the `free` markers to the derived spend split. It caught six commas a
  mechanical em-dash fix had inserted that the frontmatter does not contain, plus four
  lines that had drifted before this session.
- **A folded-scalar assertion no longer depends on line wrapping.**
  `tests/skills/outreach-expert/skill-shape.test.mjs` matched `never sends` against the
  raw frontmatter block. `description:` is a folded YAML scalar, so a line break inside
  it carries no meaning, and any re-wrap that split the phrase failed a test whose claim
  was still true. It normalises whitespace first now.
- **NOT changed: em-dash clusters that span a line break.** Fixing those means
  re-flowing paragraphs, which broke three of `tests/skills/live-run-corrections.test.mjs`
  and `post-engagers.test.mjs` — the tests that encode what live API runs proved the
  skills had wrong. The content survived the reflow; only the line breaks moved. Making
  those assertions wrap-insensitive is defensible on its own merits, but loosening
  evidence tests to land a cosmetic change is the wrong trade, so the reflow was
  reverted. 63 cross-line clusters remain, by decision.

### Added

- **`_lib/tty.mjs`.** Wordmark, coloured status chips, boxes and a stderr progress line,
  hand-rolled in ~40 lines of ANSI rather than adding a dependency: `SECURITY.md` states
  the single runtime dependency as a fact a reader can verify by grep, and a colour
  library would spend that claim. Styling is suppressed on a pipe, under `NO_COLOR`,
  `TERM=dumb`, `--json`, `--quiet`, `--no-color`, and always for `doctor --report`,
  which gets pasted into issues. Stripping the escapes yields byte-identical text to the
  plain render, so styling can never change content.
- **An agent-runnable install prompt in the README**, with the real exit codes (127 Node
  missing, 1 Node too old, 3 doctor blocking) and an explicit instruction never to spend
  without showing a dry-run total first. Every step was executed end to end.

## Unreleased — 2026-09-18

### Added

- **`/gtm-onboard`, and the two artifacts the pack was missing.** `gtm/profile.yaml`
  holds the seller — company, website, what you sell, the wedge, citable proof, tone,
  sender, routing, `never_claim`. `gtm/preferences.jsonl` holds standing dos and don'ts,
  append-only. The gap was structural: the pack was built API-first, so every artifact
  it persists is the output of a paid call, and no endpoint returns "who is this user".
  `/personalize` refuses claims it cannot source and had no source on disk for the one
  claim every email makes. `/personalize`, `/sequence-builder`, `/outreach-expert`,
  `/inbound` and `/reply-triage` now read them, pinned by
  `tests/contracts/profile-readers.test.mjs`.
- **Website pre-fill, opt-in and priced.** `/gtm-onboard` can propose profile values
  from the user's own site. It is the only step there that can spend, it is dry-run
  priced first, and declining loses nothing the interview did not capture — onboarding
  gets no exemption from law 3.
- **`llms.txt` and `AGENTS.md`.** Generated by `scripts/gen-llms-txt.mjs` from derived
  facts; `tests/contracts/llms-txt.test.mjs` fails when it goes stale. The free/paid
  split imports `_lib/spend-split.mjs`, extracted from
  `no-stale-catalog-claims.test.mjs` so one predicate has one implementation.
- **`docs/destination-handoff.md`.** What happens at the export seam: look for an
  installed MCP server, then the destination's API docs or Postman collection, then ask.
  Wired into `/crm-export`, `/crm-sync-expert`, `/sequence-builder` and
  `/outreach-expert`. Adds no tool grants; the pack still writes to no CRM and sends
  nothing.
- **`tests/cli/setup-cli.test.mjs`.** `./setup` is the first command a stranger runs and
  was the least tested surface in the pack — three defects shipped in it, all found by a
  human rather than the suite.
- **`tests/contracts/no-real-pii.test.mjs`.** `no-internal-leak` excludes `spec/` and
  `tests/fixtures/live/`; those are the only two trees sourced from outside this
  repository, so the only two that can carry someone else's contact details.

### Fixed

- **`setup --root` was broken three ways.** `--root=DIR` was rejected as an unknown
  argument although `bin/richapi.mjs` has always accepted the `=` form; `--root` with no
  value printed a raw Node stack trace; and `--root DIR` where DIR did not exist died on
  `ENOENT` writing `.gitignore` before anything created the root. `--check` passed
  throughout, because check mode never writes.
- **Node prerequisites are enforced, not just declared.** `engines.node` is advisory and
  the documented install path is `git clone` + `./setup`, where npm never runs. Missing
  Node now exits 127 with install instructions; too-old Node exits 1 naming the floor,
  which is read from `package.json` so the two cannot drift.
- **A private individual's email address was in the pinned spec** and three hand-written
  spec fixtures, from an upstream live response. Redacted to a reserved domain, spec
  re-pinned, `spec_sha256` restamped across the generated artefacts. Live-capture
  absorption verified intact afterwards — 63 endpoints still `live_fixture`.
- **`SECURITY.md` and `CODE_OF_CONDUCT.md` shipped placeholder contact addresses.** Both
  now route to `support@richapi.ai`.
- **`setup` created a workspace and said nothing about what to do with it.** A first run
  now names `/gtm-onboard` and prices it at zero; the prompt stops once a profile exists.
- **Two assertions hardcoded counts in files that derive everything else.**
  `list-hygiene`'s sandbox matched `/3 skill\(s\)/`, which only ever matched "33" by
  substring, and `no-stale-catalog-claims` typed the skill total into a README check.
- `CHANGELOG.md` cited `tests/contracts/no-competitor-names.test.mjs`, which does not
  exist; the guard is `no-outside-references.test.mjs`.

## Unreleased — 2026-09-17

### Added

- **Recipes.** Named chains of existing skills for common GTM jobs, as `yaml recipe`
  blocks in the skills that run them, routed from `/richapi-gtm` and listed in the
  README. `tests/skills/recipes.test.mjs` checks every step is a skill, every send keeps
  the gate order, and every CRM-file recipe says it is not cleared for contact.
- **Post engagers as a list source.** `/build-prospect-list` Path C takes a pasted
  LinkedIn post URL; `_lib/linkedin-urn.mjs` turns it into the URN the post endpoints
  require and refuses anything that is not one post, before a call.

### Fixed

- **Flat-priced paged endpoints were not page-gated.** `post_activities` and
  `search_bing` charge per page; the catalog generator only gated per-result pricing.
- **Zero-based searches bought their second page without asking.** The page gate read
  page 0 as page 1, so `people_search --start-page 0` walked two pages before the first
  confirm. Pages are now gated by their position in the run as well.

### Changed

- **Spec re-pinned; `post_keyword_search` is enabled.** The spec now bills it 0.1
  credits per result on `numberOfElements` (the page), not 6 per result on
  `totalElements`, so it is page-gated like the other searches and no longer disabled in
  the catalog or in `gates.yaml`. No skill uses it yet. The spec also documents
  `GET /usage` and `GET /my-endpoints`; the POST-only catalog skips both.
- **Second capture run.** 63 of 68 endpoints are `live_fixture`, 5 are
  `keys_from_spec_example`, none are `TODO_no_usable_example`. Any `2xx` with a JSON body
  now counts as a recording.
- **Bulk results are joined to rows by identity.** `enrich_profiles_bulk` was recorded
  answering out of request order. `runtime.batch.auto` stays `false`.
- **No third-party vendor names in the pack.** The research-agent prompt corpus is
  `research-question-corpus.json`, with classification fields only; its counts are
  unchanged. `tests/contracts/no-outside-references.test.mjs` guards it.

## Unreleased — 2026-09-02

### Fixed — the pack was not delivering the data users paid for

The 2026-08-31 capture run recorded 55 live responses. Replaying them through
`RESPONSE_MAPS` showed every map had been derived from the spec's 200 examples, and the
spec was wrong about where the payload lives:

| endpoint | price | columns delivered | what was lost |
|---|---|---|---|
| `email_finder` | 5cr | 1 of 3 | **the email address** |
| `email_verifier` | 2cr | 0 of 5 | everything |
| `phone_finder` | **25cr** | 0 of 2 | **the phone number** |
| `enrich_profile` | 1cr | 4 of 11 | title, company, url, location |
| `enrich_company` | — | 4 of 10 | industry, size, HQ, founded |
| `identify_email_type` | — | 1 of 2 | the classification |

The default waterfall — profile → email → verify, ~8 credits a contact — returned the
email in **zero** cases. Three causes, all now fixed:

- **Envelope.** The finder endpoints wrap their payload in `result`; the reader unwrapped
  only `data`. Map keys are now dotted paths from the body root, so a path names exactly
  one location and there is no implicit unwrapping to get wrong.
- **Key names.** `enrich_profile` answers `picture`/`url`/`positionGroups`, not
  `profilePicture`/`linkedinUrl`/`currentTitle`; `enrich_company` answers
  `followers`/`staff`/`foundedYear`/`industries`. Every path is now one a recording
  actually contained. The same waterfall delivers **69 columns where it delivered 10**.
- **The detector could not see it.** `inspectResponse` flagged a mapping failure on
  *zero* columns, and `email_finder` produced one by coincidence. New `MAP_PARTIAL`
  status: a response that carries data but not the column the call was bought for is a
  loud, billable failure.

`find_personal_email` is mapped for the first time — the recording settled the shape
dispute between the spec and the backend manifest, in the spec's favour.

### Added

- `richapi doctor` — the preflight in English, with the fix for each finding. Zero calls,
  zero credits. `--report` renders a paste-able block carrying no list data, no paths and
  no key.
- `richapi enrich <list> --explain-my-list` — free, zero-call list triage: how many rows
  are worth paying for, which hops can reach them, and which inputs are missing. A
  truncated read never renders as a total.
- `richapi --version`.
- `richapi catalog gen --absorb-live` — distils the recorded captures into the shipped
  `_lib/live-field-maps.json`, which generation reads. Provenance-gated: a capture pinned
  to a different spec is rejected with a reason.
- `.claude-plugin/marketplace.json` and `docs/INSTALL.md` — the install path for
  the skills half, which `docs/GETTING-STARTED.md` had linked to for weeks without it
  existing.

### Security

- **Every `allowed-tools` grant is now scoped.** No skill declares a bare `Bash`. Each
  one's shell grants are derived from the commands its own runnable fences invoke, and
  the build fails on a bare `Bash` or on a grant outside the pack's surface. Partial
  mitigation, stated as such: six skills hold `Bash(node:*)` and `node -e` is arbitrary
  execution. None of the five skills that ingest attacker-authored text is among them.
- The cached credit balance is **scoped to the API key** rather than machine-global. One
  file meant a run in one client's checkout reported the balance last seen in another's,
  which crossed the per-book-of-business boundary `LIMITATIONS.md` §6 promises.

### Fixed — the first screen a new user reads

- `BALANCE: 0` with no API key set. Now `unknown`, which is what the README promises.
- `CATALOG_STALE: yes` on every fresh install, because the catalog had never been synced.
  A never-synced install is fresh, not stale.
- A missing `jq` reported a healthy install as broken (`CATALOG_OK: no` with 68 endpoints
  present) and sent every skill to a fix that could not work. New `JQ_MISSING` key; the
  checks it gates report `unknown` rather than `no`. A check that could not run is not a
  failing check.
- `--max-rows` and any future value-taking flag missing from `NEEDS_VALUE` silently
  became `true` rather than erroring.

### Docs

- `README.md` leads on the runtime rather than the skill count, and states the pricing
  and signup entry point instead of a placeholder.
- `LIMITATIONS.md` §1 and §2 rewritten: they still said the pack had never made a real
  authenticated call, which stopped being true on 2026-08-31.
- The README's test-count sentence claimed a guard stricter than the one that exists. It
  now says plainly that the guard checks a band, that **nothing guards the "0 failing"
  half**, and that you should run `npm test` yourself.


## [Unreleased]

Packaging and project hygiene. No runtime or skill behaviour changed.

### Added

- `publishConfig.access: public`. `@richapi/gtm-skills` is a scoped package, and npm
  defaults a scoped package to `restricted` — the first publish would have either
  failed with a 402 or shipped a package nobody outside the org could install.
- `repository`, `bugs` and `homepage`. npm resolves relative README links against
  `repository`, so without it every one of the README's links to `skills/*/SKILL.md`,
  `_lib/gates.yaml` and `docs/` was dead on the package page. **All three currently
  carry the placeholder `PLACEHOLDER-SET-BEFORE-PUBLISH`**, because there is no git
  remote and the repository name is not decided.
- `guard:placeholders` script and `prepublishOnly`, which runs the guard and then
  `npm run check`. The guard (`tests/contracts/no-placeholder-metadata.mjs`) exits
  non-zero if the placeholder is still in `package.json`, so it cannot reach the
  registry by accident. `tests/contracts/package-metadata.test.mjs` asserts the wiring
  and proves the guard is not vacuous.
- `richapi-setup` in the `bin` map, pointing at `setup.mjs`. `files:` shipped `setup`
  and `setup.mjs` but nothing put either on `PATH`, so an npm install had no way to run
  setup — and without a suppression store `richapi enrich <list> --dry-run`, the
  README's headline free command, exits 5 with `suppression store unreadable — failing
  closed`. It maps to `setup.mjs`, not the extensionless `setup` wrapper, because this
  is a `"type": "module"` package and Node cannot load an extensionless file as ESM
  before 20.10. `./setup` still works and is unchanged.
- `docs/skill-shape.md` and `docs/demo-script.md` to `files:`. The README links to
  both and neither was in the tarball, so every npm consumer got dead links. A test
  now fails if the README links to a path `files:` does not ship.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and
  this file, all shipped in the tarball. `CONTRIBUTING.md` carries the house rules that
  previously existed only in `CLAUDE.md`: the seven laws, the four SKILL.md shape rules,
  `scripts/ci-local.sh`, and the frozen-contract amendment procedure.
- Issue templates (bug, feature, endpoint drift), a pull request template, and
  Dependabot config for npm and GitHub Actions.

### Removed

- `bin/richapi-capture-fixtures.mjs` from the published tarball (`files:` now negates
  it). It spends real credits against the live API with `--run`, was in no `bin` entry,
  and appeared in no user-facing documentation — an undocumented spend surface shipped
  to every installer with no way to discover it and no reason to. It remains in the
  repository for maintainers, and a test asserts both halves of that.

### Fixed

- `tests/contracts/executables-load.test.mjs` derived `setup.mjs` twice once it was
  also a `bin` entry, and symlinked it twice into one temp directory. Deduplicated,
  using the guard the same function already applies to `bin/`.

## [2.0.0-alpha.0] — 2026-08-30

First alpha of the pack, built on the RichAPI data plane. Never published; install
from a checkout.

### Added

- 33 skills covering ICP, list building, enrichment, research, copy, compliance, export
  and measurement, validated by `scripts/validate-skills.mjs` against a four-rule shape
  contract (`docs/skill-shape.md`).
- A `richapi` CLI whose every metered path plans before it spends: `enrich --dry-run`
  makes zero API calls, needs no key, and prints a per-hop and per-row ceiling with a
  stated floor. Runs are journalled and resumable from the row they died on.
- A generated endpoint catalog (`_lib/api-catalog.json`) as the single source of truth
  for cost and routing, with three CI gates over it: regenerable-and-current, a spec
  diff severity gate, and an every-endpoint-is-owned check.
- Three frozen JSON Schemas — `api-catalog`, `journal-line`, `ledger-line` —
  content-hash-pinned in `tests/contracts/frozen-contracts.sha256`.
- Fail-closed suppression, a TTL-swept and erasable `gtm/` PII directory, and a `setup`
  that refuses to run where `gtm/` is already git-tracked.
- An https-only API origin allowlist with explicit opt-in for non-default hosts, and
  the API key passed to curl on stdin via `--config -` so it never appears in
  `ps auxww`.
- Local activation counters that make no network call, ever.
- A CI workflow pinned to exact Node versions (18.20.8, 20.19.0, 22.0.0, 24.5.0) and
  `scripts/ci-local.sh`, which runs every step of it offline.

### Known limitations

Stated in full in `LIMITATIONS.md`:

- No live response fixtures. `field_map` is null on all 68 endpoints; 65 report
  `keys_from_spec_example` (spec-example key NAMES only) and 3 report
  `TODO_no_usable_example` — `enrich_profiles_bulk`, `enrich_companies_bulk` and
  `google_maps_places_scraper_keyword`. Field maps are spec-derived, never captured
  from a live response, and `--batch` should stay off.
- `post_keyword_search` ships `disabled_by_default` — it bills 6 credits per result
  against a count that is tens of thousands on a common keyword, and the spec's prose
  contradicts its own pricing block.
- `BALANCE` is usually `unknown`. There is no documented balance endpoint and the pack
  will not guess one.
- CI has never executed on a hosted runner; the matrix has been run by hand instead.
- All 33 skills declare an unscoped `allowed-tools: Bash`. See [`SECURITY.md`](SECURITY.md).
