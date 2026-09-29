import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { usageRecord, validateParams, configArgs, guard } from '../executors/codex.mjs';
import { limited, derive, decideOn } from '../viewer/state.mjs';

const root = resolve('.'), dir = realpathSync(mkdtempSync('/tmp/rehearse-codex-'));
const p = { model: 'fixture', codex_pricing: { input: 2, cached_input: 0.2, output: 10 } };
let count = 0;
const test = (name, fn) => { fn(); console.log(`  ok ${++count}. ${name}`); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
const git = (cwd, ...args) => {
  const r = run('git', ['-C', cwd, ...args]); assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
};
try {
  test('cached input is counted once; dollar estimates carry their rates and basis', () => {
    const u = usageRecord({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }, p, 500, 1);
    assert.equal(u.input_tokens, 400); assert.equal(u.cache_read_input_tokens, 600);
    assert.equal(u.cost_usd, 0.00142); assert.match(u.cost_basis, /estimated/); assert.equal(u.turns, null);
    assert.equal(usageRecord(null, p, 500, 0).cost_usd, null);
    assert.equal(usageRecord({ input_tokens: 2, cached_input_tokens: 4, output_tokens: 1 }, p, 0, 0).input_tokens, null);
  });
  test('unknown cost is not a zero-dollar session limit; Codex quota messages are recognized', () => {
    assert.equal(limited({ state: 'failed', result: { usage: { cost_usd: null, turns: null } } }), false);
    for (const text of ['usage_limit_reached', 'rate_limit_exceeded', 'insufficient_quota', 'You have exceeded your current quota'])
      assert.equal(limited({ state: 'failed', result: { output: [text] } }), true, text);
  });
  test('model IDs are opaque; unsupported parameters stop before a model is called', () => {
    assert.doesNotThrow(() => validateParams({ model: 'opus' }));
    assert.throws(() => validateParams({ model: 'fixture', max_turns: 3 }), /no max_turns equivalent/);
    assert.throws(() => validateParams({}), /model explicitly/);
  });
  test('the git hook blocks direct, absolute, and compound git invocations', () => {
    for (const command of ['git status', '/usr/bin/git add .', 'pwd && git commit -m x', 'bash -lc "git status"'])
      assert.equal(guard({ tool_input: { command } }).hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(guard({ tool_input: { cmd: 'lake build' } }), {});
  });
  mkdirSync(join(dir, 'cache'));
  test('configuration keeps linked caches read-only and enables only the declared Lean MCP', () => {
    const args = configArgs(p, { OSTOYAE_LINKED: join(dir, 'cache'), OSTOYAE_TOOLS: 'bash /lab/tool' }, dir);
    assert(!args.includes('--add-dir'));
    assert(args.includes('approval_policy="never"'));
    assert(args.some((x) => x.includes(`${JSON.stringify(join(dir, 'cache'))}="read"`)));
    assert(!args.some((x) => x.startsWith('mcp_servers.lean=')));
    assert(configArgs(p, { OSTOYAE_LEAN_MCP: process.execPath }, dir).some((x) => x.startsWith('mcp_servers.lean=')));
    assert(configArgs({ ...p, reasoning_effort: 'low' }, {}, dir).includes('model_reasoning_effort="low"'));
    assert(configArgs({ ...p, reasoning_effort: 'low', effort: 'high' }, {}, dir).includes('model_reasoning_effort="high"'));
  });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/codex'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'login') { console.log('logged in fixture'); process.exit(0); }
const args = process.argv.slice(2), mode = args[args.length-1];
fs.writeFileSync('.ostoyae/args.json', JSON.stringify(args));
fs.mkdirSync('.ostoyae', {recursive:true});
const reports = {done:{},wall:{wall:'missing prerequisite',work:[{id:'need',what:'build prerequisite'}]},map:{map:{settles:'mapped',cost:'small'}},verify:{verdicts:[]},badverify:{}};
if (reports[mode]) fs.writeFileSync('.ostoyae/report.json',JSON.stringify(reports[mode]));
if (['done','wall','failure'].includes(mode)) fs.writeFileSync('result.txt',mode);
if (mode === 'done') fs.writeFileSync(' leading\\nfile.txt','unusual filename');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture read AGENTS.md'}}));
if (mode === 'failure') console.log(JSON.stringify({type:'error',message:'fixture error despite CLI exit zero'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:600,output_tokens:50}}));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` };
  for (const mode of ['done', 'wall', 'map', 'verify', 'badverify', 'failure', 'done-ignored']) {
    test(`fake Codex ${mode} obeys the handback/commit contract`, () => {
      const repo = join(dir, mode); mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'rehearsal'); git(repo, 'config', 'user.email', 'rehearsal@example.test');
      writeFileSync(join(repo, 'README'), 'scratch\n');
      if (mode !== 'done-ignored') writeFileSync(join(repo, 'AGENTS.md'), 'original contract\n');
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'start');
      const before = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'AGENTS.md'), 'injected contract\n');
      if (mode === 'done-ignored') {
        writeFileSync(join(repo, 'CLAUDE.md'), 'injected contract\n');
        writeFileSync(join(repo, '.git/info/exclude'), 'AGENTS.md\nCLAUDE.md\n');
      }
      const a = { id: 'a-0001', of: 'w-one', what: mode === 'done-ignored' ? 'done' : mode, kind: /verify/.test(mode) ? 'verify' : mode === 'map' ? 'map' : 'prove', params: p };
      const r = run('bash', [join(root, 'executors/codex.sh')], { cwd: repo, env, input: JSON.stringify(a) });
      assert.equal(r.status, ['done', 'map', 'verify', 'done-ignored'].includes(mode) ? 0 : 1, r.stdout + r.stderr);
      const u = JSON.parse(readFileSync(join(repo, '.ostoyae/usage.json')));
      assert.equal(u.output_tokens, 50); assert.equal(u.cost_usd, 0.00142);
      const changed = ['done', 'wall', 'failure', 'done-ignored'].includes(mode);
      assert.equal(git(repo, 'rev-parse', 'HEAD') !== before, changed);
      if (mode !== 'done-ignored') assert.equal(git(repo, 'show', 'HEAD:AGENTS.md'), 'original contract');
      else assert(!git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('AGENTS.md'));
      if (mode === 'done' || mode === 'done-ignored') assert.equal(git(repo, 'show', 'HEAD: leading\nfile.txt'), 'unusual filename');
      assert(!git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('.ostoyae'));
      const args = JSON.parse(readFileSync(join(repo, '.ostoyae/args.json')));
      assert(args.some((x) => /ostoyae-codex\./.test(x)));
    });
  }
  test('doctor checks the selected executor without invoking Claude', () => {
    writeFileSync(join(dir, 'bin/claude'), '#!/bin/sh\necho unexpected-Claude >&2\nexit 88\n', { mode: 0o755 });
    const g = { graph: 'doctor-codex', defaults: p, sandbox: { repo: join(dir, 'done'), root: join(dir, 'wt'), base: 'main' }, work: [{ id: 'w', what: 'do' }], edges: [], attempts: [] };
    const file = join(dir, 'graph.json'); writeFileSync(file, JSON.stringify(g));
    const r = run('node', ['doctor.mjs', file, '--exec', `bash ${root}/executors/codex.sh`], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert(!r.stdout.includes('unexpected-Claude'));
    const f = run('node', ['doctor.mjs', file, '--exec', `bash ${root}/executors/fake.sh`], { env });
    assert.equal(f.status, 0, f.stdout + f.stderr);
  });
  test('indexed answers agree with live answers after deciding a cloned graph', () => {
    const g = { max_attempts: 2, work: [{id:'w-a',what:'a',status:'proposed'}, {id:'w-b',what:'b'}], edges:[{id:'e-1',from:'w-a',to:'w-b',status:'proposed'}], attempts:[] };
    for (const status of ['confirmed', 'rejected']) {
      const c = structuredClone(g), live = derive(c);
      for (const id of ['w-a','e-1']) decideOn(live.lookup(id), status);
      assert.deepEqual([...derive(c, {index:true}).readyIds()], [...live.readyIds()]);
    }
    const live = derive(g); g.work.push({id:'w-new',what:'new'});
    assert(live.readyIds().has('w-new'));
  });
  test('both dry-run paths skip gate commands and leave the graph byte-identical', () => {
    const marker = join(dir, 'gate-ran'), file = join(dir, 'dry.json');
    const g = { graph:'dry-gate',concurrency:1,max_attempts:1,defaults:p,
      sandbox:{repo:join(dir,'done'),root:join(dir,'dry-wt'),base:'main'},
      ontology:{kinds:{lemma:{claim:['decl','statement'],id:'w-{decl}',what:'prove {decl}',gate:`touch ${marker}`}}},
      work:[{id:'w-t',what:'prove t',kind:'lemma',claim:{decl:'t',statement:'True'}}],edges:[],attempts:[] };
    const bytes=JSON.stringify(g); writeFileSync(file,bytes);
    for(const flags of [['--dry-run'],['--gate','--dry-run']]) {
      const r=run('node',['run.mjs',file,...flags]); assert.equal(r.status,0,r.stdout+r.stderr);
      assert.equal(readFileSync(file,'utf8'),bytes); assert(!existsSync(marker)); assert(!existsSync(join(dir,'dry-wt')));
    }
  });
  test('a dollar cap stops on unpriced Codex usage without launching another attempt', () => {
    const file=join(dir,'unpriced.json');
    const g={graph:'unpriced',concurrency:1,max_attempts:2,sandbox:{repo:join(dir,'done'),root:join(dir,'unpriced-wt'),base:'main'},
      work:[{id:'w-one',what:'do it'}],edges:[],attempts:[{id:'a-0001',of:'w-one',state:'failed',result:{usage:usageRecord({input_tokens:10,cached_input_tokens:0,output_tokens:2},{model:'fixture'},10,1)}}]};
    writeFileSync(file,JSON.stringify(g));
    const r=run('node',['run.mjs',file,'--exec',`bash ${root}/executors/fake.sh`,'--max-usd','5']);
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/unknown Codex dollar cost/);
    assert.equal(JSON.parse(readFileSync(file)).attempts.length,1);
  });
  test('missing Codex token usage retains executor identity and stops a dollar-capped run', () => {
    const fixture=join(dir,'missing-usage.mjs'), file=join(dir,'missing-usage.json');
    writeFileSync(fixture,"import{writeFileSync,mkdirSync}from'node:fs';mkdirSync('.ostoyae',{recursive:true});writeFileSync('.ostoyae/usage.json',JSON.stringify({executor:'codex',_bad:'no tokens',cost_usd:null}));writeFileSync('.ostoyae/report.json','{}');process.exitCode=1;");
    writeFileSync(file,JSON.stringify({graph:'missing-usage',concurrency:1,max_attempts:1,
      sandbox:{repo:join(dir,'done'),root:join(dir,'missing-usage-wt'),base:'main'},
      work:[{id:'w-one',what:'one'},{id:'w-two',what:'two'}],edges:[],attempts:[]}));
    const r=run('node',['run.mjs',file,'--exec',`node ${fixture}`,'--max-usd','5']);
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/unknown Codex dollar cost/);
    const attempts=JSON.parse(readFileSync(file)).attempts; assert.equal(attempts.length,1);
    assert.equal(attempts[0].result.usage.executor,'codex');
  });
  test('invalid budget values cannot silently turn a cap off', () => {
    for(const args of [['--max-usd','NaN'],['--max-launches','-1'],['--max-output-tokens','1.5']]) {
      const r=run('node',['run.mjs',join(dir,'unpriced.json'),'--dry-run',...args]); assert.equal(r.status,2);
    }
  });
  {
    const cell=join(dir,'adopt-wt','adopt','a-0001'); mkdirSync(cell,{recursive:true});
    const orphan=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:cell,stdio:'ignore',detached:true});
    const file=join(dir,'adopt.json'), runfile=join(dir,'adopt.run.json');
    writeFileSync(file,JSON.stringify({graph:'adopt',concurrency:1,max_attempts:1,
      sandbox:{repo:join(dir,'done'),root:join(dir,'adopt-wt'),base:'main'},
      work:[{id:'w-orphan',what:'finish'},{id:'w-next',what:'must not launch'}],edges:[],
      attempts:[{id:'a-0001',of:'w-orphan',state:'running',cell_pid:orphan.pid,
        sandbox:{worktree:'wt/adopt/a-0001',branch:'unused',port:4910}}]}));
    const adopter=spawn(process.execPath,['run.mjs',file,'--exec',`bash ${root}/executors/fake.sh`,'--adopt-wait','1'],{stdio:['ignore','pipe','pipe']});
    let output=''; adopter.stdout.on('data',b=>output+=b); adopter.stderr.on('data',b=>output+=b);
    const exited=new Promise(r=>adopter.on('close',r));
    const waitFor=async(predicate)=>{const until=Date.now()+10000;while(!predicate()){assert(Date.now()<until,output);await new Promise(r=>setTimeout(r,50));}};
    try {
      await waitFor(()=>output.includes('outlived runner'));
      assert.equal(JSON.parse(readFileSync(runfile)).pid,adopter.pid,'adopter must own the heartbeat while waiting');
      const duplicate=run('node',['run.mjs',file,'--exec',`bash ${root}/executors/fake.sh`]);
      assert.equal(duplicate.status,1,duplicate.stdout+duplicate.stderr); assert.match(duplicate.stderr,/runner is already live/);
      // Keep this parent's event loop free to reap its orphan fixture after SIGTERM.
      const stop=spawn(process.execPath,['run.mjs',file,'--stop','--now'],{stdio:'ignore'});
      assert.equal(await new Promise(r=>stop.on('close',r)),0);
      await waitFor(()=>adopter.exitCode!==null);
      assert.equal(await exited,0,output);
      const g=JSON.parse(readFileSync(file)); assert.equal(g.attempts.length,1); assert.equal(g.attempts[0].state,'failed');
      assert(existsSync(cell),'hard-stopped adopted worktree must be retained'); assert(!existsSync(runfile));
      console.log(`  ok ${++count}. adoption owns its heartbeat, rejects a second runner and accepts stop --now`);
    } finally {
      if(adopter.exitCode===null)adopter.kill('SIGKILL');
      try{process.kill(-orphan.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
      await exited;
    }
  }
  test('wrapper forwards reservation/rejection flags and refuses unknown options before doctor', () => {
    const capture=join(dir,'forwarded.json'), doctor=join(dir,'doctor-called');
    writeFileSync(join(dir,'bin/node'),`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');
const a=process.argv.slice(2);
if(a[0]==='doctor.mjs'){fs.writeFileSync(${JSON.stringify(doctor)},'yes');process.exit(0);}
if(a[0]==='run.mjs'){fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(a));process.exit(0);}
if(a[0]==='viewer/serve.mjs'){setInterval(()=>{},1000);}else{const r=cp.spawnSync(${JSON.stringify(process.execPath)},a,{stdio:'inherit'});process.exit(r.status??1);}
`,{mode:0o755});
    const port=55000+process.pid%9000, pidfile=`/tmp/ostoyae-viewer-${port}.pid`;
    assert(!existsSync(pidfile),'choose an unowned fixture pidfile');
    writeFileSync(join(dir,'bin/curl'),`#!${process.execPath}\nconst fs=require('node:fs');console.log(JSON.stringify({pid:Number(fs.readFileSync(${JSON.stringify(pidfile)},'utf8'))}));\n`,{mode:0o755});
    const wrapenv={...env,OSTOYAE_PORT:String(port),OSTOYAE_NO_OPEN:'1',OSTOYAE_EXEC:`bash ${root}/executors/fake.sh`};
    for(const args of [['go','--unknown'],['go','--usd','NaN']]) {
      assert.equal(run('bash',['bin/ostoyae',...args],{env:wrapenv}).status,2); assert(!existsSync(doctor));
    }
    try {
      const r=run('bash',['bin/ostoyae','go',join(dir,'unpriced.json'),'--reserve-usd','12','--launches','1'],{env:wrapenv});
      assert.equal(r.status,0,r.stdout+r.stderr);
      const args=JSON.parse(readFileSync(capture)); assert.equal(args[args.indexOf('--reserve-usd')+1],'12');
      assert.equal(args[args.indexOf('--max-launches')+1],'1');
      const reject=run('bash',['bin/ostoyae','reject',join(dir,'unpriced.json'),'w-one','--reject-why','a concrete reason'],{env:wrapenv});
      assert.equal(reject.status,0,reject.stderr); assert(JSON.parse(readFileSync(capture)).includes('a concrete reason'));
    } finally {
      if(existsSync(pidfile)){process.kill(Number(readFileSync(pidfile,'utf8')),'SIGTERM');rmSync(pidfile);}
      rmSync(`/tmp/ostoyae-viewer-${port}.log`,{force:true});
    }
  });
  console.log(`  ${count} assertions, all passing. No model calls.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
