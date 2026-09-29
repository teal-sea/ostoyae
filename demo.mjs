#!/usr/bin/env node
// A fresh, disposable pursuit and the real runner, driven only by fake.sh.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { terminal, forPerson } from './lib/terminal.mjs';

const args = process.argv.slice(2);
if (args.some(a => a !== '--no-viewer')) {
  console.error('usage: bin/ostoyae demo [--no-viewer]'); process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'ostoyae-demo-'));
const repo = join(dir, 'pursuit'); mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Ostoyae demo'); git('config', 'user.email', 'demo@ostoyae.invalid');
writeFileSync(join(repo, '.gitignore'), '.ostoyae/\n');
git('add', '.gitignore'); git('commit', '-qm', 'Start the disposable demo');
const file = join(dir, 'demo.json');
const g = {
  graph: 'demo-shared-parser', concurrency: 1, max_attempts: 1,
  sandbox: { repo, root: join(dir, 'cells'), base: 'main' },
  defaults: { fake: { sleep: 1 } },
  mapping: { what: 'Find what each feature needs; reuse shared work' },
  judge: { verify: 'Check that proposed dependencies are real', default_check: 'test -f {id}.txt' },
  work: ['search', 'export'].map(id => ({ id, what: `Build ${id} using the shared parser`,
    params: { fake: { sleep: 1, map: {
      map: { settles: `${id} works`, cost: 'small' },
      work: [{ id: 'parser', what: 'Build the shared parser once' }],
      edges: [{ from: 'parser', to: id, why: 'uses the same parser' }],
    } } } })), edges: [], attempts: [],
};
writeFileSync(file, JSON.stringify(g, null, 2) + '\n');
const person = forPerson(process.stdout), t = terminal();
if (person) console.log(t.heading('Two features need a parser nobody has written. Watch the graph grow it.', 'demo') + '\n' +
  t.quiet('Scripted agents, no model calls. Not benchmark evidence.'));
else console.log(`\nScripted demo. No model calls; its costs and outcomes are not benchmark evidence.\nBoard: ${file}`);
let viewer;
if (!args.includes('--no-viewer')) {
  const port = Number(process.env.OSTOYAE_PORT ?? 4300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('OSTOYAE_PORT must be an integer from 1 to 65535'); process.exit(2);
  }
  viewer = spawn(process.execPath, [join(import.meta.dirname, 'viewer/serve.mjs'), file,
    '--port', String(port), '--read-only'], { stdio: 'inherit' });
  const ready = await new Promise(resolve => {
    const deadline = Date.now() + 8000;
    const check = async () => {
      if (viewer.exitCode !== null || Date.now() > deadline) return resolve(false);
      try {
        const h = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).then(r => r.json());
        if (h.pid === viewer.pid) return resolve(true);
      } catch {}
      setTimeout(check, 100);
    };
    check();
  });
  if (!ready) { viewer.kill(); console.error('Demo viewer could not start; choose another OSTOYAE_PORT.'); process.exit(1); }
  console.log(`Read-only viewer: http://localhost:${port}\nOpen it to watch the graph grow. Ctrl-C closes the viewer.\n`);
}
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const runner = spawn(process.execPath, [join(import.meta.dirname, 'run.mjs'), file,
  '--exec', `bash ${quote(join(import.meta.dirname, 'executors/fake.sh'))}`,
  '--auto-advance', '--max-launches', '8'], { stdio: 'inherit' });
let interrupted = false;
const stop = () => { interrupted = true; runner.kill('SIGTERM'); viewer?.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const [code] = await once(runner, 'exit');
const result = JSON.parse(readFileSync(file, 'utf8'));
const done = result.attempts.filter(a => a.kind === 'prove' && a.state === 'done');
const success = code === 0 && done.length === 3 && done.filter(a => a.of === 'parser').length === 1;
if (person) console.log(success ? `  ${t.dim('One parser, built once. Both features finished on top of it.')}\n\n  ${t.dim('Your turn:')} ${t.accent('ostoyae init --agent claude --item "Fix the login bug"')}\n  ${t.dim(`Board kept at ${file}`)}\n`
  : `\n  Demo stopped before completion. Board kept at ${file}\n`);
else console.log(`\nDemo ${success ? 'complete: one parser, two completed consumers' : 'stopped before completion'}.\nBoard retained: ${file}`);
if (!success || interrupted) viewer?.kill();
if (viewer && viewer.exitCode === null) await once(viewer, 'exit');
process.exitCode = success || interrupted ? 0 : 1;
