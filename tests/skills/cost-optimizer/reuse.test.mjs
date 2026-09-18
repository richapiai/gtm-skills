// The pack has exactly ONE cost calculation. These tests assert that neither of this
// suite's skills became the second one.
//
// This is a source-level check, which is unusual and deliberate. The behavioural tests
// next door prove the current numbers are right; they cannot prove the numbers stayed
// right for the right reason. A future edit that replaces `buildReceipt` with a local
// `floor + ceiling` sum would keep every honesty test green on today's fixtures and
// silently fork the arithmetic — and a fork is how the receipt's floor/ceiling
// convention and the ledger's stop being the same convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractScript } from '../scheduled-workflow/helpers.mjs';

const COST = extractScript('cost-optimizer', '==== gtm-cost-optimizer v1 ====');
const SCHEDULE = extractScript('scheduled-workflow', '==== gtm-schedule v1 ====');

test('/cost-optimizer prices every figure through the pack\'s own ledger and receipt', () => {
  assert.match(COST, /import \{ Ledger \} from '\.\/_lib\/ledger\.mjs'/);
  assert.match(COST, /import \{ buildReceipt, assertNeverOverstates \} from '\.\/_lib\/receipt\.mjs'/);
  assert.match(COST, /import \{[^}]*cacheTtlDays[^}]*\} from '\.\/_lib\/gates\.mjs'/);
  assert.match(COST, /import \{ readJournal, summarize \} from '\.\/_lib\/journal\.mjs'/);
});

/** Source with `//` comments stripped, so a rationale in prose is not read as code. */
function code (src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** A guard is only a guard if nothing catches it. */
function uncaught (src, callRe, label) {
  const calls = [...src.matchAll(callRe)];
  assert.ok(calls.length > 0, `${label}: the guard is not called at all`);
  for (const m of calls) {
    const after = src.slice(m.index, m.index + 300);
    assert.ok(!/\bcatch\s*\(/.test(after),
      `${label}: the guard is inside a try — a receipt that cannot be proven must crash `
      + 'the report, not be softened into one');
  }
  return calls.length;
}

test('/cost-optimizer runs the never-overstate guard and never catches it', () => {
  const n = uncaught(code(COST), /assertNeverOverstates\(/g, 'cost-optimizer');
  assert.ok(n >= 2, 'the guard must run over each finding\'s line set AND over the whole ledger');
});

test('/cost-optimizer never reads a raw credit field — only the receipt turns lines into a number', () => {
  // Everything downstream of priceLines is selection and formatting. The moment a
  // second function starts adding up credits_estimated or credits_actual, the pack has
  // two cost calculations and they will disagree.
  const offenders = code(COST).split('\n')
    .filter((l) => /\bcredits_(?:actual|estimated)\b/.test(l));
  assert.deepEqual(offenders, [],
    'a credit field is read outside the receipt: ' + offenders.join(' | '));
  assert.match(COST, /r\.credits_floor/);
  assert.match(COST, /r\.credits_ceiling/);
});

test('/cost-optimizer never treats a known_zero line as evidence', () => {
  // A non-2xx deducts no credits. Building a saving on those lines claims money that was
  // never spent, which is the mirror image of fabricating an actual.
  assert.match(COST, /cost_status === 'actual' \|\| l\.cost_status === 'estimated_unverifiable'/);
  assert.ok(!/cost_status !== 'known_zero'/.test(COST),
    'allowlist the two charged statuses rather than denylisting one — a new status added '
    + 'to the ledger contract must default to NOT being evidence');
});

test('/scheduled-workflow burns the envelope through the same receipt, not its own sum', () => {
  assert.match(SCHEDULE, /import \{ buildReceipt, assertNeverOverstates, spendPhrase \} from '\.\/_lib\/receipt\.mjs'/);
  assert.match(SCHEDULE, /const burn = receipt\.credits_ceiling;/);
  assert.ok(!/credits_floor\s*[;,)]?\s*\/\/\s*burn/i.test(SCHEDULE));
  uncaught(code(SCHEDULE), /assertNeverOverstates\(receipt, ledger\);/g, 'scheduled-workflow');
});

test('/scheduled-workflow asks the pack\'s gate engine rather than listing gates itself', () => {
  assert.match(SCHEDULE, /import \{ gatePlanFor \} from '\.\/_lib\/run\.mjs'/);
  assert.match(SCHEDULE, /gatePlanFor\(\{ plan: fresh\.plan, catalog: cat, session, pages: fresh\.pages \}\)/);
  // The always-ask list, the disabled list and the page ceiling must NOT be restated
  // here; they are read through the engine. A copy is a copy that goes stale.
  const src = code(SCHEDULE);
  for (const leaked of ['phone_finder', 'find_personal_email', 'post_keyword_search']) {
    assert.ok(!src.includes(leaked),
      `the script names ${leaked} directly — that list lives in gates.yaml and is read `
      + 'through gatePlanFor, never restated');
  }
});

test('/scheduled-workflow reuses the CLI\'s spend-confirmation rule verbatim', () => {
  assert.match(SCHEDULE, /import \{ confirmAccepted \} from '\.\/bin\/richapi\.mjs'/);
  assert.match(SCHEDULE, /confirmAccepted\(process\.env\.APPROVE, envelope\)/);
  assert.ok(!/APPROVE\s*===\s*'y'/.test(SCHEDULE));
});

test('neither script makes an HTTP call, imports a client, or reads an API key', () => {
  for (const [name, src] of [['cost-optimizer', COST], ['scheduled-workflow', SCHEDULE]]) {
    assert.ok(!/\bfetch\s*\(/.test(src), `${name} calls fetch`);
    assert.ok(!/node:https?\b/.test(src), `${name} imports http`);
    assert.ok(!/client\.mjs/.test(src), `${name} imports the API client`);
    assert.ok(!/API_KEY|RICHAPI_KEY/.test(src), `${name} reads an API key`);
    assert.ok(!/ai_enrich/.test(src), `${name} references the paid inference endpoint`);
  }
});
