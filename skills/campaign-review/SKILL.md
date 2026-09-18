---
name: campaign-review
version: 1.0.0
description: >
  Reviews a contact list against the pack's quality floors AND against /comply's verdict
  for the same list, then emits a PASS or FAIL bound to the list's content hash. A list
  with no live compliance clearance FAILs here. Use when asked to "review this campaign",
  "is this list ready to send", "check this list before launch", "sign off on this list",
  or "why did launch refuse". Makes zero API calls and spends nothing. Proactively invoke
  before any hand-off to a sending tool: /launch will not write an export without a
  verdict this skill produced. Run /comply first. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - review this campaign
  - is this list ready to send
  - check this list before launch
  - sign off on this list
  - campaign review
  - why did launch refuse
---

# Review a campaign list

You are the last reviewer before a list leaves the pack. You do not wave things through
and you do not soften a stop into a suggestion. Your output is a verdict file, not an
opinion, and the verdict is bound to the exact list you read — one edited row and it no
longer applies.

You do not form the compliance opinion yourself. [`/comply`](../comply/SKILL.md) owns the
lawful-basis rule table and writes its own verdict; this skill **reads** it and refuses
the list when it is missing, stale, bound to a different list, or FAIL. That order
matters: one rule table, one place it is implemented, and a review that cannot be handed
a clearance is a review that fails. Run `/comply` first — it costs nothing.

## Before anything else

Run the preflight and read the keys:

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `SUPPRESSION: STOP` — there is no readable suppression store. Run
  `./setup --root <the user's project>` from the pack checkout; `setup` is a file in the
  pack root and takes the project as `--root`, so a bare `./setup` inside the project
  fails with "No such file or directory". A review that could not run the suppression
  cross-check is not a review; this skill fails the list rather than passing it on an
  unchecked gate (law 5).

`API_KEY_SET: no` is **not** a blocker here. This skill makes no API calls at all: it
reads a file the user already has. `BALANCE: unknown` is likewise irrelevant.

## What a verdict is, and what binds it

A verdict is a small JSON file with two load-bearing fields:

- `list_hash` — the content hash of the list, over every row, computed from the row
  values rather than the column order. Reordering columns is not a change; adding,
  removing or editing a contact is.
- `issued_at` — when the review ran. A verdict expires after
  `gates.yaml:skills.campaign_review.verdict_max_age_hours`, **even when the hash still
  matches**, because suppression state and verification results move underneath a list
  that has not itself changed. Someone unsubscribes; a mailbox that resolved last week
  stops resolving. The hash cannot see either.

Those two fields are what [`/launch`](../launch/SKILL.md) reads. A third is carried for
it: `comply`, the id, status, hash and issue time of the compliance verdict this review
stood on. `/launch` re-checks that block against the list in front of it rather than
trusting that this skill looked, so a review copied from another list cannot smuggle a
clearance with it. Everything else in the file is for the human.

## Step 1 — read the list

Above `gates.yaml:skills.campaign_review.full_read_max_rows` the row-level tallies run
over a deterministic sample; at or below it every row is read. Three things always cover
the whole list regardless, because they are cheap and because getting them wrong is
unrecoverable: the content hash, the duplicate scan, and the suppression cross-check.

Say which mode ran. "Reviewed a sample" and "reviewed every row" are different claims
and the user is entitled to know which one they got.

## Step 2 — run the gates

Run the review from the user's project. It spends nothing and writes one file. It
expects `/comply`'s verdict to be on disk already, at `gtm/reviews/<list>.comply.json`
unless `COMPLY` says otherwise:

```bash
LIST=gtm/lists/q3-uk.csv ROOT=. node --input-type=module -e "${GTM_COMPLY:?set this to the gtm-comply script from /comply}"           # first
LIST=gtm/lists/q3-uk.csv ROOT=. node --input-type=module -e "${GTM_CAMPAIGN_REVIEW:?set this to the gtm-campaign-review script below}" # then this
```

where `$GTM_CAMPAIGN_REVIEW` is the script below. Write it to a file and run it if that
is easier; it is the same script either way.
`$GTM_COMPLY` is /comply's script, bound the same way.

**Neither script needs the pack to be the working directory.** Both resolve the pack
themselves — `RICHAPI_PACK_ROOT` if it is set, else the installed
`@richapi/gtm-skills` in the project's `node_modules`, else the current directory. They
used to `import './_lib/…'`, which exists only in the pack checkout, so in a customer's
project they died with `ERR_MODULE_NOT_FOUND`. The one line to add, and only when the
pack is a checkout somewhere else: `RICHAPI_PACK_ROOT=/path/to/gtm-skills`.

**Two things the quality gates do not accept as answers.** Both were live findings, and
both made a bad list look like a good one:

- **Verification comes only from the verifier.** The fail-rate gate reads
  `email_verification_status` and nothing else. `email_status` is `email_finder`'s
  column (the ESP of an address that same call guessed), and reading it as a verdict
  reported "0% fail rate" over a list nobody had verified.
- **An explicit null is not a value.** `not_found`, `not_verifiable` and
  `not_applicable` are how this pack records an absence. A row whose email column holds
  `not_found` has no address, so it does not count toward coverage, and a status column
  holding one is not a verdict. Counting the markers turned a list with no addresses on
  it into "100% coverage".

```js
// ==== gtm-campaign-review v1 ====
// Reads a list, checks it against the quality floors AND against /comply's verdict for
// the same list, and writes a verdict bound to the list's content hash. ZERO API calls.
// Runs from ANY directory — see `PACK` below.
//
// env: LIST  (required)  the .csv or .jsonl list under review
//      RICHAPI_PACK_ROOT (where the pack is, when it is neither installed nor here)
//      ROOT  (default .) the user's project root, the one holding gtm/
//      OUT   (default gtm/reviews/<list>.verdict.json)
//      COMPLY (default gtm/reviews/<list>.comply.json) the /comply verdict this
//             review stands on. Absent, stale or FAIL is a stop, never a shrug.
//      CHANNEL (default email) the channel this review is FOR. A /comply clearance is
//             per channel, so a verdict that cleared `phone` does not clear an email
//             review: the email preconditions were never in play when it was screened.
//      NOW   (ISO instant; test seam, so a clock is never implicit)
//      GATES_FILE (alternate gates.yaml; test seam for the gate itself)
//
// exit 0 = PASS written, 3 = FAIL written, 2 = could not review at all.

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
const { listContentHash } = await lib('sender-export.mjs');
const { filterOutputList } = await lib('suppression.mjs');
const { loadGates, gateValue, checkCoverage, checkVerificationFailRate, MissingGateKey, STOP } = await lib('gates.mjs');

const LIST = process.env.LIST;
const ROOT = path.resolve(process.env.ROOT || '.');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
if (!LIST) { console.error('campaign-review: LIST is required'); process.exit(2); }

const gates = loadGates(process.env.GATES_FILE || undefined);
const G = (k) => gateValue(gates, k);

function readRows (file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return parseCsv(text);
}

const EMAIL_COLS = ['email', 'work_email', 'email_address'];
// The VERIFIER'S OWN verdict, and nothing else. `email_status` used to be first in
// this list: that is `email_finder`'s column — the ESP's view of the mailbox it
// guessed, written by the same call that guessed the address. Counting it as
// verification let a list where every row read `not_found` report "100% coverage,
// 0% fail rate" and pass the gate. Nothing verified it; nobody paid a verifier.
const STATUS_COLS = ['email_verification_status', 'verification_status', 'smtp_status'];
const FAILED = new Set(['invalid', 'undeliverable', 'do_not_mail', 'unknown', 'bad', 'bounced', 'hard_bounce']);
const HARD = new Set(['bounced', 'hard_bounce', 'undeliverable']);
// The pack's three explicit nulls. A cell holding one is a recorded ABSENCE of a
// value, not a value: `not_found` in an email column is not an address, and in a
// status column it is not a verdict.
const NULL_ENUM = new Set(['not_found', 'not_verifiable', 'not_applicable']);
const cell = (row, cols) => {
  for (const c of cols) {
    const v = row?.[c];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s === '' || NULL_ENUM.has(s.toLowerCase())) continue;
    return s;
  }
  return '';
};
// An address is a mailbox, not a marker. Coverage counts what could be sent to.
const address = (row) => {
  const v = cell(row, EMAIL_COLS);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : '';
};
// Coverage means "rows this campaign can actually REACH", so it is measured on the
// column the CHANNEL uses. Measuring a call list's email coverage reported 0% and
// stopped a list that was never going to carry an address — the same defect as
// /comply asking a phone list for a postal address, one skill later.
const PHONE_COLS = ['phone', 'phone_number', 'mobile', 'mobile_phone', 'direct_dial'];
const LINKEDIN_COLS = ['linkedin_url', 'linkedin', 'profile_url'];
const REACHABLE = {
  email: (row) => address(row),
  phone: (row) => cell(row, PHONE_COLS),
  linkedin: (row) => cell(row, LINKEDIN_COLS),
};
/** Reachable on ANY channel in play. A mixed campaign needs one working route per row. */
const reachable = (row, channels) => channels.some((c) => (REACHABLE[c] ? REACHABLE[c](row) !== '' : false));

let rows;
try { rows = readRows(LIST); }
catch (e) { console.error('campaign-review: cannot read ' + LIST + ': ' + e.message); process.exit(2); }

const listHash = listContentHash(rows);           // every row, always
const checks = [];
const notes = [];
const stop = (gate, reason, extra = {}) => checks.push({ gate, decision: 'stop', reason, ...extra });
const pass = (gate, reason, extra = {}) => checks.push({ gate, decision: 'allow', reason, ...extra });
const record = (d) => (d.decision === STOP ? stop(d.gate, d.reason, d) : pass(d.gate, d.reason, d));

let readMode = 'full';
let sample = rows;
let maxAgeHours = null;
let complyFile = process.env.COMPLY
  || path.join(ROOT, 'gtm', 'reviews', path.basename(LIST).replace(/\.[^.]+$/, '') + '.comply.json');
let comply = null;         // the parsed /comply verdict, once it is known good
let complyState = 'absent';
// A clearance is a property of a list AND a channel. A verdict written before the
// channel dimension existed names none, and an unnamed channel reads as `email` —
// what those runs actually meant, and the narrowest reading, never the widest.
const CHANNEL = (process.env.CHANNEL || 'email').trim().toLowerCase();
const clearedChannels = (cy) => (Array.isArray(cy?.channels) && cy.channels.length
  ? cy.channels.map((c) => String(c).trim().toLowerCase())
  : ['email']);

try {
  const fullReadMax = G('skills.campaign_review.full_read_max_rows');
  if (rows.length > fullReadMax) {
    readMode = 'sample';
    const step = Math.ceil(rows.length / fullReadMax);
    sample = rows.filter((_, i) => i % step === 0);
  }

  // --- compliance: nobody on the suppression list may be on this list ------
  // Runs over EVERY row. An unreadable store throws, and that is a FAIL, not a pass.
  const filtered = filterOutputList(rows, { root: ROOT });
  if (filtered.dropped.length > 0) {
    stop('suppression', filtered.dropped.length + ' contact(s) on this list are suppressed. '
      + 'Run /list-hygiene to drop them, then review again.',
      { suppressed_rows: filtered.dropped.length });
  } else {
    pass('suppression', 'no suppressed contact is on this list (' + rows.length + ' row(s) checked)');
  }

  // --- compliance: /comply's verdict ---------------------------------------
  // The lawful-basis gate is NOT re-implemented here. Its rule table lives in
  // skills/comply/SKILL.md and there is exactly one implementation of it on purpose;
  // a second one in this file would drift, and the drift would fail open. What this
  // checks is the same three things /launch checks of the verdict below: it says
  // PASS, it is bound to THIS list, and it has not expired. A list nobody cleared is
  // not a reviewed list, so absent reads as stop, never as "no compliance finding".
  maxAgeHours = G('skills.campaign_review.verdict_max_age_hours');
  let cy = null;
  if (!fs.existsSync(complyFile)) {
    complyState = 'absent';
    stop('comply', 'no compliance verdict at ' + complyFile + '. Run /comply over this list; '
      + 'it makes no API calls and it is the only thing that clears a lawful basis.',
      { comply_file: complyFile, comply_state: complyState });
  } else {
    try { cy = JSON.parse(fs.readFileSync(complyFile, 'utf8')); }
    catch (e) {
      complyState = 'unreadable';
      stop('comply', 'the compliance verdict at ' + complyFile + ' is not readable JSON (' + e.message
        + '). Run /comply again.', { comply_file: complyFile, comply_state: complyState });
    }
  }
  if (cy) {
    const named = Array.isArray(cy.blocking) && cy.blocking.length ? ' Blocking: ' + cy.blocking.join(', ') + '.' : '';
    // typeof-string first, deliberately: Date.parse coerces, so a numeric issued_at
    // of 12345 parses as the year 12345 and a stale clearance reads as a future one.
    // A future date is not "very fresh" either — it is unmeasurable, so it expires.
    const cyIssued = typeof cy.issued_at === 'string' ? Date.parse(cy.issued_at) : NaN;
    const cyAge = (NOW.getTime() - cyIssued) / (60 * 60 * 1000);
    const cyMeasurable = Number.isFinite(cyAge) && cyAge >= 0;
    if (cy.status !== 'PASS') {
      complyState = 'fail';
      stop('comply', '/comply stopped ' + (cy.rows_stopped ?? 'some') + ' row(s) on this list.' + named
        + ' Fix what the compliance verdict names per row, or drop those rows, then run /comply again.',
        { comply_file: complyFile, comply_state: complyState, comply_blocking: cy.blocking ?? [] });
    } else if (typeof cy.list_hash !== 'string' || cy.list_hash !== listHash) {
      complyState = 'hash_mismatch';
      stop('comply', 'the compliance verdict covers list ' + String(cy.list_hash ?? 'nothing').slice(0, 12)
        + ' but this list is ' + listHash.slice(0, 12) + '. A cleared list that was then edited is not a '
        + 'cleared list. Run /comply again over the list as it stands.',
        { comply_file: complyFile, comply_state: complyState });
    } else if (!clearedChannels(cy).includes(CHANNEL)) {
      complyState = 'wrong_channel';
      stop('comply', 'the compliance verdict clears ' + clearedChannels(cy).join(', ') + ', and this '
        + 'review is for ' + CHANNEL + '. A clearance is per channel: the ' + CHANNEL + ' preconditions '
        + 'were never in play when that list was screened. Run /comply again with CHANNEL=' + CHANNEL
        + ' over this exact list.',
        { comply_file: complyFile, comply_state: complyState, comply_channels: clearedChannels(cy) });
    } else if (!cyMeasurable || cyAge > maxAgeHours) {
      complyState = 'stale';
      stop('comply', cyMeasurable
        ? 'the compliance verdict is ' + cyAge.toFixed(1) + 'h old, past '
          + 'gates.yaml:skills.campaign_review.verdict_max_age_hours (' + maxAgeHours + 'h). '
          + 'Suppression and objection state move underneath a clearance. Run /comply again; it costs nothing.'
        : 'the compliance verdict carries no readable issued_at, so its age cannot be established '
          + 'against gates.yaml:skills.campaign_review.verdict_max_age_hours. An age we cannot measure is '
          + 'treated as expired, not as fresh. Run /comply again.',
        { comply_file: complyFile, comply_state: complyState });
    } else {
      complyState = 'pass';
      comply = cy;
      pass('comply', '/comply cleared all ' + (cy.rows_total ?? rows.length) + ' row(s) of this exact list for '
        + CHANNEL + ' at ' + cy.issued_at + ' (' + (cy.verdict_id ?? 'no id') + ')',
        { comply_file: complyFile, comply_state: complyState });
    }
  }

  // --- quality: coverage ---------------------------------------------------
  // On the channels actually in play. `reviewChannels` is what /comply cleared, or
  // just this review's channel when there is no clearance to read — never "all", which
  // would let an unreadable verdict widen the check.
  const reviewChannels = (comply ? clearedChannels(comply) : [CHANNEL]).filter((c) => REACHABLE[c]);
  const withAddress = sample.filter((r) => reachable(r, reviewChannels)).length;
  const coveragePct = sample.length ? (withAddress / sample.length) * 100 : NaN;
  record({ ...checkCoverage(gates, coveragePct), channels: reviewChannels });

  // --- quality: verification ----------------------------------------------
  // A list nobody verified has an UNMEASURED fail rate, and an unmeasured rate is a
  // stop, not a zero. catch_all is counted as neither a pass nor a failure.
  //
  // E-MAIL ONLY. There is no verifier for a phone number in this API and none for a
  // LinkedIn URL, so demanding a verifier verdict on a call list is demanding a column
  // no endpoint can fill — a stop with no fix, which is the bug this channel work
  // exists to remove. It is reported as not applicable, never as a silent pass.
  if (!reviewChannels.includes('email')) {
    pass('quality_stops', 'no e-mail verification check: this review is for '
      + reviewChannels.join(', ') + ', and the pack ships no verifier for those channels. '
      + 'The fail rate is `not_applicable`, not zero — re-review with CHANNEL=email before '
      + 'anything is e-mailed to this list.',
      { verification: 'not_applicable', channels: reviewChannels });
  } else {
  const stated = sample.map((r) => cell(r, STATUS_COLS).toLowerCase()).filter(Boolean);
  const failPct = stated.length ? (stated.filter((s) => FAILED.has(s)).length / stated.length) * 100 : NaN;
  const hardPct = stated.length ? (stated.filter((s) => HARD.has(s)).length / stated.length) * 100 : NaN;
  const ver = checkVerificationFailRate(gates, { failPct, hardBouncePct: Number.isFinite(hardPct) ? hardPct : null });
  record(Number.isFinite(failPct) ? ver : { ...ver, reason: ver.reason
    + ' — no row carries a verifier verdict (' + STATUS_COLS.join(', ') + '). '
    + 'The finder\'s `email_status` is not one: it is the ESP of an address the same call '
    + 'guessed. Run the verification hop in /enrich-waterfall, then review again.' });
  }

  // --- notes: real, but not this skill's stop to make ----------------------
  const seen = new Set();
  let dupes = 0;
  for (const r of rows) {
    const e = address(r).toLowerCase();
    if (!e) continue;
    if (seen.has(e)) dupes += 1; else seen.add(e);
  }
  if (dupes > 0) notes.push(dupes + ' duplicate email(s). /list-hygiene owns dedupe; the same person receiving two emails is a complaint waiting to happen.');
  const maxExport = G('skills.launch.max_export_rows');
  if (rows.length > maxExport) notes.push('this list is larger than gates.yaml:skills.launch.max_export_rows, so /launch will refuse it whatever this verdict says.');
} catch (e) {
  if (e instanceof MissingGateKey) {
    stop(e.key, e.message + ' — failing closed (law 5)', { failed_closed: true });
  } else if (e?.name === 'SuppressionUnavailableError') {
    stop('suppression', 'the suppression store could not be read: ' + e.message
      + ' — a check that could not run is not a passing check. Run `./setup`.',
      { failed_closed: true });
  } else {
    console.error('campaign-review: ' + e.message);
    process.exit(2);
  }
}

const blocking = checks.filter((c) => c.decision === 'stop');
const status = blocking.length === 0 ? 'PASS' : 'FAIL';
const issuedAt = NOW.toISOString();
// A verdict whose max age could not be read has already expired. Fail closed.
const expiresAt = maxAgeHours === null
  ? issuedAt
  : new Date(NOW.getTime() + maxAgeHours * 60 * 60 * 1000).toISOString();

const verdict = {
  schema_version: 1,
  verdict_id: 'cr-' + issuedAt.replace(/[:.]/g, '-') + '-' + listHash.slice(0, 8),
  status,
  list_file: path.relative(ROOT, path.resolve(LIST)) || path.resolve(LIST),
  list_hash: listHash,
  rows_total: rows.length,
  rows_read: sample.length,
  read_mode: readMode,
  issued_at: issuedAt,
  expires_at: expiresAt,
  max_age_hours: maxAgeHours,
  checks,
  blocking: blocking.map((c) => c.gate),
  // The channel this review is for, carried forward. /launch writes an EMAIL sender
  // export and re-checks this, so a phone review cannot produce one.
  channel: CHANNEL,
  channels: comply ? clearedChannels(comply) : [],
  // The clearance this review stands on, copied forward so /launch can re-check it
  // against the same list hash rather than taking "we looked" on trust.
  comply: {
    state: complyState,
    file: path.relative(ROOT, path.resolve(complyFile)) || complyFile,
    verdict_id: comply?.verdict_id ?? null,
    status: comply?.status ?? null,
    list_hash: comply?.list_hash ?? null,
    issued_at: comply?.issued_at ?? null,
    rows_stopped: comply?.rows_stopped ?? null,
    channel: CHANNEL,
    channels: comply ? clearedChannels(comply) : null,
  },
  notes,
};

const out = process.env.OUT
  || path.join(ROOT, 'gtm', 'reviews', path.basename(LIST).replace(/\.[^.]+$/, '') + '.verdict.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(verdict, null, 2) + '\n', 'utf8');

console.log(status + '  ' + verdict.verdict_id);
console.log('  list      ' + verdict.list_file + '  (' + rows.length + ' row(s), read ' + readMode + ')');
console.log('  list_hash ' + listHash);
console.log('  expires   ' + expiresAt);
for (const c of checks) console.log('  ' + (c.decision === 'stop' ? 'STOP ' : 'ok   ') + c.gate + ': ' + c.reason);
for (const n of notes) console.log('  note  ' + n);
console.log('  verdict   ' + out);
process.exit(status === 'PASS' ? 0 : 3);
// ==== end gtm-campaign-review v1 ====
```

## Step 3 — report the verdict, not a summary of it

Read the verdict file back to the user. Two rules:

- **A FAIL is a list of named gates, each with its fix.** "The list failed review" is
  useless. "Coverage is under the floor in `gates.yaml:quality_stops.coverage_min_pct`;
  run the enrichment waterfall over the rows with no email" is actionable. Every stop in
  the verdict already carries its gate key — pass those on.
- **A PASS is not a recommendation.** It means every gate the pack can check cleared.
  The pack cannot check whether the copy is any good, whether the offer makes sense, or
  whether these are the right people. Say so, once, and do not pad it.

If the user wants to change something after a PASS, the answer is always the same: make
the change, then run this skill again. A verdict is cheap. Re-running costs nothing and
makes no calls, which is exactly why the binding is strict.

## What this skill will not do

- **It will not send anything, and it will not write a sender export.**
  [`/launch`](../launch/SKILL.md) is the only skill in the pack that writes a
  sender-format file, and it does so against a verdict this skill produced. Sending
  execution itself is outside the pack permanently.
- **It will not pass a gate it could not run.** An unreadable suppression store, an
  unmeasured verification rate, a missing or expired compliance verdict, a `gates.yaml`
  key that does not resolve — each of those is a FAIL, never a silent allow. A check that
  could not run is not a passing check.
- **It will not decide a lawful basis.** [`/comply`](../comply/SKILL.md) owns that rule
  table and this skill will not second-guess, override or re-implement it. There is no
  flag here that clears a row `/comply` stopped; the route is to fix the record and run
  `/comply` again.
- **It will not review a list it did not read.** The verdict binds to the content hash
  of the rows actually loaded. It cannot vouch for a list someone describes to it.
- **It will not judge the campaign.** Copy quality, offer, targeting and timing are
  human calls. This skill checks the floors the pack can measure and says nothing about
  the rest.
- **It will not spend credits.** Zero API calls, no exceptions. If a gate needs data the
  list does not carry, the answer is to go enrich it and come back, not to buy the
  answer mid-review.

## Related

- [`/comply`](../comply/SKILL.md) — writes the compliance verdict this skill requires;
  run it before this one, and again after any edit to the list
- [`/launch`](../launch/SKILL.md) — the only consumer of a verdict, and the only writer
  of a sender export
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — fills the coverage and
  verification gaps a FAIL will name
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router, and the session receipt
- `richapi gates` prints every threshold and the key it comes from
