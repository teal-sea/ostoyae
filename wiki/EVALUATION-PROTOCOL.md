# EVALUATION-PROTOCOL.md

**Status when this file was committed: pre-registration only. No result in it.**
Everything below was written before any arm was run, any ticket was chosen, or any number was
seen. The commit that adds this file adds no experiment; that ordering is checkable in
`git log` and is the only reason the criteria below are worth anything. The pattern is
`~/Zeta/HARNESS-EVALUATION-PROTOCOL.md`, whose subject went four experiments, 74 runs, and never
beat its control. This one is written so it can lose the same way.

## 1. The claim under test

> **Does the graph (a wall becomes a task, the parent parks, shared prerequisites merge, the
> runner works what is started before probing what is not) land more work per output token
> than the same agents used head-on, with retries, at the same budget?**

The graph is the claim, not the instrument. The operator's own words on 2026-08-30, before any
number existed: *"it feels like a lot of unnecessary machinery now."* That sentence is H0 below,
and this protocol exists to be able to accept it.

What tonight's runs did and did not show, for the record. They showed the mechanism works: 53
Erdős problems went in, 9 were mapped by agents, 97 tasks and 128 dependency edges came out,
every one found by a run and none authored, and the runner then worked confirmed tasks before
new problems. They showed nothing about whether that beats not doing it. No arm, no control, no
matched budget, no ticket landed. Nothing in `wiki/log/` is evidence for the claim.

## 2. Hypotheses

| ID | Hypothesis | Arm contrast |
|---|---|---|
| **H0** | **The null this exists to accept:** two independent head-on agents at the same output-token budget land as many tickets as the graph. The machinery is a viewer, not an engine. | `R2` vs `G` |
| **H1** (primary) | The graph lands more tickets than two independent head-on agents at matched output tokens. | `G` vs `R2` |
| **H2** | The advantage, if any, is confined to tickets that share a prerequisite; on unrelated tickets the graph does no better than `S0`. | `G` vs `S0`, split by subset |
| **H3** | The graph does a shared prerequisite once where head-on arms do it once per ticket. | duplicate-work count, `G` vs `S0`/`R2` |
| **H4** | The mappers, not just the DAG, carry the effect: mapping on beats mapping off. | `G` vs `G-nomap` |
| **H5** | The graph costs the operator more minutes per landed ticket than the head-on arms. | operator minutes, all arms |

**H1 is primary.** H2 to H5 are secondary and are labelled exploratory in the analysis.

## 3. Arms

Budget is held constant across arms and mechanisms are separated. A ladder where each rung adds
a mechanism and money at once was not used, for the reason `~/Zeta`'s protocol gives: a rising
curve would be unattributable.

| Arm | What runs | Output-token budget per ticket |
|---|---|---|
| `S0` | one `claude -p` per ticket, the ticket's own text as prompt, no graph, no retry | **B** |
| `S1` | `S0` with twice the budget: two attempts, second told the first's last message | 2B |
| `R2` | two independent `claude -p` per ticket, no shared context, both results kept; a ticket counts as landed if either passes its check | 2B |
| `G` | Ostoyae: the tickets as a graph, mapping on, operator confirming, `go` until the budget is spent | 2B total across the family, counted from `result.usage` |
| `G-nomap` | Ostoyae with `mapping` removed from the graph: the DAG as scheduler, walls still become tasks, no mapper | 2B |

`R2` is **the matched-budget control the experiment turns on.** The graph beating one cheap
agent would show nothing; the question is whether it beats the same money spent on a second
good agent.

Same model in every arm (`sonnet`, as `mapping.params.model` names today). Same executor,
`executors/claude.sh`. Same machine, with the machine guard at its post-2026-08-29
match so it cannot kill an arm.

## 4. Budget: four resources, measured separately

"Equal budget" is not used here without naming the resource. Four are tracked and there is no
exchange rate between them:

| Resource | Unit | Source |
|---|---|---|
| model compute | output tokens (primary), input and cache tokens (reported) | `attempts[].result.usage`, written by the executor from `claude -p`'s final event |
| money | USD as the provider reports it | `result.usage.cost_usd` |
| operator time | minutes of human attention: confirming, adjudicating, restarting | stopwatch, recorded per ticket per arm |
| wall-clock | seconds | `result.usage.duration_ms`, `started_at`/`ended_at` |

**Equalization rule, frozen:** arms are matched on **output tokens within ±15%** per ticket
(`S0`, `S1`, `R2`) or per family (`G`, `G-nomap`). An arm that cannot be brought inside the band
without changing what it is is not adjusted; every endpoint is then reported twice, raw and per
1000 output tokens. An arm that wins raw and loses normalized is reported as winning raw and
losing normalized. No composite score.

**Dependency, resolved 2026-08-30:** `~/Zeta`'s protocol was blocked because sessions did not
expose token counts. Ostoyae's cells run `claude -p --output-format stream-json`, whose final
`result` event carries `usage` and `total_cost_usd`; the executor now writes that to
`.ostoyae/usage.json` and the runner records it on the attempt. The head-on arms run through the
same executor so their numbers come from the same place.

## 5. Subject

A real codebase of the operator's, with real open tickets, chosen after this file is committed
and named in the log entry that records the run. Requirements, frozen:

- 10 to 12 tickets.
- At least 4 share one hidden prerequisite (a missing fixture, an untyped module, a flaky
  setup) that none of the ticket texts names. This is the subset H2 and H3 are about, and it is
  chosen by a person reading the code, not by an agent.
- Every ticket has a **mechanical check**: a test command that exits 0 only when the ticket is
  done, written before any arm runs, held outside the repository during execution, its SHA-256
  frozen in the run's log entry and re-verified after. Scoring is the exit code. No scorer
  judgment, no "looks right".
- No ticket may be solvable by reading another ticket's answer.

`examples/fix-booking-race.json` is the shape; it is not the subject.

## 6. Endpoints

Primary: **tickets landed**, out of the ticket count, per arm. Landed means the check exits 0
on the arm's committed branch, run by the engine, not claimed by the agent.

Secondary, all with the ticket count as denominator:

- duplicate work: how many times the shared prerequisite was built across the arm's attempts
  (counted by a person reading the diffs, blind to arm);
- operator minutes per landed ticket;
- output tokens per landed ticket;
- for `G` arms: walls that became tasks that later landed, out of walls raised.

## 7. Predictions, on record before the run

- `S0` lands as many unrelated tickets as `G`. On that subset H2 holds and the graph adds cost.
- `G` beats `R2` only on the shared-prerequisite subset, and by at most the size of that subset.
- `G` builds the shared prerequisite once. `S0` and `R2` build it once per ticket that reaches
  it, three to eight times.
- `G` costs more operator minutes per landed ticket than every other arm. H5 holds.
- `G-nomap` lands fewer than `G` on the shared subset: without a mapper, the wall is raised by
  the prover after it has already spent its budget.

If the last two both hold, the honest summary is: the graph is where the money goes further and
the operator's time goes faster, and which of those matters is a decision, not a measurement.

## 8. Criteria that count AGAINST the graph

| Observation | What it licenses |
|---|---|
| `R2` lands ≥ `G` at matched output tokens | **the primary result is negative.** Spend the budget on a second agent. H0 accepted. |
| `G` ≈ `G-nomap` within the bootstrap interval | the mappers are ceremony for this task class; delete map attempts, keep walls |
| `G` loses on tickets per operator minute by more than the shared-subset gain | the cost lands on the scarcest resource there is |
| `S0` lands ≥ `G` on the shared subset | the graph does not even do the one thing it is for |
| Any `G` attempt lands a ticket whose check was not run by the engine | the record cannot be trusted; the experiment is void until `check` is enforced |

**If two or more fire, the recorded conclusion is "simplify", specified now:** keep the wall
handback and the append-only record (the parts that cost nothing), keep the board as a viewer,
delete map attempts and the scheduling loop, and run tickets head-on with `R2`.

## 9. What would make the graph worth expanding

Symmetry, so this is not a document that can only convict:

- `G` beats `R2` on the whole set, not only the shared subset.
- `G` beats `R2` on tickets per operator minute, not only per token.
- The duplicate-work count in `G` is 1 and in `R2` is ≥ 4.

## 10. What is not decided here

- The subject repository and tickets. Chosen after this commit, named in the run's log entry.
- Bootstrap interval width and the ticket count for a decisive difference. With 10 to 12
  tickets a one-ticket difference is noise; this is a screen, and a positive result licenses a
  larger run, not a claim.
- Whether `check` should be enforced by the engine on every attempt in normal operation. This
  protocol requires it for the experiment; `wiki/open.md` question 4 owns the general case.
- The Erdős board. It is the showcase and it is not a subject: its checks need `lake build`,
  which the machine guard kills by policy, and its walls are open mathematics, not missing
  fixtures.

## 11. Execution order, so it cannot be done backwards

1. This file merged to `main`. Its commit adds nothing under `run.mjs` except what §4 names.
2. Subject and tickets chosen; checks written; digests recorded in a log entry; that entry
   merged.
3. `S0`, `S1`, `R2` run first, in that order, before any `G` arm, so the head-on numbers exist
   before anyone has watched the graph do anything.
4. `G-nomap`, then `G`.
5. One log entry per arm as it lands, numbers only, no interpretation.
6. The verdict, in `wiki/EVALUATION-VERDICT.md`, written against §8 and §9 and nothing else.
