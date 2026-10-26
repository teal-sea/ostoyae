#!/usr/bin/env bash
# Maintenance E2E fixture: a consumer job's acceptance command. Runs on a fresh
# checkout of the consumer attempt's branch. Passes only when ALL hold:
#   1. the consumer's own artifact exists (its job ran),
#   2. the shared prerequisite's artifact exists (its content was inherited), and
#   3. the shared artifact was committed by the shared prerequisite job, not by this
#      consumer (the fake executor commits "<work-id>.txt" with subject "fake: <work-id>").
# This is what turns "the consumer passed" into "the consumer passed ON the shared code".
# Usage: maintenance-check-consumer.sh <own-artifact> <shared-artifact>
set -uo pipefail
own="${1:?usage: maintenance-check-consumer.sh <own-artifact> <shared-artifact>}"
shared="${2:?usage: maintenance-check-consumer.sh <own-artifact> <shared-artifact>}"
if [ ! -f "$own" ]; then
  echo "maintenance-check-consumer: this attempt's own artifact $own is missing" >&2
  exit 1
fi
if [ ! -f "$shared" ]; then
  echo "maintenance-check-consumer: the shared prerequisite artifact $shared was not inherited" >&2
  exit 1
fi
stem="${shared%.txt}"
subject=$(git log --format='%s' -1 -- "$shared" 2>/dev/null || echo '')
if [ "$subject" != "fake: $stem" ]; then
  echo "maintenance-check-consumer: $shared was not committed by the shared prerequisite job (last commit touching it: '$subject')" >&2
  exit 1
fi
echo "maintenance-check-consumer: $own built here; $shared inherited from '$subject'"
