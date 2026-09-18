// setup-sweep — the optional, opt-in, priced-before-asked enrichment pass that
// `setup` offers over the user's OWN company domain.
//
// WHY THIS FILE EXISTS
//
//   A fresh install produces an empty `gtm/` tree. An empty tree is honest and it is
//   also the worst possible first impression: nothing in it proves the pack works.
//   One enrichment call on the user's own company fixes that for the price of a
//   single credit.
//
//   It is also the single most dangerous prompt in the pack, for two reasons:
//
//   1. LAW 3 — "every paid call is named and costed before it runs. No opt-out paid
//      calls, ever — including at setup." An opt-OUT sweep here would burn trust at
//      the exact moment the activation metric is measured, and it would break the
//      keystone law in the one place a user has no reason to expect a charge. So the
//      offer is opt-IN, the default is decline, and declining spends EXACTLY zero —
//      not "a small number", zero, proven by a client that throws on any use.
//
//   2. A TYPO BILLS A STRANGER. `acme.com` and `acme.co` are one keystroke apart and
//      look identical at a glance. Enriching the wrong one spends the user's credits
//      on a company that is not theirs and writes that company's data into their
//      `gtm/`. So the resolved domain is shown back split into label and TLD, with
//      the source it was inferred from, and the user must type it back EXACTLY.
//      "y" does not confirm a domain; only the domain confirms a domain.
//
//   And it must NEVER WEDGE. Setup's job is to prepare the tree. The sweep is a
//   bonus, and a bonus that blocks installation when the API is down is worse than
//   no bonus. Every failure — throw, timeout, 402, 401, missing key, missing gate
//   key, unpriceable catalog entry — degrades to "sweep skipped, setup complete,
//   exit 0".
//
// LAW 1: the credit number is read from the catalog through `ledger.estimate()`. No
// number is typed here.
// LAW 5: the two gate keys below are read through `gateValue()`, which throws on an
// absent leaf. A missing key therefore means NO SWEEP, never "no bound".
// LAW 7: the sweep writes PII into `gtm/`, so it goes through `_lib/run.mjs`, which
// stamps provenance and applies the TTL table. It is never hand-rolled.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { gateValue } from './gates.mjs';
import { estimate as estimateCost } from './ledger.mjs';

/**
 * The one endpoint the sweep may call.
 *
 * `enrich_company` is priced `flat` (so the quote cannot be wrong by a result count
 * nobody can predict), is `bounded`, is NOT page-gated and is NOT in `always_ask`. A
 * sweep over anything people-shaped would also be a personal-data fetch nobody asked
 * for.
 *
 * WHAT IT TAKES, measured against the live API on 2026-09-18:
 *
 *     url=https://www.linkedin.com/company/richapi  -> 200, 15 columns, 1 credit
 *     url=richapi              (the universalName)  -> 200, the same company
 *     url=richapi.ai / acme.com / github.com        -> 404
 *     url=https://stripe.com                        -> 503
 *
 * A LinkedIn company, then. This comment used to say the opposite — "the only endpoint
 * that takes a bare company domain" — and also that the response reports its charge,
 * which no endpoint in this API does (`billing_field_present_in_response: false` for
 * all 68). The sweep offered a DOMAIN, so every sweep it ever made would have 404'd.
 * Nothing was charged, because a non-2xx is unbilled, which is why it went unnoticed.
 *
 * Do NOT strip the TLD and send the label as a slug. Measured the same day: `acme`
 * answers 200 with "Acme Home Loans", which has nothing to do with acme.com — a paid,
 * confident, WRONG company written into the operator's gtm/.
 */
export const SWEEP_ENDPOINT = 'enrich_company';

/** Gate keys this module reads. Absent => the sweep is unavailable (law 5). */
export const GATE_KEYS = Object.freeze({
  timeout_ms: 'setup_sweep.timeout_ms',
  max_credits: 'setup_sweep.max_credits',
});

/**
 * Hosts that are a code forge, not a company. A git remote on one of these tells us
 * where the code lives and nothing about who the user is.
 */
const FORGE_HOSTS = new Set([
  'github.com', 'www.github.com', 'gist.github.com', 'ssh.github.com',
  'gitlab.com', 'bitbucket.org', 'codeberg.org', 'git.sr.ht', 'sr.ht',
  'dev.azure.com', 'ssh.dev.azure.com', 'visualstudio.com', 'sourceforge.net',
  'gitea.com', 'git.launchpad.net', 'launchpad.net', 'pagure.io',
]);

/**
 * Consumer mailbox providers. A git `user.email` at one of these is the user's
 * personal address; its domain is a mail host, not their company.
 */
const CONSUMER_MAIL_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'yandex.ru', 'yandex.com', 'mail.ru', 'zoho.com',
  'fastmail.com', 'hey.com', 'duck.com', 'tutanota.com', 'tuta.io',
  'qq.com', '163.com', '126.com', 'naver.com', 'web.de', 'inbox.lv',
  'users.noreply.github.com', 'example.com', 'example.org', 'localhost',
]);

/** Reserved / non-routable names that are never a company domain. */
const NOT_A_COMPANY = new Set(['localhost', 'localhost.localdomain', 'invalid', 'test', 'local']);

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// ---------------------------------------------------------------------------
// Domain normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce anything domain-ish — a URL, an email, `WWW.Acme.com:8443/about?x=1` — to a
 * bare lowercase registrable host, or null when it is not a domain at all.
 *
 * Returning null rather than a best guess is the point: the value that comes out of
 * here is about to be shown as "this is the company we will bill you to enrich", so
 * "I could not read that" must be distinguishable from "acme.com".
 */
export function normalizeDomain (raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === '') return null;

  s = s.replace(/^mailto:/i, '');
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, '');   // scheme
  s = s.split(/[/?#\\]/, 1)[0];                      // path / query / fragment
  const at = s.lastIndexOf('@');
  if (at !== -1) s = s.slice(at + 1);                // userinfo, or an email's local part
  s = s.replace(/^\[|\]$/g, '');                     // bracketed IPv6
  s = s.replace(/:\d+$/, '');                        // port
  s = s.replace(/\.+$/, '');                         // root dot
  s = s.toLowerCase();
  if (s.startsWith('www.')) s = s.slice(4);

  if (s === '' || s.length > 253) return null;
  if (NOT_A_COMPANY.has(s)) return null;
  if (IPV4_RE.test(s)) return null;
  if (s.includes(':')) return null;                  // IPv6
  if (!DOMAIN_RE.test(s)) return null;

  const labels = s.split('.');
  const tld = labels[labels.length - 1];
  // A numeric or single-character TLD is not a registrable public suffix; either way
  // it is not something worth spending a credit on.
  if (tld.length < 2 || !/^[a-z]+$/.test(tld)) return null;
  if (labels.length < 2 || labels[0] === '') return null;
  return s;
}

/**
 * The LinkedIn company this sweep enriches, or null.
 *
 * The two forms the endpoint answers: the company URL, and the bare `universalName`
 * slug. This runs BEFORE any domain normalisation, and has to: `normalizeDomain`
 * reduces `https://www.linkedin.com/company/richapi` to `linkedin.com`, so a user who
 * passed their own company URL to `--sweep-domain` was silently offered a sweep of
 * LinkedIn itself, which then 404s as a bare domain.
 */
export function sweepCompany (raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return null;
  const m = v.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (m) return { url: `https://www.linkedin.com/company/${m[1].toLowerCase()}`, slug: m[1].toLowerCase() };
  // A bare slug: no scheme, no path, and no dot — a dot makes it a domain.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(v)) return { url: v.toLowerCase(), slug: v.toLowerCase() };
  return null;
}

/**
 * Split for DISPLAY, so a typo is visible instead of merely present.
 * `acme.co.uk` -> { label: 'acme', tld: 'co.uk' }.
 */
export function spellDomain (domain) {
  const labels = String(domain).split('.');
  // Two-part public suffixes common enough that showing only ".uk" would hide the
  // interesting half. Not a full PSL — this is a display aid, not a routing decision.
  const twoPart = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au',
    'org.au', 'co.nz', 'co.jp', 'co.za', 'com.br', 'com.mx', 'co.in', 'com.sg']);
  const last2 = labels.slice(-2).join('.');
  const tld = labels.length > 2 && twoPart.has(last2) ? last2 : labels[labels.length - 1];
  const label = labels.slice(0, labels.length - tld.split('.').length).join('.');
  return { label, tld };
}

// ---------------------------------------------------------------------------
// Resolving the user's OWN domain
// ---------------------------------------------------------------------------

function gitConfig (root, key) {
  try {
    return execFileSync('git', ['-C', root, 'config', '--get', key],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function readPackageJson (root) {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Infer the user's own company domain, cheapest and most explicit source first.
 *
 * Every source is a GUESS and is labelled as one. The value of the source line is
 * that it lets the user recognise a wrong answer: "found in your git user.email" and
 * "you passed --sweep-domain" fail in completely different ways, and the second is
 * the only one where re-reading the flag is the fix.
 *
 * Returns { domain, source, evidence } or { domain: null, source: null, tried: [...] }.
 */
export function resolveOwnDomain ({ root = process.cwd(), env = process.env, explicit = null } = {}) {
  const tried = [];
  const attempt = (source, raw, evidence) => {
    if (!raw) return null;
    const d = normalizeDomain(raw);
    tried.push({ source, raw: String(raw), accepted: Boolean(d) });
    return d ? { domain: d, source, evidence: evidence ?? String(raw), tried } : null;
  };

  if (explicit) {
    const d = normalizeDomain(explicit);
    tried.push({ source: 'flag', raw: String(explicit), accepted: Boolean(d) });
    if (d) return { domain: d, source: 'flag', evidence: `--sweep-domain ${explicit}`, tried };
    return { domain: null, source: null, tried, error: `"${explicit}" is not a readable domain` };
  }

  const fromEnv = attempt('env', env.RICHAPI_OWN_DOMAIN, 'the RICHAPI_OWN_DOMAIN environment variable');
  if (fromEnv) return fromEnv;

  const pkg = readPackageJson(root);
  if (pkg) {
    const home = typeof pkg.homepage === 'string' ? pkg.homepage : null;
    // A homepage pointing at the forge is the repo's page, not the company's.
    const homeHost = home ? normalizeDomain(home) : null;
    if (homeHost && !FORGE_HOSTS.has(homeHost)) {
      const hit = attempt('package.json:homepage', home, 'package.json "homepage"');
      if (hit) return hit;
    } else if (home) {
      tried.push({ source: 'package.json:homepage', raw: home, accepted: false });
    }
  }

  const remote = gitConfig(root, 'remote.origin.url');
  if (remote) {
    // scp-style `git@host:org/repo` has no scheme; normalizeDomain's `@` handling
    // already lands on the host, and the `:` port strip does not fire because what
    // follows the colon is not digits-to-end.
    const host = normalizeDomain(remote.replace(/^([^/]+):/, (m, h) => (h.includes('@') ? `${h}/` : m)));
    if (host && !FORGE_HOSTS.has(host)) {
      const hit = attempt('git:remote.origin.url', host, `git remote origin (${remote})`);
      if (hit) return hit;
    } else {
      tried.push({ source: 'git:remote.origin.url', raw: remote, accepted: false });
    }
  }

  const email = gitConfig(root, 'user.email');
  if (email) {
    const host = normalizeDomain(email);
    if (host && !CONSUMER_MAIL_HOSTS.has(host)) {
      const hit = attempt('git:user.email', host, `git user.email (${email})`);
      if (hit) return hit;
    } else {
      tried.push({ source: 'git:user.email', raw: email, accepted: false });
    }
  }

  return { domain: null, source: null, tried };
}

const SOURCE_PROSE = {
  'flag': 'you passed it on the command line (--sweep-domain)',
  'env': 'the RICHAPI_OWN_DOMAIN environment variable',
  'package.json:homepage': 'the "homepage" field of this repo\'s package.json',
  'git:remote.origin.url': 'this repo\'s git remote "origin"',
  'git:user.email': 'your git user.email — a GUESS from your address, check it hard',
};

export function sourceProse (source) { return SOURCE_PROSE[source] ?? 'an unknown source'; }

// ---------------------------------------------------------------------------
// Pricing — law 1: from the catalog, never typed
// ---------------------------------------------------------------------------

/** Read a gate leaf without throwing. Absent => unavailable, never "unbounded". */
function readGate (gates, dotted) {
  try { return { ok: true, value: gateValue(gates, dotted) }; }
  catch (e) { return { ok: false, value: null, reason: e && e.message ? e.message : String(e) }; }
}

/**
 * Price the sweep from the catalog and check it against its ceiling.
 *
 * The ceiling exists because law 1's own evidence says it must: 16 of 53 endpoints
 * repriced in four months and `phone_finder` went 3 -> 25 credits. A regenerated
 * catalog can therefore make this prompt quote 25 credits without anyone editing a
 * line of this file. Past `setup_sweep.max_credits` the sweep declines itself rather
 * than offering a number nobody signed off on.
 */
export function priceSweep ({ catalog, gates, endpoint = SWEEP_ENDPOINT } = {}) {
  const entry = catalog?.endpoints?.[endpoint];
  if (!entry) {
    return { available: false, reason: `${endpoint} is not in the catalog`, endpoint };
  }
  if (entry.deprecated) {
    return { available: false, reason: `${endpoint} is deprecated in the catalog`, endpoint };
  }
  if (entry.pricing?.disabled_by_default) {
    return { available: false, reason: `${endpoint} is disabled by default in the catalog`, endpoint };
  }

  const est = estimateCost(entry, { resultCount: 1 });
  if (est.credits === null || !Number.isFinite(est.credits)) {
    // An unpriceable call cannot be named and costed, so under law 3 it cannot be
    // offered at all.
    return { available: false, reason: `${endpoint} is not priceable from the catalog (${est.basis})`, endpoint };
  }

  const ceiling = readGate(gates, GATE_KEYS.max_credits);
  if (!ceiling.ok) {
    return {
      available: false, endpoint, credits: est.credits,
      reason: `gates.yaml:${GATE_KEYS.max_credits} is missing — the sweep fails closed (law 5)`,
    };
  }
  const maxCredits = Number(ceiling.value);
  if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
    return { available: false, endpoint, credits: est.credits,
      reason: `gates.yaml:${GATE_KEYS.max_credits} is not a positive number` };
  }
  if (est.credits > maxCredits) {
    return {
      available: false, endpoint, credits: est.credits, max_credits: maxCredits,
      reason: `${endpoint} now costs ${est.credits} credits, above the `
        + `gates.yaml:${GATE_KEYS.max_credits} ceiling of ${maxCredits} — not offered`,
    };
  }

  const timeout = readGate(gates, GATE_KEYS.timeout_ms);
  if (!timeout.ok) {
    return {
      available: false, endpoint, credits: est.credits,
      reason: `gates.yaml:${GATE_KEYS.timeout_ms} is missing — the sweep fails closed (law 5)`,
    };
  }
  const timeoutMs = Number(timeout.value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { available: false, endpoint, credits: est.credits,
      reason: `gates.yaml:${GATE_KEYS.timeout_ms} is not a positive number` };
  }

  return {
    available: true,
    endpoint,
    credits: est.credits,
    basis: est.basis,
    verifiable: est.verifiable,
    model: est.model,
    max_credits: maxCredits,
    timeout_ms: timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// The prompt copy
// ---------------------------------------------------------------------------

/**
 * The offer. This is the first paid-call prompt a new user ever reads, so it names
 * the endpoint, the exact request body, the price and where the price came from,
 * and what gets written — BEFORE it asks anything. A prompt reading "shall I look up
 * your company?" with no number attached is the opt-in-shaped law 3 violation this
 * whole task exists to prevent.
 */
export function renderSweepOffer ({ domain, source, price, ttlDays = null, company = null }) {
  // A company is confirmed by its slug; a domain by its label and TLD. Same shape of
  // question either way: type back the thing that identifies who gets enriched.
  const { label, tld } = company ? { label: company.slug, tld: null } : spellDomain(domain);
  const spelled = tld === null ? label : `${label}.${tld}`;
  const verif = price.verifiable
    ? 'the response reports the charge, so the receipt carries an actual'
    : 'the response does NOT report the charge, so this is recorded estimated_unverifiable';
  const ttl = ttlDays === null ? '' : `, TTL ${ttlDays}d`;
  return [
    '',
    '  ─ optional, paid, and off by default ──────────────────────────────────────',
    '',
    '  Setup itself is finished and it spent nothing. What follows is a PAID call,',
    '  it is entirely optional, and doing nothing declines it.',
    '',
    '  I can make ONE enrichment call on your own company, so this install has a',
    '  real record in gtm/ instead of an empty tree.',
    '',
    `    call      POST /${price.endpoint}  {"url": "${domain}"}`,
    `    cost      ${price.credits} credit${price.credits === 1 ? '' : 's'}  (catalog: ${price.basis}; `
      + '_lib/api-catalog.json, not typed here)',
    `              ${verif}`,
    `    writes    gtm/enrichment-cache/${price.endpoint}.jsonl — personal data${ttl}`,
    '',
    (company ? '    company   ' : '    domain    ') + domain,
    company
      ? `              universalName "${label}"`
      : `              name "${label}"   ·   TLD ".${tld}"`,
    `              inferred from ${sourceProse(source)}`,
    '',
    `  Read that character by character. "${spelled}" and a one-letter neighbour of it`,
    '  are different companies: the wrong one spends your credits enriching a stranger',
    '  and writes their data into your gtm/.',
    '',
    `  To run it, type "${spelled}" back exactly. Anything else — Enter, "y", "yes",`,
    '  a near miss — declines and spends 0 credits.',
    '',
  ].join('\n');
}

export function sweepQuestion (domain, company = null) {
  const { label, tld } = company ? { label: company.slug, tld: null } : spellDomain(domain);
  const spelled = tld === null ? label : `${label}.${tld}`;
  return `  Type "${spelled}" to run it, or press Enter to skip: `;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * The domain confirmation. An exact match against the domain that was displayed, and
 * nothing else. `y` is not a confirmation of a domain — it is a confirmation of
 * whatever the reader thought they saw, which is exactly the failure mode.
 */
export function checkCompanyConfirmation (answer, company) {
  const raw = answer === null || answer === undefined ? '' : String(answer).trim();
  if (raw === '') return { ok: false, code: 'no_answer', reason: 'nothing typed — declined' };
  if (/^(y|yes|ok|sure|yep|yeah|n|no)$/i.test(raw)) {
    return {
      ok: false, code: 'yes_is_not_a_company',
      reason: `"${raw}" does not confirm a company. Type ${company.slug} exactly, or Enter to skip.`,
    };
  }
  // The URL confirms too: it is what was displayed, and retyping it is stricter, not
  // looser, than the slug.
  const typed = sweepCompany(raw);
  if (!typed) return { ok: false, code: 'unreadable', reason: `"${raw}" is not a LinkedIn company — declined` };
  if (typed.slug !== company.slug) {
    return {
      ok: false, code: 'mismatch',
      reason: `"${typed.slug}" is not "${company.slug}" — declined, and nothing was spent`,
    };
  }
  return { ok: true, code: 'confirmed', company };
}

export function checkDomainConfirmation (answer, domain) {
  const raw = answer === null || answer === undefined ? '' : String(answer).trim();
  if (raw === '') return { ok: false, code: 'no_answer', reason: 'no domain typed — declined' };
  if (/^(y|yes|ok|sure|yep|yeah|n|no)$/i.test(raw)) {
    return {
      ok: false, code: 'yes_is_not_a_domain',
      reason: `"${raw}" does not confirm a domain. Type ${domain} exactly, or Enter to skip.`,
    };
  }
  const typed = normalizeDomain(raw);
  if (!typed) return { ok: false, code: 'unreadable', reason: `"${raw}" is not a readable domain — declined` };
  if (typed !== domain) {
    return {
      ok: false, code: 'mismatch', typed,
      reason: `you typed ${typed}, the offer was for ${domain}. One letter apart is a `
        + 'different company, so nothing was called and 0 credits were spent. Re-run with '
        + `\`./setup --sweep --sweep-domain ${typed}\` if ${typed} really is your company.`,
    };
  }
  return { ok: true, code: 'confirmed', typed };
}

// ---------------------------------------------------------------------------
// Running it — every failure degrades, none wedges
// ---------------------------------------------------------------------------

export class SweepUnavailable extends Error {
  constructor (msg, code = 'unavailable') { super(msg); this.name = 'SweepUnavailable'; this.code = code; }
}

/** A timeout that never keeps the process alive. */
function withTimeout (promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`the sweep did not answer within ${ms}ms`);
      e.code = 'sweep_timeout';
      reject(e);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Run the confirmed sweep through the ordinary gated call surface.
 *
 * NOTHING about the call is hand-rolled: `runCall` builds the request against the
 * endpoint's contract, checks suppression, applies the session budget, writes the
 * journal, the ledger and the PII-stamped cache entry, and honours the TTL table.
 * The sweep's only additions are a wall-clock bound and a refusal to spend more than
 * the number the user was shown.
 *
 * @returns {Promise<object>} always resolves; failures come back as { ok: false }.
 */
export async function runSweep ({
  domain, price, root, dir = 'gtm', api = null, catalog = null, gates = null,
  runCall = null, now = () => new Date(),
}) {
  const call = runCall ?? (await import('./run.mjs')).runCall;
  const quoted = price.credits;

  const pending = call({
    endpoint: price.endpoint,
    rows: [{ url: domain }],
    root,
    dir,
    api,
    catalog,
    gates,
    budget: price.max_credits,
    // The user has already been shown the endpoint, the body and the price, and has
    // typed the domain back. That IS the law 3 confirmation. What is NOT approved is
    // a plan that grew: if the surface's own estimate exceeds the quote, decline.
    confirm: async ({ plan }) => {
      const total = plan?.totals?.credits_estimated;
      return Number.isFinite(total) && total <= quoted;
    },
  });

  try {
    const res = await withTimeout(pending, price.timeout_ms);
    // A declined/blocked plan is a zero-call outcome, not a success.
    if (res && (res.mode === 'declined' || res.mode === 'blocked')) {
      return {
        ok: false, code: res.mode === 'declined' ? 'plan_exceeded_quote' : 'gate_blocked',
        message: (res.reasons && res.reasons.join('; '))
          || `the planned spend did not match the ${quoted}-credit quote, so nothing was called`,
        calls_made: 0, credits: 0, at: now().toISOString(),
      };
    }
    // `runGated` does NOT throw on a 402 or a 500 — it journals the unit failed (or
    // aborts the run) and returns normally. So "did it work" is read off the executor,
    // never off the absence of an exception.
    const exec = res?.exec ?? {};
    const calls = exec.calls_made ?? res?.calls_made ?? 0;
    const t = res?.ledger_totals ?? {};
    // Law 4: never fabricate an actual. `ledger_total` is already actual-where-known
    // and estimate-where-not; the quote is the fallback only when no line was written.
    const spent = Number.isFinite(t.ledger_total) ? t.ledger_total : (calls > 0 ? quoted : 0);
    const base = {
      calls_made: calls, credits: spent, run_id: res?.run_id ?? null,
      endpoint: price.endpoint, domain, at: now().toISOString(),
    };
    if (exec.aborted) {
      return { ...base, ok: false, code: exec.abort_reason ?? 'aborted',
        message: `the run aborted (${exec.abort_reason ?? 'unknown reason'})` };
    }
    if ((exec.ok ?? 0) === 0 && (exec.failed ?? 0) > 0) {
      return { ...base, ok: false, code: 'call_failed',
        message: `${exec.failed} call(s) failed; see ${res?.journal_path ?? 'the run journal'}` };
    }
    return { ...base, ok: true, code: 'ok' };
  } catch (err) {
    // EVERY throw lands here. There is no rethrow: a failed bonus must not be able to
    // fail an installation.
    return {
      ok: false,
      code: err?.code ?? (err?.name === 'MissingApiKey' ? 'no_api_key' : 'sweep_failed'),
      status: err?.status ?? null,
      message: err && err.message ? err.message : String(err),
      calls_made: 0, credits: 0, at: now().toISOString(),
    };
  }
}

/** Human-readable one-liner for whatever the sweep ended up doing. */
export function renderSweepOutcome (sweep) {
  if (!sweep) return null;
  if (sweep.ran && sweep.result?.ok) {
    const c = sweep.result.credits;
    return `  sweep: enriched ${sweep.domain} — ${sweep.result.calls_made} API call(s), `
      + `~${c} credit(s). Written to gtm/enrichment-cache/${sweep.endpoint}.jsonl.`;
  }
  if (sweep.ran && sweep.result && !sweep.result.ok) {
    // Law 4: do NOT claim the failure was free. A request that left the machine and
    // came back as a network error may well have been billed, and `_lib/run.mjs`
    // records exactly that as an unverifiable estimate. Quoting the ledger here keeps
    // setup's summary and the receipt telling the same story.
    const c = sweep.credits ?? 0;
    const cost = c === 0
      ? 'nothing was charged'
      : `~${c} credit(s) may have been charged and could not be verified — see the ledger`;
    return `  sweep: FAILED (${sweep.result.code}) — ${sweep.result.message}\n`
      + `         Setup is unaffected: the tree is complete and ${cost}.`;
  }
  return `  sweep: not run — ${sweep.reason}. 0 API calls made, 0 credits spent.`;
}

// ---------------------------------------------------------------------------
// The whole offer, start to finish
// ---------------------------------------------------------------------------

/**
 * Offer the sweep, and run it only if the user opted in AND typed the domain back.
 *
 * Every argument that touches the outside world is injectable (`ask`, `say`, `api`,
 * `catalog`, `gates`, `runCall`, `env`), which is what lets the zero-call promise be
 * PROVEN rather than asserted: a test passes a client that throws on any property
 * access and the decline paths still complete.
 *
 * This function does not throw. Ever. Its contract is that `setup` can call it and
 * carry on regardless of the answer.
 */
export async function offerSweep ({
  root = process.cwd(),
  dir = 'gtm',
  check = false,
  enabled = false,
  explicitDomain = null,
  confirmDomain = null,
  env = process.env,
  api = null,
  catalog = null,
  gates = null,
  ask = null,
  say = () => {},
  runCall = null,
  loadCatalog = null,
  loadGates = null,
  ttlDays = null,
  now = () => new Date(),
} = {}) {
  const declined = (reason, extra = {}) =>
    ({ offered: false, ran: false, reason, domain: null, endpoint: SWEEP_ENDPOINT,
       credits_quoted: 0, calls_made: 0, credits: 0, ...extra });

  if (check) return declined('--check mode writes nothing and calls nothing');
  if (!enabled) {
    return declined('not requested — the sweep is opt-in (run `./setup --sweep`, '
      + 'or answer the prompt on an interactive terminal)');
  }

  try {
    if (!api && !env.richapi_API_KEY) {
      return declined('richapi_API_KEY is not set, so there is nothing to call with');
    }

    const cat = catalog ?? (loadCatalog ? loadCatalog() : (await import('./enrich.mjs')).loadCatalog());
    const gts = gates ?? (loadGates ? loadGates() : (await import('./gates.mjs')).loadGates());

    const price = priceSweep({ catalog: cat, gates: gts });
    if (!price.available) return declined(price.reason, { credits_quoted: price.credits ?? 0 });

    // enrich_company answers a LinkedIn company and nothing else, so that is what the
    // sweep asks for. Setup can INFER a domain (package.json, the git remote, your git
    // e-mail) and a domain is exactly what this endpoint 404s on, so inference cannot
    // feed it: the company is named on the flag or the sweep does not run.
    const company = sweepCompany(explicitDomain);
    if (!company) {
      const inferred = resolveOwnDomain({ root, env, explicit: null });
      const yours = inferred.domain ? ` Yours looks like "${inferred.domain}" — find it on ` : ' Find it on ';
      return declined(
        (explicitDomain
          ? `"${explicitDomain}" is not a LinkedIn company. `
          : 'the sweep needs your LinkedIn company, which setup cannot infer from a git '
            + 'repository. ')
        + 'enrich_company takes a company URL or its universalName slug — a bare domain '
        + 'answers 404 (measured 2026-09-18).' + yours
        + 'LinkedIn and re-run: `./setup --sweep --sweep-domain '
        + 'https://www.linkedin.com/company/<you>`. Your gtm/ tree is complete either '
        + 'way, and setup spent nothing',
        { credits_quoted: price.credits, tried: inferred.tried });
    }

    const domain = company.url;
    const source = 'flag';
    say(renderSweepOffer({ domain, source, price, ttlDays, company }));

    let answer;
    if (confirmDomain !== null && confirmDomain !== undefined) {
      answer = String(confirmDomain);
      say(`  --confirm-domain ${answer}`);
    } else if (typeof ask === 'function') {
      answer = await ask(sweepQuestion(domain, company));
    } else {
      return {
        offered: true, ran: false, domain, source, endpoint: price.endpoint,
        credits_quoted: price.credits, calls_made: 0, credits: 0,
        reason: 'no interactive terminal to confirm the company on. Re-run with '
          + `\`./setup --sweep --confirm-domain ${company.slug}\` once you have checked it`,
      };
    }

    const ck = checkCompanyConfirmation(answer, company);
    if (!ck.ok) {
      return {
        offered: true, ran: false, domain, source, endpoint: price.endpoint,
        credits_quoted: price.credits, calls_made: 0, credits: 0,
        declined_code: ck.code, reason: ck.reason,
      };
    }

    const result = await runSweep({ domain, price, root, dir, api, catalog: cat, gates: gts, runCall, now });
    return {
      offered: true, ran: true, domain, source, endpoint: price.endpoint,
      credits_quoted: price.credits, calls_made: result.calls_made ?? 0,
      // Law 4: the ledger's number, not the quote. A failed call that was still
      // billed must not be reported as free, and a free failure must not be reported
      // as the quoted price.
      credits: Number.isFinite(result.credits) ? result.credits : 0,
      reason: result.ok ? null : result.message, result,
    };
  } catch (err) {
    // Resolution, catalog load, gate load, prompt — anything at all. Setup carries on.
    return declined(`the sweep could not be prepared (${err && err.message ? err.message : err})`,
      { error_code: err?.code ?? 'sweep_setup_failed' });
  }
}

export default {
  SWEEP_ENDPOINT, GATE_KEYS, normalizeDomain, spellDomain, resolveOwnDomain,
  sourceProse, priceSweep, renderSweepOffer, sweepQuestion, checkDomainConfirmation,
  runSweep, renderSweepOutcome, offerSweep,
};
