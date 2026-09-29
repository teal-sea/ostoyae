#!/usr/bin/env node
// A remote ownership claim fences one campaign. Board and artifact refs publish together.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readBoard, resolveExecution } from './lib/cli-config.mjs';
import { captureIdentity, processOwner, canonicalPath } from './lib/process-identity.mjs';
import { cellAlive, cellPathOf, readRun } from './lib/liveness.mjs';
import { registerBoard } from './lib/boards.mjs';

const engine = import.meta.dirname;
const now = () => new Date().toISOString();
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
const atomic = (file, value) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n'); renameSync(temp, file);
};
function git(cwd, args, { input, allowFailure = false } = {}) {
  const r = spawnSync('git', ['-c', 'user.name=ostoyae campaign', '-c', 'user.email=campaign@ostoyae.invalid', ...args],
    { cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (!allowFailure && (r.error || r.status !== 0)) throw new Error(`git ${args[0]}: ${r.error?.message ?? r.stderr.trim()}`);
  return { ...r, text: r.stdout?.trim() ?? '' };
}
function refs(cwd, remote = false) {
  const text = git(cwd, remote ? ['ls-remote', '--heads', 'origin'] : ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/']).text;
  return Object.fromEntries(text.split('\n').filter(Boolean).map(line => { const [oid, ref] = line.trim().split(/\s+/); return [ref, oid]; }));
}
function parse(args) {
  const options = {}, run = [];
  const values = new Set(['--repo', '--board', '--branch', '--from', '--dir', '--agent', '--model', '--effort', '--profile']);
  const modes = new Set(['--check', '--publish-only']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (values.has(key)) {
      if (options[key] !== undefined) throw new Error(`${key} was supplied twice`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
      options[key] = value;
    } else if (modes.has(key)) options[key] = true;
    else run.push(key);
  }
  for (const key of ['--repo', '--board', '--branch']) if (!options[key]) throw new Error(`${key} is required`);
  const board = options['--board'];
  if (isAbsolute(board) || board.split(/[\\/]/).some(part => ['..', '.git', ''].includes(part)) || !board.endsWith('.json'))
    throw new Error('--board must be a repository-relative JSON path outside .git');
  const branch = options['--branch'];
  if (!/^(claude|codex)\//.test(branch) || branch.startsWith('claude/ostoyae-owners/'))
    throw new Error('--branch must start with claude/ or codex/ and cannot name an ownership ref');
  if (options['--check'] && options['--publish-only']) throw new Error('select --check or --publish-only, not both');
  const aliases = { '--invocations': '--max-invocations', '--launches': '--max-launches', '--usd': '--max-usd', '--output-tokens': '--max-output-tokens' };
  return { options, run: run.map(value => aliases[value] ?? value) };
}
function idle(journal, boardFile) {
  boardFile = canonicalPath(boardFile);
  if (journal.runner && processOwner(journal.runner.pid, { identity: journal.runner.identity, runnerFile: boardFile }) !== false)
    throw new Error('the previous runner is alive or unverified; ownership is retained');
  const r = readRun(boardFile.replace(/\.json$/, '') + '.run.json');
  if (r && processOwner(r.pid, { identity: r.identity, runnerFile: boardFile }) !== false)
    throw new Error('the board still has a live or unverified runner');
  const board = readBoard(boardFile);
  for (const attempt of board.attempts) if (attempt.state === 'running') {
    const path = cellPathOf(board, attempt);
    if (path && attempt.cell_pid && cellAlive(attempt.cell_pid, path, attempt.cell_identity, attempt.cell_group))
      throw new Error(`attempt ${attempt.id} is alive or unverified; ownership is retained`);
    throw new Error(`attempt ${attempt.id} has not settled; recover its existing cell before publishing, without starting a replacement`);
  }
}

export async function campaign(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('ostoyae campaign --repo URL --board PATH --branch codex/NAME --invocations N [--agent NAME]');
    console.log('  --dir PATH           local recovery directory, unique per campaign');
    console.log('  --check              restore and inspect, without running or publishing');
    console.log('  --publish-only       publish settled local work without launching a model');
    console.log('  --from BRANCH        source branch for the first firing');
    console.log('Owns one campaign remotely; independent campaigns remain concurrent. No claim expires automatically.');
    return 0;
  }
  const { options: o, run } = parse(args);
  const branch = o['--branch'], boardName = o['--board'], repo = o['--repo'];
  const key = createHash('sha256').update(`${repo}\n${branch}\n${boardName}`).digest('hex').slice(0, 16);
  const requestedDirectory = resolve(process.env.OSTOYAE_CWD || process.cwd(), o['--dir'] || process.env.OSTOYAE_CAMPAIGN_DIR || `.campaign/${key}`);
  mkdirSync(requestedDirectory, { recursive: true });
  const directory = realpathSync(requestedDirectory);
  const pursuit = join(directory, 'pursuit'), file = join(pursuit, boardName), record = join(directory, 'campaign.json');
  const say = (phase, text) => console.log(`  ${phase.padEnd(11)} ${text}`);
  let saved;
  const recovery = `ostoyae campaign --repo ${quote(repo)} --board ${quote(boardName)} --branch ${quote(branch)} --dir ${quote(directory)} --publish-only`;
  let journal, localClaim;
  const localStore = join(directory, '.owner.git'), localRef = 'refs/ostoyae/wrapper';
  const update = data => { Object.assign(journal, data, { beat: now() }); atomic(record, journal); };
  const fail = error => {
    if (journal) update({ phase: 'failed', error: error.message });
    console.error(`campaign: ${error.message}\n  recovery    ${directory}\n  next        ${recovery}`);
    if (journal?.runnerExit > 0) console.error(`campaign: runner exit ${journal.runnerExit} is preserved`);
    return journal?.runnerExit > 0 ? journal.runnerExit : 1;
  };
  try {
    // Git supplies an atomic compare-and-swap for local ownership as well as remote refs.
    // Reclaim only a wrapper whose process identity is positively gone, never a timed-out one.
    git(directory, ['init', '--bare', '-q', localStore]);
    const prior = git(localStore, ['rev-parse', '--verify', localRef], { allowFailure: true });
    if (prior.status === 0) {
      const owner = JSON.parse(git(localStore, ['cat-file', 'blob', prior.text]).text);
      if (processOwner(owner.pid, { identity: owner.identity }) !== false) throw new Error('this directory has a live or unverified campaign wrapper');
    }
    const claimBlob = git(localStore, ['hash-object', '-w', '--stdin'], {
      input: JSON.stringify({ pid: process.pid, identity: captureIdentity(process.pid), nonce: randomUUID() }),
    }).text;
    git(localStore, ['update-ref', localRef, claimBlob, prior.status === 0 ? prior.text : '']);
    localClaim = claimBlob;
    saved = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
    git(directory, ['check-ref-format', `refs/heads/${branch}`]);
    if (saved && (saved.repo !== repo || saved.branch !== branch || saved.board !== boardName || saved.directory !== directory))
      throw new Error('--dir belongs to a different campaign; use its recorded target or a separate directory');
    if (saved?.owner && processOwner(saved.owner.pid, { identity: saved.owner.identity }) !== false && saved.phase !== 'published')
      throw new Error('this local campaign directory is owned by a live or unverified wrapper');
    if (saved && saved.phase !== 'published' && !o['--publish-only'] && !o['--check'])
      throw new Error('unpublished local work exists; it was preserved. Inspect it and use --publish-only before running again');
    if (o['--publish-only']) {
      if (!saved?.claim) throw new Error('no local ownership record is available to recover');
      journal = { ...saved, owner: { pid: process.pid, identity: captureIdentity(process.pid) } };
      idle(journal, file);
      const after = readBoard(file).attempts.length;
      update({ after, recorded: after - journal.before });
    } else {
      if (saved && o['--check']) {
        say('check', `phase=${saved.phase}; ${saved.after ?? saved.before ?? 'unknown'} recorded session(s); no run or push`);
        if (saved.error) say('failure', saved.error);
        return 0;
      }
      if (existsSync(join(pursuit, '.git'))) {
        if (git(pursuit, ['config', '--get', 'remote.origin.url']).text !== repo) throw new Error('local pursuit origin differs from the requested repository; nothing overwritten');
        if (git(pursuit, ['status', '--porcelain']).text) throw new Error('local pursuit has uncommitted work; it was preserved');
        git(pursuit, ['fetch', '-q', '--prune', 'origin']);
      } else git(directory, ['clone', '-q', '--', repo, pursuit]);
      let remote = refs(pursuit, true);
      const boardRef = `refs/heads/${branch}`;
      const from = o['--from'];
      if (from) git(pursuit, ['check-ref-format', `refs/heads/${from}`]);
      const start = remote[boardRef] || (from ? remote[`refs/heads/${from}`] : git(pursuit, ['rev-parse', 'HEAD']).text);
      if (!start) throw new Error(`--from ${from} does not exist on origin`);
      git(pursuit, ['checkout', '-q', '-B', branch, start]);
      const inside = relative(realpathSync(pursuit), realpathSync(file));
      if (inside.startsWith('../') || isAbsolute(inside)) throw new Error('board path escapes its repository');
      let board = readBoard(file);
      const slug = board.graph.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const prefix = `refs/heads/ost/${slug}/`, trunkRef = `refs/heads/ost/${board.graph}/trunk`;
      git(pursuit, ['check-ref-format', trunkRef]);
      const lockRef = `refs/heads/claude/ostoyae-owners/${createHash('sha256').update(slug).digest('hex')}`;
      if (o['--check']) {
        say('check', `${board.attempts.length} session(s); ${remote[lockRef] ? 'owned, no competing launch permitted' : 'unowned'}; nothing run or pushed`);
        return 0;
      }
      // A claim is deliberately not a time lease: loss of contact never proves the cell stopped.
      const claim = git(pursuit, ['commit-tree', `${start}^{tree}`, '-p', start], {
        input: `Ostoyae campaign ownership ${randomUUID()}\n\n${JSON.stringify({ branch, board: boardName, started: now() })}\n`,
      }).text;
      const newJournal = { version: 1, repo, branch, board: boardName, directory, graph: board.graph, prefix, trunkRef,
        lockRef, claim, before: board.attempts.length, started: now(), phase: 'claiming',
        owner: { pid: process.pid, identity: captureIdentity(process.pid) } };
      // Exclusive creation also prevents two local wrappers racing before their remote claims.
      if (!saved) writeFileSync(record, JSON.stringify(newJournal) + '\n', { flag: 'wx' }); else atomic(record, newJournal);
      journal = newJournal;
      const claimResult = git(pursuit, ['push', '-q', `--force-with-lease=${lockRef}:`, 'origin', `${claim}:${lockRef}`], { allowFailure: true });
      if (claimResult.status !== 0) {
        journal = null; // Do not rewrite an existing owner's journal or imply this client owns the claim.
        throw new Error(`campaign ownership is locked or could not be established; no work launched. ${claimResult.stderr?.trim() ?? ''}`);
      }
      update({ phase: 'owned' }); say('ownership', `acquired for ${board.graph}`);
      // A preceding owner may have finished between the initial clone and our successful claim.
      git(pursuit, ['fetch', '-q', '--prune', 'origin']); remote = refs(pursuit, true);
      if (remote[lockRef] !== claim) throw new Error('remote ownership changed before restore');
      if (remote[boardRef]) git(pursuit, ['checkout', '-q', '-B', branch, remote[boardRef]]);
      board = readBoard(file);
      if (board.graph !== journal.graph) throw new Error('campaign graph changed while ownership was being acquired');
      update({ expected: remote, before: board.attempts.length });
      // Updating a checked-out ref alone leaves its index and files at the old revision.
      // Retire only clean worktrees owned by this recovery directory before restoring refs.
      const worktrees = git(pursuit, ['worktree', 'list', '--porcelain', '-z']).text.split('\0\0');
      for (const block of worktrees) {
        const fields = Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
          const at = line.indexOf(' '); return [line.slice(0, at), line.slice(at + 1)];
        }));
        const ref = fields.branch;
        if (!ref || !(ref.startsWith(prefix) || ref === trunkRef) || !remote[ref] || fields.HEAD === remote[ref]) continue;
        const path = fields.worktree, inside = relative(directory, realpathSync(path));
        if (inside.startsWith('../') || isAbsolute(inside)) throw new Error(`graph ref ${ref} is checked out outside this recovery directory`);
        if (git(path, ['status', '--porcelain']).text) throw new Error(`graph worktree ${path} has uncommitted work; it was preserved`);
        git(pursuit, ['worktree', 'remove', '--', path]);
      }
      for (const [ref, oid] of Object.entries(remote)) if (ref.startsWith(prefix) || ref === trunkRef) git(pursuit, ['update-ref', ref, oid]);
      board.sandbox = { ...board.sandbox, repo: pursuit, root: join(directory, 'worktrees') };
      atomic(file, board);
      registerBoard(file);
      say('restored', `${board.attempts.length} session(s), including earlier attempt branches and landed work`);
      const execution = resolveExecution(board, { agent: o['--agent'], model: o['--model'], effort: o['--effort'], profile: o['--profile'] }, process.env, engine);
      const runnerArgs = [...run];
      if (!runnerArgs.includes('--exec')) runnerArgs.push('--exec', execution.command);
      if (o['--model']) runnerArgs.push('--model', execution.model);
      if (o['--effort']) runnerArgs.push('--effort', execution.effort);
      if (!['--max-invocations', '--max-usd', '--max-output-tokens'].some(flag => Number(runnerArgs[runnerArgs.indexOf(flag) + 1]) > 0 && runnerArgs.includes(flag)))
        throw new Error('campaign needs a positive cumulative --invocations, --usd or --output-tokens cap');
      const output = join(directory, 'runner.log'), fd = openSync(output, 'w');
      const child = spawn(process.execPath, [join(engine, 'run.mjs'), file, ...runnerArgs],
        { cwd: engine, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      update({ phase: 'running', runner: { pid: child.pid, identity: child.pid ? captureIdentity(child.pid, { runnerFile: file }) : null } });
      let cursor = 0;
      const tail = () => { const text = readFileSync(output, 'utf8'); if (text.length > cursor) { process.stdout.write(text.slice(cursor)); cursor = text.length; } };
      const pulse = setInterval(() => { try { tail(); update({ after: readBoard(file).attempts.length }); } catch (e) { console.error(`campaign heartbeat: ${e.message}`); } }, 2000);
      const stop = () => { try { child.kill('SIGINT'); } catch (e) { console.error(`campaign stop: ${e.message}`); } };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      let rc;
      try { rc = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1))); }); }
      finally { clearInterval(pulse); process.off('SIGINT', stop); process.off('SIGTERM', stop); tail(); }
      const after = readBoard(file).attempts.length, count = after - journal.before;
      const text = readFileSync(output, 'utf8');
      const reasons = [...text.matchAll(/(?:the queue emptied:\s*(.+)|stopped at (.+?): \d+ launched,)/g)];
      const reason = reasons.at(-1)?.slice(1).find(Boolean) || 'unknown (runner recorded no current-run reason)';
      say('work', `${count} session(s) recorded this firing${count === 0 ? `; reason: ${reason}` : ''}`);
      update({ phase: 'settled', runnerExit: rc, after, recorded: count, reason });
      idle(journal, file);
    }
    // A lost success acknowledgement is resolved by the exact published refs before any retry.
    let remote = refs(pursuit, true);
    if (!remote[journal.lockRef] && journal.publish && Object.entries(journal.publish).every(([ref, oid]) => remote[ref] === oid)) {
      update({ phase: 'published' }); say('continuity', 'the exact settled record and artifacts were already published; no work repeated');
      return journal.runnerExit ?? 1;
    }
    if (remote[journal.lockRef] !== journal.claim) throw new Error('remote campaign ownership no longer matches this recovery record');
    git(pursuit, ['add', '--', boardName]);
    if (git(pursuit, ['diff', '--cached', '--quiet'], { allowFailure: true }).status === 1)
      git(pursuit, ['commit', '-qm', `campaign ${journal.graph}: ${readBoard(file).attempts.length} sessions on the record`, '--', boardName]);
    const local = refs(pursuit), boardRef = `refs/heads/${branch}`;
    const publish = Object.fromEntries(Object.entries(local).filter(([ref]) => ref === boardRef || ref === journal.trunkRef || ref.startsWith(journal.prefix)));
    if (!publish[boardRef]) throw new Error('local campaign branch is missing; nothing published');
    for (const [ref, oid] of Object.entries(publish)) {
      const old = journal.expected?.[ref];
      if (old && git(pursuit, ['merge-base', '--is-ancestor', old, oid], { allowFailure: true }).status !== 0)
        throw new Error(`ref ${ref} would discard earlier work; preserved locally for reconciliation`);
    }
    update({ phase: 'publishing', publish });
    const pushed = git(pursuit, ['push', '-q', '--atomic', `--force-with-lease=${journal.lockRef}:${journal.claim}`,
      ...Object.keys(publish).map(ref => `--force-with-lease=${ref}:${journal.expected?.[ref] ?? ''}`),
      'origin', ...Object.entries(publish).map(([ref, oid]) => `${oid}:${ref}`), `:${journal.lockRef}`], { allowFailure: true });
    remote = refs(pursuit, true);
    if (remote[journal.lockRef] || !Object.entries(publish).every(([ref, oid]) => remote[ref] === oid))
      throw new Error(`continuity FAILED: the atomic publication did not complete; ownership and local work are retained. ${pushed.stderr?.trim() ?? ''}`);
    update({ phase: 'published', finished: now() });
    say('continuity', `published board and ${Object.keys(publish).length - 1} artifact ref(s) together; ownership released; runner exit ${journal.runnerExit ?? 'unknown'}`);
    return journal.runnerExit ?? 1;
  } catch (e) { return fail(e); }
  finally {
    if (localClaim) {
      const released = git(localStore, ['update-ref', '-d', localRef, localClaim], { allowFailure: true });
      if (released.status !== 0) console.error(`campaign: local ownership release failed at ${localStore}; inspect before reusing this directory`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await campaign(process.argv.slice(2)); }
  catch (e) { console.error(`campaign: ${e.message}`); process.exitCode = 2; }
}
