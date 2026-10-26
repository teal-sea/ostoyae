#!/usr/bin/env node
// Maintenance E2E acceptance: a no-model, rerunnable, end-to-end rehearsal of the
// discovered-shared-work mechanism on the REAL engine with REAL git branches and
// REAL checks. The only fake part is the executor (executors/fake.sh): zero model calls.
//
//   node rehearsals/maintenance-e2e.mjs [--engine <path>] [--logs <dir>] [--work <dir>]
//   OSTOYAE_ENGINE_ROOT=/path/to/integration-checkout node rehearsals/maintenance-e2e.mjs
//
// What it accepts, in order:
//   A. Discovery and parking: two consumer jobs walk into the same missing shared
//      prerequisite, wall, and park. Proposals stay inert: nothing runs on the shared
//      item before the operator answers, and a rerun launches nothing new.
//   B. Authorized admission: an explicit --confirm admits exactly one shared item and
//      both consumer edges. The shared prerequisite is built ONCE; both consumers'
//      fresh-tree checks demand its committed artifact and pass on inherited content.
//      The integrated result lands on the base via `ostoyae land` (real fast-forward).
//   C. Negative — failed acceptance command: an executor that exits zero but whose
//      engine-run check refuses is recorded `failed`, never merges to the trunk, and
//      there is nothing to land.
//   D. Negative — duplicate discovery after admission: a third consumer names the same
//      prerequisite; the engine does not build it twice, the duplicate joins as a
//      finder note, the new edge still parks its source until explicitly confirmed.
//
// Design rules: no engine edits, expectations are the product's own (report a failure,
// never weaken it), every invocation and exit code goes to <logs>/invocations.log.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, makePursuit, readBoard, consumerWork } from './maintenance-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Engine root: --engine argument, else OSTOYAE_ENGINE_ROOT, else this checkout's root.
// Nothing is copied: the rehearsal always runs the engine it was pointed at.
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const ENGINE = resolve(opt('--engine', process.env.OSTOYAE_ENGINE_ROOT || resolve(HERE, '..')));
if (!existsSync(join(ENGINE, 'run.mjs')) || !existsSync(join(ENGINE, 'executors', 'fake.sh'))) {
  console.error(`maintenance-e2e: ${ENGINE} is not an Ostoyae engine root (no run.mjs / executors/fake.sh).`);
  process.exit(2);
}
const FIXTURES = join(HERE, 'fixtures', 'maintenance');
if (!existsSync(join(FIXTURES, 'maintenance-check-consumer.sh'))) {
  console.error(`maintenance-e2e: fixtures missing at ${FIXTURES} — it must sit beside the rehearsal, not the engine.`);
  process.exit(2);
}
const WORK = resolve(opt('--work', mkdtempSync(join(process.env.OSTOYAE_SCRATCH || tmpdir(), 'maintenance-e2e-'))));
const LOGS = resolve(opt('--logs', join(WORK, 'logs')));
mkdirSync(LOGS, { recursive: true });
const FAKE = `bash ${join(ENGINE, 'executors', 'fake.sh')}`;

// --------------------------------------------------------------- assert harness
let ran = 0, failed = 0;
const logLines = [];
function assert(label, fn) {
  ran++;
  try {
    fn();
    logLines.push(`  ok    ${label}`);
    console.log(`  ok    ${label}`);
  } catch (e) {
    failed++;
    logLines.push(`  FAIL  ${label}\n        ${String(e.message).split('\n').slice(0, 4).join('\n        ')}`);
    console.log(`  FAIL  ${label}`);
    console.log(`        ${String(e.message).split('\n').slice(0, 4).join('\n        ')}`);
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function snapshot(engine, label, boardFile) {
  writeFileSync(join(LOGS, `board-${label}.json`), readFileSync(boardFile));
}

// --------------------------------------------------------------------- scenario
const engine = new Engine({ root: ENGINE, logdir: LOGS });
engine.env = { ...engine.env, OSTOYAE_STATE_DIR: join(WORK, 'state') };

const pursuit = join(WORK, 'pursuit');
makePursuit(pursuit, engine);
const boardFile = join(pursuit, 'ostoyae.json');

function baseBoard(graph) {
  return {
    graph,
    concurrency: 3,
    max_attempts: 2,
    // judge.verify is deliberately absent: verdicts are evidence, not decisions, and this
    // scenario tests the operator path. `default_check` still gives the proposed shared
    // item a real gate — the runner's word against the agent's.
    judge: { default_check: `bash ${join(FIXTURES, 'maintenance-check-shared.sh')} {id}.txt` },
    sandbox: { repo: pursuit, root: join(WORK, 'wt'), base: 'main', port_base: 'auto' },
    work: [], edges: [], attempts: [],
  };
}

function go(label, extraArgs = []) {
  return engine.run(label, 'run.mjs', [boardFile, '--exec', FAKE, '--no-messaging', ...extraArgs]);
}

// ---- A: two consumers walk into the same missing shared helper.
{
  const g = baseBoard('maintenance-e2e');
  g.work = [consumerWork('w-alpha', FIXTURES), consumerWork('w-beta', FIXTURES)];
  writeFileSync(boardFile, JSON.stringify(g, null, 2));

  const rd = engine.run('A0.doctor', 'doctor.mjs', [boardFile, '--exec', FAKE, '--json']);
  assert('A0a. doctor accepts the board before anything runs (no launch without readiness)', () => {
    eq(rd.exit, 0, `doctor exit\n${rd.stdout.slice(0, 1500)}`);
  });

  const r1 = go('A.run1-discovery', ['--max-launches', '8']);
  assert('A0. run1 exits 0', () => eq(r1.exit, 0, `run1 exit\n${r1.stdout.slice(-800)}${r1.stderr.slice(-400)}`));

  let b = readBoard(boardFile);
  const shared = b.work.filter((w) => w.id === 'w-shared');
  assert('A1. one shared prerequisite item exists, status proposed', () => {
    eq(shared.length, 1, 'w-shared count');
    eq(shared[0].status, 'proposed', 'w-shared status');
  });
  assert('A2. both consumers walled, each finding the same helper (one item, two finders)', () => {
    const ws = b.work.find((w) => w.id === 'w-shared');
    eq(ws.found_by.length, 2, 'w-shared found_by length');
    const walls = b.attempts.filter((a) => a.state === 'walled');
    eq(walls.length, 2, 'walled attempts');
    eq(walls.map((a) => a.of).sort().join(','), 'w-alpha,w-beta', 'walled items');
    ok(walls.every((a) => a.result?.wall && a.result.wall.includes('row-parsing helper')), 'wall text on record');
  });
  assert('A3. two proposed edges (shared blocks each consumer), nothing confirmed', () => {
    const edges = b.edges;
    eq(edges.length, 2, 'edge count');
    ok(edges.every((e) => e.status === 'proposed'), 'edges proposed');
    ok(edges.every((e) => e.from === 'w-shared'), 'edges from shared');
  });
  assert('A4. proposals are inert: the shared item never ran, and both consumers are parked', () => {
    eq(b.attempts.filter((a) => a.of === 'w-shared').length, 0, 'attempts on w-shared');
    eq(b.last_run.drained, 'awaiting-decision', 'drain state');
    ok(/2 item\(s\) parked/.test(b.last_run.why), `parked count in why: ${b.last_run.why}`);
  });
  snapshot(engine, 'A-after-discovery', boardFile);

  // ---- B-negative: unconfirmed prerequisite. Re-running without a decision buys nothing.
  const attemptsBefore = b.attempts.length;
  const r2 = go('B.run2-no-decision', ['--max-launches', '8']);
  assert('B0. rerun with the decision unanswered exits 0', () => eq(r2.exit, 0, `rerun exit\n${r2.stdout.slice(-800)}`));
  b = readBoard(boardFile);
  assert('B1. an unconfirmed prerequisite launches nothing new', () => {
    eq(b.attempts.length, attemptsBefore, 'attempt count unchanged after rerun');
    eq(b.last_run.launched, 0, 'launched in rerun');
    eq(b.last_run.drained, 'awaiting-decision', 'drain again awaiting-decision');
  });

  // ---- The authorized decision: one explicit confirmation admits the shared prerequisite.
  // Edge ids are taken from the board, never hardcoded: which consumer settles first decides
  // which edge is e-0001, and the rehearsal must not assume scheduling order.
  const proposalIds = ['w-shared', ...b.edges.filter((e) => e.status === 'proposed').map((e) => e.id)];
  const rc = engine.run('C.confirm', 'run.mjs', [boardFile, '--confirm', proposalIds.join(',')]);
  assert('C0. --confirm exits 0', () => eq(rc.exit, 0, `confirm exit\n${rc.stdout}${rc.stderr}`));
  b = readBoard(boardFile);
  assert('C1. confirmation is explicit: the item is active, both edges confirmed', () => {
    eq(b.work.find((w) => w.id === 'w-shared').status, 'active', 'w-shared status');
    ok(b.edges.every((e) => e.status === 'confirmed' && e.decided_at), 'edges confirmed with decision dates');
  });
  snapshot(engine, 'C-after-confirm', boardFile);

  // ---- Build the shared prerequisite once; both consumers inherit and pass fresh-tree checks.
  const r3 = go('D.run3-build-and-consume', ['--max-launches', '8']);
  assert('D0. run3 exits 0', () => eq(r3.exit, 0, `run3 exit\n${r3.stdout.slice(-1200)}${r3.stderr.slice(-400)}`));
  b = readBoard(boardFile);
  const sharedAttempts = b.attempts.filter((a) => a.of === 'w-shared');
  assert('D1. the shared prerequisite is built exactly once and its check passed on a fresh tree', () => {
    eq(sharedAttempts.length, 1, 'attempts on w-shared');
    eq(sharedAttempts[0].state, 'done', 'shared state');
    eq(sharedAttempts[0].result?.check?.ok, true, 'shared check ok');
    eq(sharedAttempts[0].result?.integrated, 'ost/maintenance-e2e/trunk', 'shared integrated');
  });
  assert('D2. both consumers succeed on their second attempt, checks pass on their branches', () => {
    for (const id of ['w-alpha', 'w-beta']) {
      const as = b.attempts.filter((a) => a.of === id);
      eq(as.length, 2, `${id} attempts`);
      eq(as[0].state, 'walled', `${id} attempt 1 walled`);
      eq(as[1].state, 'done', `${id} attempt 2 done`);
      eq(as[1].result?.check?.ok, true, `${id} check ok`);
      eq(as[1].result?.check?.on, as[1].sandbox.branch, `${id} check ran on its branch`);
      eq(as[1].result?.integrated, 'ost/maintenance-e2e/trunk', `${id} integrated`);
    }
  });
  // Consumers inherited the shared artifact through their own checks: verify it directly on
  // each consumer's branch rather than trusting the runner's chatter — the file is present
  // and its creating commit is the shared job's, not the consumer's. (The engine runs each
  // check on a fresh checkout of the branch and only prints `check passed`; the content proof
  // belongs on the branch itself.)
  assert('D3. consumers inherited the shared artifact: present on each branch, created by the shared job only', () => {
    for (const id of ['w-alpha', 'w-beta']) {
      const a = b.attempts.filter((x) => x.of === id && x.state === 'done')[0];
      const branch = a.sandbox.branch;
      const files = engine.raw(`D3.tree-${id}`, 'git', ['-C', pursuit, 'ls-tree', '-r', '--name-only', branch]);
      eq(files.status, 0, `ls-tree ${branch}`);
      const list = files.stdout.trim().split('\n');
      ok(list.includes('w-shared.txt'), `w-shared.txt inherited on ${branch}: ${list}`);
      ok(list.includes(`${id}.txt`), `${id}.txt own artifact on ${branch}: ${list}`);
      const touch = engine.raw(`D3.commits-${id}`, 'git', ['-C', pursuit, 'log', '--format=%s', branch, '--', 'w-shared.txt']);
      eq(touch.status, 0, `log ${branch}`);
      const subjects = touch.stdout.trim().split('\n');
      eq(subjects.length, 1, `commits touching w-shared.txt on ${branch}: ${subjects}`);
      eq(subjects[0], 'fake: w-shared', `w-shared.txt authorship on ${branch}`);
    }
    ok(/check\s+passed.*maintenance-check-consumer\.sh w-alpha/.test(r3.stdout), 'alpha check passed on fresh tree');
    ok(/check\s+passed.*maintenance-check-consumer\.sh w-beta/.test(r3.stdout), 'beta check passed on fresh tree');
  });
  assert('D4. the board drains satisfied', () => {
    eq(b.last_run.drained, 'board-satisfied', 'drain state');
  });
  snapshot(engine, 'D-after-build', boardFile);

  // ---- Landing, item path first (before the trunk fast-forward): `land w-beta` rebuilds
  // the consumer's recorded commits, WITH its dependency commits, on a fresh branch from the
  // base, and re-runs its check there. That is the engine itself proving the integrated
  // result — shared code included — can be taken.
  // NOTE (product finding, see report): landItem cherry-picks, which creates NEW commits and
  // therefore needs an operator git identity in the environment. The engine sets identity env
  // for cells and trunk merges, but not for the item-land cherry-pick, and an identity failure
  // surfaces as "does not apply cleanly on main" — a misleading wrapper around git's raw
  // "unable to auto-detect email address". We supply the identity the way a real operator's
  // machine would have it configured.
  const identityEnv = { GIT_AUTHOR_NAME: 'operator', GIT_AUTHOR_EMAIL: 'operator@invalid',
    GIT_COMMITTER_NAME: 'operator', GIT_COMMITTER_EMAIL: 'operator@invalid' };
  const rli = engine.run('E0i.land-item', 'cli.mjs', ['land', 'w-beta', '--board', 'ostoyae.json', '--json'], { cwd: pursuit, env: identityEnv });
  assert('E0i. ostoyae land <consumer> builds a checked branch including the shared dependency', () => {
    eq(rli.exit, 0, `land-item exit\n${rli.stdout.slice(0, 900)}${rli.stderr.slice(0, 400)}`);
    const d = JSON.parse(rli.stdout);
    eq(d.ok, true, `land-item ok: ${rli.stdout.slice(0, 500)}`);
    eq(d.branch, 'ostoyae/w-beta', 'PR branch name');
    ok((d.dependencies ?? []).includes('w-shared'), `dependency w-shared included: ${JSON.stringify(d.dependencies)}`);
    ok((d.messages ?? []).some((m) => /Check passed on a fresh worktree/.test(m)), `fresh-tree check recorded: ${JSON.stringify(d.messages)}`);
  });
  const prFiles = engine.raw('E0i.pr-tree', 'git', ['-C', pursuit, 'ls-tree', '-r', '--name-only', 'ostoyae/w-beta']);
  assert('E0ii. the item branch carries its own artifact AND the inherited shared artifact', () => {
    eq(prFiles.status, 0, 'ls-tree exit');
    const list = prFiles.stdout.trim().split('\n');
    ok(list.includes('w-beta.txt'), `w-beta.txt on PR branch: ${list}`);
    ok(list.includes('w-shared.txt'), `w-shared.txt on PR branch: ${list}`);
    ok(!list.includes('w-alpha.txt'), `sibling w-alpha.txt stays off this item's branch: ${list}`);
  });

  // ---- Landing: the integrated result goes to the base through the real `land` path.
  const rl = engine.run('E.land', 'cli.mjs', ['land', 'ostoyae.json', '--json'], { cwd: pursuit });
  assert('E0. ostoyae land fast-forwards the base (exit 0, ok:true, messages record the move)', () => {
    eq(rl.exit, 0, `land exit\n${rl.stdout.slice(0, 800)}${rl.stderr.slice(0, 800)}`);
    const d = JSON.parse(rl.stdout);
    eq(d.ok, true, `land ok: ${rl.stdout.slice(0, 400)}`);
    eq(d.base, 'main', 'land base');
    ok((d.messages ?? []).some((m) => /fast-forward/.test(m)), `fast-forward message: ${JSON.stringify(d.messages)}`);
  });
  const show = engine.raw('E.tree', 'git', ['-C', pursuit, 'ls-tree', '-r', '--name-only', 'main']);
  assert('E1. main now carries every artifact: one shared file, two consumers', () => {
    eq(show.status, 0, 'ls-tree exit');
    const files = show.stdout.trim().split('\n').sort();
    ok(files.includes('w-shared.txt'), `w-shared.txt on main: ${files}`);
    ok(files.includes('w-alpha.txt'), `w-alpha.txt on main: ${files}`);
    ok(files.includes('w-beta.txt'), `w-beta.txt on main: ${files}`);
  });
  const hist = engine.raw('E.history', 'git', ['-C', pursuit, 'log', '--format=%s', 'main']);
  assert('E2. the shared file has exactly one creating commit on the landed history', () => {
    eq(hist.status, 0, 'log exit');
    const subjects = hist.stdout.trim().split('\n');
    eq(subjects.filter((s) => s === 'fake: w-shared').length, 1, `shared commit count in ${subjects}`);
  });
}

// ---- C-negative: a failed acceptance command never merges and never lands.
// Runs on its own pursuit + board so the main board stays intact for the duplicate case.
{
  const pursuit2 = join(WORK, 'pursuit-fail');
  makePursuit(pursuit2, engine);
  const board2 = join(pursuit2, 'ostoyae.json');
  const g = baseBoard('maintenance-e2e-refuse');
  g.sandbox.repo = pursuit2;
  g.max_attempts = 1;
  g.work = [{
    id: 'w-lucky', what: 'claim done while the demanded artifact is not on the branch',
    check: `bash ${join(FIXTURES, 'maintenance-check-always-fail.sh')}`,
    params: { fake: { prove: 'done' } },
  }];
  writeFileSync(board2, JSON.stringify(g, null, 2));
  const r = engine.run('F.refused-check', 'run.mjs', [board2, '--exec', FAKE, '--no-messaging', '--max-launches', '2']);
  const b = readBoard(board2);
  const a = b.attempts.find((x) => x.of === 'w-lucky');
  assert('F0. an executor that exits zero is failed when the engine check refuses', () => {
    eq(r.exit, 0, `run exit (the run itself is fine): ${r.stdout.slice(-600)}`);
    eq(a.state, 'failed', 'attempt state');
    eq(a.result?.check?.ok, false, 'check recorded as failed');
    ok(/check failed \(exit 1\)/.test(a.result?.why ?? ''), `why says check failed: ${a.result?.why}`);
  });
  assert('F1. the refused work never merges to the trunk and nothing is offered to land', () => {
    ok(!a.result?.integrated, 'no integrated field');
    const trunk = engine.raw('F.trunk', 'git', ['-C', pursuit2, 'rev-parse', '--verify', '--quiet', 'refs/heads/ost/maintenance-e2e-refuse/trunk']);
    if (trunk.status === 0) {
      const files = engine.raw('F.trunk-files', 'git', ['-C', pursuit2, 'ls-tree', '-r', '--name-only', 'ost/maintenance-e2e-refuse/trunk']);
      ok(!files.stdout.includes('w-lucky.txt'), `refused artifact must not be on the trunk: ${files.stdout}`);
    }
    const rl = engine.run('F.land', 'cli.mjs', ['land', 'ostoyae.json', '--json'], { cwd: pursuit2 });
    eq(rl.exit, 0, 'land with nothing to land exits 0');
    ok(/Nothing to land/.test(rl.stdout + rl.stderr), `land says nothing to land: ${rl.stdout.slice(0, 300)}`);
    const main = engine.raw('F.main', 'git', ['-C', pursuit2, 'ls-tree', '-r', '--name-only', 'main']);
    ok(!main.stdout.includes('w-lucky.txt'), 'the refused artifact never reached the base');
  });
  assert('F2. the board reports exhaustion, not satisfaction', () => {
    eq(b.last_run.drained, 'exhausted', 'drain state');
  });
  snapshot(engine, 'F-refused', board2);
}

// ---- D-negative: duplicate discovery after the prerequisite was admitted and built.
{
  let b = readBoard(boardFile);
  eq(b.work.filter((w) => w.id === 'w-shared')[0].status, 'active', 'precondition: w-shared active');
  const sharedAttemptsBefore = b.attempts.filter((a) => a.of === 'w-shared').length;
  // A third consumer arrives, authored active, and walks into the same helper by handback.
  b.work.push(consumerWork('w-gamma', FIXTURES));
  b.work.find((w) => w.id === 'w-gamma').params.fake.prove = 'wall'; // stays parked for the scenario
  writeFileSync(boardFile, JSON.stringify(b, null, 2));
  const r = go('G.duplicate-discovery', ['--max-launches', '4']);
  b = readBoard(boardFile);
  assert('G0. re-discovering the admitted prerequisite creates no second item and no second build', () => {
    eq(r.exit, 0, `run exit\n${r.stdout.slice(-600)}`);
    eq(b.work.filter((w) => w.what.includes('shared row-parsing helper')).length, 1, 'helper item count');
    eq(b.attempts.filter((a) => a.of === 'w-shared').length, sharedAttemptsBefore, 'w-shared attempt count unchanged');
  });
  const gamma = b.attempts.filter((a) => a.of === 'w-gamma');
  assert('G1. the duplicate handback is noted, not re-added, and its own edge still parks it', () => {
    eq(gamma.length, 1, 'gamma attempts');
    eq(gamma[0].state, 'walled', 'gamma walled');
    ok((gamma[0].result?.notes ?? []).some((n) => /already in the graph as active, not re-added/.test(n)),
      `note says not re-added: ${JSON.stringify(gamma[0].result?.notes)}`);
    const edge = b.edges.find((e) => e.to === 'w-gamma');
    ok(edge && edge.status === 'proposed', 'gamma edge exists and is proposed');
    eq(b.last_run.drained, 'awaiting-decision', 'drain awaits the decision on the new edge');
  });
  // The inertness is the same rule the first round proved: until a person answers, gamma
  // does not get a second attempt.
  const before = b.attempts.length;
  const r2 = go('G2.duplicate-no-decision', ['--max-launches', '4']);
  b = readBoard(boardFile);
  assert('G2. rerunning with the duplicate edge unanswered launches nothing new', () => {
    eq(r2.exit, 0, 'rerun exit');
    eq(b.attempts.length, before, 'no new attempts');
  });
  snapshot(engine, 'G-duplicate', boardFile);
}

// ------------------------------------------------------------------------ close
writeFileSync(join(LOGS, 'assertions.log'), logLines.join('\n') + '\n');
console.log(`\n  maintenance-e2e: ${ran} assertions, ${failed} failed`);
console.log(`  engine: ${ENGINE}`);
console.log(`  logs:   ${LOGS}`);
console.log(`  work:   ${WORK}`);
if (opt('--keep', '') === '') { /* workspace kept: it is the evidence */ }
process.exit(failed ? 1 : 0);
