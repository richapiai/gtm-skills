// Canned RichAPI responses, transcribed from the Error Handling and
// Credits & Pricing sections of spec/openapi.yaml (lines 199-470).
//
// The shapes here are deliberately literal. In particular the 402 body carries
// `reserved` and `balance` as STRINGS, not numbers — that is what the API
// actually sends, and a ledger that assumes numbers will silently coerce
// "2.5" into something else on the one code path where getting the balance
// wrong costs real money.

/** A minimal, case-insensitive Headers stand-in. */
export class FakeHeaders {
  #map = new Map();
  constructor (init = {}) {
    for (const [k, v] of Object.entries(init)) this.#map.set(String(k).toLowerCase(), String(v));
  }
  get (name) { const v = this.#map.get(String(name).toLowerCase()); return v === undefined ? null : v; }
  has (name) { return this.#map.has(String(name).toLowerCase()); }
  set (name, value) { this.#map.set(String(name).toLowerCase(), String(value)); }
  entries () { return this.#map.entries(); }
  [Symbol.iterator] () { return this.#map.entries(); }
  toJSON () { return Object.fromEntries(this.#map); }
}

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required',
  403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

/**
 * A Response-alike. Enough surface for the runtime under test: status, ok,
 * headers.get(), json(), text(), clone(). Not a real Response — deliberately,
 * so nothing can accidentally hit the network through it.
 */
export class FakeResponse {
  constructor (status, body, headers = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.statusText = STATUS_TEXT[status] ?? '';
    this.headers = headers instanceof FakeHeaders ? headers : new FakeHeaders({ 'content-type': 'application/json', ...headers });
    this._body = body;
    this.bodyUsed = false;
  }
  async json () { this.bodyUsed = true; return typeof this._body === 'string' ? JSON.parse(this._body) : structuredClone(this._body); }
  async text () { this.bodyUsed = true; return typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
  clone () { return new FakeResponse(this.status, this._body, this.headers); }
}

/** 200 with a JSON body. */
export function okJson (body, { status = 200, headers = {} } = {}) {
  return new FakeResponse(status, body, headers);
}

/**
 * 402 Insufficient credits.
 * spec/openapi.yaml:~405 — `{"error":"Insufficient credits","reserved":"5","balance":"2.5"}`
 * This body refreshes the cached balance FOR FREE (no /usage call).
 * @param {{balance?: string|number, reserved?: string|number}} [opts]
 */
export function insufficientCredits ({ balance = '2.5', reserved = '5' } = {}) {
  return new FakeResponse(402, {
    error: 'Insufficient credits',
    reserved: String(reserved),
    balance: String(balance)
  });
}

/**
 * 429 Too Many Requests, with the `Retry-After` header the spec promises
 * (spec/openapi.yaml:~325 and ~420). Body carries only `error`.
 * @param {{retryAfter?: number|string}} [opts]
 */
export function tooManyRequests ({ retryAfter = 30 } = {}) {
  return new FakeResponse(429, { error: 'Too Many Requests' }, { 'retry-after': String(retryAfter) });
}

/** 401/403 — missing or invalid API key. Not billed. */
export function unauthorized ({ status = 401 } = {}) {
  return new FakeResponse(status, { error: 'No API access configured for this key' });
}

/** 404 — unknown endpoint. There is no `available_apis` list in the body. */
export function unknownEndpoint (name = 'nonexistent') {
  return new FakeResponse(404, { error: `Unknown API: ${name}. Use GET /api/v1/my-endpoints to see available APIs.` });
}

/** 503 — endpoint under maintenance. Carries a machine-readable `code`. */
export function underMaintenance () {
  return new FakeResponse(503, {
    error: 'This endpoint is under maintenance. It will be available again soon.',
    code: 'ENDPOINT_UNDER_MAINTENANCE'
  });
}

/** 502/504 — upstream service error or timeout. Retry with backoff. */
export function upstreamError ({ status = 502 } = {}) {
  return new FakeResponse(status, { error: 'The upstream service is temporarily unavailable. Please try again later.' });
}

/** 500 — internal server error. Not billed. */
export function serverError () {
  return new FakeResponse(500, { error: 'Internal Server Error' });
}

/**
 * `GET /usage` — the shape documented in the Credits & Pricing tag. Note that
 * /usage is NOT in `paths:` of the pinned spec, so this is the only
 * machine-usable record of its shape in the repo.
 */
export function usage ({ months = ['2026-03'], total_credits = 42.5, apis = { enrich_profile: { calls: 25, credits: 25 }, people_search: { calls: 5, credits: 17.5 } } } = {}) {
  return new FakeResponse(200, { months, total_credits, apis });
}

/**
 * A 200 body that carries NO billing field — the majority case for the 11 of
 * 21 metered endpoints whose response omits it. The ledger must write
 * cost_status `estimated_unverifiable` for these and never fabricate an actual
 * (law 4).
 */
export function okWithoutBillingField (body = {}) {
  return new FakeResponse(200, body);
}

// ---------------------------------------------------------------------------
// Live-shaped success bodies (added 2026-09-02)
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST, AND WHY A TEST SHOULD NEVER HAND-ROLL AN ENRICH BODY AGAIN.
//
// Until today every test wrote its own success body, each one transcribed from the
// spec's 200 examples. The spec was wrong about where the payload lives: the finder
// endpoints wrap it in `result`, and enrich_profile answers `picture`/`url`/
// `positionGroups` rather than `profilePicture`/`linkedinUrl`/`currentTitle`. So the
// production map and roughly a dozen test files were consistently wrong TOGETHER, the
// suite was green, and a paid `email_finder` call delivered the provider name and threw
// the email away.
//
// A shape that lives in one place can be corrected in one place. Every builder below is
// transcribed from a RECORDED response in tests/fixtures/live/, and
// tests/response-maps/response-map-coverage.test.mjs re-checks the real recordings on every
// run, so these cannot drift from the server without the build going red.
//
// Each takes overrides so a test can express a miss (`{ email: null }`) or a partial
// answer without rebuilding the envelope by hand.

/**
 * `email_finder` 200. Recorded shape:
 *   {success, result:{email, email_status, esp}, provider, providers_tried, execution_log}
 * Pass `{ result: null }` for a genuine not-found.
 */
export function liveEmailFinder (overrides = {}) {
  const { result, ...rest } = overrides;
  return {
    success: true,
    result: result === undefined
      ? { email: 'ada@acme.example', email_status: 'valid', esp: 'Microsoft 365 / Outlook' }
      : result,
    // A MISS carries `provider: null` — the recorded miss shape. Defaulting it to a
    // provider name would make a not-found produce a column, and a capability that
    // counts "delivered at least one column" as a find would score every miss as a hit.
    provider: result === null ? null : 'provider_a',
    providers_tried: result === null ? 3 : 1,
    execution_log: result === null
      ? [{ provider: 'provider_a', status: 'no_data', latency_ms: 402 }]
      : [{ provider: 'provider_a', status: 'success', latency_ms: 1715 }],
    ...rest,
  };
}

/** `email_verifier` 200. Recorded shape carries ONLY `result.status` — no echoed address. */
export function liveEmailVerifier (overrides = {}) {
  const { result, ...rest } = overrides;
  return {
    success: true,
    result: result === undefined ? { status: 'ok' } : result,
    // A MISS carries `provider: null` — the recorded miss shape. Defaulting it to a
    // provider name would make a not-found produce a column, and a capability that
    // counts "delivered at least one column" as a find would score every miss as a hit.
    provider: result === null ? null : 'provider_b',
    providers_tried: result === null ? 3 : 1,
    execution_log: result === null
      ? [{ provider: 'provider_b', status: 'no_data', latency_ms: 402 }]
      : [{ provider: 'provider_b', status: 'success', latency_ms: 2358 }],
    ...rest,
  };
}

/** `phone_finder` 200. The 25-credit call. Recorded shape: `result:{phone, phone_status}`. */
export function livePhoneFinder (overrides = {}) {
  const { result, ...rest } = overrides;
  return {
    success: true,
    result: result === undefined ? { phone: '+15550100', phone_status: 'valid' } : result,
    // A MISS carries `provider: null` — the recorded miss shape. Defaulting it to a
    // provider name would make a not-found produce a column, and a capability that
    // counts "delivered at least one column" as a find would score every miss as a hit.
    provider: result === null ? null : 'provider_c',
    providers_tried: result === null ? 3 : 1,
    execution_log: result === null
      ? [{ provider: 'provider_c', status: 'no_data', latency_ms: 402 }]
      : [{ provider: 'provider_c', status: 'success', latency_ms: 409 }],
    ...rest,
  };
}

/**
 * `enrich_profile` 200. No envelope; the current role lives under
 * `positionGroups[0].profilePositions[0]` and the employer under
 * `positionGroups[0].company`.
 */
export function liveEnrichProfile (overrides = {}) {
  return {
    url: 'https://www.linkedin.com/in/ada',
    entityUrn: 'ACoAAA8BYqEBCGLg',
    firstname: 'Ada',
    lastname: 'Lovelace',
    headline: 'VP Sales at Acme',
    summary: 'Builds data platforms.',
    picture: 'https://media.example/ada.jpg',
    industry: 'Software Development',
    openToWork: false,
    hiring: true,
    premium: true,
    influencer: false,
    creator: false,
    location: { country: 'United States', city: 'Seattle', state: 'Washington', defaultValue: 'Seattle, Washington, United States', shortValue: 'Seattle, Washington' },
    positionGroups: [{
      company: { id: 8736, name: 'Acme', logo: 'https://media.example/acme.png', url: 'https://www.linkedin.com/company/acme', domain: 'acme.example', profileType: 'COMPANY' },
      date: { start: '2019-01-01T00:00:00.000Z' },
      profilePositions: [{ company: 'Acme', title: 'VP Sales', date: { start: '2019-01-01T00:00:00.000Z' } }],
    }],
    educations: [{ school: { id: 1, name: 'Example University', logo: 'https://media.example/u.png', url: 'https://www.linkedin.com/school/eu', profileType: 'SCHOOL' }, date: { start: '2008', end: '2012' } }],
    ...overrides,
  };
}

/** `enrich_company` 200. `staff.total`, `followers`, `industries[]`, `locations.headquarter`. */
export function liveEnrichCompany (overrides = {}) {
  return {
    url: 'https://www.linkedin.com/company/acme',
    objectUrn: 'urn:li:company:1035',
    name: 'Acme',
    universalName: 'acme',
    type: 'PUBLIC_COMPANY',
    description: 'Every company has a mission.',
    website: 'https://acme.example',
    logo: 'https://media.example/acme.png',
    cover: 'https://media.example/acme-cover.png',
    followers: 28983871,
    industries: ['Software Development'],
    specialities: ['Business Software'],
    hashtags: ['#acme'],
    staff: { total: 232816, range: { start: 10001, end: null } },
    locations: {
      headquarter: { country: 'US', geographicArea: 'Washington', city: 'Redmond', postalCode: '98052', line1: '1 Microsoft Way' },
      other: [{ country: 'AU', geographicArea: 'NSW', city: 'North Sydney', postalCode: '2060', line1: '1 Denison Street' }],
    },
    ...overrides,
  };
}

/** `find_personal_email` 200. The resolved async envelope the capture settled on. */
export function liveFindPersonalEmail (overrides = {}) {
  const { data, ...rest } = overrides;
  return {
    id: '6a95c6873873c520987a4545',
    data: data === undefined ? { email: 'ada@personal.example', status: 'ok', verifier: 'Million Verifier' } : data,
    status: 'success',
    ...rest,
  };
}

export default {
  FakeHeaders, FakeResponse, okJson, insufficientCredits, tooManyRequests,
  unauthorized, unknownEndpoint, underMaintenance, upstreamError, serverError,
  usage, okWithoutBillingField,
  liveEmailFinder, liveEmailVerifier, livePhoneFinder,
  liveEnrichProfile, liveEnrichCompany, liveFindPersonalEmail,
};
