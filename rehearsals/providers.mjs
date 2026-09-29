import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellEnvironment, commandWords, executorCommand, identifyExecutor, listProviders, shellQuote, findExecutable } from '../lib/providers.mjs';
import { configArgs } from '../executors/codex.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ostoyae-providers-')));
let passed = 0, failed = 0;
function test(name, fn) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { fn(); console.log(`  ok ${++passed}. ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
}
const run = (command, args, env = process.env, cwd = root, input) => spawnSync(command, args,
  { cwd, env, input, encoding: 'utf8', timeout: 30_000 });
const output = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

try {
  const bin = join(tmp, 'bin'); mkdirSync(bin);
  const repo = join(tmp, 'pursuit'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const graph = join(tmp, 'board.json');
  const board = { graph: 'providers', sandbox: { repo, root: join(tmp, 'cells'), env_passthrough: ['STUB_AUTH', 'STUB_MARKER'] },
    defaults: { model: 'provider/arbitrary:model+2026' }, work: [{ id: 'w', what: 'fixture', check: 'true' }], edges: [], attempts: [] };
  writeFileSync(graph, JSON.stringify(board));
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const provider = path.basename(process.argv[1]);
if (['auth', 'login'].includes(process.argv[2])) {
  fs.appendFileSync(process.env.STUB_MARKER, JSON.stringify({provider, args:process.argv.slice(2), home:process.env.HOME, token:process.env.FIXTURE_KEY})+'\\n');
  console.error('fake-secret-must-not-appear');
  process.exit(process.env.STUB_AUTH === 'yes' ? 0 : 1);
}
fs.writeFileSync(process.env.STUB_ARGV, JSON.stringify({args:process.argv.slice(2),config:process.env.OPENCODE_CONFIG_CONTENT}));
fs.mkdirSync('.ostoyae', {recursive:true});
fs.writeFileSync('.ostoyae/report.json', JSON.stringify({verdicts:[]}));
const malformed = process.env.STUB_USAGE === 'missing';
if(provider==='codex') console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,cached_input_tokens:1,output_tokens:2}}));
else if(provider==='claude') console.log(JSON.stringify({type:'result',usage:{input_tokens:1,output_tokens:2},total_cost_usd:0}));
else if(provider==='gemini') console.log(JSON.stringify({type:'result',status:'success',stats:{input:1,output_tokens:2,cached:0}}));
else if(provider==='opencode') {
  console.log(JSON.stringify({type:'step_finish',part:{cost:0.25,tokens:{input:3,output:2,cache:{read:1,write:0}}}}));
  console.log(JSON.stringify({type:'step_finish',part:malformed?{tokens:{output:1}}:{cost:0,tokens:{input:0,output:0,cache:{read:0,write:0}}}}));
}
else console.log('Tokens: 1 sent, 2 received. Cost: $0.00 message, $0.00 session.');
`;
  for (const provider of listProviders().filter((p) => p.cli)) writeFileSync(join(bin, provider.cli), stub, { mode: 0o755 });
  const marker = join(tmp, 'auth.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_MARKER: marker, STUB_AUTH: 'no' };
  const doctor = (command, environment = env, extra = []) => run(process.execPath, ['doctor.mjs', graph, '--exec', command, ...extra], environment);

  test('provider registry exposes all routes and never adds secrets to cell environments', () => {
    assert.deepEqual(listProviders().map((p) => p.id), ['claude', 'codex', 'gemini', 'aider', 'opencode', 'muse', 'grok', 'hermes', 'custom']);
    assert.deepEqual(cellEnvironment(['FIXTURE_KEY'], { HOME:'/home/me', FIXTURE_KEY:'keep', OTHER_KEY:'drop' }), { HOME:'/home/me', FIXTURE_KEY:'keep' });
    assert.throws(() => cellEnvironment(['API_KEY=value']), /variable names/);
    assert.throws(() => executorCommand('unknown', root), /unknown provider/);
  });
  test('quoted installation paths round trip, including apostrophes', () => {
    const command = executorCommand('claude', "/tmp/a user's directory");
    assert.equal(identifyExecutor(command).executable, "/tmp/a user's directory/executors/claude.sh");
    assert.equal(identifyExecutor(command).provider, 'claude');
    assert.deepEqual(commandWords("env NAME='two words' bash -e 'a b.sh'"), ['env', 'NAME=two words', 'bash', '-e', 'a b.sh']);
  });
  for (const [provider, wrapper] of [['codex', 'bash -e'], ['claude', '/bin/bash'], ['claude', 'env /bin/bash -eu'], ['codex', '/usr/bin/env bash -o pipefail']]) {
    test(`${wrapper} cannot bypass ${provider} authentication failure`, () => {
      const r = doctor(`${wrapper} ${shellQuote(join(root, 'executors', `${provider}.sh`))}`);
      assert.equal(r.status, 1, output(r));
      assert.match(output(r), /executor auth.*failed/);
      assert.doesNotMatch(output(r), /ready to launch|fake-secret-must-not-appear/);
    });
  }
  test('quoted script path with spaces and apostrophes is checked', () => {
    const dir = join(tmp, "user's adapter dir"); mkdirSync(dir);
    symlinkSync(join(root, 'executors', 'claude.sh'), join(dir, 'claude.sh'));
    const r = doctor(`/bin/bash -e ${shellQuote(join(dir, 'claude.sh'))}`);
    assert.equal(r.status, 1, output(r)); assert.match(output(r), /executor auth.*failed/);
  });
  test('env assignments reach the exact auth status call without logging values', () => {
    const r = doctor(`env HOME=${shellQuote(join(tmp, 'another home'))} FIXTURE_KEY='secret fixture value' STUB_AUTH=yes bash ${shellQuote(join(root, 'executors', 'claude.sh'))}`);
    assert.equal(r.status, 0, output(r));
    const event = JSON.parse(readFileSync(marker, 'utf8').trim().split('\n').at(-1));
    assert.equal(event.home, join(tmp, 'another home')); assert.equal(event.token, 'secret fixture value');
    assert.deepEqual(event.args, ['auth', 'status']);
    assert.doesNotMatch(output(r), /secret fixture value|fake-secret-must-not-appear/);
  });
  test('env unset after an assignment stays unset; ignored environments stay explicit', () => {
    const parsed = identifyExecutor('FIXTURE_KEY=first env -u FIXTURE_KEY bash /tmp/claude.sh');
    assert.equal(parsed.environment.FIXTURE_KEY, undefined); assert.deepEqual(parsed.unset, ['FIXTURE_KEY']);
    const cleared = identifyExecutor('env -i PATH=/usr/bin HOME=/tmp bash /tmp/codex.sh');
    assert.equal(cleared.clearEnvironment, true); assert.equal(cleared.environment.HOME, '/tmp');
  });
  test('wrapper environments are resolved in order, including nested env PATH changes', () => {
    const first = join(tmp, 'wrapper-first'), last = join(tmp, 'wrapper-last');
    mkdirSync(first); mkdirSync(last);
    symlinkSync(findExecutable('env'), join(first, 'env'));
    const script = join(tmp, 'custom.sh'); writeFileSync(script, 'exit 0\n');
    const command = `env -i PATH=${shellQuote(first)} env PATH=${shellQuote(last)} /bin/bash ${shellQuote(script)}`;
    const contexts = identifyExecutor(command).wrapperContexts;
    assert.deepEqual(contexts.map((c) => c.environment.PATH), [undefined, first, last]);
    assert.deepEqual(contexts.map((c) => c.clearEnvironment), [false, true, true]);
    const actual = run('/bin/sh', ['-c', command]);
    assert.equal(actual.status, 0, output(actual));
    const good = doctor(command);
    assert.equal(good.status, 0, output(good));
    const badCommand = `env -i PATH=${shellQuote(last)} env PATH=${shellQuote(first)} /bin/bash ${shellQuote(script)}`;
    const actualBad = run('/bin/sh', ['-c', badCommand]);
    assert.notEqual(actualBad.status, 0, output(actualBad));
    const bad = doctor(badCommand);
    assert.equal(bad.status, 1, output(bad));
    assert.match(output(bad), /env is not on PATH when its wrapper is invoked/);
  });
  test('unknown commands and shell startup logic never claim verified authentication', () => {
    const r = doctor('true'); assert.equal(r.status, 0, output(r)); assert.match(output(r), /authentication UNVERIFIED/);
    for (const command of ['bash -lc "claude"', 'bash -c \'claude && true\'', '$WRAPPER claude']) {
      const r = doctor(command); assert.match(output(r), /authentication UNVERIFIED/);
      assert.doesNotMatch(output(r), /reports authentication/);
    }
  });
  test('missing commands and malformed quoting fail before launch', () => {
    for (const command of ['missing-executor-command', "bash 'unfinished"]) {
      const r = doctor(command); assert.equal(r.status, 1, output(r)); assert.match(output(r), /Not safe to launch/);
    }
  });
  test('a sanitized machine PATH reports missing bash, git, and python3', () => {
    const minimal = join(tmp, 'minimal'); mkdirSync(minimal);
    symlinkSync(process.execPath, join(minimal, 'node'));
    symlinkSync(join(bin, 'claude'), join(minimal, 'claude'));
    const r = doctor(executorCommand('claude', root), { ...env, PATH:minimal });
    assert.equal(r.status, 1, output(r));
    for (const name of ['bash', 'git', 'python3']) assert.match(output(r), new RegExp(`${name} is not on PATH`));
  });
  test('doctor model override is in memory and no auth probe calls a model', () => {
    const before = readFileSync(graph, 'utf8');
    const r = doctor(executorCommand('codex', root), { ...env, STUB_AUTH:'yes' }, ['--model','arbitrary-model']);
    assert.equal(r.status, 0, output(r)); assert.equal(readFileSync(graph, 'utf8'), before);
    const events = readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse);
    assert(events.every((ev) => ['auth', 'login'].includes(ev.args[0]) && ev.args[1] === 'status'));
  });
  test('doctor JSON is one parseable object with blocking reasons and the same exit status', () => {
    for (const authenticated of ['yes', 'no']) {
      const r = doctor(executorCommand('claude', root), { ...env, STUB_AUTH:authenticated }, ['--json']);
      const report = JSON.parse(r.stdout);
      assert.equal(report.ready, authenticated === 'yes');
      assert.equal(r.status, report.ready ? 0 : 1);
      assert.equal(report.blocking, report.rows.filter((row) => row.state === 'FAIL').length);
      assert(report.rows.some((row) => row.name === 'executor auth'));
      assert.doesNotMatch(r.stdout, /fake-secret-must-not-appear/);
    }
  });
  test('Codex forwards model names with no whitelist while preserving isolation flags', () => {
    for (const model of ['opus', 'provider/arbitrary:model+2026', "model's literal name"]) {
      const args = configArgs({ model }, {}, repo);
      assert.equal(args[args.indexOf('--model')+1], model);
      assert(args.includes('--ignore-user-config')); assert(args.some((v) => v.includes('permissions.ostoyae-cell')));
    }
    const imported = run(process.execPath, ['--input-type=module', '-'], process.env, root,
      "await import('./executors/codex.mjs'); console.log('imported');");
    assert.equal(imported.status, 0, output(imported)); assert.equal(imported.stdout.trim(), 'imported');
  });
  for (const provider of listProviders().filter((p) => p.cli)) {
    test(`${provider.id} adapter passes the model unchanged to its CLI`, () => {
      const cwd = join(tmp, provider.id); mkdirSync(cwd);
      const argvFile = join(cwd, 'argv.json');
      const model = "provider/model's literal:2026+preview";
      const r = run(findExecutable('bash'), [join(root, 'executors', `${provider.id}.sh`)],
        { ...env, STUB_ARGV:argvFile, OSTOYAE_ATTEMPT:'fixture', OSTOYAE_WORK:'w',
          OPENCODE_CONFIG_CONTENT:JSON.stringify({provider:{fixture:{name:'preserved'}},permission:{edit:'allow'}}) }, cwd,
        JSON.stringify({ id:'fixture', of:'w', what:'fixture', kind:'verify', params:{model} }));
      assert.equal(r.status, 0, output(r));
      const saved = JSON.parse(readFileSync(argvFile));
      const index = saved.args.findIndex((arg) => ['--model','-m'].includes(arg));
      assert(index >= 0); assert.equal(saved.args[index+1], model);
      if (provider.id === 'opencode') {
        const config = JSON.parse(saved.config);
        assert.equal(config.provider.fixture.name, 'preserved');
        assert.equal(config.permission.bash.git, 'deny'); assert.equal(config.permission.edit, 'allow');
      }
    });
  }
  test('OpenCode missing usage cannot turn a partial total into a known zero or subtotal', () => {
    const cwd = join(tmp, 'opencode-missing'); mkdirSync(cwd);
    const r = run(findExecutable('bash'), [join(root, 'executors/opencode.sh')],
      { ...env, STUB_ARGV:join(cwd,'argv.json'), STUB_USAGE:'missing', OSTOYAE_ATTEMPT:'fixture', OSTOYAE_WORK:'w' }, cwd,
      JSON.stringify({ id:'fixture', of:'w', kind:'verify', params:{model:'fixture'} }));
    assert.equal(r.status, 0, output(r));
    const usage = JSON.parse(readFileSync(join(cwd,'.ostoyae/usage.json')));
    assert.equal(usage.cost_usd, null); assert.equal(usage.input_tokens, null);
    assert.equal(usage.cache_read_input_tokens, null); assert.equal(usage.output_tokens, 3);
    assert.match(usage._bad, /incomplete/); assert.match(output(r), /cost=\?/);
  });
  test('malformed OpenCode configuration fails before invoking the agent', () => {
    const cwd = join(tmp, 'opencode-invalid'); mkdirSync(cwd);
    const r = run(findExecutable('bash'), [join(root, 'executors/opencode.sh')],
      { ...env, OPENCODE_CONFIG_CONTENT:'{broken', OSTOYAE_ATTEMPT:'fixture', OSTOYAE_WORK:'w' }, cwd,
      JSON.stringify({ id:'fixture', of:'w', kind:'verify' }));
    assert.equal(r.status, 1, output(r)); assert.match(output(r), /JSONDecodeError/);
  });
} finally {
  rmSync(tmp, { recursive:true, force:true });
}
console.log(`\n${passed} passed; ${failed} failed; zero model calls.`);
process.exitCode = failed || !passed ? 1 : 0;
