// Portable CLI behavior using disposable repositories and a zero-model executor.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveExecution, terminalMode } from '../lib/cli-config.mjs';
import { terminal } from '../lib/terminal.mjs';
import { captureIdentity } from '../lib/process-identity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = realpathSync(mkdtempSync(join(tmpdir(), "ostoyae cli's ")));
const repo = join(temp, 'pursuit'), home = join(temp, 'home'), bin = join(temp, 'bin');
for (const path of [repo, home, bin]) mkdirSync(path);
const cli = join(root, 'bin/ostoyae');
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OSTOYAE_') && !name.startsWith('CLAUDE_') && !name.startsWith('CODEX_') && !name.startsWith('ANTHROPIC_')));
Object.assign(env, { HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1', OSTOYAE_NO_OPEN: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
let checks = 0, failures = 0;
const test = async (name, run) => { checks++; try { await run(); console.log(`  ok ${checks}. ${name}`); } catch (e) { failures++; console.error(`  FAIL ${checks}. ${name}\n${e.stack}`); } };
// A launch includes Git provisioning and process-identity probes. Give those bounded
// operations room on a busy shared host; the fake executor and launch cap are unchanged.
const run = (args, extra = {}) => spawnSync(cli, args, { cwd: repo, env, encoding: 'utf8', timeout: args[0] === 'go' ? 120_000 : 30_000, ...extra });
const ok = result => { assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? '')); return result.stdout; };
const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const file = join(repo, 'ostoyae.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));
const write = value => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const fake = join(bin, 'fake executor.mjs'), log = join(temp, 'attempt.json');
writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const a = JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(a));
fs.mkdirSync('.ostoyae',{recursive:true});
fs.writeFileSync('result.txt', 'fixture completed');
execFileSync('git',['add','result.txt']);
execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture work']);
fs.writeFileSync('.ostoyae/usage.json', JSON.stringify({cost_usd:0,output_tokens:0,input_tokens:0,model:a.params.model??'fixture'}));
console.log('FIXTURE WORK COMPLETE; 0 model calls');
`, { mode: 0o755 });
const executor = `node ${quote(fake)}`;
for (const name of ['claude', 'codex', 'gemini', 'aider', 'opencode', 'muse', 'grok', 'hermes']) writeFileSync(join(bin, name), '#!/bin/sh\necho "a real provider must not run in this test" >&2\nexit 97\n', { mode: 0o755 });

try {
  await test('help, setup and version work without a board', () => {
    for (const args of [[], ['--help'], ['setup'], ['init', '--help']]) assert.match(ok(run(args)), /^\s*ostoyae\b/m);
    assert.match(ok(run(['--version'])), /^ostoyae \d+\.\d+\.\d+/);
    assert(!existsSync(file));
  });
  await test('providers inventory does not call provider CLIs', () => {
    const result = JSON.parse(ok(run(['providers', '--json'])));
    assert.deepEqual(result.providers.map(p => p.id), ['claude', 'codex', 'gemini', 'aider', 'opencode', 'muse', 'grok', 'hermes', 'custom']);
    assert(result.providers.filter(p => p.cli).every(p => p.installed));
  });
  await test('help exposes a machine-readable command and flag contract', () => {
    const schema = JSON.parse(ok(run(['help', '--json'])));
    assert.equal(schema.schema_version, 1);
    assert(schema.commands.find(c => c.command === 'go').flags.some(f => f.flag === '--json'));
    for (const command of ['init', 'go', 'doctor', 'dry'])
      assert(schema.commands.find(c => c.command === command).flags.some(f => f.flag === '--effort'));
    assert(schema.commands.find(c => c.command === 'go').invokes_models);
    assert(!schema.commands.find(c => c.command === 'doctor').invokes_models);
    const failure = run(['status', '--json', '--unknown']);
    assert.equal(failure.status, 2); assert.equal(JSON.parse(failure.stdout).ok, false);
  });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  await test('setup persists provider, opaque model, profile and environment names', () => {
    ok(run(['setup', '--agent', 'codex', '--model', 'provider/new-model:preview', '--effort', 'medium', '--profile', 'claude-cloud', '--env', 'OPENAI_API_KEY', '--env', 'OPENAI_API_KEY', '--item', 'Update package.json']));
    const board = read(); assert.deepEqual(board.execution, { provider: 'codex', profile: 'claude-cloud' });
    assert.equal(board.defaults.model, 'provider/new-model:preview'); assert.equal(board.defaults.effort, 'medium'); assert.deepEqual(board.sandbox.env_passthrough, ['OPENAI_API_KEY']);
    assert.equal(board.work[0].what, 'Update package.json'); assert.equal(board.sandbox.repo, repo);
  });
  await test('custom execution persists an exact shell command and does not store secrets', () => {
    const value = 'fixture-private-value';
    ok(run(['init', '--exec', executor, '--model', 'local/model:tag', '--env', 'FIXTURE_TOKEN', '--item', 'Do work', '--force'], { env: { ...env, FIXTURE_TOKEN: value } }));
    assert.deepEqual(read().execution, { provider: 'custom', profile: 'auto', command: executor });
    assert(!readFileSync(file, 'utf8').includes(value));
  });
  await test('provider and executor precedence is CLI, environment, board, default', () => {
    const board = { execution: { provider: 'gemini', profile: 'headless' } };
    assert.equal(resolveExecution(board, { agent: 'codex' }, { OSTOYAE_EXEC: executor }, root).provider, 'codex');
    assert.equal(resolveExecution(board, { exec: executor }, { OSTOYAE_EXEC: 'false' }, root).command, executor);
    assert.equal(resolveExecution(board, {}, { OSTOYAE_EXEC: executor }, root).command, executor);
    assert.equal(resolveExecution(board, {}, {}, root).provider, 'gemini');
    assert.equal(resolveExecution({}, {}, {}, root).provider, 'claude');
    assert.equal(resolveExecution({ defaults: { model: 'saved' } }, { model: 'arbitrary/new' }, {}, root).model, 'arbitrary/new');
    assert.equal(resolveExecution({ defaults: { effort: 'low' } }, { effort: 'ultra' }, {}, root).effort, 'ultra');
    assert.throws(() => resolveExecution(board, { agent: 'claude', exec: executor }, {}, root), /custom executor/);
  });
  await test('invalid configuration and contradictory flags are explicit errors', () => {
    for (const execution of [null, [], { provider: 'unknown' }, { provider: 'custom' }, { provider: 'claude', command: 'false' }, { profile: 'magic' }, { profile: null }]) {
      assert.throws(() => resolveExecution({ execution }, {}, {}, root));
    }
    for (const args of [['go', '--usd', 'NaN'], ['go', '--launches', '1.5'], ['go', '--agent', 'made-up'], ['go', '--model'], ['go', '--effort', 'too.long'], ['status', '--wat'], ['watch', '--terminal', '--browser']]) assert.equal(run(args).status, 2, args.join(' '));
    assert(!existsSync(log));
  });
  await test('profiles choose headless mode without changing credentials or permissions', () => {
    for (const profile of ['headless', 'claude-cloud']) assert.equal(terminalMode(profile, {}, {}, true), true);
    for (const environment of [{ SSH_CONNECTION: 'fixture' }, { CI: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) assert.equal(terminalMode('auto', {}, environment, true), true);
    assert.equal(terminalMode('auto', {}, {}, false), true);
    const options = { terminal: true }; assert.equal(terminalMode('local', options, {}, true), true); assert.deepEqual(options, { terminal: true });
  });
  await test('status and dry preserve the board while applying in-memory model options', () => {
    const before = readFileSync(file, 'utf8');
    const data = JSON.parse(ok(run(['status', '--json', '--model', 'different/model'])));
    assert.equal(data.execution.model, 'different/model'); assert.equal(data.attempts.total, 0); assert.equal(data.spend.unpriced, 0);
    assert.match(ok(run(['dry', '--model', 'different/model'])), /not written/);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
  await test('status distinguishes known zero usage from missing usage and unknown states', () => {
    const original = read(), board = structuredClone(original);
    board.attempts = [{ id: 'a-1', of: board.work[0].id, state: 'failed', result: { why: 'fixture failure', usage: { cost_usd: 0, output_tokens: 0 } } },
      { id: 'a-2', of: board.work[0].id, state: 'unknown-fixture' }];
    board.last_run = { ended: '2026-09-12T00:00:00Z', launched: 0, why: 'zero ready work', next: 'review the wall', invocation_allowance: 8 };
    write(board);
    try {
      const data = JSON.parse(ok(run(['status', '--json'])));
      assert.equal(data.spend.usd, 0); assert.equal(data.spend.priced, 1); assert.equal(data.spend.unpriced, 1);
      assert.equal(data.spend.token_measured, 1); assert.equal(data.spend.unmeasured_tokens, 1); assert.equal(data.attempts.unknown, 1);
      assert.equal(data.last_run.launched, 0); assert.equal(data.reason, 'zero ready work'); assert.match(ok(run(['status'])), /0 launched/);
    } finally { write(original); }
  });
  await test('corrupt boards and heartbeats never appear as empty or inactive', () => {
    const before = readFileSync(file, 'utf8'), runfile = file.replace('.json', '.run.json');
    writeFileSync(file, '{'); assert.equal(run(['status', '--json']).status, 2); writeFileSync(file, before);
    writeFileSync(runfile, '{');
    try { const r = run(['status']); assert.equal(r.status, 2); assert.match(r.stderr, /invalid JSON.*heartbeat/); }
    finally { rmSync(runfile); }
  });
  await test('a recycled runner PID is reported gone, not live', () => {
    const runfile = file.replace('.json', '.run.json');
    writeFileSync(runfile, JSON.stringify({ pid: process.pid, beat: new Date().toISOString(),
      identity: { ...captureIdentity(process.pid, { runnerFile: file }), boot: 'another-boot' } }));
    try { assert.equal(JSON.parse(ok(run(['status', '--json']))).runner.state, 'gone'); }
    finally { rmSync(runfile); }
  });
  await test('a damaged identity is unknown, never a stopped runner', () => {
    const runfile = file.replace('.json', '.run.json');
    writeFileSync(runfile, JSON.stringify({ pid: process.pid, beat: new Date().toISOString(), identity: {} }));
    try { assert.equal(JSON.parse(ok(run(['status', '--json']))).runner.state, 'unknown'); }
    finally { rmSync(runfile); }
  });
  await test('force cannot erase the board while a run record exists', () => {
    const before = readFileSync(file, 'utf8'), runfile = file.replace('.json', '.run.json');
    writeFileSync(runfile, JSON.stringify({ pid: process.pid, identity: captureIdentity(process.pid), beat: new Date().toISOString() }));
    try { assert.equal(run(['init', '--force', '--item', 'replacement']).status, 2); assert.equal(readFileSync(file, 'utf8'), before); }
    finally { rmSync(runfile); }
  });
  await test('cloud setup accepts an existing detached commit', () => {
    const commit = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach');
    try { ok(run(['init', 'detached.json', '--profile', 'claude-cloud', '--item', 'work'])); assert.equal(JSON.parse(readFileSync(join(repo, 'detached.json'))).sandbox.base, commit); }
    finally { git('checkout', '-q', 'main'); }
  });
  await test('environment name validation never accepts inline credentials', () => {
    const before = readFileSync(file, 'utf8'); const r = run(['init', '--force', '--env', 'API_KEY=secret']);
    assert.equal(r.status, 2); assert.doesNotMatch(r.stderr, /API_KEY=secret/); assert.equal(readFileSync(file, 'utf8'), before);
  });
  await test('a malformed package manifest is reported without writing a board', () => {
    writeFileSync(join(repo, 'package.json'), '{');
    try { const r = run(['init', 'broken-package.json']); assert.equal(r.status, 2); assert.match(r.stderr, /invalid JSON.*package/); assert(!existsSync(join(repo, 'broken-package.json'))); }
    finally { rmSync(join(repo, 'package.json')); }
  });
  await test('terminal output fits a phone width and respects NO_COLOR', () => {
    const t = terminal({ isTTY: true, columns: 39 }, { TERM: 'xterm-256color', NO_COLOR: '' });
    const text = t.heading('An extremely long board title for a narrow phone terminal', 'Useful progress') + '\n' + t.row('Model', 'organization/very-long-model-name-with-an-arbitrary-version:preview');
    assert.doesNotMatch(text, /\x1b\[/);
    assert(text.split('\n').every(line => line.length <= 39));
    assert.match(terminal({ isTTY: true, columns: 80 }, { TERM: 'xterm-256color' }).heading('Ready', 'Progress'), /\x1b\[/);
    assert.doesNotMatch(terminal({ isTTY: false, columns: 80 }, { FORCE_COLOR: '3' }).heading('Ready', 'Progress'), /\x1b\[/);
  });
  await test('watch --once is a finite plain-text snapshot', () => {
    const before = readFileSync(file, 'utf8'), output = ok(run(['watch', '--terminal', '--once']));
    assert.match(output, /No attempts recorded yet/); assert.doesNotMatch(output, /\x1b\[/); assert.equal(readFileSync(file, 'utf8'), before);
  });
  await test('terminal watcher handles SIGTERM and leaves the board untouched', async () => {
    const before = readFileSync(file, 'utf8');
    const watcher = spawn(cli, ['watch', '--terminal', '--interval', '100'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; watcher.stdout.on('data', b => { output += b; if (output.includes('Watching every')) watcher.kill('SIGTERM'); });
    watcher.stderr.on('data', b => { error += b; });
    const timeout = setTimeout(() => watcher.kill('SIGKILL'), 10_000);
    const code = await new Promise(resolve => watcher.on('close', resolve)); clearTimeout(timeout);
    assert.equal(code, 0, error); assert.equal(readFileSync(file, 'utf8'), before);
  });
  await test('CLI flags select the same executor for doctor and headless launch', () => {
    const before = read();
    const output = ok(run(['go', '--headless', '--exec', executor, '--model', 'fixture/runtime-model', '--effort', 'high', '--launches', '1'], { env: { ...env, OSTOYAE_EXEC: 'false', OSTOYAE_PORT: 'not-a-port' } }));
    assert.match(output, /FIXTURE WORK COMPLETE/); assert.doesNotMatch(output, /viewer ready/);
    const board = read(); assert.equal(board.attempts.length, 1); assert.equal(board.attempts[0].state, 'done'); assert.equal(board.last_run.launched, 1);
    assert.equal(JSON.parse(readFileSync(log)).params.model, 'fixture/runtime-model');
    assert.equal(JSON.parse(readFileSync(log)).params.effort, 'high');
    assert.equal(board.attempts[0].result.usage.effort, 'high');
    assert.equal(board.defaults.model, before.defaults.model, 'runtime model does not rewrite saved defaults');
    assert.equal(board.defaults.effort, before.defaults.effort, 'runtime effort does not rewrite saved defaults');
  });
  await test('doctor and go JSON have pure stdout and report zero work', () => {
    const doctor = JSON.parse(ok(run(['doctor', '--json'])));
    assert.equal(doctor.ready, true); assert(Array.isArray(doctor.rows));
    const result = run(['go', '--json', '--launches', '1']);
    const output = JSON.parse(ok(result));
    assert.equal(output.ok, true); assert.equal(output.exit_code, 0); assert.equal(output.phase, 'finished');
    assert.equal(output.last_run.launched, 0); assert.match(result.stderr, /ready|Ready|queue emptied/);
    assert.equal(read().attempts.length, 1);
  });
  await test('go refuses missing, zero and reservation-only budgets before preflight', () => {
    const before = readFileSync(file, 'utf8');
    for (const args of [[], ['--launches', '0'], ['--usd', '0'], ['--reserve-usd', '1']]) {
      const result = run(['go', '--json', ...args]);
      assert.equal(result.status, 2); assert.match(JSON.parse(result.stdout).error, /positive budget/);
      assert.doesNotMatch(result.stderr, /ready to launch/); assert.equal(readFileSync(file, 'utf8'), before);
    }
  });
  await test('go JSON reports failed preflight without starting an attempt', () => {
    const before = readFileSync(file, 'utf8');
    const result = run(['go', '--json', '--agent', 'claude', '--launches', '1']);
    assert.equal(result.status, 1); const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false); assert.equal(output.phase, 'preflight');
    assert.equal(readFileSync(file, 'utf8'), before);
  });
  await test('no-TTY and SSH launches work without any viewer port', () => {
    for (const extra of [{}, { SSH_CONNECTION: 'fixture' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
      const output = ok(run(['go', '--launches', '1'], { env: { ...env, ...extra, OSTOYAE_PORT: 'not-a-port' } }));
      assert.match(output, /0 launched|nothing to launch/); assert.equal(read().attempts.length, 1);
    }
  });
  await test('a second symlink resolves the CLI from a path with spaces and apostrophes', () => {
    const alias = join(bin, 'alias'); symlinkSync(cli, alias);
    const output = ok(spawnSync(alias, ['status', '--json'], { cwd: repo, env, encoding: 'utf8' }));
    assert.equal(JSON.parse(output).graph, read().graph);
  });
  await test('a browser request reports a port conflict before returning success', async () => {
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.end('not http'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const p = spawn(cli, ['watch', '--browser'], { cwd: repo, env: { ...env, OSTOYAE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
      const code = await new Promise(resolve => p.on('close', resolve));
      assert.notEqual(code, 0); assert.match(output, /viewer.*(exited|log)/);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`\n  ${checks} CLI checks, ${failures} failed. No model calls.`);
process.exitCode = failures ? 1 : 0;
