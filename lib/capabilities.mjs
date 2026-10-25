// Named per-node runtime capabilities: declare what a cell must be able to start, probe it
// under the same sandbox profile the model shell will use, and refuse the launch before any
// model budget is spent when the known runtime cannot start.
//
// Distinct from board-level doctor tool presence checks and from sandbox.preflight (board prep
// under bare sh). A capability is profile-bound: host evidence does not satisfy a Codex cell,
// and a failed cell probe parks the node rather than widening permissions or reusing a DB.

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const statusOf = (x) => x?.status ?? 'active';

/** Catalog from `sandbox.capabilities`: id → { what, probe, timeout_ms? }. */
export function catalogOf(g) {
  const raw = g?.sandbox?.capabilities;
  if (!object(raw)) return new Map();
  const out = new Map();
  for (const [id, def] of Object.entries(raw)) {
    if (!id || !object(def)) continue;
    const probe = String(def.probe ?? '').trim();
    if (!probe) continue;
    out.set(id, {
      what: typeof def.what === 'string' ? def.what : '',
      probe,
      timeout_ms: Number(def.timeout_ms) > 0 ? Number(def.timeout_ms) : 20_000,
    });
  }
  return out;
}

export function requiresOf(w) {
  const xs = w?.requires;
  if (!Array.isArray(xs)) return [];
  return [...new Set(xs.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/** Profile stamp for evidence. Codex cells share workspace-write landlock/seatbelt. */
export function profileOf({ provider, agent } = {}) {
  const who = String(agent || provider || 'unknown').toLowerCase();
  if (who === 'codex') return 'codex/workspace-write';
  if (who === 'fake' || who === 'custom') return `host/${who}`;
  return `host/${who || 'sh'}`;
}

function normalizeEvidence(e) {
  if (!object(e) || !e.capability) return null;
  return {
    capability: String(e.capability),
    ok: e.ok === true,
    where: typeof e.where === 'string' ? e.where : 'cell',
    profile: typeof e.profile === 'string' ? e.profile : '',
    by: e.by ?? null,
    of: e.of ?? null,
    at: e.at ?? null,
    why: typeof e.why === 'string' ? e.why : '',
    detail: typeof e.detail === 'string' ? e.detail : undefined,
  };
}

/** Board-declared evidence plus findings recorded on settled attempts. */
export function evidenceList(g) {
  const out = [];
  for (const e of g?.sandbox?.capability_evidence ?? []) {
    const n = normalizeEvidence(e);
    if (n) out.push(n);
  }
  for (const a of g?.attempts ?? []) {
    for (const e of a.result?.capabilities ?? []) {
      const n = normalizeEvidence({ ...e, by: e.by ?? a.id, of: e.of ?? a.of });
      if (n) out.push(n);
    }
  }
  return out;
}

/** Latest evidence for this capability under this profile (same sandbox class). */
export function findEvidence(g, capability, profile) {
  const matches = evidenceList(g).filter((e) => e.capability === capability && e.profile === profile);
  return matches.length ? matches[matches.length - 1] : null;
}

export function evidenceSatisfies(e) {
  return !!e && e.ok === true && (e.where === 'cell' || e.where === 'cell-worktree');
}

export function evidenceBlocks(e) {
  // A failed cell probe parks. Host/external ok never unblocks a cell requirement by itself.
  return !!e && e.ok === false && (e.where === 'cell' || e.where === 'cell-worktree');
}

export function capabilityBlocks(w) {
  const c = w?.capability;
  return !!(c && c.state === 'fails' && Array.isArray(c.requires) && c.requires.length);
}

/** Argv for `codex sandbox <platform> … -- <cmd>` — no model, same OS sandbox class as the cell. */
export function codexSandboxArgs(cmd, { cwd } = {}) {
  const os = platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux';
  const args = ['sandbox', os, '--full-auto'];
  if (cwd) args.push('--cwd', cwd);
  args.push('--', 'sh', '-c', cmd);
  return args;
}

function tailOf(r, n = 6) {
  const text = String(r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n);
}

/**
 * Run one capability probe. `runner` is injectable for rehearsals; default picks Codex sandbox
 * when the profile is a Codex cell, else bare sh in cwd (host profile).
 */
export function runCapabilityProbe({ id, def, cwd, env = process.env, profile, runner } = {}) {
  if (!def?.probe) return { ok: false, state: 'unknown', why: `capability ${id} has no probe`, tail: [] };
  const timeout = def.timeout_ms ?? 20_000;
  let r;
  try {
    if (typeof runner === 'function') {
      r = runner({ id, def, cwd, env, profile, cmd: def.probe, timeout });
    } else if (String(profile).startsWith('codex/')) {
      r = spawnSync('codex', codexSandboxArgs(def.probe, { cwd }), {
        cwd, env, encoding: 'utf8', timeout, stdio: 'pipe',
      });
      if (r.error?.code === 'ENOENT') {
        return {
          ok: false, state: 'unknown',
          why: `codex not on PATH; cannot probe ${id} under ${profile}`,
          tail: ['install Codex CLI, or record sandbox.capability_evidence from a parent-owned run'],
        };
      }
    } else {
      r = spawnSync('sh', ['-c', def.probe], { cwd, env, encoding: 'utf8', timeout, stdio: 'pipe' });
    }
  } catch (e) {
    return { ok: false, state: 'unknown', why: `probe ${id} could not run: ${e.message}`, tail: [] };
  }
  if (r.error?.code === 'ETIMEDOUT') {
    return { ok: false, state: 'fails', why: `probe ${id} timed out after ${timeout} ms`, tail: tailOf(r) };
  }
  if (r.error) {
    return { ok: false, state: 'unknown', why: `probe ${id}: ${r.error.code || r.error.message}`, tail: tailOf(r) };
  }
  const where = String(profile).startsWith('codex/') ? 'cell' : 'cell-worktree';
  if (r.status === 0) {
    return { ok: true, state: 'ok', why: def.what || `${id} probe passed`, tail: tailOf(r), where };
  }
  const first = tailOf(r, 1)[0] || `exit ${r.status}`;
  return { ok: false, state: 'fails', why: first, tail: tailOf(r), where };
}

/**
 * Resolve every required capability for a work item. Mutates `w.capability` when blocked.
 * Returns null when nothing is required or all are satisfied; otherwise the capability record.
 */
export function ensureCapabilities(w, {
  g, catalog, profile, cwd, env, today, runner, ofAttempt = null,
} = {}) {
  const need = requiresOf(w);
  if (!need.length) { delete w.capability; return null; }
  const missing = need.filter((id) => !catalog.has(id));
  if (missing.length) {
    w.capability = {
      ok: false, state: 'fails', at: today?.() ?? new Date().toISOString(),
      profile, requires: need,
      why: `unknown capability id(s): ${missing.join(', ')}`,
      error: missing.map((id) => `no sandbox.capabilities.${id}`),
    };
    return w.capability;
  }

  const findings = [];
  for (const id of need) {
    const prior = findEvidence(g, id, profile);
    if (evidenceSatisfies(prior)) {
      findings.push({ ...prior, reused: true });
      continue;
    }
    if (evidenceBlocks(prior)) {
      w.capability = {
        ok: false, state: 'fails', at: today?.() ?? new Date().toISOString(),
        profile, requires: need, evidence: prior,
        why: prior.why || `${id} known not to start under ${profile}`,
        error: [prior.why || `${id} failed under ${profile}`],
      };
      return w.capability;
    }
    const def = catalog.get(id);
    const probe = runCapabilityProbe({ id, def, cwd, env, profile, runner });
    const evidence = {
      capability: id,
      ok: probe.ok === true,
      where: probe.where ?? (String(profile).startsWith('codex/') ? 'cell' : 'cell-worktree'),
      profile,
      by: ofAttempt,
      of: w.id,
      at: today?.() ?? new Date().toISOString(),
      why: probe.why,
      ...(probe.tail?.length ? { detail: probe.tail.join('\n') } : {}),
    };
    g.sandbox = g.sandbox ?? {};
    g.sandbox.capability_evidence = [...(g.sandbox.capability_evidence ?? []), evidence];
    findings.push(evidence);
    // Failed probes park. Unknown under Codex (no CLI) also parks: launching would spend budget
    // on a runtime we could not verify. A host-profile probe that cannot run is treated the same
    // when it did not exit 0 — never silently widen permissions to make it pass.
    if (!probe.ok) {
      w.capability = {
        ok: false, state: 'fails', at: evidence.at, profile, requires: need,
        evidence, why: probe.why, error: probe.tail?.length ? probe.tail : [probe.why],
      };
      return w.capability;
    }
  }
  w.capability = {
    ok: true, state: 'ok', at: today?.() ?? new Date().toISOString(),
    profile, requires: need, findings,
  };
  return w.capability;
}

/** Doctor: schema shape only. Does not claim Codex readiness without a cell-profile probe. */
export function doctorCapabilities(g, { ok, warn, bad } = {}) {
  const say = {
    ok: ok ?? (() => {}),
    warn: warn ?? (() => {}),
    bad: bad ?? (() => {}),
  };
  const raw = g?.sandbox?.capabilities;
  if (raw != null && !object(raw)) {
    say.bad('capabilities', 'sandbox.capabilities must be an object of named probes',
      'each entry is { "probe": "…", "what": "…" }');
    return;
  }
  const catalog = catalogOf(g);
  if (raw && catalog.size === 0) {
    say.warn('capabilities', 'sandbox.capabilities is present but names no usable probe');
  }
  for (const [id, def] of catalog) {
    if (!def.what) say.warn('capabilities', `\`${id}\` has no what; say what runtime it proves`);
    else say.ok('capabilities', `${id}${def.what ? `  ${def.what.slice(0, 70)}${def.what.length > 70 ? '…' : ''}` : ''}`);
  }
  for (const w of g?.work ?? []) {
    if (statusOf(w) === 'rejected') continue;
    for (const id of requiresOf(w)) {
      if (!catalog.has(id)) {
        say.bad('requires', `${w.id} requires \`${id}\`, which sandbox.capabilities does not name`,
          'add the capability or drop it from work[].requires');
      }
    }
  }
  const ev = g?.sandbox?.capability_evidence;
  if (ev != null && !Array.isArray(ev)) {
    say.bad('capability_evidence', 'sandbox.capability_evidence must be an array');
  }
}
