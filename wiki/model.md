# The model

The data model, updated 2026-09-13. Settled behavior is recorded here. What is undecided is in
`open.md` and is not guessed at here.

This file is the self-contained current model for Ostoyae. The repository's code and operational documentation define what is
implemented.

## The object being built

From the map-first method, section 2:

> The missing object is a single one: **a graph whose edges are "X blocks Y", built from probe
> results, on which priority is computed.**

And section 3, step EDGE:

> Edges come from three places: statements of the questions, cheap mapping probes, and, the
> big one, WALLS FOUND BY FAILED RUNS. A run that fails against a wall has discovered an edge;
> that is a success, and it must re-enter the ranking automatically.

**Ostoyae is that object.** Three things follow and are settled rather than open.

1. **Known initial dependencies may be authored in `work[].needs`; newly discovered
   dependencies come from run evidence.** Mapping probes and walls add proposed edges carrying
   the attempt that found them.
2. **The map and the allocation are one structure.** There is no second table. What runs next is
   computed on the same file that recorded what already ran.
3. **A run that did not complete its assigned work can still be a success of a different kind if
   it found an edge**, and the record has to say which outcome happened.

The source uses “failed run” in the broad, ordinary sense of not completing the assigned work.
The engine's terminal states are narrower: a structurally informative non-completion is `walled`,
not `failed`.

## The failure this is built against

Not hypothetical. From the map-first method, section 1:

> Run 16585a2a attempted Hardy-Ramanujan, hit the wall, and DISCOVERED THE EDGE: "Mathlib
> contains no Mertens second theorem... one formalization unlocks a family of wanted targets
> rather than one." That is the single most valuable output of the run. It was written to
> `threads.json` with status `unfunded`, and nothing reads `threads.json` when ranking.

The probe was fine. The discovery was fine. The discovery was written somewhere the chooser does
not read, so the next probe was chosen alphabetically. **The defect is not judgment and not
budget. It is that discovery and allocation were in two different files.**

So the one rule that governs this repo's file format: **a wall found by a run lands in the graph
the scheduler reads.** Not in a log, not in a report directory, not in prose in a handback.

## The shape

Three layers. Same graph, stacked. Edges inside a layer mean one thing, edges between layers
mean "this is that."

```
  work        ●───▶●───▶●            dependency: B waits for A
                │     │
  attempts    ●●●●   ●●              derivation: this came from that
               │      │
  artifacts   ▣▣     ▣▣▣             versions: v1 → v2 → v3
```

**Work layer.** What you want done, and what waits on what.

**Attempt layer.** What actually happened. One agent, one cell, one result.

**Artifact layer.** The files and their versions. Whether this is a real layer or a property
hanging off an attempt is open, question 2.

## Both layers move

An earlier version of this file said the work layer is *"the layer you can author ahead of time
and freeze"* and that *"frozen or moving is per layer."* **That is deleted.** It is the
alphabetical-scheduler premise: a graph typed once by a person, executed in the order it was
typed, learning nothing from what it ran.

The work layer moves because runs move it. A person may seed known initial dependencies in
`work[].needs`, but that starting information does not freeze the graph. An attempt that hits a
wall proposes work and edges, and those land in the file. The attempt layer moves too, because
retries are attempts. Neither layer is ever frozen. What varies is only how much a given run
adds.

## How the graph changes

An attempt hands back a report. The report is data, and it is not authority.

```json
{
  "wall":  "there is no idempotency column to guard the confirm path on",
  "work":  [ { "id": "w-schema", "what": "add an idempotency key column" } ],
  "edges": [ { "from": "w-schema", "to": "w-confirm", "why": "the guard has nothing to read" } ]
}
```

Everything in it lands in the graph file with `status: "proposed"`, carrying the attempt id that
found it and the date. **A proposal is inert.** It is not scheduled and it does not affect
readiness. Then, from the map-first method, section 5:

> `collect` parses handback `threads` for blocking language and proposes edges (operator
> confirms; do not let prose auto-edit the graph).

By default, the operator confirms or rejects. A confirmed edge gates. A confirmed work item
becomes ordinary work, indistinguishable from something a person typed. A rejected one is a
route that was closed, kept in the file as a record and never launched.

**Only confirmed edges affect scheduling.** The normal confirmation path is an explicit human
decision. The bounded exception is an operator-authorized `--auto-advance` invocation with a
configured judge and positive cap. It may confirm fully judged routes to that invocation's
original open tickets, while statement revisions and reopened edges still require explicit
decisions. Agent prose alone never edits the schedule.

## A node is an attempt

One agent, one cell, one result.

The argument for it is retries. If a node is a unit of work and you try it five times, four of
those disappear and the graph lies about what happened. If a node is an attempt, you get five
nodes, four dead and one that worked.

An attempt ends in one of three states, and the third is the point of this repo:

| state | meaning |
|---|---|
| `done` | it did the work |
| `failed` | it did not, and it found no useful structure |
| `walled` | it did not, and it found a wall or dependency structure |

A `walled` attempt parks its work item until its proposals receive an authorized decision,
because retrying before that walks into the same wall.

## A node's sandbox

An attempt is not just a prompt. It is an agent plus an isolated environment: its own git
worktree, its own database if the project has one, its own ports, and no authority to pick
anything that has to be unique across attempts.

That last rule comes from an earlier runner, learned on 2026-08-13 when two workers each read the log, saw #8,
and both took #9. Anything unique gets assigned by the thing that can see all the attempts, never
chosen by the attempt itself. Migration ordinals are the obvious case. **Edge ids are the new
one**, an attempt proposes an edge, it does not name it.

## Everything is a parameter

Nothing about a node is fixed. Which agent, which model, the prompt, the sandbox config, the
budget, the branch. All knobs, and knobs get turned while the graph is running.

## Two edge meanings

**Dependency.** B cannot start until A is done. Lives on the work layer. A known initial
dependency may be authored in `work[].needs`. A dependency discovered by a run is proposed,
statused and attributed to the attempt that found it.

**Derivation.** C came from B, a retry, a mutation, a branch off a previous attempt. Lives on
the attempt layer. Not statused; it is a fact about what the runner did, not a claim about the
world.

A dependency edge and a retry edge look identical in the data and mean opposite things, which is
the reason for the layers. Git already does this: a commit is an attempt, the parent edge is
derivation, a merge is dependency, and it is one graph.

## What survives a dead node

Environments are disposable. Records are not.

The worktree, the container and the database branch all get torn down. What a dead attempt keeps
is its parameters, its diff, why it died, **and the edges it found.** That last one is why a
failed attempt can be worth more than a successful one, and why the graph gets denser rather
than just longer as runs accumulate.

For the artifact layer, git is already the store. An attempt is a branch, dead attempts are
unmerged commits, and content addressing means a hundred attempts touching the same three files
cost about as much as one.

## Connecting the layers

By id, not by similarity. The attempt that wrote a file is the process that wrote it, so the edge
is known at write time. An earlier runner did this with a run id in the commit trailer.

Embeddings are for a different job: searching the dead. Once there are thousands of failed
attempts, the question worth asking is whether something like this has been tried and how it
died. That is retrieval, and it is a switch rather than a foundation.

## What is deliberately not here

**Measured benefit from leverage ranking.** Ranking now exists in `viewer/state.mjs`;
its causal benefit remains unestablished. Measured against an earlier runner's 105 runs on 2026-08-27: of 33 edges
in `edges.json`, 21 were recorded on a single day. Ranking by leverage looks strong in hindsight
(hubs land 87%, leaves 57%) and the effect disappears when restricted to edges that existed at
the moment of choosing (67% against 64%, n=6). The edges were written by a person reading
handbacks in batches, not produced by the loop. **Leverage cannot be tested until its input
accumulates, so accumulation is built first.**

**Scoring and selection over a population.** Same reason, further out.

**A `mode` field.** An earlier version had `frozen` and `growing`. Deleted: it conflated the
graph changing, which is now always true, with selection over a population, which does not exist.

## Steering decays, so the control is the graph

From arXiv 2608.19072, read 2026-08-26 and kept in `raw/`. It separates *execution-level*
capability, iterating inside a chosen strategy, from *strategy-level* capability, revising the
judgment as evidence comes in, and finds the strategy is locked in at the very beginning with the
remaining budget spent on local adjustments. An experience scaffold improved execution and left
the strategy static. Extra inference compute helped easy tasks and did almost nothing on the
hardest. And:

> human guidance effectively redirects the initial strategy, yet the agent falls back into local
> adjustment loops once training starts

You cannot buy strategy revision with more of anything on one node. Structure is the only lever
left, which is the case for the graph.

And the operator's control is at the graph, between runs, not inside a running node. Concretely,
in this repo, it is confirming and rejecting what the last runs proposed. Mid-flight steering is
not the primary control surface here, and that is deliberate.

*The paper studies LLM post-training runs. That this transfers to product code is an assumption
this repo makes, not something the paper shows.*

## What runs a node

The configured executor (`claude.sh`, `codex.sh`, `muse.sh`, `grok.sh`, or an explicit command).
Ostoyae owns its graph cells, graph transitions, checks and trunk integration.
Proposals remain operator decisions by default. The implemented bounded exception is
`--auto-advance`: with a configured judge and an operator-selected positive cap, it may
confirm fully judged routes to the invocation's original open tickets. It leaves statement
revisions and reopened edges for explicit decisions. That limited behavior is not a decision
about wider automatic governance, which remains open.

Coordination may set an authorized objective, budget and acceptance boundary. Independent
consultants may reject the coordinator's framing, and workers retain method freedom inside that
boundary. A consultant's or worker's conclusion is evidence, not an automatic policy decision.
