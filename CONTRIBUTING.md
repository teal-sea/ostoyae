# Contributing

Thanks for looking. This is a small engine with strong opinions, and the opinions are written
down, so read this page and `wiki/model.md` before opening a pull request.

## What we accept

- Bug fixes with a rehearsal that fails before the fix and passes after it.
- New executors, following `docs/executors.md`, with `bin/rehearse-executors` extended to
  drive them through the stub.
- Documentation that a stranger would need and did not find.
- Engine changes that keep the three rules below. Open an issue first for anything that
  changes the board format or the scheduling rules; those are design decisions and the
  open ones are listed in `wiki/open.md`.

## The three rules

1. **Zero dependencies.** Node's standard library and `git`. Nothing goes in `package.json`
   under `dependencies`. If something earns an exception, the pull request says why.
2. **The board is data.** Everything the runner needs is in one JSON file a person can read.
   State that only a program can interpret is in the wrong place.
3. **Attempts are append-only.** Nothing in `attempts[]` is ever edited or deleted, including
   the dead ones. A board that hides its failures lies about what happened.

And one rule about words: an attempt that did not do the work and did find structure is
`walled`, not failed. Copy, commit messages and comments that call a wall a failure, or
describe parking as retrying, are wrong and will be sent back.

## Running the tests

Every test uses the fake executor and makes no model calls:

```sh
npm test
```

or run one: `bash bin/rehearse-judge`. Each script prints what it asserted and exits non-zero
on the first failure. `bin/ostoyae demo --no-viewer` is the end-to-end run CI finishes with.

The sandbox and the real executors are tested against real agents when they change. If your
change touches `sandbox.mjs` or an executor, say in the pull request which agent you ran it
with and what it cost, or say that you did not.

## Style

- Plain language in comments and docs. Say what the code does and why, and if it fixed a real
  failure, say when and what it cost. The existing comments are the model.
- No new files nobody will read. If something belongs in the wiki, put it there.
- Every number in a doc traces to a log entry or a source. If you cannot find it, leave it out.

## Pull requests

- One change per pull request.
- The description says what was asked, what you found, what changed, and what you did not do.
- Run `npm test` locally and report its result. The workflow defines the same suite, but GitHub
  Actions is not a release gate while the maintainer's Actions allowance is unavailable. Do not
  dispatch or rerun it for this work; report any validation gaps explicitly.
