# Security

## Reporting a vulnerability

Email **support@richapi.ai** with `[gtm-skills]` in the subject.
Please do not open a public issue for anything exploitable.

Include the version (`cat VERSION`), your Node version, the skill or command involved,
and what an attacker gets. If a proof of concept spends credits, say roughly how many
so a reproduction can be budgeted (law 3 applies to us too).

There is no bug bounty. Expect an acknowledgement; a fix timeline depends on what it
is. A public advisory will credit you unless you ask otherwise.

## Threat model in one paragraph

This pack hands an LLM agent a shell and a paid API key, and several of its skills feed
the agent text an attacker wrote — a public form body, an email reply, a call
transcript, a scraped page, a CSV cell. The two things that can go wrong are therefore
**prompt-injected command execution** and **unbudgeted spend**, and a third that
follows both: **contact PII leaving `gtm/`**. Everything below is either a control
against one of those or an honest statement that a control is missing.

## The narrowed grant, and the hole it does not close

**Every `allowed-tools` grant is now scoped** (2026-09-02). No skill declares a bare
`Bash`. Each one's shell grants are DERIVED from the commands its own runnable fences
invoke, and `tests/permissions/allowed-tools.test.mjs` fails the build on a bare `Bash`
anywhere, on a grant over a command outside the pack's surface, and on any drift from
the audit of record.

The whole command surface is six commands:

| Grant | Skills | What it reaches |
|---|---|---|
| `Bash(richapi:*)` | 22 | the pack's own CLI |
| `Bash(richapi-skills-preflight:*)` | 33 | the health contract |
| `Bash(node:*)` | 10 | **arbitrary execution — see below** |
| `Bash(head:*)` · `Bash(tr:*)` · `Bash(cat:*)` | 1 | `crm-sync-expert`, reading a CSV header |
| `Bash(rm:*)` · `Bash(touch:*)` · `Bash(printf:*)` · `Bash(grep:*)` | 1 | `scheduled-workflow`, disarming a schedule |

**This is partial mitigation, and the honest part is which half is missing.** For the 23
skills without `Bash(node:*)`, the narrowing is real: they cannot reach `curl`, `ssh`, a
package manager, or a shell, so a prompt-injected line inside a scraped page or a reply
body has nothing to call. For the **ten that hold `Bash(node:*)`** — `campaign-review`, `comply`, `cost-optimizer`, `crm-export`, `crm-sync-expert`, `gtm-retro`, `launch`, `learn`, `measure`, `scheduled-workflow` —
`node -e` is arbitrary execution and the grant is a formality. Those ten run a generated
script through `node --input-type=module -e`, which is why they need it.

That count was **six** when this section was first written on 2026-09-02, and it was
wrong: the derivation read only the first token of each line, so four skills whose
`node` call is prefixed with environment assignments (`ROOT=. node ...`) were missed.
`tests/permissions/allowed-tools.test.mjs` now derives the command surface pipeline-aware and
fails the build when a skill runs a command it does not declare — which is how the four
were found.

Of the five skills that ingest attacker-authored text (`/reply-triage`, `/inbound`,
`/call-intel`, `/research-agent`, `/signal-watch`), **none holds `Bash(node:*)`**. That
is the intersection that mattered, it is empty, and it is pinned by a test rather than by
this sentence — a skill cannot acquire both properties without failing the build.

What that still means for you:

- **Run this pack in an environment you would be willing to lose.** Give the agent the
  narrowest sandbox you can. Six skills can still execute arbitrary JavaScript.
- **Use a scoped API key with a credit cap.** The runtime's gates are a budget control,
  not an authorization boundary.
- Treat any skill that ingests third-party text as processing hostile input, because it
  is — the narrowing reduces what an injection can reach, it does not stop one landing.

## Controls that do exist

These are real and tested. They are listed here because until now they lived only in
source comments, where no user was ever going to find them.

**HTTPS-only origin allowlist, with explicit opt-in.**
`richapi_API_ORIGIN` used to be honored with no allowlist, no scheme check and no
warning, so `richapi_API_ORIGIN=http://evil.tld` sent the live API key to an attacker
in a plaintext header — and an agent that reads documents is one prompt-injected line
away from setting an environment variable. Now (`_lib/client.mjs`,
`bin/richapi-skills-preflight`):

- `https://api.richapi.ai` is always allowed.
- Any other origin must be `https:`. Plain `http:` to a remote host is refused
  outright.
- Any other `https:` origin requires an explicit opt-in:
  `richapi_ALLOW_CUSTOM_ORIGIN=<hostname>` (pinned, preferred) or `=1` for any https
  origin.
- Credentials embedded in the origin (`https://user:pass@host`) are refused.
- A refusal names the origin and states outright that nothing was sent and that there
  is **no fallback** to the default. Silently falling back would be its own bug.

**The API key never appears in a process listing.**
`-H "x-api-key: $key"` put the live key in `ps auxww` for every other local user, on a
schedule, behind every skill invocation. The key now goes to curl on **stdin** via
`curl --config -`; `printf` is a shell builtin and `sed` reads the key from a pipe, so
no process in the pipeline carries it in its arguments either. Keys containing a
backslash or a double quote are escaped into curl's config format rather than
silently truncated.

**Fail-closed suppression.**
An empty suppression store means zero entries. A **missing or unreadable** one means
STOP, never "nothing suppressed" (`_lib/suppression.mjs`, law 5). On a fresh checkout
with no `./setup`, `richapi enrich leads.csv --dry-run` exits **5** with `suppression
store unreadable — failing closed, no call made` rather than proceeding. Unproven
fail-closed suppression is the failure mode that mails a person who asked not to be
mailed.

**`setup` refuses to run where `gtm/` is git-tracked.**
`gtm/` holds contact PII. It is gitignored, TTL-swept and erasable. If it is already
tracked, `setup` refuses outright rather than adding more PII to a history that will
be pushed; it also warns when `gtm/` appears in git *history* even though it is
untracked now.

**Spend is planned before it happens.** Every metered call is named and costed in a
dry-run that makes zero API calls, and the printed total is a ceiling with a stated
floor, not an estimate. This is a safety control as much as a cost one: an injected
instruction to "enrich everything" produces a plan and a confirmation prompt, not a
bill.

## Network destinations

The pack talks to exactly three hosts. There are no others.

| Host | When | Carries the API key? |
|---|---|---|
| `api.richapi.ai` | enrichment calls; a backgrounded `GET /api/v1/usage` balance refresh at most once per TTL | yes |
| `mcp.richapi.ai/health` | probed on every preflight to emit `NET: online\|offline`; 2s timeout | no |
| `raw.githubusercontent.com` | a backgrounded `VERSION` fetch to emit `UPGRADE:`, cached with a TTL | no |

Override the first two with `richapi_API_ORIGIN` (subject to the allowlist above) and
`richapi_MCP_ORIGIN`. The `VERSION` check has no override today; if you need a fully
airgapped run, block the host — every one of these three calls is backgrounded or
short-timeout and degrades to `offline` / `unknown` rather than failing the run.

## No telemetry

**There is no telemetry, no analytics vendor, and no phone-home in this package.** No
Segment, PostHog, Mixpanel, Amplitude, Google Analytics, Sentry, Datadog or Bugsnag —
verified by grep across the tree, and there is no such dependency: the package has
exactly one runtime dependency, `yaml`.

`_lib/activation.mjs` is named like telemetry and is not. It counts installs and runs
into a local JSON file and **makes no network call, ever** — it imports only
`node:fs`, `node:path` and `node:crypto` plus a path helper, and
`tests/activation/activation.test.mjs` asserts that at the source level as well as at
runtime, because "telemetry" is a word that grows a network client the moment nobody
is watching. It stores counts, timestamps, an install id and a pack version. No list
names, no file paths, no row ids, no contact values, no endpoint payloads. It lives in
the state directory (`~/.richapi-skills`, overridable with `richapi_SKILLS_HOME`),
never in `gtm/`.

If this pack ever ships a phone-home it will be a separate module behind an explicit
opt-in, and it will not be that file.

## Where PII lives

- `gtm/` — contact data, run journals, the suppression store. Gitignored, TTL-swept,
  erasable via `/comply`. Never commit it.
- `~/.richapi-skills` (or `$richapi_SKILLS_HOME`) — the balance cache, the upgrade
  cache, and the activation counters. No contact data.
- Live API responses captured by the maintainer fixture tool are redacted before they
  are written to `tests/fixtures/live/`; unredacted bodies only exist with
  `--keep-raw`, which writes `*.raw.json`, which `.gitignore` excludes. That tool is
  **not shipped in the npm tarball**.

## Supported versions

| Version | Supported |
|---|---|
| `2.0.0-alpha.x` | yes — fixes land on the newest alpha only |

Nothing is published to npm yet; `npm view @richapi/gtm-skills` is a 404. Until a
`2.0.0` final exists, "supported" means the current `main`.

## What `2.0.0-alpha.0` promises

It is an alpha, and it is labelled one for reasons that are written down rather than
implied:

**What is stable enough to build on.** The `richapi` CLI's core verbs and their exit
codes. The dry-run plan format. The three frozen JSON Schemas — `api-catalog`,
`journal-line`, `ledger-line` — which are content-hash-pinned and cannot change
without a deliberate, announced amendment. `engines.node >= 18.20.8`.

**What may break between any two alphas, without a major bump.**

- Skill names, file layout under `skills/`, and prose. Renaming a skill renames its
  gate namespace with it.
- Gate keys in `_lib/gates.yaml` and their default values. Keys are add-only *within*
  the alpha series by convention, but a default may move.
- The generated `_lib/api-catalog.json`, on every upstream spec change. Credit costs
  come from it and are not a stable interface — 16 of 53 endpoints repriced in four
  months upstream.
- Journal and ledger *file layout* on disk (the line schemas are frozen; where the
  files sit is not).
- The `bin` map. `richapi-setup` is new in this alpha.

**What is known-incomplete.** Response shapes are recorded for all but five endpoints,
and still spec-derived for those five:

- `live_fixture` — 63 of 68 endpoints.
- `keys_from_spec_example` — 5 of 68 endpoints. This is the state that produced the
  2026-09-02 response-map defect (`LIMITATIONS.md` §1); treat these key names as
  unverified.
- `TODO_no_usable_example` — 0 of 68 endpoints.

`--batch` should stay off, for the separate reason in `LIMITATIONS.md` §3.
`BALANCE` is often `unknown`: it comes only from a background probe of `GET /usage`, and
no run is reconciled against that endpoint. CI has never
executed on a hosted runner — the matrix has been run by hand instead. All of this is
in the README under *Where this actually stands*, and in `LIMITATIONS.md`.

Semantic versioning applies from `2.0.0` final. Before then, read
[`CHANGELOG.md`](CHANGELOG.md) between alphas.
