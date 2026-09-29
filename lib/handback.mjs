// The handback: what an attempt writes into its cell, and how it lands on the board.
// The report is data an attempt writes; it is not trusted and it is not authority. Everything in
// it lands as a proposal, ids are assigned by the runner, and anything malformed is dropped with a
// note rather than crashing the run or half-applying.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fill, slug, claimHash, readClaim } from './claims.mjs';

const statusOf = (x) => x?.status ?? 'active';

// Where an attempt leaves its handback. A fixed path inside the cell rather than an environment
// variable, because sandbox.mjs is tested and not being touched for this.
export const REPORT = '.ostoyae/report.json';
export const USAGE = '.ostoyae/usage.json';
// Where a map attempt finds the graph's work, so the edges it proposes can name items that exist.
export const WORK = '.ostoyae/work.json';
// Where a verify attempt finds the handback it is judging, verbatim, beside the item it was for.
export const VERIFY = '.ostoyae/verify.json';

export function absorb(rep, a, { g, work, ONT, today, edgeId }) {
  const found = [], notes = [];
  const stamp = today();
  // What the agent called each proposal, against the id the runner assigned it. Edges in the
  // same report name the agent's ids, so they are resolved through this and never trusted.
  const said = new Map();

  // A handback is agent-written bytes, and "malformed is dropped with a note rather than
  // crashing the run" is the contract above. `rep.work ?? []` is not enough of it: a number
  // or an object is not iterable and threw a TypeError out of settle, killing the whole
  // runner mid-run, and a string iterated per character into one junk note each. Anything
  // that is not an array is one note and no proposals.
  const claimedWork = Array.isArray(rep.work) ? rep.work : [];
  if (rep.work != null && !Array.isArray(rep.work)) {
    notes.push(`proposed work is ${typeof rep.work}, not a list: dropped`);
  }
  for (const w of claimedWork) {
    if (ONT) {
      const r = readClaim(w, ONT);
      if (r.why) { notes.push(`proposed work dropped: ${r.why}`); continue; }
      let id, what, check;
      try {
        id = `${ONT.id_prefix ?? 'w'}-${slug(fill(r.spec.id, r.claim, `${r.kind}.id`))}`;
        what = fill(r.spec.what, r.claim, `${r.kind}.what`);
        check = r.spec.check ? fill(r.spec.check, r.claim, `${r.kind}.check`, { shell: true }) : null;
      } catch (e) { notes.push(`proposed ${r.kind} dropped: ${e.message}`); continue; }
      const hash = claimHash(r.kind, r.claim);
      if (w.id && w.id !== id) notes.push(`${w.id} is the agent's name for it; the graph calls it ${id}`);
      // The same claim, however it was named. This is the collision that makes parallel mappers
      // safe: an item already in the graph is joined, not duplicated. Identity is the hash and
      // the hash covers the whole claim, statement included.
      const hashOf = (x) => x.claim_hash ?? (x.kind && x.claim ? claimHash(x.kind, x.claim) : null);
      const have = g.work.find((x) => hashOf(x) === hash);
      // Reject a different claim under an existing id; silently reusing it would change what earlier attempts mean.
      const revises = have ? null : work.get(id);
      if (revises) {
        id = `${id}-${hash.slice(0, 6)}`;
        notes.push(`${revises.id} is stated differently by ${a.id}: recorded as ${id}, a revision of it`);
      }
      if (have) {
        said.set(w.id ?? id, have.id);
        if (!have.found_by?.includes(a.id)) {
          have.found_by = [...(have.found_by ?? []), a.id];
          notes.push(`${have.id} already ${statusOf(have)}, ${a.id} added as a finder of the same claim`);
        } else notes.push(`${have.id} already ${statusOf(have)}, not re-added`);
        // Support accumulates; identity does not move. A later finder fills in evidence keys the
        // first one left empty and never overwrites one it wrote, so which mapper happened to
        // land first changes nothing that is already recorded.
        for (const [k, v] of Object.entries(r.evidence)) {
          if (have.evidence?.[k] == null) { have.evidence = { ...(have.evidence ?? {}), [k]: v }; }
        }
        continue;
      }
      const item = {
        id, kind: r.kind, claim: r.claim, claim_hash: hash, what,
        ...(Object.keys(r.evidence).length ? { evidence: r.evidence } : {}),
        ...(check ? { check } : {}),
        ...(revises ? { revises: revises.id } : {}),
        needs: [], status: 'proposed', found_by: [a.id], found_at: stamp,
      };
      // Recorded on the item being corrected too, so a reader of the false one is told a
      // correction exists without having to search for it.
      if (revises) revises.revised_by = [...new Set([...(revises.revised_by ?? []), item.id])];
      g.work.push(item);
      work.set(item.id, item);
      said.set(w.id ?? id, id);
      found.push(item.id);
      continue;
    }
    if (!w?.id) { notes.push('proposed work item with no id, dropped'); continue; }
    const have = work.get(w.id);
    if (have) {
      if (statusOf(have) === 'proposed' && !have.found_by.includes(a.id)) {
        have.found_by.push(a.id);
        notes.push(`${w.id} already proposed, ${a.id} added as a finder`);
      } else {
        notes.push(`${w.id} already in the graph as ${statusOf(have)}, not re-added`);
      }
      continue;
    }
    const item = { id: w.id, what: w.what ?? '', needs: [], status: 'proposed', found_by: [a.id], found_at: stamp };
    g.work.push(item);
    work.set(item.id, item);
    found.push(item.id);
  }

  // Same contract as work above: a non-list is one note, never a throw.
  const claimedEdges = Array.isArray(rep.edges) ? rep.edges : [];
  if (rep.edges != null && !Array.isArray(rep.edges)) {
    notes.push(`proposed edges are ${typeof rep.edges}, not a list: dropped`);
  }
  for (const e0 of claimedEdges) {
    // An edge's ends are the ids the runner assigned, resolved from what the agent called them.
    // An end naming an item already in the graph passes through unchanged.
    const e = ONT ? { ...e0, from: said.get(e0?.from) ?? e0?.from, to: said.get(e0?.to) ?? e0?.to } : e0;
    if (!e?.from || !e?.to) { notes.push('edge missing from or to, dropped'); continue; }
    if (e.from === e.to) { notes.push(`edge ${e.from} to itself, dropped`); continue; }
    if (!work.has(e.from) || !work.has(e.to)) {
      notes.push(`edge ${e.from} -> ${e.to} names work that is not in the graph, dropped`);
      continue;
    }
    const dup = g.edges.find((x) => x.from === e.from && x.to === e.to);
    if (dup) {
      if (!dup.found_by.includes(a.id)) dup.found_by.push(a.id);
      notes.push(`${dup.id} ${e.from} -> ${e.to} already recorded, ${a.id} added as a finder`);
      continue;
    }
    const edge = {
      id: edgeId(),
      from: e.from, to: e.to, why: e.why ?? '',
      status: 'proposed', found_by: [a.id], found_at: stamp,
    };
    g.edges.push(edge);
    found.push(edge.id);
  }

  return { found, notes };
}

export function readReport(path) {
  const p = join(path, REPORT);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return { _bad: String(e.message).split('\n')[0] }; }
}

// What the attempt cost, as the executor wrote it beside the handback. Absent is recorded as
// absent: an executor that reports nothing is not the same as a free attempt, and the report
// says which attempts have no number so a total is never quietly short.
export function readUsage(path) {
  const p = join(path, USAGE);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return { _bad: String(e.message).split('\n')[0] }; }
}
