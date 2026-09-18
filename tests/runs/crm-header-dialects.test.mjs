// A list arrives from a CRM, and every mainstream CRM exports Title Case with
// spaces: `First Name`, `Company Name`, `LinkedIn URL`. The planner reads exact
// lowercase snake_case.
//
// So the single most common input in the GTM world planned as ZERO calls, zero
// credits, and reported every row as "no linkedin_url to enrich from" — a
// header-parsing failure worded as an accusation about the user's data. It was
// silent (no error), free (no spend), and wrong in the direction that looks like
// the customer's fault, which is the direction nobody files a bug about.
//
// Measured before the fix, on the same two contacts:
//   Title Case headers -> 0 calls, 0 credits, "2 with no usable input"
//   snake_case headers -> 5 calls, 11 credits
//
// These tests pin the dialects, and pin that snake_case did not change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readInputRows } from '../../_lib/enrich.mjs';

function listFile (csv, name = 'list.csv') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-dialect-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, csv, 'utf8');
  return p;
}

test('a HubSpot-style Title Case export exposes canonical keys', () => {
  const p = listFile(
    'First Name,Last Name,Email,Company Name,Website URL,LinkedIn URL\n'
    + 'Jane,Doe,jane@acme.com,Acme Corp,acme.com,https://linkedin.com/in/janedoe\n',
  );
  const [row] = readInputRows(p);
  assert.equal(row.first_name, 'Jane');
  assert.equal(row.last_name, 'Doe');
  assert.equal(row.email, 'jane@acme.com');
  assert.equal(row.company_name, 'Acme Corp');
  assert.equal(row.linkedin_url, 'https://linkedin.com/in/janedoe',
    'the profile URL is what enrich_profile needs; without it the row plans as zero calls');
  assert.equal(row.website, 'acme.com',
    'RECORD_MAPPINGS.enrich_company already reads `website` — it just never saw it');
});

test('Apollo / Salesforce spellings reach the same canonical keys', () => {
  const p = listFile(
    'First Name,Last Name,Email,Company,Website,Person Linkedin Url\n'
    + 'Ada,Lovelace,ada@analytical.io,Analytical Engines,analytical.io,https://linkedin.com/in/adalovelace\n',
  );
  const [row] = readInputRows(p);
  assert.equal(row.linkedin_url, 'https://linkedin.com/in/adalovelace');
  assert.equal(row.company_name, 'Analytical Engines');
  assert.equal(row.website, 'analytical.io');
});

test('the original columns survive, so an export keeps what it arrived with', () => {
  const p = listFile('First Name,Email\nJane,jane@acme.com\n');
  const [row] = readInputRows(p);
  assert.equal(row['First Name'], 'Jane', 'the original header must not be consumed');
  assert.equal(row.first_name, 'Jane', 'and the canonical alias must exist alongside it');
});

test('an alias never overwrites a key the row already carries', () => {
  // `Email` and `email` are different headers, so parseCsv's duplicate check lets
  // both through. Deciding which address is real is not this layer's call — the one
  // already in canonical form stands.
  const p = listFile('Email,email\nWRAPPED@acme.com,canonical@acme.com\n');
  const [row] = readInputRows(p);
  assert.equal(row.email, 'canonical@acme.com',
    'the pre-existing canonical key wins; the alias must not clobber it');
});

test('snake_case input is unchanged', () => {
  const p = listFile(
    'first_name,last_name,email,company_name,domain,linkedin_url\n'
    + 'Jane,Doe,jane@acme.com,Acme,acme.com,https://linkedin.com/in/janedoe\n',
  );
  const [row] = readInputRows(p);
  assert.equal(row.first_name, 'Jane');
  assert.equal(row.email, 'jane@acme.com');
  assert.equal(row.domain, 'acme.com');
  assert.equal(row.linkedin_url, 'https://linkedin.com/in/janedoe');
});

test('jsonl input gets the same treatment as csv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-dialect-jsonl-'));
  const p = path.join(dir, 'list.jsonl');
  fs.writeFileSync(p, JSON.stringify({ 'First Name': 'Jane', 'LinkedIn URL': 'https://x/in/j' }) + '\n', 'utf8');
  const [row] = readInputRows(p);
  assert.equal(row.first_name, 'Jane');
  assert.equal(row.linkedin_url, 'https://x/in/j');
});

test('a row with no recognisable identity is still left alone', () => {
  // Normalisation must not invent a value. A genuinely unusable row has to stay
  // unusable, or "no usable input" stops meaning anything.
  const p = listFile('Notes,Score\nsome note,42\n');
  const [row] = readInputRows(p);
  assert.equal(row.email, undefined);
  assert.equal(row.linkedin_url, undefined);
  assert.equal(row.notes, 'some note');
});
