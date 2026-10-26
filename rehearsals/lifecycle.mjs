// Lifecycle regressions: stop/resume and subscription-quota failure, rehearsed with
// deterministic fake executors, real processes and real git. Zero model calls.
//
//   node rehearsals/lifecycle.mjs      prints one line per assertion, exits non-zero if any fails
//
// What is pinned, in the order an operator meets it:
//   1. a subscription-quota result stops new launches instead of retrying the same exhausted
//      pool: the attempts are `failed` with `result.limited: true`, the item is NOT exhausted
//      (a quota is not work failure), and a later run may retry the item once the window opens
//   2. running children are accounted for: an in-flight attempt is reserved against --max-usd
//      before the next launch is allowed, so concurrency cannot silently walk past the cap
//   3. an interrupted owner does not double-launch or duplicate settlement on resume: the sweep
//      adopts live cells, settles them once from their handback, and no item gets a second
//      concurrent attempt
//   4. spend/usage that is unknown is not free: a _bad or absent usage record is counted as
//      unpriced, refuses to bind a dollar cap, and is never summed as zero dollars
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import * as spend from '../lib/spend.mjs';

const root = resolve('.');
const dir = realpathSync(mkdtempSync('/tmp/rehearse-lifecycle-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
const git = (cwd, ...args) => {
  const r = run('git', ['-C', cwd, ...args]); assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
};
let count = 0;
const test = async (name, fn) => { await fn(); console.log(`  ok ${++count}. ${name}`); };
const boardPath = (name) => join(dir, `${name}.json`);
const load = (name) => JSON.parse(readFileSync(boardPath(name), 'utf8'));
const writeBoard = (name, g) => writeFileSync(boardPath(name), JSON.stringify(g));
// A pursuit each test shares: one fresh git repo, one throwaway worktree root per board.
const pursuit = join(dir, 'pursuit');
mkdirSync(pursuit);
git(pursuit, 'init', '-q', '-b', 'main');
git(pursuit, 'config', 'user.name', 'rehearsal');
git(pursuit, 'config', 'user.email', 'rehearsal@ostoyae.invalid');
writeFileSync(join(pursuit, 'README'), 'hello\n');
git(pursuit, 'add', '.'); git(pursuit, 'commit', '-qm', 'start');
const EXEC = `bash ${root}/executors/fake.sh`;

// A deterministic executor that always hits a subscription quota. It writes nothing, so its
// usage is also unknown -- the two concerns land on the same attempt.
const quotaExec = join(dir, 'quota-exec.sh');
writeFileSync(quotaExec, `#!/usr/bin/env bash\ncat >/dev/null\n` +
  `echo "error: You have exceeded your current quota, please check your plan and billing details."\n` +
  `echo "exceeded your current quota"\nexit 1\n`, { mode: 0o755 });

try {
  // ----------------------------------------------------------------- 1. quota-limit stops the run
  await test('a quota result is recorded limited, does not exhaust the item, and stops new launches', () => {
    const name = 'quota';
    writeBoard(name, {
      graph: name, concurrency: 2, max_attempts: 3,
      sandbox: { repo: pursuit, root: join(dir, `wt-${name}`), base: 'main', port_base: 5210 },
      work: [1, 2, 3, 4, 5].map((n) => ({ id: `w-${n}`, what: `item ${n}`, check: 'true' })),
      edges: [], attempts: [],
    });
    const r = run('node', ['run.mjs', boardPath(name), '--exec', `bash ${quotaExec}`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const g = load(name);
    // Concurrency is 2: two were already in flight when the first quota landed. Nothing more.
    assert.equal(g.attempts.length, 2, JSON.stringify(g.attempts.map((a) => [a.id, a.of, a.state])));
    for (const a of g.attempts) {
      assert.equal(a.state, 'failed');
      assert.equal(a.result.limited, true, a.result);
    }
    assert.match(g.last_run.stopped_by, /plan window/);
    // The item is not exhausted by the quota: no non-limited attempt was spent on it.
    assert.match(r.stdout, /1 attempt in, retries left/);
    assert.equal(g.attempts.filter((a) => a.state !== 'running').length, 2);
  });

  await test('a quota does not count against max_attempts: the item retries after the window opens', () => {
    const name = 'quota-retry';
    writeBoard(name, {
      graph: name, concurrency: 1, max_attempts: 2,
      sandbox: { repo: pursuit, root: join(dir, `wt-${name}`), base: 'main', port_base: 5220 },
      work: [{ id: 'w-1', what: 'item 1', check: 'true' }], edges: [], attempts: [],
    });
    // First run: quota. Second run (same board): a working executor, which must still be
    // allowed to launch -- a limited attempt is not a spent one.
    const q = run('node', ['run.mjs', boardPath(name), '--exec', `bash ${quotaExec}`]);
    assert.equal(q.status, 0, q.stdout + q.stderr);
    const afterQuota = load(name);
    assert.equal(afterQuota.attempts.length, 1);
    assert.equal(afterQuota.attempts[0].result.limited, true);
    const done = run('node', ['run.mjs', boardPath(name), '--exec', EXEC]);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    const g = load(name);
    assert.equal(g.attempts.length, 2, JSON.stringify(g.attempts.map((a) => [a.id, a.state])));
    const prove = g.attempts.find((a) => a.kind === 'prove' && !a.result?.limited);
    assert.ok(prove, 'no un-limited prove attempt followed the quota');
    assert.equal(prove.state, 'done', prove.result);
  });

  // --------------------------------------------- 2. running children are reserved against the cap
  await test('overBudget reserves in-flight attempts before allowing the next launch', () => {
    // $5 settled, one child running, would-be launch reserved at $5 each: 5 + 2*5 >= 10 -> bind.
    const g = { attempts: [
      { kind: 'prove', state: 'done', result: { usage: { cost_usd: 5 } } },
      { kind: 'prove', state: 'running' },
    ] };
    const bound = spend.overBudget(g, { MAX_USD: 10, MAX_INVOCATIONS: 0, MAX_OUTPUT_TOKENS: 0, RESERVE_USD: 5 });
    assert.match(bound, /1 in flight reserved at \$5\.00 each/, bound);
    // With the child still running but more headroom, the launch is allowed.
    const open = spend.overBudget(g, { MAX_USD: 100, MAX_INVOCATIONS: 0, MAX_OUTPUT_TOKENS: 0, RESERVE_USD: 5 });
    assert.equal(open, null, open);
  });

  // ------------------------------------------------- 3. an interrupted owner resumes without loss
  // A deterministic executor that thinks for 6s, commits, and writes a handback -- so a cell
  // that survives its owner leaves evidence the sweep can settle from (a prove's exit code is
  // lost with the runner; the handback is what remains).
  const resumeExec = join(dir, 'resume-exec.py');
  writeFileSync(resumeExec, `#!/usr/bin/env python3
import json, sys, time, os, subprocess
a = json.load(sys.stdin)
time.sleep(6)
of = a['of']
open(of + '.txt', 'w').write('resumed work\\n')
os.makedirs('.ostoyae', exist_ok=True)
open('.ostoyae/report.json', 'w').write('{}\\n')
subprocess.run(['git', 'add', of + '.txt'])
subprocess.run(['git', 'commit', '-qm', 'resume: ' + of])
`, { mode: 0o755 });

  await test('an interrupted owner is adopted: settled once, no duplicate attempt, ids unique', async () => {
    const name = 'resume';
    writeBoard(name, {
      graph: name, concurrency: 2, max_attempts: 2,
      sandbox: { repo: pursuit, root: join(dir, `wt-${name}`), base: 'main', port_base: 5230 },
      work: [1, 2, 3, 4].map((n) => ({ id: `w-${n}`, what: `item ${n}`, check: 'true' })),
      edges: [], attempts: [],
    });
    const board = boardPath(name);
    const EXEC_RESUME = `python3 ${resumeExec}`;
    const owner = spawn(process.execPath, ['run.mjs', board, '--exec', EXEC_RESUME], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; owner.stdout.on('data', (b) => out += b); owner.stderr.on('data', (b) => out += b);
    const waitFor = async (pred, ms = 30000) => {
      const until = Date.now() + ms;
      while (!pred()) { assert(Date.now() < until, out); await new Promise((r) => setTimeout(r, 100)); }
    };
    const runningOnDisk = () => JSON.parse(readFileSync(board, 'utf8')).attempts.filter((a) => a.state === 'running');
    try {
      await waitFor(() => runningOnDisk().length >= 2 && runningOnDisk().every((a) => a.cell_pid));
      // The owner is gone; its two cells are detached and keep thinking.
      owner.kill('SIGKILL');
      await new Promise((r) => owner.once('close', r));
      const orphaned = runningOnDisk();
      assert.equal(orphaned.length, 2, JSON.stringify(orphaned.map((a) => [a.id, a.of])));
      const orphanIds = orphaned.map((a) => a.id);
      // Resume: the sweep adopts the live cells and settles each from its handback, exactly once.
      const again = run('node', ['run.mjs', board, '--exec', EXEC_RESUME]);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      const g = load(name);
      const ids = g.attempts.map((a) => a.id);
      assert.equal(ids.length, new Set(ids).size, `duplicate attempt ids: ${ids}`);
      // The adopted pair keeps its original ids -- it is settled, not re-launched under new ids.
      for (const id of orphanIds) {
        const a = g.attempts.find((x) => x.id === id);
        assert.ok(a, `adopted attempt ${id} vanished`);
        assert.equal(a.state, 'done', `${id} -> ${a.state}: ${JSON.stringify(a.result)}`);
      }
      // Every item ends with exactly one attempt and none is left running.
      assert.equal(g.attempts.length, 4, JSON.stringify(g.attempts.map((a) => [a.id, a.of, a.state])));
      assert.ok(!g.attempts.some((a) => a.state === 'running'));
      // No duplicate settlement: a second resume changes nothing.
      const snap = JSON.stringify(g.attempts);
      assert.equal(run('node', ['run.mjs', board, '--exec', EXEC_RESUME]).status, 0);
      assert.equal(JSON.stringify(load(name).attempts), snap);
    } finally {
      try { owner.kill('SIGKILL'); } catch { /* already reaped */ }
    }
  });

  // ----------------------------------------------------------- 4. unknown usage is not free
  await test('a _bad usage record is unpriced and refuses a dollar cap, never summed as zero', () => {
    const g = { attempts: [
      { kind: 'prove', state: 'failed', result: { usage: { _bad: 'unparseable', cost_usd: null } } },
    ] };
    const s = spend.spendSoFar(g);
    assert.equal(s.usd, 0);                 // dollars unknown, not zero
    assert.equal(s.priced, 0);
    assert.equal(s.unpriced, 1);
    const bound = spend.overBudget(g, { MAX_USD: 10, MAX_INVOCATIONS: 0, MAX_OUTPUT_TOKENS: 0, RESERVE_USD: 0 });
    assert.match(bound, /unknown dollar cost on 1 attempt/, bound);
  });

  await test('an executor that reports no usage stops a dollar-capped run instead of pricing it free', () => {
    const name = 'unknown-cap';
    const bareExec = join(dir, 'bare-exec.sh');
    // A prove that "succeeds" without ever writing a usage record: unknown, not $0.
    writeFileSync(bareExec, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'fake work\\n' > w-1.txt\nexit 0\n`, { mode: 0o755 });
    writeBoard(name, {
      graph: name, concurrency: 1, max_attempts: 1,
      sandbox: { repo: pursuit, root: join(dir, `wt-${name}`), base: 'main', port_base: 5240 },
      work: [{ id: 'w-1', what: 'item 1', check: 'true' },
             { id: 'w-2', what: 'item 2', check: 'true' }],
      edges: [], attempts: [],
    });
    const r = run('node', ['run.mjs', boardPath(name), '--exec', `bash ${bareExec}`, '--max-usd', '5']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /unknown dollar cost/);
    const g = load(name);
    assert.equal(g.attempts.length, 1, 'a second unpriced launch slipped past the dollar cap');
    assert.equal(g.attempts[0].result.usage, undefined, JSON.stringify(g.attempts[0].result));
  });

  console.log(`  ${count} assertions, all passing. No model calls.`);
} finally {
  // Reap any detached fixture cells still sleeping, then drop the tree.
  try { run('pkill', ['-f', dir]); } catch { /* none */ }
  rmSync(dir, { recursive: true, force: true });
}
