#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, selectBoard, selfCommand } from './lib/cli-config.mjs';
import { writeBoard } from './lib/board-write.mjs';
import { detectCheck } from './lib/check-detect.mjs';
import { findCycle, showCycle } from './lib/dag.mjs';

const root = import.meta.dirname;
const cwd = process.env.OSTOYAE_CWD || process.cwd();
const command = process.argv[2];
const args = process.argv.slice(3);
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const fail = message => { throw new Error(`${message}. Nothing written.`); };
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function parse() {
  const valued = command === 'add' ? ['--check', '--needs', '--id', '--board'] : ['--label', '--limit', '--check', '--board', '--repo'];
  const flags = command === 'import' ? ['--dry-run', '--any-author'] : [];
  const options = {}, positions = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.includes(a)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || !value.trim()) fail(`${a} needs a value`);
      if (a === '--label') (options.label ??= []).push(value);
      else if (options[a.slice(2)] !== undefined) fail(`${a} was supplied twice`);
      else options[a.slice(2)] = value;
    } else if (flags.includes(a)) {
      if (options[a.slice(2)] !== undefined) fail(`${a} was supplied twice`);
      options[a.slice(2)] = true;
    }
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else positions.push(a);
  }
  return { options, positions };
}
function selected(options, boardArg) {
  if (options.board && boardArg) fail('select one board using its path or --board');
  const file = selectBoard(options.board ?? boardArg, cwd, root);
  if (!file) fail('no board selected; run ostoyae init or pass --board');
  return file;
}
function nextId(board, what, used) {
  const numbered = board.work.map(w => /^w-(\d+)$/.exec(w.id)).filter(Boolean);
  if (numbered.length) {
    const width = Math.max(...numbered.map(m => m[1].length));
    for (let n = Math.max(...numbered.map(m => Number(m[1]))) + 1; ; n++) {
      const id = `w-${String(n).padStart(width, '0')}`;
      if (!used.has(id)) return id;
    }
  }
  const base = `w-${slug(what.split(/\s+/).slice(0, 4).join(' ')) || 'item'}`.slice(0, 40).replace(/-$/, '');
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
function add(options, positions) {
  const boardArg = positions[0]?.endsWith('.json') && (positions.length > 1 || existsSync(resolve(cwd, positions[0]))) ? positions.shift() : null;
  if (positions.length > 1) fail(`unexpected argument ${positions[1]}`);
  const file = selected(options, boardArg);
  if (!existsSync(file)) fail(`board not found: ${file}`);
  const input = positions[0] === undefined && !process.stdin.isTTY ? readFileSync(0, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) : positions;
  if (!input.length) fail('add needs a work item or non-empty stdin lines');
  if (options.id && input.length !== 1) fail('--id needs exactly one work item');
  const needs = options.needs === undefined ? [] : options.needs.split(',').map(s => s.trim());
  if (needs.some(s => !s)) fail('--needs needs comma-separated ids');
  return writeBoard(file, 'add', board => {
    const used = new Set(board.work.map(w => w.id));
    for (const id of needs) if (!used.has(id)) fail(`unknown dependency ${id}`);
    const ids = [];
    for (const what of input) {
      const id = options.id ?? nextId(board, what, used);
      if (used.has(id)) fail(`duplicate id ${id}`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(`invalid id ${id}`);
      used.add(id); ids.push(id);
      board.work.push({ id, what, needs, ...(options.check ? { check: options.check } : {}) });
    }
    // New items only need items already on the board, so this cannot fire today; it is here so
    // a later change to how `add` takes needs cannot quietly put a loop on the board.
    const cycle = findCycle(board);
    if (cycle?.some(id => ids.includes(id))) fail(`dependency cycle: ${showCycle(cycle)}`);
    return { write: true, ids };
  }).then(result => console.log(`  added ${result.ids.join(', ')}\n  next: ${selfCommand(root)} go ${quote(file)} --invocations 3`));
}
function githubRemote(repo, ownerRepo) {
  const origin = tryGit(repo, ['remote', 'get-url', 'origin']);
  const remotes = origin ? [origin] : (tryGit(repo, ['remote', '-v']) ?? '').split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean);
  const github = remotes.map(url => /(?:github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase()).filter(Boolean);
  if (github.length && !github.includes(ownerRepo.toLowerCase())) fail(`GitHub remote is ${github.join(', ')}, not ${ownerRepo}; pass --repo for the right checkout`);
}
function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
// Issue text becomes agent instructions and the agent's code runs as the check, so by default
// only people with push access to the repository can put work on the board.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
async function issues(ownerRepo, labels, limit, anyAuthor) {
  const api = process.env.OSTOYAE_GITHUB_API ?? 'https://api.github.com';
  const base = new URL(api);
  let url = new URL(`repos/${ownerRepo}/issues`, base.href.replace(/\/?$/, '/'));
  url.search = new URLSearchParams({ state: 'open', labels: labels.join(','), per_page: String(Math.min(100, limit)) }).toString();
  const auth = token(), found = [], skipped = [];
  while (url && found.length < limit) {
    let response;
    try { response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ostoyae', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }); }
    catch (e) { fail(`GitHub network error: ${e.message}`); }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const reset = response.headers.get('x-ratelimit-reset');
      const when = reset && Number.isFinite(Number(reset)) ? `; resets ${new Date(Number(reset) * 1000).toISOString()}` : '';
      const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail?.message ?? '');
      fail(`GitHub HTTP ${response.status}${limited ? ` (rate limit${when})` : ''}${response.status === 404 ? ` for ${ownerRepo}` : ''}`);
    }
    let page;
    try { page = await response.json(); }
    catch { fail('GitHub returned malformed JSON'); }
    if (!Array.isArray(page)) fail('GitHub returned malformed JSON');
    for (const issue of page) {
      if (!issue || typeof issue !== 'object' || !Number.isSafeInteger(issue.number) || typeof issue.title !== 'string' || typeof issue.html_url !== 'string' || typeof issue.updated_at !== 'string') fail('GitHub returned malformed issue JSON');
      if (issue.pull_request) continue;
      if (!anyAuthor && !TRUSTED.has(issue.author_association)) { skipped.push(issue); continue; }
      found.push(issue);
      if (found.length === limit) break;
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    url = next ? new URL(next, url) : null;
    if (url && url.origin !== base.origin) fail('GitHub pagination pointed to another host');
  }
  return { found, skipped };
}
async function closedIssues(ownerRepo, board, fetched) {
  if (!board) return new Set();
  const open = new Set(fetched.map(issue => issue.number));
  const missing = board.work.filter(item => item.source?.kind === 'github' &&
    item.source.repo.toLowerCase() === ownerRepo.toLowerCase() && !open.has(item.source.number));
  const closed = new Set(), auth = token();
  const api = (process.env.OSTOYAE_GITHUB_API ?? 'https://api.github.com').replace(/\/?$/, '/');
  for (const item of missing) {
    let response;
    try { response = await fetch(new URL(`repos/${ownerRepo}/issues/${item.source.number}`, api), { headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'ostoyae', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }); }
    catch (e) { fail(`GitHub network error: ${e.message}`); }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const reset = response.headers.get('x-ratelimit-reset');
      const when = reset && Number.isFinite(Number(reset)) ? `; resets ${new Date(Number(reset) * 1000).toISOString()}` : '';
      const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail?.message ?? '');
      fail(`GitHub HTTP ${response.status}${limited ? ` (rate limit${when})` : ''} for issue #${item.source.number}`);
    }
    let issue;
    try { issue = await response.json(); } catch { fail('GitHub returned malformed JSON'); }
    if (!issue || issue.number !== item.source.number || !['open', 'closed'].includes(issue.state)) fail('GitHub returned malformed issue JSON');
    if (issue.state === 'closed') closed.add(item.id);
  }
  return closed;
}
function issueItem(issue, ownerRepo, check) {
  const body = typeof issue.body === 'string' ? issue.body : '';
  const clipped = body.length > 4000 ? `${body.slice(0, 4000)}\n[Body truncated to 4,000 characters.]` : body;
  return { id: `gh-${issue.number}`, what: `Fix GitHub issue #${issue.number}: ${issue.title}\n\n${clipped}\n\nIssue: ${issue.html_url}\n\nAdd a regression test that reproduces this bug before fixing it.`, needs: [],
    ...(check ? { check } : {}), source: { kind: 'github', repo: ownerRepo, number: issue.number, url: issue.html_url, updated_at: issue.updated_at } };
}
async function importGithub(options, positions) {
  if (positions[0] !== 'github' || positions.length !== 2 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(positions[1])) fail('use ostoyae import github OWNER/REPO');
  const ownerRepo = positions[1];
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if ((options.limit !== undefined && !/^\d+$/.test(options.limit)) || !Number.isSafeInteger(limit) || limit < 1) fail('--limit needs a positive integer');
  const repo = tryGit(resolve(cwd, options.repo ?? '.'), ['rev-parse', '--show-toplevel']);
  if (!repo) fail('--repo must point to a git checkout');
  githubRemote(repo, ownerRepo);
  const file = selectBoard(options.board, cwd, root) ?? resolve(cwd, 'ostoyae.json');
  const hadBoard = existsSync(file);
  if (hadBoard && resolve(readBoard(file).sandbox?.repo ?? '') !== resolve(repo)) fail(`board ${file} belongs to another repository`);
  const { found: fetched, skipped } = await issues(ownerRepo, options.label ?? ['bug'], limit, options['any-author'] === true);
  const closed = await closedIssues(ownerRepo, hadBoard ? readBoard(file) : null, fetched);
  if (!options.check) detectCheck(repo);
  let created = false;
  if (!hadBoard && !options['dry-run']) {
    const made = spawnSync('node', [fileURLToPath(new URL('./init.mjs', import.meta.url)), file, '--repo', repo], { cwd: root, env: process.env, encoding: 'utf8' });
    if (made.status !== 0) fail(`could not create board: ${made.stderr.trim()}`);
    created = true;
  }
  const report = board => {
    const chosen = options.check ? { value: options.check, via: '--check' }
      : board.judge?.default_check ? { value: board.judge.default_check, via: 'board default check' }
      : (() => { const value = detectCheck(repo); return { value, via: value ? 'detected from repository' : 'none' }; })();
    const byId = new Map(board.work.map(w => [w.id, w]));
    const counts = { added: [], updated: [], unchanged: [], attempted: [], closed: [] };
    for (const issue of fetched) {
      const item = issueItem(issue, ownerRepo, chosen.via === 'board default check' ? null : chosen.value);
      const old = byId.get(item.id);
      if (!old) { board.work.push(item); byId.set(item.id, item); counts.added.push(item.id); continue; }
      if (old.source?.kind !== 'github' || old.source.repo.toLowerCase() !== ownerRepo.toLowerCase() || old.source.number !== issue.number) fail(`id ${item.id} already belongs to another item`);
      if (board.attempts.some(a => a.of === item.id)) { counts.attempted.push(item.id); continue; }
      if (old.source.updated_at !== item.source.updated_at || old.what !== item.what ||
          (chosen.via !== 'board default check' && chosen.value && old.check !== chosen.value)) {
        old.what = item.what; old.source = item.source;
        if (chosen.via !== 'board default check' && chosen.value) old.check = chosen.value;
        counts.updated.push(item.id);
      } else counts.unchanged.push(item.id);
    }
    counts.closed.push(...closed);
    return { write: !options['dry-run'] && (counts.added.length > 0 || counts.updated.length > 0), counts, chosen };
  };
  let result;
  try {
    result = options['dry-run'] ? report(hadBoard ? structuredClone(readBoard(file)) : { work: [], attempts: [], judge: null })
      : await writeBoard(file, 'import', report);
  } catch (e) {
    if (created) throw Object.assign(new Error(`${e.message} Board created at ${file}; 0 issues written.`), { exitCode: e.exitCode });
    throw e;
  }
  const { counts, chosen } = result;
  console.log(`  ${options['dry-run'] ? 'dry run: ' : ''}${counts.added.length} added, ${counts.updated.length} updated, ${counts.unchanged.length} unchanged, ${counts.attempted.length} left alone after attempts`);
  if (counts.added.length) console.log(`  added: ${counts.added.join(', ')}`);
  if (counts.updated.length) console.log(`  updated: ${counts.updated.join(', ')}`);
  if (counts.attempted.length) console.log(`  attempted: ${counts.attempted.join(', ')}`);
  if (counts.closed.length) console.log(`  closed, kept on board: ${counts.closed.join(', ')}`);
  if (skipped.length) console.log(`  skipped ${skipped.length} issue(s) from people without push access: ${skipped.map(i => `#${i.number}`).join(', ')}. Review them, then pass --any-author to include them.`);
  console.log(`  check: ${chosen.value ?? 'none'} (${chosen.via})`);
  if (!chosen.value) console.log('  Nothing can land until a check exists. Set one with ostoyae import github OWNER/REPO --check CMD or add work[].check.');
  console.log(`  next: ${selfCommand(root)} go ${quote(file)} --invocations 3`);
}
try {
  const { options, positions } = parse();
  if (command === 'add') await add(options, positions);
  else if (command === 'import') await importGithub(options, positions);
  else fail(`unknown ingest command ${command}`);
} catch (e) { console.error(`  ${e.message.endsWith('Nothing written.') || e.message.endsWith('issues written.') ? e.message : `${e.message} Nothing written.`}`); process.exitCode = e.exitCode ?? 2; }
