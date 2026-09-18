// tests/skills/crm-export/export-boundary.test.mjs
//
// The question this file settles: is a CRM export the sender export under another name?
//
// The answer shipped in skills/crm-export/SKILL.md is "no, and here is the mechanical
// reason": the sole-writer rule gates the artifact that is one upload away from a SEND, and a CRM import
// file is one upload away from a RECORD. That distinction only holds while the two
// target namespaces stay disjoint — because a CRM with a sequencer bolted on is a
// sender, and the pack has already ruled that Apollo and Outreach are senders by putting
// them in SENDER_FORMATS.
//
// So the boundary is not prose here. It is: crm-export's targets ∩ SENDER_FORMATS = ∅,
// enforced by the shipped script reading that list at run time. These tests hold both
// halves — the disjointness, and the fact that it is READ rather than copied, so adding
// a platform to _lib/sender-export.mjs makes this skill refuse it the same day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SKILL, skillBody, skillProse, extractScript, runExport, refusalCodes,
  scriptTargets, projectRoot, writeCsv,
} from './helpers.mjs';
import { SENDER_FORMATS, HEADER_PREFIX } from '../../../_lib/sender-export.mjs';

const body = skillBody();
const script = extractScript();
const TARGETS = scriptTargets();
const SENDERS = Object.keys(SENDER_FORMATS);

test('the two namespaces are disjoint', () => {
  const overlap = TARGETS.filter(t => SENDERS.includes(t)).sort();
  assert.deepEqual(overlap, [],
    `crm-export offers ${overlap.join(', ')}, which _lib/sender-export.mjs already declares to be `
    + 'sending tools. A second route to the same artifact makes the sender-export gate decoration.');
  assert.ok(TARGETS.length > 0, 'the script must actually offer CRM targets');
});

test('every sender platform is refused by name, with a route to /launch', () => {
  const root = projectRoot({ suppression: [] });
  const list = writeCsv(root, 'gtm/lists/l.csv', [{ email: 'a@a.example', first_name: 'A' }]);
  for (const platform of SENDERS) {
    const out = `${root}/gtm/exports/${platform}.csv`;
    const r = runExport({ LIST: list, OUT: out, TARGET: platform, ROOT: root });
    assert.equal(r.status, 3, `TARGET=${platform} did not refuse:\n${r.out}`);
    assert.deepEqual(refusalCodes(r.out), ['SENDER_TARGET'], `TARGET=${platform}:\n${r.out}`);
    assert.match(r.out, /\/launch/, `the ${platform} refusal does not name the route`);
    assert.ok(!fs.existsSync(out), `a refusal left a file behind at ${out}`);
    assert.ok(!fs.existsSync(out + '.manifest.json'), 'a refusal left a manifest behind');
  }
});

test('`csv` in particular is refused — the neutral target is deliberately not called that', () => {
  // This is the case that would have been easiest to get wrong. "Just give me a CSV" is
  // the request that quietly reopens the ungated export route, and `csv` is a
  // SENDER_FORMATS entry, so it belongs to /launch.
  assert.ok(SENDERS.includes('csv'), 'SENDER_FORMATS no longer has a `csv` entry — re-read the boundary');
  assert.ok(!TARGETS.includes('csv'));
  assert.ok(TARGETS.includes('generic_crm'),
    'there must still be a neutral target, or the refusal is just a missing feature');
  assert.match(skillProse(), /no `csv` target/i, 'the SKILL.md must explain the naming, not just do it');
});

test('the sender list is READ at run time, never copied into this skill', () => {
  // A copied list drifts. The next platform added to _lib/sender-export.mjs must be
  // refused here on the same day, with no edit in this file.
  // The import is resolved from the installed pack rather than from `./_lib/...`, so
  // the script also runs in the user's project — but it is still the SAME module that
  // defines the list, loaded at run time.
  assert.match(script, /SENDER_FORMATS[^}]*\} = await lib\('sender-export\.mjs'\)/,
    'the script does not read SENDER_FORMATS from the module that defines it');
  const code = script.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const platform of SENDERS) {
    assert.ok(!new RegExp(`['"\`]${platform}['"\`]`).test(code),
      `the script hard-codes the sender platform "${platform}" — read the list, do not copy it`);
  }
});

test('the skill never names the sender export writer, and never writes one', () => {
  // The validator makes this an error for any skill but /launch. Asserted here too,
  // because the validator rule is the thing this skill is most tempted to route around.
  assert.ok(!/\bwriteSenderExport\b/.test(body), 'the SKILL.md names writeSenderExport');
  assert.ok(!/\bwriteSenderExport\b/.test(script), 'the shipped script names writeSenderExport');
});

test('the file it writes is not a sender export, and could not be mistaken for one', () => {
  const root = projectRoot({ suppression: [] });
  const list = writeCsv(root, 'gtm/lists/l.csv', [
    { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@a.example', company_name: 'AE' },
  ]);
  const out = `${root}/gtm/exports/o.csv`;
  const r = runExport({ LIST: list, OUT: out, TARGET: 'hubspot', OBJECT: 'contacts', ROOT: root });
  assert.equal(r.status, 0, r.out);

  const first = fs.readFileSync(out, 'utf8').split('\n')[0];
  assert.ok(!first.startsWith(HEADER_PREFIX),
    'the file carries a /launch binding header — that marker means "gated sender export"');
  assert.ok(!first.startsWith('#'),
    'a CRM importer reads line 1 as the header row, so a comment line breaks the import');
  assert.match(first, /^firstname,/, 'line 1 must be the CRM header row');
});

test('the binding lives in a manifest instead, and the skill admits that is weaker', () => {
  const root = projectRoot({ suppression: [] });
  const list = writeCsv(root, 'gtm/lists/l.csv', [{ email: 'a@a.example', first_name: 'A' }]);
  const out = `${root}/gtm/exports/o.csv`;
  assert.equal(runExport({ LIST: list, OUT: out, TARGET: 'generic_crm', ROOT: root }).status, 0);

  const m = JSON.parse(fs.readFileSync(out + '.manifest.json', 'utf8'));
  assert.equal(m.not_a_sender_export, true);
  assert.equal(m.written_by, SKILL);
  assert.equal(typeof m.source_list_hash, 'string');
  assert.equal(m.source_list_hash.length, 64, 'the manifest must bind the source list by content hash');
  assert.match(skillProse(), /weaker/i,
    'a manifest beside the file is weaker tamper-evidence than an in-file header; say so rather '
    + 'than implying parity with /launch');
});

test('the boundary is argued in the file, in both directions', () => {
  const s = skillProse();
  assert.match(s, /sequencer/i, 'the CRM-with-a-sequencer objection must be met, not dodged');
  assert.match(s, /Apollo/, 'the precedent is that Apollo and Outreach are already ruled senders');
  assert.match(s, /Outreach/);
  assert.match(s, /over-application/i,
    'refusing a legitimate feature is the other failure mode and must be named');
  assert.match(s, /No PASS verdict is required|no send/i,
    'the skill must say which /launch gate it does NOT inherit, and why');
  assert.match(s, /sender-export gate/, 'name the gate the argument is about');
});

test('an outbound plan is routed to the review, not quietly allowed', () => {
  // The honest residual risk: import the records, then sequence them from inside the
  // CRM. The skill cannot prevent that, so it must name it and route.
  assert.match(skillProse(), /sequence these records from inside the CRM/i);
  assert.ok(skillBody().includes('](../campaign-review/SKILL.md)'),
    'the route for that case is /campaign-review and it must be a live link');
  assert.ok(skillBody().includes('](../launch/SKILL.md)'));
});
