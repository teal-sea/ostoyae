// Who is alive: the runner, its cells, and the one command that stops them.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { captureIdentity, identityMatches, inspectProcess, inspectProcessGroup, processOwner } from './process-identity.mjs';

const pad = (s, n) => String(s).padEnd(n);

// EPERM means the process exists and belongs to somebody else, which for this purpose is alive.
export const alive = (pid) => inspectProcess(pid).status !== 'dead';

export const readRun = (RUNFILE) => {
  if (!existsSync(RUNFILE)) return null;
  try {
    const record = JSON.parse(readFileSync(RUNFILE, 'utf8'));
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('missing or invalid runner PID');
    return record;
  }
  catch (e) { throw new Error(`Cannot read run record ${RUNFILE}: ${e.message}. Resolve it before launching or stopping.`); }
};

export function cellPathOf(g, a) {
  if (!g.sandbox || !a.sandbox?.worktree) return null;
  const repo = resolve(g.sandbox.repo);
  const root = resolve(g.sandbox.root ?? join(repo, '..', 'ostoyae-worktrees'));
  return join(root, a.sandbox.worktree.replace(/^wt\//, ''));
}

// Where a cell's output goes: a file beside the worktrees, not a pipe into the runner. A cell
// writing into a pipe dies of EPIPE the moment the runner does, which is why the twelve orphans
// of 2026-09-03/04 left nothing to recover: two of the three swept at 00:23 had no handback and
// no commit. Out of the tree so it can never be committed as work.
export function cellLogOf(g, a) {
  const path = cellPathOf(g, a);
  return path ? join(dirname(path), '_logs', `${a.id}.log`) : null;
}

export function rememberCellGroup(g, a) {
  const path = cellPathOf(g, a), info = inspectProcess(a.cell_pid);
  if (!path || info.pgid !== a.cell_pid || processOwner(a.cell_pid, { cwd: path, identity: a.cell_identity }) !== true) return false;
  const leader = a.cell_identity ?? captureIdentity(a.cell_pid, { cwd: path });
  if (!leader) return false;
  const group = inspectProcessGroup(a.cell_pid);
  const previous = a.cell_group;
  const sameGroup = previous?.pgid === a.cell_pid && identityMatches(previous.leader, { identity: leader }) && previous.leader.cwd === leader.cwd;
  const members = new Map((sameGroup ? previous.members : []).map((m) => [`${m.pid}:${m.boot}:${m.start}`, m]));
  const unverified = [];
  for (const member of group.members) {
    if (!member.identity) { unverified.push(member.pid); continue; }
    const identity = { ...member.identity, cwd: leader.cwd };
    members.set(`${identity.pid}:${identity.boot}:${identity.start}`, identity);
  }
  a.cell_group = { pgid: a.cell_pid, leader, status: unverified.length ? 'unknown' : group.status,
    members: [...members.values()], unverified };
  return JSON.stringify(previous) !== JSON.stringify(a.cell_group);
}

export function inspectCell(pid, path, identity, recordedGroup) {
  const leader = inspectProcess(pid);
  const owner = processOwner(pid, { cwd: path, identity });
  // A live replacement at the same PID cannot give ownership of its group to an old record.
  const recycled = owner === false && leader.status !== 'dead';
  const trusted = !!recordedGroup && recordedGroup.pgid === pid && identityMatches(recordedGroup.leader, { identity }) &&
    recordedGroup.leader.cwd === identity?.cwd;
  const members = new Map();
  const unknown = new Set();
  if (owner === true) {
    const known = identity ?? captureIdentity(pid, { cwd: path });
    if (known) members.set(pid, known); else unknown.add(pid);
  }
  else if (owner === null) unknown.add(pid);
  if (trusted) for (const member of recordedGroup.members ?? []) {
    const owned = processOwner(member.pid, { cwd: path, identity: member });
    if (owned === true) members.set(member.pid, member);
    else if (owned === null) unknown.add(member.pid);
  }
  // Old attempts have no group record. A surviving group is still a reason to wait, but its
  // members never become signal targets merely because they share the dead leader's number.
  if (!recycled && (leader.pgid === pid || leader.status === 'dead' || trusted)) {
    const group = inspectProcessGroup(pid);
    for (const member of group.members) if (!members.has(member.pid)) unknown.add(member.pid);
    if (group.status === 'unknown') unknown.add(pid);
  }
  return { status: unknown.size ? 'unknown' : members.size ? 'alive' : 'dead',
    members: [...members.values()], unknown: [...unknown] };
}

export function cellAlive(pid, path, identity, recordedGroup) {
  // Unknown ownership blocks duplicate work but never authorizes a signal.
  if (processOwner(pid, { cwd: path, identity }) !== false) return true;
  return inspectCell(pid, path, identity, recordedGroup).status !== 'dead';
}

// Snapshot owned members before signalling them individually. A negative PGID can target a
// recycled group; birth identities let a subsequent stop safely address surviving children.
export function killCell(g, a) {
  const path = cellPathOf(g, a);
  if (!path) return false;
  rememberCellGroup(g, a);
  const cell = inspectCell(a.cell_pid, path, a.cell_identity, a.cell_group);
  let signalled = false, failed = cell.unknown.length > 0;
  for (const member of cell.members.sort((x, y) => Number(x.pid === a.cell_pid) - Number(y.pid === a.cell_pid))) {
    const owner = processOwner(member.pid, { cwd: path, identity: member });
    if (owner === false) continue;
    if (owner !== true) { failed = true; continue; }
    try { process.kill(member.pid, 'SIGTERM'); signalled = true; }
    catch (e) { if (e.code !== 'ESRCH') failed = true; }
  }
  return signalled && !failed;
}

export const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// Older records use verifiable argv where available. New records also carry the process's
// birth identity, allowing the same check on macOS and Linux without trusting a bare PID.
export function isRunnerOf(pid, file, identity) {
  return processOwner(pid, { runnerFile: file, identity });
}

// What is in flight right now, read from the file rather than from the copy this process parsed
// when it started. A live runner has been launching and settling ever since, so the number in
// memory is whatever was true when `stop` began loading, which is not what the operator is being
// told it is.
export function inFlightOnDisk(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).attempts.filter((a) => a.state === 'running').length; }
  catch { return null; }
}

// `--stop`. Reads the same two facts every other reader here reads, the runfile and `cell_pid` on
// the attempts, so it works whether the runner is alive, dead, or dead with its cells still
// spending. It never writes the graph: an attempt that was running is left running, and the next
// runner's `sweep` settles it from whatever handback the cell left, which is the one path that
// has already been rehearsed for orphans.
//
// Exit code, because the wrapper has to decide whether to take the viewer down with it:
// 0 nothing is running any more, 10 something still is.
export async function stopRun({ g, file, RUNFILE, NOW }) {
  console.log(`\n${g.graph}  stop\n`);
  const prev = readRun(RUNFILE);
  const ownership = prev ? isRunnerOf(prev.pid, file, prev.identity) : false;
  if (ownership === null) {
    console.log(`  UNKNOWN  cannot verify ownership of runner pid ${prev.pid}. Nothing is signalled.` +
      `\n           Inspect this process on the machine where it started; the run record is preserved.\n`);
    return 10;
  }
  const runner = ownership === true ? prev : null;
  if (prev && !runner && alive(prev.pid)) {
    console.log(`  note     pid ${prev.pid} from the runfile is alive but is not a runner for this graph:` +
                `\n           its number has been recycled. Nothing is signalled at it.`);
  }
  const cells = g.attempts.filter((a) => a.state === 'running' && cellAlive(a.cell_pid, cellPathOf(g, a), a.cell_identity, a.cell_group));

  if (!runner && !cells.length) {
    console.log(prev
      ? `  nothing to stop: no identified runner or live cells for this graph.\n` +
        `  ${g.attempts.filter((a) => a.state === 'running').length} attempt(s) are still unsettled; the next runner sweeps them.\n`
      : `  nothing to stop: no runner on this graph.\n`);
    return 0;
  }

  if (runner) {
    // An exited runner can still have live cells. Even ESRCH goes through the completion check.
    let signalled = false;
    try { process.kill(runner.pid, 'SIGTERM'); signalled = true; }
    catch (e) {
      console.log(`  runner   pid ${runner.pid}: signal failed (${e.code}).\n`);
      if (e.code !== 'ESRCH') return 10;
    }
    if (signalled) console.log(`  runner   pid ${runner.pid}, up since ${runner.started}: told to stop launching.`);
    else console.log(`  runner   pid ${runner.pid} exited before the signal; checking its remaining cells.`);
    if (NOW && signalled) {
      // The second signal is what kills the cells. Sent separately rather than as one louder
      // signal so that the same handler serves Ctrl-C on an attended run: once to drain, twice
      // to kill.
      await nap(1500);
      if (isRunnerOf(runner.pid, file, runner.identity) === true) {
        try { process.kill(runner.pid, 'SIGTERM'); }
        catch (e) { if (e.code !== 'ESRCH') console.log(`  FAILED   second stop signal: ${e.code}`); }
      }
      console.log(`  cells    ${inFlightOnDisk(file) ?? cells.length} in flight: told to die with it.`);
    }
    const deadline = Date.now() + (NOW ? 90_000 : 15_000);
    while (isRunnerOf(runner.pid, file, runner.identity) !== false && Date.now() < deadline) await nap(500);
    if (isRunnerOf(runner.pid, file, runner.identity) === false) {
      let latest;
      try { latest = JSON.parse(readFileSync(file, 'utf8')); }
      catch (e) {
        console.log(`\n  UNKNOWN  runner exited but its final board cannot be read: ${e.message}\n`);
        return 10;
      }
      const remaining = latest.attempts.filter((a) => a.state === 'running' &&
        cellAlive(a.cell_pid, cellPathOf(latest, a), a.cell_identity, a.cell_group));
      if (remaining.length) {
        console.log(`\n  INCOMPLETE  runner exited, but ${remaining.length} cell(s) are still alive or unverified.\n`);
        return 10;
      }
      console.log(`\n  stopped. The run is over and the record is written.\n`);
      return 0;
    }
    console.log(`\n  draining: ${inFlightOnDisk(file) ?? cells.length} attempt(s) are still in flight and nothing new launches.` +
                `\n  They finish and are recorded, which is the point; a killed cell is money spent on nothing.` +
                `\n  'bin/ostoyae stop --now' kills them instead.\n`);
    return 10;
  }

  // The runner is gone and its cells are not. This is the case that had no answer at all: the
  // cells are detached so that a dead runner cannot take their work down with it, which is right,
  // and it means killing the runner never stopped the spending.
  console.log(`  runner   ${prev ? `pid ${prev.pid} is gone` : 'no runfile'}, but ${cells.length} cell(s) are still running, and still spending:`);
  for (const a of cells) console.log(`  ${pad(a.id, 8)} ${pad('cell', 7)} pid ${a.cell_pid}  ${a.of}`);
  if (!NOW) {
    console.log(`\n  left alone. A cell that finishes writes a handback, and the next runner reads it and` +
                `\n  settles the attempt from it, check and trunk merge included. 'stop --now' kills them.\n`);
    return 10;
  }
  let failed = 0;
  for (const a of cells) {
    const killed = killCell(g, a);
    if (!killed) failed++;
    console.log(killed
      ? `  ${pad(a.id, 8)} ${pad('signal', 7)} pid ${a.cell_pid}`
      : `  ${pad(a.id, 8)} ${pad('kill', 7)} FAILED on pid ${a.cell_pid}`);
  }
  if (failed) {
    console.log(`\n  INCOMPLETE  ${failed}/${cells.length} cell(s) could not be identified or signalled. Records preserved.\n`);
    return 10;
  }
  const until = Date.now() + 3000;
  const remaining = () => cells.filter((a) => cellAlive(a.cell_pid, cellPathOf(g, a), a.cell_identity, a.cell_group));
  while (remaining().length && Date.now() < until) await nap(100);
  const count = remaining().length;
  if (count) {
    console.log(`\n  INCOMPLETE  ${count}/${cells.length} cell(s) remain alive or unverified after SIGTERM. Records preserved.\n`);
    return 10;
  }
  console.log(`\n  killed. Their attempts still say running and their branches still hold whatever they` +
              `\n  committed; the next runner sweeps them and reads what they left.\n`);
  return 0;
}
