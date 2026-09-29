// Two boards, one repository, concurrent work and independent browser selections.
// Real Git worktrees and TCP listeners, scripted executor only. No provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ostoyae-multiple-')));
const repo = join(temp, 'pursuit'), state = join(temp, 'state'); mkdirSync(repo);
const env = { ...process.env, OSTOYAE_STATE_DIR: state, OSTOYAE_NO_OPEN: '1', GIT_CONFIG_GLOBAL: '/dev/null', NO_COLOR: '1' };
for (const key of ['OSTOYAE_CWD', 'OSTOYAE_GRAPH', 'OSTOYAE_EXEC', 'OSTOYAE_PORT']) delete env[key];
const cli = join(root, 'bin/ostoyae');
const run = args => spawnSync(cli, args, { cwd: repo, env, encoding: 'utf8', timeout: 45000 });
const ok = r => { assert.equal(r.status, 0, r.stdout + r.stderr + (r.error?.message ?? '')); return r.stdout; };
const git = (...args) => ok(spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=r@x', ...args], { env, encoding: 'utf8' })).trim();
const read = name => JSON.parse(readFileSync(join(repo, name)));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const processes = [], viewers = [];
const start = args => {
  const child = spawn(cli, args, { cwd: repo, env }); processes.push(child);
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout: output, stderr: '' })); });
};
let count = 0;
const pass = text => console.log(`  ok ${++count}. ${text}`);
try {
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'start');
  const executor = join(temp, 'executor.mjs');
  writeFileSync(executor, `import fs from 'node:fs'; import net from 'node:net'; import {execFileSync} from 'node:child_process';
const a=JSON.parse(fs.readFileSync(0,'utf8')); const server=net.createServer();
server.listen(Number(process.env.PORT),'127.0.0.1',()=>{
  fs.appendFileSync(${JSON.stringify(join(temp, 'events'))},JSON.stringify({event:'start',branch:process.env.OSTOYAE_BRANCH,port:Number(process.env.PORT),time:Date.now()})+'\\n');
  setTimeout(()=>{
    fs.writeFileSync('result.txt',process.env.OSTOYAE_BRANCH+'\\n');
    execFileSync('git',['add','result.txt']); execFileSync('git',['-c','user.name=fixture','-c','user.email=r@x','commit','-qm','done']);
    fs.mkdirSync('.ostoyae',{recursive:true});fs.writeFileSync('.ostoyae/usage.json',JSON.stringify({cost_usd:0,output_tokens:0,input_tokens:0}));
    fs.appendFileSync(${JSON.stringify(join(temp, 'events'))},JSON.stringify({event:'end',branch:process.env.OSTOYAE_BRANCH,time:Date.now()})+'\\n');
    server.close();
  },3000);
});`);
  for (const file of ['alpha.json', 'beta.json']) ok(run(['init', file, '--exec', `node ${quote(executor)}`, '--item', 'Build the shared parser', '--check', 'test -s result.txt']));
  const a = read('alpha.json'), b = read('beta.json');
  assert.notEqual(a.graph, b.graph); assert.equal(a.sandbox.port_base, 'auto'); pass('new boards in one repository receive separate identities');
  const listed = JSON.parse(ok(run(['boards', '--json'])));
  assert.equal(listed.boards.length, 2); assert.equal(listed.overlaps.length, 1); assert.equal(listed.overlaps[0].items.length, 2);
  pass('the agent can list both boards and see matching work');
  assert.equal(run(['status', 'alpha.json', '--board', 'beta.json']).status, 2); pass('ambiguous board targets are refused');
  const results = await Promise.all(['alpha.json', 'beta.json'].map(file => start(['go', '--board', file, '--invocations', '1'])));
  results.forEach(ok);
  const finished = [read('alpha.json'), read('beta.json')];
  for (const board of finished) {
    assert.equal(board.attempts.length, 1); assert.equal(board.attempts[0].state, 'done', JSON.stringify(board.attempts));
    assert.equal(git('show', `ost/${board.graph}/trunk:result.txt`), board.attempts[0].sandbox.branch);
  }
  assert.notEqual(finished[0].attempts[0].sandbox.port, finished[1].attempts[0].sandbox.port);
  const events = readFileSync(join(temp, 'events'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(Math.max(...events.filter(e => e.event === 'start').map(e => e.time)) < Math.min(...events.filter(e => e.event === 'end').map(e => e.time)));
  pass('two overlapping tasks really execute concurrently with separate branches and bound ports');
  // --control: this rehearsal decides through the page. Without it the viewer only shows.
  for (const file of ['alpha.json', 'beta.json']) {
    const output = ok(run(['watch', '--board', file, '--browser', '--control']));
    const url = output.match(/http:\/\/localhost:\d+/)[0]; viewers.push(url);
  }
  assert.notEqual(viewers[0], viewers[1]); pass('a second viewer opens without a manually chosen port');
  const get = async (url, path) => { const r = await fetch(url + path, { headers: { connection: 'close' } }); assert.equal(r.status, 200); return r.json(); };
  assert.equal((await get(viewers[0], '/api/health')).graph, join(repo, 'alpha.json'));
  assert.equal((await get(viewers[1], '/api/health')).graph, join(repo, 'beta.json'));
  assert.match(ok(run(['watch', '--board', 'alpha.json', '--browser', '--control'])), new RegExp(viewers[0])); pass('reopening a board reuses only its own viewer');
  const other = run(['watch', '--board', 'alpha.json', '--browser']);
  assert.notEqual(other.status, 0); assert.match(other.stderr + other.stdout, /with --control/); pass('reopening without --control is refused rather than served with control on');
  const betaQuery = `?board=${encodeURIComponent(join(repo, 'beta.json'))}`;
  const switched = await fetch(viewers[0] + '/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: join(repo, 'beta.json') }) });
  assert.equal(switched.status, 200); assert.match((await switched.json()).url, /board=/);
  assert.equal((await get(viewers[0], '/api/graph')).file, join(repo, 'alpha.json'));
  assert.equal((await get(viewers[0], '/api/graph' + betaQuery)).file, join(repo, 'beta.json'));
  pass('switching one browser tab leaves the other tab on its board');
  // Same proposal id, different boards: even a delayed POST must target the chosen board.
  for (const file of ['alpha.json', 'beta.json']) {
    const board = read(file); board.work.push({ id: 'shared-id', what: `Proposal for ${file}`, status: 'proposed' });
    writeFileSync(join(repo, file), JSON.stringify(board));
  }
  const decision = await fetch(viewers[0] + '/api/decide' + betaQuery, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: ['shared-id'] }) });
  assert.equal(decision.status, 200, await decision.text());
  assert.equal(read('alpha.json').work.at(-1).status, 'proposed'); assert.notEqual(read('beta.json').work.at(-1).status, 'proposed');
  pass('a decision changes only the board selected by that tab');
  ok(run(['stop', '--board', 'alpha.json']));
  assert.equal((await get(viewers[1], '/api/health')).graph, join(repo, 'beta.json')); pass('stopping one board leaves the other viewer available');
  const betaBytes = readFileSync(join(repo, 'beta.json'));
  writeFileSync(join(repo, 'beta.json'), '{');
  const corrupt = run(['boards', '--json']); assert.equal(corrupt.status, 1);
  assert.equal(JSON.parse(corrupt.stdout).errors.length, 1); pass('an unreadable registered board is reported rather than disappearing');
  writeFileSync(join(repo, 'beta.json'), betaBytes);
} finally {
  for (const url of viewers) {
    try { const r = await fetch(url + '/api/health'); const h = await r.json(); if (h.pid) process.kill(h.pid, 'SIGTERM'); } catch { /* fixture already stopped */ }
  }
  for (const p of processes) if (p.exitCode === null) p.kill('SIGTERM');
  if (process.env.KEEP) console.log(`Fixtures: ${temp}`); else rmSync(temp, { recursive: true, force: true });
}
console.log(`${count} multiple-board checks passed. No model calls.`);
