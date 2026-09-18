// tests/contracts/executables-load.test.mjs
//
// Every executable this package ships must actually START on the lowest Node
// version `engines.node` claims.
//
// THE BUG THIS EXISTS TO PREVENT
//
//   package.json is `"type": "module"`. Under a type:module package, Node refuses
//   to load an EXTENSIONLESS file as ESM until 20.10:
//
//     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension "" for
//     .../bin/richapi. Loading extensionless files is not supported inside of
//     "type":"module" package.json contexts.
//
//   Every executable in this repo used to be extensionless, so on the whole of
//   Node 18 and Node 20.0–20.9 the CLI could not run a single line. Nothing caught
//   it: the CI matrix row "20" resolves to the newest 20.x, where it happens to
//   work, and no test had ever spawned the binaries under an older runtime.
//
//   The `bin` map KEY is the user-facing command name, so `bin/richapi.mjs` still
//   installs as `richapi`. Only the file on disk changed.
//
// WHAT IS ASSERTED, AND WHY IN TWO LAYERS
//
//   1. A STATIC rule: any shipped executable whose shebang names `node` must have a
//      module extension. This is the layer that actually protects the future — it
//      fails on THIS runtime, so a new extensionless node executable is caught by
//      the normal `npm test`, with no old Node binary required.
//
//   2. A DYNAMIC rule: spawn each one and confirm it reaches its own code rather
//      than dying in Node's module loader. On a modern runtime this passes even for
//      a broken file, which is exactly why layer 1 is not optional.
//
// The list is DERIVED from package.json's `bin` map plus the root `setup` pair, so
// an executable added later is covered without touching this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

// Extensions Node can load as ESM inside a "type":"module" package on every
// version in `engines.node`. `.js` is here because type:module makes it ESM;
// `.cjs` because it opts back out. Extensionless is the whole point of the file.
const LOADABLE = new Set(['.mjs', '.cjs', '.js']);

/** Everything the package ships as a runnable entry point. */
function executables () {
  const out = [];
  for (const [command, relPath] of Object.entries(PKG.bin ?? {})) {
    out.push({ label: `bin map "${command}" -> ${relPath}`, rel: relPath });
  }
  // `setup` is documented and invoked as `./setup`. Both halves of the pair ship and
  // both must work, whether or not the bin map also exposes one of them as a command
  // (it does: `richapi-setup` -> setup.mjs, so an npm install has a setup entry point).
  // The `already listed` guard is the same idiom used for bin/ below: without it a
  // path reachable two ways is symlinked twice into one temp dir and dies on EEXIST.
  for (const [label, rel] of [
    ['setup.mjs (the implementation)', 'setup.mjs'],
    ['./setup (the wrapper)', 'setup'],
  ]) {
    if (out.some((e) => e.rel === rel)) continue;
    out.push({ label, rel });
  }

  // Everything else executable under bin/. These are not installed as commands, so
  // npm never symlinks them, but they ship in the tarball and carry the same
  // main-module guard — and one of them (richapi-capture-fixtures.mjs) had a guard
  // that broke on a RELATIVE path, not just a symlink. Covering them here means the
  // day one is promoted into the bin map, it is already known to work.
  for (const name of readdirSync(join(REPO_ROOT, 'bin')).sort()) {
    const rel = `bin/${name}`;
    if (out.some((e) => e.rel === rel)) continue;
    out.push({ label: `${rel} (ships, not a bin-map command)`, rel });
  }
  return out;
}

const ALL = executables();

/** First line of the file, without the trailing newline. */
function shebang (abs) {
  const head = readFileSync(abs, 'utf8').slice(0, 200);
  const line = head.split('\n', 1)[0];
  return line.startsWith('#!') ? line : '';
}

const isNodeShebang = (sb) => /\bnode\b/.test(sb);

test('the derived executable list is not accidentally empty', () => {
  assert.ok(ALL.length >= 5,
    `only ${ALL.length} executables derived — package.json's bin map is probably not being read`);
  assert.ok(PKG.type === 'module',
    'this contract assumes "type":"module"; if that changed, the extension rule below changed too');
});

for (const { label, rel } of ALL) {
  const abs = join(REPO_ROOT, rel);

  test(`${label} — exists, is a real file, and is executable`, () => {
    assert.ok(existsSync(abs), `${rel} is referenced but does not exist`);
    const st = statSync(abs);
    // Not a symlink: `npm pack` silently DROPS symlinks from the tarball, so a
    // symlinked entry point installs as nothing at all.
    assert.ok(st.isFile(), `${rel} must be a real file (npm pack drops symlinks)`);
    assert.ok((st.mode & 0o111) !== 0, `${rel} is not executable (chmod +x)`);
  });

  test(`${label} — if node loads it, it has a loadable extension (ERR_UNKNOWN_FILE_EXTENSION guard)`, () => {
    const sb = shebang(abs);
    assert.ok(sb.startsWith('#!'), `${rel} has no shebang, so nothing knows how to run it`);
    if (!isNodeShebang(sb)) return; // a shell script: Node never loads it, extension is irrelevant
    assert.ok(LOADABLE.has(extname(rel)),
      `${rel} runs under node and this package is "type":"module", so an extensionless ` +
      `(or otherwise unloadable) filename dies with ERR_UNKNOWN_FILE_EXTENSION on every ` +
      `Node below 20.10 — rename it to .mjs and point package.json at the new path`);
  });

  test(`${label} — starts and reaches its own code`, () => {
    const sb = shebang(abs);
    // Spawn the way the runtime actually would: node files through process.execPath
    // (this is the invocation that used to explode), shell files directly.
    const res = isNodeShebang(sb)
      ? spawnSync(process.execPath, [abs, '--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 })
      : spawnSync(abs, ['--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

    assert.equal(res.error, undefined, `${rel} could not be spawned: ${res.error?.message}`);
    assert.equal(res.signal, null, `${rel} was killed by ${res.signal} instead of exiting`);

    const stderr = res.stderr ?? '';
    assert.ok(!stderr.includes('ERR_UNKNOWN_FILE_EXTENSION'),
      `${rel} died in Node's module loader — the extensionless-ESM bug is back:\n${stderr}`);

    // Any of these means the process never got as far as its own first statement.
    for (const marker of ['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT', 'Cannot find module', 'SyntaxError']) {
      assert.ok(!stderr.includes(marker), `${rel} failed to load (${marker}):\n${stderr}`);
    }

    // A Node process that dies in the loader prints a stack of `node:internal/`
    // frames and nothing of its own. That, not the exit code, is the signal here:
    // some of these binaries answer `--help` with a usage message and a non-zero
    // status by design (richapi-skills-config exits 2 on an unknown verb), which is
    // its own code running correctly.
    assert.ok(!/\bnode:internal\//.test(stderr),
      `${rel} crashed inside Node itself rather than running:\n${stderr}`);
    assert.equal(typeof res.status, 'number', `${rel} never exited cleanly`);
    assert.ok(`${res.stdout}${stderr}`.trim().length > 0,
      `${rel} --help produced no output at all, so nothing proves it reached its own code`);
  });
}

// npm puts every `bin` entry on PATH as a SYMLINK into node_modules. Node resolves
// the entry point's symlinks, so a main-module guard written as
// `import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href` compares the
// REAL file against the SYMLINK and is false for every installed user — the command
// then does nothing and exits 0. That is how `richapi` shipped: a silent no-op that
// looks like success. Spawn each executable through a symlink, the way an install
// does, and require it to behave the same as it does directly.
/**
 * Preflight keys whose value legitimately differs between two invocations
 * milliseconds apart, so comparing them tells you nothing about symlinks.
 *
 * This test used to compare raw stdout and failed roughly one full-suite run in
 * three, never in isolation. The cause was not a symlink bug: `richapi-skills-preflight`
 * emits a TTL-cached BALANCE, a live NET probe and a CATALOG_AGE that ticks, and
 * `node --test` runs files in parallel, so a sibling test can move that state
 * between the direct spawn and the symlinked one.
 *
 * A test that lies one run in three gets ignored inside a week, and this is the
 * test guarding the class that produced three real bugs in one night. So the
 * volatile values are blanked and everything else is still compared byte for byte.
 *
 * The bug it exists to catch is untouched by this: through a symlink the broken
 * preflight reported `CATALOG_OK: no`, `CATALOG_TOOLS: 0`, `FILTERS_OK: no` and
 * `SKILLS_VERSION: unknown`. Not one of those keys is on this list, and the
 * "produced NO output" check above compares nothing at all.
 */
const VOLATILE_KEYS = ['CATALOG_AGE', 'NET', 'BALANCE', 'UPGRADE'];

/** Blank the value of every volatile key, keeping the key itself asserted. */
function stable (out) {
  return String(out ?? '')
    .split('\n')
    .map((line) => {
      const m = /^([A-Z_]+):/.exec(line);
      return m && VOLATILE_KEYS.includes(m[1]) ? `${m[1]}: <volatile>` : line;
    })
    .join('\n');
}

test('every executable still works when invoked through a symlink, the way npm installs it', (t) => {
  const linkDir = mkdtempSync(join(tmpdir(), 'bin-symlink-'));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));

  // Every executable is checked before anything is reported. Failing on the first
  // one would have hidden the other two the day all three were broken at once.
  const broken = [];
  const check = (cond, msg) => { if (!cond) broken.push(msg); };

  for (const { label, rel } of ALL) {
    const abs = join(REPO_ROOT, rel);
    const sb = shebang(abs);
    const link = join(linkDir, `link-${rel.replace(/[\\/]/g, '-')}`);
    symlinkSync(abs, link);

    const run = (target) => (isNodeShebang(sb)
      ? spawnSync(process.execPath, [target, '--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 })
      : spawnSync(target, ['--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 }));

    const direct = run(abs);
    const viaLink = run(link);

    check(`${viaLink.stdout}${viaLink.stderr}`.trim().length > 0,
      `${label} produced NO output through a symlink (exit ${viaLink.status}). npm installs ` +
      'bins as symlinks, so this is what every installed user gets: a silent no-op, which ' +
      'reads as success. The main-module guard must compare realpaths.');
    check(stable(viaLink.stdout) === stable(direct.stdout),
      `${label} behaves differently through a symlink than directly. Either its main-module ` +
      'guard compares paths without following symlinks, or it derives its root from $0/argv[1] ' +
      `without resolving the link first.\n    direct:  ${JSON.stringify(stable(direct.stdout).slice(0, 120))}` +
      `\n    symlink: ${JSON.stringify(stable(viaLink.stdout).slice(0, 120))}`);
    check(viaLink.status === direct.status,
      `${label} exited ${viaLink.status} through a symlink but ${direct.status} directly`);
  }

  assert.deepEqual(broken, [],
    `${broken.length} executable(s) misbehave when reached through a symlink:\n  - ` +
    broken.join('\n  - '));
});

// The sibling failure mode: a guard that compares against a bare `process.argv[1]`
// is also false whenever the path given is RELATIVE, symlinks or not. That is how
// bin/richapi-capture-fixtures.mjs was written.
test('every node executable still works when invoked by a relative path', () => {
  for (const { label, rel } of ALL) {
    const abs = join(REPO_ROOT, rel);
    if (!isNodeShebang(shebang(abs))) continue;

    const viaRelative = spawnSync(process.execPath, [rel, '--help'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
    const viaAbsolute = spawnSync(process.execPath, [abs, '--help'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

    assert.ok(`${viaRelative.stdout}${viaRelative.stderr}`.trim().length > 0,
      `${label} produced NO output when invoked as a relative path (exit ${viaRelative.status})`);
    assert.equal(viaRelative.stdout, viaAbsolute.stdout,
      `${label} behaves differently via a relative path — its main-module guard is ` +
      'comparing raw strings instead of resolved real paths');
  }
});

test('./setup and setup.mjs are the same program, reached two different ways', () => {
  const viaWrapper = spawnSync(join(REPO_ROOT, 'setup'), ['--help'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  const viaNode = spawnSync(process.execPath, [join(REPO_ROOT, 'setup.mjs'), '--help'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });

  assert.equal(viaWrapper.status, 0, `./setup --help exited ${viaWrapper.status}: ${viaWrapper.stderr}`);
  assert.equal(viaNode.status, 0, `node setup.mjs --help exited ${viaNode.status}: ${viaNode.stderr}`);
  assert.equal(viaWrapper.stdout, viaNode.stdout,
    './setup must be a pure pass-through to setup.mjs, not a second implementation');
});

test('the wrapper forwards arguments and its exit code, and packs as a real file', () => {
  const wrapper = join(REPO_ROOT, 'setup');
  const src = readFileSync(wrapper, 'utf8');
  assert.match(src, /^#!\/bin\/sh/, 'the wrapper must be POSIX sh, not bash — it runs on minimal images');
  assert.match(src, /exec\b/, 'the wrapper must exec, so signals and the exit code pass straight through');
  assert.match(src, /setup\.mjs/, 'the wrapper must delegate to setup.mjs');
  // A shim, not a second implementation. Path plumbing (resolving the symlink chain
  // so `dirname` finds setup.mjs) is allowed; anything setup.mjs is about is not,
  // because logic here is logic no test of setup.mjs can see.
  for (const forbidden of ['gtm/', '.gitignore', 'suppression', 'mkdir']) {
    assert.ok(!src.includes(forbidden),
      `the wrapper mentions "${forbidden}" — that behaviour belongs in setup.mjs, where it is testable`);
  }

  // Arguments reach the implementation: --check is a real, side-effect-free flag.
  const res = spawnSync(wrapper, ['--check', '--json', '--root', REPO_ROOT],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.signal, null);
  assert.doesNotThrow(() => JSON.parse(res.stdout),
    `./setup did not forward --check --json to setup.mjs; got: ${res.stdout.slice(0, 200)}`);
});

// The floor that started all this was ">=18", written down and never run. A declared
// floor nobody executes is a guess. These two tests make the claim checkable: the
// floor must be an exact version, and CI must actually run that exact version.
test('engines.node declares an exact, testable floor', () => {
  const declared = PKG.engines?.node;
  assert.ok(declared, 'package.json must declare engines.node');
  assert.match(declared, /^>=\d+\.\d+\.\d+$/,
    `engines.node is "${declared}" — a floor like ">=18" claims every 18.x including ones ` +
    'nobody ran. Name the exact lowest version the suite was run green on.');
});

test('the CI matrix pins exact versions and its lowest row is the declared floor', () => {
  const wf = join(REPO_ROOT, '.github', 'workflows', 'validate.yml');
  const src = readFileSync(wf, 'utf8');

  const line = src.split('\n').find((l) => /^\s*node:\s*\[/.test(l));
  assert.ok(line, 'could not find the `node:` matrix row in validate.yml');
  const versions = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(versions.length >= 2, `the matrix has only ${versions.length} row(s)`);

  for (const v of versions) {
    assert.match(v, /^\d+\.\d+\.\d+$/,
      `matrix row "${v}" is a floating major — it resolves to the newest patch and proves ` +
      'nothing about the rest of the range, which is exactly how the extensionless bug hid');
  }

  const floor = PKG.engines.node.replace(/^>=/, '');
  const asTuple = (v) => v.split('.').map(Number);
  const cmp = (a, b) => {
    const [x, y] = [asTuple(a), asTuple(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const lowest = [...versions].sort(cmp)[0];
  assert.equal(lowest, floor,
    `engines.node says >=${floor} but the lowest CI row is ${lowest}. The floor is only ` +
    'a claim until CI runs it; make them the same version.');
});

// The third way the floor claim can be false: the code runs on it but the command
// the README tells you to type does not. `node --test <glob>` only gained
// glob-argument support in Node 21, so `node --test 'tests/**/*.test.mjs'` on the
// 18.20.8 floor exits with "Could not find 'tests/**/*.test.mjs'" and runs nothing.
// CI and scripts/ci-local.sh both already use an explicit `find` list for exactly
// this reason; package.json did not, so `npm test` was the one entry point that
// could not be executed on the version engines.node promises. Measured 2026-08-30:
// with the find form, 2204/2204 pass on v18.20.8.
test('npm test is runnable on the declared engines.node floor', () => {
  const script = PKG.scripts?.test;
  assert.ok(script, 'package.json must declare a test script');

  assert.ok(!/--test\s+['"]?[^'"\s]*\*/.test(script),
    `the test script passes a glob to \`node --test\`:\n    ${script}\n` +
    'Glob arguments need Node >= 21, but engines.node declares ' +
    `>=${PKG.engines.node.replace(/^>=/, '')}, so this runs nothing on the floor. ` +
    "Use the explicit list CI uses: node --test $(find tests -name '*.test.mjs' | sort)");

  const wf = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  const ciRuns = /run:\s*(node --test [^\n]+)/.exec(wf);
  assert.ok(ciRuns, 'could not find the CI test step in validate.yml');
  assert.equal(script.trim(), ciRuns[1].trim(),
    'npm test and the CI test step must invoke the suite the same way, or CI proves ' +
    'something no contributor can reproduce locally.');
});

test('package.json ships every executable it declares', () => {
  const files = PKG.files ?? [];
  const covered = (rel) => files.some((f) => rel === f || (f.endsWith('/') && rel.startsWith(f)));
  for (const { rel } of ALL) {
    assert.ok(covered(rel),
      `${rel} is an entry point but no "files" entry ships it — it would be missing from the tarball`);
  }
});
