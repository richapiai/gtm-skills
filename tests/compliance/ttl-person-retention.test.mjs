// tests/compliance/ttl-person-retention.test.mjs — REGRESSION.
//
// THE BUG THIS FILE EXISTS TO CATCH (high severity, found in a security audit).
//
// `_lib/gates.yaml` carried, on the `capability_groups` key:
//
//     # ... _lib/pii.mjs does not read this key; it is how the gate resolves a catalog
//     # entry that has no endpoint-specific override.
//     capability_groups:
//       enrichment: firmographics
//
// _lib/pii.mjs DOES read that key. `ttlForEndpoint()` resolves endpoint ->
// capability_group -> class AHEAD of its own built-in table, so `enrichment:
// firmographics` (90d) silently overrode the reasoning recorded in _lib/pii.mjs —
// that person-level endpoints belong in `email_verification` (7d) because
// "contactability decays with job changes... Shorter is the fail-closed direction."
//
// Measured on the shipped config:
//     enrich_profile               7d ->  90d   (12.9x)
//     find_linkedin_url_by_email   7d ->  90d   (12.9x)
//     profile_social_metrics       1d ->  90d   (90x)
//     table.notes: []                            <- the operator was never told
//
// A named person's profile retained 90 days instead of 7, by default, with no
// diagnostic anywhere. That is the GDPR art. 5(1)(e) storage-limitation exposure a
// regulator finds first.
//
// Two invariants, both written to go red if it comes back:
//   1. No person-identity endpoint resolves LONGER than its built-in class.
//   2. A widening cannot be silent — a deliberately widened policy fires a note.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpRoot, cleanupTmp, write, REPO_ROOT } from './helpers.mjs';
import {
  loadTtlTable, ttlForEndpoint, sweepEnrichmentCache,
  DEFAULT_ENDPOINT_CLASS, DEFAULT_TTL_CLASSES, PERSON_IDENTITY_ENDPOINTS,
  capabilityGroupOf, _resetCapabilityGroupCache, DAY_MS,
} from '../../_lib/pii.mjs';

test.after(cleanupTmp);

const GATES_YAML = join(REPO_ROOT, '_lib', 'gates.yaml');
const days = (ms) => ms / DAY_MS;
const shipped = () => loadTtlTable({ root: REPO_ROOT });

// ---------------------------------------------------------------------------
// 1. The invariant: person data is never retained longer than its built-in class.
// ---------------------------------------------------------------------------

test('the person-identity set is not empty and names the endpoints the bug widened', () => {
  for (const ep of [
    'enrich_profile', 'enrich_profiles_bulk',
    'find_linkedin_url_by_email', 'find_linkedin_url_by_name',
    'profile_social_metrics', 'web_emails', 'extract_urls_emails',
    'email_verifier', 'phone_finder',
  ]) {
    assert.ok(PERSON_IDENTITY_ENDPOINTS.has(ep),
      `${ep} returns a named person and must be inside PERSON_IDENTITY_ENDPOINTS`);
  }
});

test('NO person-identity endpoint resolves longer than its built-in class', () => {
  _resetCapabilityGroupCache();
  const t = shipped();
  assert.notEqual(t.source, 'defaults', 'the shipped policy must actually be under test');

  const widened = [];
  for (const ep of PERSON_IDENTITY_ENDPOINTS) {
    const cls = DEFAULT_ENDPOINT_CLASS[ep];
    if (!cls) continue;
    const builtin = DEFAULT_TTL_CLASSES[cls];
    const resolved = ttlForEndpoint(ep, t);
    if (resolved > builtin) {
      widened.push(`${ep}: built-in ${cls} ${days(builtin)}d -> policy ${days(resolved)}d `
        + `(${(resolved / builtin).toFixed(1)}x, group ${capabilityGroupOf(ep)})`);
    }
  }
  assert.deepEqual(widened, [],
    'the shipped policy retains person data longer than the fail-closed built-in class:\n  '
    + widened.join('\n  '));
});

test('the specific endpoints the audit measured are back on their short clocks', () => {
  const t = shipped();
  assert.equal(days(ttlForEndpoint('enrich_profile', t)), 7);
  assert.equal(days(ttlForEndpoint('enrich_profiles_bulk', t)), 7);
  assert.equal(days(ttlForEndpoint('find_linkedin_url_by_email', t)), 7);
  assert.equal(days(ttlForEndpoint('find_linkedin_url_by_name', t)), 7);
  assert.equal(days(ttlForEndpoint('profile_social_metrics', t)), 1);
  assert.equal(days(ttlForEndpoint('web_emails', t)), 7);
  assert.equal(days(ttlForEndpoint('extract_urls_emails', t)), 7);
  assert.equal(days(ttlForEndpoint('predict_gender', t)), 7);
  assert.equal(days(ttlForEndpoint('normalize_phone', t)), 7);
  assert.equal(days(ttlForEndpoint('slack_channel_members', t)), 1);
  // …and the split did not cost the company half its cache.
  assert.equal(days(ttlForEndpoint('enrich_company', t)), 90);
  assert.equal(days(ttlForEndpoint('enrich_companies_bulk', t)), 90);
  assert.equal(days(ttlForEndpoint('email_verifier', t)), 7);
});

test('the person half of `enrichment` is pinned BY NAME, not left to the group', () => {
  // The group axis is the catalog's ("what does this endpoint do"); retention needs
  // "whose data is this". The two do not line up, so the person members are pinned in
  // cache_ttl.endpoints, which resolves ahead of cache_ttl.capability_groups.
  const t = shipped();
  for (const ep of ['enrich_profile', 'find_linkedin_url_by_email', 'profile_social_metrics']) {
    assert.equal(capabilityGroupOf(ep), 'enrichment', `${ep} moved out of the enrichment group`);
    assert.ok(t.policyEndpoints[ep] !== undefined,
      `${ep} lost its explicit pin and is back on the group's 90d firmographics clock`);
  }
});

test('the stale comment that hid the bug is gone from gates.yaml', () => {
  const src = readFileSync(GATES_YAML, 'utf8');
  assert.ok(!/does not read this key/.test(src),
    'gates.yaml claims again that the retention sweep does not read capability_groups');
  // A comment cannot be enforced, but its absence can be. The positive form is what a
  // future editor needs to see before changing a group value.
  const block = src.slice(src.indexOf('capability_groups:') - 1400, src.indexOf('capability_groups:'));
  assert.match(block, /_lib\/pii\.mjs/,
    'nothing next to capability_groups tells the reader the PII sweep resolves through it');
  assert.match(block, /OVERRIDES the built-in retention class/);
});

// ---------------------------------------------------------------------------
// 2. A widening can never again be SILENT.
// ---------------------------------------------------------------------------

/** A policy file that deliberately parks a person endpoint on a 90d clock. */
function widenedPolicy() {
  const root = tmpRoot('compliance-widen-');
  return write(root, 'gates.yaml', [
    'cache_ttl:',
    '  classes:',
    '    firmographics: 90d',
    '    funding_tech: 30d',
    '    email_verification: 7d',
    '    posts_activity: 1d',
    '    unknown: 1d',
    '  capability_groups:',
    '    enrichment: firmographics',
    '    email_and_phone: email_verification',
    '  endpoints:',
    '    web_emails: firmographics',
    '',
  ].join('\n'));
}

test('a deliberate widening of person data FIRES A NOTE — via a group', () => {
  _resetCapabilityGroupCache();
  const t = loadTtlTable({ gatesPath: widenedPolicy() });
  assert.notEqual(t.source, 'defaults');

  // This is the exact shipped-config bug, reproduced in a fixture.
  assert.equal(days(ttlForEndpoint('enrich_profile', t)), 90);
  const note = t.notes.find(n => n.includes('enrich_profile'));
  assert.ok(note, `no note for a 12.9x person-data widening; notes = ${JSON.stringify(t.notes)}`);
  assert.match(note, /PII RETENTION WIDENED/);
  assert.match(note, /capability_groups\.enrichment/);
  assert.match(note, /7d/);
  assert.match(note, /90d/);
});

test('a deliberate widening FIRES A NOTE — via an explicit endpoint entry too', () => {
  const t = loadTtlTable({ gatesPath: widenedPolicy() });
  const note = t.notes.find(n => n.includes('web_emails'));
  assert.ok(note, 'an endpoint pinned to a longer class widened silently');
  assert.match(note, /cache_ttl\.endpoints\.web_emails/);
});

test('every widening is logged, person or not, and carries the arithmetic', () => {
  const t = loadTtlTable({ gatesPath: widenedPolicy() });
  const byEp = Object.fromEntries(t.widenings.map(w => [w.endpoint, w]));

  const w = byEp.profile_social_metrics;
  assert.ok(w, 'the 90x widening the audit measured is not in table.widenings');
  assert.equal(w.builtin_class, 'posts_activity');
  assert.equal(w.builtin_days, 1);
  assert.equal(w.resolved_days, 90);
  assert.equal(w.factor, 90);
  assert.equal(w.person_identity, true);

  // A non-person widening is recorded too — just not escalated into `notes`.
  const job = byEp.linkedin_job_detail;
  assert.ok(job, 'a non-person widening went unrecorded');
  assert.equal(job.person_identity, false);
  assert.ok(!t.notes.some(n => n.includes('linkedin_job_detail')),
    'notes is the person-data channel; routine policy tuning does not belong in it');
});

test('a policy that only TIGHTENS logs nothing — the note is not noise', () => {
  const root = tmpRoot('compliance-tighten-');
  const p = write(root, 'gates.yaml', [
    'cache_ttl:',
    '  classes:',
    '    firmographics: 45d',
    '    funding_tech: 30d',
    '    email_verification: 7d',
    '    posts_activity: 1d',
    '    unknown: 1d',
    '  endpoints:',
    '    enrich_company: firmographics',
    '    phone_finder: 3d',
    '',
  ].join('\n'));
  const t = loadTtlTable({ gatesPath: p });
  assert.deepEqual(t.notes, [], `a narrowing policy logged: ${JSON.stringify(t.notes)}`);
  assert.deepEqual(t.widenings, []);
});

test('the shipped policy widens no person data, and says what it does widen', () => {
  const t = shipped();
  assert.deepEqual(t.notes, [],
    `the shipped policy widens person retention: ${JSON.stringify(t.notes, null, 2)}`);
  // `widenings` is deliberately NOT asserted empty: the built-in table is a
  // fail-closed default, not a ceiling, and policy may legitimately outrank it. What
  // it may not do is outrank it in the dark.
  for (const w of t.widenings) {
    assert.equal(w.person_identity, false, `${w.endpoint} is person data and is widened`);
    assert.ok(w.resolved_days > w.builtin_days && w.factor > 1);
    assert.ok(typeof w.via === 'string' && w.via.startsWith('cache_ttl.'));
  }
});

test('the retention sweep TELLS the operator — it does not keep the notes to itself', () => {
  const root = tmpRoot('compliance-sweepnotes-');
  const r = sweepEnrichmentCache({ root, dryRun: true });
  assert.ok(Array.isArray(r.ttl_notes), 'the sweep report drops the retention notes on the floor');
  assert.ok(Array.isArray(r.ttl_widenings));
});
