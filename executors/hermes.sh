#!/usr/bin/env bash
# Run one headless Hermes Agent attempt. stdin is attempt JSON; the harness owns commits.
# Hermes Agent v0.21.5 stream-json supplies tokens and duration but no dollar cost.
# No per-invocation git denial was found. The prompt contract is the git guard.
# TERMINAL_ENV=local and TERMINAL_CWD pin the terminal unless the profile explicitly
# sets terminal.backend or terminal.cwd. Hermes config overrides those environment values.
# --in pins the CLI process cwd, but cannot override an explicit remote backend.
# Verified with a real Hermes Agent cell: it fixed a planted bug, the check passed, and it landed.
set -uo pipefail
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-hermes.XXXXXX") || exit 1
  cat "${BASH_SOURCE[0]}" > "$_copy" || exit 1
  OSTOYAE_EXEC_COPY="$_copy" exec bash "$_copy" "$@"
fi
rm -f "$OSTOYAE_EXEC_COPY"

ATTEMPT=$(cat)
WHAT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a.get("what") or a["of"])')
MODEL=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("model","") or "")')
EFFORT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("params",{}).get("effort","") or "")')
KIND=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("kind") or "prove")')
MAXT=$(printf '%s' "$ATTEMPT" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("params",{}).get("max_turns"); print(v if isinstance(v,int) and not isinstance(v,bool) and v>0 else "")')
CONF=$(mktemp -d "${TMPDIR:-/tmp}/ostoyae-hermes-conf.XXXXXX") || exit 1
trap 'rm -rf "$CONF"' EXIT
{ cat AGENTS.md; printf '\n\n'; printf '%s\n' "$WHAT"; } > "$CONF/prompt.txt"
TOOLS=terminal,file,todo
[ -n "${OSTOYAE_WEB:-}" ] && TOOLS="$TOOLS,web"
ARGS=(chat --query-file "$CONF/prompt.txt" --format stream-json --yolo --source tool
  --ignore-rules --in "$PWD" -t "$TOOLS")
[ -n "$MODEL" ] && ARGS+=(-m "$MODEL")
[ -n "$EFFORT" ] && ARGS+=(--reasoning "$EFFORT")
[ -n "$MAXT" ] && ARGS+=(--max-turns "$MAXT")
echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
TERMINAL_ENV=local TERMINAL_CWD="$PWD" hermes "${ARGS[@]}" < /dev/null \
  | python3 -u -c '
import json, os, sys
model = None
result = None
turns = 0
lines = 0
seen = set()
# Hermes streams its reply in fragments that split words ("ocked me."). Buffer them and print
# whole lines; whatever is left is printed when anything else happens or the stream ends.
said = ""
def say(final=False):
    global said
    while "\n" in said:
        line, said = said.split("\n", 1)
        if line.strip(): print("says: " + " ".join(line.split())[:400], flush=True)
    if not final and len(said) > 400 and " " in said:
        line, said = said.rsplit(" ", 1)
        print("says: " + " ".join(line.split())[:400], flush=True)
    if final:
        if said.strip(): print("says: " + " ".join(said.split())[:400], flush=True)
        said = ""
for raw in sys.stdin:
    raw = raw.strip()
    if not raw: continue
    lines += 1
    try: ev = json.loads(raw)
    except ValueError:
        say(True); print(raw, flush=True); continue
    if not isinstance(ev, dict): continue
    kind = ev.get("type")
    seen.add(str(kind))
    if kind == "text" and isinstance(ev.get("text"), str):
        said += ev["text"]; say(); continue
    say(True)
    if kind == "system" and ev.get("subtype") == "init":
        model = ev.get("model") or model
    elif kind == "tool_use":
        turns += 1
        print("uses " + str(ev.get("name", "?")) + ": " + json.dumps(ev.get("input"))[:160], flush=True)
    elif kind == "result":
        result = ev
        if ev.get("error"):
            print("[cell] error: " + str(ev["error"])[:200], flush=True)
say(True)
def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None
rec = {"executor":"hermes", "model":model, "input_tokens":None, "output_tokens":None,
       "cache_read_input_tokens":None, "cache_creation_input_tokens":None,
       "cost_usd":None, "cost_basis":"Hermes reports tokens, not cost", "duration_ms":None,
       "turns":turns}
if result is None:
    rec["_bad"] = "no result frame in %d stream lines (types: %s)" % (lines, ", ".join(sorted(seen)))
else:
    tokens = result.get("tokens") or {}
    if isinstance(tokens, dict):
        for ours, theirs in (("input_tokens","input"), ("output_tokens","output"),
                             ("cache_read_input_tokens","cache_read"),
                             ("cache_creation_input_tokens","cache_write")):
            rec[ours] = number(tokens.get(theirs))
    if all((rec[key] or 0) == 0 for key in ("input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens")):
        for key in ("input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"):
            rec[key] = None
    rec["duration_ms"] = number(result.get("duration_ms"))
    if result.get("exit_code") not in (None, 0):
        rec["_bad"] = "Hermes result exit_code %s" % result["exit_code"]
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as err:
    print("[cell] could not write usage: " + str(err), flush=True)
print("usage: out=%s in=%s cache_read=%s turns=%s model=%s" % (
    rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
    rec["turns"], rec["model"]), flush=True)
'
STATUS=${PIPESTATUS[0]}

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

# A handback that names a wall means the agent did not finish, whatever Hermes exited with.
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
