// A PID is an address, not an identity. Only signal a process whose birth record matches.
import { readFileSync, readlinkSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';

const read = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const command = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim(); }
  catch { return null; }
};
// Containers can expose a host /proc whose PID numbers do not describe this process namespace.
export function hasLocalProc() {
  try { return Number(readlinkSync('/proc/self')) === process.pid; } catch { return false; }
}
const localProc = hasLocalProc();
const boot = localProc ? read('/proc/sys/kernel/random/boot_id')
  : command('sysctl', ['-n', 'kern.boottime']);
// One spelling per file. realpath alone is not it: on a case-insensitive filesystem
// `Board.json` and `board.json` are the same board but different strings, and two writers
// starting under the two spellings derived different sidecars and verified past each other
// into the same record. Walk each component and take the on-disk case, so every alias of
// one file resolves to one string. Best-effort throughout: anything unreadable is kept as
// given, and on a case-sensitive filesystem the walk is the identity (every component
// matches exactly or the file is not there).
const sameOnDisk = (a, b) => {
  try {
    const sa = statSync(a), sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
};
export const resolveOnDiskCase = (abs, matches = sameOnDisk) => {
  const parts = abs.split('/');
  const out = parts[0] === '' ? [''] : [parts[0]];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const dir = out.join('/') || '/';
    let entries = null;
    try { entries = readdirSync(dir); } catch { entries = null; }
    if (entries && !entries.includes(part)) {
      const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
      if (hit !== undefined && matches(resolve(dir, part), resolve(dir, hit))) {
        out.push(hit); continue;
      }
    }
    out.push(part);
  }
  return out.join('/') || '/';
};
export const canonicalPath = (path) => {
  try { return resolveOnDiskCase(realpathSync(path)); }
  catch { /* missing: resolve what exists */ }
  try { return resolveOnDiskCase(resolve(realpathSync(dirname(resolve(path))), basename(resolve(path)))); }
  catch { return resolve(path); }
};
const canonical = (path) => canonicalPath(path);

// Filesystem-truthful identity: two paths naming one file are equal even when no string
// function can see it (exotic case-folding, hardlinks). Falls back to the canonical
// strings when either side cannot be statted.
export const sameFile = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (sameOnDisk(a, b)) return true;
  try { statSync(a); statSync(b); return false; }
  catch { return canonicalPath(a) === canonicalPath(b); }
};

// A sandbox can hide the process table: signalling a live PID then fails with ESRCH,
// the same error a truly dead process gives. The tinygrad A/B viewers, started from a
// sandboxed shell, read two live runners as gone for exactly this reason. Before reading
// ESRCH as dead, check the inspector can see anything at all: its own parent is
// necessarily alive, so ESRCH on the parent means this process is blind, and every
// verdict from it is unknown, never dead.
export function canSeeProcesses() {
  try { process.kill(process.ppid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
const deadOrBlind = () => canSeeProcesses() ? { status: 'dead' } : { status: 'unknown', identity: null };

export function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' };
  try { process.kill(pid, 0); }
  catch (e) { if (e.code === 'ESRCH') return deadOrBlind(); }
  if (localProc) {
    const stat = read(`/proc/${pid}/stat`);
    if (stat) {
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      if (['Z', 'X'].includes(fields[0])) return { status: 'dead' };
      const argv = (read(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
      let cwd = null;
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* permission denied: identity still available */ }
      return { status: 'alive', identity: boot && fields[19] ? { method: 'proc', pid, boot, start: fields[19] } : null,
        argv, command: argv.join(' '), cwd, pgid: Number(fields[2]), ppid: Number(fields[1]) };
    }
  }
  const ps = command('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'pgid=', '-o', 'ppid=', '-o', 'command=']);
  const match = ps?.match(/^(.{24})\s+(\S+)\s+(\d+)\s+(\d+)\s+([\s\S]*)$/);
  if (match) {
    if (/^[ZX]/.test(match[2])) return { status: 'dead' };
    return { status: 'alive', identity: boot ? { method: 'ps', pid, boot, start: match[1] } : null,
      argv: null, command: match[5], cwd: null, pgid: Number(match[3]), ppid: Number(match[4]) };
  }
  // Inability to inspect a live PID is neither a dead process nor permission to kill it.
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return deadOrBlind(); }
  return { status: 'unknown', identity: null };
}

// A detached leader can exit while its process group keeps working. Enumerate the group
// without sending a signal; an unreadable process table is explicitly unknown.
export function inspectProcessGroup(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return { status: 'dead', members: [] };
  const blindTomb = () => canSeeProcesses() ? { status: 'dead', members: [] } : { status: 'unknown', members: [] };
  try { process.kill(-pgid, 0); }
  catch (e) { if (e.code === 'ESRCH') return blindTomb(); }
  const table = command('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=']);
  if (table === null) return { status: 'unknown', members: [] };
  const members = [];
  let sawGroup = false, sawLive = false;
  for (const row of table.split('\n')) {
    if (!row.trim()) continue;
    const fields = row.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if (!fields) return { status: 'unknown', members };
    if (Number(fields[2]) !== pgid) continue;
    sawGroup = true;
    if (/^[ZX]/.test(fields[3])) continue;
    sawLive = true;
    const pid = Number(fields[1]), info = inspectProcess(pid);
    if (info.status !== 'dead' && (info.pgid === pgid || info.status === 'unknown')) members.push({ pid, ...info });
  }
  if (!members.length && !(sawGroup && !sawLive)) {
    try { process.kill(-pgid, 0); }
    catch (e) { if (e.code === 'ESRCH') return blindTomb(); }
    return { status: 'unknown', members };
  }
  return { status: members.some((m) => m.status === 'unknown') ? 'unknown' : members.length ? 'alive' : 'dead', members };
}

export function captureIdentity(pid, { cwd, runnerFile } = {}) {
  const identity = inspectProcess(pid).identity;
  return identity ? { ...identity, ...(cwd ? { cwd: canonical(cwd) } : {}),
    ...(runnerFile ? { runner_file: canonical(runnerFile) } : {}) } : null;
}
export function identityMatches(expected, actual) {
  return !!(expected?.boot && expected?.start && expected?.method && actual?.identity &&
    expected.pid === actual.identity.pid &&
    expected.boot === actual.identity.boot && expected.start === actual.identity.start &&
    expected.method === actual.identity.method);
}

// true: identified owner; false: gone/recycled; null: alive but unverifiable.
export function processOwner(pid, { identity, cwd, runnerFile } = {}) {
  const info = inspectProcess(pid);
  if (info.status === 'dead') return false;
  if (identity) {
    if (!identity.boot || !identity.start || !identity.method || !Number.isSafeInteger(identity.pid)) return null;
    if (!info.identity) return null;
    if (!identityMatches(identity, info)) return false;
    if (runnerFile && identity.runner_file) return sameFile(identity.runner_file, runnerFile);
    if (cwd && identity.cwd) return sameFile(identity.cwd, cwd);
    if (!runnerFile && !cwd) return true;
  }
  if (runnerFile) {
    if (info.argv?.length) {
      const script = info.argv.findIndex((arg) => /(?:^|\/)run\.mjs$/.test(arg));
      return script > 0 && info.argv.slice(script + 1).some((arg) =>
        sameFile(resolve(info.cwd ?? process.cwd(), arg), runnerFile));
    }
    // ps does not preserve argv boundaries. Legacy runfiles on such systems cannot establish
    // ownership safely. A known unrelated executable is still a definite mismatch.
    if (info.command && !/(?:^|\/)node(?:\s|$)/.test(info.command)) return false;
    return null;
  }
  if (cwd) {
    if (info.cwd) return sameFile(info.cwd, cwd);
    const lsof = command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const found = lsof?.split('\n').find((line) => line.startsWith('n'))?.slice(1);
    if (found) return sameFile(found, cwd);
  }
  return null;
}
