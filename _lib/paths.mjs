// _lib/paths.mjs — where the PACKAGE's own files live.
//
// The distinction this module exists to enforce:
//
//   PACKAGE root  — ships with the install. Holds api-catalog.json, gates.yaml,
//                   the contracts, the pinned spec. Read-only, same for every user.
//   PROJECT root  — the user's GTM workspace. Holds gtm/. Different every time.
//
// Conflating them is why the CLI only ran from inside the repo checkout: three
// separate lookups resolved package data against `process.cwd()`, found nothing, and
// either died or silently fell back to built-in defaults. The TTL sweep did the
// latter, so an operator's retention policy in gates.yaml was never applied.
//
// Nothing here should ever take a project root as a default.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed package root — the parent of this `_lib/` directory. */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PKG_LIB = path.join(PKG_ROOT, '_lib');

/** Generated endpoint catalog. Cost and routing come from here, never from prose. */
export const CATALOG_PATH = path.join(PKG_LIB, 'api-catalog.json');

/** Operator policy: gates, budgets, retention TTLs. */
export const GATES_PATH = path.join(PKG_LIB, 'gates.yaml');

/** The pinned OpenAPI document and its checksum. */
export const SPEC_PATH = path.join(PKG_ROOT, 'spec', 'openapi.yaml');
export const SPEC_SHA_PATH = `${SPEC_PATH}.sha256`;
