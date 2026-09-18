---
name: crm-export
version: 1.0.0
description: >
  Writes the pack's data out as a CRM import file (HubSpot, Salesforce, Pipedrive,
  Close, Attio, or a canonical generic file), suppression-filtered at write time, with a
  manifest saying exactly what PII is in it. Use when asked to "export this to HubSpot",
  "get this into Salesforce", "CRM-ready file", "import file for my CRM", or "export as
  CSV for my CRM". It is NOT the sender export: any target the pack already treats as a
  sending tool is refused by name and routed to /launch. Makes zero API calls and spends
  nothing. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - export this to my crm
  - export to hubspot
  - get this into salesforce
  - crm ready file
  - import file for pipedrive
  - export for close
  - export for attio
---

# Write the CRM import file, and say what is in it

The file you write is PII leaving the pack. It goes into a system this pack cannot see,
cannot audit and cannot erase from, and once it is in there it is somebody else's
problem forever. So the file names itself: what is in it, what is deliberately not in
it, which rows were dropped and why, and the fact that it holds personal data.

This skill makes zero API calls. Everything it needs is already on disk.

## Before anything else

```bash
richapi-skills-preflight
```

Stop and fix before continuing if:

- `SUPPRESSION: STOP` — there is no readable suppression store. Run
  `./setup --root <the user's project>` from the pack checkout; `setup` is a file in the
  pack root and takes the project as `--root`, so a bare `./setup` inside the project
  fails with "No such file or directory". Never hand-create `gtm/suppression.jsonl`
  instead — that skips the `.gitignore` write and the refusal to run on a git-tracked
  `gtm/` (law 7). This is a hard blocker and not a warning: the file about to be written
  is a contact file, and a suppression check that could not run is not a passing check
  (law 5). The script below refuses on its own if you skip this.

`API_KEY_SET: no` is **not** a blocker, and `BALANCE: unknown` is irrelevant. This skill
owns no endpoints, makes no paid call, and has nothing to price.

`CATALOG_OK: no` is not a blocker either, though it is worth mentioning to the user: the
provenance stamped on the rows came from the catalog when they were fetched, and a stale
catalog means a stale answer to "where did this column come from".

## Is a CRM export just a sender export under another name?

No — and the reason has to be mechanical, or the answer is a vibe and the gate it
protects is decoration. This section is the argument, because getting it wrong in either
direction is bad: a second uncontrolled export route makes the sender-export gate pointless, and refusing to
build a legitimate feature is over-application dressed up as rigour.

**What the sender-export gate actually gates.** [`/launch`](../launch/SKILL.md) is the sole writer of the
*sender-format* export. The rationale is that sending is external, so the export file is
the last artifact the pack still controls; an ungated second export path is one
copy-paste away from making [`/campaign-review`](../campaign-review/SKILL.md) and
[`/comply`](../comply/SKILL.md) advisory. `_lib/sender-export.mjs` enforces it with an
actor seam, and the SKILL.md validator makes any other skill naming its writer a hard
error.

**Why the CRM file is a different artifact.** The gated thing is not "a CSV with
contacts in it" — the pack writes those routinely into `gtm/lists/`, and pretending
otherwise would gate every skill in the tree. The gated thing is the artifact that is
*one upload away from a send*: shaped for a sending tool's importer, requiring no further
work from the user before mail leaves. A CRM import file is one upload away from a
*record*. The destination is a system of record with its own ownership, lifecycle and
consent fields; importing into it is a filing action, and nothing is sent.

**The obvious objection, and the answer.** A CRM with a sequencer bolted on is a sender.
That objection is correct, which is why the boundary cannot be the word "CRM". It has to
be a namespace, and the pack already maintains one: `SENDER_FORMATS` in
`_lib/sender-export.mjs` is the list of platforms this pack has ruled to be sending
tools. Two of its entries (Apollo and Outreach) are called CRMs everywhere else in the
industry, and the pack has already decided they are senders. That decision is the
precedent, so this skill inherits it rather than re-litigating it.

**The rule, therefore:** *this skill's target namespace and `SENDER_FORMATS` are
disjoint, and the disjointness is enforced from the file rather than from a list typed
here.* The script reads `SENDER_FORMATS` at run time and refuses any target that appears
in it, with a route to `/launch`. When someone adds a platform to that list, this skill
starts refusing it the same day, with no edit here. A target that only ever fed a CRM
object and later grows a sequencer gets added there, once, and both gates move together.

Three consequences worth stating plainly, because they are the parts that cost something:

- **There is no `csv` target.** A generic sender CSV is a `SENDER_FORMATS` entry, so the
  neutral target here is called `generic_crm`, and it emits the canonical record rather
  than a send-ready shape. "Just give me a CSV I can paste into my sequencer" is
  `/launch`, and refusing it here is the whole point of the namespace being disjoint.
- **This file carries no binding header.** The sender export prepends a comment line
  binding the platform, the list hash and the verdict, and every supported sending tool
  skips a leading comment. A CRM importer does not: it reads line one as the header row,
  so the same trick would break every import. The binding therefore lives in a manifest
  written beside the file. That is weaker — a hand-edited CRM file is detectable only if
  someone reads the manifest — and pretending otherwise would be worse than admitting it.
- **No PASS verdict is required.** There is no send, so requiring
  `/campaign-review` here would be over-application. What *is* required is the
  suppression pass, which runs at write time and cannot be turned off. If the user's plan
  is to import these records and then sequence them from inside the CRM, that is an
  outbound campaign and it needs the review — say so, once, and route.

## What the file contains, what it does not, and the fact that it is PII

**It is PII leaving the pack.** Law 7 covers `gtm/`: gitignored, TTL-swept, erasable by
`/comply erase`. None of that follows the file into a CRM. Once imported, the pack cannot
find those records, cannot expire them and cannot erase them, and a later erase request
has to be executed twice — once here and once by the user, in their CRM. Tell the user
that in the same sentence as the file path, every time.

**In the file** — person-identifying data, by design, because a CRM record without it is
not a record:

- name (first, last, full), business email address, phone number where one was fetched
- job title, seniority, function, LinkedIn profile URL
- employer name, company domain, company LinkedIn URL, industry, size band, location
- `source_endpoint` and `fetched_at` provenance for every row, which
  `_lib/pii.mjs` stamps at fetch time and which the CRM import should land in a custom
  field rather than discard — a record whose origin is unknown cannot be defended later
- a `source` column naming this pack, so the import is attributable in the CRM's own
  reporting

**Not in the file**, deliberately:

- **Suppressed contacts.** Filtered at write time against `gtm/suppression.jsonl`, and
  the count of what was dropped goes in the manifest and the report.
- **Anything the pack inferred.** Only fetched values with an endpoint behind them. A
  guess that lands in a CRM becomes a fact the next person reads.
- **The pack's own state.** No verdicts, no journal lines, no ledger rows, no credit
  costs, no run IDs. Those describe the pack, not the contact, and they are exactly the
  columns that become a permanent mystery in a CRM two years from now.
- **A lawful-basis or consent claim.** This skill has not established one and will not
  imply one by writing a column called `consent`. [`/comply`](../comply/SKILL.md) owns
  that question under `gates.yaml:skills.comply.jurisdictions`.
- **Personal email addresses**, unless they were already in the input because the user
  opted into `find_personal_email` per batch through `/comply`. This skill adds none.

## Inference mode: local, always

**Mode: local inference only. Zero LLM hops.** `ai_enrich` is not in this skill's
endpoint set and this skill's endpoint set is empty.

Deciding that a column called `co_name` is the company name, or that a row's title maps
to a seniority band, is reasoning over text already on disk — and this pack already runs
inside a model that does that at no charge. The local-inference rule permits the paid hop for exactly two
reasons and neither arises. **Perplexity web grounding** answers a question about the
public web; a field mapping is a question about a file. **Batch scale** would mean one
model call per row, and if a mapping needs a model call per row then the mapping is
wrong rather than under-resourced — that is the signal to go back to
[`/crm-sync-expert`](../crm-sync-expert/SKILL.md), not to spend.

## Step 1 — decide the target, the object and the key

Four answers before anything is written, and ask rather than assume:

- **Target** — `hubspot`, `salesforce`, `pipedrive`, `close`, `attio`, or `generic_crm`.
  Anything the pack treats as a sending tool is refused; see the boundary above.
- **Object** — `contacts` (people) or `companies` (accounts). They are different files
  with different dedupe keys, and a CRM that receives one as the other creates a mess
  that takes a day to unpick.
- **Upsert key** — `email` for people, `company_domain` for accounts, in almost every
  case. This is the field the CRM deduplicates on, and a row missing it creates a
  duplicate rather than updating a record.
- **Whose mapping wins.** The built-in default map is a starting point and nothing more.
  Vendor field names and picklists change faster than this file is revised, so where the
  user has run [`/crm-sync-expert`](../crm-sync-expert/SKILL.md), pass its mapping
  document with `MAP=` and it overrides the defaults. Where they have not, say plainly
  that the defaults are unverified against their instance, especially for custom fields.

Then preview the first few projected rows in the conversation before writing anything. A
mapping error is obvious on sight and invisible in a summary.

## Step 2 — canonical first, projection second (this order is not cosmetic)

The suppression filter finds an address by scanning a row's **top-level string values**.
That is why a column called `Email`, `Work Email` or `EMAIL` all work the same. It is
also what makes it blind in two situations this skill would otherwise walk straight into:

- **A projected column name it cannot recognise.** Some targets nest or rename the
  address into a shape whose value is no longer a plain string.
- **A nested row.** An object or an array value is not scanned at all, so a suppressed
  contact inside one is a silent fail-open at the one place law 5 is enforced.

So the order is fixed: **filter the flat canonical rows, then project the survivors.**
Never the reverse. The script below also refuses outright if any input row carries a
nested value, because a row the filter cannot fully read is a row it cannot clear.

## Step 3 — run the export

Run it from the user's project — the pack does not have to be the working directory:

```bash
LIST=gtm/lists/q3-uk.csv OUT=gtm/exports/q3-uk.hubspot.csv \
TARGET=hubspot OBJECT=contacts ROOT=. \
node --input-type=module -e "${GTM_CRM_EXPORT:?set this to the gtm-crm-export script below}"
```

where `$GTM_CRM_EXPORT` is the script below. Write it to a file and run it if that is
easier; it is the same script either way.

```js
// ==== gtm-crm-export v1 ====
// The pack's only writer of a CRM import file. It is NOT a sender export: /launch owns
// that artifact, and this script refuses every target that _lib/sender-export.mjs
// declares to be a sending tool, reading that list at run time so the two can never
// drift apart. Runs from ANY directory — see `PACK` below.
//
// env: LIST    (required) the .csv or .jsonl rows to export
//      OUT      (required) where the import file goes
//      TARGET   (required) hubspot | salesforce | pipedrive | close | attio | generic_crm
//      OBJECT   (default contacts) contacts | companies
//      MAP      (optional) JSON {canonical_field: target_field} from /crm-sync-expert.
//               It WINS over the built-in default map, which is a starting point and
//               never a schema — vendor field names rot faster than this file.
//      ROOT     (default .) the user's project root, the one holding gtm/
//      ALLOW_LOW_COVERAGE  set it to the coverage floor you are knowingly going under
//               ("yes" is not enough) to write a file below
//               gates.yaml:quality_stops.coverage_min_pct. Recorded in the manifest.
//      RICHAPI_PACK_ROOT (where the pack is, when it is neither installed nor here)
//      GATES_FILE (alternate gates.yaml; test seam for the coverage floor itself)
//      NOW      (ISO instant; test seam, so a clock is never implicit)
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
const { filterOutputList, writeOutputList } = await lib('suppression.mjs');
const { SENDER_FORMATS, listContentHash } = await lib('sender-export.mjs');
const { loadGates, gateValue, MissingGateKey } = await lib('gates.mjs');

const LIST   = process.env.LIST;
const OUT    = process.env.OUT;
const TARGET = String(process.env.TARGET || '').trim().toLowerCase();
const OBJECT = String(process.env.OBJECT || 'contacts').trim().toLowerCase();
const ROOT   = path.resolve(process.env.ROOT || '.');
const NOW    = process.env.NOW ? new Date(process.env.NOW) : new Date();

for (const [k, v] of [['LIST', LIST], ['OUT', OUT], ['TARGET', process.env.TARGET]]) {
  if (!v) { console.error('crm-export: ' + k + ' is required'); process.exit(2); }
}

// --- the canonical record ---------------------------------------------------
// One shape in, many shapes out. Everything upstream normalises to this, and the
// suppression filter runs against THIS, before any projection renames a column.
const CANONICAL = [
  'first_name', 'last_name', 'full_name', 'title', 'seniority', 'function',
  'email', 'email_status', 'phone', 'linkedin_url',
  'company_name', 'company_domain', 'company_linkedin_url', 'industry',
  'company_size', 'city', 'country',
  'source_endpoint', 'fetched_at', 'source',
];

// Default maps. Conservative on purpose: the standard fields every instance has, and
// no invented custom-field names. Anything absent from a map is dropped from the file
// rather than guessed into a column the importer will reject.
const TARGETS = {
  hubspot: {
    contacts: { first_name: 'firstname', last_name: 'lastname', email: 'email', phone: 'phone',
      title: 'jobtitle', company_name: 'company', industry: 'industry', city: 'city',
      country: 'country', linkedin_url: 'linkedin_url',
      source_endpoint: 'richapi_source_endpoint', fetched_at: 'richapi_fetched_at', source: 'richapi_source' },
    companies: { company_name: 'name', company_domain: 'domain', industry: 'industry',
      city: 'city', country: 'country', company_linkedin_url: 'linkedin_company_page',
      source_endpoint: 'richapi_source_endpoint', fetched_at: 'richapi_fetched_at', source: 'richapi_source' },
  },
  salesforce: {
    contacts: { first_name: 'FirstName', last_name: 'LastName', email: 'Email', phone: 'Phone',
      title: 'Title', company_name: 'Company', industry: 'Industry', city: 'City',
      country: 'Country', linkedin_url: 'LinkedInURL__c',
      source_endpoint: 'Richapi_Source_Endpoint__c', fetched_at: 'Richapi_Fetched_At__c', source: 'LeadSource' },
    companies: { company_name: 'Name', company_domain: 'Website', industry: 'Industry',
      city: 'BillingCity', country: 'BillingCountry',
      source_endpoint: 'Richapi_Source_Endpoint__c', fetched_at: 'Richapi_Fetched_At__c' },
  },
  pipedrive: {
    contacts: { full_name: 'Name', email: 'Email', phone: 'Phone', title: 'Title',
      company_name: 'Organization', linkedin_url: 'LinkedIn URL',
      source_endpoint: 'Source endpoint', fetched_at: 'Fetched at' },
    companies: { company_name: 'Name', company_domain: 'Domain', industry: 'Industry',
      city: 'City', country: 'Country', source_endpoint: 'Source endpoint', fetched_at: 'Fetched at' },
  },
  close: {
    contacts: { full_name: 'name', email: 'emails', phone: 'phones', title: 'title',
      company_name: 'lead_name', linkedin_url: 'url',
      source_endpoint: 'custom.source_endpoint', fetched_at: 'custom.fetched_at' },
    companies: { company_name: 'display_name', company_domain: 'url', industry: 'custom.industry',
      source_endpoint: 'custom.source_endpoint', fetched_at: 'custom.fetched_at' },
  },
  attio: {
    contacts: { first_name: 'first_name', last_name: 'last_name', email: 'email_addresses',
      phone: 'phone_numbers', title: 'job_title', company_name: 'company',
      linkedin_url: 'linkedin', source_endpoint: 'source_endpoint', fetched_at: 'fetched_at' },
    companies: { company_name: 'name', company_domain: 'domains', industry: 'categories',
      company_linkedin_url: 'linkedin', source_endpoint: 'source_endpoint', fetched_at: 'fetched_at' },
  },
  // The neutral target. NOT called `csv`: that name belongs to SENDER_FORMATS and this
  // namespace is disjoint from it, deliberately. Emits the canonical record unchanged.
  generic_crm: { contacts: null, companies: null },
};

const refusals = [];
const refuse = (code, why, fix) => refusals.push({ code, why, fix });

// --- refusal 1: SENDER_TARGET ----------------------------------------------
// Read from _lib/sender-export.mjs at run time, never copied here. Adding a platform
// to that list makes this skill refuse it the same day, with no edit in this file.
if (Object.prototype.hasOwnProperty.call(SENDER_FORMATS, TARGET)) {
  refuse('SENDER_TARGET',
    '"' + TARGET + '" is a sending tool in _lib/sender-export.mjs, not a CRM object store. '
    + 'A CRM with a sequencer bolted on is a sender, and that list is where the pack records the decision.',
    'Use /launch, which writes the sender export against a PASS verdict bound to the list content hash. '
    + 'If you want CRM records instead, pick a target that is not on that list.');
}

// --- refusal 2: UNKNOWN_TARGET / UNKNOWN_OBJECT -----------------------------
const targetDef = TARGETS[TARGET];
if (!targetDef && refusals.length === 0) {
  refuse('UNKNOWN_TARGET', 'no CRM mapping is defined for "' + TARGET + '".',
    'Pick one of: ' + Object.keys(TARGETS).join(', ') + '. For a target this skill does not know, '
    + 'run /crm-sync-expert and pass its mapping with MAP=, using TARGET=generic_crm.');
}
if (targetDef && !Object.prototype.hasOwnProperty.call(targetDef, OBJECT)) {
  refuse('UNKNOWN_OBJECT', '"' + OBJECT + '" is not an object type for ' + TARGET + '.',
    'Use one of: ' + Object.keys(targetDef).join(', ') + '. People and accounts are different '
    + 'files with different dedupe keys; one imported as the other is a day of cleanup.');
}

// --- read the rows ----------------------------------------------------------
function readRows (file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return parseCsv(text);
}
let rows = [];
if (refusals.length === 0) {
  try { rows = readRows(LIST); }
  catch (e) { console.error('crm-export: cannot read ' + LIST + ': ' + e.message); process.exit(2); }

  // --- refusal 3: NO_ROWS ---------------------------------------------------
  if (rows.length === 0) {
    refuse('NO_ROWS', LIST + ' has no rows.',
      'An empty import file is a silent no-op in every CRM importer. Check the list first.');
  }

  // --- refusal 4: NESTED_ROWS ----------------------------------------------
  // The suppression filter scans top-level STRING values. A nested object or array is
  // invisible to it, so a suppressed contact hidden in one would be a fail-OPEN at the
  // one place law 5 is enforced. A row the filter cannot fully read is not cleared.
  const nested = [];
  rows.forEach((r, i) => {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (v !== null && typeof v === 'object') nested.push('row ' + (i + 1) + ' field "' + k + '"');
    }
  });
  if (nested.length > 0) {
    refuse('NESTED_ROWS',
      'the input carries nested values the suppression filter cannot read: ' + nested.slice(0, 5).join(', ')
      + (nested.length > 5 ? ' (+' + (nested.length - 5) + ' more)' : '') + '.',
      'Flatten the list to one level before exporting — /list-hygiene does this. Nesting happens '
      + 'AFTER the filter in this script, never before it.');
  }
}

if (refusals.length > 0) {
  console.error('REFUSED — nothing was written to ' + OUT);
  for (const r of refusals) {
    console.error('  ' + r.code + ': ' + r.why);
    console.error('    fix: ' + r.fix);
  }
  process.exit(3);
}

// --- suppression, on the CANONICAL rows, before any projection --------------
// filterOutputList() throws SuppressionUnavailableError when the store is missing or
// unreadable. That is a STOP, never "nothing suppressed" (law 5).
let kept, dropped;
try {
  ({ kept, dropped } = filterOutputList(rows, { root: ROOT }));
} catch (e) {
  if (e?.name === 'SuppressionUnavailableError') {
    console.error('REFUSED — nothing was written to ' + OUT);
    console.error('  SUPPRESSION_UNAVAILABLE: ' + e.message);
    console.error('    fix: run `./setup` in the project root. A contact file is never written '
      + 'against a store the pack could not read.');
    process.exit(3);
  }
  throw e;
}

// --- projection, on the survivors only --------------------------------------
let map = targetDef[OBJECT];
if (process.env.MAP) {
  try { map = JSON.parse(fs.readFileSync(process.env.MAP, 'utf8')); }
  catch (e) { console.error('crm-export: cannot read MAP ' + process.env.MAP + ': ' + e.message); process.exit(2); }
}
const project = (row) => {
  if (!map) {
    const o = {};
    for (const f of CANONICAL) if (row[f] !== undefined) o[f] = row[f];
    return o;
  }
  const o = {};
  for (const [canon, field] of Object.entries(map)) {
    if (row[canon] !== undefined && String(row[canon] ?? '').trim() !== '') o[field] = row[canon];
    else o[field] = '';
  }
  return o;
};
const projected = kept.map(project);
const columns = map ? [...new Set(Object.values(map))]
  : [...new Set(projected.flatMap((r) => Object.keys(r)))];

// --- refusal 5: LOW_COVERAGE, BEFORE anything is written --------------------
// A row with no value in the dedupe key does not update a record — it creates a
// duplicate. A live run wrote a contacts file with email coverage of 0%: every row a
// new duplicate, in a system where bad data is permanent and expensive to undo. It
// warned, in a line under the one that said WROTE, and the file was already on disk.
//
// So the floor is a gate, not a note. `quality_stops.coverage_min_pct` is the same key
// /campaign-review stops a list on, and it stops this file for the same reason. A
// floor that cannot be READ is a STOP too (law 5): a gate nobody could evaluate has
// not been passed.
//
// The override exists because "I am importing companies I will enrich next week" is a
// real workflow — but it is explicit, it names the floor it is going under, and it is
// written into the manifest, so the file carries the record of the decision and the
// next person can see what they are importing.
const upsertKey = OBJECT === 'companies' ? 'company_domain' : 'email';
const withKey = kept.filter((r) => String(r[upsertKey] ?? '').trim() !== '').length;
const coveragePct = kept.length === 0 ? 0 : Math.round((withKey / kept.length) * 1000) / 10;
let coverageFloor = null;
let floorError = null;
try { coverageFloor = gateValue(loadGates(process.env.GATES_FILE || undefined), 'quality_stops.coverage_min_pct'); }
catch (e) { if (e instanceof MissingGateKey) floorError = e.message; else throw e; }

const override = String(process.env.ALLOW_LOW_COVERAGE ?? '').trim();
const overrideFloor = override === '' ? null : Number(override);
// The override must NAME the floor it is crossing. A bare "yes" would be a flag
// somebody sets once in a script and never reads again.
const overrideValid = overrideFloor !== null && Number.isFinite(overrideFloor)
  && coverageFloor !== null && overrideFloor === coverageFloor;

// Nothing survived the filter: there is no coverage to measure, and an empty file is
// already reported as what it is. A fraction of zero rows is not 0%, it is no answer.
if (kept.length === 0) {
  // fall through: the empty file and its manifest still get written.
} else if (coverageFloor === null) {
  refuse('COVERAGE_FLOOR_UNREADABLE',
    'gates.yaml:quality_stops.coverage_min_pct did not resolve (' + floorError + '), so the '
    + upsertKey + ' coverage of this file (' + coveragePct + '%) cannot be checked against anything.',
    'Restore the key. A floor that could not be read is a STOP, not "no floor" (law 5).');
} else if (coveragePct < coverageFloor && !overrideValid) {
  const missing = kept.length - withKey;
  refuse('LOW_COVERAGE',
    missing + ' of ' + kept.length + ' row(s) carry no `' + upsertKey + '`, so '
    + upsertKey + ' coverage is ' + coveragePct + '%, under the '
    + coverageFloor + '% floor at gates.yaml:quality_stops.coverage_min_pct. Every row without '
    + 'it creates a duplicate instead of updating a record, and a CRM makes that permanent.',
    'Fill the gaps first — /enrich-waterfall is almost always cheaper than the cleanup. '
    + 'If you mean to import them anyway, say which floor you are going under: '
    + 'ALLOW_LOW_COVERAGE=' + coverageFloor + '. It is recorded in the manifest.'
    + (override === '' ? '' : ' (ALLOW_LOW_COVERAGE="' + override + '" does not name this floor.)'));
}

if (refusals.length > 0) {
  console.error('REFUSED — nothing was written to ' + OUT);
  for (const r of refusals) {
    console.error('  ' + r.code + ': ' + r.why);
    console.error('    fix: ' + r.fix);
  }
  process.exit(3);
}

// --- write, through the ONLY writer that filters ----------------------------
// Deliberately the same call /launch uses for its rows: there is no unfiltered writer
// in this pack, and this script does not become the first one. It runs the filter a
// second time on the projected rows, which must be a no-op; if it is not, the
// projection reintroduced a suppressed identifier and that is worth seeing.
const res = writeOutputList(OUT, projected, { root: ROOT, columns });

// --- the manifest, beside the file, because a CRM importer reads line 1 -----

const manifestPath = OUT + '.manifest.json';
fs.writeFileSync(manifestPath, JSON.stringify({
  schema_version: 1,
  artifact: 'crm_import_file',
  not_a_sender_export: true,
  written_by: 'crm-export',
  written_at: NOW.toISOString(),
  target: TARGET,
  object: OBJECT,
  file: OUT,
  source_list: LIST,
  source_list_hash: listContentHash(rows),
  upsert_key: upsertKey,
  columns,
  rows_in: rows.length,
  rows_written: res.written,
  rows_suppressed: dropped.length,
  upsert_key_coverage_pct: coveragePct,
  coverage_floor_key: 'gates.yaml:quality_stops.coverage_min_pct',
  coverage_floor_pct: coverageFloor,
  // Present and true only when a human went under the floor on purpose. The file
  // carries the record of that decision, because the file is what gets imported.
  coverage_override: overrideValid && coveragePct < coverageFloor,
  contains_pii: true,
  pii_notice: 'This file contains personal data. It leaves gtm/, so it is no longer TTL-swept '
    + 'and no longer reachable by `/comply erase`. An erasure request must be executed twice: '
    + 'once in this pack and once in the destination CRM.',
}, null, 2) + '\n', 'utf8');

console.log('WROTE  ' + res.file);
console.log('  target      ' + TARGET + ' / ' + OBJECT);
console.log('  rows        ' + res.written + ' written, ' + dropped.length + ' suppressed at write time');
if (res.written !== kept.length) {
  console.log('  NOTE        the post-projection filter dropped ' + (kept.length - res.written)
    + ' further row(s) — the projection reintroduced a suppressed identifier');
}
console.log('  upsert key  ' + upsertKey + ' present on ' + coveragePct + '% of written rows'
  + ' (floor ' + coverageFloor + '%)'
  + (overrideValid && coveragePct < coverageFloor
    ? ' — WRITTEN UNDER THE FLOOR on an explicit ALLOW_LOW_COVERAGE, recorded in the manifest' : ''));
console.log('  columns     ' + columns.join(', '));
console.log('  manifest    ' + manifestPath);
console.log('  PII         yes — this file leaves the pack. See the manifest pii_notice.');
// ==== end gtm-crm-export v1 ====
```

## Step 4 — report what left, and what did not

Read the output back, and lead with the two numbers people skip:

- **Rows suppressed at write time.** Somebody unsubscribed and the file is smaller than
  the list. That is the gate working. The user needs to hear it before their CRM tells
  them the row count does not match.
- **Upsert-key coverage.** Rows with no value in the dedupe field do not update anything
  — they create duplicates. This is a **gate, not a warning**: below
  `gates.yaml:quality_stops.coverage_min_pct` the script refuses and writes nothing,
  naming how many rows are missing the key. It used to warn, one line under the one that
  said `WROTE`, and a live run put a contacts file on disk with 0% email coverage — every
  row a new duplicate in a system where bad data is permanent and expensive.
  [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) fills the gaps first, and that is
  almost always cheaper than the cleanup.

  The way past it is `ALLOW_LOW_COVERAGE=<the floor you are crossing>` — the number, not
  "yes", so the override cannot be a flag somebody set once in a script and forgot. It is
  recorded in the manifest as `coverage_override: true`, because the file is what gets
  imported and the next person is entitled to see the decision. Offer it only when the
  user has said what the thin rows are for; do not set it to get past a refusal.

  A floor that does not resolve is a STOP too (law 5): a gate nobody could evaluate has
  not been passed. And when suppression leaves nothing to write, there is no coverage to
  measure — an empty file is reported as an empty file, not as 0%.

Then close with what has and has not happened: the file is at this path, the manifest is
beside it, and **their CRM is unchanged**. This pack has no CRM write endpoint and cannot
observe the result of an import. If you ever report that records were created or updated,
you are guessing.

Finally, say the PII sentence out loud rather than leaving it in the manifest: this file
holds personal data, it is outside the pack's retention and erase sweep now, and a future
erasure request has to be carried out in both places.

## Step 5 — hand the file to the destination

The file exists and the CRM is untouched. That is the correct state, and it is also the
moment the user is most likely to be stuck, so do not stop at the path.

Work the ladder in [`docs/destination-handoff.md`](../../docs/destination-handoff.md),
in order, and stop at the first rung that answers:

1. **An MCP server for this CRM, already available in this session.** Name the tool, and
   say what it would do with *this* file — the object from Step 1, the dedupe key from
   Step 1, the row count and the suppressed count from Step 4. Then ask. An available
   tool is not an instruction to use it.
2. **The CRM's documented import API, or its Postman collection.** Name the specific
   endpoint that takes this object, and the rate limit that will bite at this row count.
   Not a link to a docs homepage.
3. **Neither.** Say so, say what you looked for, and give the manual import path — which
   for every target here is a file upload the user drives. Do not invent an endpoint.

Whichever rung answers, three facts travel with the file and must be repeated, because
the importer will not know them:

- **Suppressed rows were removed at write time.** The count is smaller than the list on
  purpose. If this file is pushed weeks later, suppression has moved on and the honest
  answer is to re-export, not to filter downstream.
- **The upsert key is `<the key from Step 1>`.** A push on the wrong key creates
  duplicates in a system where duplicates are permanent and expensive.
- **This file is PII, outside the pack's erase sweep.** A later erasure request has to be
  carried out in the destination too.

**The pack still does not write.** If the user says go, the write happens through their
MCP or their importer, under their credentials, and this skill has not become a CRM
writer — it has handed over. Never report records as created or updated; report what was
handed over.

## What this skill will not do

- **It will not write a sender export.** That artifact belongs to
  [`/launch`](../launch/SKILL.md) alone, which writes it only against a PASS verdict
  bound to the list's content hash. This skill's targets and the pack's sender list are
  disjoint by construction, checked at run time against `_lib/sender-export.mjs`, and the
  refusal names the route rather than just declining.
- **It will not export to a target the pack has ruled a sending tool**, however
  convincingly the user argues it is really a CRM. That argument belongs in
  `_lib/sender-export.mjs`, once, where both gates can read it.
- **It will not write against an unreadable suppression store.** Missing store, corrupt
  line, unrecognised entry — all STOP, and nothing is written.
- **It will not export a nested row.** A value the suppression filter cannot read is a
  row it cannot clear, and a fail-open there is the one failure this pack exists to
  prevent.
- **It will not sync, upsert or touch a CRM.** No endpoint in this pack writes to one.
  The user's importer does the write, under their credentials.
- **It will not design the mapping.** [`/crm-sync-expert`](../crm-sync-expert/SKILL.md)
  owns dedupe keys, collision rules, custom-field architecture and what a given importer
  silently truncates. The defaults here are a starting point and are labelled as one.
- **It will not spend credits.** It owns no endpoints and makes no paid calls. If a
  column is missing, that is an enrichment question with its own price and its own plan.
- **It will not invent a column.** No inferred seniority, no guessed industry, no derived
  score. Only values with an endpoint and a timestamp behind them.
- **It will not claim a lawful basis.** A CRM import does not inherit one, and writing a
  consent column the pack cannot back would manufacture evidence.
- **It will not clean the list.** [`/list-hygiene`](../list-hygiene/SKILL.md) normalises,
  de-duplicates and flattens, and doing it before the export is the only cheap time.

## Related

- [`/crm-sync-expert`](../crm-sync-expert/SKILL.md) — designs the mapping this skill
  writes; pass its document with `MAP=` and it overrides the defaults
- [`/launch`](../launch/SKILL.md) — the sole writer of the sender-format export, for when
  the destination sends rather than files
- [`/campaign-review`](../campaign-review/SKILL.md) — the verdict an outbound list needs;
  required if the plan is to sequence these records from inside the CRM
- [`/comply`](../comply/SKILL.md) — whether these contacts may be contacted at all, and
  the erase path that a CRM import puts partly out of reach
- [`/list-hygiene`](../list-hygiene/SKILL.md) — normalise, de-duplicate and flatten before
  the export, not after the import
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — fills the upsert key on the rows
  that would otherwise land as duplicates
- [`/pre-meeting-briefing`](../pre-meeting-briefing/SKILL.md) — the other end of the deal
  cycle; what the meeting produced gets filed here
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session receipt
- Every threshold this skill cites, printed with the key it came from: `richapi gates`
