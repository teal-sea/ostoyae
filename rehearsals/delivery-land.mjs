// Landing useful checked work: whole board, per item, and every refusal in between.
// Real disposable git repositories, the scripted executor, real checks. No model calls.
//
//   node rehearsals/delivery-land.mjs      one line per assertion, exits non-zero on any failure
//
// The machine has no git identity (GIT_CONFIG_GLOBAL=/dev/null, as multiple-boards.mjs does):
// the runner writes its own author and committer into every cell commit, so landing must not be
// the one path that needs whatever happens to be configured on the host.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'bin/ostoyae');
const fake = `bash ${join(root, 'executors/fake.sh')}`;
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ostoyae-delivery-')));
const env = { ...process.env, OSTOYAE_STATE_DIR: join(temp, 'state'), OSTOYAE_NO_OPEN: '1', NO_COLOR: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
for (const key of ['OSTOYAE_CWD', 'OSTOYAE_GRAPH', 'OSTOYAE_EXEC', 'OSTOYAE_PORT']) delete env[key];

let checks = 0, failures = 0;
const test = (name, fn) => {
  checks++;
  try { fn(); console.log(`  ok ${checks}. ${name}`); }
  catch (error) { failures++; console.error(`  FAIL ${checks}. ${name}: ${error.message}`); }
};
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const gitStatus = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).status;
const ostoyae = (repo, ...args) => spawnSync(cli, args, { cwd: repo, env, encoding: 'utf8', timeout: 180000 });
const must = (repo, ...args) => {
  const r = ostoyae(repo, ...args);
  assert.equal(r.status, 0, `${args.join(' ')} exited ${r.status}\n${r.stdout}${r.stderr}`);
  return r;
};
const land = (repo, ...args) => {
  const r = ostoyae(repo, 'land', ...args, '--json');
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
  assert.ok(json, `land ${args.join(' ')} did not print JSON (exit ${r.status}): ${r.stdout}${r.stderr}`);
  assert.equal(r.status, json.exit_code, 'exit status disagrees with the JSON exit_code');
  return { status: r.status, json, said: json.messages.join('\n') };
};
const branch = (repo, name) => gitStatus(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`) === 0;
const readBoard = (repo) => JSON.parse(readFileSync(join(repo, 'ostoyae.json'), 'utf8'));

// A repository with a board on it. The board file stays untracked, as init leaves it.
// `init` derives the first item's id from its text, so later items refer to it as '@first'.
function pursuit(name, items) {
  const repo = join(temp, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.ostoyae/\n');
  writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'start');
  must(repo, 'init', '--exec', fake, '--item', items[0].what, '--check', items[0].check);
  const first = readBoard(repo).work[0].id;
  for (const item of items.slice(1)) {
    must(repo, 'add', 'ostoyae.json', item.what, '--id', item.id,
      ...(item.needs?.length ? ['--needs', item.needs.map(n => (n === '@first' ? first : n)).join(',')] : []),
      ...(item.check ? ['--check', item.check] : []));
  }
  return { repo, first };
}
const run = (repo, n = 6) => must(repo, 'go', 'ostoyae.json', '--invocations', String(n), '--headless');
const trunkOf = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ost/*/trunk');

try {
  /* ---------------------------------------------------------- the whole board */

  const whole = pursuit('whole', [{ what: 'Build alpha', check: 'test -f w-build-alpha.txt' }]);
  run(whole.repo, 2);
  const wholeTrunk = trunkOf(whole.repo);
  assert.ok(wholeTrunk, 'the run left no trunk branch');

  let landed = null;
  test('whole board: land fast-forwards the base and the work is on it', () => {
    const before = git(whole.repo, 'rev-parse', 'main');
    landed = land(whole.repo);
    assert.equal(landed.status, 0, landed.said);
    assert.equal(git(whole.repo, 'rev-parse', 'main'), git(whole.repo, 'rev-parse', wholeTrunk), 'main did not move to the trunk');
    assert.notEqual(before, git(whole.repo, 'rev-parse', 'main'));
    assert.match(git(whole.repo, 'show', 'main:w-build-alpha.txt'), /^fake work by a-\d+ on w-build-alpha$/);
    assert.ok(branch(whole.repo, wholeTrunk), 'land deleted the trunk branch');
  });

  test('whole board: landing again says there is nothing to land and exits 0', () => {
    const again = land(whole.repo);
    assert.equal(again.status, 0, again.said);
    assert.match(again.said, /Nothing to land/);
  });

  const dirty = pursuit('dirty', [{ what: 'Build alpha', check: 'test -f w-build-alpha.txt' }]);
  run(dirty.repo, 2);
  writeFileSync(join(dirty.repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  test('whole board: a dirty tracked base refuses, names the file, and moves nothing', () => {
    const before = git(dirty.repo, 'rev-parse', 'main');
    const refused = land(dirty.repo);
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /uncommitted changes/);
    assert.match(refused.said, /calc\.py/);
    assert.match(refused.said, /git merge/);
    assert.equal(git(dirty.repo, 'rev-parse', 'main'), before, 'main moved despite the refusal');
    assert.equal(readFileSync(join(dirty.repo, 'calc.py'), 'utf8'), 'def add(a, b):\n    return a + b\n', 'the local edit was touched');
  });

  const moved = pursuit('moved', [{ what: 'Build alpha', check: 'test -f w-build-alpha.txt' }]);
  run(moved.repo, 2);
  writeFileSync(join(moved.repo, 'other.txt'), 'later\n');
  git(moved.repo, 'add', 'other.txt'); git(moved.repo, 'commit', '-qm', 'moved on');
  test('whole board: a base that moved is not a fast-forward, so land refuses and prints the merge', () => {
    const before = git(moved.repo, 'rev-parse', 'main');
    const refused = land(moved.repo);
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /not a fast-forward/);
    assert.match(refused.said, new RegExp(`git merge '${trunkOf(moved.repo)}'`));
    assert.equal(git(moved.repo, 'rev-parse', 'main'), before, 'main moved despite the refusal');
  });

  /* ------------------------------------------------------- one item at a time */

  const board = pursuit('peritem', [
    { what: 'Build alpha', check: 'test -f w-build-alpha.txt' },
    { id: 'w-beta', what: 'Build beta on alpha', needs: ['@first'], check: 'test -f w-beta.txt && test -f w-build-alpha.txt' },
    { id: 'w-broken', what: 'Build broken', check: 'false' },
  ]);
  const alpha = board.first;
  run(board.repo, 6);
  const mainBefore = git(board.repo, 'rev-parse', 'main');
  const alphaCommit = git(board.repo, 'log', '--format=%H', '--all', '--grep', '^fake: w-build-alpha$').split('\n')[0];
  const betaCommit = git(board.repo, 'log', '--format=%H', '--all', '--grep', '^fake: w-beta$').split('\n')[0];
  assert.ok(alphaCommit && betaCommit, 'the run recorded no commits to land');

  let beta = null;
  test('per item: land <id> builds ostoyae/<id> from the base, including the dependency it needs', () => {
    beta = land(board.repo, 'w-beta');
    assert.equal(beta.status, 0, beta.said);
    assert.equal(beta.json.branch, 'ostoyae/w-beta');
    assert.equal(beta.json.base, 'main');
    assert.deepEqual(beta.json.dependencies, [alpha]);
    assert.ok(branch(board.repo, 'ostoyae/w-beta'), 'the branch it named does not exist');
    assert.match(git(board.repo, 'show', `ostoyae/w-beta:w-build-alpha.txt`), /^fake work by a-\d+ on w-build-alpha$/,
      "the dependency's content is missing from the branch");
    assert.match(git(board.repo, 'show', 'ostoyae/w-beta:w-beta.txt'), /^fake work by a-\d+ on w-beta$/);
    assert.match(beta.said, /Check passed on a fresh worktree/);
    assert.equal(git(board.repo, 'rev-list', '--count', 'main..ostoyae/w-beta'), '2',
      'the branch does not carry exactly the two recorded commits');
  });

  test('per item: the reported branch, commit count and authorship are what is in the repository', () => {
    assert.equal(beta.json.commits, 2);
    const subjects = git(board.repo, 'log', '--format=%s', '--reverse', 'main..ostoyae/w-beta').split('\n');
    assert.deepEqual(subjects, ['fake: w-build-alpha', 'fake: w-beta']);
    // cherry-pick keeps who wrote the work; only the committer is the machine that rebuilt it.
    assert.match(git(board.repo, 'log', '--format=%an <%ae>', '-1', 'ostoyae/w-beta'), /^fake a-\d+ <a-\d+@ostoyae\.invalid>$/);
    for (const commit of [alphaCommit, betaCommit]) {
      assert.equal(spawnSync('git', ['-C', board.repo, 'cat-file', '-e', commit], { env }).status, 0, `recorded commit ${commit} vanished`);
    }
    assert.equal(git(board.repo, 'rev-parse', 'main'), mainBefore, 'landing one item moved the base');
  });

  test('per item: no landing worktree or checked-out branch is left behind', () => {
    const trees = git(board.repo, 'worktree', 'list', '--porcelain');
    assert.doesNotMatch(trees, /_land/, `a landing worktree was left: ${trees}`);
    assert.equal(git(board.repo, 'branch', '--show-current'), 'main', 'the base is no longer the checked-out branch');
  });

  test('per item: landing the same item twice refuses, because the branch is already there', () => {
    const again = land(board.repo, 'w-beta');
    assert.equal(again.status, 1, again.said);
    assert.match(again.said, /already exists/);
    assert.ok(branch(board.repo, 'ostoyae/w-beta'), 'the refusal removed the branch it was protecting');
  });

  test('per item: a dependency lands on its own, without the dependent', () => {
    const alone = land(board.repo, alpha);
    assert.equal(alone.status, 0, alone.said);
    assert.deepEqual(alone.json.dependencies, []);
    assert.match(git(board.repo, 'show', `ostoyae/${alpha}:w-build-alpha.txt`), /^fake work by a-\d+ on w-build-alpha$/);
    assert.equal(git(board.repo, 'rev-list', '--count', `main..ostoyae/${alpha}`), '1');
    assert.notEqual(gitStatus(board.repo, 'cat-file', '-e', `ostoyae/${alpha}:w-beta.txt`), 0, 'the dependency branch carried the dependent work');
  });

  test('per item: an item that failed its check refuses, and no branch appears', () => {
    const refused = land(board.repo, 'w-broken');
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /w-broken is (exhausted|failed|blocked), not done/);
    assert.equal(branch(board.repo, 'ostoyae/w-broken'), false);
  });

  test('per item: work that has not run refuses', () => {
    must(board.repo, 'add', 'ostoyae.json', 'Build gamma later', '--id', 'w-gamma', '--needs', 'w-broken', '--check', 'true');
    const refused = land(board.repo, 'w-gamma');
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /w-gamma is \w+, not done/);
    assert.equal(branch(board.repo, 'ostoyae/w-gamma'), false);
  });

  test('per item: an unknown id refuses and changes no refs', () => {
    const before = git(board.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads');
    const refused = land(board.repo, 'nope');
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /Unknown item nope/);
    assert.equal(git(board.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'), before);
  });

  /* With an identity configured, that identity commits the rebuilt branch: the fallback is for
     machines without one, never an override of the person landing. */
  const named = pursuit('named', [{ what: 'Build alpha', check: 'true' }]);
  git(named.repo, 'config', 'user.name', 'Operator');
  git(named.repo, 'config', 'user.email', 'operator@example.invalid');
  run(named.repo, 2);
  test('per item: an operator identity is used as committer, and the original author is kept', () => {
    const landedHere = land(named.repo, named.first);
    assert.equal(landedHere.status, 0, landedHere.said);
    assert.equal(git(named.repo, 'log', '--format=%cn <%ce>', '-1', `ostoyae/${named.first}`), 'Operator <operator@example.invalid>');
    assert.match(git(named.repo, 'log', '--format=%an <%ae>', '-1', `ostoyae/${named.first}`), /^fake a-\d+ <a-\d+@ostoyae\.invalid>$/);
  });

  /* A check that fails on the freshly rebuilt branch must not leave a branch behind. */
  /* A base that moved onto the same lines: the work no longer applies, and the refusal has to say
     which paths collided rather than blame the commit for "not applying cleanly". */
  const clash = pursuit('conflict', [{ what: 'Build alpha', check: 'test -f w-build-alpha.txt' }]);
  run(clash.repo, 2);
  writeFileSync(join(clash.repo, 'w-build-alpha.txt'), 'someone else got here first\n');
  git(clash.repo, 'add', 'w-build-alpha.txt'); git(clash.repo, 'commit', '-qm', 'base took the same file');
  test('per item: commits that collide with a moved base are reported as a conflict on the paths', () => {
    const refused = land(clash.repo, clash.first);
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, /conflicts with main on w-build-alpha\.txt/);
    assert.doesNotMatch(refused.said, /unable to auto-detect email/);
    assert.equal(branch(clash.repo, `ostoyae/${clash.first}`), false);
    assert.doesNotMatch(git(clash.repo, 'worktree', 'list', '--porcelain'), /_land/);
  });

  const tight = pursuit('tightened', [{ what: 'Build tight', check: 'true' }]);
  run(tight.repo, 2);
  const tightBoard = readBoard(tight.repo);
  tightBoard.work[0].check = 'test -f never-written.txt';
  writeFileSync(join(tight.repo, 'ostoyae.json'), JSON.stringify(tightBoard, null, 2) + '\n');
  test('per item: a check that fails on the fresh tree refuses and removes the branch it made', () => {
    const refused = land(tight.repo, tight.first);
    assert.equal(refused.status, 1, refused.said);
    assert.match(refused.said, new RegExp(`check failed on ostoyae/${tight.first} \\(exit 1\\)`));
    assert.equal(branch(tight.repo, `ostoyae/${tight.first}`), false, 'a branch that failed its check was left behind');
    assert.doesNotMatch(git(tight.repo, 'worktree', 'list', '--porcelain'), /_land/);
  });

  test('per item: a refused landing leaves the base and the trunk exactly where they were', () => {
    assert.equal(git(tight.repo, 'rev-parse', 'main'), git(tight.repo, 'rev-parse', 'HEAD'));
    assert.ok(trunkOf(tight.repo), 'the trunk was deleted by a failed landing');
  });
} finally {
  if (failures || process.env.KEEP) console.log(`  kept ${temp}`);
  else rmSync(temp, { recursive: true, force: true });
}

console.log('');
if (failures) { console.error(`  delivery-land: ${failures} of ${checks} FAILED`); process.exitCode = 1; }
else console.log(`  delivery-land: ${checks} assertions, all passing`);
