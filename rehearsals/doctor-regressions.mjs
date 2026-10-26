#!/usr/bin/env node
// Deterministic regressions for two doctor.mjs OpenCode defects, zero model calls.
//
//   1. variant — a model pin carrying the `#effort` variant suffix (e.g.
//      `opencode-go/glm-5.3-flash#high`) is compared VERBATIM against the CLI's
//      variant-free `opencode models` listing, so a valid pin is falsely rejected as
//      "not in the CLI's model listing".
//   2. env — `opencodeModels` spawns `opencode models` with the HOST environment instead
//      of the resolved cell environment (and the credential fallback reads host
//      process.env). A host-only marker variable proves which environment reached the
//      subprocess: if the cell env is used the marker is absent and the pin is found; if
//      the host env leaks through, the stub answers with a different listing and the pin
//      is falsely rejected.
//
//   node rehearsals/doctor-regressions.mjs [variant|env]
//
// A stub `opencode` sits on PATH ahead of the real one and answers the two safe reads
// (`auth list --format json`, `models`). Shapes are the real client 2.1.4's.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const only = process.argv[2] ?? 'all';
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-doctor-regressions-'));

// Stub client. `models` answers differently depending on whether the host-only marker
// reached the subprocess: that is the whole point of the env test.
const stubDir = join(temp, 'stub-bin');
const stub = join(stubDir, 'opencode');
const d = join(stubDir, 'opencode.d');
mkdirSync(d, { recursive: true });
const authJson = JSON.stringify([
  { id: 'opencode-go', name: 'OpenCode Go', connections: [{ type: 'credential', id: 'cred_new', label: 'box: OpenCode Go', method: 'key' }] },
]);
const modelsTxt = ['opencode-go/glm-5.3', 'opencode-go/glm-5.3-flash', 'opencode-go/deepseek-v4.1-flash'].join('\n') + '\n';
writeFileSync(join(d, 'auth.json'), authJson);
writeFileSync(join(d, 'models.txt'), modelsTxt);
const stubScript = [
  '#!/usr/bin/env bash',
  'dir="$(dirname "$0")/opencode.d"',
  'case "$*" in',
  '  "auth list --format json") cat "$dir/auth.json"; exit 0 ;;',
  '  "models")',
  '    if [ -n "${OSTOYAE_DOCTOR_LEAK:-}" ]; then',
  '      printf "opencode-go/glm-5.3\\nopencode-go/deepseek-v4.1-flash\\n"',
  '    else',
  '      cat "$dir/models.txt"',
  '    fi',
  '    exit 0 ;;',
  'esac',
  'echo "opencode stub: unexpected arguments: $*" >&2',
  'exit 90',
  '',
].join('\n');
writeFileSync(stub, stubScript);
chmodSync(stub, 0o755);

// A real pursuit repo, because doctor inspects sandbox.repo and resolves sandbox.base.
const repo = join(temp, 'pursuit');
mkdirSync(repo);
const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr || r.stdout); };
git('init', '-q', '-b', 'main');
git('-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'start', '--allow-empty');

const board = (model) => ({
  graph: 'doctor-regressions',
  concurrency: 1,
  max_attempts: 2,
  execution: { provider: 'opencode', profile: 'headless' },
  sandbox: { repo, root: join(temp, 'cells'), base: 'main', port_base: 'auto', env_passthrough: [] },
  work: [{ id: 'w1', what: 'maintenance', needs: [], check: 'true' }],
  edges: [],
  attempts: [],
  defaults: { model },
});
const boardPath = join(temp, 'board.json');
const writeBoard = (model) => writeFileSync(boardPath, JSON.stringify(board(model), null, 2) + '\n');

const baseEnv = { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}`, OSTOYAE_STATE_DIR: join(temp, 'state') };
delete baseEnv.OSTOYAE_DOCTOR_LEAK;
delete baseEnv.OSTOYAE_GRAPH; delete baseEnv.OSTOYAE_CWD; delete baseEnv.OSTOYAE_EXEC;

const doctor = (env) => spawnSync(process.execPath, [join(root, 'doctor.mjs'), boardPath], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });

let checks = 0, failures = 0;
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${checks}. ${name}: ${String(e.message).split('\n')[0]}`); }
};

if (only === 'all' || only === 'variant') test('a #variant pin is registry-checked by its base id, not rejected verbatim', () => {
  writeBoard('opencode-go/glm-5.3-flash#high');
  const r = doctor(baseEnv);
  assert.equal(r.status, 0, `doctor exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /glm-5\.3-flash/);
  assert.doesNotMatch(r.stdout + r.stderr, /not in the CLI's model listing/, r.stdout + r.stderr);
});

if (only === 'all' || only === 'env') test('`opencode models` runs in the cell environment, not the host environment', () => {
  writeBoard('opencode-go/glm-5.3-flash');
  const r = doctor({ ...baseEnv, OSTOYAE_DOCTOR_LEAK: '1' });
  assert.equal(r.status, 0, `doctor exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /glm-5\.3-flash/);
  assert.doesNotMatch(r.stdout + r.stderr, /not in the CLI's model listing/, r.stdout + r.stderr);
});

process.exitCode = failures ? 1 : 0;
console.log(`  ${checks - failures} of ${checks} passing${failures ? `, ${failures} failing` : ''}`);
if (failures) console.error(`  artifacts kept at ${temp}`);
