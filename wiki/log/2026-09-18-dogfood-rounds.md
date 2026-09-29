# 2026-09-18 — dogfood rounds, isolated worktree (task_6ec95533c3b4)

**What was asked (the operator).** Go full blast: sustained
dogfooding in this isolated worktree, actual local Ostoyae launches through
existing Muse subscription access authorized. Tinygrad optional. Never Zeta,
production, or other workers' checkouts. Cover doctor/dry/status/go, real
Muse executor calls, done/failed/walled, prerequisite discovery, parking and
unblocking, dependency reuse, mapping/judging, proposals/rejection, merge
conflicts, interruption/recovery, accounting/caps, CLI/viewer consistency.
Fix genuine failures on the owned branch with regressions. No paid API
fallback, cloud spend, push/PR, or Actions. Old campaign evidence preserved
under `~/tinygrad-c2` and `~/tinygrad-ab` (untouched).

**Engine revision:** `d76a490` on branch `teal-sea/ostoyae-dogfood`.
**Scratch root:** `/tmp/ostoyae-df-20260918/` (pursuits, cells, boards).
**Baseline:** `npm test` green end to end (exit 0, incl. demo), 2026-09-18.

## Round 1 — scripted fault coverage (fake.sh, zero model calls)

Boards `r1a–r1f` (+`r1a2`, `r1b2`, `r1d2`) in `/tmp/ostoyae-df-20260918/`,
pursuit `/tmp/ostoyae-df-20260918/pursuit`, engine `d76a490`. All `go` runs
used `--exec bash <engine>/executors/fake.sh` (absolute; a relative path
fails inside cells — 4 failed attempts on `r1a.json` record that harness
error and the clean rerun moved to `r1a2`).

- **Wall floor (correct).** `r1a2` a-0001 handed back wall + proposals but
  recorded `failed`: wall text "no dep" names nothing beyond the task
  (`lib/wall.mjs`), so no parking and the retry fired at once. Genuine
  `walled` + parked came from `r1f` ("blocked ...", novel word): `1 item(s)
  parked and 2 proposal(s) unanswered`, then reject → retry `done` →
  board-satisfied, the walled attempt kept as `walled`.
- **Verdict-aware parking (verified live).** `r1b2`: map-sourced edge judged
  NO → source proved and satisfied with proposals still open. `r1b`: refuted
  work still holds; `--auto-advance` confirmed only the fully-judged-ok
  route (`w-shared`+`e-0001`), proved dependency-first, left the NO-verdict
  pair for the operator; `reject` then drained the board.
- **Merge conflict (reproduced).** `r1c` custom exec, concurrency 2, one
  file: second trunk merge conflicted, trunk untouched, attempt still `done`
  with `result.conflict` + note — the tinygrad-C2 Arm A Scan shape
  (board-satisfied, trunk missing work).
- **Interruption (verified).** `stop` mid-25s-cell: in-flight landed, no new
  launches. SIGKILL of the runner: orphan cell reaped by hand, rerun marked
  a-0001 `failed` ("runner exited before settle; no handback"), continued as
  a-0002 with no id reuse. The dead cell's branch is kept as evidence by
  design; its worktree registration remains (safe default — the cell may
  still be alive, so no teardown on recovery).
- **Caps (verified).** `--usd 5` with $2.50/attempt: projection
  `spent + (running+1) × avg ≥ max` refuses the exact-cap launch
  (conservative by one launch, by design in `lib/spend.mjs`).
  `--invocations 3` bound across a restart (2 launched, rerun 0).
- **CLI/viewer (consistent).** Viewer `/api/graph` vs `status --json` agree
  on `r1b` (3 done + 1 rejected) and mid-state `r1e` (3 done, 1 ready);
  read-only POST refused; `status.pending` counts proposals only.
- **Doctor (correct).** Refused `r1c` until `default_check` carried `{id}`.

## Repairs from Round 1 (this branch, committed below)

1. **Dry claimed "no check declared" on gated boards.** A dry run executes no
   check, so absent `result.check` never meant absent declaration. Settle now
   records the declared command (`result.checkDeclared`, dry-only, never
   written) and the summary prints "checks declared but not run in dry
   mode"; genuinely ungated items keep the agent's-word line.
2. **"Never ran" mixed ready with waiting.** The summary now splits stuck
   items by the viewer's own `ready`: `N ready · M waiting` with
   `ready <id> <n> attempt(s) in, retries left` / `not launched yet`, and
   `waiting <id> needs ...` only for unmet needs (refuted-need wording kept
   for `rehearse-question`).
3. **Conflicted dones were invisible in the summary.** New line "N done but
   unmerged, trunk conflict: ids" (attempts with `result.conflict` and no
   `result.integrated`); the attempts stay `done`, semantics unchanged.

Coverage: new `bin/rehearse-summary` (7 assertions), wired into `npm test`.
Docs: 5 pinned summary lines updated (`README.md`, `docs/running.md`).
Full suite green after the fix (`npm test` exit 0, incl. demo).

## Round 2 — real Muse cells (subscription, $0)

Engine `e2261ac` (frozen during flights; no edits while a runner was live).
Route: `executors/muse.sh`, `--agent muse --model muse-spark-1.3`, Meta login
under HOME, no API key. Caps by launches + output tokens only (dollars
cannot bind: `cost_usd` null on every attempt).

- **r2 (pursuit2 tiny calculator, 4/4 done).** Smoke `--launches 1` then drain
  `--launches 3`: a-0001..a-0004 all `done`, checks passed, trunks merged,
  dependency order held (w-cli ran after w-add+w-mul), full
  `tests/test_calc.py` passes on `ost/df-r2/trunk`. Usage: 3612 out /
  1.26M in (mostly cache) over 4 attempts, 5–8 turns each. New summary lines
  verified live on real output ("2 ready · 1 waiting",
  "ready w-mul not launched yet", "waiting w-cli needs w-add, w-mul").
  Agents used the `ahead` box and answered `true` on proves; harmless.
- **r3 (pursuit3 greeters + staged wall).** Mapping on, judge on.
  Mapper a-0001 really proposed shared `w-greet-helper` + 2 edges; the
  verify judge really refuted all three after testing standalone passes in
  /tmp scratch; w-shout parked as mapped-awaiting-operator; operator
  rejected; w-shout proved standalone; board drained 2 satisfied /
  1 exhausted. Trunk tests pass. Usage: 20120 out / 2.96M in over 8.
- **Staged unsatisfiable item.** Both w-impossible proves wrote clear walls
  ("asserts False unconditionally ... must stay walled rather than weaken
  the test") and proposed nothing → recorded `failed` with the wall kept,
  exhausted after 2. The map had already flagged unsatisfiable. No test was
  weakened. Observation, not a repair: a correctly-diagnosed unsatisfiable
  wall has no `walled` box because `walled` requires `found.length`
  (`run.mjs`); the wall text survives on the record, so nothing is lost.
  Whether unsatisfiable deserves its own terminal item state is an open
  question, not decided here.

Round-2 batch totals: 12 launches, 23732 output tokens, $0.00.

## Round 3 — reuse loop with a required helper (real cells, $0)

- **r4 (pursuit4, both gates import missing `common.normalize`).** Mapper
  a-0001 proposed `w-common` + both edges; verify judged all ok citing exact
  gate lines and ModuleNotFoundError. Mapper a-0003 (w-whisper2) named the
  same edge → joined as second finder with empty `found` → **did not park**
  → its prover wrote its own `src/common.py` (`def normalize(name)`, no
  hints) beside the still-proposed `w-common`. `--auto-advance` then
  confirmed all three on the ok verdicts; w-common's prover overwrote the
  copy compatibly (`name: str` hints); w-shout2 proved; board-satisfied,
  trunk tests pass. 6 attempts, 15360 out / 2.31M in.
- **Genuine gap, repaired.** Parking read `result.found` (novel proposals
  only), so a duplicate discovery never parked its source — the graph
  watched a second copy of discovered shared work land. Fix
  (`viewer/state.mjs`): parking and the awaiting-operator print read
  `namedOpen` = novel found ∪ open proposals the attempt joined as a
  finder, matching the decisions view's existing union. Unchanged: `found`
  stays novel-only, no second verify fires on duplicates
  (`pendingVerify` reads `found`), fully-collided walls keep their recorded
  state (open.md Q9's narrow half is not decided here). Coverage: new
  `bin/rehearse-duplicate-park` (5 assertions; fails 3/5 pre-fix, 5/5
  post-fix), wired into `npm test`; full suite green.
- **Second-order observation, not built.** Satisfied items are never
  re-gated after later trunk merges: had w-common's overwrite been
  incompatible, w-whisper2's gate could have broken silently. Design-level;
  logged, not fixed.

## Round 4 — questions, refutation, concurrency (real cells, $0)

- **r5 (pursuit5, buggy median, concurrency 2).** Ambiguous question brief
  ("false with a failing case"): both attempts answered false correctly but
  wrote failing correctness tests, so checks failed, answers recorded-not-
  applied, item exhausted; w-mean-tests done in parallel; w-report waiting.
  Harness-brief error, engine behaved per design. `watch --once` mid-flight
  showed live runner/usage correctly. Usage: 9730 out / 1.32M in, 3 cells.
- **r5b (precise brief).** Agent diagnosed `sorted(xs)[-1]`, wrote passing
  assertions demonstrating wrongness, answer false applied, refutation
  merged to trunk, w-report blocked reading "needs w-settle-median
  (refuted)", drain state `blocked`. 2387 out / 722k in, 1 cell.
- **Status `execution` is current flag resolution**, not last-run history
  (bare status shows provider claude + board model; `--agent muse` shows
  muse; per-attempt usage carries the real executor). Consistent, not a bug.

## Round 5 — real conflict, scoping, kill recovery, binding caps

- **r6 (pursuit6, same function two ways, concurrency 2).** Both cells
  passed their own checks; second trunk merge conflicted on src/norm.py;
  both `done`; new line printed on real output: "1 done but unmerged,
  trunk conflict: a-0001". Git confirms trunk=lower, strip branch intact
  and not an ancestor. 1476 out / 564k in, 2 cells.
- **r7 (scripted `--only w-leaf`).** Family root→mid→leaf launched, w-other
  untouched, drain names the --only scope; summary reads "ready w-other
  not launched yet". Correct; scope reason lives on the drain line.
- **r8 (real SIGKILL + `stop --now`).** Runner killed mid-cell; orphan real
  muse cell found ("still running, and still spending") and signaled;
  confirmed dead. Rerun swept a-0001 to `failed` with the check's
  ModuleNotFoundError tail, usage null; output-token cap then refused all
  launches (documented conservative direction for unreported spend).
  Operator raised max_attempts 1→2 (recorded), relaunched with launches cap
  only: retry + dependent done, board-satisfied, killed attempt kept.
- **r9 (binding output-token cap, real).** `--output-tokens 100`: first cell
  spent 617, rerun "stopped at the 100 output-token budget, with 617
  spent: 0 launched". Caps bind new launches across restarts; in-flight
  overspend is by design.
- **r10 (scripted `--keep`).** Cell worktree left standing with contents.

## Round 6 — Grok executor, new adapter (subscription, ~$0.44 reported)

Authorized mid-night: all existing Grok subscription capacity alongside Muse.
`grok` 1.0.34 present, grok.com login, models grok-4.6 (default) / grok-4.5.
Gemini path blocked: no `gemini` CLI on PATH and no Google credential in
session — missing-install + missing-credential finding, no workaround built.

Probes established: `-p`/`--prompt-file` + `--output-format json` answers one
object with text/usage/modelUsage/cost; `streaming-messages-json` gives
init/assistant/result frames; `--trust` loads cwd AGENTS.md (without it the
contract is ignored — both files probed); `--deny 'Bash(git *)'` blocks git
under bypassPermissions; `--deny 'MCPTool(*)'` blocks MCP calls; exit codes
0/1/130/143. Skills (47) and global instructions have no CLI off switch and
ride into every cell; user's MCP servers stay configured unless denied.

Built `executors/grok.sh` on the claude/muse contract (private copy, prompt
file, harness commit, wall/verify/map gates; usage from the result frame with
reported dollars, so `--usd` binds). Registry entry (verified, not
experimental), `rehearse-executors` grok section (7 assertions, real frame
shapes), docs (`docs/grok.md` new; README, executors, CHANGELOG, schema,
portability rows). Verified live: rg1 prove done ($0.035) + rg2 map ($0.06),
verify ($0.19, 12 turns of independent testing) and prove ($0.06) done, trunk
tests pass. Full suite green (35 executor assertions).

## Round 7 — engine self-dogfood + two serious repairs (Muse cells, $0)

Cloned this worktree to `/tmp/.../engine-pursuit` (isolated copy, same
branch) and ran r11 (mapping on): dead-destructure removal, quiet cell
commits, CHANGELOG hygiene. 6/6 done, board-satisfied — but trunk review
found every prove had destroyed `.claude/CLAUDE.md` (337 lines in one
commit) and committed `.ostoyae/` artifacts.

- **Root cause (serious, repaired).** The engine's own `AGENTS.md` is a
  symlink to `.claude/CLAUDE.md`; contract injection `writeFileSync`s the
  link's name, which follows the link and overwrites the target, and the
  harness excludes the link's name, not the target's path — so the wreckage
  committed. A link pointing outside the repo would have destroyed the
  operator's own file. Fix (`sandbox.mjs`): unlink-then-write, leaving a
  regular ignored file in all three cases. Covered by
  `bin/rehearse-hygiene` (symlink target byte-identical, outside file
  untouched, tracked file excluded).
- **`.ostoyae/` on branches is deliberate, not fixed.** Two `sandbox.mjs`
  comments say every attempt commits its handback so the branch carries
  what it found, with merge machinery to remove it. But `codex.mjs`
  excludes `.ostoyae` from commits while shell executors commit it when
  unignored — an unresolved inconsistency, logged for an owner decision.
- **Commit silence (repaired, beyond the agent's fix).** The r11 agent's
  `git -c advice.addIgnoredFile=false` ported, but probing git 2.50.1
  showed `-c` kills only hints: the header prints and add exits 1 whenever
  an ignored file is named in `:(exclude)` (codex.mjs already documented
  this for 2.47+). All 7 shell commit paths now enumerate changed paths
  (diff + ls-files, NUL, literal pathspecs) minus contracts, the codex.mjs
  way; what gets committed is unchanged. Covered by hygiene assertion 4
  and a new silence assertion in `rehearse-executors`.
- **fake.sh had no excludes at all** (pre-existing; no rehearsal pursuit
  ever tracked a contract path). Fixed with the same enumeration.
- **grok.sh empty-array crash (repaired).** `"${WEBOFF[@]}"` under `set -u`
  is fatal on system bash 3.2 whenever OSTOYAE_WEB is set; ARGS now builds
  incrementally. Covered by hygiene assertion 5 (stub run with the var set).
- Also observed: a-0004 "exit 1, but the check passed" (agent felt failure
  on good work) — honest record, no action; CHANGELOG entries ported.
- Live proof: r12 real Muse cell on the engine pursuit — target md5
  identical, branch keeps the symlink, work committed, no noise. Full suite
  green after all of it.

## Round 8 — reuse loop at scale (Muse cells, $0)

r13 (pursuit7 task tracker, 6 items, concurrency 2, mapping + judge): 6
mappers discovered w-store + w-validate + 7 edges; judge passed 7, refuted 2
(e-0005 "preference not block", e-0007 docs-moot — both argued from the
gates). Duplicate-park fix held live: e-0002/e-0003/e-0004 each found by two
mappers, all second sources parked (pre-fix they proved at once, r4).
`--auto-advance` confirmed the 7 ok; operator overrode e-0005 to confirmed
(the brief says "via store" and two w-clean proves died on
ModuleNotFoundError — judge blind spot: verdicts read the gate, the
requirement lived in the brief; evidence for open.md Q4) and rejected moot
e-0007. Drained 8/8, all trunk gates pass. 21 attempts, 50270 out / 8.58M in.

Two harness errors, both mine: w-add's gate appended to a fixed /tmp path
(retries poisoned each other) — fixed with a tempfile db, merged into the
graph trunk as an explicit operator commit; max_attempts 2→3 to revive the
two poisoned items, recorded. No engine changes in this round.

## Round 9 — independent-review repair package (deterministic, $0)

Review `/tmp/ostoyae-df-20260918/review-c93e3f4.md` scored the branch after
c93e3f4. All findings reproduced live or against stubs; no model cells fired
(all adapter behavior verifiable deterministically).

- **P1, grok zero usage (repaired).** All-zero result frames and
  `total_cost_usd` 0 recorded as `cost_usd: 0`, `cost_basis: reported`
  (reproduced against a stub). Per Grok's headless docs both are unknown
  fallbacks, so both now record as absence (nulls, the muse convention, not
  `_bad`, keeping model/turns/durations); caps refuse, sums exclude,
  nothingRan cannot misclassify. The header's false `modelUsage[].costUSD`
  claim corrected to total-only.
- **P2, `api_ms` (repaired).** `duration_api_ms` now recorded; grok-only
  runs report model time.
- **P2, `.claude/CLAUDE.md` beside the contract (repaired).** No CLI switch
  disables Claude-compat loading and the config overlay allowlist excludes
  compat tables, so grok.sh moves tracked `.claude/CLAUDE.md` +
  `.claude/CLAUDE.local.md` aside for the run, names them on the prompt with
  the aside path, and restores only where the agent left nothing (agent work
  wins; originals tracked). Subdirectory instruction files and
  `.claude/rules|skills` still load (documented residual).
- **P3, empty pathspec stages all (reproduced, repaired).** Empty stdin to
  `git add --pathspec-from-file` stages the worktree incl. contracts, exit 0
  (git 2.50.1). All 7 shell commit paths now stage only on a non-empty list
  (the codex.mjs rule). Regression drives the shipped `commit_work`
  verbatim with enumeration queries failed out; a non-UTF8-filename variant
  was abandoned (APFS rejects non-UTF8 names).
- **P3, gated prove labeled ready (reproduced, repaired).** `ready()` skips
  the gate (the launch loop enforces it), so gated items printed `ready …
  not launched yet` above their own never-launches section. The stuck split
  now excludes gated items.
- Regressions, each verified failing pre-fix via stash: executors 4 (api),
  8–11 (zero shape, both caps, max_attempts), 12–13 (withholding);
  hygiene 6 (empty guard); gate 4d (gated exclusion). Full suite green.
- Residual risks taken from the review, not built: `sh -c` git bypass
  (documented), subagent spawning, skills/globals riding along, unused
  `--sandbox`, shell-vs-codex `.ostoyae` policy (still undecided).

## Totals and honest gaps

Real cells tonight: 56 Muse launches ($0.00 metered; 137,577 out /
≈24M in incl. cache) + 4 grok verification cells (~$0.35 reported) +
~$0.09 grok probes.
Cells carry large cached context even for trivial tasks — observed, not a
defect. Extra-compute ledger: $0.00 of $30 (local runs sufficed; no VM or
Modal provisioned). No claude/codex executor calls (not authorized for this
run), no live Gemini cells (CLI + credential missing), no live campaign
firing (needs a remote; rehearsal covers mechanics), no Actions (operator
instruction), no push/PR (not authorized).
Old campaign evidence under ~/tinygrad-c2 and ~/tinygrad-ab untouched;
`ostoyae boards` lists those boards read-only, never written.

## Batch: crash consistency and hostile state (after d632f2f)

Scope: concurrent-runner exclusion, interruption at board-write and merge
boundaries, malformed handbacks/usage, stale runfiles and cell
registrations, recovery idempotence, CLI/viewer agreement after recovery,
plus the shell-vs-codex `.ostoyae` policy as investigate-only. All work in
isolated scratch pursuits under $TMPDIR; zero live cells; $0.00 of the $30
ceiling spent (cumulative still $0.00).

Reproduced before repair (repro scripts in /tmp, kept out of the repo):
- **Simultaneous starters both run (reproduced, repaired).** Two runners
  started in the same instant both passed the runfile check, both spawned
  an a-0001, and collided on `<board>.json.tmp` until one crashed with
  ENOENT. The check was read-then-act with no atomicity.
- **Non-array handback `work`/`edges` kill the runner (reproduced,
  repaired).** `{"work": 5}`, `{"work": {...}}`, `{"edges": 7}` threw
  TypeError out of settle (unhandled rejection, runner dead mid-run),
  against the file-header contract "dropped with a note rather than
  crashing the run". `{"work": "abc"}` iterated per character into junk
  notes.
- **Stale trunk merge blamed on the next branch (reproduced, repaired).**
  A MERGE_HEAD left by a killed runner made the next `integrate` report
  the clean branch as conflicting on the stale paths; the branch never
  merged and no retry exists.
- **Corrupt runfile refuses as a stack trace (reproduced, repaired for
  launch/stop).** Launch and stop threw uncaught from `readRun`. Status
  degradation to unknown was built, then reverted: rehearsals/cli.mjs
  ("never appear as empty or inactive") pins exit 2, which is repository
  evidence for refuse-loudly. Pinned instead, with the decision recorded
  in cli.mjs.
- **Recycled cell pids (exercised, already correct).** Stop --now signals
  nothing at strangers; the sweep settles without adopting. Locked in.
- **Recovery idempotence (exercised, already correct).** kill -9 mid-run,
  stop --now, two recoveries: work/attempts/edges byte-identical across
  recoveries, ids unique, each branch merged once. Locked in.
- **Spawn-to-checkpoint window (measured, narrowed).** ~7ms of ps-spawning
  identity bookkeeping sat between spawn and the first checkpoint; a
  kill -9 there orphans a live agent the sweep cannot adopt. The pid now
  checkpoints immediately after spawn. Residual: ~1ms of sync write.
- **absorb double-application (exercised, already correct).** Re-absorbing
  one handback joins without duplicating items or finders.

Repairs: atomic per-graph lock (`<board>.run.json.lock`, O_EXCL claim,
identity-verified stale breaking, fail-closed on unverifiable, re-verify
after claim, released on clean exit); --gate and confirm refuse beside a
live lock holder; absorb drops non-array work/edges with one note;
integrate aborts a stale trunk merge first; cell pid checkpoints before
identity capture; corrupt runfiles refuse plainly (launch exit 1, stop
UNKNOWN exit 10); stop names unsettled attempts when no runfile exists.

Regressions: new `bin/rehearse-crash` (22 asserts, wired into `npm
test`): exclusion pairs, stale/garbage/recycled locks, hostile shapes,
stale merge, corrupt-heartbeat matrix, recycled cell pids, kill -9 double
recovery with byte comparison, status-vs-derive agreement. Verified
failing pre-fix via stash (sections 1, 3, 4, 5b, 5c fail; 2, 5a, 6, 7, 8
are lock-ins). Full suite green after.

`.ostoyae` policy (investigate-only, no repair): shell executors commit
`.ostoyae/*` alongside prove work; codex.mjs excludes it. Every engine
reader takes the handback from the live worktree, never from a branch, so
both policies function; docs say "commit whatever it wrote" without naming
`.ostoyae`, and exactly one comment (sandbox.mjs) calls committing
deliberate. Intended invariant not clear: shell buys post-teardown
archaeology at the price of phantom merge conflicts (handled by removal);
codex buys conflict-free merges at the price of losing the verbatim
report. Preserved as an explicit decision item.

Residuals (documented, not built): confirm-vs-starting-runner ms window;
stop-vs-starting-runner (reports nothing, operator retries); kill -9
between merge commit and MERGE_HEAD removal (re-merge is
content-identical); no in-engine writer produces a torn runfile or board
(all tmp+rename), so those stay external-damage-manual-repair.

## Batch: adversarial review of the 9abee30 lock (same day)

Scope: challenge the per-graph lock and recovery behavior as a review
target. Fake executor only; $0.00 spent, zero live cells. Three genuine
defects, each reproduced pre-fix in isolated scratch pursuits:

- **Gate/runner split-brain (reproduced, repaired).** `--gate` wrote the
  graph with no runfile and no lock: a 12s gate plus a starter at +3s
  ended with the gate's stale checkpoint erasing a settled a-0001
  (`attempts: []`, branch orphaned, next runner would re-mint a-0001
  onto "branch already exists"). `--gate` now holds the lock across the
  whole gate; confirm claims just before its write (dry claims nothing).
  Locks carry the holder's role so a refusal says gating/confirming
  instead of "starting, wait for its first beat".
- **`init --force` beside a live holder (reproduced, repaired).** The
  runfile-existence check is blind to a starter between claim and beat;
  init overwrote the board (attempts wiped) beside a live holder. It now
  refuses beside a verified live holder (stale locks still break at the
  next claimant, not here).
- **Stop beside a starting runner (reproduced, repaired).** No runfile
  meant "nothing to stop: no runner", exit 0, while a starter was about
  to launch cells. Stop now names the holder and exits 10 (nothing to
  signal yet); a gating/confirming holder reports as such with exit 0
  since it launches nothing.

Exercised, already correct, locked in: unverifiable lock owners refuse
fail-closed with the lock preserved; kill -9 stranded locks break on
next launch with recovery completing; zero-byte, mistyped-pid and pid-0
locks break after the grace re-read; legacy identity-less runfiles
proceed on dead pids and refuse on live non-runners only when
unverifiable; doctor ignores stale runfiles/locks without error;
campaign-launched runners self-protect through their own claim.

Regressions: `bin/rehearse-crash` sections 9-10 (8 asserts). 9a-9e and
10a verified failing pre-fix via stash (9d fails knock-on: pre-fix init
wipes the board 9c-9e share); 10b-10c are lock-ins. Full suite green.

Not changed, on purpose: confirm --dry-run still refuses beside a live
runner (pre-existing, errs safe); status shows no runner during the
claim-to-beat millisecond window (self-resolving); no test hooks added
for the confirm-claim race itself (same three lines as the e2e-tested
gate claim; release and stale-break are asserted instead). Residuals:
same board addressed by two names differing only in case still splits
brains on macOS (pre-existing runfile property, inherited by the lock);
mixed old/new engine versions during rollout (a pre-lock starter
ignores the lock); `.ostoyae` policy still undecided (prior batch).

## Batch: independent-review repairs (P1-P4 + confirm re-read, after b56bce4)

Scope: every reproduced material finding from /tmp/ostoyae-review-b56bce4,
verified with its probes before repair. Fake executor only; $0.00 spent.

- **P1 viewer decide during --gate (reproduced, repaired).** The probe's
  exact case: mid-gate POST accepted 200, gate checkpoint erased it back
  to proposed. `/api/decide` now claims (role confirm), re-reads under
  ownership, decides, writes, releases; held graphs answer 409 naming
  the holder. `/api/launch` refuses 409 into a held graph (live or
  unverifiable) and verifies the child beat before answering 200, so a
  holder that appears between check and spawn surfaces as 409/500 with
  the log path instead of a lying 200. Handlers are async-safe and a
  throw answers 500 rather than killing the server.
- **P2 init --force vs unverifiable holder (reproduced, repaired).**
  Launch refused but init overwrote (w-keep gone) because it checked
  verified-live only. Init now fails closed at the claim bar via the new
  `lockClaimant`, claims as role init, re-checks the runfile, writes
  through tmp+rename (preserving the non-force existence refusal), and
  releases on every path.
- **P3 stop vs unverifiable holder (reproduced, repaired).** Stop said
  "nothing to stop", exit 0, beside a holder launch refuses. It now
  names the holder and exits 10; the exit-0 "launches nothing" answer
  stands only for a verified gate/confirm role, since a crafted lock can
  claim any role.
- **P4 grok missing result frame (confirmed in code, fixed).** The
  probe's extraction regex broke (SyntaxError artifact), but line 256
  dereferenced `_result` outside the isinstance guard -- the review's
  p4w run shows the AttributeError. Guarded; usage.json now carries the
  `_bad` evidence and --max-usd still refuses on the unpriced attempt
  (fail-closed preserved, asserted).
- **Confirm residual (reproduced, repaired).** CLI confirm decided on
  the loaded snapshot, then claimed: a writer finishing between load
  and claim was clobbered. Claim, re-read (`refreshBoard`: in-place
  refresh plus work/ontology/defaults rebuild, --model re-applied),
  decide, then write -- for confirm, gate, and main (main also
  resyncs its id counters, which closes duplicate ids even against a
  pre-lock writer). Proven with a 70MB board and a hardlink-swapped
  flip: clobbered pre-fix, both changes land post-fix.

Writer audit (who claims the lock): run/gate/confirm (run.mjs),
viewer decide, init --force all claim; viewer launch checks ownership
and verifies the child; campaign writes only its journal plus git refs
and spawns self-claiming runners; doctor is read-only; demo writes
only its own scratch board; pidfile/index writes are not board writes.
Pre-lock binaries remain the one writer class outside the contract.

Regressions: rehearse-viewer 5a-5d (P1 exact case + launch + idle
control), rehearse-crash 10c-10e (init/stop fail-closed, init
claim/release), 11a (confirm re-read), rehearse-executors 14-15
(grok missing frame + cap). Stash fail-before: 5a, 5b, 10c, 10d, 11a,
14 fail; 5c, 5d, 10e, 10f, 15 are lock-ins. Full suite green.

Residuals: the page shows no runner during a gate (server 409s; display
state untouched); stop cannot signal a starter (by design -- reports
and exits 10); a lock-ignorant writer inside another writer's hold is
outside any lock protocol; mixed old/new versions during rollout;
`.ostoyae` policy still undecided.

## Batch: portability + .ostoyae policy (after cbbbb76)

Scope: the two residuals from the prior batch -- mixed old/new versions
during rollout, and the undecided `.ostoyae` policy -- plus the
case-alias split-brain the portability probe found. Fake/stub only;
$0.00 spent, zero model cells.

- **Canonical board identity (reproduced, repaired).** Two starters
  under different case spellings of one board derived different
  sidecars and verified past each other into the same record. Boards
  now resolve through on-disk-case `canonicalPath` plus
  device/inode `sameFile` (lib/process-identity.mjs), used by every
  owner check and every sidecar derivation in run/init/viewer/
  cli-config/campaign/doctor. Rehearse-crash 12a-12d: alias refuses,
  shared sidecars, one canonical string, hardlink identity.
- **Mixed-version fencing (emulated, repaired).** The last pre-lock
  engine (d632f2f, extracted verbatim) now refuses beside a current
  holder in both directions: every writer -- run, gate, confirm --
  beats a role-carrying runfile in the same breath as the claim
  (measured 0ms lock-to-runfile on a 70MB board, before the 1.2s
  re-read parse), and the refusal names a pre-lock holder as one.
  Recovery over old-written records completes (killed cell swept,
  nothing lost). Rehearse-crash 13a-13d.
- **Two refusal-wording repairs the fencing exposed.** Gates now beat,
  so the with-beat refusal branch had to name the holder's role too
  (`holderDoing` is beat-aware; run.mjs + liveness.mjs), and the
  viewer's decide/launch guards name a gating runfile from its role
  (viewer/serve.mjs; `runner()` carries `role`). Crash 9a and viewer
  5a/5b pin both.
- **`.ostoyae` policy (decided, enforced).** docs/executors.md rule 3
  (`AGENTS.md`, `CLAUDE.md`, `.ostoyae/` never committed) was already
  the rule; only codex.mjs honoured it. All seven shell executors'
  staged-paths enumeration now drops `.ostoyae` and `.ostoyae/*`
  exactly the way codex.mjs does. The rehearsal pursuit no longer
  gitignores `.ostoyae/`, so assertion 5 passes on the filter alone;
  assertion 6 checks the wall path too, and crash 1f covers fake.sh.
  Stash fail-before: old code commits `.ostoyae/usage.json` on done
  and `report.json` + `usage.json` on wall; fixed code commits
  neither (48/48 executors, crash green).
- **12d flake (repaired).** The hardlink check linked the live board,
  and `checkpoint()` replaces the board by rename: a checkpoint
  between link and check is a true negative for `sameFile` and failed
  under full-suite load. It now links a quiet file.

Regressions: rehearse-crash 1f, 12a-12d, 13a-13d;
rehearse-executors 5 (unmasked), 6 (wall path); crash 9a, viewer
5a/5b (wording). Full `npm test` green (NPM_EXIT:0, demo complete;
one pre-existing pytest SKIPPED).

Residuals: live (non-indexed) derive is quadratic -- a 450k-item
board never finishes a launch scan (found while probing; 13d kills
its runner after measuring, so it is not in the way). claude.sh's
one-line filter change is covered by inspection plus its six
rehearsed siblings, not by execution (no claude commit rehearsal
exists). The 70MB-board parse (~1.2s) still sits on the starter
path before first launch.
