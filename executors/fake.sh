#!/usr/bin/env bash
# Scripted executor for tests and demos. It makes no model calls.
# params.fake.map, prove, and verify select outcomes; arrays select by attempt number
# and repeat their last entry. params.fake.sleep delays the attempt, params.fake.usd
# supplies reported cost, and params.fake.answer adds a prove answer.
set -uo pipefail

ATTEMPT=$(cat)
field() { printf '%s' "$ATTEMPT" | python3 -c "import json,sys; a=json.load(sys.stdin); $1"; }

# What this attempt says it cost. Written first, so it is on the record even when the attempt
# goes on to wall or fail, which is how a real executor behaves: the model was paid either way.
USD=$(field 'print(((a.get("params") or {}).get("fake") or {}).get("usd") or 0)')
EFFORT=$(field 'print(((a.get("params") or {}).get("effort") or (a.get("params") or {}).get("reasoning_effort") or ""))')
if [ "$USD" != "0" ] || [ -n "$EFFORT" ]; then
  mkdir -p .ostoyae
  python3 -c '
import json, sys
usd = float(sys.argv[1]); effort = sys.argv[2]
json.dump({"model": "fake", **({"effort": effort} if effort else {}), "cost_usd": usd if usd else None, "input_tokens": 0,
           "output_tokens": int(usd * 1000), "duration_ms": 0, "turns": 1},
          open(".ostoyae/usage.json", "w"), indent=2)
' "$USD" "$EFFORT"
fi

ID=$(field 'print(a["id"])')
OF=$(field 'print(a["of"])')
KIND=$(field 'print(a.get("kind") or "prove")')
SLEEP=$(field 'print(((a.get("params") or {}).get("fake") or {}).get("sleep") or 0)')

# The sleep is the agent thinking. It talks while it thinks, one line a second, and half way
# through it writes a first draft of its report, so the page can show a node thinking and an
# edge appearing before the attempt settles, the way a real agent told to write as it goes would.
if [ "$SLEEP" != "0" ]; then
  python3 -c '
import json, os, sys, time
a = json.loads(sys.argv[1]); n = int(float(sys.argv[2]))
fake = (a.get("params") or {}).get("fake") or {}
of, aid, kind = a["of"], a["id"], a.get("kind") or "prove"
lines = [f"reading the code for {of}", f"searching the repo for what {of} uses", f"working out what {of} needs",
         "writing down what I found", "checking it once more"]
draft = fake.get("map") if kind == "map" else None
for i in range(n):
    print(f"[{aid}] " + lines[i % len(lines)], flush=True)
    if i == n // 2 and isinstance(draft, dict):
        os.makedirs(".ostoyae", exist_ok=True)
        partial = {k: v for k, v in draft.items() if k in ("work", "edges", "wall")}
        with open(".ostoyae/report.json", "w") as f: json.dump(partial, f, indent=2)
        print(f"[{aid}] first draft of the report is written", flush=True)
    time.sleep(1)
' "$ATTEMPT" "$SLEEP"
fi

# A verify attempt reads what it is judging from .ostoyae/verify.json and hands back one verdict
# per proposal, plus one on the wall when there is one. It commits nothing.
if [ "$KIND" = verify ]; then
  python3 -c '
import json, os, sys
a = json.loads(sys.argv[1])
params = a.get("params") or {}
fake = params.get("fake") or {}
of, aid = a["of"], a["id"]
say = lambda did: print(f"[{aid}] {did}", flush=True)
if "verify" in fake and fake["verify"] is None:
    say("handed back nothing, exit 1"); sys.exit(1)
try:
    v = json.load(open(".ostoyae/verify.json"))
except Exception as e:
    say(f"no verify.json to read ({e}), exit 1"); sys.exit(1)
props = v.get("proposals", [])
names = {p["id"]: (p["from"] + " → " + p["to"] if p.get("kind") == "edge" else p["id"]) for p in props}
ids = [p["id"] for p in props] + ([v["judging"]] if v.get("wall") else [])
script = fake.get("verify") or {}
out = []
for i in ids:
    s = script.get(i, True)
    if s is True: out.append({"id": i, "ok": True, "why": "needed, and nothing like it exists yet"})
    elif s is False: out.append({"id": i, "ok": False, "why": "not needed"})
    else: out.append({"id": i, "ok": False, "why": str(s)})
os.makedirs(".ostoyae", exist_ok=True)
with open(".ostoyae/report.json", "w") as f:
    json.dump({"verdicts": out}, f, indent=2); f.write("\n")
word = lambda x: names.get(x["id"], x["id"]) + (" yes" if x["ok"] else " no")
say("judged " + of + ": " + ", ".join(map(word, out)))
' "$ATTEMPT"
  exit $?
fi

# A map attempt does not touch the work and never commits. Python does the whole thing: pick the
# scripted outcome, write the report, say what it did, and exit the way the runner reads.
if [ "$KIND" = map ]; then
  python3 -c '
import json, os, sys
a = json.loads(sys.argv[1])
params = a.get("params") or {}
fake = params.get("fake") or {}
of, aid = a["of"], a["id"]
say = lambda did: print(f"[{aid}] {did}", flush=True)
def write(rep):
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/report.json", "w") as f:
        json.dump(rep, f, indent=2); f.write("\n")
if "map" not in fake:
    write({"map": {"settles": "fake default", "cost": "unknown"}})
    say(f"planned {of}"); sys.exit(0)
m = fake["map"]
if isinstance(m, list):
    n = int(params.get("attempt") or 1)
    m = m[min(n, len(m)) - 1]
if m is None:
    say("handed back nothing, exit 1"); sys.exit(1)
if m == "wall":
    write({"wall": "fake could not map",
           "work": [{"id": f"{of}-needs", "what": f"what {of} needs"}],
           "edges": [{"from": f"{of}-needs", "to": of, "why": "fake"}]})
    say(f"blocked: {of} needs something that is not there; proposed {of}-needs"); sys.exit(1)
if not isinstance(m, dict):
    say(f"params.fake.map is {m!r}, which fake.sh does not understand, exit 1"); sys.exit(1)
write(m)
if isinstance(m.get("map"), dict):
    needs = [w["id"] for w in m.get("work", [])]
    built = [n for n in needs if os.path.exists(n + ".txt")]
    missing = [n for n in needs if n not in built]
    tail = ""
    if missing and not built: tail = ": it needs " + ", ".join(missing) + ", which does not exist yet"
    elif built and not missing: tail = ": it needs " + ", ".join(built) + ", already built"
    elif needs: tail = ": " + ", ".join(built) + " is built, " + ", ".join(missing) + " is not"
    say("planned " + of + tail); sys.exit(0)
say("wrote the report as given, without a map, exit 1"); sys.exit(1)
' "$ATTEMPT"
  exit $?
fi

# A prove attempt. Python picks the outcome and writes a wall report if that is the outcome; the
# git part stays in bash, next to how claude.sh does it.
ACTION=$(python3 -c '
import json, os, sys
a = json.loads(sys.argv[1])
params = a.get("params") or {}
fake = params.get("fake") or {}
p = fake.get("prove", "done")
if isinstance(p, list):
    n = int(params.get("attempt") or 1)
    p = p[min(n, len(p)) - 1]
if p == "wall":
    os.makedirs(".ostoyae", exist_ok=True)
    rep = dict(fake.get("wall_report") or {"wall": "fake wall"})
    if "answer" in fake: rep["answer"] = fake["answer"]
    with open(".ostoyae/report.json", "w") as f:
        json.dump(rep, f, indent=2); f.write("\n")
print(p)
' "$ATTEMPT")

case "$ACTION" in
  done)
    printf 'fake work by %s on %s\n' "$ID" "$OF" > "$OF.txt"
    # The same staged-paths enumeration the real executors use: a pursuit that tracks
    # AGENTS.md (as a file or a symlink the injection replaced) must not have the contract
    # committed over it, and naming an ignored file in :(exclude) is an add error on git
    # 2.47+, which `&&` would turn into a failed commit. fake.sh never needed any of this
    # until a rehearsal pursuit tracked the path. The empty list is guarded like everywhere
    # else: an empty pathspec file stages the whole worktree, contracts included.
    PATHS=$(mktemp "${TMPDIR:-/tmp}/ostoyae-paths.XXXXXX") || { echo "[$ID] could not commit $OF"; exit 1; }
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
    if [ -s "$PATHS" ]; then
      git --literal-pathspecs -c advice.addIgnoredFile=false add -A --pathspec-from-file="$PATHS" --pathspec-file-nul --
    fi
    rm -f "$PATHS"
    git commit -qm "fake: $OF

Attempt: $ID
Work: $OF" || { echo "[$ID] could not commit $OF"; exit 1; }
    echo "[$ID] built $OF and committed $OF.txt"
    # The answer, after the commit: the runner reads the report from the worktree, and the
    # branch must not carry it, the same as a real executor's report.
    python3 -c '
import json, os, sys
a = json.loads(sys.argv[1]); fake = (a.get("params") or {}).get("fake") or {}
if "answer" in fake:
    os.makedirs(".ostoyae", exist_ok=True)
    with open(".ostoyae/report.json", "w") as f:
        json.dump({"answer": fake["answer"]}, f, indent=2); f.write("\n")
    print("[" + a["id"] + "] answered " + json.dumps(fake["answer"]) + " on " + a["of"], flush=True)
' "$ATTEMPT"
    ;;
  wall)
    echo "[$ID] blocked on $OF: something it needs is missing"
    exit 1
    ;;
  fail)
    echo "[$ID] failed on $OF, no report"
    exit 1
    ;;
  *)
    echo "[$ID] params.fake.prove is '$ACTION', which the demo agent does not understand"
    exit 1
    ;;
esac
