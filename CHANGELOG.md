# Changelog

## 0.2.2, first public release

- One board can mix agents: agent, model and reasoning effort per board, per role (map, verify,
  prove) and per job. Every attempt records the agent, model and effort it ran with, and the
  viewer shows them.
- Messaging between running attempts is on by default. Each attempt is told which attempts are
  running beside it; `ostoyae-msg who`, `send` and `read` work across agent types; when two
  running attempts change the same file, Ostoyae messages both. `--no-messaging` turns it off.
- Hermes Agent executor, and an Ostoyae skill for running boards from Hermes.
- `ostoyae import github owner/repo`: issues from people with push access become jobs.
- Compiled Python files are kept out of agent commits.

## 0.1.0, unreleased

Planned first tagged version; no tag has been cut. Everything before it is in `wiki/log/`, one entry per working
session, and that record stays the authority on what happened when.

- The engine: a board of work items, cells that run one agent each in a git worktree, a
  handback that turns a wall into proposed work and edges, and an operator's confirm and
  reject. Map attempts, the judge, questions with two finishes, the ontology, budget caps in
  sessions, dollars and output tokens, and recovery of attempts a dead runner left behind.
- `ostoyae init` writes a board for the repository you are standing in.
- `install.sh` installs, upgrades and uninstalls without sudo, into `~/.ostoyae` with a link
  in `~/.local/bin`; `docs/remote.md` covers SSH, headless agent login and Tailscale.
- `ostoyae land` fast-forwards the board's base branch to its trunk and refuses anything
  else; the end of `go` names the trunk branch and the land command.
- A prove cell is told its item's check and, under Claude Code, may run exactly that command.
- `go`, `land`, `doctor`, `dry`, `status`, `watch` and `stop` have their own `--help`.
- Executors for Claude Code, Codex, Muse Code and Grok Code, verified against the real
  agents; Gemini CLI, Aider and OpenCode adapters rehearsed against stubs only.
- `executors/grok.sh` runs one attempt as a headless Grok session and records tokens, turns
  and dollars from the result frame.
- Summary labels done attempts without checks as agent's word or declared but not run in
  dry mode; splits stuck items into ready and waiting lines; reports done-but-unmerged
  attempts with a trunk-conflict line.
- Duplicate discovery parks its source: parking and the awaiting-operator print read
  `namedOpen` (novel proposals plus open proposals the attempt joined as a finder), so a
  second discoverer of shared work waits instead of rebuilding it. `found` stays
  novel-only and no second verify fires on duplicates. Covered by
  `bin/rehearse-duplicate-park`.
- Contract injection unlinks a symlinked AGENTS.md/CLAUDE.md before writing, so a pursuit
  whose contract path is a link keeps its target; cell commits stay silent about ignored
  contract files.
- Grok usage fails closed: all-zero frames and zero dollars record as unknown (never
  reported free), `duration_api_ms` is kept as `api_ms`, tracked `.claude/CLAUDE*.md` is
  withheld from the Claude-compat loader, and empty staged-path lists no longer stage the
  worktree; gated items are excluded from the ready/waiting summary split.
- Crash consistency: one runner per graph is enforced by an atomic lock beside the runfile
  (stale holders are broken by identity, never by bare pid); non-array handback `work` and
  `edges` drop with a note instead of killing the runner; a trunk worktree left mid-merge
  is abandoned before the next merge rather than blamed on it; the cell pid is checkpointed
  before the identity bookkeeping; corrupt runfiles refuse plainly (status 2, launch 1,
  stop UNKNOWN/10), never as a stack trace. `bin/rehearse-crash` covers all of it.
- Every writer holds the lock: `--gate` claims across the whole gate (a slow
  gate erased a settled attempt), confirm claims just before its write, and
  `init --force` refuses beside a live holder. Locks carry the holder's role
  so refusals name the wait; `stop` reports a starting runner instead of
  nothing. Covered by `bin/rehearse-crash` sections 9-10.
- Lock ownership for every writer: the viewer claims before deciding (a
  mid-gate decision was accepted then erased) and refuses launches into a
  held graph, verifying the child beat before answering; `init --force`
  fails closed beside unverifiable holders, claims as `init`, and writes
  atomically; stop names unverifiable holders instead of claiming idle;
  run, gate and confirm re-read the board under ownership before deciding;
  the grok adapter records `_bad` instead of throwing on a missing result
  frame. Covered by `bin/rehearse-viewer` section 5, `bin/rehearse-crash`
  sections 10-11, and two grok adapter asserts.
- One board, one identity: every owner check and sidecar derivation resolves through
  on-disk-case `canonicalPath` plus device/inode `sameFile`, so case-alias spellings of a
  board share sidecars instead of verifying past each other; every writer beats a
  role-carrying runfile beside its lock claim, fencing current and pre-lock engines in
  both directions. `.ostoyae/` is excluded from all seven shell executors' staged-path
  enumeration, matching `codex.mjs` and the documented rule. Covered by
  `bin/rehearse-crash` sections 12-13 and the `rehearse-executors` wall-path assert.
- The viewer: the board drawn live, with yes and no on each proposal.
- A dependency-free npm package definition. Installed-command rehearsals cover symlinks,
  quoted paths, board selection, `init` argument handling and non-spending auth preflight.
  The repository is private, this work is on a review branch, and no npm package is published.
- Commands without a board direct the reader to `init`; the historical lab example is never
  selected implicitly. `doctor` uses authentication-status commands without a model prompt.
