# DECISION-PROTOCOL.md

**Status when committed: pre-registration. No arm of it has run. Nothing here is a result.**
The first protocol asked whether the graph beats head-on agents and produced a run that could
not answer it. This one is written to end differently in one specific way: it is registered to
a **decision**, not to a hypothesis. When the run finishes, one of three pre-named actions is
taken, and which one is read off a table frozen here.

It is deliberately one page where the first was six. The first copied `~/Zeta`'s length without
its reason; this copies the operator's design instead: *"you just had to do a simple A/B test,
one run with regular, one run with Ostoyae, and go from there."* Two arms. That is the whole
apparatus.

## 1. The decision

What to do with Ostoyae. Three actions, all fully specified now:

| outcome | action |
|---|---|
| **A. invest** | keep the engine whole, mapper on by default; the result licenses a larger run, not a claim |
| **B. keep the loop, park the mapper** | the DAG, the wall handback and the record stay (three complete arms already showed they cost nothing); map attempts default off, kept as a flag. B is inferred from the first run's parity, not raced as its own arm here; that is a known economy, not an oversight |
| **C. simplify** | as the first verdict specified: wall handback and append-only record kept, board as viewer, map attempts and the scheduling loop deleted |

**The burden is on the graph.** The first experiment, for all its faults, measured the graph at
1.8× worse per dollar controlled for ticket mix, and the salvage arithmetic says its mapper
never pays when the shared prerequisite is cheap. Simplify is the standing default; this run
exists to overturn it or confirm it.

## 2. The question, in two halves

At **equal dollars and equal concurrency**, on tickets that share a prerequisite **expensive
enough to be worth mapping**, does Ostoyae land more tickets than the same agents used head-on
with retries — and does it get to done in less wall-clock time?

Wall-clock is in the question because it is the operator's stated point of the engine — several
agents at the same time, ordered by a DAG — and because **the first experiment never ran
anything in parallel**: one `lake build` at 5.6 GB forced concurrency 1 in every arm, so no
number from it speaks for or against parallelism at all. One thing is fixed by geometry, not by
experiment, and is stated so nobody re-tests it: on tickets with no dependencies between them,
N plain agents in parallel and the DAG are the same schedule, so the graph can only win
wall-clock where edges exist and only win dollars where the shared work is expensive. Both
halves of the question therefore live or die on the same subject requirement in §5.

The italicised clause is the condition the salvage derived: the graph pays only when the
saving from not rebuilding the prerequisite, `c`, exceeds the per-ticket cost of mapping, `m`
(~$0.60 at sonnet prices), and then only past `d = s/(c−m)` tickets sharing it. On the first
run's tickets `c−m` was at best $0.27 and plausibly negative. This protocol does not assume
the condition can be met; gate P2 measures it, and if the world never offers a subject that
passes P2, that is outcome C by a cheaper road than running arms.

## 3. Gates, before any arm spends a dollar

All five are cheap; four exist because a rule in
`log/2026-08-30-what-the-experiment-taught-about-the-designer.md` was written in blood.

- **E1, engine-run checks.** **Built.** A work item carries `check`, a command the *engine*
  runs in the cell after a prove attempt's executor exits zero; non-zero is `failed` regardless
  of what the agent said, and the ordinary retry follows. Rehearsed with the fake executor: a
  lying done is caught and retried, a check-failing first attempt is landed by its retry, a
  wall with structure stays `walled`, and an item without `check` is byte-for-byte the old
  behaviour. Without this the head-on arm's retry can never fire (`S1` was `S0` at a different
  seed) and "the agent said done" scores 11/11 where the checks score 8/11. This is the scoped
  version of `open.md` question 4; the open-ended-score case stays open.
- **E2, real-agent rehearsal of the conflict path.** The 2026-08-30 change to `sandbox.mjs`
  (a conflicted upstream merge is handed to the agent instead of failing the attempt) is
  fake-executor-verified only, and `CLAUDE.md` forbids relying on that. One real agent, one
  manufactured two-upstream conflict, ~$2.
- **E3, a scope rule for confirms.** Unattended: auto-yes only for proposals with an edge path
  to a ticket; everything else waits ($4.37 of `G-nomap` went to CI hygiene nobody asked for).
  Attended: the operator confirms, and the stopwatch runs (H5 finally gets data).
- **E4, dollar budgets.** Built (`--usd`, cumulative over `attempts[]`). Both arms use it;
  neither arm is capped in launches.
- **E5, full dress rehearsal** of both arms end to end with `executors/fake.sh`, including a
  wall, a retry-after-failed-check, and a conflict. Costs nothing; the first run spent four
  live launches discovering a path that had never once run.

## 4. The pilot, which is allowed to kill the experiment

Two gates, both numeric, both on the candidate subject, ~$12 total. **Fail either and the
arms do not run** — the pilot's log entry records the failure and the subject search continues
(or, after three failed subjects, outcome C is taken on the grounds that the task class this
engine was built for has not been found in the operator's actual work).

- **P1, headroom.** Head-on, one attempt each, on 3 sampled tickets. **At least one must fail
  its check.** All three passing = no headroom = the first experiment again.
- **P2, the mechanism is worth money.** From those same transcripts and diffs, price what the
  attempts spent reaching or rebuilding the shared prerequisite. Required: **≥ $3 per ticket**
  (5× the mapping cost) or the prerequisite blocks outright (the attempt walls or fails
  without it). A prerequisite worth a minute goes back in the drawer.

## 5. Subject

Chosen after this file merges, named and digest-frozen in the run's log entry, same rules as
before (mechanical checks, engine-run, held outside the repo, no ticket solvable by reading
another's answer) plus what the first run taught:

- 8–12 tickets, ≥4 gated by **one missing piece that is itself landable** — a lemma, a
  fixture, a port — not open mathematics (unlandable) and not a lakefile edit (worth a
  minute). The flag paragraph's own shape: Mertens-sized, not two-lines-sized.
- Helper definitions pinned by the checks (the helper library cached), closing the soft hole
  the first run recorded.
- **Three attempts must fit in memory at once — wherever the lab runs them.** Concurrency ≥ 3
  in both arms, the same number in both, is a requirement on the subject, not a tuning knob: a
  subject whose check forces concurrency 1 silently deletes the wall-clock half of the
  question, which is exactly what happened on 2026-08-30. Amended the same day, at the
  operator's correction: "available hardware" includes what the lab can rent. The lab runs
  Modal (patterns in `teal-sea/modalruns`), a `check` is an arbitrary shell command, so a
  5.6 GB Lean check can run remotely N-wide with zero engine changes and only the attempts'
  own agents need local memory. **The Lean subject class is therefore NOT excluded by this
  gate.** What it needs is a Modal credential in the session's environment; a session without
  one reports that missing credential, not a hardware blocker. If neither local memory nor a
  wired remote runner can hold the pilot's checks three-wide, then the subject fails §5.
- Same model both arms, same executor, same machine.

## 6. Arms, budget, order

| arm | what | budget |
|---|---|---|
| `H` | head-on with retries, **in parallel**: agents run at the same concurrency as `G`, one per ticket, engine runs the check, a failed check spawns a retry told the failure, until the money runs out | `--usd X` |
| `G` | Ostoyae, mapping on, scope-ruled or attended confirms, `go` cycles until the money runs out | `--usd X` |

`H` is parallel on purpose. The fair control for a DAG of agents is a flat pool of agents, not
one agent in series; comparing the graph to a serial baseline would hand it a wall-clock win
that flat parallelism gets for free. What `H` cannot do, and `G` can, is order work along
dependencies and hand a finished prerequisite to the tickets behind it — that difference, and
nothing else, is what the run prices.

`X` = ticket count × pilot-measured per-ticket head-on cost × 1.5, same number both arms,
set at freeze. Roughly $25–35 an arm; whole experiment ≤ $80 including pilots and rehearsals.

**`H` runs first.** When it finishes, stop and read it before `G` spends a cent: if `H` lands
every ticket, the pilot's headroom gate was wrong, the run is void, and `G` does not launch.
A void run charges nothing to the decision.

## 7. Reading the result

Primary: **tickets landed at equal dollars**, check exits 0 on the arm's branch, engine-run.

| result | outcome |
|---|---|
| `G` lands ≥ 2 more than `H` | **A** |
| within 1 ticket of each other | **B**, unless the tiebreak below says A |
| `H` lands ≥ 2 more than `G` | **C** |

Tiebreak, pre-registered: at parity on tickets, `G` takes A only if it wins **at least two of
three** — dollars spent at its last landed ticket, **wall-clock to its last landed ticket**,
and operator minutes per landed ticket — and is not more than 15% worse on the third. Anything
less leaves B. Wall-clock is measured launch-to-last-landed per arm, from the run record, both
arms at the same concurrency on the same idle machine. Operator minutes count whatever the
confirm model was; a scope rule's minutes are 0 and that is recorded as a property of the run,
not hidden.

Secondary, reported but deciding nothing: duplicate prerequisite builds (person-counted,
blind to arm); walls raised that became tasks that landed; `G`'s ledger decomposed into
map / shared / prove dollars. **The decomposition is not a rescue**: if `G` loses, "but the
proves alone were efficient" changes C to C, and goes in the log as engineering input only.

At 8–12 tickets a 2-ticket margin is a screen, not a proof, and is registered as exactly
that: A licenses a bigger run before any claim; C is the second strike against a graph that
has now been given the subject it was designed for, and second strikes are what defaults are
for.

## 7a. One fact about the hybrid, so outcome B is not oversold

Outcome B — flat pool, walls become tasks, no mapper — dedups **sequentially** discovered
structure only. A wall lands when its attempt settles; siblings already running in parallel
have each hit the same missing thing before the wall exists. The first run measured this
directly: `G-nomap`, which is exactly this configuration, built the shared scaffold **11
times, same as plain `S0`**; only upfront mapping got 2. So whichever outcome fires, the
timing options for structure discovery are, in cost order:

| timing | cost | catches parallel duplication |
|---|---|---|
| never (flat) | 0 | no |
| after the first wall (hybrid) | 0 | no — the wave already launched |
| a **canary**: one launch per family until its first attempt settles, then the family opens | 0 tokens, one serial hop of wall-clock | yes |
| a mapper before the fan-out | ~$0.60/ticket | yes |

The canary is not an arm of this experiment and is not built; adding it would re-grow the
five-arm design this protocol exists to not be. It is named here so the outcome's follow-up is
already scoped: under A it is the optimization to try against the mapper; under B it is the
upgrade to the hybrid; under C it is moot.

## 8. Execution order

1. This file merged. Gates E1–E5 built and rehearsed, each a commit that adds no arm.
2. Subject chosen, pilot run, P1 and P2 in a log entry with digests. Fail → back to §5.
3. `H`. Stop, read, void-check.
4. `G`.
5. One log entry per arm, numbers only. The decision, in this file's terms, appended to
   `EVALUATION-VERDICT.md` §9 with the row of §7 that fired. Then the action is taken.

## 9. Not decided here

The subject. Whether checks stay engine-enforced outside experiments (`open.md` question 4
keeps the general case). Confirm-mid-run (E3's scope rule sidesteps it for this run; the
viewer defect stands). Anything about a larger run, which outcome A must license explicitly.
