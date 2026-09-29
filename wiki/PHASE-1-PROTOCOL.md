# PHASE-1-PROTOCOL.md

> ## ⛔ DO NOT RUN THIS YET. Three blockers, found by an adversarial review of this file
> ## on 2026-09-09, after it was written. None costs money to fix. Two of them would have
> ## produced a number that looked like a result and meant nothing.
>
> **1. The primary duplicate-helper metric is wrong as specified.** §6 diffs each branch against
> the pinned base. Every cell starts from the trunk, not from `sandbox.base`, so work a cell
> inherited is counted as work it duplicated. Measured on this repo's own rehearsal output: the
> last arm-A branch diffs thirteen other items' files against base. On arm B this makes the
> zero-redundant-scaffolding threshold **unreachable exactly when the graph works**, because a
> shared helper is merged into every dependent. **September 9 follow-up:** the runner now
> records `sandbox.start_commit` after provisioning and `end_commit` before teardown.
> A regression proves a consumer's own diff excludes its inherited helper. §6 now uses
> those snapshots. The counting script is still unwritten; old attempts without a start
> and attempts with `start_conflicts` must not be scored as zero duplication.
>
> **2. The subject does not hold at any pin.** The admissibility screen this file requires was
> run for the first time by the reviewer, against a real clone of `sphinx-doc/sphinx` at
> `dd1615c5`: **seven of the fifteen test patches do not apply**, real `--3way` fails on all
> seven, only one of the eight named reserves applies, and **no pin among the fifteen base
> commits gets more than eight of fifteen to apply.** The board's ceiling is nine items, both
> `FAIL_TO_PASS` collisions are destroyed, and the `domains/python.py` cluster collapses from
> five items to one. The brief's "15 interdependent" is not obtainable in this window. **How
> many items the experiment runs with is the operator's decision, not a detail.**
>
> **3. One item's check can never pass.** `sphinx-doc__sphinx-8621`'s `FAIL_TO_PASS` ids are
> truncated in the dataset, and §3 writes them verbatim into `pytest -q <ids>`. A selection
> error currently reads as a genuine failure. The screen needs a `pytest --collect-only`
> criterion that asserts the expected number of tests is actually selected.
>
> **What survived the review, and is worth keeping:** the model control is real and wired
> through (`run.mjs:807-810` into `claude.sh:31`), and both arms genuinely share one token
> capture path, which was the thing most likely to be fudged.
>
> **The deeper finding, which is about the brief rather than this file.** SWE-bench Verified
> holds 499 distinct `base_commit` values across 500 rows. Distinct bases do not prove
> independence; they do mean the dataset does not supply the shared-base, interdependent
> set this protocol needs. Its gold patches are localised fixes to existing code.
> The shared-unwritten-helper mechanism the brief measures may not be present in this
> dataset at all. §6's void condition covers that, but it should be read before any money is
> committed, not after.


**Status when this file was committed: pre-registration only. No arm has run. No number below
came from an experiment.** The two boards it governs are `examples/swebench-phase1-arm-a.json`
and `examples/swebench-phase1-arm-b.json`; `bin/rehearse-phase1` is the mechanical guard on
both. This is the third pre-registration in this wiki and it inherits from all of them:
`wiki/EVALUATION-PROTOCOL.md`, `wiki/EVALUATION-VERDICT.md`, which is the record of that design
failing, and `wiki/DECISION-PROTOCOL.md`, which is the one-page redesign written after it. Read
the verdict before this. §11 is written against it, and §4, §6 and §9 take their arm rules,
pilot gates and concurrency requirement from `DECISION-PROTOCOL.md` rather than restating them
in new words.

**Where Phase 1 differs from `DECISION-PROTOCOL.md`, and why both exist.** That protocol is
registered to a decision about the engine, on the operator's own repository, with tickets landed
as its primary endpoint. Phase 1 comes from an external evaluation brief, run on neutral ground,
with **token spend and duplicate helper implementations** as its endpoints. They can share the
pilot gates and the arm rules; they do not share a primary endpoint and neither one's verdict
decides the other's.

The claim under test is not this repo's. It is the Phase 1 line of that external brief: run 15
interdependent issues from SWE-bench Verified, and measure total token spend and duplicate
helper implementations across Arm A (Flat Claude Code) vs. Arm B (Ostoyae).

---

## 0. The one thing that must not be got wrong: both arms run the same model

The variable under test is the orchestration. A stronger model on arm B measures the model and
the result attributes to nothing. So:

**One model string, in one place, in both boards, and nowhere else.** `defaults.model`, and no
`params.model` on any item, no `mapping.params.model`, no `judge.params.model`. Both boards
carry `sonnet` today and it is the only decision in either file the operator is expected to
change; changing it in one file and not the other is the accident this section exists to stop.

Three things enforce it, in the order they fire:

1. `bin/rehearse-phase1` assertion 2 fails if the two boards disagree, if a model appears
   anywhere other than `defaults`, or if the string `"model"` occurs more than once in either
   file. Run it before either arm and after any edit to either board.
2. `mapping.params` and `judge.params` are absent from arm B on purpose. A cheaper mapper is
   the obvious economy — `wiki/EVALUATION-PROTOCOL.md` §3 used one — and it is exactly what
   makes arm B a different model from arm A. The cost of not taking it is that arm B pays the
   work model's rate for every map and every verify attempt, which biases **against** the
   hypothesis. That is the right direction for a claim being tested for falsity.
3. After the run: `result.usage.model` is recorded on every attempt of every arm
   (`graph.schema.md:184`). The set of values across both arms must have exactly one member.
   `--model sonnet` is an alias and the snapshot behind it can move between arms, so pin the
   dated model id in `defaults.model` before launching and check the recorded set afterwards.
   An arm whose recorded models are not one value is void, not adjusted.

Nothing in the engine checks any of this. The three above are what there is.

---

## 1. The subject, and what SWE-bench Verified will not give

**Established, from the dataset itself.** SWE-bench Verified was read on 2026-09-09 through
`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test`,
500 rows in five pages of 100. Columns: `repo`, `instance_id`, `base_commit`, `patch`,
`test_patch`, `problem_statement`, `hints_text`, `created_at`, `version`, `FAIL_TO_PASS`,
`PASS_TO_PASS`, `environment_setup_commit`, `difficulty`.

Three measurements, each a counted fact about the 500 rows:

| measured | value |
|---|---|
| distinct `base_commit` values | **499 of 500** |
| repos | django 231, sympy 75, sphinx 44, matplotlib 34, scikit-learn 32, astropy 22, xarray 22, pytest 19, pylint 10, requests 8, seaborn 2, flask 1 |
| instances in one repo at one `version` sharing a gold-patch file, best case in a pytest-driven repo | sphinx, 11 of 15 in a 2020-12-17..2021-08-29 window |

**So the brief's sentence does not describe anything the dataset contains.** Every instance is
an independent PR at its own base commit; there is no dependency between any two. "15
interdependent issues from SWE-bench Verified" cannot be selected, only constructed. Two
further consequences follow from the same numbers:

- **One graph is one pursuit at one base** (`graph.schema.md:471`, `sandbox` is required and
  carries a single `repo` and `base`). Fifteen instances at fifteen base commits cannot be one
  board. They have to be pinned to one commit, which is a modification of the benchmark.
- **No pytest-driven repo has 15 instances in one version band.** Django has 43 at v3.2, and
  django's tests run through `tests/runtests.py`, not pytest. The largest pytest-driven cluster
  is sphinx's 15-instance window above. The boards use sphinx, and that is the reading taken
  where the brief ("15 interdependent") and the request ("a Python repo under pytest") cannot
  both be satisfied.

### How interdependence was established, and what it is not

For the 15 chosen instances, computed from the gold patches:

- **11 of 15 touch a file another one touches.** `sphinx/ext/autodoc/__init__.py` in 5,
  `sphinx/domains/python.py` in 5, `sphinx/util/docfields.py` in 2, `sphinx/util/inspect.py`
  in 2, `sphinx/ext/autodoc/importer.py` in 2.
- **3 of 15 edit the same function**: the hunk context `def add_directive_header(self, sig: str)
  -> None:` in `sphinx/ext/autodoc/__init__.py`. Two more pairs share a hunk context:
  `def make_xref(...)` and `def handle_signature(...)` in `sphinx/domains/python.py`, and
  `def transform(self, node: nodes.field_list)` in `sphinx/util/docfields.py`.
- **2 pairs share a failing test.** `sphinx-doc__sphinx-8551` and `sphinx-doc__sphinx-9230`
  both have `tests/test_domain_py.py::test_info_field_list` in `FAIL_TO_PASS`;
  `sphinx-doc__sphinx-9461` and `sphinx-doc__sphinx-9591` both have
  `tests/test_domain_py.py::test_pyproperty`.

**That is co-location, not dependency, and it is not what the brief's mechanism needs.** The
brief's claim is about duplicate scaffolding, and scaffolding gets duplicated when several
items each need the same piece of code that does not exist yet. SWE-bench gold patches are
localised fixes to code that already exists. Nothing in the 15 requires an unwritten helper.
So the honest position, on record before any arm runs:

**The mechanism arm B exists for may not be present in this subject at all.** §6 makes that a
pre-registered void condition rather than a discovery, because that is precisely the failure
`EVALUATION-VERDICT.md` §3 records: "the primary endpoint hit the ceiling before `G` ran … with
no headroom no arm can show a difference".

### The 15, and the pinned base

`sandbox.base` in both boards is `dd1615c59dc6fff633e27dbb3861f2d27e1fb976`, the earliest base
commit of the 15 (`sphinx-doc__sphinx-8548`, 2020-12-17). Earliest, not latest, because at the
latest base commit fourteen of the fifteen fixes are already in the tree and those items are
already done.

| item | instance | version | base commit date | gold-patch files |
|---|---|---|---|---|
| `w-sphinx-8548` | sphinx-doc__sphinx-8548 | 3.4 | 2020-12-17 | autodoc/`__init__`, autodoc/importer |
| `w-sphinx-8551` | sphinx-doc__sphinx-8551 | 3.4 | 2020-12-19 | domains/python, util/docfields |
| `w-sphinx-8593` | sphinx-doc__sphinx-8593 | 3.5 | 2020-12-27 | autodoc/`__init__`, autodoc/importer |
| `w-sphinx-8595` | sphinx-doc__sphinx-8595 | 3.5 | 2020-12-27 | autodoc/`__init__` |
| `w-sphinx-8621` | sphinx-doc__sphinx-8621 | 3.5 | 2020-12-30 | builders/html/transforms |
| `w-sphinx-8638` | sphinx-doc__sphinx-8638 | 4.0 | 2021-01-01 | domains/python |
| `w-sphinx-8721` | sphinx-doc__sphinx-8721 | 3.5 | 2021-01-21 | ext/viewcode |
| `w-sphinx-9229` | sphinx-doc__sphinx-9229 | 4.1 | 2021-05-15 | autodoc/`__init__` |
| `w-sphinx-9230` | sphinx-doc__sphinx-9230 | 4.1 | 2021-05-15 | util/docfields |
| `w-sphinx-9258` | sphinx-doc__sphinx-9258 | 4.1 | 2021-05-21 | domains/python |
| `w-sphinx-9281` | sphinx-doc__sphinx-9281 | 4.1 | 2021-05-29 | util/inspect |
| `w-sphinx-9320` | sphinx-doc__sphinx-9320 | 4.1 | 2021-06-11 | cmd/quickstart |
| `w-sphinx-9367` | sphinx-doc__sphinx-9367 | 4.1 | 2021-06-20 | pycode/ast |
| `w-sphinx-9461` | sphinx-doc__sphinx-9461 | 4.2 | 2021-07-17 | domains/python, autodoc/`__init__`, util/inspect |
| `w-sphinx-9591` | sphinx-doc__sphinx-9591 | 4.2 | 2021-08-29 | domains/python |

Each item's `what` is the instance's `problem_statement` verbatim and nothing else. The
`FAIL_TO_PASS` tests are not in the board and no cell can read them: they live in the check,
outside the pursuit (§3).

### Admissibility: the step that has not been run

Pinning fifteen instances to one commit invalidates the dataset's guarantee. Each instance's
`test_patch` was written against its own base commit, eight months later in some cases. **An
instance is admissible only if, at the pinned base:** its `test_patch` applies; its
`FAIL_TO_PASS` tests then fail; and its `PASS_TO_PASS` tests then pass. The procedure:

```sh
git -C ~/swebench/sphinx checkout --detach dd1615c59dc6fff633e27dbb3861f2d27e1fb976
# per instance, in a throwaway worktree of that commit, with the environment of §2:
git apply --3way ~/swebench/phase1/patches/<instance_id>.test.patch   || echo "INADMISSIBLE: patch"
pytest -q <FAIL_TO_PASS ids>   && echo "INADMISSIBLE: already passes"
pytest -q <PASS_TO_PASS ids>   || echo "INADMISSIBLE: base is not green"
```

**This has not been run and cannot be run from the machine that wrote this file** (no sphinx
clone, no environment for sphinx 3.4). Every item in both boards is therefore a candidate, not
a confirmed subject. **An inadmissible item is replaced from this reserve, in order**, each of
which shares a file with the 15:

`sphinx-doc__sphinx-7462`, `sphinx-doc__sphinx-7454`, `sphinx-doc__sphinx-7748`,
`sphinx-doc__sphinx-8035`, `sphinx-doc__sphinx-9602`, `sphinx-doc__sphinx-9698`,
`sphinx-doc__sphinx-7757`, `sphinx-doc__sphinx-8265`.

The first four have base commits **earlier** than the pinned base (2020-04 to 2020-08), so
substituting one moves the pin earlier and re-opens admissibility for everything. Substitute
from the last four first.

Also to settle during admissibility: the two `FAIL_TO_PASS` collisions above. If after pinning
one member of a pair is satisfied by the other's fix, the pair is one item and not two, and the
board goes to 14 with one substitution. Both boards must be edited together and the rehearsal
re-run.

---

## 2. The pursuit and the environment

One clone, `~/swebench/sphinx`, of `github.com/sphinx-doc/sphinx`, with the pinned base commit
present. `sandbox.repo` in both boards points at it.

**Doctor cannot tell you the pinned base is there.** `doctor.mjs:157-163` runs
`git rev-parse --verify --quiet <base>`, and git exits 0 for any well-formed 40-hex string
whether the object exists or not. Reproduced on 2026-09-09 in a repo that did not contain the
commit:

```
$ git rev-parse --verify --quiet dd1615c59dc6fff633e27dbb3861f2d27e1fb976
dd1615c59dc6fff633e27dbb3861f2d27e1fb976
exit=0
$ git rev-parse --verify --quiet 'dd1615c59dc6fff633e27dbb3861f2d27e1fb976^{commit}'
exit-with-commit=1
```

Doctor then printed `ok pursuit …, base dd1615c…` and `ready to launch`, and the run recorded
30 attempts, every one `failed` with `provision failed: … git branch ost/arm-a/trunk
dd1615c…`. So the pre-flight is a command, not doctor:

```sh
git -C ~/swebench/sphinx rev-parse --verify "$(node -e 'process.stdout.write(require("./examples/swebench-phase1-arm-a.json").sandbox.base)')^{commit}"
```

The one-line fix in `doctor.mjs` (append `^{commit}` to the ref it verifies) is not made here;
it is an engine change and this is a protocol.

**The interpreter environment.** `sandbox.env_passthrough` is `["VIRTUAL_ENV", "PYTHONPATH"]` in
both boards, and nothing else. A cell is a bare worktree and the environment is replaced, not
extended (`graph.schema.md:471`), so:

- `PYTHONPATH` must be `.` at launch. That is what makes `import sphinx` resolve to the cell's
  own branch rather than to the pursuit or to a site-packages copy. `bin/rehearse-phase1`
  assertion 12 empties `env_passthrough` and the check then fails with `ModuleNotFoundError`,
  which is what says the field is load-bearing and not decorative.
- `VIRTUAL_ENV` is passed because pytest plugins, tox and uv read it to decide which
  interpreter they are in.
- **Nothing else is passed on purpose.** `PYTEST_ADDOPTS`, `SPHINX_*` or `PYTHONWARNINGS` in the
  launching shell would change what the check measures, and both arms have to see the same
  environment. If an arm needs a variable, both boards get it and the rehearsal is re-run.
- `sandbox.link` is absent. A linked package directory would be the pursuit's copy shared by
  every cell, which is the opposite of what this needs.

The third-party dependencies of sphinx 3.4 (docutils, jinja2, babel, imagesize, and the pins in
that commit's `setup.py`) come from the venv the run is launched from. Nothing is installed
inside a cell. **Building that venv is an operator step and it is not done** (§10).

Declared tools, identical in both boards: `pytest`, `flake8`, `mypy`, each with a `probe`.
`python3 -m pytest` is deliberately not declared: doctor reads the token after an interpreter as
the script and reports `-m is not there`.

---

## 3. The gate: how an item is scored

`work[].check` on every item, in both boards, is
`bash /home/tom/swebench/phase1/checks/<instance_id>.sh`. The runner runs it on a fresh detached
checkout of the attempt's branch, not in the cell (`graph.schema.md:211-229`), after the
executor exits zero and before teardown. Exit 0 is `done`; anything else is `failed` with the
command and its last lines on the record.

Each script does exactly three things, and the generator that writes them is the same one that
writes the patches:

```sh
set -eu
git apply /home/tom/swebench/phase1/patches/<instance_id>.test.patch
pytest -q <FAIL_TO_PASS ids>
pytest -q <PASS_TO_PASS ids>
```

**The scripts and the patches live outside the pursuit.** A cell's tools are confined to its
worktree, so no agent can read the tests it is judged on. That is the same rule
`wiki/EVALUATION-PROTOCOL.md` §5 froze ("held outside the repository during execution, its
SHA-256 frozen in the run's log entry and re-verified after"), and it is why the check is a
script path rather than a `pytest` line in the board.

Generate them from the dataset, once, before any arm:

```sh
python3 - <<'PY'
import json, urllib.request, os, shlex
rows = []
for off in range(0, 500, 100):
    u = ("https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified"
         f"&config=default&split=test&offset={off}&length=100")
    rows += [r["row"] for r in json.load(urllib.request.urlopen(u, timeout=60))["rows"]]
want = {w["check"].rsplit("/", 1)[-1][:-3]
        for w in json.load(open("examples/swebench-phase1-arm-a.json"))["work"]}
os.makedirs(os.path.expanduser("~/swebench/phase1/checks"), exist_ok=True)
os.makedirs(os.path.expanduser("~/swebench/phase1/patches"), exist_ok=True)
for r in rows:
    if r["instance_id"] not in want: continue
    iid = r["instance_id"]
    open(os.path.expanduser(f"~/swebench/phase1/patches/{iid}.test.patch"), "w").write(r["test_patch"])
    f2p = " ".join(map(shlex.quote, json.loads(r["FAIL_TO_PASS"])))
    p2p = " ".join(map(shlex.quote, json.loads(r["PASS_TO_PASS"])))
    patch = shlex.quote(os.path.expanduser(f"~/swebench/phase1/patches/{iid}.test.patch"))
    open(os.path.expanduser(f"~/swebench/phase1/checks/{iid}.sh"), "w").write(
        "set -eu\n"
        f"git apply {patch}\n"
        f"pytest -q {f2p}\n" + (f"pytest -q {p2p}\n" if p2p else ""))
print(len(want), "checks written")
PY
sha256sum ~/swebench/phase1/checks/*.sh ~/swebench/phase1/patches/*.patch
```

**The digests go in the log entry that opens the run, before the first arm, and are re-verified
after the last.** A check changed mid-experiment voids everything scored before the change.

Note the paths above are `/home/tom/...` to match `examples/python-etl-backfill.json` and the
other boards; if the operator's home is different, both boards and the generator change
together and the rehearsal is re-run.

---

## 4. The arms

Four. All four run through `executors/claude.sh`, so every arm's token record comes from one
code path (§5). All four run against the same pursuit at the same pinned base with the same
checks, the same tools, the same `env_passthrough` and the same model.

| arm | board | how | what it isolates |
|---|---|---|---|
| **A** | `swebench-phase1-arm-a.json`, split into 15 one-item graphs | 15 runs, one item each, its own trunk, three in flight at a time | flat: no cell ever sees another item's work |
| **A-trunk** | the same board, run whole | one run, `concurrency: 3`, 15 items in file order | flat scheduling with an accumulating trunk |
| **A-one** | the same board, folded to one item | one run, one item whose `what` is all 15 problem statements | one long session for all fifteen |
| **B** | `swebench-phase1-arm-b.json` | `bin/ostoyae go`, mapping + judge + ontology, confirms per §8 | the graph |

**Concurrency is 3 in both boards and is not a knob.** `wiki/DECISION-PROTOCOL.md` §5 froze it
("Concurrency ≥ 3 in both arms, the same number in both, is a requirement on the subject, not a
tuning knob") and §6 says why: "the fair control for a DAG of agents is a flat pool of agents,
not one agent in series; comparing the graph to a serial baseline would hand it a wall-clock win
that flat parallelism gets for free". So arm A's fifteen one-item graphs are launched three at a
time, and arm A is a flat pool, not a queue. Rehearsal assertion 4 fails if the two boards ever
disagree on it.

### Why arm A is one session per issue

Because that is the only arm A in which a duplicate helper implementation can occur at all. A
single session that reads all fifteen issues has already seen its own earlier work when it
reaches the twelfth, so it writes a shared helper once — which is arm B's result obtained
without arm B. Running only the single-session arm would make the brief's second threshold
unmeasurable; running only the split arm would leave the strongest control untested, which is
exactly what `EVALUATION-VERDICT.md` §8 records as the reason the first experiment's primary
result was "not obtained rather than negative" ("`R2` was never run"). So both run.

### Why A-trunk exists, and how it was measured

**Every Ostoyae cell starts from the trunk, not from `sandbox.base`** (`graph.schema.md:607`).
So fifteen items run through one board share their finished work whether the board has an edge in
it or not. That is not a flat arm and it is not a detail:

`bin/rehearse-phase1` assertions 8 and 9, fake executor, zero model calls. Run whole, the
fifteenth attempt's branch carries all fifteen files (`ls-tree -r` on
`ost/arm-a/<last attempt>` returns 15 `.txt` paths). Split into fifteen one-item graphs, the
branch of the same item carries one (`['w-sphinx-9591.txt']`). Same board, same executor, same
checks.

If B's saving against A disappears against A-trunk, the result is consistent with
shared accumulation explaining the gain. It does not establish an additional
benefit from the graph. A-trunk is the control that separates those explanations.

### The three A variants, as commands

```sh
# A: fifteen one-item graphs. Each keeps concurrency 1, max_attempts 2, its own trunk.
python3 - <<'PY'
import json
g = json.load(open("examples/swebench-phase1-arm-a.json"))
for w in g["work"]:
    one = dict(g, graph=f"phase1-a-{w['id']}", work=[w], edges=[], attempts=[])
    json.dump(one, open(f"/tmp/phase1-a-{w['id']}.json", "w"), indent=2)
PY
# Three in flight at a time, so arm A is a flat pool at arm B's concurrency and not a queue.
for f in /tmp/phase1-a-w-sphinx-*.json; do
  node doctor.mjs "$f" --exec "bash $PWD/executors/claude.sh" || break
done
printf '%s\n' /tmp/phase1-a-w-sphinx-*.json | xargs -P 3 -I{} \
  node run.mjs {} --exec "bash $PWD/executors/claude.sh" --max-usd <per-item cap>

# A-trunk: the board as committed.
node run.mjs examples/swebench-phase1-arm-a.json --exec "bash $PWD/executors/claude.sh" --max-usd <cap>

# A-one: the same fifteen prompts as one item, gated by all fifteen checks.
python3 - <<'PY'
import json
g = json.load(open("examples/swebench-phase1-arm-a.json"))
g["graph"] = "phase1-a-one"
g["work"] = [{"id": "w-all-fifteen", "needs": [],
              "what": "\n\n---\n\n".join(w["what"] for w in g["work"]),
              "check": "bash /home/tom/swebench/phase1/checks/all.sh"}]
g["edges"] = []; g["attempts"] = []
json.dump(g, open("/tmp/phase1-a-one.json", "w"), indent=2)
PY
# checks/all.sh runs the fifteen scripts in order and exits 0 only if all fifteen do; it also
# writes one line per item so a partial result is countable. Not written yet (§10).
```

A-one lands 0 or 15 as an item, so its per-item score comes from `all.sh`'s per-item lines and
not from the graph. Its usage record is one session's, which is the point of the arm.

### Arm B

`concurrency: 3`, `max_attempts: 2`, `mapping` on with one map attempt per item, `judge` on with
`require_check: true`, `ontology` with two kinds. No `needs`, no authored edges: **the board must
not contain the answer.** Rehearsal assertion 6 fails if either board ever grows one.

The two ontology kinds are the shapes a proposal may take on a Python repo:

| kind | claim | what it is for |
|---|---|---|
| `helper` | `module`, `symbol`, `signature` | code several items would each write |
| `fixture` | `path`, `name` | a pytest fixture several items would each build |

Identity is `sha1(kind, claim)`, so two mappers naming the same helper become one item with two
finders instead of two items. That collision is what makes duplicate-scaffold counting mean
anything on this arm, and it is the mechanism `EVALUATION-VERDICT.md` §4 records working at
$13.97 of cost when it was absent.

The `helper` check takes the module and symbol as **argv**, not as interpolated Python:

```
python3 -c "import importlib,sys; sys.exit(0 if hasattr(importlib.import_module(sys.argv[1]), sys.argv[2]) else 1)" {module} {symbol}
```

The obvious spelling, `python3 -c "from {module} import {symbol}"`, is wrong: the runner
shell-quotes every claim value it puts in a check (`run.mjs:841-848`), so it comes out as
`from 'sphinx.util.typing' import 'render_field_type'` and is a `SyntaxError`. Found by
rehearsal assertion 13, which is now the guard on it.

`judge.default_check` is `pytest -q --junitxml=/tmp/ostoyae-{id}.xml`, the whole suite. For a
task a mapper wrote and nobody gated, "the suite still passes" is the only mechanical gate
there is; `{id}` is in it because doctor refuses a `default_check` without one.

---

## 5. Token capture, and whether the arms are comparable

**They are, because there is one capture path.** `executors/claude.sh` runs
`claude -p … --output-format stream-json --verbose` and pipes it through a filter that, on the
`result` event, writes `.ostoyae/usage.json` (`executors/claude.sh:154-191`):

```
model                       from the keys of the event's modelUsage
input_tokens                usage.input_tokens
output_tokens               usage.output_tokens
cache_read_input_tokens     usage.cache_read_input_tokens
cache_creation_input_tokens usage.cache_creation_input_tokens
cost_usd                    total_cost_usd
duration_ms, api_ms, turns  duration_ms, duration_api_ms, num_turns
```

The runner records that verbatim as `result.usage` on the attempt, **on every outcome, because a
failed attempt cost money too** (`graph.schema.md:184-194`). All four arms run through this same
executor and the same `--output-format`, on the same fields, so the numbers are commensurable by
construction rather than by argument. That is the one thing the first evaluation got right and
it is why `graph.schema.md:194` calls this "the denominator `wiki/EVALUATION-PROTOCOL.md`
matches arms on".

What is **not** settled about it, stated as such:

- **Whether `usage.output_tokens` on the final `result` event is the session total or the last
  turn's.** Reported, not verified: `EVALUATION-VERDICT.md` §5 records single attempts at 24 to
  49 turns and up to 168,920 output tokens, which is a session total and not one turn. It has
  not been checked directly from this repo. **What would settle it:** one cheap real cell, and
  a comparison of the final event's `usage.output_tokens` against the sum of `output_tokens`
  over that session's `assistant` events. One cell, and it must be run before either arm, not
  after.
- **Arm B has three kinds of attempt.** Map and verify attempts write usage the same way and
  `result.usage` is on all of them, so arm B's denominator is the sum over **every** attempt of
  every kind, retries and failures included. `EVALUATION-VERDICT.md` §8 is what happens when
  that is not done: the mappers were $6.57 of $17.08 and the arm's headline number was an
  artifact of a launch counter.
- **Cache tokens are not comparable across arms and are not the primary.** Arm B's prompts are
  longer (§9.3) and cache hits depend on what else ran on the account. `output_tokens` is the
  primary because it is the least cache-sensitive of the four fields; `input_tokens`,
  `cache_read_input_tokens` and `cache_creation_input_tokens` are reported beside it, never
  folded into it.
- **An attempt whose executor wrote no usage is unpriced, never zero** (`graph.schema.md:189`).
  The run's `spent:` line already says so. Any arm with an unpriced attempt reports the count of
  them next to its total.
- **A-one's usage is one record for fifteen items.** No per-item attribution exists for that
  arm and none is invented.

---

## 6. Duplicate helper implementations, counted rather than judged

The brief's second endpoint. `wiki/EVALUATION-PROTOCOL.md` §6 counted this "by a person reading
the diffs, blind to arm", and `EVALUATION-VERDICT.md` reported 11, 11, 11, 2 with no stated
rule. This replaces that with something a script does.

**Definition.** For an arm, take every prove attempt, including unsuccessful
ones that committed work. Resolve its recorded `sandbox.start_commit` and
`sandbox.end_commit` in the pursuit and use `git diff <start_commit> <end_commit>`.
Never substitute the graph's pinned base or the current branch tip. Missing
commits, missing snapshots or `start_conflicts` make attribution unavailable;
an arm with unavailable attribution cannot pass the zero-duplication criterion.
Parse added Python definitions with `ast`: every `FunctionDef`, `AsyncFunctionDef`
and `ClassDef` present at the end and absent at the start. For each compute a **body
fingerprint**: `ast.dump` of the node with docstrings removed, all identifiers of arguments and
locals renamed positionally, and the node's own name excluded.

Then, over the arm's attempts:

| count | rule |
|---|---|
| **D-body** (primary) | Σ over fingerprints of max(0, n−1), where n is the number of distinct **work items** whose branches add a definition with that fingerprint |
| D-name-file | same, keyed on (file path, definition name) |
| D-name | same, keyed on definition name alone |

D-body is primary because it does not depend on two agents choosing the same name, which is the
thing arb B's ontology is supposed to make unnecessary. D-name and D-name-file are reported
beside it because a name collision across two modules may be two different things and the reader
should be able to see the difference.

The counting script is written **before any arm runs**, its SHA-256 frozen in the same log entry
as the checks, and it is run over an anonymised list of branch names so the person running it
cannot see which arm a branch belongs to. It is not written yet (§10).

**The pilot, and the void condition.** `EVALUATION-VERDICT.md` §3 and §7 pre-commit this: a
$10 head-on pilot that must fail at least once, before the arms. Here it must also **duplicate
at least once**. So:

> **P1 and P2 of `wiki/DECISION-PROTOCOL.md` §4, on the 4 items that touch
> `sphinx/ext/autodoc/__init__.py` (`w-sphinx-8548`, `w-sphinx-8593`, `w-sphinx-8595`,
> `w-sphinx-9229`), arm A, split, one session each.** P1 as frozen there: at least one of the
> four must fail its check, or there is no headroom. P2 as frozen there: the shared work must be
> worth ≥ $3 a ticket, or "a prerequisite worth a minute goes back in the drawer". Phase 1 adds
> one gate of its own because its endpoint is duplication and not tickets landed: **P3, if D-body
> is 0 across those four, Phase 1's second endpoint is VOID and no further arm runs until the
> subject is changed.** Nothing was duplicated, so nothing can be de-duplicated, and
> the threshold "zero redundant scaffold implementations" is met by both arms trivially. This is
> the 2026-08-30 no-headroom failure, and it is more likely than not here for the reason §1
> gives: nothing in the 15 needs an unwritten helper.

If the pilot's D-body is 0 the licensed next move is stated now, so it is not a decision made
under the pressure of a sunk cost: **either change the subject** (a codebase where several open
tickets do need one unwritten thing — which is `EVALUATION-PROTOCOL.md` §5's own requirement,
and which SWE-bench Verified does not satisfy), **or inject the prerequisite** by deleting a
helper that the 15 fixes rely on from the pinned base and recording exactly what was deleted.
The second is no longer SWE-bench Verified and must not be reported as it.

---

## 7. Thresholds, pre-registered

The brief says "≥ 25% token reduction and zero redundant scaffold implementations". Stated so
that it can be scored:

| endpoint | rule | pass |
|---|---|---|
| **T1 primary** | total output tokens, arm B over arm A, summed over every attempt of every kind | `B ≤ 0.75 × A` |
| **T2 primary** | output tokens per **landed** item, arm B over arm A. Landed = the item's check exited 0 on a branch, run by the engine | `B ≤ 0.75 × A` |
| **T3** | D-body on arm B | `= 0` |
| **T4** | D-body on arm A | `≥ 1`, or the endpoint is void (§6) |
| **T5** | items landed, arm B | `≥` arm A's, minus 1 |

**T1 and T2 must both pass.** The brief says "total token spend", and a total-token reduction
achieved by landing fewer items is not a reduction: `EVALUATION-VERDICT.md` §8 is the case —
`G` spent 168,026 output tokens against about 867,000 budgeted, "19% of 2B, 81% below the band",
with five tickets never attempted, and its landed count "is a measurement of that arithmetic".
T5 is the floor that stops T1 being won that way; one item of slack because with 15 items a
one-item difference is noise.

Arms A-trunk and A-one are scored on the same endpoints and are **not** part of the pass rule.
They are what the result gets attributed to (§8).

**n = 1 is not a measurement.** Three replicates per arm, different days, and the reported
number is the median with the range beside it. If the budget allows only one pass per arm, this
is a screen and the words "screen, not a result" go in the verdict, as
`EVALUATION-PROTOCOL.md` §10 did.

---

## 8. What would falsify the claim

Symmetric to §7, and each row is a stop, not a discussion.

| observation | what it licenses |
|---|---|
| arm A ≤ arm B on output tokens per landed item | **the claim is false on this subject.** No graph. |
| D-body on arm A is 0 | the second endpoint is void; the subject cannot show the mechanism (§6) |
| arm B lands fewer items **and** spends more per landed item | the graph is worse on both axes; simplify, per `EVALUATION-VERDICT.md` §2 |
| B's saving over A disappears against **A-trunk** | the saving is the shared trunk, not the DAG or the mapper. Keep the trunk, delete the rest. |
| **A-one** beats B on either T1 or T2 | one longer session is the cheaper orchestration. This is the row most likely to fire and it is the reason A-one is mandatory. |
| any arm B item recorded `done` with no `result.check` | the record cannot be trusted; the experiment is void until every item's check ran. `require_check: true` is on for this reason. |
| the recorded `result.usage.model` set across both arms has more than one member | void. §0. |
| arm B's confirms include an item that is not one of the 15 and has no confirmed edge to one | scope drift, and the number is not about the 15 any more. Count them; `EVALUATION-VERDICT.md` §4 records three such tasks confirmed by a scripted yes. |

**Confirms on arm B are `bin/ostoyae confirm-scoped` only, scripted, with the count of confirmed
proposals and their ids recorded per pass.** A hand-picked confirm is the operator choosing the
graph's answer, and it cannot be told apart from the graph finding it.

---

## 9. Confounds

Every one of these is a reason a difference between the arms might not be the orchestration.
None of them is resolved by this document; they are named so the verdict can say which ones
were live.

1. **Arm B gets more attempts and more turns.** Fifteen map attempts, up to fifteen verify
   attempts, and up to two prove attempts per item, against arm A's up to two. That is the
   brief's own obvious confound and the mitigation is not a cap, it is the denominator: every
   attempt of every kind counts in T1 and T2, and `attempts`, `turns` and `duration_ms` are
   reported per arm beside the tokens. Arm B may legitimately use more turns; it may not use
   them for free.
2. **The shared trunk.** Measured, §4. A-trunk separates it.
3. **Prompt length.** An arm B prove attempt's prompt carries the full Ostoyae contract, the
   proposal contract generated from the ontology (`run.mjs:771-787`), and, on a mapped item,
   the map. An arm A prompt carries the plain contract (`sandbox.mjs:256-277`). Arm B's input
   tokens are structurally higher and its output tokens include writing `report.json`. Reported
   separately; `output_tokens` is primary; no composite score.
4. **The plain contract is not silent about reports.** `toolSection` (`sandbox.mjs:279-299`) is
   appended to both contracts and it says "put its job id in your report's `ahead`". A plain
   agent is therefore told it has a report. It is identical in both arms because the boards
   declare identical tools, so it is not an arm difference — but it is a deviation from
   `graph.schema.md:499`'s "a plain agent is a plain agent" and it belongs on the record.
5. **The wall floor against a verbatim GitHub issue.** A wall must contain one word of four
   letters or more that is not in the item's own id, label and text (`run.mjs:710-722`). These
   items' `what` is a 1,400-character issue report, so the excluded set is hundreds of words and
   a legitimate wall is more likely to be scored as restating the task, recorded `failed`, and
   not to park its item. Countable: attempts with `result.wall` present and `state: failed`.
   Report the count per arm B pass. If it is more than one or two the floor, not the graph, is
   what is being measured.
6. **`walled` needs a proposal, and with the ontology on a proposal must be typed.** An attempt
   that hits a wall and describes it in a sentence has its proposal dropped at the door and is
   recorded `failed`, not `walled`. Rehearsal assertion 13 pins both halves. So arm B's wall
   count is a count of *typed* discoveries, and the notes on failed attempts
   (`proposed work dropped: kind … is not one of helper, fixture`) are the missing half.
7. **Branch residue between arms.** `ost/<graph>/*` branches from an earlier pass of the same
   graph name make the next provision fail; doctor warns about them. Delete them, or use a
   fresh clone per arm, and say which in the log entry.
8. **Model snapshot drift.** §0, item 3.
9. **The plan window.** An arm run at a different hour meets different throttling; a rate-limited
   attempt is `failed` with `result.limited: true` and the run stops launching
   (`graph.schema.md:356-359`). Report the count per arm. An arm that hit the window did not
   finish and its total is not a total.
10. **Benchmark contamination.** These sphinx issues are from 2020-2021 and are in the training
    data of any current model. Both arms share it, so it does not bias the A-vs-B contrast, but
    it caps what the absolute landing rate means, and it is why T2 is a ratio.
11. **The gate can fail for a reason that is not the fix.** The check applies the held-out test
    patch with `git apply`; an agent that edited anything under `tests/` can break the apply.
    Both boards' `sandbox.notes` tell every cell not to, identically. Countable: check output
    containing `patch does not apply` or `error: while searching for`. Those items are excluded
    from both arms' landed counts and the exclusion is reported.
12. **`defaults.budget` does nothing.** `examples/fix-booking-race.json` and
    `examples/python-etl-backfill.json` carry a `budget` string and nothing in `run.mjs`,
    `sandbox.mjs` or `executors/claude.sh` reads it. Neither Phase 1 board carries one, so
    nobody reads a wall-clock cap that is not enforced. Spend is capped with `--max-usd` and
    `--max-output-tokens` only.
13. **A launch counter is not a budget.** `--max-launches` stops arm B mid-mechanism and its
    total then measures the counter. Cap in dollars and output tokens; `--max-launches` is not
    used on any arm.

---

## 10. What is missing before this can run

Not risks. Things that do not exist yet.

| missing | what it is |
|---|---|
| `~/swebench/sphinx` | a clone of sphinx-doc/sphinx containing `dd1615c5`. Not on any machine this file was written from. |
| the sphinx 3.4 environment | a venv with that commit's `setup.py` dependencies, and `PYTHONPATH=.` at launch. Building it is an operator step. |
| `~/swebench/phase1/checks/*.sh`, `patches/*.patch` | generated by the script in §3, digests frozen in the opening log entry. Not generated. |
| `checks/all.sh` | the A-one gate: the fifteen checks in order, one line per item, exit 0 only if all fifteen do. Not written. |
| the duplicate counter | the `ast`-based script of §6, SHA-256 frozen with the checks. Not written. |
| the admissibility screen | §1. Fifteen `git apply` + two `pytest` runs at the pinned base. Never run; every item in both boards is a candidate until it is. |
| one usage-verification cell | §5, first bullet. One cheap real cell to settle whether the final `result` event's `output_tokens` is the session or the turn. This is the only thing here that spends money, and it must be spent before either arm. |
| a Claude Code credential in the cell environment | doctor's `executor auth` row is green on the machine this was written from, which says nothing about the operator's. |
| the spend cap | §11. |
| E2 and the conflict half of E5 | `wiki/DECISION-PROTOCOL.md` §3 requires a real-agent rehearsal of the conflicted-upstream path and a full dress rehearsal including a conflict. `grep -l conflict bin/rehearse-*` returns nothing on 2026-09-09, so the conflict path is still fake-verified at best and not rehearsed at all by name. It reaches arm B the moment two confirmed shared tasks touch one file, which is what `EVALUATION-VERDICT.md` §4 records costing four of that arm's 22 launches. |

---

## 11. Execution order, so it cannot be done backwards

Copied from `EVALUATION-PROTOCOL.md` §11, which exists because the first experiment's arms were
run in an order that made two of its inputs unusable.

1. This file committed. Nothing under `run.mjs`, `sandbox.mjs` or `executors/` changes in the
   same commit; the two boards and `bin/rehearse-phase1` are the only other files in it.
2. `bash bin/rehearse-phase1` — 14 assertions, and §0's model guard is assertion 2.
3. Pursuit cloned, environment built, checks and patches generated, digests recorded in a log
   entry, that entry committed.
4. The admissibility screen (§1). Substitutions made in **both** boards; rehearsal re-run.
5. The one usage-verification cell (§5).
6. The pilot (§6). **If D-body is 0, stop.**
7. `node doctor.mjs` on every board that will run, plus the `^{commit}` pre-flight of §2.
8. Arms in this order: **A, A-trunk, A-one, then B.** Head-on first, so the head-on numbers
   exist before anyone has watched the graph do anything.
9. One log entry per arm as it lands. Numbers only, no interpretation.
10. The verdict, in a file of its own, written against §7 and §8 and nothing else.

**The spend cap is the operator's and there is no default here.** For scale, from
`EVALUATION-VERDICT.md` §1: eleven Lean tickets head-on cost $56.04 at 433,642 output tokens,
and the graph arm's eleven mappers cost $6.57. Fifteen sphinx items are a different subject and
that is an order of magnitude, not an estimate. Four arms, three replicates, is twelve passes.
Get the cumulative cap before the first launch and report what each pass cost when it lands.
