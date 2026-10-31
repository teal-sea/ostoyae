// Normalize sandbox.link entries. Strings stay optional (historical). Objects may require
// presence and declare a probe shared by doctor and cell provisioning (issue #2).

export function linkEntries(link = []) {
  if (!Array.isArray(link)) throw new Error('sandbox.link must be an array');
  return link.map((entry, i) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) throw new Error(`sandbox.link[${i}] is empty`);
      return { path: entry, required: false, probe: null, probe_timeout_ms: 6000 };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || !entry.path.trim())
      throw new Error(`sandbox.link[${i}] must be a path string or { path, required?, probe? }`);
    const ms = entry.probe_timeout_ms ?? 6000;
    if (entry.probe_timeout_ms != null && (!Number.isFinite(ms) || ms <= 0))
      throw new Error(`sandbox.link[${i}].probe_timeout_ms must be a positive number`);
    return {
      path: entry.path.trim(),
      required: entry.required === true,
      probe: typeof entry.probe === 'string' && entry.probe.trim() ? entry.probe.trim() : null,
      probe_timeout_ms: ms,
    };
  });
}

export function linkPaths(link = []) {
  return linkEntries(link).map((e) => e.path);
}

export function preflightEntries(preflight = []) {
  if (preflight == null) return [];
  if (!Array.isArray(preflight)) throw new Error('sandbox.preflight must be an array');
  return preflight.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`sandbox.preflight[${i}] must be { cmd, what? }`);
    const cmd = typeof entry.cmd === 'string' ? entry.cmd.trim() : '';
    if (!cmd) throw new Error(`sandbox.preflight[${i}] needs a nonempty cmd`);
    const ms = entry.timeout_ms ?? entry.probe_timeout_ms ?? 6000;
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`sandbox.preflight[${i}] timeout must be positive`);
    return { cmd, what: typeof entry.what === 'string' ? entry.what : '', timeout_ms: ms };
  });
}
