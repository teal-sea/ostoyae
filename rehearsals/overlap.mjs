// Two stub agents change the same file at the same time; a third changes a different one.
// Ostoyae must tell each of the pair, once, from sender `ostoyae`, and leave the third alone.
// With messaging off it must not look at the cells at all. No model calls.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-overlap-'));
const repo = join(temp, 'repo'), out = join(temp, 'out'), shim = join(temp, 'shim');
mkdirSync(repo); mkdirSync(out); mkdirSync(shim);
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
// A git that notes every time something asks a cell for its untracked files by -C path. The
// runner's watcher is the only caller that does; executors and stubs run git in their own cwd.
const watchLog = join(temp, 'watch.log');
writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *" -C "*" ls-files "*"--others"*) echo "$*" >> ${JSON.stringify(watchLog)};; esac\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '1' };
for (const key of ['OSTOYAE_CWD', 'OSTOYAE_EXEC', 'OSTOYAE_GRAPH']) delete env[key];
const run = (args, cwd = repo) => spawnSync(args[0], args.slice(1), { cwd, env, encoding: 'utf8', timeout: 120000 });
const ok = r => { assert.equal(r.status, 0, r.stdout + r.stderr + (r.error?.message ?? '')); return r.stdout; };
const pass = s => console.log(`  ok  ${s}`);

// w-a and w-b both edit README, which the repository tracks. w-c writes a new file of its own.
// Each pair member waits for a notice, then keeps listening long enough for a duplicate to
// show; w-c listens until both are done. Everything heard is written to out/<job>.json.
const stub = join(temp, 'stub.mjs');
writeFileSync(stub, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const a = JSON.parse(fs.readFileSync(0, 'utf8')); const job = a.of, OUT = ${JSON.stringify(out)};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = () => { const r = spawnSync('ostoyae-msg', ['read'], { encoding: 'utf8' }); if (r.status) throw Error(r.stderr); return r.stdout; };
const rec = { id: a.id, contract: fs.readFileSync('AGENTS.md', 'utf8'), heard: '', bytecode: process.env.PYTHONDONTWRITEBYTECODE ?? null };
if (job === 'w-c') fs.writeFileSync('other.txt', 'mine\\n');
else fs.appendFileSync('README', job + ' was here\\n');
if (process.env.OSTOYAE_MAILBOX) {
  if (job === 'w-c') {
    for (let n = 0; n < 300 && !(fs.existsSync(OUT + '/w-a.json') && fs.existsSync(OUT + '/w-b.json')); n++) { rec.heard += read(); await sleep(100); }
  } else {
    for (let n = 0; n < 300 && !rec.heard.includes('[ostoyae to'); n++) { rec.heard += read(); await sleep(100); }
    await sleep(4000); rec.heard += read();
  }
} else await sleep(4000);
fs.writeFileSync(OUT + '/' + job + '.json', JSON.stringify(rec));
fs.mkdirSync('.ostoyae', { recursive: true }); fs.writeFileSync('.ostoyae/report.json', '{}');
`);

const board = (name) => {
  const path = join(repo, `${name}.json`);
  writeFileSync(path, JSON.stringify({ graph: `overlap-${name}`, concurrency: 3, max_attempts: 1,
    defaults: { model: 'stub-model' },
    sandbox: { repo, root: join(temp, `cells-${name}`), base: 'main', port_base: name === 'on' ? 48000 : 48100 },
    work: [{ id: 'w-a', what: 'Fix the greeting in README' }, { id: 'w-b', what: 'Fix the farewell in README' },
      { id: 'w-c', what: 'Write other.txt' }], edges: [], attempts: [] }, null, 2));
  return path;
};

try {
  ok(run(['git', 'init', '-q', '-b', 'main']));
  writeFileSync(join(repo, 'README'), 'fixture\n');
  ok(run(['git', 'add', '.'])); ok(run(['git', '-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-qm', 'start']));

  const on = board('on');
  const r = run([process.execPath, join(root, 'run.mjs'), on, '--exec', `node '${stub}'`, '--keep']);
  const log = r.stdout + r.stderr;
  assert.equal(r.status, 0, log);
  const g = JSON.parse(readFileSync(on, 'utf8'));
  const by = Object.fromEntries(g.attempts.map(x => [x.of, x]));
  const heard = Object.fromEntries(['w-a', 'w-b', 'w-c'].map(j => [j, JSON.parse(readFileSync(join(out, `${j}.json`), 'utf8'))]));

  // The contract of a later launch names the attempts already running, with job, agent and model.
  const [first, second] = [...g.attempts].sort((x, y) => x.id.localeCompare(y.id));
  const firstContract = heard[first.of].contract, secondContract = heard[second.of].contract;
  assert.match(firstContract, /No other attempt was running on this board when you started/);
  assert.match(secondContract, new RegExp(`- \`${first.id}\`, job \`${first.of}\`, custom · stub-model: `), secondContract);
  assert.match(secondContract, /Before you edit a file, check whether a peer is working on the same area/);
  assert.match(secondContract, /Run `ostoyae-msg read` before you edit a file and before you finish/);
  pass('a later launch lists the running attempts in its contract, with job, agent and model');

  // Exactly one notice to each of the pair, from ostoyae, naming the file and the other attempt.
  const notices = (g.messages ?? []).filter(m => m.from === 'ostoyae');
  assert.equal(notices.length, 2, JSON.stringify(g.messages, null, 2) + log);
  for (const [me, other] of [['w-a', 'w-b'], ['w-b', 'w-a']]) {
    const mine = notices.filter(m => m.to === by[me].id);
    assert.equal(mine.length, 1, JSON.stringify(notices));
    assert.deepEqual(mine[0].overlap, { path: 'README', with: by[other].id });
    assert.match(mine[0].text, new RegExp(`${by[other].id} \\(job ${other}: .*custom · stub-model\\) have both changed README`));
    assert.match(mine[0].text, /Tell each other what you changed/);
    assert.equal(heard[me].heard.match(/\[ostoyae to /g)?.length, 1, heard[me].heard);
    assert.match(heard[me].heard, new RegExp(`\\[ostoyae to ${by[me].id}\\] .*${by[other].id}.*README`));
  }
  pass('each of the pair hears exactly one notice from ostoyae, naming the other attempt and the file');
  pass('the notices are on the board\'s messages, with the file and the other attempt as fields');
  assert(!notices.some(m => m.to === by['w-c'].id) && !heard['w-c'].heard.includes('[ostoyae'), JSON.stringify(notices));
  assert(!notices.some(m => m.text.includes('other.txt')));
  pass('no notice for an attempt that changed a different file');
  assert.match(log, /overlap +README is also changed by a-000\d; told both/);
  assert(existsSync(watchLog), 'the watcher never looked at a cell');
  assert.equal(heard['w-a'].bytecode, '1');
  pass('the run says so, and PYTHONDONTWRITEBYTECODE=1 reached the cells');

  rmSync(watchLog, { force: true });
  for (const j of ['w-a', 'w-b', 'w-c']) rmSync(join(out, `${j}.json`));
  const off = board('off');
  const q = run([process.execPath, join(root, 'run.mjs'), off, '--exec', `node '${stub}'`, '--no-messaging']);
  assert.equal(q.status, 0, q.stdout + q.stderr);
  const h = JSON.parse(readFileSync(off, 'utf8'));
  assert.equal(h.messages, undefined);
  assert(h.attempts.length === 3 && h.attempts.every(x => x.state === 'done'), JSON.stringify(h.attempts));
  if (existsSync(watchLog)) assert.fail(`the runner looked at cells with messaging off:\n${readFileSync(watchLog, 'utf8')}`);
  assert.doesNotMatch(q.stdout, /is also changed by/);
  pass('with messaging off there are no notices and the runner never looks at the cells');
} finally {
  if (process.env.KEEP) console.log(`Fixtures: ${temp}`); else rmSync(temp, { recursive: true, force: true });
}
console.log('Overlap rehearsal passed. No model calls.');
