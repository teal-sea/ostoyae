// The board is a DAG: doctor names a cycle and blocks it, go will not launch one, and a yes that
// would close one is recorded as a no with the loop it would have made.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCycle, closesCycle } from '../lib/dag.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-dag-'));
const env = { ...process.env, OSTOYAE_STATE_DIR: join(temp, 'state') };
let failures = 0, checks = 0;
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (error) { failures++; console.error(`  FAIL ${checks}. ${name}: ${error.message}`); }
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
// A board that passes every other doctor check, so the only thing that can block it is its shape.
const board = (name, work, edges = []) => {
  const repo = join(temp, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'rehearsal');
  git(repo, 'config', 'user.email', 'rehearsal@ostoyae.invalid');
  writeFileSync(join(repo, '.gitignore'), '.ostoyae/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'start');
  const g = { graph: name, concurrency: 1, max_attempts: 1,
    sandbox: { repo, root: join(temp, `wt-${name}`), base: 'main' },
    work: work.map((w) => ({ what: w.id, needs: [], check: 'true', ...w })), edges, attempts: [] };
  const file = join(temp, `${name}.json`);
  writeFileSync(file, JSON.stringify(g, null, 2));
  return file;
};
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const node = (script, ...args) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', env });
const doctor = (file) => {
  const r = node('doctor.mjs', file, '--exec', 'true', '--json');
  return { status: r.status, row: JSON.parse(r.stdout).rows.find((x) => x.name === 'dependencies') };
};
const edge = (id, from, to, status = 'proposed') => ({ id, from, to, why: '', status });
const fake = `bash '${join(root, 'executors/fake.sh').replaceAll("'", "'\\''")}'`;

try {
  test('doctor blocks a two-job cycle and names it', () => {
    const d = doctor(board('two', [{ id: 'w-a', needs: ['w-b'] }, { id: 'w-b', needs: ['w-a'] }]));
    assert.equal(d.status, 1);
    assert.equal(d.row.state, 'FAIL');
    assert.equal(d.row.detail, 'dependency cycle: w-a → w-b → w-a');
    assert.match(d.row.fix, /remove one of those needs/);
  });

  test('doctor blocks a three-job cycle and names it', () => {
    const d = doctor(board('three', [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['c'] }, { id: 'c', needs: ['a'] }]));
    assert.equal(d.status, 1);
    assert.equal(d.row.detail, 'dependency cycle: a → b → c → a');
  });

  test('doctor blocks a job that needs itself', () => {
    const d = doctor(board('self', [{ id: 'a' }, { id: 'b', needs: ['a', 'b'] }]));
    assert.equal(d.status, 1);
    assert.equal(d.row.detail, 'dependency cycle: b → b');
  });

  test('doctor sees a cycle closed by a confirmed edge, not only by needs', () => {
    const d = doctor(board('mixed', [{ id: 'a', needs: ['b'] }, { id: 'b' }], [edge('e-0001', 'a', 'b', 'confirmed')]));
    assert.equal(d.status, 1);
    assert.equal(d.row.detail, 'dependency cycle: a → b → a');
  });

  test('a diamond is not a cycle', () => {
    const d = doctor(board('diamond', [{ id: 'base' }, { id: 'left', needs: ['base'] }, { id: 'right', needs: ['base'] },
      { id: 'top', needs: ['left', 'right'] }]));
    assert.equal(d.status, 0, JSON.stringify(d));
    assert.equal(d.row.state, 'ok');
    assert.equal(findCycle(read(join(temp, 'diamond.json'))), null);
  });

  test('a proposed or rejected edge closes nothing until it is confirmed', () => {
    const d = doctor(board('unconfirmed', [{ id: 'a', needs: ['b'] }, { id: 'b' }],
      [edge('e-0001', 'a', 'b'), edge('e-0002', 'a', 'b', 'rejected')]));
    assert.equal(d.row.state, 'ok');
  });

  test('go does not launch on a cyclic board, and does on the same board without the loop', () => {
    const cyclic = board('go-cycle', [{ id: 'w-a', needs: ['w-b'] }, { id: 'w-b', needs: ['w-a'] }]);
    const r = spawnSync('bash', [join(root, 'bin/ostoyae'), 'go', cyclic, '--exec', fake, '--invocations', '2', '--headless'], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /dependency cycle: w-a → w-b → w-a/);
    assert.match(r.stderr, /refusing to launch/);
    assert.equal(read(cyclic).attempts.length, 0);
    const fine = board('go-fine', [{ id: 'w-a', needs: ['w-b'] }, { id: 'w-b' }]);
    const f = spawnSync('bash', [join(root, 'bin/ostoyae'), 'go', fine, '--exec', fake, '--invocations', '2', '--headless'], { encoding: 'utf8', env });
    assert.equal(f.status, 0, f.stdout + f.stderr);
    assert.ok(read(fine).attempts.length > 0);
  });

  test('confirming a cycle-closing edge is refused with its path; a harmless edge still confirms', () => {
    const file = board('confirm', [{ id: 'a' }, { id: 'b', needs: ['a'] }, { id: 'c' }],
      [edge('e-0001', 'b', 'a'), edge('e-0002', 'c', 'b')]);
    const g0 = read(file);
    g0.attempts = [{ id: 'a-0001', of: 'a', state: 'done', result: { found: ['e-0001'] } }];
    writeFileSync(file, JSON.stringify(g0, null, 2));
    const r = node('run.mjs', file, '--confirm', 'e-0001,e-0002');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /would close a dependency cycle: a → b → a/);
    const g = read(file);
    const [e1, e2] = g.edges;
    assert.equal(e1.status, 'rejected');
    assert.equal(e1.rejected_why, 'would close a dependency cycle: a → b → a');
    assert.equal(e2.status, 'confirmed');
    assert.deepEqual(g.attempts, g0.attempts, 'attempts are append-only and untouched');
    assert.equal(doctor(file).row.state, 'ok');
  });

  test('the scoped, unattended yes refuses a cycle-closing edge the same way', () => {
    const file = board('scoped', [{ id: 'a', needs: ['b'] }, { id: 'b' }, { id: 'c', needs: ['a'] }],
      [edge('e-0001', 'c', 'b'), edge('e-0002', 'b', 'c')]);
    const r = node('run.mjs', file, '--confirm-scoped');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const g = read(file);
    assert.equal(g.edges[0].status, 'rejected');
    assert.equal(g.edges[0].rejected_why, 'would close a dependency cycle: b → c → a → b');
    assert.equal(g.edges[1].status, 'confirmed');
    assert.match(r.stdout, /1 changed/);
  });

  test('confirming a proposed job whose confirmed edges would loop is refused with the path', () => {
    const file = board('job', [{ id: 'a', needs: ['p'] }, { id: 'p', status: 'proposed' }],
      [edge('e-0001', 'a', 'p', 'confirmed')]);
    assert.equal(doctor(file).row.state, 'ok', 'a proposed job schedules nothing yet');
    const r = node('run.mjs', file, '--confirm', 'p');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const p = read(file).work.find((w) => w.id === 'p');
    assert.equal(p.status, 'rejected');
    assert.equal(p.rejected_why, 'would close a dependency cycle: p → a → p');
  });

  test('closesCycle judges only the yes it is asked about', () => {
    const g = { work: [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }, { id: 'c' }, { id: 'd' }],
      edges: [edge('e-0001', 'c', 'd')], attempts: [] };
    assert.equal(closesCycle(g, g.edges[0]), null, 'an existing loop elsewhere is doctor\'s, not this edge\'s');
    const self = edge('e-0003', 'c', 'c');
    assert.deepEqual(closesCycle({ ...g, edges: [self] }, self), ['c', 'c']);
  });
} finally { rmSync(temp, { recursive: true, force: true }); }

console.log(failures ? `\n  ${failures} of ${checks} dag checks failed\n` : `\n  all ${checks} dag checks passed\n`);
process.exit(failures ? 1 : 0);
