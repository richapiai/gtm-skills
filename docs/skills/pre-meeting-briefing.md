# /pre-meeting-briefing

A one-page call sheet on the humans you are about to meet, off a plan you approve once,
finished before the call starts.

## The problem this solves

You have a call at 2pm with two people you have never met. The invite gives you a name,
maybe a LinkedIn URL, maybe only an email domain. Doing this properly is forty minutes of
tab work you do not have, and the alternative is opening with "so, tell me a bit about
yourselves". This builds the page you actually need in the time you actually have: who is
in the room, the two things that changed at their company recently, and one opener you
can say out loud without wincing.

## When to use it

- "Prep me for my 2pm."
- "Who am I meeting? All I have is a name and the company."
- "Brief me on David Chen. Also, is this the right David Chen?"
- "What has Acme said publicly in the last few weeks that I could open with?"
- "I have ten minutes and almost no budget. What can you tell me?"

## When NOT to use it

- **You want the funding round, the traffic numbers or their ad history.** The market
  pass never runs here, not with a flag and not on request. Those endpoints belong to
  [`/account-research`](account-research.md), where you approve them with your eyes open.
- **You want the buying committee mapped.** You already know who is in the room. Finding
  more people at the account is [`/org-map`](org-map.md), and the hierarchy with
  provenance on every edge is the whole point of that skill.
- **You want everyone's posting history.** It reads at most one chosen profile's
  activity, and it will not fan that across the attendee list. The reason is under what
  it costs.
- **You gave it a bare common name and no company.** It stops and asks rather than
  picking a David Chen. So do two plausible matches.
- **You want their email address or phone number.** The sheet never carries either, on
  purpose. That is [`/enrich-waterfall`](enrich-waterfall.md), and it prices itself.
- **You want the follow-up email written.** A brief is preparation. Copy is
  [`/personalize`](personalize.md), and the cadence around it is
  [`/sequence-builder`](sequence-builder.md).
- **You want to know whether you may contact them after the meeting.** That is
  [`/comply`](comply.md). A meeting is not consent.
- **You want it to dial, join, record or transcribe.** None of that exists in this pack.
  The other side of the same call is [`/call-intel`](call-intel.md), which reads the
  transcript your recorder produced.
- **You want deep research on the account rather than the people.** Say so and go to
  [`/account-research`](account-research.md). This skill is person-first by design.

## What it costs

Paid, and usually small. This skill owns no endpoints at all. It borrows two skills and
constrains them:

- **Identity**, through [`/enrich-waterfall`](enrich-waterfall.md):
  `find_linkedin_url_by_email`, `find_linkedin_url_by_name`, `enrich_profile`.
- **Company context**, through [`/account-research`](account-research.md) Pass 0 and
  Pass 1: `enrich_company`, then `website_intelligence` or the individual modules,
  `find_sitemap_urls` and `web_scrape` where the brief needs one specific page.
- **What changed**: `linkedin_company_posts`, `post_details`, `post_activities`, and at
  most `profile_social_metrics` then `profile_activities` on one chosen attendee.

Every number comes from the dry run, which makes zero calls, costs nothing, needs no API
key, and always runs first. No credit price is written on this page on purpose: prices
live in `_lib/api-catalog.json` and are read at plan time.

Three things worth knowing before you approve it:

- **The context is nearly free. The recency is what you are paying for.** Firmographics
  and the site sweep sit in the longest cache window, so on an account somebody looked at
  recently those hops show up on the plan as skipped and not charged. Posts and activity
  sit in the shortest window, because a stale post makes a rep sound like they prepared
  last quarter.
- **`profile_activities` is the one line that can never be reconciled.** It is charged on
  a count field absent from the response, so its ledger line stays an estimate. One
  profile per brief, chosen rather than swept, under
  `skills.account_research.profile_activities_max_profiles` in `_lib/gates.yaml`, and it
  confirms every time however little you have spent. Print the ceiling with `richapi
  gates skills.account_research.profile_activities_max_profiles`.
- **If the plan does not fit the time or the money, cut the recency.** The identity plus
  cached context is a one-paragraph brief that is true and on time, which beats a full
  one that lands after the call.

## What you get

`gtm/research/pre-meeting/<date>-<attendee>.md`. One page, six blocks: who is in the
room with their role and tenure, the company context, what changed, one opener, a
watch-out, and what was not checked.

Every claim names the endpoint it came from, like `Marketing stack | HubSpot, Segment |
[web_tech_stack]`. Gaps are written in one of three words, never left blank: `not_found`,
`not_verifiable`, `not_applicable`. **`NOT CHECKED` is a required block**, because a call
sheet is defined by what it left out, and the absence of a committee is not a finding
about the company.

The opener references something real or it is omitted. No "I saw you are doing great
things in the space", and no reads on anybody's personality or motives.

The sheet carries no email address and no phone number. What it does carry is a
do-not-contact flag under the watch-out, because the realistic slip is not a bulk send,
it is a rep firing off a follow-up to somebody who unsubscribed. If the do-not-contact
store could not be read, the sheet says the check did not run and carries no suggested
follow-up at all.

## How to run it

Ask Claude in plain English, with whatever the invite gave you:

> "Prep me for tomorrow's call with Dana Ruiz and Sam Okafor at Acme. Here is Dana's
> LinkedIn URL."

> "Who am I meeting at 2pm, and what should I open with?"

There is no `richapi pre-meeting-briefing` command. Underneath, the skill prices what it
borrows with the shared verbs, and both of these make zero calls:

```console
$ richapi call enrich_profile --param url=<linkedin-profile-url> --dry-run
$ richapi search linkedin_company_posts --param company_linkedin_url=<url> --pages 1 --dry-run
```

## What it needs first

`./setup` once, so there is a readable do-not-contact store. The brief still gets written
without it; the follow-up line does not. Check with `richapi preflight`.

Bring the attendee list. A LinkedIn profile URL is the only identifier that needs no
resolution. An email, or a name plus a company, resolves through
[`/enrich-waterfall`](enrich-waterfall.md) on its own priced plan. A bare common name
stops and asks.

Nothing else has to have run first. If [`/account-research`](account-research.md) already
ran on this account, most of the company context is a cache read and the brief is
cheaper. After the call, [`/call-intel`](call-intel.md) turns the transcript into what it
produced.
