# Providers, machines and orchestration

The orchestrating agent uses `ostoyae`; the human follows the browser viewer. Both use the same
board, attempts and heartbeat. There is no separate conversation service or hosted control plane.

## Install and configure

Requirements: Node.js 22+, Git, Bash, Python 3 and standard macOS/Linux process tools (`ps`,
plus `sysctl` on macOS). Install the selected agent CLI separately.
There are no npm dependencies. `install.sh` installs the `ostoyae` command into `~/.ostoyae`
and `~/.local/bin` without sudo, and re-running it upgrades. From a checkout,
`npm install --global .` also works. To avoid any install, call
`/absolute/path/to/Ostoyae/bin/ostoyae`. For a machine you reach over SSH or Tailscale, see
[running on another machine](remote.md).

```sh
cd your-repository
ostoyae init --agent claude --profile auto --item "Describe the outcome"
ostoyae doctor
ostoyae dry
ostoyae go --invocations 3
ostoyae status --json
```

`--invocations` counts every recorded session, including maps and judges, across restarts.
`--launches` counts work launches in this invocation and excludes judge sessions. Dollar and
token caps depend on reported usage and are not hard provider billing limits.
`go` requires at least one positive cap; a reserve by itself does not authorize launches.

## Multiple boards

Ostoyae can run multiple independent boards in parallel, even against the same repository.
Create a separate JSON file with `init` for each campaign. New boards get distinct saved graph
identifiers, so their attempt branches, trunks and worktrees do not collide. Their cells use
`sandbox.port_base: "auto"`, which reserves distinct available ports on the machine. Existing
boards with numeric port bases keep those explicit assignments. Existing board identifiers and
attempt records are preserved; do not copy a board and clear its attempts to create new work.

```sh
ostoyae init frontend.json --agent claude --item "Build the frontend"
ostoyae init backend.json --agent claude --item "Build the backend"
ostoyae boards --json
ostoyae go --board frontend.json --invocations 3   # one agent session operates this board
ostoyae go --board backend.json --invocations 3    # another session can run this concurrently
ostoyae watch --board frontend.json --browser
ostoyae watch --board backend.json --browser
```

`--board` also works with status, doctor, dry, stop and decisions. It selects only that command's
board, not another session's. Each board's allowance is separate. These commands require the
same launch authorization as a single-board run; creating or listing boards launches nothing.

The machine-local board index contains paths only, under `$XDG_STATE_HOME/ostoyae/boards` or
`~/.local/state/ostoyae/boards`. `OSTOYAE_STATE_DIR` overrides the Ostoyae state directory.
`init`, `go`, `campaign` and browser viewing register their board. Listing also reads nearby board files
and the legacy engine `graph.local.json` inventory. Unreadable registered boards are reported
as errors. The legacy selected default applies within the engine or that board's project,
not in an unrelated directory. An explicit board path or `OSTOYAE_GRAPH` always wins.

`boards --json` includes each board's work, runner, usage and pending decisions. Its `overlaps`
array identifies identical task text after whitespace normalization. This is a lead for the
orchestrating agent, not semantic equivalence or an automatic dependency. Distinct boards do
not share accepted results automatically. Tasks that must consume the same prerequisite can
use one board with explicit dependencies; independently landed work still needs integration.

Browser viewers select free loopback ports automatically and reuse a board's existing viewer.
Set `OSTOYAE_PORT` only when a specific forwarded port is needed. Each browser tab carries its
board in its URL, so switching tabs cannot retarget another tab's decisions. Stopping one board
does not stop another board's viewer or runner.

Automatic port claims remain reserved if a runner loses track of a surviving cell. They are
not silently reused while that work might still be listening. Explicit numeric port bases
remain the operator's responsibility when running older boards concurrently.

## Continue a campaign in another session

`ostoyae campaign` carries the board, accepted work and earlier attempt branches through a
repository remote. It is included in the installed package; `bin/campaign` is the same command
for source checkouts. Give each independent campaign its own board and state branch.

```sh
ostoyae campaign --repo YOUR_REPOSITORY --board boards/project.json \
  --branch codex/project-campaign --check
ostoyae campaign --repo YOUR_REPOSITORY --board boards/project.json \
  --branch codex/project-campaign --agent codex --invocations 12 --launches 2
```

The cumulative allowance is 12 recorded sessions across firings. The per-firing work-launch
limit is 2; judge sessions also consume the cumulative allowance. A positive cumulative
invocation, dollar or token cap is required. No command here grants model-launch permission.
Routine environments that only accept `claude/` branches can use that prefix for the state
branch. The remote must also accept the graph's artifact refs and atomic pushes.

One remote ownership claim prevents two sessions from executing the same campaign. Different
graph identities have separate claims and can run concurrently. After ownership is acquired,
the latest record and all recorded attempt branches are restored. The completed board and
artifact refs are then published in one atomic update that also releases ownership.

A failed publication retains ownership and local recovery data, so another machine cannot
start from an old allowance. The command prints the recovery directory and an exact
`--publish-only` command. That command launches nothing: it refuses a live or unverified
runner, and publishes only settled local work. Repeating a confirmed publication is harmless.
If the wrapper died but its runner completed, the record can be published with the runner's
exit code reported as unknown instead of invented. An unsettled attempt must first be
reconciled through the existing runner recovery path; it is never deleted or replaced here.

`campaign.json` in the recovery directory records phase, heartbeat, recorded-session counts,
publication targets and failures. `runner.log` retains the execution output. A zero-work firing
reports its current reason explicitly. Claims never expire automatically. If the entire
machine and its unpublished work are lost, ownership remains held for operator reconciliation;
this command does not pretend the lost evidence can be reconstructed from an earlier save.

Use `--dir` to choose a recovery directory; otherwise it is `.campaign/<target-hash>` below
the caller's directory. Preserve it after an interrupted or failed publication. No live
campaign or hosted scheduler is installed by these commands.

## Provider selection

The board saves:

```json
{
  "execution": { "provider": "codex", "profile": "headless" },
  "defaults": { "model": "your-accessible-model-id" }
}
```

Execution selection is explicit `--agent` or `--exec`, then `OSTOYAE_EXEC`, then the board's
`execution`, then Claude for older boards. `--model` overrides the default for this invocation;
it does not rewrite the saved default. Work, mapper and judge parameter overrides still win
over the default. Every attempt stores the model it received.

Model IDs are opaque. The engine does not maintain an allowed-model catalog. The provider
must support the chosen ID, the backend must be reachable, and the account must have access.
An arbitrary chat/completion model does not become a coding agent merely by giving its ID.

## Provider configuration

| Selection | Model/configuration | Readiness boundary |
|---|---|---|
| `--agent claude` | Optional `--model`; saved Claude auth or explicitly passed provider environment | `claude auth status`, no model prompt |
| `--agent codex` | Explicit `--model`; Codex adapter deliberately ignores user configuration to preserve its isolation settings | `codex login status`, no model prompt |
| `--agent gemini` | Optional `--model`; explicitly pass needed Google/Gemini environment names | Installed CLI; auth and model access unverified |
| `--agent aider` | `--model` understood by Aider, including its configured backend | Installed CLI; auth and model access unverified |
| `--agent opencode` | `--model provider/model`; declared OpenCode configuration is preserved with the git denial enforced | Installed CLI; auth and model access unverified |
| `--agent muse` | Optional `--model` (e.g. `muse-spark-1.3`); explicitly pass `META_API_KEY` when that is how the box authenticates | Installed CLI; auth unverified (model access verified by live runs, 2026-09-17) |
| `--agent grok` | Optional `--model` (e.g. `grok-4.6`); grok.com login under HOME | Installed CLI; auth unverified (model access verified by live runs, 2026-09-18) |
| `--exec 'command'` | A custom attempt/handback executor, including one using a local model | Executable and configuration checks where inspectable; auth unverified |

Gemini, Aider and OpenCode adapters remain experimental. Contract rehearsals use stubs and do
not prove a particular real model, CLI version or account works. See [executors](executors.md)
for the exact adapter contract and historical real-agent evidence.

Environment values are not copied into the board. Cells receive `PATH`, `HOME`, `USER`, `SHELL`
and `TMPDIR`, plus explicitly named variables:

```sh
ostoyae init --agent aider --model YOUR_MODEL --env OPENAI_API_KEY --item "Your task"
```

`--env` stores the name in `sandbox.env_passthrough`. The value must already exist in the
execution environment. Custom `--exec` commands are saved verbatim, so keep credential values
out of those commands and use `--env` for them. Pass any required backend, project, region and
credential variables explicitly. `doctor` warns about relevant host variables missing from the cell without printing
their values. Configuration files in HOME remain available to provider CLIs. Codex's adapter
has a narrower configuration contract; arbitrary custom backends belong in a compatible adapter
or custom executor, not an assumed Codex config override.

## Where it runs

| Environment | Setup |
|---|---|
| macOS or Linux local terminal | `--profile local` or `auto`; optional `watch --browser` |
| Linux VM, SSH or CI workspace | `--profile headless`; install runtime and agent CLI inside that environment |
| Claude Code cloud session opened from a phone | `--profile claude-cloud`; run inside the cloud workspace, using the auth and network access available there |
| Windows | Run inside WSL2 or a Linux VM; native Windows shells are unsupported |
| Local-model backend | Use Aider, OpenCode or a custom executor configured for that backend; the engine does not host or download models |

Profiles affect presentation. They do not change credentials, grant permissions, open ports
publicly or install missing tools. A detached Git checkout with a commit is accepted; an unborn
repository needs a commit first. Projects can declare additional tools and probes on the board.

The browser viewer binds to loopback. For a remote machine, forward its viewer port through
your workspace's port-forwarding feature, an SSH tunnel or `tailscale serve`; the commands are
in [running on another machine](remote.md). Never `tailscale funnel`, which makes it public. The CLI does not depend on this
viewer. The phone is a client of the remote workspace, not a native execution host.

## Moving an existing run

The repository, its Ostoyae branches, the board, retained cell worktrees and logs all matter.
Copying only the JSON does not transfer commits or a running process. After moving stopped
work, update `sandbox.repo`, `sandbox.root` and machine-specific links to their destination
paths, then run `doctor` and `dry`. Preserve `attempts[]`. Do not use `init --force` to relocate
a run, because it replaces the board. The `<board>.run.json` heartbeat and
`<board>.run.json.lock` files beside the board are machine-local; do not copy them — the
next runner claims fresh ones.

Active processes cannot migrate between machines. Process birth records distinguish known
owners from recycled PIDs; unknown ownership is reported and never signalled. On the original
machine, `stop` stops new launches and lets cells finish; `stop --now` asks to kill identified
cells. The next runner inspects unsettled attempts and their handbacks.
Surviving children keep an attempt active even if their group leader exits. Stop signals go
only to verified process identities. Exit 10 means work remains or cannot be verified; exit 0
means the stop completed. Unreadable process information never means a successful stop.

Cloud suspension, VM destruction and ephemeral disks can stop or erase a run. Persist the
repository and record with the workspace's storage facilities. A profile is not a durability
service.

## Evidence and failure states

Each live run writes a heartbeat, each attempt is counted, failures retain their reason, and
the board's `last_run` says why it stopped, including a run that launched zero work. JSON status
includes unpriced and unmeasured attempts. Unknown does not mean zero.

`doctor` never sends a model prompt. It may run project-declared `sandbox.tools[].probe`
commands. Check the declared probes when using an unfamiliar board. Authentication status
alone proves neither quota nor model access.

`npm test` exercises disposable repositories, fake agents, provider stubs, installed-package
paths, budgets, identity checks, orphan recovery and stop behavior. It does not spend on models.
Browser rendering and physical-device acceptance are separate from these runtime rehearsals.
