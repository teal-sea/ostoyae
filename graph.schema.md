# The graph, as data

A graph is one JSON file. Everything the runner needs is in it, everything the runs discover goes
back into it, and it is readable by a person without running anything.

**One file is the point.** The map-first method's diagnosis of the Mertens failure is that the
run discovered the edge and wrote it to `threads.json`, which nothing reads when ranking.
Discovery and allocation have to share a substrate or the loop does not close.

`sandbox.port_base` accepts `"auto"` for a reserved, available port per cell, or an integer
base for explicit `base + attempt number` assignments. New boards use `"auto"` so boards
running concurrently do not all choose the same ports. The selected number is recorded on
the attempt before its executor starts.

```json
{
  "graph": "fix-booking-race",
  "concurrency": 3,
  "max_attempts": 3,
  "sandbox": {
    "repo": "/home/you/booking-app",
    "root": "/home/you/ostoyae-worktrees",
    "base": "main",
    "port_base": "auto",
    "link": ["node_modules"],
    "db": {
      "admin_url": "postgres://localhost/postgres",
      "template": "booking_golden",
      "url_pattern": "postgres://localhost/{db}"
    }
  },
  "work": [
    { "id": "w-schema",  "what": "add the idempotency column", "needs": [] },
    { "id": "w-confirm", "what": "guard the confirm path",     "needs": ["w-schema"] }
  ],
  "edges": [],
  "attempts": []
}
```

## Fields

**`execution`**, optional CLI configuration, persisted by `init`. `provider` selects `claude`,
`codex`, `gemini`, `aider`, `opencode`, `muse`, `grok`, or `custom`. `profile` is `auto`, `local`,
`headless`, or `claude-cloud`. A custom provider requires `command`, a shell command implementing
the attempt/handback contract. Profiles never widen credential passthrough or sandbox access.

```json
"execution": { "provider": "codex", "profile": "headless" },
"defaults": { "agent": "codex", "model": "your-codex-model-id", "effort": "high" }
```

CLI selection: explicit `--agent`/`--exec`, then `OSTOYAE_EXEC`, then `work[].params.agent`,
then `mapping.params.agent` or `judge.params.agent`, then `defaults.agent`, then `execution.provider`,
then Claude for older boards. A CLI executor overrides every attempt. `--model` and `--effort`
temporarily override board defaults; work, map and judge parameter overrides retain their normal
precedence. The selected agent, model and effort are stored on each attempt. Codex needs an
explicit Codex model. Models are opaque strings, except recognizable model families from another
provider are refused. Effort is a short token matching
`^[a-z0-9_-]{1,20}$`; the provider decides which levels it accepts.

The runner heartbeat carries a process birth `identity`; each running attempt can carry
`cell_identity`. These records permit safe ownership checks across macOS and Linux. Older
records remain readable; unknown ownership never authorizes a kill.


**`concurrency`**, how many attempts may be running at once.

**`messaging`**, optional and on by default. Set it to `false` or run
`ostoyae go --no-messaging` to disable messages. Use
`{"max_chars": 2000, "max_sends": 20}` for per-attempt limits. Every cell gets `ostoyae-msg send
<attempt-id|all> "text"`, `ostoyae-msg read`, and `ostoyae-msg who` on its PATH.
Claude Code and Codex also deliver unread messages after tool calls; other adapters use
the read command, and their contract tells them to run it before editing a file and before
finishing.

Ostoyae does not wait for agents to find each other. Each attempt's contract lists the attempts
already running when it launched (attempt id, job, the job's `what` shortened, agent and model) and
tells it to check with a peer before editing the same area. While attempts run, the runner looks
every few seconds at the files each running cell has changed since its own start commit (tracked
changes and new untracked files, not `.ostoyae/`, the injected contract or compiled Python). When
two running attempts have both changed the same path, it sends each of them one message from
`ostoyae` naming the file, the other attempt, its job and agent, and what to do. Each pair hears
about each path once. These notices are ordinary mailbox entries with an extra
`"overlap": {"path": ..., "with": <other attempt id>}`, so they appear in the board's `messages`.
The runner uses git on the cells only; with messaging off it does not look at all. Other adapters use a temp-file relay so their shell sandboxes can keep
the mailbox outside cell workspaces. A separate append-only JSONL mailbox lives in a `.mail` directory beside
the board. A directory lock serializes appends and cursor updates. The board keeps the
messages, per-attempt send/read counts, and the last run's sent count.

**`max_attempts`**, how many attempts one work item gets before it is exhausted and anything
downstream of it is blocked forever. Counts prove attempts only; map attempts have their own
budget, below.

**`mapping`**, optional. When present, every work item gets a cheap **map attempt** before any
expensive prove attempt. The mapper is the map-first method's step 2: it converts the item from
prose into coordinates. A node is a task and an edge is a dependency, so the mapper hands back
the tasks the item breaks into, each small enough for one run, the edges between them so they
read start to finish with the last edges pointing at the item, what would settle it, and a cost
class. It writes no proof. A map that comes back as another project ("prove the prime number
theorem") instead of tasks is a bad map; today only the operator can tell, see `open.md`
question 4. Absent, or `null`, means off and nothing about maps applies.

```json
"mapping": {
  "what": "Map this theorem; do not prove it. Turn it from prose into coordinates: the tasks ...",
  "max_attempts": 1,
  "params": { "model": "sonnet", "effort": "low" }
}
```

**`mapping.what`**, the instruction handed to every map attempt, **required** when `mapping` is
present. There is no default in code: the runner and `doctor` refuse a graph that has `mapping`
without a non-empty `what` (exit 2, naming the field), because a person opening the graph should
be able to read what the mapper was told. The runner appends `The work item you are mapping is
<id>: <what>` after a blank line.
**`mapping.max_attempts`**, how many map attempts an item gets, a positive integer, default 1.
Anything else is refused at load. Counts **failed** map attempts only; a walled map attempt does
not spend it, because a wall is the outcome this repo exists for. An item whose map attempts are
all spent with no map is exhausted.
**`mapping.params`**, merged into a map attempt's `params` after `defaults` and the item's own
`params`, so a different agent, model or effort for maps is one line in the file.

**`work[]`**, the work layer. `needs` holds dependency edges the operator typed. `status` is
`active` when absent.

**`work[].source`**, optional origin metadata for imported issues. GitHub imports store
`{ "kind": "github", "repo": "owner/repo", "number": 42, "url": "https://github.com/owner/repo/issues/42", "updated_at": "2026-09-27T00:00:00Z" }`.
The source identifies the issue for later imports; issue text remains only in `what` and never
becomes a check or command.

| `status` | meaning |
|---|---|
| absent / `active` | ordinary work. Scheduled when its dependencies are satisfied. |
| `proposed` | an attempt proposed it. **Never scheduled.** Waiting on the operator. |
| `rejected` | the operator said no. Never scheduled, kept as a record of a closed route. |

A proposed or rejected item also carries `found_by` (the attempt ids that proposed it) and
`found_at`.

**`work[].answer`**, `true` or `false`, with `answered_by` and `answered_at`: written by the
runner when a done attempt hands back an `answer`. An item is satisfied either way. Answered
`false`, it is a refutation: the statement is false, the counterexample is on the trunk, and
anything that `needs` this item is blocked rather than unblocked, because a proof that rests on
a false statement has nothing to rest on.

**`work[].map`**, the record of the item's map, written by the runner when a map attempt ends
`done`, or `walled` with a valid map beside the wall. An item with a `map` is mapped and its
next attempt is a prove attempt. So is an item whose `found_by` names a map attempt: the mapper
that proposed it sized it, and it is not mapped again.

```json
"map": {
  "by": "a-0006", "at": "2026-08-29T20:11:03.000Z",
  "settles": "the Lean statement, sorry-free, in lean/Frontier/X.lean",
  "cost": "large", "notes": "anything the prover should know",
  "needs": ["w-lemma"], "unlocks": ["w-other"]
}
```

`needs` and `unlocks` are derived by the runner from the edges that attempt proposed (into the
item, out of the item), never copied from the agent's prose. A person may type a `map` by hand
with no `by`; the item then counts as mapped, and its prove attempts are told `Map (by hand)`.

**`edges[]`**, dependency edges **discovered by runs**. `from` blocks `to`: `to` cannot start
until `from` is satisfied, the same direction as an authored `needs`, so the two read together.

```json
{
  "id": "e-0001",
  "from": "w-schema",
  "to": "w-confirm",
  "why": "the guard has nothing to read without the column",
  "status": "confirmed",
  "found_by": ["a-0001"],
  "found_at": "2026-08-27T19:04:11.244Z",
  "decided_at": "2026-08-27T19:06:02.118Z"
}
```

`status` is `proposed`, `confirmed` or `rejected`. **Only `confirmed` edges affect scheduling**,
and only when both endpoints are `active` work, confirming an edge is not a way to sneak a
proposed work item into the schedule.

**The graph is a DAG.** Authored `needs` plus confirmed edges between `active` work must form a
directed acyclic graph: no job may wait, directly or through others, on itself. A cycle never
crashes anything, every job in it just waits forever, so it is refused by name. `ostoyae doctor`
blocks a board that has one and prints the loop (`dependency cycle: w-a → w-b → w-a`), and `go`
will not launch it. A yes that would close a cycle (`confirm`, `confirm-scoped`, the judge's
`--auto-advance`, the viewer) is recorded as a no: the edge or job becomes `rejected`, with
`rejected_why: "would close a dependency cycle: <path>"`, and the run keeps going.

`found_by` is a list because two attempts can walk into the same wall independently, and that is
worth knowing.

**`attempts[]`**, the node layer, appended as the run goes. Never edited, only appended.

```json
{
  "id": "a-0001",
  "of": "w-confirm",
  "from": null,
  "state": "walled",
  "params": { "agent": "claude", "model": "opus", "budget": "30m", "attempt": 1 },
  "sandbox": { "worktree": "wt/…/a-0001", "branch": "ost/…/a-0001", "db": "…", "port": 4101 },
  "started": "t+0",
  "ended": "t+1",
  "started_at": "2026-08-29T17:16:12.245Z",
  "ended_at": "2026-08-29T17:16:19.4Z",
  "result": {
    "why": "exit 1",
    "wall": "there is no idempotency column to guard the confirm path on",
    "found": ["w-schema", "e-0001"]
  }
}
```

**`of`**, which work item this is an attempt at. The inter-layer edge.
**`from`**, the attempt this one derives from: a retry, or a mutation of it. Null for a first
attempt. This is the derivation edge and it is a different relation from `needs`.
**`state`**, `running`, `done`, `failed`, or `walled`.
**`kind`**, `map` or `prove`. Written on every attempt the runner starts; absent on older records
and read as `prove`. `from` and `params.attempt` count within a kind: a map attempt's `from` is
the previous map attempt of the same item, a prove attempt's is the previous prove attempt. A
prove attempt on a mapped item has the map appended to its `what` after a blank line, `Map
(<by>): settles: ...; cost: ...; notes: ...`, so the prover is told what the mapper found.
**`result.map`**, on a done map attempt, `{ settles, cost, notes }` exactly as handed back.
**`started_at`**, **`ended_at`**, wall clock, beside the logical clock. `t+0` orders attempts
against each other and cannot say this one has been going for eleven minutes, which is the
question somebody watching a cell actually has. `ended_at` with no `ended` means the attempt was
swept: a runner died holding it and a later run settled it, so it never ended in any run's clock.
**`result.wall`**, what stopped it, in its own words. Present only on an attempt that did not
finish: it is what makes the attempt `walled`.
**`result.ahead`**, a finding about the *next* attempt from one that did finish. Recorded, and
deliberately without effect on `state`, so a warning never costs an attempt its work.
**`result.answer`**, `true` or `false`, from an attempt told to settle a statement rather than
prove it: `true` is a proof, `false` is a refutation. Recorded on any attempt that handed it
back; applied to the item only by a done one. A refutation is finished work, so a done attempt
that answered `false` merges to the trunk like any proof, and the item carries `answer: false`,
`answered_by` and `answered_at`. Anything but a boolean is a note on the attempt, not an answer.
**`result.found`**, the ids of everything it put into the graph. This is what makes a walled
attempt worth its cost.
**`result.integrated`**, the trunk branch this attempt's work was merged into. Only a done
prove attempt gets one.
**`result.conflict`**, the paths that stopped it merging, when two finished attempts own one
file. The attempt is still `done`: it did its work, and its branch still holds it. Only a
person can say which side is right, so the trunk is left untouched and this says why.
**`result.usage`**, what it cost, as the executor wrote it to `.ostoyae/usage.json` beside the
handback: `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, `cost_usd`, `duration_ms`, `api_ms`, `turns`,
`web_search_requests`, `web_fetch_requests`. Recorded on every outcome, because a failed attempt
cost money too. When a session emits several result events, token counts and turns are summed
across them while cost and durations take the max (the per-event fields are incremental versus
cumulative); an exact-duplicate event merges once. Absent when the executor wrote none, and the run's `spent:` line counts those
as unpriced, never as zero. Codex records cached input separately, subtracting it from total
input so it is counted once. Codex JSONL does not report billed dollars, API time or agent
turns: those fields are `null`. Optional `params.codex_pricing` rates per million tokens
(`input`, `cached_input`, `output`) produce an explicitly labeled estimate, with rates saved
on the usage record; it is not an invoice. A dollar-capped run stops when any settled
attempt has missing, malformed, negative or nonfinite cost. Output-token caps likewise
stop on missing or invalid settled output counts; token reservations use token coverage,
independently of dollar coverage. In-flight estimates are not hard billing limits.
This is the denominator `wiki/EVALUATION-PROTOCOL.md` matches arms on.
**`params`**, everything adjustable. The runner hands the object to the executor.
`params.agent`, `params.model` and `params.effort` override their board defaults.
For map and verify attempts, `work[].params.agent` wins over the role's agent;
`mapping.params` and `judge.params` override the item's other values for those attempt kinds.
Codex also accepts `params.reasoning_effort` on older boards. `params.effort` wins when both
are present. The effective effort is also written to `.ostoyae/usage.json` when usage is reported.
**`sandbox`**, assigned by the runner, never chosen by the attempt.

**`sandbox.start_commit` / `sandbox.end_commit`**, immutable commit IDs captured
after provisioning and before teardown, respectively. Diff these to attribute
committed changes to this attempt instead of counting the inherited trunk again.
Recovered attempts capture the end when available; old attempts without a recorded
start cannot be reconstructed from today's moving branch. `start_conflicts` means
provisioning left upstream merges unresolved, so HEAD alone does not represent
everything inherited. Such attempts are unscorable by a simple commit diff.
`snapshot_error` records a failed end lookup; missing snapshots are not empty diffs.
These fields identify commits, not uncommitted files or authorship attestation.

**`decided_via: "auto-advance"`** on work and edges records a bounded run's
automatic scoped confirmation after a positive judge verdict. This mode is opt-in,
requires a configured judge and cap, and never automatically accepts a statement
revision or reopened edge. The normal explicit decision commands remain available.

### `walled` is a third outcome, not a kind of failure

| state | it did the work | it found structure |
|---|---|---|
| `done` | yes |  |
| `failed` | no | no |
| `walled` | no | yes |

A work item whose most recent attempt is `walled` is parked until the operator answers the
proposals that still gate it. Retrying before that walks into the same wall. What gates it is
narrower than "any open proposal": an unjudged proposal always holds; a refuted edge does not
(the judge said the dependency is not real); a judged-ok discovery holds only through a live
dependency path into the item, transitively, never through a refuted edge -- without one it is
a side discovery that stays proposed for review while the source proceeds. A refuted work item
still holds: only the operator can close that route. A walled attempt still counts against
`max_attempts`; whether it should is open.

### `check`, the engine's word against the agent's

A work item may carry `check`, a shell command. After a prove attempt's executor exits zero,
the runner runs it on a fresh checkout of the attempt's branch (see *The judge*), before
teardown; exit 0 and the attempt is `done`, anything
else and it is `failed` with the command and its last lines on the record, and the usual retry
follows, told nothing special; the failure is in `result.why` like any other. It gates only
that one path: a wall still beats everything, a map attempt is judged by its map, and an item
without `check` behaves exactly as every item did before the field existed.

```json
{ "id": "t-vendor-11", "what": "vendor Erdős 11 so it builds", "check": "bash eval/checks/t-vendor-11.sh" }
```

It exists because of a measured gap: on 2026-08-30 all eleven head-on attempts exited zero,
"the agent said done" scored 11 for 11, and the real checks scored 8 of 11 on the rows they
could judge, and because a retry follows a recorded failure, so without an engine-run check a
retry can never fire on work that is wrong. This is the scoped half of `open.md` question 4,
the run-with-a-mechanical-gate case; scores, reviewers and the open-ended case stay open there.

## The ontology, one claim one thing

Off when the key is absent, and then a proposal is a sentence carrying an id the agent chose,
which is what every graph did before. On, **a proposal is a claim of a declared kind**, and three
things stop being the agent's to decide:

| | |
|---|---|
| the id | assigned from the claim by `id`, never from what the agent called it |
| the text | generated from the claim by `what`, so two agents describing one lemma produce one sentence, not two paraphrases |
| identity | `sha1(kind, claim)`, so two agents proposing the same lemma under different names become **one item with two finders** |

```json
"ontology": { "kinds": {
  "lemma": {
    "claim":    ["decl", "statement"],
    "evidence": ["why", "searched"],
    "id":    "lemma-{decl}",
    "what":  "Prove `{decl}` sorry-free:\n\n{statement}",
    "check": "bash checks/task.sh {decl}"
  } } }
```

`claim` is the identity-bearing content and is hashed. `evidence` is support: recorded, never
hashed, so finding the same lemma again with a better search does not create a second item. A
claim missing a required key, carrying a key the kind does not declare, or naming a kind that
does not exist is **refused at absorb** with a note on the attempt: a stray key would silently
change the identity, which is the one thing this exists to prevent. `id`, `what` and `check` are
templates over the claim's keys; a template naming a key the claim lacks refuses the proposal
rather than filling in a blank.

**A question is a kind whose check accepts either answer.** An open problem is not "prove X",
it is "settle X", and a refutation is as finished as a proof. A graph declares it like any other
kind: a `what` that says settle rather than prove, and a `check` that passes on a sorry-free
proof of the statement or of its negation. The attempt says which in the handback's `answer`,
the runner records it on the item, and a false answer blocks whatever needed the statement true
instead of unblocking it. Nothing else in the engine knows the kind exists.

An edge's ends name the agent's own handles, and the runner resolves them to the ids it assigned;
an end that resolves to nothing is dropped, as always.

**This is what lifts the one-mapper queue.** Six mappers three-wide on 2026-08-31 proposed one
shared task under three ids and the engine built it three times for $13.97. Serializing discovery
was the workaround; the collision is the fix, and it does not care whether two mappers ran at the
same moment. So with `ontology` on, map attempts run as parallel as `concurrency` allows; with it
off, the old queue stands, because nothing else prevents the collision.

A confirmed edge's fingerprint is taken over its ends' claim hashes when they have them, so
rewording a task's evidence does not reopen every edge into it, and changing what it *claims*
does.

## The judge

Off when the key is absent, and then the graph behaves exactly as before: proposals are confirmed
on the operator's reading alone, and a task a map proposed is done on the agent's word. On:

```json
"judge": {
  "verify": "the instruction handed to every verify attempt; there is no default",
  "default_check": "bash checks/task.sh {id}",
  "require_check": true,
  "max_attempts": 1,
  "params": { "model": "sonnet" }
}
```

**Verify attempts.** A third kind of attempt, beside prove and map. After any attempt settles
with proposals, a map's tasks, a wall's tasks, a failed attempt's tasks, the runner launches a
verify attempt on the same item, `judges: "<attempt id>"`, before it launches anything else. It
gets a cell like any attempt, because judging a claimed blocker means looking, and it is handed
the handback it judges verbatim in `.ostoyae/verify.json`: the item, the wall, the map, and every
proposal with its full text. A work proposal made under an ontology also carries its exact
`claim_kind`, `claim` and `evidence`, so a judge can test the claimed statement rather than infer
it back from generated prose. It hands back:

```json
{ "verdicts": [ { "id": "w-lemma", "ok": false, "why": "Mathlib has it: Real.tendsto_log_atTop" },
                { "id": "e-0007",  "ok": true,  "why": "the task names the file and the statement" },
                { "id": "a-0012",  "ok": true,  "why": "the wall names a declaration that is absent" } ] }
```

One entry per proposal, and one under the judged attempt's own id for its wall. Each lands on
the thing it is about as `verdict: { by, ok, why, at }` (the wall's as `result.wall_verdict` on
the judged attempt). **A verdict is evidence, not a decision.** The proposal stays `proposed`, the
operator still answers, and the one thing a failed verdict changes is that `--confirm-scoped`,
the unattended yes, leaves that proposal alone and says so. `--confirm` by id can still say yes
to it. A verify attempt is `done` when it handed back at least one verdict on an id the attempt
actually proposed, `failed` otherwise, and a failed one is retried up to `judge.max_attempts`. It
commits nothing, proposes nothing, is filed under the item, and neither parks nor unparks it: the
item's last *work* attempt still decides `walled` and `mapped`. It takes a seat in `concurrency`
and counts against `--max-usd` and `--max-output-tokens`, not against `--max-launches`.

A judge may use disposable scratch files to test a claim with the project's parser, compiler or
typechecker. Those probes are not project work: the verify attempt may not change tracked files,
commits nothing, and keeps only its report. Whether a particular claim requires such a check is
part of the graph's `judge.verify` instruction, not a language-specific rule in the engine.

**A check runs on the branch, never in the cell.** When a prove attempt exits zero and its item
has a `check`, the runner checks out the attempt's branch fresh (`<root>/<graph>/_check/<id>`,
detached, the shared caches linked in exactly as for a cell), runs the check there, and removes
it. The cell is the agent's working tree, with whatever it left uncommitted or ignored; the branch
is what the record and the next attempt stand on, so the branch is what is judged. The check sees
`OSTOYAE_TRUNK`, `OSTOYAE_GRAPH` and `OSTOYAE_CHECK_TREE` beside the cell's variables, so it can
diff the branch against what the graph had built. `result.check.on` names the branch.

**`default_check`** is a shell command with `{id}` in it, and it is the check of every work item
that declares none of its own, which is what a task a map proposed always is: the mapper wrote
its `what`, and nobody wrote its gate. **`require_check`** makes doctor refuse a graph in which an
active item has neither. Without either, a done attempt with no check is still `done`, and the
record says so: `result.check` is absent and the note reads `done on the agent's word: no check
declared`. That is the verification brief's `claimed`, kept inside the three-state vocabulary.

**A wall must name something.** A wall that restates its own task found the task, not structure:
`could not prove the c lemma` on the item `prove the c lemma`. The floor is mechanical and
small: the wall must contain at least one word of four letters or more that is in neither the
item's own id, label and text nor a short list every wall contains (`mathlib`, `lemma`,
`cannot`, ...). Below the floor the attempt is `failed`, with the wall kept on the record and its
proposals still absorbed for the judge to read. Above it, the judge reads the wall.

**Fingerprints.** A confirmed edge remembers the text of both its ends at confirm time
(`fingerprint`). When either changes, the runner reopens the edge on load: `proposed`,
`reopened_at`, `reopened_why`. It schedules nothing until confirmed again, by id; the unattended
yes leaves it alone. A `--confirm` clears the reopen and records `reconfirmed_at`. Edges from
before fingerprints carry none and are taken as written.

**The plan window.** An attempt whose executor's last lines say it was rate limited is recorded
`failed` with `result.limited: true`, the settle line says `stopped by the plan window`, the
summary lists them, and the run stops launching: the next launch would meet the same window.

`bin/rehearse-judge` walks every path above with the fake executor, zero model calls, and asserts
on the record it leaves.

## The handback

After the executor exits and before teardown, the runner reads `.ostoyae/report.json` from the
attempt's worktree. Everything in it is optional.

```json
{
  "wall":  "there is no idempotency column to guard the confirm path on",
  "ahead": "if you did finish, your warning goes here instead, and `wall` stays empty",
  "answer": false,
  "work":  [ { "id": "w-schema", "what": "add an idempotency key column" } ],
  "edges": [ { "from": "w-schema", "to": "w-confirm", "why": "the guard has nothing to read" } ]
}
```

Everything lands as `proposed`. The report is data, not authority:

- The runner assigns edge ids. An attempt proposes an edge, it never names one.
- An edge naming work that is not in the graph is dropped, with a note on the attempt.
- A duplicate edge is not re-added; the attempt is appended to the existing edge's `found_by`.
- Unreadable JSON is recorded on the attempt and the run continues.
- `answer` lands on the item only from a done attempt. An item answered `false` is satisfied,
  and everything that needed it is **blocked**, not unblocked: a dependent of a false statement
  has nothing to stand on, and the status line names the refuted need.
- The file is deleted before the executor runs, so a report inherited from an upstream branch
  can never be read as this attempt's.

### The map handback

A map attempt hands back the same file with one more key:

```json
{
  "map":   { "settles": "what a finished result would be", "cost": "small | medium | large | unknown", "notes": "optional" },
  "work":  [ { "id": "w-lemma", "what": "one line" } ],
  "edges": [ { "from": "w-lemma", "to": "w-this", "why": "..." }, { "from": "w-this", "to": "w-other", "why": "..." } ]
}
```

What the item depends on is `work` plus edges into it. What it unlocks is edges out of it to
items already in the graph. Both go through the proposal path above and are inert until the
operator confirms. So the agent can name existing items, the runner writes
`.ostoyae/work.json` into a map attempt's cell before the executor runs, listing every
non-rejected item as `{ id, label, what, status, mapped }`. Only map attempts get it, and map
attempts never commit, so it never lands on a branch.

How a map attempt ends:

- `walled`, if the report names a `wall` and produced proposals, exactly as for a prove attempt.
  A valid `map` beside the wall is recorded all the same: for an open problem, "no known route,
  cost unknown" is the map. An invalid one gets the same notes as below.
- `done`, only if the exit was zero **and** `map.settles` is a non-empty string.
- `failed` otherwise, with a note saying which: `handed back no map`, `map has no settles`, or
  `handed back a map but exited non-zero, map not recorded`.

A missing `cost` is recorded as `null` with the note `map has no cost, recorded as null`, never
defaulted. A cost outside the four words is kept as written with a note. Keys inside `map` that
are not `settles`, `cost` or `notes` are dropped with a note. A `map` handed back by a prove
attempt is ignored with the note `map handed back by a prove attempt, ignored`.

**A done map attempt with still-gating proposals parks its item**, state `mapped`, until the
operator answers, the same way a wall parks it: unjudged proposals and judged-ok discoveries
with a live path into the item hold it; judged-ok side discoveries with no path, and proposals
whose dependency claim the judge refuted, stay proposed for review without holding it.
Without this the runner would launch the expensive
attempt seconds after the cheap one said what it lacks. A done map attempt that proposed nothing
leaves the item ready to prove in the same run.

**Prove attempts run first.** `ready()` returns prove-ready items before map-ready ones: a
prove-ready item is one the operator has already answered for, a map-ready one is one nobody has
looked at, and started work is reinforced before new ground is probed. A map attempt does not
wait on the item's `needs`, because mapping is cheap and independent of upstream content. On a
fresh mapping graph nothing is prove-ready, so `--max-launches N` launches N map attempts and no
proofs. Once tasks are confirmed, the same budget works them first and maps with what is left.
(Until 2026-08-29 maps ran first, and a budget of 5 against 28 unmapped problems mapped 5 new
problems every run and never reached a confirmed task.)

## The operator

```
node run.mjs <graph.json> --confirm <id>[,<id>...]
node run.mjs <graph.json> --reject  <id>[,<id>...]
```

Takes work ids and edge ids. Mutates the file and exits without running anything, confirming is
a deliberate act, not a side effect of a run. A confirmed **edge** becomes `confirmed`; a
confirmed **work item** becomes `active`, ordinary work with no trace of having been proposed
except `found_by`.

Every run prints what is proposed, with the attempt that found it and the date, and the exact
command to confirm it.

The viewer's yes and no buttons do the same thing through `POST /api/decide` on `127.0.0.1`:
only a proposed item can be decided, the file is written through a temp file and a rename, and
the request is refused with 409 while a runner is live. A decision made from the page carries
`decided_via: "viewer"` beside `decided_at`; one made from the command carries `decided_at` only.

## The accumulation line

Every run ends with:

```
edges: 4 total · 2 confirmed · 4 found by runs, over 3 day(s) (2026-08-27, 2026-08-29, 2026-09-02)
```

This is the test the whole design is for, printed where it cannot be avoided. Edges arriving from
runs, spread across the days runs happened, is the loop working. Edges arriving in one batch is a
person reading handbacks, which is what an earlier single-node runner's `edges.json` showed, 21 of 33 on a single day.

## The cell

`sandbox` is required. **Without it the runner refuses to execute anything.**

Provisioning creates a real git worktree on a real branch, optionally a real database cloned from
a template, and assigns a port. Then it writes `AGENTS.md` and `CLAUDE.md` into the worktree with
the rules for that attempt. The executor runs with `cwd` set to the worktree and a **replaced**
environment, so a `DATABASE_URL` or `PORT` in the launching shell does not reach the attempt.

An attempt bases on the branches of the attempts that satisfied its dependencies, so a dependency
hands over content and not just ordering. More than one upstream is merged in, in order.

**A conflict between two upstreams no longer fails the attempt.** It used to, and on 2026-08-30
that cost the graph arm of the evaluation four of its twenty-two launches and two tickets every
head-on arm landed: two confirmed shared tasks had both edited `lakefile.toml`, which is what
shared prerequisites do. A conflict there is not the dependent's failure; it is the graph saying
two confirmed tasks own one file, and the cell is the only place both versions exist.

So the merge is left in progress. The conflicted paths, and any upstreams that could not be
merged behind it, are named in a section appended to the cell's contract, and resolving them is
the attempt's first job. The agent still never runs git: the executor's usual `git add -A && git
commit` concludes the merge. An agent that judges the collision bigger than the ticket walls on
it and names both tasks, which is the outcome this repo is for: the collision becomes a task and
the dependent parks, instead of an exit code with nothing attached.

### `sandbox.contract` and `sandbox.notes`, what the cell is told

`contract` is absent or `"plain"`. Absent writes the Ostoyae contract into the cell's
`AGENTS.md`/`CLAUDE.md`: the rules, and how to hand back `.ostoyae/report.json` with walls,
work and edges. `"plain"` writes only the rules and how to finish, no handback: it exists for
the evaluation protocol's head-on arms, so a plain agent is a plain agent. `notes` is free text
appended to either contract under "From the operator", so one sentence reaches every attempt the
same way. `params.max_turns`, an integer, caps the session's turns (`claude -p --max-turns`);
absent means the Claude executor's default. The Codex executor requires an explicit Codex
`params.model` and rejects `max_turns`: its CLI has no equivalent agent-turn cap. It does not
silently substitute an output-token budget or inherit a Claude model name.

### `sandbox.link`, dependency caches, shared rather than rebuilt

```json
"link": ["lean/.lake/packages", "node_modules"]
```

A cell is a bare worktree, so it arrives with no `.lake`, no `node_modules`, no `.venv`. For a
compiled pursuit that is fatal rather than inconvenient: **Mathlib's build is 1.8 GB**, an agent
cannot produce it inside a cell, and thirty cells cannot each hold one. `link` symlinks each
named path from the pursuit repo into the worktree at the same relative path, and adds it to the
worktree's `info/exclude`.

The executor is told where the links resolve to, as `OSTOYAE_LINKED`, real paths joined by `:`.
`executors/claude.sh` passes each as `--add-dir`, because Claude Code refuses its own tools
outside the directory it was started in and a symlink resolves outside it. Found 2026-09-03:
six lean-eval mappers had Mathlib linked in and could not read a line of it, so their evidence
was written from memory. `--add-dir` opens a path for writing too, so the same executor
passes a `--settings` rule denying `Edit`, `Write`, `MultiEdit` and `NotebookEdit` under each
linked path; the rule matches the resolved path, so a write through the symlink is refused as
well. Bash is not covered by it. An executor of your own that runs an agent with the same
rule needs the same treatment, both halves.

**A linked path is shared, not isolated, and that is the opposite of what `db` does.** `db`
clones because a test writes to it. `link` shares because a dependency cache is read-mostly.
Name only things every cell reads and no cell writes:

| link this | not this | why |
|---|---|---|
| `lean/.lake/packages` | `lean/.lake` | `packages` is Mathlib and is never rebuilt; `build` is the pursuit's own output and every cell writes it |
| `node_modules` | `dist`, `.next` | installed deps are read-only; build output is not |

Two cells building into one linked directory will corrupt each other. The runner does not police
this, getting the list right is the operator's job.

A path that is not present in the pursuit repo is skipped with a note rather than failing the
attempt, so a graph can name a cache the machine has not built yet.

Teardown removes the worktree and drops the database. Linked paths are **unlinked first**, and
only after each is confirmed to be a symlink rather than a directory, a teardown that deleted
the tree with the links still in it would be one bad `rm -r` away from destroying the cache every
other cell is reading. **The branch survives**, so a failed or walled attempt's work is still
readable. `--keep` leaves everything standing.

### `--dry-run` touches nothing

It provisions no cell, creates no branch, and **does not write the graph file**. It used to do
all three whenever a `sandbox` was configured: one dry run against a live repo left **32 `ost/…`
branches** in it and wrote **32 simulated attempts** into `attempts[]`, marked `done` and
`failed`, distinguishable from real ones only by the string `simulated pass` in `result.why`.
`attempts[]` is the record everything else is derived from. A rehearsal does not write history.

Branches and databases are namespaced by graph name. If a branch already exists the runner fails
with what that means rather than a raw git error: the graph has been run before and its attempts
were cleared, and attempts are append-only.

## When the file is written, and the heartbeat beside it

The graph is written **at every launch and every settle**, through `<graph>.json.tmp` and a
rename. It used to be written once, when the run ended, which meant that for the whole length of
a run the file said every item was `ready` while agents were working in cells, and the companion,
which reads that file and nothing else, showed the graph as it had been before the run started.
The rename is what makes a reader polling twice a second safe: it never catches half a graph.

Liveness does **not** go in the graph. A heartbeat changes every two seconds and says nothing
about the work, so it would bury the record in beats. The runner writes `<graph>.run.json` beside
the graph instead, holding its pid, when it started, its last beat and how many launches it has
spent, and removes it on the way out. Gitignored. It is runtime state, not the record.

**Why the last run ended is on the record, in `last_run`.** `attempts[]` says what ran and
nothing said what stopped the runner, so a caller deciding whether anything should happen next
had to guess. `last_run` carries `ended`, `launched`, `invocations`, `invocation_allowance`,
`stopped_by` (the budget that bound, or null), `drained` (why the queue emptied, or null when a
budget bound), `why` and `next`. It is cleared when a run starts, so a reader who opens the file
mid-run sees no verdict rather than the previous one, and written just before the runner exits.

`drained` is one of `board-satisfied`, `awaiting-decision`, `awaiting-judge`, `exhausted`,
`gated` or `blocked`. **`board-satisfied` means every check on every active item passed.** That is
a claim about the board and about the checks. It is not a claim that the question the board was
built to ask has been answered, and the wording the runner prints says so, because an empty queue
and a finished mission are different things and this engine does not get to confuse them.

**A file left behind is the signal.** A runner that dies mid-run leaves its heartbeat and leaves
its attempts saying `running`, which is the one state nothing recovers from on its own: `ready`
skips the item, `exhausted` refuses to count it, and it is permanently busy on an agent that is
not there. The next run reads the leftover heartbeat, finds the pid is gone, and settles those
attempts as `failed` with `runner pid N exited before this attempt settled`, printing each one.
That is the only thing in the system that moves an entry already in `attempts[]`, it only ever
moves one off `running`, and it never removes one.

**Two runners on one graph are refused.** Each holds the whole file in memory and writes it back,
so the loser's attempts are not corrupted, they are gone: absent from the record with nothing to
say they ran. A second `run.mjs` on a graph whose heartbeat belongs to a live process exits 1 and
names the pid to wait for. So does `--confirm` and `--reject`, because a decision made during a
run would be overwritten without saying so. `--dry-run` is allowed and says a run is in progress.

## What the runner does not do

It does not pick migration ordinals, branch names, ports, database names or edge ids inside a
node. Those are assigned because the runner can see every attempt at once and an attempt cannot.

Ready prove work is considered before ready map work. Within each group, the chooser
ranks by leverage over confirmed dependencies, descending, and preserves file order for
ties. Readiness and the configured concurrency still limit what can run. This is an
implemented ordering rule, not evidence of a comparative performance advantage.

Proposals are inert until confirmed. Confirmation is explicit by default. With an
operator-selected cap, judge and `--auto-advance`, the runner can confirm fully judged
routes to the invocation's original open tickets; it preserves `--only` and leaves
statement revisions to explicit decisions. See the bounded-continuation section.


## The trunk

`ost/<graph>/trunk` is where finished work accumulates, one branch per graph. It is created
from `sandbox.base` the first time a graph runs and it gets a worktree of its own at
`<root>/<graph>/_trunk`.

Two things use it:

- **Every cell starts from it**, rather than from `sandbox.base`. So an attempt sees everything
  that has finished, including siblings it has no edge to. Upstream branches are still merged in
  on top, which is a no-op for any already in the trunk.
- **Every done prove attempt merges into it.** A map attempt commits nothing and a walled or
  failed attempt did not finish, so neither is merged.

A conflict is recorded on the attempt and the trunk is left exactly as it was. That is not a
failure of the attempt, which finished, and its branch still holds its work. It is the graph
saying two finished jobs own one file, which is a thing only a person can settle.

**The trunk is not `main` and never becomes it.** Landing is the operator's decision. This only
stops finished work from being stranded on branches that never meet, which is what happened on
erdos-zeta-plain on 2026-09-01: five lemmas proved sorry-free across three attempts, each in its
own copy of one file, with no branch holding all five.
