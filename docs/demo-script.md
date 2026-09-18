# The 30-second demo

A recording script, not a recording. Everything below is executable as written; follow it
top to bottom and you get the README GIF in about two minutes of wall time.

**DECIDED 2026-09-02: the GIF records the FREE path only.** Three beats — setup →
`--explain-my-list` → `--dry-run` — and it ends on the priced plan, not on a paid run.

Why that shape:

- It is the thing **no competing pack can show**. Every other GTM skill library
  orchestrates somebody else's API and cannot price a call before making it. A GIF of an
  enriched CSV is a GIF anyone can make; a GIF of the bill arriving *before* the spend is
  not.
- It **runs forever**, needs no key and no signup, so a viewer can reproduce it in the
  ninety seconds after watching it. That is the activation path.
- The free grant is **25 credits, about three contacts**. A GIF that ends on a paid run
  teaches a viewer to spend their entire trial reproducing a demo.

The paid run still has to be answered, because "and then what?" is the viewer's next
thought. It is answered by a **single still frame of the receipt** at the end (beat 4
below), and in prose by `docs/GETTING-STARTED.md` step 6, which walks the paid run and
states the three-contact reality plainly.

Nothing in the recording spends a credit. The plan shown costs **23 credits at the
ceiling, 2 at the floor** if the viewer later chooses to run it — both numbers read from
the plan itself, not typed here.

### The beats

| # | Command | Spends | What it shows |
|---|---|---|---|
| 1 | `./setup --root ~/demo` | nothing | "0 API calls made, 0 credits spent" |
| 2 | `richapi enrich leads.csv --explain-my-list` | nothing | how much of the list is worth paying for |
| 3 | `richapi enrich leads.csv --dry-run` | nothing | **the bill, before the spend** — hold this frame |
| 4 | *(still frame)* the receipt from a prior paid run | nothing | cost per found record — answers "and then what?" |

Beat 3 is the point of the recording. Hold on `TOTAL: 23 credits (ceiling; floor 2 ...)`
and on the `Billed on a miss:` block for a full two seconds each — those two are the
whole product, and a viewer who reads nothing else should read those.

---

## Before you record

**Check this first**, after `npm link` and before you start recording:

```console
$ richapi help
```

It must print the usage block starting `richapi — GTM waterfall runtime`. That one
command is the whole check: `npm link` puts `richapi` on your PATH as a symlink, and the
guard at the bottom of `bin/richapi.mjs` decides from it whether the CLI was invoked
directly or imported. It used to compare `import.meta.url` (the real path) against
`process.argv[1]` (the symlink path) and lose, so the installed command printed nothing
and exited 0. That is fixed — the guard calls `realpathSync` on both sides
(`bin/richapi.mjs`), and `tests/contracts/executables-load.test.mjs` spawns every
executable through a real symlink and requires it to behave as it does directly. Run the
command anyway; a GIF of a command that does nothing is not recoverable in post.

You need one of:

- **`vhs`** — `brew install vhs`. Deterministic, scripted, writes the GIF directly.
  Recommended: no live typing, no retakes.
- **`asciinema` + `agg`** — `brew install asciinema agg`. Live capture, then convert.

## Stage the demo directory (~90 seconds, not recorded)

```console
$ cd ~
$ git clone PASTE_CLONE_URL richapi-demo   # substitute; there is no public remote yet
$ cd richapi-demo
$ npm ci
$ npm link
$ cat > leads.csv <<'CSV'
first_name,last_name,company,domain,linkedin_url
Ada,Lovelace,Analytical Engines,analyticalengines.com,https://www.linkedin.com/in/adalovelace
Grace,Hopper,Compiler Works,compilerworks.io,https://www.linkedin.com/in/gracehopper
Alan,Turing,Bombe Systems,bombesystems.co.uk,
CSV
$ export richapi_API_KEY=<your key>
```

Three rows on purpose. Two are complete; the third has no LinkedIn URL, which is what
makes `hops not attempted` appear in the plan — the most useful line in the output and
the one a competitor's demo would edit out.

A fresh clone means `gtm/` does not exist yet, so beat 1 has something real to do. If you
re-record, `rm -rf gtm enriched.csv` first.

---

## The three beats

### Beat 1 — `./setup` (0:00 → 0:04)

```console
$ ./setup
```

Expected, verbatim from a real run:

```
RichAPI GTM skills — setup (apply)
  root: /Users/you/richapi-demo
  git:  not a git repo (nothing to track)
  gtm/ tracked by git: no  ✓
  .gitignore: added gtm/  ✓
  gtm/ tree: lists, enrichment-cache, research, copy, org-maps, deals, ads, runs  ✓
  suppression store: OK (0 entries — empty and honest; a missing store reads as STOP, never as "nothing suppressed")
  cache TTL policy: .../_lib/gates.yaml
      firmographics        90d
      funding_tech         30d
      email_verification    7d
      posts_activity        1d
      unknown               1d  <- unknown endpoints fail closed to the shortest TTL
      people_lists          7d
      directories          30d

  0 API calls made, 0 credits spent (Law 3: no opt-out paid calls, ever).
  setup complete.
```

In a fresh clone the `git:` line reads `gtm/ tracked by git: no  ✓` instead of
`not a git repo`. Exit 0. Hold 2.5s on the last two lines — `0 API calls made, 0 credits
spent` is the beat.

### Beat 2 — the dry run (0:05 → 0:16)

```console
$ richapi enrich leads.csv --dry-run
```

Expected, verbatim from a real run (the run id changes every time):

```
run enrich-mtdjqpty-14464b  (dry-run)

DRY RUN — plan for run enrich-mtdjqpty-14464b (no calls made)

Waterfall: 0:enrich_profile -> 1:email_finder? -> 2:email_verifier?

Per hop:
  hop 0  enrich_profile               2 calls @ 1cr  = 2cr  | 1 n/a
  hop 1  email_finder                 3 calls @ 5cr  = 15cr
  hop 2  email_verifier               3 calls @ 2cr  = 6cr

Rows:
  r00000-bf780ecee54b  enrich_profile=1cr, email_finder=5cr, email_verifier=2cr  => 8cr
  r00001-fb8bf32b6c03  enrich_profile=1cr, email_finder=5cr, email_verifier=2cr  => 8cr
  r00002-6c0f3b1e61ca  enrich_profile=not_applicable, email_finder=5cr, email_verifier=2cr  => 7cr

Rows:        3 (0 suppressed/dropped, 0 fully cached)
Calls:       8 (0 cache hits skipped, not charged)
TOTAL:       23 credits (ceiling; floor 2 if no conditional hop fires)
ETA:         unavailable — the API publishes no per-endpoint rate-limit quota, so elapsed time cannot be predicted; no ETA is published until it does

Approve this plan to run it. Resume re-plans only rows not already done.

ZERO calls made. Journal: /Users/you/richapi-demo/gtm/runs/enrich-mtdjqpty-14464b.jsonl
  8 units planned, 0 written terminal (suppressed or cached).

hops not attempted:
  enrich_profile       1  no linkedin_url to enrich from
```

26 lines. Hold 6s — this is the beat the whole GIF exists for. Exit 0, zero calls, no API
key required.

### Beat 3 — the paid run and the file (0:17 → 0:30)

```console
$ richapi enrich leads.csv --out enriched.csv
$ column -s, -t < enriched.csv
```

The run prints per-hop progress and then a receipt: coverage first, then spend as a range
where the endpoint did not report its charge. Hold 4s on the receipt, 3.5s on the table.

**This beat is the one nobody has executed.** It needs an API key and spends up to 23
credits, so the exact receipt text and the exact output columns are unverified. Record it
once, then paste the real output back into this file so the next person does not have to
pay again.

If the run is interrupted, `richapi enrich leads.csv --resume <run-id> --out enriched.csv`
pays only for the rows that did not finish.

---

## The vhs tape

Write this to `demo.tape` in `~/richapi-demo` and run `vhs demo.tape`. It produces
`demo.gif`. Nothing here is interactive, so the result is byte-stable across takes.

```
Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1180
Set Height 760
Set Padding 18
Set TypingSpeed 45ms
Set Theme "Builtin Dark"

Hide
Type "cd ~/richapi-demo && rm -rf gtm enriched.csv && clear" Enter
Sleep 1s
Show

# Beat 1 — setup. Zero calls, zero credits.
Type "./setup"       Enter
Sleep 2500ms
Type "clear"         Enter
Sleep 300ms

# Beat 2 — the plan. Zero calls, no API key needed.
Type "richapi enrich leads.csv --dry-run"  Enter
Sleep 6s
Type "clear"         Enter
Sleep 300ms

# Beat 3 — approve, run, open the file.
Type "richapi enrich leads.csv --out enriched.csv"  Enter
Sleep 4s
Type "column -s, -t < enriched.csv"  Enter
Sleep 3500ms
```

Budget: ~4s + ~9s + ~13s of hold plus typing ≈ 30s. If it lands long, cut beat 1's sleep
to 2s and beat 3's first sleep to 3s. If the dry-run plan overflows 760px, raise `Height`
rather than shrinking the font — the per-row cost lines have to stay readable.

## The asciinema alternative

```console
$ cd ~/richapi-demo
$ rm -rf gtm enriched.csv
$ asciinema rec demo.cast \
    --cols 118 --rows 34 \
    --idle-time-limit 1.5 \
    --title "RichAPI GTM — setup, plan, run" \
    --command bash
```

Then type the three beats live, `exit` when done, and convert:

```console
$ agg --font-size 15 --theme asciinema demo.cast demo.gif
```

`--idle-time-limit 1.5` collapses your typing pauses so a live take still lands near 30
seconds. Use `--overwrite` to re-record over an existing cast.

## Where the GIF goes

`README.md`, in the block quote directly under the resume command in
[Start with the free command](../README.md#start-with-the-free-command). Replace the
quote with the image; keep a text description of the three beats next to it so the
README still reads correctly with images off.

---

## Verification status

Run on 2026-08-29, Node v24.5.0, in a scratch directory outside the repo.

| Command | Status |
|---|---|
| `./setup` | **Verified.** Exit 0. Output above is verbatim. Zero calls. |
| `richapi enrich leads.csv --dry-run` | **Verified.** Exit 0, zero calls, 23cr ceiling / 2cr floor on this list. Output above is verbatim. |
| `richapi enrich leads.csv --dry-run --phone` | **Verified.** Same list re-plans at 98 credits — `phone_finder` is 25cr/call. |
| dry run with one domain suppressed | **Verified.** Ceiling drops 23 → 16; the suppressed row plans at 0cr and every hop on it reads `skipped_suppressed`. |
| `richapi enrich leads.csv --out enriched.csv` with no key | **Verified.** Refuses with `richapi_API_KEY is not set. Export it, or use --dry-run (which spends nothing).` No calls made. |
| `richapi help`, `richapi preflight`, `richapi gates`, `richapi catalog diff` | **Verified.** All free, all exit 0. |
| `richapi enrich leads.csv --out enriched.csv` **with** a key | **Not verified — spends credits.** Receipt text and output columns unconfirmed. |
| `column -s, -t < enriched.csv` | **Not verified** — depends on the beat above. |
| `richapi` invoked through a symlink | **Verified** on 2026-08-31: a symlink to `bin/richapi.mjs` on PATH, `richapi help` prints the usage block and exits 0. `tests/contracts/executables-load.test.mjs` spawns every executable through a real symlink on every run. |
| `npm link` itself putting `richapi` on PATH | **Not verified** — no global install was performed; the symlink behaviour it depends on is verified above. |
| `richapi ... --dir <root>` vs `--dir <root>/gtm` | **Verified.** `--dir` is the state tree, so after `./setup --root X` the flag takes `X/gtm`. Passing `X` exits 5 with `suppression store unreadable — failing closed, no call made.` |
| `vhs demo.tape` / `asciinema rec` | **Not verified** — no terminal available in the environment this script was written in. |

Field maps come from recordings now. `field_map` is `null` on 68 of 68 endpoints by
design; the path lists split like this:

- `live_fixture` — 63 of 68, read off a recorded 2xx response. Every waterfall hop is here,
  so the columns in `enriched.csv` are the ones the server really sends.
- `keys_from_spec_example` — 5 of 68, still the spec's guess: `geo_id_search`,
  `google_ad_transparency_scraper_sync`, `google_maps_reviews_scraper_sync`,
  `linkedin_ad_search`, `slack_channel_members`. The demo touches none of them.
- `TODO_no_usable_example` — 0 of 68.
