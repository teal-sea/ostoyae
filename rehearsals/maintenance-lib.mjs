// Shared helpers for the maintenance E2E acceptance harness (rehearsals/maintenance-e2e.mjs).
// Owns: engine invocation with recorded exit codes + raw logs, git-fixture creation,
// board JSON builders. No model calls anywhere: the fake executor does all the work.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every engine invocation goes through here. Each call is logged as an exact command
// line with its real exit code, stdout and stderr, into `<logdir>/invocations.log`.
export class Engine {
  constructor({ root, logdir }) {
    this.root = root;
    this.logdir = logdir;
    this.env = { ...process.env, NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    delete this.env.OSTOYAE_EXEC;
    mkdirSync(logdir, { recursive: true });
    this.logPath = join(logdir, 'invocations.log');
    writeFileSync(this.logPath, `# engine root: ${root}\n# node: ${process.execPath}\n`);
    this.invocations = [];
  }

  // Run an engine script (run.mjs, doctor.mjs, cli.mjs, ...) with args. Records and returns
  // { label, command, cwd, exit, stdout, stderr }.
  run(label, script, args, opts = {}) {
    const cwd = opts.cwd ?? this.root;
    const r = spawnSync(process.execPath, [join(this.root, script), ...args],
      { cwd, env: { ...this.env, ...(opts.env ?? {}) }, encoding: 'utf8', timeout: opts.timeout ?? 180000 });
    const exit = r.status === null ? `SIGNAL:${r.signal ?? r.error?.message}` : r.status;
    const command = `${process.execPath} ${join(this.root, script)} ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`;
    const entry = { label, command, cwd, exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
    this.invocations.push(entry);
    writeFileSync(this.logPath,
      `\n===== ${label} =====\n$ ${command}\n(cwd ${cwd})\nexit: ${exit}\n--- stdout ---\n${entry.stdout}` +
      `--- stderr ---\n${entry.stderr}${r.error ? `--- spawn error ---\n${r.error.message}\n` : ''}`,
      { flag: 'a' });
    return entry;
  }

  // A raw (non-engine) command, also logged: git inspections the assertions stand on.
  raw(label, cmd, cmdArgs, opts = {}) {
    const r = spawnSync(cmd, cmdArgs, { cwd: opts.cwd, env: this.env, encoding: 'utf8' });
    writeFileSync(this.logPath, `\n===== ${label} =====\n$ ${cmd} ${cmdArgs.join(' ')}\n(cwd ${opts.cwd})\nexit: ${r.status}\n${r.stdout}${r.stderr}`, { flag: 'a' });
    return r;
  }
}

// A throwaway pursuit repository: real git, one committed base on `main`.
export function makePursuit(dir, engine) {
  mkdirSync(dir, { recursive: true });
  let r = engine.raw(`git init ${dir}`, 'git', ['init', '-q', '-b', 'main', dir]);
  if (r.status !== 0) throw new Error(`git init failed: ${r.stdout}${r.stderr}`);
  writeFileSync(join(dir, 'README.md'), '# maintenance fixture pursuit\n\nThrowaway repo: two consumers need one shared row-parsing helper.\n');
  r = engine.raw('git add', 'git', ['-C', dir, 'add', '-A']);
  if (r.status !== 0) throw new Error(`git add failed: ${r.stdout}${r.stderr}`);
  r = engine.raw('git commit', 'git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'start']);
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stdout}${r.stderr}`);
  return dir;
}

export const readBoard = (file) => JSON.parse(readFileSync(file, 'utf8'));

// The wall handback a consumer produces when it walks into the missing shared helper.
// The wall text deliberately names things beyond the item's own text so the engine's
// wall floor (lib/wall.mjs) clears it: this fixture satisfies the product rule, it does
// not dodge it.
export function wallReport(consumerId) {
  return {
    wall: 'the shared row-parsing helper is absent from the pursuit: readers have nothing to parse rows against',
    work: [{ id: 'w-shared', what: 'add the shared row-parsing helper' }],
    edges: [{ from: 'w-shared', to: consumerId, why: 'the reader parses rows through the helper' }],
  };
}

// A consumer work item: attempt 1 walls and proposes the shared helper, attempt 2 (after
// the helper has landed and its branch is inherited) does the work. The check demands
// BOTH its own artifact and the shared prerequisite's artifact, committed by the shared
// job, on a fresh checkout of the branch.
export function consumerWork(id, fixturesDir) {
  return {
    id,
    what: `wire ${id.replace(/^w-/, '')} to read rows`,
    check: `bash ${join(fixturesDir, 'maintenance-check-consumer.sh')} ${id}.txt w-shared.txt`,
    // NOTE: the shared item itself is gated by judge.default_check on the board
    // ("... maintenance-check-shared.sh {id}.txt"), so a done-on-the-agent's-word
    // can never stand in for a real shared build.
    params: { fake: { prove: ['wall', 'done'], wall_report: wallReport(id), usd: 0.02 } },
  };
}
