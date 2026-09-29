#!/usr/bin/env bash
# Run one headless Grok attempt. stdin is attempt JSON; the harness owns commits.
# Streaming messages feed the live view; the final result supplies usage and cost.
set -uo pipefail

# Run from a private copy, for the reason claude.sh gives: bash reads a script as it runs it, and
# an edit to this file would land inside every cell partway through the old bytes.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-grok.XXXXXX") || exit 1
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

# The prompt goes through a file, never argv: a prompt starting with a dash would otherwise parse
# as a flag. The directory dies with the attempt.
CONF=$(mktemp -d "${TMPDIR:-/tmp}/ostoyae-grok-conf.XXXXXX") || exit 1
trap 'rm -rf "$CONF"' EXIT
printf '%s' "$WHAT" > "$CONF/prompt.txt"

DISALLOW="ask_user_question"
ARGS=(--prompt-file "$CONF/prompt.txt" --output-format streaming-messages-json --trust
  --permission-mode bypassPermissions --deny 'Bash(git *)' --deny 'MCPTool(*)')
# Built incrementally, never expanded conditionally: "${EMPTY[@]}" under `set -u` is a fatal
# unbound variable on the system bash 3.2, which is what runs this file, so a WEBOFF array
# that is empty when OSTOYAE_WEB is set would die before grok starts.
if [ -z "${OSTOYAE_WEB:-}" ]; then
  DISALLOW="$DISALLOW,web_search,web_fetch"
  ARGS+=(--disable-web-search)
fi
ARGS+=(--disallowed-tools "$DISALLOW")
[ -n "$MODEL" ] && ARGS+=(-m "$MODEL")
[ -n "$EFFORT" ] && ARGS+=(--reasoning-effort "$EFFORT")
[ -n "$MAXT" ] && ARGS+=(--max-turns "$MAXT")

if [ -n "${OSTOYAE_LINKED:-}" ]; then
  echo "[cell $OSTOYAE_ATTEMPT] linked caches are not opened: no grok flag for them was found"
fi
if [ -n "${OSTOYAE_LEAN_MCP:-}" ]; then
  echo "[cell $OSTOYAE_ATTEMPT] Lean language server is not attached: no grok flag for it was found"
fi

# Set aside tracked Claude project instructions during the cell, then restore them if the agent left the path alone.
MOVED=""
for CLAUDEMEM in .claude/CLAUDE.md .claude/CLAUDE.local.md; do
  if [ -f "$CLAUDEMEM" ] && git ls-files --error-unmatch -- "$CLAUDEMEM" >/dev/null 2>&1; then
    mkdir -p "$CONF/claude-away/$(dirname "$CLAUDEMEM")"
    mv "$CLAUDEMEM" "$CONF/claude-away/$CLAUDEMEM"
    MOVED="$MOVED $CLAUDEMEM"
  fi
done
if [ -n "$MOVED" ]; then
  {
    printf '\n\nNote from the harness: it moved%s aside to %s for this run, because grok would otherwise load them as project instructions beside the contract above. Read the originals there if your task needs them; files you write at those paths are kept as your work.\n' "$MOVED" "$CONF/claude-away"
  } >> "$CONF/prompt.txt"
  echo "[cell $OSTOYAE_ATTEMPT] withheld from rules loading:$MOVED"
fi

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
# stdin is /dev/null: the attempt JSON was consumed above and the prompt travels by file. The
# filter prints text and tool calls for the live view and writes usage from the final result
# frame. The exit code is grok's.
grok "${ARGS[@]}" < /dev/null \
  | python3 -u -c '
import json, os, sys
# streaming-messages-json: a system/init frame (model, tools), assistant frames (content
# blocks: thinking, text, tool_use), and one final result frame with usage, modelUsage,
# total_cost_usd, num_turns and durations. Anything unparseable passes through verbatim so
# the live view never swallows a crash.
_model = None
_lines = 0
_result = None
_saw = set()
def _num(v):
    return v if isinstance(v, (int, float)) and v >= 0 else None
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    _lines += 1
    try: ev = json.loads(raw)
    except ValueError:
        print(raw, flush=True); continue
    if not isinstance(ev, dict): continue
    t = ev.get("type")
    _saw.add(str(t))
    if t == "system" and isinstance(ev.get("model"), str) and ev["model"]:
        _model = ev["model"]
        continue
    if t == "assistant":
        msg = ev.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict): continue
                if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                    print("says: " + " ".join(b["text"].split())[:400], flush=True)
                elif b.get("type") == "tool_use":
                    print("uses " + str(b.get("name", "?")) + ": " + json.dumps(b.get("input"))[:160], flush=True)
        if isinstance(msg, dict) and isinstance(msg.get("model"), str) and msg["model"]:
            _model = msg["model"]
        continue
    if t == "result":
        _result = ev
        if ev.get("is_error"):
            print("[cell] result is_error, stop: " + str(ev.get("stop_reason", ""))[:200], flush=True)
        continue
_usage = {"model": _model, "input_tokens": None, "output_tokens": None,
          "cache_read_input_tokens": None, "cache_creation_input_tokens": None,
          "reasoning_tokens": None, "duration_ms": None, "turns": 0,
          "cost_usd": None}
_bad = None
_note = None
if not isinstance(_result, dict):
    _bad = "no result frame in %d stream lines (types: %s)" % (_lines, ", ".join(sorted(_saw)[:12]) or "none")
else:
    u = _result.get("usage") or {}
    if isinstance(u, dict):
        for ours, key in (("input_tokens", "input_tokens"),
                          ("output_tokens", "output_tokens"),
                          ("cache_read_input_tokens", "cache_read_input_tokens"),
                          ("cache_creation_input_tokens", "cache_creation_input_tokens"),
                          ("reasoning_tokens", "reasoning_tokens")):
            v = _num(u.get(key))
            if v is not None: _usage[ours] = v
    v = _num(_result.get("duration_ms"))
    if v is not None: _usage["duration_ms"] = v
    # duration_api_ms is the summed *reported* per-call model time; calls that report nothing
    # contribute 0, so it can under-count. Recorded verbatim: it feeds display sums only.
    v = _num(_result.get("duration_api_ms"))
    if v is not None: _usage["api_ms"] = v
    v = _num(_result.get("num_turns"))
    if v is not None: _usage["turns"] = int(v)
    # Fail-closed zeros, per the headless docs, not per paranoia. The Messages schema has no
    # marker for missing usage, so any bucket grok cannot account for falls back to 0, and an
    # all-zero usage means the ledger was incomplete or absent: "unknown", not "free".
    buckets = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    # Absence, not _bad: the frame arrived and the known fields (model, turns, durations) stay
    # on the record, the muse convention for unknown cost. Caps refuse on the nulls exactly as
    # they would on _bad, and nothingRan cannot mistake them for a plan-window kill.
    if all((_usage[b] or 0) == 0 for b in buckets):
        for b in buckets: _usage[b] = None
        _note = "ledger incomplete or absent, unknown not free"
    else:
        _note = None
    v = _result.get("total_cost_usd")
    if _num(v) is not None and v > 0:
        _usage["cost_usd"] = v
    mu = _result.get("modelUsage")
    if isinstance(mu, dict) and len(mu) == 1 and _usage["model"] is None:
        _usage["model"] = next(iter(mu))
rec = dict(_usage)
rec["executor"] = "grok"
if rec["cost_usd"] is not None:
    rec["cost_basis"] = "reported"
elif isinstance(_result, dict) and _result.get("total_cost_usd") == 0:
    rec["cost_basis"] = "unreported: total_cost_usd 0 is the unknown-cost fallback, not a price"
else:
    rec["cost_basis"] = "unreported: no total_cost_usd on the result frame"
if _bad: rec["_bad"] = _bad
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as err:
    print("[cell] could not write usage: " + str(err), flush=True)
if _bad:
    print("usage: none recorded (%s)" % _bad, flush=True)
elif _note:
    print("usage: unknown (%s); model=%s turns=%s" % (_note, rec["model"], rec["turns"]), flush=True)
else:
    print("usage: out=%s in=%s cache_read=%s cost=%s turns=%s model=%s" % (
        rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
        rec["cost_usd"], rec["turns"], rec["model"]), flush=True)
'
STATUS=${PIPESTATUS[0]}

# Bring back what was moved aside, only where the agent left nothing: a file there now is the
# agent's work and wins; the tracked original stays reachable in git either way.
for CLAUDEMEM in $MOVED; do
  if [ ! -e "$CLAUDEMEM" ] && [ -f "$CONF/claude-away/$CLAUDEMEM" ]; then
    mv "$CONF/claude-away/$CLAUDEMEM" "$CLAUDEMEM"
  fi
done

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

# A handback that names a wall means the agent did not finish, whatever grok exited with.
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
