#!/usr/bin/env node
// Per-node runtime capabilities (issue #6): declare, probe, park — zero model calls.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  catalogOf, requiresOf, profileOf, findEvidence, evidenceSatisfies, evidenceBlocks,
  ensureCapabilities, capabilityBlocks, codexSandboxArgs, doctorCapabilities, runCapabilityProbe,
} from '../lib/capabilities.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..');
let fails = 0;
const check = (n, c) => { console.log((c ? '  ok    ' : '  FAIL  ') + n); if (!c) fails++; };

console.log('== capabilities unit');

check('profileOf stamps Codex as codex/workspace-write',
  profileOf({ agent: 'codex' }) === 'codex/workspace-write');
check('profileOf stamps fake as host/fake',
  profileOf({ agent: 'fake' }) === 'host/fake');

const g0 = {
  sandbox: {
    capabilities: {
      'probe.fail': { what: 'always fails', probe: 'echo shmget denied >&2; exit 1' },
      'probe.ok': { what: 'always ok', probe: 'echo ok; exit 0' },
    },
  },
  work: [{ id: 'w-a', what: 'needs fail', requires: ['probe.fail'] }],
  attempts: [],
};
const cat = catalogOf(g0);
check('catalogOf keeps named probes', cat.has('probe.fail') && cat.has('probe.ok'));
check('requiresOf reads work[].requires', requiresOf(g0.work[0]).join() === 'probe.fail');

const failProbe = runCapabilityProbe({
  id: 'probe.fail', def: cat.get('probe.fail'), cwd: root, profile: 'host/fake',
});
check('failing probe returns fails', failProbe.ok === false && failProbe.state === 'fails');
check('failing probe keeps denial text', /shmget/i.test(failProbe.why));

const okProbe = runCapabilityProbe({
  id: 'probe.ok', def: cat.get('probe.ok'), cwd: root, profile: 'host/fake',
});
check('passing probe returns ok', okProbe.ok === true && okProbe.state === 'ok');

const args = codexSandboxArgs('true', { cwd: '/tmp' });
check('codexSandboxArgs is sandbox platform full-auto, no model',
  args[0] === 'sandbox' && args.includes('--full-auto') && !args.includes('exec') && !args.includes('--model'));

const wFail = { id: 'w-a', what: 'x', requires: ['probe.fail'] };
const rFail = ensureCapabilities(wFail, {
  g: g0, catalog: cat, profile: 'host/fake', cwd: root, today: () => 't0',
});
check('ensureCapabilities parks on failed probe', rFail?.state === 'fails' && capabilityBlocks(wFail));
check('failed probe is recorded as board evidence',
  (g0.sandbox.capability_evidence ?? []).some((e) => e.capability === 'probe.fail' && e.ok === false));

const gEv = {
  sandbox: {
    capabilities: { 'probe.fail': cat.get('probe.fail') },
    capability_evidence: [{
      capability: 'probe.fail', ok: false, where: 'cell', profile: 'codex/workspace-write',
      by: 'a-0001', of: 'w-foundation', at: 't', why: 'shmget denied',
    }],
  },
  work: [{ id: 'w-b', requires: ['probe.fail'] }],
  attempts: [],
};
const wEv = gEv.work[0];
const prior = findEvidence(gEv, 'probe.fail', 'codex/workspace-write');
check('findEvidence sees parent-owned cell failure', evidenceBlocks(prior) && !evidenceSatisfies(prior));
const rEv = ensureCapabilities(wEv, {
  g: gEv, catalog: catalogOf(gEv), profile: 'codex/workspace-write', cwd: root, today: () => 't1',
  runner: () => { throw new Error('must not probe when evidence already blocks'); },
});
check('parent cell failure parks without re-probing', rEv?.state === 'fails' && capabilityBlocks(wEv));

const gOkEv = {
  sandbox: {
    capabilities: { 'probe.ok': cat.get('probe.ok') },
    capability_evidence: [{
      capability: 'probe.ok', ok: true, where: 'cell', profile: 'codex/workspace-write',
      by: 'a-0002', of: 'w-foundation', at: 't', why: 'initdb ok',
    }],
  },
  work: [{ id: 'w-c', requires: ['probe.ok'] }],
  attempts: [],
};
const wOk = gOkEv.work[0];
const rOk = ensureCapabilities(wOk, {
  g: gOkEv, catalog: catalogOf(gOkEv), profile: 'codex/workspace-write', cwd: root, today: () => 't2',
  runner: () => { throw new Error('must not probe when evidence satisfies'); },
});
check('matching cell ok evidence satisfies without probing', rOk?.state === 'ok' && !capabilityBlocks(wOk));

const hostOk = {
  capability: 'probe.ok', ok: true, where: 'host', profile: 'codex/workspace-write', at: 't',
};
check('host ok does not satisfy a cell requirement', !evidenceSatisfies(hostOk));

const rows = [];
doctorCapabilities({
  sandbox: { capabilities: { 'probe.ok': { probe: 'true' } } },
  work: [{ id: 'w-x', requires: ['missing.cap'] }],
}, {
  ok: (n, d) => rows.push(['ok', n, d]),
  warn: (n, d) => rows.push(['warn', n, d]),
  bad: (n, d) => rows.push(['FAIL', n, d]),
});
check('doctor fails unknown requires ids',
  rows.some((r) => r[0] === 'FAIL' && r[1] === 'requires' && /missing\.cap/.test(r[2])));

console.log('== capabilities via run.mjs (fake executor, no model)');

const T = mkdtempSync(join(tmpdir(), 'ostoyae-cap-'));
const pursuit = join(T, 'pursuit');
mkdirSync(pursuit);
writeFileSync(join(pursuit, 'README'), 'x\n');
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: pursuit });
spawnSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'add', '-A'], { cwd: pursuit });
spawnSync('git', ['-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'start'], { cwd: pursuit });

const boardPath = join(T, 'board.json');
const board = {
  graph: 'cap-rehearse',
  concurrency: 1,
  max_attempts: 2,
  execution: { provider: 'fake' },
  sandbox: {
    repo: pursuit,
    root: join(T, 'wt'),
    base: 'main',
    port_base: 5190,
    capabilities: {
      'probe.fail': { what: 'shmget denial stand-in', probe: 'echo shmget denied >&2; exit 1' },
    },
  },
  work: [{ id: 'w-need', what: 'would burn tokens without preflight', requires: ['probe.fail'], check: 'true' }],
  edges: [],
  attempts: [],
};
writeFileSync(boardPath, JSON.stringify(board, null, 2) + '\n');

const run = spawnSync('node', [join(root, 'run.mjs'), boardPath, '--exec', `bash ${join(root, 'executors/fake.sh')}`,
  '--max-launches', '3'], { encoding: 'utf8', cwd: root });
const after = JSON.parse(readFileSync(boardPath, 'utf8'));
check('run parks capability failure with zero attempts',
  after.attempts.length === 0 && after.work[0].capability?.state === 'fails');
check('run log names the capability refusal',
  /capability/.test(run.stdout + run.stderr) && /not launched/.test(run.stdout + run.stderr));
check('board evidence recorded from the probe',
  (after.sandbox.capability_evidence ?? []).some((e) => e.capability === 'probe.fail' && e.ok === false));

// Parent evidence alone: no probe needed, still zero launches.
const board2Path = join(T, 'board2.json');
const board2 = {
  ...board,
  graph: 'cap-rehearse-ev',
  sandbox: {
    ...board.sandbox,
    root: join(T, 'wt2'),
    capability_evidence: [{
      capability: 'probe.fail', ok: false, where: 'cell', profile: 'host/fake',
      by: 'a-parent', of: 'w-foundation', at: 't', why: 'shmget denied by parent',
    }],
  },
  work: [{ id: 'w-child', what: 'inherits failure', requires: ['probe.fail'], check: 'true' }],
  attempts: [],
};
writeFileSync(board2Path, JSON.stringify(board2, null, 2) + '\n');
spawnSync('node', [join(root, 'run.mjs'), board2Path, '--exec', `bash ${join(root, 'executors/fake.sh')}`,
  '--max-launches', '2'], { encoding: 'utf8', cwd: root });
const after2 = JSON.parse(readFileSync(board2Path, 'utf8'));
check('parent evidence parks child with zero attempts',
  after2.attempts.length === 0 && after2.work[0].capability?.state === 'fails');
check('parent evidence was used (no second probe appended for the child)',
  (after2.sandbox.capability_evidence ?? []).filter((e) => e.of === 'w-child').length === 0);

const board3Path = join(T, 'board3.json');
const board3 = {
  graph: 'cap-rehearse-ok',
  concurrency: 1,
  max_attempts: 1,
  execution: { provider: 'fake' },
  sandbox: {
    repo: pursuit,
    root: join(T, 'wt3'),
    base: 'main',
    port_base: 5195,
    capabilities: {
      // Probe that would fail if evidence were ignored — proves we reused the ok record.
      'probe.ok': { what: 'ok', probe: 'echo should-not-run >&2; exit 1' },
    },
    capability_evidence: [{
      capability: 'probe.ok', ok: true, where: 'cell', profile: 'host/fake',
      by: 'a-parent', of: 'w-foundation', at: 't', why: 'ok',
    }],
  },
  work: [{ id: 'w-go', what: 'ready runtime', requires: ['probe.ok'], check: 'true' }],
  edges: [],
  attempts: [],
};
writeFileSync(board3Path, JSON.stringify(board3, null, 2) + '\n');
spawnSync('node', [join(root, 'run.mjs'), board3Path, '--exec', `bash ${join(root, 'executors/fake.sh')}`,
  '--max-launches', '2'], { encoding: 'utf8', cwd: root });
const after3 = JSON.parse(readFileSync(board3Path, 'utf8'));
check('satisfying evidence allows a launch without re-probing',
  after3.attempts.length >= 1
  && !(after3.sandbox.capability_evidence ?? []).some((e) => e.of === 'w-go'));

rmSync(T, { recursive: true, force: true });

console.log(fails ? `\n  ${fails} capability assertion(s) failed` : '\n  capability rehearsal passed');
process.exit(fails ? 1 : 0);
