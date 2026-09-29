// Who is alive: the runner, its cells, and the one command that stops them.

import { readFileSync, writeFileSync, existsSync, openSync, closeSync, rmSync } from 'node:fs';
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

// One runner per graph, enforced rather than hoped for. The runfile check is check-then-act:
// two runners started in the same instant both read "no runner", both beat, and both run.
export const lockPathOf = (RUNFILE) => `${RUNFILE}.lock`;
export const removeLock = (LOCKFILE) => rmSync(LOCKFILE, { force: true });

// Remove the runfile only when it is still ours: a writer that beat over our preliminary
// record owns it now, and deleting its record would blind everyone to it.
export function removeOwnRunfile(RUNFILE) {
  try {
    const r = JSON.parse(readFileSync(RUNFILE, 'utf8'));
    if (r?.pid === process.pid) rmSync(RUNFILE, { force: true });
  } catch { /* absent or unreadable: nothing of ours to remove */ }
}

export function readLock(LOCKFILE) {
  if (!existsSync(LOCKFILE)) return null;
  try {
    const record = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('missing or invalid lock PID');
    return record;
  } catch (e) { return { _bad: String(e.message).split('\n')[0] }; }
}

// The live holder, if any: a lock whose owner verifies as this graph's runner. Anything else
// is not a holder. Breaking a stale lock is the claimer's job, not this one's.
export function liveLockHolder(LOCKFILE, file) {
  const owner = readLock(LOCKFILE);
  if (!owner || owner._bad) return null;
  return processOwner(owner.pid, { identity: owner.identity, runnerFile: file }) === true ? owner : null;
}

// The claimant, if any: a lock whose owner is live OR unverifiable. This is the same bar
// `claimRunLock` refuses at, and every writer and every stop decision must use it rather
// than `liveLockHolder`: an unverifiable holder sits on the graph exactly as much as a
// verified one, and launch already refuses it. Anything it names, including its `role`,
// is unconfirmed -- a crafted lock can claim any role -- so callers act on the pid, never
// on the role, unless the holder also verifies.
export function lockClaimant(LOCKFILE, file) {
  const owner = readLock(LOCKFILE);
  if (!owner || owner._bad) return null;
  return processOwner(owner.pid, { identity: owner.identity, runnerFile: file }) !== false ? owner : null;
}

// Describe old locks without a role using their heartbeat, so active writers are not called starters.
export const holderDoing = (holder) =>
  holder?.role === 'gate' ? 'gating the board' :
  holder?.role === 'confirm' ? 'writing a decision' :
  holder?.beat ? 'running' : 'still starting';

// Claim the graph, or refuse it. Returns { claimed: true } to exactly one starter; everyone
// else gets { claimed: false, holder }, with the holder named when there is one to name.
export async function claimRunLock(LOCKFILE, { file, identity, started, role }) {
  for (let round = 0; round < 3; round++) {
    let fd = null;
    try { fd = openSync(LOCKFILE, 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== null) {
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, identity, file, started, ...(role ? { role } : {}) }) + '\n'); }
      finally { closeSync(fd); }
      return { claimed: true };
    }
    // Held. A lock being written reads empty for microseconds, so one grace re-read before
    // calling it corrupt; no live claimer writes garbage for a whole second.
    let owner = readLock(LOCKFILE);
    if (owner?._bad) { await nap(1000); owner = readLock(LOCKFILE); }
    if (!owner) continue;                              // released under us; retry
    if (owner._bad) { removeLock(LOCKFILE); continue; }
    const claim = processOwner(owner.pid, { identity: owner.identity, runnerFile: file });
    if (claim !== false) return { claimed: false, holder: owner };   // live or unverifiable: refuse
    removeLock(LOCKFILE);                              // dead holder: break and retry
  }
  return { claimed: false, holder: null };
}

export function cellPathOf(g, a) {
  if (!g.sandbox || !a.sandbox?.worktree) return null;
  const repo = resolve(g.sandbox.repo);
  const root = resolve(g.sandbox.root ?? join(repo, '..', 'ostoyae-worktrees'));
  return join(root, a.sandbox.worktree.replace(/^wt\//, ''));
}

// Write cell output beside the worktree so a runner restart can recover it.
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

// Read live cells from disk because a cached process snapshot may already be stale.
export function inFlightOnDisk(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).attempts.filter((a) => a.state === 'running').length; }
  catch { return null; }
}

// `--stop`. Reads the same two facts every other reader here reads, the runfile and `cell_pid` on
// the attempts, so it works whether the runner is alive, dead, or dead with its cells still
// spending. It never writes the graph: an attempt that was running is left running, and the next
// runner's `sweep` settles it from whatever handback the cell left, which is the one path that
// has already been rehearsed for orphans.
export async function stopRun({ g, file, RUNFILE, NOW }) {
  console.log(`\n${g.graph}  stop\n`);
  let prev = null;
  try { prev = readRun(RUNFILE); }
  catch (e) {
    console.log(`  UNKNOWN  ${e.message}\n`);
    return 10;
  }
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
    // A starter between its claim and its first beat has no runfile and no cells yet, and a
    // gate holds the lock for minutes and launches nothing. Neither is "nothing": the first
    // is about to spend and the second is worth not wondering about. An UNVERIFIABLE holder
    // is named too: launch already refuses it, so stop calling the graph idle contradicts
    // the refusal. Only a VERIFIED holder's role is believed -- a crafted lock can claim
    // any role, so "launches nothing" is exit 0 only when the holder verifies.
    const holder = lockClaimant(lockPathOf(RUNFILE), file);
    if (holder) {
      const since = holder.started ? `, started ${holder.started}` : '';
      const verified = liveLockHolder(lockPathOf(RUNFILE), file);
      if (verified && (verified.role === 'gate' || verified.role === 'confirm')) {
        // Same answer as the runfile branch below: a gate is running, so exit 10 says so.
        if (verified.role === 'gate') {
          console.log(`  pid ${verified.pid} is gating this board${since}: no cells, nothing spending, but writers are blocked.` +
                      `\n  Stop does not interrupt gates; kill pid ${verified.pid} on this machine if it must die. ` +
                      `Gates keep no partial state.\n`);
        } else {
          console.log(`  a decision is being written on this graph (pid ${verified.pid}${since}). Nothing to signal; it lands or fails on its own. Retry in a moment.\n`);
        }
        return 10;
      }
      if (!verified) {
        console.log(`  pid ${holder.pid} holds this graph's lock${since}, but its ownership cannot be verified.` +
                    `\n  Nothing is signalled. If that pid is gone, the next launch breaks the stale lock` +
                    `\n  and proceeds; if it is alive, inspect it on this machine first.\n`);
        return 10;
      }
      console.log(`  a runner is starting on this graph: pid ${holder.pid} holds the lock${since}, but it has` +
                  `\n  no runfile and no cells yet, so there is nothing to signal. Wait for its first beat,` +
                  `\n  then stop it.\n`);
      return 10;
    }
    const unsettled = g.attempts.filter((a) => a.state === 'running').length;
    console.log(prev
      ? `  nothing to stop: no identified runner or live cells for this graph.\n` +
        `  ${unsettled} attempt(s) are still unsettled; the next runner sweeps them.\n`
      : `  nothing to stop: no runner on this graph.\n` +
        (unsettled ? `  ${unsettled} attempt(s) are still unsettled; the next runner sweeps them.\n` : ''));
    return 0;
  }

  if (runner) {
    // Signal short writers gently; a live cell may contain work that needs recovery.
    if (!cells.length && (prev.role === 'confirm' || prev.role === 'init')) {
      console.log(`  a ${prev.role === 'confirm' ? 'decision' : 'board replacement'} is being written on this graph` +
                  ` (pid ${prev.pid}). Nothing to signal; it lands or fails on its own. Retry in a moment.\n`);
      return 10;
    }
    if (!cells.length && prev.role === 'gate') {
      console.log(`  pid ${prev.pid} is gating this board: no cells, nothing spending, but writers are blocked.` +
                  `\n  Stop does not interrupt gates; kill pid ${prev.pid} on this machine if it must die. ` +
                  `Gates keep no partial state.\n`);
      return 10;
    }
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
