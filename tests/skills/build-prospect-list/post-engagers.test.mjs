// tests/skills/build-prospect-list/post-engagers — the post-engagers list source.
//
// A pasted post URL has to become the URN the post endpoints require, locally and for
// free, and anything that is not unambiguously one post is refused before a credit is
// spent (law 5). The walk over engagers is page-gated like every other paged search,
// because each page is a separate flat charge.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { postUrnFrom, POST_URN_ENDPOINTS } from '../../../_lib/linkedin-urn.mjs';
import { buildRequestFor, runSearch } from '../../../_lib/run.mjs';
import { CATALOG, fixture, cannotCall } from '../../run-surface/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const body = fs.readFileSync(path.join(ROOT, 'skills', 'build-prospect-list', 'SKILL.md'), 'utf8');

const ID = '7458532524865232896';

test('every accepted post URL form resolves to exactly one URN', () => {
  const cases = [
    [`urn:li:activity:${ID}`, `urn:li:activity:${ID}`],
    [`https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`, `urn:li:activity:${ID}`],
    [`https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A${ID}`, `urn:li:ugcPost:${ID}`],
    [`https://www.linkedin.com/posts/jane-doe_launch-day-activity-${ID}-AbCd`, `urn:li:activity:${ID}`],
    [`https://linkedin.com/posts/acme_hiring-ugcPost-${ID}-x1Y2/?utm_source=share`, `urn:li:ugcPost:${ID}`],
    [`  https://uk.linkedin.com/feed/update/urn:li:activity:${ID}  `, `urn:li:activity:${ID}`],
  ];
  for (const [input, urn] of cases) {
    assert.deepEqual(postUrnFrom(input), { ok: true, urn }, input);
  }
});

test('anything that is not one post is refused with a reason', () => {
  const refused = [
    '',
    null,
    'not a url',
    `https://example.com/feed/update/urn:li:activity:${ID}`,
    'https://www.linkedin.com/in/jane-doe/',
    'https://www.linkedin.com/company/acme/',
    'https://www.linkedin.com/sales/search/people?query=x',
    `https://www.linkedin.com/feed/update/urn:li:share:${ID}/`,
    `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/urn:li:activity:1/`,
    'https://www.linkedin.com/feed/update/%E0%A4%A/',
  ];
  for (const input of refused) {
    const r = postUrnFrom(input);
    assert.equal(r.ok, false, String(input));
    assert.ok(r.reason && r.reason.length > 0, `refusal for ${input} must say why`);
  }
});

test('post_url becomes urn for the post endpoints, and post_url itself is never sent', () => {
  for (const endpoint of POST_URN_ENDPOINTS) {
    assert.ok(CATALOG.endpoints[endpoint], `${endpoint} missing from the catalog`);
    const req = buildRequestFor(endpoint, {}, CATALOG, {
      params: { post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/` },
    });
    assert.equal(req.ok, true, req.reason);
    assert.equal(req.payload.urn, `urn:li:activity:${ID}`);
    assert.ok(!('post_url' in req.payload), 'post_url is an input column, not a request field');
  }
});

test('an unreadable post_url is a refused unit, not a paid call', () => {
  const req = buildRequestFor('post_activities', {}, CATALOG, {
    params: { post_url: 'https://www.linkedin.com/company/acme/' },
  });
  assert.equal(req.ok, false);
  assert.match(req.reason, /post_activities/);
});

test('walking engager pages is page-gated on the plan, with zero calls', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'post_activities',
    params: { post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`, type: 'COMMENT' },
    pages: 3,
    startPage: 0,
    root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });
  assert.equal(res.calls_made, 0);
  assert.ok(res.plan.totals.credits_estimated > 0, 'each page is priced from the catalog');
  const pageConfirms = res.gate.confirms.filter((c) => String(c.gate).startsWith('unbounded_endpoints'));
  assert.equal(pageConfirms.length, 2, 'every page after the first asks');
});

test('the skill documents the post-engagers path end to end', () => {
  const pathC = body.split(/^### /m).find((s) => /^Path C/i.test(s));
  assert.ok(pathC, 'no "Path C" post-engagers section');
  for (const name of ['post_details', 'post_activities']) {
    assert.match(pathC, new RegExp('`' + name + '\\('), `${name} must be invoked in Path C`);
  }
  assert.match(pathC, /post_url/, 'the CLI input is post_url');
  assert.match(pathC, /zero-based/i, 'post_activities pages start at 0');
  assert.match(pathC, /COMMENT/);
  assert.match(pathC, /REACTION/);
  assert.match(pathC, /unmatched/, 'rows matching no rule are shown, not dropped');
  assert.match(pathC, /icp-review/, 'an empty persona list points at /icp-review');
  assert.match(pathC, /gates\.yaml:unbounded_endpoints\.pages_before_confirm/);
});

test('Path C names the recorded engager fields, the precedence rule, and the hand-off', () => {
  const pathC = body.split(/^### /m).find((s) => /^Path C/i.test(s));
  const rec = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'live', 'post_activities.json'), 'utf8'));
  const row = rec.body.content[0];
  // Every field the skill tells the agent to read must exist in the recording.
  for (const key of ['headline', 'entityUrn']) {
    assert.ok(key in row.commenter, `recording has no commenter.${key}`);
    assert.match(pathC, new RegExp('commenter\\.' + key), `Path C must name commenter.${key}`);
  }
  assert.ok('id' in row && 'url' in row, 'recording lost id/url');
  assert.ok(!('title' in row.commenter) && !('company' in row.commenter),
    'the recording now carries a title or company: revisit the headline-only rule');
  assert.match(pathC, /exclude wins over include/i, 'the precedence rule must be stated');
  assert.match(pathC, /no job title and no company/i);
  assert.match(pathC, /`urn` = `commenter\.entityUrn`/, 'kept rows carry urn for bulk enrichment');
  assert.match(pathC, /overlap/i, 'pages can overlap');
  assert.match(pathC, /by `id`/, 'rows are deduped by id');
  assert.match(pathC, /min_rows_to_continue/);
});

test('the post-engagers recipe and Step 8 agree on the min_rows_to_continue stop', () => {
  const recipe = body.slice(body.indexOf('### post-engagers-to-list'),
    body.indexOf('### domains-to-decision-makers'));
  const step8 = body.slice(body.indexOf('## Step 8'),
    body.indexOf('## What this skill will not do'));
  for (const text of [recipe, step8]) {
    assert.match(text, /gates\.yaml:skills\.build_prospect_list\.min_rows_to_continue/);
    assert.match(text, /stop/i);
    assert.match(text, /unmatched/);
    assert.match(text, /wide/i);
  }
});
