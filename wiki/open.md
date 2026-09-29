# Open

## 11. What automatic governance, if any, belongs beyond the implemented bounded scope?

The current engine has two authorized confirmation scopes. The default is an explicit operator
decision on each proposed work item or edge. The narrow exception is a run started with
`--auto-advance`, a configured judge and an operator-selected positive cap: it may confirm fully
judged routes to that invocation's original open tickets. It does not accept statement revisions
or reopened edges.

That behavior answers what the current runner may do, not what all future governance should be.
Whether other automatic scopes should exist, and what review or authority they would require,
remains undecided. Coordination can state an objective and boundary; independent consultants may
reject its framing, and workers retain method freedom within the authorized boundary. Neither
conclusion becomes a graph decision merely because it was reported.

Opened 2026-09-13 in the consolidation correction. No new scope is authorized here.

## Should a cell be steerable, and what does that do to the record?

Opened 2026-09-10. Cells are reachable mid-flight through `SendMessage`, measured. The engine
has no concept of it and the attempt record has no field for it, so a steer is invisible to the
board and to the judge.

Undecided, and it is not merely an implementation question. An earlier runner treated a steer as a
recorded defect: an unfolded one recurs on every future run, so the count per run is a
measurement of whether the briefs are good enough to scale. That framing says steer freely and
record ruthlessly. The opposite reading is that this engine's cell is deliberately a sealed
contract, `what` in and a report out, and that a mid-flight channel makes every attempt's
provenance ambiguous and every comparison between runs unsound.

Both cannot be true at once. Whichever way it goes needs a line in the log saying why.
→ `log/2026-09-10-cells-are-reachable-and-the-record-does-not-know.md`

What is undecided. Moving something off this page is a real decision and needs a line in the
log saying why and which way it went.

Nothing here is guessed at in `model.md`. If you build on one of these, say which one and which
way you assumed.

---

## ~~1. Are dependency edges authored up front, or only visible in hindsight?~~ CLOSED

The 2026-08-29 answer said hindsight only. That was too absolute. The implemented answer has
two sources with different provenance:

- A person may seed a known initial dependency in `work[].needs`.
- A dependency learned while the board runs comes from a mapping probe or wall, enters as a
  proposed edge and carries the attempt that found it.

Authored `needs` affect scheduling immediately. A discovered edge affects scheduling only after
confirmation. The graph can start with known structure and still grow from execution evidence.
This is closed because the board format and runtime already support both sources.

## 2. Is the artifact layer real, or a property of an attempt?

An attempt produces files. Whether those deserve their own plane with their own version edges,
or are just fields hanging off the attempt, depends on one thing: would you ever want to look
at the artifact plane on its own with the agents hidden?

If yes it is a layer. If no it is a property and the model gets simpler.

## 3. What are the work layer's nodes?

"Work item" is a placeholder and it is doing too much. A theorem, a bug, a feature, a question,
a refactor slice are not obviously the same kind of thing, and the top layer's node type
decides how the graph gets authored.

**2026-09-05.** One of those is now distinct in the engine: a **question** is an item with two
finishes, and a `done` attempt says which (`answer: true|false`). Built because the lean-eval
board had refuted 12 statements across 20 attempts and recorded every one as a failure, since
"prove X" had no box for "X is false". A refuted item is satisfied, its counterexample merges to
the trunk, and what needed it true is blocked rather than unblocked. Still open here: whether an
item that needs a question *settled either way* is a different edge, and what a wall that
proposes a question rather than a lemma should look like.
→ `log/2026-09-05-questions-and-the-disproof-machine.md`.

## 4. When does an attempt get judged, and by what?

In a scoped run, pass or fail is enough and the gate is tests. In an open-ended run you need
something closer to a score, because selection is what makes the search converge.

**This depends on the application and should be switchable, not baked in.** A tightly scoped
task on clean code does not need a gradient. An open search does. The engine should not assume
either.

An outside lab sent a shape for this on 2026-08-29, kept verbatim in
`raw/2026-08-29-rogue-lab-verification-brief.md`: split `done` into `claimed` and `done`, a
`check` shell command declared on the work item before the run and run by the engine after it,
mechanical invariants on the handback, and a reviewer attempt only at a boundary. Their own
caveat is that they never ran it. Not decided.

Map attempts, added 2026-08-29, take the same shortcut: a map attempt is judged done by the
presence of a non-empty `map.settles`, and nothing checks what it says. The operator, the same night:
*"you have to check that their output is correct because if the mapping is wrong everything is
wrong but either way even if that happens the system we build should be able to handle that as
well."* Today the check is the operator, on the card, and after a wrong yes nothing withers: a
confirmed edge is confirmed forever and there is no way to un-say yes. Three pieces would make
a wrong map survivable, none built: refuse a map that makes a cycle, at confirm time; retract,
un-confirming an edge or a task with a date, so a wrong map can wither; and evidence against a
map, so a prover that walls on a task the map called ready is recorded against that map and the
page says so. That is the fungus rule from the doctrine, reinforce what is found and let the
rest wither, and it is the next thing to build. One thing the first live run did show, the same
day: the misuse can go the other way too. `a-0001` reported Mertens building sorry-free and
walled anyway, on things it said did not gate the proof, so a `done` was recorded as `walled` on
the agent's own reading of the words.

**2026-09-03.** The brief's shape is built, and its four parts with it:
a check runs on a fresh checkout of the branch, never the cell; a `verify` attempt reads every
handback's proposals and lands a verdict on each and on the wall, which the unattended yes
honours and an attended one may override; a wall that restates its task is failed; a confirmed
edge carries a fingerprint and reopens when its text moves. `done` without a check stays `done`
and the record says "on the agent's word", so the three-state vocabulary is untouched. Rehearsed
with the fake executor, not yet against a real agent. **Still open here:** scores and ranking for
the open-ended case (the brief says don't, and nothing measured says otherwise); retracting a
confirmed work item, not just an edge; and recording evidence against a map, a prover that walls
on a task the map called ready. → `log/2026-09-03-the-judge.md`.

**2026-09-05: the blind spot has a price now, measured on the lean-eval board at $642.68 total
spend.** The judge type-checks a statement; it cannot tell a well-typed false one from a true one.
What that costs:

| | |
| --- | --- |
| items the judge passed that were later rejected | 47 |
| of those, items that got as far as a prove attempt | 14 |
| spent on them before they were closed | $110.80 |
| the judge itself: 75 verify attempts | $98.82 |
| proposals and edges the judge refused | 135 |

So the judge costs about what its blind spot costs. Every dollar on a rejected item is on one the
judge passed; none was ever spent on an item it refused. The loss is concentrated: 14 items, about
$7.91 each, and the worst single one is $12.88.

**What tonight showed about a possible answer.** An external prover service is already told, in the submit prompt,
*"If the statement is false as written, say so and prove the negation instead"*, and on
`IsSylvesterDomain.ring_coherent` it did exactly that, returning a sorry-free counterexample after
Dicks–Sontag. That arrived three hours after $10.58 had already gone into proving it. Running it
*before* the prover, on statements the judge has passed, is the shape of the fix. Two things stop
it being an obvious yes and both are the operator's call, not the engine's:

1. **The prover allows one job at a time** (measured 2026-09-05), and 7–25 minutes a call. At 14
   suspect items over three days that is comfortably within one slot, but it puts a wait in front
   of a prove, and a stage that delays every prove is a scheduling policy.
2. **It is a filter, not a decision.** The prover failing to refute is not evidence a statement is
   true, so this catches some false statements and cannot promise a rate.

Not built. If it is built it should be a stage a graph declares, off unless declared.

**2026-09-05, evening: not the external prover.** zeta-lab measured it on 2026-09-04
(`hunts/frontier_math/TOOL-SURVEY.md`, addendum): free, and unusable inside a cell all the same,
7 to 25 minutes against a shell tool that cuts off at about two, one job at a time, five
of six cells on batch three proving by hand while they waited and using none of the answers.
The shape that fits is zeta-lab's own: **a battery per kind**, a surrogate null the statement
must not vacuously satisfy, run in the gate that already elaborates statements. `a-0129`'s
one-vertex graph is that null. Not built.

## 5. Three layers or more?

Three is the current answer. The caution is that it is easy to keep adding layers because
encoding a relation as a plane is cheap, and past three nobody can read the thing.

## ~~6. Not yet named~~ CLOSED

**Ostoyae**, 2026-08-26, after *Armillaria ostoyae*.

## 7. Should a walled attempt count against `max_attempts`?

Raised 2026-08-27 by building it. Today it does: an attempt that hit a wall and produced an edge
consumes one of the work item's attempts, same as a failure.

The argument for counting it is budget honesty, it launched an agent and spent the money. The
argument against is that it is the outcome the doctrine calls a success of a different kind, and
charging for it means a work item that keeps finding structure runs out of attempts and is marked
exhausted for being informative.

Not urgent. It only bites on a work item that walls more than once, which has not happened yet.

Map attempts, 2026-08-29, went the other way: they have their own budget, `mapping.max_attempts`,
default 1, failed map attempts count and walled ones do not, and none of it touches
`max_attempts`. Charging a cheap probe to the proving budget would have silently halved it for
any graph that opts in. The prove-side question above stays open.

## 8. Three things the map-first change assumed, 2026-08-29

Built, not decided. Each is a one-line rule today and could go the other way.

- An item that already walled is mapped after its wall is answered, like any item without a
  map. One rule that reads in a sentence, at the cost of a map attempt on an item whose wall
  already said what it needs.
- A map whose only proposals are edges out of the item (unlocks, nothing missing) still parks
  the item until the operator answers. Not launching is not acting on a proposal, and the
  alternative was a special case.
- A second map attempt that walls on proposals already in the graph hands back nothing new and
  is recorded `failed`, the same walled rule as proves. With the map budget at 1 that exhausts
  the item right after the operator confirmed exactly what it asked for. Seen in verification
  on 2026-08-29 with the fake executor; whether a real agent does this is unobserved.

## ~~9. Is a corrected statement a duplicate or a revision?~~ CLOSED 2026-09-04

**A revision.** Decided by the operator the same night.
Built and rehearsed the same hour; what the fix does is at the bottom of this entry.

Undecided, and observed rather than guessed: on the lean-eval board, `a-0115` was told to prove
`Group.LocallyIndicable.exists_divisionRing_embedding` and came back with a refutation. The item's
statement is false as written — `G` and `K` introduce two universe parameters, so
`MonoidAlgebra K G : Type (max u v)`, while the item pins `D` to `Type 0`, which forces
`Small.{0} K` — and the agent proved that in Lean and proposed a corrected statement rather than
asserting it.

None of it reached the graph, in four steps:

1. Identity is the claim, and the claim is keyed on the `decl`. The correction names the same
   `decl`, so it resolved onto the existing item: *"a-0115 added as a finder of the same claim"*.
   The corrected statement was absorbed, not recorded.
2. So `result.found` was empty.
3. A wall is only `walled` when it found something (`run.mjs`, the `rep?.wall && found.length`
   branch). Empty fell through to `failed`.
4. So a refutation was recorded as a plain failure, the item kept its false statement, and the
   scheduler launched a fourth attempt at it.

**That is the paragraph this repo is judged by, running backwards inside the engine.** It is not
a scheduling bug: it is two rules that are each right on their own.

Keying identity on the `decl` is what makes two mappers naming one lemma into one item with two
finders, which is the 2026-08-31 fix and is worth keeping. It is also what makes a *corrected
statement* indistinguishable from a *duplicate*, and those are not the same thing.

The shape of an answer, not chosen: a proposal whose `decl` matches an existing item but whose
`statement` differs is a proposed revision, not a finder — the machinery is already here, it is
what reopens a confirmed edge when the text of an end changes. What it would cost is that a
mapper paraphrasing a statement it did not read carefully opens a revision instead of colliding
harmlessly, which is the noise the ontology was built to remove.

The narrow half is separable and is not this question: a wall whose proposal collided with an
existing item still walled. It named something real. Today it is recorded `failed`.

**Confirmed within the hour, at a price.** `a-0127` was the fourth attempt, launched by the
scheduler after `a-0115` had already refuted the statement. It independently re-derived the same
refutation — same universe defect, arrived at by a cardinality argument instead of `Small.{0}`,
and it too declined to weaken the statement. Four attempts, $9.77, two of them agents proving the
same thing false with no way to tell each other. The item is still `active` and still carries
`∃ (D : Type)`.

The prediction and the confirmation are both on the record here because the confirmation is what
makes this a defect rather than a design opinion: the engine cannot currently learn that a
statement is false, no matter how well an agent proves it.

**And again, on a different item, correcting a different thing.** `a-0129` was told to prove
`GoodLTC.expanderMixingLemma` and found it false as written: `IsSpectralExpander G d lam` puts no
constraint on `lam` when `Fintype.card V ≤ 1`, because on a one-vertex graph the only vector with
vanishing sum is zero, so the Rayleigh-quotient clause holds vacuously for every real `lam`,
negative ones included. Its correction was to the *definition the item depends on* — add
`0 ≤ lam` — and it named `w-def-goodltc-isspectralexpander`, which exists. Same four steps: same
claim, absorbed as a finder, nothing found, `failed`, item still active. $3.25.

So the defect is not about an item's own statement. **Any proposal that corrects an existing claim
is absorbed as a duplicate of the thing it corrects**, whether it is the item being worked or a
definition upstream of it. Three refutation attempts in this batch, `a-0115`, `a-0127`, `a-0129`,
and all three are recorded `failed` with `found: []`.

Correcting an upstream claim is the single most valuable thing a prove attempt can hand back,
because one bad definition is wrong under every lemma that rests on it. It is currently the one
kind of handback the graph cannot hold.

**Correction, after reading the code instead of the symptom.** The first three notes above say
identity is keyed on the `decl`, so a correction cannot be told from a duplicate. That is not what
`run.mjs` does, and the difference matters for how big the answer is.

Identity is the hash, and the hash is `claimHash(kind, claim)` over the whole claim, statement
included. A corrected statement therefore has a *different* hash and does not collide. The
absorption happens one clause later:

```js
const have = g.work.find((x) => x.claim_hash === hash) ?? work.get(id);
```

The first clause is identity and is right: the same claim, however it was named, joins the item
that already carries it, and that is what makes parallel mappers safe. The second clause is not
identity at all. It is id-uniqueness — the id is the slug of the `decl`, two items cannot share
one — and it silently treats *a different claim wearing the same name* as the same thing. The
comment above the line describes only the first clause.

`a-0115`'s proposal, read off its branch, is exactly that case: `decl` unchanged, statement
changed from `∃ (D : Type)` to `.{u, v}` with `∃ (D : Type (max u v))`. Different claim, different
hash, same name, absorbed.

So the question is smaller than the first three notes make it: **the ontology already
distinguishes a correction from a duplicate.** What is undecided is only what to do when the hash
misses and the id collides — today, join silently; the alternatives are to record it as a proposed
revision of the item it renames, or to give it a disambiguated id and let the judge rule on which
statement is right. Neither changes what identity means.

**The controlled comparison, from the same batch, same executor, same night.** `a-0133` was told
to prove `BoseGases.exists_unique_isScatteringSolution` and also found its statement false: the
uniqueness half fails because `IsScatteringSolution` is invariant under changing `w` on a null
set. Same kind of handback as `a-0115`, `a-0127` and `a-0129`. It is recorded `walled`, with six
proposals: three typed lemmas and three edges, a whole decomposition of the item into what is
actually true.

The only difference is the names. `a-0133` proposed `BoseGases.not_exists_unique_...`,
`BoseGases.exists_...` and `IsScatteringSolution.ae_eq` — three decls the graph had never seen,
so nothing collided and everything landed. The other three named a decl the graph already had.

Four refutations in one batch:

| attempt | what it corrected | name already in the graph | recorded |
|---|---|---|---|
| `a-0115` | the item's own statement | yes | `failed`, nothing found |
| `a-0127` | the same statement, independently | yes | `failed`, nothing found |
| `a-0129` | an upstream definition | yes | `failed`, nothing found |
| `a-0133` | the item, under new names | no | `walled`, 3 items and 3 edges |

**Whether a discovery is recorded as the outcome this repo exists for, or as a plain failure,
currently turns on whether the agent happened to pick a name the graph already holds.** Nothing
about the quality of the finding is in it. All four proved their refutations in Lean.

**It is not four attempts and it is not tonight.** Across the whole lean-eval board to date:

- **6 items have been refuted** — an agent showed the statement is false as written, in Lean, not
  by assertion.
- **11 attempts were spent doing it**, $28.26, because a refuted item stays active and gets
  attempted again.
- **10 of those 11 are recorded `failed`.** The one exception is `a-0133`, which happened to
  invent new names.
- **Every one of the 6 items had been judged `ok = true`** by a verify attempt before any of this.

The denominator that matters: **62 items have ever been given a prove attempt, and 6 of them are
false.** Roughly one in ten of the statements this board hands to a prover is not provable,
because it is not true.

That last line belongs to question 4 as much as to this one. The judge type-checks a proposed
statement against Lean before passing it, which is what catches a malformed claim, and it is
exactly what cannot catch a well-typed false one. `Group.LocallyIndicable.exists_divisionRing_embedding`
type-checks perfectly; it is refuted by a cardinality argument. A gate that runs the elaborator is
not a gate on truth, and the board's verdicts should not be read as one.


### What was built, 2026-09-04

A proposal whose claim hash misses but whose id collides is a correction, and it lands as its own
item: id disambiguated by the claim hash, `revises` naming the item it corrects, and `revised_by`
recorded on that item so a reader of the false statement is told a correction exists. The wall
that found it now has something in `found`, so it is `walled`, which is what it always was.

Two agents proposing the same correction still collide on the hash and become one item with two
finders. That is the property the ontology was built for and the thing the fix could not break;
it is also what would have stopped `a-0127` paying $2.27 to re-derive `a-0115`'s refutation.

Confirming a revision closes the statement it revises: `rejected`, dated, with the reason and the
id that replaced it. Both cannot stand, because they are the same declaration and carry the same
`check`, so two active items would send two agents to write one name two different ways. The
closed item is never deleted — the record of having believed a false statement is worth keeping.

And one thing the rehearsal found rather than the argument: an item a person typed into the graph
carries no `claim_hash`, so the hash lookup could never match it and every proposal naming it
looked like a revision. Items that carry a claim are now hashed on the spot when they have no
stored hash.

`bin/rehearse-correction`, 8 assertions, zero model calls.

**Not done, and why.** The judge still cannot tell a well-typed false statement from a true one —
that is question 4, not this one, and it is why these statements reached a prover at all. And the
artifacts of a wall still never reach the trunk: ten refutation modules, sorry-free and
`#print axioms`-clean, are sitting on branches nobody reads. That is a separate defect and it is
not fixed here.

## 10. What replaces `--usd` and `LIMIT_RE` when the agent runs off the box?

Raised 2026-09-06 by the cloud-session finding
(`log/2026-09-06-the-cell-in-a-cloud-session.md`). A cell in a Claude Code cloud session costs
nothing in compute and gets 15 GB to itself, which is the whole reason to want it. But the cloud
session does not hand its usage back to whatever launched it, and the plan window's words never
reach the runner's output tail. Two guards the operator relies on stop working, and they are
guards, not conveniences:

- **`--usd` and `--output-tokens`** are cumulative over `attempts[]` and read from
  `.ostoyae/usage.json`, which `executors/claude.sh` writes from `claude -p`'s final
  `stream-json` event. **Updated September 12:** missing or invalid settled usage now
  stops the corresponding cap; it does not provide a known total or cancel already-running
  concurrent work. The old claim that missing usage leaves the cap entirely inert is
  superseded by the September 9 spending fixes. Separately,
  `nothingRan()` (`viewer/state.mjs:52`) stops recognising the attempts a closed window killed,
  because it keys on `cost_usd === 0 && turns <= 1`.
- **`LIMIT_RE`** turns the CLI's *"You've hit your session limit"* into `limited: true` and stops
  the run. It matches the executor's output tail (`run.mjs:1224`). Remotely that text is in a
  session transcript the runner never reads. On 2026-09-05 the same blindness, from a regex that
  matched the wrong words, cost 314 cells launched into a closed window in an hour, each spending
  one of its item's four tries.

A remote adapter still needs reliable usage and window signals for meaningful accounting
and timely cancellation. Launch/invocation bounds remain available independently of price
coverage. The following September 6 options are historical design alternatives, not a claim
that the present runner ignores missing usage:

1. **A launch cap and nothing else.** `--launches N` already binds without usage. Honest, and it
   prices a mapper and a hard proof the same, which is exactly what `--usd` was added on
   2026-08-30 to stop doing.
2. **Read the window some other way.** Poll the account's usage before each launch rather than
   inferring it from an attempt that already failed. Nothing in the repo does this and no endpoint
   for it has been checked.
3. **Make the cell report its own.** The prompt tells the cloud agent to write usage into the
   handback it commits. That is the agent's word about its own cost, which is the kind of thing
   the `check` field exists because the engine does not trust.

This is a scheduling and budget decision, so it is the operator's, and it blocks nothing until a
cloud executor is actually wanted. **Do not build the executor without picking one**: a run whose
caps silently do not bind is worse than no cloud executor at all.

**Scoped 2026-09-10, not closed.** This question is about the agent running *off the box*, which
is what `claude --cloud` dispatch would be. It does **not** apply to running the engine inside a
cloud VM, where the runner and the cell are on one machine and the cell is an ordinary headless
`claude -p`: `--output-format stream-json` reports usage exactly as it does on the Mac, and
`LIMIT_RE` reads the executor's own output tail. Measured that day, one real cell:
`$0.0308`, 661 output tokens, 3 turns, and the allowance bound on it. Both guards work there. The
question stands, unchanged, for the dispatch shape it was raised about.
→ `log/2026-09-10-what-the-cloud-docs-actually-say.md`
