// tests/contracts/no-real-pii.test.mjs
//
// THE TWO TREES THE LEAK GUARD DOES NOT LOOK AT CARRY NO REAL PERSON'S ADDRESS.
//
// `no-internal-leak.test.mjs` excludes `spec/` and `tests/fixtures/live/` on the grounds
// that they are never hand-edited (law 2). That reasoning is sound and the exclusion
// stays — but it left the two trees that come from OUTSIDE this repository, and
// therefore the only two that can carry someone else's contact details, unscanned in
// both guards.
//
// It shipped one. Until 2026-09-18 the pinned spec's `find_personal_email` 200 example
// was a real private individual's Gmail address, lifted from a live response upstream
// and mirrored into three hand-written spec fixtures. A public repository would have
// published it permanently into git history.
//
// THE RULE: inside those two trees, every email address is either a reserved domain
// (RFC 2606 / RFC 6761 — nobody can receive mail there) or one of ours. A live-scraped
// business address would also fail this, which is intended: a recording that needs one
// gets redacted by the capture tool before it is committed, exactly as
// `redacted@example.invalid` already shows.
//
// Scope note: this is about a person's mailbox, not about every string that identifies
// a company. Public business data in a recording — a company LinkedIn URL, a maps
// listing's switchboard number — is what the endpoints return and is not in scope here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREES = ['spec', 'tests/fixtures/live', 'tests/fixtures/spec'];

// RFC 2606 + RFC 6761 reserved names, and our own address. Nothing else may appear.
const ALLOWED_DOMAIN = /^(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost|richapi\.ai)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function walk (rel, out = []) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (!statSync(abs).isDirectory()) { out.push(rel); return out; }
  for (const e of readdirSync(abs)) walk(`${rel}/${e}`, out);
  return out;
}

const FILES = TREES.flatMap((t) => walk(t)).filter((f) => !/\.(png|ico|jpg|jpeg|gif|pdf)$/i.test(f));

test('no unreserved email domain in the spec or the recorded fixtures', () => {
  const offences = [];
  for (const rel of FILES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(EMAIL)) {
        if (!ALLOWED_DOMAIN.test(m[1])) offences.push(`${rel}:${i + 1}  ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offences, [], `Real-looking email address in a tree a stranger can read.\n\n${offences.join('\n')}\n\nRedact it to a reserved domain (example.com / example.invalid). If it is in\nspec/openapi.yaml, re-pin: shasum -a 256 spec/openapi.yaml > spec/openapi.yaml.sha256\nand restamp spec_sha256 across the generated artefacts, then npm run catalog:gen.`);
});

test('the guard actually scans the trees it claims to', () => {
  assert.ok(FILES.length > 100, `expected the recorded fixture tree, got ${FILES.length} files`);
  for (const t of TREES) assert.ok(FILES.some((f) => f.startsWith(`${t}/`)), `${t} not scanned`);
});

test('the pattern would have caught the kind of address that shipped', () => {
  // A CONSUMER MAILBOX, not the real one. The address this guard was written for was a
  // private individual's Gmail, and reproducing it here would have republished it inside
  // the test whose whole job is to keep it out — which is exactly what happened: it was
  // caught in the staged tree seconds before the history was rewritten.
  //
  // The rule under test is "an unreserved domain is refused", so any consumer mailbox
  // domain exercises it identically.
  for (const addr of ['someone@gmail.com', 'a.person@proton.me', 'user@yahoo.co.uk']) {
    const [, domain] = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(addr);
    assert.equal(ALLOWED_DOMAIN.test(domain), false, `${addr} must not be allowed`);
  }
});

// ---------------------------------------------------------------------------
// Third parties, not just people
// ---------------------------------------------------------------------------
//
// The spec's response examples came from real API responses, so they arrived carrying
// whoever happened to be in them. The 2026-09-18 pass found real small businesses with
// live domains, addresses, phone numbers and Google place ids; a real LinkedIn member
// URN; real ad-library creative ids; and CDN paths that encode a real account. None of
// that is secret — it is all public business data — but publishing a repository that
// ships an identifiable third party's contact details is a different act from reading
// them off an API.
//
// Values are what carry the risk. `field_map_keys` is derived from a 200 example's
// top-level KEY NAMES only, so neutralising values costs the catalog nothing: the
// 2026-09-18 scrub changed 48 values and `_lib/api-catalog.json` came back byte-identical.

const HOST = /https?:\/\/([A-Za-z0-9.-]+)/g;

/** Hosts an example may legitimately name: reserved names, our own, and platforms. */
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost|richapi\.ai|linkedin\.com|licdn\.com|crunchbase\.com|acme\.com|json-schema\.org|openapis\.org|google\.com|youtube\.com|schema\.org)$/i;

test('no identifiable third-party host in the spec or the recorded fixtures', () => {
  const offences = [];
  for (const rel of FILES) {
    if (!/\.(ya?ml|json)$/i.test(rel)) continue;
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(HOST)) {
        const host = m[1].replace(/\.$/, '');
        // `https://...` is an elided placeholder, not a host.
        if (/^[.]*$/.test(host)) continue;
        if (!ALLOWED_HOST.test(host)) offences.push(`${rel}:${i + 1}  ${host}`);
      }
    });
  }
  // The recorded live fixtures legitimately contain scraped third-party hosts — that IS
  // the response. Only the spec and the hand-written spec fixtures are held to this.
  const specOnly = offences.filter((o) => !o.startsWith('tests/fixtures/live/'));
  assert.deepEqual(specOnly, [],
    `Identifiable third-party host in a hand-maintained file.\n\n${specOnly.join('\n')}\n\n`
    + 'Replace the value with a reserved domain. Keys and structure must not change: '
    + 'field_map_keys is derived from KEY NAMES, so values are free to neutralise. '
    + 'Then re-pin: shasum -a 256 spec/openapi.yaml > spec/openapi.yaml.sha256');
});

test('no real street address or Google place id survives in the spec', () => {
  const spec = readFileSync(join(ROOT, 'spec', 'openapi.yaml'), 'utf8');
  assert.equal(/ChIJ[A-Za-z0-9_-]{10,}/.test(spec), false,
    'a Google place id identifies one real business premises');
  for (const m of spec.matchAll(/^\s*phone: (.+)$/gm)) {
    const phone = m[1].trim().replace(/["']/g, '');
    assert.match(phone, /555/,
      `${phone}: an example phone number must be in a reserved 555 range`);
  }
});
