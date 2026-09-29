import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Offering agents a mailbox is not enough: two real agents edited one file side by side, sent
// nothing, and the later one's work did not land. So the runner looks for them. Every few
// seconds, while messaging is on, it asks git what each running cell has changed since its own
// start commit, and tells both attempts when two of them have changed the same path.

// The runner's own files and compiled Python never count as a shared file. The contract is
// rewritten in every cell, so a repository that tracks AGENTS.md would otherwise pair everyone.
const RUNNER_OWNED = new Set(['AGENTS.md', 'CLAUDE.md']);
export const compiled = (path) => path.endsWith('.pyc') || path.split('/').includes('__pycache__');
const counts = (path) => path && !RUNNER_OWNED.has(path) && path !== '.ostoyae' && !path.startsWith('.ostoyae/') && !compiled(path);

// Tracked changes against the start commit (committed, staged or not) and new untracked files.
// Git plumbing on the worktree only; a cell being torn down just reads as nothing changed.
export function changedPaths(path, start) {
  if (!path || !start || !existsSync(path)) return [];
  const git = (args) => execFileSync('git', ['-C', path, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  try {
    const out = git(['diff', '--name-only', '-z', start, '--', '.', ':(exclude).ostoyae']) +
                git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).ostoyae']);
    return [...new Set(out.split('\0'))].filter(counts);
  } catch { return []; }
}

const peerLabel = (x, job) =>
  `${x.id} (job ${x.of}${job ? `: ${short(job, 80)}` : ''}; ${x.params?.agent ?? 'unknown agent'} · ${x.params?.model ?? 'provider default'})`;
export const short = (text, n = 100) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export const overlapText = (path, other, job) =>
  `You and ${peerLabel(other, job)} have both changed ${path}. ` +
  `Tell each other what you changed (ostoyae-msg send ${other.id} "..."), and keep to separate parts of the file. ` +
  `Whichever of you finishes later has its work merged on top of the earlier one's, ` +
  `so if you both change the same lines the later work will not land.`;

// One pass. `running` is the attempts in flight, each with its cell path; `told` is the set of
// pair-and-path keys already noticed, so each pair hears about each path once. Returns the
// notices to send; the caller writes them to the mailbox and adds their keys to `told`.
export function findOverlaps(running, told, jobOf = () => null) {
  const cells = running.filter((x) => x.path && x.start);
  if (cells.length < 2) return [];
  const changed = new Map(cells.map((x) => [x.attempt.id, new Set(changedPaths(x.path, x.start))]));
  const out = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const a = cells[i].attempt, b = cells[j].attempt;
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    for (const path of changed.get(a.id)) {
      if (!changed.get(b.id).has(path)) continue;
      const key = overlapKey(first.id, second.id, path);
      if (told.has(key)) continue;
      out.push({ key, path, to: first, other: second, text: overlapText(path, second, jobOf(second.of)) });
      out.push({ key, path, to: second, other: first, text: overlapText(path, first, jobOf(first.of)) });
    }
  }
  return out;
}

export const overlapKey = (a, b, path) => `${[a, b].sort().join('|')}|${path}`;
