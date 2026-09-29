Terms used in Ostoyae boards and runs.

| word | meaning |
|---|---|
| **board** | one JSON file: the jobs, the edges between them, and every attempt ever made. The runner reads it and writes it back. |
| **work item** | one job on the board. "Add the idempotency column." Has an id, a `what`, and an optional `check`. |
| **attempt** | one agent, one cell, one result. Attempts are appended to the board and never edited or deleted. |
| **cell** | the sandbox an attempt runs in: its own git worktree on its own branch, its own port, a replaced environment. |
| **executor** | the shell command that runs one attempt inside its cell. `executors/claude.sh` runs Claude Code; there are adapters for Codex, Gemini CLI, Aider, OpenCode, Muse Code and Grok Code, and a fake one for tests. |
| **handback** | the file an attempt writes before it exits, `.ostoyae/report.json`: what stopped it, what work it proposes, what depends on what. |
| **wall** | what an attempt names as the thing that stopped it. A wall that names something the graph does not have yet is the outcome this engine exists for. |
| **done / failed / walled** | three distinct attempt states. `done` did the work. `failed` did not do the work and found no useful structure. `walled` did not do the work but found a wall or dependency structure. |
| **proposal** | a work item or edge that came out of a handback. Inert until confirmed: never scheduled, never affects readiness. |
| **edge** | "A blocks B." Authored ones are in `needs`; discovered ones are in `edges[]` with the attempt that found them. |
| **map attempt** | an optional cheap first pass on an item that says what it needs and what it unlocks, before any expensive attempt. |
| **judge** | optional. A `check` command the engine runs on a fresh checkout to decide `done`, and a verify attempt that judges each proposal before the unattended yes can act on it. |
| **trunk** | the branch where every done attempt's work is merged, so later attempts start from everything finished so far. |
| **viewer** | the local page that draws the board while it runs and takes your yes and no. |

