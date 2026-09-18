// Skill text that was wrong against the live API.
//
// Eleven recipe runs against the real API, each agent following the skills exactly as
// written. These are the places where doing what the skill said produced a 400, a
// wrong number, or a confident silence. Each assertion below fails against the text
// that shipped before those runs.
//
// Prose assertions are usually a smell — they prove a sentence exists, not that a rule
// holds. These are the exception the pack already makes for skill text: the skill IS
// the program an agent executes, so a false sentence in it is a live defect, and the
// recorded fixture or the spec beside each one is the evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skill = (name) => fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'live', name + '.json'), 'utf8'));
const spec = () => fs.readFileSync(path.join(ROOT, 'spec', 'openapi.yaml'), 'utf8');

test('build-prospect-list: an engager row url is a comment permalink, not a profile URL', () => {
  const s = skill('build-prospect-list');
  // The recorded row shape: the identifier that names the PERSON is commenter.entityUrn.
  const row = fixture('post_activities').body.content[0];
  assert.ok(row.commenter && 'entityUrn' in row.commenter, 'the fixture no longer carries commenter.entityUrn');

  assert.match(s, /`url` is the comment's permalink, not the person's profile/);
  assert.match(s, /commentUrn/, 'name the form so it is recognisable in a response');
  // The recipe must not tell anyone to write it into linkedin_url — every consumer of
  // that column treats it as a profile URL.
  assert.match(s, /Do not write the comment permalink into `linkedin_url`/);
  assert.ok(!/`linkedin_url` = the row's `url`/.test(s),
    'the skill still maps the comment permalink into linkedin_url');
  assert.match(s, /`urn` = `commenter\.entityUrn`/);
});

test('inbound: distribute_leads takes comma-separated strings, not JSON', () => {
  const s = skill('inbound');
  assert.match(spec(), /values_associated_with_labels:\n\s+type: string/,
    'the spec no longer types this field as a string — re-read it');
  // Only the runnable command matters — the prose quotes the old form to explain it.
  const commands = [...s.matchAll(/^richapi call distribute_leads[\s\S]*?--dry-run$/gm)].map((m) => m[0]);
  assert.equal(commands.length, 1, 'expected exactly one distribute_leads example');
  assert.ok(!/:='\{\}'/.test(commands[0]),
    'the example still sends a JSON object into a string field (it 4xxs on a real call)');
  assert.match(s, /comma-separated strings/i);
  assert.match(s, /values_associated_with_labels='[^']*@[^']*,[^']*@[^']*'/,
    'the example must show the real shape: a comma-separated list');
});

test('tam-map: the market total is totalResultCount; totalElements caps at 1000', () => {
  const s = skill('tam-map');
  const pag = fixture('linkedin_company_search').body.pagination;
  assert.equal(pag.totalElements, 1000, 'the recorded cap changed — re-read the fixture');
  assert.ok(pag.totalResultCount > pag.totalElements,
    'the fixture no longer shows the two fields diverging, which is the whole point');

  assert.match(s, /Read `pagination\.totalResultCount`, not `pagination\.totalElements`/);
  assert.match(s, /saturates at 1000|caps? at 1000/i);
  // The "Counted" class and the cache-read instruction must both name the right field.
  assert.match(s, /- \*\*Counted\*\* — a `pagination\.totalResultCount`/);
  assert.match(s, /read\n`pagination\.totalResultCount` from:/);
});

test('enrich-waterfall: email_finder needs a profile URL or a name + DOMAIN', () => {
  const s = skill('enrich-waterfall');
  assert.match(spec(), /company_domain:\n\s+type: string\n\s+description: Company domain \(required if no linkedin_url\)/);
  assert.match(s, /company NAME is not a domain/i);
  assert.match(s, /http_400/);
  assert.ok(!s.includes('| `first_name` + `last_name` + `company_name` |'),
    'name + company name is still offered as sufficient input');
  // And the route out for such a row, which is a priced hop and not a silent retry.
  assert.match(s, /find_website_by_company_name\(\)/);
  // Reconciled with hygiene's own rule, in both directions.
  assert.match(skill('list-hygiene'), /A company NAME is not a domain/);
  assert.match(skill('list-hygiene'), /no enrichable identifier/);
});

test('list-hygiene: identify_email_type returns company/personal flags, not role or disposable', () => {
  const s = skill('list-hygiene');
  const body = fixture('identify_email_type').body;
  for (const k of ['is_likely_company_email', 'is_likely_personal_email', 'username']) {
    assert.ok(k in body, `the fixture no longer carries ${k}`);
  }
  for (const k of Object.keys(body)) {
    assert.ok(!/^(role|disposable|type)$/.test(k), `the endpoint now returns ${k} — re-read this rule`);
  }
  assert.match(s, /is_likely_company_email/);
  assert.match(s, /no `role` value and no `disposable` value/);
  // Role boxes are still handled — locally, off `username`, which the response carries.
  assert.match(s, /Role boxes and disposable domains are a LOCAL decision/);
  assert.match(s, /`username`/);
});

test('signal-watch: the champion watch cannot track named champions, and says so', () => {
  const s = skill('signal-watch');
  assert.match(s, /the watch as\n  written does not track named champions/);
  assert.match(s, /re-enrich and diff/i, 'the honest method must be named');
  assert.match(s, /discovery/i, 'and what the sweep IS good for');
  // The recipe that runs it must carry the same correction, or an agent reading only
  // the recipe repeats the live failure.
  const recipe = s.slice(s.indexOf('\n### champion-moved\n'));
  assert.match(recipe, /re-enriching their profiles and diffing/);
});

test('local-business-outbound ends where the data ends, not at a send', () => {
  const s = skill('local-business-prospecting');
  const doc = YAML.parse(s.match(/```yaml recipe\n([\s\S]*?)```/)[1]);
  assert.equal(doc.name, 'local-business-outbound');
  assert.equal(doc.ends, 'deliverable', 'a listing carries no email; this chain cannot reach a send');
  for (const step of ['sequence-builder', 'campaign-review', 'launch']) {
    assert.ok(!doc.steps.includes(step), `${step} cannot run on rows with no address`);
  }
  assert.match(s, /This recipe does not reach a send, and it used to claim it did/);
  assert.match(s, /build-prospect-list/, 'the hand-off to a named person must be explicit');
  assert.match(s, /call list/i, 'and the honest use of the deliverable as it stands');
});

test('account-research has a path for a domain with no LinkedIn link on the site', () => {
  const s = skill('account-research');
  assert.match(s, /A domain whose site lists no LinkedIn link/);
  assert.match(s, /domain-only brief/);
  // It must not solve it by guessing the company on LinkedIn by name.
  assert.match(s, /name-to-entity search belongs to/);
  assert.match(s, /`not_found`/, 'the dimensions it loses are reported as the explicit null');
});

test('evidence-score says where Fit comes from, instead of assuming an ICP it never sees', () => {
  const s = skill('evidence-score');
  assert.match(s, /## Where Fit comes from/);
  assert.match(s, /reads no `gtm\/icp\.yaml`/);
  assert.match(s, /Fit scores \*\*zero and reports `not_found`\*\*/);
  // The rubric still names the five match fields, so the claim and the table agree.
  const rules = YAML.parse(s.match(/```yaml evidence-rules\n([\s\S]*?)```/)[1]);
  const fit = rules.dimensions.fit.signals.map((x) => x.field);
  assert.deepEqual(fit.filter((f) => f.startsWith('icp_')).length, fit.length,
    'every Fit signal must be an ICP comparison, or this section is describing the wrong dimension');
});

// ---------------------------------------------------------------------------
// The second round of live runs, 2026-09-17. Same rule as above: each assertion
// fails against the text that shipped before the run, and each carries its evidence.
// ---------------------------------------------------------------------------

test('local-business-prospecting: the reviews URL shape is the measured one', () => {
  const s = skill('local-business-prospecting');
  // Measured 2026-09-17, one review per probe: the listing's own `url` answered with a
  // review; `?q=place_id:` answered 201 with an empty array. An earlier run had claimed
  // the opposite, so the skill now carries the trial rather than one run's impression.
  const place = fixture('google_maps_places_scraper_keyword').body[0];
  assert.match(place.placeId, /^ChIJ/, 'the recording no longer carries a place id');
  assert.match(place.url, /query_place_id=/, 'the url shape the skill tells callers to pass is gone');
  // The recorded reviews call was made with a /maps/place/... URL and returned nothing
  // with an http 2xx. That is the silent failure, on the record.
  const reviews = fixture('google_maps_reviews_scraper_sync');
  assert.ok(reviews.http_status >= 200 && reviews.http_status < 300, 'the miss was a 2xx, which is the point');
  assert.deepEqual(reviews.body, [], 'the recording no longer shows the empty answer');

  assert.match(s, /empty array/i, 'say that the failure is silent, not an error');
  assert.match(s, /limit=1/, 'a one-review probe must be the documented first step');
  assert.match(s, /`placeId`/, 'and say what the place id is for');
  assert.ok(!/q=place_id:<placeId>"\s*\\/.test(s),
    'the runnable command must not pass the shape that answers empty');
});

test('enrich-waterfall: web_emails is a direct `richapi call`, not a waterfall hop', () => {
  const s = skill('enrich-waterfall');
  const owners = YAML.parse(fs.readFileSync(path.join(ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
  assert.ok(owners.endpoints.web_emails.includes('enrich-waterfall'),
    'endpoint-owners still assigns web_emails here, so this skill has to document it');
  assert.match(s, /richapi call web_emails/, 'show the call the user actually runs');
  assert.match(s, /not[^.]{0,40}(a )?waterfall hop|NOT part of `richapi enrich`/i,
    'say plainly that `richapi enrich` has no such hop');
  // And the recipe that named the step must agree it is a separate call.
  const local = skill('local-business-prospecting');
  assert.match(local, /direct `richapi call`, not a waterfall hop/);
});

test('enrich-waterfall + build-prospect-list: bulk returns no title and no company', () => {
  // The shape difference, straight off the two recordings: the bulk element nests its
  // collections under `contents`, the single one does not, and the field map is the
  // single endpoint's.
  const bulk = fixture('enrich_profiles_bulk').body[0];
  const single = fixture('enrich_profile').body;
  assert.ok(Array.isArray(bulk.positionGroups?.contents), 'bulk no longer nests under contents');
  assert.ok(Array.isArray(single.positionGroups), 'the single response no longer answers with a bare array');

  for (const name of ['enrich-waterfall', 'build-prospect-list']) {
    const s = skill(name);
    assert.match(s, /no `?title`?|no job title/i, `${name} still promises a title from bulk`);
    assert.match(s, /`company_name`/, `${name} must name the other column that comes back empty`);
    assert.match(s, /`linkedin_url`/, `${name} must say what bulk DOES give you`);
    assert.match(s, /enrich_profile/, `${name} must name the second hop a title costs`);
  }
});

test('comply: a verdict names the channel it clears, and the recipes that end in calls say so', () => {
  const s = skill('comply');
  const rules = YAML.parse(s.match(/```yaml comply-rules\n([\s\S]*?)```/)[1]);
  assert.deepEqual(rules.jurisdictions.can_spam.channels, ['email'],
    'CAN-SPAM is an e-mail statute; governing a call list is how a postal-address stop reached one');
  assert.equal(rules.default_channel, 'email', 'an unset channel must mean what every past run meant');
  assert.deepEqual(rules.channel_conditions.no_physical_postal_address, ['email']);
  assert.match(s, /## Step 1b/, 'the channel needs its own step, not a footnote');
  assert.match(s, /CHANNEL=phone/);

  // The recipe that ends in a call list has to name the channel it needs clearing for.
  const local = skill('local-business-prospecting');
  assert.match(local, /`CHANNEL=phone`/, 'a call list must be told which clearance to ask for');
  assert.match(local, /no_rule_set_for_channel:phone/,
    'and told that a US call list still stops, because no TCPA rule set ships');
});
