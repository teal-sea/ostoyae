// The operator's turn: yes, no, and the scoped unattended yes.

import { decideOn } from '../viewer/state.mjs';

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
    // An active item can still be closed, and until 2026-09-04 it could not: `--reject` answered
    // proposals only, so once an item was confirmed there was no way to say "this route is dead"
    // through the CLI at all. Seven items on the lean-eval board had been proved FALSE in Lean by
    // eleven attempts between them, and every one was still active and still schedulable, because
    // the yes that made them active could not be taken back. Confirming an active item is still a
    // no-op, and a decided item is not re-decided.
    const closable = status === 'rejected' && !isEdgeId(id) && statusOf(x) === 'active';
    if (statusOf(x) !== 'proposed' && !closable) { console.log(`  ${pad(id, 10)} already ${statusOf(x)}, left alone`); continue; }
    if (closable) console.log(`  ${pad(id, 10)} ${pad('closing', 9)} was active: a route being closed, not a proposal declined`);
    // A confirmed edge is `confirmed`. A confirmed work item is `active`, it becomes ordinary
    // work, indistinguishable from something a person typed into the file. There is no third
    // kind of work item. The rule lives in state.mjs so nothing drawing the graph can differ.
    decideOn(x, status, g);
    if (REJECT_WHY && status === 'rejected') x.rejected_why = REJECT_WHY;
    supersede(x, ctx);
    if (x.reopened_at) { x.reconfirmed_at = x.decided_at; delete x.reopened_at; delete x.reopened_why; }
    const what = isEdgeId(id) ? `${x.from} blocks ${x.to}` : x.what;
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

// The scope rule for an unattended yes. "Yes to everything" is not a policy, it is the absence
// of one, and on 2026-08-30 it spent $4.37 of `G-nomap`'s budget on agent-proposed CI hygiene
// with no path to any ticket. The rule that replaces the operator's judgment when the operator
// is out of the loop: confirm a proposal only when following proposed and confirmed edges from
// it reaches work that was in the graph before the run, the tickets. A proposal that helps no
// ticket waits for a person.
//
// This is a floor, not a substitute: it cannot tell a good decomposition from a bad one, only
// an on-scope one from an off-scope one. An attended run still beats it.
export function confirmScoped(targets, ctx) {
  const { g, S } = ctx;
  const { judgeOn, refuted, satisfied } = S;
  const automatic = targets !== null;
  const judged = (x) => (judgeOn() ? x.verdict?.ok === true : x.verdict?.ok !== false) && !x.reopened_at &&
    (!automatic || !x.revises); // changing a ticket's statement still needs an explicit decision
  // What counts as a destination: work that was in the graph before the run AND is still open.
  // A rejected item is neither. Excluding only proposals made a closed route a legitimate
  // ticket, so a proposal whose one edge reached a statement the operator had already closed as
  // false satisfied the gate and was confirmed unattended — the walk said "reaches a ticket"
  // about a ticket that no longer exists. Such a proposal now waits for a person, which is all
  // this changes: nothing is promoted, nothing is rejected, and no route through open work is
  // affected.
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
  // And a reopened edge is left alone too: it was confirmed once against text that has since
  // changed, and re-saying yes to it unread is exactly the silent drift the fingerprint exists
  // to stop. Both wait for `--confirm` by id.
  // With the judge on, unjudged is not yes. This confirmed five pseudo-Lean proposals from
  // a-0113's wall at 20:05 on 2026-09-04, ten minutes before the verify attempt that failed all
  // five landed; they were active, schedulable and unparseable, and the judge's no arrived on
  // items that had already been made work. The unattended yes waits for the verdict it exists
  // to honour. With no judge configured, nothing will ever judge them, and the old rule stands.
  const items = g.work.filter((w) => statusOf(w) === 'proposed' && judged(w));
  const take = items.filter((w) => reaches(w.id));
  const ids = new Set(take.map((w) => w.id));
  // An edge is confirmed when both its ends will exist and its from-side is in scope.
  const okEnd = (x) => existing.has(x) || ids.has(x);
  const edges = g.edges.filter((e) => e.status === 'proposed' && judged(e) && okEnd(e.from) && okEnd(e.to) && reaches(e.from));
  for (const x of [...take, ...edges]) {
    decideOn(x, 'confirmed', g);
    if (automatic) x.decided_via = 'auto-advance';
    supersede(x, ctx);
    console.log(`  ${pad(x.id, 10)} ${pad(x.status, 9)} ${isEdgeId(x.id) ? `${x.from} blocks ${x.to}` : x.what}`);
  }
  const left = g.work.filter((w) => statusOf(w) === 'proposed').length +
               g.edges.filter((e) => e.status === 'proposed').length;
  const failed = [...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed' && x.verdict?.ok === false).length;
  const reopened = g.edges.filter((e) => e.status === 'proposed' && e.reopened_at).length;
  if (left && !automatic) console.log(`  ${pad('', 10)} ${pad('', 9)} ${left} proposal(s) left for the operator` +
                        `${failed ? `, ${failed} failed by the judge` : ''}${reopened ? `, ${reopened} reopened after its text changed` : ''}` +
                        `, the rest reach no ticket through a usable, judged route`);
  return take.length + edges.length;
}
