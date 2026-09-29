# 2026-09-10 — the first campaign in a cloud VM, and what it cost to learn

Issue 58 asked for one continuous path from an existing Zeta hunt to a bounded autonomous
outcome. This is what happened, including the two defects that were mine and the money they cost.

## The engine ran a real hunt, unattended, in a cloud VM

38 attempts, 28 done, **$35.63**, against `teal-sea/zeta-lab`'s `hunts/prime_pair_error`, with the
pursuit a frozen clone and the cells ordinary headless Claude Code. The auth question that looked
like the blocker was not one: `claude` in a cloud VM authenticates from `$HOME`, which `BASE_ENV`
already keeps, so **`sandbox.env_passthrough` stays empty** for the executor. It is still required
for anything else: a variable set on the cloud environment does **not** reach a cell unless the
board names it. Measured, both ways, with two dummy keys.

## Three defects, and only one of them was the engine's

**1. `--max-launches` was never a campaign budget.** It counts work launches and its counter lives
in one invocation of `run.mjs`. Measured on a four-item board: `--max-launches 2` gives four
attempts after one run and **eight after two**, because verify sessions run free beside it and the
counter resets. `--max-invocations N` now counts entries in `attempts[]`, which is one entry per
session in any role, append-only and on disk, so it is cumulative and restart-persistent by
construction. It is also the only cap that still binds when the executor reports no usage.
`bin/rehearse-allowance` pins both behaviours, including `--max-launches` continuing to do what it
does, so the contrast is not repaired by accident.

**2. A drained queue said nothing.** With no budget bound the runner printed its report and
exited, and `<graph>.run.json`, which could have said why, is deleted on a clean exit by design.
`classifyDrain()` now names it in `report()`'s own buckets and writes it to `last_run` on the
graph. `board-satisfied` says every check passed and the printed line says out loud that this is
not an answer to the question the board asked.

**3. `doctor` had a hole it only pretended to guard.** It refused `python3` as a bare interpreter
and let `/opt/zeta-venv/bin/python` through, because it compared the whole word against a list of
names. Both produce the identical `Bash(...:*)` grant. The comparison is on the basename now, and
a board that genuinely needs one says `"bare": true` and gets a warning that **names the grant in
the line doctor actually prints**. The first version of that fix put the grant in `warn`'s second
argument, which is never printed: a disclosure nobody sees, which is the same failure as the hole.

## The two things that cost real money, both mine

**Mapping cost $2.78 and mapped nothing.** Both map attempts failed, `0 of 5 items mapped`, and
because `mapping.max_attempts` was 1 the two seeded items were then reported exhausted before
either reached the prove step it was seeded for. Removing the key made both launchable. One board
and two attempts: a reason to seed work directly, not a verdict on mapping anywhere else.

**A one-line `judge.default_check` cost $11.33.** It read
`test -e hunts/prime_pair_error/{id}.py`, which demands a file named after the item id. Items that
come from the mapper carry no check of their own and fall through to it, and no task ever asks for
a file named that way: they name outputs after what they do. Eight prove attempts, all recorded
`failed` with the check false, **and the work was fine every time**. With `max_attempts` at 2 each
was retried at full price first. The default check now asks whether the attempt changed anything
under the hunt directory, which is a question about the work rather than about a filename the
engine did not choose. All four items passed on the first retry under it, which is what confirms
the diagnosis rather than asserting it.

`attempts[]` still records those ten as failed. Nothing in it was edited.

## The keeper: the judge caught a mapper inventing its own justification

A failed map proposed a follow-up whose text asserted, in the present tense, that
`delta_sq_probe.py` "already measures" S(N) with results at six named cutoffs. No such file
existed; the attempt that would have written it had just failed. The verify attempt rejected it,
in its own words, because **"the proposal fabricates a completed result to justify itself"**, and
rejected the dependent edge for the same reason. It caught that by reading the worktree instead of
trusting the handback. That separation is worth more than the $2.78 the mapping round cost.

When that task was later scheduled, its premise had become true and its numbers had not: the
measurement existed, at a different ladder. The fabricated cutoffs were replaced with the measured
ones and the correction recorded in the verdict, rather than confirming a false premise.

## Do we need several Ostoyaes? No.

Asked at the end of the session, and the answer follows from what is already here rather than from
preference:

- **One engine, many boards.** A board is a file. `run.mjs` refuses a second runner on the *same*
  graph, and nothing stops one runner per board on different graphs. Parallelism across hunts is
  more boards, not more engines. Another copy of Ostoyae buys duplicated defect surface.
- **The binding constraint is the account's rate window, not the engine.** Anthropic's docs are
  explicit that cloud sessions share rate limits with everything else on the account and that
  parallel work consumes them proportionately. `hot.md`'s 2026-09-06 entry reached the same place:
  the cloud removes a cash cost and leaves the window where it was. Two Ostoyaes on one account
  compete for one window and finish no sooner.
- **What is genuinely missing for unattended running is durability, not concurrency.** A cloud VM
  is reclaimed on idle and the docs say background shell commands are not restored, so a long
  `setsid nohup` runner does not survive the machine. The pieces that would fix it: the board in a
  repo, which it now is; a Routine as the durable owner, minimum interval one hour, every firing a
  fresh session cloning the default branch; and an allowance that survives a fresh process, which
  `--max-invocations` is. **No Routine was created.** That is recurring unattended spend and it is
  the operator's to authorize.
- If more throughput is genuinely wanted, the honest lever is **more accounts or a self-hosted
  environment**, because that is what buys window. Not more engines.

## Numbers a next session should not have to rediscover

| thing | figure |
| --- | --- |
| one bounded, hand-written item, mapping off | about $1 |
| the mapped mode, this board | $2.78 for zero maps |
| the whole campaign | $35.63 over 38 attempts |
| a real cell, haiku, trivial task | $0.0308, 3 turns, 11.1 s |
| zeta-lab fast tier on the VM | 2957 passed, 3 skipped, 16:47 |
| VM | 4 vCPU, 16 GB, 30 GB, no compute charge |
| Routine minimum interval | one hour, shorter cron rejected |
