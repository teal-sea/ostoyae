import { executorCommand, listProviders } from './providers.mjs';
import { effectiveEffort, validateEffort } from './effort.mjs';

// Does the board pick agents per role or per job? Then no single --exec may stand in for all of them.
export function mixesAgents(board) {
  return !!(board?.defaults?.agent || board?.mapping?.params?.agent || board?.judge?.params?.agent
    || (board?.work ?? []).some(w => w.params?.agent));
}
// Does the board name any agent at all? A board that names none runs only with an explicit executor.
export function selectsAgents(board) { return !!(board?.execution?.provider || mixesAgents(board)); }

export function attemptConfigs(board, fallback, override = null) {
  return (board.work ?? []).filter(w => w.status !== 'rejected').flatMap(w => {
    const base = { ...board.defaults, ...w.params };
    const jobAgent = w.params?.agent === undefined ? {} : { agent: w.params.agent };
    return [[w.id, base], ...(board.mapping ? [[`${w.id}/map`, { ...base, ...board.mapping.params, ...jobAgent }]] : []),
      ...(board.judge?.verify ? [[`${w.id}/verify`, { ...base, ...board.judge.params, ...jobAgent }]] : [])];
  }).map(([name, params]) => [name, resolveAttempt(params, fallback, override)]);
}

export function resolveAttempt(params, fallback, override = null, root = null, customCommand = null) {
  const agent = override?.provider ?? params.agent ?? fallback;
  if (!listProviders().some(p => p.id === agent)) throw Error(`unknown agent: ${agent}`);
  const model = params.model ?? null;
  if (agent === 'codex' && (typeof model !== 'string' || !model.trim())) throw Error('Codex needs params.model explicitly');
  if (model !== null && (typeof model !== 'string' || !model.trim())) throw Error('params.model must be a nonempty string');
  // Recognizable provider families are refused when paired with another adapter. Other
  // model IDs remain opaque, as providers may add new IDs without an Ostoyae release.
  if (agent !== 'custom' && model && ((agent !== 'claude' && /^(?:claude[-/]|(?:opus|sonnet|haiku)(?:[-/]|$))/i.test(model)) ||
    (agent !== 'codex' && /^(?:codex[-/]|gpt-[\w.-]*codex(?:[-/]|$))/i.test(model))))
    throw Error(`${model} does not belong to ${agent}`);
  const effort = effectiveEffort(params);
  if (effort != null) validateEffort(effort);
  const command = root ? (override?.command ?? executorCommand(agent, root, customCommand)) : null;
  return { agent, model, effort: effort ?? null, command };
}
