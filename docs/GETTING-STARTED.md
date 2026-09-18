# Getting started

For the person who runs go-to-market, not the person who runs the build.

By the end of this page you will have a file of enriched leads you can open in a
spreadsheet, and you will have seen exactly what it cost before you paid for it.

You do not need to know how any of this works. You do need to copy and paste
about six lines, and you need to read one screen of output before you spend
anything. That screen is the whole point of this pack.

---

## What you are installing, in one paragraph

This is a set of instructions that a coding assistant (Claude Code) reads, plus a
small program called `richapi` that does the actual work of looking up email
addresses, phone numbers and company data. The instructions tell the assistant how
to run the program safely. The program refuses to spend money until you have seen
the bill and said yes.

**Two things it will never do**, so you are not surprised later: it does not send
email, and it does not write into your CRM. It takes you up to the send button and
hands you a file. See [LIMITATIONS.md](../LIMITATIONS.md) for the full list.

---

## Step 1 — install Node

`richapi` is written in JavaScript, and Node is the program that runs JavaScript on
your computer. It is free, it is made by a non-profit foundation, and installing it
does not change anything else on your machine.

You need version **18.20.8 or newer**.

**macOS and Windows** — go to <https://nodejs.org>, download the version marked
**LTS** (it stands for Long Term Support, which means "the stable one"), and run the
installer. Accept the defaults.

**Linux** — use your distribution's package manager, or the installers at
<https://nodejs.org>.

Now check it worked. Open Terminal (macOS: press Cmd+Space, type "Terminal",
press Enter) or PowerShell (Windows: press the Start key, type "PowerShell",
press Enter), and type:

```console
$ node --version
```

**You should see** a version number that starts with `v18.20.8` or higher, like
`v22.11.0`. If you see `command not found`, Node did not install — restart your
terminal first, because it only notices new programs when it starts.

---

## Step 2 — get the pack onto your computer

```console
$ git clone <the repository URL> richapi-gtm-skills
$ cd richapi-gtm-skills
$ npm ci
```

`git clone` copies the files down. `cd` moves you into the folder. `npm ci` reads
the list of things the program needs and downloads them.

**You should see** `npm ci` print a line ending in something like
`added 1 package in 2s`. Warnings are normal. An error that stops it is not.

Then make the `richapi` command available everywhere:

```console
$ npm link
```

**You should see** a couple of lines mentioning paths. Check it took:

```console
$ richapi help
```

**You should see** a page starting `richapi — GTM waterfall runtime`. If you see
`command not found: richapi`, `npm link` did not finish — on macOS or Linux try
`sudo npm link`.

---

## Step 3 — create your workspace

This is where your lists and results live.

```console
$ ./setup --root ~/gtm-work
```

Replace `~/gtm-work` with wherever you want your files. `~` means your home folder.

**You should see** a summary ending in:

```
  0 API calls made, 0 credits spent (Law 3: no opt-out paid calls, ever).
  setup complete.
```

That "0 credits" line is not decoration. Nothing in this pack, including setup,
spends money without showing you a bill first.

### The one thing that trips everybody up

`setup` takes `--root`. The `richapi` command takes `--dir`. **They are not the
same value.** `--root` is the parent folder; `--dir` is the `gtm` folder inside it.

```console
$ ./setup --root ~/gtm-work                 # creates ~/gtm-work/gtm/
$ richapi enrich leads.csv --dir ~/gtm-work/gtm    # note the /gtm
```

If you point `--dir` at the parent by mistake you get this, and nothing runs:

```
richapi: suppression store unreadable — failing closed, no call made.
  suppression store missing at ~/gtm-work/suppression.jsonl — STOP.
```

That is the safety system working, not a bug. It means "I could not check whether
anyone on this list has unsubscribed, so I refuse to touch it." Add `/gtm` to the
path and run it again.

---

## Step 4 — see the bill before you pay it

This is the important step, and it is free.

Make a file called `leads.csv` with your contacts. Column names from Salesforce,
HubSpot or Apollo work as they come — `First Name`, `Company Name`, `LinkedIn URL`
are all understood. A minimal one looks like:

```csv
first_name,last_name,company,domain,linkedin_url
Jane,Doe,Acme,acme.com,https://linkedin.com/in/janedoe
```

Then:

```console
$ richapi enrich leads.csv --dry-run --dir ~/gtm-work/gtm
```

**You should see** a plan like this. **No API calls are made and nothing is
charged.**

```
DRY RUN — plan for run enrich-mth5t7y8-e910ab (no calls made)

Waterfall: 0:enrich_profile -> 1:email_finder? -> 2:email_verifier?

Per hop:
  hop 0  enrich_profile               2 calls @ 1cr  = 2cr  | 1 n/a
  hop 1  email_finder                 3 calls @ 5cr  = 15cr
  hop 2  email_verifier               3 calls @ 2cr  = 6cr

Rows:        3 (0 suppressed/dropped, 0 fully cached)
TOTAL:       23 credits (ceiling; floor 2 if no conditional hop fires)

ZERO calls made.

hops not attempted:
  enrich_profile       1  no linkedin_url to enrich from
```

Three things worth reading properly:

**TOTAL is a ceiling, not a guess.** 23 is the most you can pay. 2 is the least.
Both numbers are calculated from the price list, never typed by hand.

**`hops not attempted` is about your list, not the service.** A row with no
LinkedIn URL and no company domain cannot be looked up by anyone. Better to know
before you pay for the rest.

**`suppressed/dropped`** is anyone who has unsubscribed. They are removed before
anything is charged, and they cost nothing.

You can run this as many times as you like. It is always free.

---

## Step 5 — check the system is healthy

```console
$ richapi preflight
```

**You should see** something like:

```
CATALOG_OK: yes
CATALOG_TOOLS: 68
API_KEY_SET: no
SUPPRESSION: OK
BALANCE: unknown
```

What each line means when it goes wrong:

| Line | Meaning |
|---|---|
| `API_KEY_SET: no` | Normal until step 6. Dry runs still work. |
| `SUPPRESSION: STOP` | **Stop.** `setup` has not run, or `--dir` is wrong. Nothing will run until this says OK. |
| `CATALOG_OK: no` | Run `richapi catalog gen`. |
| `CATALOG_OK: unknown` | `jq` is not installed, so nothing looked. Install `jq` — the catalog is almost certainly fine. |
| `JQ_MISSING: yes` | Install `jq`. Every check that reads JSON is unmeasured without it. |
| `BALANCE: unknown` | Normal. The balance comes only from a background probe of `GET /usage`, and the pack refuses to guess one. |

---

## Step 6 — spend, once you have decided to

A **credit** is the unit the data service bills in. Different lookups cost
different amounts: confirming an email address is cheap, finding a phone number is
the most expensive call in the whole system. The dry run in step 4 told you exactly
which ones your list needs and what they add up to.

Get an API key from your RichAPI account, then:

```console
$ export richapi_API_KEY=your-key-here
$ richapi enrich leads.csv --out enriched.csv --dir ~/gtm-work/gtm
```

On Windows PowerShell the first line is `$env:richapi_API_KEY = "your-key-here"`.

You will be shown the plan again and asked to approve it. **Nothing is charged
before you answer.**

**You should get** `enriched.csv`, which opens in Excel, Numbers or Google Sheets,
plus a receipt telling you what actually ran.

If it stops halfway — laptop closed, wifi dropped — do not start over. Resume, and
you pay only for the rows that did not finish:

```console
$ richapi enrich leads.csv --resume <run-id> --out enriched.csv --dir ~/gtm-work/gtm
```

The run id is in the dry-run output, on the line beginning `DRY RUN — plan for run`.

---

## Step 7 — use it through Claude instead

Everything above also works by asking in plain English, which is the point of the
skills. Point Claude Code at the `skills/` folder (see
[INSTALL.md](INSTALL.md)) and then say things like:

> I have a list of leads at ~/gtm-work/leads.csv, can you enrich it?

> Is this list safe to send under GDPR?

> Which of these accounts should I contact first?

Start with `/richapi-gtm`, which works out what you are trying to do and sends you
to the right skill. Every skill has a plain-English page in
[docs/skills/](skills/) explaining what problem it solves and what it costs.

---

## When something goes wrong

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). The errors are deliberately blunt:
this pack would rather stop and tell you why than guess and spend your money.
