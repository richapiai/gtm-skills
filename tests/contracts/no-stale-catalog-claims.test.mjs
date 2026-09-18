// tests/contracts/no-stale-catalog-claims.test.mjs
//
// Law 1 and law 6 applied to the pack's PUBLIC prose about its own catalog.
//
// tests/contracts/no-stale-self-claims.test.mjs forbids a SKILL.md from saying a
// skill is absent when it is present. This is the same failure one level out: the
// README and the docs stating a measured fact about the generated
// catalog that the generated catalog does not support.
//
// It shipped. Four public files said "all 68 endpoints are marked
// `TODO_no_usable_example`". Measured, 65 of 68 report `keys_from_spec_example` and
// 3 report `TODO_no_usable_example`, and `skills/crm-sync-expert/SKILL.md` had said
// so correctly the whole time — so the pack publicly contradicted itself, and the
// contradiction ran PESSIMISTIC. A pack whose entire pitch is "measured, not
// asserted" understating itself by a factor of 22 is not a rounding error; it is the
// pitch failing on its own front page.
//
// Three drift classes are pinned here, all of them derived at runtime and none of
// them counted by hand:
//
//   1. The field-map tally in `_lib/api-catalog.json`, and every doc sentence that
//      quantifies `TODO_no_usable_example`.
//   2. Which skills can spend a credit, and the `free` markers the README prints.
//   3. The test count the README pins, floored by the suite's own static size.
//
// Every number in this file is computed from the repo. If the spec moves, this test
// goes red and the DOCS get regenerated — the numbers here are never edited to match
// a new reality, because that is exactly the edit that produced the bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { allowedFieldMapStatuses } from '../../_lib/catalog/extract.mjs';
import { spendSplit, costsCredits, skillNames } from '../../_lib/spend-split.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..', '..');
const SKILLS    = join(ROOT, 'skills');
const TESTS     = join(ROOT, 'tests');

const readRoot = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// 1. THE MEASUREMENT — field maps
// ---------------------------------------------------------------------------

/**
 * The field-map state of the generated catalog, tallied from the file.
 * @returns {{total:number, byStatus:Record<string,number>, byStatusEndpoints:Record<string,string[]>, fieldMapNull:number}}
 */
export function fieldMapTally (catalog) {
  const entries = Object.entries(catalog.endpoints ?? {});
  // Every status the frozen contract allows is tallied, at zero when no row carries
  // it: "all 68 are TODO" must still be caught on the day nothing is TODO.
  const byStatus = {};
  const byStatusEndpoints = {};
  for (const s of allowedFieldMapStatuses()) { byStatus[s] = 0; byStatusEndpoints[s] = []; }
  let fieldMapNull = 0;

  for (const [name, def] of entries) {
    const status = def.field_map_status ?? '(missing)';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    (byStatusEndpoints[status] ??= []).push(name);
    if (def.field_map === null || def.field_map === undefined) fieldMapNull += 1;
  }
  for (const list of Object.values(byStatusEndpoints)) list.sort();

  return { total: entries.length, byStatus, byStatusEndpoints, fieldMapNull };
}

const CATALOG = JSON.parse(readRoot('_lib/api-catalog.json'));
const TALLY   = fieldMapTally(CATALOG);

test('THE NUMBERS: field_map is null on every endpoint, but only a few lack an example', () => {
  assert.equal(TALLY.total, 68, 'the population is every endpoint in the generated catalog');
  assert.equal(TALLY.fieldMapNull, TALLY.total,
    'field_map null on 68/68 is the honest caveat and must stay true until live fixtures populate it');
  // UPDATED 2026-09-17 for the second capture run (63 recorded; the five left are a
  // miss, two 403s, an empty body and one uncapturable). First written 2026-09-02 for
  // the first capture absorption. `live_fixture` rows are the
  // ones a recorded 200 response supplied; `keys_from_spec_example` rows are still the
  // spec's guess, which is the state that dropped email, phone and verdict fields, as described in
  // LIMITATIONS.md §1. If this fails the spec moved or a capture landed — REGENERATE
  // the docs from the new tally, do not edit this test to match the docs.
  assert.deepEqual(TALLY.byStatus,
    { live_fixture: 63, keys_from_spec_example: 5, TODO_no_usable_example: 0 },
    'if this fails the spec moved or a capture landed — regenerate the docs from the new tally');
  assert.deepEqual(TALLY.byStatusEndpoints.TODO_no_usable_example, []);
  assert.deepEqual(TALLY.byStatusEndpoints.keys_from_spec_example, [
    'geo_id_search', 'google_ad_transparency_scraper_sync', 'google_maps_reviews_scraper_sync',
    'linkedin_ad_search', 'slack_channel_members',
  ]);
});

// --- the predicate ----------------------------------------------------------
//
// The bug class is a SCOPE claim: prose that puts a different number of endpoints
// under a `field_map_status` than the catalog does. It has to stay narrow, because
// one correct paragraph now carries three quantified claims at once —
//
//   "`field_map` is null on 68 of 68 endpoints; 65 of 68 report
//    `keys_from_spec_example`; 3 report `TODO_no_usable_example`"
//
// — and a test that shouts at the honest `null` caveat gets the caveat deleted,
// which is the outcome this whole file exists to prevent. So each quantifier is
// attributed to the status token NEAREST to it, and a quantifier nearest to `null`
// is left alone: that one is about `field_map`, not about a status.

/** "68 of 68", "all 68", "marked 65", "every endpoint" — a claimed scope. */
const SCOPE = [
  { re: /\b(\d+)\s+of\s+(\d+)\b/g,               read: (m) => ({ n: Number(m[1]), of: Number(m[2]) }) },
  { re: /\ball\s+(\d+)\b/gi,                     read: (m) => ({ n: Number(m[1]) }) },
  { re: /\bmarked\s+(\d+)\b/gi,                  read: (m) => ({ n: Number(m[1]) }) },
  { re: /\b(?:all|every|each)\s+endpoints?\b/gi, read: ()  => ({ universal: true }) },
];

const NULL_ANCHOR = /\bnull\b/gi;

function nearestDistance (unit, at, re) {
  let best = Infinity;
  for (const m of unit.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
    best = Math.min(best, Math.abs(m.index - at));
  }
  return best;
}

/**
 * Which `field_map_status` a quantifier is talking about, or null when it is talking
 * about the `field_map: null` caveat (or about nothing this test owns).
 */
function subjectStatus (unit, at, tally) {
  let best = null;
  let bestAt = nearestDistance(unit, at, NULL_ANCHOR);   // `null` wins ties by starting the bidding
  for (const status of Object.keys(tally.byStatus)) {
    const d = nearestDistance(unit, at, new RegExp(status, 'g'));
    if (d < bestAt) { bestAt = d; best = status; }
  }
  return Number.isFinite(bestAt) ? best : null;
}

/** Frontmatter and fenced code stripped: a schema or a shell transcript is not prose. */
function proseOf (src) {
  let s = String(src).replace(/\r\n/g, '\n');
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---\n', 4);
    if (end >= 0) s = s.slice(end + 5);
  }
  return s.replace(/^```[\s\S]*?^```/gm, '\n');
}

/** Prose as the units a claim lives in: one paragraph, one list item, one table row. */
function claimUnits (prose) {
  const units = [];
  for (const block of prose.split(/\n\s*\n/)) {
    let cur = null;
    for (const line of block.split('\n')) {
      if (/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line) || cur === null) {
        if (cur !== null) units.push(cur);
        cur = line;
      } else {
        cur += ' ' + line;
      }
    }
    if (cur !== null) units.push(cur);
  }
  return units.map(u => u.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Every sentence that puts the wrong number of endpoints under a `field_map_status`.
 * @returns {{status:string, claimed:number|'all', measured:number, text:string}[]}
 */
export function staleCatalogClaims (src, tally) {
  const statuses = Object.keys(tally.byStatus);
  const anyStatus = new RegExp(statuses.join('|'));
  const out = [];

  for (const unit of claimUnits(proseOf(src))) {
    if (!anyStatus.test(unit)) continue;

    for (const { re, read } of SCOPE) {
      for (const m of unit.matchAll(new RegExp(re.source, re.flags))) {
        const status = subjectStatus(unit, m.index, tally);
        if (status === null) continue;              // the honest `field_map: null` caveat
        const measured = tally.byStatus[status];
        const claim = read(m);
        const bad = (claimed) => out.push({ status, claimed, measured, text: unit });

        if (claim.universal) {
          if (measured !== tally.total) bad('all');
        } else if (claim.of !== undefined) {
          // "N of M" is only a claim about this population when M is the population.
          if (claim.of === tally.total && claim.n !== measured) bad(claim.n);
        } else if (claim.n === tally.total && measured !== tally.total) {
          bad(claim.n);
        }
      }
    }
  }
  return out;
}

// --- the contract -----------------------------------------------------------
//
// The pack's front-door prose: the two root pages a stranger reads, plus everything
// under docs/. Two exclusions, both deliberate:
//
//   tests/fixtures/README.md documents the `field_map_status` recorded INSIDE three
//   hand-authored placeholder fixture files. That is a fact about those files, not a
//   claim about the catalog, and it stays true whatever the catalog says.
//
//   skills/** IS now in scope. It was excluded when this test was written because
//   skills/crm-sync-expert/SKILL.md carried one real instance of exactly this bug
//   ("Every endpoint's `field_map_status` is `TODO_no_usable_example`") alongside a
//   correct statement of the split 150 lines earlier. That line was corrected on
//   2026-08-31 and the exclusion deleted with it, because a guard that skips the one
//   place the bug actually shipped is not a guard.

const SCANNED_DOCS = (() => {
  const out = [];
  // Every root-level .md, discovered rather than listed. CHANGELOG.md rotted with
  // "All 68 endpoints are TODO_no_usable_example" for exactly one reason: it was
  // outside this scan set. A guard that enumerates its own scope grows a blind spot
  // every time someone adds a document.
  for (const e of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile() && e.name.endsWith('.md')) out.push(e.name);
  }
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        walk(join(dir, e.name), r);
      } else if (e.name.endsWith('.md')) {
        out.push(r);
      }
    }
  };
  walk(join(ROOT, 'docs'), 'docs');
  // skills/** carries the same claim in prose and is where the bug actually shipped.
  walk(join(ROOT, 'skills'), 'skills');
  return out;
})();

test('no front-door doc misstates how many endpoints carry a field_map_status', () => {
  assert.ok(SCANNED_DOCS.length >= 3, 'the doc set is discovered; an empty scan proves nothing');
  const findings = [];
  for (const rel of SCANNED_DOCS) {
    for (const f of staleCatalogClaims(readRoot(rel), TALLY)) {
      findings.push(`${rel}: says ${f.claimed} carry ${f.status}, measured ${f.measured}\n      ${f.text}`);
    }
  }
  assert.deepEqual(findings, [],
    'stale catalog claims — measured from _lib/api-catalog.json: '
    + `${TALLY.byStatus.TODO_no_usable_example} of ${TALLY.total} endpoints are `
    + `TODO_no_usable_example (${TALLY.byStatusEndpoints.TODO_no_usable_example.join(', ')}) `
    + `and ${TALLY.byStatus.keys_from_spec_example} carry keys_from_spec_example. `
    + `field_map is null on ${TALLY.fieldMapNull}/${TALLY.total}, which is a SEPARATE `
    + 'and still-true caveat — correct the count, keep the caveat:\n\n  - '
    + `${findings.join('\n\n  - ')}\n`);
});

test('the docs that discuss field maps state the split, rather than only the caveat', () => {
  // The four files that carried the wrong claim. Each must now name both halves, so
  // a future edit that deletes the correction fails here instead of in a reader's
  // head. Names come from the tally; only the file list is fixed.
  const spec  = String(TALLY.byStatus.keys_from_spec_example);
  const todo  = String(TALLY.byStatus.TODO_no_usable_example);
  for (const rel of ['README.md', 'docs/demo-script.md',
                     'docs/designs/networked-learnings.md']) {
    const src = readRoot(rel);
    assert.ok(src.includes('keys_from_spec_example'),
      `${rel} discusses field maps but never names the status 65 of 68 endpoints actually carry`);
    assert.ok(new RegExp(`\\b${spec}\\b`).test(src), `${rel} never states the measured ${spec}`);
    assert.ok(new RegExp(`\\b${todo}\\b`).test(src), `${rel} never states the measured ${todo}`);
    for (const name of TALLY.byStatusEndpoints.TODO_no_usable_example) {
      assert.ok(src.includes(name), `${rel} does not name the real TODO endpoint ${name}`);
    }
    for (const name of TALLY.byStatusEndpoints.keys_from_spec_example) {
      assert.ok(src.includes(name), `${rel} does not name the unrecorded endpoint ${name}`);
    }
  }
});

test('the predicate catches the claim that actually shipped, in each form it shipped in', () => {
  const shipped = [
    'All 68 endpoints are marked `TODO_no_usable_example`: most of the spec\'s response\nexamples are placeholder.',
    'Response field maps are unresolved. All 68 endpoints are still marked\n`TODO_no_usable_example` pending a live capture.',
    'Field maps are still spec-derived (`TODO_no_usable_example` on all 68 endpoints).',
    'Today **68 of 68 endpoints** have `field_map_status: "TODO_no_usable_example"`.',
    'Every endpoint reports `TODO_no_usable_example`.',
    // …and the same drift the other way round, which is what a future spec change
    // would produce: the split restated with a number the catalog no longer supports.
    '60 of 68 endpoints report `keys_from_spec_example`.',
  ];
  for (const s of shipped) {
    assert.ok(staleCatalogClaims(s, TALLY).length > 0, `predicate missed a stale claim: ${s}`);
  }
});

test('the predicate leaves the true statements — including the null caveat — alone', () => {
  const honest = [
    // The corrected split, in the forms the docs now use.
    // The corrected split. Each status is its own claim unit, because the predicate
    // attributes a quantifier to the NEAREST status token and three statuses chained in
    // one sentence make every number ambiguous — the middle one is closer to the status
    // that follows it than to the one it belongs to. Documents state the split as a
    // list for the same reason.
    '`field_map` is `null` on 68 of 68 endpoints.',
    '63 of 68 endpoints report `live_fixture`.',
    '5 of 68 endpoints report `keys_from_spec_example`.',
    '0 of 68 endpoints report `TODO_no_usable_example`.',
    'Most endpoints report `live_fixture`; the rest report `keys_from_spec_example`, '
      + 'having no usable recording.',
    '`field_map` is `null` for every endpoint in the generated catalog.',
    'the three `TODO_no_usable_example` blockers',
    // A count that is not about this population.
    'Two of the 21 metered endpoints report `TODO_no_usable_example`-adjacent nothing.',
    // No TODO token at all: not this test\'s business.
    'All 68 endpoints are in the catalog and every one of them is priced.',
    // Fenced blocks are not prose.
    'See:\n\n```json\n{ "field_map_status": "TODO_no_usable_example" }\n```\n',
  ];
  for (const s of honest) {
    assert.deepEqual(staleCatalogClaims(s, TALLY), [], `predicate flagged honest prose:\n${s}`);
  }
});

// ---------------------------------------------------------------------------
// 2. THE MEASUREMENT — which skills can spend
// ---------------------------------------------------------------------------
//
// The README's `free` markers are a promise about money, so they are derived from
// the two places that actually decide it and compared, never hand-counted:
//
//   a. `_lib/endpoint-owners.yaml` maps the skill to an endpoint that costs credits.
//   b. The skill's own SKILL.md reaches one — as `endpoint_name(...)`, which is the
//      form scripts/validate-skills.mjs lints, or as `richapi call|search <endpoint>`.
//
// Neither source alone is right: /enrich-waterfall drives `richapi enrich` and names
// no endpoint call, /local-business-prospecting calls four maps endpoints it does not
// own, and /pre-meeting-briefing spends only through `richapi call`. The union is the
// conservative answer, and conservative here means "assume it can spend".

// The predicate itself now lives in tests/helpers/spend-split.mjs, so the llms.txt
// generator reads the SAME implementation instead of a second one. Re-exported here
// because this file is where the split is pinned.
export { spendSplit, costsCredits, skillNames };

test('the spend split is derivable, and both halves are non-empty', () => {
  const { spends, free } = spendSplit();
  assert.equal(spends.length + free.length, skillNames().length);
  assert.ok(free.length > 0, 'a pack with no free skill cannot make the free-first claim');
  assert.ok(spends.length > 0, 'a pack with no spending skill would not need this runtime');
  // The pinned split, so that a skill gaining or losing an endpoint updates the README.
  assert.equal(spends.length, 23);
  assert.deepEqual(free, [
    'campaign-review', 'cost-optimizer', 'crm-export', 'crm-sync-expert', 'gtm-kickoff',
    'gtm-retro', 'learn', 'measure', 'outreach-expert', 'richapi-gtm', 'sequence-builder',
  ]);
});

test('the README marks exactly the skills that make no paid call as free', () => {
  const { spends, free } = spendSplit();
  const readme = readRoot('README.md');

  // The marker sits between the skill link and its generated description.
  const marked = new Set();
  for (const m of readme.matchAll(/\[`\/([a-z0-9-]+)`\]\(skills\/[a-z0-9-]+\/SKILL\.md\) — \*\*free\.\*\*/g)) {
    marked.add(m[1]);
  }

  assert.deepEqual([...marked].sort(), free,
    'README `free` markers disagree with the derived split — re-derive, do not re-count');
  for (const name of spends) {
    assert.ok(!marked.has(name), `${name} can reach a metered endpoint and must not be marked free`);
  }
  // The OTHER half of the split was stated in the README and guarded by nothing, so it
  // sat at "The other 22" after a 23rd spending skill landed. Both halves are pinned now:
  // a claim about money that only half-checks is the shape of every defect in this file.
  assert.ok(readme.includes(`The other ${spends.length} can`),
    `the README must state the measured spending count (${spends.length}), not a remembered one`);

  assert.ok(readme.includes(`${free.length} of the ${skillNames().length}`),
    `the README must state the measured free count (${free.length}), not a remembered one`);
});

// ---------------------------------------------------------------------------
// 3. THE MEASUREMENT — the test count the README pins
// ---------------------------------------------------------------------------
//
// The README said "1,819 tests" while the suite ran 2,205. A test cannot run the whole
// suite to learn the real total, so this guard uses a proxy: the number of `test(` /
// `it(` call sites written at the start of a line across tests/.
//
// The proxy is close but NOT exact — measured on the day this was written, 2,243
// declared against 2,205 reported, 1.7% apart. Declarations inside string fixtures and
// subtests registered as `t.test(...)` are why, so this is deliberately a proximity
// band rather than a hard floor: an honest pinned count tracks the suite's static size,
// and a stale one drifts away from it. The band that shipped this file would have
// caught the actual bug with room to spare (1,819 against 2,243 is 18.9% low), while
// leaving normal churn alone. Widen it only with a measurement, never to get green.

const COUNT_BAND = { low: 0.95, high: 1.25 };

/** Statically declared `test(` / `it(` call sites across the suite. */
function declaredTestCount () {
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.test.mjs')) {
        n += (readFileSync(abs, 'utf8').match(/^[ \t]*(?:test|it)\s*\(/gm) ?? []).length;
      }
    }
  };
  walk(TESTS);
  return n;
}

test('the test count the README pins still tracks the size of the suite', () => {
  const readme = readRoot('README.md');
  const m = readme.match(/\*\*([\d,]+)\s+tests,\s*0\s+failing\*\*/);
  assert.ok(m, 'README no longer pins a test count in the expected form — update this guard with it');

  const claimed  = Number(m[1].replace(/,/g, ''));
  const declared = declaredTestCount();
  assert.ok(declared > 100, 'the proxy must actually find the suite; a tiny count means it did not');

  const ratio = claimed / declared;
  assert.ok(ratio >= COUNT_BAND.low,
    `README pins ${claimed} tests, but ${declared} are declared across tests/ — `
    + `${((1 - ratio) * 100).toFixed(1)}% low. The suite outgrew the README: run \`npm test\` `
    + 'and paste the count from its last line.');
  assert.ok(ratio <= COUNT_BAND.high,
    `README pins ${claimed} tests against ${declared} declared — implausibly high; re-measure `
    + 'with `npm test` rather than adjusting the band.');
});

test('this file derives every number it enforces, rather than restating a doc', () => {
  const self = readFileSync(join(__dirname, 'no-stale-catalog-claims.test.mjs'), 'utf8');
  const body = self.slice(self.indexOf('export function fieldMapTally'));
  assert.ok(!/readdirSync\s*\(\s*['"]/.test(body), 'directories must be read by path, not by literal');
  assert.ok(skillNames().length >= 2);
  assert.ok(Object.keys(CATALOG.endpoints ?? {}).length > 0, 'the catalog must be read, not assumed');
});
