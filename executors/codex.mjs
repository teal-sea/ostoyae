// Codex CLI 0.153.4 contract adapter. No SDK dependencies.
// Primary references and the differences from claude.sh are in README.md.
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const self = fileURLToPath(import.meta.url);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const number = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const toml = (x) => Array.isArray(x) ? `[${x.map(toml).join(',')}]`
  : object(x) ? `{${Object.entries(x).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}`
  : JSON.stringify(x);

export function validateParams(p = {}) {
  if (typeof p.model !== 'string' || !p.model.trim()) throw Error('Codex needs params.model explicitly');
  if (p.max_turns != null) throw Error('Codex exec has no max_turns equivalent; remove params.max_turns explicitly and use the runner launch/output-token budgets');
  if (p.codex_pricing != null) {
    if (!object(p.codex_pricing) || !['input', 'cached_input', 'output'].every((k) => number(p.codex_pricing[k])))
      throw Error('params.codex_pricing must name nonnegative input, cached_input and output USD rates per million tokens');
  }
}

// Codex's turn.completed input includes cached input. Ostoyae's input_tokens does not.
// JSONL does not supply billed dollars, API duration, or Claude-style model-turn counts.
export function usageRecord(u, p, elapsed, turns) {
  const valid = object(u) && ['input_tokens', 'cached_input_tokens', 'output_tokens'].every((k) => number(u[k]))
    && u.cached_input_tokens <= u.input_tokens;
  const rates = p.codex_pricing;
  const input = valid ? u.input_tokens - u.cached_input_tokens : null;
  const cost = valid && rates ? (input * rates.input + u.cached_input_tokens * rates.cached_input + u.output_tokens * rates.output) / 1e6 : null;
  return {
    executor: 'codex', model: p.model, ...(p.effort ?? p.reasoning_effort ? { effort: p.effort ?? p.reasoning_effort } : {}), input_tokens: input,
    cache_read_input_tokens: valid ? u.cached_input_tokens : null,
    cache_creation_input_tokens: null, output_tokens: valid ? u.output_tokens : null,
    cost_usd: cost, cost_basis: cost === null ? 'unreported' : 'estimated from params.codex_pricing',
    ...(rates ? { pricing_usd_per_million: rates } : {}),
    duration_ms: elapsed, api_ms: null, turns: null, user_turns: turns,
    ...(valid ? {} : { _bad: 'Codex did not emit complete token usage' }),
  };
}

// An enforced tool hook, not a prompt. Covers ordinary and compound shell invocations of git.
// Like Claude's Bash(git:*) rule this is not a hostile-code boundary: an arbitrary interpreter
// can conceal a subprocess. The filesystem sandbox independently protects git metadata/caches.
export function guard(input) {
  const args = input.tool_input ?? {};
  const cmd = String(args.command ?? args.cmd ?? '');
  if (/(?:^|[\s/;|&()'"`])git(?:$|[\s;'"`])/m.test(cmd))
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'The Ostoyae harness owns git. Leave changes in the worktree.' } };
  return {};
}

export function configArgs(p, env = process.env, cwd = process.cwd(), helper = self) {
  validateParams(p);
  const linked = (env.OSTOYAE_LINKED ?? '').split(':').filter(Boolean).map((x) => realpathSync(x));
  const fs = { ':root': 'read', ':slash_tmp': 'read', ':tmpdir': 'read',
    [join(cwd, '.ostoyae', 'tmp')]: 'write', [dirname(helper)]: 'read' };
  for (const x of linked) fs[x] = 'read';
  if (env.OSTOYAE_MAILBOX) fs[dirname(env.OSTOYAE_MAILBOX)] = 'write';
  // This profile extends Codex's protected .git/.codex defaults. No --add-dir: that grants write.
  const settings = {
    approval_policy: 'never', default_permissions: 'ostoyae-cell',
    'permissions.ostoyae-cell': { extends: ':workspace', filesystem: fs,
      network: { enabled: Boolean(env.OSTOYAE_TOOLS || env.OSTOYAE_LEAN_MCP) } },
    [`projects.${JSON.stringify(cwd)}.trust_level`]: 'untrusted',
    web_search: env.OSTOYAE_WEB ? 'live' : 'disabled',
    'features.multi_agent': false, 'features.apps': false, 'features.plugins': false,
    'features.hooks': true, 'features.shell_snapshot': false,
    'shell_environment_policy.inherit': 'all', 'shell_environment_policy.ignore_default_excludes': true,
    'hooks.PreToolUse': [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${quote(helper)} --guard`, timeout: 10 }] }],
  };
  if (env.OSTOYAE_MAILBOX) settings['hooks.PostToolUse'] = [{ hooks: [{ type: 'command',
    command: 'OSTOYAE_HOOK_EVENT=PostToolUse ostoyae-msg read --hook', timeout: 10 }] }];
  if (p.effort ?? p.reasoning_effort) settings.model_reasoning_effort = p.effort ?? p.reasoning_effort;
  if (p.service_tier) settings.service_tier = p.service_tier;
  if (env.OSTOYAE_LEAN_MCP) {
    if (!existsSync(env.OSTOYAE_LEAN_MCP)) throw Error('OSTOYAE_LEAN_MCP does not exist');
    settings['mcp_servers.lean'] = { command: env.OSTOYAE_LEAN_MCP, required: true,
      env: { LEAN_PROJECT_PATH: cwd, PATH: env.PATH ?? '' } };
  }
  // Project layers are untrusted and user config/rules are excluded. Only the harness's CLI
  // hook is enabled by this trust flag; it does not bypass the sandbox or approval policy.
  return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--dangerously-bypass-hook-trust', '--cd', cwd, '--model', p.model,
    ...Object.entries(settings).flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`])];
}

async function execute(a) {
  const p = a.params ?? {};
  validateParams(p);
  const cwd = realpathSync(process.cwd());
  mkdirSync('.ostoyae/tmp', { recursive: true });
  const args = configArgs(p, process.env, cwd);
  args.push('--', a.what || a.of);
  const start = Date.now();
  let usage = null, turns = 0, agentError = false, completed = false;
  const secrets = Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v.length >= 8).map(([, v]) => v);
  const say = (s) => { for (const secret of secrets) s = s.replaceAll(secret, '[redacted]'); console.log(s); };
  say(`[cell ${a.id}] ${a.what || a.of}`);
  const child = spawn('codex', args, { cwd, env: { ...process.env, TMPDIR: join(cwd, '.ostoyae/tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((res) => {
    child.on('error', (e) => { say(`[cell] Codex could not start: ${e.code}`); agentError = true; res(1); });
    child.on('close', (code) => res(code ?? 1));
  });
  const stderr = createInterface({ input: child.stderr });
  stderr.on('line', (line) => say(line));
  for await (const line of createInterface({ input: child.stdout })) {
    let ev;
    try { ev = JSON.parse(line); } catch { say(line); continue; }
    if (ev.type === 'turn.completed') { usage = ev.usage; turns++; completed = true; }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      agentError = true;
      say(`[cell] ${ev.error?.message || ev.message || JSON.stringify(ev.error || ev)}`);
    }
    const item = ev.item;
    if (ev.type === 'item.completed' && item?.type === 'agent_message') say(item.text ?? '');
    if (ev.type === 'item.started' && item?.type === 'command_execution') say(`uses shell: ${item.command}`);
    if (ev.type === 'item.completed' && item?.type === 'command_execution') say(`shell exit ${item.exit_code}: ${(item.aggregated_output ?? '').slice(-600)}`);
    if (ev.type === 'item.started' && item?.type === 'mcp_tool_call') say(`uses MCP: ${item.server}/${item.tool}`);
  }
  const code = await exited;
  const record = usageRecord(usage, p, Date.now() - start, turns);
  writeFileSync('.ostoyae/usage.json', JSON.stringify(record, null, 2) + '\n');
  say(`usage: out=${record.output_tokens} in=${record.input_tokens} cache_read=${record.cache_read_input_tokens} cost=${record.cost_usd ?? '?'} (${record.cost_basis})`);
  let report = null;
  try { report = JSON.parse(readFileSync('.ostoyae/report.json', 'utf8')); } catch {}
  const kind = a.kind || 'prove';
  let changed = false;
  if (kind !== 'map' && kind !== 'verify') {
    const git = (args, input) => {
      const r = spawnSync('git', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (r.error || r.status !== 0) throw Error(`harness git ${args[0]} failed (${r.error?.code ?? r.status}): ${r.stderr}`);
      return args.includes('-z') ? r.stdout : r.stdout.trim();
    };
    let trackedCompiled = null;
    // Git 2.47 reports ignored explicit exclude-pathspecs as an add error even though it
    // stages the other files. Select actual changed paths first; ignored injected contracts
    // never become pathspecs. NUL input also preserves spaces/newlines and avoids argv limits.
    const paths = [...new Set((git(['diff', '--name-only', '-z', 'HEAD', '--', '.']) +
      git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0'))]
      .filter((x) => x && !['AGENTS.md', 'CLAUDE.md', '.ostoyae'].includes(x) && !x.startsWith('.ostoyae/'))
      // Compiled Python stays out unless the repository already tracks compiled files.
      .filter((x) => !(x.endsWith('.pyc') || x.split('/').includes('__pycache__')) ||
        (trackedCompiled ??= !!git(['ls-files', '-z', '--', ':(glob)**/*.pyc', ':(glob)**/__pycache__/**']).replaceAll('\0', '')));
    if (paths.length) {
      git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], paths.join('\0') + '\0');
      for (const path of ['AGENTS.md', 'CLAUDE.md', '.ostoyae'])
        spawnSync('git', ['restore', '--staged', '--quiet', '--', path], { stdio: 'ignore' });
      const prefix = report?.wall ? 'walled, partial work: ' : code || agentError ? 'failed, partial work: ' : '';
      git(['commit', '-qm', `${prefix}${a.what || a.of}\n\nAttempt: ${a.id}\nWork: ${a.of}`]);
      say(`[cell ${a.id}] harness committed ${git(['rev-parse', '--short', 'HEAD'])}`);
      changed = true;
    }
  }
  if (code || agentError || !completed) return 1;
  if (!object(report)) { say('[cell] no valid report.json handback'); return 1; }
  if (report.wall) return 1;
  if (kind === 'verify') {
    if (!Array.isArray(report.verdicts)) { say('[cell] verify attempt handed back no verdicts'); return 1; }
    return 0;
  }
  if (kind === 'map') {
    if (!object(report.map)) { say('[cell] map attempt handed back no map'); return 1; }
    return 0;
  }
  return changed ? 0 : 1; // A no-change proof still reaches the runner's independent check.
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(self)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (process.argv[2] === '--guard') console.log(JSON.stringify(guard(input)));
    else process.exitCode = await execute(input);
  } catch (e) {
    console.error(`[cell] ${e.message}`);
    process.exitCode = process.argv[2] === '--guard' ? 2 : 1;
  }
}
