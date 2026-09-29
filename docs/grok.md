# Running cells with Grok

The Grok executor, `executors/grok.sh`, runs one attempt as a headless Grok session.
This page is the reference for it; `docs/executors.md` covers the executor contract
every adapter follows.

Select the executor explicitly:

```sh
bin/ostoyae doctor path/to/graph.json --agent grok
```

The graph's `defaults.model` and any work, mapping or judge overrides must name Grok model
ids (cells pinned to `grok-4.6` report it back exactly). Nothing rewrites an existing
board's models or launches it automatically. The adapter targets Grok 1.0.34. Run
`bash bin/rehearse-executors` for the contract checks, including the grok section.

Validated on 2026-09-18 with four authorized scratch cells: prove, map, verify, prove.
All finished real work, passed their checks and merged to trunk; all recorded real usage
with dollars (e.g. 797 out / 24278 in / 99328 cached, 5 turns, $0.035 on `grok-4.6`).
This is not a Lean/MCP board test.

| Claude executor behavior | Grok adapter |
| --- | --- |
| Private script copy | The script is copied before the cell starts, same pattern. |
| Headless prompt/model | `grok --prompt-file`, explicit `-m`, `--output-format streaming-messages-json`, `--permission-mode bypassPermissions`, `--trust`. |
| `params.max_turns` | Passed as `--max-turns`: turns, like claude.sh. |
| No agent git | `--deny 'Bash(git *)'`, proven by probe (denied by policy under bypassPermissions). `sh -c 'git ...'` is not covered; the contract text is the rest. |
| MCP servers | `--deny 'MCPTool(*)'` blocks all MCP tool calls (probed). The user's servers stay configured otherwise, and one of them on the dev box is an orchestrator a cell must not reach. No per-server grant exists yet. |
| Skills and global instructions | No CLI switch turns them off; 47 skills plus the global instructions file ride into every cell. Unmeasured beyond the input tokens they cost. |
| `ask_user_question` | Disallowed: headless has nobody to ask. |
| Linked caches | Not opened; no flag found. Whether cell reads are refused is untested. |
| Declared shell tools | No per-command grants exist; the agent shell runs under bypassPermissions. |
| Lean MCP | Not attached; no flag found. |
| Web tools | `OSTOYAE_WEB` leaves them on, otherwise `--disable-web-search` plus `web_search,web_fetch` on the denylist. |
| Handback | `.ostoyae/report.json`; a wall returns nonzero, a map needs `map`, a verify needs a `verdicts` array. Partial prove work is committed even on a wall or agent error. |
| Usage/auth | Tokens, cache, turns, durations (`duration_ms` and `duration_api_ms` as `api_ms`) and `total_cost_usd` from the final `result` frame; doctor checks CLI presence only. Unlike muse, dollars are reported, so `--usd` binds on grok results. Zeros fail closed to unknown per the headless docs: an all-zero usage frame means the ledger was incomplete or absent, and `total_cost_usd` 0 is the unknown-cost fallback, so both become absence (never reported free) and the caps refuse. |
| Project memory | Tracked `.claude/CLAUDE.md` and `.claude/CLAUDE.local.md` are moved aside for the run (named on the prompt with their aside path, restored only where the agent left nothing), because Claude compatibility loads them beside the injected contract and has no CLI off switch. Subdirectory instruction files and `.claude/rules|skills` still load. |

The stream is `system/init` (model, tools, skills, MCP), `assistant` frames (text and
tool calls for the live view), and one final `result` frame. Exit codes are 0 success,
1 error, 130/143 signals.

Sources: the CLI's own `--help` text, `~/.grok/docs/user-guide` (headless mode, project
rules, permissions), `grok models`, and headless probes (prompt echo, file write, git
denial, MCP denial, AGENTS.md pickup with and without `--trust`, stream captures), all
2026-09-18 on this machine.
