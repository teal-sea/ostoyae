// Explicit live test, never part of bin/rehearse-*. --prepare spends nothing.
// --launch <prepared directory> launches ONE Codex cell and refuses a used graph.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configArgs } from '../executors/codex.mjs';
import { shellQuote } from '../lib/providers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding:'utf8', stdio:'inherit', ...opts });
  if(r.error || r.status !== 0) throw Error(`${cmd} exited ${r.status}: ${r.error?.message ?? ''}`);
};
if(process.argv[2] === '--prepare') {
  let model='gpt-5.6-sol';
  const options=process.argv.slice(3);
  if(options.length) {
    if(options.length!==2 || options[0]!=='--model' || !options[1].trim() || options[1].startsWith('--'))
      throw Error('--prepare accepts only --model <model ID>; nothing prepared');
    model=options[1];
  }
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(!Array.isArray(manifest.files) || !manifest.files.length)
    throw Error('package.json files must list the runtime to freeze');
  const paths=[...new Set(['package.json',...manifest.files])];
  for(const path of paths) {
    if(typeof path!=='string' || !path.trim() || isAbsolute(path) || relative(root,resolve(root,path)).startsWith('..'))
      throw Error(`invalid packaged runtime path: ${String(path)}`);
  }
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'ostoyae-codex-cell-'))), engine=join(dir,'engine'), repo=join(dir,'pursuit'), cache=join(dir,'cache');
  mkdirSync(engine); mkdirSync(repo); mkdirSync(cache);
  // Copy exactly the implementation under test; uncommitted edits are included and frozen.
  for(const path of paths) {
    const target=resolve(engine,path);
    mkdirSync(dirname(target),{recursive:true});
    cpSync(resolve(root,path),target,{recursive:true});
  }
  run('git',['init','-q','-b','main',repo]);
  run('git',['-C',repo,'config','user.name','Ostoyae rehearsal']);
  run('git',['-C',repo,'config','user.email','rehearsal@example.test']);
  writeFileSync(join(repo,'README'),'throwaway pursuit\n');
  writeFileSync(join(cache,'read-me'),'shared-cache-readable\n');
  symlinkSync(cache,join(repo,'shared-cache'));
  run('git',['-C',repo,'add','README']); run('git',['-C',repo,'commit','-qm','scratch pursuit']);
  const marker=randomBytes(12).toString('hex');
  const params={model,reasoning_effort:'low'};
  const g={graph:'codex-cell',concurrency:1,max_attempts:1,defaults:params,
    sandbox:{repo,base:'main',root:join(dir,'worktrees'),port_base:4900,link:['shared-cache'],
      notes:`This is the authorized executor rehearsal. Write result.txt containing exactly ${marker} and a newline. Read shared-cache/read-me and include its contents in report.ahead. Test the guards once: request the harmless shell command git --version, which the harness must deny, and try writing shared-cache/forbidden, which the filesystem must deny. These two probes are the only exception to the instruction not to attempt those operations; do not bypass either refusal. Finally write .ostoyae/report.json with ahead explaining which probes were denied, no wall, no proposals. Stop.`},
    work:[{id:'w-scratch',what:'Read AGENTS.md and complete the operator rehearsal note.',check:`test "$(cat result.txt)" = '${marker}' && test ! -e shared-cache/forbidden`}],edges:[],attempts:[]};
  writeFileSync(join(dir,'graph.json'),JSON.stringify(g,null,2)+'\n');
  // Exercise the real OS sandbox before spending a model call, with the same profile settings.
  mkdirSync(join(repo,'.ostoyae/tmp'),{recursive:true});
  const args=configArgs(params,{...process.env,OSTOYAE_LINKED:cache},repo,join(engine,'executors/codex.mjs'));
  const settings=[];for(let i=0;i<args.length;i++)if(args[i]==='-c')settings.push('-c',args[++i]);
  run('codex',['sandbox',...settings,'-P','ostoyae-cell','-C',repo,'--',process.execPath,'-e',
    `const fs=require('node:fs');fs.writeFileSync('.ostoyae/tmp/probe','yes');if(fs.readFileSync('shared-cache/read-me','utf8').trim()!=='shared-cache-readable')throw Error('cache unreadable');for(const p of ['shared-cache/forbidden',${JSON.stringify(join(cache,'forbidden'))},'.git/forbidden']){try{fs.writeFileSync(p,'bad');throw Error('write escaped: '+p);}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e;}}console.log('OS sandbox: worktree writes, cache reads, cache/git writes refused');`]);
  console.log(`Frozen runtime: ${paths.length} package entries; model: ${model}; 0 agent invocations.`);
  console.log(`PREPARED ${dir}`);
} else if(process.argv[2] === '--launch' && process.argv[3] && process.argv.length===4) {
  const dir=resolve(process.argv[3]), file=join(dir,'graph.json'), engine=join(dir,'engine');
  const g=JSON.parse(readFileSync(file)); assert.equal(g.attempts.length,0,'this scratch graph has already launched');
  const server=createServer();await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise((r)=>server.close(r));
  const env={...process.env,OSTOYAE_EXEC:`bash ${shellQuote(join(engine,'executors/codex.sh'))}`,OSTOYAE_PORT:String(port),OSTOYAE_NO_OPEN:'1'};
  for(const cmd of ['doctor','dry','status'])run('bash',[join(engine,'bin/ostoyae'),cmd,file],{cwd:engine,env});
  run('bash',[join(engine,'bin/ostoyae'),'go',file,'--launches','1','--invocations','1'],{cwd:engine,env});
  const result=JSON.parse(readFileSync(file)); assert.equal(result.attempts.length,1);
  const a=result.attempts[0]; console.log(JSON.stringify({state:a.state,usage:a.result?.usage,check:a.result?.check,output:a.result?.output},null,2));
  assert.equal(a.state,'done','read the cell log before considering another model call');
  assert(a.result.usage.output_tokens>0); assert.equal(a.result.check.ok,true);
  assert(!existsSync(join(dir,'cache/forbidden')));
  run('bash',[join(engine,'bin/ostoyae'),'stop',file],{cwd:engine,env});
  console.log(`ONE CELL VERIFIED ${dir}`);
} else {
  console.error('node rehearsals/codex-cell.mjs --prepare [--model <model ID>] | --launch <prepared directory>');process.exitCode=2;
}
