import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'ostoyae-readiness-'));
let failures = 0, checks = 0;
const run = (g, ...args) => {
  const file = join(temp, `${g.graph}.json`);
  writeFileSync(file, JSON.stringify(g));
  const r = spawnSync(process.execPath, [join(root, 'run.mjs'), file, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { g: JSON.parse(readFileSync(file)), output: r.stdout };
};
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (error) { failures++; console.error(`  FAIL ${checks}. ${name}: ${error.message}`); }
};
const yes = { ok: true }, no = { ok: false };
const proposal = (id, verdict = yes) => ({ id, what: id, status: 'proposed', ...(verdict && { verdict }) });
const edge = (from, to, verdict = yes) => ({ id: `e-${from}-${to}`, from, to, status: 'proposed', ...(verdict && { verdict }) });
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const realBoard = (name) => {
  const repo = join(temp, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'rehearsal');
  git(repo, 'config', 'user.email', 'rehearsal@ostoyae.invalid');
  writeFileSync(join(repo, '.gitignore'), '.ostoyae/\n');
  git(repo, 'add', '.gitignore'); git(repo, 'commit', '-qm', 'start');
  return { graph: name, concurrency: 1, max_attempts: 1,
    sandbox: { repo, root: join(temp, `wt-${name}`), base: 'main' },
    mapping: { what: 'Find the shared dependency' },
    judge: { verify: 'Check that each proposal is needed', default_check: 'test -f {id}.txt' },
    work: [{ id: 'ticket', what: 'Build the feature', params: { fake: { map: {
      map: { settles: 'feature', cost: 'small' },
      work: [{ id: 'helper', what: 'Build the shared helper' }],
      edges: [{ from: 'helper', to: 'ticket', why: 'feature imports the helper' }],
    } } } }], edges: [], attempts: [] };
};
const fake = `bash '${join(root, 'executors/fake.sh').replaceAll("'", "'\\''")}'`;

try {
  for (const barrier of ['rejected-work', 'refuted-work', 'failed-edge', 'unjudged-edge', 'reopened-edge', 'unjudged-work']) {
    test(`scoped confirmation cannot cross ${barrier}`, () => {
      const middle = barrier === 'rejected-work' ? { id: 'middle', what: 'closed', status: 'rejected' }
        : barrier === 'refuted-work' ? { id: 'middle', what: 'false statement' }
        : proposal('middle', barrier === 'unjudged-work' ? null : yes);
      const first = edge('new', 'middle', barrier === 'failed-edge' ? no : barrier === 'unjudged-edge' ? null : yes);
      if (barrier === 'reopened-edge') first.reopened_at = '2026-09-09';
      const attempts = barrier === 'refuted-work'
        ? [{ id: 'a-0001', of: 'middle', kind: 'prove', state: 'done', result: { answer: false } }] : [];
      const original = { graph: barrier, judge: { verify: 'Review the proposed dependencies' }, work: [{ id: 'ticket', what: 'open work' }, middle, proposal('new'), proposal('good')],
        edges: [first, edge('middle', 'ticket'), edge('good', 'ticket')], attempts };
      const { g } = run(original, '--confirm-scoped');
      assert.equal(g.work.find(w => w.id === 'new').status, 'proposed');
      assert.equal(g.work.find(w => w.id === 'good').status, 'active');
      assert.deepEqual(g.attempts, attempts);
      const explicit = run(original, '--confirm', 'new');
      assert.equal(explicit.g.work.find(w => w.id === 'new').status, 'active');
    });
  }
  test('a fully judged dependency chain is confirmed together', () => {
    const { g } = run({ graph: 'valid-chain', judge: { verify: 'Review the proposed dependencies' }, work: [{ id: 'ticket', what: 'ticket' }, proposal('new'), proposal('middle')],
      edges: [edge('new', 'middle'), edge('middle', 'ticket')], attempts: [] }, '--confirm-scoped');
    assert(g.work.every(w => w.status !== 'proposed'));
    assert(g.edges.every(e => e.status === 'confirmed'));
  });
  for (const usage of [null, { _bad: 'truncated' }, { executor: 'claude', cost_usd: null }, { cost_usd: -1 }]) {
    test(`a dollar cap stops on unknown or invalid spend: ${JSON.stringify(usage)}`, () => {
      const { output } = run({ graph: `unknown-${checks}`, work: [{ id: 'next', what: 'next' }], edges: [],
        attempts: [{ id: 'a-0001', of: 'earlier', state: 'done', result: usage ? { usage } : {} }] }, '--dry-run', '--max-usd', '10');
      assert.match(output, /unknown.*dollar cost/i);
      assert.doesNotMatch(output, /a-0002\s+start/);
    });
  }
  test('a genuinely zero-cost attempt does not prevent the next launch', () => {
    const { output } = run({ graph: 'zero-cost', work: [{ id: 'next', what: 'next' }], edges: [],
      attempts: [{ id: 'a-0001', of: 'earlier', state: 'done', result: { usage: { cost_usd: 0 } } }] }, '--dry-run', '--max-usd', '10', '--max-launches', '1');
    assert.match(output, /a-0002\s+start/);
  });
  test('output-token caps fail closed and reserve token-only provider usage', () => {
    for (const usage of [{ cost_usd: 1 }, { cost_usd: null, output_tokens: 60, executor: 'codex' }]) {
      const { output } = run({ graph: `token-cap-${checks}`, work: [{ id: 'next', what: 'next' }], edges: [],
        attempts: [{ id: 'a-0001', of: 'earlier', state: 'done', result: { usage } }] },
        '--dry-run', '--max-output-tokens', '100');
      assert.doesNotMatch(output, /a-0002\s+start/);
      assert.match(output, usage.output_tokens ? /100 output-token budget/ : /unknown output-token cost/);
    }
  });
  test('auto-advance requires both a judge and a bound before writing anything', () => {
    for (const judge of [null, { verify: 'judge' }]) {
      const g = { graph: 'invalid-auto', work: [], edges: [], attempts: [], ...(judge && { judge }) };
      const file = join(temp, 'invalid-auto.json');
      writeFileSync(file, JSON.stringify(g));
      const before = readFileSync(file, 'utf8');
      const r = spawnSync(process.execPath, [join(root, 'run.mjs'), file, '--dry-run', '--auto-advance',
        ...(judge ? [] : ['--max-launches', '1'])], { encoding: 'utf8' });
      assert.equal(r.status, 2); assert.match(r.stderr, /requires judge.verify/);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  });
  test('default runs park at judged proposals; opt-in runs finish the dependency chain', () => {
    const manual = run(realBoard('manual'), '--exec', fake, '--max-launches', '5').g;
    assert.equal(manual.work.find(w => w.id === 'helper').status, 'proposed');
    assert(!manual.attempts.some(a => a.of === 'helper'));
    const auto = run(realBoard('auto'), '--exec', fake, '--max-launches', '5', '--auto-advance').g;
    assert.equal(auto.work.find(w => w.id === 'helper').decided_via, 'auto-advance');
    const proves = auto.attempts.filter(a => a.kind === 'prove');
    assert.deepEqual(proves.map(a => a.of), ['helper', 'ticket']);
    assert(proves.every(a => a.state === 'done' && a.result.check.ok && a.result.integrated));
    for (const a of auto.attempts) {
      assert.match(a.sandbox.start_commit, /^[a-f0-9]{40}$/);
      assert.match(a.sandbox.end_commit, /^[a-f0-9]{40}$/);
      assert(!a.sandbox.snapshot_error && !a.sandbox.start_conflicts);
    }
    const ticket = proves[1];
    const ownFiles = git(auto.sandbox.repo, 'diff', '--name-only', ticket.sandbox.start_commit, ticket.sandbox.end_commit);
    assert.equal(ownFiles, 'ticket.txt', 'inherited helper must not count as the ticket’s own work');
    assert.match(git(auto.sandbox.repo, 'show', `${ticket.sandbox.start_commit}:helper.txt`), /fake work/);
  });
  test('auto-advance honors failed judgments, --only, and its launch cap', () => {
    const denied = realBoard('denied');
    denied.judge.params = { fake: { verify: { helper: false } } };
    const d = run(denied, '--exec', fake, '--max-launches', '5', '--auto-advance').g;
    assert.equal(d.work.find(w => w.id === 'helper').status, 'proposed');
    assert(!d.attempts.some(a => a.of === 'helper'));
    const scoped = realBoard('only');
    scoped.work.push({ id: 'other', what: 'Unrelated ticket' }, proposal('extra'));
    scoped.edges.push(edge('extra', 'other'));
    const s = run(scoped, '--exec', fake, '--max-launches', '5', '--auto-advance', '--only', 'ticket').g;
    assert.equal(s.work.find(w => w.id === 'extra').status, 'proposed');
    assert(!s.attempts.some(a => ['other', 'extra'].includes(a.of)));
    const capped = run(realBoard('capped'), '--exec', fake, '--max-launches', '1', '--auto-advance').g;
    assert.equal(capped.attempts.filter(a => a.kind !== 'verify').length, 1);
    assert.equal(capped.work.find(w => w.id === 'helper').status, 'proposed');
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`  ${checks} checks, ${failures} failed. No model calls.`);
process.exitCode = failures ? 1 : 0;
