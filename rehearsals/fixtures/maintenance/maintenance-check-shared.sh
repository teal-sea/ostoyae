#!/usr/bin/env bash
# Maintenance E2E fixture: the shared prerequisite job's acceptance command, supplied
# by the board as judge.default_check (a shell command with {id}). The engine runs it
# on a fresh checkout of the attempt's branch, never in the cell. Passes only if the
# artifact the prerequisite job produced is actually committed on the branch.
# Usage: maintenance-check-shared.sh <artifact-file>
set -uo pipefail
file="${1:?usage: maintenance-check-shared.sh <artifact-file>}"
if [ ! -f "$file" ]; then
  echo "maintenance-check-shared: $file is not on this tree" >&2
  exit 1
fi
echo "maintenance-check-shared: $file present"
