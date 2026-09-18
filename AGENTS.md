# Agents

Two different jobs, two different files.

**Using the pack** — driving the skills, spending credits, exporting a list:
read **[`llms.txt`](llms.txt)**. It is generated from this repository's own derived
facts (skill list, endpoint count, which skills can spend) and links onward to
everything else. Do not read the README first; it is written for a human evaluating
whether to adopt the pack.

**Working on the pack** — changing code, skills or docs in this repository:
read **[`CLAUDE.md`](CLAUDE.md)** for the seven laws every change is held to, then
**[`CONTRIBUTING.md`](CONTRIBUTING.md)** for setup and the review checklist.

## The three things to get right either way

1. **Nothing spends without an approved plan.** `--dry-run` prices a whole run and
   makes zero API calls. Never add a code path that calls a metered endpoint before a
   human has seen the total. A declined plan exits **7**, not 0.
2. **`gtm/` is personal data.** Gitignored, TTL-swept, erasable via `/comply`. Never
   commit it, never copy it into a message, never write it outside that tree.
3. **Numbers come from files, not from memory.** Credit costs come from
   `_lib/api-catalog.json`, thresholds from `_lib/gates.yaml`, response shapes from
   recorded fixtures. If you are about to type a number into prose, derive it instead.

`llms.txt` is generated. Regenerate with `npm run docs:llms`; the build fails if it is
stale.
