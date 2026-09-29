#!/usr/bin/env bash
# Run one attempt as a headless Claude Code session inside its cell.
# The runner has already created the worktree, assigned the branch, database and port,
# and written the contract into AGENTS.md / CLAUDE.md right here. Claude Code reads those
# on start, so the rules arrive without being repeated in the prompt.
set -uo pipefail

# Run a private copy because Bash reads scripts during execution; edits to the source must not change an active cell.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-claude.XXXXXX") || exit 1
  cat "${BASH_SOURCE[0]}" > "$_copy" || exit 1
  OSTOYAE_EXEC_COPY="$_copy" exec bash "$_copy" "$@"
fi
rm -f "$OSTOYAE_EXEC_COPY"

ATTEMPT=$(cat)
WHAT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a.get("what") or a["of"])')
MODEL=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("model","") or "")')
EFFORT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("effort","") or "")')
KIND=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("kind") or "prove")')

ARGS=(-p "$WHAT" --permission-mode acceptEdits)
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
[ -n "$EFFORT" ] && ARGS+=(--effort "$EFFORT")
# A turn cap, from `params.max_turns`, so attempts in an experiment can be matched on budget
# before their token counts exist. Absent means claude's default, as before.
MAXT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("params",{}).get("max_turns"); print(v if isinstance(v,int) and v>0 else "")')
[ -n "$MAXT" ] && ARGS+=(--max-turns "$MAXT")
# The shared caches the runner linked into this cell, resolved (sandbox.mjs sets OSTOYAE_LINKED).
# Claude Code refuses its own Read and Bash tools outside the directory it started in, and a
# linked path is a symlink that resolves outside it, so without this an agent told to grep
# Mathlib is refused and answers from memory. --add-dir is variadic, so it is followed by
# another flag on the command line, which is what ends the list.
if [ -n "${OSTOYAE_LINKED:-}" ]; then
  IFS=: read -r -a LINKED <<< "$OSTOYAE_LINKED"
  # Deny file writes to linked caches. `--add-dir` permits writing, and these paths are shared with other cells.
  DENIED="$OSTOYAE_LINKED"
  ADD_DIR=1
fi
if [ -n "${OSTOYAE_MAILBOX:-}" ]; then
  LINKED+=("$(dirname "$OSTOYAE_MAILBOX")")
  ADD_DIR=1
fi

# One --settings, carrying both halves of what this cell may do, because a second --settings
# would replace the first rather than merge with it.
SETTINGS=$(DENIED="${DENIED:-}" WEB="${OSTOYAE_WEB:-}" LEAN="${OSTOYAE_LEAN_MCP:-}" TOOLS="${OSTOYAE_TOOLS:-}" CHECK="${OSTOYAE_CHECK:-}" MAILBOX="${OSTOYAE_MAILBOX:-}" python3 -c '
import json, os
perms = {}
denied = [d for d in os.environ["DENIED"].split(":") if d]
if denied:
    perms["deny"] = [f"{tool}(/{d}/**)" for d in denied
                     for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit")]
allow = []
if os.environ["WEB"]:
    allow += ["WebSearch", "WebFetch"]
if os.environ["LEAN"]:
    allow += ["Bash(lake:*)", "Bash(lean:*)", "mcp__lean"]
allow += [f"Bash({cmd}:*)" for cmd in os.environ["TOOLS"].split("\n") if cmd.strip()]
if os.environ["MAILBOX"]:
    allow.append("Bash(ostoyae-msg:*)")
check = os.environ["CHECK"].strip()
if check and "\n" not in check:
    allow.append(f"Bash({check})")
if allow:
    perms["allow"] = allow
settings = {"permissions": perms} if perms else {}
if os.environ["MAILBOX"]:
    settings["hooks"] = {"PostToolUse": [{"hooks": [{"type": "command", "command": "ostoyae-msg read --hook", "timeout": 10}]}]}
print(json.dumps(settings) if settings else "")
')
[ -n "$SETTINGS" ] && ARGS+=(--settings "$SETTINGS")
# --add-dir is variadic, so it is followed by another flag, which is what ends the list.
[ -n "${ADD_DIR:-}" ] && ARGS+=(--add-dir "${LINKED[@]}")

# The Lean language server, as an MCP server, when OSTOYAE_LEAN_MCP names its executable.
# Without it a prove cell writes a tactic blind, runs `lake build`, reads the error and guesses
# again, and it guesses lemma names from memory the same way the first run's mappers guessed
# Mathlib names. This gives it `lean_goal` (the proof state at a position), `lean_loogle` and
# `lean_leansearch` and `lean_hammer_premise` (find a lemma by its shape, not its name), and
# `lean_multi_attempt` (try several tactics without a rebuild each time). LEAN_PROJECT_PATH is
# the cell's own worktree, so the server elaborates the file the agent is editing.
if [ -n "${OSTOYAE_LEAN_MCP:-}" ] && [ -x "${OSTOYAE_LEAN_MCP}" ]; then
  MCP=$(LEAN_MCP="$OSTOYAE_LEAN_MCP" WT="${OSTOYAE_WORKTREE:-$PWD}" python3 -c '
import json, os
print(json.dumps({"mcpServers": {"lean": {
    "command": os.environ["LEAN_MCP"],
    "env": {"LEAN_PROJECT_PATH": os.environ["WT"],
            "PATH": os.path.expanduser("~/.elan/bin") + ":" + os.environ.get("PATH", "")}}}}))
')
  ARGS+=(--mcp-config "$MCP")
fi

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
# --disallowedTools Bash(git:*) so the agent does not burn the attempt asking to commit.
# The harness owns git; the contract in the worktree says so too.
claude "${ARGS[@]}" --disallowedTools "Bash(git:*)" --output-format stream-json --verbose \
  | python3 -u -c '
import hashlib, json, os, sys
# Merged usage across every `result` event in this session. Incremental fields sum,
# cumulative fields take the max; see the result branch below for the evidence.
_usage = {"models": set(), "input_tokens": None, "output_tokens": None,
          "cache_read_input_tokens": None, "cache_creation_input_tokens": None,
          "cost_usd": None, "duration_ms": None, "api_ms": None, "turns": None,
          "web_search_requests": None, "web_fetch_requests": None}
_seen_results = set()
def _num(v):
    return v if isinstance(v, (int, float)) and v >= 0 else None
def _merge_result(ev):
    u = ev.get("usage") or {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens"):
        v = _num(u.get(k))
        if v is not None: _usage[k] = (_usage[k] or 0) + v
    for k, v in (("turns", _num(ev.get("num_turns"))),
                 ("web_search_requests", _num((u.get("server_tool_use") or {}).get("web_search_requests"))),
                 ("web_fetch_requests", _num((u.get("server_tool_use") or {}).get("web_fetch_requests")))):
        if v is not None: _usage[k] = (_usage[k] or 0) + v
    for k, v in (("cost_usd", _num(ev.get("total_cost_usd"))),
                 ("duration_ms", _num(ev.get("duration_ms"))),
                 ("api_ms", _num(ev.get("duration_api_ms")))):
        if v is not None and (_usage[k] is None or v > _usage[k]): _usage[k] = v
    _usage["models"] |= set((ev.get("modelUsage") or {}).keys())
    rec = {k: v for k, v in _usage.items() if k != "models"}
    rec["model"] = ",".join(sorted(_usage["models"])) or None
    try:
        os.makedirs(".ostoyae", exist_ok=True)
        with open(".ostoyae/usage.json", "w") as f:
            json.dump(rec, f)
    except OSError as e:
        print("[cell] could not write usage: " + str(e), flush=True)
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try: ev = json.loads(raw)
    except ValueError:
        print(raw, flush=True); continue
    t = ev.get("type")
    if t == "assistant":
        for c in ev.get("message", {}).get("content", []):
            if c.get("type") == "text" and c.get("text", "").strip():
                print("says: " + " ".join(c["text"].split())[:400], flush=True)
            elif c.get("type") == "tool_use":
                i = c.get("input", {}) or {}
                what = i.get("command") or i.get("file_path") or i.get("pattern") or i.get("path") or i.get("query") or ""
                print("uses " + str(c.get("name", "?")) + (": " + " ".join(str(what).split())[:160] if what else ""), flush=True)
    elif t == "result":
        r = ev.get("result")
        if isinstance(r, str) and r.strip():
            print(r, flush=True)
        if ev.get("is_error"):
            print("[cell] agent reported an error", flush=True)
        # Merge usage across result events: sum incremental tokens and turns, but take the maximum cumulative cost and duration.
        _digest = hashlib.sha1(raw.encode()).hexdigest()
        if _digest not in _seen_results:
            _seen_results.add(_digest)
            _merge_result(ev)
        cost = _usage["cost_usd"]
        print("usage: out=%s in=%s cache_read=%s cache_create=%s cost=%s turns=%s api=%ss" % (
            _usage["output_tokens"], _usage["input_tokens"], _usage["cache_read_input_tokens"],
                _usage["cache_creation_input_tokens"], ("$%.2f" % cost) if isinstance(cost, (int, float)) else "?",
                _usage["turns"], (_usage["api_ms"] or 0) // 1000), flush=True)
'
STATUS=${PIPESTATUS[0]}

# Commit partial work on failed or walled attempts so teardown does not erase it; keep the original exit status.
commit_work() {
  # $1 is the subject prefix; the injected contract is never committed (see below).
  if [ -n "$(git status --porcelain -- . ':(exclude).ostoyae' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md')" ]; then
    # Exclude injected contracts while staging. Unstaging optional pathspecs can fail as a group and accidentally commit a contract.
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
  echo "[cell $OSTOYAE_ATTEMPT] agent exited non-zero"
  [ "$KIND" != map ] && [ "$KIND" != verify ] && commit_work "failed, partial work: " || true
  exit 1
fi

# A verify attempt's only product is its verdicts. It is done when the handback carries a
# `verdicts` array, it commits nothing, and anything else it wrote is torn down with the cell.
# The runner decides what each verdict lands on; the executor only says whether there are any.
if [ "$KIND" = verify ]; then
  if [ -s .ostoyae/report.json ] \
     && python3 -c 'import json,sys; sys.exit(0 if isinstance((json.load(open(".ostoyae/report.json")) or {}).get("verdicts"), list) else 1)' 2>/dev/null; then
    echo "[cell $OSTOYAE_ATTEMPT] judged, handback carries verdicts"; exit 0
  fi
  echo "[cell $OSTOYAE_ATTEMPT] verify attempt handed back no verdicts"; exit 1
fi

# A map attempt's only product is the handback. It is done when the handback carries a map,
# it commits nothing, and anything else it wrote is left on the worktree to be torn down.
if [ "$KIND" = map ]; then
  if [ -s .ostoyae/report.json ] \
     && python3 -c 'import json,sys; sys.exit(0 if isinstance((json.load(open(".ostoyae/report.json")) or {}).get("map"), dict) else 1)' 2>/dev/null; then
    echo "[cell $OSTOYAE_ATTEMPT] mapped, handback carries a map"; exit 0
  fi
  echo "[cell $OSTOYAE_ATTEMPT] map attempt handed back no map"; exit 1
fi

# A handback that names a wall means the agent did not finish, whatever `claude` exited with.
# `claude -p` returns 0 when the session completed, not when the work succeeded, so the exit
# code above cannot carry that and this has to. run.mjs turns wall + proposals into `walled`,
# which is the outcome this whole repo is built for and is not a failure.
WALLED=0
if [ -s .ostoyae/report.json ] \
   && python3 -c 'import json,sys; sys.exit(0 if (json.load(open(".ostoyae/report.json")) or {}).get("wall") else 1)' 2>/dev/null; then
  WALLED=1
fi

# Commit a walled attempt's partial work before teardown. Exclude injected AGENTS.md and CLAUDE.md.
CHANGED=0
SUBJECT_PREFIX=""
[ "$WALLED" = 1 ] && SUBJECT_PREFIX="walled, partial work: "
if commit_work "$SUBJECT_PREFIX"; then CHANGED=1; fi

if [ "$WALLED" = 1 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] walled, reported a wall"
  exit 1
fi

# An attempt that changed nothing is not a success. The report does not count as a change:
# without this, an agent that wrote only a handback would look like it had done the work.
if [ "$CHANGED" = 0 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] no changes, nothing to commit"
  exit 1
fi
