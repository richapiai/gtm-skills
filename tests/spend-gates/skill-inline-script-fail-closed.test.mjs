// tests/spend-gates/skill-inline-script-fail-closed.test.mjs
//
// Law 3 ("every paid call is named and costed before it runs; no opt-out paid
// calls, ever") and law 5 ("fail closed"), enforced on the one thing in this pack
// that silently violates both: a documented bash fence that runs an inline script
// through an unbound shell variable.
//
// `node --input-type=module -e ""` exits 0 and prints nothing. So this:
//
//     VERDICT=$(... node --input-type=module -e "$GTM_SCHEDULE") || exit 0
//     eval "$(printf '%s\n' "$VERDICT" | grep '^RICHAPI_SCHEDULE_BUDGET=')"
//     richapi call enrich_company ... --budget "$RICHAPI_SCHEDULE_BUDGET" --yes
//
// does NOT stop when $GTM_SCHEDULE is unset. The check no-ops with status 0, the
// `|| exit 0` never fires, the eval binds nothing, and the next line makes a paid,
// unattended `--yes` call whose envelope check never ran. An unset variable deletes
// the gate silently.
//
// The fix is bash's required-parameter form, `${VAR:?message}`, which aborts with a
// message on stderr and a non-zero status when VAR is unset OR empty — including
// inside `$( )`, where it makes the substitution fail so `|| exit 0` fires.
//
// This file derives the variable set by scanning the tree. It is deliberately NOT a
// list of the nine variables that exist today: a tenth added later is caught the
// moment it lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS = join(ROOT, 'skills');

// --- known-unfixed --------------------------------------------------------
// Real violations of the same rule in files outside the change being tested.
// Keyed `<skill>/SKILL.md::$VAR`. This is a debt register, not an exemption: the
// staleness test below fails the moment an entry is fixed, so an entry cannot
// outlive the bug it names.
// Empty, and the staleness test below keeps it that way: an entry here cannot
// outlive the bug it names. `comply/SKILL.md::$GTM_COMPLY` was the one entry —
// carried because skills/comply sat outside that change's scope — and it was
// fixed on 2026-08-30, so it is gone. The register stays as a mechanism: a change
// that finds this bug outside its scope registers it here rather than either
// weakening the scan or editing a file it does not own.
const KNOWN_UNFIXED = new Set([]);

// --- scanning -------------------------------------------------------------

function skillFiles () {
  const out = [];
  for (const name of readdirSync(SKILLS).sort()) {
    const f = join(SKILLS, name, 'SKILL.md');
    try { if (statSync(f).isFile()) out.push(f); } catch { /* no SKILL.md */ }
  }
  return out;
}

// Every `node --input-type=module -e <arg>` in the text, with <arg> unquoted and
// the 1-based line it starts on.
function invocations (text) {
  const out = [];
  const re = /node\s+--input-type=module\s+-e\s+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    const q = rest[0];
    let arg;
    if (q === '"' || q === "'") {
      const end = rest.indexOf(q, 1);
      arg = end === -1 ? rest.split('\n')[0] : rest.slice(1, end);
    } else {
      arg = rest.split(/[\s\n]/)[0];
    }
    out.push({
      quote: q === '"' || q === "'" ? q : null,
      arg,
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

// Shell parameter expansions inside an -e payload, classified.
// `${NAME:?msg}` with a non-empty msg is the only accepted form.
function expansions (arg) {
  const found = [];
  let residue = arg;

  const braced = /\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g;
  let m;
  while ((m = braced.exec(arg)) !== null) {
    const [whole, name, suffix] = m;
    if (!suffix.startsWith(':?')) {
      found.push({ name, ok: false, why: `\${${name}${suffix}} is not the required form`, whole });
    } else if (suffix.slice(2).trim() === '') {
      found.push({ name, ok: false, why: `\${${name}:?} has an empty message`, whole });
    } else {
      found.push({ name, ok: true, whole });
    }
    residue = residue.replace(whole, ' '.repeat(whole.length));
  }

  const bare = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = bare.exec(residue)) !== null) {
    found.push({ name: m[1], ok: false, why: `bare $${m[1]} no-ops when unset`, whole: m[0] });
  }
  return found;
}

function scan () {
  const sites = [];
  for (const file of skillFiles()) {
    const rel = relative(SKILLS, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const inv of invocations(text)) {
      for (const e of expansions(inv.arg)) {
        sites.push({ rel, key: `${rel}::$${e.name}`, line: inv.line, quote: inv.quote, ...e });
      }
    }
  }
  return sites;
}

// --- the contract ---------------------------------------------------------

test('the scan actually finds the inline-script invocations (guards the regex)', () => {
  const sites = scan();
  assert.ok(sites.length >= 10,
    `expected the tree to contain many "node --input-type=module -e" sites, found ${sites.length}. ` +
    'If the pack really stopped documenting them, delete this file; otherwise the scanner is broken.');
  const files = new Set(sites.map(s => s.rel));
  assert.ok(files.size >= 5, `expected several skills to carry them, found ${[...files].join(', ')}`);
});

test('every inline-script variable uses the fail-closed ${VAR:?msg} form', () => {
  const bad = scan().filter(s => !s.ok && !KNOWN_UNFIXED.has(s.key));
  assert.deepEqual(bad.map(s => `skills/${s.rel}:${s.line}  ${s.whole}  — ${s.why}`), [],
    '\nAn unset or empty variable makes `node --input-type=module -e ""` exit 0 with no output, ' +
    'so a copy-pasted fence silently skips the check it documents. Use ' +
    '`node --input-type=module -e "${GTM_X:?set this to the gtm-x script below}"` instead.\n');
});

test('the -e payload is double-quoted, so the expansion is reached at all', () => {
  // `-e '${VAR:?...}'` would pass the literal text to node and never fail closed.
  const bad = [];
  for (const file of skillFiles()) {
    const rel = relative(SKILLS, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const inv of invocations(text)) {
      if (inv.arg.includes('$') && inv.quote !== '"') {
        bad.push(`skills/${rel}:${inv.line}  -e ${inv.quote ?? ''}${inv.arg}${inv.quote ?? ''}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'a single-quoted or unquoted -e payload never expands the variable');
});

test('the known-unfixed register has no stale entries', () => {
  const stillBad = new Set(scan().filter(s => !s.ok).map(s => s.key));
  const stale = [...KNOWN_UNFIXED].filter(k => !stillBad.has(k));
  assert.deepEqual(stale, [],
    'these are fixed now — delete them from KNOWN_UNFIXED so the register cannot rot');
});

// --- the behaviour the rule is standing on --------------------------------
// Asserting the string form is only worth something if the form does what the
// comment says. These run bash.

const bash = (script) => {
  try {
    const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

test('bare $VAR unset: node -e exits 0 and prints nothing (the bug being fixed)', () => {
  const r = bash('unset GTM_X; node --input-type=module -e "$GTM_X"');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('${VAR:?msg} unset or empty: non-zero exit, message on stderr', () => {
  for (const setup of ['unset GTM_X;', 'GTM_X="";']) {
    const r = bash(`${setup} node --input-type=module -e "\${GTM_X:?bind me}"`);
    assert.notEqual(r.code, 0, `${setup} should have aborted`);
    assert.match(r.stderr, /GTM_X: bind me/, `${setup} should name the variable on stderr`);
  }
});

test('${VAR:?msg} unset inside $( ): the `|| exit 0` guard fires', () => {
  // The scheduled-workflow unattended sequence, reduced to its control flow.
  const seq = (payload) => `
    unset GTM_SCHEDULE
    VERDICT=$(MODE=check node --input-type=module -e "${payload}") || { echo GUARD_FIRED; exit 0; }
    eval "$(printf '%s\\n' "$VERDICT" | grep '^RICHAPI_SCHEDULE_BUDGET=')"
    echo "PAID_CALL_REACHED budget=[$RICHAPI_SCHEDULE_BUDGET]"
  `;
  const before = bash(seq('$GTM_SCHEDULE'));
  assert.match(before.stdout, /PAID_CALL_REACHED/,
    'the bare form is supposed to fall through — that is the bug this test documents');

  const after = bash(seq('${GTM_SCHEDULE:?bind me}'));
  assert.match(after.stdout, /GUARD_FIRED/, 'the required form must make the substitution fail');
  assert.doesNotMatch(after.stdout, /PAID_CALL_REACHED/,
    'an unattended --yes call must never be reachable with the envelope check skipped');
});

test('${VAR:?msg} bound: the script still runs normally', () => {
  const r = bash(`GTM_X='console.log("ok")'; node --input-type=module -e "\${GTM_X:?bind me}"`);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'ok');
});

// --- the prose half of the fix -------------------------------------------
// The guard tells a reader what went wrong at run time. The doc has to tell them
// before they run it. Every skill that documents one of these fences must name the
// variable in prose as something the reader binds.

test('every skill with an inline-script fence names its variable in prose', () => {
  const missing = [];
  for (const file of skillFiles()) {
    const rel = relative(SKILLS, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const vars = new Set();
    for (const inv of invocations(text)) for (const e of expansions(inv.arg)) vars.add(e.name);
    for (const name of vars) {
      // a backticked `$NAME` outside the fences, i.e. in the prose
      if (!new RegExp('`\\$' + name + '`').test(text)) missing.push(`skills/${rel}: $${name}`);
    }
  }
  assert.deepEqual(missing, [],
    'the fence is a placeholder; say so in prose at or before first use');
});
