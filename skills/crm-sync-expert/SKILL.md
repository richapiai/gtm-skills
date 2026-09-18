---
name: crm-sync-expert
version: 1.0.0
description: >
  Designs a CRM synchronisation before anyone runs one — which object a row belongs to,
  which key deduplicates it, what wins on a collision, and what the CRM will silently
  truncate, coerce or drop on import. Use when asked "sync this to HubSpot", "push to
  Salesforce", "map these fields", "which dedupe key", "two-way sync", "custom fields
  for enriched data", "lifecycle stage", or "why did my import create duplicates".
  It advises and prepares; it never writes to a CRM, because no endpoint in this pack
  can. (richapi-gtm)
allowed-tools: Bash(richapi:*), Bash(richapi-skills-preflight:*), Bash(node:*), Bash(head:*), Bash(tr:*), Bash(cat:*), Read, Write
triggers:
  - sync this to my crm
  - push to hubspot
  - salesforce integration
  - map these fields for import
  - which dedupe key
  - two way sync
  - crm custom fields
  - why did my import create duplicates
---

# CRM sync — design the mapping, then hand the file over

A botched CRM mapping is not a bug you notice. It is a quarter of enrichment landing in
the wrong column, a picklist that grew a one-off value per import, and a duplicate
population nobody sees until someone runs a report. It costs a day of cleanup at best
and a re-import at worst. This skill exists to make that day not happen.

It is worth being blunt about the shape of the help on offer, because the honest version
is more useful than the flattering one.

## What this skill does, and the one thing it cannot do

**It does not execute a sync.** There is no CRM write endpoint in this pack. Not one
of the endpoints in [`_lib/api-catalog.json`](../../_lib/api-catalog.json) writes to
HubSpot, Salesforce, Pipedrive, GoHighLevel or anything else; every one of them reads.
That is not an oversight this skill is working around.
[`ROADMAP.md`](../../ROADMAP.md#blocked-on-the-api-growing) lists **true two-way
CRM sync execution** under *blocked on the API growing*: the design exists, the endpoint
does not, and the honest word for that is "blocked", not "coming".

So the boundary is hard, and it runs right through the middle of the job:

| The pack does this | Someone else does this |
|---|---|
| Decides the object, the key, the conflict rule | Creates the custom fields in the CRM |
| Names what will truncate, coerce or be rejected | Runs the import, the API job or the iPaaS scenario |
| Prepares the file the importer reads | Confirms the records actually changed |
| Says what a re-run will do to existing records | Owns the undo |

**Never say "synced".** Not in a summary, not in a status line, not in a report. The
words this skill is allowed to use are *mapped*, *prepared*, *planned*, and *handed
off*. A user who reads "synced to HubSpot" and closes the terminal believes their CRM
is current when nothing has been written to it, and every decision they make afterwards
rests on that. It is the single worst outcome available here and it is available for
free, in one careless sentence.

## What it spends

Nothing. This skill owns **no endpoints** —
[`_lib/endpoint-owners.yaml`](../../_lib/endpoint-owners.yaml) assigns it none, which is
correct rather than an omission, because designing a mapping is reasoning over a file
that already exists. It makes zero paid calls, so there is no plan to approve and no
ledger line to read back. Law 3 asks that every paid call be named and costed; naming
none is how that law is satisfied here.

If the mapping turns out to need data the file does not carry, that is an enrichment
question and it belongs to [`/enrich-waterfall`](../enrich-waterfall/SKILL.md), which
will price it. Do not quietly grow this skill a budget.

## Inference mode — local, always

**Mode: local inference only. Zero LLM hops.**

`ai_enrich` is not in this skill's endpoint set. Deciding that a column called
`co_name` is the company name, or that a CRM's `Industry` picklist has no value for
"Vertical SaaS", is reasoning over text already on disk — and this pack already runs
inside a model that does that at no charge. Paying an endpoint to re-read a CSV header
is exactly the waste local inference exists to stop.

The two reasons the pack permits an `ai_enrich` call cannot arise here. **Perplexity web
grounding** does not apply: nothing in a field mapping is a question about the public
web. **Batch scale** does not apply either: a mapping is decided once for a file, not
once per row — if you find yourself wanting a model call per row, the mapping is wrong,
not under-resourced.

## Before anything else

```bash
richapi-skills-preflight
```

- `API_KEY_SET: no` — **not a blocker.** This skill makes no paid call. Say so plainly
  instead of sending the user to find a key they do not need.
- `CATALOG_OK: no` — regenerate with `richapi catalog gen`. You will be reading
  `field_map_status` out of the catalog in step 2, and a stale catalog is the wrong
  answer to a question about what the API actually returns.
- `SUPPRESSION: STOP` — **this one is a blocker for the handoff**, though not for the
  conversation. A CRM is a sending machine with a database attached: once a suppressed
  contact is inside it, the CRM's own workflows will re-sequence them, and the pack's
  suppression store never gets consulted again. Run `./setup` before any file leaves.

## Step 1 — decide which question this actually is

Five different asks arrive wearing the word "sync". They have different right answers
and only one of them is a mapping problem.

| The ask | The right answer |
|---|---|
| One-time load of a prospect list | A file, produced by the pack's export skill, imported by the CRM's own importer |
| Recurring refresh of records the CRM already holds | A scheduled job **outside this pack**, reading a file this skill helped shape |
| React the moment a record changes stage | A webhook from the CRM into whatever the user already runs. The pack is not in this loop |
| Genuine bidirectional sync | An iPaaS or bespoke integration. Not this pack, and not soon — [`ROADMAP.md`](../../ROADMAP.md#blocked-on-the-api-growing) |
| "We have not picked a CRM" | A selection conversation. Ask before you map |

If the user has not said which, ask. Mapping for a one-time import and mapping for a
recurring upsert differ on the only question that matters — what happens the second
time a row arrives.

## Step 2 — derive the mapping from the file, never from a documented schema

This is the rule that most separates this skill from a plausible-sounding one, and it
comes straight out of law 2: **the spec is a cost-and-route source, not a schema
source.**

Check it yourself rather than taking it on trust:

```bash
richapi catalog gen
node -e "const c=require('./_lib/api-catalog.json');
  const s=new Set(Object.values(c.endpoints).map(e=>e.field_map_status));
  console.log([...s]);"
```

`field_map` is `null` for every endpoint in the generated catalog. Most endpoints now
report a `field_map_status` of `keys_from_spec_example` and publish a `field_map_keys`
array — the top-level key NAMES the spec's 200 example declares, nothing more; the rest
report `TODO_no_usable_example`, having no usable example at all. A key list is not a
field map: it says nothing about what a key means, its type, whether it is always
present, or what is nested under it, because the response examples in the spec are
mostly the literal string `example`. Live fixtures have not been captured yet.

The consequence is concrete: **there is no authoritative list of the field names the
API returns**, so a mapping table written from a remembered response shape is fiction
that will pass review and fail at import. Read the actual output file instead:

```bash
head -1 gtm/lists/q3-uk.csv | tr ',' '\n' | cat -n
```

Map from those column names, and record, for every target field, where the source
column came from. A mapping whose left-hand side nobody verified is the same defect as
a hand-typed credit number: it looks authoritative and it is stale on arrival.

The pack's freshness classes are the right anchor for an `*_enriched_at` column:
firmographic data is treated as good for `gates.yaml:cache_ttl.classes.firmographics`,
so a record older than that is a candidate for refresh rather than a fact.

## Step 3 — pick the dedupe key, and write down what a collision does

Every CRM deduplicates, none of them the same way, and the failure is silent in all of
them. Decide two things explicitly and put both in the mapping document.

**The key.** Email is the default in most CRMs and it is a poor stable identifier: it is
the first thing that changes when someone moves job, which is precisely the population a
GTM pack keeps finding. Prefer, in order:

1. An identifier you assign and keep — a row id you control changes never.
2. The LinkedIn URL — changes rarely, and this pack can usually supply one.
3. Email — changes often, and must be lower-cased and trimmed before any comparison.
   `Jane@Acme.com` and `jane@acme.com` are two contacts in every CRM that matters.

**The collision rule.** Name it before the import, not after:

| Rule | Use when |
|---|---|
| `create_only` | First load into an empty object. Fails loudly on an existing key |
| `update_blank_only` | The safe default for enrichment. Fills gaps, never overwrites a human |
| `overwrite` | Only where the pack is the acknowledged system of record for that field |
| `append` | Multi-value fields, and only where the CRM actually supports it |

`update_blank_only` is the default this skill recommends because the alternative failure
is unrecoverable: overwriting a rep's hand-typed job title with a stale enriched one
destroys the better value and leaves no trace that it happened.

A note on the direction nobody plans for: the same file imported twice with
`create_only` produces duplicates, and with `overwrite` produces a silent rollback of
every edit made since the first import. Ask what the second run is meant to do.

## Step 4 — name what the CRM will silently damage

Rejections are the good case; the user sees them. These are the ones that succeed:

- **Picklist values outside the defined set.** Depending on the CRM, an unknown value
  is dropped, coerced, or added — and "added" is how a picklist reaches four hundred
  values. Constrain to a fixed set. Where the field is a search taxonomy the API also
  uses, [`_lib/filters-catalog.json`](../../_lib/filters-catalog.json) holds the real
  label sets for seniority, function and company size; use those rather than inventing
  parallel ones.
- **Text length caps.** Long fields (headline, summary, description) are truncated at
  the field's limit without a warning. Decide what gets truncated deliberately.
- **The pack's explicit nulls.** This pack has exactly one way to say "no value":
  `not_found`, `not_verifiable`, `not_applicable`, defined in
  [`_lib/dual-contract.schema.json`](../../_lib/dual-contract.schema.json). A CRM has no
  such vocabulary. **Never let those strings reach a CRM text field** — that is how
  `not_found` becomes four hundred people's job title and then shows up in a merge tag.
  Decide per field: either the cell is blank, or you create a real picklist value that
  means the same thing. The mapping document must say which, for every field.
- **Type coercion.** A string `"false"` is truthy on import in more places than it
  should be; a leading `+` on a phone number is eaten by a spreadsheet before the CRM
  ever sees it; leading zeros vanish from postcodes the same way. If a file passes
  through a spreadsheet between here and the CRM, assume all three happened.
- **Display name versus internal name.** Most import failures are this. The CRM's import
  mapper wants the internal API name, and the column header the user is looking at is
  the label. Confirm which one the importer reads before blaming the data.
- **Character encoding.** A UTF-8 byte-order mark in the first header cell makes the
  first column unmappable in several importers, and the error message never mentions it.

## Step 5 — the object model, and only the parts that do not rot

Structural facts about a CRM's object model are stable and worth stating. Rate limits,
API versions, plan tiers and pricing are **not**, and this skill does not state them
from memory — that is the same failure mode law 1 was written for, one abstraction up.
Sixteen of fifty-three surviving endpoints in this pack's own API repriced in four
months; a third party's rate limit is no more durable than that.

- **HubSpot** — Contacts (person), Companies (organisation), Deals, Tickets.
  Associations are first-class and labelled. Contact dedupe is native on email; a
  contact with no email will duplicate.
- **Salesforce** — Lead is pre-qualification and converts, **irreversibly**, into
  Contact plus Account plus Opportunity. A Lead and a Contact with the same email may
  coexist by design, which is where most "dedupe is broken" reports come from. Dedupe is
  rule-based, not field-based. Custom field *type* cannot be changed once records exist,
  so pick the end-state type on day one.
- **Pipedrive** — Person, Organization, Deal. Deliberately shallow, and that is a
  feature for a sales-only team.
- **GoHighLevel** — Contacts live inside a sub-account and there is no Company object.
  Company data is custom fields on the contact and tags are the primary segmentation.
  Do not model it like HubSpot; it will not hold.

For anything version-specific — limits, endpoint shapes, which auth flow is current —
tell the user to read the vendor's current documentation. Saying "check the docs" is a
worse answer than a confident number only if the confident number is right.

## Step 6 — write the mapping document, then hand off

The artifact this skill produces is a mapping document, not a synchronised CRM. Write it
where the user can commit it, and give every row four columns: **target field, source
column, transform, collision rule.** Add a fifth for the explicit-null decision.

Then hand off honestly:

- The file itself is written by [`/crm-export`](../crm-export/SKILL.md), which is the
  sole writer of that artifact. Hand it the mapping document — that skill reads it as
  `MAP=` and it overrides the built-in defaults, which are explicitly unverified against
  any particular CRM instance. This skill does not write the file and neither should you
  improvise one: a second writer is how two files with the same name disagree.
- A contact list bound for a **sender** is a different artifact with a different gate.
  Only [`/launch`](../launch/SKILL.md) writes that one, and only against a PASS verdict
  from [`/campaign-review`](../campaign-review/SKILL.md).
- Before anything leaves, [`/comply`](../comply/SKILL.md) decides whether these contacts
  may be contacted at all, under the regimes in `gates.yaml:skills.comply.jurisdictions`.
  A CRM import that bypasses that gate re-arms every contact in it.
- If coverage on the list is below `gates.yaml:quality_stops.coverage_min_pct`, syncing
  it imports the gaps too. Fix the list first; a CRM makes bad data permanent and
  expensive.

Close by telling the user exactly what has and has not happened: the mapping is decided,
the document is at this path, and their CRM is unchanged.

## Step 7 — find the path that will actually run the sync

The mapping document is the deliverable and it is inert. Before closing, find out what
the user has to execute it with, using the ladder in
[`docs/destination-handoff.md`](../../docs/destination-handoff.md):

1. **An MCP server for this CRM in this session.** Name it, and check the mapping against
   what it can actually express — if the design needs a custom field the MCP cannot
   create, that is a finding, and it belongs in the document rather than in a message
   that scrolls away.
2. **The CRM's API docs or Postman collection.** Confirm the object, the upsert semantics
   and the field types the design assumes. A mapping derived from the file and never
   checked against the destination's real schema is the defect this skill exists to
   prevent, one level out.
3. **Neither.** Say what you looked for and design for the file-import path, which is the
   conservative assumption anyway.

Record the answer in the mapping document under the destination, because the next person
to run this sync needs to know whether an integration exists before they plan around one.

**This does not make the skill a sync runner.** It designs the sync and names the path;
the user executes it under their own credentials. `ROADMAP.md` puts two-way sync
permanently out of scope and that is unchanged.

## What this skill will not do

- **It will not sync anything.** There is no CRM write endpoint in this pack and there
  is not going to be one soon. [`ROADMAP.md`](../../ROADMAP.md#blocked-on-the-api-growing)
  lists true two-way CRM sync execution as *blocked on the API growing* — a design with
  no endpoint under it. Every write is performed by the user, their CRM's importer, or
  an integration platform they own. A report from this skill claiming any record was
  created or changed would be a fabrication: it cannot observe the CRM at all, so it
  has nothing to report.
- **It will not write the import file.** That artifact belongs to
  [`/crm-export`](../crm-export/SKILL.md), which suppression-filters at write time and
  ships a manifest. One writer per artifact, or the reviews attached to it are advice.
- **It will not write a sender export.** That is [`/launch`](../launch/SKILL.md)'s alone,
  gated on a PASS verdict bound to the list's content hash.
- **It will not clear a contact for contact.** [`/comply`](../comply/SKILL.md) is the
  gate; a mapping that routes a suppressed contact into a CRM has defeated it.
- **It will not spend credits.** It owns no endpoints and makes no paid calls.
- **It will not quote a rate limit, API version or price from memory.** Those rot faster
  than this file is revised, and a confidently wrong limit is worse than no limit.
- **It will not assert a response field name the pack cannot verify.** `field_map` is
  `null` for every endpoint, and no endpoint has a live-captured fixture; the mapping
  comes from the file on disk, or it is guesswork with a table around it.
- **It will not send, dial, post to LinkedIn, or host an inbox.** Those are outside this
  pack permanently, not pending.

## Related

- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — fills the columns a mapping
  turns out to need, with a dry-run plan and a per-hop cost
- [`/list-hygiene`](../list-hygiene/SKILL.md) — normalises and de-duplicates **before**
  the import, which is the only cheap time to do it
- [`/comply`](../comply/SKILL.md) — the gate that decides whether these contacts may be
  contacted; a CRM import does not inherit its verdict
- [`/campaign-review`](../campaign-review/SKILL.md) — the verdict a list needs before any
  outbound artifact is written
- [`/launch`](../launch/SKILL.md) — the sole writer of the sender-format export, for when
  the destination is a sending tool rather than a CRM
- [`/outreach-expert`](../outreach-expert/SKILL.md) — the sending-side counterpart:
  domain, deliverability and sequence hygiene, also advisory
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router and the session receipt
- [`/crm-export`](../crm-export/SKILL.md) — writes the import file this mapping
  describes, and reads the mapping document as `MAP=`
- What is built, what is not, and what is blocked: [`../../ROADMAP.md`](../../ROADMAP.md)
