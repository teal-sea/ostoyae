import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { entries, limits, startCursor } from '../lib/messaging.mjs';
import { serve as serveRelay } from '../lib/mail-relay.mjs';
import { configArgs } from '../executors/codex.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-messaging-'));
const repo = join(temp, 'repo'); mkdirSync(repo);
const cli = join(root, 'bin/ostoyae'), msg = join(root, 'bin/ostoyae-msg');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', OSTOYAE_STATE_DIR: join(temp, 'state'), NO_COLOR: '1' };
for (const key of ['OSTOYAE_CWD', 'OSTOYAE_EXEC', 'OSTOYAE_GRAPH']) delete env[key];
const cmd = (file, args, extra = {}) => spawnSync(file, args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
const ok = r => { assert.equal(r.status, 0, r.stdout + r.stderr + (r.error?.message ?? '')); return r.stdout; };
const pass = s => console.log(`  ok  ${s}`);
const git = (...args) => ok(cmd('git', ['-c', 'user.name=fixture', '-c', 'user.email=x@y', ...args]));
const board = join(repo, 'board.json'), mailbox = join(repo, 'board.messages.test.jsonl');
const say = (attempt, args) => cmd(msg, args, { OSTOYAE_MAILBOX: mailbox, OSTOYAE_ATTEMPT: attempt, OSTOYAE_BOARD: board });
const launch = args => new Promise((resolve, reject) => {
  const p = spawn(cli, args, { cwd: repo, env }); let output = '';
  p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
  p.on('error', reject); p.on('close', status => resolve({ status, stdout: output }));
});

try {
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'start');
  writeFileSync(mailbox, '');
  writeFileSync(board, JSON.stringify({ messaging: { max_chars: 2000, max_sends: 20 }, attempts: [
    { id: 'a-0001', of: 'one', what: 'First job', params: { agent: 'claude', model: 'sonnet' }, state: 'running', cell_pid: process.pid },
    { id: 'a-0002', of: 'two', what: 'Second job', params: { agent: 'codex', model: 'gpt-5.2-codex' }, state: 'running', cell_pid: process.pid },
    { id: 'a-0003', of: 'three', what: 'Finished job', state: 'done', cell_pid: process.pid },
    { id: 'a-0005', of: 'five', what: 'Third running job', state: 'running', cell_pid: process.pid },
  ] }));
  assert.match(ok(say('a-0001', ['who'])), /a-0002  two  codex · gpt-5\.2-codex  Second job/);
  assert.doesNotMatch(ok(say('a-0001', ['who'])), /a-0003/); pass('who lists only other running attempts');
  assert.match(ok(say('a-0001', ['send', 'a-0002', 'hello'])), /sent/);
  assert.match(ok(say('a-0002', ['read'])), /hello/);
  assert.equal(ok(say('a-0002', ['read'])).trim(), 'No unread messages.');
  ok(say('a-0001', ['send', 'all', 'broadcast']));
  assert.match(ok(say('a-0002', ['read'])), /broadcast/);
  assert.match(ok(say('a-0005', ['read'])), /broadcast/);
  assert.equal(ok(say('a-0001', ['read'])).trim(), 'No unread messages.'); pass('direct and all delivery is once, excluding sender');
  startCursor(mailbox, 'a-0004');
  assert.equal(ok(say('a-0004', ['read'])).trim(), 'No unread messages.');
  pass('a later attempt does not inherit an earlier broadcast');
  ok(say('a-0002', ['send', 'a-0001', 'who reply']));
  assert.match(ok(say('a-0001', ['who'])), /who reply/);
  ok(say('a-0002', ['send', 'a-0001', 'send reply']));
  assert.match(ok(say('a-0001', ['send', 'a-0002', 'next'])), /send reply/);
  pass('who and send also drain unread messages');
  assert.match(say('a-0001', ['send', 'a-0002', 'x'.repeat(2001)]).stderr, /1 to 2000 characters/);
  for (let i = 3; i < 20; i++) ok(say('a-0001', ['send', 'all', `message ${i}`]));
  assert.match(say('a-0001', ['send', 'all', 'extra']).stderr, /send limit reached/); pass('size and send budgets refuse cleanly');
  ok(say('a-0002', ['read']));
  assert.equal(ok(say('a-0002', ['read', '--hook'])), '');

  // Hook output is the documented PostToolUse shape, and is silent when empty.
  ok(say('a-0002', ['read']));
  ok(say('a-0002', ['send', 'a-0001', 'hook delivery']));
  const hook = JSON.parse(ok(say('a-0001', ['read', '--hook'])));
  assert.equal(hook.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(hook.hookSpecificOutput.additionalContext, /hook delivery/);
  assert.equal(ok(say('a-0001', ['read', '--hook'])), ''); pass('hook JSON carries unread text and emits nothing when empty');
  const codex = configArgs({ model: 'stub' }, { ...env, OSTOYAE_MAILBOX: mailbox }, repo);
  assert(codex.some(x => x.includes(`"${repo}"="write"`)));
  assert(codex.some(x => x.includes('hooks.PostToolUse'))); pass('Codex grants mailbox write access and enables delivery hook');
  const fakeBin = join(temp, 'fake-bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'claude'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CLAUDE_ARGV_FILE"\nexit 1\n', { mode: 0o755 });
  const claudeArgs = join(temp, 'claude-args');
  const claudeCell = join(temp, 'claude-cell'); mkdirSync(claudeCell);
  spawnSync('bash', [join(root, 'executors/claude.sh')], { cwd: claudeCell, encoding: 'utf8',
    input: JSON.stringify({ id: 'a-0001', of: 'one', what: 'Test hook', kind: 'prove', params: {} }),
    env: { ...env, PATH: `${fakeBin}:${join(root, 'bin')}:${env.PATH}`,
      CLAUDE_ARGV_FILE: claudeArgs, OSTOYAE_MAILBOX: mailbox, OSTOYAE_BOARD: board,
      OSTOYAE_ATTEMPT: 'a-0001', OSTOYAE_WORK: 'one', OSTOYAE_WORKTREE: claudeCell },
  });
  const args = readFileSync(claudeArgs, 'utf8').split('\n');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'ostoyae-msg read --hook');
  assert(args.includes(repo)); pass('Claude enables the PostToolUse hook in its existing settings');
  const relayDir = join(temp, 'relay'); mkdirSync(relayDir);
  const relayTimer = setInterval(() => serveRelay(relayDir, mailbox, board, limits(JSON.parse(readFileSync(board)).messaging)), 10);
  const relayed = (attempt, words) => new Promise((resolve, reject) => {
    const p = spawn(msg, words, { cwd: repo, env: { ...env, OSTOYAE_MAILBOX: mailbox,
      OSTOYAE_BOARD: board, OSTOYAE_ATTEMPT: attempt, OSTOYAE_MAIL_RELAY: relayDir } });
    let stdout = '', stderr = '';
    p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', reject); p.on('close', status => status ? reject(Error(stderr)) : resolve(stdout));
  });
  try {
    await relayed('a-0002', ['send', 'a-0001', 'relayed note']);
    assert.match(await relayed('a-0001', ['read']), /relayed note/);
    assert.match(await relayed('a-0001', ['who']), /a-0002  two/);
  } finally { clearInterval(relayTimer); }
  pass('temp-file relay handles send and read without cell mailbox writes');

  // Independent processes use the real command. Raise the board cap for this stress run.
  const state = JSON.parse(readFileSync(board)); state.messaging.max_sends = 100;
  for (let i = 0; i < 20; i++) state.attempts.push({ id: `writer-${i}`, of: 'stress', state: 'running', cell_pid: process.pid });
  writeFileSync(board, JSON.stringify(state));
  const writers = Array.from({ length: 20 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {spawnSync} from 'node:child_process'; for(let j=0;j<50;j++){const r=spawnSync(${JSON.stringify(msg)},['send','all',String(j)],{encoding:'utf8'});if(r.status)throw Error(r.stderr)}`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, OSTOYAE_MAILBOX: mailbox, OSTOYAE_ATTEMPT: `writer-${i}`, OSTOYAE_BOARD: board } });
    let error = ''; p.stderr.on('data', b => error += b);
    p.on('error', reject); p.on('close', status => status ? reject(Error(error)) : resolve());
  }));
  await Promise.all(writers);
  assert.equal(entries(mailbox).filter(x => x.from.startsWith('writer-')).length, 1000);
  assert.equal(new Set(entries(mailbox).map(x => x.id)).size, entries(mailbox).length);
  pass('20 writers append 1,000 intact, unique JSONL messages');

  const stub = join(temp, 'stub.mjs');
  writeFileSync(stub, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const a=JSON.parse(fs.readFileSync(0,'utf8'));
const out={id:a.id, path:process.env.PATH, contract:fs.readFileSync('AGENTS.md','utf8'), mailbox:process.env.OSTOYAE_MAILBOX||null};
const call=(...args)=>{const r=spawnSync('ostoyae-msg',args,{encoding:'utf8'});if(r.status)throw Error(r.stderr);return r.stdout};
if(out.mailbox){const b=JSON.parse(fs.readFileSync(process.env.OSTOYAE_BOARD,'utf8'));let peers=[],seen='';for(let n=0;n<100;n++){seen+=call('who');peers=seen.trim().split('\\n').filter(x=>/^a-[0-9]+\\s/.test(x));if(peers.length)break;await new Promise(r=>setTimeout(r,30))}
 if(!peers.length)throw Error('no peer');out.who=peers;
 if(a.of===b.attempts[0].of){if(seen.includes('from second'))out.read=seen;out.send=call('send',peers[0].split(' ')[0],'from first');if(out.send.includes('from second'))out.read=out.send;for(let n=0;n<100&&!out.read;n++){const r=call('read');if(r.includes('from second')){out.read=r;break}await new Promise(r=>setTimeout(r,30))}}
 else{if(seen.includes('from first'))out.read=seen;for(let n=0;n<100&&!out.read;n++){const r=call('read');if(r.includes('from first')){out.read=r;break}await new Promise(r=>setTimeout(r,30))}out.send=call('send','all','from second')}
 if(!out.read)throw Error('no message received');}
fs.writeFileSync(${JSON.stringify(temp)}+'/'+a.of+'.json',JSON.stringify(out));
fs.writeFileSync(a.of+'.txt','done');spawnSync('git',['add',a.of+'.txt']);spawnSync('git',['-c','user.name=fixture','-c','user.email=x@y','commit','-qm','done']);
fs.mkdirSync('.ostoyae',{recursive:true});fs.writeFileSync('.ostoyae/report.json','{}');`);
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  rmSync(board); rmSync(mailbox);
  ok(cmd(cli, ['init', board, '--exec', `node ${quote(stub)}`, '--item', 'First', '--item', 'Second']));
  let real = JSON.parse(readFileSync(board));
  real.sandbox.port_base = 44000;
  writeFileSync(board, JSON.stringify(real));
  const run = await launch(['go', board, '--launches', '2']);
  assert.equal(run.status, 0, run.stdout);
  real = JSON.parse(readFileSync(board));
  assert.equal(real.messages.length, 2, run.stdout + '\n' + JSON.stringify(real.attempts));
  assert.equal(real.last_run.messages, 2);
  assert(real.attempts.every(a => a.messaging.sent === 1 && a.messaging.read === 1));
  for (const w of real.work) {
    const path = join(temp, w.id + '.json');
    assert(existsSync(path), run.stdout + '\n' + JSON.stringify(real.attempts));
    const data = JSON.parse(readFileSync(path));
    assert(data.mailbox && data.path.split(':').includes(join(root, 'bin')));
    assert.match(data.contract, /## Messages from running peers/);
  }
  pass('messaging defaults on; concurrent stub cells exchange messages and record sends and reads');

  ok(cmd(cli, ['init', join(repo, 'off.json'), '--exec', `node ${quote(stub)}`, '--item', 'Off']));
  const offInitial = JSON.parse(readFileSync(join(repo, 'off.json')));
  offInitial.sandbox.port_base = 45000;
  writeFileSync(join(repo, 'off.json'), JSON.stringify(offInitial));
  const off = await launch(['go', join(repo, 'off.json'), '--launches', '1', '--no-messaging']);
  assert.equal(off.status, 0, off.stdout);
  const offBoard = JSON.parse(readFileSync(join(repo, 'off.json')));
  const offData = JSON.parse(readFileSync(join(temp, offBoard.work[0].id + '.json')));
  assert.equal(offData.mailbox, null);
  assert(!offData.path.split(':').includes(join(root, 'bin')));
  assert.doesNotMatch(offData.contract, /## Messages from running peers/);
  assert.equal(offBoard.messages, undefined);
  assert(!readdirSync(repo).some(x => x.startsWith('off.mail')));
  pass('--no-messaging creates no mailbox, PATH command or contract section');
  const disabled = join(repo, 'disabled.json');
  ok(cmd(cli, ['init', disabled, '--exec', `node ${quote(stub)}`, '--item', 'Disabled']));
  const disabledInitial = JSON.parse(readFileSync(disabled));
  disabledInitial.messaging = false; disabledInitial.sandbox.port_base = 46000;
  writeFileSync(disabled, JSON.stringify(disabledInitial));
  const disabledRun = await launch(['go', disabled, '--launches', '1']);
  assert.equal(disabledRun.status, 0, disabledRun.stdout);
  const disabledBoard = JSON.parse(readFileSync(disabled));
  assert.equal(JSON.parse(readFileSync(join(temp, disabledBoard.work[0].id + '.json'))).mailbox, null);
  pass('board messaging false disables default messaging');
  const help = JSON.parse(ok(cmd(cli, ['help', '--json'])));
  assert(help.commands.find(x => x.command === 'go').flags.some(x => x.flag === '--no-messaging'));
  pass('help JSON lists the flag');
} finally {
  if (process.env.KEEP) console.log(`Fixtures: ${temp}`); else rmSync(temp, { recursive: true, force: true });
}
console.log('Messaging rehearsal passed. No model calls.');
