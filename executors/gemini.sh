#!/usr/bin/env bash
# Run one headless Gemini CLI attempt. stdin is attempt JSON; the harness owns commits.
# This adapter has stub contract coverage but has not been verified with a real agent.
set -uo pipefail

# Run from a private copy, for the reason claude.sh gives: bash reads a script as it runs it, and
# an edit to this file would land inside every cell partway through the old bytes.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-gemini.XXXXXX") || exit 1
  cat "${BASH_SOURCE[0]}" > "$_copy" || exit 1
  OSTOYAE_EXEC_COPY="$_copy" exec bash "$_copy" "$@"
fi
rm -f "$OSTOYAE_EXEC_COPY"

ATTEMPT=$(cat)
WHAT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a.get("what") or a["of"])')
MODEL=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("model","") or "")')
EFFORT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("effort","") or "")')
KIND=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("kind") or "prove")')
MAXT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("params",{}).get("max_turns"); print(v if isinstance(v,int) and v>0 else "")')

# The cell's own Gemini config, in a directory that dies with the attempt. The system settings
# file wins over the user's and the project's, so a pursuit that ships its own .gemini/settings.json
# cannot re-enable git, and the contract file is named so the agent reads it: Gemini's memory
# file is GEMINI.md by default and the runner writes AGENTS.md and CLAUDE.md.
CONF=$(mktemp -d "${TMPDIR:-/tmp}/ostoyae-gemini-conf.XXXXXX") || exit 1
trap 'rm -rf "$CONF"' EXIT
MAXT="$MAXT" python3 -c '
import json, os, sys
s = {"tools": {"exclude": ["run_shell_command(git)"]},
     "context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}
if os.environ["MAXT"]:
    s["model"] = {"maxSessionTurns": int(os.environ["MAXT"])}
json.dump(s, open(sys.argv[1], "w"))
' "$CONF/settings.json"
cat > "$CONF/ostoyae.toml" <<'TOML'
[[rule]]
toolName = "run_shell_command"
commandPrefix = "git"
decision = "deny"
priority = 1000
TOML
export GEMINI_CLI_SYSTEM_SETTINGS_PATH="$CONF/settings.json"
export GEMINI_CLI_TRUST_WORKSPACE=true

ARGS=(-p "$WHAT" --approval-mode yolo --output-format stream-json --admin-policy "$CONF/ostoyae.toml")
[ -n "$MODEL" ] && ARGS+=(-m "$MODEL")
[ -n "$EFFORT" ] && echo "[cell $OSTOYAE_ATTEMPT] effort ignored: Gemini CLI has no per-run effort flag"
# The shared caches the runner linked into this cell (sandbox.mjs sets OSTOYAE_LINKED), opened to
# the agent's tools. --include-directories is the documented way to widen the workspace; whether
# it also opens them for writing was not established, and the contract's "never write into them"
# is the guard either way.
if [ -n "${OSTOYAE_LINKED:-}" ]; then
  IFS=: read -r -a LINKED <<< "$OSTOYAE_LINKED"
  for d in "${LINKED[@]}"; do ARGS+=(--include-directories "$d"); done
fi

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
# stdin is /dev/null: the attempt JSON was consumed above, and -p is documented as appended to
# whatever stdin holds. The filter turns each stream event into one plain line for the live view
# and writes usage.json from the `result` event. The exit code is gemini's.
gemini "${ARGS[@]}" < /dev/null \
  | python3 -u -c '
import json, os, sys
buf = []
def flush():
    if buf:
        print("says: " + " ".join("".join(buf).split())[:400], flush=True); buf.clear()
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try: ev = json.loads(raw)
    except ValueError:
        print(raw, flush=True); continue
    t = ev.get("type")
    if t == "message":
        if ev.get("role") == "assistant":
            buf.append(ev.get("content") or "")
            if not ev.get("delta"): flush()
        continue
    flush()
    if t == "tool_use":
        p = ev.get("parameters") or {}
        what = p.get("command") or p.get("file_path") or p.get("path") or p.get("pattern") or p.get("query") or ""
        print("uses " + str(ev.get("tool_name", "?")) + (": " + " ".join(str(what).split())[:160] if what else ""), flush=True)
    elif t == "error":
        print("[cell] " + str(ev.get("severity", "error")) + ": " + str(ev.get("message", "")), flush=True)
    elif t == "result":
        if ev.get("status") == "error":
            e = ev.get("error") or {}
            print("[cell] agent reported an error: " + str(e.get("message") or e), flush=True)
        s = ev.get("stats") or {}
        rec = {
            "executor": "gemini",
            "model": ",".join(sorted((s.get("models") or {}).keys())) or None,
            "input_tokens": s.get("input"),
            "output_tokens": s.get("output_tokens"),
            "cache_read_input_tokens": s.get("cached"),
            "cache_creation_input_tokens": None,
            "total_tokens": s.get("total_tokens"),
            "cost_usd": None,
            "cost_basis": "unreported: Gemini CLI reports tokens and duration, not dollars",
            "duration_ms": s.get("duration_ms"),
            "api_ms": None,
            "turns": None,
            "tool_calls": s.get("tool_calls"),
        }
        if not s: rec["_bad"] = "Gemini CLI result event carried no stats"
        try:
            os.makedirs(".ostoyae", exist_ok=True)
            with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
        except OSError as e:
            print("[cell] could not write usage: " + str(e), flush=True)
        print("usage: out=%s in=%s cache_read=%s cost=? (%s) tool_calls=%s" % (
            rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
            rec["cost_basis"], rec["tool_calls"]), flush=True)
flush()
'
STATUS=${PIPESTATUS[0]}

# Everything below is claude.sh's, unchanged: commit whatever the attempt wrote, then read the
# handback the way the runner expects.
commit_work() {
  if [ -n "$(git status --porcelain -- . ':(exclude).ostoyae' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md')" ]; then
    # Stage exactly the changed, unignored paths that are not the injected contracts or the harness handback dir.
    # Naming an ignored file in :(exclude) is an add error on git 2.47+ and prints advice
    # about files deliberately excluded, so enumerate instead, the way codex.mjs does:
    PATHS=$(mktemp "${TMPDIR:-/tmp}/ostoyae-paths.XXXXXX") || return 1
    {
      git diff --name-only -z HEAD -- . 2>/dev/null
      git ls-files --others --exclude-standard -z -- . 2>/dev/null
    } | python3 -c '
import sys
seen = set()
out = []
# Compiled Python stays out unless the repository already tracks compiled files.
def tracked_compiled(cache=[]):
    if not cache:
        import subprocess
        r = subprocess.run(["git", "ls-files", "-z", "--", ":(glob)**/*.pyc", ":(glob)**/__pycache__/**"], capture_output=True)
        cache.append(bool(r.stdout.strip(b"\0")))
    return cache[0]
for p in sys.stdin.buffer.read().split(b"\0"):
    try:
        s = p.decode()
    except ValueError:
        continue
    if not s or s in ("AGENTS.md", "CLAUDE.md", ".ostoyae") or s.startswith(".ostoyae/"):
        continue
    if (s.endswith(".pyc") or "__pycache__" in s.split("/")) and not tracked_compiled():
        continue
    if s not in seen:
        seen.add(s)
        out.append(s)
if out:
    sys.stdout.buffer.write("\0".join(out).encode() + b"\0")
' > "$PATHS"
    # Guard the empty list: feeding git add an empty pathspec file stages every change in
    # the worktree, contracts included (exit 0), which is exactly what the enumeration
    # exists to prevent. Codex stages only when its list is non-empty; same rule here.
    if [ -s "$PATHS" ]; then
      git --literal-pathspecs -c advice.addIgnoredFile=false add -A --pathspec-from-file="$PATHS" --pathspec-file-nul --
    fi
    rm -f "$PATHS"
    git restore --staged --quiet -- AGENTS.md 2>/dev/null || true
    git restore --staged --quiet -- CLAUDE.md 2>/dev/null || true
    git commit -qm "$1$WHAT

Attempt: $OSTOYAE_ATTEMPT
Work: $OSTOYAE_WORK" || return 1
    echo "[cell $OSTOYAE_ATTEMPT] committed $(git rev-parse --short HEAD)"
    return 0
  fi
  return 1
}

if [ "$STATUS" != 0 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] agent exited non-zero ($STATUS)"
  [ "$KIND" != map ] && [ "$KIND" != verify ] && commit_work "failed, partial work: " || true
  exit 1
fi

if [ "$KIND" = verify ]; then
  if [ -s .ostoyae/report.json ] \
     && python3 -c 'import json,sys; sys.exit(0 if isinstance((json.load(open(".ostoyae/report.json")) or {}).get("verdicts"), list) else 1)' 2>/dev/null; then
    echo "[cell $OSTOYAE_ATTEMPT] judged, handback carries verdicts"; exit 0
  fi
  echo "[cell $OSTOYAE_ATTEMPT] verify attempt handed back no verdicts"; exit 1
fi

if [ "$KIND" = map ]; then
  if [ -s .ostoyae/report.json ] \
     && python3 -c 'import json,sys; sys.exit(0 if isinstance((json.load(open(".ostoyae/report.json")) or {}).get("map"), dict) else 1)' 2>/dev/null; then
    echo "[cell $OSTOYAE_ATTEMPT] mapped, handback carries a map"; exit 0
  fi
  echo "[cell $OSTOYAE_ATTEMPT] map attempt handed back no map"; exit 1
fi

# A handback that names a wall means the agent did not finish, whatever gemini exited with.
WALLED=0
if [ -s .ostoyae/report.json ] \
   && python3 -c 'import json,sys; sys.exit(0 if (json.load(open(".ostoyae/report.json")) or {}).get("wall") else 1)' 2>/dev/null; then
  WALLED=1
fi

CHANGED=0
SUBJECT_PREFIX=""
[ "$WALLED" = 1 ] && SUBJECT_PREFIX="walled, partial work: "
if commit_work "$SUBJECT_PREFIX"; then CHANGED=1; fi

if [ "$WALLED" = 1 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] walled, reported a wall"
  exit 1
fi

if [ "$CHANGED" = 0 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] no changes, nothing to commit"
  exit 1
fi
