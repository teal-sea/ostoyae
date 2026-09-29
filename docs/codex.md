# Running cells with Codex

The Codex executor, `executors/codex.sh` and `executors/codex.mjs`, runs one attempt as a headless
OpenAI Codex CLI session. This page is the reference for it; `docs/executors.md` covers the
executor contract every adapter follows.

Select the executor explicitly:

```sh
OSTOYAE_EXEC="bash $PWD/executors/codex.sh" bin/ostoyae doctor path/to/graph.json
```

The graph's `defaults.model` and any work, mapping or judge overrides must name Codex models.
Nothing rewrites an existing board's Claude models or launches it automatically. The adapter
targets Codex CLI 0.153.4. Run `bash bin/rehearse-codex` for the fake-executor contract checks.

Validated on 2026-09-05 with an authorized real scratch cell: contract read, git/cache guards
obeyed, handback and usage recorded, harness commit landed, independent check passed. The first
scratch attempt exposed an ignored-contract staging bug; its failed record is preserved and
the corrected staging path passed the second live test. This is not a Lean/MCP board test.

| Claude executor behavior | Codex adapter |
| --- | --- |
| Private script copy | Both executor files are copied before the cell starts. |
| Headless prompt/model | `codex exec --json`, explicit model, approvals `never`. |
| `params.max_turns` | No equivalent in `codex exec`; rejected before launch, never silently ignored. Runner launch and output-token budgets remain available. |
| No agent git | A harness-provided `PreToolUse` hook denies ordinary git shell invocations; the harness commits the work. |
| Linked caches | Explicit filesystem `read` permissions, including shell writes; no writable `--add-dir`. |
| Declared shell tools | Run inside the workspace sandbox. Claude's per-command allow rules have no identical meaning: Codex `allow` rules grant execution outside the sandbox, so this adapter does not generate them. Declaring tools enables network access inside the sandbox. |
| Lean MCP | Only when `OSTOYAE_LEAN_MCP` names it; project path points at the cell and initialization is required. MCP servers run outside the shell sandbox, so a declared server is trusted code. |
| Web tools | `OSTOYAE_WEB` enables live search; otherwise search is disabled. |
| Handback | `.ostoyae/report.json`; a wall returns nonzero, a map needs `map`, a verify needs a `verdicts` array. Partial prove work is committed even on a wall or agent error. |
| Usage/auth | JSONL token usage becomes `.ostoyae/usage.json`; doctor uses `codex login status` in the cell environment without a model call. |

Codex's total input includes cached input; the adapter subtracts it before storing
`input_tokens`, so the engine counts it once. Claude-style model turns, API duration and billed
dollars are not supplied by this JSONL interface and stay `null`. `user_turns` counts Codex's
completed task turns; it is not a substitute for Claude's `num_turns`.

Optional `params.codex_pricing` (or `defaults.codex_pricing`) supplies `input`, `cached_input`
and `output` rates in USD per million tokens. The resulting `cost_usd` is labeled an estimate
and stores the rates used. Choose rates for the actual model, tier and context regime. This is
an accounting estimate, not a ChatGPT subscription charge or an invoice; separately billed
tools/cache writes are not reported in the CLI token totals. Without rates, dollars remain
unknown and a dollar-capped run stops after an unpriced Codex result. Token budgets still work.

The git hook is a guard against ordinary agent commands, not a boundary against hostile code
concealing subprocesses inside an interpreter. The filesystem sandbox separately protects
linked caches and git metadata. User/project agent configuration and rules are excluded from
the cell so they cannot grant extra permissions; the explicit hook trust flag trusts the
harness's hook, not unrestricted shell execution. HOME survives for saved Codex authentication.


Sources: [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[permissions](https://learn.chatgpt.com/docs/permissions),
[hooks](https://learn.chatgpt.com/docs/hooks), and
[command rules](https://learn.chatgpt.com/docs/agent-configuration/rules), read 2026-09-05.

