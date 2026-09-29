#!/usr/bin/env bash
# Run one headless Muse attempt. stdin is attempt JSON; the harness owns commits.
# Muse's stream has no usage; model_completed records in its session log supply tokens
# and turns. The CLI reports no dollar cost, so cost_usd remains unknown.
set -uo pipefail

# Run from a private copy, for the reason claude.sh gives: bash reads a script as it runs it, and
# an edit to this file would land inside every cell partway through the old bytes.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-muse.XXXXXX") || exit 1
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
CONF=$(mktemp -d "${TMPDIR:-/tmp}/ostoyae-muse-conf.XXXXXX") || exit 1
trap 'rm -rf "$CONF"' EXIT
printf '%s' "$WHAT" > "$CONF/prompt.txt"

ARGS=(exec --json --disable-approval --sandbox-network enabled --trust-workspace --workspace "$PWD" --prompt-file "$CONF/prompt.txt")
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
[ -n "$EFFORT" ] && ARGS+=(--reasoning-effort "$EFFORT")
[ -n "$MAXT" ] && ARGS+=(--max-model-steps "$MAXT")
# Web tools default on; a cell gets them only when the graph says so, the way claude.sh grants
# WebSearch and WebFetch only under OSTOYAE_WEB.
[ -z "${OSTOYAE_WEB:-}" ] && ARGS+=(--disable-web-tools)

if [ -n "${OSTOYAE_LINKED:-}" ]; then
  echo "[cell $OSTOYAE_ATTEMPT] linked caches are not opened: no muse flag for them was found"
fi
if [ -n "${OSTOYAE_LEAN_MCP:-}" ]; then
  echo "[cell $OSTOYAE_ATTEMPT] Lean language server is not attached: no muse flag for it was found"
fi

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
# stdin is /dev/null: the attempt JSON was consumed above and the prompt travels by file. The
# filter prints text and tool calls for the live view, then reads usage out of the run session
# log (the stream carries none). The exit code is muse's.
muse "${ARGS[@]}" < /dev/null \
  | python3 -u -c '
import datetime, json, os, sys, time
# The --json stream carries text, tool calls and the terminal record, but no usage. Usage lives
# in the run session log, which this session leaves behind (logging stays on for exactly this
# reason). The stream gives the live view plus the session id; the log gives the numbers.
_sid = None
_model = None
_lines = 0
_kinds = set()
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
    s = ev.get("stream")
    sid = s.get("id") if isinstance(s, dict) else None
    if isinstance(sid, str) and sid and _sid is None:
        _sid = sid
    pt = ev.get("payload_type")
    p = ev.get("payload") or {}
    if not isinstance(p, dict): continue
    if pt == "run.model.configured":
        if isinstance(p.get("model_id"), str) and p["model_id"]:
            _model = p["model_id"]
        continue
    if pt == "run.output.delta":
        txt = p.get("text") or ""
        if isinstance(txt, str) and txt.strip():
            print("says: " + " ".join(txt.split())[:400], flush=True)
        continue
    if pt == "tool.result":
        facts = p.get("correlation_facts") or p.get("edit_facts") or {}
        name = facts.get("tool_name", "?") if isinstance(facts, dict) else "?"
        what = (p.get("edit_facts") or {}).get("path") or p.get("text") or ""
        print("uses " + str(name) + (": " + " ".join(str(what).split())[:160] if what else ""), flush=True)
        continue
    if pt == "run.terminal.completed":
        txt = p.get("text") or ""
        if isinstance(txt, str) and txt.strip():
            print(txt, flush=True)
        if p.get("reason"):
            print("[cell] terminal reason: " + str(p["reason"])[:200], flush=True)
        continue
    e = p.get("event") or {}
    if isinstance(e, dict) and isinstance(e.get("kind"), str):
        _kinds.add(e["kind"])
        if e["kind"] == "failed":
            print("[cell] task failed: " + str(e.get("reason", ""))[:200], flush=True)
# Usage, from the session log. One model_completed record per model call; token counts and
# durations sum (input grows per call while output stays per-call, so each record is one call).
_usage = {"model": _model, "input_tokens": None, "output_tokens": None,
          "cache_read_input_tokens": None, "cache_creation_input_tokens": None,
          "reasoning_tokens": None, "duration_ms": None, "turns": 0}
_bad = None
if _sid is None:
    _bad = "no session id in %d stream lines (kinds: %s)" % (_lines, ", ".join(sorted(_kinds)[:12]) or "none")
else:
    root = os.environ.get("XDG_DATA_HOME") or os.path.join(os.environ.get("HOME", ""), ".local", "share")
    today = datetime.date.today()
    cands = [os.path.join(root, "muse", "sessions", "%d" % d.year, "%02d" % d.month, "%02d" % d.day, _sid, "session.jsonl")
             for d in (today, today - datetime.timedelta(days=1))]
    seen = set()
    for _try in range(6):
        for cand in cands:
            try:
                with open(cand) as f:
                    for line in f:
                        line = line.strip()
                        if not line: continue
                        try: rec = json.loads(line)
                        except ValueError: continue
                        if not isinstance(rec, dict): continue
                        rid = rec.get("id")
                        if rid is not None:
                            if rid in seen: continue
                            seen.add(rid)
                        ev2 = (rec.get("payload") or {}).get("event") or {}
                        if not isinstance(ev2, dict) or ev2.get("kind") != "model_completed": continue
                        u = ev2.get("usage") or {}
                        if isinstance(u, dict):
                            for ours, key in (("input_tokens", "input_tokens"),
                                              ("output_tokens", "output_tokens"),
                                              ("cache_read_input_tokens", "cached_tokens"),
                                              ("cache_creation_input_tokens", "cache_write_tokens"),
                                              ("reasoning_tokens", "reasoning_tokens")):
                                v = _num(u.get(key))
                                if v is not None: _usage[ours] = (_usage[ours] or 0) + v
                        v = _num(ev2.get("duration_ms"))
                        if v is not None: _usage["duration_ms"] = (_usage["duration_ms"] or 0) + v
                        _usage["turns"] += 1
                        if isinstance(ev2.get("model"), str) and ev2["model"] and _usage["model"] is None:
                            _usage["model"] = ev2["model"]
            except OSError:
                continue
        if _usage["turns"] > 0: break
        time.sleep(1)
    if _usage["turns"] == 0:
        _bad = "no model_completed record for session %s in %s" % (_sid, " or ".join(cands))
rec = dict(_usage)
rec["executor"] = "muse"
rec["cost_usd"] = None
rec["cost_basis"] = "unreported: usage records carry tokens, not dollars"
if _bad: rec["_bad"] = _bad
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as err:
    print("[cell] could not write usage: " + str(err), flush=True)
if _bad:
    print("usage: none recorded (%s)" % _bad, flush=True)
else:
    print("usage: out=%s in=%s cache_read=%s cost=? (%s) turns=%s model=%s" % (
        rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
        rec["cost_basis"], rec["turns"], rec["model"]), flush=True)
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

# A handback that names a wall means the agent did not finish, whatever muse exited with.
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
