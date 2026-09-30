// Land the board trunk onto its base only by fast-forward. Refuse dirty or active checkouts and report the merge command for manual resolution.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { shellQuote, cellEnvironment } from './providers.mjs';
import { checkTree } from '../sandbox.mjs';
import { derive } from '../viewer/state.mjs';
import { cycleIn, showCycle } from './dag.mjs';

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };
const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'git failed';

export const trunkName = (graph) => `ost/${graph}/trunk`;

// What the trunk holds relative to the base. Never throws for a board with no sandbox or no
// trunk yet; those are states, not errors.
export function trunkReport(board) {
  const trunk = trunkName(board.graph);
  const repo = board.sandbox?.repo ? resolve(board.sandbox.repo) : null;
  const base = typeof board.sandbox?.base === 'string' ? board.sandbox.base : null;
  const out = { trunk, repo, base, exists: false, base_is_branch: false, commits_ahead: 0, fast_forward: false };
  if (!repo || !base || !existsSync(repo)) return out;
  out.exists = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${trunk}`]) !== null;
  out.base_is_branch = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]) !== null;
  if (!out.exists) return out;
  const baseRef = out.base_is_branch ? `refs/heads/${base}` : base;
  out.commits_ahead = Number(tryGit(repo, ['rev-list', '--count', `${baseRef}..refs/heads/${trunk}`]) ?? 0);
  out.fast_forward = tryGit(repo, ['merge-base', '--is-ancestor', baseRef, `refs/heads/${trunk}`]) !== null;
  return out;
}

// The worktree that has `branch` checked out, or null when none does.
function checkedOutAt(repo, branch) {
  const list = tryGit(repo, ['worktree', 'list', '--porcelain']) ?? '';
  let path = null;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// The command a person runs to merge by hand, from where it has to run.
function manualMerge(repo, base, trunk, at) {
  return at ? `cd ${shellQuote(at)} && git merge ${shellQuote(trunk)}`
    : `cd ${shellQuote(repo)} && git switch ${shellQuote(base)} && git merge ${shellQuote(trunk)}`;
}

// Returns { ok, code, lines }. Code 0 landed or nothing to land, 1 refused.
export function land(board, { runnerFile = false } = {}) {
  const r = trunkReport(board);
  const lines = [];
  const refuse = (...why) => ({ ok: false, code: 1, lines: [...lines, ...why], report: r });
  if (!r.repo) return refuse('This board has no sandbox.repo, so there is no branch to land.');
  if (!existsSync(r.repo)) return refuse(`Repository ${r.repo} does not exist on this machine.`);
  if (!r.exists) return { ok: true, code: 0, lines: [`Nothing to land: ${r.trunk} does not exist yet. No attempt has finished.`], report: r };
  if (!r.commits_ahead) return { ok: true, code: 0, lines: [`Nothing to land: ${r.base} already has everything on ${r.trunk}.`], report: r };
  lines.push(`${r.trunk} is ${r.commits_ahead} commit(s) ahead of ${r.base} in ${r.repo}.`);
  if (runnerFile) return refuse('A runner file sits beside this board, so a run may still be merging into the trunk.',
    'Wait for it to finish (ostoyae status), then run land again. Nothing changed.');
  if (!r.base_is_branch) return refuse(`The board's base ${r.base} is a commit, not a branch, so there is no branch to move.`,
    `Take the work with: git -C ${shellQuote(r.repo)} merge ${shellQuote(r.trunk)}  (from the branch you want it on)`);
  const at = checkedOutAt(r.repo, r.base);
  const manual = manualMerge(r.repo, r.base, r.trunk, at);
  if (!r.fast_forward) return refuse(`${r.base} has moved since the run started, so this is not a fast-forward.`,
    'Land refuses anything but a fast-forward. Merge it yourself and resolve what git reports:', `  ${manual}`);
  if (at) {
    const dirty = tryGit(at, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty === null) return refuse(`Could not read the state of ${at}.`, `  ${manual}`);
    if (dirty) return refuse(`${at} has uncommitted changes to tracked files:`,
      ...dirty.split('\n').slice(0, 10).map((l) => `  ${l}`),
      'Commit or stash them, then run land again, or merge yourself:', `  ${manual}`);
    try { git(at, ['merge', '--ff-only', '--quiet', `refs/heads/${r.trunk}`]); }
    catch (e) { return refuse(`git refused the fast-forward: ${firstLine(e)}`, 'Nothing changed. Merge yourself:', `  ${manual}`); }
  } else {
    // Not checked out anywhere: fetch into the branch. Without a leading `+` git refuses any
    // update that is not a fast-forward, so this cannot rewrite history either.
    try { git(r.repo, ['fetch', '--quiet', '.', `refs/heads/${r.trunk}:refs/heads/${r.base}`]); }
    catch (e) { return refuse(`git refused the fast-forward: ${firstLine(e)}`, 'Nothing changed. Merge yourself:', `  ${manual}`); }
  }
  const head = git(r.repo, ['rev-parse', '--short', `refs/heads/${r.base}`]);
  lines.push(`Landed: ${r.base} fast-forwarded to ${head}${at ? ` in ${at}` : ''}.`,
    `${r.trunk} and its worktrees are left in place. Nothing was deleted.`);
  return { ok: true, code: 0, lines, report: { ...r, landed: head } };
}

// Rebuild one item's recorded commits on the base, then judge that branch in a fresh tree.
export async function landItem(board, id, { runnerFile = false } = {}) {
  const repo = board.sandbox?.repo, base = board.sandbox?.base;
  const branch = `ostoyae/${id}`;
  const lines = [];
  const out = (ok, message) => ({ ok, code: ok ? 0 : 1, lines: [...lines, message], report: { branch, base, repo, dependencies: dependencies ?? [] } });
  let dependencies = [];
  if (!repo || !base) return out(false, 'This board needs sandbox.repo and sandbox.base. Nothing changed.');
  if (runnerFile) return out(false, 'A runner file sits beside this board. Wait for it to finish. Nothing changed.');
  if (!board.work.some(w => w.id === id)) return out(false, `Unknown item ${id}. Nothing changed.`);
  const state = derive(board, { index: true });
  const itemState = state.stateOf(id);
  if (itemState !== 'done') return out(false, `${id} is ${itemState}, not done. Nothing changed.`);
  if (!tryGit(repo, ['check-ref-format', '--branch', branch])) return out(false, `Invalid branch name ${branch}. Nothing changed.`);
  if (tryGit(repo, ['show-ref', '--verify', `refs/heads/${branch}`]) !== null) return out(false, `${branch} already exists. Nothing changed.`);
  const baseCommit = tryGit(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!baseCommit) return out(false, `Base ${base} is missing. Nothing changed.`);
  const cycle = cycleIn([id], state.needsOf);
  if (cycle) return out(false, `dependency cycle: ${showCycle(cycle)}. Nothing changed.`);
  const ordered = [], seen = new Set();
  const visit = workId => {
    if (seen.has(workId)) return;
    seen.add(workId);
    for (const need of state.needsOf(workId)) visit(need);
    ordered.push(workId);
  };
  visit(id);
  const selected = [], included = [], picked = new Set();
  for (const workId of ordered) {
    if (state.stateOf(workId) !== 'done') return out(false, `Dependency ${workId} is ${state.stateOf(workId)}. Nothing changed.`);
    const attempts = state.proveAttemptsOf(workId).filter(a => a.state === 'done');
    if (attempts.length !== 1) return out(false, `${workId} has ${attempts.length} done prove attempts; its commits cannot be attributed uniquely. Nothing changed.`);
    const a = attempts[0], start = a.sandbox?.start_commit, end = a.sandbox?.end_commit;
    if (!start || !end || a.sandbox?.start_conflicts?.length) return out(false, `${workId} has no clean recorded commit range. Nothing changed.`);
    if (tryGit(repo, ['merge-base', '--is-ancestor', start, end]) === null) return out(false, `${workId} has a broken commit range. Nothing changed.`);
    const range = tryGit(repo, ['rev-list', '--reverse', '--topo-order', `${start}..${end}`]);
    if (range === null) return out(false, `${workId} commits cannot be read. Nothing changed.`);
    let added = 0;
    for (const commit of range.split('\n').filter(Boolean)) {
      const parents = git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ');
      if (parents.length !== 2) return out(false, `${workId} contains a merge commit that cannot be separated. Nothing changed.`);
      if (tryGit(repo, ['merge-base', '--is-ancestor', commit, baseCommit]) !== null || picked.has(commit)) continue;
      selected.push({ workId, commit }); picked.add(commit); added++;
    }
    if (workId !== id && added) included.push(workId);
  }
  dependencies = included;
  if (!selected.length) return out(false, `${id} and its dependencies have no commits outside ${base}. No PR branch created.`);
  const root = resolve(board.sandbox.root ?? join(repo, '..', 'ostoyae-worktrees'));
  const path = join(root, board.graph, '_land', `${id}-${process.pid}`);
  let madeBranch = false, madeTree = false, check = null, result;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    git(repo, ['branch', branch, baseCommit]); madeBranch = true;
    git(repo, ['worktree', 'add', '--quiet', path, branch]); madeTree = true;
    for (const { workId, commit } of selected) {
      try { git(path, ['cherry-pick', '--quiet', commit]); }
      catch (e) { throw new Error(`${workId} commit ${commit.slice(0, 12)} does not apply cleanly on ${base}: ${firstLine(e)}`); }
    }
    const item = state.workOf(id);
    const cmd = item.check ?? (board.judge?.default_check ? board.judge.default_check.replaceAll('{id}', id) : null);
    if (!cmd) throw new Error(`${id} has no check; set work[].check or judge.default_check before landing`);
    check = checkTree(board.sandbox, board.graph, { id: `_land-${id}-${process.pid}`, sandbox: { branch } });
    const checked = await new Promise(resolve => {
      const env = { ...cellEnvironment(board.sandbox.env_passthrough ?? []), OSTOYAE_ATTEMPT: `_land-${id}`, OSTOYAE_WORK: id,
        OSTOYAE_BRANCH: branch, OSTOYAE_WORKTREE: check.path, OSTOYAE_CHECK_TREE: check.path,
        OSTOYAE_TRUNK: trunkName(board.graph), OSTOYAE_GRAPH: board.graph };
      const child = spawn(cmd, { shell: true, cwd: check.path, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      child.stdout.on('data', b => tail = (tail + b).slice(-2000));
      child.stderr.on('data', b => tail = (tail + b).slice(-2000));
      child.on('close', code => resolve({ code, tail }));
      child.on('error', e => resolve({ code: null, tail: e.message }));
    });
    if (checked.code !== 0) throw new Error(`check failed on ${branch} (exit ${checked.code}): ${cmd}${checked.tail ? `; ${checked.tail.trim().split('\n').slice(-1)[0]}` : ''}`);
    lines.push(`Created ${branch} from ${base} with ${selected.length} recorded commit(s).`);
    if (included.length) lines.push(`Dependencies included: ${included.join(', ')}.`);
    lines.push(`Check passed on a fresh worktree: ${cmd}`);
    const source = state.workOf(id).source, fixes = source?.kind === 'github' && Number.isSafeInteger(source.number) ? ` --body ${shellQuote(`Fixes #${source.number}`)}` : '';
    lines.push(`Open a PR: git -C ${shellQuote(repo)} push -u origin ${shellQuote(branch)} && gh pr create --base ${shellQuote(base)} --head ${shellQuote(branch)} --fill${fixes}`);
    result = { ok: true, code: 0, lines, report: { branch, base, repo, dependencies: included, commits: selected.length } };
    return result;
  } catch (e) {
    result = out(false, `${e.message}.`);
    return result;
  } finally {
    if (check) try { check.remove(); } catch (e) { result.lines.push(`Could not remove check worktree: ${e.message}`); }
    if (madeTree) tryGit(repo, ['worktree', 'remove', '--force', path]);
    if (madeBranch && !result.ok) {
      tryGit(repo, ['branch', '-D', branch]);
      result.lines.push(tryGit(repo, ['show-ref', '--verify', `refs/heads/${branch}`]) === null
        ? 'Branch removed.' : `Could not remove ${branch}; inspect it before retrying.`);
    }
  }
}
