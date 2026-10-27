#!/usr/bin/env bash
# Maintenance E2E fixture: an acceptance command that is authored to always refuse.
# The negative case: an executor exits zero ("the agent said done") but the engine's
# check on a fresh branch checkout must turn that attempt into `failed`.
# Usage: maintenance-check-always-fail.sh [anything]
set -uo pipefail
echo "maintenance-check-always-fail: the artifact this check demands is not on the tree, refusing" >&2
exit 1
