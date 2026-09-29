import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIdentity, inspectProcess, inspectProcessGroup, processOwner, resolveOnDiskCase } from '../lib/process-identity.mjs';
import { alive, cellAlive, killCell, readRun, rememberCellGroup, stopRun } from '../lib/liveness.mjs';

let count = 0;
const test = async (name, fn) => {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  await fn(); console.log(`  ok ${++count}. ${name}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (test) => {
  const until = Date.now() + 15_000;
  while (!test()) { assert(Date.now() < until, 'fixture condition timed out'); await delay(50); }
};
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-process-'));
const sandbox = { repo: temp, root: temp };
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: temp, detached: true, stdio: 'ignore' });
let stubborn;
const owned = [];
const liveFixture = async () => {
  const fixture = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"],
    { cwd: temp, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new Error('live fixture did not become ready')), 15_000);
      fixture.stdout.once('data', () => { clearTimeout(timer); yes(); });
      fixture.once('error', (error) => { clearTimeout(timer); no(error); });
    });
    const identity = captureIdentity(fixture.pid, { cwd: temp });
    assert(identity, 'live fixture has no verifiable birth identity');
    owned.push(identity);
    return { process: fixture, identity };
  } catch (error) {
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGKILL');
    throw error;
  }
};
const leaderCode = `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
process.on('SIGTERM',()=>process.exit(0));
process.stdin.resume();
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
  {stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>{
  if(process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE,String(child.pid));
  else console.log(child.pid);
  if(process.env.EXIT_LEADER) setTimeout(()=>process.exit(0),500);
});
setInterval(()=>{},1000);
`;
try {
  await test('a distinct case spelling keeps its path on a case-sensitive filesystem', () => {
    const lower = join(temp, 'alias.json');
    writeFileSync(lower, '{}');
    const upper = join(temp, 'ALIAS.json');
    assert.equal(resolveOnDiskCase(upper, () => false), upper);
    assert.equal(resolveOnDiskCase(lower, () => false), lower);
  });
  await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
  const identity = captureIdentity(child.pid, { cwd: temp });
  await test('the running child has a portable birth identity', () => {
    assert(identity?.start && identity.boot); assert.equal(inspectProcess(child.pid).status, 'alive');
    assert.equal(processOwner(child.pid, { identity }), true);
  });
  await test('a recycled start time cannot own the recorded cell', () => {
    assert.equal(processOwner(child.pid, { identity: { ...identity, start: 'wrong-start' } }), false);
  });
  await test('a copied record from another boot cannot own this process', () => {
    assert.equal(processOwner(child.pid, { identity: { ...identity, boot: 'different-machine-boot' } }), false);
  });
  await test('birth identity includes the PID, even for simultaneous births', () => {
    assert.equal(identity.pid, child.pid);
    assert.equal(processOwner(child.pid, { identity: { ...identity, pid: child.pid + 1 } }), false);
  });
  await test('a copied identity cannot authorize a different board or worktree', () => {
    const runnerIdentity = captureIdentity(child.pid, { runnerFile: join(temp, 'first.json') });
    assert.equal(processOwner(child.pid, { identity: runnerIdentity, runnerFile: join(temp, 'other.json') }), false);
    assert.equal(processOwner(child.pid, { identity, cwd: join(temp, 'other-cell') }), false);
    assert.notEqual(processOwner(child.pid, { identity, runnerFile: join(temp, 'other.json') }), true);
  });
  await test('invalid PIDs never identify process groups or the current process', () => {
    for (const pid of [0, -1, undefined, null, '1', 1.5, Infinity]) assert.equal(alive(pid), false);
  });
  await test('a provisioning attempt without a PID does not crash orphan inspection', () => {
    assert.equal(cellAlive(undefined, temp, undefined, undefined), false);
  });
  await test('missing ownership stays unknown, even while the PID is alive', () => {
    assert.equal(processOwner(child.pid), null);
  });
  await test('kill refuses an unverified cell and the process stays alive', () => {
    assert.equal(killCell({}, { cell_pid: child.pid }), false); assert(alive(child.pid));
  });
  await test('kill refuses a recycled cell even at the original directory', () => {
    assert.equal(killCell({ sandbox: { repo: temp, root: temp } }, {
      cell_pid: child.pid, cell_identity: { ...identity, start: 'wrong-start' }, sandbox: { worktree: '.' }
    }), false); assert(alive(child.pid));
  });
  await test('malformed run records fail visibly instead of allowing another run', () => {
    const file = join(temp, 'broken.run.json'); writeFileSync(file, '{');
    assert.throws(() => readRun(file), /Cannot read run record/);
    for (const record of [{}, { pid: '123' }, { pid: -1 }]) {
      writeFileSync(file, JSON.stringify(record)); assert.throws(() => readRun(file), /invalid runner PID/);
    }
  });
  await test('orphan stop reports failure when ownership cannot be established', async () => {
    const code = await stopRun({ g: { graph: 'unknown-owner', attempts: [
      { id: 'a-0', of: 'w-0', state: 'running' },
      { id: 'a-1', of: 'w-1', state: 'running', cell_pid: child.pid }] },
      file: join(temp, 'board.json'), RUNFILE: join(temp, 'absent.run.json'), NOW: true });
    assert.equal(code, 10); assert(alive(child.pid));
  });
  await test('a verified detached cell can be stopped, including on macOS', async () => {
    assert.equal(killCell({ sandbox }, { cell_pid: child.pid, cell_identity: identity, sandbox: { worktree: '.' } }), true);
    await new Promise(resolve => child.once('close', resolve));
    assert.equal(alive(child.pid), false); assert.equal(processOwner(child.pid, { identity }), false);
  });
  await test('a delivered stop signal is not reported as a dead process', async () => {
    stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
      { cwd: temp, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((yes, no) => { stubborn.stdout.once('data', yes); stubborn.once('error', no); });
    const code = await stopRun({ g: { graph: 'stubborn-cell', sandbox, attempts: [{ id: 'a-2', of: 'w-2',
      state: 'running', cell_pid: stubborn.pid, cell_identity: captureIdentity(stubborn.pid, { cwd: temp }), sandbox: { worktree: '.' } }] },
      file: join(temp, 'board.json'), RUNFILE: join(temp, 'absent.run.json'), NOW: true });
    assert.equal(code, 10); assert(alive(stubborn.pid));
  });
  await test('survivor: a dead leader cannot hide its SIGTERM-ignoring child or authorize unrelated kills', async () => {
    const stranger = await liveFixture();
    const leader = spawn(process.execPath, ['-e', leaderCode], { cwd: temp, detached: true, stdio: ['ignore','pipe','ignore'] });
    const descendant = await new Promise((yes, no) => { leader.stdout.once('data', (data) => yes(Number(String(data).trim()))); leader.once('error', no); });
    owned.push(captureIdentity(leader.pid), captureIdentity(descendant));
    const a = { id:'a-group', of:'w-group', state:'running', cell_pid:leader.pid,
      cell_identity:captureIdentity(leader.pid,{cwd:temp}), sandbox:{worktree:'.'} };
    const g = {graph:'surviving-child',sandbox,attempts:[a]};
    await waitFor(()=>{ rememberCellGroup(g,a); return a.cell_group?.members.some((member)=>member.pid===descendant); });
    const file = join(temp,'group.json'); writeFileSync(file,JSON.stringify(g));
    const code = await stopRun({g,file,RUNFILE:join(temp,'no-group.run.json'),NOW:true});
    assert.equal(code,10); assert.equal(alive(leader.pid),false); assert.equal(alive(descendant),true);
    assert.equal(inspectProcessGroup(leader.pid).status,'alive');
    assert.equal(cellAlive(a.cell_pid,temp,a.cell_identity,a.cell_group),true);
    const saved = JSON.parse(readFileSync(file,'utf8'));
    assert.equal(saved.attempts[0].state,'running');
    assert.equal(await stopRun({g:saved,file,RUNFILE:join(temp,'no-group.run.json'),NOW:true}),10);
    assert.equal(killCell(g,{...a,cell_pid:stranger.process.pid}),false); assert(alive(stranger.process.pid));
    assert.equal(killCell(g,{...a,cell_identity:{...a.cell_identity,start:'copied-start'}}),false);
    assert(alive(descendant));
  });
  await test('survivor: a runner ESRCH race still checks its final board for live cells', async () => {
    const liveCell = await liveFixture();
    const runner = spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],
      {cwd:temp,detached:true,stdio:['ignore','pipe','ignore']});
    await new Promise((yes,no)=>{runner.stdout.once('data',yes);runner.once('error',no);});
    owned.push(captureIdentity(runner.pid));
    const file=join(temp,'race.json'), RUNFILE=join(temp,'race.run.json');
    const g={graph:'runner-exit-race',sandbox,attempts:[{id:'a-race',of:'w-race',state:'running',cell_pid:liveCell.process.pid,
      cell_identity:liveCell.identity,sandbox:{worktree:'.'}}]};
    writeFileSync(file,JSON.stringify(g));
    writeFileSync(RUNFILE,JSON.stringify({pid:runner.pid,identity:captureIdentity(runner.pid,{runnerFile:file})}));
    const kill=process.kill;
    process.kill=function(pid,signal){
      if(pid===runner.pid&&signal==='SIGTERM') { kill(pid,'SIGKILL'); throw Object.assign(new Error('fixture exit race'),{code:'ESRCH'}); }
      return kill(pid,signal);
    };
    try { assert.equal(await stopRun({g,file,RUNFILE,NOW:false}),10); }
    finally { process.kill=kill; }
    assert(alive(liveCell.process.pid));
  });
  await test('survivor: runner preserves the cell and recovery cannot launch duplicate work', async () => {
    const root=process.cwd(), repo=join(temp,'pursuit'); mkdirSync(repo);
    execFileSync('git',['init','-q','-b','main',repo]);
    execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','fixture']);
    const executor=join(temp,'leader.cjs');writeFileSync(executor,leaderCode);
    const pidFile=join(temp,'descendant.pid'), file=join(temp,'recovery.json');
    writeFileSync(file,JSON.stringify({graph:'survivor-recovery',concurrency:1,max_attempts:1,
      sandbox:{repo,root:join(temp,'cells'),env_passthrough:['PID_FILE','EXIT_LEADER']},
      work:[{id:'w',what:'fixture'}],edges:[],attempts:[]}));
    const quote=(s)=>"'"+s.replaceAll("'","'\\''")+"'";
    const command=`exec ${quote(process.execPath)} ${quote(executor)}`;
    const run=async(args)=>{
      const proc=spawn(process.execPath,[join(root,'run.mjs'),file,'--exec',command,...args],
        {cwd:root,env:{...process.env,PID_FILE:pidFile,EXIT_LEADER:'1'},stdio:['ignore','pipe','pipe']});
      owned.push(captureIdentity(proc.pid));
      let output='';proc.stdout.on('data',(data)=>output+=data);proc.stderr.on('data',(data)=>output+=data);
      const finished=new Promise((yes,no)=>{proc.once('close',(code)=>yes({code,output}));proc.once('error',no);});
      await waitFor(()=>existsSync(pidFile));
      const pid=Number(readFileSync(pidFile,'utf8'));owned.push(captureIdentity(pid));
      return finished;
    };
    const first=await run(['--max-launches','1']);
    assert.equal(first.code,10,first.output);assert.match(first.output,/INCOMPLETE/);
    const before=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(before.attempts.length,1);assert.equal(before.attempts[0].state,'running');
    const cell=join(temp,'cells',before.attempts[0].sandbox.worktree.replace(/^wt\//,''));
    assert(existsSync(cell));
    const recovered=await run(['--max-launches','1','--adopt-wait','0']);
    assert.equal(recovered.code,10,recovered.output);
    const after=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(after.attempts.length,1);assert.equal(after.attempts[0].state,'running');
    assert(existsSync(cell));assert(alive(Number(readFileSync(pidFile,'utf8'))));
  });
} finally {
  for (const identity of owned) if (identity && processOwner(identity.pid,{identity})===true) {
    try { process.kill(identity.pid,'SIGKILL'); } catch (e) { if(e.code!=='ESRCH') throw e; }
  }
  await waitFor(()=>owned.every((identity)=>!identity||processOwner(identity.pid,{identity})!==true));
  if (stubborn && alive(stubborn.pid)) { process.kill(-stubborn.pid, 'SIGKILL'); }
  if (alive(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  rmSync(temp, { recursive: true, force: true });
}
console.log(`\n  ${count} process identity checks passed. No model calls.`);
if (!count) process.exitCode=1;
