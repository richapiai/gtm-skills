// Injectable fake HTTP client.
//
// Two jobs:
//   1. Record every call so a test can assert WHICH paid endpoint ran, how
//      often, and with what body. "Every paid call is named and costed" (law 3)
//      is only enforceable if tests can see the calls.
//   2. Throw on ANY call. This is how `--dry-run`'s zero-call claim gets
//      proven rather than asserted: hand the runtime a client that cannot make
//      a request, and if the plan renders, the claim is true. A recording
//      client that merely counts zero proves only that this code path did not
//      call — a throwing client proves it cannot.

import { FakeResponse, okJson } from './responses.mjs';

/** Raised by a throwing client. Distinct type so tests can assert on it. */
export class ZeroCallViolation extends Error {
  constructor (url, reason) {
    super(`${reason} — but an HTTP call to ${url} was attempted`);
    this.name = 'ZeroCallViolation';
    this.url = url;
  }
}

/** Raised when a fake runs out of queued/registered responses. */
export class UnexpectedCallError extends Error {
  constructor (url, callCount) {
    super(`fake http: no response registered for call #${callCount} to ${url}`);
    this.name = 'UnexpectedCallError';
    this.url = url;
  }
}

function endpointOf (url) {
  const s = String(url);
  const withoutQuery = s.split('?')[0].replace(/\/+$/, '');
  const seg = withoutQuery.split('/').filter(Boolean).pop();
  return seg ?? withoutQuery;
}

function parseBody (init) {
  const raw = init?.body;
  if (raw == null) return { body: null, bodyText: null };
  if (typeof raw === 'string') {
    try { return { body: JSON.parse(raw), bodyText: raw }; } catch { return { body: null, bodyText: raw }; }
  }
  return { body: raw, bodyText: JSON.stringify(raw) };
}

function headerObject (init) {
  const h = init?.headers;
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries([...h.entries()]);
  return { ...h };
}

function matches (matcher, call) {
  if (typeof matcher === 'function') return Boolean(matcher(call));
  if (matcher instanceof RegExp) return matcher.test(call.url);
  const m = String(matcher);
  return call.endpoint === m || call.url === m || call.url.includes(m);
}

/**
 * @typedef {object} RecordedCall
 * @property {string} url
 * @property {string} endpoint  last path segment, e.g. "email_finder"
 * @property {string} method
 * @property {Record<string,string>} headers
 * @property {any} body         parsed JSON request body, or null
 * @property {string|null} bodyText
 * @property {number} at        Date.now() at call time
 */

/**
 * Create a recording fake HTTP client.
 *
 * @param {object} [opts]
 * @param {FakeResponse[]} [opts.queue]   FIFO responses, consumed one per call
 * @param {Array<[any, FakeResponse|((call:RecordedCall)=>FakeResponse)]>} [opts.routes]
 *        [matcher, response] pairs. Matcher is an endpoint name, a substring of
 *        the URL, a RegExp, or a predicate over the RecordedCall.
 * @param {FakeResponse|((call:RecordedCall)=>FakeResponse)} [opts.fallback]
 *        Used when nothing else matches. Omit to make an unmatched call throw
 *        UnexpectedCallError — the safer default, since a silent 200 turns a
 *        missing assertion into a passing test.
 * @param {boolean|string} [opts.throwOnCall]
 *        Truthy makes every call throw ZeroCallViolation. Pass a string to
 *        state the invariant being protected, e.g. "--dry-run must make zero calls".
 */
export function createFakeHttp (opts = {}) {
  const { queue = [], routes = [], fallback, throwOnCall = false } = opts;

  const state = {
    calls: /** @type {RecordedCall[]} */ ([]),
    queue: [...queue],
    routes: [...routes],
    fallback,
    throwOnCall
  };

  const resolveResponse = (call) => {
    for (const [matcher, response] of state.routes) {
      if (matches(matcher, call)) return typeof response === 'function' ? response(call) : response;
    }
    if (state.queue.length) return state.queue.shift();
    if (state.fallback !== undefined) {
      return typeof state.fallback === 'function' ? state.fallback(call) : state.fallback;
    }
    throw new UnexpectedCallError(call.url, state.calls.length);
  };

  const fake = {
    /** WHATWG-fetch-shaped. Pass this wherever the runtime takes a `fetch`. */
    async fetch (url, init = {}) {
      const { body, bodyText } = parseBody(init);
      const call = {
        url: String(url),
        endpoint: endpointOf(url),
        method: (init.method ?? 'GET').toUpperCase(),
        headers: headerObject(init),
        body,
        bodyText,
        at: Date.now()
      };
      if (state.throwOnCall) {
        // Record it first: the failure message is far more useful when the
        // test can print which endpoint broke the zero-call promise.
        state.calls.push(call);
        throw new ZeroCallViolation(call.url, typeof state.throwOnCall === 'string' ? state.throwOnCall : 'this client must never be called');
      }
      state.calls.push(call);
      const res = resolveResponse(call);
      return res instanceof FakeResponse ? res : okJson(res);
    },

    /** All calls, in order. */
    get calls () { return state.calls; },
    get callCount () { return state.calls.length; },

    /** Endpoint names in call order, e.g. ["email_finder","email_verifier"]. */
    calledEndpoints () { return state.calls.map(c => c.endpoint); },

    /** Every call whose endpoint / URL / predicate matches. */
    callsTo (matcher) { return state.calls.filter(c => matches(matcher, c)); },

    /** Register a route. Later registrations lose to earlier ones. */
    on (matcher, response) { state.routes.push([matcher, response]); return fake; },

    /** Append FIFO responses. */
    enqueue (...responses) { state.queue.push(...responses); return fake; },

    /** Set the catch-all. */
    setFallback (response) { state.fallback = response; return fake; },

    /** Flip this client into throw-on-any-call mode mid-test. */
    forbidCalls (reason = 'this client must never be called') { state.throwOnCall = reason; return fake; },
    allowCalls () { state.throwOnCall = false; return fake; },

    /** Clear recorded calls and pending queue; keeps routes. */
    reset () { state.calls.length = 0; state.queue.length = 0; return fake; },

    /**
     * Throw unless zero calls were made. Prefer createThrowingHttp for
     * zero-call proofs; use this when the client legitimately made calls in an
     * earlier phase and must make none in a later one.
     */
    assertNoCalls (message = 'expected zero HTTP calls') {
      if (state.calls.length) {
        const seen = state.calls.map(c => `${c.method} ${c.endpoint}`).join(', ');
        throw new Error(`${message} — but ${state.calls.length} were made: ${seen}`);
      }
    }
  };

  return fake;
}

/**
 * A client that throws ZeroCallViolation on any call. The proof form of the
 * zero-call claim: pass it to the code under test and let the runtime fail
 * loudly rather than asserting a count afterwards.
 *
 * @param {string} [reason] the invariant being protected, quoted in the error
 */
export function createThrowingHttp (reason = 'this code path must make zero HTTP calls') {
  return createFakeHttp({ throwOnCall: reason });
}

export default { createFakeHttp, createThrowingHttp, ZeroCallViolation, UnexpectedCallError };
