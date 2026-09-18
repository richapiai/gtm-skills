// _lib/linkedin-urn.mjs — a LinkedIn post URL, turned into the URN the post endpoints take.
//
// `post_details` and `post_activities` require `urn` matching
// ^urn:li:(activity|ugcPost):[0-9]+$ (spec/openapi.yaml). People paste URLs, not URNs,
// and no endpoint converts one into the other, so the conversion is local and free.
//
//   /feed/update/urn:li:activity:123/        ─┐
//   /feed/update/urn%3Ali%3AugcPost%3A123     ├─▶ urn:li:activity:123 | urn:li:ugcPost:123
//   /posts/jane_some-slug-activity-123-AbCd   │
//   urn:li:activity:123 (already a URN)      ─┘
//   anything else (share URNs, profiles, company pages, Sales Nav) ─▶ refused, zero calls
//
// Fail closed (law 5): a string this cannot read unambiguously is refused with a reason,
// never guessed into a URN that would buy the wrong post's engagers.

const URN_RE = /^urn:li:(activity|ugcPost):([0-9]+)$/;
const EMBEDDED_URN_RE = /urn:li:(activity|ugcPost|share):([0-9]+)/g;
const SLUG_RE = /-(activity|ugcPost)-([0-9]+)(?:-|\/|$)/g;

/** Endpoints whose `urn` may be supplied as `post_url`. */
export const POST_URN_ENDPOINTS = Object.freeze(['post_details', 'post_activities']);

/**
 * @param {string} input a post URL or a post URN
 * @returns {{ ok: true, urn: string } | { ok: false, reason: string }}
 */
export function postUrnFrom (input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'no post URL given' };
  }
  const raw = input.trim();
  if (URN_RE.test(raw)) return { ok: true, urn: raw };

  let url;
  try { url = new URL(raw); } catch {
    return { ok: false, reason: `"${raw}" is neither a post URN nor a URL` };
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    return { ok: false, reason: `"${host}" is not a LinkedIn host` };
  }

  let path;
  try { path = decodeURIComponent(url.pathname); } catch {
    return { ok: false, reason: 'the URL path is not valid percent-encoding' };
  }

  const found = new Set();
  let share = false;
  for (const m of path.matchAll(EMBEDDED_URN_RE)) {
    if (m[1] === 'share') share = true;
    else found.add(`urn:li:${m[1]}:${m[2]}`);
  }
  if (path.startsWith('/posts/')) {
    for (const m of path.matchAll(SLUG_RE)) found.add(`urn:li:${m[1]}:${m[2]}`);
  }

  if (found.size === 1) return { ok: true, urn: [...found][0] };
  if (found.size > 1) {
    return { ok: false, reason: `the URL names more than one post (${[...found].join(', ')}); paste one` };
  }
  if (share) {
    return { ok: false, reason: 'share URNs are not accepted by the post endpoints; open the post and copy its activity URL' };
  }
  return { ok: false, reason: 'no post id in this URL — paste the URL of the post itself (…/feed/update/urn:li:activity:… or …/posts/…-activity-…)' };
}
