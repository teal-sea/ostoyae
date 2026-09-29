# 2026-08-31: the recovered A/B, and the first run where the graph paid for itself

**Found, not run.** A session working from the operator's phone built and ran a second
evaluation on 2026-08-30 between 08:21 and 10:31 local, in `~/erdos-frontier/eval2/`, and died
before committing it. The operator asked for it to be found. It is now committed in
`erdos-frontier` as `1f384a1`, exactly as found, nothing edited. This entry reads it.

## The design, and why it worked where two pilots failed

Six vendor tickets (Erdős 1, 11, 41, 60, 82, 184), each requiring the upstream file vendored
**as written**: the `import FormalConjecturesUtil` line kept, every `@[category ...]` attribute
kept. Saturday's evaluation let agents strip that import, which reduced the shared prerequisite
to a two-line edit; requiring it verbatim makes porting the Util library the real, unavoidable,
shared piece of work. That one design change is what both disqualified pilots were groping for:
a prerequisite expensive enough to be worth mapping.

## The numbers, from `eval2/scores/*.tsv` and `eval2/logs/*.log`

| arm | landed | attempts | output tokens | USD | per landed ticket |
|---|---|---|---|---|---|
| `old` (head-on) | 6/6 | 6 | 85,554 | 16.67 | $2.78 |
| `ost` (Ostoyae) | 5/6 | 12 | 41,596 | 9.78 | $1.96 |

Inside the `ost` arm: six map attempts, **all six walled on the same missing library** at $0.20
to $0.24 each; the shared task `w-vendor-conjectures-util` built once for $2.92; five proves
then landed at $1.05 to $1.18 each, against $2.21 to $3.26 for the same tickets head-on. The
sixth ticket, t-184, was mapped and parked when the 12-launch budget ran out: the
launch-counting defect this branch fixed with `--usd` two days after this run hit it. Not a
failure; a launch counter.

The per-ticket economics, measured rather than estimated this time: redoing the prerequisite
cost head-on agents roughly $1.7 to $2.2 per ticket; a map attempt cost $0.22; the shared build
cost $2.92 once. Break-even at two tickets sharing it. There were six. This is the arithmetic
of `log/2026-08-30-what-the-evaluation-can-still-answer.md` with the sign flipped by a subject
whose shared work is worth more than the probe that finds it.

## What it is and is not

It is the operator's own experiment shape — one run head-on, one run Ostoyae, same tickets,
compare — and the first measured instance of the mechanism paying: the wall became a task, the
task was done once, and a family of proves got cheaper than their control. Duplicate builds of
the prerequisite: **1 against 6.**

It is not the registered experiment. One run of each arm; not matched on dollars (the graph arm
was launch-capped at 59% of the control's spend and still delivered 5 of 6); wall-clock not
compared; concurrency not equalized; tickets agent-designed. By `DECISION-PROTOCOL.md` §7 read
at face value, at equal dollars both arms land 6/6 and the tiebreak goes to dollars-at-last-landed,
which the graph wins by more than a third — but that extrapolates the unspent budget, and the
protocol's own point is that extrapolation is not measurement.

## What it licenses

The subject family is qualified: P2's condition is satisfied by measurement (the prerequisite
priced at 8 to 10 map-attempts' worth per ticket), and the pilot stage's job — find a subject
that can discriminate — is done, by recovery rather than by piloting. The registered arms can
now run on this family, dollar-matched via `--usd`, wall-clock recorded, concurrency ≥ 3 with
the Lean checks running remotely: the Modal check harness was verified end to end tonight
(a remote check's exit code propagates; the Zeta Lean image with the mathlib cache builds on
Modal), so the memory ceiling that forced concurrency 1 is gone.

Subject strikes stand at one (the integration family, struck twice over by two
independent pilots). This family is the counter-example, found by changing what "vendor it"
means.
