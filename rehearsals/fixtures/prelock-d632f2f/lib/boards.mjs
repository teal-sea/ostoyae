// A machine-local index of board paths, never a second copy of their state.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readBoard, readJSON } from './cli-config.mjs';

export const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const indexDir = () => join(process.env.OSTOYAE_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ostoyae'), 'boards');

export function registerBoard(path) {
  const file = canonical(path);
  readBoard(file);
  const dir = indexDir(); mkdirSync(dir, { recursive: true });
  const entry = join(dir, createHash('sha256').update(file).digest('hex') + '.json');
  const temp = `${entry}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ file }) + '\n'); renameSync(temp, entry);
}

export function discoverBoards(cwd, root, explicit = []) {
  const paths = new Set(explicit.map(canonical)), errors = [];
  const dir = indexDir();
  if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try {
      const entry = readJSON(join(dir, name), 'board index');
      if (typeof entry.file !== 'string' || !entry.file) throw new Error('board index entry has no path');
      paths.add(canonical(entry.file));
    } catch (e) { errors.push({ file: join(dir, name), error: e.message }); }
  }
  const local = join(root, 'graph.local.json');
  if (existsSync(local)) {
    try {
      const entry = readJSON(local);
      if (typeof entry.graph !== 'string' || (entry.boards !== undefined && !Array.isArray(entry.boards))) throw new Error('invalid graph.local.json board index');
      for (const path of [entry.graph, ...(entry.boards ?? [])]) {
        if (typeof path !== 'string' || !path.trim()) throw new Error('board index contains an invalid path');
        paths.add(canonical(resolve(root, path)));
      }
    } catch (e) { errors.push({ file: local, error: e.message }); }
  }
  // Only inspect immediate siblings. No recursive filesystem scan or unrelated repo crawling.
  for (const directory of new Set([cwd, ...explicit.map(p => dirname(p))])) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter(n => n.endsWith('.json') && !/\.(run|live)\.json$/.test(n))) {
      const file = join(directory, name);
      try { const g = JSON.parse(readFileSync(file, 'utf8')); if (typeof g.graph === 'string' && Array.isArray(g.work)) paths.add(canonical(file)); }
      catch { /* Arbitrary JSON beside a board is not a registered board. */ }
    }
  }
  return { files: [...paths], errors };
}

// Exact task-text matches are leads for the orchestrating agent, not proof that tasks
// are interchangeable. No automatic cross-board dependency or acceptance is invented.
export function overlappingWork(boards) {
  const byText = new Map();
  for (const { file, board } of boards) for (const work of board.work) {
    if (work.status === 'rejected' || typeof work.what !== 'string' || !work.what.trim()) continue;
    const text = work.what.trim().replace(/\s+/g, ' ');
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push({ file, graph: board.graph, id: work.id });
  }
  return [...byText.entries()].filter(([, items]) => new Set(items.map(i => i.file)).size > 1)
    .map(([what, items]) => ({ what, items, basis: 'matching task text; equivalence not established' }));
}
