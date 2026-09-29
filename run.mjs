#!/usr/bin/env node
// Walk the board, launch ready work, and absorb what attempts discover.
// A handback adds proposed work and edges to the same board. Proposals remain inert until
// you confirm them. The runner assigns identifiers shared across attempts so cells cannot collide.

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, rmdirSync, readdirSync, mkdirSync, mkdtempSync, openSync, closeSync, statSync, readSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { provision, teardown, ensureTrunk, integrate, trunkOf, trunkPath, checkTree } from './sandbox.mjs';
import { derive, kindOf, LIMIT_RE } from './viewer/state.mjs';
import { fill, claimHash } from './lib/claims.mjs';
import { wallNamesNothing } from './lib/wall.mjs';
import { REPORT, USAGE, WORK, VERIFY, absorb as absorbInto, readReport, readUsage } from './lib/handback.mjs';
import * as spend from './lib/spend.mjs';
import { classifyDrain as classifyDrainOf, report as reportOf } from './lib/summary.mjs';
import { alive, readRun as readRunFile, cellPathOf as cellPathIn, cellLogOf as cellLogIn, cellAlive,
         rememberCellGroup, killCell as killCellIn, stopRun as stopRunWith,
         claimRunLock, liveLockHolder, lockPathOf, removeLock, removeOwnRunfile, holderDoing } from './lib/liveness.mjs';
import { decide as decideWith, confirmScoped as confirmScopedWith } from './lib/decide.mjs';
import { captureIdentity, processOwner, canonicalPath } from './lib/process-identity.mjs';
import { cellEnvironment, identifyExecutor } from './lib/providers.mjs';
import { resolveAttempt, selectsAgents } from './lib/attempt-execution.mjs';
import { reservePort } from './lib/ports.mjs';
import { validateEffort, effectiveEffort } from './lib/effort.mjs';
import { entries as mailEntries, limits as messageLimits, locked as mailLocked, reads as messageReads, startCursor, notice as mailNotice } from './lib/messaging.mjs';
import { findOverlaps, overlapKey, short } from './lib/overlap.mjs';
import { serve as serveMailRelay } from './lib/mail-relay.mjs';
import { terminal, forPerson, showsPlumbing } from './lib/terminal.mjs';

const argv = process.argv.slice(2);
function usageFor(a, path) {
  const usage = readUsage(path);
  if (!usage || usage._bad || a.params?.effort == null) return usage;
  usage.effort = a.params.effort;
  writeFileSync(join(path, USAGE), JSON.stringify(usage, null, 2) + '\n');
  return usage;
}
const rawFile = argv.find((a) => !a.startsWith('--') && !isValueOf(a));
const flag = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
function isValueOf(a) { const i = argv.indexOf(a); return i > 0 && ['--exec', '--model', '--effort', '--confirm', '--reject', '--reject-why', '--max-launches', '--max-usd', '--max-output-tokens', '--max-invocations', '--reserve-usd', '--only', '--adopt-wait'].includes(argv[i - 1]); }
const CONFIRM_SCOPED = flag('--confirm-scoped');
const AUTO_ADVANCE = flag('--auto-advance');
// Detached cells survive a dead runner. `--stop` lets in-flight cells settle; `--stop --now` kills them.
const STOP = flag('--stop');
// Run every active item with a claim through its kind's gate and write the results, launching
// nothing. What a run does before each launch, done to the whole board at once.
const GATE = flag('--gate');
const NOW = flag('--now');

if (!rawFile) {
  console.error('usage: node run.mjs <graph.json> [--dry-run] [--exec "<cmd>"] [--keep] [--only <id>]');
  console.error('       budget: --max-launches N | --max-usd N | --max-output-tokens N  (any, all; first to bind stops new launches)');
  console.error('               --max-invocations N  every agent session on the record: work, map AND verify, cumulative across restarts');
  console.error('               --reserve-usd N   what each in-flight attempt counts for against --max-usd (default: mean settled cost)');
  console.error('       node run.mjs <graph.json> --confirm <id>[,<id>...] | --reject <id>[,<id>...] [--reject-why "<text>"] | --confirm-scoped');
  console.error('       node run.mjs <graph.json> --stop [--now]   stop a live run; --now kills the cells too');
  process.exit(2);
}
// One spelling per board from here on: every sidecar (runfile, lock, live view) and every
// identity record derives from this string, so two aliases of one file share them instead
// of splitting brains.
const file = canonicalPath(rawFile);

const DRY = flag('--dry-run');
const EXEC = arg('--exec', null);
const KEEP = flag('--keep');
const CONFIRM = arg('--confirm', null);
const REJECT = arg('--reject', null);
// Record your reason for rejecting a route so the decision can be understood later.
const REJECT_WHY = arg('--reject-why', null);
const MAX_LAUNCHES = Number(arg('--max-launches', 0)) || 0;
// `--max-launches` counts sessions, not spend. Usage caps count reported resources across the board record.
const MAX_USD = Number(arg('--max-usd', 0)) || 0;
const MAX_OUTPUT_TOKENS = Number(arg('--max-output-tokens', 0)) || 0;
// Reserve estimated spend for in-flight attempts so concurrency does not bypass the cap.

// The allowance that counts sessions rather than money, across every role and across restarts.
// The three caps above do not answer "how many agent sessions may this campaign spend in total".
const MAX_INVOCATIONS = Number(arg('--max-invocations', 0)) || 0;
const RESERVE_USD = Number(arg('--reserve-usd', 0)) || 0;

// Wait a bounded time for an orphaned live cell; it may still produce a handback. Leave it running after timeout.
const ADOPT_WAIT_MIN = arg('--adopt-wait', null) === null ? 20 : Number(arg('--adopt-wait', 20));

for (const [name, integer] of [['--max-launches', true], ['--max-usd', false],
  ['--max-output-tokens', true], ['--max-invocations', true],
  ['--reserve-usd', false], ['--adopt-wait', false]]) {
  if (!flag(name)) continue;
  const value = arg(name, null), n = Number(value);
  if (value == null || !String(value).trim() || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    console.error(`  ${name} needs a nonnegative ${integer ? 'integer' : 'number'}. Nothing run.`);
    process.exit(2);
  }
}

// Reject unknown flags and missing executors before provisioning; otherwise every ready item could record a failed attempt.
const KNOWN_FLAGS = new Set(['--dry-run', '--exec', '--model', '--effort', '--keep', '--only', '--confirm', '--reject', '--confirm-scoped',
  '--max-launches', '--max-usd', '--max-output-tokens', '--max-invocations', '--reserve-usd', '--reject-why',
  '--stop', '--now', '--adopt-wait', '--gate', '--auto-advance', '--messaging', '--no-messaging']);
const unknownFlags = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a) && !isValueOf(a));
if (unknownFlags.length) {
  console.error(`  unknown flag ${unknownFlags.join(', ')}. Nothing run.`);
  process.exit(2);
}
// One node and what it needs, nothing else. A graph of fifty-three problems is the god view;
// a run is usually one problem being worked out. `--only w-erdos-282` launches on 282 and on
// everything 282 transitively needs (its confirmed tasks, their prerequisites), and skips the
// other fifty-two. The file stays whole; only the launches narrow.
const ONLY = arg('--only', null);
const g = JSON.parse(readFileSync(file, 'utf8'));
// A board that names its agents (execution.provider, or an agent per role or per job) runs without --exec.
// One that names none still needs --exec or --dry-run, as it always did.
if (!DRY && !EXEC && !selectsAgents(g) && CONFIRM === null && REJECT === null && !CONFIRM_SCOPED && !STOP && !GATE) {
  console.error('  nothing to execute: --exec "<cmd>" runs attempts, --dry-run walks without touching anything. Nothing run.');
  process.exit(2);
}
let MESSAGING = !flag('--no-messaging') && g.messaging !== false;
if (MESSAGING) messageLimits(g.messaging);
let SAVED_DEFAULTS = g.defaults;
if (flag('--model')) {
  const model = arg('--model', null);
  if (!model || model.startsWith('--') || !model.trim()) {
    console.error('  --model needs a model ID. Nothing run.');
    process.exit(2);
  }
  g.defaults = { ...g.defaults, model };
}
if (flag('--effort')) {
  try { g.defaults = { ...g.defaults, effort: validateEffort(arg('--effort', null), '--effort') }; }
  catch (e) { console.error(`  ${e.message}. Nothing run.`); process.exit(2); }
}
try {
  for (const [name, params] of [['defaults', g.defaults], ...g.work.map(w => [`work.${w.id}.params`, w.params]),
    ['mapping.params', g.mapping?.params], ['judge.params', g.judge?.params]]) {
    const effort = effectiveEffort(params);
    if (effort !== undefined) validateEffort(effort, `${name}.${params.effort !== undefined ? 'effort' : 'reasoning_effort'}`);
  }
} catch (e) { console.error(`  ${e.message}. Nothing run.`); process.exit(2); }

g.attempts ??= [];
g.edges ??= [];
g.concurrency ??= 3;
g.max_attempts ??= 3;

// Reject duplicate work ids. Aliases would merge unrelated attempts and could launch one id more than once.
for (const [plane, xs] of [['work', g.work ?? []], ['edges', g.edges]]) {
  const seen = new Map();
  for (const x of xs) seen.set(x.id, (seen.get(x.id) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1);
  if (dup.length) {
    console.error(`  ${file}: duplicate ${plane} ids: ${dup.map(([id, n]) => `${id} x${n}`).join(', ')}.` +
                  `\n  Give each entry its own id; variants of one problem are different work items.\n`);
    process.exit(2);
  }
}

// Mapping is off when the key is absent. When it is on, `what` is the instruction handed to every
// map attempt, and it has to be in the file: there is no default written in code, because a
// person opening the graph should be able to read what the mapper was told.
if (g.mapping != null) {
  if (typeof g.mapping !== 'object' || typeof g.mapping.what !== 'string' || !g.mapping.what.trim()) {
    console.error(`  ${file}: mapping is on but mapping.what is missing. It is the instruction handed` +
                  `\n  to every map attempt and there is no default. Write it in the graph.\n`);
    process.exit(2);
  }
  g.mapping.max_attempts ??= 1;
  // Zero would mark every unmapped item exhausted before anything ran, and print it as a result.
  if (!Number.isInteger(g.mapping.max_attempts) || g.mapping.max_attempts < 1) {
    console.error(`  ${file}: mapping.max_attempts is ${JSON.stringify(g.mapping.max_attempts)}. Make it a positive` +
                  `\n  integer, or leave it out for 1.\n`);
    process.exit(2);
  }
}

// When `judge` is absent, proposals require your decision. With it, `verify` supplies the verifier prompt and `default_check` gates items without their own check.
if (g.judge != null) {
  const j = g.judge;
  const bad = typeof j !== 'object' || Array.isArray(j) ||
    (j.verify != null && (typeof j.verify !== 'string' || !j.verify.trim())) ||
    (j.default_check != null && (typeof j.default_check !== 'string' || !j.default_check.includes('{id}')));
  if (bad) {
    console.error(`  ${file}: judge is on but malformed. It is { verify: "<instruction to every verify attempt>",` +
                  `\n  default_check: "<shell command with {id}>", require_check: true|false, params: {...} }, every key optional.\n`);
    process.exit(2);
  }
}

// Ontology assigns proposal identity from declared claims, so equivalent discoveries share one item instead of creating duplicate work.
if (g.ontology != null) {
  const o = g.ontology;
  const kinds = o?.kinds;
  const bad = typeof o !== 'object' || Array.isArray(o) || typeof kinds !== 'object' || !kinds ||
    !Object.keys(kinds).length ||
    Object.entries(kinds).some(([, k]) =>
      typeof k !== 'object' || !Array.isArray(k.claim) || !k.claim.length ||
      k.claim.some((x) => typeof x !== 'string') ||
      (k.evidence != null && !Array.isArray(k.evidence)) ||
      typeof k.id !== 'string' || !k.id.includes('{') ||
      typeof k.what !== 'string' || !k.what.includes('{'));
  if (bad) {
    console.error(`  ${file}: ontology is on but malformed. Each kind is { claim: [required keys],` +
                  `\n  evidence: [optional keys], id: "template-{key}", what: "instruction {key}", check: "optional" }.\n`);
    process.exit(2);
  }
}


// Liveness, beside the graph and never inside it. The graph is the record and is written when the
// graph changes; a heartbeat changes every two seconds and says nothing about the work, so it
// would bury the record in beats. Left behind when a runner dies, which is how the next one knows.
const RUNFILE = file.replace(/\.json$/, '') + '.run.json';
const LOCKFILE = lockPathOf(RUNFILE);
let heart = null;                // the heartbeat timer, stopped before the runfile is removed
const RUN_STARTED = new Date().toISOString();
let MAILBOX = null;
let MAIL_VIEW = null;
let MAIL_RELAY = null, mailTimer = null, overlapTimer = null;
let mailBase = 0;
// Pair-and-path keys already noticed, so two attempts hear about one shared file once.
const overlapsTold = new Set();
function syncMessages() {
  if (!MAILBOX) return;
  const now = mailLocked(MAILBOX, () => mailEntries(MAILBOX));
  g.messages ??= [];
  if (now.length > mailBase) {
    g.messages.push(...now.slice(mailBase));
    mailBase = now.length;
  }
  for (const a of g.attempts) {
    if (!a.messaging || !a.messaging.mailbox || a.messaging.mailbox !== MAILBOX) continue;
    a.messaging.sent = now.filter(x => x.from === a.id).length;
    a.messaging.read = messageReads(MAILBOX, a.id);
  }
}
// A clean exit has copied every message onto the board, so this run's mailbox, cursors and lock go,
// and the .mail directory with them once it is empty. Otherwise a run that merely had messaging on
// leaves untracked files beside the board, and a campaign refuses the directory as uncommitted work.
// A crashed run keeps its mailbox; the next run recovers it onto the board.
function dropMailbox() {
  if (!MAILBOX) return;
  if (mailTimer) clearInterval(mailTimer);
  if (overlapTimer) clearInterval(overlapTimer);
  mailTimer = overlapTimer = null;
  if (MAIL_RELAY) rmSync(MAIL_RELAY, { recursive: true, force: true });
  MAIL_RELAY = null;
  const dir = dirname(MAILBOX), base = basename(MAILBOX);
  for (const f of readdirSync(dir)) if (f === base || f.startsWith(`${base}.`)) rmSync(join(dir, f), { recursive: true, force: true });
  try { rmdirSync(dir); } catch {}
  MAILBOX = null;
}
function recoverMessages() {
  const seen = new Set((g.messages ?? []).map(x => x.id));
  for (const path of new Set(g.attempts.map(a => a.messaging?.mailbox).filter(Boolean))) {
    if (path === MAILBOX) continue;
    if (!existsSync(path)) continue;
    const now = mailLocked(path, () => mailEntries(path));
    g.messages ??= [];
    for (const entry of now) if (!seen.has(entry.id)) { g.messages.push(entry); seen.add(entry.id); }
    for (const a of g.attempts.filter(a => a.messaging?.mailbox === path)) {
      a.messaging.sent = now.filter(x => x.from === a.id).length;
      a.messaging.read = messageReads(path, a.id);
    }
  }
}

// Who an attempt is working beside, for its contract: the attempts on this run's mailbox that
// are running when it launches. Only those can hear it.
function peersOf(a) {
  return g.attempts.filter((x) => x.id !== a.id && x.state === 'running' && x.messaging?.mailbox === MAILBOX)
    .map((x) => ({ id: x.id, of: x.of, kind: kindOf(x), what: short(work.get(x.of)?.what ?? ''),
                   agent: x.params?.agent ?? 'unknown', model: x.params?.model ?? 'provider default' }));
}

// Every few seconds while messaging is on: which running cells have changed the same path.
// Each pair hears about each path once, from sender `ostoyae`, through the same mailbox, so the
// notice lands in `messages` on the board and in `ostoyae-msg read` like any other message.
const OVERLAP_EVERY_MS = 3000;
function watchOverlaps() {
  if (!MAILBOX) return;
  try {
    const running = g.attempts.filter((x) => x.state === 'running' && x.messaging?.mailbox === MAILBOX && x.sandbox?.start_commit)
      .map((x) => ({ attempt: x, path: cellPathOf(x), start: x.sandbox.start_commit }));
    const found = findOverlaps(running, overlapsTold, (id) => work.get(id)?.what);
    if (!found.length) return;
    for (const n of found) {
      mailNotice(MAILBOX, n.to.id, n.text, { overlap: { path: n.path, with: n.other.id } });
      if (!overlapsTold.has(n.key)) console.log(`  ${pad(n.to.id, 8)} ${pad('overlap', 7)} ${n.path} is also changed by ${n.other.id}; told both`);
      overlapsTold.add(n.key);
    }
    checkpoint();
  } catch (e) {
    console.log(`  ${pad('', 8)} ${pad('overlap', 7)} could not check cells for shared files: ${String(e.message).split('\n')[0]}`);
  }
}

// What each running agent is saying, and what it has written into its handback so far. Beside
// the graph, never in it: it changes every second and it is not the record. Left for the page to
// read, so a person can watch a node think and watch its edges form before it hands back. The
// record still comes from the handback at settle, and nothing here changes what the runner does.
const LIVEFILE = file.replace(/\.json$/, '') + '.live.json';
const live = {};                 // attempt id -> { of, kind, lines: [...], tentative: report so far }
function publishLive() {
  if (DRY) return;
  const tmp = `${LIVEFILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: today(), attempts: live }, null, 2) + '\n');
  renameSync(tmp, LIVEFILE);
}

const work = new Map(g.work.map((w) => [w.id, w]));
let seq = g.attempts.length;
let eseq = g.edges.length;
let clock = 0;
let launched = 0;
// Set by SIGINT/SIGTERM, read by the loop and by the cells' close handler. `stopping` stops new
// launches and lets what is in flight land. `hardStop` is the second signal: the cells are killed,
// and then nothing is torn down, because a cell that was killed mid-work may have committed
// something to its branch and a teardown would take the branch with it.
let stopping = null;
let hardStop = false;

const pad = (s, n) => String(s).padEnd(n);
// Two readers. A log or a pipe gets every line, plain and greppable, exactly as before. A person
// at a terminal gets the story: launches, outcomes, and the moment a job walls and a new job is
// born. Worktree and trunk bookkeeping is plumbing for them; OSTOYAE_VERBOSE=1 brings it back.
const HUMAN = forPerson(process.stdout);
const PLUMBING = showsPlumbing(process.stdout);
const T = terminal(process.stdout);
const plumb = (line) => { if (PLUMBING) console.log(line); };
let COL = 18;
const tint = { start: '2', done: '32', planned: '2', judged: '2', walled: '38;5;179', failed: '31', check: '2', yes: '32', no: '31' };
// One event line. Plain output keeps the old columns; a person gets the same columns, coloured.
const widen = () => { COL = Math.min(28, Math.max(COL, ...g.work.map((x) => x.id.length + 2), ...g.edges.map((e) => `${e.from} → ${e.to}`.length + 2))); };
const event = (id, kind, rest) => {
  if (!HUMAN) return console.log(`  ${pad(id, 8)} ${pad(kind, 7)} ${rest}`);
  console.log(`  ${T.dim(pad(id, 8))} ${T.paint(tint[kind] ?? '0', pad(kind, 7))} ${rest}`);
};
const today = () => new Date().toISOString();
const isEdgeId = (id) => String(id).startsWith('e-');
const lookup = (id) => (isEdgeId(id) ? g.edges.find((e) => e.id === id) : work.get(id));
const statusOf = (x) => x?.status ?? 'active';

/* ---------------------------------------------------------- checkpointing */

// Write each transition atomically so the viewer never reads stale or partial board state.
function checkpoint() {
  if (DRY) return;                          // a rehearsal does not get to write history
  syncMessages();
  recoverMessages();
  const tmp = `${file}.tmp`;
  const record = flag('--model') || flag('--effort') ? { ...g, defaults: SAVED_DEFAULTS } : g;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, file);
  if (MAIL_VIEW) {
    writeFileSync(`${MAIL_VIEW}.tmp`, JSON.stringify({ messaging: g.messaging,
      attempts: g.attempts.map(a => ({ id: a.id, of: a.of, what: a.what,
        state: a.state, cell_pid: a.cell_pid })) }) + '\n');
    renameSync(`${MAIL_VIEW}.tmp`, MAIL_VIEW);
  }
}


// The pieces that read the record without touching the loop live in lib/, and take the board
// as an argument. These bind them to this run's board, file and flags so the loop reads as it did.
const readRun = () => readRunFile(RUNFILE);
const cellPathOf = (a) => cellPathIn(g, a);
const cellLogOf = (a) => cellLogIn(g, a);
const killCell = (a) => { const signalled = killCellIn(g, a); checkpoint(); return signalled; };
const CAPS = { MAX_INVOCATIONS, MAX_USD, MAX_OUTPUT_TOKENS, RESERVE_USD };
const RECORDED_BUDGETS = { launches: MAX_LAUNCHES || null, usd: MAX_USD || null,
  output_tokens: MAX_OUTPUT_TOKENS || null, invocations: MAX_INVOCATIONS || null,
  reserve_usd: RESERVE_USD || null };
const spendSoFar = () => spend.spendSoFar(g);
const dearestOfKind = (kind) => spend.dearestOfKind(g, kind);
const unpricedKindBusy = (kind) => spend.unpricedKindBusy(g, kind, RESERVE_USD);
const reserveUsed = () => spend.reserveUsed(g, RESERVE_USD);
const overBudget = () => spend.overBudget(g, CAPS);
const absorb = (rep, a) => absorbInto(rep, a, { g, work, ONT, today, edgeId: () => `e-${String(++eseq).padStart(4, '0')}` });
const decide = (ids, status) => decideWith(ids, status, { g, work, S, REJECT_WHY, today });
const confirmScoped = (targets = null) => confirmScopedWith(targets, { g, work, S, today, ...(HUMAN && targets ? { say: () => {} } : {}) });
const classifyDrain = () => classifyDrainOf({ g, S, gateBlocks });
const report = () => reportOf({ g, S, file, gateBlocks });
const stopRun = () => stopRunWith({ g, file, RUNFILE, NOW });
const RUN_IDENTITY = captureIdentity(process.pid, { runnerFile: file });

// What this process is doing with the graph. Every writer holds a runfile -- a run, a gate,
// a decision -- because a pre-lock engine never looks at the lock and the runfile is the
// only thing it can see. Old readers ignore the extra field and treat every holder as a
// live runner, which is the safe direction.
let BEAT_ROLE = 'run';
function beat() {
  if (DRY) return;
  const temp = `${RUNFILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({
    graph: g.graph, file, pid: process.pid, identity: RUN_IDENTITY, started: RUN_STARTED,
    beat: today(), launched, budget: MAX_LAUNCHES || null, role: BEAT_ROLE,
    invocations: g.attempts.length, invocation_allowance: MAX_INVOCATIONS || null,
    budgets: RECORDED_BUDGETS,
  }, null, 2) + '\n');
  renameSync(temp, RUNFILE);
}

// A second runner on the same graph is not a race worth surviving. Each holds the whole file in
// memory and writes it back, so the loser's attempts are not corrupted, they are gone: absent
// from the record with nothing to say they ever ran. Refuse, and say which process to wait for.
function foreignRunner() {
  const prev = readRun();
  return prev && prev.pid !== process.pid &&
    processOwner(prev.pid, { identity: prev.identity, runnerFile: file }) !== false ? prev : null;
}

// Anything that writes the graph refuses beside a live runner: main, --gate, and the decision
// path. A live lock holder counts too: it covers the breath between one writer's claim and
// its first beat, and any crafted lock with no runfile at all. A runfile that cannot be
// read refuses plainly rather than as a stack trace; the message names the resolution.
function blockingRunner() {
  let prev = null;
  try { prev = foreignRunner(); }
  catch (e) { console.error(`  ${e.message}\n`); process.exit(1); }
  return prev ?? liveLockHolder(LOCKFILE, file);
}

// A live runfile with no lock behind it is a writer from before locks existed: every
// current writer claims before it beats, so nothing current can be in that state. Checked
// once, so the note is advisory -- but the refusal it rides on is not.
function legacyNote(other) {
  if (!other?.beat) return '';
  try { if (existsSync(LOCKFILE)) return ''; } catch { return ''; }
  return `\n  This is a pre-lock engine: a live runfile with no lock behind it. Stop it or upgrade it before launching beside it.`;
}

// Said once, the same way, wherever a second writer is refused.
function refuseLiveRunner(other) {
  if (other?.beat) {
    console.error(`  a runner is already live on this graph: pid ${other.pid}, started ${other.started},` +
                  `\n  last beat ${other.beat}, ${holderDoing(other)}. Two runners write this file over each other and one` +
                  `\n  loses its attempts entirely. Wait for it, or stop it, then run again.${legacyNote(other)}\n`);
  } else {
    const who = other?.pid ? `pid ${other.pid}, started ${other.started ?? 'unknown'}, no heartbeat yet: it is ${holderDoing(other)}`
      : 'another starter holds the lock and its holder could not be read';
    console.error(`  a runner is already live on this graph: ${who}.` +
                  `\n  Two runners write this file over each other and one loses its attempts entirely.` +
                  `\n  Wait for it, or stop it, then run again.\n`);
  }
  process.exit(1);
}

// A runner that died mid-run left its attempts saying `running`, and `running` is the one state
// nothing recovers from on its own: `ready` skips it, `exhausted` refuses to count it, and the
// work item is permanently busy on an agent that is not there.

async function sweep(prev) {
  const stale = g.attempts.filter((a) => a.state === 'running');
  if (!stale.length) {
    if (prev) plumb(`  swept    nothing: pid ${prev.pid} left no unsettled attempt\n`);
    return;
  }
  const who = `runner${prev ? ` pid ${prev.pid}` : ''}`;
  for (const a of stale) {
    const w = work.get(a.of);
    const path = cellPathOf(a);
    if (path && cellAlive(a.cell_pid, path, a.cell_identity, a.cell_group)) {
      console.log(`  ${pad(a.id, 8)} ${pad('adopted', 7)} ${pad(a.of, 14)} cell pid ${a.cell_pid} outlived ${who};` +
                  ` waiting up to ${ADOPT_WAIT_MIN}m for it`);
      const until = Date.now() + ADOPT_WAIT_MIN * 60_000;
      let spoke = Date.now();
      while (cellAlive(a.cell_pid, path, a.cell_identity, a.cell_group) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        // A silent wait and a wedge look identical from outside, and that is what made the
        // unbounded version so hard to diagnose. So it says so, once a minute.
        if (Date.now() - spoke >= 60_000) {
          spoke = Date.now();
          console.log(`  ${pad(a.id, 8)} ${pad('adopted', 7)} ${pad(a.of, 14)} still running,` +
                      ` ${Math.ceil((until - Date.now()) / 60_000)}m left before this run stops waiting`);
        }
      }
      if (cellAlive(a.cell_pid, path, a.cell_identity, a.cell_group)) {
        console.log(`  ${pad(a.id, 8)} ${pad('waited', 7)} ${pad(a.of, 14)} cell pid ${a.cell_pid} is still running after` +
                    ` ${ADOPT_WAIT_MIN}m. Left alone: it keeps its item, and whatever it hands back` +
                    `\n           is settled by a later runner. 'bin/ostoyae stop --now' kills it.`);
        continue;
      }
    }
    const report = path && existsSync(path) ? readReport(path) : null;
    if (path && existsSync(path)) snapshotEnd(a, path);
    if (!w || !report) {
      const why = `${who} exited before this attempt settled` + (path && existsSync(path) ? '; the cell left no handback' : '');
      a.state = 'failed';
      a.ended_at = today();                 // it has no `ended`: it never ended in that run's clock
      const usage = path && existsSync(path) ? usageFor(a, path) : null;
      a.result = { why, ...(usage ? { usage } : {}) };
      console.log(`  ${pad(a.id, 8)} ${pad('swept', 7)} ${pad(a.of, 14)} ${why}`);
      continue;
    }
    // The handback is there, so the cell finished on its own. Its exit code is lost with the
    // runner that was listening for it, and the check decides a prove anyway; a map or a verify
    // is decided by what it handed back, as always.
    console.log(`  ${pad(a.id, 8)} ${pad('found', 7)} ${pad(a.of, 14)} handback in ${path}; settling from it`);
    const cell = { path, env: { OSTOYAE_ATTEMPT: a.id, OSTOYAE_WORK: a.of, OSTOYAE_BRANCH: a.sandbox.branch,
                                OSTOYAE_WORKTREE: path, PORT: String(a.sandbox.port) },
                   made: { worktree: path, branch: a.sandbox.branch, db: null,
                           links: (g.sandbox.link ?? []).map((l) => join(path, l)) } };
    const why = `recovered: ${who} exited before this attempt settled; handback read from the cell`;
    let r = { ok: true, why, report, usage: usageFor(a, path), tail: [] };
    if (kindOf(a) === 'prove' && checkOf(w)) {
      const cmd = checkOf(w);
      const my = checkTurn.then(() => runCheck(cmd, cell, a));
      checkTurn = my.catch(() => {});
      const c = await my;
      HUMAN ? event(a.id, 'check', `${pad(a.of, COL)} ${c.code === 0 ? T.paint('32', 'passed') : T.paint('31', `FAILED, exit ${c.code}`)}  ${T.dim(cmd)}`)
        : console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} ${c.code === 0 ? 'passed' : `FAILED, exit ${c.code}`}  ${cmd}  (on ${c.on})`);
      r = c.code === 0
        ? { ...r, check: { ok: true, cmd, on: c.on } }
        : { ...r, ok: false, why: `check failed (exit ${c.code}): ${cmd}`, tail: c.tail, check: { ok: false, cmd, on: c.on } };
    }
    settle(a, w, r);
    if (!KEEP && !hardStop) {
      try { teardown(cell.made, g.sandbox, (m) => plumb(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`)); }
      catch (e) { console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} teardown failed: ${e.message}`); }
    }
  }
  console.log('');
  checkpoint();
}


/* ------------------------------------------------------------- derivation */

// Share readiness rules with the viewer so scheduling and display agree.
const S = derive(g);
const { effective, needsOf, attemptsOf, satisfied, refuted, running, spent, exhausted,
        openProposals, walled, blocked, schedulable, ready, inFlight, leverage,
        proveAttemptsOf, mapAttemptsOf, mappingOn, mapMax, hasMap, mapSpent,
        awaitingMap, nextKind, judgeOn, proposalsOf, pendingVerify, stale } = S;

if (AUTO_ADVANCE && (!judgeOn() || !(MAX_LAUNCHES || MAX_USD || MAX_OUTPUT_TOKENS || MAX_INVOCATIONS))) {
  console.error('  --auto-advance requires judge.verify and a positive launch, dollar, output-token, or invocation cap. Nothing run.');
  process.exit(2);
}

// A yes was given to a sentence. When the sentence changes, the yes is withdrawn: a confirmed
// edge whose ends no longer read as they did at confirm time goes back to `proposed`, dated,
// with the reason, and schedules nothing until someone confirms it again. Done on load so the
// record says it, not only the derivation. Edges from before fingerprints carry none and are
// left as they are.
function reopenStale() {
  for (const e of stale()) {
    e.status = 'proposed';
    e.reopened_at = today();
    e.reopened_why = 'the text of an end changed after it was confirmed';
    console.log(`  ${pad(e.id, 10)} reopened  ${e.from} blocks ${e.to}: ${e.reopened_why}`);
  }
}
if (!STOP) reopenStale();

/* --------------------------------------------------------------- decisions */


/* --------------------------------------------------------------- sandbox */

function assign(n) {
  const tag = String(n).padStart(4, '0');
  const slug = String(g.graph).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dbslug = slug.replace(/-/g, '_');
  return {
    worktree: `wt/${slug}/a-${tag}`,
    branch: `ost/${slug}/a-${tag}`,
    db: `ost_${dbslug}_${tag}`,
    port: g.sandbox?.port_base === 'auto' ? null : (g.sandbox?.port_base ?? 4100) + n,
  };
}

// What an attempt is told. A map attempt gets the graph's mapping instruction and then the item,
// so the file says in one place what every mapper was asked. A prove attempt on a mapped item
// gets the map after its own instruction: what the item settles, costs and needs is what the
// last attempt learned, and it goes where the next one will read it.
const checkOf = (w) => w?.check ?? (g.judge?.default_check ? g.judge.default_check.replaceAll('{id}', w.id) : null);


// Recognize a plan-window stop separately from work failure, so a quota does not exhaust the item.

function whatFor(w, kind, judging = null) {
  if (kind === 'map') return `${g.mapping.what}\n\nThe work item you are mapping is ${w.id}: ${w.what}`;
  if (kind === 'verify') {
    const lines = [g.judge.verify, '',
      `The attempt you are judging is ${judging.id}, a ${kindOf(judging)} attempt on ${w.id}: ${w.what}`];
    if (judging.result?.wall) lines.push('', `It stopped and named this as what stopped it (its wall): ${judging.result.wall}`,
      `Judge the wall under the id ${judging.id}.`);
    if (judging.result?.map) lines.push('', `Its map: settles: ${judging.result.map.settles}; cost: ${judging.result.map.cost ?? 'not given'}` +
      `${judging.result.map.notes ? `; notes: ${judging.result.map.notes}` : ''}`);
    lines.push('', 'It proposed:');
    for (const x of proposalsOf(judging)) {
      lines.push(isEdgeId(x.id) ? `- ${x.id}, an edge: ${x.from} blocks ${x.to}${x.why ? `, because: ${x.why}` : ''}`
                                : `- ${x.id}, a task: ${x.what}`);
    }
    lines.push('', `The same is in ${VERIFY}, with each proposal's full text. Hand back ${REPORT} with ` +
      `"verdicts": one entry per id above${judging.result?.wall ? ` (and one for ${judging.id}, the wall)` : ''}, ` +
      `each { "id", "ok": true or false, "why": one line }. Use disposable scratch files when testing a claim ` +
      `requires them. Change no tracked project file and commit nothing; only the report is kept.`);
    return lines.join('\n');
  }
  // An item counts as mapped without a `map` block when a map attempt proposed it; there is no
  // map text to append then, the item's own `what` is the mapper's sentence.
  const base = (!w.map || typeof w.map !== 'object')
    ? w.what
    : (() => {
        const m = w.map;
        const parts = [`settles: ${m.settles}`, `cost: ${m.cost ?? 'not given'}`];
        if (m.notes) parts.push(`notes: ${m.notes}`);
        return `${w.what}\n\nMap (${m.by ?? 'by hand'}): ${parts.join('; ')}`;
      })();
  return base + proposalContract();
}

// Give prove attempts the ontology shape too, so a discovered dependency can be accepted by `absorb`.
function proposalContract() {
  if (!ONT) return '';
  const kinds = Object.entries(ONT.kinds).map(([kind, spec]) => {
    const claim = (spec.claim ?? []).map((k) => `"${k}": ...`).join(', ');
    return `  ${kind}  { ${claim} }`;
  }).join('\n');
  return '\n\n---\nIf you cannot finish, or you find that this item needs work the graph does not have ' +
    'yet, you may propose it. A proposal is a CLAIM OF A DECLARED KIND, never a sentence, or the ' +
    'engine drops it. The kinds are:\n\n' + kinds + '\n\nPut them in ' + REPORT + ' as "work": ' +
    '[{ "id": <a short handle of your own>, "kind": <one of the above>, "claim": { ... }, ' +
    '"evidence": { "why": ..., "searched": ... } }], and "edges": [{ "from": ..., "to": ..., "why": ... }] ' +
    'where the ends are your own handles or ids already in the graph. Name each declaration the way ' +
    'the library would name it, in its namespace and convention, so that two attempts finding the ' +
    'same thing collide into one task instead of building it twice. An edge whose end names nothing ' +
    'the graph knows is dropped, so every id you use in an edge must be one you also declared in ' +
    '"work" or one that already exists. This is optional: propose nothing if you finished the work.';
}

function spawnAttempt(w, kind = nextKind(w.id), judging = null) {
  const effortParams = (params) => params ? { ...params, ...(effectiveEffort(params) === undefined ? {} : { effort: effectiveEffort(params) }) } : {};
  // A map attempt derives from the item's last map attempt and a prove from its last prove, and
  // `params.attempt` counts the same way. A failed map does not use up a prove, and the other way
  // round, because they are budgeted apart. A verify attempt derives from nothing: it is filed
  // under the item, says which attempt it judges in `judges`, and counts against no budget of
  // the item's, because it is the judge's session and not the item's.
  const prior = kind === 'map' ? mapAttemptsOf(w.id) : kind === 'verify' ? [] : proveAttemptsOf(w.id);
  const from = prior.length ? prior[prior.length - 1].id : null;
  const n = ++seq;
  const a = {
    id: `a-${String(n).padStart(4, '0')}`,
    of: w.id,
    kind,
    ...(judging ? { judges: judging.id } : {}),
    what: whatFor(w, kind, judging),
    from,
    state: 'running',
    params: {
      ...effortParams(g.defaults), ...effortParams(w.params),
      ...(kind === 'map' ? effortParams(g.mapping.params) : {}),
      ...(kind === 'verify' ? effortParams(g.judge.params) : {}),
      ...(w.params?.agent !== undefined ? { agent: w.params.agent } : {}),
      attempt: prior.length + 1,
    },
    sandbox: assign(n),
    started: null,
    ended: null,
    // Wall-clock beside the logical clock. `t+0` orders attempts against each other and cannot
    // say that this one has been running for eleven minutes, which is the question an operator
    // watching a cell actually has.
    started_at: null,
    ended_at: null,
    result: null,
    ...(MESSAGING ? { messaging: { sent: 0, read: 0, mailbox: MAILBOX } } : {}),
  };
  const selected = resolveAttempt(a.params, g.execution?.provider ?? 'claude',
    EXEC ? { provider: identifyExecutor(EXEC).provider, command: EXEC } : null,
    dirname(fileURLToPath(import.meta.url)), g.execution?.command);
  a.params.agent = selected.agent;
  if (selected.model != null) a.params.model = selected.model;
  if (selected.effort != null) a.params.effort = selected.effort;
  g.attempts.push(a);
  return a;
}

/* --------------------------------------------------------------- handback */

// The ontology, when the board declares one. Claims are read against it in lib/claims.mjs and
// absorbed in lib/handback.mjs; the rulebook itself is documented at load, above.
let ONT = g.ontology ?? null;

// Re-read the board under ownership. Load happened before the claim, and a writer that
// finished in between is in the file but not in memory; deciding or checkpointing the
// snapshot would write it back over their work. Refresh in place: the bound predicates
// read `g` live so they stay correct, and only the snapshots are rebuilt -- the work
// index, the ontology binding, and the --model defaults (re-applied after, with what
// the file carries re-captured for the write). The id counters are the caller's: only
// a run mints attempt and edge ids.
function refreshBoard() {
  let fresh;
  try { fresh = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    removeLock(LOCKFILE);
    console.error(`  ${file} changed while this command waited for the lock and no longer reads: ` +
                  `${String(e.message).split('\n')[0]}. Nothing written.\n`);
    process.exit(1);
  }
  for (const k of Object.keys(g)) delete g[k];
  Object.assign(g, fresh);
  g.attempts ??= [];
  g.edges ??= [];
  g.concurrency ??= 3;
  g.max_attempts ??= 3;
  if (g.mapping != null) g.mapping.max_attempts ??= 1;
  SAVED_DEFAULTS = g.defaults;
  if (flag('--model')) g.defaults = { ...(g.defaults ?? {}), model: arg('--model', null) };
  if (flag('--effort')) g.defaults = { ...(g.defaults ?? {}), effort: arg('--effort', null) };
  work.clear();
  for (const w of g.work) work.set(w.id, w);
  ONT = g.ontology ?? null;
  reopenStale();
}




/* ------------------------------------------------------------ environment */

// The environment an executor runs in is REPLACED, not extended, so a DATABASE_URL or PORT in
// the shell that launched the runner cannot reach an agent. That rule stays.
//
// But the allowlist was `PATH` and `HOME` alone, and that is too narrow to run anything real.
// `claude` keeps its credentials in the macOS Keychain and resolves whose keychain to open from
// `USER`; without it, it cannot find them and reports `Not logged in · Please run /login`, which
// reads like a logout and is a lookup failure. Three agents died on it in one run and the
// ledger recorded `exit 1` three times.
//
// Isolated one variable at a time against `claude -p`:
//
//   PATH HOME                 Not logged in
//   PATH HOME LOGNAME         Not logged in
//   PATH HOME USER            ok
//
// `SHELL` and `TMPDIR` are here because the executor is run through a shell and agents write
// temporary files; neither carries pursuit state. Anything else an executor needs is named by
// the graph in `sandbox.env_passthrough`, so the next person to hit this has a documented way
// through instead of editing the runner.
function cellEnv(cell, agent) {
  return { ...cellEnvironment(g.sandbox?.env_passthrough ?? [], process.env, agent), ...cell.env };
}

/* -------------------------------------------------------------- executing */

async function runAttempt(a) {
  // A dry run must provision nothing, even when the board has a sandbox.
  if (DRY) {
    // A simulated map lands, so the walk shows the maps and then the proves behind them.
    if (kindOf(a) === 'map') return { ok: true, why: 'simulated map', report: { map: { settles: 'simulated', cost: 'unknown' } } };
    // A simulated judge passes everything, so the walk shows where verify attempts fall.
    if (kindOf(a) === 'verify') {
      const src = g.attempts.find((x) => x.id === a.judges);
      return { ok: true, why: 'simulated verdicts', report: { verdicts: (src?.result?.found ?? []).map((id) => ({ id, ok: true, why: 'simulated' })) } };
    }
    const first = a.params.attempt === 1;
    return { ok: !first, why: first ? 'simulated failure' : 'simulated pass' };
  }

  if (!g.sandbox) return { ok: false, why: 'no sandbox configured; refusing to run unisolated' };

  let cell, portLease;
  try {
    if (g.sandbox.port_base === 'auto') {
      portLease = await reservePort();
      a.sandbox.port = portLease.port;
    }
    // From a done prove. A done map attempt has no commits, so basing on it would hand over
    // nothing and the branch would say the dependency landed when only its map did.
    const upstream = needsOf(a.of)
      .map((n) => proveAttemptsOf(n).find((x) => x.state === 'done'))
      .filter(Boolean)
      .map((x) => x.sandbox.branch);
    // Conflicts matter to a person; worktree paths do not.
    const log = (m) => (/conflict|blocked behind/.test(m) ? console.log : plumb)(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`);
    // Start from the trunk, not from the graph base: everything finished so far is in it, so a
    // cell sees siblings it has no edge to as well as the parents it does.
    const base = ensureTrunk(g.sandbox, g.graph, log);
    const itemCheck = kindOf(a) === 'prove' ? checkOf(work.get(a.of)) : null;
    const selected = resolveAttempt(a.params, g.execution?.provider ?? 'claude',
      EXEC ? { provider: identifyExecutor(EXEC).provider, command: EXEC } : null,
      dirname(fileURLToPath(import.meta.url)), g.execution?.command);
    // Commits carry the agent's name. A custom executor is named after its script (fake.sh commits as fake).
    const agent = selected.agent === 'custom'
      ? basename(identifyExecutor(selected.command).executable ?? 'custom').replace(/\.[^.]+$/, '') : selected.agent;
    cell = provision(a, { ...g.sandbox, base, agent, ...(itemCheck ? { itemCheck } : {}),
      ...(MAILBOX ? { messaging: { mailbox: MAILBOX, board: MAIL_VIEW, bin: join(dirname(fileURLToPath(import.meta.url)), 'bin'), peers: peersOf(a),
        ...(!['claude', 'codex'].includes(agent) ? { relay: MAIL_RELAY } : {}) } } : {}) }, log, upstream);
    // Record what this attempt inherited before the executor can commit. The
    // board's pinned base predates the shared trunk and cannot attribute a diff.
    a.sandbox.start_commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'],
      { cwd: cell.path, encoding: 'utf8' }).trim();
    // A merge left for the agent is not represented by HEAD alone. Exclude such
    // starts from commit-diff attribution instead of crediting inherited work.
    if (cell.made.conflicts?.length) a.sandbox.start_conflicts = cell.made.conflicts;
    checkpoint();
  } catch (e) {
    if (portLease) await portLease.release();
    return { ok: false, why: `provision failed: ${String(e.message).split('\n')[0]}` };
  }

  // An attempt bases on its upstream's branch, so a report the upstream committed arrives here
  // as content. Clear it: a report in this cell must be this attempt's or there is none.
  rmSync(join(cell.path, REPORT), { force: true });
  rmSync(join(cell.path, USAGE), { force: true });
  rmSync(join(cell.path, WORK), { force: true });
  rmSync(join(cell.path, VERIFY), { force: true });

  // A verify attempt is handed the handback it judges, verbatim, and the item it was for. It
  // gets a cell like any attempt because judging a claimed blocker means looking: grep the
  // library for the lemma the wall says is missing, read the file the task says to change. It
  // commits nothing.
  if (kindOf(a) === 'verify') {
    const src = g.attempts.find((x) => x.id === a.judges);
    mkdirSync(join(cell.path, '.ostoyae'), { recursive: true });
    writeFileSync(join(cell.path, VERIFY), JSON.stringify({
      judging: src.id, kind: kindOf(src), state: src.state, of: src.of,
      item: { id: a.of, label: work.get(a.of)?.label ?? null, what: work.get(a.of)?.what ?? '' },
      wall: src.result?.wall ?? null, map: src.result?.map ?? null,
      proposals: proposalsOf(src).map((x) => isEdgeId(x.id)
        ? { id: x.id, kind: 'edge', from: x.from, to: x.to, why: x.why ?? '', from_what: work.get(x.from)?.what ?? '', to_what: work.get(x.to)?.what ?? '' }
        : { id: x.id, kind: 'work', what: x.what ?? '',
            ...(x.claim ? { claim_kind: x.kind, claim: x.claim, evidence: x.evidence ?? {} } : {}) }),
    }, null, 2) + '\n');
  }

  // A map attempt is asked what the item needs and what it unlocks, and both ends of an edge have
  // to name work the graph knows. So it is handed the graph's work, every item not rejected, with
  // whether each is mapped, in a file beside the report. Only a map attempt gets it, and a map
  // attempt commits nothing, so it never lands on a branch.
  if (kindOf(a) === 'map') {
    mkdirSync(join(cell.path, '.ostoyae'), { recursive: true });
    writeFileSync(join(cell.path, WORK), JSON.stringify({
      mapping: a.of,
      items: g.work.filter((w) => statusOf(w) !== 'rejected').map((w) => ({
        id: w.id, label: w.label ?? null, what: w.what ?? '', status: statusOf(w), mapped: hasMap(w.id),
      })),
    }, null, 2) + '\n');
  }

  let pendingCell = false;
  try {
    const selected = resolveAttempt(a.params, g.execution?.provider ?? 'claude',
      EXEC ? { provider: identifyExecutor(EXEC).provider, command: EXEC } : null,
      dirname(fileURLToPath(import.meta.url)), g.execution?.command);
    if (portLease) await portLease.activate();
    if (MAILBOX) startCursor(MAILBOX, a.id);

    const exec = await new Promise((res) => {
      // Output to a file and the cell in its own process group, so the cell outlives a runner
      // that is killed (see `cellLogOf` and `sweep`). The runner tails the file for the live view.
      const logPath = cellLogOf(a);
      let fd = 'pipe';
      if (logPath) { mkdirSync(dirname(logPath), { recursive: true }); fd = openSync(logPath, 'a'); }
      const p = spawn(selected.command, {
        shell: true,
        cwd: cell.path,
        env: cellEnv(cell, selected.agent),
        stdio: ['pipe', fd, fd],
        detached: !!logPath,
      });
      // The cell's pid, on the record FIRST, before anything slow. A runner killed between the
      // spawn and the checkpoint leaves a live agent nobody owns -- the sweep cannot adopt a
      // cell it has no pid for -- and the identity bookkeeping below spawns subprocesses.
      // This checkpoint narrows that window to the write itself; the one below records the rest.
      a.cell_pid = p.pid;
      checkpoint();
      a.cell_identity = captureIdentity(p.pid, { cwd: cell.path });
      if (fd !== 'pipe') closeSync(fd);
      // An executor's last words are the only explanation a failed attempt ever gets. Streamed
      // through so a live run is still readable, and kept so `exit 1` is not the whole record.
      // Three agents once died on `Not logged in` and the ledger said `exit 1` three times.
      const tail = [];
      const entry = live[a.id] = { of: a.of, kind: kindOf(a), started: today(), lines: [], tentative: null };
      let atLineStart = true;
      const keep = (buf, out) => {
        if (!HUMAN) out.write(buf);
        else {
          // Agent chatter sits under its own events, indented and quiet.
          let text = String(buf).replace(/\n(?=.)/g, '\n' + ' '.repeat(19));
          if (atLineStart) text = ' '.repeat(19) + text;
          atLineStart = text.endsWith('\n');
          out.write(T.color ? `\x1b[2m${text}\x1b[0m` : text);
        }
        for (const line of String(buf).split('\n')) if (line.trim()) {
          tail.push(line.trim());
          entry.lines.push(line.trim());
        }
        while (tail.length > 12) tail.shift();
        while (entry.lines.length > 60) entry.lines.shift();
      };
      let seen = 0;
      const drain = () => {
        if (!logPath) return;
        try {
          const size = statSync(logPath).size;
          if (size <= seen) return;
          const h = openSync(logPath, 'r');
          try {
            const buf = Buffer.alloc(size - seen);
            const n = readSync(h, buf, 0, buf.length, seen);
            seen += n;
            keep(buf.subarray(0, n), process.stdout);
          } finally { closeSync(h); }
        } catch { /* not there yet */ }
      };
      if (!logPath) {
        p.stdout.on('data', (b) => keep(b, process.stdout));
        p.stderr.on('data', (b) => keep(b, process.stderr));
      }
      // An executor that dies before reading its attempt closes the pipe under this write. That
      // is the executor's failure, recorded through `close` like any other, not the runner's.
      p.stdin.on('error', () => {});
      p.stdin.end(JSON.stringify(a));
      if (logPath && p.pid) a.cell_group = { pgid: p.pid, leader: a.cell_identity,
        members: a.cell_identity ? [a.cell_identity] : [] };
      rememberCellGroup(g, a);
      checkpoint();
      // Every two seconds: what the agent has said, and whatever it has written into its
      // handback so far, half-finished or not. A report that does not parse yet is just "not
      // yet"; the runner reads the finished one at settle.
      const watch = setInterval(() => {
        drain();
        if (rememberCellGroup(g, a)) checkpoint();
        try {
          const rp = join(cell.path, REPORT);
          if (existsSync(rp)) { try { entry.tentative = JSON.parse(readFileSync(rp, 'utf8')); } catch { /* being written */ } }
        } catch { /* cell gone */ }
        publishLive();
      }, 2000);
      let finishing = false;
      const done = async (r) => {
        if (finishing) return;
        finishing = true;
        clearInterval(watch);
        const until = Date.now() + 3000;
        while (cellAlive(a.cell_pid, cell.path, a.cell_identity, a.cell_group) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (cellAlive(a.cell_pid, cell.path, a.cell_identity, a.cell_group)) {
          a.cell_exit = { at: today(), why: r.why };
          a.cell_wait = { at: today(), why: 'executor leader exited, but child processes are still alive or unverified' };
          r = { ...r, pending: true, why: a.cell_wait.why };
          checkpoint();
        }
        drain(); delete live[a.id]; publishLive(); res(r);
      };
      p.on('close', (code) => done(hardStop
        ? { ok: false, why: 'stopped by the operator: the cell was killed by `ostoyae stop --now`', tail }
        : { ok: code === 0, why: `exit ${code}`, tail }));
      p.on('error', (e) => done({ ok: false, why: e.message, tail }));
    });

    if (exec.pending) { pendingCell = true; return exec; }

    // The check, when the work item declares one. Run by the engine, in the cell, after a prove
    // attempt's executor exits zero, and its exit code decides `done` against the agent's word.
    const handback = readReport(cell.path);
    // Skip the check after a plan-window stop; the agent did not work on the item.
    if (!exec.ok && (exec.tail ?? []).some((l) => LIMIT_RE.test(String(l)))) {
      return { ...exec, report: handback, usage: usageFor(a, cell.path) };
    }
    // Run the check even when an agent exits nonzero: it may have found the requested state already true.
    if (kindOf(a) === 'prove' && checkOf(work.get(a.of)) && !handback?.wall) {
      const cmd = checkOf(work.get(a.of));
      // Serialize checks across the run because simultaneous checks can contend over shared resources.
      const my = checkTurn.then(() => runCheck(cmd, cell, a));
      checkTurn = my.catch(() => {});
      const c = await my;
      HUMAN ? event(a.id, 'check', `${pad(a.of, COL)} ${c.code === 0 ? T.paint('32', 'passed') : T.paint('31', `FAILED, exit ${c.code}`)}  ${T.dim(cmd)}`)
        : console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} ${c.code === 0 ? 'passed' : `FAILED, exit ${c.code}`}  ${cmd}  (on ${c.on})`);
      if (c.code !== 0) {
        return { ok: false, why: `check failed (exit ${c.code}): ${cmd}`, tail: c.tail,
                 check: { ok: false, cmd, on: c.on }, report: handback, usage: usageFor(a, cell.path) };
      }
      // Passed. If the executor had said no, say whose word this is: the record should not read
      // as though the agent claimed a success it did not claim.
      if (!exec.ok) {
        exec.why = `${exec.why}, but the check passed: ${cmd}`;
        console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} the executor exited non-zero and the check decides: done`);
      }
      exec.ok = true;
      exec.check = { ok: true, cmd, on: c.on };
    }

    // Read the handback while the cell still stands. The environment is disposable, the record
    // is not, and this is the part of the cell worth keeping.
    return { ...exec, report: handback, usage: usageFor(a, cell.path) };
  } finally {
    if (portLease && !pendingCell) await portLease.release();
    if (!pendingCell) snapshotEnd(a, cell.path);
    // Keep a cell killed by `stop --now` so its partial work can be inspected.
    if (!KEEP && !hardStop && !pendingCell) {
      try { teardown(cell.made, g.sandbox, (m) => plumb(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`)); }
      catch (e) { console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} teardown failed: ${e.message}`); }
    }
  }
}

function snapshotEnd(a, path) {
  try {
    a.sandbox.end_commit = execFileSync('git', ['rev-parse', '--verify', `${a.sandbox.branch}^{commit}`],
      { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    a.sandbox.snapshot_error = `cannot resolve final branch: ${String(error.message).split('\n')[0]}`;
  }
}

/* ------------------------------------------------------------------- loop */

// The map is the result of a map attempt, the way a commit is the result of a prove. It is
// recorded on the attempt as handed back, and on the work item with who wrote it, when, and what
// it needs and unlocks. Those two are read off the edges this attempt proposed or was added to
// as a finder, into the item and out of it, and never off the prose. Anything odd in the map is
// noted rather than repaired: a missing cost stays missing, a cost outside the four words stays
// as written, and a key the shape does not have is dropped. Returns whether the map landed.
const COSTS = ['small', 'medium', 'large', 'unknown'];
function settleMap(a, w, rep, ok, notes) {
  const m = rep && !rep._bad ? rep.map : undefined;
  if (!m || typeof m !== 'object' || Array.isArray(m)) { notes.push('handed back no map'); return false; }
  if (typeof m.settles !== 'string' || !m.settles.trim()) { notes.push('map has no settles'); return false; }
  if (!ok) { notes.push('handed back a map but exited non-zero, map not recorded'); return false; }
  const map = { settles: m.settles, cost: m.cost ?? null, notes: m.notes ?? null };
  if (m.cost == null) notes.push('map has no cost, recorded as null');
  else if (!COSTS.includes(m.cost)) notes.push(`map cost "${m.cost}" is not one of ${COSTS.join(', ')}, kept as written`);
  for (const k of Object.keys(m)) if (!['settles', 'cost', 'notes'].includes(k)) notes.push(`map key ${k} dropped`);
  const mine = g.edges.filter((e) => (e.found_by ?? []).includes(a.id));
  a.result.map = map;
  w.map = {
    by: a.id, at: a.ended_at, ...map,
    needs: mine.filter((e) => e.to === w.id).map((e) => e.from),
    unlocks: mine.filter((e) => e.from === w.id).map((e) => e.to),
  };
  return true;
}

// Verify verdicts annotate proposals; they never confirm them by themselves.
function settleVerify(a, rep, ok, notes) {
  const vs = rep && !rep._bad ? rep.verdicts : undefined;
  if (!Array.isArray(vs)) { notes.push('handed back no verdicts'); return false; }
  if (!ok) { notes.push('handed back verdicts but exited non-zero, not recorded'); return false; }
  const src = g.attempts.find((x) => x.id === a.judges);
  const mine = new Set([...(src?.result?.found ?? []), ...(src?.result?.wall ? [src.id] : [])]);
  const landed = [];
  for (const v of vs) {
    if (!v?.id || !mine.has(v.id)) { notes.push(`verdict on ${v?.id ?? '(no id)'}, which ${a.judges} did not propose, dropped`); continue; }
    const verdict = { by: a.id, ok: v.ok === true, why: typeof v.why === 'string' ? v.why : '', at: a.ended_at };
    if (v.id === src.id) src.result.wall_verdict = verdict;
    else lookup(v.id).verdict = verdict;
    landed.push({ id: v.id, ok: verdict.ok, why: verdict.why });
  }
  for (const id of mine) if (!landed.some((v) => v.id === id)) notes.push(`no verdict on ${id}, left unjudged`);
  a.result.verdicts = landed;
  return landed.length > 0;
}

// The same settle, told to a person. The walled-and-found moment is the product, so it gets the
// only accent on the screen; everything else is quiet.
function tellPerson(a, w, r, found, notes) {
  widen();
  const kind = kindOf(a), done = a.state === 'done';
  const label = done && kind === 'map' ? 'planned' : done && kind === 'verify' ? 'judged' : a.state;
  const why = done ? (kind === 'verify' ? `what ${a.judges} found` : kind === 'map' ? '' : a.result.check ? 'check passed' : String(r.why).replace(/^exit 0$/, 'finished'))
    : a.result.wall ? `blocked: ${a.result.wall}` : r.why;
  event(a.id, label, `${pad(w.id, COL)} ${a.state === 'walled' ? T.accent(why) : done ? T.dim(why) : why}` +
    `${a.result.ahead ? T.dim(`  ahead: ${a.result.ahead}`) : ''}${typeof a.result.answer === 'boolean' ? `  answer: ${a.result.answer}` : ''}` +
    `${a.result.limited ? '  stopped by the plan window' : ''}`);
  const gap = `  ${pad('', 8)} `;
  const name = (id) => { const x = lookup(id); return x && isEdgeId(id) ? `${x.from} → ${x.to}` : id; };
  for (const v of a.result.verdicts ?? []) console.log(`${gap}${T.paint(v.ok ? '32' : '31', pad(v.ok ? 'yes' : 'no', 7))} ${pad(name(v.id), COL)} ${T.dim(v.why)}`);
  for (const line of a.result.output ?? []) console.log(`${gap}${pad('', 7)} ${T.dim(line)}`);
  if (a.result.map) {
    const m = w.map;
    console.log(`${gap}${pad('', 7)} ${T.dim(`plan: ${m.settles}${m.needs.length ? `; needs ${m.needs.join(', ')}` : ''}`)}`);
  }
  for (const id of found) {
    const x = lookup(id);
    console.log(isEdgeId(id)
      ? `${gap}${T.accent(pad('+ link', 7))} ${pad(`${x.from} → ${x.to}`, COL)} ${T.dim(`proposed${x.why ? `: ${x.why}` : ''}`)}`
      : `${gap}${T.paint('1;38;5;179', pad('+ job', 7))} ${T.paint('1', pad(x.id, COL))} ${x.what} ${T.dim('(proposed)')}`);
  }
  for (const n of notes) if (!/done on the agent's word/.test(n) || !a.result.check) console.log(`${gap}${pad('', 7)} ${T.dim(n)}`);
}

function settle(a, w, r) {
  if (r.pending) {
    stopping ??= 'executor child processes still alive or unverified';
    console.log(`  ${pad(a.id, 8)} ${pad('INCOMPLETE', 7)} ${r.why}; attempt stays running and its worktree is preserved`);
    checkpoint();
    return;
  }
  a.ended = `t+${++clock}`;
  a.ended_at = today();
  a.result = { why: r.why };

  const rep = r.report;
  if (rep?._bad) a.result.note = `handback unreadable: ${rep._bad}`;
  // Recorded on every attempt that reported it, whatever the outcome: a failed attempt cost
  // money too, and a wall's cost is part of what it found.
  if (r.usage && !r.usage._bad) a.result.usage = r.usage;
  else if (r.usage?._bad) a.result.usage = { _bad: r.usage._bad,
    ...(r.usage.executor === 'codex' ? { executor: 'codex', cost_usd: null } : {}) };
  // Whether the engine verified the work, on the record beside the outcome. Absent means the
  // item declared no check, which is how every graph behaved before checks existed.
  if (r.check) a.result.check = r.check;

  // What the executor said before it died. Kept only when there is no wall to explain the
  // outcome, because a walled attempt already said what stopped it in its own words and this
  // would just be noise beside it.
  if (!r.ok && !rep?.wall && r.tail?.length) a.result.output = r.tail.slice(-6);

  let found = [], notes = [];
  // A verify attempt proposes nothing: its handback is verdicts, and a judge that could add
  // tasks to the graph would be a second mapper with a different prompt.
  if (rep && !rep._bad && kindOf(a) !== 'verify') ({ found, notes } = absorb(rep, a));

  // The plan window, when it is what stopped the agent. Recorded beside the outcome, and the run
  // stops launching (see main): the next launch would meet the same window.
  if (!r.ok && (r.tail ?? []).some((l) => LIMIT_RE.test(l))) { a.result.limited = true; limitHit = a.id; }

  if (rep?.wall) a.result.wall = rep.wall;
  // `ahead` is the other half of `wall`: a finding about the NEXT attempt, from one that
  // finished its own job. It is recorded and it deliberately does not touch the state.
  if (rep?.ahead) a.result.ahead = rep.ahead;
  // `answer` is the handback of a question: the attempt settled the statement, and this is which
  // way. `true` is a proof, `false` is a refutation, and a refutation is finished work, not a
  // wall: the counterexample is in the branch and it merges like any proof. Recorded on every
  // attempt that said it, whatever the outcome; applied to the item further down, and only by a
  // done attempt, because one that did not finish settled nothing. Anything but a boolean is a
  // note and not an answer: "probably false" is not something the graph can stand on.
  if (rep && !rep._bad && 'answer' in rep && kindOf(a) !== 'verify') {
    if (typeof rep.answer === 'boolean') a.result.answer = rep.answer;
    else notes.push(`answer is ${JSON.stringify(rep.answer)}, not true or false: not recorded`);
  }
  if (found.length) a.result.found = found;

  // An attempt that hit a wall and produced structure did not do its work, and did not waste the
  // launch either. It gets its own state so the record can say which of the two happened.
  const restated = !!rep?.wall && kindOf(a) !== 'verify' && wallNamesNothing(rep.wall, w);
  if (restated) notes.push('wall names nothing beyond the task itself, recorded as failed');

  if (kindOf(a) === 'verify') {
    a.state = settleVerify(a, rep, r.ok, notes) ? 'done' : 'failed';
  } else if (rep?.wall && found.length && !restated) {
    a.state = 'walled';
    // Retain a map handed back with a wall; its dependencies still need review.
    if (rep.map != null) {
      if (kindOf(a) === 'map') settleMap(a, w, rep, r.ok, notes);
      else notes.push('map handed back by a prove attempt, ignored');
    }
  } else if (kindOf(a) === 'map') {
    a.state = restated ? 'failed' : (settleMap(a, w, rep, r.ok, notes) ? 'done' : 'failed');
  } else {
    a.state = r.ok && !restated ? 'done' : 'failed';
    if (rep?.map != null) notes.push('map handed back by a prove attempt, ignored');
    // Done on the agent's word, and the record says so. This is the `claimed` of the verification
    // brief, kept inside the three-state vocabulary: the state is `done`, and `result.check` is
    // absent, which every reader can see. A graph that wants none of these declares `check`s or
    // a `judge.default_check`, and doctor refuses one that asks for that and has a gap.
    if (a.state === 'done' && !a.result.check) {
      const declared = DRY && kindOf(a) === 'prove' ? checkOf(w) : null;
      if (declared) {
        a.result.checkDeclared = declared;
        notes.push(`dry run: check declared, not run: ${declared}`);
      } else {
        notes.push('done on the agent\'s word: no check declared');
      }
    }
  }
  // Apply an answer only from a done attempt, so an unfinished refutation cannot settle a statement.
  if (typeof a.result.answer === 'boolean' && kindOf(a) === 'prove') {
    if (a.state === 'done') {
      w.answer = a.result.answer; w.answered_by = a.id; w.answered_at = today();
      notes.push(a.result.answer ? 'answered: true' : 'answered: false, a refutation; whatever needed this true is blocked');
    } else {
      notes.push(`answer ${a.result.answer} on an attempt that did not finish: recorded, not applied`);
    }
  }
  // Accumulation, the half of this repo's job that gating alone never did. Only a done prove
  // attempt merges: a map commits nothing, and a walled or failed one did not finish, so
  // neither belongs in the branch that says what this graph has actually built.
  if (a.state === 'done' && kindOf(a) !== 'map' && g.sandbox && !DRY) {
    try {
      const r = integrate(g.sandbox, g.graph, a.sandbox.branch,
                          (m) => (/conflict|abandoned/.test(m) ? console.log : plumb)(`  ${pad(a.id, 8)} ${pad('trunk', 7)} ${m}`));
      if (r.ok) a.result.integrated = trunkOf(g.graph);
      // A conflict is recorded on the attempt and said out loud. It is not a failure of this
      // attempt, which finished: it is two finished jobs owning one file, and only a person
      // can say which one is right.
      else { a.result.conflict = r.paths; notes.push(`trunk merge conflicted on ${r.paths.join(', ')}`); }
    } catch (e) {
      notes.push(`trunk merge could not run: ${String(e.message).split('\n')[0]}`);
    }
  }

  if (notes.length) a.result.notes = notes;

  if (HUMAN) { tellPerson(a, w, r, found, notes); checkpoint(); beat(); return; }
  console.log(`  ${pad(a.id, 8)} ${pad(a.state, 7)} ${pad(w.id, 14)} ${r.why}${a.result.wall ? `, wall: ${a.result.wall}` : ''}` +
              `${a.result.ahead ? `, ahead: ${a.result.ahead}` : ''}${typeof a.result.answer === 'boolean' ? `, answer: ${a.result.answer}` : ''}` +
              `${a.result.limited ? ', stopped by the plan window' : ''}` +
              `${a.judges ? `, judged ${a.judges}` : ''}`);
  for (const v of a.result.verdicts ?? []) console.log(`  ${pad('', 8)} ${pad('verdict', 7)} ${pad(v.id, 8)} ${v.ok ? 'ok' : 'NO'}  ${v.why}`);
  // `exit 1` on its own tells an operator nothing. Say what the executor said.
  for (const line of a.result.output ?? []) console.log(`  ${pad('', 8)} ${pad('said', 7)} ${line}`);
  if (a.result.map) {
    const m = w.map;
    const links = [m.needs.length ? `needs ${m.needs.join(', ')}` : '', m.unlocks.length ? `unlocks ${m.unlocks.join(', ')}` : ''].filter(Boolean);
    console.log(`  ${pad('', 8)} ${pad('map', 7)} settles: ${m.settles}; cost: ${m.cost ?? 'not given'}` +
                `${m.notes ? `; notes: ${m.notes}` : ''}${links.length ? `; ${links.join('; ')}` : ''}`);
  }
  for (const id of found) {
    const x = lookup(id);
    const what = isEdgeId(id) ? `edge  ${x.from} blocks ${x.to}${x.why ? `  (${x.why})` : ''}` : `work  ${x.id}  ${x.what}`;
    console.log(`  ${pad('', 8)} ${pad('found', 7)} ${pad(id, 8)} proposed  ${what}`);
  }
  for (const n of notes) console.log(`  ${pad('', 8)} ${pad('note', 7)} ${n}`);
  checkpoint();
  beat();
}

// `--only` includes the item and its transitive dependencies, leaving unrelated work untouched.
function family(root) {
  const seen = new Set();
  const walk = (id) => { if (seen.has(id)) return; seen.add(id); for (const n of needsOf(id)) walk(n); };
  walk(root);
  return seen;
}
const inFamily = ONLY ? ((w) => family(ONLY).has(w.id)) : (() => true);
if (ONLY && !work.has(ONLY)) {
  console.error(`  ${file}: --only ${ONLY} names no work item in this graph.\n`);
  process.exit(2);
}


// The check queue: a promise chain every check appends to, so checks run one at a time while
// the attempts around them stay concurrent.
let checkTurn = Promise.resolve();
// The check runs on a fresh checkout of the attempt's branch (sandbox.checkTree), never in the
// cell: the cell is the agent's working tree and the branch is what the record and the next
// attempt stand on. `OSTOYAE_TRUNK` and `OSTOYAE_GRAPH` are named so a check can diff the
// branch against what the graph had already built. `on` says where it ran, for the record.

// Compile a statement in its workspace before launching a prover. Syntax and missing imports are gate failures, not proof attempts.
const gateOf = (w) => (ONT && w.kind && ONT.kinds[w.kind]?.gate && w.claim)
  ? fill(ONT.kinds[w.kind].gate, w.claim, `${w.kind}.gate`, { shell: true }) : null;

// The root problem an item ultimately blocks, following edges that are not rejected. Null when
// it reaches nothing, which the gate treats as "cannot tell", not as a failure.
function rootItemOf(id, seen = new Set()) {
  const w = work.get(id);
  if (!w) return null;
  if (!w.claim && !(w.found_by ?? []).length) return id;
  if (seen.has(id)) return null;
  seen.add(id);
  for (const e of g.edges) if (e.from === id && e.status !== 'rejected') {
    const r = rootItemOf(e.to, seen);
    if (r) return r;
  }
  // Do not auto-confirm a route with no path to an open original ticket.
  for (const by of w.found_by ?? []) {
    const a = g.attempts.find((x) => x.id === by);
    if (a?.of && a.of !== id) { const r = rootItemOf(a.of, seen); if (r) return r; }
  }
  return null;
}

const gateHashOf = (w) => w.claim_hash ?? (w.kind && w.claim ? claimHash(w.kind, w.claim) : null);

// Record the trunk used by a gate so a later change does not make the verdict appear current.
function trunkRev() {
  if (!g.sandbox) return null;
  try { return execFileSync('git', ['-C', resolve(g.sandbox.repo), 'rev-parse', trunkOf(g.graph)], { encoding: 'utf8' }).trim().slice(0, 12); }
  catch { return null; }
}

async function runGate(w) {
  const cmd = gateOf(w);
  if (!cmd || !g.sandbox) return null;
  const hash = gateHashOf(w);
  const rev = trunkRev();
  // A pass stands until the statement changes. A refusal also expires when the trunk moves,
  // because what was missing may since have landed.
  if (w.gate && w.gate.hash === hash && (w.gate.ok || w.gate.trunk === rev)) return w.gate;
  const root = rootItemOf(w.id);
  // Create the trunk before the gate, which runs before attempt provisioning.
  try { ensureTrunk(g.sandbox, g.graph, (m) => plumb(`  ${pad('', 8)} ${pad('trunk', 7)} ${m}`)); }
  catch (e) { w.gate = { ok: false, state: 'unknown', at: today(), hash, error: [`no trunk: ${String(e.message).split('\n')[0]}`] }; return w.gate; }
  const cwd = trunkPath(g.sandbox, g.graph);
  const stamp = today();
  const r = await new Promise((res) => {
    const env = { ...cellEnv({ env: {} }), OSTOYAE_TRUNK: trunkOf(g.graph), OSTOYAE_GRAPH: g.graph,
                  OSTOYAE_ITEM: w.id, OSTOYAE_ROOT_ITEM: root ?? '', OSTOYAE_STATEMENT: String(w.claim.statement ?? '') };
    const p = spawn(cmd, { shell: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const keep = (b) => { for (const line of String(b).split('\n')) if (line.trim()) { tail.push(line.trim()); while (tail.length > 8) tail.shift(); } };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    p.on('close', (code) => res({ code, tail }));
    p.on('error', (e) => res({ code: null, tail: [e.message] }));
  });
  // Exit 2 from the gate means it could not judge (no workspace found, nothing built): recorded
  // as unknown and the item stays launchable, because a gate that cannot see is not a no.
  // A gate that did not run (spawn failed, code null) has not said no.
  const state = r.code === 0 ? 'ok' : (r.code === 2 || r.code === null) ? 'unknown' : 'fails';
  w.gate = { ok: state === 'ok', state, at: stamp, hash, trunk: rev, cmd, root: root ?? null,
             ...(state !== 'ok' ? { error: r.tail } : {}) };
  return w.gate;
}

const gateBlocks = (w) => w.gate && w.gate.state === 'fails' && w.gate.hash === gateHashOf(w) && w.gate.trunk === trunkRev();

// --gate: the whole board at once, then write. Refuses beside a live runner like any decision.
async function gateAll() {
  console.log(`\n${g.graph}  gate\n`);
  const items = g.work.filter((w) => statusOf(w) !== 'rejected' && gateOf(w));
  let ok = 0, fails = 0, unknown = 0, skipped = 0;
  const rev = trunkRev();
  for (const w of items) {
    if (w.gate && w.gate.hash === gateHashOf(w) && (w.gate.ok || w.gate.trunk === rev)) { skipped++; continue; }
    const my = checkTurn.then(() => runGate(w));
    checkTurn = my.catch(() => {});
    const r = await my;
    if (!r) { skipped++; continue; }
    if (r.state === 'ok') ok++; else if (r.state === 'fails') fails++; else unknown++;
    console.log(`  ${pad(w.id, 60)} ${pad(r.state, 8)}${r.state === 'fails' ? '  ' + String(r.error?.[0] ?? '').slice(0, 90) : ''}`);
  }
  console.log(`\n  ${ok} elaborate · ${fails} do not · ${unknown} could not be judged · ${skipped} already gated, unchanged`);
  return fails;
}

async function runCheck(cmd, cell, a) {
  const log = (m) => plumb(`  ${pad(a.id, 8)} ${pad('check', 7)} ${m}`);
  let tree;
  try { tree = checkTree(g.sandbox, g.graph, a, log); }
  catch (e) { return { code: null, on: 'no tree', tail: [`could not check out ${a.sandbox.branch}: ${String(e.message).split('\n')[0]}`] }; }
  try {
    return await new Promise((res) => {
      const env = { ...cellEnv(cell), OSTOYAE_TRUNK: trunkOf(g.graph), OSTOYAE_GRAPH: g.graph, OSTOYAE_CHECK_TREE: tree.path };
      const p = spawn(cmd, { shell: true, cwd: tree.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const tail = [];
      const keep = (b) => { for (const line of String(b).split('\n')) if (line.trim()) { tail.push(line.trim()); while (tail.length > 6) tail.shift(); } };
      p.stdout.on('data', keep); p.stderr.on('data', keep);
      p.on('close', (code) => res({ code, on: a.sandbox.branch, tail }));
      p.on('error', (e) => res({ code: null, on: a.sandbox.branch, tail: [e.message] }));
    });
  } finally {
    try { tree.remove(); } catch (e) { log(`check tree not removed: ${e.message}`); }
  }
}

// Set when an attempt is stopped by the plan window. The loop stops launching on it: a run that
// keeps launching into a closed window buys `failed` rows and nothing else.
let limitHit = null;

// How a run ends, for a person: what happened, how much the graph grew, what it cost, what to
// do next. The full ledger is still one `ostoyae status` away and is printed in full to logs.
function tellEnding(drain, boundBy) {
  const active = g.work.filter((w) => statusOf(w) === 'active');
  const done = active.filter((w) => satisfied(w.id)).length;
  const grown = g.work.filter((w) => (w.found_by ?? []).length && statusOf(w) !== 'rejected').length;
  const links = g.edges.filter((e) => (e.found_by ?? []).length && e.status !== 'rejected').length;
  const s = spendSoFar();
  console.log('');
  if (drain?.state === 'board-satisfied') console.log(`  ${T.paint('1;32', 'Done.')} ${done} of ${active.length} jobs passed their checks.`);
  else if (drain) console.log(`  ${T.paint('1', 'Stopped.')} ${drain.why}.`);
  else if (boundBy) console.log(`  ${T.paint('1', 'Stopped at the cap.')} ${done} of ${active.length} jobs done.`);
  if (grown || links) console.log(`  ${T.accent(`The graph grew by ${grown} job${grown === 1 ? '' : 's'} and ${links} link${links === 1 ? '' : 's'}`)} ${T.dim('that agents found on their own.')}`);
  console.log(`  ${T.dim([`${g.attempts.length} agent session${g.attempts.length === 1 ? '' : 's'}`, s.priced && `$${s.usd.toFixed(2)}`, s.output_tokens && `${s.output_tokens} output tokens`].filter(Boolean).join(' · '))}`);
  const pending = [...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed');
  if (pending.length) {
    console.log(`\n  ${T.paint('1', 'Waiting for your yes')}`);
    for (const x of pending) console.log(`  ${T.paint('1;38;5;179', '+')} ${pad(x.id, 10)} ${isEdgeId(x.id) ? `${x.from} → ${x.to}` : x.what}${x.verdict ? T.dim(`  judge: ${x.verdict.ok ? 'yes' : 'no'}`) : ''}`);
    console.log(`  ${T.accent(`ostoyae confirm ${pending.map((x) => x.id).join(',')}`)}  ${T.dim('or reject')}`);
  } else if (drain && drain.state !== 'board-satisfied') console.log(`  ${T.dim(`next: ${drain.next}`)}`);
  const conflicted = g.attempts.filter((a) => a.state === 'done' && (a.result?.conflict ?? []).length && !a.result?.integrated);
  if (conflicted.length) console.log(`  ${T.paint('31', `${conflicted.length} finished job${conflicted.length === 1 ? '' : 's'} could not merge`)}: ${conflicted.map((a) => `${a.of} (${a.result.conflict.join(', ')})`).join(', ')}`);
}

async function main() {
  // The previous run's verdict is not this run's state. Cleared before anything launches so a
  // reader who opens the file mid-run sees no verdict rather than a stale one.
  if (!DRY) delete g.last_run;
  if (HUMAN) console.log(`\n  ${T.paint('1', g.graph)}  ${T.dim([`${g.work.filter((w) => statusOf(w) === 'active').length} jobs`,
    MAX_LAUNCHES && `up to ${MAX_LAUNCHES} sessions`, MAX_USD && `up to $${MAX_USD.toFixed(2)}`, MAX_OUTPUT_TOKENS && `up to ${MAX_OUTPUT_TOKENS} output tokens`,
    MAX_INVOCATIONS && `${MAX_INVOCATIONS - g.attempts.length} of ${MAX_INVOCATIONS} sessions left`, mappingOn() && 'agents plan first',
    ONLY && `only ${ONLY} and what it needs`].filter(Boolean).join('  ·  '))}\n`);
  else console.log(`\n${g.graph}  concurrency ${g.concurrency}  max_attempts ${g.max_attempts}` +
              `${MAX_LAUNCHES ? `  max_launches ${MAX_LAUNCHES}` : ''}` +
              `${MAX_USD ? `  max $${MAX_USD.toFixed(2)}` : ''}` +
              `${MAX_OUTPUT_TOKENS ? `  max ${MAX_OUTPUT_TOKENS} output tokens` : ''}` +
              `${MAX_INVOCATIONS ? `  max_invocations ${MAX_INVOCATIONS} all roles, ${g.attempts.length} already spent` : ''}` +
              `${mappingOn() ? `  mapping on, ${mapMax()} map attempt${mapMax() === 1 ? '' : 's'} per item` : ''}` +
              `${ONLY ? `\n  only ${ONLY} and what it needs: ${family(ONLY).size} item${family(ONLY).size === 1 ? '' : 's'} in its family` : ''}\n`);

  const foreign = blockingRunner();
  if (DRY) {
    if (foreign) console.log(`  note: pid ${foreign.pid} is running this graph now. These numbers ignore it.\n`);
  } else {
    if (foreign) refuseLiveRunner(foreign);
    // Claimed before the first beat. The check above is read-then-act, and a second starter
    // in the same instant reads the same nothing; the claim is atomic, so exactly one of them
    // proceeds. Re-verified after, for a starter from before locks existed beating in the
    // window; a lock-aware starter cannot be there, because it would hold this lock.
    const claim = await claimRunLock(LOCKFILE, { file, identity: RUN_IDENTITY, started: RUN_STARTED, role: 'run' });
    if (!claim.claimed) refuseLiveRunner(claim.holder);
    // Beaten in the same breath as the claim: a pre-lock engine never looks at the lock,
    // so the runfile is the only thing it can see, and any gap between the two is a window
    // where it starts beside us. Its own foreign check then refuses it.
    beat();
    let again = null;
    try { again = foreignRunner(); }
    catch (e) { removeLock(LOCKFILE); removeOwnRunfile(RUNFILE); console.error(`  ${e.message}\n`); process.exit(1); }
    if (again) { removeLock(LOCKFILE); removeOwnRunfile(RUNFILE); refuseLiveRunner(again); }
    // Re-read under ownership: a writer that finished between our load and our claim is in
    // the file now. The id counters restart from the record so a new attempt never re-mints
    // an id -- including against a pre-lock writer the claim could not see.
    refreshBoard();
    MESSAGING = !flag('--no-messaging') && g.messaging !== false;
    if (MESSAGING) messageLimits(g.messaging);
    recoverMessages();
    if (MESSAGING) {
      const mailDir = `${file.replace(/\.json$/, '')}.mail`;
      mkdirSync(mailDir, { recursive: true });
      MAILBOX = join(mailDir, `${Date.now()}-${process.pid}.jsonl`);
      closeSync(openSync(MAILBOX, 'wx'));
      MAIL_VIEW = `${MAILBOX}.peers.json`;
      MAIL_RELAY = mkdtempSync(join(tmpdir(), 'ostoyae-mail-'));
      mailTimer = setInterval(() => serveMailRelay(MAIL_RELAY, MAILBOX, file, messageLimits(g.messaging)), 100);
      mailTimer.unref();
      for (const m of g.messages ?? []) if (m.from === 'ostoyae' && m.overlap) overlapsTold.add(overlapKey(m.to, m.overlap.with, m.overlap.path));
      overlapTimer = setInterval(watchOverlaps, OVERLAP_EVERY_MS);
      overlapTimer.unref();
    }
    seq = g.attempts.length;
    eseq = g.edges.length;
    // Read after claiming: the sweep below only uses it for the log label, so a runfile that
    // became unreadable under us is no reason to stop now that the graph is ours.
    let previous = null;
    try { previous = readRun(); } catch { previous = null; }
    // Two signals, two meanings, and the second is the one that costs money. Once: stop launching
    // and let the cells land, which is free, because an attempt that is nearly done is money
    // already spent. Twice: kill the cells. Three times: leave now and let the next runner sweep.
    // `ostoyae stop` sends the first, `ostoyae stop --now` sends the first two.
    const onSignal = (sig) => {
      if (!stopping) {
        stopping = "the operator's stop";
        console.log(`\n  ${sig}: stopping. Nothing new launches. The ${inFlight()} attempt(s) in flight` +
                    `\n  keep going and are recorded when they land; signal again to kill their cells.\n`);
        return;
      }
      if (!hardStop) {
        hardStop = true;
        const cells = g.attempts.filter((a) => a.state === 'running' && a.cell_pid);
        console.log(`\n  ${sig} again: killing ${cells.length} cell(s). Their branches keep whatever they` +
                    `\n  committed, and the cells are left standing rather than torn down.\n`);
        for (const a of cells) {
          console.log(killCell(a)
            ? `  ${pad(a.id, 8)} ${pad('signal', 7)} pid ${a.cell_pid}`
            : `  ${pad(a.id, 8)} ${pad('kill', 7)} FAILED on pid ${a.cell_pid}`);
        }
        return;
      }
      console.log(`\n  ${sig} a third time: leaving. Unsettled attempts stay running and the next runner sweeps them.\n`);
      process.exit(1);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    // Adoption can wait for minutes. Own the runfile and accept stop signals throughout it,
    // not only after it: otherwise a second runner can adopt the same cells concurrently.
    beat();
    // unref so a heartbeat can never be the reason the process stays up. The run keeps itself
    // alive; when it stops, this stops with it. Held onto so the end of the run can stop it
    // before deleting the file: an unref'd timer still fires while the process is finishing, and
    // a beat landing after the rm writes the runfile back. The next runner then reads a heartbeat
    // for a pid that exited cleanly, calls it a death and sweeps for orphans that never existed.
    heart = setInterval(beat, 2000);
    heart.unref();
    await sweep(previous);
  }

  const live = new Set();
  const track = (p) => { const w = p.finally(() => live.delete(w)); live.add(w); return w; };

  // Named when a budget binds, so the run can say which one, and so the summary does not have to
  // guess. Null means it ran out of work rather than out of money.
  let stoppedBy = null;

  // Freeze the destinations for this invocation. Newly accepted work cannot
  // authorize unrelated expansion, and --only remains the scope boundary.
  const autoTargets = new Set(g.work.filter((w) => statusOf(w) === 'active' &&
    !satisfied(w.id) && !refuted(w.id) && inFamily(w)).map((w) => w.id));

  for (;;) {
    if (AUTO_ADVANCE && !stopping && !overBudget() && !limitHit &&
        !(MAX_LAUNCHES && launched >= MAX_LAUNCHES)) {
      const was = new Set([...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed').map((x) => x.id));
      const confirmed = confirmScoped(autoTargets);
      if (confirmed) {
        const grew = [...g.work, ...g.edges].filter((x) => was.has(x.id) && statusOf(x) !== 'proposed');
        const jobs = grew.filter((x) => !isEdgeId(x.id)), links = grew.filter((x) => isEdgeId(x.id));
        console.log(HUMAN ? (jobs.length ? `\n  ${T.paint('1;38;5;179', '▲ The graph grew.')}  ` : `\n  ${T.accent('New link.')}  `) + [
            jobs.length && `new job ${jobs.map((x) => T.paint('1', x.id)).join(', ')}`,
            links.length && links.map((e) => `${e.to} now waits for ${e.from}`).join(', '),
          ].filter(Boolean).join('; ') + T.dim('  (approved by the judge)') + '\n'
          : `  auto-advance: ${confirmed} judged, scoped proposal(s) confirmed`);
        checkpoint();
      }
    }
    // The judge goes first. A handback that proposed something is a claim about the graph, and
    // the cheapest thing to do with a claim is to read it before anything is spent on it. Verify
    // attempts take a seat in `concurrency` and count against the money and token budgets, and
    // not against `--max-launches`, which counts work.
    for (const src of pendingVerify()) {
      if (stopping) break;
      if (inFlight() >= g.concurrency || limitHit) break;
      // A verify attempt is an agent session and is charged as one. It stays outside
      // `--max-launches` on purpose -- that flag counts work, and an evaluation matched on work
      // must not have its arms moved by how often the judge ran -- but `--max-invocations` is
      // the all-role allowance and a judge that could run for free under it would make it a
      // fiction. `overBudget()` charges it because the allowance is checked in there.
      const judgeBound = overBudget();
      if (judgeBound) { stoppedBy ??= judgeBound; break; }
      const w = work.get(src.of);
      if (!w) continue;
      const a = spawnAttempt(w, 'verify', src);
      a.started = `t+${clock}`;
      a.started_at = today();
      if (HUMAN) event(a.id, 'start', `${pad(w.id, COL)} ${T.dim(`a judge checks what ${src.id} found`)}`);
      else console.log(`  ${pad(a.id, 8)} ${pad('start', 7)} ${pad(w.id, 14)} verify, judging ${src.id}`);
      checkpoint();
      beat();
      track(runAttempt(a).then((r) => settle(a, w, r)));
    }
    for (const w of ready().filter(inFamily)) {
      if (stopping) { stoppedBy = stopping; break; }
      if (inFlight() >= g.concurrency) break;
      if (limitHit) { stoppedBy = `the plan window: ${limitHit} was rate limited`; break; }
      // Spend is checked here, between launches, on what has already settled. In-flight attempts
      // are allowed to finish; only new launches stop, which is the same rule `--max-launches`
      // has always had.
      const over = overBudget();
      if (over) { stoppedBy = over; break; }
      // A budget, not a schedule. Sixteen work items at two attempts each is thirty-two agent
      // sessions, and the first question a graph answers is usually "does any of this work at
      // all", which three answers as well as thirty-two, for a tenth of the spend. In-flight
      // attempts are allowed to finish; only new launches stop.
      if (MAX_LAUNCHES && launched >= MAX_LAUNCHES) {
        stoppedBy = `the launch budget of ${MAX_LAUNCHES}`;
        break;
      }
      // Serialize discovery until proposals are absorbed, so parallel mappers do not duplicate the same prerequisite.
      if (!ONT && nextKind(w.id) === 'map' &&
          g.attempts.some((x) => x.state === 'running' && kindOf(x) === 'map')) continue;
      // And the same caution for money: the first attempt of a kind nobody has paid for yet
      // goes alone, so an unknown price is discovered once rather than concurrency times over.
      if (MAX_USD && unpricedKindBusy(nextKind(w.id))) continue;
      // The statement is compiled before a prover is spawned on it (see runGate). A gate that
      // fails leaves the item on the board, unlaunched, named in the report with the compiler's
      // words; an operator revises the statement or closes the route.
      if (!DRY && nextKind(w.id) === 'prove' && gateOf(w)) {
        if (gateBlocks(w)) continue;
        const my = checkTurn.then(() => runGate(w));
        checkTurn = my.catch(() => {});
        const r = await my;
        if (r && r.state === 'fails') {
          console.log(`  ${pad('', 8)} ${pad('gate', 7)} ${pad(w.id, 14)} does not elaborate, not launched: ${String(r.error?.[0] ?? '').slice(0, 100)}`);
          checkpoint();
          continue;
        }
        // A cell may settle, spend the remaining budget, or hit the plan limit while the gate
        // waits in the check queue. The operator may also stop us during that wait.
        if (stopping) { stoppedBy = stopping; break; }
        if (limitHit) { stoppedBy = `the plan window: ${limitHit} was rate limited`; break; }
        const bound = overBudget();
        if (bound) { stoppedBy = bound; break; }
      }
      const a = spawnAttempt(w);
      launched++;
      a.started = `t+${clock}`;
      a.started_at = today();
      // A map launch says so. A launch picked for its leverage says how much it unlocks, so the
      // order the chooser produced is visible in the run log, not just in the picture.
      const startNote = [a.kind === 'map' ? 'map' : '', a.from ? `retry of ${a.from}` : '',
                         leverage(w.id) ? `unlocks ${leverage(w.id)}` : ''].filter(Boolean).join(', ');
      if (HUMAN) event(a.id, 'start', `${pad(w.id, COL)} ${T.dim([a.kind === 'map' ? 'plans first'
          : `builds${needsOf(w.id).length ? ` on ${needsOf(w.id).join(', ')}` : ''}`, a.from ? `retry of ${a.from}` : '',
        leverage(w.id) ? `unblocks ${leverage(w.id)}` : ''].filter(Boolean).join(', '))}`);
      else console.log(`  ${pad(a.id, 8)} ${pad('start', 7)} ${pad(w.id, 14)} ` + startNote);
      // Written before the agent is spawned, not after it finishes: a launch is the moment the
      // picture is supposed to move, and an attempt that dies in provisioning still happened.
      checkpoint();
      beat();
      track(runAttempt(a).then((r) => settle(a, w, r)));
    }
    if (!live.size) break;
    await Promise.race(live);
  }

  // Say which budget bound, and re-check it: a budget can be crossed by the last attempts to
  // settle, after the loop stopped launching for want of ready work.
  const boundBy = overBudget() ?? stoppedBy ?? stopping;
  const unsettled = g.attempts.filter((a) => a.state === 'running');
  if (unsettled.length && !DRY) {
    process.exitCode = 10;
    console.log(`\n  INCOMPLETE  ${unsettled.length} attempt(s) still have live or unverified processes. Records and worktrees are preserved.`);
  }
  if (boundBy) {
    const left = ready().filter(inFamily).length;
    const s = spendSoFar();
    // A cap stops new launches; already running attempts can still exceed it.
    const dear = dearestOfKind('prove');
    const over = MAX_USD && s.usd > MAX_USD ? `\n  OVER the $${MAX_USD.toFixed(2)} cap by $${(s.usd - MAX_USD).toFixed(2)}: ` +
      `attempts already in flight when it bound cannot be un-spent.` +
      `\n  Each was reserved at $${reserveUsed().toFixed(2)}, the mean; the dearest actually cost $${(dear ?? 0).toFixed(2)}.` +
      `\n  '--reserve-usd ${Math.ceil(dear ?? 0)}' would have held this cap, at the price of not launching` +
      `\n  once the run came within $${Math.ceil(dear ?? 0)} of it.` : '';
    console.log(`\n  stopped at ${boundBy}: ${launched} launched, ${left} still ready.${over}` +
                `\n  spent ${s.output_tokens} output tokens · $${s.usd.toFixed(2)} over ${g.attempts.length} attempt(s)` +
                `${s.unpriced ? `, ${s.unpriced} of which reported no dollar cost and are not in the dollar total` : ''}.` +
                `\n  ${unsettled.length ? `${unsettled.length} attempt(s) remain running; use stop or recovery before another launch`
                                : hardStop ? 'the cells the operator killed are recorded as stopped, and kept'
                                : 'everything launched ran to completion and is recorded'}. Re-run to continue.`);
  }

  // An empty launch queue may mean completion, parked work, or exhausted attempts; report which.
  const drain = boundBy ? null : classifyDrain();
  if (HUMAN) tellEnding(drain, boundBy);
  else {
    if (drain) console.log(`\n  the queue emptied: ${drain.why}\n  next: ${drain.next}`);
    report();
  }
  if (MAILBOX) {
    syncMessages();
    if (!HUMAN || mailBase) console.log(`  messages: ${mailBase} sent`);
  }
  // Do not save simulated attempts to the durable record.
  if (DRY) {
    dropMailbox();
    console.log(`  dry run: ${file} not written\n`);
    return;
  }
  // Why this run ended, on the record. `attempts[]` says what ran; nothing in the file said what
  // stopped it, and a caller that has to decide whether to invoke anything next needs that.
  g.last_run = {
    ended: today(),
    launched,
    invocations: g.attempts.length,
    invocation_allowance: MAX_INVOCATIONS || null,
    budgets: RECORDED_BUDGETS,
    stopped_by: boundBy ?? null,
    drained: drain?.state ?? null,
    why: drain?.why ?? boundBy ?? null,
    next: drain?.next ?? 'a budget bound; re-run to continue',
    ...(MAILBOX ? { messages: mailBase } : {}),
  };
  checkpoint();
  // The heartbeat outlives the run only when the run died. Removing it on the way out is what
  // makes a leftover one mean something to the next runner, so the timer is stopped first: a beat
  // that fires after the rm puts the file back and turns a clean exit into a reported death.
  if (heart) clearInterval(heart);
  dropMailbox();
  removeOwnRunfile(RUNFILE);
  rmSync(LIVEFILE, { force: true });
  removeLock(LOCKFILE);
  if (HUMAN) console.log(''); else console.log(`  wrote ${file}\n`);
}

/* ---------------------------------------------------------------- summary */



if (STOP) {
  process.exit(await stopRun());
} else if (GATE) {
  if (DRY) {
    for (const w of g.work.filter((w) => statusOf(w) !== 'rejected' && gateOf(w)))
      console.log(`  ${w.id}  would gate: ${gateOf(w)}`);
    console.log(`  dry run: no gate commands executed; ${file} not written\n`);
    process.exit(0);
  }
  const foreign = blockingRunner();
  if (foreign) { console.error(`  pid ${foreign.pid} is running this graph; the gate writes the graph and would be overwritten.${legacyNote(foreign)}`); process.exit(1); }
  // Hold both lock and runfile through the gate so other writers cannot race it.
  const claim = await claimRunLock(LOCKFILE, { file, identity: RUN_IDENTITY, started: RUN_STARTED, role: 'gate' });
  if (!claim.claimed) refuseLiveRunner(claim.holder);
  BEAT_ROLE = 'gate';
  beat();
  heart = setInterval(beat, 2000);
  refreshBoard();
  let n = 0;
  try {
    n = await gateAll();
    checkpoint();
  } finally { if (heart) clearInterval(heart); heart = null; removeOwnRunfile(RUNFILE); removeLock(LOCKFILE); }
  console.log(`  wrote ${file}\n`);
  process.exit(n ? 1 : 0);
} else if (CONFIRM || REJECT || CONFIRM_SCOPED) {
  console.log(`\n${g.graph}  operator\n`);
  // Refuse decisions beside a live runner, which holds and later rewrites the board in memory.
  const foreign = blockingRunner();
  if (foreign) {
    console.error(`  pid ${foreign.pid} is running this graph right now and would write over this` +
                  `\n  decision without saying so. Wait for it to finish, then confirm.${legacyNote(foreign)}\n`);
    process.exit(1);
  }
  // Claim, re-read, decide, then write. Deciding on the loaded snapshot and claiming
  // after leaves a window where a writer that finished between our load and our claim is
  // in the file but not in memory, and our checkpoint writes it back over their work. A
  // dry run walks the snapshot and writes nothing, so it claims nothing.
  if (!DRY) {
    const claim = await claimRunLock(LOCKFILE, { file, identity: RUN_IDENTITY, started: RUN_STARTED, role: 'confirm' });
    if (!claim.claimed) refuseLiveRunner(claim.holder);
    BEAT_ROLE = 'confirm';
    beat();
    refreshBoard();
  }
  const n = (CONFIRM ? decide(CONFIRM, 'confirmed') : 0) + (REJECT ? decide(REJECT, 'rejected') : 0) +
            (CONFIRM_SCOPED ? confirmScoped() : 0);
  // `--dry-run` must leave the board untouched, including the decision path.
  if (DRY) { console.log(`\n  ${n} would change; dry run: ${file} not written\n`); process.exit(0); }
  try {
    checkpoint();
  } finally { removeOwnRunfile(RUNFILE); removeLock(LOCKFILE); }
  console.log(`\n  ${n} changed, wrote ${file}\n`);
} else {
  main();
}
