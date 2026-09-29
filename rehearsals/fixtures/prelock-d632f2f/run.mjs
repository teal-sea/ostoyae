#!/usr/bin/env node
// ostoyae, walk a graph, run what is ready, and let what runs change the graph.
//
//   node run.mjs <graph.json> [--dry-run] [--exec "<cmd>"] [--keep]
//   node run.mjs <graph.json> --confirm <id>[,<id>...]
//   node run.mjs <graph.json> --reject  <id>[,<id>...]
//
// This file exists for section 3 of the map-first method: a run that fails against a wall has
// discovered an edge, and that is a success. The lab's Mertens failure was exactly this. Run
// 16585a2a hit the wall, discovered that Mathlib had no Mertens second theorem and that one
// formalization would unlock a family of targets, wrote it to threads.json, and nothing reads
// threads.json when ranking. The discovery was recorded somewhere the chooser does not look.
//
// So an attempt hands back a report. Walls and new work in it become `proposed` entries in this
// same file, each carrying the attempt id that found it and the date it was found. Proposals are
// inert: not scheduled, and they do not affect readiness. The operator confirms, and only a
// confirmed edge changes what runs next. Prose does not auto-edit the graph.
//
// Anything that must be unique across attempts, branch, worktree, database, port, and now edge
// ids, is assigned here and never chosen inside a node. A node cannot see its siblings.
//
// A graph can ask for a map before the work. With `mapping` on, an item's first attempt is a map
// attempt: it does not do the work, it says what the item settles, what it costs and what it
// needs, and what it needs goes through the same proposal path a wall does. The prove attempt
// comes after, carrying the map. Every attempt says which of the two it is.

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, mkdirSync, openSync, closeSync, statSync, readSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { provision, teardown, ensureTrunk, integrate, trunkOf, trunkPath, checkTree } from './sandbox.mjs';
import { derive, kindOf, LIMIT_RE } from './viewer/state.mjs';
import { fill, claimHash } from './lib/claims.mjs';
import { wallNamesNothing } from './lib/wall.mjs';
import { REPORT, USAGE, WORK, VERIFY, absorb as absorbInto, readReport, readUsage } from './lib/handback.mjs';
import * as spend from './lib/spend.mjs';
import { classifyDrain as classifyDrainOf, report as reportOf } from './lib/summary.mjs';
import { alive, readRun as readRunFile, cellPathOf as cellPathIn, cellLogOf as cellLogIn, cellAlive,
         rememberCellGroup, killCell as killCellIn, stopRun as stopRunWith } from './lib/liveness.mjs';
import { decide as decideWith, confirmScoped as confirmScopedWith } from './lib/decide.mjs';
import { captureIdentity, processOwner } from './lib/process-identity.mjs';
import { cellEnvironment } from './lib/providers.mjs';
import { reservePort } from './lib/ports.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && !isValueOf(a));
const flag = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
function isValueOf(a) { const i = argv.indexOf(a); return i > 0 && ['--exec', '--model', '--confirm', '--reject', '--reject-why', '--max-launches', '--max-usd', '--max-output-tokens', '--max-invocations', '--reserve-usd', '--only', '--adopt-wait'].includes(argv[i - 1]); }
const CONFIRM_SCOPED = flag('--confirm-scoped');
const AUTO_ADVANCE = flag('--auto-advance');
// Stopping a run. A run is launched with `setsid nohup` so it survives the terminal that started
// it, which is what makes it worth launching and also means there is no Ctrl-C to press. Until
// 2026-09-04 there was no way to stop one at all: killing the runner left every cell spending,
// because a cell is detached on purpose so that a dead runner does not take its work with it.
// `--stop` asks the live runner to stop launching and let what is in flight land; `--stop --now`
// kills the cells too. Both work from any terminal, and both work when the runner is already
// gone and only its cells are left.
const STOP = flag('--stop');
// Run every active item with a claim through its kind's gate and write the results, launching
// nothing. What a run does before each launch, done to the whole board at once.
const GATE = flag('--gate');
const NOW = flag('--now');

if (!file) {
  console.error('usage: node run.mjs <graph.json> [--dry-run] [--exec "<cmd>"] [--keep] [--only <id>]');
  console.error('       budget: --max-launches N | --max-usd N | --max-output-tokens N  (any, all; first to bind stops new launches)');
  console.error('               --max-invocations N  every agent session on the record: work, map AND verify, cumulative across restarts');
  console.error('               --reserve-usd N   what each in-flight attempt counts for against --max-usd (default: mean settled cost)');
  console.error('       node run.mjs <graph.json> --confirm <id>[,<id>...] | --reject <id>[,<id>...] [--reject-why "<text>"] | --confirm-scoped');
  console.error('       node run.mjs <graph.json> --stop [--now]   stop a live run; --now kills the cells too');
  process.exit(2);
}

const DRY = flag('--dry-run');
const EXEC = arg('--exec', null);
const KEEP = flag('--keep');
const CONFIRM = arg('--confirm', null);
const REJECT = arg('--reject', null);
// Why a route was closed, in the operator's words, recorded on the item. A rejection with no
// reason is a dead end the next reader has to reconstruct from attempts.
const REJECT_WHY = arg('--reject-why', null);
const MAX_LAUNCHES = Number(arg('--max-launches', 0)) || 0;
// Budget on the resource the question is about. `--max-launches` counts agent sessions, which is
// the right cap for "does any of this work at all" and the wrong one for anything compared
// against another arm: a launch is not a unit of spend. The evaluation of 2026-08-30 matched its
// arms on output tokens in the protocol and then capped `G` at 22 launches, so `G` spent 11 of
// them on cheap mapper runs and stopped at 168,026 output tokens against a budget of about
// 867,000. That is 19% of what it was allowed, with five tickets never attempted, so its result
// measures that arithmetic and not the graph.
//
// These two cap the resources `result.usage` actually reports. All three can be set; the first to
// bind stops new launches. They are cumulative over `attempts[]`, not per run: the file is the
// record, a cap that resets every `go` is not a cap, and "2B total across the family" in a
// protocol means across the family.
const MAX_USD = Number(arg('--max-usd', 0)) || 0;
const MAX_OUTPUT_TOKENS = Number(arg('--max-output-tokens', 0)) || 0;
// What an in-flight attempt is assumed to cost until it settles. Spend only lands at settle, so
// a cap checked against settled spend alone let three expensive attempts fly at once and turned
// an $8.12 cap into $15.78 on 2026-08-31. With a reservation, each running attempt counts
// against the cap at this figure (or, unset, at the mean settled cost so far), and the overshoot
// is bounded by one attempt's error rather than by concurrency times the dearest attempt.

// The allowance that counts sessions rather than money, across every role and across restarts.
//
// The three caps above do not answer "how many agent sessions may this campaign spend in total".
// `--max-usd` and `--max-output-tokens` are computed from `result.usage`, so an executor that
// reports no usage makes them refuse to bind rather than bind wrongly, which is correct and
// leaves nothing holding the line. `--max-launches` counts only the work launches of one runner
// invocation: a verify attempt is deliberately outside it (see the comment on the judge in
// main()), and the counter starts at zero every `go`, so a controller that restarts four times
// spends four times its cap. For a bounded campaign that has to survive its own restarts, both
// of those are the wrong unit.
//
// `attempts[]` is the right one. It is the durable, append-only record, and every entry in it is
// one executor session the runner spawned: prove, map and verify alike. Counting entries is
// therefore cumulative and restart-persistent by construction, with no new state to keep in step.
//
// It counts an attempt that died in provisioning too, which no model was paid for. That is
// deliberate and it is the conservative direction: on 2026-09-03 a flag the runner did not know
// turned into 79 failed map attempts in 79 seconds, and an allowance that refused to count them
// would not have stopped it.
const MAX_INVOCATIONS = Number(arg('--max-invocations', 0)) || 0;
const RESERVE_USD = Number(arg('--reserve-usd', 0)) || 0;

// How long a new runner waits for a cell that outlived the runner before it. Adopting one is
// worth real money: it is an agent already paid for, most of the way through work whose handback
// the sweep can still settle from, check and trunk merge included. So the wait is the right
// default. Unbounded was not: until 2026-09-04 a wedged cell held the next runner for as long as
// its process existed, with nothing launching and nothing said, and the only way out was to find
// the pid by hand. Now the wait is bounded and says what it is doing; when it expires the cell is
// left exactly as it is, still running and still owning its item, and the run gets on with the
// rest of the graph. `bin/ostoyae stop --now` is what kills it.
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

// A walk with nothing to execute is not a dry run. It is a run in which every attempt fails the
// instant it is provisioned, and each of those failures is recorded and spends the item's
// attempt. On 2026-09-03 a session typed `node run.mjs <board> --status`, a flag that does not
// exist, and in 79 seconds the runner made a branch and recorded a failed map attempt for every
// one of the 79 unmapped problems on the lean-eval board, at no model cost and with every map
// attempt spent. The same failure `--dry-run` was fixed for (see runAttempt), by another door,
// and this time it reached the record. So a flag the runner does not know stops it here, and a
// walk with nothing to execute stops here, before a cell exists.
const KNOWN_FLAGS = new Set(['--dry-run', '--exec', '--model', '--keep', '--only', '--confirm', '--reject', '--confirm-scoped',
  '--max-launches', '--max-usd', '--max-output-tokens', '--max-invocations', '--reserve-usd', '--reject-why',
  '--stop', '--now', '--adopt-wait', '--gate', '--auto-advance']);
const unknownFlags = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a) && !isValueOf(a));
if (unknownFlags.length) {
  console.error(`  unknown flag ${unknownFlags.join(', ')}. Nothing run.`);
  process.exit(2);
}
if (!DRY && !EXEC && CONFIRM === null && REJECT === null && !CONFIRM_SCOPED && !STOP && !GATE) {
  console.error('  nothing to execute: --exec "<cmd>" runs attempts, --dry-run walks without touching anything. Nothing run.');
  process.exit(2);
}
// One node and what it needs, nothing else. A graph of fifty-three problems is the god view;
// a run is usually one problem being worked out. `--only w-erdos-282` launches on 282 and on
// everything 282 transitively needs (its confirmed tasks, their prerequisites), and skips the
// other fifty-two. The file stays whole; only the launches narrow.
const ONLY = arg('--only', null);
const g = JSON.parse(readFileSync(file, 'utf8'));
const SAVED_DEFAULTS = g.defaults;
if (flag('--model')) {
  const model = arg('--model', null);
  if (!model || model.startsWith('--') || !model.trim()) {
    console.error('  --model needs a model ID. Nothing run.');
    process.exit(2);
  }
  g.defaults = { ...g.defaults, model };
}

g.attempts ??= [];
g.edges ??= [];
g.concurrency ??= 3;
g.max_attempts ??= 3;

// One id, one thing, or the file does not run. A duplicated id aliases silently: `workOf` finds
// the first copy, attempts on any copy count against all of them, one proved copy marks the rest
// satisfied, and a single pass of the launch loop can start the same id as many times as it
// appears, paying each time. Found live on erdos-zeta-plain, 2026-09-02: w-erdos-1167 appeared
// four times carrying four different formalized statements, one id, and the chooser surfaced it
// by listing the same item four times in one ready pass. Refusing beats deduplicating, because a
// dedupe picks a survivor quietly and three variants of the problem stop existing.
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

// The judge. Off when the key is absent, and then every proposal is confirmed on the operator's
// reading alone, as before. On, `verify` is the instruction handed to every verify attempt and,
// like `mapping.what`, it lives in the file: a person opening the graph can read what the judge
// was told. `default_check` is a shell command with `{id}` in it, given to every work item that
// declares no `check` of its own, which is what a task a map proposed always is: the mapper
// wrote its `what`, nobody wrote its gate. `require_check` makes doctor refuse a graph with an
// active item that has neither. `params` go to every verify attempt, e.g. a cheaper model.
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

// The ontology. Off when the key is absent, and then a proposal is a sentence with an id the
// agent chose, which is what every graph did before. On, a proposal is a CLAIM of a declared
// kind, and three things stop being the agent's to decide:
//
//   the id      assigned from the claim by `id`, never from what the agent called it
//   the text    generated from the claim by `what`, so two agents describing one lemma
//               produce one sentence rather than two paraphrases
//   identity    the hash of (kind, claim). Two agents proposing the same lemma under
//               different names collide on the hash and become one item with two finders.
//
// This is the actual fix for the $13.97 of 2026-08-31, where three mappers proposed one shared
// task under three ids and the engine built it three times. Serializing discovery was the
// workaround; the collision is the fix, and with it mappers can run in parallel again.
//
//   "ontology": { "kinds": { "lemma": {
//       "claim": ["decl", "statement"],      required, and NOTHING else is hashed
//       "evidence": ["why", "searched"],     optional, recorded, never part of identity
//       "id": "lemma-{decl}",                the id template
//       "what": "Prove {decl} ...",          the instruction template
//       "check": "bash checks/lemma.sh {decl}" } } }
//
// A claim missing a required key, or carrying a key the kind does not declare, is refused at
// absorb with a note. A stray key would silently change the identity, which is the one thing
// this exists to prevent.
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
let heart = null;                // the heartbeat timer, stopped before the runfile is removed
const RUN_STARTED = new Date().toISOString();

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
const today = () => new Date().toISOString();
const isEdgeId = (id) => String(id).startsWith('e-');
const lookup = (id) => (isEdgeId(id) ? g.edges.find((e) => e.id === id) : work.get(id));
const statusOf = (x) => x?.status ?? 'active';

/* ---------------------------------------------------------- checkpointing */

// The graph used to be written once, when the run ended. For the whole length of a run the file
// on disk said sixteen items were `ready` while three agents were working in cells, and the
// viewer, which reads that file and nothing else, showed the graph as it had been before the run
// started. A companion that shows the past is worse than no companion, because it is believed.
//
// So it is written on every transition instead: at each launch and at each settle. Through a temp
// file and a rename, because a reader polling every 700ms will otherwise catch a half-written
// graph, and a rename is the one filesystem operation that is atomic for the reader.
function checkpoint() {
  if (DRY) return;                          // a rehearsal does not get to write history
  const tmp = `${file}.tmp`;
  const record = flag('--model') ? { ...g, defaults: SAVED_DEFAULTS } : g;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, file);
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
const confirmScoped = (targets = null) => confirmScopedWith(targets, { g, work, S, today });
const classifyDrain = () => classifyDrainOf({ g, S, gateBlocks });
const report = () => reportOf({ g, S, file, gateBlocks });
const stopRun = () => stopRunWith({ g, file, RUNFILE, NOW });
const RUN_IDENTITY = captureIdentity(process.pid, { runnerFile: file });

function beat() {
  if (DRY) return;
  const temp = `${RUNFILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({
    graph: g.graph, file, pid: process.pid, identity: RUN_IDENTITY, started: RUN_STARTED,
    beat: today(), launched, budget: MAX_LAUNCHES || null,
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

// A runner that died mid-run left its attempts saying `running`, and `running` is the one state
// nothing recovers from on its own: `ready` skips it, `exhausted` refuses to count it, and the
// work item is permanently busy on an agent that is not there.
//
// Until 2026-09-04 every one of them was settled `failed` on sight, and that threw the work away:
// the cell is a separate process, it outlives the runner, and it finishes its job and writes its
// handback into a worktree nobody reads. Four runners died that way on the lean-eval board in one
// day, three cells each, twelve of eighty-eight attempts paid for and recorded as nothing. So a
// stale attempt is read before it is judged. If its cell is still running, wait for it. If the
// cell left a handback, settle from the handback exactly as a live run would have, check and
// all. Only a cell that is gone and left nothing is failed. This edits `attempts[]`, which nothing
// else here is allowed to do, so it only ever moves an entry off `running` and it never removes
// one.

async function sweep(prev) {
  const stale = g.attempts.filter((a) => a.state === 'running');
  if (!stale.length) {
    if (prev) console.log(`  swept    nothing: pid ${prev.pid} left no unsettled attempt\n`);
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
      const usage = path && existsSync(path) ? readUsage(path) : null;
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
    let r = { ok: true, why, report, usage: readUsage(path), tail: [] };
    if (kindOf(a) === 'prove' && checkOf(w)) {
      const cmd = checkOf(w);
      const my = checkTurn.then(() => runCheck(cmd, cell, a));
      checkTurn = my.catch(() => {});
      const c = await my;
      console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} ${c.code === 0 ? 'passed' : `FAILED, exit ${c.code}`}  ${cmd}  (on ${c.on})`);
      r = c.code === 0
        ? { ...r, check: { ok: true, cmd, on: c.on } }
        : { ...r, ok: false, why: `check failed (exit ${c.code}): ${cmd}`, tail: c.tail, check: { ok: false, cmd, on: c.on } };
    }
    settle(a, w, r);
    if (!KEEP && !hardStop) {
      try { teardown(cell.made, g.sandbox, (m) => console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`)); }
      catch (e) { console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} teardown failed: ${e.message}`); }
    }
  }
  console.log('');
  checkpoint();
}


/* ------------------------------------------------------------- derivation */

// What the graph means, "from blocks to", what is ready, what is walled, what is blocked , 
// lives in viewer/state.mjs and is shared with the companion. It used to be duplicated here,
// which meant the runner and any picture of it could disagree the first time either changed,
// invisibly: a node drawn as launchable that the scheduler refuses to launch.
//
// `derive` reads `g` live rather than snapshotting it, because a run appends proposed work to
// `g.work` while these predicates are still bound.
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
for (const e of STOP ? [] : stale()) {
  e.status = 'proposed';
  e.reopened_at = today();
  e.reopened_why = 'the text of an end changed after it was confirmed';
  console.log(`  ${pad(e.id, 10)} reopened  ${e.from} blocks ${e.to}: ${e.reopened_why}`);
}

/* -------------------------------------------------------- the operator's turn */


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
// The gate an item is judged by: its own, or the graph's default with the id filled in, or
// none. A task a map proposed has a `what` the mapper wrote and no `check` anyone wrote, and
// without a default it is done on the agent's word, which the record says out loud.
const checkOf = (w) => w?.check ?? (g.judge?.default_check ? g.judge.default_check.replaceAll('{id}', w.id) : null);


// What a plan window sounds like when it closes on an agent. Matched against the executor's
// last lines, and recorded on the attempt as its own thing: an attempt the window stopped did
// not fail at the work, and a board that shows it as `failed` sends the operator hunting for
// a bug that is a quota.
// LIMIT_RE lives in viewer/state.mjs, beside the counting that has to agree with it.

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

// What a prove attempt needs in order to propose work, and did not have until 2026-09-04.
// A prove attempt that hits a wall has usually just discovered the next layer of the graph, and
// `absorb` types every proposal against the ontology, so an untyped one is dropped. Only the map
// instruction carried the ontology, so a prover's discovery was deleted on arrival: a-0098 on the
// lean-eval board spent $8.17 establishing that Chowla over F_q[t] needs Weil II, proposed five
// tasks and five edges for that next layer, and every one was dropped with "kind null is not one
// of lemma, def, vendor". The wall survived; the map it drew did not. A prover is not asked to
// map, and this does not invite it to: it is told what shape a proposal must take IF it makes one.
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
      ...(g.defaults ?? {}), ...(w.params ?? {}),
      ...(kind === 'map' ? (g.mapping.params ?? {}) : {}),
      ...(kind === 'verify' ? (g.judge.params ?? {}) : {}),
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
  };
  g.attempts.push(a);
  return a;
}

/* --------------------------------------------------------------- handback */

// The ontology, when the board declares one. Claims are read against it in lib/claims.mjs and
// absorbed in lib/handback.mjs; the rulebook itself is documented at load, above.
const ONT = g.ontology ?? null;




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
function cellEnv(cell) {
  return { ...cellEnvironment(g.sandbox?.env_passthrough ?? []), ...cell.env };
}

/* -------------------------------------------------------------- executing */

async function runAttempt(a) {
  // A dry run provisions nothing, whether or not a sandbox is configured. This used to read
  // `DRY && !g.sandbox`, so a dry run against a real sandbox fell through to `provision` and
  // created branches and worktrees in the pursuit repo before simulating, the exact opposite
  // of what the flag is reached for. Measured once: 32 `ost/…` branches left in a live repo.
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
    const log = (m) => console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`);
    // Start from the trunk, not from the graph base: everything finished so far is in it, so a
    // cell sees siblings it has no edge to as well as the parents it does.
    const base = ensureTrunk(g.sandbox, g.graph, log);
    cell = provision(a, { ...g.sandbox, base }, log, upstream);
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
    if (!EXEC) return { ok: false, why: 'no --exec and not --dry-run' };
    if (portLease) await portLease.activate();

    const exec = await new Promise((res) => {
      // Output to a file and the cell in its own process group, so the cell outlives a runner
      // that is killed (see `cellLogOf` and `sweep`). The runner tails the file for the live view.
      const logPath = cellLogOf(a);
      let fd = 'pipe';
      if (logPath) { mkdirSync(dirname(logPath), { recursive: true }); fd = openSync(logPath, 'a'); }
      const p = spawn(EXEC, {
        shell: true,
        cwd: cell.path,
        env: cellEnv(cell),
        stdio: ['pipe', fd, fd],
        detached: !!logPath,
      });
      a.cell_identity = captureIdentity(p.pid, { cwd: cell.path });
      if (fd !== 'pipe') closeSync(fd);
      // An executor's last words are the only explanation a failed attempt ever gets. Streamed
      // through so a live run is still readable, and kept so `exit 1` is not the whole record.
      // Three agents once died on `Not logged in` and the ledger said `exit 1` three times.
      const tail = [];
      const entry = live[a.id] = { of: a.of, kind: kindOf(a), started: today(), lines: [], tentative: null };
      const keep = (buf, out) => {
        out.write(buf);
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
      // The cell's pid, on the record, so a runner that replaces a dead one can tell a cell
      // that is still working from one that is gone (see `sweep`).
      a.cell_pid = p.pid;
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
    // This exists because of a measured gap: on 2026-08-30 every one of eleven head-on attempts
    // exited zero, "the agent said done" scored 11 for 11, and the real checks scored 8 of 11
    // on the rows they could judge. Without this, a retry can never fire on work that is wrong
    // (`S1` was `S0` at a different seed) and `attempts[]` records claims as results.
    //
    // Ordering is deliberate and narrow: the check gates only the exit-zero prove path. A wall
    // still beats everything, walled stays walled, a map attempt is judged by its map as before,
    // and an item with no `check` behaves exactly as it always did. This is the scoped half of
    // `open.md` question 4, the run-with-a-mechanical-gate case; scores and reviewer attempts
    // stay open there.
    // Read before the check decides anything, because a wall beats everything and a wall is in
    // the handback, not in the exit code.
    const handback = readReport(cell.path);
    // A cell the plan window closed on never worked, and the check must not run on it: on
    // 2026-09-05 the check ran on 152 such cells, said "changed no Submission file", and its words
    // replaced the agent's "hit your session limit" in the record, so nothing downstream could
    // tell the window from a failure. The tail stays the agent's and settle reads the window off it.
    if (!exec.ok && (exec.tail ?? []).some((l) => LIMIT_RE.test(String(l)))) {
      return { ...exec, report: handback, usage: readUsage(cell.path) };
    }
    // The check gated only the exit-zero path until 2026-09-04, and that had a case backwards.
    // `a-0153` was told to prove a lemma, found it already proved and sorry-free in its own
    // worktree, verified it rather than rewriting it, and changed nothing -- so the executor had
    // nothing to commit and exited 1, so the check never ran, so an attempt that was right about
    // its work was recorded `failed` with `exit 1` and no explanation, and the item spent one of
    // its tries. The check would have passed: the declaration is there and it builds.
    //
    // The check is the authority over the agent's word, and an authority that is only consulted
    // when the agent already said yes is not one. So it runs whenever a prove attempt has a check
    // and did not wall, and its verdict decides. A wall is still a wall, an item with no `check`
    // still behaves exactly as it did, and a check that fails still fails the attempt.
    if (kindOf(a) === 'prove' && checkOf(work.get(a.of)) && !handback?.wall) {
      const cmd = checkOf(work.get(a.of));
      // One check at a time, across the whole run. Pilot 1 (2026-08-31) failed an attempt whose
      // work was correct because two cells' checks ran their test suites at the same moment and
      // the suite binds a fixed port. Attempts stay concurrent; only the checks queue. A check
      // is seconds where an attempt is minutes, so the serialization costs almost nothing and
      // removes a noise source that lands directly on the primary endpoint.
      const my = checkTurn.then(() => runCheck(cmd, cell, a));
      checkTurn = my.catch(() => {});
      const c = await my;
      console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} ${c.code === 0 ? 'passed' : `FAILED, exit ${c.code}`}  ${cmd}  (on ${c.on})`);
      if (c.code !== 0) {
        return { ok: false, why: `check failed (exit ${c.code}): ${cmd}`, tail: c.tail,
                 check: { ok: false, cmd, on: c.on }, report: handback, usage: readUsage(cell.path) };
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
    return { ...exec, report: handback, usage: readUsage(cell.path) };
  } finally {
    if (portLease && !pendingCell) await portLease.release();
    if (!pendingCell) snapshotEnd(a, cell.path);
    // A cell the operator killed is kept. It is the one case where the environment is worth more
    // than the tidying: whatever the agent had committed is on that branch, and teardown removes
    // the worktree the next reader would look in.
    if (!KEEP && !hardStop && !pendingCell) {
      try { teardown(cell.made, g.sandbox, (m) => console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} ${m}`)); }
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

// The verdicts are the result of a verify attempt, the way a map is the result of a map attempt.
// Each lands on the proposal it is about, with who said it and when, and one about the judged
// attempt's own id is the verdict on its wall. A verdict is evidence, not a decision: the
// proposal stays `proposed`, the operator still answers, and only the unattended yes reads it.
// Anything odd is noted rather than repaired: a verdict on an id the attempt never proposed is
// dropped, a proposal the judge said nothing about stays unjudged, and a missing `ok` is a no.
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
  //
  // The wall beats the exit code, and that ordering is load-bearing. This read `r.ok ? 'done' :
  // …`, so a zero exit made an attempt `done` no matter what its own report said, and the
  // shipped executor exits zero whenever the tree is dirty, which a report file by itself makes
  // it. Every walled attempt would have been recorded as a success, through the one path the
  // repo exists to support. `claude -p` returns 0 when the session completes rather than when
  // the work succeeds, so an exit code cannot carry "did the work" and the report has to.
  //
  // An agent writes `wall` only when something stopped it, so a report carrying one is the
  // attempt saying it did not finish. That holds only as far as the contract teaches it, and
  // it did not: on 2026-09-01 a-0026 finished its survey, wrote "Nothing stopped the survey"
  // into `wall` because that was the only box shaped like a warning, and had its finished work
  // recorded as not done. Everything waiting on it stopped. `ahead` is now that box.
  //
  // A map attempt is done only when it exited zero and handed back a map with something in
  // `settles`. A zero exit with no map is a failed map, and the note says which.
  // The wall floor. A wall that restates the task found nothing, and a walled attempt is one
  // that found structure, so this one is failed, with the wall kept on the record so the reason
  // is readable, and whatever it proposed still lands as proposals for the judge and the
  // operator to read.
  const restated = !!rep?.wall && kindOf(a) !== 'verify' && wallNamesNothing(rep.wall, w);
  if (restated) notes.push('wall names nothing beyond the task itself, recorded as failed');

  if (kindOf(a) === 'verify') {
    a.state = settleVerify(a, rep, r.ok, notes) ? 'done' : 'failed';
  } else if (rep?.wall && found.length && !restated) {
    a.state = 'walled';
    // A map attempt that walls has still mapped, when it handed back a map: for an open problem
    // "no known route, cost unknown" is the map, and the mapping instruction asks for exactly
    // that. Until 2026-08-29 the map beside a wall was dropped, so Erdős 282 and 371 came back
    // with ten tasks each and no map, and would have been mapped a second time after confirm.
    // A prove attempt's map beside a wall is still ignored, as everywhere else.
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
    // In a dry run no check executes, so an absent `result.check` says nothing about whether one
    // is declared; claiming "no check declared" there misreports every gated board. The declared
    // command is recorded beside the note instead, and the summary reads it. Dry runs never
    // write the graph, so this marker is terminal-session-only.
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
  // The answer lands on the item from a done attempt only. Until 2026-09-05 a refutation had no
  // box: an agent told to prove X that proved not-X was recorded failed, or walled if it happened
  // to pick new names, the item stayed active, and the next attempt paid to refute it again.
  // Twelve items on the lean-eval board, twenty attempts, $69.73, every one of them correct.
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
                          (m) => console.log(`  ${pad(a.id, 8)} ${pad('trunk', 7)} ${m}`));
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

// The family of `--only`: the node and everything it transitively needs, through authored
// `needs` and confirmed edges. Proposed edges are not in it until confirmed, so `--only` on a
// walled item launches nothing until the operator answers, which is the same rule as everywhere.
// Recomputed on each call because confirms and settles change what an item needs.
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
/* ------------------------------------------------------------------- gate */

// A statement is compiled in its workspace BEFORE a prover is spawned on it. On the lean-eval
// board, 17 of the 41 attempts that hit a wall on 2026-09-04 were an agent discovering that the
// statement it had been handed did not elaborate -- a typo, a missing namespace, a universe
// pinned wrong, ASCII where Lean should be -- at $3 to $15 an attempt, after the judge had passed
// it, because the judge reads and a compiler compiles. Five of six proposals from one wall were
// not Lean at all. So the kind declares a `gate`, the same way it declares a `check`:
//
//   "ontology": { "kinds": { "lemma": { ..., "gate": "bash /abs/gate-task.sh {decl}" } } }
//
// The command runs in the graph's trunk worktree, one at a time with the checks, with the
// statement in OSTOYAE_STATEMENT and the root problem the item ultimately blocks in
// OSTOYAE_ROOT_ITEM, which is how a board script finds the workspace. Exit 0 elaborates. The
// verdict lands on the item as `gate`, keyed to the claim hash so a revised statement is gated
// again and an unchanged one is not; an item whose gate failed is never launched and the status
// report names it and quotes the compiler. A kind without a gate behaves exactly as before.
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
  // No edge reaches a root: the chain is broken by a rejected edge, or the proposal carried no
  // edge at all. The attempt that found the item knows what it was working on, and that is
  // either the root or something under it. 113 of 200 items had no root by edges alone on the
  // first sweep, 2026-09-04.
  for (const by of w.found_by ?? []) {
    const a = g.attempts.find((x) => x.id === by);
    if (a?.of && a.of !== id) { const r = rootItemOf(a.of, seen); if (r) return r; }
  }
  return null;
}

const gateHashOf = (w) => w.claim_hash ?? (w.kind && w.claim ? claimHash(w.kind, w.claim) : null);

// What the trunk was when a gate ran. A statement that names a declaration no attempt has landed
// YET does not elaborate, and that is a correct refusal to launch a prover at it -- but it is a
// refusal about a moment, not about the statement. On 2026-09-05 nine of the twenty failures were
// exactly this: `BiotSavart.velocity` is itself an item on the board, and its dependants would
// have stayed unlaunchable for ever once it landed, because the verdict was keyed to the claim
// alone and the claim never changes. So the trunk's commit is part of the key: land anything and
// every refusal is reconsidered.
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
  // The trunk worktree is where the gate runs, and until now it was only ever made at
  // provisioning, which is after the gate. Idempotent, so it costs nothing when it exists.
  try { ensureTrunk(g.sandbox, g.graph, (m) => console.log(`  ${pad('', 8)} ${pad('trunk', 7)} ${m}`)); }
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
  const log = (m) => console.log(`  ${pad(a.id, 8)} ${pad('check', 7)} ${m}`);
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

async function main() {
  // The previous run's verdict is not this run's state. Cleared before anything launches so a
  // reader who opens the file mid-run sees no verdict rather than a stale one.
  if (!DRY) delete g.last_run;
  console.log(`\n${g.graph}  concurrency ${g.concurrency}  max_attempts ${g.max_attempts}` +
              `${MAX_LAUNCHES ? `  max_launches ${MAX_LAUNCHES}` : ''}` +
              `${MAX_USD ? `  max $${MAX_USD.toFixed(2)}` : ''}` +
              `${MAX_OUTPUT_TOKENS ? `  max ${MAX_OUTPUT_TOKENS} output tokens` : ''}` +
              `${MAX_INVOCATIONS ? `  max_invocations ${MAX_INVOCATIONS} all roles, ${g.attempts.length} already spent` : ''}` +
              `${mappingOn() ? `  mapping on, ${mapMax()} map attempt${mapMax() === 1 ? '' : 's'} per item` : ''}` +
              `${ONLY ? `\n  only ${ONLY} and what it needs: ${family(ONLY).size} item${family(ONLY).size === 1 ? '' : 's'} in its family` : ''}\n`);

  const foreign = foreignRunner();
  if (DRY) {
    if (foreign) console.log(`  note: pid ${foreign.pid} is running this graph now. These numbers ignore it.\n`);
  } else {
    if (foreign) {
      console.error(`  a runner is already live on this graph: pid ${foreign.pid}, started ${foreign.started},` +
                    `\n  last beat ${foreign.beat}. Two runners write this file over each other and one` +
                    `\n  loses its attempts entirely. Wait for it, or stop it, then run again.\n`);
      process.exit(1);
    }
    const previous = readRun();
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
    // Seen on the lean-eval board on 2026-09-04, twice, and diagnosed as an unclean exit both
    // times because a leftover runfile is supposed to mean exactly that.
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
      const confirmed = confirmScoped(autoTargets);
      if (confirmed) {
        console.log(`  auto-advance: ${confirmed} judged, scoped proposal(s) confirmed`);
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
      console.log(`  ${pad(a.id, 8)} ${pad('start', 7)} ${pad(w.id, 14)} verify, judging ${src.id}`);
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
      // Discovery is serial on purpose. A mapper's whole value is reading the proposals the
      // previous mappers left in work.json; six mappers three-wide on 2026-08-31 could not see
      // each other and proposed one shared task under three different ids, and the engine then
      // did one job three times for $13.97 and landed nothing. The same subject at concurrency
      // 1 produced one task and built it once. So at most one map attempt is in flight per
      // graph; proves stay as parallel as concurrency allows. This is the canary rule from the
      // 2026-08-30 analysis in its minimal form: discovery queues, work fans out.
      // Discovery is serial WITHOUT an ontology, and parallel with one. Six mappers three-wide on
      // 2026-08-31 could not see each other and proposed one shared task under three different
      // ids; the engine did one job three times for $13.97. Serializing them was the workaround
      // and the fix is identity: with `ontology` on, a proposal is a claim, the runner assigns the
      // id from it, and two mappers naming one lemma collide on the claim hash and become one item
      // with two finders. The collision does not care whether they ran at the same moment, so the
      // queue is lifted. With no ontology the old rule stands, because nothing else prevents it.
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
      console.log(`  ${pad(a.id, 8)} ${pad('start', 7)} ${pad(w.id, 14)} ` +
                  [a.kind === 'map' ? 'map' : '', a.from ? `retry of ${a.from}` : '',
                   leverage(w.id) ? `unlocks ${leverage(w.id)}` : ''].filter(Boolean).join(', '));
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
    // In-flight attempts cannot be un-spent, so a cap can still be passed by whatever was
    // already running when it bound. Said out loud rather than left for the operator to subtract.
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

  // A queue that emptied is not a mission that finished, and until now the runner said nothing
  // at all about the difference. With no budget bound it printed the report and exited, so a
  // supervisor reading that exit could not tell "every check on the board passed" from "every
  // item is parked waiting for a human" from "everything that could run has spent its attempts".
  // The runfile that could have said so is deleted on a clean exit, by design, because a
  // leftover one is how the next runner recognises a death. So the reason is classified here,
  // said out loud, and written to the graph, which is the only durable thing left once the
  // process is gone.
  const drain = boundBy ? null : classifyDrain();
  if (drain) console.log(`\n  the queue emptied: ${drain.why}\n  next: ${drain.next}`);

  report();
  // A dry run writes nothing either. `attempts[]` is the record the whole design rests on , 
  // appended, never edited, and simulated attempts landing in it as `done` and `failed` are
  // indistinguishable from real ones except for a string in `result.why`. A rehearsal does not
  // get to write history.
  if (DRY) {
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
  };
  checkpoint();
  // The heartbeat outlives the run only when the run died. Removing it on the way out is what
  // makes a leftover one mean something to the next runner, so the timer is stopped first: a beat
  // that fires after the rm puts the file back and turns a clean exit into a reported death.
  if (heart) clearInterval(heart);
  rmSync(RUNFILE, { force: true });
  rmSync(LIVEFILE, { force: true });
  console.log(`  wrote ${file}\n`);
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
  const foreign = foreignRunner();
  if (foreign) { console.error(`  pid ${foreign.pid} is running this graph; the gate writes the graph and would be overwritten.`); process.exit(1); }
  const n = await gateAll();
  checkpoint();
  console.log(`  wrote ${file}\n`);
  process.exit(n ? 1 : 0);
} else if (CONFIRM || REJECT || CONFIRM_SCOPED) {
  console.log(`\n${g.graph}  operator\n`);
  // A live runner holds the whole graph in memory and writes it back when it settles an attempt,
  // so a decision made now would be overwritten and silently lost. The answer is the operator's
  // and it is not going to disappear into a race.
  const foreign = foreignRunner();
  if (foreign) {
    console.error(`  pid ${foreign.pid} is running this graph right now and would write over this` +
                  `\n  decision without saying so. Wait for it to finish, then confirm.\n`);
    process.exit(1);
  }
  const n = (CONFIRM ? decide(CONFIRM, 'confirmed') : 0) + (REJECT ? decide(REJECT, 'rejected') : 0) +
            (CONFIRM_SCOPED ? confirmScoped() : 0);
  // --dry-run means "touch nothing", and it has to mean that on the decision path too. It did not:
  // `confirm-scoped --dry-run` printed the same walk as a dry run and then wrote 88 decisions into
  // the graph anyway (2026-09-03, on the live lean-eval board). A flag that says it changed
  // nothing while changing the operator's record is worse than no flag, because it also supplies
  // confidence. The walk above has already printed what would change.
  if (DRY) { console.log(`\n  ${n} would change; dry run: ${file} not written\n`); process.exit(0); }
  checkpoint();
  console.log(`\n  ${n} changed, wrote ${file}\n`);
} else {
  main();
}
