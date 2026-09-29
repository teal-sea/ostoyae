#!/usr/bin/env node
// Write a board for the repository you are standing in.
//
//   node init.mjs [board.json] [--repo <path>] [--item "<what>"]... [--check "<cmd>"] [--model <m>] [--force]
//
// The board this writes is the smallest one that runs: a sandbox block pointing at the repo, the
// work items given on the command line, no edges, no attempts. The judge, mapping and ontology
// stay off, so every proposal an attempt hands back waits for a person. Nothing here launches
// anything; the next step is `ostoyae doctor`, and it says so.
//
// `OSTOYAE_CWD` preserves your invocation directory before the installed CLI changes directories.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readJSON, resolveExecution, selfCommand } from './lib/cli-config.mjs';
import { claimRunLock, liveLockHolder, lockClaimant, lockPathOf, holderDoing, removeLock, removeOwnRunfile } from './lib/liveness.mjs';
import { captureIdentity, canonicalPath } from './lib/process-identity.mjs';
import { terminal } from './lib/terminal.mjs';
import { randomUUID } from 'node:crypto';
import { registerBoard } from './lib/boards.mjs';
import { detectCheck } from './lib/check-detect.mjs';

const argv = process.argv.slice(2);
const cwd = process.env.OSTOYAE_CWD || process.cwd();
const VALUED = new Set(['--repo', '--item', '--check', '--model', '--effort', '--agent', '--profile', '--exec', '--env']);
const items = [], passthrough = [], options = {};
let board = null, repoArg = null, check = null, force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--') || !v.trim()) { console.error(`  ${a} needs a value. Nothing written.`); process.exit(2); }
    if (a === '--repo') repoArg = v; else if (a === '--item') items.push(v);
    else if (a === '--check') check = v;
    else if (a === '--env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) { console.error('  --env accepts a variable name, never NAME=value. Nothing written.'); process.exit(2); }
      if (!passthrough.includes(v)) passthrough.push(v);
    } else options[a.slice(2)] = v;
  } else if (a === '--force') force = true;
  else if (a.startsWith('--')) { console.error(`  unknown flag ${a}. Nothing written.`); process.exit(2); }
  else if (a.endsWith('.json') && !board) board = a;
  else { console.error(`  unexpected argument ${a}. Nothing written.`); process.exit(2); }
}

const abs = (p) => (isAbsolute(p) ? p : resolve(cwd, p));
const git = (args, dir) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let execution;
try { execution = resolveExecution({}, options, process.env, import.meta.dirname); }
catch (e) { console.error(`  ${e.message}. Nothing written.`); process.exit(2); }
if (execution.provider === 'hermes' && process.env.HERMES_HOME && !passthrough.includes('HERMES_HOME'))
  passthrough.push('HERMES_HOME');

let repo;
try { repo = git(['rev-parse', '--show-toplevel'], abs(repoArg ?? '.')); }
catch {
  console.error(`  ${abs(repoArg ?? '.')} is not inside a git repository. Run this from the repository the` +
                `\n  agents should work on, or pass --repo <path>. Nothing written.`);
  process.exit(2);
}
let base, commit;
try { commit = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repo); }
catch {
  console.error(`  ${repo} has no commit on HEAD yet. Commit something first. Nothing written.`);
  process.exit(2);
}
try { base = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo); }
catch (e) {
  if (e.status !== 1) { console.error(`  could not inspect HEAD: ${e.code ?? e.status}. Nothing written.`); process.exit(2); }
  base = commit;
}

const file = canonicalPath(abs(board ?? 'ostoyae.json'));
if (existsSync(file) && !force) {
  console.error(`  ${file} already exists. Pass --force to overwrite it. Nothing written.`);
  process.exit(2);
}
const runfile = file.replace(/\.json$/, '') + '.run.json';
if (existsSync(runfile)) {
  console.error(`  ${runfile} exists. Stop the runner and settle its record before replacing this board. Nothing written.`);
  process.exit(2);
}
// A starter between its claim and its first beat holds the lock and has no runfile yet.
// Overwriting the board under it replaces the record it is about to write. Fail closed at
// the same bar launch refuses at: a live OR unverifiable holder. A stale lock is broken
// by the claim below, not here -- and only a verified holder's role is named.
const holder = lockClaimant(lockPathOf(runfile), file);
if (holder) {
  const verified = liveLockHolder(lockPathOf(runfile), file);
  if (verified) console.error(`  pid ${verified.pid} is ${holderDoing(verified)} on this graph and holds its lock.` +
                ` Wait for it before replacing this board. Nothing written.`);
  else console.error(`  pid ${holder.pid} holds this graph's lock but its ownership cannot be verified.` +
                ` Refusing to overwrite beside it. Nothing written.`);
  process.exit(2);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Two boards in one pursuit must never share attempt branches, trunk, or cell paths.
// The identifier is saved in the board, so moving that board to another machine preserves it.
const graph = `${slug(basename(repo)) || 'repo'}-${slug(basename(file, '.json')) || 'board'}-${randomUUID().slice(0, 8)}`;

// Dependency caches worth sharing into every cell rather than rebuilding: present in the repo and
// ignored by it. A path that is tracked is part of the work and is not linked.
const ignored = (rel) => { try { git(['check-ignore', '-q', rel], repo); return true; } catch { return false; } };
const link = ['node_modules', '.venv', 'venv', 'target', 'vendor', '.lake/packages']
  .filter((rel) => existsSync(join(repo, rel)) && ignored(rel));

// A test command the repository already answers to, offered as each item's `check`. A guess
// here is printed, not hidden: a wrong check fails every attempt, so the line says to read it.
let detected;
try { detected = check ?? detectCheck(repo); }
catch (e) { console.error(`  ${e.message}. Nothing written.`); process.exit(2); }

const ids = new Set();
const work = items.map((what, i) => {
  let id = `w-${slug(what.split(/\s+/).slice(0, 4).join(' ')) || i + 1}`.slice(0, 40).replace(/-$/, '');
  while (ids.has(id)) id = `${id}-${i + 1}`;
  ids.add(id);
  return { id, what, needs: [], ...(detected ? { check: detected } : {}) };
});

const g = {
  graph,
  concurrency: 2,
  max_attempts: 2,
  execution: {
    provider: execution.source === 'OSTOYAE_EXEC' ? 'custom' : execution.provider,
    profile: execution.profile,
    ...(execution.provider === 'custom' || execution.source === 'OSTOYAE_EXEC' ? { command: execution.command } : {}),
  },
  ...(execution.model !== null || execution.effort !== null ? { defaults: {
    ...(execution.model !== null ? { model: execution.model } : {}),
    ...(execution.effort !== null ? { effort: execution.effort } : {}),
  } } : {}),
  sandbox: {
    repo,
    root: join(dirname(repo), 'ostoyae-worktrees'),
    base,
    port_base: 'auto',
    ...(link.length ? { link } : {}),
    ...(passthrough.length ? { env_passthrough: passthrough } : {}),
  },
  work,
  edges: [],
  attempts: [],
};
// Claimed just before the write, as every other writer does: the claim serializes two
// racing inits, and the runfile re-check catches a legacy runner that beat in the window
// (a lock-aware one would hold the lock and fail this claim instead). Written through a
// temp file and a rename: a kill mid-write must not tear the board.
const LOCK = lockPathOf(runfile);
const INIT_IDENTITY = captureIdentity(process.pid, { runnerFile: file });
const INIT_STARTED = new Date().toISOString();
const claim = await claimRunLock(LOCK, { file, identity: INIT_IDENTITY, started: INIT_STARTED, role: 'init' });
if (!claim.claimed) {
  const h = claim.holder;
  console.error(h?.pid
    ? `  pid ${h.pid} holds this graph's lock. Wait for it before replacing this board. Nothing written.`
    : `  another writer holds this graph's lock and its holder could not be read. Nothing written.`);
  process.exit(2);
}
// Held like every other writer: a pre-lock engine never looks at the lock, so without this
// runfile it would start beside the replacement. Single beat, no timer: the hold is one write.
// A legacy runner beats no lock, so one that appeared during the build owns the runfile now
// and must be refused before this record overwrites it.
if (existsSync(runfile)) {
  removeLock(LOCK);
  console.error(`  ${runfile} appeared while this board was being built. Stop the runner and settle its record before replacing this board. Nothing written.`);
  process.exit(2);
}
{
  const temp = `${runfile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ file, pid: process.pid, identity: INIT_IDENTITY,
    started: INIT_STARTED, beat: new Date().toISOString(), role: 'init' }) + '\n');
  renameSync(temp, runfile);
}
const releaseInit = () => { removeOwnRunfile(runfile); removeLock(LOCK); };
let ownRunfile = false;
try { ownRunfile = JSON.parse(readFileSync(runfile, 'utf8'))?.pid === process.pid; } catch { ownRunfile = false; }
if (!ownRunfile) {
  releaseInit();
  console.error(`  ${runfile} is held by another writer. Stop it and settle its record before replacing this board. Nothing written.`);
  process.exit(2);
}
// The old write used flag 'wx' without --force: a board that appeared mid-build still refuses.
if (!force && existsSync(file)) {
  releaseInit();
  console.error(`  ${file} already exists. Pass --force to overwrite it. Nothing written.`);
  process.exit(2);
}
try {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(g, null, 2) + '\n');
  renameSync(tmp, file);
} catch (e) {
  releaseInit();
  console.error(`  could not write ${file}: ${e.code}. Check the output directory and permissions.`);
  process.exit(2);
}
releaseInit();

try { registerBoard(file); }
catch (e) { console.error(`  Board created at ${file}, but its board-list entry could not be saved: ${e.message}`); process.exit(2); }

const shown = relative(canonicalPath(cwd), file) || file;
const t = terminal();
console.log(t.heading('Board created', 'Configure once. Check readiness. Start when you choose.'));
console.log(t.row('Board', shown));
console.log(t.row('Provider', `${g.execution.provider} · ${execution.profile}`));
console.log(t.row('Model', execution.model ?? 'provider default; choose an exact model with --model'));
console.log(t.row('Effort', execution.effort ?? 'provider default; choose a level with --effort'));
console.log(`  repository   ${repo}  (${base === commit ? 'detached commit' : 'branch'} ${base})`);
console.log(`  cells under  ${g.sandbox.root}`);
if (link.length) console.log(`  linked in    ${link.join(', ')}  (shared caches; write protection depends on the executor)`);
console.log(`  work items   ${work.length}${work.length ? ': ' + work.map((w) => w.id).join(', ') : '  (add some: "work": [{ "id", "what", "needs": [] }])'}`);
if (detected) console.log(`  check        ${detected}  on every item${check ? '' : ', guessed from the repository. Read it: a wrong check fails every attempt'}`);
else console.log(`  check        none. Attempts are done on the agent's word until an item declares one`);
if (passthrough.length) console.log(t.row('Environment', `${passthrough.join(', ')}; names only, no values saved`));
if (file.startsWith(repo + '/')) {
  const inside = relative(repo, file);
  console.log(`\n  the board is inside the repository. Commit it or ignore it, your call; the runner also writes` +
              `\n  ${inside.replace(/\.json$/, '')}.run.json and .live.json beside it while a run is up, and those are not the record.`);
}
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const command = selfCommand(import.meta.dirname);
console.log(`\n  next:  ${command} doctor ${quote(shown)}        checks everything, spends nothing` +
            `\n         ${command} dry ${quote(shown)}           walks the board, touches nothing` +
            `\n         ${command} go ${quote(shown)} --launches 1   one agent session, then stop\n`);
