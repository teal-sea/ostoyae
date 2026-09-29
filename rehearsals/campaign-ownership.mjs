// Competing sessions and interrupted publication, using disposable local remotes only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'campaign-ownership-'));
const env = { ...process.env, OSTOYAE_STATE_DIR: join(temp, 'state') };
delete env.OSTOYAE_EXEC;
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=rehearsal', '-c', 'user.email=r@x', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 60000;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for campaign'); await sleep(50); }
}
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const release = join(temp, 'release'), executor = join(temp, 'executor.sh');
writeFileSync(executor, `#!/bin/sh\nwhile [ ! -f ${quote(release)} ]; do sleep 0.1; done\nexec bash ${quote(join(root, 'executors/fake.sh'))}\n`);
function start(origin, dir, extra = []) {
  const child = spawn('bash', [join(root, 'bin/campaign'), '--repo', origin, '--board', 'board.json',
    '--branch', 'claude/test', '--dir', dir, '--exec', `bash ${quote(executor)}`,
    '--max-invocations', '2', '--max-launches', '1', ...extra], { cwd: root, env });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  return { child, done };
}
let checks = 0;
try {
  const origin = join(temp, 'origin'), seed = join(temp, 'seed');
  mkdirSync(origin); git(origin, 'init', '--bare', '-q', '-b', 'main');
  mkdirSync(seed); git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README'), 'disposable pursuit\n');
  writeFileSync(join(seed, 'board.json'), JSON.stringify({ graph: 'ownership', concurrency: 1, max_attempts: 1,
    defaults: { fake: { sleep: 0.05 } }, sandbox: { repo: seed, root: join(temp, 'unused'), base: 'main' },
    work: [1, 2].map(n => ({ id: `w-${n}`, what: `Make w-${n}.txt`, check: `test -f w-${n}.txt${n === 2 ? ' && test -f w-1.txt' : ''}`, ...(n === 2 ? { needs: ['w-1'] } : {}) })), edges: [], attempts: [] }));
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'fixture'); git(seed, 'push', '-q', origin, 'main');
  const firstDir = join(temp, 'first'), secondDir = join(temp, 'second');
  const first = start(origin, firstDir);
  await until(() => {
    try { return JSON.parse(readFileSync(join(firstDir, 'pursuit/board.json'))).attempts.length > 0; } catch { return false; }
  });
  const second = await start(origin, secondDir).done;
  writeFileSync(release, 'continue\n');
  const firstResult = await first.done;
  assert.equal(firstResult.code, 0, firstResult.output);
  const duplicate = JSON.parse(readFileSync(join(secondDir, 'pursuit/board.json'))).attempts.length;
  assert.equal(duplicate, 0, `competing client launched ${duplicate} duplicate session(s)\n${second.output}`);
  assert.notEqual(second.code, 0, second.output);
  assert.match(second.output, /owned|ownership|locked/i);
  console.log(`  ok ${++checks}. competing clients cannot launch duplicate work`);

  const resumed = await start(origin, join(temp, 'third')).done;
  assert.equal(resumed.code, 0, resumed.output);
  const board = JSON.parse(git(origin, 'show', 'claude/test:board.json'));
  assert.deepEqual(board.attempts.map(a => a.of), ['w-1', 'w-2']);
  assert.ok(board.attempts.every(a => a.state === 'done'), resumed.output);
  console.log(`  ok ${++checks}. a new machine resumes the remaining task`);

  const reused = await start(origin, firstDir).done;
  assert.equal(reused.code, 0, reused.output);
  assert.match(reused.output, /0 session\(s\) recorded/);
  assert.equal(JSON.parse(readFileSync(join(firstDir, 'pursuit/board.json'))).attempts.length, 2);
  assert.equal(git(join(firstDir, 'pursuit'), 'rev-parse', 'ost/ownership/trunk'), git(origin, 'rev-parse', 'ost/ownership/trunk'));
  const trunkPath = join(firstDir, 'worktrees/ownership/_trunk');
  if (existsSync(trunkPath)) assert.ok(existsSync(join(trunkPath, 'w-2.txt')));
  console.log(`  ok ${++checks}. an older local directory restores the newer trunk without leaving stale checked-out files`);

  const failedOrigin = join(temp, 'failed-origin');
  mkdirSync(failedOrigin); git(failedOrigin, 'init', '--bare', '-q', '-b', 'main');
  git(seed, 'push', '-q', failedOrigin, 'main');
  const hook = join(failedOrigin, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/ost/*/trunk) exit 1;; esac\ndone\n'); chmodSync(hook, 0o755);
  const failedDir = join(temp, 'failed');
  const rejected = await start(failedOrigin, failedDir).done;
  assert.notEqual(rejected.code, 0, rejected.output);
  assert.match(rejected.output, /continuity FAILED/);
  const headRefs = git(failedOrigin, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
  assert.ok(headRefs.some(ref => ref.startsWith('refs/heads/claude/ostoyae-owners/')));
  assert.ok(!headRefs.includes('refs/heads/claude/test'));
  assert.ok(!headRefs.some(ref => ref.startsWith('refs/heads/ost/')));
  assert.equal(JSON.parse(readFileSync(join(failedDir, 'pursuit/board.json'))).attempts.length, 1);
  console.log(`  ok ${++checks}. rejected publication keeps the ownership claim and publishes neither artifact nor board`);

  const blockedDir = join(temp, 'blocked');
  const blocked = await start(failedOrigin, blockedDir).done;
  assert.notEqual(blocked.code, 0, blocked.output);
  assert.equal(JSON.parse(readFileSync(join(blockedDir, 'pursuit/board.json'))).attempts.length, 0);
  console.log(`  ok ${++checks}. a failed publication cannot reset allowance on another machine`);

  rmSync(hook);
  const repaired = await start(failedOrigin, failedDir, ['--publish-only']).done;
  assert.equal(repaired.code, 0, repaired.output);
  assert.equal(JSON.parse(git(failedOrigin, 'show', 'claude/test:board.json')).attempts.length, 1);
  assert.match(git(failedOrigin, 'ls-tree', '-r', '--name-only', 'ost/ownership/trunk'), /w-1.txt/);
  const published = git(failedOrigin, 'rev-parse', 'claude/test');
  const replay = await start(failedOrigin, failedDir, ['--publish-only']).done;
  assert.equal(replay.code, 0, replay.output);
  assert.equal(git(failedOrigin, 'rev-parse', 'claude/test'), published);
  console.log(`  ok ${++checks}. publication-only recovery preserves results and is idempotent`);

  const crashOrigin = join(temp, 'crash-origin'), crashDir = join(temp, 'crashed');
  mkdirSync(crashOrigin); git(crashOrigin, 'init', '--bare', '-q', '-b', 'main'); git(seed, 'push', '-q', crashOrigin, 'main');
  rmSync(release);
  const interrupted = start(crashOrigin, crashDir);
  await until(() => { try { return JSON.parse(readFileSync(join(crashDir, 'campaign.json'))).phase === 'running'; } catch { return false; } });
  interrupted.child.kill('SIGKILL'); await interrupted.done;
  const premature = await start(crashOrigin, crashDir, ['--publish-only']).done;
  assert.notEqual(premature.code, 0, premature.output);
  assert.match(premature.output, /alive or unverified|live or unverified/);
  writeFileSync(release, 'continue\n');
  await until(() => {
    try { const g = JSON.parse(readFileSync(join(crashDir, 'pursuit/board.json'))); return g.attempts.length === 1 && g.attempts[0].state === 'done' && !existsSync(join(crashDir, 'pursuit/board.run.json')); }
    catch { return false; }
  });
  const recovered = await start(crashOrigin, crashDir, ['--publish-only']).done;
  assert.match(recovered.output, /published board and .*runner exit unknown/, recovered.output);
  assert.equal(JSON.parse(git(crashOrigin, 'show', 'claude/test:board.json')).attempts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(crashDir, 'campaign.json'))).recorded, 1);
  console.log(`  ok ${++checks}. a lost wrapper retains live ownership, then publishes settled work without repeating it`);
} finally {
  if (process.env.KEEP) console.log(`Fixtures: ${temp}`);
  else rmSync(temp, { recursive: true, force: true });
}
console.log(`${checks} campaign ownership checks passed. No model calls.`);
