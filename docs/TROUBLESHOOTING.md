# Troubleshooting

Every message below was produced by actually running the thing, not written from
memory. If you see something not on this list, the message itself usually names the
fix on a line beginning `Fix:`.

One idea explains most of this page: **this pack fails closed.** When it cannot
prove something is safe, it stops instead of guessing. A refusal is usually the
system working, not breaking.

---

## `command not found: richapi`

The `richapi` command is not on your path.

From inside the pack folder, run `npm link`. On macOS or Linux you may need
`sudo npm link`.

Then close your terminal and open a new one. A terminal only notices new commands
when it starts, so this fixes it surprisingly often.

If you would rather not use `npm link`, every command also works with `node` in
front of it, run from inside the pack folder:

```console
$ node bin/richapi.mjs help
```

---

## `command not found: node`

Node is not installed, or your terminal has not noticed it yet. See
[GETTING-STARTED.md](GETTING-STARTED.md) step 1, then restart your terminal.

If `node --version` prints something older than `v18.20.8`, install the current
LTS from <https://nodejs.org>. The pack will not run on older versions and the
reason is technical rather than fussy: an important file format is not supported
before that version.

---

## `SUPPRESSION: STOP`

**The most common one, and the most important to understand.**

The suppression store is the list of people who have unsubscribed. This pack will
not touch a contact list when it cannot read that file, because "I could not check"
must never quietly become "nobody has unsubscribed."

Two causes:

**You have not run setup.** From inside the pack folder:

```console
$ ./setup --root ~/gtm-work
```

**Your `--dir` is pointing one level too high.** This is the single most common
first-day mistake. `setup` takes `--root`; `richapi` takes `--dir`; the second is
the `gtm` folder inside the first.

```console
$ ./setup --root ~/gtm-work                       # makes ~/gtm-work/gtm/
$ richapi enrich leads.csv --dir ~/gtm-work/gtm   # note the /gtm on the end
```

The full error names the exact path it looked in, which tells you which mistake it
is:

```
richapi: suppression store unreadable — failing closed, no call made.
  suppression store missing at ~/gtm-work/suppression.jsonl — STOP. Run `setup` to
  create it. A missing store is never read as "nothing suppressed".
```

If that path is missing a `/gtm`, that is your answer.

---

## `API_KEY_SET: no`

Expected until you are ready to spend. Dry runs work without a key and are free.

To set it:

```console
$ export richapi_API_KEY=your-key-here          # macOS / Linux
$ $env:richapi_API_KEY = "your-key-here"        # Windows PowerShell
```

This lasts for that terminal window only. Open a new window and you set it again.

Note the spelling: lowercase `richapi`, then uppercase `_API_KEY`. It is
case-sensitive and `RICHAPI_KEY` will not be picked up.

---

## `BALANCE: unknown`

Not a problem, and not something to fix.

The data service publishes no way to ask how many credits you have left. Rather
than invent a number, the pack says it does not know. A real figure appears only
after a run has been told it is out of credits.

---

## `CATALOG_OK: no` or `CATALOG_TOOLS: 0`

The price list could not be read. Regenerate it:

```console
$ richapi catalog gen
```

**`CATALOG_OK: unknown` is a different thing** and this fix will not help: `unknown`
means nothing looked, because `jq` is missing. See below.

---

## Everything looks broken and `preflight` disagrees with reality

The health check uses a small tool called `jq` to read the price list. If `jq` is
missing, those checks cannot run — and they say so rather than guessing: `JQ_MISSING:
yes`, then `CATALOG_OK: unknown`, `CATALOG_TOOLS: unknown`, `FILTERS_OK: unknown`.
Unmeasured, not failed. `richapi doctor` says it in a sentence.

Check:

```console
$ jq --version
```

If that fails, install it: `brew install jq` on macOS, `sudo apt install jq` on
Debian or Ubuntu, `winget install jqlang.jq` on Windows.

**All three of those lines being wrong together is the tell.** One of them wrong on
its own is a real problem; all three at once is usually just `jq`.

---

## `input list not found: <path>`

```
richapi: input list not found: /Users/you/leads.csv
```

The file is not where you said it was. Check the spelling, and remember the path is
relative to the folder your terminal is in. `pwd` tells you where that is.

---

## `"<name>" is not in the catalog`

```
richapi: "not_a_real_endpoint" is not in the catalog — run: node bin/richapi-catalog-gen.mjs
```

Either a typo, or the price list is stale. Run `richapi catalog gen` and try again.

---

## `--yes requires --budget`

```
richapi: --yes requires --budget. Unattended runs must name a credit ceiling: every
gate fires on a fraction of it, so without one the run is uncapped.
```

`--yes` means "do not ask me to approve." That is only safe with a ceiling, because
every spending limit in the pack is expressed as a fraction of your budget, and
without a budget there is no fraction and therefore no limit.

Add `--budget <credits>`. Price it first with `--dry-run`, which is free.

---

## `BLOCKED before any call`

```
BLOCKED before any call:
  - this call would take session spend to 8 of a 5-credit budget (160%).
    Policy: raise_or_abort.
```

Your budget is smaller than the plan. Nothing was charged.

Run with `--dry-run` to see the real total, then either raise `--budget` to cover
it or shorten the list. The pack will not spend past a ceiling you set, and it will
not silently do half the job either: a partial run buys a partial list nobody asked
for.

---

## The plan says 0 calls and 0 credits for every row

The dry run shows `hops not attempted` and every row says something like `no
linkedin_url to enrich from`.

Usually this means your list genuinely lacks the input a lookup needs — you cannot
find someone's work email from a first name alone.

But check your column headers first. Exports from Salesforce, HubSpot, Apollo and
Outreach use names like `First Name` and `LinkedIn URL`, and those are understood.
If your headers are unusual, rename them to `first_name`, `last_name`, `email`,
`company_name`, `domain`, `linkedin_url` and run the dry run again.

---

## A contact I expected is missing from the output

Most likely they are on the suppression store — someone unsubscribed. The dry run
counts them on the `Rows:` line as `suppressed/dropped`, and they cost nothing.

This is deliberate and there is no override. A suppressed contact is checked twice:
once when the plan is built and again when the file is written, because someone may
have unsubscribed in between.

---

## A compliance check refuses a US contact

`/comply` recognises GDPR, CCPA and CASL. CCPA is a California law, so a row marked
only `US` does not match any regime it knows, and the row stops as
`unknown_jurisdiction`.

For a California contact, use `subject_region: US-CA` rather than
`subject_country: US`.

For US contacts outside California there is currently no matching regime in the
pack. That is a known gap, not something you can configure around — see
[LIMITATIONS.md](../LIMITATIONS.md).

---

## It stopped in the middle of a run

Do not start over — you would pay for everything twice. Resume instead, and you pay
only for the rows that did not finish:

```console
$ richapi enrich leads.csv --resume <run-id> --out enriched.csv --dir ~/gtm-work/gtm
```

The run id looks like `enrich-mth5t7y8-e910ab` and appears at the top of the plan.

---

## Still stuck

Run this and include the output when you ask for help. It contains no contact data:

```console
$ richapi preflight
$ node --version
$ jq --version
```
