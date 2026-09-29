import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';

const providers = [
  { id: 'claude', label: 'Claude Code', cli: 'claude', auth: 'claude auth status', experimental: false,
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] },
  { id: 'codex', label: 'Codex', cli: 'codex', auth: 'codex login status', experimental: false,
    env: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] },
  { id: 'gemini', label: 'Gemini CLI', cli: 'gemini', auth: null, experimental: true,
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI'] },
  { id: 'aider', label: 'Aider', cli: 'aider', auth: null, experimental: true,
    env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_BASE', 'OLLAMA_API_BASE'] },
  { id: 'opencode', label: 'OpenCode', cli: 'opencode', auth: null, experimental: true,
    env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'] },
  { id: 'muse', label: 'Muse Code', cli: 'muse', auth: null, experimental: false,
    env: ['META_API_KEY', 'XDG_DATA_HOME'] },
  { id: 'grok', label: 'Grok Code', cli: 'grok', auth: null, experimental: false,
    env: [] },
  { id: 'hermes', label: 'Hermes Agent', cli: 'hermes', auth: null, experimental: false,
    env: ['HERMES_HOME'] },
  { id: 'custom', label: 'Custom executor', cli: null, auth: null, experimental: true, env: [] },
];

export function listProviders() {
  return providers.map((p) => ({ ...p, env: [...p.env] }));
}

export function cellEnvironment(passthrough = [], sourceEnv = process.env, provider = null) {
  if (!Array.isArray(passthrough) || passthrough.some((n) => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))
    throw Error('sandbox.env_passthrough must be an array of environment variable names');
  const env = {};
  const credentialNames = providers.find(p => p.id === provider)?.env ?? [];
  for (const name of new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', ...credentialNames, ...passthrough]))
    if (sourceEnv[name] !== undefined) env[name] = sourceEnv[name];
  return env;
}

export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function executorCommand(provider, root, customCommand) {
  if (!providers.some((p) => p.id === provider)) throw Error(`unknown provider: ${provider}`);
  if (provider === 'custom') {
    if (typeof customCommand !== 'string' || !customCommand.trim()) throw Error('custom provider needs an executor command');
    return customCommand;
  }
  return `bash ${shellQuote(join(root, 'executors', `${provider}.sh`))}`;
}

// Literal shell words only. Never evaluate a command just to find its provider. Shell
// expansions and operators need a custom executor diagnostic, not a guessed auth check.
export function commandWords(command) {
  const words = [];
  let word = '', quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === quote) quote = null; else word += c; }
    else if (c === '\\') {
      if (i + 1 === command.length) throw Error('unfinished escape in executor command');
      const next = command[++i];
      word += quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next) ? '\\' + next : next;
      started = true;
    } else if (c === '$' || c === '`' || (!quote && /[;|&<>()\n]/.test(c))) {
      throw Error('shell expansion or compound command requires a custom executor; authentication cannot be inferred');
    } else if (quote) { if (c === quote) quote = null; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += c; started = true; }
  }
  if (quote) throw Error('unclosed quote in executor command');
  if (started) words.push(word);
  return words;
}

export function identifyExecutor(command) {
  const result = { provider: 'custom', executable: null, argv: [], environment: {}, unset: [], clearEnvironment: false, wrappers: [], wrapperContexts: [] };
  const wrapper = (executable) => {
    result.wrappers.push(executable);
    result.wrapperContexts.push({ executable, environment: { ...result.environment },
      unset: [...result.unset], clearEnvironment: result.clearEnvironment });
  };
  let words;
  try { words = commandWords(command); }
  catch (e) { return { ...result, reason: e.message, malformed: /unclosed|unfinished/.test(e.message) }; }
  for (let depth = 0; depth < 16; depth++) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const assignment = words.shift(), i = assignment.indexOf('=');
      result.environment[assignment.slice(0, i)] = assignment.slice(i + 1);
    }
    if (!words.length) return { ...result, reason: 'executor command has no executable', malformed: true };
    const first = words.shift(), name = basename(first);
    if (name === 'env') {
      wrapper(first);
      while (words[0]?.startsWith('-')) {
        const option = words.shift();
        if (option === '--') break;
        if (['-i', '--ignore-environment', '-'].includes(option)) {
          result.clearEnvironment = true; result.environment = {}; result.unset = [];
        } else if (['-u', '--unset'].includes(option) && words.length) {
          const key = words.shift(); result.unset.push(key); delete result.environment[key];
        } else if (option.startsWith('--unset=')) {
          const key = option.slice(8); result.unset.push(key); delete result.environment[key];
        }
        else return { ...result, reason: 'unsupported env option; authentication cannot be inferred' };
      }
      continue;
    }
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
      wrapper(first);
      let commandString = false;
      while (words[0]?.startsWith('-') || words[0]?.startsWith('+')) {
        const option = words.shift();
        if (option === '--') break;
        if (/^-[^-]*c/.test(option)) {
          if (/[li]/.test(option)) return { ...result, reason: 'shell startup options change the environment; authentication cannot be inferred' };
          commandString = true; break;
        }
        if (['-o', '+o', '-O', '+O'].includes(option)) {
          if (!words.length) return { ...result, reason: 'shell option has no argument', malformed: true };
          words.shift();
        } else if (!/^[-+][aefhkmnptuvxBCEHPT]+$/.test(option) && !['--noprofile', '--norc', '--posix'].includes(option)) {
          return { ...result, reason: 'shell startup options change the environment; authentication cannot be inferred' };
        }
      }
      if (commandString) {
        if (!words.length) return { ...result, reason: 'shell -c has no command', malformed: true };
        try { words = commandWords(words[0]); }
        catch (e) { return { ...result, reason: e.message }; }
        continue;
      }
      if (!words.length) return { ...result, reason: 'shell executor has no script', malformed: true };
      const script = words.shift();
      return { ...result, executable: script, argv: words,
        provider: providers.find((p) => p.cli && `${p.id}.sh` === basename(script))?.id ?? 'custom' };
    }
    if (name === 'exec') continue;
    return { ...result, executable: first, argv: words,
      provider: providers.find((p) => p.cli && [p.cli, `${p.id}.sh`].includes(name))?.id ?? 'custom' };
  }
  return { ...result, reason: 'too many executor wrappers; authentication cannot be inferred' };
}

export function findExecutable(command, env = process.env) {
  const candidates = command.includes('/') ? [resolve(command)]
    : typeof env.PATH === 'string' ? env.PATH.split(delimiter).map((dir) => resolve(dir || '.', command)) : [];
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(e.code)) throw e;
    }
  }
  return null;
}
