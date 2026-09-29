#!/usr/bin/env node
// The cell an attempt runs in. Built before anything is allowed to run in it.
//
// Two halves:
//   provision()  the padded room , an isolated worktree, database and port
//   contract()   the straitjacket, the rules written where the agent will read them
//
// The runner assigns every name in here. An attempt never picks its own branch, database,
// port or migration ordinal, because an attempt cannot see its siblings and the runner can.
// Two workers each reading a log, seeing #8 and taking #9 is a real thing that happened.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/* ------------------------------------------------------------ the room */

export function provision(attempt, cfg, log = () => {}, upstream = []) {
  const repo = resolve(cfg.repo);
  const root = resolve(cfg.root ?? join(repo, '..', 'ostoyae-worktrees'));
  const path = join(root, attempt.sandbox.worktree.replace(/^wt\//, ''));
  const branch = attempt.sandbox.branch;
  const made = { worktree: null, branch: null, db: null };

  mkdirSync(root, { recursive: true });

  // A branch that already exists means this attempt id has been used against this repo
  // before. Say that, rather than letting a raw git error stand in for it.
  let exists = false;
  try { sh('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); exists = true; } catch {}
  if (exists) throw new Error(
    `branch ${branch} already exists in ${repo}. Attempt ids come from the length of ` +
    `attempts[], so this graph has been run before and its attempts were cleared. ` +
    `Attempts are append-only: keep them, or start a graph with a new name.`);

  // Where this attempt starts. A dependency edge has to hand over content, not just
  // ordering: if w-test waits for w-schema, it must start from what w-schema produced.
  // Branching every attempt from the graph base is isolation without handoff, and the
  // downstream agent silently redoes the upstream's work.
  // `cfg.base` is the graph's trunk when the runner passes one, so a cell starts from
  // everything finished so far rather than from a parent alone. Upstreams are merged below
  // whether or not they are already in it; one that is, is a no-op.
  const from = cfg.base ?? 'HEAD';
  sh('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, from]);
  made.worktree = path;
  made.branch = branch;
  log(`worktree ${path} on ${branch} from ${from}`);

  // More than one upstream: merge the rest in. A conflict here used to throw, and the attempt
  // was recorded `failed` before an agent started. The evaluation of 2026-08-30 spent four of
  // `G`'s twenty-two launches that way and killed two tickets every head-on arm landed: two
  // shared tasks had both edited `lakefile.toml`, which is what shared prerequisites do.
  //
  // A conflict between two upstreams is not this attempt's failure. It is the graph saying two
  // confirmed tasks own one file, and the cell is the only place that can be resolved, because
  // the cell is the only place both versions exist. So the merge is left in progress, markers
  // and all, the conflicted paths are named in the contract, and the agent resolves them as its
  // first job. The executor's usual `git add -A && git commit` concludes the merge; the harness
  // still owns git and the agent still never runs it.
  //
  // An agent that cannot resolve it walls, which is the correct outcome and now reachable: the
  // wall names the two tasks that collide, and that is structure the run discovered. Before this
  // the same situation produced an exit code and nothing else.
  made.conflicts = [];
  for (const extra of upstream) {
    try {
      sh('git', ['-C', path, 'merge', '--no-edit', extra]);
      log(`merged ${extra}`);
    } catch {
      // Which paths, from the index rather than from the error text.
      let paths = [];
      try {
        paths = sh('git', ['-C', path, 'diff', '--name-only', '--diff-filter=U'])
          .split('\n').map((x) => x.trim()).filter(Boolean);
      } catch {}
      // The runner's own bookkeeping is never the agent's problem. Every attempt commits its
      // handback (deliberate, so the branch carries what it found), so any two upstreams both
      // carry `.ostoyae/` and every multi-upstream merge conflicts on it. The first real-agent
      // rehearsal of this path found exactly that: the agent was handed a phantom conflict on a
      // file the runner had already deleted from the worktree, and spent turns investigating
      // it. Resolve those by removal here, where they arise; only the project's own paths ever
      // reach the contract.
      const mine = paths.filter((x) => x === '.ostoyae' || x.startsWith('.ostoyae/'));
      if (mine.length) {
        sh('git', ['-C', path, 'rm', '-r', '-f', '-q', '--ignore-unmatch', '--', '.ostoyae']);
        paths = paths.filter((x) => !mine.includes(x));
      }
      // The contract is the runner's too. A pursuit that tracks AGENTS.md sees the injection as
      // a modification, and a cell whose executor committed it (they did, until 2026-09-04)
      // collides with every sibling on that one file. Either side will do: the contract for
      // this cell is written over it below.
      paths = resolveContract(path, paths);
      if (!paths.length) {
        // Nothing of the project's conflicted: conclude the merge and keep going. The commit is
        // the runner's, named as such, and the next upstream merges on top of it.
        sh('git', ['-C', path, '-c', 'user.name=ostoyae', '-c', 'user.email=ostoyae@invalid',
                   'commit', '-q', '--no-edit']);
        log(`merged ${extra}, handback bookkeeping conflicts resolved by removal`);
        continue;
      }
      made.conflicts.push({ branch: extra, paths });
      log(`merging ${extra} conflicted on ${paths.join(', ')}; left for the agent`);
      // A second merge cannot start while one is in progress, and resolving this one is now the
      // attempt's job, so the remaining upstreams are not merged. They are named in the contract
      // so the agent knows what it is not standing on.
      const rest = upstream.slice(upstream.indexOf(extra) + 1);
      if (rest.length) {
        made.conflicts.push({ branch: null, unmerged: rest });
        log(`not merged, blocked behind the conflict: ${rest.join(', ')}`);
      }
      break;
    }
  }

  // Gitignored dependency caches, linked in rather than rebuilt. A cell is a bare worktree, so
  // it arrives with no `.lake`, no `node_modules`, no `.venv`, and for a compiled pursuit that
  // is fatal rather than inconvenient. Mathlib's build is 1.8 GB; an agent cannot produce it,
  // and thirty cells cannot each hold one.
  //
  // The trade is deliberate and is the opposite of the database's: `db` clones because a test
  // writes to it, `link` shares because a dependency cache is read-mostly. **A linked path is
  // NOT isolated.** Name only things every cell reads and none writes, `.lake/packages`, not
  // `.lake`; `node_modules`, not `dist`. Two cells building into one linked directory will
  // corrupt each other, and that is the operator's call to get right.
  const linked = [];
  made.links = linkInto(path, cfg, repo, log, linked);

  const env = {
    OSTOYAE_ATTEMPT: attempt.id,
    OSTOYAE_WORK: attempt.of,
    OSTOYAE_BRANCH: branch,
    OSTOYAE_WORKTREE: path,
    PORT: String(attempt.sandbox.port),
  };
  // Where the links actually point, resolved, for the executor to open up to the agent's tools.
  // A linked path is a symlink out of the worktree, and Claude Code refuses to read outside
  // the directory it was started in unless told otherwise: on 2026-09-03 every lean-eval mapper
  // had `.lake/packages/mathlib` linked in and its Read and Bash tools "refused all access
  // (blocked as outside the worktree)", so the Mathlib evidence in six maps was written from
  // memory and the judge threw out sixteen proposals for it. `claude.sh` turns this into
  // `--add-dir`. Real paths, not the symlinks, because the refusal is decided on the resolved
  // path, and on the Linux box `.lake/packages` is itself a link into a shared Mathlib tree.
  if (linked.length) env.OSTOYAE_LINKED = linked.join(':');

  // What the lab can do that this cell cannot do for itself. A cell is a fresh checkout with an
  // agent in it: it has no idea the operator pays for a Lean prover, a search API, or remote
  // compute, and nothing in its environment tells it. So every one of those went unused while
  // agents wrote Lean by hand and guessed Mathlib names from memory -- Aristotle proved a lemma
  // in seven minutes on 2026-09-03, the transcript is in bin/ask-aristotle, and no cell has ever
  // called it because no cell could see it.
  //
  // Declared per graph rather than built in, because which tools a subject needs is the
  // operator's to say and a new one must not need an engine change:
  //
  //   "tools": [{ "cmd": "bash /abs/bin/ask-aristotle", "what": "one-line description" }]
  //
  // The executor turns each `cmd` into a permission to run exactly that command and the
  // contract prints the descriptions, so an agent is told what it has instead of discovering it.
  const tools = (cfg.tools ?? []).filter((t) => t && typeof t.cmd === 'string');
  if (tools.length) env.OSTOYAE_TOOLS = tools.map((t) => t.cmd).join('\n');

  if (cfg.db) {
    const name = attempt.sandbox.db;
    // Template clone. Sub-second, and it is a real database rather than a shared schema.
    sh('psql', [cfg.db.admin_url, '-v', 'ON_ERROR_STOP=1', '-c',
      `CREATE DATABASE "${name}" TEMPLATE "${cfg.db.template}"`]);
    made.db = name;
    env.DATABASE_URL = cfg.db.url_pattern.replace('{db}', name);
    log(`database ${name} from template ${cfg.db.template}`);
  }

  // The contract is injected per attempt and must not land in the tree. Excluded rather
  // than gitignored, because .gitignore belongs to the project and this does not.
  // `sandbox.contract: "plain"` writes a contract with no handback: the agent is told what is
  // its, told not to run git, and told how to finish, and nothing about walls or reports. It
  // exists for the evaluation protocol's head-on arms, so a plain agent is a plain agent and not
  // an Ostoyae agent with a shorter prompt. `sandbox.notes` is appended to either contract, so
  // one sentence ("you may run lake build here") reaches every arm the same way.
  const text = (cfg.contract === 'plain' ? plainContract(attempt, env, tools) : contract(attempt, env, tools)) +
    linkNotice(cfg.link, made.links.length) +
    conflictNotice(made.conflicts) +
    (cfg.notes ? `\n## From the operator\n\n${cfg.notes}\n` : '');
  // Unlink before writing: a write follows a symlink, and a pursuit whose AGENTS.md is a link
  // (this repo's own AGENTS.md points at .claude/CLAUDE.md) would have the link's target
  // overwritten with the contract and then committed, because the harness excludes the link's
  // name and not the target's path. Observed 2026-09-18: every cell on an engine checkout
  // destroyed .claude/CLAUDE.md. A link pointing outside the repo would be worse: the target
  // would be the operator's own file. Removing the link first leaves a regular ignored file
  // in all three cases (absent, tracked file, symlink), and the exclude below still covers it.
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try { rmSync(join(path, name), { force: true }); } catch {}
    writeFileSync(join(path, name), text);
  }
  const exclude = sh('git', ['-C', path, 'rev-parse', '--git-path', 'info/exclude']);
  const excludePath = exclude.startsWith('/') ? exclude : join(path, exclude);
  mkdirSync(join(excludePath, '..'), { recursive: true });
  // Linked caches go in the exclude too. The project normally gitignores them itself, but a
  // linked path that shows up as untracked invites an agent to `git add` it, and adding a
  // symlink to 1.8 GB of build output to a commit is not a thing anyone wants to review.
  writeFileSync(excludePath, ['AGENTS.md', 'CLAUDE.md', ...(cfg.link ?? [])].join('\n') + '\n');

  return { path, env, made };
}

/* ----------------------------------------------------- the straitjacket */

// What an attempt is told when two of its upstreams disagree. Written only when they do, so a
// clean cell's contract is byte-for-byte what it always was.
//
// The wording is deliberate on one point: it does not say "fix the build". It says two confirmed
// tasks own one file, because that is the fact, and an agent that decides the collision is worse
// than it can resolve should wall on it and name both tasks. That wall is the graph learning
// something it had no other way to learn.
// What a cell is told about the paths it shares. A linked path is the operator's live checkout
// seen through a symlink; on 2026-08-31 an attempt worked out that resolving a new `[[require]]`
// would have written packages into it, for every sibling and for the operator, and said so in
// its wall. Stated here because the only thing between a cell and that write is the agent
// having been told.
export function linkNotice(link = [], linked = 0) {
  if (!link.length) return '';
  return `\n## Shared, read-only\n\n` +
    `These paths are linked from the operator's own checkout, not copied: ${link.map((p) => `\`${p}\``).join(', ')}` +
    `${linked < link.length ? ` (${link.length - linked} not present on this machine, skipped)` : ''}. ` +
    `Every cell reads them and the operator works in them. **Never write into them**: no ` +
    `\`lake update\`, no package resolution, no build that fetches dependencies, nothing that ` +
    `creates files under them. If your task needs a new dependency, say so in your report and stop.\n` +
    `Your Read, Grep and Bash tools are allowed into them, so search them before concluding ` +
    `that something is missing. Your file-writing tools are refused there, by rule: a refusal ` +
    `under one of these paths is the rule working, not an error to work around. If a read ` +
    `refuses, say so in your report; do not fill in from memory what you could not look up.\n`;
}

export function conflictNotice(conflicts = []) {
  const merges = conflicts.filter((c) => c.branch);
  if (!merges.length) return '';
  const blocked = conflicts.find((c) => c.unmerged);
  return `\n## Two of your upstreams collide, and resolving it is your first job\n\n` +
    `You depend on more than one finished task. They were merged into this branch in order and\n` +
    `one of them conflicted, so **you are in the middle of a merge**: the conflicted files below\n` +
    `contain \`<<<<<<<\` markers and nothing will build until they are gone.\n\n` +
    merges.map((c) =>
      `- merging \`${c.branch}\` conflicted on ${c.paths.length ? c.paths.map((p) => `\`${p}\``).join(', ') : 'paths git did not name'}`
    ).join('\n') + `\n\n` +
    (blocked ? `Not merged at all, because a merge was already in progress:\n` +
      `${blocked.unmerged.map((b) => `\`${b}\``).join(', ')}.\n` +
      `Anything those branches were going to give you is not here.\n\n` : '') +
    `Edit the files to a resolved state and remove every marker. Do not run git: the harness\n` +
    `commits, and its commit concludes the merge.\n\n` +
    `This is not a mistake you made. Two tasks the operator confirmed both own one file. If the\n` +
    `right resolution is obvious, take it and get on with your own task. If it is not, and the two\n` +
    `sides want genuinely different things so that picking either loses work, that is a wall. Hand\n` +
    `it back naming both tasks and what each wanted, and stop. A wall here is worth more than a\n` +
    `guess, because it is the only way the graph finds out that those two tasks should never\n` +
    `have been split.\n`;
}



// The plain contract: everything an agent needs to work safely in its cell, and nothing that
// makes it an Ostoyae agent. No report, no wall, no proposals. Written when the graph says
// `sandbox.contract: "plain"`.
export function plainContract(attempt, env, tools = []) {
  return `# You are attempt ${attempt.id}

Injected by the runner. This file is rewritten every time and anything you add to it is
discarded.

You are one agent working on one task: **${attempt.of}**. The task is your prompt.

| | |
|---|---|
| branch | \`${env.OSTOYAE_BRANCH}\`, already checked out |
| worktree | \`${env.OSTOYAE_WORKTREE}\`, you are in it |
| port | \`PORT=${env.PORT}\` |

**Do not create, checkout or switch branches.** **Do not run git at all**: the harness commits
your work for you when you exit. **Stay inside the worktree.** Never read \`.env\` or anything
checked in for credentials.

When you are done, leave your changes in the working tree and stop. Exit zero if the task is
done and you verified it, non-zero if it is not. Do not exit zero to look successful.
` + toolSection(tools);
}

// One section, printed only when the graph declares tools, because a contract that lists nothing
// is a contract an agent learns to skim.
export function toolSection(tools) {
  if (!tools?.length) return '';
  return `

## What the lab can do for you

These are paid for, wired into this cell, and you may run them. Nothing else outside the worktree.

${tools.map((t) => `- \`${t.cmd}\`${t.what ? ` — ${t.what}` : ''}`).join('\n')}

Reach for them before writing something by hand that one of them already does. What they return
is a lead to check, never a certificate: port it into this worktree and let the build decide.

**If one of them is still working when you finish, put its job id in your report's \`ahead\`.**
A job you submitted outlives you: your cell is destroyed at settle and nobody else knows the id,
so the answer is paid for and lost. On 2026-09-04 an Aristotle job came back with a complete
proof twenty minutes after the attempt that asked for it had exited, having proved the same lemma
by hand. An id in \`ahead\` is on the record and the next attempt can collect it.`;
}

export function contract(attempt, env, tools = []) {
  return `# You are attempt ${attempt.id}

Injected by the runner. This file is the contract, not a suggestion. It is rewritten every
time and anything you add to it is discarded.

## What you are

One attempt at one piece of work: **${attempt.of}**. Other attempts at the same work are
running right now in their own cells. You cannot see them and they cannot see you.

## What is yours

| | |
|---|---|
| branch | \`${env.OSTOYAE_BRANCH}\`, already checked out |
| worktree | \`${env.OSTOYAE_WORKTREE}\`, you are in it |
| database | ${env.DATABASE_URL ? `\`DATABASE_URL\` in your environment` : 'none for this run'} |
| port | \`PORT=${env.PORT}\` |

## The rules

**Do not create, checkout or switch branches.** You are on yours. A second branch is a second
attempt, and only the runner makes those.

**Use \`DATABASE_URL\` from your environment. Never read it from \`.env\`, a config file, or
anything checked in.** Whatever is in those points at a database somebody else is using.

**Never drop, reset, truncate or recreate a database.** If a migration conflicts, stop and
fail. Resetting the database is the single most destructive thing you can do here and it is
never the fix.

**Never pick a number, name or identifier that another attempt could also pick.** Migration
ordinals, ports, branch names, case numbers. If you need one, fail and say so. The runner
assigns anything unique because it can see every attempt at once and you cannot.

**Bind to \`PORT\`.** Nothing else is yours.

**Stay inside the worktree.** Do not read or write outside \`${env.OSTOYAE_WORKTREE}\`${tools.length ? ', with the tools below as the one exception' : ''}.

**Do not run git at all.** No commit, no add, no branch, no push, no pull request. The
harness owns git and commits your work for you when you exit. Asking for permission to
commit wastes the attempt.

## How you finish

Two things, and the second one is the part nobody tells you.

Leave your changes in the working tree and stop. Exit zero if the work is done, non-zero if
it is not. A non-zero exit is a normal outcome, it becomes a failed attempt in the record and
the record keeps why. Do not exit zero to look successful, and do not report success for work
you could not verify.

**Then write \`.ostoyae/report.json\` inside your worktree, before you exit.** It is the only
thing you say that outlives this cell. The runner reads it while the worktree still stands and
then destroys everything else. Write it whether you succeeded or not.

\`\`\`json
{
  "map": {
    "settles": "what a finished result would be",
    "cost": "small | medium | large | unknown",
    "notes": "anything the attempt that does the work should know"
  },
  "wall": "what stopped you, in your own words",
  "ahead": "what the next attempt will hit, when nothing stopped you",
  "answer": true,
  "work": [ { "id": "w-short-slug", "what": "what this is, carrying any text it must copy verbatim" } ],
  "edges": [ { "from": "w-a", "to": "w-b", "why": "why a has to land first" } ]
}
\`\`\`

Every key is optional and an empty object is a fine report. Write only what you actually
hit. **Write it as you go, not only at the end**: the moment you know a wall, a missing piece
or an edge, write the file with what you have so far and keep adding to it. The runner reads it
while you work and shows the operator each edge as it appears; the version on disk when you
exit is the one that counts.

**\`wall\`**, the thing that stopped you, if something did. Not "it failed": the specific
missing piece. *"There is no idempotency column to guard the confirm path on"* is a wall.

**\`ahead\`**, something the next attempt will hit that did **not** stop you. If you finished
your own job, every warning you have goes here and none of it goes in \`wall\`. The two are not
interchangeable: \`wall\` is read as "this attempt did not do its work", so a finished job that
writes one is recorded as not done and everything waiting on it stops. "Nothing stopped me, but
the next step needs X" is \`ahead\`, plus the X itself in \`work\`.

**\`answer\`**, only when your instructions ask you to **settle** a statement rather than prove
it: \`true\` if you proved it, \`false\` if you proved its negation. A refutation is finished
work. Leave \`wall\` empty, commit the counterexample the way you would commit a proof, and let
the check confirm it. An \`answer\` beside a \`wall\` is recorded and not applied, because an
attempt that did not finish settled nothing. Anything but \`true\` or \`false\` is not an answer.

**\`work\`**, work you discovered somebody has to do and that is not in the graph yet. Invent
a short \`id\` for each. \`what\` is usually one line, but it is the **only** thing the cell that
runs it will ever see, and that cell does not inherit your prompt. So when the job is to copy a
statement, a definition or any text verbatim, put that text into \`what\` in full, however long
it runs. A task that says "exactly as given above" or "as given in this work item" is broken on
arrival, because for whoever receives it there is no above and no this.

**\`edges\`**, \`from\` blocks \`to\`: \`from\` has to land before \`to\` can be attempted. Both
ends must name either work already in the graph or work you proposed in \`work\` above.

**\`map\`**, only when your instructions say to map rather than to do the work. \`settles\` is
what a finished result would be, in one or two sentences. \`cost\` is one of \`small\`,
\`medium\`, \`large\`, \`unknown\`. \`notes\` is anything the attempt that does the work should
know. Put what this depends on in \`work\` and \`edges\` above, and what it would unlock in
\`edges\` as well; the other items in this graph are listed in \`.ostoyae/work.json\` beside this
file. A map attempt changes nothing but this report. A map without \`settles\` is recorded as a
failed attempt.

**Why it is worth the two minutes.** An attempt that fails and says nothing is a wasted launch.
An attempt that fails, names its wall, and proposes the work that would clear it is recorded as
\`walled\` rather than \`failed\`, it did not do its job, and it did not waste the launch
either. Attempts that can fail are only worth running because of this file. None of which is a
reason to claim a wall you did not hit: if you finished, leave \`wall\` empty and put what you
found in \`ahead\` and \`work\`. That is worth exactly as much and keeps your work.

Nothing you write here is authority. The runner assigns the real ids, drops anything malformed
with a note, and lands all of it as a proposal for a human to confirm. So report honestly and
do not invent structure to look productive: a fabricated edge costs more than a blank report.
` + toolSection(tools);
}

// The link loop, shared by a cell and by the tree a check runs in. `targets`, when given,
// collects where each link resolves to, for the cell to hand its executor.
function linkInto(path, cfg, repo, log, targets = null) {
  const links = [];
  for (const rel of cfg.link ?? []) {
    const target = join(repo, rel);
    if (!existsSync(target)) { log(`link ${rel} skipped, not present in ${repo}`); continue; }
    const at = join(path, rel);
    mkdirSync(join(at, '..'), { recursive: true });
    rmSync(at, { recursive: true, force: true });
    symlinkSync(target, at);
    links.push(at);
    // Deduplicated: on the lean-eval board 86 links resolve to one shared Mathlib, and before
    // this each cell got 86 identical --add-dir arguments and 344 deny rules for 4.
    const real = realpathSync(target);
    if (targets && !targets.includes(real)) targets.push(real);
    log(`linked ${rel} -> ${target}`);
  }
  return links;
}

/* ------------------------------------------------------------ the bench */

// Where a check runs: a fresh checkout of what the attempt COMMITTED, never the cell it worked
// in. The cell holds whatever the agent left behind, uncommitted edits, ignored build artifacts,
// a `.lake/build` warmed by a build of some earlier version of the file, and a check run there
// judges that, not the branch. The branch is the record and the only thing the next attempt
// will ever stand on, so the branch is what gets judged. Detached, so nothing here can move the
// branch; the shared caches are linked in exactly as for a cell; removed when the check is done.
export function checkTree(cfg, graph, attempt, log = () => {}) {
  const repo = resolve(cfg.repo);
  const root = resolve(cfg.root ?? join(repo, '..', 'ostoyae-worktrees'));
  const path = join(root, graph, '_check', attempt.id);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, '..'), { recursive: true });
  sh('git', ['-C', repo, 'worktree', 'add', '--detach', path, attempt.sandbox.branch]);
  log(`check tree ${path} at ${attempt.sandbox.branch}`);
  const links = linkInto(path, cfg, repo, log);
  return {
    path,
    remove: () => teardown({ worktree: path, links, db: null }, cfg, log),
  };
}

/* ------------------------------------------------------------- teardown */

export function teardown(made, cfg, log = () => {}) {
  // Unlink the shared caches FIRST, before anything is allowed to delete this directory. The
  // links point at the pursuit repo's real `.lake` and `node_modules`; a teardown that removed
  // the tree while they were still in it would be one buggy `rm -r` away from deleting the
  // thing every other cell is reading. Unlink, verify it was a link and not a directory, then
  // tear down.
  for (const at of made.links ?? []) {
    try {
      if (!existsSync(at) && !lstatSync(at, { throwIfNoEntry: false })) continue;
      const st = lstatSync(at);
      if (!st.isSymbolicLink()) { log(`link ${at} is not a symlink, left alone`); continue; }
      unlinkSync(at);
      log(`unlinked ${at}`);
    } catch (e) { log(`unlink ${at} failed: ${e.message}`); }
  }

  // Environments are disposable. Records are not. The branch survives so a failed attempt's
  // work can still be read; the worktree and the database do not.
  if (made.worktree && existsSync(made.worktree)) {
    try {
      sh('git', ['-C', resolve(cfg.repo), 'worktree', 'remove', '--force', made.worktree]);
      log(`removed worktree ${made.worktree}`);
    } catch {
      rmSync(made.worktree, { recursive: true, force: true });
      sh('git', ['-C', resolve(cfg.repo), 'worktree', 'prune']);
      log(`force-removed worktree ${made.worktree}`);
    }
  }
  if (made.db && cfg.db) {
    sh('psql', [cfg.db.admin_url, '-c', `DROP DATABASE IF EXISTS "${made.db}"`]);
    log(`dropped database ${made.db}`);
  }
}

/* --------------------------------------------------------- accumulation */

// The trunk: one branch per graph, where finished attempts accumulate.
//
// `wiki/model.md` names both halves as this repo's job, "Gating and accumulation are this
// repo's job. Fulcrum runs one node.", and only the first was ever built. What the missing
// half costs showed up on erdos-zeta-plain on 2026-09-01: five lemmas were proved sorry-free
// across three attempts, and each one lived in its own copy of lean/Erdos/359.lean. A
// dependency edge hands content down a chain, so a child stands on its parent. Siblings have
// no edge between them, by definition, so nothing ever brought the three together and no
// branch held all five results.
//
// The trunk is not `main` and never becomes it. Landing is the operator's call; this only
// stops finished work from being stranded on branches that never meet.
export const trunkOf = (graph) => `ost/${graph}/trunk`;

// The trunk gets a worktree of its own rather than being merged headless. `git merge-tree`
// could do it without one, but the conflict handling below is the same code already proven
// against real agents in provision(), and one mechanism that works beats two that nearly do.
export function trunkPath(cfg, graph) {
  const repo = resolve(cfg.repo);
  const root = resolve(cfg.root ?? join(repo, '..', 'ostoyae-worktrees'));
  return join(root, graph, '_trunk');
}

export function ensureTrunk(cfg, graph, log = () => {}) {
  const repo = resolve(cfg.repo);
  const trunk = trunkOf(graph);
  const path = trunkPath(cfg, graph);
  let had = false;
  try { sh('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + trunk]); had = true; } catch {}
  if (!had) {
    sh('git', ['-C', repo, 'branch', trunk, cfg.base ?? 'HEAD']);
    log(`trunk ${trunk} started from ${cfg.base ?? 'HEAD'}`);
  }
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(join(path, '..'), { recursive: true });
    sh('git', ['-C', repo, 'worktree', 'add', path, trunk]);
    log(`trunk worktree ${path}`);
  }
  // Linked like a cell, every time, because a bare worktree of a compiled pursuit is a trap: the
  // first `lake build` anyone runs in it fetches a whole Mathlib per workspace instead of finding
  // the shared one. 7.5 GB into one workspace on 2026-09-04 at 01:23, then 7.5 GB and 1.9 GB more
  // into two others that night from the operator's own builds, until the disk hit zero and a
  // commit failed. Idempotent, and it replaces a real directory at a link path with the link,
  // because `cfg.link` is the pursuit saying those paths are links; the log says so when it does.
  for (const rel of cfg.link ?? []) {
    const at = join(path, rel);
    try { if (existsSync(at) && !lstatSync(at).isSymbolicLink()) log(`trunk ${rel} was a real directory, replaced by the link`); } catch {}
  }
  linkInto(path, cfg, repo, (m) => { if (!m.startsWith('linked ')) log(`trunk ${m}`); });
  return trunk;
}

// Merge one finished attempt into the trunk. Returns what happened rather than throwing,
// because a conflict between two attempts is not an error in either of them: it is the graph
// saying two finished jobs own one file, and that is a finding the operator has to see.
// AGENTS.md and CLAUDE.md in a conflict list are the harness's injected contract, never the
// project's content, so a merge is not two jobs owning one file. Keep the side we are on and
// drop them from the list; what remains is a real conflict.
const CONTRACT_FILES = ['AGENTS.md', 'CLAUDE.md'];
function resolveContract(path, paths) {
  const mine = paths.filter((x) => CONTRACT_FILES.includes(x));
  if (!mine.length) return paths;
  try { sh('git', ['-C', path, 'checkout', '--ours', '--', ...mine]); } catch {}
  try { sh('git', ['-C', path, 'add', '--', ...mine]); } catch {}
  return paths.filter((x) => !mine.includes(x));
}

export function integrate(cfg, graph, branch, log = () => {}) {
  const path = trunkPath(cfg, graph);
  try {
    const out = sh('git', ['-C', path, 'merge', '--no-edit', branch]);
    const already = /Already up to date/i.test(out);
    if (!already) log(`trunk merged ${branch}`);
    return { ok: true, already };
  } catch {
    let paths = [];
    try {
      paths = sh('git', ['-C', path, 'diff', '--name-only', '--diff-filter=U'])
        .split('\n').map((x) => x.trim()).filter(Boolean);
    } catch {}
    // The handback is the runner's bookkeeping and every attempt commits one, so every second
    // merge collides on `.ostoyae/`. That is not two jobs owning one file; the record already
    // lives in the graph. Resolved by removal here, exactly as provision() does it.
    const mine = paths.filter((x) => x === '.ostoyae' || x.startsWith('.ostoyae/'));
    if (mine.length) {
      try { sh('git', ['-C', path, 'rm', '-r', '-f', '-q', '--ignore-unmatch', '--', '.ostoyae']); } catch {}
      paths = paths.filter((x) => !mine.includes(x));
    }
    // And the injected contract, when a cell committed it: the trunk keeps its own. See
    // provision() for the same rule on the way in.
    paths = resolveContract(path, paths);
    if (!paths.length) {
      sh('git', ['-C', path, '-c', 'user.name=ostoyae', '-c', 'user.email=ostoyae@invalid',
                 'commit', '-q', '--no-edit']);
      log(`trunk merged ${branch}, handback bookkeeping resolved by removal`);
      return { ok: true, already: false };
    }
    try { sh('git', ['-C', path, 'merge', '--abort']); } catch {}
    log(`trunk merge of ${branch} conflicted on ${paths.join(', ')}; trunk left untouched`);
    return { ok: false, paths };
  }
}
