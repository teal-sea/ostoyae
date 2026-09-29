#!/usr/bin/env bash
# Run one headless Aider attempt. stdin is attempt JSON; the harness owns commits.
# This adapter has stub contract coverage but has not been verified with a real agent.
# Effort flag from Aider docs; Aider is not installed on this machine.
set -uo pipefail

# Run from a private copy, for the reason claude.sh gives.
if [ -z "${OSTOYAE_EXEC_COPY:-}" ]; then
  _copy=$(mktemp "${TMPDIR:-/tmp}/ostoyae-aider.XXXXXX") || exit 1
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
[ -n "$MAXT" ] && echo "[cell $OSTOYAE_ATTEMPT] params.max_turns=$MAXT ignored: Aider has no turn cap, one --message is one reply"

mkdir -p .ostoyae
: > .ostoyae/aider.env

ARGS=(--message "$WHAT" --yes-always --read AGENTS.md
      --no-auto-commits --no-dirty-commits --no-gitignore --no-suggest-shell-commands --no-auto-lint
      --chat-history-file .ostoyae/aider.chat.history.md --input-history-file .ostoyae/aider.input.history
      --env-file .ostoyae/aider.env
      --no-pretty --no-stream --no-fancy-input --no-detect-urls
      --no-check-update --no-show-release-notes --no-analytics)
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
[ -n "$EFFORT" ] && ARGS+=(--reasoning-effort "$EFFORT")

echo "[cell $OSTOYAE_ATTEMPT] $WHAT"
START_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
# Aider prints plainly with --no-pretty, so its output is the live view as it is. The filter
# passes every line through and reads the "Tokens: ... Cost: ..." lines into usage.json at the
# end. The exit code is aider's.
aider "${ARGS[@]}" < /dev/null 2>&1 \
  | START_MS="$START_MS" MODEL="$MODEL" python3 -u -c '
import json, os, re, sys, time
tok = re.compile(r"Tokens:\s*([\d.]+k?) sent(?:,\s*([\d.]+k?) cache write)?(?:,\s*([\d.]+k?) cache hit)?,\s*([\d.]+k?) received\.")
cost = re.compile(r"Cost:\s*\$([\d.]+) message,\s*\$([\d.]+) session\.")
def n(s):
    if s is None: return 0
    return int(round(float(s[:-1]) * 1000)) if s.endswith("k") else int(float(s))
sent = recv = cw = ch = 0; turns = 0; session = None; seen_tokens = False
for raw in sys.stdin:
    print(raw.rstrip("\n"), flush=True)
    m = tok.search(raw)
    if m:
        seen_tokens = True; turns += 1
        sent += n(m.group(1)); cw += n(m.group(2)); ch += n(m.group(3)); recv += n(m.group(4))
    c = cost.search(raw)
    if c: session = float(c.group(2))
rec = {
    "executor": "aider", "model": os.environ["MODEL"] or None,
    "input_tokens": sent if seen_tokens else None,
    "output_tokens": recv if seen_tokens else None,
    "cache_read_input_tokens": ch if seen_tokens else None,
    "cache_creation_input_tokens": cw if seen_tokens else None,
    "cost_usd": session,
    "cost_basis": ("Aider'"'"'s own rounded Tokens:/Cost: lines, summed over replies; session total from the last Cost: line"
                   if session is not None else
                   "tokens from Aider'"'"'s rounded Tokens: lines; no Cost: line, Aider has no pricing for this model"),
    "duration_ms": int(time.time() * 1000) - int(os.environ["START_MS"]),
    "api_ms": None, "turns": turns if seen_tokens else None,
}
if not seen_tokens: rec["_bad"] = "Aider printed no Tokens: line"
try:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/usage.json", "w") as f: json.dump(rec, f)
except OSError as e:
    print("[cell] could not write usage: " + str(e), flush=True)
print("usage: out=%s in=%s cache_read=%s cost=%s turns=%s" % (
    rec["output_tokens"], rec["input_tokens"], rec["cache_read_input_tokens"],
    ("$%.2f" % session) if session is not None else "?", rec["turns"]), flush=True)
'
STATUS=${PIPESTATUS[0]}

# claude.sh's commit, with one more exclusion: Aider's own files in the worktree root, which are
# state and not work. `.aider*` matches the tags cache and anything else it names that way.
commit_work() {
  if [ -n "$(git status --porcelain -- . ':(exclude).ostoyae' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md' ':(exclude).aider*')" ]; then
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
    if not s or s in ("AGENTS.md", "CLAUDE.md", ".ostoyae") or s.startswith(".aider") or s.startswith(".ostoyae/"):
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

# A handback that names a wall means the agent did not finish. Aider exits 0 whenever it started,
# so the exit code says nothing about the work and this has to.
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
