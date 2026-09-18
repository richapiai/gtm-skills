#!/usr/bin/env bash
#
# scripts/test-each-file.sh — run every test file in its OWN process, each under a
# hard deadline, and print the tail of any file that fails or does not exit.
#
# WHY THIS EXISTS
#
#   `node --test <files>` reports files in order and a file only counts as finished
#   when its process exits. One file that never exits therefore looks, from outside,
#   like six hours of silence followed by the runner's cancellation — which is
#   exactly what it looked like on 2026-09-02, on all four matrix rows, at ~$9 a run
#   (two tests wrote to a /proc path; node's recursive mkdir spins forever there).
#   This script turns that silence into a file name and the last test that spoke.
#
# It is a diagnostic, not a replacement for the real suite: files that only misbehave
# when run concurrently will pass here and still hang in the full run. That is why
# the workflow keeps both, and bounds the full run with a step timeout.
#
# Usage:  bash scripts/test-each-file.sh            (TEST_FILE_TIMEOUT=90 by default)

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

LIMIT="${TEST_FILE_TIMEOUT:-90}"

# GNU timeout on Linux; Homebrew coreutils on macOS ships it as gtimeout. Without
# either the files still run, just unbounded — and the summary says so.
if command -v timeout >/dev/null 2>&1; then BOUND=(timeout -k 5 "$LIMIT")
elif command -v gtimeout >/dev/null 2>&1; then BOUND=(gtimeout -k 5 "$LIMIT")
else BOUND=(); echo "test-each-file: no timeout binary; files run unbounded" >&2; fi

snapshot () {
  # Linux ps knows --forest; fall back to plain ps elsewhere.
  ps -eo pid,ppid,stat,etime,args --forest 2>/dev/null || ps -ef
}

bad=0
hung=0
for f in $(find tests -name '*.test.mjs' | sort); do
  out="$(mktemp)"
  "${BOUND[@]}" node --test --test-reporter=tap "$f" >"$out" 2>&1 &
  pid=$!
  # Ten seconds before the deadline, photograph the process tree: if the file is
  # stuck on a child (git, npm, bash, a second node) that child is in the picture.
  # The watcher writes only to its file; detached from our stdout so a caller reading
  # this script through a pipe sees EOF the moment the loop ends, not when the last
  # sleep does.
  ( sleep $(( LIMIT > 15 ? LIMIT - 10 : 5 )); snapshot >"$out.ps" 2>/dev/null ) >/dev/null 2>&1 &
  watcher=$!
  wait "$pid"; rc=$?
  pkill -P "$watcher" 2>/dev/null; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  if [ "$rc" -ne 0 ]; then
    bad=$((bad + 1))
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      hung=$((hung + 1))
      echo "::group::HUNG — did not exit within ${LIMIT}s: $f"
      echo "--- last 40 lines of its output (the last 'ok' is the last test that finished) ---"
      tail -n 40 "$out"
      if [ -s "$out.ps" ]; then echo "--- process tree ${LIMIT}s in ---"; cat "$out.ps"; fi
    else
      echo "::group::FAILED (exit $rc): $f"
      tail -n 40 "$out"
    fi
    echo "::endgroup::"
  fi
  rm -f "$out" "$out.ps"
done

echo "test-each-file: $bad file(s) failed, of which $hung hung (deadline ${LIMIT}s each)"
[ "$bad" -eq 0 ]
