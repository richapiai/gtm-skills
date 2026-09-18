#!/usr/bin/env bash
#
# scripts/ci-local.sh — run .github/workflows/validate.yml, locally, offline.
#
# WHY THIS EXISTS
#
#   CI is written and has never finished green on GitHub: `validate.yml` is
#   manual-only, and its first runs hung until cancelled. A workflow that has not
#   passed is a workflow that does not work yet; the only question is which step it
#   dies on. This script answers that question locally, without a push or a publish.
#
# WHAT IT DOES NOT DO
#
#   No git command. No remote. No push. No npm publish. Two steps would like the
#   network and neither one needs it:
#
#     * `npm ci` is forced OFFLINE (`npm ci --offline`), so it resolves from the local
#       npm cache or fails loudly.
#     * the catalog drift gate asks api.richapi.ai whether the pinned catalog still matches
#       what the server serves. With no route it prints a SKIPPED banner and exits 0.
#       That is the whole design: this script is run offline routinely, and a gate that
#       wedges offline gets deleted, after which it protects nothing. Run it with a
#       network and it does the real comparison.
#
# FIDELITY, AND WHERE IT ENDS
#
#   Every step of the `validate` job runs here, in the workflow's order, and the
#   script stops at the first failure exactly as CI would. Two things it cannot
#   reproduce and therefore states out loud rather than papering over:
#
#     * the Node version matrix (18.20.8, 20.19.0, 22.0.0, 24.5.0). Those rows are
#       PINNED, not floating majors, because a floating row proves only its newest
#       patch — which is how an extensionless-ESM bug survived every green CI run.
#       This machine has one runtime. The
#       script prints which, and says the other rows remain unverified.
#     * `actions/checkout`. CI tests a clean checkout; this tests the working tree,
#       which may hold uncommitted work. Where they differ, CI is the authority.
#
#   The `absorb-spec` job is deliberately NOT run: it is opt-in per dispatch, it
#   fetches a live spec over the network, and it ends in `git push`.
#
# Usage:  bash scripts/ci-local.sh [--skip-install]

set -u -o pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$(pwd)"

SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

STEP_NO=0
FAILED_STEP=""
START_ALL=$(date +%s)

hr () { printf '%s\n' "----------------------------------------------------------------------"; }

# Run one workflow step. Stops the script on the first non-zero exit, which is what
# `fail-fast` inside a job means: later steps never run, so their status is unknown
# rather than green.
step () {
  local name="$1"; shift
  STEP_NO=$((STEP_NO + 1))
  hr
  printf 'STEP %d  %s\n' "$STEP_NO" "$name"
  printf '        $ %s\n' "$*"
  hr
  local t0 t1 rc
  t0=$(date +%s)
  "$@"
  rc=$?
  t1=$(date +%s)
  if [ $rc -eq 0 ]; then
    printf '\n[PASS] step %d: %s  (%ss)\n\n' "$STEP_NO" "$name" "$((t1 - t0))"
    return 0
  fi
  printf '\n[FAIL] step %d: %s  — exit %d after %ss\n' "$STEP_NO" "$name" "$rc" "$((t1 - t0))"
  FAILED_STEP="$name"
  finish $rc
}

finish () {
  local rc="${1:-0}"
  local end; end=$(date +%s)
  hr
  if [ "$rc" -eq 0 ]; then
    printf 'ci-local: ALL %d STEPS PASSED in %ss\n' "$STEP_NO" "$((end - START_ALL))"
    printf 'node %s only — the CI matrix rows for the other versions remain UNVERIFIED.\n' "$(node --version)"
  else
    printf 'ci-local: FAILED at step %d (%s) after %ss\n' "$STEP_NO" "$FAILED_STEP" "$((end - START_ALL))"
    printf 'Steps after this one did not run, so their status is unknown, not green.\n'
  fi
  hr
  exit "$rc"
}

hr
printf 'ci-local — .github/workflows/validate.yml, job `validate`, run locally\n'
printf '  repo   %s\n' "$ROOT"
printf '  node   %s\n' "$(node --version)"
printf '  npm    %s\n' "$(npm --version 2>/dev/null || echo '(not found)')"
printf '  matrix CI runs node 18.20.8, 20.19.0, 22.0.0 and 24.5.0. This run covers %s ONLY.\n' "$(node --version)"
printf '  network `npm ci` is forced --offline; absorb-spec is not run. The live drift gate\n'
printf '          reaches for api.richapi.ai and SKIPS cleanly when it cannot.\n'
hr
printf '\n'

# --- workflow step: npm ci --no-audit --no-fund -----------------------------
#
# CI runs `npm ci`, which hits the registry. Offline that is not available, so this
# adds --offline: it resolves from the local npm cache and fails rather than
# reaching out. A failure here is an environment result, not a repo result, and the
# summary says so.
if [ "$SKIP_INSTALL" -eq 1 ]; then
  STEP_NO=$((STEP_NO + 1))
  printf 'STEP %d  npm ci  — SKIPPED by --skip-install (status UNKNOWN, not green)\n\n' "$STEP_NO"
else
  step "npm ci (forced offline)" npm ci --offline --no-audit --no-fund
fi

# --- workflow step: chmod +x bin/* setup ------------------------------------
step "Make bin/* executable" bash -c 'chmod +x bin/* setup setup.mjs'

# --- the three absorption gates ---------------------------------------------
step "Catalog is regenerable and current" node bin/richapi-catalog-gen.mjs --check
step "Spec diff severity gate"            node bin/richapi-catalog-diff.mjs
step "Every endpoint is owned or explicitly unclaimed" \
     node _lib/catalog/owners-check.mjs --check-coverage

# --- the pin vs the wire ----------------------------------------------------
#
# The three gates above compare the repo against ITSELF; this one asks the server.
# In CI it runs on matrix row 0 only. Here it always runs, because this is the
# machine where "offline" is the normal case and the skip path is the thing worth
# exercising. The 8s bound is below the tool's own 10s default so a hung server
# cannot stretch a local run either.
step "Pinned catalog still matches the live server" \
     node bin/richapi-catalog-drift.mjs --timeout 8000

# --- runtime health ---------------------------------------------------------
step "Preflight emits its stable key contract" ./bin/richapi-skills-preflight
step "Validate skills"                          node scripts/validate-skills.mjs

# --- tests ------------------------------------------------------------------
#
# First one file per process under a deadline, so a file that never exits is named
# instead of hanging this script the way it hung CI. Then the real suite, verbatim.
step "Tests, one file at a time (hang diagnostic)" bash scripts/test-each-file.sh

# Reproduced verbatim, including the explicit file list: `node --test <dir>` treats
# the directory as a module path and fails, and glob support is not in every matrix
# row. The command substitution is evaluated inside bash -c so the expansion happens
# the same way the workflow's `run:` does.
step "Tests" bash -c "node --test \$(find tests -name '*.test.mjs' | sort)"

finish 0
