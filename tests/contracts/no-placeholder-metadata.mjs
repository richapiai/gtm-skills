#!/usr/bin/env node
// tests/contracts/no-placeholder-metadata.mjs — the publish stop.
//
// WHY THIS FILE EXISTS
//
//   `repository`, `bugs` and `homepage` are not decoration. npm resolves every
//   RELATIVE link in a README against `repository`, so with no repository field the
//   README's ~40 links to `skills/*/SKILL.md`, `docs/skill-shape.md` and `_lib/`
//   are dead on npmjs.com for every reader. The fields therefore have to be present
//   before publish.
//
//   They must name the real repository (`richapiai/gtm-skills`). Inventing a URL
//   would be worse than having none: a wrong `repository` sends every relative README
//   link to somebody
//   else's repository, and `bugs` sends every bug report there too.
//
//   So the fields carry a marker that is impossible to mistake for a real URL, and
//   this script is the thing that stops the marker reaching the registry. It is
//   wired into `prepublishOnly`, which npm runs on `npm publish` and never on
//   `npm install`, so an accidental publish fails before the tarball is uploaded.
//
// WHY IT IS NOT A `node:test` FILE
//
//   A test that fails on the placeholder would fail on every checkout today, because
//   the placeholder is the correct current value. This has to be red only at publish
//   time. The always-on invariants that CAN hold today — the fields exist, all three
//   agree on one repository, publishConfig is public — live in
//   tests/contracts/package-metadata.test.mjs and run with the normal suite.
//
// Exit 0 = safe to publish. Exit 1 = a placeholder is still in package.json.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The marker. Chosen to be a syntactically valid URL path segment (so npm and
 * `npm pkg get` never choke on it) while being unreadable as a real repository, and
 * to be greppable as one token across the whole tree.
 */
export const PLACEHOLDER = 'PLACEHOLDER-SET-BEFORE-PUBLISH';

export const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

/** @returns {string[]} dotted paths inside package.json whose value contains the marker. */
export function placeholderPaths (pkg) {
  const hits = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (node.includes(PLACEHOLDER)) hits.push(path);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(pkg, '');
  return hits;
}

function main () {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const hits = placeholderPaths(pkg);
  if (hits.length === 0) {
    console.log('publish guard: no placeholder metadata in package.json.');
    return 0;
  }
  process.stderr.write(
    `REFUSING TO PUBLISH — package.json still carries ${PLACEHOLDER} in:\n`
    + hits.map((h) => `  ${h}\n`).join('')
    + '\nnpm resolves relative README links against `repository`, and sends bug reports to\n'
    + '`bugs`. Publishing with the marker in place would ship a README whose links all\n'
    + '404 and an issue tracker that does not exist.\n\n'
    + 'To fix: decide the repository name (`gtm-skills` collides with another\n'
    + "vendor's pack), create the remote, then replace every occurrence above\n"
    + 'with the real owner/repo. All three fields must name the SAME repository;\n'
    + 'tests/contracts/package-metadata.test.mjs checks that.\n',
  );
  return 1;
}

// Only when run as a program, so the test file can import the helpers above.
// Realpath both sides: npm invokes this as a RELATIVE path from an npm script, and a
// guard comparing raw strings is false for exactly that call — the same silent-no-op
// bug tests/contracts/executables-load.test.mjs exists to catch.
const asReal = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
if (process.argv[1] && asReal(fileURLToPath(import.meta.url)) === asReal(process.argv[1])) {
  process.exit(main());
}
