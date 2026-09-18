# Installing RichAPI GTM Skills

Works in **Claude Code, Cursor, Windsurf, Codex, Copilot, Cline, Continue, Zed** and
anything else that reads the [`SKILL.md`](https://agentskills.io) format — plus every
other agent, through the CLI.

New to the terminal? Start at [`GETTING-STARTED.md`](GETTING-STARTED.md) instead. This
page assumes you can run a command.

---

## First: this is two things, and you need both

| | What it is | Where it goes | Without it |
|---|---|---|---|
| **The CLI** (`richapi`) | The program that plans, prices, gates and calls | Your `PATH` | Every skill tells the agent to run a command that does not exist |
| **The skills** (`skills/`) | 33 `SKILL.md` files the agent reads | Your agent's skills folder | You have a working CLI and no plain-English front door |

Almost every install problem is one of these two missing. The preflight checks both.

> **Install the CLI first.** Every skill's first instruction is `richapi-skills-preflight`.
> If that command is missing, the agent gets `command not found` and has no way to know
> why.

---

## Step 1 — the CLI (every platform)

```console
$ git clone https://github.com/richapiai/gtm-skills
$ cd gtm-skills
$ npm ci
$ npm link                      # puts `richapi` and `richapi-setup` on your PATH
$ richapi-setup --root ~/gtm-work   # 0 API calls, 0 credits
```

**Requirements:** Node >= 18.20.8 and `jq`. Both are checked by the preflight, and a
missing `jq` is now reported as `JQ_MISSING: yes` rather than as a broken catalog.

Check it took:

```console
$ richapi doctor
```

You want `Everything checks out.` No API key needed — dry runs are free and are the thing
worth trying first.

---

## Step 2 — the skills, per platform

Every host reads the same 33 files. Only the folder differs.

| Agent | Project-local | Global |
|---|---|---|
| **Claude Code** | `.claude/skills/` | `~/.claude/skills/` |
| **Cursor** | `.cursor/skills/` | — |
| **Windsurf** | `.windsurf/skills/` | — |
| **Codex** | `.codex/skills/` | `~/.codex/skills/` |
| **Zed** | `.zed/skills/` | — |
| **GitHub Copilot** · **Cline** · **Continue** · others | see your agent's skills docs | — |

**Prefer project-local.** Your lists live in the project, and the pack's state tree
(`gtm/`) is per-directory by design — one checkout is one book of business.

### The general recipe

```console
$ cd ~/gtm-work                       # your GTM project
$ mkdir -p .claude/skills             # or .cursor/skills, .windsurf/skills, …
$ ln -s ~/gtm-skills/skills/* .claude/skills/
```

**Symlinks, not copies.** A copy goes stale silently, and a stale skill quoting an old
credit price is exactly the failure this pack is built to prevent. One endpoint went from
3 credits to 25 in a single quarter. With symlinks, `git pull` updates all 33 at once.

### Claude Code — the one-command path

Claude Code also has a plugin marketplace, which handles updates for you:

```console
$ claude
> /plugin marketplace add richapiai/gtm-skills
> /plugin install richapi-gtm-skills
```

The plugin ships the **skills only**. Install the CLI from Step 1 as well; the preflight
stops on a version mismatch between the two rather than failing later with
`command not found`.

### Cursor

```console
$ mkdir -p .cursor/skills
$ ln -s ~/gtm-skills/skills/* .cursor/skills/
```

Cursor reads `SKILL.md` natively. If you also keep `.cursor/rules`, leave them alone —
skills and rules coexist, and a rule is not a substitute for a skill here: these files
carry step gates and approval stops that a passive rule cannot enforce.

### Windsurf

```console
$ mkdir -p .windsurf/skills
$ ln -s ~/gtm-skills/skills/* .windsurf/skills/
```

Cascade picks them up from the project directory.

### Any agent that does not read SKILL.md

The CLI is the portable half and needs no agent at all:

```console
$ richapi enrich leads.csv --explain-my-list   # free: is any of this worth buying?
$ richapi enrich leads.csv --dry-run           # free: the bill, before the spend
$ richapi enrich leads.csv --out enriched.csv  # spends, after you approve
```

Everything the skills do, they do by driving these commands. Point your agent at
[`docs/skills/`](skills/) — one plain-English page per skill — and it can follow the
same recipes.

---

## About MCP

**This pack is not an MCP server, and that is deliberate.**

RichAPI operates its own MCP server, and you can wire it straight into Cursor or any
other MCP host. Before you do, understand exactly what you give up.

An MCP tool call goes agent → endpoint. There is nothing in between. So a direct MCP
connection has:

| | Direct MCP | Through this pack |
|---|---|---|
| Cost shown before the call | ✗ | ✓ priced per row and per hop |
| Spend ceiling | ✗ | ✓ gates on a fraction of a budget you name |
| Do-not-contact check | ✗ | ✓ enforced before spend *and* at write time |
| Record of what you paid | ✗ | ✓ per-call ledger, honest about what it cannot verify |
| Resume after a crash | ✗ | ✓ pays only for rows that did not finish |
| Wrong-shape response caught | ✗ | ✓ loud failure instead of an empty column |
| Empty call refused | ✗ | ✓ refused before it is sent |
| Your column names accepted | ✗ | ✓ mapped to what each endpoint wants |

The last two rows were measured against `https://mcp.richapi.ai/mcp` on 2026-09-18,
and both cut the same way.

`email_finder` and `phone_finder` declare **nothing required** on the MCP surface, which
is the API's own contract: an empty call is valid, and it is billable. `phone_finder` is
25 credits. This pack refuses to build one.

The names differ too. MCP takes each endpoint's own field names, and they are not
consistent between endpoints — `email_finder` wants `company_domain` where
`phone_finder` wants `domain`, for the same company's domain, and `enrich_profile` wants
`url` where every prospect list on earth has a column called `linkedin_url`. The pack
maps your columns onto whatever the endpoint asks for; over MCP you do that yourself,
per endpoint, per call. MCP does at least fail loudly on a name it does not know rather
than silently ignoring it.

One divergence is worth calling out on its own, because it costs a whole run rather than
one call: **`enrich_company` takes a LinkedIn company URL, or its `universalName` slug,
and nothing else.** A bare domain answers 404 and a website URL answers 503. Feed it a
`domain` column and every row misses. It is free — a non-2xx is unbilled — which is
precisely what makes it hard to notice.

That "wrong-shape response" row is not hypothetical. On 2026-08-31 a capture run showed the response maps
were reading the wrong place in the body, so a paid `email_finder` call returned the
provider name and **threw the email away** — silently, on every call. A direct MCP
connection has no layer that could notice. See [`LIMITATIONS.md`](../LIMITATIONS.md) §1.

**So:** if your host speaks MCP, install the skills and the CLI anyway. Every MCP host
that can also run a terminal command gets the full runtime. Use the raw MCP server only
when you want unmetered, unrecorded calls and have decided that is fine.

What the two surfaces agree on, measured the same day: the MCP server exposes all 68
endpoints, its field names are `snake_case` exactly as the skills write them, and the
same endpoint returns the same body through either path. The skills' *knowledge* carries
over to MCP. Their *guard rails* do not.

There is **no MCP wrapper around this runtime yet** — one that exposed `dry-run`,
`approve`, `enrich` as MCP tools would give MCP-only hosts the gates too. It is not
built, and this page will say so until it is.

---

## Verify the install

```console
$ richapi doctor
```

```
richapi doctor  (2.0.0-alpha.0)

[  ok  ] jq is installed
[  ok  ] Catalog loaded — 68 endpoints
[  ok  ] Catalog is the shipped one
[  ok  ] Do-not-contact store is readable
[  ok  ] No API key — dry runs still work
[  ok  ] Credit balance: unknown

Everything checks out. Nothing here spends a credit until you approve a plan.
```

Four lines people misread:

- **`No API key`** is fine. Dry runs cost nothing and 11 of the 33 skills never spend at all.
- **`Credit balance: unknown`** is the honest answer, not a failure. With no key there is no
  account to have a balance, and with one the number appears only after a background
  probe of `GET /usage` has answered.
- **`Catalog is the shipped one`** means it has never been re-synced, which is correct on
  a fresh install.
- **`Do-not-contact store is readable`** — `STOP` here means nothing will enrich until
  `richapi-setup` has run. That is the fail-closed rule, not a bug.

Then, in your agent:

> I have a list of leads at ~/gtm-work/leads.csv — what would it cost to enrich it?

Start with `/richapi-gtm`, the router: it works out what you are trying to do and hands
off to one of the other 32.

---

## What your agent must honour

- **`allowed-tools`.** Every skill declares scoped shell grants — `Bash(richapi:*)` and
  friends, never a bare `Bash`. An agent that ignores the field runs these with whatever
  permissions it has, which is wider than the pack asks for. Ten skills additionally hold
  `Bash(node:*)`, which is arbitrary execution — see
  [`SECURITY.md`](../SECURITY.md#the-narrowed-grant-and-the-hole-it-does-not-close).
- **Approval stops.** Several skills pause and wait for a human to approve a priced plan.
  An agent that auto-approves everything defeats the one feature this pack exists for. If
  yours cannot pause, run unattended work through `richapi enrich --yes --budget <n>`,
  which enforces the ceiling in the runtime instead of in the agent.

---

## When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: richapi` | CLI half not installed | `npm link` from the checkout |
| The router does nothing | Skills not on a path the agent reads | Check `<skills-dir>/richapi-gtm/SKILL.md` resolves |
| `CATALOG_OK: unknown` | `jq` missing | Install `jq` — the catalog is fine |
| `CATALOG_OK: no` | Catalog genuinely unreadable | `richapi catalog gen` |
| `SUPPRESSION: STOP` | No readable store | `richapi-setup --root <your project>` |
| Preflight stops on a version mismatch | CLI and skills are different versions | Update whichever is behind |
| Odd credit numbers | Stale catalog | `richapi catalog gen`, then `richapi catalog diff` |

**The `--root` / `--dir` trap**, which catches nearly everyone: `richapi-setup` takes
`--root` (the *parent*), the commands take `--dir` (the `gtm/` folder *inside* it).

```console
$ richapi-setup --root ~/gtm-work                  # creates ~/gtm-work/gtm/
$ richapi enrich leads.csv --dir ~/gtm-work/gtm    # note the /gtm
```

Point `--dir` one level too high and you get `suppression store unreadable — failing
closed, no call made` and exit 5. That is the safety system working.

Everything else: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
