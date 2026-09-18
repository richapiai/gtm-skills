// tests/contracts/gate-values.test.mjs
//
// The numbers themselves, pinned to their shipped values.
//
// WHY THIS FILE EXISTS. A mutation red-team ran 62 one-line mutations against
// this pack. It caught 20 of 20 aimed at `_lib/` runtime logic — the mechanisms
// are genuinely well tested. Eleven of its twelve survivors were NUMBERS IN
// gates.yaml, changed one line at a time, every one of them silent:
//
//   unbounded_endpoints.hard_page_ceiling              20    -> 25
//   skills.launch.max_export_rows                      50000 -> 90000
//   quality_stops.max_waterfall_reruns                 2     -> 3
//   quality_stops.verification_max_fail_rate_pct       25    -> 30
//
// The cause is self-comparison. tests/skills/launch/launch-gate.test.mjs:25:
//
//     const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');
//
// The expected value is read from the config under test. Change 168 to 100000
// and both sides of the assertion move together: eleven years of staleness, and
// the suite stays green. That pattern is correct for testing a MECHANISM — the
// gate should behave the same at any threshold — and it is the whole hole when
// the threshold is itself the control. Something has to hold the literal.
//
// WHAT IS PINNED, AND WHAT IS NOT. A gate is pinned here when changing its value
// alone, with no code change, can:
//
//   (a) increase what a run costs,
//   (b) widen what is retained, exported, or erased, or
//   (c) remove a stop that guards an irreversible or an unverifiable action.
//
// Everything else is left alone on purpose, because a pin costs something: it
// makes a deliberate tuning change fail CI, and a file that fails for tuning
// gets edited without being read. So presentation caps (`max_digest_rows` — how
// many rows a digest prints), quality bands (`skills.evidence_score.band_*` —
// what a score is called), and staleness windows that only change what a skill
// SAYS (`brief_max_age_days`, `retro_max_window_days`, `play_max_age_days`) are
// not pinned. `skills.campaign_review.verdict_max_age_hours` IS pinned despite
// being a staleness window, because /launch refuses to write the sender export
// against a verdict older than it: that one gates an artifact leaving the pack.
//
// EVERY PIN CARRIES ITS REASON. Not "this was 20" but what 20 buys. The next
// person to change a number should learn from this file what they are turning
// off, and should change the pin in the same commit as the gate. A pin is not a
// freeze; it is a receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGates, gateValue, gateKeys } from '../../_lib/gates.mjs';
import * as GATES_MOD from '../../_lib/gates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dirname, '..', '..');
const GATES = loadGates();

/**
 * The pinned set. [key, shipped value, what the value protects].
 * A change here must be deliberate, and must arrive with the gates.yaml change.
 */
const PINNED = [
  // --- the session spend gate ----------------------------------------------
  // These four fractions ARE the pack's only spend control. Raise `stop` past 1
  // and there is no hard stop; raise `single_call_confirm` and the one huge
  // unbounded search on call #1 stops asking.
  ['session_budget.fractions.notify', 0.50,
    'the informational crossing. Above 0.5 the user first hears about spend past halfway.'],
  ['session_budget.fractions.confirm', 0.80,
    'the last crossing that still leaves budget to change course. Raising it confirms too late to matter.'],
  ['session_budget.fractions.stop', 1.00,
    'the hard stop. Anything above 1.0 means a session can spend past the budget the user set.'],
  ['session_budget.fractions.single_call_confirm', 0.25,
    'the one-call gate that fires however low cumulative spend is. This is what catches the '
    + 'single unbounded search on the first call of a session.'],
  ['session_budget.on_stop', 'raise_or_abort',
    'the only way past the stop is the user naming a new budget. Never an implicit rollover.'],
  ['session_budget.ask_once_per_session', true,
    'the budget is asked, not defaulted. false would make suggestion_credits an applied default.'],
  ['session_budget.suggestion_credits', 25,
    'mirrors the free grant (confirmed with the API owner 2026-08-31; this file asserted 500 until '
    + 'then, inviting a first-time user to spend 20x a grant they did not have). The trial run that '
    + 'decides whether anyone pays is the one budgeted.'],
  ['session_budget.min_credits', 1,
    'floor on an accepted budget. Zero would let a session claim a budget was set while every '
    + 'fraction of it is zero, which reads as "no gate" rather than as a stop.'],
  ['session_budget.max_credits', 100000,
    'ceiling on an accepted budget. A typo of one extra zero should be refused, not honoured.'],

  // --- the page gate --------------------------------------------------------
  ['unbounded_endpoints.policy', 'page_gate',
    'the 12 per-result endpoints with no bounding request field are gated by a human between pages. '
    + 'Any other policy removes the only real ceiling they have.'],
  ['unbounded_endpoints.pages_before_confirm', 1,
    'page 1 runs, every page after it asks. Raising this buys pages nobody approved.'],
  ['unbounded_endpoints.hard_page_ceiling', 20,
    'STOP beyond this even with confirms. A red-team mutation moved it to 25 and nothing went red: '
    + 'on lead_search at 10cr + 0.5/result, five extra pages is real money.'],
  ['unbounded_endpoints.assumed_results_per_page', 25,
    'the estimate basis when the caller gives no hint. Lowering it makes every dry-run under-quote.'],

  // --- request-body page multipliers ---------------------------------------
  ['request_page_multipliers.policy', 'clamp',
    'these endpoints multiply pages from INSIDE the request body, so the page gate counts one '
    + 'request. Clamping the field is the only control that binds.'],
  ['request_page_multipliers.endpoints.directory_yellowpages.clamp', 1,
    'one page per request, which restores the per-page human gate the field routes around.'],
  ['request_page_multipliers.endpoints.google_search_scraper_sync.clamp', 1,
    '`limit` means "max results" on all five sibling scrapers and "max PAGES" here alone, charged '
    + 'per result, with no billing field in the response. A user who sets 100 buys ~10x what they '
    + 'think and the receipt cannot correct them.'],

  // --- quality stops --------------------------------------------------------
  ['quality_stops.coverage_min_pct', 70,
    'below this the list is not worth enriching further. Lowering it spends the waterfall on a bad list.'],
  ['quality_stops.verification_max_fail_rate_pct', 25,
    'past this the source list is the problem, not the verifier. A mutation to 30 survived: the '
    + 'difference is a whole budget spent proving a list is bad.'],
  ['quality_stops.verification_max_hard_bounce_pct', 5,
    'hard bounces are sender-reputation damage, not just wasted credits.'],
  ['quality_stops.max_waterfall_reruns', 2,
    'a re-run recharges EVERY tier. A mutation to 3 survived, and 3 is 50% more spend on the same contacts.'],

  // --- platform audience floors --------------------------------------------
  // Under the floor the platform rejects the upload AFTER the credits are spent.
  ['audience_minimums.linkedin', 300, 'LinkedIn rejects a smaller audience after the fill is paid for.'],
  ['audience_minimums.meta', 1000, 'Meta rejects a smaller audience after the fill is paid for.'],
  ['audience_minimums.google', 1000, 'Google rejects a smaller audience after the fill is paid for.'],

  // --- watchlist: the recurring bill ---------------------------------------
  ['watchlist.max_entities', 250, 'every refresh recosts the whole watchlist, forever.'],
  ['watchlist.max_entities_hard_stop', 1000, 'the ceiling no confirmation gets past.'],
  ['watchlist.max_refresh_batch', 50, 'bounds one refresh cycle independently of list size.'],
  ['watchlist.min_refresh_interval_hours', 24,
    'the cadence floor. A misfiring trigger at a shorter interval spends the envelope overnight.'],

  // --- runtime switches -----------------------------------------------------
  ['runtime.batch.auto', false,
    'the live bulk endpoint answers out of request order; results are joined by entityUrn, and the '
    + 'switch stays off until a real batched run through the runtime has been checked end to end.'],

  // --- the setup sweep ------------------------------------------------------
  ['setup_sweep.max_credits', 5,
    'a ceiling on the QUOTE, not the spend. A paid prompt during ./setup only earns its place '
    + 'while it is trivially cheap; past this the sweep withdraws the offer instead of showing a bigger number.'],
  ['setup_sweep.timeout_ms', 20000,
    'a wall-clock bound, so a hung API cannot make ./setup hang. A failed bonus must never block installation.'],

  // --- cache TTLs: spend AND retention --------------------------------------
  // A cache hit is the cheapest credit saved, and the same block is what
  // _lib/pii.mjs sweeps on, so these numbers are a retention policy too.
  ['cache_ttl.classes.unknown', '1d',
    'the fail-closed floor for anything unmatched. Widening it widens every endpoint nobody classified.'],
  ['cache_ttl.classes.email_verification', '7d', 'a verification result older than a week is a guess.'],
  ['cache_ttl.classes.posts_activity', '1d', 'activity is the fastest-moving fact in the pack.'],
  ['cache_ttl.classes.firmographics', '90d', 'the longest TTL in the pack, and therefore the longest PII retention.'],
  ['cache_ttl.classes.funding_tech', '30d', 'funding and stack move on a monthly cadence.'],
  ['cache_ttl.classes.people_lists', '7d', 'a people list is stale the moment somebody changes job.'],
  ['cache_ttl.classes.directories', '30d', 'directory listings move slowly; the charge for re-walking them does not.'],
  ['cache_ttl.endpoints.ai_enrich', '0d',
    'non-deterministic output is NEVER served from cache. A previous reshape lost this line once already.'],

  // --- /launch: the last artifact the pack controls -------------------------
  ['skills.launch.require_pass_verdict', true,
    'the sender export is written only against a PASS verdict bound to the list content hash.'],
  ['skills.launch.max_export_rows', 50000,
    'a mutation to 90000 survived. This is the size of the file that leaves the pack and gets sent to people.'],
  ['skills.campaign_review.verdict_max_age_hours', 168,
    'past a week a verdict is stale even when the content hash still matches, because suppression state '
    + 'and verification results move underneath it. This is the number the self-comparison hole was found on: '
    + '168 -> 100000 is eleven years and nothing went red.'],

  // --- /comply: irreversible ------------------------------------------------
  ['skills.comply.erase_requires_explicit_confirm', true,
    'erasure is never implicit and never silently batched.'],
  ['skills.comply.erase_confirm_fraction', 0.10,
    'blast radius. A sweep that would purge more than a tenth of stored rows asks first, so a typo\'d '
    + 'domain cannot empty the cache in one go.'],

  // --- structural clamps on the endpoint that bills per page ----------------
  ['skills.tam_map.directory_max_pages_per_request', 1,
    'directory_yellowpages takes max_pages IN THE REQUEST BODY, so one request scrapes N pages while the '
    + 'runtime page gate counts one. This is a structural clamp, not a tuning knob.'],
  ['skills.play_design.trigger_probe_max_pages', 1,
    'sizing a trigger reads page one and stops. Sizing is not buying.'],

  // --- local_business_prospecting: the highest bill-surprise page in the pack -
  // Added 2026-08-31. Every endpoint this skill touches bills per result and NONE
  // reports its charge, so an overrun is invisible in the receipt as well as in the
  // plan. The skill previously deferred all three ceilings to a namespace nobody had
  // written, which left them enforced by prose only.
  ['skills.local_business_prospecting.directory_max_pages_per_request', 1,
    'the same structural clamp as tam_map on the same endpoint, scoped to this skill. '
    + 'A clamp scoped to another skill does not bind this page.'],
  ['skills.local_business_prospecting.max_reviews_per_place', 25,
    'reviews are charged per result against a count the response does not carry. An '
    + 'earlier version of this skill reviewed every place, which is the most expensive '
    + 'mistake available here.'],
  ['skills.local_business_prospecting.max_places_per_run', 20,
    'the bill is the PRODUCT of this and max_reviews_per_place, so both are pinned and '
    + 'the plan shows the product rather than either factor.'],

  // --- profile_activities: the charge that cannot be verified ---------------
  // Charged per result on a count field ABSENT from the response, page-gated,
  // with no request field bounding the total. One call can empty a budget and
  // leave nothing in the receipt to prove it.
  ['skills.account_research.profile_activities_max_profiles', 1,
    'one profile per run, chosen rather than swept. The charge can never be reconciled afterwards.'],
  ['skills.competitive_intel.profile_activities_max_profiles', 1,
    'same endpoint, same unverifiable charge, across a SET of companies.'],
  ['skills.call_intel.max_enrich_profile_calls_per_run', 1,
    'attendee resolution is chosen, never swept across everyone named on a call.'],

  // --- cross-endpoint page ceilings -----------------------------------------
  // hard_page_ceiling is PER ENDPOINT. Without these, one run walks several
  // unbounded endpoints to that ceiling and multiplies the bill with no single
  // gate firing. Each is the only thing standing between a run and that multiple.
  ['skills.build_prospect_list.max_pages_per_run', 10, 'pages across ALL searches in one list build.'],
  ['skills.tam_map.max_pages_per_run', 10, 'pages across ALL searches in one map.'],
  ['skills.account_research.max_pages_per_run', 6, 'one account can touch six page-gated endpoints.'],
  ['skills.competitive_intel.max_pages_per_run', 6, 'pages across all four page-gated tiers in one sweep.'],
  ['skills.signal_watch.max_pages_per_run', 6, 'pages in ONE cycle of a recurring skill.'],
  ['skills.org_map.max_pages_per_run', 4,
    'pages across one org map. The tightest of the cross-endpoint ceilings, because an org map '
    + 'walks people_search and the employee search together.'],
  ['skills.tam_map.max_count_probes', 12,
    'page-one probes bought purely to read a total-count field. Bounds the cross-tab: 4 industries x 3 sizes x 3 regions is 36.'],

  // --- fan-out and sweep width ----------------------------------------------
  ['skills.research_agent.max_rows_per_run', 500,
    'a freeform question that sounds like one call is rows x fan-out.'],
  ['skills.research_agent.max_endpoints_per_row', 4,
    'fan-out WIDTH. Four hops over a thousand rows is four thousand calls, and no other gate can see that shape.'],
  ['skills.research_agent.pilot_rows', 20,
    'test the hypothesis on a slice, then re-price the remainder from what the slice measured.'],
  ['skills.research_agent.ai_enrich_requires_web_grounding', true,
    'without provider=perplexity and web search, the paid hop is the local model at a per-call price.'],
  ['skills.competitive_intel.max_competitors_per_sweep', 5,
    'the multiplier on every other line of a sweep — this is the only skill that runs against a SET.'],
  ['skills.competitive_intel.ad_details_max_per_competitor', 3, 'flat per-ad detail fetches after a search.'],
  ['skills.signal_watch.max_job_details_per_cycle', 3,
    'flat per call is cheap once and expensive every cycle forever — the whole hazard of a recurring skill.'],
  ['skills.org_map.committee_max_profiles', 25,
    'the bulk profile hop is charged on _list_count, which is absent from the response.'],
  ['skills.icp_review.max_sample_accounts', 50,
    'the only mandatory paid step in /icp-review. Without it the bound is money, not scope.'],
  ['skills.ads_audience.max_fill_rows', 2000,
    'email_finder is flat per call, so this is the only bound on the paid fill that is not the session budget.'],
  ['skills.ads_audience.pre_match_headroom_multiple', 1.5,
    'platforms match a fraction of what you send, so uploading AT the floor fails. Below this multiple '
    + 'the fill is not offered, because the user would be paying to be rejected.'],
  ['skills.list_hygiene.max_rows_per_run', 10000,
    'domain liveness is unpaid but not free: a 5k-row list at a 10s timeout is a 14-hour run.'],

  // --- the paid-drafting floors (local inference by default) ---------------------------------------
  // Below these the surrounding agent drafts at no marginal cost. Lowering one
  // turns free work into 2 credits a row — a billing error, not a capability.
  ['skills.personalize.ai_enrich_batch_min_rows', 200, 'below this, drafting locally is free and ai_enrich is a billing error.'],
  ['skills.reply_triage.ai_enrich_batch_min_rows', 200,
    'the same floor, on replies. Below it the classification is free in this agent\'s context, so '
    + 'paying per row to read short emails is a billing error.'],
  ['skills.org_map.ai_enrich_batch_min_rows', 200,
    'the same floor, on org inference. Reporting-line guesses are drafted locally at no marginal '
    + 'cost until the row count makes a batch call cheaper than the latency.'],
  ['skills.call_intel.ai_enrich_batch_min_transcripts', 200,
    'the same floor, on transcripts. A handful of calls is read for free by the surrounding model; '
    + 'the paid hop only earns its place at batch scale.'],

  // --- unattended spend -----------------------------------------------------
  // A schedule spends while nobody is watching, so each of these bounds a
  // different axis of the same runaway.
  ['skills.scheduled_workflow.approval_max_age_days', 30,
    '16 of 53 endpoints repriced in four months. An old approval approves a world that no longer exists.'],
  ['skills.scheduled_workflow.max_runs_per_approval', 26,
    'bounds one approval. Without it, "1,000,000 runs" is a legal envelope. 26 is two quarters of weekly fires.'],
  ['skills.scheduled_workflow.min_interval_hours', 6,
    'the cadence floor. A misfiring trigger spends the whole envelope before anyone is awake.'],
  ['skills.scheduled_workflow.max_envelope_credits', 20000,
    'total across ALL runs of one approval. session_budget.max_credits bounds a single run, which is '
    + 'not the thing that runs away here.'],

  // --- compliance asymmetries ------------------------------------------------
  ['skills.reply_triage.ambiguous_is_unsubscribe', true,
    'the cost of wrongly suppressing is one lost lead; the cost of wrongly not suppressing is a complaint. '
    + 'Held as policy so it cannot be softened into a heuristic.'],
  ['skills.reply_triage.domain_suppression_requires_explicit_authority', true,
    'the opposite asymmetry, deliberately: a domain entry removes a whole account, so ambiguity about '
    + 'SCOPE narrows rather than widens.'],
  ['skills.reply_triage.max_replies_per_run', 1000, 'one batch\'s ceiling on the paid path.'],
];

test('every spend-or-safety gate still carries its shipped value', () => {
  const drift = [];
  for (const [key, expected, why] of PINNED) {
    let actual;
    try { actual = gateValue(GATES, key); } catch (e) { drift.push(`${key} — ${e.message}`); continue; }
    if (actual !== expected) {
      drift.push(`${key}: ${JSON.stringify(actual)} (pinned ${JSON.stringify(expected)})\n      ${why}`);
    }
  }
  assert.deepEqual(drift, [],
    'a spend-or-safety gate moved. This is not automatically wrong — but it is never incidental,\n'
    + 'and a test that reads the expected value out of the file under test cannot tell you it\n'
    + 'happened. If the change is intended, change the pin in the same commit and say why:\n\n  - '
    + drift.join('\n  - ') + '\n');
});

test('the pinned set is well formed and has no duplicates', () => {
  const seen = new Set();
  const bad = [];
  for (const [key, expected, why] of PINNED) {
    if (seen.has(key)) bad.push(`${key} is pinned twice`);
    seen.add(key);
    if (expected === undefined || expected === null) bad.push(`${key} has no pinned value`);
    if (!why || why.length < 30) bad.push(`${key} has no real reason — a pin without one teaches nobody anything`);
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('a pinned key that leaves gates.yaml fails here, not silently', () => {
  // Deleting a key is a STOP under law 5, which is loud at runtime and silent in
  // review. Renaming one is silent in both. Either way it must land here.
  const declared = new Set(gateKeys(GATES));
  const gone = PINNED.map(p => p[0]).filter(k => !declared.has(k));
  assert.deepEqual(gone, [],
    'these keys are pinned but no longer declared in gates.yaml. A rename is a silent STOP for '
    + 'every skill still citing the old name (gates.yaml rule 3: keys are add-only):\n  ' + gone.join('\n  '));
});

test('the pins are literals, not reads of the file under test', () => {
  // The failure mode this whole file answers. If a future edit "simplifies" a pin
  // into gateValue(GATES, key), that row silently stops testing anything.
  const self = readFileSync(join(__dirname, 'gate-values.test.mjs'), 'utf8');
  const table = self.slice(self.indexOf('const PINNED = ['), self.indexOf('\n];\n', self.indexOf('const PINNED = [')));
  assert.ok(!/gateValue\s*\(/.test(table),
    'a row in PINNED reads its expected value from gates.yaml. That is the self-comparison hole: '
    + 'both sides move together and the mutation survives.');
  assert.ok(PINNED.length >= 60, `the pinned set shrank to ${PINNED.length} — was a row deleted to get green?`);
});

test('the four red-team survivors are covered', () => {
  // The specific mutations that survived. Named so that deleting their rows is a
  // visible act rather than a quiet one.
  const survivors = [
    'unbounded_endpoints.hard_page_ceiling',
    'skills.launch.max_export_rows',
    'quality_stops.max_waterfall_reruns',
    'quality_stops.verification_max_fail_rate_pct',
    'skills.campaign_review.verdict_max_age_hours',
  ];
  const pinned = new Set(PINNED.map(p => p[0]));
  const missing = survivors.filter(k => !pinned.has(k));
  assert.deepEqual(missing, [], `a known mutation survivor is no longer pinned: ${missing.join(', ')}`);
});

test('every skill with a gates.yaml namespace is represented, or deliberately is not', () => {
  // A new skill block landing in gates.yaml with no pin is not automatically
  // wrong — plenty of keys are presentation or quality, which this file does not
  // pin. But a whole namespace with nothing pinned is worth a look, so report it
  // rather than assert on it: this test states the coverage, it does not police it.
  const skillsBlock = GATES.skills ?? {};
  const pinnedNamespaces = new Set(PINNED.map(p => p[0]).filter(k => k.startsWith('skills.'))
    .map(k => k.split('.')[1]));
  const unpinned = Object.keys(skillsBlock).filter(n => !pinnedNamespaces.has(n)).sort();

  // These namespaces hold nothing that meets the (a)/(b)/(c) test above. Listing
  // them here is the defence of the choice; a NEW namespace appearing in this
  // list fails, so the choice gets made again rather than defaulted.
  const DELIBERATELY_UNPINNED = {
    gtm_kickoff:  'brief_max_age_days only changes what a downstream skill SAYS about the brief.',
    evidence_score: 'bands and confidence floors decide what a score is CALLED, not what a run costs.',
    gtm_retro:    'a retro reads existing artifacts; its windows and caps are presentation.',
    cost_optimizer: 'noise floors on a report that spends nothing.',
    learn:        'a prior may only REORDER an approved hop set, so it can never change what a run costs.',
    list_hygiene: 'max_rows_per_run IS pinned; the probe timeout and concurrency are operational tuning.',
    comply:       'the two irreversibility gates are pinned; `jurisdictions` is a list, not a threshold.',
    campaign_review: 'verdict_max_age_hours IS pinned; full_read_max_rows only changes sampling.',
    icp_review:   'max_sample_accounts IS pinned; icp_max_age_days only changes what the skill says.',
    // The two advisory namespaces. Both skills own zero endpoints and execute
    // nothing, so no value under either can move (a) what a run costs, (b) what is
    // retained or exported, or (c) a stop — there is no stop to remove, only advice
    // the operator applies in their own sending tool. They are also the two values
    // in the file that are SUPPOSED to be refreshed: receiver and platform guidance
    // moves, and a pin would make a legitimate refresh fail CI for a number the pack
    // cannot enforce or measure. What must not drift is their existence and their
    // shape, which the block below asserts instead.
    sequence_builder: 'cadence design advice; the skill spends nothing and enforces nothing.',
    outreach_expert:  'deliverability advice the user applies in their own sending tool; enforces nothing.',
  };
  const unexplained = unpinned.filter(n => !(n in DELIBERATELY_UNPINNED));
  assert.deepEqual(unexplained, [],
    'a skill namespace in gates.yaml has no pinned gate and no stated reason. Decide: does any of\n'
    + 'its keys change what a run costs, what is retained, or what cannot be undone? Pin those, and\n'
    + 'add the namespace to DELIBERATELY_UNPINNED with one line if the answer is no:\n  '
    + unexplained.join('\n  '));
});

test('the skills inventory the pin table reasons about comes from the filesystem', () => {
  const dirs = readdirSync(join(ROOT, 'skills')).filter(d => statSync(join(ROOT, 'skills', d)).isDirectory());
  assert.ok(dirs.length >= 20, 'the skill inventory came back suspiciously small');
});

// ---------------------------------------------------------------------------
// The two advisory namespaces: not pinned to a VALUE, pinned to an ANSWER
// ---------------------------------------------------------------------------
//
// /sequence-builder exists to answer "how many follow-ups, how far apart" and
// /outreach-expert to answer "how hard can I send, and for how long do I warm".
// Both shipped refusing to answer, because each deferred its headline numbers to
// a `skills.*` namespace nobody had written.
//
// Note the shape of that failure, because it is the one this file's siblings do
// NOT catch. It was never a dangling gate reference: neither skill ever cited the
// missing keys — citing an unresolvable key is a validator error, so the honest
// move at the time was to name the shape of each rule and no value. The cited-key
// check in skill-gate-keys.test.mjs was green throughout, and so was the validator. The
// hole was an authoring gap that every mechanical check was blind to by design,
// and the only visible symptom was two skills that would not do their job.
//
// So this block asserts the join the other checks cannot see: the namespaces
// exist, every key the two skills quote resolves, the values are the right SHAPE
// for what they claim to bound, and the number a reader is given appears on the
// same line as the key it came from. It deliberately does NOT pin the values —
// see DELIBERATELY_UNPINNED above: receiver and platform guidance is supposed to
// be refreshed here, and a pin would make a refresh fail CI for a number this
// pack cannot enforce or measure.

/** namespace -> { skill, keys: { leaf: [min, max] } }. Ranges are sanity, not pins. */
const ADVISORY = {
  'skills.sequence_builder': {
    skill: 'sequence-builder',
    keys: {
      // A cadence, in touches and business days.
      max_steps:                [1, 20],
      min_gap_business_days:    [1, 30],
      max_window_business_days: [5, 260],
    },
  },
  'skills.outreach_expert': {
    skill: 'outreach-expert',
    keys: {
      // Sends, days, and two rates expressed as percentages.
      max_sends_per_mailbox_per_day: [1, 2000],
      warmup_min_days:               [1, 120],
      spam_complaint_max_pct:        [0, 5],
      unsubscribe_max_pct:           [0, 10],
    },
  },
};

const skillBodyOf = (dir) => readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8');

test('both advisory namespaces exist and every key under them resolves to a sane number', () => {
  const bad = [];
  for (const [ns, spec] of Object.entries(ADVISORY)) {
    let block;
    try { block = gateValue(GATES, ns); } catch (e) { bad.push(`${ns} — ${e.message}`); continue; }
    assert.equal(typeof block, 'object', `${ns} should be a block of keys`);
    for (const [leaf, [lo, hi]] of Object.entries(spec.keys)) {
      const key = `${ns}.${leaf}`;
      let v;
      try { v = gateValue(GATES, key); } catch (e) { bad.push(`${key} — ${e.message}`); continue; }
      if (typeof v !== 'number' || !Number.isFinite(v)) { bad.push(`${key} is ${JSON.stringify(v)}, not a number`); continue; }
      if (v < lo || v > hi) bad.push(`${key} is ${v}, outside the sanity range ${lo}..${hi}`);
    }
    // No stray leaves: a key nobody reads is the decoration the declared-key check exists to catch,
    // and an extra one here would be invisible to it as long as the skill's prose
    // happens to name it.
    const extra = Object.keys(block).filter(k => !(k in spec.keys));
    if (extra.length) bad.push(`${ns} declares keys neither skill asked for: ${extra.join(', ')}`);
  }
  assert.deepEqual(bad, [],
    'the two skills that answer the most-asked question in outbound read these keys. A missing\n'
    + 'one is a STOP under law 5, which here means the skill goes back to refusing to answer:\n\n  - '
    + bad.join('\n  - ') + '\n');
});

test('each skill cites every key in its own namespace, with the value on the same line', () => {
  // The two halves of "can it answer the question". The citation makes the number
  // traceable; the number on the same line as the citation is what the reader is
  // actually given, and is also the only form law 1's line-scoped escape accepts.
  const bad = [];
  for (const [ns, spec] of Object.entries(ADVISORY)) {
    const lines = skillBodyOf(spec.skill).split('\n');
    for (const leaf of Object.keys(spec.keys)) {
      const key = `${ns}.${leaf}`;
      const citing = lines.filter(l => l.includes(`gates.yaml:${key}`));
      if (citing.length === 0) { bad.push(`skills/${spec.skill}/SKILL.md never cites gates.yaml:${key}`); continue; }
      const value = String(gateValue(GATES, key));
      if (!citing.some(l => l.includes(value))) {
        bad.push(`skills/${spec.skill}/SKILL.md cites gates.yaml:${key} but never states its value (${value}) `
          + 'on the same line — the reader gets a key and no answer');
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n  '));
});

test('neither skill reaches into the other\'s namespace', () => {
  // gates.yaml rule 3, applied across a boundary the two skills draw themselves:
  // /sequence-builder owns step count and spacing, /outreach-expert owns the
  // sending rates. Two skills carrying one threshold under two names is how one
  // of them goes stale without anyone noticing.
  for (const [ns, spec] of Object.entries(ADVISORY)) {
    const other = Object.keys(ADVISORY).find(k => k !== ns);
    assert.doesNotMatch(skillBodyOf(spec.skill), new RegExp(`gates\\.yaml:${other.replace('.', '\\.')}\\.`),
      `skills/${spec.skill}/SKILL.md cites a key from ${other}; route to the owner instead`);
  }
});

test('the advisory values carry a sourced, dated comment in gates.yaml', () => {
  // These are industry conventions, not laws of physics, and the whole defence of
  // writing them as values rather than refusing them is that each one says where it
  // came from and when it was last checked. A value that loses its provenance is
  // indistinguishable from a number somebody typed.
  const yaml = readFileSync(join(ROOT, '_lib', 'gates.yaml'), 'utf8').split('\n');
  const bad = [];
  for (const spec of Object.values(ADVISORY)) {
    for (const leaf of Object.keys(spec.keys)) {
      const at = yaml.findIndex(l => new RegExp(`^\\s+${leaf}:`).test(l));
      if (at < 0) { bad.push(`${leaf} is not declared in gates.yaml`); continue; }
      // Walk back over the comment run immediately above the key.
      const run = [];
      for (let i = at - 1; i >= 0 && /^\s*#/.test(yaml[i]); i--) run.unshift(yaml[i]);
      const text = run.join(' ');
      if (!/source:/i.test(text) && !/\bsource\b/i.test(text)) bad.push(`${leaf} — no source on its comment`);
      if (!/confidence/i.test(text)) bad.push(`${leaf} — no stated confidence`);
      if (!/\b20\d\d-\d\d-\d\d\b/.test(text)) bad.push(`${leaf} — no ISO date saying when it was last checked`);
    }
  }
  assert.deepEqual(bad, [],
    'a deliverability value lost its provenance. Law 1 is relaxed for these keys only because\n'
    + 'receiver policy moves on a scale of years AND every value says where it came from:\n\n  - '
    + bad.join('\n  - ') + '\n');
});

test('a missing advisory key still fails closed, exactly like every other gate', () => {
  // Law 5 does not get a carve-out because the block is advisory. These keys are
  // read through the same `gateValue()` as the spend gates, so deleting one wedges
  // the skill that quotes it rather than letting the skill invent a number — which
  // is the failure the whole namespace was written to end.
  const { MissingGateKey } = GATES_MOD;
  for (const [ns, spec] of Object.entries(ADVISORY)) {
    for (const leaf of Object.keys(spec.keys)) {
      const holed = structuredClone({ skills: GATES.skills });
      delete holed.skills[ns.split('.')[1]][leaf];
      assert.throws(() => gateValue(holed, `${ns}.${leaf}`), MissingGateKey,
        `${ns}.${leaf} does not fail closed when absent`);
    }
  }
  // And the namespace itself: losing the whole block is a STOP, never "no gate".
  assert.throws(() => gateValue({ skills: {} }, 'skills.outreach_expert.warmup_min_days'), MissingGateKey);
});
