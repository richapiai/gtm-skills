---
name: comply
version: 1.0.0
description: >
  The hard compliance gate. Resolves the jurisdiction of every contact, clears a lawful
  basis under GDPR, CCPA/CPRA or CASL before anything is contacted, runs the fail-closed
  suppression check, enforces retention, and executes erasure requests. Writes a
  compliance verdict bound to the list's content hash; /campaign-review reads it and
  FAILs without a live PASS, so /launch cannot export a list this skill stopped. Use
  when asked "is this list safe to send", "can I email this contact", "delete this
  person's data", "right to be forgotten", "GDPR", "CCPA", "CASL", "do not contact", or
  before any launch. Proactively invoke before any review or export step — this skill
  can stop a run, and a run it did not clear is not cleared. (richapi-gtm)
allowed-tools: Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write
triggers:
  - is this list safe to send
  - can i email this contact
  - delete this person's data
  - right to be forgotten
  - erase this contact
  - gdpr
  - ccpa
  - casl
  - do not contact
  - compliance check
---

# Compliance — the gate

This skill is a **gate, not advice**, and the thing that makes that sentence true is a
file. It returns one of three verdicts per row (`allow`, `confirm`, `stop`), and it
writes them into a **compliance verdict** bound to the list's content hash.
[`/campaign-review`](../campaign-review/SKILL.md) reads that file and FAILs the list
without a live PASS from it, and [`/launch`](../launch/SKILL.md) writes no export
against a FAIL. A `stop` therefore ends the run for the rows it names *mechanically*,
not by persuasion. Nothing downstream may reinterpret a `stop` as a warning, and no
other skill may clear a contact this one refused.

You are the person who has watched a sending domain get blacklisted, and then watched
the legal follow-up cost more than the campaign earned. You do not guess at a lawful
basis. When the record does not say, you return the explicit null and refuse — an
unanswerable check is a failed check, never a passing one.

**This skill is not legal advice.** It enforces a rule table the pack ships. A regulator
reads the statute, not this file.

## Before anything else

```bash
richapi-skills-preflight
```

Two keys decide whether this skill can run at all:

- `SUPPRESSION: STOP` — there is no readable suppression store. **Stop.** A suppression
  check that could not run is not a passing suppression check (law 5). Fix it by running
  `./setup --root <the user's project>` **from the pack checkout** — `setup` lives in the
  pack root, not in the project, so a bare `./setup` only works when the two are the same
  directory. Never hand-create `gtm/suppression.jsonl` instead: `setup` is also what writes
  `gtm/` into `.gitignore` and what refuses to run where `gtm/` is already git-tracked
  (law 7). Do not screen a list against a store you could not open, and do not report
  "nothing suppressed" — that is the failure this key exists to catch.
- `CATALOG_OK: no` — retention classes resolve through the catalog's capability groups.
  Without it every endpoint falls to the shortest TTL, which is safe but wasteful.
  Regenerate with `richapi catalog gen`.

`API_KEY_SET: no` is not a blocker. This skill makes **zero** paid calls.

## Step 1 — resolve the jurisdiction

The jurisdiction of a contact is the **data subject's** location. It is not the
company's headquarters, not the sender's location, and not the domain's registrar.

Read the signals in the order the gate table gives, and record which one answered. Every
regime that matches applies — a contact in Ireland whose employer is a California
company is subject to both, and each rule set must clear independently.

**An unresolved jurisdiction is a refusal.** The verdict is `stop` and the jurisdiction
is reported as the explicit null `not_found`. Say this out loud to the user rather than
quietly dropping the row:

> 3 of 40 rows carry no country, region, phone country code or recognisable domain. I
> cannot tell which regime applies to them, so they are refused, not sent. Add a country
> column or drop them.

The regimes this skill has rule sets for are exactly
`gates.yaml:skills.comply.jurisdictions`. A jurisdiction that resolves but has **no rule
set** is also a refusal — "we wrote no rules for this place" is not a finding that the
place has no rules. That is the difference between a gate and a rubber stamp. So a row
in, say, Japan refuses with `no_rule_set` until a rule set for it ships; adding one is a
change to the gate table and to `gates.yaml:skills.comply.jurisdictions`, not a
judgement call made at run time.

**Those two refusals are not the same refusal, and they were reported as one.** A row
that states no country at all is `unknown_jurisdiction`, and the fix is a column. A row
that states a country this pack has no rules for is `no_rule_set:<code>`, and the fix is
never a column — it already has one. Until this was split, a Seattle row carrying
`US`/`US-WA` was told to "add `subject_country`", which the operator had no way to
satisfy, because **there was no US rule set outside California**.

**The United States now resolves.** `can_spam` is the federal floor and applies to every
US row; `ccpa` applies on top of it where `subject_region` is `US-CA`. `on_conflict:
all_apply` means a Californian must clear both, so CCPA never reads as a replacement for
CAN-SPAM. CAN-SPAM is an **opt-out** regime: it asks no consent question before a
commercial message (the basis is `not_applicable`, exactly as under CCPA), but it does
require a working unsubscribe and a valid physical postal address in the message
(15 U.S.C. 7704(a)(5)), so a US row with no `sender_postal_address` column stops. That
is a precondition, not an opt-out: fill the column and it clears.

An ISO 3166-2 code names its country in its own prefix, so a row carrying only
`subject_region: US-WA` resolves to the US. Nothing else is derived from a subdivision:
a state outside California adds no rule set of its own, whatever state privacy statute
that state has passed, because this pack ships no rule set for it.

One trap worth naming, because it silently mislabels a whole column: country codes are
ISO 3166-1 alpha-2, so `CA` is **Canada**. California is the ISO 3166-2 subdivision
`US-CA` and belongs in `subject_region`. A California list tagged `CA` in the country
column is read as Canadian and screened against CASL.

## Step 1a — when the only location you have is free text

The detection order above reads ISO codes. The pack's enrichment does not produce
any. `enrich_profile` publishes a free-text `location` — "Berlin, Germany", "Greater
London Area", "San Francisco Bay Area", "Remote" — so a normal prospect list of names,
companies and LinkedIn URLs resolves nothing, and enriching it resolves nothing either.
Every row lands on `unresolved`, stops, and the operator discovers that *after* the
credits were spent. That is a paperwork gap dressed up as a compliance failure.

`_lib/jurisdiction.mjs` is the hop between the two. It maps free text to an ISO 3166-1
alpha-2 country (plus the ISO 3166-2 subdivision when the text pins one) from a local
table. No network hop, no endpoint, no credit, same answer every time.

**It reads the columns the pack actually writes.** `enrich_profile` and the bulk path
land a country **NAME** in `location_country` ("United States", not `US`) plus
`location_state`, `location_city` and the free-text `location`
(`_lib/client.mjs:RESPONSE_MAPS`, recorded in `tests/fixtures/live/enrich_profile.json`).
Until this hop read them, a list you had just paid to enrich still resolved nothing and
every row stopped, and the fix was hand-mapping a column the enrichment had filled. It
now reads, best first: `subject_country`, `subject_region`, `location_country`,
`country`, `location_state`, then the free-text fields.

**A column whose header names a country may also state an ISO code outright.** `CA` in
`subject_country` is Canada, because the column says the value is a country and the gate
table already reads it that way. That relaxation stops at the column edge: `CA` in
`location`, in `city` or in `location_state` still resolves nothing, because there it is
a state abbreviation just as plausibly. A region column is read only in full ISO 3166-2
form (`US-WA`, never `WA`), and an unrecognised value in either is `not_found` with the
fix that fits *that* column, not a generic "add a country column".

**It is not part of the gate, and it never decides a regime.** It proposes values for
the `subject_country` and `subject_region` columns the table above already detects on;
detection then runs exactly as it did before. A row it cannot resolve is left exactly as
it was, so `unresolved_verdict: stop` still applies to it, untouched.

Run it before detection, and read the confidence:

| the string named | example | it returns | confidence | what you do |
|---|---|---|---|---|
| the country | `Berlin, Germany` | `DE` + `DE-BE` | 0.99 | write the columns, re-run detection |
| a region assigned to exactly one country | `Greater London Area, United Kingdom`, `Los Angeles, California` | `GB` + `GB-LND` | 0.95 | write the columns, re-run detection |
| a city the table believes is unique | `Munich` | `DE` | 0.85 | **offer it, do not write it** — a human confirms |
| a name that exists in several countries | `London`, `Georgia`, `Ontario`, `Paris` | `not_verifiable` | 0 | leave the row unresolved; print the candidates |
| a metropolitan area naming no country | `San Francisco Bay Area` | `not_verifiable` | 0 | leave the row unresolved |
| a multi-country region | `EMEA`, `European Union` | `not_verifiable` | 0 | leave the row unresolved |
| not a place at all | `Remote` | `not_applicable` | 0 | leave the row unresolved |
| anything else | `Sunnyvale`, `Kyiv, Ukraine` | `not_found` | 0 | leave the row unresolved |

The dividing line is the **autofill floor**, exported as `AUTOFILL_MIN_CONFIDENCE`: the
country and region tiers sit on or above it and may be written unattended; the city tier
sits below it and may not. The city table is the least trustworthy of the three, so even
a wrong entry in it cannot silently populate a country column — it can only be shown to
a person.

```js
import { resolveLocation, proposeSubjectColumns } from '../../_lib/jurisdiction.mjs';

resolveLocation('Berlin, Germany', { field: 'location' });
// { result: { country: 'DE', region: 'DE-BE', confidence_basis: 'country_name',
//             evidence: [{ kind: 'country_name', matched: 'Germany', part: 'Germany',
//                          part_index: 1, maps_to: 'DE', field: 'location' }] },
//   confidence: 0.99, reasoning: '...', source: 'jurisdiction-table v1 ... <- location' }

resolveLocation('London', { field: 'location' });
// { result: 'not_verifiable', confidence: 0, reasoning: '"London" exists in more than one
//   country (CA-ON, GB, US-OH) and nothing else in the string pins one...', source: '...' }

const p = proposeSubjectColumns(row);      // reads location, subject_location, city, ...
if (p.apply) Object.assign(row, p.columns); // only at or above the autofill floor
```

Every answer is a dual contract — `result` / `confidence` / `reasoning` / `source`, with
the same explicit-null enum this skill uses everywhere else. Nothing it returns is
`ai_inferred`: there is no model in the path, only the table. Every resolution carries
the evidence that produced it — which input field, which token in it, which part of the
string — so "why is this subject GDPR" has a written answer.

**What it refuses to resolve, on purpose:**

- **Two-letter tokens, always.** `San Francisco, CA` resolves nothing. `CA` is Canada as
  an ISO 3166-1 alpha-2 code and California as a US state abbreviation — the exact trap
  named above — and free text does not say which. `UK` and `USA` are the named
  exceptions; they collide with no subdivision abbreviation.
- **US and Canadian cities by name.** American place names are borrowed from Europe, so
  a bare US city name is the likeliest way to mislabel a European subject. A North
  American subject is pinned by a state, a province or a country token, or not at all.
- **Countries outside its stated table.** It carries the 31 countries in the `gdpr` list
  above, `CA`, `US`, and CH, AU, NZ, IN, SG, ZA. Everything else returns the explicit
  null. The boundary is written in the module header; read it before trusting a null.
- **Contradictions.** `Vancouver, Canada / London, United Kingdom` names two countries
  and `London, Germany` names an impossible pair. Both refuse rather than pick a half.
- **A regime.** It returns ISO codes. Whether those codes mean GDPR, CCPA or CASL is the
  gate table's decision and stays there.

A wrong country is far worse than an unresolved one: an unresolved row stops and the
operator fixes it, while a row mislabelled `US` skips GDPR silently and nobody finds
out. Every judgement call in that module is biased accordingly, and
`tests/compliance/jurisdiction.test.mjs` asserts it — including that no GDPR country is ever
resolved to a non-GDPR one.

## Step 1b — name the channel, because a verdict is per channel

**A clearance is not a property of a list. It is a property of a list *and a channel*.**
Until this was split, it was neither: every run was implicitly an email run, so the
CAN-SPAM preconditions — a working unsubscribe, a valid physical postal address
(15 U.S.C. 7704(a)(5)) — fired on lists that carry **no email column at all**. A maps
listing gives a name, an address and a phone number; the honest deliverable is a call
list, and a call list could never clear, because it was being asked for the footer of an
email nobody was going to send. The operator had nothing to fix.

So the caller states the channel, and the verdict names the channel it clears:

```bash
CHANNEL=phone LIST=gtm/lists/local/dentists-austin.csv ROOT=. \
node --input-type=module -e "${GTM_COMPLY:?set this to the gtm-comply script below}"
```

| `CHANNEL` | what it means | default |
|---|---|---|
| `email` | a commercial email message | **yes** — an unset CHANNEL is an email run |
| `phone` | a call to the number on the row | |
| `linkedin` | a LinkedIn message, which is a CEM like an email | |
| `mixed` | **every** channel in the table, all preconditions in play | |

`mixed` is deliberately the strictest reading and never a weaker one. A list carrying
both emails and phone numbers has to clear both sets of preconditions, because the
alternative (scoping `mixed` to whichever channels a row happens to carry) would let
an empty column be the thing that skips a rule.

Two mechanisms do the work, and both fail closed:

1. **A rule set governs the channels it names**, in its own `channels:` key. `can_spam`
   names `[email]` only, because CAN-SPAM is an e-mail statute top to bottom. `casl`
   names `[email, linkedin]` — a LinkedIn message is a commercial electronic message
   and a voice call is not. `gdpr` and `ccpa` name all three: they govern the
   *processing*, not the medium, so calling a German prospect still needs a lawful
   basis. A rule set that names **no** channels governs none of them.
2. **A refusal condition applies to the channels `channel_conditions` names**, and to
   every channel when it names none. `no_physical_postal_address` is `[email]`.
   `no_unsubscribe_mechanism` is `[email, linkedin]`. Everything else — suppression, an
   objection, an undisclosed source, a CCPA notice — is a fact about the record and
   applies to every channel.

**A channel nothing governs is a refusal, not a clearance.** A US row on `phone` matches
`can_spam`, which governs email, and no other rule set matches it — so it stops with
`no_rule_set_for_channel:phone`. That is the honest answer: **this pack ships no TCPA,
DNC or telemarketing rule set**, and "we wrote no rules for calling" is not a finding
that calling is unregulated. The same refusal that protects a Japanese row protects a US
call list. A German row on `phone` does clear, because GDPR governs the call.

**Downstream reads the channel or it reads nothing.**
[`/campaign-review`](../campaign-review/SKILL.md) checks the channel it is reviewing
against the verdict's `channels`, and [`/launch`](../launch/SKILL.md) writes an **email
sender export**, so it requires `email` among them. A phone clearance therefore cannot
produce a sender file by any route, and a list can be cleared for `phone` while `email`
stays blocked on a missing postal address. That is the intended state, not a
contradiction: it says the call list is ready and the email list is not.

## Step 2 — clear the lawful basis

Run every matched rule set. A rule set clears only when both hold:

1. The row names an **accepted basis** for that regime *and* carries every piece of
   evidence that basis requires. A basis with no stored record is `not_found` — never
   "probably legitimate interest".
2. **No refusal condition fires.** Refusal conditions are computed from the row, never
   asserted by the model. A condition that cannot be computed counts as fired.

One refusal from one matched regime is a refusal overall.

## The gate table

This block is the gate. The evals under `tests/evals/comply/` run adversarial fixtures
through this exact table, one file per jurisdiction, and assert the verdict or the
explicit-null enum value. Editing a verdict here changes the gate and turns the evals
red if the edit fails open.

```yaml comply-rules
schema_version: 1

verdicts: [allow, confirm, stop]
null_enum: [not_found, not_verifiable, not_applicable]

# Law 5. Anything this table does not enumerate is a refusal.
default_verdict: stop
no_rule_set_verdict: stop

# A verdict is per CHANNEL. See "Step 1b" above for why: CAN-SPAM's postal-address
# precondition is a rule about a commercial EMAIL, and it was firing on lists with no
# email on them at all, so a phone list could never clear anything.
channels: [email, phone, linkedin]
default_channel: email
# Every channel in play must be governed by a matched rule set. A channel nothing
# governs is `no_rule_set_for_channel` — a refusal, never a quiet clearance. This is
# what stops a US phone list reading as "CAN-SPAM, nothing to check" when the pack
# ships no TCPA/DNC rule set at all.
ungoverned_channel_verdict: stop
# A refusal condition named here fires only when one of its channels is in play.
# Anything NOT named here applies to every channel, so a new condition is scoped to
# all channels until somebody says otherwise (law 5).
channel_conditions:
  # 15 U.S.C. 7704(a)(5): a physical postal address in every commercial e-mail message.
  no_physical_postal_address: [email]
  # A working opt-out in the MESSAGE. A phone call is not a message with a footer in it.
  no_unsubscribe_mechanism: [email, linkedin]
  # "Is this address a personal inbox" is not a question a phone list can answer.
  personal_inbox_without_consent: [email]

detection:
  # `declared` is an operator-stated regime and is authoritative, including when it
  # names one this pack has no rule set for. The rest read the DATA SUBJECT, not
  # the company. Country codes are ISO 3166-1 alpha-2, so CA is Canada; California
  # is the ISO 3166-2 subdivision US-CA and belongs in subject_region.
  order: [declared, subject_region, subject_country, phone_country,
          company_hq_country, email_tld]
  # A conflict is not resolved by picking a winner. Every matched rule set must
  # clear independently, and one refusal is a refusal.
  on_conflict: all_apply
  unresolved_verdict: stop
  unresolved_jurisdiction: not_found
  # An ISO 3166-2 code names its country in its own prefix, so US-WA is read as a
  # US row as well as a Washington one. A row that carries only a subdivision is
  # not an unlocatable row, and telling its operator to "add a subject_country"
  # was the fix message that sent a Seattle list back with nothing left to add.
  subdivision_implies_country: true
  subdivisions:
    US-CA: ccpa
  countries:
    gdpr: [AT, BE, BG, HR, CY, CZ, DK, EE, ES, FI, FR, DE, GR, HU, IE, IS, IT, LI,
           LT, LU, LV, MT, NL, NO, PL, PT, RO, SE, SI, SK, GB]
    casl: [CA]
    # CAN-SPAM is the federal floor for every US state. California adds CCPA/CPRA
    # through the subdivision above, and `all_apply` means both must clear.
    can_spam: [US]
  tlds:
    gdpr: ['.de', '.fr', '.ie', '.nl', '.es', '.it', '.se', '.pl', '.eu', '.co.uk']
    casl: ['.ca']
    can_spam: ['.us']

# An address here is a personal inbox whatever the row's own label claims.
personal_inbox_domains: [gmail.com, googlemail.com, yahoo.com, hotmail.com,
  outlook.com, live.com, icloud.com, me.com, aol.com, proton.me, protonmail.com,
  gmx.de, web.de, orange.fr, free.fr, mail.ru, yandex.ru]

jurisdictions:
  gdpr:
    # GDPR governs the PROCESSING, not the medium, so every channel it is matched on
    # is governed by it: calling a German prospect needs a lawful basis too.
    channels: [email, phone, linkedin]
    citation: >-
      GDPR Art. 6 lawful basis; Art. 14 notice when data was not obtained from the
      subject; Art. 21 right to object; PECR reg. 22 for marketing to an individual
      subscriber.
    basis_field: lawful_basis
    accepted_basis: [consent, legitimate_interest]
    evidence_required:
      consent: [consent_record_id, consent_timestamp]
      legitimate_interest: [lia_record_id, data_source]
    refuse_when: [suppressed, objection_recorded, source_undisclosed,
                  personal_inbox_without_consent, no_unsubscribe_mechanism]

  ccpa:
    # Same reason as GDPR: notice, sale opt-out and sensitive PI are facts about the
    # record, not about the medium it is used down.
    channels: [email, phone, linkedin]
    citation: >-
      CCPA/CPRA Sec. 1798.100 notice at collection; Sec. 1798.105 deletion;
      Sec. 1798.120 right to opt out of sale or sharing; Sec. 1798.121 limits on
      sensitive personal information.
    # CCPA is not a consent regime for business email. The basis question does not
    # apply, and is answered with the explicit null rather than an invented basis.
    basis_field: null
    accepted_basis: []
    absent_basis_is: not_applicable
    refuse_when: [suppressed, notice_at_collection_missing, opt_out_of_sale_recorded,
                  sensitive_pi_without_notice, no_unsubscribe_mechanism]

  can_spam:
    # CAN-SPAM is an E-MAIL statute, top to bottom. It governs no other channel, and
    # saying it does was how a call list inherited a postal-address precondition. A US
    # phone row therefore has NO rule set here and stops on
    # `no_rule_set_for_channel:phone` — this pack ships no TCPA or DNC rule set, and
    # "we wrote no rules for this" is not a finding that there are none.
    channels: [email]
    citation: >-
      CAN-SPAM 15 U.S.C. 7704(a)(3) a working opt-out honoured for at least 30 days
      after the message; 7704(a)(5) a valid physical postal address in every
      commercial message; 16 CFR 316.5 forbids charging a fee, or requiring anything
      beyond an email address and an internet page, to opt out.
    # CAN-SPAM is an opt-out regime, not a consent one: no lawful basis is asked for
    # before a commercial message, so the basis question is answered with the
    # explicit null rather than a basis borrowed from GDPR.
    basis_field: null
    accepted_basis: []
    absent_basis_is: not_applicable
    refuse_when: [suppressed, objection_recorded, no_unsubscribe_mechanism,
                  no_physical_postal_address]

  casl:
    # CASL governs a commercial ELECTRONIC MESSAGE — email and a LinkedIn message are
    # both CEMs; a voice call is not one, and Canadian telemarketing sits under rules
    # this pack does not ship.
    channels: [email, linkedin]
    citation: >-
      CASL s.6(2) sender identification and a working unsubscribe; s.10(9)(a) implied
      consent from an existing business relationship; s.10(9)(b) conspicuously
      published address, which is void where the publication refuses such messages.
    basis_field: consent_kind
    accepted_basis: [express, implied]
    evidence_required:
      express: [consent_record_id, consent_timestamp]
      implied: [consent_event, consent_timestamp]
    implied_consent_windows:
      transaction: {months: 24}
      inquiry: {months: 6}
      published_address: none
    refuse_when: [suppressed, objection_recorded, implied_consent_expired,
                  published_address_refuses_cem, role_irrelevant,
                  no_unsubscribe_mechanism]

# Computed from the row. A fact that cannot be computed is TRUE when it is a
# refusal condition — an unanswerable check is a failed check.
facts:
  suppressed: the suppression engine matched this row
  objection_recorded: objection is true
  source_undisclosed: data_source is missing or empty
  personal_inbox_without_consent: the address is a personal inbox and the basis is not consent
  no_unsubscribe_mechanism: unsubscribe_mechanism is not true
  no_physical_postal_address: sender_postal_address is missing or empty
  notice_at_collection_missing: notice_at_collection is not true
  opt_out_of_sale_recorded: opt_out_sale is true
  sensitive_pi_without_notice: sensitive_pi is true and sensitive_pi_notice is not true
  implied_consent_expired: consent_kind is implied and consent_timestamp is older than the window for consent_event
  published_address_refuses_cem: consent_event is published_address and published_address_refuses_cem is true
  role_irrelevant: consent_event is published_address and role_relevant is not true
```

Statutory periods worth knowing while reading that table, none of which this pack sets:
CASL s.10(9)(a) expires implied consent 2 years after a transaction and 6 months after
an inquiry. CASL requires an unsubscribe mechanism to stay working for at least 60 days
after the message. GDPR Article 12 gives a controller 30 days to answer a data-subject
request. CCPA Sec. 1798.105 requires a verified deletion request be honoured within 45
days. CASL's limitation period is 3 years, which is the floor for keeping consent
records.

## Two kinds of refusal, and only one of them is permanent

Every `stop` above is a refusal, but they are not the same kind of thing, and treating
them as one is the most expensive mistake available here.

**A precondition failure is the operator's paperwork.** `source_undisclosed` means
nobody filled in a `data_source` column. `no_unsubscribe_mechanism` means the sequence
does not carry an unsubscribe link yet. `evidence_missing:lia_record_id` means the
legitimate-interest assessment exists in a filing cabinet and not in the CSV. None of
those is the contact saying anything. They **block this run** and nothing more: fix the
record, run this skill again, and the row clears. Nothing about the contact is written
anywhere, and no future run is affected.

**An opt-out is the contact.** `objection_recorded` is a data subject exercising GDPR
Art. 21, and it does not stop being true when the list is re-imported next quarter. That
belongs in the suppression store — which is append-only and has no un-suppress path
anywhere in this pack, deliberately. Nothing here removes an entry, and this skill will
not offer to.

So the two categories go to two different places, and never to each other's:

| Category | What it means | Where it goes | Reversible |
|---|---|---|---|
| `precondition` | a column this gate needs is missing or false | this run's verdict only | yes — fix the record, run again |
| `unresolved` | no signal resolves the data subject's jurisdiction (`unknown_jurisdiction`), or one does and this pack ships no rule set for it (`no_rule_set:<code>`) | this run's verdict only | `unknown_jurisdiction`: add a country or region column, or let Step 1a derive one from a free-text location. `no_rule_set`: not by adding a column — drop the row, or ship a rule set |
| `opt_out` | the contact objected, or is already suppressed | the suppression store, `reason: comply_objection` | **no** |

Two consequences worth being blunt about:

- **A missing column never suppresses anybody.** Writing a paperwork gap into an
  append-only store would permanently burn a contact for a typo, silently and
  irreversibly. That is a worse bug than an unclearable list, so this skill will not do
  it, and the test suite asserts a precondition stop leaves the store byte-identical.
- **An objection is recorded once and stays.** The entry carries `reason:
  comply_objection` and `source: comply` so it is distinguishable from an unsubscribe
  reply or a manual do-not-contact entry, and because the suppression engine is the one
  filter every writer in the pack passes through, that contact stops reaching *any*
  output (a sender export, a CRM import file, an ads audience) from that moment on.
  Say so out loud when it happens; it is not undoable.

`opt_out_of_sale_recorded` deliberately sits in the first group and not the second. CCPA
Sec. 1798.120 is an opt-out of *sale or sharing*, which is not the same statement as "do
not contact me", and expanding it into one would be this pack inventing a wish the
contact did not express. It stops the row — handing the record to a third-party sender
is a sharing act — but it is not written to the store.

## Step 3 — screen the list

Suppression is enforced by `_lib/suppression.mjs` and nowhere else. Never write your own
membership test, never lowercase-and-compare in a loop, and never build an output list
any other way:

```js
import { writeOutputList } from '../../_lib/suppression.mjs';
const res = writeOutputList(outFile, rows, { root });   // throws STOP without a store
```

Three properties you rely on and must not re-implement:

- A missing or corrupt store **throws**. There is no "assume empty" path.
- Matching is on the normalised value **or its sha256**, so a contact stays suppressed
  after their address has been erased.
- A suppressed domain suppresses every address at it and every subdomain of it.

Dropped rows carry the journal status `skipped_suppressed`. Report the count. A list
that lost rows to suppression is a healthier list than one that did not.

## Step 4 — run the gate and write the verdict

The rule table above is the gate; this is the thing that runs it. It spends nothing,
reads the table out of this very file, screens every row against the real suppression
store, and writes one verdict:

```bash
CHANNEL=email LIST=gtm/lists/q3-uk.csv ROOT=. node --input-type=module -e "${GTM_COMPLY:?set this to the gtm-comply script below}"
```

`CHANNEL` defaults to `email` (Step 1b). Set it to `phone`, `linkedin` or `mixed` when
the list is going anywhere else, and read the channel line the script prints back:
a verdict clears the channels it names and no others.

where `$GTM_COMPLY` is the script below. Write it to a file and run it if that is
easier; it is the same script either way. It exits `0` on PASS, `3` on FAIL, and `2`
only when the list itself cannot be read.

**Run it from the user's project, not from the pack.** The script used to `import
'./_lib/…'`, which exists only in the pack checkout, so in a customer's project it died
with `ERR_MODULE_NOT_FOUND` before reading a single row — three live runs ended there.
It now resolves the pack itself, in this order, and reads the gate table from the same
place:

1. **`RICHAPI_PACK_ROOT`**, when it is set. This is the one line to add when the pack is
   a git checkout somewhere else: `RICHAPI_PACK_ROOT=/path/to/gtm-skills`.
2. **the installed `@richapi/gtm-skills`**, resolved from the project's `node_modules`.
   Nothing to configure — this is the normal path, and it is why `npm i
   @richapi/gtm-skills` is enough.
3. **the current directory**, which is the pack checkout when you are standing in it.

If none of those holds, the failure names the pack root it tried. Do not "fix" it by
copying `_lib/` into the project: two copies of the suppression engine is exactly the
drift law 5 exists to prevent.

**Addresses are masked on the way to the terminal** — `a***@acme.example`, beside the
row number. The verdict file under `gtm/` carries the full address, because that is
where a fix reads it from and that tree is gitignored, TTL-swept and erasable (law 7).
Terminal scrollback is none of those things and ends up in tickets and CI logs, so when
you read refusals back to the user, name the row and the reason. Open the verdict file
if the full address is genuinely needed.

The verdict lands at `gtm/reviews/<list>.comply.json` by default, which is exactly where
[`/campaign-review`](../campaign-review/SKILL.md) looks for it. Three fields are
load-bearing and the rest is for the human:

- `status` — `PASS` or `FAIL`. One stopped row is a FAIL for the list, because a list is
  the unit that gets exported and a per-row allow-list would be a second, softer gate.
- `list_hash` — the same content hash `/campaign-review` and `/launch` bind to, computed
  over row *values*. Edit, add or remove a contact and this verdict no longer applies.
- `channels` — **which channels this verdict clears**, and the reason the same list can
  be cleared for `phone` and blocked for `email`. A consumer checks the channel it is
  about to use against this list; `/launch` requires `email` in it, because a sender
  export is an email artifact.
- `issued_at` — clearance is not permanent. Suppression state moves underneath a list
  that has not changed, so the verdict expires against
  `gates.yaml:skills.campaign_review.verdict_max_age_hours`, the same clock that expires
  a review. One clock for both verdicts is deliberate: two would let an operator hold a
  fresh review over a stale clearance.

Per stopped row the verdict carries the row number, the address, the `category` from the
table above, every reason with its regime prefix, and a `fixes` list. That is the part
the operator acts on, so read it to them rather than summarising it.

```js
// ==== gtm-comply v1 ====
// The compliance gate, in executable form. Reads a list, runs the `comply-rules`
// table that ships in THIS file over every row against the real suppression store,
// and writes a COMPLIANCE VERDICT bound to the list's content hash.
//
// ZERO API calls. Runs from ANY directory — see `packRoot` below.
//
// env: LIST  (required)  the .csv or .jsonl list under review
//      ROOT  (default .) the user's project root, the one holding gtm/
//      OUT   (default gtm/reviews/<list>.comply.json)
//      RULES (default <pack>/skills/comply/SKILL.md — the gate table is read FROM it)
//      RICHAPI_PACK_ROOT (where the pack is, when it is neither installed nor here)
//      CHANNEL (default email) email | phone | linkedin | mixed — the channel(s) the
//              list will be contacted on. A verdict clears the channels it names and
//              no others; `mixed` means EVERY channel in the table, which is the
//              strictest reading and never a weaker one.
//      NOW   (ISO instant; test seam, so a clock is never implicit)
//      GATES_FILE (alternate gates.yaml; test seam for the gate itself)
//
// exit 0 = PASS written, 3 = FAIL written, 2 = could not read the list at all.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// --- where the pack is ------------------------------------------------------
// This script runs in the USER'S project, where `./_lib/...` does not exist — three
// live runs died on ERR_MODULE_NOT_FOUND doing exactly that. So resolve the pack,
// in this order, and import everything from there:
//   1. RICHAPI_PACK_ROOT, when the operator says where it is;
//   2. the installed `@richapi/gtm-skills`, from the project's node_modules;
//   3. the current directory, which is the pack checkout itself.
const requireFrom = (dir) => createRequire(pathToFileURL(path.join(dir, 'resolve.mjs')));
const PACK = process.env.RICHAPI_PACK_ROOT
  ? path.resolve(process.env.RICHAPI_PACK_ROOT)
  : (() => {
      try { return path.dirname(requireFrom(process.cwd()).resolve('@richapi/gtm-skills/package.json')); }
      catch { return process.cwd(); }
    })();
const lib = (m) => import(pathToFileURL(path.join(PACK, '_lib', m)).href);

const { parse: parseYaml } = await import(pathToFileURL(requireFrom(PACK).resolve('yaml')).href);
const { parseCsv } = await lib('csv.mjs');
const { listContentHash } = await lib('sender-export.mjs');
const {
  loadSuppressionStore, isSuppressed, rowIdentifiers, addSuppressionEntry, maskContact,
} = await lib('suppression.mjs');
const { loadGates, gateValue, MissingGateKey, ALLOW, STOP } = await lib('gates.mjs');
const { isCountryCode, countryOfSubdivision, resolveLocation } = await lib('jurisdiction.mjs');

const LIST = process.env.LIST;
const ROOT = path.resolve(process.env.ROOT || '.');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const RULES_FILE = process.env.RULES || path.join(PACK, 'skills', 'comply', 'SKILL.md');
const CHANNEL = (process.env.CHANNEL || '').trim().toLowerCase();
if (!LIST) { console.error('comply: LIST is required'); process.exit(2); }

const NOT_FOUND = 'not_found';
const NOT_APPLICABLE = 'not_applicable';
const NULL_ENUM = ['not_found', 'not_verifiable', 'not_applicable'];

// The facts that mean THE CONTACT SAID NO, as opposed to the operator's paperwork
// being incomplete. Only `objection_recorded` is written to the suppression store,
// because only it is a statement by the data subject that survives this list.
const OPT_OUT_FACTS = new Set(['suppressed', 'objection_recorded']);
const RECORDABLE_OPT_OUT = new Set(['objection_recorded']);

const FIX = {
  suppressed: 'this contact is already on the suppression store, which is permanent by design. Drop the row.',
  objection_recorded: 'the contact objected. They are on the suppression store now and stay there. Drop the row.',
  source_undisclosed: 'record where this contact came from in a `data_source` column, then run /comply again.',
  personal_inbox_without_consent: 'a personal inbox needs a real consent record: set the basis to consent and fill `consent_record_id` and `consent_timestamp`, or drop the row.',
  no_unsubscribe_mechanism: 'set `unsubscribe_mechanism` true once the sequence carries a working unsubscribe, then run /comply again.',
  notice_at_collection_missing: 'set `notice_at_collection` true once the notice at collection was given, then run /comply again.',
  opt_out_of_sale_recorded: 'the contact opted out of sale or sharing. Handing their record to a third-party sender is a sharing act, so drop the row.',
  sensitive_pi_without_notice: 'set `sensitive_pi_notice` true, or take the sensitive fields off the row.',
  implied_consent_expired: 'CASL implied consent has run out. Record express consent with its evidence, or drop the row.',
  published_address_refuses_cem: 'the published address refuses commercial electronic messages. Drop the row.',
  role_irrelevant: 'set `role_relevant` true only when the message relates to the published role; otherwise drop the row.',
  basis_not_recorded: 'record a lawful basis this regime accepts, with the evidence it requires, then run /comply again.',
  evidence_missing: 'the row names a basis but not the evidence that basis requires. Fill the named field, then run /comply again.',
  basis_not_accepted: 'this regime does not accept that basis. Use one it does, with its evidence, or drop the row.',
  unknown_jurisdiction: 'this row states no country at all. Add a `subject_country` (ISO 3166-1 alpha-2) or `subject_region` (ISO 3166-2, e.g. US-WA) column, then run /comply again.',
  no_rule_set: 'the row says where this person is and this pack ships no rule set for it. Do NOT add a country column — it already has one. "We wrote no rules for this place" is not a finding that the place has no rules, so either drop the row, or add a rule set to the `comply-rules` table in skills/comply/SKILL.md and name it in gates.yaml:skills.comply.jurisdictions.',
  no_physical_postal_address: 'CAN-SPAM 15 U.S.C. 7704(a)(5) requires a valid physical postal address in every commercial message. Put the sender\'s in a `sender_postal_address` column, then run /comply again.',
  fact_uncomputable: 'a refusal condition could not be computed from the row, so it counts as fired. Supply the column it needs.',
  absent_basis_is_not_an_explicit_null: 'the gate table names a non-null default basis for this regime. Fix `absent_basis_is` in skills/comply/SKILL.md.',
  comply_rules_unavailable: 'restore the `comply-rules` block in skills/comply/SKILL.md. The table is the gate.',
  suppression_unreadable: 'run `./setup --root <the project>` from the pack checkout. A suppression check that could not run is not a passing check.',
  no_rule_set_for_channel: 'this row resolves to a jurisdiction, and every rule set that matched it governs a DIFFERENT channel. CAN-SPAM is an e-mail statute and governs no call; this pack ships no TCPA, DNC or telemarketing rule set. Re-run with a CHANNEL those rule sets govern, drop the row, or ship a rule set for the channel and name its `channels` in the `comply-rules` table.',
  unknown_channel: 'CHANNEL must be one of the `channels` in the comply-rules table, or `mixed`. A channel the table does not enumerate is a refusal (law 5), never a default.',
};

// --- the gate table, read out of the skill ----------------------------------
// There is no default table. A default table is exactly how a deleted gate goes
// unnoticed, so an unreadable one is a FAIL verdict, never an empty rule set.
function loadRules (file) {
  // Line splitting here is fence parsing, not record editing. Deletion is
  // `_lib/pii.mjs` and only `_lib/pii.mjs`, for the reason recorded in that file:
  // a line-oriented rewrite half-deleted a record that spanned two physical lines.
  //
  // The fence is BUILT here, never written literally. A bare triple backtick inside
  // this block ends the block a reader is copying it out of, so this script could only
  // be lifted from the skill by line number. Three backticks is the one string this
  // script may not contain, and building it is the whole fix.
  const FENCE = String.fromCharCode(96).repeat(3);
  const OPENS = new RegExp('^' + FENCE + 'yaml[ \\t]+comply-rules[ \\t]*$');
  const CLOSES = new RegExp('^' + FENCE + '\\s*$');
  const src = fs.readFileSync(file, 'utf8');
  const blocks = [];
  let open = null;
  for (const line of src.split(/\r?\n/)) {
    if (open === null) { if (OPENS.test(line)) open = []; continue; }
    if (CLOSES.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  if (blocks.length !== 1) throw new Error(blocks.length + ' `comply-rules` block(s) in ' + file + '; there must be exactly one');
  const doc = parseYaml(blocks[0]);
  if (!doc || typeof doc !== 'object') throw new Error('comply-rules parsed to nothing');
  // `channels` and `default_channel` are required for the same reason every other key
  // here is: a verdict that does not name the channel it clears is not a verdict, and a
  // missing key reads as STOP, never as "no channel dimension" (law 5).
  for (const k of ['default_verdict', 'detection', 'jurisdictions', 'channels', 'default_channel']) {
    if (doc[k] === undefined) throw new Error('comply-rules is missing `' + k + '`');
  }
  if (doc.default_verdict !== STOP) throw new Error('comply-rules default_verdict is "' + doc.default_verdict + '" — law 5 says "' + STOP + '"');
  return doc;
}

// --- the engine. Every lookup that misses is a stop, and every fact that cannot
// be computed counts as fired. This mirrors tests/skills/comply/harness.mjs, and
// tests/skills/comply/shipped-gate.test.mjs asserts the two never disagree.
const up = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
const low = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isTrue = (v) => v === true || low(v) === 'true' || low(v) === 'yes';
const emailDomain = (row) => { const e = low(row.email); const at = e.lastIndexOf('@'); return at < 0 ? '' : e.slice(at + 1); };

function addMonths (date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

// --- the channel dimension --------------------------------------------------
// A verdict is per CHANNEL, because a precondition is. CAN-SPAM's postal address is a
// rule about a commercial e-mail; it was firing on lists with no email column at all,
// so a call list could never clear anything and the operator had no way to make it.
//
// Two mechanisms, both fail closed:
//   1. A rule set governs the channels IT names. One that names none governs none.
//   2. A refusal condition named in `channel_conditions` fires only when one of its
//      channels is in play. One named nowhere applies to every channel.
function resolveChannels (rules) {
  const all = (rules.channels || []).map(low).filter(Boolean);
  if (all.length === 0) throw new Error('comply-rules names no `channels`');
  const asked = CHANNEL || low(rules.default_channel);
  if (asked === 'mixed') return { asked, channels: [...all].sort() };
  if (!all.includes(asked)) {
    const e = new Error('CHANNEL ' + JSON.stringify(asked) + ' is not one of: ' + all.join(', ') + ', mixed');
    e.complyCode = 'unknown_channel';
    throw e;
  }
  return { asked, channels: [asked] };
}

/** Does this rule set govern this channel? A rule set naming no channels governs none. */
function governs (rules, regime, channel) {
  const named = rules.jurisdictions?.[regime]?.channels;
  return Array.isArray(named) && named.map(low).includes(channel);
}

function resolveJurisdictions (row, rules) {
  const det = rules.detection || {};
  const known = new Set(Object.keys(rules.jurisdictions || {}));
  const matched = new Map();
  const note = (regime, signal) => { if (known.has(regime) && !matched.has(regime)) matched.set(regime, signal); };

  const declared = low(row.jurisdiction || row.declared_jurisdiction);
  if (declared) {
    if (!known.has(declared)) return { jurisdictions: [], unresolved: true, declared_unknown: declared };
    note(declared, 'declared');
  }
  const subdivisions = det.subdivisions || {};
  // A column that names a country or a region may hold a NAME rather than a code:
  // profile enrichment writes `United States`, not `US`. The jurisdiction table
  // resolves both, so ask it before treating the value as unlocatable (live 2026-09-17:
  // every enriched row read as `unknown_jurisdiction` until this call was added).
  const asCode = (field, raw) => {
    const v = up(raw);
    if (!v) return { country: null, region: null };
    if (isCountryCode(v)) return { country: v, region: null };
    const r = resolveLocation(raw, { field });
    const res = r && typeof r.result === 'object' ? r.result : null;
    return { country: res?.country ?? null, region: res?.region ?? null };
  };
  const regionResolved = asCode('subject_region', row.subject_region);
  const region = up(regionResolved.region ?? row.subject_region);
  if (region && subdivisions[region]) note(low(subdivisions[region]), 'subject_region');

  // Every country code this row states, whichever column it came from. The gate needs
  // the list even when nothing matches: a stated country with no rule set and a row
  // with no country at all are different refusals with opposite fixes.
  const located = [];
  const pairs = [['subject_region', det.subdivision_implies_country
    ? (countryOfSubdivision(region) ?? regionResolved.country) : null]];
  for (const f of ['subject_country', 'phone_country', 'company_hq_country', 'location_country']) {
    pairs.push([f, asCode(f, row[f]).country]);
  }
  for (const [field, code] of pairs) {
    if (!code) continue;
    if (isCountryCode(code)) located.push(code);
    if (subdivisions[code]) { note(low(subdivisions[code]), field); continue; }
    for (const [regime, list] of Object.entries(det.countries || {})) {
      if (Array.isArray(list) && list.map(up).includes(code)) note(low(regime), field);
    }
  }
  const domain = emailDomain(row);
  if (domain) {
    for (const [regime, list] of Object.entries(det.tlds || {})) {
      if (Array.isArray(list) && list.some((t) => domain.endsWith(low(t)))) note(low(regime), 'email_tld');
    }
  }
  const jurisdictions = [...matched.keys()].sort();
  return {
    jurisdictions,
    unresolved: jurisdictions.length === 0,
    declared_unknown: null,
    located: [...new Set(located)],
  };
}

const isPersonalInbox = (row, rules) =>
  low(row.address_type) === 'personal'
  || (!!emailDomain(row) && (rules.personal_inbox_domains || []).map(low).includes(emailDomain(row)));

function impliedConsentExpired (row, jur, now) {
  if (low(row.consent_kind) !== 'implied') return false;
  const windows = jur.implied_consent_windows || {};
  const event = low(row.consent_event);
  if (!event) return true;
  if (!Object.prototype.hasOwnProperty.call(windows, event)) return true;
  const win = windows[event];
  if (win === 'none' || win === null) return false;
  const months = win && typeof win === 'object' ? Number(win.months) : NaN;
  if (!Number.isFinite(months)) return true;
  const ts = Date.parse(row.consent_timestamp);
  if (Number.isNaN(ts)) return true;
  return addMonths(new Date(ts), months).getTime() < now.getTime();
}

function computeFacts (row, rules, jurName, { suppressed, now }) {
  const jur = rules.jurisdictions[jurName] || {};
  const declaredBasis = jur.basis_field ? low(row[jur.basis_field]) : '';
  return {
    suppressed: suppressed === true,
    objection_recorded: isTrue(row.objection),
    source_undisclosed: !String(row.data_source ?? '').trim(),
    personal_inbox_without_consent: isPersonalInbox(row, rules) && declaredBasis !== 'consent',
    no_unsubscribe_mechanism: !isTrue(row.unsubscribe_mechanism),
    no_physical_postal_address: !String(row.sender_postal_address ?? '').trim(),
    notice_at_collection_missing: !isTrue(row.notice_at_collection),
    opt_out_of_sale_recorded: isTrue(row.opt_out_sale),
    sensitive_pi_without_notice: isTrue(row.sensitive_pi) && !isTrue(row.sensitive_pi_notice),
    implied_consent_expired: impliedConsentExpired(row, jur, now),
    published_address_refuses_cem: low(row.consent_event) === 'published_address' && isTrue(row.published_address_refuses_cem),
    role_irrelevant: low(row.consent_event) === 'published_address' && !isTrue(row.role_relevant),
  };
}

function checkOneJurisdiction (row, rules, jurName, ctx) {
  const jur = rules.jurisdictions[jurName];
  if (!jur) return { verdict: STOP, basis: NOT_FOUND, reasons: ['no_rule_set'] };
  const reasons = [];
  const accepted = Array.isArray(jur.accepted_basis) ? jur.accepted_basis.map(low) : [];
  let basis;
  if (accepted.length === 0) {
    basis = low(jur.absent_basis_is) || NOT_APPLICABLE;
    if (!NULL_ENUM.includes(basis)) { reasons.push('absent_basis_is_not_an_explicit_null'); basis = NOT_FOUND; }
  } else {
    const raw = low(row[jur.basis_field]);
    if (!raw) { basis = NOT_FOUND; reasons.push('basis_not_recorded'); }
    else if (!accepted.includes(raw)) { basis = NOT_FOUND; reasons.push('basis_not_accepted:' + raw); }
    else {
      basis = raw;
      for (const field of (jur.evidence_required || {})[raw] || []) {
        if (!String(row[field] ?? '').trim()) { reasons.push('evidence_missing:' + field); basis = NOT_FOUND; }
      }
    }
  }
  const facts = computeFacts(row, rules, jurName, ctx);
  const scope = rules.channel_conditions || {};
  for (const name of jur.refuse_when || []) {
    // Scope first, uncomputability second: a condition that is not in play for this
    // channel is not a check that failed, it is a check that does not apply.
    const only = scope[name];
    if (Array.isArray(only) && !only.map(low).some((c) => ctx.channels.includes(c))) continue;
    if (facts[name] === undefined) { reasons.push('fact_uncomputable:' + name); continue; }
    if (facts[name]) reasons.push(name);
  }
  return { verdict: reasons.length ? STOP : ALLOW, basis, reasons };
}

function checkRow (row, { rules, store, now, channels }) {
  const suppressed = rowIdentifiers(row).some((id) => isSuppressed(store, id));
  const det = resolveJurisdictions(row, rules);
  if (det.unresolved) {
    // Three different refusals, and only one of them is "tell me where they are".
    const located = det.located || [];
    const reasons = det.declared_unknown ? ['no_rule_set:' + det.declared_unknown]
      : located.length ? ['no_rule_set:' + low(located.join('+'))]
        : ['unknown_jurisdiction'];
    if (suppressed) reasons.unshift('suppressed');
    return {
      verdict: rules.detection?.unresolved_verdict === ALLOW ? ALLOW : STOP,
      jurisdiction: low(rules.detection?.unresolved_jurisdiction) || NOT_FOUND,
      jurisdictions: [], basis: NOT_FOUND, reasons, channels_cleared: [],
    };
  }

  // A channel nothing governs is a refusal, not a clearance. A US row on `phone`
  // matches can_spam, which is an e-mail statute: the honest answer is that this pack
  // ships no rule set for calling that person, and the honest answer is a stop.
  const ungoverned = channels.filter((c) => !det.jurisdictions.some((j) => governs(rules, j, c)));
  if (ungoverned.length > 0) {
    return {
      verdict: low(rules.detection?.ungoverned_channel_verdict) === ALLOW ? ALLOW : STOP,
      jurisdiction: det.jurisdictions[0],
      jurisdictions: det.jurisdictions,
      basis: NOT_FOUND,
      reasons: ungoverned.map((c) => 'no_rule_set_for_channel:' + c),
      channels_cleared: [],
    };
  }

  const governing = det.jurisdictions.filter((j) => channels.some((c) => governs(rules, j, c)));
  const per = {};
  for (const j of governing) per[j] = checkOneJurisdiction(row, rules, j, { suppressed, now, channels });
  const refusing = governing.filter((j) => per[j].verdict !== ALLOW);
  const primary = refusing[0] || governing[0];
  return {
    verdict: refusing.length ? STOP : ALLOW,
    jurisdiction: primary,
    jurisdictions: det.jurisdictions,
    basis: per[primary].basis,
    reasons: refusing.flatMap((j) => per[j].reasons.map((r) => j + ':' + r)),
    channels_cleared: refusing.length ? [] : [...channels],
  };
}

// --- run --------------------------------------------------------------------
function readRows (file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return parseCsv(text);
}

let rows;
try { rows = readRows(LIST); }
catch (e) { console.error('comply: cannot read ' + LIST + ': ' + e.message); process.exit(2); }

const listHash = listContentHash(rows);
const gates = loadGates(process.env.GATES_FILE || undefined);

const blocking = [];
const stopped = [];
const optOuts = [];
const unrecordableOptOuts = [];
const notes = [];
const seen = new Set();
let maxAgeHours = null;
let cleared = 0;
let failedClosed = null;
let channels = null;
let channelAsked = CHANNEL || null;
const block = (code) => { if (!blocking.includes(code)) blocking.push(code); };

try {
  // The clock first. A verdict that cannot establish its own lifetime has expired.
  maxAgeHours = gateValue(gates, 'skills.campaign_review.verdict_max_age_hours');
  const rules = loadRules(RULES_FILE);
  // The channel, before any row. A verdict that cannot say which channel it clears
  // clears nothing, so an unknown CHANNEL is a FAIL verdict, not a default.
  const ch = resolveChannels(rules);
  channelAsked = ch.asked;
  channels = ch.channels;
  const regimes = new Set(Object.keys(rules.jurisdictions || {}));
  // Strip the `<regime>:` prefix a reason carries, so `gdpr:evidence_missing:lia_record_id`
  // reads as the code `evidence_missing` with the detail `lia_record_id`.
  const codeOf = (reason) => {
    const parts = String(reason).split(':');
    return regimes.has(parts[0]) ? parts[1] : parts[0];
  };
  const fixFor = (reason) => FIX[codeOf(reason)] || 'fix the record. The way past a refusal is the record, not asking twice.';

  const store = loadSuppressionStore({ root: ROOT });   // throws => STOP

  rows.forEach((row, i) => {
    const v = checkRow(row, { rules, store, now: NOW, channels });
    for (const j of v.jurisdictions) seen.add(j);
    if (v.verdict === ALLOW) { cleared += 1; return; }

    const codes = v.reasons.map(codeOf);
    // The contact the operator has to recognise is the one for the channel being
    // screened. Reading `email` whatever the channel printed "(no address)" against
    // every stop on a phone-only list, which made the stop unactionable — and, worse,
    // left `contact` empty, so the opt-out branch below silently did nothing.
    const emailContact = String(row.email ?? row.work_email ?? row.email_address ?? '').trim();
    const phoneContact = String(row.phone ?? row.mobile ?? row.phone_number ?? '').trim();
    const contact = (channels.includes('email') ? emailContact : '') || phoneContact || emailContact;
    stopped.push({
      row: i + 1,
      contact,
      category: codes.some((c) => OPT_OUT_FACTS.has(c)) ? 'opt_out'
        : (v.jurisdictions.length === 0 || codes.includes('no_rule_set_for_channel'))
          ? 'unresolved' : 'precondition',
      jurisdiction: v.jurisdiction,
      jurisdictions: v.jurisdictions,
      basis: v.basis,
      reasons: v.reasons,
      fixes: [...new Set(v.reasons.map(fixFor))],
    });
    for (const r of v.reasons) block(r);

    // The ONLY irreversible act in this skill, and the narrowest it could be. A
    // precondition failure never reaches here: that is the operator's paperwork, not
    // the contact's wish, and burning a contact for a missing column would be a worse
    // bug than the one this gate closes.
    if (codes.some((c) => RECORDABLE_OPT_OUT.has(c))) {
      // The suppression store keys on e-mail addresses and domains. An objection from
      // a row that carries neither cannot be made permanent here, and silence would be
      // the worst possible outcome: the run would report the objection handled while
      // nothing was written. Say so, loudly, and let the row stay stopped.
      if (!emailContact) unrecordableOptOuts.push(i + 1);
      else if (!isSuppressed(store, emailContact)) {
        addSuppressionEntry({ email: emailContact, reason: 'comply_objection', source: 'comply' }, { root: ROOT, now: NOW });
        store.emails.add(emailContact.toLowerCase());
        optOuts.push({ row: i + 1, contact: emailContact, reason: 'comply_objection' });
      }
    }
  });
} catch (e) {
  if (e instanceof MissingGateKey) failedClosed = { code: e.key, reason: e.message + ' — failing closed (law 5)' };
  else if (e?.complyCode) failedClosed = { code: e.complyCode, reason: e.message };
  else if (e?.name === 'SuppressionUnavailableError') failedClosed = { code: 'suppression_unreadable', reason: e.message };
  else failedClosed = { code: 'comply_rules_unavailable', reason: e.message };
  block(failedClosed.code);
  cleared = 0;
}

if (unrecordableOptOuts.length) {
  notes.push('row(s) ' + unrecordableOptOuts.join(', ') + ' record an objection but carry no e-mail '
    + 'address. The suppression store keys on e-mail addresses and domains, so NOTHING WAS WRITTEN '
    + 'and this objection is not permanent. Suppress this person in the system that owns the channel, '
    + 'then drop the row. Do not run the list again expecting the gate to remember.');
}
if (optOuts.length) {
  notes.push(optOuts.length + ' contact(s) objected and are now on the suppression store with reason '
    + '`comply_objection`. That is permanent: nothing in this pack removes a suppression entry.');
}
if (stopped.some((s) => s.category !== 'opt_out')) {
  notes.push('Rows stopped on a precondition are NOT suppressed. Fix the record and run /comply again — '
    + 'the row clears, and nothing about it was made permanent.');
}

const status = blocking.length === 0 ? 'PASS' : 'FAIL';
const issuedAt = NOW.toISOString();
const expiresAt = maxAgeHours === null ? issuedAt : new Date(NOW.getTime() + maxAgeHours * 60 * 60 * 1000).toISOString();

const verdict = {
  schema_version: 1,
  kind: 'comply',
  verdict_id: 'cy-' + issuedAt.replace(/[:.]/g, '-') + '-' + listHash.slice(0, 8),
  status,
  // WHICH CHANNEL THIS CLEARS. `channel` is what the caller asked for; `channels` is
  // the set that was actually screened (`mixed` expands to all of them). A consumer
  // must check the channel it is about to use against `channels` — /campaign-review
  // and /launch both do, and /launch writes an e-mail sender export, so a phone-only
  // clearance cannot produce one.
  channel: channelAsked,
  channels: channels ?? [],
  cleared_for: (status === 'PASS' && channels) ? channels : [],
  list_file: path.relative(ROOT, path.resolve(LIST)) || path.resolve(LIST),
  list_hash: listHash,
  rows_total: rows.length,
  rows_cleared: cleared,
  rows_stopped: stopped.length,
  issued_at: issuedAt,
  expires_at: expiresAt,
  max_age_hours: maxAgeHours,
  jurisdictions: [...seen].sort(),
  blocking,
  failed_closed: failedClosed,
  stopped,
  opt_outs_recorded: optOuts,
  notes,
};

const out = process.env.OUT
  || path.join(ROOT, 'gtm', 'reviews', path.basename(LIST).replace(/\.[^.]+$/, '') + '.comply.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(verdict, null, 2) + '\n', 'utf8');

console.log(status + '  ' + verdict.verdict_id);
console.log('  list      ' + verdict.list_file + '  (' + rows.length + ' row(s))');
console.log('  list_hash ' + listHash);
console.log('  channel   ' + (channelAsked || '(unresolved)')
  + (channels ? '  screened: ' + channels.join(', ') : '')
  + (status === 'PASS' ? '  — this verdict clears THESE channels and no others' : ''));
console.log('  expires   ' + expiresAt);
console.log('  cleared   ' + cleared + ' of ' + rows.length);
if (failedClosed) {
  console.log('  STOP  ' + failedClosed.code + ': ' + failedClosed.reason);
  console.log('        fix: ' + (FIX[failedClosed.code] || 'restore the gate this skill could not read.'));
}
// Addresses are MASKED on the way to the terminal. The verdict file holds the full
// address because a fix needs it and that file lives under gtm/, which is gitignored,
// TTL-swept and erasable (law 7). Terminal scrollback is none of those things, and it
// is routinely pasted into tickets, CI logs and chat — so the row number identifies
// the row and the mask proves which record it is, without printing the person.
for (const s of stopped) {
  console.log('  STOP  row ' + s.row + ' ' + (maskContact(s.contact) || '(no address)') + ' [' + s.category + '] ' + s.reasons.join(', '));
  for (const f of s.fixes) console.log('        fix: ' + f);
}
for (const n of notes) console.log('  note  ' + n);
console.log('  verdict   ' + out);
process.exit(status === 'PASS' ? 0 : 3);
// ==== end gtm-comply v1 ====
```

## Erasure — `/comply erase`

`/comply erase <email|domain>` purges every artifact holding that person across the
whole `gtm/` tree and appends a tombstone. **It is irreversible.** There is no undo,
no trash, and no second copy.

Deletion is `_lib/pii.mjs` and only `_lib/pii.mjs`. Never hand-roll it. The reason is
recorded in that file: an earlier implementation split CSVs on newlines, half-deleted a
record that spanned two physical lines, left an unterminated quote that corrupted
everything after it, and reported success. The shipped engine rewrites **records**, not
lines, and it sweeps the whole tree so a directory added later is covered automatically.

### The two confirmations

**One — erasure is never implicit.** `gates.yaml:skills.comply.erase_requires_explicit_confirm`
is true, so the user confirms the target before anything is written. Read the target back
to them in full. "yes" to "shall I clean that up?" is not a confirmation of a target
nobody restated.

**Two — a wide sweep asks again.** Measure first, then compare against
`gates.yaml:skills.comply.erase_confirm_fraction`:

```bash
node _lib/pii.mjs erase <email|domain> --root . --dry-run --json
```

The dry run writes nothing, deletes nothing and appends no tombstone. Divide the rows it
would remove plus the files it would delete by the number of erasable rows stored under
`gtm/`, and if that fraction is above the gate key, **ask again before proceeding** and
show the number. This is the gate that stops a typo'd domain — `acme.co` for `acme.com`,
or a bare TLD — from emptying the cache in one keystroke. Denominator excludes
`tombstones.jsonl`, which is never rewritten, and `suppression.jsonl`, whose entries are
downgraded to hashes rather than destroyed; leaving them in would shrink the fraction and
weaken the gate.

If either gate key is missing, that is `stop`, not "no gate" (law 5).

### Running it

```bash
node _lib/pii.mjs erase <email|domain> --root .
```

Then report what the tombstone records: files scanned, files touched, rows removed,
occurrences redacted, suppression entries downgraded to hashes. The target itself is
stored in the tombstone as a sha256, deliberately — the audit trail of an erasure must
not be a place the erased address survives.

Erasure is idempotent. A second run finds nothing, changes no data file, and appends a
second tombstone recording that a request was made and matched nothing. Say that plainly
instead of implying the first run failed.

The person stays suppressed. Their plaintext address in `suppression.jsonl` is replaced
by its hash, because "they asked not to be contacted" survives "they asked to be
forgotten" — re-adding them on the next import would be the worse violation.

## Retention

TTLs are policy, so they live in `gates.yaml` and are never typed into this file. The
sweep in `_lib/pii.mjs` drops expired rows from `gtm/enrichment-cache/` on every
preflight; it is fire-and-forget and never gates a run.

| What | Key |
|---|---|
| Company firmographics | `gates.yaml:cache_ttl.classes.firmographics` |
| Funding, tech and hiring signals | `gates.yaml:cache_ttl.classes.funding_tech` |
| Email verification and contactability | `gates.yaml:cache_ttl.classes.email_verification` |
| Posts and activity | `gates.yaml:cache_ttl.classes.posts_activity` |
| Anything unclassified | `gates.yaml:cache_ttl.classes.unknown` |
| Model output, never served from cache | `gates.yaml:cache_ttl.endpoints.ai_enrich` |

Fail closed, in this order: an endpoint with no entry gets the **shortest** TTL in the
table, never the longest and never "no expiry"; a row with no `fetched_at` or no
`source_endpoint` is expired; a malformed row is expired. Read a value with
`richapi gates` rather than quoting one from memory.

To force a sweep now:

```bash
node _lib/pii.mjs sweep --root .
```

## Step 5 — report the verdict

Read the verdict file back. Lead with the refusals, and give the row number and the
masked address the run printed, not a count. One stopped row looks like this inside
`stopped[]` — the file holds the address in full, your summary does not:

```json
{
  "row": 7,
  "contact": "someone@gmail.com",
  "category": "precondition",
  "jurisdiction": "gdpr",
  "jurisdictions": ["gdpr"],
  "basis": "not_found",
  "reasons": ["gdpr:source_undisclosed", "gdpr:personal_inbox_without_consent"],
  "fixes": ["record where this contact came from in a `data_source` column, then run /comply again.", "..."]
}
```

Rules for the summary you give the user:

- **Name the rows that failed and why.** "38 of 40 cleared" hides the two that matter.
- **A refusal is a refusal.** Do not soften `stop` into "you may want to check these".
- **Never invent a basis.** If the record does not carry one, the answer is `not_found`
  and the row does not go out. The three permitted ways to say "no answer" are
  `not_found`, `not_verifiable` and `not_applicable`; every other spelling — blank,
  "N/A", "unknown" — is a fabrication with a friendly face.
- **`not_applicable` is a real answer.** CCPA asks no consent question for business
  email, so the basis for a California-only row is `not_applicable`, not `not_found`
  and certainly not a borrowed GDPR basis.
- **Say which category each refusal is.** "Row 7 is missing a `data_source`; add the
  column and re-run and it clears" and "Row 9 objected and is now permanently
  suppressed" are different news, and the second one is not undoable.
- **Say what happens next.** A FAIL here means `/campaign-review` will FAIL the list and
  `/launch` will refuse to write the export. That is the gate working; do not offer a
  way around it, because there is not one.

## What this skill will not do

- **It does not give legal advice.** It enforces a shipped rule table. Coverage of a
  regime here is not an opinion that you are compliant, and the absence of one is not
  an opinion that you are not.
- **It does not fail open, ever.** An unresolved jurisdiction, a regime with no rule
  set, an unreadable suppression store, a missing gate key and an uncomputable refusal
  condition all read the same way: `stop`.
- **It does not clear a row it could not check.** There is no "probably fine" verdict
  and no override flag. The way past a refusal is fixing the record, not asking twice.
- **It does not guess a country from a place it cannot pin.** Step 1a reads free-text
  locations, and it refuses far more than it answers: an ambiguous name, a metropolitan
  label, a multi-country region and a two-letter token all resolve to nothing and leave
  the row exactly as unresolved as it was. Filling a country column is the one thing
  that could quietly move a subject out of a regime, so it happens only from an explicit
  country or region name, and never from the city table without a human.
- **It does not send, and it does not export the send file.** Sending execution,
  LinkedIn actions and dialing are outside the pack permanently. The final artifact is
  written by `/launch` alone, bound to a passing verdict.
- **It does not suppress a contact for the operator's paperwork.** A missing column, an
  unresolved jurisdiction and an absent evidence field stop the run and write nothing
  about the person. The suppression store means "this person said no", and diluting it
  with "we could not prove a basis today" would make it useless as both a record and a
  gate. Only `objection_recorded` crosses that line, and it crosses it once.
- **It does not clear rows one at a time.** The verdict is for the list, because the
  list is the unit that gets exported. Dropping the stopped rows is a legitimate fix —
  it changes the list, so re-run this skill and the review over the list as it now
  stands.
- **It does not delete anything outside `gtm/`.** Your CRM, your sending platform and
  your warehouse hold their own copies, and an erasure request is only finished when
  those are handled too. Say so; do not let a clean tombstone imply coverage this pack
  does not have.
- **It does not undo an erasure, and it does not un-suppress.** There is no restore path
  for either. That is why erasure asks twice, and why only an actual objection is ever
  written to the suppression store.
- **It does not gate the CRM import file.** [`/crm-export`](../crm-export/SKILL.md)
  requires no verdict by design (filing a record is not sending a message), so a
  *precondition* stop here does not stop a CRM export. An *opt-out* does, because that
  one is enforced by the suppression engine every writer in the pack runs through. If
  the plan is to import these records and then sequence them from inside the CRM, that
  is an outbound campaign and it needs this gate; say so.

## Related

- [`/campaign-review`](../campaign-review/SKILL.md) — reads this skill's verdict and
  FAILs the list without a live PASS from it; run it after this one
- [`/launch`](../launch/SKILL.md) — writes the export, and only against a review that
  carries this skill's clearance
- [`/richapi-gtm`](../richapi-gtm/SKILL.md) — the router; start here if the request is
  not obviously a compliance question
- [`/enrich-waterfall`](../enrich-waterfall/SKILL.md) — screens its own output through
  the same suppression engine before writing anything
- [`../../CLAUDE.md`](../../CLAUDE.md) — law 5 (fail closed) and law 7 (`gtm/` is PII)
- [`../../ROADMAP.md`](../../ROADMAP.md) — what is built and what is not
