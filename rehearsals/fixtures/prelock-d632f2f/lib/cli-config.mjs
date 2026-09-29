// CLI and viewer share selection rules. Reading configuration never changes the board.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { executorCommand, identifyExecutor, listProviders } from './providers.mjs';

export const profiles = ['auto', 'local', 'headless', 'claude-cloud'];
export const executionSignature = ({ command, model }) => createHash('sha256')
  .update(JSON.stringify({ command, model })).digest('hex');
export function readJSON(file, label = 'configuration') {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`cannot read ${label} ${file}: ${e.code}`); }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`invalid JSON in ${label} ${file}: ${e.message}`); }
}

export function readBoard(file) {
  const board = readJSON(file, 'board');
  if (!board || typeof board !== 'object' || Array.isArray(board)) throw new Error(`board ${file} must be an object`);
  if (typeof board.graph !== 'string' || !board.graph.trim()) throw new Error(`board ${file} needs a graph name`);
  for (const key of ['work', 'edges', 'attempts']) {
    if (!Array.isArray(board[key])) throw new Error(`board ${file}: ${key} must be an array; missing is not empty`);
    if (board[key].some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error(`board ${file}: ${key} contains an invalid record`);
  }
  return board;
}

export function selectBoard(explicit, cwd, root, env = process.env) {
  if (explicit) return resolve(cwd, explicit);
  if (env.OSTOYAE_GRAPH) return resolve(cwd, env.OSTOYAE_GRAPH);
  if (existsSync(join(cwd, 'ostoyae.json'))) return join(cwd, 'ostoyae.json');
  const local = join(root, 'graph.local.json');
  if (!existsSync(local)) return null;
  const config = readJSON(local);
  if (!config || typeof config.graph !== 'string' || !config.graph.trim()) throw new Error(`${local}: graph must name a board path`);
  const selected = resolve(root, config.graph);
  // A legacy engine default must not silently attach an unrelated project to its board.
  // Explicit paths and OSTOYAE_GRAPH above remain intentional cross-project selection.
  const inside = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path !== '..' && !path.startsWith('../') && !isAbsolute(path); };
  if (inside(root, cwd)) return selected;
  if (existsSync(selected)) {
    const board = readBoard(selected);
    if (typeof board.sandbox?.repo === 'string' && inside(resolve(root, board.sandbox.repo), cwd)) return selected;
  }
  return null;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

export function resolveExecution(board, options = {}, env = process.env, root) {
  const saved = board.execution ?? {};
  if (board.execution !== undefined && (!board.execution || typeof saved !== 'object' || Array.isArray(saved))) throw new Error('execution must be an object');
  for (const key of Object.keys(saved)) if (!['provider', 'profile', 'command'].includes(key)) throw new Error(`unknown execution setting: ${key}`);
  if (saved.provider !== undefined) nonempty(saved.provider, 'execution.provider');
  if (saved.command !== undefined) nonempty(saved.command, 'execution.command');
  if (saved.profile !== undefined && !profiles.includes(saved.profile)) throw new Error(`unknown execution.profile: ${saved.profile}`);
  const ids = [...listProviders().map(p => p.id), 'custom'];
  if (saved.provider !== undefined && !ids.includes(saved.provider)) throw new Error(`unknown execution.provider: ${saved.provider}; run ostoyae providers`);
  if (saved.command !== undefined && saved.provider !== 'custom') throw new Error('execution.command requires execution.provider custom');
  if (saved.provider === 'custom' && saved.command === undefined) throw new Error('execution.provider custom requires execution.command');
  if (options.agent !== undefined && !ids.includes(options.agent)) throw new Error(`unknown agent: ${options.agent}; run ostoyae providers`);
  if (options.exec !== undefined && options.agent !== undefined && options.agent !== 'custom') throw new Error('--exec selects a custom executor; use --agent custom or omit --agent');
  const profile = options.profile ?? saved.profile ?? 'auto';
  if (!profiles.includes(profile)) throw new Error(`unknown profile: ${profile}; choose ${profiles.join(', ')}`);
  if (board.defaults !== undefined && (!board.defaults || typeof board.defaults !== 'object' || Array.isArray(board.defaults))) throw new Error('defaults must be an object');
  if (board.defaults?.model !== undefined) nonempty(board.defaults.model, 'defaults.model');
  const model = options.model !== undefined ? nonempty(options.model, '--model') : board.defaults?.model ?? null;
  let provider, command, source;
  if (options.exec !== undefined) {
    provider = 'custom'; command = nonempty(options.exec, '--exec'); source = 'CLI';
  } else if (options.agent !== undefined) {
    provider = options.agent; source = 'CLI';
    command = executorCommand(provider, root, provider === 'custom' ? saved.command : undefined);
  } else if (env.OSTOYAE_EXEC !== undefined) {
    command = nonempty(env.OSTOYAE_EXEC, 'OSTOYAE_EXEC'); source = 'OSTOYAE_EXEC';
    provider = identifyExecutor(command).provider ?? 'custom';
  } else {
    provider = saved.provider ?? 'claude'; source = saved.provider ? 'board' : 'default';
    command = executorCommand(provider, root, saved.command);
  }
  return { provider, profile, command, model, source };
}

export function terminalMode(profile, options = {}, env = process.env, tty = !!process.stdout.isTTY) {
  if (options.browser && options.terminal) throw new Error('--browser and --terminal/--headless cannot be combined');
  if (options.browser) return false;
  if (options.terminal || profile === 'headless' || profile === 'claude-cloud') return true;
  return !tty || !!(env.SSH_CONNECTION || env.SSH_TTY || env.CI || env.CLAUDE_CODE_REMOTE || env.CLAUDE_CODE_REMOTE_ENVIRONMENT);
}
