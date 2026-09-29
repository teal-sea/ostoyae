// Exercise the installed executable, not just bin/ostoyae in a source checkout.
// Everything stays in temporary directories. No agent, network or credentials are used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ostoyae-onboarding-')));
const env = { ...process.env, npm_config_update_notifier: 'false', OSTOYAE_STATE_DIR: join(temp, 'state') };
delete env.OSTOYAE_GRAPH;
delete env.OSTOYAE_CWD;
delete env.OSTOYAE_EXEC;
let checks = 0, failures = 0;
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
const ok = r => { assert.equal(r.status, 0, r.error?.message ?? r.stderr + r.stdout); return r.stdout; };
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${checks}. ${name}: ${e.message}`); }
};
const repo = join(temp, "reader's repo.json");
const git = (...args) => ok(run('git', args, repo));
const board = name => JSON.parse(readFileSync(join(repo, name), 'utf8'));
let cli, installed;

try {
  // npm creates the same relative executable symlink that npx uses. Install offline so a
  // published package with a similar name can never accidentally satisfy this test.
  const packed = JSON.parse(ok(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root)))[0];
  const consumer = join(temp, "reader's installation"); mkdirSync(consumer);
  ok(run('npm', ['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(temp, packed.filename)], consumer));
  cli = join(consumer, 'node_modules/.bin/ostoyae');
  installed = join(consumer, 'node_modules/ostoyae');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ostoyae rehearsal');
  git('config', 'user.email', 'rehearsal@ostoyae.invalid');

  test('an unborn branch explains that it needs a commit', () => {
    const r = run(join(root, 'bin/ostoyae'), ['init', '--item', 'hello'], repo);
    assert.equal(r.status, 2); assert.match(r.stderr, /no commit.*yet/);
    assert.doesNotMatch(r.stderr, /at .*init\.mjs|Command failed/);
    assert(!existsSync(join(repo, 'ostoyae.json')));
  });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  mkdirSync(join(repo, 'node_modules'));
  git('add', '.'); git('commit', '-qm', 'start');

  test('an installed executable initializes the caller repository', () => {
    ok(run(cli, ['init', '--item', 'Build a greeting'], repo));
    const g = board('ostoyae.json');
    assert.equal(g.sandbox.repo, repo); assert.equal(g.sandbox.base, 'main');
    assert.deepEqual(g.sandbox.link, ['node_modules']);
    assert.equal(g.work[0].check, 'npm test'); assert.deepEqual(g.attempts, []);
  });
  test('init preserves valued arguments ending in .json', () => {
    ok(run(cli, ['init', 'custom.json', '--repo', repo, '--item', 'Update package.json', '--item', 'Validate config.json', '--check', 'node verify.json'], repo));
    const g = board('custom.json');
    assert.deepEqual(g.work.map(w => w.what), ['Update package.json', 'Validate config.json']);
    assert.equal(g.work[0].check, 'node verify.json');
  });
  test('init refuses extra board names without writing either', () => {
    const r = run(cli, ['init', 'first.json', 'second.json', '--item', 'hello'], repo);
    assert.equal(r.status, 2); assert.match(r.stderr, /unexpected argument/);
    assert(!existsSync(join(repo, 'first.json')) && !existsSync(join(repo, 'second.json')));
  });
  test('init refuses overwrite and --force explicitly replaces the board', () => {
    const before = readFileSync(join(repo, 'ostoyae.json'), 'utf8');
    const r = run(cli, ['init', '--item', 'Replacement'], repo);
    assert.equal(r.status, 2); assert.match(r.stderr, /already exists/);
    assert.equal(readFileSync(join(repo, 'ostoyae.json'), 'utf8'), before);
    ok(run(cli, ['init', '--item', 'Replacement', '--force'], repo));
    assert.equal(board('ostoyae.json').work[0].what, 'Replacement');
  });
  test('installed dry uses the caller board and never rewrites its record', () => {
    const before = readFileSync(join(repo, 'ostoyae.json'), 'utf8');
    assert.match(ok(run(cli, ['dry'], repo)), /dry run:.*not written/);
    assert.equal(readFileSync(join(repo, 'ostoyae.json'), 'utf8'), before);
  });
  test('relative OSTOYAE_GRAPH resolves from the caller directory', () => {
    env.OSTOYAE_GRAPH = 'custom.json';
    try { assert.match(ok(run(cli, ['dry'], repo)), /custom\.json not written/); }
    finally { delete env.OSTOYAE_GRAPH; }
  });
  test('doctor finds a fake executor in an installation path with spaces and apostrophes', () => {
    const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
    env.OSTOYAE_EXEC = `bash ${quote(join(installed, 'executors/fake.sh'))}`;
    try { assert.match(ok(run(cli, ['doctor'], repo)), /ready|READY/i); }
    finally { delete env.OSTOYAE_EXEC; }
  });
  const stubDir = join(temp, 'stub-bin'); mkdirSync(stubDir);
  const authLog = join(temp, 'auth-calls.json');
  const authExit = join(temp, 'auth-exit');
  const stub = join(stubDir, 'claude');
  writeFileSync(stub, `#!/usr/bin/env node\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(authLog)}, JSON.stringify(process.argv.slice(2)));
console.log('synthetic-private-account-detail');
if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(99);
process.exit(Number(fs.readFileSync(${JSON.stringify(authExit)}, 'utf8')));\n`);
  chmodSync(stub, 0o755);
  for (const status of [0, 1, 2]) test(`Claude preflight uses auth status only, including exit ${status}`, () => {
    const oldPath = env.PATH; env.PATH = `${stubDir}:${oldPath}`;
    writeFileSync(authExit, String(status));
    try {
      const r = run(cli, ['doctor'], repo);
      assert.equal(r.status, status ? 1 : 0, r.stderr + r.stdout);
      assert.deepEqual(JSON.parse(readFileSync(authLog)), ['auth', 'status']);
      assert.match(r.stdout, status ? /auth status failed/ : /no model call made/);
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-private-account-detail/);
    } finally { env.PATH = oldPath; }
  });
  test('detached HEAD uses the current commit for cloud checkouts', () => {
    git('checkout', '-q', '--detach');
    try {
      const r = run(cli, ['init', 'detached.json', '--item', 'hello'], repo);
      ok(r);
      assert.equal(board('detached.json').sandbox.base, git('rev-parse', 'HEAD').trim());
    } finally { git('checkout', '-q', 'main'); }
  });
  const empty = join(temp, 'empty'); mkdirSync(empty);
  test('commands with no board point to init instead of the lab example', () => {
    for (const cmd of ['go', 'doctor', 'dry', 'watch', 'status', 'stop', 'confirm', 'reject', 'confirm-scoped']) {
      const r = run(cli, [cmd], empty);
      assert.equal(r.status, 2, cmd + ': ' + r.stderr);
      assert.match(r.stderr, /no board.*run.*init/i);
      assert.doesNotMatch(r.stderr, /mathlib|ENOENT|Cannot find module/);
    }
  });
  test('an explicitly missing board gets a useful error', () => {
    const r = run(cli, ['dry', 'missing.json'], empty);
    assert.equal(r.status, 2); assert.match(r.stderr, /board not found/);
  });
  test('graph.local.json stays relative to the engine and does not attach an unrelated directory', () => {
    writeFileSync(join(installed, 'chosen.json'), readFileSync(join(repo, 'ostoyae.json')));
    writeFileSync(join(installed, 'graph.local.json'), JSON.stringify({ graph: 'chosen.json' }));
    try {
      assert.match(ok(run(cli, ['dry'], installed)), /chosen\.json not written/);
      const r = run(cli, ['dry'], empty); assert.equal(r.status, 2); assert.match(r.stderr, /no board selected/);
    }
    finally { rmSync(join(installed, 'graph.local.json')); }
  });
  test('an explicit board wins over OSTOYAE_GRAPH', () => {
    env.OSTOYAE_GRAPH = 'does-not-exist.json';
    try { assert.match(ok(run(cli, ['dry', join(repo, 'ostoyae.json')], empty)), /ostoyae\.json not written/); }
    finally { delete env.OSTOYAE_GRAPH; }
  });
  test('a second symlink still resolves the installed launcher', () => {
    const alias = join(temp, 'ostoyae-alias'); symlinkSync(cli, alias);
    assert.match(ok(run(alias, ['dry'], repo)), /dry run:.*not written/);
  });
  test('the installed campaign entry point restores a board without model calls or remote writes', () => {
    writeFileSync(join(repo, 'campaign-fixture.json'), JSON.stringify({ graph: 'installed-campaign',
      sandbox: { repo, base: 'main' }, work: [], edges: [], attempts: [] }));
    git('add', 'campaign-fixture.json'); git('commit', '-qm', 'campaign fixture');
    const before = git('for-each-ref', '--format=%(refname) %(objectname)');
    const result = run(cli, ['campaign', '--repo', repo, '--board', 'campaign-fixture.json',
      '--branch', 'codex/installed-campaign', '--dir', join(temp, 'campaign'), '--check'], empty);
    assert.match(ok(result), /0 session\(s\).*nothing run or pushed/);
    assert.equal(git('for-each-ref', '--format=%(refname) %(objectname)'), before);
    assert.ok(existsSync(join(installed, 'campaign.mjs')));
  });
} finally { rmSync(temp, { recursive: true, force: true }); }

console.log(`\n  ${checks} onboarding checks, ${failures} failed. No model calls.`);
process.exitCode = failures ? 1 : 0;
