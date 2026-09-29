// Claims under an ontology: templates, ids, identity, and the rulebook at the door.

import { createHash } from 'node:crypto';

// One line of a template, with {key} filled from the claim. A key the claim does not have is an
// error rather than an empty string: a template that names it meant it.
// `shell: true` for a template that becomes a command: every value is single-quoted, so a
// declaration like `McKayConjecture.Irr'_finite` -- Lean allows the apostrophe, and Mathlib is
// full of them -- reaches the script as one argument instead of ending the shell's quote. That
// one name broke its check with `exit 2` on 2026-09-03 and its gate on 2026-09-04. The id, the
// prose and the gate's statement are not shell and are filled as written.
export const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
export function fill(tpl, claim, where, { shell = false } = {}) {
  let missing = null;
  const out = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (claim[k] == null) { missing ??= k; return ''; }
    return shell ? shq(claim[k]) : String(claim[k]);
  });
  if (missing) throw new Error(`${where} names {${missing}}, which the claim does not have`);
  return out;
}

// An id is a name, so it is slugged: the decl `Real.tendsto_log_log_atTop` becomes
// `w-lemma-real-tendsto-log-log-attop`. Two claims whose decls differ only in case were the
// same declaration anyway, and Lean is case-sensitive, so the hash, not the id, is identity.
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Identity: the kind and the claim, canonically ordered, and nothing else. Evidence is not in
// it, so finding the same lemma again with a better search does not create a second item.
export const claimHash = (kind, claim) => createHash('sha1')
  .update(JSON.stringify([kind, Object.keys(claim).sort().map((k) => [k, claim[k]])]))
  .digest('hex').slice(0, 16);

// The rulebook, applied at the door. Returns the claim as the kind declares it, or why not.
export function readClaim(w, ONT) {
  const kind = w?.kind;
  if (typeof kind !== 'string' || !ONT.kinds[kind]) {
    return { why: `kind ${JSON.stringify(kind ?? null)} is not one of ${Object.keys(ONT.kinds).join(', ')}` };
  }
  const spec = ONT.kinds[kind];
  const c = w.claim;
  if (typeof c !== 'object' || !c || Array.isArray(c)) return { why: `${kind} has no claim object` };
  const claim = {};
  for (const k of spec.claim) {
    const v = c[k];
    if (typeof v !== 'string' || !v.trim()) return { why: `${kind} claim is missing ${k}` };
    claim[k] = v.trim();
  }
  const strays = Object.keys(c).filter((k) => !spec.claim.includes(k));
  if (strays.length) return { why: `${kind} claim carries ${strays.join(', ')}, which the kind does not declare` };
  const evidence = {};
  for (const k of spec.evidence ?? []) if (w.evidence?.[k] != null) evidence[k] = w.evidence[k];
  return { kind, spec, claim, evidence };
}
