// _lib/sender-export.mjs — gates with teeth.
//
// The problem this exists to solve, stated plainly: sending is EXTERNAL. A user can
// paste a CSV into Instantly and bypass /comply, /campaign-review and /launch
// entirely. A dashboard that only advises is one copy-paste from irrelevant.
//
// A release tool that owns the push is trustworthy because the irreversible act is
// INSIDE the tool. The equivalent here is the sender export file. So:
//
//   /launch is the ONLY skill that may write a sender-format export,
//   it writes only after reading a PASS verdict BOUND TO THE LIST'S CONTENT HASH,
//   and it embeds that hash in the file so a stale or hand-edited export is detectable.
//
// Edit the list after review and the review goes stale, exactly like a code review
// bound to a commit. The export then refuses to be written, and any export already on disk can
// be shown to no longer match the list it claims to come from.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { writeOutputList, loadSuppressionStore } from './suppression.mjs';

export class SenderExportRefused extends Error {
  constructor (msg, detail = {}) { super(msg); this.name = 'SenderExportRefused'; Object.assign(this, detail); }
}

/** The marker that identifies a file as a gated sender export. */
export const HEADER_PREFIX = '#gtm-launch';

/**
 * Featured senders first: Smartlead and Instantly. The others are supported but
 * unfeatured, which is a docs and golden-file question, not a code one — one exporter,
 * different headers.
 */
export const SENDER_FORMATS = Object.freeze({
  smartlead: { featured: true, columns: ['email', 'first_name', 'last_name', 'company_name', 'website', 'linkedin_url', 'custom_1'] },
  instantly: { featured: true, columns: ['email', 'first_name', 'last_name', 'company_name', 'website', 'personalization'] },
  apollo: { featured: false, columns: ['email', 'first_name', 'last_name', 'company_name', 'linkedin_url'] },
  outreach: { featured: false, columns: ['email', 'first_name', 'last_name', 'company_name', 'linkedin_url'] },
  lemlist: { featured: false, columns: ['email', 'firstName', 'lastName', 'companyName', 'linkedinUrl'] },
  csv: { featured: false, columns: null }, // whatever the rows carry
});

export function isSenderPlatform (name) {
  return Object.prototype.hasOwnProperty.call(SENDER_FORMATS, String(name));
}

/**
 * The content hash a review binds to. Canonical over the rows' VALUES, so reordering
 * columns is not a change but editing, adding or removing a contact is.
 */
export function listContentHash (rows) {
  const canon = (rows ?? []).map(r => {
    const o = {};
    for (const k of Object.keys(r ?? {}).sort()) {
      const v = r[k];
      if (v === null || v === undefined || String(v).trim() === '') continue;
      o[k] = String(v).trim();
    }
    return o;
  });
  canon.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Read a verdict written by /comply or /campaign-review. */
export function readVerdict (file) {
  if (!fs.existsSync(file)) {
    throw new SenderExportRefused(`no review verdict at ${file} — a launch without a review is not a launch`);
  }
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new SenderExportRefused(`verdict at ${file} is not readable JSON: ${e.message}`); }
  return v;
}

/**
 * Is this verdict good for these exact rows, on this channel?
 *
 * FAILS CLOSED on every ambiguity: a missing status, an unknown status, a missing
 * hash, a hash that does not match, or a clearance for a different channel.
 *
 * THE CHANNEL. A /comply verdict clears a list *and a channel* — a phone list can
 * clear for `phone` while `email` stays blocked on a missing postal address. A sender
 * export is an email artifact, so /launch asks for `email` and a phone clearance
 * cannot produce one. A verdict that names no channels at all is read as `['email']`:
 * that is what every verdict written before the channel dimension existed meant, and
 * it is the narrowest reading of one, not the widest.
 */
export function verdictCovers (verdict, rows, { channel = 'email' } = {}) {
  const hash = listContentHash(rows);
  if (!verdict || typeof verdict !== 'object') return { ok: false, reason: 'verdict is not an object', hash };
  if (verdict.status !== 'PASS') {
    return { ok: false, reason: `verdict status is ${JSON.stringify(verdict.status ?? null)}, not PASS`, hash };
  }
  if (typeof verdict.list_hash !== 'string' || verdict.list_hash.length === 0) {
    return { ok: false, reason: 'verdict carries no list_hash, so it cannot be bound to a list', hash };
  }
  if (verdict.list_hash !== hash) {
    return {
      ok: false, hash,
      reason: `verdict is STALE: it reviewed list ${verdict.list_hash.slice(0, 12)} but this list is ${hash.slice(0, 12)}. `
        + 'The list changed after review. Re-run /campaign-review.',
    };
  }
  const cleared = Array.isArray(verdict.channels) && verdict.channels.length
    ? verdict.channels.map((c) => String(c).trim().toLowerCase())
    : ['email'];
  if (!cleared.includes(String(channel).trim().toLowerCase())) {
    return {
      ok: false, hash, channel, channels: cleared,
      reason: `verdict clears ${cleared.join(', ')}, not ${channel}. A clearance is per channel: `
        + `the preconditions for ${channel} were never in play when this list was screened. `
        + `Re-run /comply with CHANNEL=${channel} over this exact list.`,
    };
  }
  return { ok: true, hash, channel, channels: cleared };
}

/**
 * Write a sender export. The ONLY function in the pack that may do so.
 *
 * `actor` must be 'launch'. That is not security — anything in-process could call this
 * — it is a seam the validator and the tests can enforce, which is what makes "only
 * /launch writes the export" a checkable claim rather than a promise in prose.
 */
export function writeSenderExport ({
  file, rows, platform = 'csv', verdictPath = null, verdict = null,
  root = process.cwd(), store = null, actor = null, now = () => new Date(),
  maxAgeHours = null,
}) {
  if (actor !== 'launch') {
    throw new SenderExportRefused(
      `only /launch may write a sender export (actor was ${JSON.stringify(actor)}). `
      + 'Sending is external, so this file is the last thing the pack controls.',
      { actor });
  }
  if (!isSenderPlatform(platform)) {
    throw new SenderExportRefused(`unknown sender platform "${platform}"`);
  }

  const v = verdict ?? readVerdict(verdictPath);
  const cover = verdictCovers(v, rows);
  if (!cover.ok) throw new SenderExportRefused(`refusing to write the export: ${cover.reason}`, { hash: cover.hash });

  // Age, checked INSIDE the seam.
  //
  // verdictCovers() binds content and nothing else, so before this the three
  // content refusals (no verdict / not PASS / hash mismatch) held against any
  // in-process caller while the fourth — a verdict that has simply gone stale on
  // the clock — was enforced only by /launch's own pre-check. A caller that got
  // past the actor seam could therefore write an arbitrarily old verdict's
  // export. All four refusals now live in the same place.
  //
  // The clock is the caller's, never the document's: a verdict does not get to
  // set the terms of its own expiry, so `expires_at` in the verdict body is
  // deliberately not read. `maxAgeHours` comes from
  // gates.yaml:skills.campaign_review.verdict_max_age_hours.
  //
  // Defaults to null so every existing caller keeps its current behaviour; an
  // unparseable or absent issued_at counts as expired, not as ageless (law 5).
  if (maxAgeHours !== null) {
    // typeof-string first, deliberately: Date.parse coerces its argument, so a
    // numeric issued_at of 12345 parses as the year 12345 and a stale verdict
    // reads as one issued in the far future. Caught by the test below.
    const issued = typeof v.issued_at === 'string' ? Date.parse(v.issued_at) : NaN;
    if (!Number.isFinite(issued)) {
      throw new SenderExportRefused(
        'refusing to write the export: verdict has no parseable issued_at, so its age '
        + 'cannot be established. An unknown age is treated as expired.', { hash: cover.hash });
    }
    const ageHours = (now().getTime() - issued) / 3_600_000;
    if (ageHours > maxAgeHours) {
      throw new SenderExportRefused(
        `refusing to write the export: verdict is STALE by age — issued ${ageHours.toFixed(1)}h ago, `
        + `limit is ${maxAgeHours}h. Suppression and verification state move underneath a verdict `
        + 'even when the list does not. Re-run /campaign-review.', { hash: cover.hash, ageHours });
    }
  }

  // Final suppression re-check AT SEND TIME. Staleness matters: someone may have
  // unsubscribed between the review and the launch.
  const s = store ?? loadSuppressionStore({ root });
  const columns = SENDER_FORMATS[platform].columns;
  const res = writeOutputList(file, rows, { root, store: s, columns: columns ?? undefined });

  // Prepend the binding header so a stale or hand-edited export is detectable later.
  const header = `${HEADER_PREFIX} platform=${platform} list_hash=${cover.hash} `
    + `verdict=${v.verdict_id ?? v.play ?? 'unknown'} written_at=${now().toISOString()} rows=${res.written}\n`;
  fs.writeFileSync(file, header + fs.readFileSync(file, 'utf8'), 'utf8');

  return { ...res, platform, list_hash: cover.hash, header: header.trim() };
}

/** Parse the binding header off an export, or null if it has none. */
export function readExportHeader (file) {
  if (!fs.existsSync(file)) return null;
  const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
  if (!first.startsWith(HEADER_PREFIX)) return null;
  const out = {};
  for (const m of first.slice(HEADER_PREFIX.length).trim().matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Does an export on disk still match the list it claims to come from?
 *
 * This is what makes the gate observable after the fact. An export with no header was
 * not written by /launch, which is itself the finding.
 */
export function verifySenderExport (file, rows) {
  const header = readExportHeader(file);
  if (!header) {
    return { ok: false, reason: 'no launch header — this file was not written by /launch' };
  }
  const hash = listContentHash(rows);
  if (header.list_hash !== hash) {
    return {
      ok: false, expected: header.list_hash, actual: hash,
      reason: 'export does not match the list it claims: it was hand-edited, or the list changed after launch',
    };
  }
  return { ok: true, ...header };
}
