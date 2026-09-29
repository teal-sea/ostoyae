#!/usr/bin/env bash
# One headless Codex attempt. stdin is the attempt JSON; the harness owns git.
# Exit 0 = done; nonzero plus a wall handback lets the runner record walled.
# Keep both executor files frozen for the lifetime of the cell.
set -euo pipefail
if [ -z "${OSTOYAE_CODEX_COPY:-}" ]; then
  exec_dir=$(mktemp -d "${TMPDIR:-/tmp}/ostoyae-codex.XXXXXX")
  source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  cp "${BASH_SOURCE[0]}" "$exec_dir/codex.sh"
  cp "$source_dir/codex.mjs" "$exec_dir/codex.mjs"
  OSTOYAE_CODEX_COPY="$exec_dir" exec bash "$exec_dir/codex.sh" "$@"
fi
trap 'rm -f "$OSTOYAE_CODEX_COPY/codex.sh" "$OSTOYAE_CODEX_COPY/codex.mjs"; rmdir "$OSTOYAE_CODEX_COPY"' EXIT
node "$OSTOYAE_CODEX_COPY/codex.mjs" "$@"
