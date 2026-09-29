import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { readBoard } from './cli-config.mjs';
import { claimRunLock, lockPathOf, readRun, removeLock, removeOwnRunfile } from './liveness.mjs';
import { captureIdentity, processOwner } from './process-identity.mjs';

const busy = message => Object.assign(new Error(message), { exitCode: 1 });

export async function writeBoard(file, role, change) {
  const runfile = file.replace(/\.json$/, '') + '.run.json';
  const lock = lockPathOf(runfile);
  let prior;
  try { prior = readRun(runfile); } catch (e) { throw busy(`${e.message} Nothing written.`); }
  if (prior && processOwner(prior.pid, { identity: prior.identity, runnerFile: file }) !== false)
    throw busy(`pid ${prior.pid} is running this graph and would write over this change. Wait for it. Nothing written.`);
  const identity = captureIdentity(process.pid, { runnerFile: file });
  const started = new Date().toISOString();
  const claim = await claimRunLock(lock, { file, identity, started, role });
  if (!claim.claimed) throw busy(`pid ${claim.holder?.pid ?? 'unknown'} holds this graph's lock. Wait for it. Nothing written.`);
  try {
    let appeared;
    try { appeared = readRun(runfile); } catch (e) { throw busy(`${e.message} Nothing written.`); }
    if (appeared && processOwner(appeared.pid, { identity: appeared.identity, runnerFile: file }) !== false)
      throw busy(`pid ${appeared.pid} started on this graph. Wait for it. Nothing written.`);
    const tempRun = `${runfile}.${process.pid}.tmp`;
    writeFileSync(tempRun, JSON.stringify({ file, pid: process.pid, identity, started, beat: new Date().toISOString(), role }) + '\n');
    renameSync(tempRun, runfile);
    const board = readBoard(file);
    const result = change(board);
    if (result.write) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n');
      renameSync(tmp, file);
    }
    return result;
  } finally {
    removeOwnRunfile(runfile);
    removeLock(lock);
  }
}
