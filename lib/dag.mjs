// The graph is a DAG, and this is where that is enforced. The relation is the one the runner
// schedules on, `needsOf` from state.mjs (authored `needs` plus confirmed, fresh edges between
// live work), so nothing here can disagree with what would actually wait on what. A cycle is
// two jobs each waiting for the other to finish: nothing crashes, both just wait forever, which
// is why it has to be refused by name before a run rather than discovered after one.

import { derive, decideOn, fingerprintOf } from '../viewer/state.mjs';

const statusOf = (x) => x?.status ?? 'active';
const isEdgeId = (id) => String(id).startsWith('e-');

// The first cycle reachable from `starts`, as the path that closes it (`['w-a', 'w-b', 'w-a']`,
// read "w-a needs w-b needs w-a"), or null. Three colours, not one seen-set: a node finished on
// one branch is safe to meet again on another, so a diamond (two jobs sharing a dependency) is
// not a cycle. Only a node still on the current path is.
export function cycleIn(starts, needsOf, keep = () => true) {
  const done = new Set(), path = [], onPath = new Set();
  const visit = (id) => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    onPath.add(id); path.push(id);
    for (const n of needsOf(id)) {
      if (!keep(n)) continue;
      const c = visit(n);
      if (c) return c;
    }
    onPath.delete(id); path.pop(); done.add(id);
    return null;
  };
  for (const id of starts) {
    if (!keep(id)) continue;
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

// Live work: what the scheduler would ever launch. A rejected or still-proposed item schedules
// nothing, and a need naming no item is doctor's other complaint, not a cycle.
const liveIn = (S) => (id) => { const w = S.workOf(id); return !!w && statusOf(w) === 'active'; };

// Any cycle on the board as it stands.
export function findCycle(board) {
  const g = { edges: [], attempts: [], ...board };
  const S = derive(g, { index: true });
  return cycleIn(g.work.map((w) => w.id), S.needsOf, liveIn(S));
}

export const showCycle = (path) => path.join(' → ');

// The cycle confirming `x` would close, or null. Decided on a copy with only `x` changed, so a
// refusal leaves nothing half-applied. Only a cycle through `x` counts: a cycle already on the
// board is doctor's to report, and not a reason to refuse an unrelated yes.
export function closesCycle(g, x) {
  const edge = isEdgeId(x.id);
  const y = edge ? { ...x, status: 'confirmed', fingerprint: fingerprintOf(g, x) } : { ...x, status: 'active' };
  const c = { ...g, work: g.work.map((w) => (w === x ? y : w)), edges: g.edges.map((e) => (e === x ? y : e)) };
  const S = derive(c, { index: true });
  const live = liveIn(S);
  // The shortest chain of needs from `src` to `dst`, so the reason names the tightest loop.
  const route = (src, dst) => {
    if (!live(src) || !live(dst)) return null;
    const prev = new Map([[src, null]]), queue = [src];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === dst) { const p = []; for (let n = cur; n != null; n = prev.get(n)) p.unshift(n); return p; }
      for (const n of S.needsOf(cur)) if (live(n) && !prev.has(n)) { prev.set(n, cur); queue.push(n); }
    }
    return null;
  };
  // An edge `from blocks to` is `to needs from`: it closes a cycle when `from` already reaches
  // `to`. A work item closes one when something it needs reaches back to it.
  if (edge) { const p = route(x.from, x.to); return p ? [x.to, ...p] : null; }
  let best = null;
  for (const n of S.needsOf(x.id)) {
    const p = route(n, x.id);
    if (p && (!best || p.length + 1 < best.length)) best = [x.id, ...p];
  }
  return best;
}

// Every yes goes through here. A yes that would close a cycle is recorded as a no, with the loop
// it would have made, and the run keeps going: the proposal stays on the board, readable, and
// the operator can remove the other link and propose it again.
export function confirmOn(x, g) {
  const path = closesCycle(g, x);
  if (!path) { decideOn(x, 'confirmed', g); return null; }
  decideOn(x, 'rejected', g);
  x.rejected_why = `would close a dependency cycle: ${showCycle(path)}`;
  return path;
}
