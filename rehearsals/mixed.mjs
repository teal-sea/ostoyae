import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { attemptConfigs, resolveAttempt } from '../lib/attempt-execution.mjs';

const root = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'ostoyae-mixed-'));
const repo = join(tmp, 'repo'), bin = join(tmp, 'bin'), boardPath = join(tmp, 'board.json');
mkdirSync(repo); mkdirSync(bin);
const call = (file, args, env, cwd = repo) => spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
const show = r => r.stdout + r.stderr + (r.error?.message ?? '');
try {
  let r = call('git', ['init', '-q', '-b', 'main'], process.env); assert.equal(r.status, 0, show(r));
  writeFileSync(join(repo, 'README'), 'fixture\n');
  r = call('git', ['add', '.'], process.env); assert.equal(r.status, 0, show(r));
  r = call('git', ['-c', 'user.name=fixture', '-c', 'user.email=x@y', 'commit', '-qm', 'start'], process.env); assert.equal(r.status, 0, show(r));
  const stub = `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const agent=path.basename(process.argv[1]), args=process.argv.slice(2);
if(['auth','login'].includes(args[0])) process.exit(0);
fs.appendFileSync(process.env.STUB_LOG,JSON.stringify({agent,args,hermes:process.env.HERMES_HOME,claude:process.env.CLAUDE_CONFIG_DIR,codex:process.env.CODEX_HOME})+'\\n');
fs.mkdirSync('.ostoyae',{recursive:true});
fs.writeFileSync('.ostoyae/report.json',JSON.stringify(agent==='hermes'?{map:{settles:'stub map',cost:'small'}}:{verdicts:[{id:'w-new',ok:true,why:'stub'}]}));
if(agent==='codex') console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
else if(agent==='claude') console.log(JSON.stringify({type:'result',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0}));
else console.log(JSON.stringify({type:'result',tokens:{input:1,output:1},exit_code:0}));
`;
  for (const name of ['hermes', 'codex', 'claude']) writeFileSync(join(bin, name), stub, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: join(tmp, 'calls.jsonl'),
    HERMES_HOME: join(tmp, 'hermes-home'), CODEX_HOME: join(tmp, 'codex-home'), CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', OSTOYAE_STATE_DIR: join(tmp, 'state'), NO_COLOR: '1' };
  delete env.OSTOYAE_EXEC;
  const board = { graph: 'mixed-fixture', execution: { provider: 'claude' },
    defaults: { agent: 'claude', model: 'sonnet', effort: 'low' },
    mapping: { what: 'Map the job.', params: { agent: 'hermes', model: 'hermes-model', effort: 'medium' } },
    judge: { verify: 'Check the proposal.', params: { agent: 'codex', model: 'gpt-5.2-codex', effort: 'high' } },
    sandbox: { repo, root: join(tmp, 'cells'), base: 'main', port_base: 47000, env_passthrough: ['STUB_LOG'] },
    concurrency: 3, max_attempts: 1,
    work: [{ id: 'w-map', what: 'Map me' }, { id: 'w-prove', what: 'Build me', map: { settles: 'done', cost: 'small' } },
      { id: 'w-verify', what: 'Judge me', map: { settles: 'done', cost: 'small' } },
      { id: 'w-new', what: 'Proposal', status: 'proposed', found_by: ['a-0001'] }],
    edges: [], attempts: [{ id: 'a-0001', of: 'w-verify', kind: 'prove', state: 'failed', params: { agent: 'claude', model: 'sonnet' },
      result: { found: ['w-new'], why: 'fixture' } }] };
  writeFileSync(boardPath, JSON.stringify(board));
  r = call(process.execPath, ['doctor.mjs', boardPath, '--json'], env, root);
  assert.equal(r.status, 0, show(r));
  const checked = JSON.parse(r.stdout);
  for (const name of ['hermes', 'codex', 'claude'])
    assert(checked.rows.some(x => ['executor', 'executor auth'].includes(x.name) && x.detail.toLowerCase().includes(name)), name);
  console.log('  ok  doctor checks all three providers');
  const wrong = structuredClone(board); wrong.judge.params.model = 'claude-sonnet-4';
  writeFileSync(boardPath, JSON.stringify(wrong));
  r = call(process.execPath, ['doctor.mjs', boardPath, '--json'], env, root);
  assert.equal(r.status, 1, show(r)); assert.match(r.stdout, /does not belong to codex/);
  console.log('  ok  doctor refuses a Claude model paired with Codex');
  writeFileSync(boardPath, JSON.stringify(board));
  r = call(process.execPath, ['run.mjs', boardPath, '--max-launches', '3', '--no-messaging'], env, root);
  assert.equal(r.status, 0, show(r));
  const summaryLine = r.stdout.split('\n').find(line => line.includes('agents:'));
  for (const agent of ['hermes', 'codex', 'claude']) assert(summaryLine?.includes(agent), summaryLine);
  const after = JSON.parse(readFileSync(boardPath));
  const recent = after.attempts.slice(1);
  for (const [kind, agent, model, effort] of [['map','hermes','hermes-model','medium'], ['verify','codex','gpt-5.2-codex','high'], ['prove','claude','sonnet','low']])
    assert(recent.some(a => a.kind === kind && a.params.agent === agent && a.params.model === model && a.params.effort === effort), JSON.stringify(recent));
  const calls = readFileSync(env.STUB_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  for (const [agent, key] of [['hermes','hermes'],['codex','codex'],['claude','claude']])
    assert(calls.some(c => c.agent === agent && c[key] === env[agent === 'hermes' ? 'HERMES_HOME' : agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']), JSON.stringify(calls));
  console.log('  ok  mixed map, verify and prove launch their own executors with model, effort and credentials');
  r = call(join(root, 'bin/ostoyae'), ['status', boardPath, '--json'], env, root);
  assert.equal(r.status, 0, show(r));
  assert.deepEqual(new Set(JSON.parse(r.stdout).mix), new Set(['claude','hermes','codex']));
  console.log('  ok  status shows the provider mix');
  assert.equal(resolveAttempt({agent:'codex',model:'gpt-5.2-codex'}, 'claude').agent, 'codex');
  assert.equal(resolveAttempt({agent:'codex',model:'shared-model'}, 'claude', {provider:'hermes'}).agent, 'hermes');
  const overrides = structuredClone(board);
  overrides.work = [{ id: 'w-one', what: 'One', params: { agent: 'claude', model: 'shared-model' } }];
  overrides.mapping.params.model = 'shared-model';
  overrides.judge.params.model = 'shared-model';
  assert.equal(attemptConfigs(overrides, 'claude').find(([name]) => name === 'w-one/map')[1].agent, 'claude');
  console.log('  ok  job agent wins over role and board; CLI agent wins over job');
  const forced = structuredClone(board);
  delete forced.mapping; delete forced.judge;
  forced.work = [{ id: 'w-forced', what: 'Forced', params: { agent: 'codex', model: 'shared-model' } }];
  forced.attempts = []; forced.defaults.model = 'shared-model'; forced.sandbox.port_base = 48000;
  writeFileSync(boardPath, JSON.stringify(forced));
  r = call(join(root, 'bin/ostoyae'), ['go', boardPath, '--agent', 'hermes', '--launches', '1', '--headless', '--no-messaging'], env, root);
  assert.equal(r.status, 0, show(r));
  const forcedAttempt = JSON.parse(readFileSync(boardPath)).attempts[0];
  assert.equal(forcedAttempt.params.agent, 'hermes');
  assert(readFileSync(env.STUB_LOG, 'utf8').includes('"agent":"hermes"'));
  console.log('  ok  go --agent overrides the job agent at launch');
} finally { if (process.env.KEEP) console.log(tmp); else rmSync(tmp, { recursive: true, force: true }); }
console.log('Mixed rehearsal passed. Stub CLIs only.');
