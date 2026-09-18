---
name: launch
version: 1.0.0
description: >
  Writes the sender-format export (the last artifact the pack controls) and only against
  a PASS verdict bound to the list's content hash. Use when asked to "launch this
  campaign", "export for Smartlead", "export for Instantly", "hand this list to the
  sender", or "why won't it export". Refuses, with the reason named, on a missing
  verdict, a FAIL verdict, a changed list, or a verdict that has gone stale.
  (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - launch this campaign
  - export for smartlead
  - export for instantly
  - hand this list to the sender
  - write the sender export
  - why won't it export
---

# Launch — write the sender export

You own the irreversible act. Everything upstream of you is advice; the file you write
is the thing that actually leaves. Sending itself happens in someone else's tool, so
this export is the last point at which the pack can still say no — and it says no by
default.

## Before anything else

Run the preflight and read the keys:

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `SUPPRESSION: STOP` — there is no readable suppression store. Run
  `./setup --root <the user's project>` from the pack checkout — `setup` lives in the pack
  root and takes the project as `--root`, and hand-creating `gtm/suppression.jsonl`
  instead skips the `.gitignore` write and the refusal to run on a git-tracked `gtm/`
  (law 7). The export runs a **final** suppression pass at write time, because someone may
  have unsubscribed between the review and now, and a check that cannot run is not a
  passing check (law 5).

`API_KEY_SET: no` is not a blocker. This skill makes zero API calls and spends nothing;
it reads a list, reads a verdict, and writes a file.

## The refusals

Every reason this skill declines to write is reported by name with its fix. A refusal
with no reason is how a user learns to work around a gate.

| Code | Fires when | The fix |
|---|---|---|
| `NO_VERDICT` | No verdict file, or one that is not readable JSON | Run [`/campaign-review`](../campaign-review/SKILL.md) over this list |
| `FAIL_VERDICT` | The verdict says FAIL | Fix what the verdict's `blocking` list names, then review again |
| `HASH_MISMATCH` | The list changed after the review | Review again. A row edited, added or removed after a PASS voids it |
| `STALE_VERDICT` | The verdict is older than `gates.yaml:skills.campaign_review.verdict_max_age_hours` | Review again. It costs nothing |
| `COMPLY_STOP` | The clearance the review carries is not a pass, covers another list, has expired, or clears a different **channel** | Run [`/comply`](../comply/SKILL.md) over this exact list with `CHANNEL=email`, then review again |

`COMPLY_STOP` is the compliance chain arriving here. `/comply` writes a verdict per list,
`/campaign-review` FAILs a list with no live clearance and copies the clearance it used
into its own verdict, and this skill re-checks that copy against the list in front of it.
**A sender export is an e-mail artifact, so the clearance has to be an e-mail one.** A
`/comply` verdict clears a list *and a channel*: a call list can clear for `phone` while
`email` stays blocked on a missing postal address, which is the intended state and not a
contradiction. This skill writes Smartlead and Instantly files, so it requires `email`
among the channels the clearance names and refuses `COMPLY_STOP` otherwise. A phone
clearance therefore cannot produce a sender file by any route — including the route
where somebody points `/launch` at a list that was only ever cleared for calling.

So a row `/comply` stopped cannot reach this file by any route: the review refuses to
PASS while the row is on the list, and taking the row off changes the hash, which voids
both verdicts and forces a fresh run over the list as it now stands. There is no flag
that clears a compliance stop, because a flag that clears a compliance stop is the whole
gate.

`HASH_MISMATCH` and `STALE_VERDICT` are two different kinds of stale and both are real.
The hash catches a list that moved under a fixed verdict. The clock catches a verdict
that stood still while the world moved: suppression and verification state change
without touching a single row, so a hash that still matches is not on its own proof that
the review still holds.

The age is measured from the verdict's own `issued_at` against
`gates.yaml:skills.campaign_review.verdict_max_age_hours`, read here, at launch time.
A verdict's `expires_at` is human-facing only and is never trusted: a document may not
set the terms of its own expiry, or the gate is whatever the last writer felt like.

Two more stops exist and are reported the same way: `TOO_MANY_ROWS` when the list
exceeds `gates.yaml:skills.launch.max_export_rows`, and `GATE_OFF` when
`gates.yaml:skills.launch.require_pass_verdict` does not resolve to true. That second one
is deliberate: the gate can be tightened, never disarmed. Turning it off does not turn
exporting on, it stops exporting entirely.

## Step 1 — say what you are about to write

Before running anything, tell the user: which list, how many rows, which sender platform,
where the file goes, and which verdict authorises it. Smartlead and Instantly are the
featured formats; Apollo, Outreach, Lemlist and plain CSV are supported.

## Step 2 — run the gate

Run it from the user's project — the pack does not have to be the working directory.
Set `RICHAPI_PACK_ROOT=/path/to/gtm-skills` only when the pack is a checkout that is
neither installed as `@richapi/gtm-skills` nor the directory you are standing in:

```bash
LIST=gtm/lists/q3-uk.csv VERDICT=gtm/reviews/q3-uk.verdict.json \
OUT=gtm/exports/q3-uk.smartlead.csv PLATFORM=smartlead ROOT=. \
node --input-type=module -e "${GTM_LAUNCH:?set this to the gtm-launch script below}"
```

where `$GTM_LAUNCH` is the script below. Write it to a file and run it if that is easier;
it is the same script either way.

```js
// ==== gtm-launch v1 ====
// The ONLY writer of a sender-format export in this pack. Runs from ANY directory —
// see `PACK` below.
//
// env: LIST     (required) the .csv or .jsonl list to export
//      RICHAPI_PACK_ROOT (where the pack is, when it is neither installed nor here)
//      VERDICT  (required) the verdict file from /campaign-review
//      OUT      (required) where the export goes
//      PLATFORM (default csv) smartlead | instantly | apollo | outreach | lemlist | csv
//      ROOT     (default .)  the user's project root, the one holding gtm/
//      NOW      (ISO instant; test seam, so a clock is never implicit)
//      GATES_FILE (alternate gates.yaml; test seam for the gate itself)
//
// exit 0 = written, 3 = refused (nothing written), 2 = could not run at all.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// --- where the pack is ------------------------------------------------------
// This script runs in the USER'S project, where `./_lib/...` does not exist. Resolve
// the pack instead: RICHAPI_PACK_ROOT, else the installed @richapi/gtm-skills, else
// the current directory (the pack checkout itself).
const requireFrom = (dir) => createRequire(pathToFileURL(path.join(dir, 'resolve.mjs')));
const PACK = process.env.RICHAPI_PACK_ROOT
  ? path.resolve(process.env.RICHAPI_PACK_ROOT)
  : (() => {
      try { return path.dirname(requireFrom(process.cwd()).resolve('@richapi/gtm-skills/package.json')); }
      catch { return process.cwd(); }
    })();
const lib = (m) => import(pathToFileURL(path.join(PACK, '_lib', m)).href);

const { parseCsv } = await lib('csv.mjs');
const {
  writeSenderExport, readVerdict, listContentHash, isSenderPlatform,
  SENDER_FORMATS, SenderExportRefused,
} = await lib('sender-export.mjs');
const { loadGates, gateValue, MissingGateKey } = await lib('gates.mjs');

const LIST = process.env.LIST;
const VERDICT = process.env.VERDICT;
const OUT = process.env.OUT;
const PLATFORM = process.env.PLATFORM || 'csv';
// The channel a sender export IS. Not configurable and not an env var: this skill
// writes Smartlead and Instantly files, which are email files, so the clearance it
// stands on has to be an email clearance. A phone-only clearance refuses below.
const EXPORT_CHANNEL = 'email';
const ROOT = path.resolve(process.env.ROOT || '.');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
for (const [k, v] of [['LIST', LIST], ['VERDICT', VERDICT], ['OUT', OUT]]) {
  if (!v) { console.error('launch: ' + k + ' is required'); process.exit(2); }
}

const gates = loadGates(process.env.GATES_FILE || undefined);
const G = (k) => gateValue(gates, k);

const refusals = [];
const refuse = (code, why, fix) => refusals.push({ code, why, fix });

function readRows (file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return parseCsv(text);
}

let rows;
try { rows = readRows(LIST); }
catch (e) { console.error('launch: cannot read ' + LIST + ': ' + e.message); process.exit(2); }

// --- gate 0: the gate itself. Fail closed — only an explicit true runs. -----
let maxAgeHours = null;
let maxRows = null;
try {
  if (G('skills.launch.require_pass_verdict') !== true) {
    refuse('GATE_OFF',
      'skills.launch.require_pass_verdict is not true, so the verdict gate is disarmed.',
      'Restore it to true. This gate can be tightened, never turned off — with it off, /launch writes nothing at all.');
  }
  maxRows = G('skills.launch.max_export_rows');
  maxAgeHours = G('skills.campaign_review.verdict_max_age_hours');
} catch (e) {
  if (!(e instanceof MissingGateKey)) throw e;
  refuse('GATE_OFF', e.message + ' — failing closed (law 5).',
    'A gates.yaml key this skill needs does not resolve. Restore it; a missing key reads as STOP, never as "no gate".');
}

// --- refusal 1: NO_VERDICT --------------------------------------------------
let verdict = null;
try { verdict = readVerdict(VERDICT); }
catch (e) {
  refuse('NO_VERDICT', e.message,
    'Run /campaign-review over this exact list. A launch without a review is not a launch.');
}

if (verdict) {
  // --- refusal 2: FAIL_VERDICT ----------------------------------------------
  if (verdict.status !== 'PASS') {
    const named = Array.isArray(verdict.blocking) && verdict.blocking.length
      ? ' Blocking: ' + verdict.blocking.join(', ') + '.' : '';
    refuse('FAIL_VERDICT',
      'the verdict status is ' + JSON.stringify(verdict.status ?? null) + ', not PASS.' + named,
      'Fix what the verdict names, then run /campaign-review again. Do not export around a FAIL.');
  }

  // --- refusal 3: HASH_MISMATCH ---------------------------------------------
  const actual = listContentHash(rows);
  if (typeof verdict.list_hash !== 'string' || verdict.list_hash.length === 0) {
    refuse('HASH_MISMATCH', 'the verdict carries no list_hash, so it is not bound to any list.',
      'Re-run /campaign-review; a verdict with no binding cannot authorise an export.');
  } else if (verdict.list_hash !== actual) {
    refuse('HASH_MISMATCH',
      'the verdict reviewed list ' + verdict.list_hash.slice(0, 12) + ' but this list is '
      + actual.slice(0, 12) + '. The list changed after the review.',
      'Re-run /campaign-review over the list as it stands now, or restore the reviewed list.');
  }

  // --- refusal 4: STALE_VERDICT ---------------------------------------------
  // The one check the export writer cannot make for us: it binds content, not time.
  const issued = Date.parse(verdict.issued_at ?? '');
  if (maxAgeHours === null) {
    // already refused as GATE_OFF above; nothing more to say about age
  } else if (!Number.isFinite(issued)) {
    refuse('STALE_VERDICT', 'the verdict carries no readable issued_at, so its age cannot be established.',
      'Re-run /campaign-review. An age we cannot measure is treated as expired, not as fresh.');
  } else {
    const ageHours = (NOW.getTime() - issued) / (60 * 60 * 1000);
    if (ageHours > maxAgeHours) {
      refuse('STALE_VERDICT',
        'the verdict is ' + ageHours.toFixed(1) + 'h old, past gates.yaml:skills.campaign_review.verdict_max_age_hours ('
        + maxAgeHours + 'h). The hash still matches, but suppression and verification state move underneath a list that has not changed.',
        'Re-run /campaign-review. It makes no API calls and costs nothing.');
    }
  }

  // --- refusal 5: COMPLY_STOP -----------------------------------------------
  // /campaign-review stands on /comply's clearance and copies its id, status, hash
  // and issue time forward. This re-checks that block against the list actually in
  // front of us, so a review cannot carry a clearance that belongs to a different
  // list or to last month. It is a consistency check on the verdict, not a second
  // compliance gate: the rule table is /comply's and the decision is the review's.
  const cy = verdict.comply;
  if (cy && typeof cy === 'object') {
    // A verdict naming no channels predates the channel dimension and meant `email` —
    // the narrowest reading of one, never the widest.
    const complyChannels = (v) => (Array.isArray(v?.channels) && v.channels.length
      ? v.channels.map((c) => String(c).trim().toLowerCase())
      : ['email']);
    // typeof-string first, for the same reason the writer does it: Date.parse coerces,
    // so a numeric issued_at reads as the far future and a stale clearance looks fresh.
    const cyIssued = typeof cy.issued_at === 'string' ? Date.parse(cy.issued_at) : NaN;
    const cyAge = (NOW.getTime() - cyIssued) / (60 * 60 * 1000);
    const cyMeasurable = Number.isFinite(cyAge) && cyAge >= 0;
    let why = null;
    if (cy.state !== 'pass' || cy.status !== 'PASS') {
      why = 'the review recorded the compliance verdict as ' + JSON.stringify(cy.state ?? cy.status ?? null)
        + ', which is not a clearance.';
    } else if (typeof cy.list_hash !== 'string' || cy.list_hash !== actual) {
      why = 'the compliance verdict covers list ' + String(cy.list_hash ?? 'nothing').slice(0, 12)
        + ' but this list is ' + actual.slice(0, 12) + '. A clearance does not travel between lists.';
    } else if (!complyChannels(cy).includes(EXPORT_CHANNEL)) {
      why = 'the compliance verdict clears ' + complyChannels(cy).join(', ') + ', and a sender export '
        + 'is an ' + EXPORT_CHANNEL + ' artifact. A clearance is per channel: the ' + EXPORT_CHANNEL
        + ' preconditions were never in play when that list was screened.';
    } else if (maxAgeHours !== null && !(cyMeasurable && cyAge <= maxAgeHours)) {
      why = 'the compliance verdict is ' + (cyMeasurable ? cyAge.toFixed(1) + 'h old' : 'of unknown age')
        + ', past gates.yaml:skills.campaign_review.verdict_max_age_hours (' + maxAgeHours + 'h). '
        + 'An age we cannot measure is treated as expired, not as fresh.';
    }
    if (why) {
      refuse('COMPLY_STOP', why,
        'Run /comply over this exact list, then /campaign-review again. A row /comply stopped does not export, '
        + 'and there is no override — the way past it is the record.');
    }
  }
}

// --- the two other stops ----------------------------------------------------
if (maxRows !== null && rows.length > maxRows) {
  refuse('TOO_MANY_ROWS',
    rows.length + ' rows exceeds gates.yaml:skills.launch.max_export_rows (' + maxRows + ').',
    'Split the list and review each part, or raise the gate deliberately.');
}
if (!isSenderPlatform(PLATFORM)) {
  refuse('UNKNOWN_PLATFORM', 'no export format is defined for "' + PLATFORM + '".',
    'Pick one of: ' + Object.keys(SENDER_FORMATS).join(', ') + '.');
}

if (refusals.length > 0) {
  console.error('REFUSED — nothing was written to ' + OUT);
  for (const r of refusals) {
    console.error('  ' + r.code + ': ' + r.why);
    console.error('    fix: ' + r.fix);
  }
  process.exit(3);
}

// --- write. The library re-checks actor, PASS and hash, and re-runs -----------
// suppression at write time; disagreement here would be a bug worth seeing.
try {
  const res = writeSenderExport({
    file: OUT, rows, platform: PLATFORM, verdict, root: ROOT, actor: 'launch', now: () => NOW,
  });
  console.log('WROTE  ' + res.file);
  console.log('  platform  ' + res.platform);
  console.log('  rows      ' + res.written + ' written, ' + res.suppressed + ' suppressed at send time');
  console.log('  list_hash ' + res.list_hash);
  console.log('  verdict   ' + (verdict.verdict_id ?? VERDICT));
  console.log('  header    ' + res.header);
} catch (e) {
  if (e instanceof SenderExportRefused || e?.name === 'SuppressionUnavailableError') {
    console.error('REFUSED at write time: ' + e.message);
    process.exit(3);
  }
  throw e;
}
// ==== end gtm-launch v1 ====
```

## Step 3 — report what left, and what did not

Read the output back to the user, and lead with the number that is easy to miss:

- **Rows suppressed at write time.** The export re-runs the suppression filter, so the
  file can legitimately hold fewer rows than the list the verdict reviewed. Somebody
  unsubscribed in between. That is the gate working, not a bug, and the user needs to
  know their audience shrank before they see it in the sender.
- **The header line.** The file's first line is a comment binding the platform, the list
  hash, the verdict and the write time. It is what makes a hand-edited export detectable
  afterwards. Do not strip it — every supported sender skips a leading comment line, and
  the moment it is gone the file is indistinguishable from one nobody reviewed.

## Step 4 — after the file exists

The pack's job ends at the file. Uploading it, scheduling it and sending it happen in
the sender, under the user's account, with the user's domain reputation. Say that
plainly rather than implying the campaign is now live.

If the list is edited later, the export on disk can still be checked against it — the
header hash will no longer match, and that mismatch is the finding.

## What this skill will not do

- **It will not send anything.** Sending execution, inbox hosting, warmup, LinkedIn
  actions, dialing and direct mail are outside this pack permanently, not pending.
  Owning sending means owning spam complaints.
- **It will not write without a live PASS.** No verdict, a FAIL verdict, a changed list,
  an expired verdict or a clearance that does not cover this list each stop the write,
  and each is named. There is no override flag, because an override flag is the whole
  gate.
- **It will not review the list itself.** It reads a verdict; it does not form one. If
  the user wants a different answer, the route is
  [`/campaign-review`](../campaign-review/SKILL.md), not this skill.
- **It will not spend credits.** Zero API calls. Everything it needs is already on disk.
- **It will not strip or rewrite the binding header**, and it will not write a
  sender-format file anywhere other than the path it just told the user about.

## Related

- [`/campaign-review`](../campaign-review/SKILL.md) — produces the verdict this skill
  requires; the only way past a refusal
- [`/comply`](../comply/SKILL.md) — writes the compliance clearance the review stands on;
  a row it stopped never reaches this export
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — fills the gaps a FAIL verdict
  names
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt
- `richapi gates` prints every threshold and the key it comes from
