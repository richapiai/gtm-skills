// tests/skills/list-hygiene/suppression-crosscheck.test.mjs
//
// /list-hygiene's highest-stakes claim: "a suppressed contact never reaches an
// output under any circumstance."
//
// These tests assert the claim against the REAL engine (_lib/suppression.mjs), not
// against prose. The prose assertions at the bottom exist only to stop the SKILL.md
// from quietly acquiring an escape hatch the engine does not have.
//
// The learning being defended: a do-not-contact check that matched on an allowlist of
// column NAMES let an unsubscribed contact through under five of six ordinary
// spellings, because Salesforce and HubSpot capitalise their exports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  filterOutputList, writeOutputList, loadSuppressionStore, suppressionStatus,
  rowIdentifiers, isSuppressed, sha256, SuppressionUnavailableError,
} from '../../../_lib/suppression.mjs';

import { parseCsv, CsvStructureError } from '../../../_lib/csv.mjs';
import { readInputRows } from '../../../_lib/enrich.mjs';

import { rootWithStore, tmpRoot, skillBody } from './helpers.mjs';

const UNSUBSCRIBED = 'nope@acme.com';

// The six spellings a real CRM export produces. Five of these are what the
// column-name allowlist missed.
const SPELLINGS = ['email', 'Email', 'Work Email', 'contact_email', 'EMAIL', 'primary_email'];

// --- the core law ----------------------------------------------------------

test('a suppressed contact is dropped under every realistic column spelling', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED, reason: 'unsubscribe' }]);
  for (const col of SPELLINGS) {
    const rows = [
      { first_name: 'Ada', [col]: UNSUBSCRIBED },
      { first_name: 'Grace', [col]: 'grace@other.example' },
    ];
    const { kept, dropped } = filterOutputList(rows, { root });
    assert.equal(dropped.length, 1, `column "${col}" did not drop the suppressed row`);
    assert.equal(dropped[0].matched, UNSUBSCRIBED);
    assert.equal(dropped[0].status, 'skipped_suppressed');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].first_name, 'Grace');
  }
});

test('the column name is irrelevant — a value-shaped identifier is scanned wherever it sits', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED }]);
  // A column nobody would ever put on an allowlist.
  const rows = [{ 'Zz Custom Field 7': UNSUBSCRIBED }, { 'Zz Custom Field 7': 'ok@x.example' }];
  assert.deepEqual(rowIdentifiers(rows[0]), [UNSUBSCRIBED]);
  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].matched, UNSUBSCRIBED);
  assert.equal(kept.length, 1);
});

// The one thing the value scan cannot see, and the pipeline order that closes it.
test('an address buried in free text is invisible until extraction — so the skill re-filters after it', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED }]);
  const buried = { 'Notes from the SDR': `left a voicemail, emailed ${UNSUBSCRIBED} twice` };
  // EMAILISH/DOMAINISH are anchored, so a sentence is not an identifier. This is
  // correct (otherwise every note would be a false positive) and it is a real hole
  // in the *pipeline*, not in the engine.
  assert.deepEqual(rowIdentifiers(buried), []);
  assert.equal(filterOutputList([buried], { root }).dropped.length, 0);

  // Once extraction materialises the identifier into a column, the same engine
  // catches it — which is why the skill re-runs the check after extraction, and why
  // writeOutputList re-filters at write time as the backstop.
  const extracted = { ...buried, extracted_email: UNSUBSCRIBED };
  assert.equal(filterOutputList([extracted], { root }).dropped.length, 1);

  const body = skillBody();
  assert.match(body, /extract_urls_emails\(\)/,
    'the skill must name the extraction call that can surface a hidden identifier');
  assert.match(body, /re-?run the (?:suppression )?cross-check|re-?filter/i,
    'the skill must require the cross-check to be re-run after extraction');
});

test('a suppressed contact never reaches the bytes of an output file', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED, reason: 'unsubscribe' }]);
  for (const [col, ext] of [['Work Email', 'csv'], ['EMAIL', 'jsonl']]) {
    const out = join(tmpRoot(), `clean.${ext}`);
    const res = writeOutputList(out, [
      { name: 'Ada', [col]: UNSUBSCRIBED },
      { name: 'Grace', [col]: 'grace@other.example' },
    ], { root });
    assert.equal(res.suppressed, 1);
    assert.equal(res.written, 1);
    const bytes = readFileSync(out, 'utf8');
    assert.ok(!bytes.toLowerCase().includes(UNSUBSCRIBED),
      `${ext} output leaked the suppressed address`);
    assert.ok(bytes.includes('grace@other.example'));
  }
});

test('domain suppression reaches emails at that domain and its subdomains', () => {
  const root = rootWithStore([{ domain: 'acme.com', reason: 'do_not_contact' }]);
  const rows = [
    { 'Work Email': 'someone@acme.com' },
    { 'Work Email': 'someone@eu.acme.com' },
    { 'Company Website': 'https://www.acme.com/careers' },
    { 'Work Email': 'ok@notacme.com' },
  ];
  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(dropped.length, 3);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]['Work Email'], 'ok@notacme.com');
});

test('a hashed entry keeps a person suppressed after their address was erased', () => {
  const root = rootWithStore([{ email_sha256: sha256(UNSUBSCRIBED) }]);
  const { kept, dropped } = filterOutputList([{ EMAIL: UNSUBSCRIBED }, { EMAIL: 'ok@x.example' }],
    { root });
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 1);
});

// --- fail closed -----------------------------------------------------------

test('no readable store is STOP, not "nothing suppressed"', () => {
  const root = rootWithStore(null); // no gtm/suppression.jsonl at all
  assert.equal(suppressionStatus({ root }).status, 'STOP');
  assert.throws(() => loadSuppressionStore({ root }), SuppressionUnavailableError);
  assert.throws(() => filterOutputList([{ email: 'anyone@x.example' }], { root }),
    e => e instanceof SuppressionUnavailableError && e.verdict === 'STOP');
});

test('a missing store means NO output file is produced at all', () => {
  const root = rootWithStore(null);
  const out = join(tmpRoot(), 'clean.csv');
  assert.throws(() => writeOutputList(out, [{ email: 'anyone@x.example' }], { root }),
    SuppressionUnavailableError);
  assert.equal(existsSync(out), false,
    'writeOutputList produced a file despite an unreadable store — that is a fail-OPEN');
});

test('one unparseable line stops the whole run rather than being skipped', () => {
  const root = tmpRoot();
  mkdirSync(join(root, 'gtm'), { recursive: true });
  writeFileSync(join(root, 'gtm', 'suppression.jsonl'),
    `{"email":"${UNSUBSCRIBED}"}\n{not json}\n`, 'utf8');
  assert.throws(() => filterOutputList([{ email: 'ok@x.example' }], { root }),
    e => e instanceof SuppressionUnavailableError && /corrupt/.test(e.message));
});

test('an EMPTY store is valid and readable — empty is not missing', () => {
  const root = rootWithStore([]);
  const st = suppressionStatus({ root });
  assert.equal(st.status, 'OK');
  assert.equal(st.count, 0);
  const { kept, dropped } = filterOutputList([{ email: 'ok@x.example' }], { root });
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('isSuppressed refuses to answer without a loaded store', () => {
  assert.throws(() => isSuppressed(null, UNSUBSCRIBED), SuppressionUnavailableError);
  assert.throws(() => isSuppressed({}, UNSUBSCRIBED), SuppressionUnavailableError);
});

// --- the skill is wired to the engine, and to nothing else -----------------

test('the SKILL.md delegates to the engine and names the enforcement functions', () => {
  const body = skillBody();
  assert.match(body, /_lib\/suppression\.mjs/,
    'the skill must point at the engine it uses');
  for (const fn of ['filterOutputList', 'writeOutputList', 'rowIdentifiers',
                    'SuppressionUnavailableError']) {
    assert.ok(body.includes(fn), `the skill must name ${fn}`);
  }
  assert.match(body, /never write your own check/i,
    'the skill must forbid re-implementing the check');
});

test('the SKILL.md states the absolute claim, with no escape hatch', () => {
  const body = skillBody();
  assert.match(body,
    /a suppressed contact never reaches an output under any circumstance/i,
    'the skill must state the law verbatim');
  // The prose must not offer a way around it.
  assert.match(body, /no override flag|no ["']?just this once|no dry-run exception/i);
  for (const hatch of [/--force/, /--no-suppress/, /skip the suppression/i,
                       /suppression.{0,20}optional/i]) {
    assert.doesNotMatch(body, hatch, `the skill offers an escape hatch: ${hatch}`);
  }
});

test('the SKILL.md keeps suppressed rows out of the dropped-rows report too', () => {
  const body = skillBody().replace(/\s+/g, ' ');
  assert.match(body, /suppressed rows are counted,\** never listed/i,
    'the dropped-rows report is an output; suppressed addresses may not appear in it');
  assert.match(body, /dropped[- ]rows report/i,
    'the skill must name the dropped-rows report as an output the law covers');
});

// --- through the real reader: bytes on disk, not hand-built objects --------
//
// Every test above builds its rows as JS objects, and that is exactly why the
// reader's bare-CR bug survived five reviews of this file: the engine was proven
// correct on rows that never came from a CSV. A real list arrives as BYTES, and
// `parseCsv` is what turns them into the rows the filter sees — so the law has to be
// asserted across that seam.
//
// The bug: `parseCsv` discarded an unquoted CR instead of ending the record. A CSV
// carrying `ok@x.example\rnope@acme.com` produced the single value
// `ok@x.examplenope@acme.com`, which equals no entry in the store, so the suppressed
// contact rode into the output list. A fail-OPEN reached by nothing more exotic than
// a legacy-Mac export.

/** The bytes a legacy-Mac / older-Excel-for-Mac export actually contains. */
const CR_LIST = `email,first_name\rok@x.example,Grace\r${UNSUBSCRIBED},Ada\r`;

test('a CR-delimited list is read as records, and the suppressed contact is dropped', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED, reason: 'unsubscribe' }]);
  const rows = parseCsv(CR_LIST);
  assert.equal(rows.length, 2, 'the whole list used to read as ZERO rows');

  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].matched, UNSUBSCRIBED);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].email, 'ok@x.example');
});

test('a suppressed contact in a CR-delimited list never reaches the output bytes', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED, reason: 'unsubscribe' }]);
  const dir = tmpRoot();
  const src = join(dir, 'in.csv');
  writeFileSync(src, CR_LIST, 'utf8');

  // The production path: the enrich input reader, then the only writer there is.
  const rows = readInputRows(src);
  const out = join(dir, 'clean.csv');
  const res = writeOutputList(out, rows, { root });

  assert.equal(res.suppressed, 1);
  assert.equal(res.written, 1);
  const bytes = readFileSync(out, 'utf8');
  assert.ok(!bytes.toLowerCase().includes(UNSUBSCRIBED),
    'the output leaked a suppressed address that entered as a CR-delimited record');
  assert.ok(bytes.includes('ok@x.example'));
});

test('a stray CR cannot glue a suppressed address into an identifier the store misses', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED }]);

  // Aligned halves: two records, and the suppressed one is dropped.
  const rows = parseCsv(`email,last_name\nok@x.example,Ada\r${UNSUBSCRIBED},Bob\n`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    for (const id of rowIdentifiers(r)) {
      assert.ok(!id.includes(`ok@x.example${UNSUBSCRIBED}`),
        'two addresses were concatenated into one identifier');
    }
  }
  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].matched, UNSUBSCRIBED);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].email, 'ok@x.example');
});

test('the audit\'s glued-field list is refused outright — it is not filtered leniently', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED }]);
  // The exact bytes from the audit. The CR splits `Ada,ok@x.example` off as a
  // two-field record under a three-field header, which is a genuinely ragged file:
  // STOP beats guessing which column each value belongs to.
  const text = `first,email,last\nAda,ok@x.example\r${UNSUBSCRIBED},Bob\n`;
  let rows = null;
  try { rows = parseCsv(text); } catch (e) {
    assert.ok(e instanceof CsvStructureError && e.verdict === 'STOP');
  }
  if (rows) {
    // If a future reader chooses to parse this rather than refuse it, the law still
    // holds: no identifier may be a concatenation, and the suppressed row must drop.
    for (const r of rows) {
      for (const id of rowIdentifiers(r)) {
        assert.ok(!id.includes(`ok@x.example${UNSUBSCRIBED}`), 'glued identifier');
      }
    }
    assert.equal(filterOutputList(rows, { root }).dropped.length, 1);
  }
});

test('a duplicate email column is refused, not collapsed onto the surviving one', () => {
  const root = rootWithStore([{ email: UNSUBSCRIBED }]);
  // `Object.fromEntries` kept the LAST `Email`, so the suppressed address in the
  // first column was destroyed before the filter could see it — and the row passed.
  const text = `Email,Email\n${UNSUBSCRIBED},ok@x.example\n`;
  assert.throws(() => parseCsv(text),
    e => e instanceof CsvStructureError && e.verdict === 'STOP');

  // Proof that the refusal is what closes it: the row the OLD reader would have
  // produced carries no trace of the suppressed address at all.
  const asOldReaderSawIt = { Email: 'ok@x.example' };
  assert.equal(filterOutputList([asOldReaderSawIt], { root }).dropped.length, 0,
    'nothing downstream can recover a column the reader threw away');
});
