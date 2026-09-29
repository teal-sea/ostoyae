# Fixture: the last pre-lock engine, verbatim

`prelock-d632f2f/` holds five paths from commit `d632f2f`, byte for byte:
`run.mjs`, `lib/`, `sandbox.mjs`, `viewer/state.mjs`, `executors/fake.sh`.
`bin/rehearse-crash` section 13 stages this tree as the legacy side of the
mixed-version fencing proof.

It is vendored rather than extracted at rehearsal time because a shallow
checkout (including the default `actions/checkout` depth on PR runs) does not
contain `d632f2f`, and the rehearsal must be self-contained there. Where the
commit is present, section 13 diffs this tree against `git archive d632f2f`
of the same paths and fails on any drift — so the fixture cannot silently
stop being the engine it claims to be.

Regenerate (exact command, from the repo root on a full clone):

```sh
rm -rf rehearsals/fixtures/prelock-d632f2f
mkdir -p rehearsals/fixtures/prelock-d632f2f
git archive d632f2f run.mjs lib sandbox.mjs viewer/state.mjs executors/fake.sh \
  | tar -x -C rehearsals/fixtures/prelock-d632f2f
```

Do not hand-edit anything inside `prelock-d632f2f/`. This note lives beside
the directory (not in it) so the drift diff compares exactly the archived
paths. The repo-root `.gitattributes` exempts that tree from whitespace-error
reporting, since the bytes — including two trailing-space comment lines — are
d632f2f's own, not new violations.
