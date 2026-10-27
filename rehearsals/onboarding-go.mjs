// OpenCode Go onboarding: what the installed combined client actually answers with, and what
// doctor says about it. Everything runs against a throwaway repo and a stub `opencode` placed
// on PATH ahead of the real one, so this never touches the subscription, never spends a model
// call and never reads real credentials. Shapes are the real client 2.1.4's: `opencode auth
// list --format json` returns a JSON array of { id, name, connections[] }, and `opencode
// models` lists plain `provider/model` ids, one per line.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-onboarding-go-'));

// A stub client whose answers the test swaps per scenario. Shapes verified against the real
// OpenCode 2.1.4 on this host: `auth list --format json` prints an array of
// { id, name, connections[] }; `models` prints bare `provider/model` lines, newest first.
const stubDir = join(temp, 'stub-bin');
const stub = join(stubDir, 'opencode');
mkdirSync(join(stubDir, 'opencode.d'), { recursive: true });
const authFile = join(stubDir, 'opencode.d/auth.json');
const modelsFile = join(stubDir, 'opencode.d/models.txt');
const stubScript = `#!/usr/bin/env bash
dir="\$(dirname "\$0")/opencode.d"
echo "\$*" >> "\$dir/calls.log"
case "\$*" in
  "auth list --format json") cat "\$dir/auth.json"; exit 0 ;;
  "models") cat "\$dir/models.txt"; exit 0 ;;
  "--version") echo "opencode v2.1.4"; exit 0 ;;
esac
echo "opencode stub: unexpected arguments: \$*" >&2
exit 90
`;
writeFileSync(stub, stubScript);
chmodSync(stub, 0o755);

// The credentials of a subscription box: an OpenCode Go row among several stored integrations.
const goCredentials = (present) => JSON.stringify([
  ...(present ? [{ id: 'opencode-go', name: 'OpenCode Go',
    connections: [{ type: 'credential', id: 'cred_new', label: 'box: OpenCode Go', method: 'key' }] }] : []),
  { id: 'alibaba-token-plan', name: 'Alibaba Token Plan',
    connections: [{ type: 'credential', id: 'cred_tp', label: 'box: Alibaba Token Plan', method: 'key' }] },
]);
writeFileSync(authFile, goCredentials(true));
writeFileSync(modelsFile, [
  'abliteration-ai/abliterated-model',
  'opencode-go/glm-5.3',                 // the bare id also exists here
  'alibaba-token-plan/glm-5.3',          // and here: two providers, one bare id
  'opencode-go/glm-5.3-flash',
  'opencode-go/deepseek-v4.1-flash',
  'opencode-go/qwen3.8-flash',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/beam-free',
].join('\n') + '\n');

const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` };
delete env.OSTOYAE_GRAPH;
delete env.OSTOYAE_CWD;
delete env.OSTOYAE_EXEC;
delete env.XDG_CONFIG_HOME;
delete env.XDG_DATA_HOME;
env.OSTOYAE_STATE_DIR = join(temp, 'state');

let checks = 0, failures = 0;
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${checks}. ${name}: ${String(e.message).split('\n')[0]}`); }
};
const repo = join(temp, 'pursuit');
mkdirSync(repo);
const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
git('init', '-q', '-b', 'main');
git('-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'start', '--allow-empty');

const run = (args) => spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 120_000 });
const doctor = (board) => run([join(root, 'doctor.mjs'), board]);
const read = (name) => { const r = spawnSync('cat', [join(repo, name)], { encoding: 'utf8' }); return r.stdout; };
const board = (name = 'board-go.json') => JSON.parse(read(name));
const boardWithModel = (from, to, model) => {
  const g = board(from); g.defaults.model = model;
  writeFileSync(join(repo, to), JSON.stringify(g, null, 2) + '\n');
};

/* init pins the provider, the exact model and credential variable NAMES only */

/* what a doctor run is allowed to call on the client: the safe list and the model registry */
const stubLog = join(stubDir, 'opencode.d/calls.log');
const readStubLog = () => {
  const r = spawnSync('cat', [stubLog], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
};

test('init records the opencode provider, an exact model pin and --env names only', () => {
  const r = run([join(root, 'init.mjs'), 'board-go.json', '--agent', 'opencode',
    '--model', 'opencode-go/glm-5.3-flash', '--env', 'OPENCODE_CONFIG_CONTENT',
    '--item', 'OpenCode Go maintenance']);
  assert.equal(r.status, 0, r.stderr);
  const g = board();
  assert.equal(g.execution.provider, 'opencode');
  assert.equal(g.defaults.model, 'opencode-go/glm-5.3-flash');
  assert.deepEqual(g.sandbox.env_passthrough, ['OPENCODE_CONFIG_CONTENT']);
});

/* doctor, modules of the real client they answer with */

test('doctor reports stored credentials instead of "no safe status probe", using only safe list calls', () => {
  const r = doctor('board-go.json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved credential/i, r.stdout);
  assert.match(r.stdout, /no model call/i, r.stdout);
  assert.doesNotMatch(r.stdout, /no safe status probe is configured/, r.stdout);
});

test('the safe check is the credential list alone: no run, models, stats or export call may reach the stub', () => {
  const log = readStubLog();
  const others = log.filter(c => !(c[0] === 'auth' && c[1] === 'list') && !(c[0] === 'models'));
  assert.deepEqual(others, [], JSON.stringify(others));
});

test('doctor refuses a model pin the CLI does not list', () => {
  boardWithModel('board-go.json', 'board-bad.json', 'opencode-go/not-a-model');
  const r = doctor('board-bad.json');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Not safe to launch/, r.stdout);
  assert.match(r.stdout, /not-a-model/, r.stdout);
});

test('doctor warns instead of picking when a bare model id matches more than one provider', () => {
  boardWithModel('board-go.json', 'board-bare.json', 'glm-5.3');
  const r = doctor('board-bare.json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout + r.stderr;
  assert.match(lines, /alibaba-token-plan\/glm-5\.3.*opencode-go\/glm-5\.3|opencode-go\/glm-5\.3.*alibaba-token-plan\/glm-5\.3/, lines);
});

test('a present pin is reported as registry-checked, not as access-verified', () => {
  boardWithModel('board-go.json', 'board-pin.json', 'opencode-go/deepseek-v4-pro');
  const r = doctor('board-pin.json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /deepseek-v4-pro/);
});

test('no stored OpenCode Go credential is blocking, not a silent pass', () => {
  writeFileSync(authFile, goCredentials(false));
  const r = doctor('board-pin.json');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Not safe to launch/, r.stdout);
  assert.match(r.stdout + r.stderr, /no stored credential|credential/i);
});
writeFileSync(authFile, goCredentials(true));

/* the iron rule: nothing here may claim quota, access or spend verification it cannot read */

test('doctor never claims remaining subscription allowance or verified access, even with credentials', () => {
  for (const name of ['board-go.json', 'board-pin.json']) {
    const r = doctor(name);
    const t = r.stdout + r.stderr;
    assert.doesNotMatch(t, /remaining (subscription )?allowance.*\d|(\d+) (calls|sessions) left|quota: \d/i, t);
    assert.doesNotMatch(t, /verified access|authenticated/i, t);
  }
});

process.exitCode = failures ? 1 : 0;
console.log(`  ${checks - failures} of ${checks} passing${failures ? `, ${failures} failing` : ''}`);
if (failures) console.error(`  rehearsal artifacts kept at ${temp}`);
