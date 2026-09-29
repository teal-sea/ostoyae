#!/usr/bin/env bash
# Run one headless OpenCode attempt. stdin is attempt JSON; the harness owns commits.
# Effort variant from OpenCode docs; OpenCode is not installed on this machine.
# This adapter has stub contract coverage but has not been verified with a real agent.
set -uo pipefail

# Run from a private copy, for the reason claude.sh gives.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-opencode.XXXXXX") || exit 1
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
[ -n "$MAXT" ] && echo "[cell $OSTOYAE_ATTEMPT] params.max_turns=$MAXT ignored: OpenCode documents no turn cap"

# The cell's permissions, inline, last in precedence.
OPENCODE_CONFIG_CONTENT=$(WEB="${OSTOYAE_WEB:-}" python3 -c '
import json, os
config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT") or "{}")
if not isinstance(config, dict) or not isinstance(config.get("permission", {}), dict):
    raise ValueError("OPENCODE_CONFIG_CONTENT and its permission field must be JSON objects")
web = "allow" if os.environ["WEB"] else "deny"
config.setdefault("permission", {}).update({"bash": {"*": "allow", "git": "deny", "git *": "deny"},
                                         "webfetch": web, "websearch": web})
print(json.dumps(config))
') || exit 1
export OPENCODE_CONFIG_CONTENT

ARGS=(run --format json --auto)
if [ -n "$EFFORT" ]; then
  if [ -z "$MODEL" ]; then echo "[cell $OSTOYAE_ATTEMPT] effort ignored: OpenCode needs a model to carry a variant"
  elif [[ "$MODEL" != *#* ]]; then MODEL="$MODEL#$EFFORT"
  fi
fi
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
# The filter turns each JSON event into one plain line for the live view and sums the
# step_finish parts into usage.json. The exit code is opencode's.
opencode "${ARGS[@]}" -- "$WHAT" < /dev/null \
  | MODEL="$MODEL" python3 -u -c '
import json, math, os, sys, time
start = time.time()
inp = out = cr = cw = 0; cost = 0.0; steps = 0
def add(total, value):
    if total is None or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return total + value
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try: ev = json.loads(raw)
    except ValueError:
        print(raw, flush=True); continue
    t = ev.get("type"); part = ev.get("part") or {}
    if t == "text":
        s = " ".join(str(part.get("text", "")).split())
        if s: print("says: " + s[:400], flush=True)
    elif t == "tool_use":
        i = part.get("state", {}).get("input", {}) or {}
        what = i.get("command") or i.get("filePath") or i.get("path") or i.get("pattern") or i.get("url") or ""
        print("uses " + str(part.get("tool", "?")) + (": " + " ".join(str(what).split())[:160] if what else ""), flush=True)
    elif t == "step_finish":
        steps += 1
        tk = part.get("tokens")
        tk = tk if isinstance(tk, dict) else {}
        cache = tk.get("cache")
        cache = cache if isinstance(cache, dict) else {}
        inp = add(inp, tk.get("input")); out = add(out, tk.get("output"))
        cr = add(cr, cache.get("read")); cw = add(cw, cache.get("write"))
        cost = add(cost, part.get("cost"))
    elif t == "error":
        e = ev.get("error") or {}
        msg = e.get("data", {}).get("message") if isinstance(e, dict) else None
        print("[cell] agent reported an error: " + str(msg or e), flush=True)
rec = {
    "executor": "opencode", "model": os.environ["MODEL"] or None,
    "input_tokens": inp if steps else None, "output_tokens": out if steps else None,
    "cache_read_input_tokens": cr if steps else None, "cache_creation_input_tokens": cw if steps else None,
    "cost_usd": cost if steps else None,
    "cost_basis": "summed from OpenCode step_finish parts; OpenCode pricing" if steps and cost is not None else "unreported: incomplete OpenCode step_finish cost",
    "duration_ms": int((time.time() - start) * 1000), "api_ms": None,
    "turns": None, "steps": steps if steps else None,
}
if not steps: rec["_bad"] = "OpenCode emitted no step_finish event"
elif any(v is None for v in [inp, out, cr, cw, cost]):
    rec["_bad"] = "OpenCode emitted incomplete or invalid usage; missing totals remain unknown"
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as e:
    print("[cell] could not write usage: " + str(e), flush=True)
    sys.exit(1)
print("usage: out=%s in=%s cache_read=%s cost=%s steps=%s" % (
    rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
    ("$%.4f" % cost) if steps and cost is not None else "?", rec["steps"]), flush=True)
'
PIPE_CODES=("${PIPESTATUS[@]}")
STATUS=${PIPE_CODES[0]}
if [ "$STATUS" = 0 ] && [ "${PIPE_CODES[1]}" != 0 ]; then
  echo "[cell $OSTOYAE_ATTEMPT] output parsing failed (${PIPE_CODES[1]})"
  STATUS=${PIPE_CODES[1]}
fi

# Everything below is claude.sh's, unchanged.
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

# A handback that names a wall means the agent did not finish, whatever opencode exited with.
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
