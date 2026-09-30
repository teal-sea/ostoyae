// The operator's turn: yes, no, and the scoped unattended yes.

import { decideOn } from '../viewer/state.mjs';
import { confirmOn } from './dag.mjs';

const pad = (s, n) => String(s).padEnd(n);
const isEdgeId = (id) => String(id).startsWith('e-');
const statusOf = (x) => x?.status ?? 'active';

// Confirming a revision closes the statement it revises. Both cannot stand: they are the same
// declaration, so they carry the same `check`, and two active items would send two agents to
// write the same name two different ways. The one being replaced is closed with the reason and
// the id that replaced it, never deleted -- a rejected item is still readable, and the record of
// having believed a false statement is worth keeping.
export function supersede(x, { work, today }) {
  if (!x.revises || statusOf(x) !== 'active') return;
  const old = work.get(x.revises);
  if (!old || statusOf(old) === 'rejected') return;
  old.status = 'rejected';
  old.decided_at = today();
  old.rejected_why = `superseded by ${x.id}, which states the same declaration differently`;
  console.log(`  ${pad(old.id, 10)} ${pad('rejected', 9)} superseded by ${x.id}`);
}

export function decide(ids, status, ctx) {
  const { g, work, REJECT_WHY } = ctx;
  const lookup = (id) => (isEdgeId(id) ? g.edges.find((e) => e.id === id) : work.get(id));
  const touched = [];
  for (const id of ids.split(',').map((s) => s.trim()).filter(Boolean)) {
    const x = lookup(id);
    if (!x) { console.log(`  ${pad(id, 10)} no such work item or edge`); continue; }
    // Allow rejecting an active item so a refuted task cannot keep launching.
    const closable = status === 'rejected' && !isEdgeId(id) && statusOf(x) === 'active';
    if (statusOf(x) !== 'proposed' && !closable) { console.log(`  ${pad(id, 10)} already ${statusOf(x)}, left alone`); continue; }
    if (closable) console.log(`  ${pad(id, 10)} ${pad('closing', 9)} was active: a route being closed, not a proposal declined`);
    // A confirmed edge is `confirmed`. A confirmed work item is `active`, it becomes ordinary
    // work, indistinguishable from something a person typed into the file. There is no third
    // kind of work item. The rule lives in state.mjs so nothing drawing the graph can differ.
    // A yes that would close a dependency cycle is recorded as a no; dag.mjs says why.
    if (status === 'confirmed') confirmOn(x, g); else decideOn(x, status, g);
    if (REJECT_WHY && status === 'rejected') x.rejected_why = REJECT_WHY;
    supersede(x, ctx);
    if (x.reopened_at && x.status !== 'rejected') { x.reconfirmed_at = x.decided_at; delete x.reopened_at; delete x.reopened_why; }
    const what = x.status === 'rejected' && status === 'confirmed' ? x.rejected_why
      : isEdgeId(id) ? `${x.from} blocks ${x.to}` : x.what;
    console.log(`  ${pad(id, 10)} ${pad(x.status, 9)} ${what}`);
    touched.push(x);
  }
  // Say when a confirmation cannot bite yet, rather than letting it look like it did.
  for (const e of touched.filter((x) => isEdgeId(x.id) && x.status === 'confirmed')) {
    for (const end of [e.from, e.to]) {
      if (statusOf(work.get(end)) === 'proposed') {
        console.log(`  ${pad('', 10)} ${pad('', 9)} no effect yet: ${end} is still proposed`);
      }
    }
  }
  return touched.length;
}

// Auto-confirm only judged routes that reach an open original ticket.
export function confirmScoped(targets, ctx) {
  const { g, S } = ctx;
  const { judgeOn, refuted, satisfied } = S;
  const automatic = targets !== null;
  const judged = (x) => (judgeOn() ? x.verdict?.ok === true : x.verdict?.ok !== false) && !x.reopened_at &&
    (!automatic || !x.revises); // changing a ticket's statement still needs an explicit decision
  // A route must reach an original ticket that is still open; a closed ticket cannot authorize new work.
  const open = (w) => statusOf(w) !== 'proposed' && statusOf(w) !== 'rejected' && !refuted(w.id);
  const existing = new Set(g.work.filter(open).map((w) => w.id));
  const original = targets ? new Set([...targets].filter((id) => existing.has(id) && !satisfied(id))) : existing;
  // Every step must be usable, not only the final ticket. Otherwise a rejected
  // item or an unjudged edge can authorize work whose own edge stays proposed.
  const eligible = new Set(g.work.filter((w) => open(w) ||
    (statusOf(w) === 'proposed' && judged(w))).map((w) => w.id));
  const usable = g.edges.filter((e) => (e.status === 'confirmed' ||
    (e.status === 'proposed' && judged(e))) && eligible.has(e.from) && eligible.has(e.to));
  const reaches = (id, seen = new Set()) => {
    if (original.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return usable.some((e) => e.from === id && reaches(e.to, seen));
  };
  // The judge's no is honoured here and only here: a proposal the verifier failed is left for a
  // person. An unattended yes that overrode the judge would be the rubber stamp the judge exists
  // to remove. An attended `--confirm` can still say yes to it, on purpose, by id.
  const items = g.work.filter((w) => statusOf(w) === 'proposed' && judged(w));
  const take = items.filter((w) => reaches(w.id));
  const ids = new Set(take.map((w) => w.id));
  // An edge is confirmed when both its ends will exist and its from-side is in scope.
  const okEnd = (x) => existing.has(x) || ids.has(x);
  const edges = g.edges.filter((e) => e.status === 'proposed' && judged(e) && okEnd(e.from) && okEnd(e.to) && reaches(e.from));
  let refused = 0;
  for (const x of [...take, ...edges]) {
    // Refused, not skipped: said out loud even when the run is quiet about what it confirmed.
    if (confirmOn(x, g)) { refused++; console.log(`  ${pad(x.id, 10)} ${pad(x.status, 9)} ${x.rejected_why}`); }
    if (automatic) x.decided_via = 'auto-advance';
    supersede(x, ctx);
    if (x.status !== 'rejected') (ctx.say ?? console.log)(`  ${pad(x.id, 10)} ${pad(x.status, 9)} ${isEdgeId(x.id) ? `${x.from} blocks ${x.to}` : x.what}`);
  }
  const left = g.work.filter((w) => statusOf(w) === 'proposed').length +
               g.edges.filter((e) => e.status === 'proposed').length;
  const failed = [...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed' && x.verdict?.ok === false).length;
  const reopened = g.edges.filter((e) => e.status === 'proposed' && e.reopened_at).length;
  if (left && !automatic) console.log(`  ${pad('', 10)} ${pad('', 9)} ${left} proposal(s) left for the operator` +
                        `${failed ? `, ${failed} failed by the judge` : ''}${reopened ? `, ${reopened} reopened after its text changed` : ''}` +
                        `, the rest reach no ticket through a usable, judged route`);
  return take.length + edges.length - refused;
}
