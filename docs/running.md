# Running Ostoyae

The operational reference: every command, every cap, the viewer, automatic continuation, and
two runs shown line by line. The README has the short version.

## The commands

The CLI is the control interface for the orchestrating agent. The human watches the browser
viewer with `ostoyae watch --browser`; a terminal dashboard is also available. Every run has
a heartbeat, counted attempts, recorded failures and a final reason, including zero launches.

```
bin/ostoyae doctor                    # can this machine run it? Checks before spending
bin/ostoyae go --invocations 3         # doctor, then run with a cumulative session cap
bin/ostoyae go --launches 3           # …stopping after three agents have been launched
bin/ostoyae go --usd 15               # …stopping when $15 has been spent
bin/ostoyae go --output-tokens 200000 # …or at an output-token budget
bin/ostoyae watch                     # terminal dashboard, nothing launches
bin/ostoyae watch --browser           # human graph viewer on localhost
bin/ostoyae status --json              # machine-readable state
bin/ostoyae dry                       # walk the graph, touch nothing
bin/ostoyae confirm e-0001,w-schema   # answer proposals
bin/ostoyae status                    # what is up, and what the graph says
bin/ostoyae stop                      # stop new launches; in-flight cells finish
bin/ostoyae add "Fix the parser"      # append a work item
bin/ostoyae import github OWNER/REPO  # pull open bugs into this repo's board
bin/ostoyae land gh-42                # build a checked PR branch for one bug
```

Any of them takes a graph path. Without one, `OSTOYAE_GRAPH` wins, then `ostoyae.json` in
your current directory, then the checkout's gitignored `graph.local.json` selector. If no
board is selected, the command asks you to run `init`. Explicit paths and `OSTOYAE_GRAPH`
are relative to your current directory; paths in `graph.local.json` remain relative to the
engine checkout. The historical Mathlib board is never selected implicitly.
`OSTOYAE_PORT` moves the viewer. `OSTOYAE_EXEC` replaces the executor, which is how the whole
`go` path gets tested end to end without spending a model call: a launch path that has only ever
been tested by launching real agents is a launch path nobody tests.

`doctor` checks Claude Code with `claude auth status` and Codex with `codex login status`,
using the cell's environment. It sends no model prompt and does not establish remaining quota
or whether a particular model is accessible. Gemini, Aider, OpenCode, Muse and Grok have presence
checks only. Any `sandbox.tools[].probe` declared by a board is still executed as configured.

`go` requires at least one positive launch, invocation, dollar or output-token cap. Reserve
settings alone are not a launch cap. With `--json`, run progress goes to stderr and stdout
contains one result object. `stop` returns 10 while work is draining or ownership is unknown;
exit 0 means no identified or unverified cells remain.

### Add work and import issues

`ostoyae add [board.json] "what" [--check CMD] [--needs ID,ID] [--id ID]`
appends one active item. With no text argument and piped stdin, it adds one item per nonempty
line and skips lines starting with `#`. `--needs` ids must already exist; `--id` must be unique.
`--board FILE` selects the board by path. The command refuses while a runner owns the board.

`ostoyae import github OWNER/REPO [--label L] [--limit N] [--check CMD] [--board FILE] [--repo PATH] [--dry-run] [--any-author]`
fetches open issues from the repository's GitHub remote. `--label` is repeatable and defaults
to `bug`; `--limit` defaults to 50. `--repo` selects the checkout and `--board` selects its
board. Without a board, import creates one as `init` would. `--dry-run` prints changes and
writes nothing. Import skips pull requests, updates unstarted issues, keeps attempted items
unchanged, and reports issues confirmed closed. Every imported item instructs the executor to
add a regression test before fixing the bug. The check is `--check`, the board's
`judge.default_check`, or the command detected from the repo, in that order. If none exists,
set `work[].check` or rerun import with `--check` before landing. `OSTOYAE_GITHUB_API` changes
the API base URL for local testing. Only issues from people with push access (owner, member, collaborator) are imported by default, since issue text becomes agent instructions and the agent's code runs as the check. `--any-author` includes everyone else; the skipped issue numbers are printed.

`ostoyae land <item-id> [--board FILE]` builds `ostoyae/<item-id>` from the board's base
using the item's recorded commits and needed dependency commits, then runs its check in a fresh
worktree. It prints a `gh pr create` command but does not run it. A conflict, missing commit
range, inseparable merge commit, or failed check removes the new branch and leaves the user's
checkout untouched. Plain `ostoyae land [board.json]` keeps its existing trunk fast-forward
behavior. `--json` works for either form.

### Pointing it at a new repo

`ostoyae init` writes this block for the repository you are standing in. By hand, copy a graph,
change four things, run it.

```json
"sandbox": {
  "repo": "/absolute/path/to/the/repo",   the pursuit. Agents work in worktrees of it
  "root": "/absolute/path/for/worktrees", where cells are built. Outside the repo
  "base": "main",                         what a first attempt branches from
  "port_base": 4100,                      each cell gets port_base + n
  "link": ["node_modules"]                gitignored caches to share in. Optional
}
```

Then the work items, with `needs: []` unless an ordering is already known, and nothing else.
`bin/ostoyae dry <graph.json>` walks it and touches nothing, which is the right first move
against an unfamiliar repo.

Underneath, and still the whole surface:

```
node run.mjs <graph.json> --exec "<command>"      # run what is ready
node run.mjs <graph.json> --dry-run               # walk the graph, execute nothing
node run.mjs <graph.json> --confirm <id>[,<id>…]  # operator: accept proposals
node run.mjs <graph.json> --reject  <id>[,<id>…]  # operator: close a route
node run.mjs <graph.json> --exec "…" --keep       # leave cells standing to inspect
node run.mjs <graph.json> --exec "…" --max-launches 3
node viewer/serve.mjs <graph.json> [--port 4300]  # browser companion; capped launches and decisions
```

**`doctor` runs before every `go`, and `go` refuses to launch if it fails.** It checks the
graph parses, the pursuit is a git repo with the base ref it names, the worktree root is
writable, the linked caches exist, no stale branches from an earlier run of the same graph, and
the one that has actually failed: that the executor authenticates **using only what the cell
will hand it**. Not "is the binary on PATH", which is a different question.

The cell replaces the environment rather than extending it, so a stray `DATABASE_URL` cannot
reach an agent. What survives is `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, plus anything the
graph names in `sandbox.env_passthrough`. `USER` is there because `claude` resolves whose
keychain to open from it; without it, it reports `Not logged in`, which reads like a logout and
is a lookup failure.

**No npm dependencies.** Imports use Node builtins and local modules. `install.sh` at the
repository root installs the CLI into `~/.ostoyae` without sudo; from a checkout,
`npm install --global .` does the same job. Node 22+, Git, Bash and Python 3 are required; the chosen
agent CLI and project-specific tools are separate. See [portability](portability.md).

**`--max-launches` is a budget, not a schedule.** Sixteen work items at two attempts each is
thirty-two agent sessions, and the first question a graph answers is usually *does any of this
work at all*, which three answers as well as thirty-two. In-flight attempts finish; only new
launches stop. Everything launched is recorded, and re-running continues from there.

**`--max-usd` and `--max-output-tokens` cap spend instead of sessions**, from what
`result.usage` reports, cumulative over `attempts[]` rather than per run. Use these whenever the
number will be compared against something: a mapper run and a hard proof are both one launch and
are not both one unit of money. The evaluation of 2026-08-30 matched its arms on output tokens
and then capped the graph arm at 22 launches, which spent 11 of them on mappers and stopped the
arm at 19% of its budget with five tickets never attempted; its result measures that arithmetic
and not the graph. Spend only lands when an attempt settles, so at concurrency N a cap can
overshoot by up to N attempts. All three caps can be set at once and the first to bind stops new
launches.

**`--max-invocations` caps agent sessions across every role and across restarts.** The three
caps above cannot do that job. `--max-usd` and `--max-output-tokens` are computed from
`result.usage`, so an executor that reports nothing makes them refuse to bind rather than bind
wrongly. `--max-launches` counts work launches only, deliberately: a verify attempt is the
judge's session and not the item's, and an evaluation matched on work must not have its arms
moved by how often the judge ran. Its counter also lives in one invocation of `run.mjs`, so a
controller that restarts four times spends its cap four times. `--max-invocations` counts entries
in `attempts[]` instead, which is the durable append-only record and holds one entry per session
the runner spawned, prove, map and verify alike. It is therefore cumulative and restart-persistent
with no second counter to keep in step, and it is the only cap here that still binds when the
executor reports no usage at all. It counts an attempt that died in provisioning too, which no
model was paid for: the conservative direction, and the one that would have stopped the 79 failed
map attempts of 2026-09-03.

**A drained queue is not a finished mission, and the run says which it was.** When no budget
bound, the run used to print its report and exit, and the heartbeat file that could have said
why is deleted on a clean exit by design. Now the reason is classified in the report's own
buckets and written to `last_run` on the graph: `board-satisfied` (every check on every active
item passed, which is a fact about the board and not about the question it was built to ask),
`awaiting-decision`, `awaiting-judge`, `exhausted`, `gated` or `blocked`, each with the next
permitted action in words.

### The companion

`bin/ostoyae watch --browser`, or `node viewer/serve.mjs <graph.json>`, then `localhost:4300`.
For a cloud/VM viewer, forward this loopback port through your workspace or SSH. The server
binds only to loopback; opening a port publicly is not required.

A living population, not a diagram. Every job is a circle, sized by what it unlocks, with its
name in words underneath and its state in words: not started, working now, finished, hit a
wall, mapped, out of tries, suggested. Every run an agent made is a small circle orbiting its
job, with thin lines of descent: to the run it retried after, and to every job it gave birth to.
Arrows between jobs are what has to happen before what, confirmed solid, suggested dashed,
authored grey. Families of jobs that grew out of one original get a soft halo with a caption.
Physics moves all of it every frame and never quite stops, so a graph with nothing happening
still breathes and a graph with agents in it visibly grows. Drag a circle to move it, drag the
background to pan, scroll to zoom, click a job to light its runs, its offspring and its arrows
and to read the sentences behind them in the rail. `?sel=w-rosser` opens the page on a job.

The rail is written for the person directing the job. **Your call** has one card per run that
found something: what stopped the agent in its own words, what it says is missing, what has to
happen first, what would be unblocked, what happens if you say yes, what happens if you say no,
and a command for each answer. The consequences come from the scheduler, asked against a copy
of the graph, so the card cannot say something the runner would not do.

**It moves while the run moves.** The runner writes the graph at every launch and every settle,
through a temp file and a rename, so the page is the run rather than a picture of the run's
starting position. A running node counts up how long its attempt has been going.

**It says whether anything is actually running.** An attempt reading `running` means a runner
said so once, not that it is still there, so a page that has not moved in four minutes looks the
same whether an agent is thinking or the runner died. The runner keeps a heartbeat beside the
graph and the rail names which it is: **live** with the beat and the launch count, **wedged** for
a process that is up and has stopped beating, **gone** for one that is not there, saying how many
attempts are left reading `running` and that the next run will inspect and settle them. When the
viewer itself cannot inspect processes (a sandboxed shell), it reports **UNKNOWN**, never "gone":
an inspector that cannot see its own parent is blind, and blindness is not death. Process birth records distinguish an original
runner or cell from a recycled PID. An unknown identity is reported and never signalled.

**Yes and no are buttons.** Each card in *your call* has them; so does *everything at once*. The
server writes the decision into the graph the same way `--confirm` does, through a temp file and
a rename, with `decided_at` and `decided_via: "viewer"`, and refuses while a run is live because
the runner would write over it. The viewer answers on `127.0.0.1` only, so whoever clicks is the
operator of the machine. The ordinary viewer can launch a dollar-capped run.
`--read-only` disables every write endpoint and exposes only the selected board;
the demo uses this mode.

The derivation, `ready`, `walled`, `blocked`, lives in `viewer/state.mjs` and **`run.mjs`
imports it**, so the picture and the scheduler cannot disagree. A node drawn as launchable that
the runner refuses to launch would be worse than no picture.

The executor is any shell command. It receives the attempt as JSON on stdin, works in the cell,
and exits non-zero to fail or wall. `executors/claude.sh`, `executors/codex.sh`,
`executors/muse.sh`, and `executors/grok.sh` run the chosen agent directly.
`executors/fake.sh` is the zero-model-call executor the tests use: it reads `params.fake` and
walls, lands, fails or maps on cue, so the whole `go` path can be exercised without spending
anything.

**Map attempts and prove attempts.** The attempt JSON carries `kind`. `claude.sh` treats a map
attempt's handback as its only product: it exits 0 when the report carries a `map` object,
commits nothing, and leaves anything else the agent wrote for teardown. Nothing mechanically
stops a map agent from writing Lean; the executor only declines to keep it. The prove path is
unchanged. Real mapping and handbacks are recorded in `wiki/log/`; the
September 4 mapper comparison is one source. A working handback channel does
not establish a comparative cost or success-rate advantage.

### Bounded automatic continuation

`bin/ostoyae go path/to/board.json --launches 8 --auto-advance` opts into
confirming judged proposals during the run. It requires `judge.verify` and
a positive launch, dollar or output-token cap. Every proposed work item and
edge along the route must pass the judge and reach an original open ticket.
Rejected or refuted work, reopened edges, failed judgments and unjudged
links cannot authorize a route. `--only` limits the destination tickets.
Statement revisions remain for an explicit operator decision. Automatic
decisions record `decided_via: "auto-advance"`; settled attempts stay intact.

Without the flag, proposals park for `confirm-scoped` or an explicit decision.
A model's positive judgment is not proof that a dependency is necessary;
use meaningful mechanical `check`s and inspect the resulting graph. Caps
stop new launches and reserve estimated in-flight spend; they cannot
guarantee the final bill stays within a fixed percentage. Missing or invalid
settled usage stops a run capped in that unit rather than counting as zero.

### A mapped run

Zero model calls, the fake executor against a scratch pursuit. Five items: one map that lands,
one that proposes a lemma with two edges, one that hands back nothing, one that proposes a job
with no edge, one that walls. Cell lines trimmed.

```
map-demo  concurrency 3  max_attempts 2  mapping on, 1 map attempt per item

  a-0001   start   w-a            map
  a-0002   start   w-b            map
  a-0003   start   w-c            map
  a-0001   done    w-a            exit 0
           map     settles: a settles; cost: small
  a-0004   start   w-d            map
  a-0002   done    w-b            exit 0
           map     settles: b settles; cost: large; notes: b needs the lemma first; needs w-lemma; unlocks w-a
           found   w-lemma  proposed  work  w-lemma  prove the lemma
           found   e-0001   proposed  edge  w-lemma blocks w-b  (b uses the lemma)
           found   e-0002   proposed  edge  w-b blocks w-a  (a reads what b writes)
  a-0005   start   w-e            map
  a-0003   failed  w-c            exit 1
           said    [fake a-0003] map w-c: handed back nothing, exit 1
           note    handed back no map
  a-0006   start   w-a
  a-0004   done    w-d            exit 0
           map     settles: d settles; cost: medium
           found   w-d-extra proposed  work  w-d-extra  something extra for d
  a-0005   walled  w-e            exit 1, wall: fake could not map
           found   w-e-needs proposed  work  w-e-needs  what w-e needs
           found   e-0003   proposed  edge  w-e-needs blocks w-e  (fake)
  a-0006   failed  w-a            exit 1
           said    [fake a-0006] prove w-a: failed, exit 1 with no report
  a-0007   start   w-a            retry of a-0006
  a-0007   done    w-a            exit 0

  1 satisfied · 1 exhausted · 1 walled · 2 mapped, awaiting you · 0 ready · 0 waiting
    exhausted  w-c  after 1 map attempt, no map
    walled     w-e  awaiting the operator on w-e-needs, e-0003
    mapped     w-b  awaiting the operator on w-lemma, e-0001, e-0002
    mapped     w-d  awaiting the operator on w-d-extra
  maps: 3 of 5 active items mapped
  7 attempts recorded (5 map, 2 prove), 1 walled and 2 failed, all kept
```

Five maps before the first proof. `w-a` was mapped, then proved on its second try, and its two
prove attempts did not touch its map budget. `w-b` and `w-d` are parked on what their maps
found. `w-c` handed back nothing and is out of map attempts. `w-e` walled, which is the outcome
the repo is for, and did not spend its map attempt.

**It commits whatever the attempt wrote, wall or no wall.** The worktree is removed the moment an
attempt settles, so anything not committed is deleted. `claude.sh` used to return without
committing when the report named a wall, and on 2026-08-29 that cost two real proofs in a single
run: one attempt reported `lean/Frontier/Mertens.lean` building sorry-free with axioms exactly
`[propext, Classical.choice, Quot.sound]`, another left `lean/Frontier/Rosser.lean` carrying the
exact reduction of Rosser to `π(x)·log π(x) < x`, and both branches ended up pointing at the same
commit as `main`. Only the prose in the handback survived. A walled attempt did not do the work
and did find structure, and its partial work is part of what it found. The commit subject is
prefixed `walled, partial work:` so the branch does not claim otherwise, and the exit code is
unchanged, so the state the runner records is unchanged.

### A worked run

Two work items, no edges between them, a fake executor. Output below is verbatim, with the
temp-directory prefix stripped.

```
$ node run.mjs wall.json --exec "bash fake.sh"

wall-demo  concurrency 2  max_attempts 3

  a-0001   start   w-confirm
  a-0001   cell    worktree wt3/wall-demo/a-0001 on ost/wall-demo/a-0001 from main
  a-0002   start   w-docs
  a-0002   cell    worktree wt3/wall-demo/a-0002 on ost/wall-demo/a-0002 from main
  [fake a-0001] w-confirm: nothing to guard on. hitting a wall, reporting it.
  [fake a-0002] w-docs: done, and noticed something else worth doing.
  a-0001   walled  w-confirm      exit 1, wall: there is no idempotency column to guard the confirm path on
           found   w-schema proposed  work  w-schema  add an idempotency key column to bookings
           found   e-0001   proposed  edge  w-schema blocks w-confirm  (the guard has nothing to read without the column)
  a-0002   done    w-docs         exit 0
           found   w-alerts proposed  work  w-alerts  alert on duplicate confirmations in prod

  1 satisfied · 0 exhausted · 1 walled · 0 ready · 0 waiting
    walled     w-confirm  awaiting the operator on w-schema, e-0001
  2 attempts recorded, 1 walled and 0 failed, all kept

  proposed, not scheduled, awaiting the operator:
    w-schema   work  add an idempotency key column to bookings found by a-0001 on 2026-08-28
    w-alerts   work  alert on duplicate confirmations in prod  found by a-0002 on 2026-08-28
    e-0001     edge  w-schema blocks w-confirm                 found by a-0001 on 2026-08-28
    confirm with:  node run.mjs wall.json --confirm w-schema,w-alerts,e-0001

  edges: 1 total · 0 confirmed · 1 found by runs, over 1 day(s) (2026-08-28)
```

A failed attempt and a successful one both proposed things. Run it again with nothing confirmed
and **no attempt starts at all**, `w-schema` is sitting in the graph as a work item with no
dependencies, and it is not launched, because nobody said yes:

```
$ node run.mjs wall.json --exec "bash fake.sh"

wall-demo  concurrency 2  max_attempts 3


  1 satisfied · 0 exhausted · 1 walled · 0 ready · 0 waiting
    walled     w-confirm  awaiting the operator on w-schema, e-0001
  2 attempts recorded, 1 walled and 0 failed, all kept
```

The operator's turn. Confirm the wall's edge and the work it needs; close the other route:

```
$ node run.mjs wall.json --confirm w-schema,e-0001 --reject w-alerts

wall-demo  operator

  w-schema   active    add an idempotency key column to bookings
  e-0001     confirmed w-schema blocks w-confirm
  w-alerts   rejected  alert on duplicate confirmations in prod

  3 changed, wrote wall.json
```

A confirmed work item becomes `active`, ordinary work, indistinguishable from something a
person typed, except that `found_by` records which attempt found it. Now the next run:

```
$ node run.mjs wall.json --exec "bash fake.sh"

wall-demo  concurrency 2  max_attempts 3

  a-0003   start   w-schema
  a-0003   cell    worktree wt3/wall-demo/a-0003 on ost/wall-demo/a-0003 from main
  [fake a-0003] w-schema: adding the column.
  a-0003   done    w-schema       exit 0
           found   w-backfill proposed  work  w-backfill  backfill idempotency keys for existing rows
  a-0004   start   w-confirm      retry of a-0001
  a-0004   cell    worktree wt3/wall-demo/a-0004 on ost/wall-demo/a-0004 from ost/wall-demo/a-0003
  [fake a-0004] w-confirm: schema.sql is here. doing the work.
  a-0004   done    w-confirm      exit 0

  3 satisfied · 0 exhausted · 0 walled · 0 ready · 0 waiting
  4 attempts recorded, 1 walled and 0 failed, all kept

  edges: 1 total · 1 confirmed · 1 found by runs, over 1 day(s) (2026-08-28)
```

Three things happened there. In the first run, concurrency 2 started both items at once; here
`w-confirm` waited, **that is the discovered edge gating**. `a-0004` branched `from
ost/wall-demo/a-0003` rather than from `main`, so the dependency handed over content and not
just ordering. And `w-alerts`, rejected, was never launched.

### The line that says whether this is working

Every run ends with:

```
edges: 4 total · 2 confirmed · 4 found by runs, over 3 day(s) (2026-08-27, 2026-08-29, 2026-09-02)
```

Edges arriving from runs, spread across the days runs happened, is the loop working. Edges
arriving in one batch means a person sat down and read handbacks, which is what the single-agent runner
this grew out of showed on its own record: 21 of 33 edges on a single day.
