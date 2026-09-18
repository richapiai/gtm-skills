// tests/permissions/allowed-tools.test.mjs
//
// No skill declares a tool it does not use.
//
// scripts/validate-skills.mjs requires `allowed-tools` to be PRESENT and non-empty.
// It never looks at the value. That is how all 33 skills came to ship the identical
// line `Bash, Read, Write` — including the ones that author no file at all — and an
// unexamined declaration is the widest grant in the pack: several skills feed
// attacker-authored free text (a public form body, a reply body, a call transcript, a
// scraped page, a CSV cell) to an agent holding Bash.
//
// This file is the value check the validator does not do. It is deliberately a PINNED
// TABLE rather than a heuristic. A heuristic over prose ("does this skill look like it
// writes a file?") is exactly the thing that drifts; an audit of record does not, and
// changing a declaration means changing the row here and saying why.
//
// Three mechanical invariants sit on top of the table, and they are what actually
// catch drift:
//
//   1. VOCABULARY  — nothing outside {Bash, Read, Write} may appear. A skill quietly
//      acquiring WebFetch or Edit turns this red rather than shipping.
//   2. BASH        — `Bash` is declared if and only if the body ships a runnable
//      ```bash fence. Mechanical, checkable in both directions.
//   3. NO-WRITE    — a skill narrowed to `Bash, Read` must still name no artifact of
//      its own: no `$GTM_<NAME>` script to materialise, and no `gtm/` path other than
//      the suppression store, which it is forbidden to write directly anyway. Add an
//      output artifact to one of these five and this test fails until `Write` comes
//      back with it.
//
// The `why` on each narrowed row is the evidence the narrowing rests on. The three
// skills still being edited at audit time (comply, campaign-review, launch) are
// pinned at their current value, not at an audited one — see NOT_AUDITED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SKILLS = join(REPO_ROOT, 'skills');

const KNOWN_TOOLS = new Set(['Read', 'Write']);

/**
 * A scoped shell grant: `Bash(<command>:*)`.
 *
 * NARROWED 2026-09-02 (ROADMAP item 4, pulled forward for the public launch). Every
 * skill used to declare a bare `Bash`, which is a grant over every command on the
 * machine — and five of them feed attacker-authored free text (a public form body, a
 * reply body, a call transcript, a scraped page, a CSV cell) to an agent holding it.
 *
 * The command surface is small enough to enumerate, and each skill's grant is DERIVED
 * from the commands its own runnable fences actually invoke.
 *
 * This is partial mitigation and SECURITY.md says so: `Bash(node:*)` is still arbitrary
 * execution, so the six skills that need `node` keep a hole this cannot close. What it
 * buys is that the other 27 cannot reach `curl`, `ssh`, a package manager or a shell.
 */
const SCOPED_BASH = /^Bash\([a-z][a-z0-9-]*:\*\)$/;

/** Commands any skill is permitted to hold a scoped grant over. */
const GRANTABLE = new Set([
  'richapi', 'richapi-skills-preflight',   // the pack's own surface
  'node',                                  // arbitrary execution — see above
  // Narrow, named coreutils. Each is used by one or two skills and none can reach
  // the network, install software, or spawn a shell.
  'head', 'cat', 'tr', 'grep', 'printf', 'rm', 'touch',
]);

/**
 * The audit of record: skill -> declared tools, and for anything narrower than the
 * pack default, the evidence the narrowing rests on.
 */
const EXPECTED = {
  'account-research':           { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'ads-audience':               { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'build-prospect-list':        { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'call-intel':                 { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'campaign-review':            { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'competitive-intel':          { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'comply':                     { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'cost-optimizer':             { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'crm-export':                 { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'crm-sync-expert':            { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Bash(node:*), Bash(head:*), Bash(tr:*), Bash(cat:*), Read, Write' },
  'enrich-waterfall':           {
    tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read',
    why: 'Names no artifact. Every file it produces is written by the runtime behind '
       + '`richapi enrich --out`; the skill itself only dry-runs, approves and reports.',
  },
  'evidence-score':             { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'gtm-kickoff':                { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'gtm-onboard':                { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'gtm-retro':                  { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'icp-review':                 { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'inbound':                    { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'launch':                     { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'learn':                      { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'list-hygiene':               { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read' },
  'local-business-prospecting': { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'measure':                    { tools: 'Bash(richapi-skills-preflight:*), Bash(node:*), Read, Write' },
  'org-map':                    { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'outreach-expert':            {
    tools: 'Bash(richapi-skills-preflight:*), Read',
    why: 'Owns zero endpoints and names no output path. Its deliverable is decisions '
       + 'read out in the session; it states it does not write the sender export or '
       + 'the CRM import file.',
  },
  'personalize':                { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'play-design':                { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'pre-meeting-briefing':       { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'reply-triage':               {
    tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read',
    why: 'Opt-outs go through `_lib/suppression.mjs` (the skill explicitly forbids '
       + 'writing gtm/suppression.jsonl directly); the batch path writes through '
       + '`richapi call ai_enrich --out`. Drafts and buckets are reported, not filed.',
  },
  'research-agent':             { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'richapi-gtm':                {
    tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read',
    why: 'The router. It reads the pack, runs the preflight and hands off. It names no '
       + 'artifact and states it never assembles one.',
  },
  'scheduled-workflow':         { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Bash(node:*), Bash(rm:*), Bash(touch:*), Bash(printf:*), Bash(grep:*), Read, Write' },
  'sequence-builder':           { tools: 'Bash(richapi-skills-preflight:*), Read, Write' },
  'signal-watch':               { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
  'tam-map':                    { tools: 'Bash(richapi:*), Bash(richapi-skills-preflight:*), Read, Write' },
};

// RESOLVED 2026-09-02. `comply`, `campaign-review` and `launch` were still being
// edited and were pinned at the pack default rather than at an audited minimum. The
// scoped-grant pass removed the question: every row's Bash grants are now DERIVED from
// the commands that skill's own runnable fences invoke, so there is no default left to
// inherit. The Write half of each row is still the audited value.
const NOT_AUDITED = new Set();

function skillDirs () {
  return readdirSync(SKILLS)
    .filter(f => statSync(join(SKILLS, f)).isDirectory())
    .sort();
}

function source (skill) {
  return readFileSync(join(SKILLS, skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
}

function frontmatterLine (src, key) {
  const end = src.indexOf('\n---\n', 4);
  const block = end < 0 ? '' : src.slice(4, end);
  for (const line of block.split('\n')) {
    const m = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (m) return m[1].trim();
  }
  return null;
}

function body (src) {
  const end = src.indexOf('\n---\n', 4);
  return end < 0 ? src : src.slice(end + 5);
}

function declared (skill) {
  const raw = frontmatterLine(source(skill), 'allowed-tools');
  assert.ok(raw, `${skill}: no allowed-tools line in frontmatter`);
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

test('the audit table covers exactly the skills on disk', () => {
  assert.deepEqual(skillDirs(), Object.keys(EXPECTED).sort(),
    'a skill was added or removed without auditing what it actually needs — '
    + 'add its row to EXPECTED with the evidence, do not copy the pack default');
});

test('every declared tool is one this pack knows about', () => {
  for (const skill of skillDirs()) {
    for (const tool of declared(skill)) {
      if (KNOWN_TOOLS.has(tool)) continue;
      assert.match(tool, SCOPED_BASH,
        `${skill}: declares "${tool}". A bare \`Bash\` is a grant over every command on `
        + 'the machine and is what this narrowing removed; use Bash(<command>:*).');
      const cmd = tool.slice('Bash('.length, -':*)'.length);
      assert.ok(GRANTABLE.has(cmd),
        `${skill}: grants Bash(${cmd}:*), which is outside the pack's command surface. `
        + 'Widening it needs a reason in this file, not a quiet frontmatter edit.');
    }
  }
});

test('no skill holds an unscoped Bash grant', () => {
  // The regression guard for the whole narrowing. One bare `Bash` anywhere puts that
  // skill back to a shell over the entire machine, and it would look like a one-word
  // frontmatter edit in review.
  for (const skill of skillDirs()) {
    assert.ok(!declared(skill).includes('Bash'),
      `${skill}: declares a bare, unscoped \`Bash\``);
  }
});

test('no skill declares a tool it does not use', () => {
  for (const skill of skillDirs()) {
    const got = declared(skill).join(', ');
    const row = EXPECTED[skill];
    assert.equal(got, row.tools,
      `${skill}: allowed-tools is "${got}", the audit says "${row.tools}".`
      + (row.why ? `\n  Narrowed because: ${row.why}` : '')
      + '\n  If the skill genuinely changed, change the row and say why. Do not widen '
      + 'the grant to make a test pass.');
  }
});

test('a shell grant is declared if and only if the skill ships a runnable shell fence', () => {
  for (const skill of skillDirs()) {
    const hasFence = /^```bash\s*$/m.test(body(source(skill)));
    const hasBash = declared(skill).some(t => SCOPED_BASH.test(t));
    assert.equal(hasBash, hasFence,
      hasFence
        ? `${skill}: ships a \`\`\`bash fence but does not declare Bash`
        : `${skill}: declares Bash but shows no shell command`);
  }
});

/**
 * Every command a skill's runnable fences actually invoke.
 *
 * PIPELINE-AWARE, and that is the entire point. The 2026-09-02 narrowing derived each
 * skill's grants by reading only the FIRST TOKEN of each line, so
 * `head -1 x | tr ',' '\\n' | cat -n` was recorded as `head` and the grant shipped
 * without `tr` or `cat`. Two skills went out declaring less than they run. Splitting on
 * the shell's own command separators is what makes this a check rather than a guess.
 */
function commandsUsed (skill) {
  const cmds = new Set();
  const fences = body(source(skill)).match(/^```bash\n[\s\S]*?^```/gm) ?? [];
  for (const fence of fences) {
    for (const raw of fence.split('\n').slice(1, -1)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      // Split on pipes, semicolons, && / ||, and command substitution openers.
      for (const seg of line.split(/\||;|&&|\|\||\$\(|`/)) {
        const m = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([a-z][a-z0-9_-]*)\b/.exec(seg);
        if (m) cmds.add(m[1]);
      }
    }
  }
  return cmds;
}

// Shell builtins and control words cannot be granted or denied by name, so they are
// not part of the coverage contract. `eval` is here because it IS a builtin — which is
// also why scoping cannot contain a skill that uses it.
const NOT_GRANTABLE_BY_NAME = new Set([
  'eval', 'exit', 'export', 'set', 'unset', 'cd', 'echo', 'read', 'source',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
  'return', 'local', 'shift', 'test', 'true', 'false',
]);

test('every command a skill runs is covered by a grant it declares', () => {
  // THE GUARD THE NARROWING SHIPPED WITHOUT. Without it, a skill can declare fewer
  // commands than it invokes and nothing notices until a user hits an unexpected
  // permission prompt in the middle of a paid run.
  const gaps = [];
  for (const skill of skillDirs()) {
    const granted = new Set(
      declared(skill)
        .filter((t) => SCOPED_BASH.test(t))
        .map((t) => t.slice('Bash('.length, -':*)'.length))
    );
    for (const cmd of commandsUsed(skill)) {
      if (NOT_GRANTABLE_BY_NAME.has(cmd)) continue;
      // Only judge commands the pack is willing to grant at all. Anything else is
      // caught by the vocabulary test above.
      if (!GRANTABLE.has(cmd)) continue;
      if (!granted.has(cmd)) {
        gaps.push(`${skill}: runs \`${cmd}\` but declares no Bash(${cmd}:*)`);
      }
    }
  }
  assert.deepEqual(gaps, [],
    'a skill invokes a command its grants do not cover. Add the grant, or stop running '
    + 'the command — do not leave the declaration smaller than the behaviour.');
});

test('no skill that ingests attacker-authored text can execute arbitrary code', () => {
  // THE INTERSECTION THAT MATTERS. `Bash(node:*)` is arbitrary execution, so scoping
  // buys nothing for a skill that holds it. These five read text an attacker can author
  // — a public form body, a reply body, a call transcript, a scraped page — so a
  // prompt-injected line in their input reaching `node -e` is the whole threat model.
  //
  // SECURITY.md states this intersection is empty. Pinned here so the claim is checked
  // rather than merely written: a skill cannot acquire both properties without failing.
  const HOSTILE_INPUT = ['reply-triage', 'inbound', 'call-intel', 'research-agent', 'signal-watch'];
  for (const skill of HOSTILE_INPUT) {
    assert.ok(skillDirs().includes(skill), `${skill} is named in the threat model but is not on disk`);
    assert.ok(!declared(skill).includes('Bash(node:*)'),
      `${skill} ingests attacker-authored text AND can execute arbitrary code. `
      + 'Either drop the node grant or remove the skill from the hostile-input list in '
      + 'SECURITY.md — and if you do the latter, say why in that document.');
  }
});

test('a skill narrowed to `Bash, Read` names no artifact of its own', () => {
  // The evidence the Write narrowing rests on, re-checked mechanically. Two markers:
  // a `$GTM_<NAME>` script the agent has to materialise before running, and a `gtm/`
  // artifact path. gtm/suppression.jsonl is exempt: the store is written through
  // _lib/suppression.mjs and every skill that touches it is told never to write it
  // directly.
  const ARTIFACT = /gtm\/[A-Za-z0-9_<>{}./-]*\.[a-z]{2,5}\b/g;

  // EXEMPT = files a narrowed skill READS but never authors. The guard's own failure
  // message already names this case ("if the runtime or _lib writes it, say so"); these
  // are it, listed rather than left to prose.
  //
  //   gtm/suppression.jsonl  written through _lib/suppression.mjs; every skill that
  //                          touches it is told never to write it directly.
  //   gtm/profile.yaml       the seller. Written by /gtm-onboard (which holds Write)
  //   gtm/preferences.jsonl  and by _lib/profile.mjs. Five skills READ them —
  //                          /personalize needs the offer and never_claim, /inbound and
  //                          /reply-triage need routing — and two of those five are
  //                          narrowed to no-Write. Reading is why they were narrowed in
  //                          the first place; naming a path you only read is not a
  //                          reason to hand back Write.
  const EXEMPT = new Set(['gtm/suppression.jsonl', 'gtm/profile.yaml', 'gtm/preferences.jsonl']);

  // ...but an exemption that let a narrowed skill claim to WRITE one would be worse
  // than no exemption, so the read-only half is checked rather than assumed.
  const WRITE_VERB = /\b(writes?|appends?|authors?|creates?|overwrites?|updates?)\b/i;

  for (const [skill, row] of Object.entries(EXPECTED)) {
    if (row.tools.includes('Write')) continue;
    const b = body(source(skill));

    // `\{?` so the braced required form `${GTM_X:?msg}` is caught too. The bare
    // `$GTM_X` spelling was the only one that existed when this guard was written;
    // the fail-closed hardening pass introduced the braced one, and a guard that
    // sees only the old spelling would wave through a narrowed skill using the new.
    assert.ok(!/\$\{?GTM_[A-Z_]+/.test(b),
      `${skill}: is narrowed to "${row.tools}" but now carries a $GTM_ script, which `
      + 'the agent has to write to a file before it can run. Restore Write.');

    for (const line of b.split('\n')) {
      for (const m of line.matchAll(ARTIFACT)) {
        if (!EXEMPT.has(m[0]) || m[0] === 'gtm/suppression.jsonl') continue;
        assert.ok(!WRITE_VERB.test(line),
          `${skill}: is narrowed to "${row.tools}" but this line reads as WRITING `
          + `${m[0]}, which only /gtm-onboard and _lib/profile.mjs may do:\n  ${line.trim()}`);
      }
    }

    const named = [...b.matchAll(ARTIFACT)]
      .map(m => m[0])
      .filter(p => !EXEMPT.has(p) && !p.endsWith('/SKILL.md'));
    assert.deepEqual([...new Set(named)], [],
      `${skill}: is narrowed to "${row.tools}" but now names a gtm/ artifact. If this `
      + 'skill authors that file, restore Write; if the runtime or _lib writes it, say '
      + 'so on the line.');
  }
});

test('the three skills left out of the audit are still flagged as unaudited', () => {
  for (const skill of NOT_AUDITED) {
    assert.ok(skill in EXPECTED, `${skill} vanished from the audit table`);
    assert.equal(EXPECTED[skill].tools, 'Bash, Read, Write',
      `${skill} was narrowed without being audited — it was still being edited at `
      + 'the time this table was written. Audit it, then drop it from NOT_AUDITED.');
  }
});
