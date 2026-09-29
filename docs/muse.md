# Running cells with Muse

The Muse executor, `executors/muse.sh`, runs one attempt as a headless Muse session.
This page is the reference for it; `docs/executors.md` covers the executor contract
every adapter follows.

Select the executor explicitly:

```sh
bin/ostoyae doctor path/to/graph.json --agent muse
```

The graph's `defaults.model` and any work, mapping or judge overrides must name Muse model
ids (cells pinned to `muse-spark-1.3` report it back exactly). Nothing rewrites an existing
board's models or launches it automatically. The adapter targets Muse Code 1.3.0. Run
`bash bin/rehearse-executors` for the contract checks, including the muse section.

Validated on 2026-09-17 with three authorized scratch cells: work done, checks passed,
trunks merged, and the third recorded real usage (1499 out / 163796 in / 135349 cached,
6 turns). A 2026-09-18 dogfood pass ran 56 further authorized Muse cells through this
adapter ($0.00 metered on the subscription); see
[the log](../wiki/log/2026-09-18-dogfood-rounds.md). This is not a Lean/MCP board test.

| Claude executor behavior | Muse adapter |
| --- | --- |
| Private script copy | The script is copied before the cell starts, same pattern. |
| Headless prompt/model | `muse exec --json`, prompt by `--prompt-file`, explicit `--model`, `--disable-approval`. |
| `params.max_turns` | Passed as `--max-model-steps`: steps, not turns. Usage `turns` counts `model_completed` records, one per step. |
| No agent git | No CLI denial exists, so the contract text is the only guard. The binary holds a deny effect nothing headless reaches; a future `--permission-profile` may change this once its schema is established. |
| Linked caches | Not opened; no flag found. Whether cell reads are refused is untested. |
| Declared shell tools | No per-command grants exist; the agent shell runs workspace-wide under disabled approval. |
| Lean MCP | Not attached; no flag found. |
| Web tools | `OSTOYAE_WEB` leaves them on, otherwise `--disable-web-tools`. The default network mode is proxy-only, untested through a cell. |
| Handback | `.ostoyae/report.json`; a wall returns nonzero, a map needs `map`, a verify needs a `verdicts` array. Partial prove work is committed even on a wall or agent error. |
| Usage/auth | Tokens summed from the run session log (below); doctor checks CLI presence only, no status probe exists. |

The `--json` stream carries text (`run.output.delta`, `run.terminal.completed`), tool calls
(`tool.result`) and the model id (`run.model.configured`), but no usage: a 54-line raw
capture of a real file-writing run holds zero usage members. The numbers live only in the
run session log, as one `model_completed` record per model call, so session logging stays on
and the adapter copies the sums into `.ostoyae/usage.json`. Records dedupe by record id;
the store resolves as `${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/<date>/<id>/`,
with a yesterday fallback and a short retry for flush. A box that sets `XDG_DATA_HOME` must
name it in `sandbox.env_passthrough`.

Nothing reports dollars, so `cost_usd` stays `null`: cap Muse runs by launches or output
tokens, not dollars. A `--usd`-capped run stops after the first unpriced Muse result,
observed on the validation runs.

Sources: the CLI's own `--help` texts, its binary strings, `--provider echo` probes, a raw
54-line `--json` capture with its 106-line session log, and three live scratch cells, all
2026-09-17 on this machine.
