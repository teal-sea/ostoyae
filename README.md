# Ostoyae

A job runner for coding agents where the jobs form a DAG, and the DAG grows while it runs.

You give it jobs. It runs an agent on each one in its own git worktree. When an agent gets stuck
because something it needs does not exist yet, it says so. The missing piece becomes a new node,
with an edge from it to the job that was stuck, and the agents build it before they go on.

![Scripted playback of the 35-job mathlib frontier, with compact display labels. Mertens's proposed chain is confirmed, built, and checked. No model calls.](docs/demo.gif)

*Armillaria ostoyae* (oh-STOY-ay) is one fungus covering 2,385 acres of Oregon, almost all of it
underground ([USDA Forest Service](https://www.fs.usda.gov/sites/nfs/files/r06/malheur/publication/Humongus%20Fungus.pdf)).
It grows toward whatever it needs. So does this.

## What it does

- Takes jobs from you, from a file, or from your GitHub issues.
- Runs each job with the agent you choose: Claude Code, Codex, Hermes, Grok, Muse, and
  [others](docs/executors.md). One board can mix them, with a model and reasoning effort per job.
- Runs independent jobs in parallel and dependent jobs in order.
- When an agent hits a wall, the wall becomes a job. Nothing is retried into the same wall.
- Runs each job's check command on a fresh checkout. Work only counts once the check passes.
- Tells running agents about each other, and warns both when two of them change the same file.
- Puts finished work on your branch with `ostoyae land`.

No npm dependencies. Node.js 22+, Git, Bash and Python 3. macOS, Linux, and Windows through WSL2.

## Try it

No API key, no model calls. Scripted agents play out the demo above in your browser.

```sh
curl -fsSL https://raw.githubusercontent.com/teal-sea/ostoyae/main/install.sh | bash
ostoyae demo
```

The installer needs no sudo. It puts Ostoyae in `~/.ostoyae` and links `~/.local/bin/ostoyae`.
Run it again to upgrade; `bash install.sh --uninstall` removes it. To install from a clone
instead, run `npm install --global .` inside it.

## Use it on your repo

```sh
cd your-repo
ostoyae init --agent claude --item "Make the flaky test deterministic"
ostoyae go --launches 3        # run agents, stopping after 3 launches
ostoyae watch --browser        # the graph, live
ostoyae land                   # take the finished work onto your branch
```

Or point it at your open bugs:

```sh
ostoyae import github OWNER/REPO --check "npm test"
ostoyae go --launches 3
ostoyae land gh-42             # one branch for that bug, plus the PR command
```

Import creates the board, skips pull requests, and asks the agent to add a regression test for
each bug. It only takes issues from people with push access, because issue text becomes the
agent's instructions. `--any-author` includes the rest once you have read them.

`go` needs a cap: `--launches N`, `--invocations N` (every agent session, including planning
and judging, across restarts), `--usd N` or `--output-tokens N`. Caps stop new launches. Work in
flight finishes, and the next run continues from the record.

`ostoyae status` says where the board is and what to do next. `ostoyae --help` has the rest.

## How it works

```
          ┌────────────────────────────────────────────┐
          │                 board.json                 │
          │     work[]     edges[]     attempts[]      │
          └────────────────────────────────────────────┘
             │                                  ▲
  ready work │                                  │  the board absorbs what
  (deps met) ▼                                  │  came back, as `proposed`
        ┌──────────────┐    handback            │
        │     cell     │  .ostoyae/report.json  │
        │  1 agent     │ ───────────────────────┘
        │  1 branch    │   { wall, work, edges }
        │  1 port      │
        └──────────────┘
                                    ┌───────────────────────┐
   nothing proposed is scheduled ──▶│  you                  │
   until it is confirmed            │  confirm  /  reject   │
                                    └───────────────────────┘
```

**The board** is a JSON file: jobs, the edges between them, and every attempt so far. It is
the whole state. Nothing lives in a database or a server.

**The cell.** Every attempt gets its own git worktree on its own branch, its own port, and a
database cloned from a template when the project has one. The environment is replaced rather
than inherited, so a `DATABASE_URL` in your shell cannot reach an agent. An attempt starts from
the trunk plus the branches of the jobs it depends on, so a dependency hands over code, not
just ordering.

**The handback.** When the agent exits, the runner reads `.ostoyae/report.json` from the
worktree:

```json
{
  "wall":  "there is no idempotency column to guard the confirm path on",
  "work":  [ { "id": "w-schema", "what": "add an idempotency key column" } ],
  "edges": [ { "from": "w-schema", "to": "w-confirm", "why": "the guard has nothing to read" } ]
}
```

Everything in it lands on the board as `proposed`, with the attempt that found it and the
date. You confirm or reject. With `--auto-advance` and a judge configured, a capped run can
confirm routes the judge has approved on its own.

**Three outcomes.** An attempt is `done`, `failed`, or `walled`: it did not finish, but it found
structure. A walled job is parked until its proposals are answered, because retrying it walks
into the same wall. Its partial work stays committed on its branch.

**The judge.** With `judge` on, nothing is taken on the agent's word. The job's `check` runs on
a fresh checkout of the branch, and its exit code decides `done`. Every handback that proposes
something gets a verify attempt, a different agent with a different prompt, which rules on each
proposal. A wall that only restates its own task counts as a failure.

**The viewer.** `ostoyae watch --browser` serves a page on `127.0.0.1` that redraws as the
runner writes the board. Jobs are nodes, attempts orbit them, and each proposal is a card that
says what yes or no would do. The page is read-only unless you start it with `--control`.

## Agents

An executor is a shell command. It gets the attempt as JSON on stdin, works in the cell, writes
its report, and exits non-zero to fail or wall. The harness commits. The agent never runs git.

| executor | agent | tested with the real agent |
|---|---|---|
| `executors/claude.sh` | Claude Code | yes, in production runs |
| `executors/codex.sh` | OpenAI Codex CLI | yes, one scratch cell |
| `executors/hermes.sh` | Hermes Agent | yes, scratch cells and a mixed board beside Claude |
| `executors/grok.sh` | Grok Code | yes, four scratch cells |
| `executors/muse.sh` | Muse Code | yes, three scratch cells |
| `executors/gemini.sh` | Gemini CLI | no, stub only |
| `executors/aider.sh` | Aider | no, stub only |
| `executors/opencode.sh` | OpenCode | no, stub only |
| `executors/fake.sh` | none | the scripted agent the demo and tests use |

`init --agent` picks one. Model IDs pass through unchanged (`--model`, `--effort`). To mix agents
on one board, set `defaults.agent`, a job's `params.agent`, `mapping.params.agent` or
`judge.params.agent`. `ostoyae doctor` checks that the agent is installed and logged in
without sending a prompt.

Running agents can talk: each is told who else is running, and `ostoyae-msg who`, `send` and
`read` work across agent types. When two attempts change the same file, Ostoyae messages both.
`go --no-messaging` turns it off.

The contract and how to write your own adapter are in [docs/executors.md](docs/executors.md).

## Where it came from

An agent proving the Hardy-Ramanujan theorem in Lean found that Mathlib lacked Mertens' second
theorem. Mertens became a job. Hardy-Ramanujan waited for it.

One head-to-head run so far: six formalization tickets that all needed the same library
vendored first. Run directly, each of the six agents vendored it for itself. Through Ostoyae, it
became one job, was built once, and five of the six tickets landed on top of it (the sixth hit
the launch cap). That is one run of each, not a controlled experiment, so there is no cost or
speed claim here. The record, including two earlier pilots where the graph lost, is in
[wiki/log](wiki/log/2026-08-31-the-recovered-ab-where-the-graph-won.md).

## More

- [Running it](docs/running.md): every command, every cap, a worked run.
- [Boards, machines and providers](docs/portability.md): several boards in one repo, remote
  machines, provider setup. Use it from Hermes with
  `hermes skills install https://raw.githubusercontent.com/teal-sea/ostoyae/main/skills/ostoyae/SKILL.md`.
- [The board format](graph.schema.md) and [example boards](examples/).
- [Design](wiki/model.md) and [open questions](wiki/open.md).
- [Contributing](CONTRIBUTING.md). `npm test` runs the whole suite with the scripted agent, no
  model calls.

Released under the [MIT license](LICENSE).
