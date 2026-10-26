#!/usr/bin/env bash
# Run one headless OpenCode attempt. stdin is attempt JSON; the harness owns commits.
# Verified against the real CLI 2.1.4 on 2026-10-26 (prove and one-turn runs).
# Effort rides as --model provider/model#variant, which is 2.1.4 help, not a probed run.
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
#
# OpenCode 2.1.4 does not always get to emit step_finish: its run loop stops consuming
# session events once execution settles, and the reconciliation it then does from
# message.list re-emits text and tool_use only, so a run can print the agent's words and no
# step_finish at all (observed on all four 2026-10-26 endpoint probes). The stream stays the
# primary source; when it carries no complete usage the adapter asks the CLI for its own
# record of the session it just ran (`opencode session export <id>`) and reports those
# numbers, labelled as recovered and as a pricing-table price. When that record is missing,
# unreadable, for another session, or incomplete, the numbers stay unknown: never zero,
# never a partial sum passed off as the total, and never a guess.
opencode "${ARGS[@]}" -- "$WHAT" < /dev/null \
  | MODEL="$MODEL" python3 -u -c '
import json, math, os, shutil, subprocess, sys, time
start = time.time()
inp = out = cr = cw = 0; cost = 0.0; steps = 0
sid = None
def add(total, value):
    if total is None or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return total + value
def ok(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
def session_usage(session):
    """The usage OpenCode itself recorded for one session, or None if unreadable or a different session."""
    exe = shutil.which("opencode")
    if not session or not exe:
        return None
    try:
        p = subprocess.run([exe, "session", "export", session], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    try:
        doc = json.loads(p.stdout.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(doc, dict):
        return None
    info = doc.get("info")
    if not isinstance(info, dict) or info.get("id") != session:
        return None
    tk = info.get("tokens") if isinstance(info.get("tokens"), dict) else {}
    cache = tk.get("cache") if isinstance(tk.get("cache"), dict) else {}
    msgs = doc.get("messages") if isinstance(doc.get("messages"), list) else []
    steps = [m for m in msgs if isinstance(m, dict) and m.get("type") == "assistant"]
    sums = [0, 0, 0, 0, 0.0]
    for m in steps:
        mt = m.get("tokens") if isinstance(m.get("tokens"), dict) else {}
        mc = mt.get("cache") if isinstance(mt.get("cache"), dict) else {}
        row = [mt.get("input"), mt.get("output"), mc.get("read"), mc.get("write"), m.get("cost")]
        if not all(ok(v) for v in row):
            sums = None; break
        sums = [a + b for a, b in zip(sums, row)]
    # The session info totals also carry the title-generation call OpenCode makes for the
    # session, which no step_finish ever reported. Summing the recorded steps keeps the same
    # accounting rule as the stream; the info total is used only when the steps do not say.
    if sums is not None and steps:
        return {"input": sums[0], "output": sums[1], "cache_read": sums[2],
                "cache_write": sums[3], "cost": sums[4], "steps": len(steps), "from": "steps"}
    if all(ok(v) for v in [tk.get("input"), tk.get("output"), cache.get("read"), cache.get("write"), info.get("cost")]):
        return {"input": tk["input"], "output": tk["output"], "cache_read": cache["read"],
                "cache_write": cache["write"], "cost": info["cost"],
                "steps": len(steps) or None, "from": "session totals"}
    return None
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try: ev = json.loads(raw)
    except ValueError:
        print(raw, flush=True); continue
    if sid is None and isinstance(ev.get("sessionID"), str): sid = ev["sessionID"]
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
stream_complete = bool(steps) and all(v is not None for v in [inp, out, cr, cw, cost])
recovered = None
if not stream_complete:
    recovered = session_usage(sid)
complete = stream_complete or recovered is not None
if recovered is not None:
    inp, out, cr, cw = recovered["input"], recovered["output"], recovered["cache_read"], recovered["cache_write"]
    cost = recovered["cost"]
    steps = steps or recovered["steps"] or 0
if complete:
    basis = ("summed from OpenCode step_finish parts; OpenCode pricing" if stream_complete else
             "summed over the steps OpenCode recorded for this run in its own session record (opencode session export, %s), read because the run stream emitted no complete step_finish; priced from its pricing table, an API-equivalent price, not a bill" % recovered["from"])
else:
    basis = "unreported: OpenCode emitted no complete step_finish and its session record could not be read"
rec = {
    "executor": "opencode", "model": os.environ["MODEL"] or None,
    # A partial sum is kept beside _bad so the record shows what was seen, never as a total.
    "input_tokens": inp if (complete or steps) else None, "output_tokens": out if (complete or steps) else None,
    "cache_read_input_tokens": cr if (complete or steps) else None, "cache_creation_input_tokens": cw if (complete or steps) else None,
    "cost_usd": cost if (complete or steps) else None, "cost_basis": basis,
    "duration_ms": int((time.time() - start) * 1000), "api_ms": None,
    "turns": None, "steps": steps if complete or steps else None,
}
if not complete:
    rec["_bad"] = ("OpenCode emitted no step_finish event and no readable session record" if not steps
                   else "OpenCode emitted incomplete or invalid usage and no readable session record; missing totals remain unknown")
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as e:
    print("[cell] could not write usage: " + str(e), flush=True)
    sys.exit(1)
print("usage: out=%s in=%s cache_read=%s cost=%s steps=%s%s" % (
    rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
    ("$%.4f" % cost) if complete else "?", rec["steps"],
    " (session record)" if complete and not stream_complete else ""), flush=True)
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
