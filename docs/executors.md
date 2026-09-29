# Executors

An executor runs one attempt. The runner (`run.mjs`) decides what to attempt, builds the cell
(`sandbox.mjs`), and then hands the attempt to its selected provider's executor. The executor is the only
part of Ostoyae that knows which coding agent is in the cell. Everything else reads the record the
executor leaves behind. This page is the contract, the adapters that exist, and how to write
another one. `docs/codex.md` is the long-form reference for the Codex adapter, and
`docs/muse.md` is the same for the Muse adapter, and `docs/grok.md` for the Grok one.

Set `defaults.agent`, `work[].params.agent`, `mapping.params.agent` or `judge.params.agent` to
mix providers on one board. A job's agent wins over its role's agent, which wins over the board
default. `--agent` or `--exec` on `go` overrides all of them. Each attempt records its actual
`params.agent`, `params.model` and `params.effort`. For example, map with Hermes, judge with
Codex, and prove with Claude:

```json
{
  "execution": { "provider": "claude" },
  "defaults": { "agent": "claude", "model": "sonnet" },
  "mapping": { "what": "Map this job into small tasks.", "params": { "agent": "hermes", "model": "hermes-model" } },
  "judge": { "verify": "Check each proposal.", "params": { "agent": "codex", "model": "gpt-5.2-codex", "effort": "high" } }
}
```

## The contract

**What the executor is given.**

- **stdin** is the attempt as JSON: `id`, `of` (the work item's id), `what` (the instruction),
  `kind` (`prove`, `map` or `verify`; absent means `prove`) and `params`, which may carry `model`
  and `max_turns`.
- **cwd** is the cell: a real git worktree on the attempt's own branch, based on the branches of
  the attempts it depends on. The runner has already written the contract for the agent into
  `AGENTS.md` and `CLAUDE.md` there. Those two files are excluded from git in the cell.
- **The environment is replaced.** `PATH HOME USER SHELL TMPDIR` and the selected provider's
  credential variables come through, plus whatever the graph names in `sandbox.env_passthrough`.
  On top of that the runner sets `OSTOYAE_ATTEMPT`,
  `OSTOYAE_WORK`, `OSTOYAE_BRANCH`, `OSTOYAE_WORKTREE`, `PORT` and `PYTHONDONTWRITEBYTECODE=1`
  (so Python leaves no compiled files for two cells to both "change"), and may set `OSTOYAE_LINKED`
  (colon-joined real paths of the shared caches linked into the cell), `OSTOYAE_WEB` (the cell may
  search and fetch), `OSTOYAE_TOOLS` (one declared tool command per line) and `OSTOYAE_CHECK`
  (the item's `check` command, on `prove` attempts whose item declares one; the contract in
  `AGENTS.md` names the same command under "The check"). With messaging on it also sets
  `OSTOYAE_MAILBOX` and `OSTOYAE_BOARD`, puts `ostoyae-msg` on `PATH`, and, for every agent but
  Claude and Codex, `OSTOYAE_MAIL_RELAY`.
- **Messages.** The contract lists the attempts already running when this one launched, and while
  attempts run the runner tells any two that have changed the same file, in a message from
  `ostoyae`. Claude and Codex receive unread messages after their tool calls, through a
  `PostToolUse` hook running `ostoyae-msg read --hook`; wire the same hook if your CLI has one.
  Every other agent is told in its contract to run `ostoyae-msg read` before it edits a file and
  before it finishes.
- **Git identity** is supplied in `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`
  and `GIT_COMMITTER_EMAIL`: `<agent> <attempt-id>` and `<attempt-id>@ostoyae.invalid` for
  every commit the executor makes, including a custom `--exec` script.

**What the executor must do.**

1. Run the agent headless, with `what` as the prompt (`of` if `what` is missing) and
   `params.model` as the model when it is set. Nothing may wait for a keypress.
2. Keep the agent away from git. The harness commits; an agent that commits, branches or pushes
   has broken the record. Use whatever the CLI has (a denied tool, a permission rule, a no-commit
   flag) and say in the file header how far it reaches. The contract in `AGENTS.md` tells the agent
   the same thing, and for some CLIs that text is the only guard.
3. When the agent exits, **commit whatever it wrote**, wall or no wall, success or failure, for
   `prove` attempts. `AGENTS.md`, `CLAUDE.md` and `.ostoyae/` never go in, and neither do
   `__pycache__/` or `*.pyc` unless the repository already tracks such files. `map` and `verify`
   attempts commit nothing; their product is the handback.
4. Write `.ostoyae/usage.json` with what the CLI reported: `model`, `input_tokens`,
   `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cost_usd`,
   `duration_ms`, `turns`. Put `null` for what the CLI does not report, and say why in a
   `cost_basis` string. The runner records it on the attempt and the dollar and token budgets are
   computed from it, so a missing file is an attempt that cannot be priced. When the CLI emits
   more than one result event for a session, merge them: token counts, turns and server-tool
   requests are incremental per event and sum; cost and durations are cumulative and take the
   max; an exact-duplicate event merges once. Summing cost and keeping only the last segment's
   tokens both lie, in opposite directions (2026-09-15).
5. Exit the way the runner reads:
   - `verify`: 0 if and only if `.ostoyae/report.json` carries a `verdicts` array.
   - `map`: 0 if and only if the report carries a `map` object.
   - `prove`: a `wall` in the report beats the agent's exit 0; commit the partial work and exit 1.
     An agent that exited non-zero: commit the partial work, exit 1. An agent that changed nothing:
     exit 1, because a report alone is not work. Otherwise exit 0, and the runner runs the item's
     `check` on the branch to decide whether the work is actually done.
6. Run from a private copy of the script. Bash reads a script as it executes it, and an edit to the
   file while a cell is running lands inside that cell. `claude.sh` shows the pattern; copy it.

**Letting the agent run the check.** A headless agent approves nothing, so a check the agent
cannot run is a check it can only reason about. On 2026-09-27 a first-run Claude cell fixed a
bug and wrote that running `python3` "needed approval, and nobody can approve anything in this
non-interactive session." How each adapter handles `OSTOYAE_CHECK`:

| adapter | how the agent may run the check |
|---|---|
| `claude.sh` | one exact-match rule, `Bash(<check>)`, added to the existing allow list. A rule with no `*` matches that one command, and parentheses in it are literal ([Claude Code permissions](https://code.claude.com/docs/en/permissions), read 2026-09-27). Claude Code checks each part of a compound command separately, so a check like `npm test && npm run lint` is not covered; write it as one command, for example `bash check.sh`. A `*` in the check acts as a wildcard in the rule. A multi-line check gets no rule. |
| `codex.mjs` | no rule needed: `approval_policy` is `never` and commands run inside the cell's Codex sandbox. Network is off unless the board declares tools or Lean. The git guard refuses any command containing the word `git`, so a check that calls git is refused. |
| `gemini.sh`, `grok.sh`, `muse.sh`, `opencode.sh` | no rule needed: they run with approvals off (`--approval-mode yolo`, `--permission-mode bypassPermissions`, `--disable-approval`, `--auto`), with git denied where the CLI allows it. |
| `hermes.sh` | no rule needed: `--yolo` allows the agent to run the check. The prompt carries the git restriction; Hermes has no per-invocation git deny flag. |
| `aider.sh` | not runnable: shell commands are off (`--no-suggest-shell-commands`) because `--yes-always` would run anything Aider suggested. |
| custom | read `OSTOYAE_CHECK` and grant exactly that command in whatever permission system the agent has. |

The runner still runs the check itself on what the attempt committed, in a fresh checkout. That
result decides the attempt; the agent's own run is only for the agent.

**What the executor is not.** It is not a sandbox: the cell's isolation is git, a replaced
environment and the agent's own permission system, and none of the git guards below stops code
that wants to hide a subprocess. It is not the judge: the executor says whether there is a report,
not whether the report is true.

## The adapters

| Executor | CLI version the adapter targets | Headless invocation | How git is kept away from the agent | Usage reported | Verified against a real agent? |
| --- | --- | --- | --- | --- | --- |
| `fake.sh` | none, runs no agent | scripted from `params.fake` | it commits itself, on purpose, so the runner's paths can be rehearsed | `cost_usd` from `params.fake.usd`, tokens derived | n/a, it is the rehearsal |
| `claude.sh` | Claude Code, whatever `claude` on PATH is | `claude -p <what> --permission-mode acceptEdits --output-format stream-json [--model] [--max-turns]` | `--disallowedTools "Bash(git:*)"`, plus the contract text | tokens, cache, `total_cost_usd`, `duration_ms`, `num_turns`, from the final `result` event | yes, in production since 2026-08-29 |
| `codex.sh` + `codex.mjs` | Codex CLI 0.153.4 | `codex exec --json --ephemeral ... --model <model>` | a `PreToolUse` hook denies shell invocations of git; `.git` is protected by the filesystem sandbox | tokens from `turn.completed`; dollars only when `params.codex_pricing` is given | yes, 2026-09-05, one scratch cell (see `docs/codex.md`) |
| `gemini.sh` | Gemini CLI docs at `main` on 2026-09-12 (npm 0.59.0 was current) | `gemini -p <what> --approval-mode yolo --output-format stream-json --admin-policy <toml> [-m <model>]` | an admin-tier policy rule denying `run_shell_command` with prefix `git`, and `tools.exclude ["run_shell_command(git)"]` in a system settings file the executor writes; `GEMINI_CLI_SYSTEM_SETTINGS_PATH` points at it | tokens, cached, `duration_ms`, `tool_calls` from the `result` event; no dollars | **NO** (2026-09-12); rehearsed with a stub only |
| `aider.sh` | Aider 0.86.x (options page read 2026-09-12; pypi 0.86.2 was current) | `aider --message <what> --yes-always --read AGENTS.md --no-auto-commits --no-dirty-commits --no-gitignore --no-suggest-shell-commands ... [--model]` | the no-commit flags; `--no-suggest-shell-commands` so `--yes-always` cannot run a suggested `git`; Aider's own `.aider*` files are excluded from the harness commit | tokens summed from Aider's rounded `Tokens:` lines; `cost_usd` from the last `Cost: ... session` line, null when Aider has no price for the model | **NO** (2026-09-12); rehearsed with a stub only |
| `opencode.sh` | OpenCode docs on 2026-09-12 (npm 1.18.30 was current; source at `dev`) | `opencode run --format json --auto [--model provider/model] -- <what>` | `permission.bash` rules `git` and `git *` set to `deny`, handed in through `OPENCODE_CONFIG_CONTENT`, which is last in precedence | tokens, cache and `cost` summed from `step_finish` events; the dollar figure is OpenCode's own pricing table | **NO** (2026-09-12); rehearsed with a stub only |

| `muse.sh` | Muse Code 1.3.0 (1.3.0-R3233.1); help text, binary strings, echo probes and the author's own session log read 2026-09-17 | `muse exec --json --disable-approval --trust-workspace --workspace <cell> --prompt-file <f> [--model] [--max-model-steps] [--disable-web-tools]` | none found: no flag or config input denies a command (a deny effect exists in the binary with no headless input reaching it); the contract text is the guard | stream carries text/tools/model only; per-call tokens summed from the run session log's `model_completed` records (deduped by record id); no dollars | **YES** (2026-09-17): three live scratch runs, work plus real usage recorded |
| `grok.sh` | Grok 1.0.34; `--help`, user-guide docs and headless probes read 2026-09-18 | `grok --prompt-file <f> --output-format streaming-messages-json --trust --permission-mode bypassPermissions --deny 'Bash(git *)' --deny 'MCPTool(*)' --disallowed-tools ask_user_question[,web_search,web_fetch] [-m] [--max-turns]` | `--deny 'Bash(git *)'` under bypassPermissions (probed: denied by policy), plus the contract text; tracked `.claude/CLAUDE*.md` moved aside (no compat off switch) | tokens, cache, `num_turns`, durations and `total_cost_usd` from the final `result` frame; dollars reported, so dollar caps bind; all-zero frames and zero cost record as unknown, never free | **YES** (2026-09-18): four live scratch runs (prove, map, verify, prove), work plus real usage recorded |
| `hermes.sh` | Hermes Agent 0.21.5; CLI help and source | `hermes chat --query-file <f> --format stream-json --yolo --source tool --ignore-rules --in <cell> -t terminal,file,todo[,web] [-m] [--max-turns]` | the cell contract is prepended to the prompt; no per-invocation git deny was found | tokens, cache, duration and tool-use count from stream-json; no dollars | yes, one scratch cell: fixed a planted bug, check passed, landed |

Effort passes through as supplied. The provider validates its own levels.

| Adapter | Effort argument | Status |
|---|---|---|
| Claude | `--effort LEVEL` | Verified on Claude Code 2.1.283 |
| Codex | `model_reasoning_effort=LEVEL` | Existing adapter setting; `reasoning_effort` remains an alias |
| Grok | `--reasoning-effort LEVEL` | Verified with local help |
| Muse | `--reasoning-effort LEVEL` | Verified with local help |
| Hermes | `--reasoning LEVEL` | Verified with local help |
| Aider | `--reasoning-effort LEVEL` | Docs only; CLI not installed |
| OpenCode | `--model provider/model#LEVEL` | Docs only; CLI not installed; needs a model |
| Gemini | No per-run argument | Ignored with a message |
| Fake | Recorded in usage | Rehearsal adapter |

Hermes receives `TERMINAL_ENV=local` and `TERMINAL_CWD=<cell>`. An explicit `terminal.backend`
or `terminal.cwd` in its selected profile overrides these values, so use a local terminal profile
for cell execution. `--in` also places the chat process in the cell. Hermes streams its reply in
fragments that split words; the executor buffers them and prints the reply in whole lines.

The unverified adapters were written from CLI help, documentation and source. muse.sh started the same way
and was verified against three live runs on 2026-09-17; grok.sh likewise against four live runs
on 2026-09-18. Both stay in the rehearsal. `bin/rehearse-executors`
drives each of them through the real runner with a stub CLI of that name on PATH and asserts the
contract: a finished prove records `done` with its file on the branch, a walled prove records
`walled` with partial work committed, `usage.json` is parsed from the stub's output in that CLI's
real format, the prompt and the headless flags reached the CLI, the git guard reached the CLI,
and the injected contract is not on the branch. What the rehearsal cannot say is whether the
flags mean to the real CLI what the docs say; that costs one attempt each for the adapters
without a live run. `doctor` checks only that the CLI is on the cell's PATH for these adapters; there is no
login probe.

Run one of them by naming it:

```sh
OSTOYAE_EXEC="bash $PWD/executors/gemini.sh" bin/ostoyae doctor path/to/graph.json
```

## Writing your own

Start from `executors/claude.sh` and keep its shape: the private-copy block at the top, the
attempt parsed from stdin, one CLI invocation piped through a filter that prints one plain line
per event (the runner keeps those beside the graph, and a person watches a node think through
them) and writes `usage.json`, then `commit_work` and the exit logic, which should be copied
rather than rewritten. The parts to work out for a new CLI are exactly the columns of the table
above:

- the flag that makes it run one prompt and exit without a terminal;
- the flag that picks the model, and what to do with `params.max_turns` (cap it, or say on the
  log that it is ignored; never silently substitute something else);
- the flag that approves edits and tool calls without asking, since nobody is there to answer;
- the mechanism that denies git, and how far it reaches;
- how it reports tokens and cost, and where in its output; and
- how it reads instructions from the worktree, so the contract in `AGENTS.md` reaches the model
  (Gemini needs `context.fileName`, Aider needs `--read`, OpenCode and Claude read it on their own).

Take each answer from the CLI's own documentation or source, put the URL and the version in the
file header, and where the docs do not say, say that in the header and take the conservative
option. Then add the stub to `bin/rehearse-executors` and the name to the branch in `doctor.mjs`,
and run the rehearsal. The header stays "NOT yet verified against a real agent" with the date
until an operator-authorised attempt has run through it and the result is on a board.
