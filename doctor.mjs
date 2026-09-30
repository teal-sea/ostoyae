#!/usr/bin/env node
// Can this machine actually run a graph? Answer before launching anything, not after.
//
//   node doctor.mjs <graph.json> [--exec "<cmd>"]
//
// This exists because of one run. Three agents launched, all three died on `Not logged in`
// because the cell's environment did not carry `USER`, and the ledger recorded `exit 1` three
// times with no cause. The information needed to prevent it was available for free, before any
// of them started. Every check here is one that has actually failed.
//
// Exit 0 = safe to launch. Exit 1 = do not launch, and the reason is on screen.

import { terminal, forPerson } from './lib/terminal.mjs';
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { derive } from './viewer/state.mjs';
import { findCycle, showCycle } from './lib/dag.mjs';
import { validateParams as validateCodexParams } from './executors/codex.mjs';
import { cellEnvironment, identifyExecutor, listProviders, findExecutable, executorCommand } from './lib/providers.mjs';
import { attemptConfigs, selectsAgents } from './lib/attempt-execution.mjs';
import { canonicalPath } from './lib/process-identity.mjs';
import { validateEffort, effectiveEffort } from './lib/effort.mjs';

const argv = process.argv.slice(2);
let file = null, EXEC = null, model = null, effort = null, argumentError = null, json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') json = true;
  else if (['--exec', '--model', '--effort'].includes(argv[i])) {
    const flag = argv[i], value = argv[++i];
    if (!value || value.startsWith('--')) { argumentError = `${flag} needs a value`; break; }
    if (flag === '--exec') EXEC = value; else if (flag === '--model') model = value; else effort = value;
  } else if (!file && !argv[i].startsWith('--')) file = canonicalPath(resolve(argv[i]));
  else { argumentError = `unknown doctor argument: ${argv[i]}`; break; }
}

const rows = [];
const ok   = (name, detail) => rows.push({ state: 'ok',   name, detail });
const bad  = (name, detail, fix) => rows.push({ state: 'FAIL', name, detail, fix });
const warn = (name, detail) => rows.push({ state: 'warn', name, detail });

if (argumentError) bad('arguments', argumentError, 'doctor <graph.json> [--exec command] [--model id] [--effort level] [--json]');

/* the graph itself */

let g = null;
if (!file || !existsSync(file)) {
  bad('graph', `no such file: ${file || '(none given)'}`, 'pass a graph path');
} else {
  try {
    g = JSON.parse(readFileSync(file, 'utf8'));
    if (model || effort) g.defaults = { ...g.defaults, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    for (const [name, params] of [['defaults', g.defaults], ...(g.work ?? []).map(w => [`work.${w.id}.params`, w.params]),
      ['mapping.params', g.mapping?.params], ['judge.params', g.judge?.params]]) {
      const selected = effectiveEffort(params);
      if (selected !== undefined) validateEffort(selected, `${name}.effort`);
    }
    ok('graph', `${g.graph}, ${g.work?.length ?? 0} work, ${g.attempts?.length ?? 0} attempts`);
  } catch (e) {
    bad('graph', `unreadable: ${String(e.message).split('\n')[0]}`, 'fix the JSON');
  }
}

/* one id, one thing */

// The runner refuses a graph with duplicated ids (see run.mjs for the aliasing this causes and
// the live case that found it). Doctor says so before `go` trips over it.
if (g) {
  for (const [plane, xs] of [['work', g.work ?? []], ['edges', g.edges ?? []]]) {
    const seen = new Map();
    for (const x of xs) seen.set(x.id, (seen.get(x.id) ?? 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1);
    if (dup.length) bad(`${plane} ids`, `duplicated: ${dup.map(([id, n]) => `${id} x${n}`).join(', ')}`,
        'give each entry its own id; variants of one problem are different work items');
  }
}

/* a DAG, not a loop */

// Two jobs that each need the other never start: nothing fails, both wait forever. The runner
// schedules on `needs` plus confirmed edges, and that relation has to be a DAG.
if (g && Array.isArray(g.work)) {
  const cycle = findCycle(g);
  if (cycle) bad('dependencies', `dependency cycle: ${showCycle(cycle)}`,
    'remove one of those needs (or reject the confirmed edge that makes it); every job in the loop is waiting for another');
  else ok('dependencies', 'no cycles');
}

/* the map, when the graph asks for one */

// Nothing here prints when `mapping` is absent, so a graph without maps reads exactly as before.
// When it is on, the runner refuses the file if `what` is missing, and that refusal would arrive
// after doctor said "ready to launch". What counts as active and mapped comes from state.mjs,
// the same derivation the runner schedules from, so this row cannot disagree with it.
if (g?.mapping != null) {
  const m = g.mapping;
  if (typeof m !== 'object' || typeof m.what !== 'string' || !m.what.trim()) {
    bad('mapping', 'on, but mapping.what is missing',
        'write the instruction handed to every map attempt in mapping.what; there is no default');
  } else if (m.max_attempts != null && !(Number.isInteger(m.max_attempts) && m.max_attempts > 0)) {
    bad('mapping', `on, but mapping.max_attempts is ${JSON.stringify(m.max_attempts)}`,
        'make mapping.max_attempts a positive integer, or leave it out for 1');
  } else {
    // The runner defaults these at load. Doctor reads the file as written, so default them here.
    const S = derive({ ...g, work: g.work ?? [], edges: g.edges ?? [], attempts: g.attempts ?? [] });
    const active = (g.work ?? []).filter(S.schedulable);
    const unmapped = active.filter((w) => !S.hasMap(w.id)).length;
    ok('mapping', `on, ${unmapped} of ${active.length} active items unmapped, ${S.mapMax()} map attempt(s) each`);
  }
}

/* the ontology */

if (g) {
  const o = g.ontology;
  if (o == null) warn('ontology', 'off: two agents that name the same missing piece differently will make two jobs');
  else {
    const kinds = o?.kinds;
    const obad = typeof o !== 'object' || Array.isArray(o) || typeof kinds !== 'object' || !kinds || !Object.keys(kinds).length ||
      Object.entries(kinds).some(([, k]) => typeof k !== 'object' || !Array.isArray(k.claim) || !k.claim.length ||
        typeof k.id !== 'string' || !k.id.includes('{') || typeof k.what !== 'string' || !k.what.includes('{'));
    if (obad) bad('ontology', 'on, but malformed', 'each kind is { claim: [keys], evidence: [keys], id, what, check }');
    else {
      ok('ontology', `${Object.keys(kinds).length} kind(s): ${Object.entries(kinds).map(([n, k]) => `${n}(${k.claim.join(', ')})`).join(', ')}`);
      // Two items in the file carrying one claim hash would be the aliasing the ids check refuses,
      // one level down. The runner cannot create it; a hand-edit can.
      const seen = new Map();
      for (const w of g.work ?? []) if (w.claim_hash) seen.set(w.claim_hash, [...(seen.get(w.claim_hash) ?? []), w.id]);
      const dup = [...seen.values()].filter((xs) => xs.length > 1);
      if (dup.length) bad('claims', `${dup.length} claim(s) under more than one id: ${dup.map((xs) => xs.join('=')).join(', ')}`,
                          'one claim, one item; merge them by hand and keep both finders');
    }
  }
}

/* the judge */

// Without a judge, you confirm proposals from your own reading.
if (g) {
  const j = g.judge;
  if (j == null) warn('judge', 'off: new jobs agents find wait for your yes, and a planned job has no check of its own');
  else {
    const jbad = typeof j !== 'object' || Array.isArray(j) ||
      (j.verify != null && (typeof j.verify !== 'string' || !j.verify.trim())) ||
      (j.default_check != null && (typeof j.default_check !== 'string' || !j.default_check.includes('{id}')));
    if (jbad) bad('judge', 'on, but malformed', 'judge is { verify, default_check with {id}, require_check, params }, every key optional');
    else {
      // Where a proposed task's gate comes from: the graph's default, or the kind that names it.
      const kinds = Object.entries(g.ontology?.kinds ?? {});
      const gated = kinds.length && kinds.every(([, k]) => k.check);
      ok('judge', `${j.verify ? 'verify attempts on' : 'no verify instruction'}` +
                  `${j.default_check ? ', default check for proposed tasks'
                    : gated ? ', proposed tasks gated by their kind'
                    : kinds.length ? `, ${kinds.filter(([, k]) => !k.check).length} kind(s) with no check`
                    : ', proposed tasks have no check'}` +
                  `${j.params?.model ? `, model ${j.params.model}` : ''}`);
      if (j.require_check) {
        const S = derive({ ...g, work: g.work ?? [], edges: g.edges ?? [], attempts: g.attempts ?? [] });
        const kindsAllGated = Object.keys(g.ontology?.kinds ?? {}).length &&
          Object.values(g.ontology.kinds).every((k) => k.check);
        const gap = (g.work ?? []).filter(S.schedulable).filter((w) => !w.check && !j.default_check && !(w.kind && kindsAllGated));
        if (gap.length) bad('require_check', `${gap.length} active item(s) with no check and no default: ${gap.slice(0, 5).map((w) => w.id).join(', ')}${gap.length > 5 ? ', …' : ''}`,
                            'declare check on each, or judge.default_check');
        else ok('require_check', 'every active item has a check');
      }
    }
  }
  // Warn when confirmed text has changed; the runner reopens that decision on load.
  try {
    const S = derive({ ...g, work: g.work ?? [], edges: g.edges ?? [], attempts: g.attempts ?? [] });
    const st = S.stale();
    if (st.length) warn('stale edges', `${st.length} confirmed edge(s) whose ends changed since: ${st.map((e) => e.id).join(', ')}; the runner reopens them`);
  } catch {}
}

/* the pursuit repo */

const repo = g?.sandbox?.repo ? resolve(g.sandbox.repo) : null;
if (!g) { /* already failed */ }
else if (!repo) bad('sandbox', 'no sandbox.repo', 'the runner refuses to run unisolated');
else if (!existsSync(repo)) bad('pursuit', `${repo} does not exist`, 'fix sandbox.repo');
else {
  try {
    const top = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const base = g.sandbox.base ?? 'HEAD';
    try {
      // Resolve the base to a commit; a name that merely parses is not enough to launch from.
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`], { stdio: 'ignore' });
      ok('pursuit', `${top}, base ${base}`);
    } catch {
      bad('pursuit base', `${base} does not resolve to a commit in ${top}`, 'fix sandbox.base');
    }
    // A branch left over from a previous run of the same graph name stops provisioning dead,
    // and the error arrives one attempt at a time rather than up front.
    const stale = execFileSync('git', ['-C', repo, 'branch', '--list', `ost/${g.graph}/*`], { encoding: 'utf8' })
      .split('\n').filter((s) => s.trim()).length;
    if (stale) warn('stale branches', `${stale} ost/${g.graph}/* branches in the pursuit from an earlier run`);
  } catch (e) {
    bad('pursuit', `cannot inspect ${repo}: ${e.code ?? e.status ?? 'git error'}`,
        String(e.stderr || e.message).trim().split('\n').slice(0, 2).join(' / '));
  }
}

/* somewhere to build cells */

if (g?.sandbox) {
  const root = resolve(g.sandbox.root ?? join(repo ?? '.', '..', 'ostoyae-worktrees'));
  try {
    mkdirSync(root, { recursive: true });
    const probe = join(root, `.doctor-${process.pid}`);
    mkdirSync(probe); rmSync(probe, { recursive: true, force: true });
    ok('worktree root', root);
  } catch (e) {
    bad('worktree root', `cannot write ${root}`, 'fix sandbox.root or its permissions');
  }
}

/* linked caches */

// Check declared tools before launch; an unavailable tool should not consume an attempt.
for (const t of g?.sandbox?.tools ?? []) {
  const cmd = String(t?.cmd ?? '').trim();
  if (!cmd) { bad('tool', 'a declared tool has no cmd', 'sandbox.tools entries are { "cmd": "...", "what": "..." }'); continue; }
  const words = cmd.split(/\s+/);
  // Match the executable basename so an absolute command path gets the intended permission.
  const base = words[0].split('/').pop();
  const viaShell = ['bash', 'sh', 'zsh', 'python3', 'python', 'node'].includes(base);
  if (viaShell && words.length < 2) {
    // Disclose broad shell grants because a generated script cannot be named in advance.
    if (t.bare === true) {
      warn('tool', `\`${cmd}\` is a bare interpreter, declared: Bash(${cmd}:*) grants the cell ` +
                   `every command it can run${t.what ? '' : ", and it says no why"}`);
    } else {
      bad('tool', `\`${cmd}\` is a bare interpreter`,
          `the rule Bash(${cmd}:*) would grant every command; name the script, or declare "bare": true if the cell writes the script it runs`);
      continue;
    }
  }
  // What the interpreter will actually run, which is not always words[1]. Taking words[1] blind
  // resolved the flag: `python3 -m pytest` was reported as "-m is not there" and `node --test` as
  // "--test is not there", so doctor refused boards that run. Skip the leading flags. `-m` is the
  // one flag whose argument is not a file: it names a module, so it is checked by asking the
  // interpreter to import it rather than by looking on PATH.
  let exe = words[0];
  let viaModule = false;
  if (viaShell) {
    let k = 1;
    const py = ['python3', 'python'].includes(words[0]);
    while (k < words.length && words[k].startsWith('-')) {
      if (py && words[k] === '-m' && k + 1 < words.length) { viaModule = true; k += 1; break; }
      k += 1;
    }
    if (k < words.length) exe = words[k];
  }
  let present;
  if (viaModule) { try { execFileSync(words[0], ['-c', `import ${exe}`], { stdio: 'ignore' }); present = true; } catch { present = false; } }
  else if (exe.includes('/')) present = existsSync(exe);
  else { try { execFileSync('sh', ['-c', `command -v ${JSON.stringify(exe)}`], { stdio: 'pipe' }); present = true; } catch { present = false; } }
  if (!present) { bad('tool', viaModule ? `\`${cmd}\`: ${words[0]} cannot import ${exe}` : `\`${cmd}\`: ${exe} is not there`,
                      'the contract will promise it and the cell will not find it'); continue; }
  if (!t.what) warn('tool', `\`${cmd}\` has no \`what\`; the contract lists it with no explanation`);
  else ok('tool', `${cmd}${t.what ? '  ' + String(t.what).slice(0, 60) + (t.what.length > 60 ? '…' : '') : ''}`);
  // Probe services for readiness, not only executable presence.
  const probe = String(t?.probe ?? '').trim();
  if (!probe) continue;
  const ms = Number(t?.probe_timeout_ms ?? 6000);
  const r = spawnSync('sh', ['-c', probe], { encoding: 'utf8', timeout: ms, stdio: 'pipe' });
  const line = String(r.stdout || r.stderr || '').trim().split('\n')[0];
  const first = line.length > 160 ? `${line.slice(0, 60)}…${line.slice(-96)}` : line;
  if (r.error && r.error.code === 'ETIMEDOUT') {
    warn('tool answers', `\`${cmd}\`: its probe did not answer within ${ms} ms`,
         'the cell will hit the same wait; a cheaper probe, or expect the tool to be slow');
  } else if (r.error) {
    warn('tool answers', `\`${cmd}\`: probe could not run (${r.error.code || r.error.message})`,
         `the probe is \`${probe}\``);
  } else if (r.status !== 0) {
    warn('tool answers', `\`${cmd}\`: probe exit ${r.status}${first ? `: ${first}` : ''}`,
         'the tool is installed but is not answering; cells will find this out one at a time');
  } else {
    ok('tool answers', `${cmd}${first ? `: ${first}` : ''}`);
  }
}
for (const rel of g?.sandbox?.link ?? []) {
  const target = join(repo ?? '', rel);
  if (!existsSync(target)) warn('link', `${rel} not present in the pursuit, cells will start without it`);
  else {
    const size = (() => { try { return statSync(target).isDirectory() ? 'dir' : 'file'; } catch { return '?'; } })();
    ok('link', `${rel} (${size})`);
  }
}

/* the executor, in the real cell environment */

// The runner imports the same allowlist. A shell wrapper can change it further, so its
// literal assignments and env flags must also apply to the authentication status command.
let env;
try { env = cellEnvironment(g?.sandbox?.env_passthrough ?? []); }
catch (e) { bad('cell environment', e.message, 'list variable names, never their values'); }

if (Number(process.versions.node.split('.')[0]) < 22)
  bad('Node.js', `running ${process.version}; Node.js 22 or newer is required`, 'install Node.js 22 or newer');
else ok('Node.js', process.version);
if (process.platform === 'win32')
  bad('platform', 'native Windows cannot run the POSIX cell executors', 'run inside WSL2, a Linux VM, or a Linux cloud workspace');
else ok('platform', `${process.platform}/${process.arch}; local and remote hosts use the same checks`);

if (env) {
  for (const name of ['git', 'bash']) {
    const path = findExecutable(name, env);
    if (path) ok('runtime', `${name}: ${path}`);
    else bad('runtime', `${name} is not on PATH in the cell environment`, `install ${name} and include its directory in PATH`);
  }
  for (const name of g?.sandbox?.env_passthrough ?? [])
    if (!env[name]) warn('cell environment', `${name} is declared but absent or empty; no value was printed`);
}

const root = resolve(import.meta.dirname);
const configs = [];
if (g && (EXEC || selectsAgents(g))) {
  try {
    const override = EXEC ? { provider: identifyExecutor(EXEC).provider, command: EXEC } : null;
    configs.push(...attemptConfigs(g, g.execution?.provider ?? 'claude', override));
  } catch (e) { bad('attempt config', e.message, 'pair each model with its selected agent'); }
}
const commands = [...new Map(configs.map(([name, config]) => [config.agent,
  [name, config.agent, EXEC ?? executorCommand(config.agent, root, g.execution?.command)]] )).values()];
if (!commands.length && EXEC) commands.push(['executor', identifyExecutor(EXEC).provider, EXEC]);
for (const [configName, agent, command] of commands) if (env) {
  let providerEnv = cellEnvironment(g?.sandbox?.env_passthrough ?? [], process.env, agent);
  const identified = identifyExecutor(command);
  const initialEnv = { ...providerEnv };
  if (identified.clearEnvironment) providerEnv = {};
  for (const name of identified.unset) delete providerEnv[name];
  Object.assign(providerEnv, identified.environment);
  const provider = listProviders().find((p) => p.id === identified.provider);
  if (identified.malformed) bad('executor', identified.reason, 'fix --exec quoting and arguments');
  else if (identified.reason) warn('executor auth', `${identified.reason}; authentication UNVERIFIED, no model call made`);
  else {
    let present = true;
    for (const context of identified.wrapperContexts) {
      const wrapperEnv = context.clearEnvironment ? {} : { ...initialEnv };
      for (const name of context.unset) delete wrapperEnv[name];
      Object.assign(wrapperEnv, context.environment);
      if (!findExecutable(context.executable, wrapperEnv)) {
        present = false;
        bad('executor', `${context.executable} is not on PATH when its wrapper is invoked`, 'install the declared wrapper or fix --exec');
      }
    }
    const bin = identified.executable;
    const path = bin?.includes('/') ? (existsSync(bin) && statSync(bin).isFile() ? bin : null) : bin && findExecutable(bin, providerEnv);
    if (!path) {
      present = false;
      bad('executor', `${bin ?? 'command'} does not exist or is not on PATH in the cell environment`, 'fix --exec');
    }
    if (provider.id !== 'custom') {
      const runtime = provider.id === 'codex' ? 'node' : 'python3';
      if (!findExecutable(runtime, providerEnv)) {
        present = false;
        bad('runtime', `${runtime} is not on PATH in the executor environment`, `install ${runtime} and include its directory in PATH`);
      }
      const cli = bin.endsWith('.sh') ? findExecutable(provider.cli, providerEnv) : path;
      if (!cli) {
        present = false;
        bad('executor', `${provider.cli} is not on PATH in the cell environment and the executor calls it`,
          `install ${provider.label}; name required credential variables in sandbox.env_passthrough`);
      }
      for (const name of provider.env)
        if (process.env[name] && !providerEnv[name]) warn('cell environment', `${name} is set on this host but absent from the cell; add its NAME to sandbox.env_passthrough if required`);
      if (present && provider.auth) {
        const args = provider.id === 'claude' ? ['auth', 'status'] : ['login', 'status'];
        const r = spawnSync(cli, args, { env: providerEnv, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
        // Status output can contain credential fragments. Neither stdout nor stderr is printed.
        if (r.error || r.status !== 0) bad('executor auth', `${provider.label} ${args.join(' ')} failed (${r.error?.code ?? r.status})`,
          `authenticate ${provider.cli} in this environment; check HOME, USER and the provider environment names. No model call made`);
        else ok('executor auth', `${provider.label} reports authentication in the cell environment; no model call made`);
      } else if (present) {
        ok('executor', `${provider.cli} is on PATH in the cell environment (${cli})`);
        warn('executor auth', `${provider.label} authentication UNVERIFIED: no safe status probe is configured; no model call made`);
      }
      if (provider.experimental) warn('executor support', `${provider.label} adapter is stub-tested; a real provider run is still required to validate this host`);
    } else if (present) {
      ok('executor', `${bin} is available`);
      warn('executor auth', 'custom command authentication UNVERIFIED; no model call made');
    }
  }
  if (identified.provider === 'codex') {
    const codexConfigs = configs.filter(([, config]) => config.agent === 'codex');
    const seen = new Set();
    for (const [name, selected] of codexConfigs) {
      const [id, role] = name.split('/');
      const work = g.work.find(w => w.id === id);
      const params = { ...g.defaults, ...work?.params,
        ...(role === 'map' ? g.mapping?.params : role === 'verify' ? g.judge?.params : {}), model: selected.model, effort: selected.effort };
      const key = JSON.stringify(params);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        validateCodexParams(params);
        if (!params.codex_pricing) warn('Codex cost', `${name}: no params.codex_pricing; tokens will be recorded, dollar cost unknown`);
      } catch (e) { bad('Codex params', `${name}: ${e.message}`, 'adapt the graph parameters before launching Codex'); }
    }
    warn('Codex config', 'the adapter excludes user config to preserve cell permissions; custom backends require a custom executor or another provider adapter');
  }
}
if (!commands.length) {
  warn('executor', 'no --exec given; executor authentication was not checked');
}

/* report */

const pad = (s, n) => String(s).padEnd(n);
const failed = rows.filter((r) => r.state === 'FAIL').length;
if (json) console.log(JSON.stringify({ ready: failed === 0, blocking: failed, rows }));
else if (forPerson(process.stdout)) {
  // A person reads what needs them. Passing rows fold into one quiet line.
  const t = terminal();
  console.log('');
  const hang = ' '.repeat(25), wide = t.width - 27;
  for (const r of rows.filter((r) => r.state !== 'ok')) {
    const [first, ...more] = t.wrap(r.detail, wide);
    console.log(`  ${r.state === 'FAIL' ? t.paint('1;31', 'FAIL') : t.accent('warn')}  ${t.paint('1', pad(r.name, 16))} ${first}`);
    for (const l of more) console.log(hang + l);
    if (r.fix) for (const l of t.wrap(r.fix, wide)) console.log(hang + t.dim(l));
  }
  const passed = rows.filter((r) => r.state === 'ok');
  console.log(t.wrap(`${passed.length} passed: ${passed.map((r) => r.name).join(', ')}`, t.width - 8).map((l, i) => `  ${i ? '      ' : t.paint('32', ' ok ') + '  '}${t.dim(l)}`).join('\n'));
  console.log('');
  console.log(failed ? `  ${t.paint('1;31', `${failed} blocking.`)} Not safe to launch.\n` : `  ${t.paint('1;32', 'ready to launch.')}\n`);
}
else {
  console.log('');
  for (const r of rows) {
    const mark = r.state === 'ok' ? ' ok ' : r.state === 'warn' ? 'warn' : 'FAIL';
    console.log(`  ${mark}  ${pad(r.name, 16)} ${r.detail}`);
    if (r.fix) console.log(`        ${pad('', 16)} ${r.fix}`);
  }
  console.log('');
  console.log(failed ? `  ${failed} blocking. Not safe to launch.\n` : '  ready to launch.\n');
}
process.exit(failed ? 1 : 0);
