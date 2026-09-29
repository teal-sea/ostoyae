# Security

Ostoyae runs autonomous coding agents against your repositories. Read this before you run it
on anything you care about.

## What the sandbox is and is not

Each attempt runs in its own git worktree on its own branch, with a replaced environment:
`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR` and whatever the board names in
`sandbox.env_passthrough`. Nothing else from your shell reaches the agent.

That is isolation of state, not of capability. The agent has the same filesystem, network and
credentials that the agent CLI has on your machine. Git restrictions and shared-cache
protections vary by executor; they are documented in [`docs/executors.md`](docs/executors.md).
Gemini, Aider and OpenCode have only been exercised with stubs, and do not establish write
denial for linked caches. A symlink is not a read-only mount. CLI permission rules guard
ordinary use and do not stop hostile code that hides a subprocess inside an interpreter.
Treat a cell as you would treat any process running under your user.

## What to keep out of a board

A board is committed and read by agents. Never put tokens, passwords or connection strings
into it. `sandbox.env_passthrough` names variables to pass; the values stay in your shell.

## Reporting a vulnerability

Open a GitHub issue with the `security` label, or if the problem would put other users at
risk before it is fixed, email the maintainer listed on the repository profile instead of
filing it publicly. Say what you found, how to reproduce it, and what you think it exposes.
You will get a reply within a week.
