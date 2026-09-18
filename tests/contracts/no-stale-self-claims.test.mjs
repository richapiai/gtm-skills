// tests/contracts/no-stale-self-claims.test.mjs
//
// Law 6 applied to the pack's prose about itself.
//
// Thirty-three skills were authored in parallel by workstreams that could not see each
// other. Each one wrote down the state of the pack *at the moment it was written*,
// and every one of those sentences went stale the instant another workstream landed. The
// router shipped saying "One skill is implemented"; /list-hygiene shipped saying
// `/comply` was "designed and not yet built" while /comply shipped the same night
// with 44 adversarial evals behind it.
//
// A stale absence claim is not untidiness. It is a correctness bug with a blast
// radius: the next reader trusts it, refuses to dispatch to a skill that exists, and
// reasons about a repo that is no longer there. A user discovers the gap that was
// never a gap.
//
// This test fails when a SKILL.md says a skill is absent and that skill is present.
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT FLAG
//
// Most "X does not exist" sentences in this pack are load-bearing honesty about the
// *API*, the *runtime*, or a *gate key* — not about a skill:
//
//   "There is no `richapi retro` verb."                        (a CLI verb)
//   "It will not report ad spend. No endpoint in this pack returns it."   (the API)
//   "the ceiling that bounds the multiplier does not exist"     (a gates.yaml key)
//   "An arm with runs from both sources is not built."          (a feature)
//   "A stage naming a skill that does not exist ... fails here." (a validation rule)
//
// Every one of those must keep passing. A test that shouts at them gets skimmed, and
// a skimmed test is worse than no test — so the predicate is narrow on purpose:
//
//   1. The claim must name a skill that ACTUALLY EXISTS in skills/, matched as a
//      `/skill-name` reference. Names come from the filesystem, never a literal
//      array, so a skill added tomorrow is covered tomorrow.
//   2. The absence phrase must be about EXISTENCE ("not built", "does not exist
//      yet", "not in this tree"), never about capability ("it will not write an
//      export") — the pack's stated ceiling is supposed to say what it will not do.
//   3. The skill reference and the absence phrase must be ADJACENT, so the skill is
//      plausibly the subject of the claim rather than something mentioned nearby.
//   4. An intervening noun that renames the subject — endpoint, verb, gate key,
//      field, stage — disarms the match.
//
// The predicate is exercised against its own fixtures below, so a future widening
// that starts flagging honest API prose fails here rather than in review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..', '..');
const SKILLS    = join(ROOT, 'skills');

/** The inventory, from the filesystem. Never a hard-coded array (that is the bug). */
function skillNames () {
  return readdirSync(SKILLS)
    .filter(f => statSync(join(SKILLS, f)).isDirectory())
    .sort();
}

// --- the predicate -------------------------------------------------------------

// Phrases asserting a thing does not EXIST. Capability disclaimers ("will not send",
// "does not write") are absent on purpose: a skill stating its ceiling is the point.
const ABSENCE = [
  /\bnot\s+(?:yet\s+)?built\b/i,
  /\bnever\s+built\b/i,
  /\bunbuilt\b/i,
  /\bnot\s+(?:yet\s+)?implemented\b/i,
  /\bnot\s+(?:yet\s+)?shipped\b/i,
  /\bdo(?:es)?\s+not\s+(?:yet\s+)?exist\b/i,
  /\bdo(?:es)?n['’]t\s+(?:yet\s+)?exist\b/i,
  /\bnot\s+(?:yet\s+)?in\s+this\s+tree\b/i,
  /\bdesigned[, ]+(?:and\s+)?not\b/i,
  /\bwhen\s+(?:it|they)\s+(?:is\s+|are\s+)?(?:built|rebuilt|lands?|ships?)\b/i,
  /\bhas\s+no\s+.{0,24}\bskill\b/i,
  /\bis\s+no\s+.{0,24}\bskill\b/i,
];

// A noun between the skill reference and the phrase that makes something ELSE the
// subject. "`/comply` refuses when the gate key does not exist" is about the key.
const SUBJECT_RESET = new RegExp(
  '\\b(?:endpoint|endpoints|verb|verbs|command|commands|cli|key|keys|gate|gates|'
  + 'field|fields|column|columns|flag|flags|parameter|header|response|schema|'
  + 'ceiling|multiplier|limit|threshold|budget|balance|store|path|provider|'
  + 'stage|stages|arm|arms|tier|tiers|mode|fixture|fixtures|capture|canary|'
  + 'client|package|feature|artifact)\\b', 'i');

// How far the phrase may sit from the skill it is claimed about. Wide enough for a
// parenthetical ("`/org-map` (committee hierarchy with confidence per edge) is
// designed and not yet in this tree"), narrow enough that an unrelated clause later
// in the same bullet does not reach back.
const ADJACENCY = 140;

/** Frontmatter and fenced code stripped: schemas and examples are not prose. */
function proseOf (src) {
  let s = String(src).replace(/\r\n/g, '\n');
  if (s.startsWith('---\n')) {
    const end = s.indexOf('\n---\n', 4);
    if (end >= 0) s = s.slice(end + 5);
  }
  return s.replace(/^```[\s\S]*?^```/gm, '\n');
}

/**
 * Prose split into the units a claim lives in: one paragraph, or one list item.
 * Hard-wrapped lines are rejoined first, so a claim wrapped across two lines reads
 * as one sentence rather than two fragments.
 */
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
 * A `/skill-name` reference. `../comply/SKILL.md` counts (it is a reference to the
 * skill); `tests/skills/comply/harness.mjs` does not — a word character before the
 * slash means the token is a path segment, not a skill mention.
 */
function skillRefRe (names) {
  const alt = [...names].sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\w-])/(${alt})(?![\\w-])`, 'g');
}

/**
 * Every stale absence claim in one SKILL.md body.
 * @returns {{skill:string, phrase:string, text:string}[]}
 */
export function staleSelfClaims (src, names) {
  const present = new Set(names);
  const refRe   = skillRefRe(names);
  const out     = [];

  for (const unit of claimUnits(proseOf(src))) {
    refRe.lastIndex = 0;
    const refs = [...unit.matchAll(refRe)]
      .map(m => ({ name: m[1], start: m.index, end: m.index + m[0].length }));
    if (refs.length === 0) continue;              // an API/runtime claim, not a skill claim

    for (const re of ABSENCE) {
      for (const hit of unit.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
        const at = hit.index;

        const end = at + hit[0].length;

        // The reference can sit inside the phrase ("there is no `/comply` skill"),
        // before it ("`/comply` — designed, not built"), or after it.
        const inside = refs.find(r => r.start < end && r.end > at);
        const before = refs.filter(r => r.end <= at).pop();
        const after  = refs.find(r => r.start >= end);

        for (const [ref, gap] of [
          inside && [inside, ''],
          before && [before, unit.slice(before.end, at)],
          after  && [after,  unit.slice(end, after.start)],
        ].filter(Boolean)) {
          if (!present.has(ref.name)) continue;   // still-true claim about a real gap
          if (gap.length > ADJACENCY) continue;   // too far to be the subject
          if (SUBJECT_RESET.test(gap)) continue;  // something else is the subject
          out.push({ skill: ref.name, phrase: hit[0].trim(), text: unit });
          break;
        }
      }
    }
  }
  return out;
}

// --- the contract ---------------------------------------------------------------

test('no SKILL.md claims a skill is absent when that skill is present', () => {
  const names = skillNames();
  assert.ok(names.length > 0, 'skills/ is empty — nothing to check, which is itself wrong');

  const findings = [];
  for (const dir of names) {
    const src = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');
    for (const f of staleSelfClaims(src, names)) {
      findings.push(`skills/${dir}/SKILL.md says /${f.skill} is absent ("${f.phrase}"), `
        + `but skills/${f.skill}/ exists.\n      ${f.text}`);
    }
  }

  assert.deepEqual(findings, [],
    'stale self-claims — the named skill shipped, so make the claim true and link it '
    + `(](../<skill>/SKILL.md)):\n\n  - ${findings.join('\n\n  - ')}\n`);
});

// --- the predicate, exercised against its own edges -------------------------------
//
// Without these, the check above passes just as well if the predicate matches
// nothing at all, and nobody would notice until the next workstream shipped a lie.

test('the predicate catches the claims that were actually shipped stale', () => {
  const names = skillNames();
  const shipped = [
    '- Suppression sources, erasure and lawful basis: `/comply` — designed, not built.',
    'Lawful basis and consent records belong to `/comply`, which is\ndesigned and not yet built.',
    '- `/org-map` (committee hierarchy with confidence per edge) is designed and not yet in\n  this tree.',
    'There is no `/comply` skill yet, so lawful-basis notation is not covered.',
    '- Turn drafts into a cadence: `/sequence-builder` — designed, not yet built.',
    '`/competitive-intel` and `/play-design` are designed and not yet in this tree.',
    '`/crm-export` … Not linked because it is not built yet.',
    'Every other earlier skill keeps its name when it is rebuilt: `/signal-watch`.',
  ];
  for (const s of shipped) {
    assert.ok(staleSelfClaims(s, names).length > 0, `predicate missed a stale claim: ${s}`);
  }
});

test('the predicate leaves load-bearing honesty alone', () => {
  const names = skillNames();
  const honest = [
    // About the API / the runtime, not about a skill.
    'There is **no `richapi retro` verb**. Do not tell the user to run a command that\ndoes not exist.',
    'It will not report ad spend. No endpoint in this pack returns it.',
    'It advises and prepares; it never writes to a CRM, because no endpoint in this pack\ncan.',
    'There is no sending endpoint, and there never will be.',
    'There is no CRM write endpoint in this pack.',
    // About a gate key or a feature, with a skill named nearby.
    '- `/comply` refuses when the gate key it reads does not exist — a missing key is STOP.',
    'It will not sweep several competitors in one run while the ceiling that bounds the\nmultiplier does not exist.',
    'An arm with runs from both sources is not built. Pick one grouping per retro.',
    // Genuinely still absent, and not a skill.
    'Live-capture fixtures are not yet built; the weekly canary shares that blocker.',
    'The pack-side client does not exist yet.',
    // Capability ceilings, which every skill is required to state.
    '**It will not write a sender export.** That is `/launch`\'s alone.',
    '- **It does not send anything.** Sending execution is outside the pack permanently.',
    '`/launch` is the only skill in the pack that writes a sender export.',
    // Code and schema blocks are not prose.
    'See the schema:\n\n```yaml\n# /comply is not built\nrefusal: not_built\n```\n',
    // A claim about a skill that really is not in skills/.
    '`/crystal-ball` is designed and not yet built.',
  ];
  for (const s of honest) {
    assert.deepEqual(staleSelfClaims(s, names), [],
      `predicate flagged honest prose:\n${s}`);
  }
});

test('the inventory comes from the filesystem, not from a literal in this file', () => {
  const self = readFileSync(join(__dirname, 'no-stale-self-claims.test.mjs'), 'utf8');
  const body = self.slice(self.indexOf('function skillNames'));
  // The router is the one name that would be most tempting to special-case.
  assert.ok(!/\breaddirSync\s*\(\s*['"]/.test(body), 'skills/ must be read by path, not by literal');
  assert.ok(skillNames().includes('richapi-gtm'), 'the router should be discovered, not assumed');
  assert.ok(skillNames().length >= 2, 'a one-skill inventory cannot detect a cross-skill claim');
});
