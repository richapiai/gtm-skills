#!/usr/bin/env node
// richapi-capture-fixtures — record one live response per endpoint and derive
// the field maps from what the API actually returns.
//
// WHY THIS EXISTS (law 2)
// -----------------------
// The spec is a cost-and-route source, NOT a schema source. Measured against
// the pinned spec/openapi.yaml:
//   * 36 of 68 endpoints have a 200 example in which >=40% of leaf values are
//     the literal string "example";
//   * email_finder's ENTIRE example is {confidence:"example", email:"example",
//     provider:"example"} — three keys, zero information;
//   * enrich_profiles_bulk and enrich_companies_bulk — the two endpoints the
//     whole batch path depends on — have NO example at all;
//   * `_list_count`, the billing field 10 endpoints charge from, appears in
//     ZERO examples.
// So field maps come from recorded live responses. This tool records them.
//
// THE LAW APPLIES TO THIS TOOL TOO (law 3)
// ----------------------------------------
// Every paid call is named and costed before it runs. This tool defaults to
// PLAN mode: it prints the per-endpoint credit cost and the total and exits
// without touching the network. Capturing requires an explicit --run plus a
// typed confirmation of the total (or --yes in CI).
//
// PII (law 7)
// -----------
// Live responses carry real contact data. Redacted copies are written to
// tests/fixtures/live/<endpoint>.json and are safe to commit. Unredacted
// bodies are only written with --keep-raw, to *.raw.json, which .gitignore
// already excludes.
//
// MAINTAINER TOOL. Not registered in package.json "bin". It imports the YAML
// parser from tests/helpers/, which is not in package.json "files"; if this
// ever needs to ship to end users, move tests/helpers/yaml.mjs to _lib/ first.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// `yaml` is a declared runtime dependency. Importing from tests/ made this binary
// throw ERR_MODULE_NOT_FOUND for every installed consumer, because package.json
// `files` ships bin/ and _lib/ but not tests/.
import YAML from 'yaml';
const parseYaml = (text) => YAML.parse(text);

// One origin rule for the whole pack. This binary sends `x-api-key` to
// `opts.baseUrl` once per endpoint in the spec, so `--run --yes --base-url
// https://evil.tld` used to walk the catalog posting the live key to a stranger.
// Same check, same refusal text, same opt-in as the JS client.
import { assertSafeOrigin, UnsafeOrigin, ORIGIN_ENV } from '../_lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SPEC = join(ROOT, 'spec', 'openapi.yaml');
const CATALOG = join(ROOT, '_lib', 'api-catalog.json');
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'live');
const FIELD_MAPS_DIR = join(OUT_DIR, 'field-maps');
const SAMPLE_INPUTS = join(OUT_DIR, 'sample-inputs.json');

const API_KEY_ENV = 'richapi_API_KEY';
const BASE_URL_DEFAULT = 'https://api.richapi.ai/api/v1';
const API_PREFIX = '/api/v1';

// ---------------------------------------------------------------- arguments
function parseArgs (argv) {
  const opts = {
    run: false, yes: false, only: null, keepRaw: false,
    assumeResults: 1, includeDisabled: false, includeUnbounded: false,
    // richapi_API_ORIGIN is an ORIGIN (no path); the client appends /api/v1 and so
    // must this, or an override silently POSTs to https://host/enrich_profile.
    baseUrl: process.env[ORIGIN_ENV]
      ? `${String(process.env[ORIGIN_ENV]).replace(/\/+$/, '')}${API_PREFIX}`
      : BASE_URL_DEFAULT,
    baseUrlSource: process.env[ORIGIN_ENV] ? ORIGIN_ENV : 'default',
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.run = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--keep-raw') opts.keepRaw = true;
    else if (a === '--include-disabled') opts.includeDisabled = true;
    else if (a === '--include-unbounded') opts.includeUnbounded = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--only') opts.only = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--only=')) opts.only = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--assume-results') opts.assumeResults = Number(argv[++i]);
    else if (a.startsWith('--assume-results=')) opts.assumeResults = Number(a.slice(17));
    else if (a === '--base-url') { opts.baseUrl = String(argv[++i]); opts.baseUrlSource = '--base-url'; }
    else { die(`unknown argument: ${a}\nRun with --help.`); }
  }
  // Checked HERE, not at the call site, so no path through this binary — plan mode
  // included — can end up holding an origin the key must not be sent to. Throws
  // UnsafeOrigin; `main` turns it into a die() so the refusal is the whole message
  // and not a stack trace.
  assertSafeOrigin(opts.baseUrl, { source: opts.baseUrlSource });
  return opts;
}

const HELP = `
richapi-capture-fixtures — record live responses and derive field maps

USAGE
  node bin/richapi-capture-fixtures.mjs [options]

  With no options this PLANS the run: it prints the credit cost of every
  endpoint it would call and the total, and makes zero HTTP requests.

OPTIONS
  --run                  actually capture. Requires a typed confirmation of the
                         total credit cost, or --yes.
  -y, --yes              skip the interactive confirmation (for CI).
  --only a,b,c           capture only these endpoints.
  --assume-results N     results assumed per per-result endpoint when costing
                         (default 1). Costing, not a request limit.
  --include-disabled     include endpoints the catalog marks
                         disabled_by_default (_lib/api-catalog.json). The
                         plan prints each one with the catalog's reason. Do
                         not pass this until that reason is settled.
  --include-unbounded    include per-result endpoints with no limit-style
                         request parameter. Their cost cannot be bounded in
                         advance, so they are excluded by default.
  --keep-raw             also write unredacted *.raw.json (gitignored).
  --base-url URL         override the API base URL. Must be https:, and unless it
                         is the default origin or a loopback host you must also
                         set richapi_ALLOW_CUSTOM_ORIGIN — see ENVIRONMENT.

ENVIRONMENT
  ${API_KEY_ENV}       required for --run.
  ${ORIGIN_ENV}    override the API origin (https:, no path). This binary sends
                         your API key to it once per endpoint, so a non-default
                         host is REFUSED unless you also opt in below.
  richapi_ALLOW_CUSTOM_ORIGIN
                         opt in to a non-default https origin: set it to the
                         hostname, or to 1 to allow any https origin. Loopback
                         hosts (localhost, 127.0.0.0/8, ::1) never need it.

OUTPUT
  tests/fixtures/live/<endpoint>.json            redacted response (committed)
  tests/fixtures/live/<endpoint>.raw.json        unredacted, --keep-raw only (gitignored)
  tests/fixtures/live/field-maps/<endpoint>.json field map for the catalog
  tests/fixtures/live/capture-report.json        what ran, what it cost, what failed
`;

function die (msg, code = 1) {
  process.stderr.write(`richapi-capture-fixtures: ${msg}\n`);
  process.exit(code);
}

// ------------------------------------------------------------- spec reading
function loadEndpoints ({ catalog } = {}) {
  if (!existsSync(SPEC)) die(`missing ${SPEC}`);
  // Disabled state is the catalog's call, never a name typed here (law 1).
  const cat = catalog ?? (existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : die(`missing ${CATALOG}`));
  const text = readFileSync(SPEC, 'utf8');
  const doc = parseYaml(text);
  const specSha = createHash('sha256').update(readFileSync(SPEC)).digest('hex');

  const out = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const method = item.post ? 'POST' : item.get ? 'GET' : null;
    if (!method) continue;
    const op = item.post ?? item.get;
    const schema = op.requestBody?.content?.['application/json']?.schema ?? {};
    const pricing = op['x-pricing'] ?? {};
    const props = schema.properties ?? {};
    const bounded = pricing.credits_per_result === undefined
      ? true
      : Object.keys(props).some(k => /^(limit|count|max_results|max|per_page|page_size|size|rows|n)$/i.test(k));

    const name = op.operationId ?? path.replace(/^\//, '');
    const catPricing = cat.endpoints?.[name]?.pricing ?? {};
    out.push({
      name,
      path,
      method,
      summary: op.summary ?? '',
      tag: op.tags?.[0] ?? null,
      requestProperties: props,
      requiredRequestFields: schema.required ?? [],
      requestBodyRequired: Boolean(op.requestBody?.required),
      pricing,
      bounded,
      disabledByDefault: Boolean(catPricing.disabled_by_default),
      disabledReason: catPricing.disabled_reason ?? null,
      exampleKeys: Object.keys(op.responses?.['200']?.content?.['application/json']?.example ?? {})
    });
  }
  return { endpoints: out, specSha, specVersion: doc.info?.version ?? 'unknown' };
}

// ------------------------------------------------------------------ costing
function estimateCredits (ep, assumeResults) {
  const p = ep.pricing;
  if (p.credits_per_call !== undefined && p.credits_per_result === undefined) {
    return { credits: p.credits_per_call, model: 'flat', certain: true };
  }
  const base = p.base_credits_per_call ?? 0;
  if (p.credits_per_result !== undefined) {
    return {
      credits: base + p.credits_per_result * assumeResults,
      model: base ? 'base_plus_per_result' : 'per_result',
      certain: ep.bounded,
      note: ep.bounded
        ? `${base ? `${base} base + ` : ''}${p.credits_per_result}/result x ${assumeResults} assumed`
        : `UNBOUNDED: charges ${p.credits_per_result}/result on ${p.result_count_field} with no limit-style parameter`
    };
  }
  return { credits: 0, model: 'unknown', certain: false, note: 'no x-pricing — cost UNKNOWN' };
}

// ------------------------------------------------- request body synthesis
// Deliberately public, non-personal values. A capture run must not send a real
// contact's data to an API and then store the answer.
const PLACEHOLDERS = [
  [/^(company_)?domain$|^clean_domain$|^website$/i, 'richapi.ai'],
  [/^messy_url$/i, 'https://www.RichAPI.ai/pricing?utm=1'],
  [/^url$|^page_url$|^search_url$|^website_url$/i, 'https://richapi.ai'],
  [/^company_name$|^organization$/i, 'RichAPI'],
  [/^linkedin_url$|^profile_url$/i, 'https://www.linkedin.com/in/williamhgates/'],
  [/^company_linkedin_url$|^company_url$/i, 'https://www.linkedin.com/company/microsoft/'],
  [/^urns?$/i, ['urn:li:fsd_profile:ACoAAA8BYQEBWX3Wn9F0Ykc1S2p1Y2tm']],
  [/^first_name$/i, 'Bill'],
  [/^last_name$/i, 'Gates'],
  [/^full_name$|^name$/i, 'Bill Gates'],
  [/^email$|^email_address$/i, 'support@richapi.ai'],
  [/^emails$/i, ['support@richapi.ai']],
  [/^phone(_number)?$/i, '+14155552671'],
  [/^keywords?$|^query$|^q$|^search_term$|^search$|^search_query$/i, 'sales intelligence'],
  [/^text$|^string$|^input$|^content$|^input_text$|^value$/i, 'RichAPI automates GTM workflows.'],
  [/^substring$|^needle$/i, 'API'],
  [/^separator$|^delimiter$/i, ','],
  [/^link$|^redirect_url$/i, 'https://richapi.ai'],
  [/^company$|^employer$/i, 'Microsoft'],
  [/^account_owner$|^advertiser$/i, 'Microsoft'],
  [/^job_id$/i, '4000000000'],
  [/^labels?$/i, ['a', 'b']],
  [/^values_associated_with_labels$/i, [['x'], ['y']]],
  [/^prompt$/i, 'Reply with the single word: ok'],
  [/^provider$/i, 'openai'],
  [/^location$|^geo$|^country$|^countries$/i, 'United States'],
  [/^title$|^job_title$/i, 'Head of Sales'],
  [/^industry$/i, 'Software Development'],
  [/^limit$|^count$|^max_results$|^page_size$|^size$/i, 1],
  [/^page$|^offset$|^start$/i, 1],
  [/^datetime$|^date$/i, '2026-08-28T00:00:00Z'],
  [/^format$/i, 'YYYY-MM-DD'],
  [/^list$|^items$|^values$/i, ['RichAPI Inc.', 'Acme, LLC']],
  [/^channel(_id)?$/i, 'general'],
  [/^video_id$/i, 'dQw4w9WgXcQ'],
  [/^post_url$|^activity_urn$/i, 'urn:li:activity:7000000000000000000']
];

function placeholderFor (field, schema) {
  for (const [re, value] of PLACEHOLDERS) if (re.test(field)) return value;
  const t = schema?.type;
  if (t === 'integer' || t === 'number') return 1;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') return {};
  return null; // unknown — the caller reports it rather than guessing
}

function loadSampleInputs () {
  if (!existsSync(SAMPLE_INPUTS)) return {};
  return JSON.parse(readFileSync(SAMPLE_INPUTS, 'utf8')).inputs ?? {};
}

function buildRequestBody (ep, overrides) {
  if (Object.prototype.hasOwnProperty.call(overrides, ep.name) && overrides[ep.name] === null) {
    // Explicitly marked "no safe sample input exists" — a visible gap, not a
    // silent one, and never a reason to invent credentials.
    return { body: null, source: 'declared-uncapturable', unknownFields: ['<declared uncapturable in sample-inputs.json>'] };
  }
  if (overrides[ep.name]) return { body: overrides[ep.name], source: 'sample-inputs.json', unknownFields: [] };
  if (!ep.requestBodyRequired && ep.requiredRequestFields.length === 0 && Object.keys(ep.requestProperties).length === 0) {
    return { body: {}, source: 'empty', unknownFields: [] };
  }
  const body = {};
  const unknown = [];

  // 1. Declared-required fields. A missing placeholder here is a hard gap: the
  //    call would 400 and waste nothing but time, but a guessed value could
  //    waste credits on a nonsense query. Report instead.
  for (const f of ep.requiredRequestFields) {
    const v = placeholderFor(f, ep.requestProperties[f]);
    if (v === null) unknown.push(f);
    else body[f] = v;
  }

  // 2. Any limit-style field, set to its minimum, so a per-result endpoint
  //    costs as little as the API will let it.
  for (const k of Object.keys(ep.requestProperties)) {
    if (/^(limit|count|max_results|page_size|size|rows)$/i.test(k) && !(k in body)) body[k] = 1;
  }

  // 3. Endpoints declaring nothing required (email_finder, phone_finder, ...)
  //    still need SOMETHING in the body. Fill the first declared properties we
  //    have a safe placeholder for; skip the ones we do not, rather than
  //    reporting a gap for a field the API never demanded.
  if (ep.requiredRequestFields.length === 0) {
    for (const k of Object.keys(ep.requestProperties)) {
      if (Object.keys(body).length >= 2) break;
      if (k in body) continue;
      const v = placeholderFor(k, ep.requestProperties[k]);
      if (v !== null) body[k] = v;
    }
  }

  if (unknown.length === 0 && Object.keys(body).length === 0 && Object.keys(ep.requestProperties).length > 0) {
    unknown.push('<no safe placeholder for any declared property>');
  }
  return { body, source: 'derived', unknownFields: unknown };
}

// ---------------------------------------------------------------- redaction
const PII_KEY = /(^|_)(email|emails|phone|phones|mobile|first_name|last_name|full_name|name|given_name|family_name|address|street|postal|zip|birth|dob|ssn|linkedin|profile_url|public_identifier|handle|username|headline|summary|about|bio|photo|picture|avatar|image_url|company_email|personal_email)($|_)/i;

/**
 * Identity keys the API answers with in CONCATENATED or camelCase form.
 *
 * `PII_KEY` above is anchored on `(^|_)` … `($|_)`, so it matches `first_name` and does
 * NOT match `firstname` — which is exactly what the server sends. Same root cause as the
 * 2026-09-02 response-map defect: the pattern was written for the shape the spec
 * describes rather than the shape the wire carries. The 2026-08-31 capture therefore
 * wrote a real, non-public person's name and LinkedIn identifier into
 * `tests/fixtures/live/people_search.json` while reporting `redacted: true`.
 *
 * These are matched as WHOLE KEYS, case-insensitively, so `companyName` and
 * `universalName` (business facts, not personal data) stay readable in the fixtures.
 */
const IDENTITY_KEY = /^(firstname|lastname|middlename|fullname|givenname|familyname|identifier|entityurn|objecturn|publicidentifier|profileid|memberid)$/i;
const EMAIL_RE = /[^\s@,;"']+@[^\s@,;"']+\.[A-Za-z]{2,}/g;
// A phone number in free text: a `+country…` run, or the (415) 555-2671 shape. A bare
// digit run is NOT enough — ids, epoch values and ISO dates look the same to a looser
// pattern, and masking them destroys the values a recording exists to show.
const PHONE_RE = /\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const PHONE_KEY = /phone|mobile|fax|(^|_)tel($|_)/i;
// Words a person wrote (a comment, a post body) and pictures of them. Kept as a shape,
// never as content: a public repository must not republish a stranger's comment.
const AUTHORED_KEY = /^(comment|commentary)$/i;
const PICTURE_KEY = /(picture|photo|avatar|background)$/i;
const MEDIA_RE = /https?:\/\/media\.licdn\.com\/[^\s"']+/gi;
const LINKEDIN_RE = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/[^\s"']+/gi;

function redactString (s) {
  return s
    .replace(EMAIL_RE, 'redacted@example.invalid')
    .replace(MEDIA_RE, 'https://media.example.invalid/REDACTED')
    .replace(LINKEDIN_RE, 'https://www.linkedin.com/in/REDACTED/')
    .replace(PHONE_RE, (m, offset, whole) => {
      // Digits inside an identifier or a date are not a phone number: URNs
      // (`urn:li:activity:7506…`), comment ids, URL slugs and ISO timestamps survive.
      const before = whole.slice(Math.max(0, offset - 60), offset);
      if (/urn:li:[A-Za-z_]+:[(A-Za-z_:,\d]*$/.test(before) || /[A-Za-z_\-/=]$/.test(before)) return m;
      if (/^\d{4}-\d{2}-\d{2}/.test(whole.slice(offset))) return m;
      return m.replace(/\D/g, '').length >= 8 ? '+10000000000' : m;
    });
}

/**
 * Type-preserving redaction. Shapes survive (that is the whole point of the
 * fixture); values that could identify a person do not.
 */
// Upstream data providers are not named in committed fixtures. Each distinct name in
// one response becomes `provider_1`, `provider_2`… in first-seen order, so a waterfall's
// sequence and its repeats stay readable. Model providers are the caller's own choice on
// `ai_enrich` and are public, so they are kept.
const PUBLIC_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'google', 'perplexity']);
const PROVIDER_KEY = /^(provider|providers?_used|vendor)$/i;

function aliasProvider (name, aliases) {
  if (PUBLIC_PROVIDERS.has(name.toLowerCase()) || /^(provider(_\d+)?|string)$/.test(name)) return name;
  if (!aliases.has(name)) aliases.set(name, `provider_${aliases.size + 1}`);
  return aliases.get(name);
}

export function redact (value, key = '', aliases = new Map()) {
  if (value === null || value === undefined) return value;
  // A numeric identifier never reached the string branch below, so `objectUrn:
  // 1013783998` survived redaction untouched. Zeroed rather than dropped: the KEY and
  // its TYPE are what the fixture exists to record.
  if (typeof value === 'number' && IDENTITY_KEY.test(key)) return 0;
  if (Array.isArray(value)) return value.slice(0, 3).map(v => redact(v, key, aliases));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, aliases);
    return out;
  }
  if (typeof value === 'string') {
    if (PROVIDER_KEY.test(key)) return aliasProvider(value, aliases);
    if (IDENTITY_KEY.test(key)) return 'REDACTED';
    if (PHONE_KEY.test(key) && /\d{6,}/.test(value.replace(/\D/g, ''))) return '+10000000000';
    if (AUTHORED_KEY.test(key)) return 'REDACTED';
    if (PICTURE_KEY.test(key) && /^https?:/i.test(value)) return 'https://media.example.invalid/REDACTED';
    if (PII_KEY.test(key)) {
      if (/url|linkedin|photo|picture|avatar|image/i.test(key)) return 'https://www.linkedin.com/in/REDACTED/';
      if (/email/i.test(key)) return 'redacted@example.invalid';
      if (/phone|mobile/i.test(key)) return '+10000000000';
      return 'REDACTED';
    }
    const s = redactString(value);
    return s.length > 240 ? s.slice(0, 237) + '...' : s;
  }
  return value;
}

// --------------------------------------------------------------- field maps
// Response key -> semantic field, the shape _lib/contracts/api-catalog.schema.json
// describes. Keys we do not recognise are surfaced as `unmapped_keys` rather
// than being given a plausible-looking name nobody verified.
const SEMANTIC = {
  email: 'email', work_email: 'email', personal_email: 'personal_email',
  phone: 'phone', mobile: 'phone', phone_number: 'phone',
  confidence: 'confidence', score: 'confidence', provider: 'provider',
  status: 'status', valid: 'is_valid', disposable: 'is_disposable',
  mxFound: 'mx_found', mx_found: 'mx_found',
  first_name: 'first_name', last_name: 'last_name', full_name: 'full_name', name: 'name',
  headline: 'headline', title: 'job_title', job_title: 'job_title',
  company: 'company_name', company_name: 'company_name', companyName: 'company_name',
  domain: 'company_domain', website: 'company_domain', clean_domain: 'company_domain',
  linkedin_url: 'linkedin_url', profile_url: 'linkedin_url', publicIdentifier: 'linkedin_handle',
  location: 'location', country: 'country', industry: 'industry',
  elements: 'result_list', numberOfElements: 'result_count', totalElements: 'result_total',
  count: 'result_count', _list_count: 'result_count',
  urn: 'urn', id: 'id', entityUrn: 'urn'
};

function jsonType (v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deriveFieldMap (body) {
  const fieldMap = {};
  const observedTypes = {};
  const unmapped = [];
  const source = (body && typeof body === 'object' && !Array.isArray(body)) ? body : { _root: body };
  for (const [k, v] of Object.entries(source)) {
    observedTypes[k] = jsonType(v);
    if (SEMANTIC[k]) fieldMap[k] = SEMANTIC[k];
    else unmapped.push(k);
  }
  return { fieldMap, observedTypes, unmapped };
}

function classifySample (body, ep) {
  if (body == null) return 'empty_body';
  if (typeof body !== 'object') return 'non_object_body';
  const keys = Object.keys(body);
  if (keys.length === 0) return 'empty_object';
  if (keys.length === 1 && keys[0] === 'error') return 'error_body';
  const emptyish = keys.every(k => body[k] === null || body[k] === '' || (Array.isArray(body[k]) && body[k].length === 0));
  return emptyish ? 'miss' : 'hit';
}

// -------------------------------------------------------------------- plan
function renderPlan (rows, { assumeResults, excluded }) {
  const w = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push('');
  lines.push('  CAPTURE PLAN — every paid call named and costed before it runs');
  lines.push('  ' + '-'.repeat(88));
  lines.push(`  ${w('endpoint', 40)}${w('model', 22)}${w('est. credits', 14)}note`);
  lines.push('  ' + '-'.repeat(88));
  for (const r of rows) {
    lines.push(`  ${w(r.name, 40)}${w(r.cost.model, 22)}${w(r.cost.credits, 14)}${r.cost.note ?? ''}`);
  }
  lines.push('  ' + '-'.repeat(88));
  const total = rows.reduce((a, r) => a + r.cost.credits, 0);
  lines.push(`  ${w('TOTAL', 40)}${w('', 22)}${w(round(total), 14)}${rows.length} endpoints, ${assumeResults} result(s) assumed per per-result endpoint`);
  lines.push('');
  if (excluded.length) {
    lines.push('  EXCLUDED (pass the named flag to include):');
    for (const e of excluded) lines.push(`    - ${w(e.name, 38)} ${e.reason}`);
    lines.push('');
  }
  return { text: lines.join('\n'), total: round(total) };
}

const round = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------- main
async function main () {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UnsafeOrigin) die(err.message, 2);
    throw err;
  }
  if (opts.help) { stdout.write(HELP); return 0; }
  if (!Number.isFinite(opts.assumeResults) || opts.assumeResults < 1) die('--assume-results must be a positive number');

  const { endpoints, specSha, specVersion } = loadEndpoints();
  const overrides = loadSampleInputs();

  let candidates = endpoints;
  if (opts.only) {
    const known = new Set(endpoints.map(e => e.name));
    const missing = opts.only.filter(n => !known.has(n));
    if (missing.length) die(`--only names endpoints that are not in the spec: ${missing.join(', ')}`);
    candidates = endpoints.filter(e => opts.only.includes(e.name));
  }

  const excluded = [];
  const rows = [];
  for (const ep of candidates) {
    if (ep.disabledByDefault && !opts.includeDisabled) {
      excluded.push({ name: ep.name, reason: `disabled_by_default — ${ep.disabledReason} (--include-disabled)` });
      continue;
    }
    const cost = estimateCredits(ep, opts.assumeResults);
    if (!ep.bounded && !opts.includeUnbounded) {
      excluded.push({ name: ep.name, reason: `cost cannot be bounded in advance — ${cost.note} (--include-unbounded)` });
      continue;
    }
    rows.push({ ep, name: ep.name, cost });
  }

  const plan = renderPlan(rows, { assumeResults: opts.assumeResults, excluded });
  stdout.write(plan.text);

  if (!opts.run) {
    stdout.write(
      '  PLAN ONLY — zero HTTP calls were made and zero credits were spent.\n' +
      `  To capture: ${API_KEY_ENV}=... node bin/richapi-capture-fixtures.mjs --run\n\n`
    );
    return 0;
  }

  // ---- from here on, real money ----
  const apiKey = process.env[API_KEY_ENV] ?? process.env.RICHAPI_API_KEY;
  if (!apiKey) {
    die(
      `no API key. --run needs a live key, and this environment has none.\n\n` +
      `  Set it and re-run:\n` +
      `    export ${API_KEY_ENV}='<your key>'\n` +
      `    node bin/richapi-capture-fixtures.mjs --run\n\n` +
      `  Create a key at https://richapi.ai (dashboard -> API keys).\n` +
      `  This run will spend approximately ${plan.total} credits (see the plan above).\n` +
      `  Nothing has been called and nothing has been charged.`,
      2
    );
  }

  if (!opts.yes) {
    if (!stdin.isTTY) {
      die('--run without --yes needs an interactive terminal to confirm the cost. Pass --yes only when you have read the plan.', 2);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`  This will spend approximately ${plan.total} credits. Type the number to confirm: `);
    rl.close();
    if (answer.trim() !== String(plan.total)) {
      stdout.write('  Not confirmed. Nothing was called and nothing was charged.\n');
      return 3;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FIELD_MAPS_DIR, { recursive: true });

  // A targeted capture (`--only`) must not erase the record of everything it did not
  // run. This file is the standing evidence of what has been recorded live, and a
  // one-endpoint re-record used to replace every row with one — measured 2026-09-18,
  // a `--only` run took the committed report from 13 rows to 1, silently, and was only
  // noticed because the working tree showed the deletion. Carry the previous rows
  // forward and let this run's results supersede their own endpoints, nothing else.
  const previous = (() => {
    try {
      const old = JSON.parse(readFileSync(join(OUT_DIR, 'capture-report.json'), 'utf8'));
      return Array.isArray(old?.results) ? old.results : [];
    } catch { return []; }         // absent or unreadable: this run is the whole record
  })();
  const ranNow = new Set(rows.map(({ ep }) => ep.name));

  const report = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    spec_sha256: specSha,
    spec_version: specVersion,
    base_url: opts.baseUrl,
    planned_credits: plan.total,
    results: []
  };

  for (const { ep, cost } of rows) {
    const { body, source, unknownFields } = buildRequestBody(ep, overrides);
    if (unknownFields.length) {
      report.results.push({
        endpoint: ep.name, status: 'skipped',
        reason: `no placeholder for required field(s): ${unknownFields.join(', ')}. Add an entry to tests/fixtures/live/sample-inputs.json.`,
        credits_estimated: cost.credits, credits_spent: 0
      });
      stdout.write(`  SKIP  ${ep.name} — needs sample input for ${unknownFields.join(', ')}\n`);
      continue;
    }

    const url = `${opts.baseUrl}${ep.path}`;
    let res; let parsed = null; let text = '';
    try {
      res = await fetch(url, {
        method: ep.method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: ep.method === 'GET' ? undefined : JSON.stringify(body)
      });
      text = await res.text();
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    } catch (err) {
      report.results.push({ endpoint: ep.name, status: 'network_error', reason: String(err?.message ?? err), credits_estimated: cost.credits, credits_spent: 0 });
      stdout.write(`  FAIL  ${ep.name} — ${err?.message ?? err}\n`);
      continue;
    }

    // Only 2xx is billed (spec: "Only successful calls are billed").
    const billed = res.ok ? cost.credits : 0;

    if (res.status === 402) {
      stdout.write(`  STOP  ${ep.name} — 402 Insufficient credits. Halting so the rest of the run is not attempted.\n`);
      report.results.push({ endpoint: ep.name, status: 'insufficient_credits', http_status: 402, body: parsed, credits_estimated: cost.credits, credits_spent: 0 });
      break;
    }

    const redacted = redact(parsed);
    if (opts.keepRaw) writeFileSync(join(OUT_DIR, `${ep.name}.raw.json`), JSON.stringify(parsed, null, 2) + '\n');
    writeFileSync(join(OUT_DIR, `${ep.name}.json`), JSON.stringify({
      endpoint: ep.name, path: ep.path, http_status: res.status,
      captured_at: new Date().toISOString(), redacted: true, body: redacted
    }, null, 2) + '\n');

    const sampleStatus = res.ok ? classifySample(parsed, ep) : 'http_error';
    const { fieldMap, observedTypes, unmapped } = deriveFieldMap(res.ok ? parsed : {});

    const usable = res.ok && sampleStatus === 'hit' && Object.keys(fieldMap).length > 0;
    // A recorded 2xx with a JSON body IS a live fixture, whether or not a semantic map
    // could be read off it; `field_map_derived` says which.
    const recorded = res.ok && parsed !== null && typeof parsed === 'object';
    writeFileSync(join(FIELD_MAPS_DIR, `${ep.name}.json`), JSON.stringify({
      endpoint: ep.name,
      path: ep.path,
      field_map_status: recorded ? 'live_fixture' : 'TODO_no_usable_example',
      field_map: usable ? fieldMap : null,
      observed_types: observedTypes,
      unmapped_keys: unmapped,
      sample_status: sampleStatus,
      billing_field: ep.pricing.result_count_field ?? null,
      billing_field_present_in_response: ep.pricing.result_count_field
        ? Object.prototype.hasOwnProperty.call(parsed ?? {}, ep.pricing.result_count_field)
        : null,
      captured_at: new Date().toISOString(),
      spec_sha256: specSha,
      source: 'live_capture',
      field_map_derived: usable
    }, null, 2) + '\n');

    report.results.push({
      endpoint: ep.name, status: res.ok ? 'ok' : 'http_error', http_status: res.status,
      sample_status: sampleStatus, request_source: source,
      credits_estimated: cost.credits, credits_spent: billed,
      field_map_status: recorded ? 'live_fixture' : 'TODO_no_usable_example'
    });
    stdout.write(`  ${res.ok ? ' OK ' : 'HTTP'}  ${ep.name} (${res.status}) — ${sampleStatus}, ${billed} credits\n`);
  }

  // This run's spend is this run's rows, before the carried-forward ones are merged in:
  // a previous capture's credits are not spent again by reprinting them.
  const spent = report.results.reduce((a, r) => a + (r.credits_spent ?? 0), 0);
  report.credits_spent_estimated = round(spent);
  const carried = previous.filter((r) => !ranNow.has(r.endpoint));
  if (carried.length) {
    report.results = [...report.results, ...carried]
      .sort((a, b) => String(a.endpoint).localeCompare(String(b.endpoint)));
    report.carried_forward = carried.length;
    report.endpoints_this_run = ranNow.size;
  }
  writeFileSync(join(OUT_DIR, 'capture-report.json'), JSON.stringify(report, null, 2) + '\n');
  stdout.write(`\n  Done. ~${round(spent)} credits spent (estimated; the API does not return credits_charged).\n`);
  stdout.write(`  Report: tests/fixtures/live/capture-report.json\n\n`);
  return 0;
}

// Exported for tests; only runs the CLI when invoked directly.
export { parseArgs, estimateCredits, buildRequestBody, deriveFieldMap, classifySample, loadEndpoints, renderPlan };

// Compared through realpath. A bare `=== process.argv[1]` fails for a RELATIVE
// invocation and for any symlink (Node resolves the entry point's symlinks, so
// import.meta.url is always the real file) — the command then silently does nothing
// and exits 0. Same rule as bin/richapi.mjs; see the note there.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const real = (f) => { try { return realpathSync(f); } catch { return resolve(f); } };
  return real(fileURLToPath(import.meta.url)) === real(resolve(process.argv[1]));
})();
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(err => die(err?.stack ?? String(err)));
}
