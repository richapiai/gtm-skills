// tests/contracts/doc-claims.test.mjs
//
// THE PROSE HALF OF LAW 6.
//
// `_lib/endpoint-owners.yaml` makes an endpoint gap impossible to leave accidental:
// every endpoint is claimed or listed `unclaimed:` WITH A REASON. `docs/claims.yaml`
// applies that shape to the numbers the front-door documents state about the pack, and
// this file enforces it.
//
// It exists because the same defect shipped three times, each time in a document rather
// than in code:
//
//   * "1,819 tests" while the suite ran several hundred more;
//   * "2,372 tests, 0 failing" while the suite ran 2,393 with 3 red — and claimed a
//     contract test guarded the number, which checks a BAND and never looked at the
//     "0 failing" half;
//   * "the pack has never made a real authenticated call, not once" for two days after
//     the capture run that made it false.
//
// The mechanism that was supposed to prevent this (`no-stale-catalog-claims`) only ever
// covered SKILL.md claims about other skills' existence, plus one field-map tally.
// README, LIMITATIONS, ROADMAP and CLAUDE.md were outside its perimeter entirely. This
// widens the perimeter and makes the registry itself checkable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The real YAML library, not the test helper's mini-parser: CLAUDE.md says parse YAML
// with the JS library, and the mini-parser cannot read a folded scalar whose line starts
// with a quotation mark — which every "reason" in the registry does.
import YAML from 'yaml';
import { allowedFieldMapStatuses } from '../../_lib/catalog/extract.mjs';
const parseYaml = (t) => YAML.parse(t);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const REGISTRY = parseYaml(read('docs/claims.yaml'));

/**
 * The front door: the documents a stranger reads before deciding to trust this, plus
 * the one every contributor works from.
 *
 * The local working log is deliberately absent — it is full of dated snapshots, and
 * holding a log to the current state would force rewriting history.
 */
const FRONT_DOOR = [
  'README.md', 'LIMITATIONS.md', 'ROADMAP.md', 'CLAUDE.md',
  'SECURITY.md', 'CONTRIBUTING.md',
  'docs/GETTING-STARTED.md', 'docs/INSTALL.md', 'docs/TROUBLESHOOTING.md',
].filter((f) => existsSync(join(ROOT, f)));

// ---------------------------------------------------------------------------
// The resolvers. Every one is a real computation over a real file.
// ---------------------------------------------------------------------------

function catalogFacts () {
  const c = JSON.parse(read('_lib/api-catalog.json'));
  // Every status the frozen contract allows resolves, at zero when no row carries it:
  // a zero count is a claim the tree can check, not a missing fact.
  const status = Object.fromEntries([...allowedFieldMapStatuses()].map((s) => [s, 0]));
  for (const e of Object.values(c.endpoints)) {
    status[e.field_map_status] = (status[e.field_map_status] ?? 0) + 1;
  }
  return { endpoint_count: Object.keys(c.endpoints).length, status };
}

function skillFacts () {
  const dir = join(ROOT, 'skills');
  const names = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort();
  const owners = parseYaml(read('_lib/endpoint-owners.yaml'));
  const catalog = JSON.parse(read('_lib/api-catalog.json'));

  // A skill is FREE when no metered endpoint names it as an owner and its own SKILL.md
  // invokes none. Derived, never listed — the same derivation the README's `free`
  // markers are checked against.
  const metered = new Set(Object.entries(catalog.endpoints)
    .filter(([, e]) => (e.pricing?.credits_per_call ?? 0) > 0
      || (e.pricing?.credits_per_result ?? 0) > 0)
    .map(([name]) => name));

  const ownedMetered = new Set();
  for (const [endpoint, skills] of Object.entries(owners.endpoints ?? {})) {
    if (!metered.has(endpoint)) continue;
    for (const s of [].concat(skills)) ownedMetered.add(s);
  }

  let free = 0;
  for (const name of names) {
    if (ownedMetered.has(name)) continue;
    const body = read(join('skills', name, 'SKILL.md'));
    const invokesMetered = [...metered].some((ep) => body.includes(ep));
    if (!invokesMetered) free += 1;
  }
  return { total: names.length, free };
}

function pkgFacts () {
  const p = JSON.parse(read('package.json'));
  return { engines_floor: String(p.engines?.node ?? '').replace(/^[^\d]*/, '') };
}

const FACTS = { catalog: catalogFacts(), skills: skillFacts(), pkg: pkgFacts() };

/** Resolve a dotted `source` path from docs/claims.yaml against the computed facts. */
function resolveSource (path) {
  let cur = FACTS;
  for (const seg of path.split('.')) {
    assert.ok(cur && Object.prototype.hasOwnProperty.call(cur, seg),
      `docs/claims.yaml names source "${path}", which does not resolve. A fact this file `
      + 'cannot derive belongs under hand_typed: with a reason, not under derived:.');
    cur = cur[seg];
  }
  return cur;
}

/** Prose only: frontmatter and fenced code are not claims. */
function prose (src) {
  let s = src;
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---\n', 4);
    if (end >= 0) s = s.slice(end + 5);
  }
  return s.replace(/^```[\s\S]*?^```/gm, '\n');
}

/** One paragraph, list item or table row — the unit a claim lives in. */
function units (src) {
  const out = [];
  for (const block of prose(src).split(/\n\s*\n/)) {
    let cur = null;
    for (const line of block.split('\n')) {
      if (/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line) || cur === null) {
        if (cur !== null) out.push(cur);
        cur = line;
      } else cur += ' ' + line;
    }
    if (cur !== null) out.push(cur);
  }
  return out.map((u) => u.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 1. The registry itself is honest.
// ---------------------------------------------------------------------------

test('CLAIMS — every derived fact actually derives, and every hand-typed one says why', () => {
  const d = REGISTRY.derived ?? {};
  assert.ok(Object.keys(d).length > 0, 'the registry must govern something');
  for (const [name, spec] of Object.entries(d)) {
    assert.ok(spec.source, `${name}: a derived fact needs a source`);
    assert.ok(spec.context, `${name}: a derived fact needs a context regex, or it matches every number`);
    const v = resolveSource(spec.source);
    assert.ok(typeof v === 'number' || typeof v === 'string',
      `${name}: source "${spec.source}" resolved to ${typeof v}, which is not a stateable value`);
  }
  for (const [name, spec] of Object.entries(REGISTRY.hand_typed ?? {})) {
    assert.ok(spec.reason && String(spec.reason).trim().length > 60,
      `${name}: a hand-typed number needs a REASON, at length. This is the same contract `
      + 'as `unclaimed:` in _lib/endpoint-owners.yaml — a deliberate exception and a '
      + 'forgotten one must never look alike.');
  }
});

test('CLAIMS — the registry derives from files, not from literals', () => {
  // The failure mode this catches: someone "fixes" a red build by pasting the current
  // number into the resolver, which turns the guard into the thing it was guarding.
  const self = read('tests/contracts/doc-claims.test.mjs');
  const body = self.slice(self.indexOf('function catalogFacts'), self.indexOf('const FACTS'));
  assert.ok(!/\b(?:68|33|35|30|11)\b/.test(body),
    'a resolver contains a literal count. Derive it from the file instead.');
});

// ---------------------------------------------------------------------------
// 2. No front-door document states a governed number wrongly.
// ---------------------------------------------------------------------------

test('CLAIMS — no front-door doc misstates a number the tree can derive', () => {
  const offenders = [];

  for (const file of FRONT_DOOR) {
    for (const unit of units(read(file))) {
      for (const [name, spec] of Object.entries(REGISTRY.derived ?? {})) {
        const truth = resolveSource(spec.source);
        if (typeof truth !== 'number') continue;
        if (!new RegExp(spec.context).test(unit)) continue;

        if (spec.form === 'of_population') {
          // `N of M`, and ONLY when M is this fact's population. Without that guard,
          // "11 of 21 metered endpoints" and "16 of 53 surviving endpoints" — real
          // claims about different populations — were read as contradictions of the
          // 68-endpoint tally.
          const pop = resolveSource(spec.population);
          for (const m of unit.matchAll(/\b(\d+)\s+of\s+(?:the\s+)?(\d+)\b/g)) {
            if (Number(m[2]) !== pop) continue;
            // "`field_map` is null on 68 of 68" is the field_map caveat, which is TRUE
            // and is about a different property from any status tally. A test that
            // shouts at the honest caveat gets the caveat deleted, which is the outcome
            // this whole file exists to prevent.
            if (/\bnull\b[^.]{0,40}$/.test(unit.slice(0, m.index))) continue;
            if (nearest(unit, m.index, REGISTRY.derived) !== name) continue;
            if (Number(m[1]) !== truth) {
              offenders.push(`${file}: says ${m[1]} of ${pop} for ${name}, derived ${truth}\n      ${unit.slice(0, 160)}`);
            }
          }
        } else if (spec.form === 'bare') {
          // `N endpoints` / `N skills` — the count immediately qualifying the noun.
          // Anchored to the noun so a nearby unrelated number cannot be mistaken for it.
          const re = new RegExp(`\\b(\\d+)\\s+(?:${spec.context})`, 'g');
          for (const m of unit.matchAll(re)) {
            const claimed = Number(m[1]);
            // A share statement (`N of M endpoints`) is governed by the of_population
            // facts, not by the bare population count.
            const before = unit.slice(Math.max(0, m.index - 12), m.index);
            if (/\bof\s+$/.test(before)) continue;
            if (/\b\d+\s+of\s+$/.test(unit.slice(Math.max(0, m.index - 20), m.index + m[1].length + 4))) continue;
            if (claimed !== truth) {
              offenders.push(`${file}: says ${claimed} for ${name}, derived ${truth}\n      ${unit.slice(0, 160)}`);
            }
          }
        }
      }
    }
  }

  assert.deepEqual(offenders, [],
    'a front-door document states a number the tree contradicts. Correct the DOCUMENT — '
    + 'these values are derived, so the document is what is wrong.');
});

/** Which governed fact a number at `at` is talking about: the nearest context match. */
function nearest (unit, at, derived) {
  let best = null;
  let bestD = Infinity;
  for (const [name, spec] of Object.entries(derived)) {
    const re = new RegExp(spec.context, 'g');
    for (const m of unit.matchAll(re)) {
      const d = Math.abs(m.index - at);
      if (d < bestD) { bestD = d; best = name; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. The specific sentences that shipped wrong, pinned so they cannot come back.
// ---------------------------------------------------------------------------

test('CLAIMS — no doc claims the pack has never made a live call', () => {
  // LIMITATIONS.md §1 said exactly this for two days after the capture run that made it
  // false, and the README contradicted it in the same repository.
  const captured = existsSync(join(ROOT, 'tests', 'fixtures', 'live', 'capture-report.json'));
  if (!captured) return;   // if the recordings are ever removed, the old claim is true again

  const DENIALS = [
    /never made a real authenticated call/i,
    /has never (?:made|reached) (?:a|the) live/i,
    /no live response fixtures/i,
    /no live (?:response )?(?:has|responses have) been captured/i,
  ];
  // Quoting the old claim in order to correct it is exactly what a good changelog entry
  // does, so a unit that marks the denial as PAST is fine. A unit that simply asserts it
  // is not. The markers are deliberately narrow: "used to", "before that date", "no
  // longer", "stopped being true", "this section read".
  const PAST = /\b(?:used to|no longer|until|before that date|stopped being true|section read|previously|was wrong|is no longer true|had shipped)\b/i;

  const offenders = [];
  for (const file of FRONT_DOOR) {
    for (const unit of units(read(file))) {
      if (PAST.test(unit)) continue;
      for (const re of DENIALS) {
        const m = new RegExp(re.source, re.flags.replace('g', '')).exec(unit);
        if (m) offenders.push(`${file}: "${m[0]}" — 55 responses are recorded in tests/fixtures/live/\n      ${unit.slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a document denies a capture that is on disk');
});

test('CLAIMS — the README does not overstate what guards its test count', () => {
  // The sentence claimed "a contract test fails once it drifts away from the size of the
  // suite, so this sentence cannot quietly rot". The guard checks a BAND, and nothing at
  // all checks the "0 failing" half — which was false when the sentence was written.
  const readme = read('README.md');
  if (!/tests, 0\s*\n?failing/.test(readme.replace(/\s+/g, ' '))) return;
  const flat = readme.replace(/\s+/g, ' ');
  assert.ok(!/cannot quietly rot/.test(flat),
    'the README claims its test count cannot rot. It can, and did: the guard checks a '
    + 'band, not an exact match.');
  assert.ok(/band/.test(flat) && /0 failing/.test(flat),
    'if the README states a test count it must also state what does and does not guard '
    + 'it — the band, and that nothing guards the "0 failing" half.');
});

test('CLAIMS — no doc describes the Bash grant as unscoped', () => {
  // Every grant was narrowed on 2026-09-02; a document still describing the old state
  // understates the pack's security posture, which is its own kind of dishonesty.
  const bare = [];
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const p = join(ROOT, 'skills', dir, 'SKILL.md');
    if (!existsSync(p)) continue;
    const m = /^allowed-tools:\s*(.+)$/m.exec(readFileSync(p, 'utf8'));
    if (m && m[1].split(',').map((s) => s.trim()).includes('Bash')) bare.push(dir);
  }
  if (bare.length) return;   // if the grants are ever widened again, the old prose is true

  const offenders = [];
  for (const file of FRONT_DOOR) {
    const p = prose(read(file));
    const m = /(?:unscoped|unrestricted)\s+Bash\s+grant|`allowed-tools`\s+is\s+unscoped/i.exec(p);
    if (m) offenders.push(`${file}: "${m[0]}" — no skill declares a bare Bash any more`);
  }
  assert.deepEqual(offenders, [], 'a document describes a security gap that has been closed');
});

test('CLAIMS — no doc says a missing jq reports the catalog as broken', () => {
  // The behaviour changed on 2026-09-02: a missing `jq` used to produce `CATALOG_OK: no`
  // on a valid catalog, which sent every skill to `richapi catalog gen` — a fix that
  // cannot work. It now reports `JQ_MISSING: yes` and marks the gated checks `unknown`.
  //
  // FOUR documents still described the old behaviour after the code changed, and the
  // number-based guard above could not see it because none of them states a number.
  // Behaviour claims need their own assertion, pinned to what the code actually does.
  const preflight = read('bin/richapi-skills-preflight');
  const degradesToUnknown = /CATALOG_OK: unknown/.test(preflight);
  if (!degradesToUnknown) return;   // if the behaviour is ever reverted, the old prose is true again

  const STALE = [
    /reports a healthy install as broken/i,
    /reports itself as broken/i,
    /`CATALOG_OK: no`[^.]{0,60}(healthy|valid|present)/i,
  ];
  const offenders = [];
  for (const file of FRONT_DOOR) {
    for (const unit of units(read(file))) {
      // A changelog-style past-tense account of the old behaviour is correct and stays.
      if (/\b(used to|until|no longer|previously|degraded into)\b/i.test(unit)) continue;
      for (const re of STALE) {
        const m = re.exec(unit);
        if (m) offenders.push(`${file}: "${m[0]}"`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'a document describes the pre-2026-09-02 jq degradation, which the preflight no '
    + 'longer does. It reports JQ_MISSING and `unknown`, not `no`.');
});
