// tests/compliance/csv-record-terminators.test.mjs
//
// The reader's three silent-data-loss bugs, all in `parseRows`/`parseCsv`.
//
//   R1  A bare CR was DISCARDED (`if (c === '\r') continue;`) instead of terminating
//       the record. The writer quotes CR precisely because Excel and most CRM
//       importers treat a lone CR as a row break — see the note above the escapeField
//       import in _lib/suppression.mjs — so the two halves of the pack disagreed about
//       what a record is, again. A CR-delimited export (legacy Mac, older
//       Excel-for-Mac, several CRM exports) parsed to ZERO records; a single stray CR
//       inside an LF file GLUED two records into one, concatenating the two emails
//       into a value that matches no suppression entry. That last one is a fail-OPEN,
//       and it is exercised end-to-end in
//       tests/skills/list-hygiene/suppression-crosscheck.test.mjs.
//
//   2.  A duplicate header (`Email,Email`) went through `Object.fromEntries`, which
//       keeps the LAST occurrence — the first column was destroyed before any caller,
//       suppression included, could look at it.
//
//   3.  A ragged record (header `a,b`, record `1,2,3`) silently dropped the trailing
//       cell.
//
// Cases 2 and 3 now refuse: CsvStructureError, verdict STOP, the same fail-closed shape as
// SuppressionUnavailableError. `parseRows` stays tolerant because `/comply erase` reads
// with it, and a deletion request must be able to read a malformed file in order to
// delete from it.
//
// Every test here fails against the old reader.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp } from './helpers.mjs';
import { parseRows, parseCsv, escapeField, stringifyRows, CsvStructureError } from '../../_lib/csv.mjs';
import { readInputRows } from '../../_lib/enrich.mjs';

test.after(cleanupTmp);

/** assert.throws does not hand back the error; these tests assert on its fields. */
function thrown (fn) {
  try { fn(); } catch (e) { return e; }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

// --- R1: every line ending terminates a record -----------------------------

test('a bare CR terminates a record — a CR-delimited list is not zero rows', () => {
  const rows = parseCsv('email\rok@x.example\rnope@acme.example\r');
  assert.equal(rows.length, 2, 'a CR-delimited file used to parse to []');
  assert.deepEqual(rows.map(r => r.email), ['ok@x.example', 'nope@acme.example']);

  // The shape that made this invisible: one physical line, thousands of records.
  const big = ['email', ...Array.from({ length: 5000 }, (_, i) => `p${i}@e.example`)].join('\r') + '\r';
  assert.equal(parseCsv(big).length, 5000);
});

test('a stray CR inside an LF file splits the record instead of gluing two into one', () => {
  // Aligned halves: the split is clean, so two records come out.
  const rows = parseCsv('email,last\nok@x.example,Ada\rnope@acme.example,Bob\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { email: 'ok@x.example', last: 'Ada' });
  assert.deepEqual(rows[1], { email: 'nope@acme.example', last: 'Bob' });
  for (const r of rows) {
    assert.ok(!Object.values(r).some(v => v.split('@').length > 2),
      'two addresses were concatenated into one field');
  }
});

test('the audit\'s glued-field input is refused, never read as one merged contact', () => {
  // The exact input from the audit. Old behaviour: ONE row,
  // {first:'Ada', email:'ok@x.examplenope@acme.example', last:'Bob'} — two people
  // merged, an address that belongs to neither, and Bob gone.
  const text = 'first,email,last\nAda,ok@x.example\rnope@acme.example,Bob\n';
  const e = thrown(() => parseCsv(text));
  assert.ok(e instanceof CsvStructureError, 'a half-record must not be read as a record');
  assert.equal(e.verdict, 'STOP');
  // Whatever else happens, the concatenation must not exist.
  assert.doesNotMatch(e.message, /ok@x\.examplenope@acme\.example/);
});

test('CRLF is ONE terminator — no phantom blank record between the halves', () => {
  const rows = parseRows('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);

  // Mixed terminators in one file, which is what a re-saved export looks like.
  assert.deepEqual(parseRows('a,b\r\n1,2\n3,4\r5,6'),
    [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
});

test('a CR inside quotes is DATA and survives the round trip', () => {
  const rows = parseRows('a,b\n"line1\rline2",z\n');
  assert.deepEqual(rows, [['a', 'b'], ['line1\rline2', 'z']]);
  assert.deepEqual(parseRows('a\n"x\r\ny"\n'), [['a'], ['x\r\ny']]);

  // The writer quotes CR on purpose; the reader must give the same bytes back.
  const value = 'note\rsecond half';
  const text = stringifyRows([['note'], [value]]);
  assert.equal(parseRows(text)[1][0], value);
  assert.ok(escapeField(value).startsWith('"'), 'escapeField must still quote a CR');
});

test('the formula neutraliser still fires on a CR-led value, and it round-trips', () => {
  // '\r=1+1' is one of the payloads in csv-formula-injection.test.mjs: Excel strips
  // leading whitespace before deciding whether a cell is a formula.
  const text = stringifyRows([['company_name'], ['\r=1+1']]);
  const back = parseRows(text);
  assert.equal(back.length, 2, 'the quoted CR must not be read as a record break');
  assert.equal(back[1][0], "'\r=1+1", 'the apostrophe marker must survive the read');
});

test('trailing newlines and blank lines are not records', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('a,b\r1,2\r'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('a,b\n1,2\n\n\n'), [{ a: '1', b: '2' }],
    'a blank line is skipped, not refused as ragged');
  assert.deepEqual(parseCsv(''), []);
});

// --- a duplicate header is refused, not silently collapsed -------------

test('a duplicate header column is STOP, not a dropped column', () => {
  const text = 'Email,Email\nnope@acme.example,ok@x.example\n';
  // Old behaviour: [{ Email: 'ok@x.example' }] — the suppressed address in the first
  // column was destroyed before the filter could ever see it.
  assert.throws(() => parseCsv(text), (e) => {
    assert.ok(e instanceof CsvStructureError);
    assert.equal(e.verdict, 'STOP');
    assert.match(e.message, /duplicate header column "Email"/);
    return true;
  });
  // Header cells are compared after trimming, the way they are used as keys.
  assert.throws(() => parseCsv('email, email\na,b\n'), CsvStructureError);
  // Different spellings are different columns: no data is lost, so nothing is refused.
  assert.deepEqual(parseCsv('Email,email\na@x.example,b@x.example\n'),
    [{ Email: 'a@x.example', email: 'b@x.example' }]);
});

// --- R3: a ragged record is refused, not silently trimmed or padded --------

test('a record with more fields than the header is STOP, not a dropped cell', () => {
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), (e) => {
    assert.ok(e instanceof CsvStructureError);
    assert.equal(e.verdict, 'STOP');
    assert.equal(e.record, 2);
    assert.match(e.message, /record 2 has 3 field\(s\) but the header has 2/);
    return true;
  });
});

test('a record with fewer fields than the header is STOP too', () => {
  // Short records are not harmless: they are what a swallowed delimiter or a lost
  // quote looks like, and the values then sit under column names that are not theirs.
  const e = thrown(() => parseCsv('email,first,last\nonly-one-value\n'));
  assert.ok(e instanceof CsvStructureError);
  assert.equal(e.record, 2);
});

test('the refusal names the file when it is given one', () => {
  const e = thrown(() => parseCsv('a,b\n1,2,3\n', { path: '/tmp/list.csv' }));
  assert.ok(e instanceof CsvStructureError);
  assert.equal(e.path, '/tmp/list.csv');
  assert.match(e.message, /\/tmp\/list\.csv/);
});

test('parseRows stays tolerant — erase must be able to read a malformed file', () => {
  // `/comply erase` reads with parseRows and rewrites records. Refusing there would
  // leave PII in place, which is the wrong failure for a deletion request.
  assert.deepEqual(parseRows('a,b\n1,2,3\n'), [['a', 'b'], ['1', '2', '3']]);
  assert.deepEqual(parseRows('Email,Email\nx,y\n'), [['Email', 'Email'], ['x', 'y']]);
});

// --- the production reader, not just the helper ----------------------------

test('readInputRows reads a CR-delimited .csv off disk as records', () => {
  const file = join(tmpRoot('compliance-csvterm-'), 'list.csv');
  writeFileSync(file, 'email,first_name\rp1@e.example,Ada\rp2@e.example,Bob\r', 'utf8');
  const rows = readInputRows(file);
  assert.equal(rows.length, 2, 'the enrich input reader used to see zero rows here');
  assert.deepEqual(rows.map(r => r.email), ['p1@e.example', 'p2@e.example']);
});

test('readInputRows refuses a ragged .csv rather than mis-columning it', () => {
  const file = join(tmpRoot('compliance-csvterm-'), 'ragged.csv');
  writeFileSync(file, 'email,first_name\np1@e.example,Ada,extra\n', 'utf8');
  assert.throws(() => readInputRows(file),
    e => e instanceof CsvStructureError && e.verdict === 'STOP');
});
