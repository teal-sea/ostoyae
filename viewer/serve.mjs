#!/usr/bin/env node
// Serve the live board and its decisions on localhost. Use the runner's caps for launches from the page.

import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { discoverBoards, canonical } from '../lib/boards.mjs';
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, kindOf, decideOn } from './state.mjs';
import { confirmOn } from '../lib/dag.mjs';
import { readBoard, resolveExecution, executionSignature, selfCommand } from '../lib/cli-config.mjs';
import { shellQuote } from '../lib/providers.mjs';
import { trunkReport } from '../lib/land.mjs';
import { processOwner, captureIdentity, canonicalPath } from '../lib/process-identity.mjs';
import { claimRunLock, liveLockHolder, lockClaimant, lockPathOf, removeLock, removeOwnRunfile, holderDoing } from '../lib/liveness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const values = new Set(['--port', '--exec', '--model', '--effort']);
const positions = args.filter((a, i) => !a.startsWith('--') && !values.has(args[i - 1]));
const file = canonicalPath(resolve(positions[0] ?? ''));
const portArg = args.indexOf('--port');
const PORT = portArg > -1 ? Number(args[portArg + 1]) : 4300;
// Three postures. Plain: the page shows every board it can find and writes nothing; the
// operator answers and launches from a terminal. `--control`: yes, no and launch are buttons.
// `--read-only`: shows the one board it was opened with and nothing else, which is what the
// demo uses. Read-only is the default because a page that can spend your budget should have to
// be asked for.
const READ_ONLY = args.includes('--read-only');
const CONTROL = args.includes('--control') && !READ_ONLY;
const overrides = {};
for (const name of ['exec', 'model', 'effort']) {
  const at = args.indexOf(`--${name}`);
  if (at !== -1) overrides[name] = args[at + 1];
}

const requests = new AsyncLocalStorage();
const current = () => requests.getStore() ?? file;
const executionOverrides = () => canonical(current()) === canonical(file) ? overrides : {};
if (!file || !existsSync(file)) {
  console.error('usage: node viewer/serve.mjs <graph.json> [--port 4300]');
  process.exit(1);
}

// The path the command boxes print: the last two segments, which is what the page has always
// shown and is enough to tell one graph from another without filling the rail.
const shortOf = (p) => p.split('/').slice(-2).join('/');

// Offer board files beside the current board so the viewer can switch without guessing a project.
const extra = positions.slice(1).map((a) => resolve(a));
function looksLikeGraph(p) {
  try {
    const g = JSON.parse(readFileSync(p, 'utf8'));
    return typeof g.graph === 'string' && Array.isArray(g.work);
  } catch { return false; }
}
// What a board has cost, from the record. Unpriced attempts are counted separately rather than
// as zero: unknown is not free.
function spendOf(g) {
  const at = g.attempts ?? [];
  const priced = at.filter((a) => a.result?.usage && !a.result.usage._bad &&
    Number.isFinite(a.result.usage.cost_usd) && a.result.usage.cost_usd >= 0);
  return { usd: Math.round(priced.reduce((t, a) => t + (Number(a.result.usage.cost_usd) || 0), 0) * 100) / 100,
           priced: priced.length, unpriced: at.length - priced.length };
}

// Boards named in graph.local.json, the file that already chooses which board this machine runs.
// A campaign's boards live in different directories (a frontier here, an evaluation there), so
// siblings alone is too narrow a net.
//
// A board whose file is gone (the demo's temp directory, a rehearsal's scratch board) is not an
// error the operator can act on, so it is marked `gone` rather than described: after one demo a
// new user's rail was eight ENOENT paths and four boards (2026-09-28). The page folds them into
// one quiet line.
function boards() {
  const inventory = READ_ONLY ? { files: [file], errors: [] }
    : discoverBoards(dirname(current()), root, [file, ...extra]);
  return [...inventory.files.map(p => {
    if (!existsSync(p)) return { path: p, name: shortOf(p), gone: true, error: 'file is gone', current: false };
    try {
      const g = readBoard(p), work = g.work;
      const pending = work.filter(w => w.status === 'proposed').length + g.edges.filter(e => e.status === 'proposed').length;
      return { path: p, name: g.graph, short: shortOf(p), work: work.length,
        attempts: g.attempts.length, pending, spent: spendOf(g).usd, current: canonical(p) === canonical(current()) };
    } catch (e) { return { path: p, name: shortOf(p), error: e.message, current: false }; }
  }), ...inventory.errors.map(e => ({ path: e.file, name: shortOf(e.file), error: e.error, current: false }))];
}

// Where the finished work is, for the list's "Finished" heading: the trunk, how far ahead of
// the base it is, and the command that takes it. Three git calls, so held for a few seconds
// rather than run on every 1.2 s poll. A board whose repository is not on this machine gets
// no git call at all (trunkReport returns early).
const landCache = new Map();
function landOf(g) {
  const key = current();
  const hit = landCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  let value;
  try {
    const r = trunkReport(g);
    value = { ...r, command: `${selfCommand(root)} land ${shellQuote(key)}` };
  } catch (e) { value = { error: e.message }; }
  landCache.set(key, { at: Date.now(), value });
  return value;
}

// Is anything actually running? The graph alone cannot say. An attempt reading `running` means a
// runner said so at some point, not that it is still there, and a picture that has not moved in
// four minutes looks the same whether an agent is thinking or the runner died. The runner writes
// a heartbeat beside the graph; this reads it and separates the three cases by name.
const runfile = () => current().replace(/\.json$/, '') + '.run.json';
// What each running agent is saying and has written so far. Written by the runner every two
// seconds while agents run, gone when the run ends. Absent means nothing is live.
const livefile = () => current().replace(/\.json$/, '') + '.live.json';
function liveNow() {
  if (!existsSync(livefile())) return {};
  try { return JSON.parse(readFileSync(livefile(), 'utf8')).attempts ?? {}; } catch { return {}; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function runner() {
  if (!existsSync(runfile())) return { state: 'none' };
  let r;
  try { r = JSON.parse(readFileSync(runfile(), 'utf8')); }
  catch (e) { return { state: 'unknown', error: `runner heartbeat unreadable: ${e.message}` }; }
  if (!r || typeof r !== 'object') return { state: 'unknown', error: 'runner heartbeat must be an object' };
  if (!Number.isSafeInteger(r.pid) || r.pid <= 0) return { state: 'unknown', error: 'runner heartbeat has no valid PID' };
  const base = { pid: r.pid, since: r.started ?? null, beat: r.beat ?? null, role: r.role ?? null,
                 launched: r.launched ?? null, budget: r.budget ?? null, budgets: r.budgets ?? null };
  const owner = processOwner(r.pid, { identity: r.identity, runnerFile: current() });
  if (owner === null) return { ...base, state: 'unknown' };
  if (!owner) return { ...base, state: 'gone' };
  // A process that is up but has stopped beating is wedged, which is not the same as working and
  // is the case an operator most needs told. The beat is every 2s; 15s is not a slow one.
  const age = Date.now() - Date.parse(r.beat ?? 0);
  if (!Number.isFinite(age)) return { ...base, state: 'unknown', error: 'runner heartbeat has no valid timestamp' };
  return { ...base, state: age > 15000 ? 'wedged' : 'live' };
}

// The graph is re-read per request rather than cached. A run rewrites the file underneath us and
// the whole point is to see that happen; a cache here would show a picture of the past.
function snapshot(opts = {}) {
  let g;
  try { g = readBoard(current()); }
  catch (e) {
    // A half-written file during a run is normal, not an error. Say so and let the page retry.
    return { error: `graph unreadable right now: ${String(e.message).split('\n')[0]}` };
  }
  const S = derive(g, { index: true });
  const rs = S.readyIds();
  const liveAtt = liveNow();
  let execution;
  try {
    const { provider, model, profile, source } = resolveExecution(g, executionOverrides(), process.env, join(here, '..'));
    execution = { provider, model, profile, source };
  } catch (e) { execution = { provider: 'unknown', error: e.message }; }

  const nodes = g.work.map((w) => ({
    id: w.id,
    // `what` is the instruction handed to the agent, long, and mostly identical across a hunt
    // because every item repeats the same conditions. `label` is what a person reads. Optional:
    // without one the picture falls back to the instruction, which is better than nothing and
    // worse than a sentence written to be read.
    label: w.label ?? null,
    what: w.what ?? '',
    state: S.stateOf(w.id, rs),
    depth: S.depth(w.id),
    // How much this item transitively unblocks (confirmed edges, unsatisfied targets only).
    // The same number `ready()` now sorts by, so the picture can say why the runner picks
    // what it picks.
    leverage: S.leverage(w.id),
    needs: S.needsOf(w.id),
    spent: S.spent(w.id),
    max: g.max_attempts,
    // The map, whether a map attempt wrote it or a person typed it in, and what the next attempt
    // at this item would be. Both budgets are shown because either one ends the item.
    map: S.hasMap(w.id) ? w.map : null,
    nextKind: S.nextKind(w.id),
    mapSpent: S.mapSpent(w.id),
    mapMax: S.mapMax(),
    foundBy: w.found_by ?? null,
    attempts: S.attemptsOf(w.id).map((a) => ({
      id: a.id, state: a.state, kind: kindOf(a), from: a.from ?? null,
      agent: a.params?.agent ?? null, model: a.params?.model ?? null, effort: a.params?.effort ?? a.params?.reasoning_effort ?? null,
      // While it runs: the last things it said, and its handback so far. Tentative, not the
      // record; the page draws it faint until the attempt settles.
      live: a.state === 'running' && liveAtt[a.id]
        ? { lines: (liveAtt[a.id].lines ?? []).slice(-12), tentative: liveAtt[a.id].tentative ?? null }
        : null,
      startedAt: a.started_at ?? null,
      endedAt: a.ended_at ?? null,
      why: a.result?.why ?? null,
      wall: a.result?.wall ?? null,
      map: a.result?.map ?? null,
      found: a.result?.found ?? [],
      notes: a.result?.notes ?? [],
      branch: a.sandbox?.branch ?? null,
    })),
  }));

  const edges = g.edges.map((e) => ({
    id: e.id, from: e.from, to: e.to, why: e.why ?? '', status: e.status,
    foundBy: e.found_by ?? [], foundAt: e.found_at ?? null,
  }));

  // Draw authored `work[].needs` edges too; they are absent from `edges[]`.
  const authored = g.work.flatMap((w) => (w.needs ?? []).map((n) => ({
    id: `needs:${n}->${w.id}`, from: n, to: w.id, why: 'authored', status: 'authored',
    foundBy: [], foundAt: null,
  })));

  const pending = [
    ...g.work.filter((w) => S.statusOf(w) === 'proposed').map((w) => ({ id: w.id, kind: 'work', what: w.what, foundBy: w.found_by ?? [], foundAt: w.found_at ?? null })),
    ...g.edges.filter((e) => e.status === 'proposed').map((e) => ({ id: e.id, kind: 'edge', what: `${e.from} blocks ${e.to}${e.why ? `, ${e.why}` : ''}`, foundBy: e.found_by ?? [], foundAt: e.found_at ?? null })),
  ];

  return {
    graph: g.graph,
    execution,
    lastRun: g.last_run ?? null,
    // The page hides yes, no and launch unless this server was started with `--control`.
    readOnly: !CONTROL,
    control: CONTROL,
    // How to answer from a terminal, in the words the CLI uses, with the board path quoted.
    cli: selfCommand(root),
    fileQuoted: shellQuote(current()),
    land: landOf(g),
    concurrency: g.concurrency,
    maxAttempts: g.max_attempts,
    mapping: S.mappingOn() ? { on: true, maxAttempts: S.mapMax() } : null,
    sandbox: { repo: g.sandbox?.repo ?? null, base: g.sandbox?.base ?? null, link: g.sandbox?.link ?? [] },
    nodes,
    edges: [...authored, ...edges],
    pending,
    decisions: opts.decisions ? decisions(g, S, rs) : undefined,
    accumulation: S.accumulation(),
    inFlight: S.inFlight(),
    ready: [...rs],
    attempts: g.attempts.length,
    runner: runner(),
    mtime: statSync(current()).mtimeMs,
    file: current(),
    boards: boards(),
    spent: spendOf(g),
  };
}

// Group pending proposals by the attempt that found them and show the effect of yes or no.
function decisions(g, S, rs) {
  const proposedWork = g.work.filter((w) => S.statusOf(w) === 'proposed');
  const proposedEdges = g.edges.filter((e) => e.status === 'proposed');
  const labelOf = (id) => S.workOf(id)?.label ?? null;
  const statusAt = (id) => (S.workOf(id) ? S.statusOf(S.workOf(id)) : 'missing');
  const after = (ids, status) => {
    // A fresh copy, so a fresh handle: the indexed handle's caches are only sound while nothing
    // moves under it, and this is the one place that moves a status on purpose.
    const c = JSON.parse(JSON.stringify(g));
    const T = derive(c);
    for (const id of ids) decideOn(T.lookup(id), status);
    return derive(c, { index: true });
  };

  const out = [];
  for (const a of [...g.attempts].sort((x, y) => String(x.id).localeCompare(String(y.id)))) {
    const mine = (x) => (x.found_by ?? []).includes(a.id) || (a.result?.found ?? []).includes(x.id);
    const work = proposedWork.filter(mine);
    const edges = proposedEdges.filter(mine);
    if (!work.length && !edges.length) continue;
    const ids = [...work, ...edges].map((x) => x.id);
    const adds = work.map((w) => w.id);
    const others = (x) => (x.found_by ?? []).filter((id) => id !== a.id);

    const Y = after(ids, 'confirmed');
    const yrs = Y.readyIds();
    const N = after(ids, 'rejected');

    out.push({
      attempt: a.id, kind: kindOf(a), state: a.state, of: a.of, ofLabel: labelOf(a.of),
      endedAt: a.ended_at ?? null,
      wall: a.result?.wall ?? null,
      map: a.result?.map ?? null,
      work: work.map((w) => ({ id: w.id, what: w.what ?? '', alsoFoundBy: others(w) })),
      edges: edges.map((e) => ({
        id: e.id, from: e.from, to: e.to, why: e.why ?? '',
        fromLabel: labelOf(e.from), toLabel: labelOf(e.to),
        fromStatus: statusAt(e.from), toStatus: statusAt(e.to),
        alsoFoundBy: others(e),
      })),
      yes: {
        adds,
        readyAtOnce: [...yrs].filter((id) => !rs.has(id)),
        // What each item still waits on once the edges bite: the group's own item first, then
        // every item the group adds. Only listed when there is something to wait on.
        waits: [a.of, ...adds]
          .map((id) => ({ item: id, on: Y.needsOf(id).filter((n) => !Y.satisfied(n)) }))
          .filter((x) => x.on.length),
        itemAfter: Y.stateOf(a.of, yrs),
      },
      no: { itemAfter: N.stateOf(a.of) },
      confirm: `node run.mjs ${shortOf(current())} --confirm ${ids.join(',')}`,
      reject: `node run.mjs ${shortOf(current())} --reject ${ids.join(',')}`,
    });
  }
  return out;
}

// Recomputed only when the file has actually moved. The page asks for this once per change, not
// on every 700 ms poll, so one board change costs one computation rather than a hundred.
const decisionCaches = new Map();
function decisionsCached() {
  const decCache = decisionCaches.get(current()) ?? { key: null, value: [] };
  let key, g;
  try { key = `${current()}:${statSync(current()).mtimeMs}`; } catch (e) { return { decisions: decCache.value, stale: true, error: e.message }; }
  if (decCache.key === key) return { decisions: decCache.value, cached: true };
  try { g = JSON.parse(readFileSync(current(), 'utf8')); }
  catch (e) { return { decisions: decCache.value, stale: true, error: String(e.message).split('\n')[0] }; }
  const S = derive(g, { index: true });
  const t = Date.now();
  const value = decisions(g, S, S.readyIds());
  decisionCaches.set(current(), { key, value });
  return { decisions: value, tookMs: Date.now() - t };
}

const page = () => readFileSync(join(here, 'index.html'));

// Accept decisions only on localhost and record their source as the viewer.
async function decide(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
  const r = runner();
  if (['live', 'wedged', 'unknown'].includes(r.state)) {
    if (r.role === 'gate') return { status: 409, error: `pid ${r.pid} is gating the board; decisions are paused until it finishes.` };
    return { status: 409, error: `the runner is ${r.state} (process ${r.pid ?? 'unknown'}); decisions are paused until its ownership is resolved.` };
  }
  const board = current();
  const RUN = runfile();
  const LOCK = lockPathOf(RUN);
  const identity = captureIdentity(process.pid, { runnerFile: board });
  const started = new Date().toISOString();
  const claim = await claimRunLock(LOCK, { file: board, identity, started, role: 'confirm' });
  if (!claim.claimed) {
    const h = claim.holder;
    if (!h?.pid) return { status: 409, error: `another writer holds this graph's lock and its holder could not be read; decisions are paused.` };
    const v = liveLockHolder(LOCK, board);
    const what = v ? `it is ${holderDoing(v)}` : 'its ownership could not be verified';
    return { status: 409, error: `pid ${h.pid} holds this graph's lock, ${what}; decisions are paused until it finishes.` };
  }
  // Held like every CLI writer: a pre-lock engine never looks at the lock, so without this
  // runfile it would start beside the decision. The pid is the server's, which is why stop
  // never signals a confirm holder. Single beat: the hold is one write.
  {
    const temp = `${RUN}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ file: board, pid: process.pid, identity, started,
      beat: new Date().toISOString(), role: 'confirm' }) + '\n');
    renameSync(temp, RUN);
  }
  try {
    let g;
    try { g = JSON.parse(readFileSync(board, 'utf8')); }
    catch (e) { return { status: 503, error: `graph unreadable right now: ${String(e.message).split('\n')[0]}` }; }
    const S = derive(g);
    const changed = [], skipped = [];
    for (const [ids, status] of [[body.confirm ?? [], 'confirmed'], [body.reject ?? [], 'rejected']]) {
      for (const id of ids) {
        const x = S.lookup(id);
        if (!x) { skipped.push(`${id}: no such job or arrow`); continue; }
        if (S.statusOf(x) !== 'proposed') { skipped.push(`${id}: already ${S.statusOf(x)}`); continue; }
        // A yes that would close a dependency cycle is recorded as a no, with the loop it makes.
        if (status === 'confirmed') confirmOn(x, g); else decideOn(x, status);
        x.decided_via = 'viewer';
        changed.push(`${id}: ${x.status}${x.status !== 'rejected' || status === 'rejected' ? '' : ` (${x.rejected_why})`}`);
      }
    }
    if (changed.length) {
      const tmp = `${board}.tmp`;
      writeFileSync(tmp, JSON.stringify(g, null, 2) + '\n');
      renameSync(tmp, board);
    }
    return { status: 200, changed, skipped };
  } finally { removeOwnRunfile(RUN); removeLock(LOCK); }
}

// Switch which board the viewer is showing. Nothing about the old board changes; the file is
// the record and the viewer only ever pointed at it.
function switchTo(path) {
  if (typeof path !== 'string') return { status: 400, error: 'not a board this viewer knows' };
  const p = resolve(path);
  if (!boards().some((b) => !b.error && canonical(b.path) === canonical(p))) return { status: 400, error: 'not a board this viewer knows' };
  if (!existsSync(p)) return { status: 400, error: 'no such file' };
  return { status: 200, ok: true, file: p, url: `/?board=${encodeURIComponent(p)}` };
}

// Pass the cap entered on the page to the runner so in-flight reservations use the same limit.
async function launch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
  // Dollars validate the way counts do: a named boolean or array is a refusal, not a
  // coercion (Number(true) === 1 and Number([5]) === 5 used to launch). Only an
  // unnamed, null, or blank cap is absent; the page sends "" for an untouched box.
  const capProvided = body.cap !== undefined && body.cap !== null && !(typeof body.cap === 'string' && body.cap.trim() === '');
  const cap = (typeof body.cap === 'boolean' || Array.isArray(body.cap)) ? NaN : Number(body.cap);
  if (capProvided && (!Number.isFinite(cap) || cap <= 0)) return { status: 400, error: 'a launch needs a positive dollar cap' };
  const reserveBad = typeof body.reserve === 'boolean' || Array.isArray(body.reserve);
  if (body.reserve !== undefined && (reserveBad || !Number.isFinite(Number(body.reserve)) || Number(body.reserve) < 0))
    return { status: 400, error: 'reserve must be a nonnegative dollar amount' };
  // Absent means never named, null, or a blank string: the page sends "" for an untouched
  // box. Anything else names a budget and must validate, so [] or true cannot slip through
  // as "not given" while the launch proceeds.
  const absent = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  const given = (...keys) => keys.filter((k) => !absent(body[k]));
  const invGiven = given('invocations', 'maxInvocations', 'max_invocations');
  const tokGiven = given('outputTokens', 'maxOutputTokens', 'output_tokens', 'max_output_tokens');
  if (invGiven.length > 1) return { status: 400, error: `conflicting invocation budgets: ${invGiven.map((k) => `'${k}'`).join(', ')} were all given; name only one` };
  if (tokGiven.length > 1) return { status: 400, error: `conflicting output-token budgets: ${tokGiven.map((k) => `'${k}'`).join(', ')} were all given; name only one` };
  const invRaw = invGiven.length ? body[invGiven[0]] : undefined;
  const tokRaw = tokGiven.length ? body[tokGiven[0]] : undefined;
  // Counts coerce the way the dollar cap does (numbers and numeric strings), except
  // booleans and arrays, which Number() would silently fold into 1 or a single element.
  const asCount = (raw) => {
    if (typeof raw === 'boolean' || Array.isArray(raw)) return NaN;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  };
  const invocations = invRaw === undefined ? null : asCount(invRaw);
  const outputTokens = tokRaw === undefined ? null : asCount(tokRaw);
  if (invRaw !== undefined && !Number.isInteger(invocations)) return { status: 400, error: 'invocations must be a positive integer' };
  if (tokRaw !== undefined && !Number.isInteger(outputTokens)) return { status: 400, error: 'output tokens must be a positive integer' };
  const capValid = capProvided && Number.isFinite(cap) && cap > 0;
  if (!capValid && invocations === null && outputTokens === null) return { status: 400, error: 'a launch needs a positive dollar cap' };
  const r = runner();
  if (['live', 'wedged', 'unknown'].includes(r.state)) {
    if (r.role === 'gate') return { status: 409, error: `pid ${r.pid} is gating the board; launching would refuse. Wait for it to finish.` };
    return { status: 409, error: `pid ${r.pid} still owns this board or cannot be identified; inspect it before launching` };
  }
  // A gate holds the lock and beats like a run; the guard above names it from the runfile.
  // This one is for a holder with no runfile behind it -- claimed, but its first beat has not
  // landed yet, or a writer from before runfiles. Spawning into either returns a 200 for a
  // child that refuses on its first breath, so refuse at the same bar the child would: live
  // or unverifiable. A holder that appears after this check is caught by the verify below.
  const held = lockClaimant(lockPathOf(runfile()), current());
  if (held) {
    const v = liveLockHolder(lockPathOf(runfile()), current());
    const what = v ? `it is ${holderDoing(v)}` : 'its ownership could not be verified';
    return { status: 409, error: `pid ${held.pid} holds this graph's lock, ${what}; launching would refuse. Wait for it to finish.` };
  }
  let execution;
  try { execution = resolveExecution(readBoard(current()), executionOverrides(), process.env, join(here, '..')); }
  catch (e) { return { status: 400, error: e.message }; }
  const executorArgs = ['--exec', execution.command, ...(executionOverrides().model === undefined ? [] : ['--model', execution.model]), ...(executionOverrides().effort === undefined ? [] : ['--effort', execution.effort])];
  const preflight = spawnSync(process.execPath, [join(here, '..', 'doctor.mjs'), current(), ...executorArgs],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (preflight.error || preflight.status !== 0) return { status: 400,
    error: `Readiness checks refused the launch: ${preflight.error?.message ?? (preflight.stdout + preflight.stderr).trim()}` };
  const args = [join(here, '..', 'run.mjs'), current(), ...executorArgs];
  if (capValid) args.push('--max-usd', String(cap));
  if (invocations !== null) args.push('--max-invocations', String(invocations));
  if (outputTokens !== null) args.push('--max-output-tokens', String(outputTokens));
  if (body.only) args.push('--only', String(body.only));
  if (body.reserve) args.push('--reserve-usd', String(Number(body.reserve)));
  const log = current().replace(/\.json$/, '') + '.viewer-launch.log';
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.on('error', error => console.error(`viewer launch failed for ${current()}: ${error.message}`));
  child.unref();
  // The child claims the lock itself. A holder that appeared between the check and the spawn
  // makes it refuse, and a 200 for a refused launch is the same lie as an erased decision.
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code ?? 1; });
  const nap = (ms) => new Promise((res) => setTimeout(res, ms));
  const since = Date.now();
  let beat = false;
  while (Date.now() - since < 8000 && exitCode === null && !beat) {
    await nap(200);
    try { beat = JSON.parse(readFileSync(runfile(), 'utf8'))?.pid === child.pid; }
    catch { /* not beaten yet */ }
  }
  // Exit 0 finished clean and 10 left cells in flight: both launched. Anything else this
  // early is a refusal or a crash, told apart by whether a writer holds the graph now.
  if (exitCode !== null && exitCode !== 0 && exitCode !== 10) {
    const r2 = runner();
    const held2 = lockClaimant(lockPathOf(runfile()), current());
    if (['live', 'wedged', 'unknown'].includes(r2.state) || held2)
      return { status: 409, error: `the launch was refused: another writer holds this graph; see ${log}` };
    return { status: 500, error: `the runner exited ${exitCode} before beating; see ${log}` };
  }
  return { status: 200, ok: true, pid: child.pid, cap: capValid ? cap : null, invocations, outputTokens,
    only: body.only ?? null, log, verified: beat || exitCode === 0 || exitCode === 10 };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const selected = url.searchParams.get('board');
  const chosen = selected ? canonical(selected) : file;
  if (selected && !boards().some(b => !b.error && canonical(b.path) === chosen)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not a board this viewer knows' })); return;
  }
  requests.run(chosen, () => handle(req, res, url));
});
function handle(req, res, url) {
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const safeJson = (status, obj) => { try { json(status, obj); } catch { /* client went away */ } };
  if (READ_ONLY && !['GET', 'HEAD'].includes(req.method)) {
    return json(403, { error: 'This viewer is read-only. Use the CLI for decisions and launches.' });
  }
  // Without `--control` the page shows the board and writes nothing; switching boards only
  // repoints the page. The CLI answers and launches.
  if (!CONTROL && !['GET', 'HEAD'].includes(req.method) && !req.url.startsWith('/api/switch')) {
    return json(403, { error: 'This viewer only shows the board. Start it with --control to decide and launch from the page, or use the CLI.' });
  }
  const readBody = (fn) => {
    let raw = ''; const chosen = current();
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => requests.run(chosen, () => {
      let b; try { b = JSON.parse(raw || '{}'); } catch { return safeJson(400, { error: 'bad json' }); }
      // A JSON body that is not an object carries no fields; treat it as an empty one so
      // each endpoint answers with its own 400 instead of throwing on property access.
      // `null` used to kill the server here (uncaught TypeError through this handler).
      if (b === null || typeof b !== 'object' || Array.isArray(b)) b = {};
      // Endpoints are sync or async alike; a throw answers 500 instead of killing the server.
      Promise.resolve()
        .then(() => fn(b))
        .then((out) => safeJson(out.status ?? 200, out),
          (e) => { console.error(`viewer ${url.pathname} failed: ${e?.message ?? e}`); safeJson(500, { error: String(e?.message ?? e).split('\n')[0] }); });
    }));
  };
  if (url.pathname === '/api/health') {
    try {
      const execution = resolveExecution(readBoard(current()), executionOverrides(), process.env, join(here, '..'));
      return json(200, { pid: process.pid, graph: current(), execution_signature: executionSignature(execution), control: CONTROL });
    } catch (e) { return json(503, { pid: process.pid, graph: current(), control: CONTROL, error: e.message }); }
  }
  if (req.url.startsWith('/api/graph')) return json(200, snapshot());
  if (req.url.startsWith('/api/decisions')) return json(200, decisionsCached());
  if (req.url.startsWith('/api/boards')) return json(200, { boards: boards() });
  if (req.url.startsWith('/api/switch') && req.method === 'POST') return readBody((b) => switchTo(b.path));
  if (req.url.startsWith('/api/launch') && req.method === 'POST') return readBody(launch);
  if (req.url.startsWith('/api/decide') && req.method === 'POST') return readBody(decide);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page());
  // 127.0.0.1 on purpose: this answers a yes or no by writing the graph, and a page that can do
  // that should not be reachable from anywhere but the machine it runs on.
}
// Compare real paths: argv may spell this file through a symlink (/tmp on macOS),
// in which case a plain resolve() never matches and the server silently no-ops.
const invokedAsMain = (() => {
  try { return realpathSync(resolve(process.argv[1] ?? '')) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedAsMain) {
  server.listen(PORT, '127.0.0.1', () => {
    const actualPort = server.address().port;
    if (process.send) process.send({ type: 'listening', port: actualPort });
    console.log(`\n  ostoyae viewer  ${file}`);
    console.log(`  http://localhost:${actualPort}\n`);
  });
}
// Exported so a harness can drive launch() without TCP: `node harness.mjs <board>` imports
// this module (which then does not listen) and awaits launch() with the board from argv.
export { launch };
