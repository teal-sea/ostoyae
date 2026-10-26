// Offline regression for the OpenCode adapter's usage path. Zero model calls.
//
// The four `opencode-probes/*.jsonl` streams are the saved real streams from the 2026-10-26
// endpoint probes (OpenCode 2.1.4, opencode-go): text and step_start parts, no step_finish. The
// `*.session.json` files beside them are the real `opencode session export <id>` records for the
// same sessions. A stub `opencode` on PATH replays one stream for `run` and one export for
// `session export`, so the adapter's recovery wiring is exercised without a provider call.
//
// What must hold: a stream with no step_finish still yields the usage the CLI itself recorded,
// labelled as recovered and as a pricing-table price (not a bill); a complete step_finish stream
// is unchanged and triggers no extra CLI call; and when nothing usable is recorded the numbers
// stay null instead of becoming zeros or partial sums passed off as totals.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'rehearsals', 'fixtures', 'opencode-probes');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ostoyae-opencode-usage-')));
let passed = 0, failed = 0;
function test(name, fn) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { fn(); console.log(`  ok ${++passed}. ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
}

const bin = join(tmp, 'bin'); mkdirSync(bin);
// The stub records its argv and replays whichever fixture the test names. `session export` is
// answered from OPENCODE_STUB_EXPORT, or fails, or answers for the wrong session.
writeFileSync(join(bin, 'opencode'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.OPENCODE_STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === 'session' && args[1] === 'export') {
  const mode = process.env.OPENCODE_STUB_EXPORT || 'fail';
  if (mode === 'fail') { console.error('stub: no session record'); process.exit(1); }
  const body = fs.readFileSync(mode, 'utf8');
  process.stdout.write(process.env.OPENCODE_STUB_EXPORT_ID
    ? body.replace(/"id":\\s*"ses_[^"]+"/, '"id": "' + process.env.OPENCODE_STUB_EXPORT_ID + '"')
    : body);
  process.exit(0);
}
fs.mkdirSync('.ostoyae', { recursive: true });
fs.writeFileSync('.ostoyae/report.json', JSON.stringify({ verdicts: [] }));
if (process.env.OPENCODE_STUB_STREAM) fs.writeSync(1, fs.readFileSync(process.env.OPENCODE_STUB_STREAM));
process.exitCode = Number(process.env.OPENCODE_STUB_EXIT || 0);
`, { mode: 0o755 });
chmodSync(join(bin, 'opencode'), 0o755);

// A cell the adapter may commit in, so a prove attempt exercises the same code path a live cell does.
function cell(name) {
  const dir = join(tmp, name); mkdirSync(dir);
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', '-A']);
  spawnSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed']);
  return dir;
}
function adapt(dir, { stream, exported = 'fail', exportAs, exit = 0, kind = 'verify', model = 'opencode-go/deepseek-v4.1-flash' }) {
  const log = join(dir, 'stub.log');
  const local = (p) => (p.startsWith('/') ? p : join(fixtures, p));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    OPENCODE_STUB_LOG: log,
    OPENCODE_STUB_STREAM: stream ? local(stream) : '',
    OPENCODE_STUB_EXPORT: exported === 'fail' ? 'fail' : local(exported),
    OPENCODE_STUB_EXIT: String(exit),
    OSTOYAE_ATTEMPT: 'fixture-attempt',
    OSTOYAE_WORK: 'w-fixture',
  };
  if (exportAs) env.OPENCODE_STUB_EXPORT_ID = exportAs;
  const r = spawnSync(process.env.BASH || 'bash', [join(root, 'executors', 'opencode.sh')], {
    cwd: dir, env, encoding: 'utf8', timeout: 60_000,
    input: JSON.stringify({ id: 'fixture-attempt', of: 'w-fixture', what: 'fixture work', kind, params: { model } }),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let usage = null;
  try { usage = JSON.parse(readFileSync(join(dir, '.ostoyae', 'usage.json'), 'utf8')); } catch {}
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out, usage, calls, exports: calls.filter((a) => a[0] === 'session' && a[1] === 'export') };
}

try {
  // The four real saved streams: text without step_finish. The adapter must report what the CLI
  // itself recorded for that session rather than calling the attempt unpriced.
  for (const model of ['deepseek-v4.1-flash', 'qwen3.8-flash', 'glm-5.3-flash', 'deepseek-v4-pro']) {
    test(`${model}: a real stream with no step_finish recovers the session's own usage`, () => {
      const dir = cell(`recover-${model}`);
      const r = adapt(dir, { stream: `${model}.jsonl`, exported: `${model}.session.json` });
      assert.equal(r.status, 0, r.out);
      const exported = JSON.parse(readFileSync(join(fixtures, `${model}.session.json`), 'utf8'));
      // Same accounting rule as step_finish: sum the steps the CLI recorded, not the session
      // total, which also carries its title-generation call.
      const steps = exported.messages.filter((m) => m.type === 'assistant');
      const want = {
        input: steps.reduce((t, m) => t + m.tokens.input, 0),
        output: steps.reduce((t, m) => t + m.tokens.output, 0),
        read: steps.reduce((t, m) => t + m.tokens.cache.read, 0),
        write: steps.reduce((t, m) => t + m.tokens.cache.write, 0),
        cost: steps.reduce((t, m) => t + m.cost, 0),
        steps: steps.length,
      };
      assert(r.usage, 'no usage.json written');
      assert.equal(r.usage._bad, undefined, JSON.stringify(r.usage));
      assert.equal(r.usage.executor, 'opencode');
      assert.equal(r.usage.model, 'opencode-go/deepseek-v4.1-flash');
      assert.equal(r.usage.input_tokens, want.input);
      assert.equal(r.usage.output_tokens, want.output);
      assert.equal(r.usage.cache_read_input_tokens, want.read);
      assert.equal(r.usage.cache_creation_input_tokens, want.write);
      assert(Math.abs(r.usage.cost_usd - want.cost) < 1e-12, `${r.usage.cost_usd} vs ${want.cost}`);
      assert.equal(r.usage.steps, want.steps);
      assert.match(r.usage.cost_basis, /session record/i);
      assert.match(r.usage.cost_basis, /not a bill/);
      assert.match(r.usage.cost_basis, /API-equivalent/);
      assert.equal(r.exports.length, 1, JSON.stringify(r.calls));
      const sessionID = JSON.parse(readFileSync(join(fixtures, `${model}.jsonl`), 'utf8').trim().split('\n').at(-1)).sessionID;
      assert.deepEqual(r.exports[0], ['session', 'export', sessionID]);
      assert.match(r.out, /cost=\$/, r.out);
      // The live view still shows the agent's words.
      assert.match(r.out, /says: ENDPOINT_OK/);
    });
  }

  test('older complete step_finish streams are summed as before, with no extra CLI call', () => {
    const dir = cell('stream-complete');
    const stream = join(tmp, 'complete.jsonl');
    writeFileSync(stream, [
      { type: 'step_finish', part: { cost: 0.25, tokens: { input: 3, output: 2, cache: { read: 1, write: 0 } } } },
      { type: 'step_finish', part: { cost: 0, tokens: { input: 5, output: 4, cache: { read: 0, write: 2 } } } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = adapt(dir, { stream });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.usage._bad, undefined, JSON.stringify(r.usage));
    assert.equal(r.usage.input_tokens, 8); assert.equal(r.usage.output_tokens, 6);
    assert.equal(r.usage.cache_read_input_tokens, 1); assert.equal(r.usage.cache_creation_input_tokens, 2);
    assert(Math.abs(r.usage.cost_usd - 0.25) < 1e-12);
    assert.equal(r.usage.steps, 2);
    assert.match(r.usage.cost_basis, /step_finish/);
    assert.equal(r.exports.length, 0, 'a complete stream must not spend an extra CLI call');
  });

  test('a silent run whose session record cannot be read reports unknown, never zero', () => {
    const dir = cell('silent');
    const r = adapt(dir, { stream: null, exported: 'fail', exit: 0 });
    assert.equal(r.status, 0, r.out); // the stub handed back an empty verdicts list
    assert.equal(r.usage.cost_usd, null); assert.equal(r.usage.input_tokens, null);
    assert.equal(r.usage.output_tokens, null); assert.equal(r.usage.cache_read_input_tokens, null);
    assert.equal(r.usage.steps, null);
    assert.match(r.usage._bad, /no step_finish|session/);
    assert.match(r.out, /cost=\?/);
  });

  test('an export for a different session is refused rather than priced into this attempt', () => {
    const dir = cell('wrong-session');
    const r = adapt(dir, { stream: 'deepseek-v4.1-flash.jsonl', exported: 'qwen3.8-flash.session.json', exportAs: 'ses_someone_else' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.usage.cost_usd, null); assert.equal(r.usage.input_tokens, null);
    assert.equal(r.usage.output_tokens, null);
    assert.match(r.out, /cost=\?/);
  });

  test('an export missing cost or tokens is refused, not filled with zeros', () => {
    const dir = cell('thin-export');
    const thin = join(tmp, 'thin.session.json');
    writeFileSync(thin, JSON.stringify({ info: { id: 'ses_x', tokens: { input: 10, output: 4, cache: { read: 0 } } }, messages: [] }));
    const r = adapt(dir, { stream: 'deepseek-v4.1-flash.jsonl', exported: thin });
    assert.equal(r.usage.cost_usd, null); assert.equal(r.usage.input_tokens, null);
    assert.match(r.out, /cost=\?/);
  });

  test('a partial step_finish sum is not passed off as a total when recovery fails', () => {
    const dir = cell('partial');
    const stream = join(tmp, 'partial.jsonl');
    writeFileSync(stream, [
      { type: 'step_finish', part: { cost: 0.25, tokens: { input: 3, output: 2, cache: { read: 1, write: 0 } } } },
      { type: 'step_finish', part: { tokens: { output: 1 } } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = adapt(dir, { stream, exported: 'fail' });
    assert.equal(r.usage.cost_usd, null); assert.equal(r.usage.input_tokens, null);
    assert.equal(r.usage.output_tokens, 3);
    assert.match(r.usage._bad, /incomplete/);
  });

  test('when the recorded steps carry no cost, the session totals are the recovered number', () => {
    const dir = cell('totals-fallback');
    const doc = JSON.parse(readFileSync(join(fixtures, 'deepseek-v4.1-flash.session.json'), 'utf8'));
    for (const m of doc.messages) if (m.type === 'assistant') delete m.cost;
    const thin = join(tmp, 'totals.session.json');
    writeFileSync(thin, JSON.stringify(doc));
    const r = adapt(dir, { stream: 'deepseek-v4.1-flash.jsonl', exported: thin });
    assert.equal(r.usage._bad, undefined, JSON.stringify(r.usage));
    assert(Math.abs(r.usage.cost_usd - doc.info.cost) < 1e-12, JSON.stringify(r.usage));
    assert.equal(r.usage.input_tokens, doc.info.tokens.input);
    assert.match(r.usage.cost_basis, /session totals/);
  });

  test('a recovered record that is not JSON at all is ignored, not parsed as usage', () => {
    const dir = cell('garbage-export');
    const garbage = join(tmp, 'garbage.json');
    writeFileSync(garbage, 'opencode v2.1.4\n{"type":"text"}\n');
    const r = adapt(dir, { stream: 'deepseek-v4.1-flash.jsonl', exported: garbage });
    assert.equal(r.usage.cost_usd, null); assert.equal(r.usage.input_tokens, null);
    assert.match(r.out, /cost=\?/);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed; ${failed} failed; zero model calls.`);
process.exitCode = failed || !passed ? 1 : 0;
