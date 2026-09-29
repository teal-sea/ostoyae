# EVALUATION-VERDICT.md

**Written 2026-08-30 against `EVALUATION-PROTOCOL.md` §8 and §9 and nothing else.** Numbers from
`~/erdos-frontier/eval/scores/*.tsv`, produced by `eval/score.sh` on each attempt's branch.
Inputs: `eval/tickets.json` and `eval/checks/` at the digests in
`log/2026-08-30-evaluation-run.md`. The operator's verdict, given before the last arm finished:
*"your experiment sucks and is poorly designed and a waste of the lab tokens."* It is recorded
here in those words, and §2 says why it is right.

## 1. The numbers

11 tickets. Landed = the ticket's check exits 0 on the attempt's branch, run by the scorer.

| arm | landed | attempts | output tokens | USD | landed per 1,000 output tokens | landed per USD | duplicate scaffold builds |
|---|---|---|---|---|---|---|---|
| `S0` head-on | **11** | 11 | 433,642 | 56.04 | 0.0254 | 0.196 | 11 |
| `S1` head-on, retry allowed | **11** | 11 | 408,221 | 53.97 | 0.0269 | 0.204 | 11 |
| `R2a`, `R2b` | not run (see log) | 2 killed | | | | | |
| `G-nomap` Ostoyae, no mapper | **11** | 14 | 402,899 | 51.80 | 0.0273 | 0.212 | 11 |
| `G` Ostoyae | **4** | 22 | 168,026 | 17.08 | 0.0238 | 0.234 | 2 |

Operator minutes: 0 in every arm, by the operator's instruction; every confirm in the `G` arms
was "yes to everything", scripted.

`G` in detail: 11 map attempts ($6.57 in total, 6 `walled`, 5 `done`), which proposed 8 shared
tasks and 28 edges; 3 shared tasks landed (scaffold $1.10, aggregator $1.29, `lcmInterval`
port $2.22); 4 tickets landed; 4 attempts failed in provisioning (below); 5 tickets never got
a prove attempt because the budget of 22 ran out. `G-nomap` spent 3 of its 14 attempts on
agent-proposed CI hygiene tasks unrelated to any ticket ($4.37), confirmed by the scripted yes.

## 2. Against §8, the criteria that count against the graph

| criterion | fired | evidence |
|---|---|---|
| `R2` lands ≥ `G` at matched tokens | **yes** | `R2` was not run, but `S0` alone lands 11 and `R2` is two of `S0`; `G` landed 4 |
| `G` ≈ `G-nomap` | no, worse | 4 vs 11 |
| `G` loses on tickets per operator minute | n/a | 0 minutes everywhere |
| `S0` ≥ `G` on the shared subset | **yes** | every ticket shares the prerequisite; 11 vs 4 |
| a `G` ticket landed without the engine's check | no | every landed ticket was scored on its branch |

Two fire. **By the frozen text the recorded conclusion is "simplify"**: keep the wall handback
and the append-only record, keep the board as a viewer, delete map attempts and the scheduling
loop, run tickets head-on.

That is the verdict. What follows is exploratory and does not soften it.

## 3. Why the tickets could not have said anything else

The primary endpoint hit the ceiling before `G` ran: one plain sonnet session lands every one
of the 11 tickets, including the three proofs written to be hard (41's Sidon case is a real
counting argument, 11's `< 10^7` bound is a kernel-checked bitmask sieve, 932 is a
smooth-numbers argument). With no headroom no arm can show a difference on tickets landed, and
the graph's mechanism, a wall that becomes a shared task, had almost nothing to act on: the
shared prerequisite is a two-line lakefile edit that every agent did alone in under a minute.
The pattern this protocol copies pre-commits this as a FAIL of the design (Zeta v1, v2, "no
headroom"), and the lesson was in that file before this one was written. The pilot that would
have caught it costs about $10 and was not run.

## 4. What `G` did that no other arm could, and what broke

Recorded because it is in the data, not because it changes §2.

- **Six of eleven mappers named the shared prerequisite as shared** and refused to fold it in:
  *"That is shared infrastructure six sibling vendor tasks all need identically, so it should
  not be created ad hoc by any one of them"* (a-0003, $0.43). Later mappers attached to the same
  node id rather than inventing their own, because `work.json` showed it to them. The scaffold
  was built once. Duplicate builds: 2 in `G` against 11 in every other arm. That is H3, in the
  predicted direction: eight shared nodes with 28 edges into the tickets. (The board screenshot
  is not included in this copy of the repo; it showed a local filesystem path.)
- **Then the engine threw it away.** A dependent cell is provisioned by merging every finished
  upstream branch into it. `t-prove-11-finite_bound1` needed `t-vendor-11` (whose agent had
  built its own scaffold, before the shared one existed) and `w-erdos-lib-scaffold`; the two
  edits to `lakefile.toml` conflict, `git merge` fails, and the attempt is recorded `failed`
  before any agent starts. Twice, exhausting the ticket. `t-vendor-677` died the same way on
  the scaffold and the `lcmInterval` port both touching the aggregator. Four of `G`'s 22
  launches were spent on provisioning failures with no agent, and both tickets they killed had
  been landed by every head-on arm. This is an engine defect, not a property of the idea:
  merging independent upstreams needs conflict handling (merge them in order into the cell and
  let the attempt resolve, or forbid two shared tasks from owning one file).
- **The loop's latency cost the rest.** Proposals are inert until the runner exits, and the
  runner exits when nothing is ready or the budget is spent. Six tickets sat parked while the
  other five consumed launches; by the time "yes" ran, 8 launches remained for 8 shared tasks
  and 6 parked tickets. The viewer refuses confirms while a run is live; in an unattended run
  that refusal is the wrong safety.
- **"Yes to everything" drifts.** `G-nomap`'s agents proposed CI hygiene tasks on Zeta
  (`w-erdos-lib-in-ci`, `w-dh-libs-in-ci`, `w-lean-cache-key-stale`), all confirmed, all run,
  none a ticket. The operator's click is a scope rule, and removing it needs one in code.
- **Cost shape.** Map attempts cost $0.29 to $1.11; `G` landed 0.234 tickets per dollar
  against `S0`'s 0.196, and fewer per output token. Both are reported, neither is the verdict.

## 5. Instrument defects found and fixed during the run

- Checks inlined the Lean statement inside a single-quoted block; a `'` in a statement made
  three S0 checks fail on a bash syntax error. Fixed (statement in a `.want` file), digests
  re-frozen, S0 re-judged on the same branches, nothing re-run.
- `params.max_turns` does not bound spend: the hard proofs took 24 to 49 reported turns and up
  to 168,920 output tokens. The per-1,000-output-tokens column is the comparison, as §4 said.
- `S1`'s retry never fired: a retry follows a recorded failure, every attempt exited 0, and the
  runner has no check of its own. `S1` was `S0` at a different random seed.
- The scorer's TSV shifts columns for attempts that reported no usage (the four provisioning
  failures); the landed counts are unaffected.
- Helper definitions (`maxPrimeFac`, `HasDensity`, `lcmInterval`, `minimalDistinctDistances`)
  are not pinned by the checks because the library that defines them is not cached; an agent's
  own definition passes. Not exploited as far as reading the proofs shows.
- The `R2a` stop killed two attempts and left two cells on disk for three minutes; `G`'s first
  mapper read one of them and said so in its map.

## 6. What §9 would have needed, and did not get

`G` beating `R2` on the whole set: no. `G` beating `R2` per operator minute: no data. Duplicate
work 1 in `G` and ≥ 4 in `R2`: the direction held (2 vs 11), the number did not, and `R2` did
not run.

## 7. What is licensed, and what is not

Licensed by §2: simplify, as specified there. Licensed by §3: a redesign of the tickets before
any further arm, with a $10 head-on pilot that must fail at least once. Licensed by §4, as
engineering rather than as evidence: fix upstream merging, allow confirm mid-run, give the
scripted yes a scope rule, and make the mapping instruction say "shared by siblings means its
own task with an edge to every sibling".

Not licensed: any claim that the graph beats head-on agents. Nothing tonight measured that
under conditions where it could be true.

---

## 8. Amendment, 2026-08-30: what §2 concluded on

Added after the verdict, not folded into it. §2 stands: it is what the frozen text says about the
numbers it was given. This says what those numbers were.

**Every row in §8 of the protocol is phrased "at matched output tokens", and §4 froze the band at
±15%. Two of the inputs to §2 are outside it.**

- `R2` was never run. The row that fired reads `R2 lands ≥ G at matched output tokens`; §2 scored
  it from `S0` by argument, which is reasoning, not a measurement.
- `G` spent 168,026 output tokens against a budget of about 867,000 — **19% of 2B, 81% below the
  band**. It stopped on a launch counter, not on its budget, with five tickets never attempted and
  11 of 22 launches spent on mappers costing $6.57 of $17.08. Its `4` is a measurement of that
  arithmetic.

So the primary result is **not obtained** rather than negative. That is not a rescue: the design
failure is untouched and is worse than the arms. With head-on at 11/11 the ceiling made the
primary endpoint undiscriminating before any arm ran, so nothing could have been shown in either
direction, and the graph loses on this ticket set on per-ticket arithmetic that does not depend on
any arm being valid. `log/2026-08-30-what-the-evaluation-can-still-answer.md` has that arithmetic:
the saving from not rebuilding the prerequisite was $0.87 a ticket against $0.60 a ticket to map,
so the break-even was about 17 tickets and there were 11.

**One line in §4 is wrong and it is the one that flattered the graph.** `G` at 0.234 tickets per
dollar against `S0`'s 0.196 compares different ticket sets: `G` never attempted the three
expensive proofs. Restricted to the same eight cheap tickets `S0` lands **0.427 per dollar and
0.0871 per 1,000 output tokens**, against `G`'s 0.234 and 0.0238. Controlled for ticket mix `G` is
about 1.8× worse per dollar and 3.7× worse per token. §4 called this "cost shape" and reported it
neutrally; it should have been reported as inverted.

**What §2's remedy over-reaches on.** It says delete map attempts *and the scheduling loop*.
`S0` $56.04, `S1` $53.97 and `G-nomap` $51.80 all land 11/11, and `G-nomap` is the DAG and the
wall handback with no mapper. Three complete arms at parity support deleting the mapper. Nothing
in the run counts against the scheduling loop, and it is the part the flag paragraph needs.

Two engine defects §2 depended on are fixed in the commit that adds this section: an upstream
merge conflict no longer kills an attempt before an agent starts, and budgets can be set in
dollars and output tokens rather than launches. Both are verified against a fake executor only.
Neither changes anything above; they change whether a future arm can spend its budget on the thing
being compared.
