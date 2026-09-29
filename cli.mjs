#!/usr/bin/env node
// One entry point for the terminal, installed package, and headless sessions.
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { derive } from './viewer/state.mjs';
import { spendSoFar } from './lib/spend.mjs';
import { readJSON, readBoard, selectBoard, resolveExecution, terminalMode, executionSignature, selfCommand } from './lib/cli-config.mjs';
import { land, landItem, trunkReport } from './lib/land.mjs';
import { listProviders, findExecutable } from './lib/providers.mjs';
import { mixesAgents } from './lib/attempt-execution.mjs';
import { terminal } from './lib/terminal.mjs';
import { processOwner, captureIdentity } from './lib/process-identity.mjs';
import { canonical, discoverBoards, registerBoard, overlappingWork } from './lib/boards.mjs';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const cwd = process.env.OSTOYAE_CWD || process.cwd();
const version = readJSON(join(root, 'package.json')).version;
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const print = text => process.stdout.write(text + '\n');
const commands = new Set(['init', 'setup', 'add', 'import', 'boards', 'campaign', 'providers', 'go', 'doctor', 'status', 'watch', 'stop', 'dry', 'confirm', 'reject', 'confirm-scoped', 'land', 'demo', 'help', 'version']);
const valued = new Set(['--board', '--agent', '--model', '--effort', '--profile', '--exec', '--launches', '--usd', '--output-tokens', '--invocations', '--only', '--reserve-usd', '--adopt-wait', '--reject-why', '--interval']);
const common = ['--agent', '--model', '--effort', '--profile', '--exec'];
const allowed = {
  go: [...common, '--launches', '--usd', '--output-tokens', '--invocations', '--only', '--reserve-usd', '--adopt-wait', '--keep', '--auto-advance', '--messaging', '--no-messaging', '--terminal', '--headless', '--browser', '--control', '--json'],
  doctor: [...common, '--json'],
  dry: [...common, '--only', '--keep', '--gate', '--auto-advance'],
  status: [...common, '--json'],
  watch: [...common, '--terminal', '--headless', '--browser', '--control', '--once', '--interval'],
  stop: ['--now'], confirm: ['--dry-run'], reject: ['--dry-run', '--reject-why'],
  'confirm-scoped': ['--dry-run'], providers: ['--json'], demo: ['--no-viewer'],
  boards: ['--json'], land: ['--json'],
};
for (const name of ['go', 'doctor', 'dry', 'status', 'watch', 'stop', 'confirm', 'reject', 'confirm-scoped', 'land']) allowed[name].push('--board');

function parse(command, args) {
  const options = {}, forward = [], positions = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positions.push(arg); continue; }
    if (!(allowed[command] ?? []).includes(arg)) throw new Error(`unknown ${command} argument ${arg}; nothing launched`);
    let value = true;
    if (valued.has(arg)) {
      value = args[++i];
      if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`${arg} needs a value; nothing launched`);
    }
    const key = arg.slice(2);
    if (options[key] !== undefined) throw new Error(`${arg} was supplied twice`);
    options[key] = value;
    if (common.includes(arg) || ['--board', '--json', '--terminal', '--headless', '--browser', '--control', '--once', '--interval'].includes(arg)) continue;
    const numeric = ['--launches', '--usd', '--output-tokens', '--invocations', '--reserve-usd', '--adopt-wait'];
    if (numeric.includes(arg)) {
      const integer = ['--launches', '--output-tokens', '--invocations'].includes(arg);
      if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(value) || !Number.isFinite(Number(value)) || (integer && !Number.isSafeInteger(Number(value)))) throw new Error(`${arg} needs a nonnegative ${integer ? 'integer' : 'number'}; nothing launched`);
    }
    const alias = { '--launches': '--max-launches', '--usd': '--max-usd', '--output-tokens': '--max-output-tokens', '--invocations': '--max-invocations' };
    forward.push(alias[arg] ?? arg);
    if (value !== true) forward.push(value);
  }
  const boards = positions.filter(p => p.endsWith('.json'));
  if (boards.length > 1) throw new Error('pass one board.json path');
  if (boards.length && options.board) throw new Error('select one board using its path or --board, not both');
  const rest = positions.filter(p => p !== boards[0]);
  if (['confirm', 'reject'].includes(command)) {
    if (rest.length > 1) throw new Error(`${command} requires one comma-separated list of ids`);
  } else if (command === 'land') {
    if (rest.length > 1) throw new Error(`land needs one item id`);
  } else if (rest.length) throw new Error(`unexpected ${command} argument ${rest[0]}`);
  if (options.headless) options.terminal = true;
  return { options, forward, board: options.board ?? boards[0], ids: rest[0] };
}

async function child(script, args = [], extra = {}) {
  return await new Promise((resolve, reject) => {
    const p = spawn('node', [script, ...args], { cwd: root, env: process.env, stdio: 'inherit', detached: process.platform !== 'win32', ...extra });
    const signal = name => {
      try { process.platform === 'win32' ? p.kill(name) : process.kill(-p.pid, name); }
      catch (e) { if (e.code !== 'ESRCH') process.stderr.write(`cannot forward ${name}: ${e.message}\n`); }
    };
    const interrupt = () => signal('SIGINT'), terminate = () => signal('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    p.on('error', e => { cleanup(); reject(new Error(`cannot start ${script}: ${e.message}`)); });
    p.on('close', (code, sig) => { cleanup(); resolve(code ?? (sig === 'SIGINT' ? 130 : 1)); });
  });
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; }
}

export function snapshot(file, options = {}) {
  const board = readBoard(file), execution = resolveExecution(board, options, process.env, root);
  for (const work of board.work) {
    if (typeof work.id !== 'string' || !work.id) throw new Error('work record has no id');
    if (work.status !== undefined && !['active', 'proposed', 'rejected'].includes(work.status)) throw new Error(`unknown work status ${work.status} on ${work.id}`);
  }
  const state = derive(board, { index: true }), ready = state.readyIds();
  const work = Object.fromEntries(['ready', 'running', 'done', 'walled', 'waiting', 'blocked', 'exhausted', 'proposed', 'rejected', 'mapped'].map(s => [s, 0]));
  for (const item of board.work) { const key = state.stateOf(item.id, ready); work[key] = (work[key] ?? 0) + 1; }
  const attempts = { total: board.attempts.length, running: 0, done: 0, walled: 0, failed: 0, unknown: 0 };
  for (const attempt of board.attempts) {
    if (['running', 'done', 'walled', 'failed'].includes(attempt.state)) attempts[attempt.state]++;
    else attempts.unknown++;
  }
  let runner = { state: 'none' };
  const runfile = file.replace(/\.json$/, '') + '.run.json';
  // Refuse a corrupt heartbeat instead of treating it as an empty or idle runner.
  if (existsSync(runfile)) {
    const r = readJSON(runfile, 'runner heartbeat');
    if (!r || typeof r !== 'object') throw new Error(`invalid runner heartbeat ${runfile}`);
    const beat = Date.parse(r.beat), age = Number.isFinite(beat) ? Math.max(0, Math.round((Date.now() - beat) / 1000)) : null;
    const owner = processOwner(r.pid, { identity: r.identity, runnerFile: file });
    runner = { state: !Number.isSafeInteger(r.pid) || r.pid <= 0 || age === null || owner === null ? 'unknown' : !owner ? 'gone' : age > 15 ? 'wedged' : 'live',
      pid: r.pid ?? null, age_seconds: age, launched: r.launched ?? null, budget: r.budget ?? null,
      invocation_allowance: r.invocation_allowance ?? null, budgets: r.budgets ?? null,
      role: r.role ?? null };
  }
  const spend = spendSoFar(board);
  const selectedAgent = (w, role) => ['CLI', 'OSTOYAE_EXEC'].includes(execution.source) ? execution.provider
    : w.params?.agent ?? role?.agent ?? board.defaults?.agent ?? execution.provider;
  const mix = [...new Set([
    ...board.work.filter(w => w.status !== 'rejected').flatMap(w => [selectedAgent(w),
      ...(board.mapping ? [selectedAgent(w, board.mapping.params)] : []),
      ...(board.judge?.verify ? [selectedAgent(w, board.judge.params)] : [])]),
    ...board.attempts.map(a => a.params?.agent),
  ].filter(Boolean))];
  const pending = work.proposed + board.edges.filter(e => e.status === 'proposed').length;
  const last = board.last_run ?? null;
  const reason = runner.state === 'live' ? 'Running; work and usage update as attempts settle.'
    : runner.state === 'gone' ? 'Runner exited without a clean finish; its cells may still be running.'
    : runner.state === 'wedged' ? 'Runner is alive but its heartbeat is stale.'
    : runner.state === 'unknown' ? 'Runner heartbeat is incomplete; activity is unknown.'
    : last?.why ?? (board.attempts.length ? 'Previous stop reason is not recorded.' : 'No attempts recorded yet.');
  return { graph: board.graph, file, execution, mix, runner, work: { total: board.work.length, ...work }, attempts, pending,
    spend: { ...spend, unmeasured_tokens: board.attempts.length - spend.token_measured },
    budgets: { recorded: !!(runner.budgets || last?.budgets), launches: runner.budgets?.launches ?? runner.budget ?? last?.budgets?.launches ?? null,
      invocation_allowance: runner.invocation_allowance ?? last?.invocation_allowance ?? null,
      usd: runner.budgets?.usd ?? last?.budgets?.usd ?? null,
      output_tokens: runner.budgets?.output_tokens ?? last?.budgets?.output_tokens ?? null },
    last_run: last, reason, next: last?.next ?? (pending ? 'Review proposals, then confirm or reject their ids.' : 'ostoyae doctor, then ostoyae dry'),
    latest_failure: [...board.attempts].reverse().find(a => a.state === 'failed')?.result?.why ?? null };
}

// What to say first about a board: one plain sentence, the thing a person would ask.
function headline(data) {
  const w = data.work, r = data.runner.state;
  if (r === 'live') return `Running. ${w.running} job${w.running === 1 ? '' : 's'} in progress, ${w.done} of ${w.total} done.`;
  if (['gone', 'wedged', 'unknown'].includes(r)) return data.reason;
  if (!data.attempts.total) return `No attempts recorded yet. ${w.total} job${w.total === 1 ? '' : 's'} on the board.`;
  if (data.pending) return `${data.pending} new job${data.pending === 1 ? '' : 's'} or link${data.pending === 1 ? '' : 's'} found, waiting for your yes.`;
  if (w.total && w.done === w.total) return `Done. All ${w.total} job${w.total === 1 ? '' : 's'} passed ${w.total === 1 ? 'its' : 'their'} check${w.total === 1 ? '' : 's'}.`;
  return `${w.done} of ${w.total} done. ${data.reason}`;
}

function renderStatus(data, compact = false) {
  const t = terminal(), w = data.work, a = data.attempts, s = data.spend, b = data.budgets;
  const finished = w.total && w.done === w.total && data.runner.state !== 'live' && !data.pending;
  const next = finished ? `${selfCommand(root)} land ${quote(relativeBoard(data.file))}` : data.next;
  const lines = [t.heading(headline(data), `${data.graph}  ·  v${version}`)];
  lines.push(finished ? `  ${t.dim('Next'.padEnd(t.width >= 80 ? 16 : 14))}${t.accent(next)}` : t.row('Next', next), '');
  const count = (n, word) => n ? `${n} ${word}` : '';
  lines.push(t.row('Jobs', [`${w.done}/${w.total} done`, count(w.running, 'running'), count(w.ready, 'ready'),
    count(w.waiting + w.blocked, 'waiting'), count(w.walled, 'walled'), count(w.exhausted, 'out of tries'),
    count(w.mapped, 'mapped'), count(data.pending, 'to decide')].filter(Boolean).join(' · ')));
  if (data.runner.state !== 'none') lines.push(t.row('Runner', `${data.runner.state}${data.runner.pid ? ` · pid ${data.runner.pid} · heartbeat ${data.runner.age_seconds ?? 'unknown'}s` : ''}${data.runner.role && data.runner.role !== 'run' ? ` · ${data.runner.role}` : ''}`));
  lines.push(t.row('Agents', `${data.mix.length ? data.mix.join(' · ') : data.execution.provider}${data.execution.model ? `  (${data.execution.model})` : ''}`));
  lines.push(t.row('Attempts', `${a.total}${a.total ? ` · ${a.done} done · ${a.walled} walled · ${a.failed} failed${a.unknown ? ` · ${a.unknown} unknown` : ''}` : ''}`));
  if (a.total) lines.push(t.row('Spent', `${s.priced ? `$${s.usd.toFixed(2)}` : 'dollars unknown'}${s.unpriced && s.priced ? ` (${s.unpriced} of ${a.total} unpriced)` : ''} · ${s.output_tokens} output tokens${s.unmeasured_tokens ? ` (${s.unmeasured_tokens} unmeasured)` : ''}`));
  const caps = [b.launches !== null && `${b.launches} launches`, b.invocation_allowance !== null && `${a.total}/${b.invocation_allowance} sessions`,
    b.usd !== null && `$${b.usd}`, b.output_tokens !== null && `${b.output_tokens} output tokens`].filter(Boolean);
  lines.push(t.row('Caps', caps.length ? caps.join(' · ') : b.recorded ? 'none set' : 'not recorded'));
  if (data.last_run) lines.push(t.row('Last run', `${data.last_run.launched ?? 'unknown'} launched · ${data.last_run.ended ?? 'end time unknown'}`));
  if (data.latest_failure) lines.push(t.row('Last failure', data.latest_failure));
  if (!finished && data.reason && !headline(data).includes(data.reason)) lines.push('', t.quiet(data.reason));
  lines.push('');
  return lines.join('\n');
}

// Help for one command. Each entry: title, usage lines, flag rows, closing note.
const topics = {
  go: ['Run agents on a board', ['ostoyae go [board.json] --invocations 3'], [
    ['--invocations N', 'At most N agent sessions of any kind, counted across restarts.'], ['--launches N', 'At most N work launches in this run.'],
    ['--usd N', 'Stop launching once reported spend reaches $N.'], ['--output-tokens N', 'Stop launching once reported output tokens reach N.'],
    ['--reserve-usd N', 'Keep $N of the dollar cap unspent.'], ['--only ID', 'Run only this work item.'], ['--keep', 'Keep cell worktrees after attempts settle.'],
    ['--auto-advance', 'Continue into newly unblocked work within the same caps.'], ['--no-messaging', 'Disable messages for this run. On by default.'], ['--messaging', 'Enable messages explicitly; already on by default.'], ['--agent, --model, --effort, --profile, --exec', 'Override the saved executor for this run.'],
    ['--terminal | --headless | --browser', 'Where progress is shown. --headless is plain terminal output.'], ['--control', 'With --browser: the page may confirm, reject and launch. Otherwise it only shows the board.'], ['--json', 'One JSON object on stdout; progress on stderr.'],
    ['--board PATH', 'Select the board by path.'],
  ], 'Needs at least one positive cap. Runs doctor first and refuses to launch if it fails. Finished work lands on the board trunk branch; take it with ostoyae land.'],
  land: ['Take the finished work', ['ostoyae land [board.json]', 'ostoyae land <item-id> [--board FILE]'], [
    ['--json', 'One JSON object on stdout.'], ['--board PATH', 'Select the board by path.'],
  ], 'Fast-forwards the board base to its trunk with no item id. With an id, creates an isolated PR branch from the base, includes recorded dependency commits, and runs the item check on a fresh worktree. Refuses while a runner file is present.'],
  add: ['Add work to a board', ['ostoyae add [board.json] "what"', 'cat bugs.txt | ostoyae add [board.json]'], [
    ['--check CMD', 'Check for the new item.'], ['--needs ID,ID', 'Existing dependencies.'], ['--id ID', 'Choose an id.'], ['--board FILE', 'Select the board by path.'],
  ], 'Adds one item per nonempty stdin line when no text argument is given. Lines starting with # are skipped. Refuses while a runner owns the board.'],
  import: ['Import GitHub bugs', ['ostoyae import github OWNER/REPO'], [
    ['--label L', 'Issue label; repeatable. Defaults to bug.'], ['--limit N', 'Maximum issues; defaults to 50.'],
    ['--check CMD', 'Check for imported issues.'], ['--board FILE', 'Select or create this board.'],
    ['--repo PATH', 'The target checkout; defaults to the current repository.'], ['--dry-run', 'Show changes without writing.'], ['--any-author', 'Also import issues from people without push access.'],
  ], 'Imports open issues from people with push access, skips pull requests, and asks for a regression test in every item. Issue text is never used as a command.'],
  doctor: ['Check readiness', ['ostoyae doctor [board.json]'], [['--json', 'One JSON object on stdout.'], ['--agent, --model, --effort, --profile, --exec', 'Check a different executor.']],
    'Checks the board, repository, worktree root and executor login status. Sends no model prompt.'],
  dry: ['Walk the board', ['ostoyae dry [board.json]'], [['--only ID', 'Walk only this item.'], ['--auto-advance', 'Walk into newly unblocked work.']],
    'Simulates the run. Creates no branches, worktrees or attempts.'],
  status: ['Read the board', ['ostoyae status [board.json]'], [['--json', 'Structured state for an orchestrating agent.']],
    'Work, attempts, usage, caps and why the last run stopped.'],
  watch: ['Watch a run', ['ostoyae watch [board.json]', 'ostoyae watch [board.json] --browser', 'ostoyae watch [board.json] --browser --control'], [
    ['--browser', 'Start the viewer on 127.0.0.1. OSTOYAE_PORT fixes the port. The page only shows the board.'], ['--control', 'With --browser: the page may confirm, reject and launch.'], ['--once', 'Print once and exit.'], ['--interval MS', 'Refresh interval.']],
    'Ctrl-C stops watching; the run continues.'],
  stop: ['Stop a run', ['ostoyae stop [board.json]'], [['--now', 'Also stop running cells whose process identity is verified.']],
    'Stops new launches and lets current work land.'],
};

function help(topic) {
  const t = terminal();
  if (Object.hasOwn(topics, topic)) {
    const [title, usage, rows, note] = topics[topic];
    print(t.heading(title, `ostoyae ${topic}  v${version}`));
    for (const u of usage) print(t.text(u));
    print('');
    for (const [a, b] of rows) print(t.row(a, b));
    print('\n' + t.text(note) + '\n'); return;
  }
  const setup = topic === 'init' || topic === 'setup';
  print(t.heading(setup ? 'Set up a board' : 'Agents fix your code. Whatever blocks them becomes the next job.', `v${version}`).replace(/\n$/, ''));
  if (topic === 'init' || topic === 'setup') {
    print(t.text('Run this in the Git repository agents should work on:'));
    print(t.text('ostoyae init --agent codex --item "Describe the outcome"'));
    for (const [a, b] of [
      ['--agent NAME', 'Choose a provider. Run ostoyae providers to see adapters.'], ['--model ID', 'Exact provider model id or supported alias; no fixed model menu.'],
      ['--effort LEVEL', 'Reasoning effort token passed to the provider.'],
      ['--profile NAME', 'auto, local, headless, claude-cloud'], ['--exec COMMAND', 'Custom executor command using the standard cell handback.'],
      ['--env NAME', 'Pass this environment variable into cells. Repeat for more names; no values are stored.'],
      ['--item TEXT', 'Add a work item; repeat to add more.'], ['--check COMMAND', 'A check that decides whether the work succeeded.'],
      ['--repo PATH', 'Repository to work on; defaults to this directory.'], ['--force', 'Replace an existing board only when no runner owns it.'],
    ]) print(t.row(a, b));
    print('\n' + t.text('Writes configuration only. Next: ostoyae doctor, then ostoyae dry.') + '\n'); return;
  }
  print(t.section('Try it'));
  print(t.command('ostoyae demo', 'watch a board grow; no model calls'));
  print(t.section('Start'));
  print(t.command('ostoyae init --agent claude --item "Fix the login bug"', 'a board with one job'));
  print(t.command('ostoyae import github OWNER/REPO', 'or: a job for every open bug'));
  print(t.command('ostoyae go --launches 3', 'run agents, at most 3 sessions'));
  print(t.section('While it runs'));
  print(t.command('ostoyae status', 'where the board is and what to do next'));
  print(t.command('ostoyae watch', 'live here; --browser shows the graph'));
  print(t.command('ostoyae land', 'take the finished work onto your branch'));
  print(t.section('Also'));
  print(t.quiet('add · doctor · dry · stop · confirm · reject · boards · providers · campaign'));
  print('\n' + t.quiet('ostoyae COMMAND --help for flags. ostoyae --help --json for agents.') + '\n');
}

function capabilities() {
  return { name: 'ostoyae', version, schema_version: 1,
    description: 'An agent runs the CLI; a human supervises through the optional browser viewer.',
    commands: [...commands].map(command => ({ command,
      flags: command === 'campaign'
        ? ['--repo', '--board', '--branch', '--from', '--dir', '--agent', '--model', '--effort', '--profile', '--exec', '--invocations', '--launches', '--usd', '--output-tokens'].map(flag => ({ flag, value: true })).concat(['--check', '--publish-only', '--auto-advance'].map(flag => ({ flag, value: false })))
        : command === 'init' || command === 'setup'
        ? ['--repo', '--item', '--check', '--agent', '--model', '--effort', '--profile', '--exec', '--env'].map(flag => ({ flag, value: true, repeatable: ['--item', '--env'].includes(flag) })).concat([{ flag: '--force', value: false }])
        : command === 'add'
        ? ['--check', '--needs', '--id', '--board'].map(flag => ({ flag, value: true }))
        : command === 'import'
        ? ['--label', '--limit', '--check', '--board', '--repo'].map(flag => ({ flag, value: true, repeatable: flag === '--label' })).concat([{ flag: '--dry-run', value: false }, { flag: '--any-author', value: false }])
        : (allowed[command] ?? (command === 'help' ? ['--json'] : [])).map(flag => ({ flag, value: valued.has(flag) })),
      board_argument: (Object.hasOwn(allowed, command) && !['providers', 'demo', 'boards'].includes(command)) || ['init', 'setup', 'add', 'import'].includes(command),
      writes_board: ['init', 'setup', 'add', 'import', 'go', 'campaign', 'confirm', 'reject', 'confirm-scoped'].includes(command),
      invokes_models: ['go', 'campaign'].includes(command),
      read_only_with: command === 'campaign' ? '--check' : ['confirm', 'reject', 'confirm-scoped'].includes(command) ? '--dry-run' : null,
      json: ['help', 'boards', 'providers', 'doctor', 'status', 'go', 'land'].includes(command),
      writes_git: command === 'land' ? 'fast-forwards the board base branch to its trunk; never forces' : undefined,
    })),
    executor_precedence: ['CLI --exec or --agent', 'OSTOYAE_EXEC', 'board.execution', 'claude'],
    profiles: ['auto', 'local', 'headless', 'claude-cloud'],
    models: 'Exact provider IDs or aliases supported by that provider; no fixed enum.',
    workflow: ['doctor', 'dry', 'status', 'go', 'land'],
    json_output: 'One JSON object on stdout. go sends progress to stderr.',
    launch_budget: 'go requires a positive --launches, --usd, --output-tokens or --invocations value.',
    exit_codes: { 0: 'Command completed; inspect graph outcomes for done, walled, and failed work.', 1: 'Readiness or runtime failure.', 2: 'Invalid input or unreadable configuration.', 10: 'Work remains running or its ownership is unknown.', 130: 'Interrupted.' },
  };
}

function providers(json) {
  const inventory = listProviders().map(p => ({ ...p, installed: p.cli ? !!findExecutable(p.cli) : null }));
  if (json) return print(JSON.stringify({ providers: inventory }, null, 2));
  const t = terminal(); print(t.heading('Choose your executor', `Provider adapters  ·  v${version}`));
  for (const p of inventory) {
    print(t.row(p.id, `${p.label} · ${p.cli ? p.installed ? 'CLI found' : 'CLI missing' : 'bring your command'}${p.experimental ? ' · experimental' : ''}`));
    if (p.cli) print(t.text(`Requires ${p.cli}. Authentication is checked by ostoyae doctor.`));
  }
  if (!inventory.some(p => p.id === 'custom')) print(t.row('custom', 'Any compatible executor: --exec "your command"'));
  print('\n' + t.text('Model names go straight to the provider: --agent PROVIDER --model MODEL. Found on PATH does not mean authenticated. No model calls made.') + '\n');
}

function viewerFiles(file) {
  const port = process.env.OSTOYAE_PORT === undefined ? 0 : Number(process.env.OSTOYAE_PORT);
  if (process.env.OSTOYAE_PORT !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('OSTOYAE_PORT must be an integer from 1 to 65535');
  const key = createHash('sha256').update(canonical(file)).digest('hex').slice(0, 20);
  return { port, pidfile: join(tmpdir(), `ostoyae-viewer-board-${key}.json`), log: join(tmpdir(), `ostoyae-viewer-board-${key}.log`) };
}
async function viewerHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10000), headers: { connection: 'close' } });
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    if (e instanceof TypeError || e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof SyntaxError) return null;
    throw e;
  }
}
async function startViewer(file, execution, options) {
  registerBoard(file);
  const files = viewerFiles(file), { pidfile, log } = files;
  const saved = existsSync(pidfile) ? readJSON(pidfile, 'viewer record') : null;
  let port = files.port || saved?.port || 0;
  const existing = port ? await viewerHealth(port) : null;
  if (!existing && saved?.pid && (!files.port || files.port === saved.port) && processOwner(saved.pid, { identity: saved.identity }) !== false)
    throw new Error(`the recorded viewer on port ${saved.port} is alive or unverified but not answering; no duplicate viewer started. Log: ${log}`);
  if (existing?.pid && alive(existing.pid)) {
    if (canonical(existing.graph) !== canonical(file)) {
      if (files.port) throw new Error(`port ${port} already serves another board; omit OSTOYAE_PORT for automatic selection`);
      port = 0;
    } else {
      if (existing.execution_signature !== executionSignature(execution))
        throw new Error(`port ${port} uses different executor settings; restart that viewer or choose OSTOYAE_PORT`);
      if (!!existing.control !== !!options.control)
        throw new Error(`port ${port} already serves this board ${existing.control ? 'with' : 'without'} --control; stop that viewer (pid ${existing.pid}) or choose OSTOYAE_PORT`);
      print(`  viewer ready: http://localhost:${port}${options.control ? ' (control on: the page may confirm, reject and launch)' : ''}`); return;
    }
  }
  port = files.port || 0;
  const out = openSync(log, 'a');
  const overrides = [...(execution.source === 'CLI' ? ['--exec', execution.command] : []), ...(options.model === undefined ? [] : ['--model', execution.model]), ...(options.effort === undefined ? [] : ['--effort', execution.effort]), ...(options.control ? ['--control'] : [])];
  const child = spawn('node', ['viewer/serve.mjs', file, '--port', String(port), ...overrides], { cwd: root, detached: true, stdio: ['ignore', out, out, 'ipc'], env: process.env });
  closeSync(out);
  let error = null; child.on('error', e => { error = e; });
  child.on('message', message => { if (message?.type === 'listening' && Number.isInteger(message.port)) port = message.port; });
  try {
    for (let i = 0; i < 40; i++) {
      if (error) throw error;
      if (child.exitCode !== null) throw new Error(`viewer exited ${child.exitCode}`);
      const health = port ? await viewerHealth(port) : null;
      if (health?.pid === child.pid) {
        writeFileSync(pidfile, JSON.stringify({ pid: child.pid, port, file: canonical(file), identity: captureIdentity(child.pid) })); child.disconnect(); child.unref();
        print(`  viewer ready: http://localhost:${port}${options.control ? ' (control on: the page may confirm, reject and launch)' : ''}`);
        if (!process.env.OSTOYAE_NO_OPEN) {
          const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`http://localhost:${port}`], { stdio: 'ignore' });
          opener.on('error', e => process.stderr.write(`  browser could not open (${e.code}); use the URL above.\n`));
          opener.on('exit', code => { if (code) process.stderr.write(`  browser opener exited ${code}; use the URL above.\n`); });
          opener.unref();
        }
        return;
      }
      await sleep(100);
    }
    throw new Error('viewer did not answer');
  } catch (e) {
    child.kill('SIGTERM');
    throw new Error(`${e.message}; viewer log: ${log}`);
  }
}
async function stopViewer(file) {
  const { pidfile } = viewerFiles(file);
  if (!existsSync(pidfile)) return;
  const { pid, port, identity } = readJSON(pidfile, 'viewer record'), health = await viewerHealth(port);
  if (health?.pid === pid && canonical(health.graph) === canonical(file) && alive(pid)) { process.kill(pid, 'SIGTERM'); print('  viewer stopped'); }
  else if (processOwner(pid, { identity }) !== false) { print('  viewer ownership is unverified; its record is preserved and no process was killed'); return; }
  else print('  recorded viewer has exited; no process killed');
  rmSync(pidfile, { force: true });
}

async function watch(file, options) {
  const interval = options.interval === undefined ? 2000 : Number(options.interval);
  if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('--interval needs an integer of at least 100 milliseconds');
  const animated = !!process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' && !options.once;
  let stopping = false, wake = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (animated) process.stdout.write('\x1b[?1049h\x1b[?25l');
  try {
    do {
      const output = renderStatus(snapshot(file, options));
      if (animated) process.stdout.write('\x1b[H\x1b[2J');
      print(output);
      if (options.once) break;
      print(terminal().text(`Watching every ${interval / 1000}s · Ctrl-C stops watching; the run continues.`));
      await new Promise(resolve => { const timer = setTimeout(resolve, interval); wake = () => { clearTimeout(timer); resolve(); }; });
    } while (!stopping);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (animated) process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
  return 0;
}

// Where the finished work is and the command that takes it, for the end of a run.
function resultBranch(file) {
  const r = trunkReport(readBoard(file));
  const shown = relativeBoard(file);
  const command = `${selfCommand(root)} land ${quote(shown)}`;
  const lines = !r.commits_ahead
    ? [`No finished work on ${r.trunk} yet; ${r.base ?? 'the base branch'} is unchanged.`]
    : [`Finished work: ${r.commits_ahead} commit(s) on branch ${r.trunk} in ${r.repo}. ${r.base} is unchanged until you take it.`,
       `Take it: ${command}`];
  return { branch: r.trunk, repo: r.repo, base: r.base, commits_ahead: r.commits_ahead, fast_forward: r.fast_forward,
    land_command: r.commits_ahead ? command : null, lines };
}
function relativeBoard(file) {
  const rel = relative(canonical(cwd), file);
  return rel && !rel.startsWith('..') ? rel : file;
}

async function main() {
  const args = process.argv.slice(2), command = args.shift();
  if (command === '--version' || command === '-v' || command === 'version') { print(`ostoyae ${version}`); return 0; }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    if (args.includes('--json')) { print(JSON.stringify(capabilities(), null, 2)); return 0; }
    if (!command) {
      const file = selectBoard(null, cwd, root);
      if (file) { const t = terminal(); print(renderStatus(snapshot(file), true)); print(t.quiet('ostoyae watch  ·  ostoyae --help') + '\n'); return 0; }
    }
    help(args[0]); return 0;
  }
  if (!commands.has(command)) throw new Error(`unknown command: ${command}; run ostoyae --help`);
  if (command === 'campaign') return await child('campaign.mjs', args);
  if (args.includes('--help') || args.includes('-h')) { help(command); return 0; }
  if (command === 'init' || command === 'setup') {
    if (command === 'setup' && !args.length) { help(command); return 0; }
    return await child('init.mjs', args);
  }
  if (command === 'add' || command === 'import') return await child('ingest.mjs', [command, ...args], { cwd: root, stdio: 'inherit' });
  if (command === 'demo') return await child('demo.mjs', args);
  const parsed = parse(command, args), { options, forward } = parsed;
  if (command === 'providers') { providers(options.json); return 0; }
  if (command === 'boards') {
    const discovered = discoverBoards(cwd, root), errors = [...discovered.errors], rows = [], valid = [];
    for (const file of discovered.files) {
      try { const data = snapshot(file); rows.push(data); valid.push({ file, board: readBoard(file) }); }
      catch (e) { errors.push({ file, error: e.message }); }
    }
    const overlaps = overlappingWork(valid);
    if (options.json) print(JSON.stringify({ boards: rows, overlaps, errors }, null, 2));
    else {
      const t = terminal(); print(t.heading('Your boards', `${rows.length} readable · ${errors.length} unavailable`));
      for (const b of rows) { print(t.row(b.graph, `${b.work.done}/${b.work.total} done · ${b.work.running} running · ${b.pending} decisions`)); print(t.text(b.file)); }
      for (const e of errors) print(t.text(`${e.file}: ${e.error}`));
      print(t.text(`${overlaps.length} matching task description(s) across boards. Inspect with ostoyae boards --json.`));
      print(t.text('Each session chooses its board: ostoyae go --board PATH --invocations N.'));
    }
    return errors.length ? 1 : 0;
  }
  const file = selectBoard(parsed.board, cwd, root);
  if (!file) throw new Error('no board selected; run ostoyae init --item "Describe the work", or pass a board.json path.');
  if (!existsSync(file)) throw new Error(`board not found: ${file}. Run ostoyae init or pass an existing board.json path.`);
  if (['confirm', 'reject'].includes(command) && !parsed.ids)
    throw new Error(`${command} requires ids, for example: ostoyae ${command} board.json w-one,e-two`);
  if (command === 'land') {
    const board = readBoard(file), runnerFile = existsSync(file.replace(/\.json$/, '') + '.run.json');
    const result = parsed.ids ? await landItem(board, parsed.ids, { runnerFile }) : land(board, { runnerFile });
    if (options.json) print(JSON.stringify({ ok: result.ok, exit_code: result.code, ...result.report, messages: result.lines }, null, 2));
    else { const t = terminal(); print(t.heading(result.ok ? 'Land' : 'Land refused', result.report.branch ?? result.report.trunk)); for (const l of result.lines) print(`  ${l}`); print(''); }
    return result.code;
  }
  const board = readBoard(file), execution = resolveExecution(board, options, process.env, root);
  const modelArgs = options.model === undefined ? [] : ['--model', execution.model];
  const effortArgs = options.effort === undefined ? [] : ['--effort', execution.effort];
  // A single-agent board runs through one executor, as before. A board that picks agents per role or per job
  // gets no --exec: each attempt launches its own agent's executor.
  const executorArgs = [...(['CLI', 'OSTOYAE_EXEC'].includes(execution.source) || !mixesAgents(board) ? ['--exec', execution.command] : []), ...modelArgs, ...effortArgs];
  if (command === 'status') { const data = snapshot(file, options); print(options.json ? JSON.stringify(data, null, 2) : renderStatus(data)); return 0; }
  if (command === 'doctor') return await child('doctor.mjs', [file, ...executorArgs, ...(options.json ? ['--json'] : [])]);
  if (command === 'dry') return await child('run.mjs', [file, '--dry-run', ...modelArgs, ...effortArgs, ...forward]);
  if (command === 'watch') {
    terminalMode(execution.profile, options);
    if (options.browser) { await startViewer(file, execution, options); return 0; }
    return await watch(file, options);
  }
  if (command === 'go') {
    terminalMode(execution.profile, options);
    if (!['launches', 'usd', 'output-tokens', 'invocations'].some(key => Number(options[key]) > 0))
      throw new Error('go needs a positive budget: --invocations N, --launches N, --usd N or --output-tokens N. Nothing launched.');
    if (options.json && options.browser) throw new Error('go --json uses terminal progress; open the viewer separately with ostoyae watch --browser');
    registerBoard(file);
    const log = options.json ? text => process.stderr.write(text + '\n') : print;
    const streams = options.json ? { stdio: ['inherit', 2, 2] } : {};
    const t = terminal(); log(t.heading('Ready before running', `${snapshot(file, options).mix.join(' · ') || execution.provider} · ${execution.profile}`));
    log(t.row('Board', file));
    const checked = await child('doctor.mjs', [file, ...executorArgs], streams);
    if (checked) {
      process.stderr.write('  refusing to launch. Fix the checks above, then run ostoyae doctor.\n');
      if (options.json) print(JSON.stringify({ ok: false, exit_code: checked, phase: 'preflight', ...snapshot(file, options) }, null, 2));
      return checked;
    }
    if (options.browser) await startViewer(file, execution, options);
    else log(t.text(`Live events below. Another terminal: ostoyae watch ${quote(file)}. Ctrl-C drains active work.`));
    const result = await child('run.mjs', [file, ...executorArgs, ...forward], streams);
    if (result) process.stderr.write(`  runner exited ${result}; inspect ostoyae status ${quote(file)}\n`);
    const final = snapshot(file, options), landing = resultBranch(file);
    if (options.json) print(JSON.stringify({ ok: result === 0, exit_code: result, phase: 'finished', ...final, result_branch: landing }, null, 2));
    else {
      if (!result) print(t.text(`Run finished: ${final.last_run?.launched ?? 'unknown'} launched. Agents: ${final.mix.join(' · ') || execution.provider}. ${final.attempts.total} attempts recorded; ${final.attempts.failed} failed, ${final.attempts.walled} walled.${final.last_run?.messages === undefined ? '' : ` messages: ${final.last_run.messages} sent.`}`));
      for (const line of landing.lines) print(`  ${line}`);
    }
    return result;
  }
  if (command === 'stop') {
    const code = await child('run.mjs', [file, '--stop', ...forward]);
    if (code === 10) { print('  work remains running or unverified; inspect ostoyae status'); return 10; }
    if (!code) await stopViewer(file); return code;
  }
  return await child('run.mjs', [file, `--${command}`, ...(parsed.ids ? [parsed.ids] : []), ...forward]);
}

try { process.exitCode = await main(); }
catch (e) {
  if (process.argv.includes('--json')) print(JSON.stringify({ ok: false, exit_code: 2, error: e.message }));
  else process.stderr.write(`\n  ${e.message}\n\n`);
  process.exitCode = 2;
}
