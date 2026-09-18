# Destination handoff

The pack exports. Something else sends, syncs or imports. This page is the one
description of what happens at that seam, so the four skills that reach it
(`/crm-export`, `/crm-sync-expert`, `/sequence-builder`, `/outreach-expert`) do not each
invent their own.

## Why this exists

The pack used to stop at a file path. That is correct about ownership and unhelpful in
practice: the user is left holding a CSV and a manual, and the agent that could have
closed the gap has already moved on. Meanwhile the agent frequently *does* have a working
connection to the destination — an installed MCP server for HubSpot, Salesforce, Attio,
Smartlead — and nothing in the pack ever thought to look.

So: the pack still does not write. It finds out what the user already has, tells them what
that means for the file they are holding, and hands over.

## The boundary, stated first

**Nothing in this handoff makes the pack a CRM writer or a sender.** `ROADMAP.md` lists
sending execution, LinkedIn actions, dialers and two-way CRM sync as permanently out of
scope, and this does not amend that.

The distinction that keeps it true:

| | Who runs it | Whose credentials | In scope? |
|---|---|---|---|
| The pack writes to a CRM | the pack | the user's, held by the pack | **no, never** |
| The pack recommends an MCP the user installs | the user | the user's, held by their agent | yes |
| The agent calls that MCP after the export | the agent, on the user's instruction | the user's | yes, and it is not this pack acting |

A skill may **find, name and explain** a destination integration. It never installs one,
never stores a credential for one, and never treats "an MCP exists" as permission to push
data through it. The user approves the push the same way they approve spend.

## The ladder

Run it in order. Stop at the first rung that answers.

**1. Is there already an MCP server for this destination?**
Look at the tools actually available in this session. Many agents ship connections to
HubSpot, Salesforce, Pipedrive, Attio, Close, Notion, Airtable, Slack and the major
sending tools. If one matches the destination the user named, say so concretely — the
tool name, and what it would let them do with the file that was just written. Then ask
whether to use it. Do not call it because it is there.

**2. Is there a documented API, or a Postman collection?**
No MCP does not mean no path. Nearly every destination in this space publishes REST docs
and many publish a Postman collection or an OpenAPI file. Point the user at the specific
thing — the import endpoint, the object it writes, the rate limit that will matter at
their row count — rather than at a documentation homepage.

**3. Neither resolved — ask, and say what you looked for.**
An honest "I could not find an integration for X; here is the manual import path, and
here is what I checked" is a useful answer. A guessed endpoint is not. Never invent an
API shape, a field name or an MCP server name to fill this rung.

## What to say when a rung hits

Three things, in this order, and no more:

1. **What you found**, named exactly — the MCP tool, or the endpoint and its docs URL.
2. **What it would do with this specific file** — which object, which dedupe key, how
   many rows, and what the destination will silently truncate or reject. For a CRM this
   is `/crm-sync-expert`'s answer; do not re-derive it here.
3. **The ask.** The user says go. The agent does not decide that a write is safe because
   the mapping looked clean.

## What never happens on this path

- No credential is read, written, stored or echoed. Not into `gtm/`, not into a message.
- No row leaves the machine before the user approves the push, exactly as no credit is
  spent before they approve a plan.
- No suppressed row is pushed, ever. Suppression is applied at write time; a later push
  of an older file is a re-push of a stale suppression state, and the right answer is to
  re-export, not to filter again downstream.
- No claim that records were created or updated. The pack cannot observe the result of a
  push it did not make. Report what was handed over, not what happened next.
- No integration is recommended because it is popular. If the user's destination is not
  covered, rung 3 is the answer.

## Related

- [`/crm-export`](../skills/crm-export/SKILL.md) — writes the file this page hands over
- [`/crm-sync-expert`](../skills/crm-sync-expert/SKILL.md) — decides the object, the key
  and the collision rule before any of this
- [`/sequence-builder`](../skills/sequence-builder/SKILL.md) — the sender's merge-tag
  syntax, which is the same question one layer up
- [`/outreach-expert`](../skills/outreach-expert/SKILL.md) — sender setup, up to and only
  up to the send button
- [`ROADMAP.md`](../ROADMAP.md) — the permanent boundary this page does not move
