// The summary a run ends with, and why its queue emptied.

import { kindOf } from '../viewer/state.mjs';
import { spendSoFar } from './spend.mjs';

const pad = (s, n) => String(s).padEnd(n);
const statusOf = (x) => x?.status ?? 'active';

// Why the loop ran out of work, in the same buckets `report()` prints. `state` is for a caller
// deciding what to do next; `why` and `next` are for whoever reads the terminal.
//
// Nothing this returns says the question was answered. `board-satisfied` means every check on
// every active item passed, which is a fact about the board and about the checks, not about the
// mathematics the board was built to ask about. An empty queue and a finished mission are
// different claims and this repo does not get to confuse them.
export function classifyDrain({ g, S, gateBlocks }) {
  const { schedulable, satisfied, walled, awaitingMap, exhausted, pendingVerify } = S;
  const active = g.work.filter(schedulable);
  const unsatisfied = active.filter((w) => !satisfied(w.id));
  const parked = unsatisfied.filter((w) => walled(w.id) || awaitingMap(w.id));
  const dead = unsatisfied.filter((w) => !walled(w.id) && !awaitingMap(w.id) && exhausted(w.id));
  const gated = g.work.filter((w) => statusOf(w) !== 'rejected' && gateBlocks(w));
  const proposals = [...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed');
  const held = pendingVerify().length;
  const ids = (xs) => xs.slice(0, 6).map((x) => x.id).join(', ') + (xs.length > 6 ? `, +${xs.length - 6} more` : '');

  // Precedence matches `report()`: something waiting on a decision outranks something that ran
  // out of tries, because the first has an authorized next action and the second does not.
  if (held) return {
    state: 'awaiting-judge',
    why: `${held} handback${held === 1 ? '' : 's'} still awaiting a verify attempt, and none was launched`,
    next: 'judge.verify is off or its attempts are spent; turn it on, or read the handbacks yourself',
  };
  if (parked.length || proposals.length) return {
    state: 'awaiting-decision',
    why: `${parked.length} item(s) parked and ${proposals.length} proposal(s) unanswered` +
         (parked.length ? `: ${ids(parked)}` : ''),
    next: proposals.length
      ? `confirm or reject them (--confirm ${ids(proposals).split(',')[0].trim()}), or re-run with --auto-advance and a cap to let the judge decide within scope`
      : 'the parked items are waiting on an answer, not on capacity',
  };
  if (dead.length) return {
    state: 'exhausted',
    why: `${dead.length} item(s) used up max_attempts without satisfying their check: ${ids(dead)}`,
    next: 'a scoped repair with the failing evidence, or a raised max_attempts. Re-running as-is launches nothing',
  };
  if (gated.length) return {
    state: 'gated',
    why: `${gated.length} item(s) whose statement does not elaborate, so nothing was ever launched on them: ${ids(gated)}`,
    next: 'revise the statement or close the route',
  };
  if (unsatisfied.length) return {
    state: 'blocked',
    why: `${unsatisfied.length} item(s) unsatisfied and none ready: each is waiting on something that is not satisfied: ${ids(unsatisfied)}`,
    next: 'the blocking items are refuted, rejected, or outside --only. Nothing here is a capacity problem',
  };
  return {
    state: 'board-satisfied',
    why: `every one of the ${active.length} active item(s) satisfied its check`,
    next: 'the board is empty. That is the board finishing, not an answer to the question it was built to ask',
  };
}

export function report({ g, S, file, gateBlocks }) {
  const { schedulable, satisfied, refuted, walled, awaitingMap, exhausted, mappingOn, hasMap, mapSpent, mapMax,
          spent, openProposals, needsOf, judgeOn, pendingVerify } = S;
  // One item, one bucket, in the same order of precedence `stateOf` uses for the picture. These
  // were four independent filters, so an item whose last attempt walled on its last allowed try
  // was both `exhausted` and `walled`: printed twice, counted twice, and the two lines said
  // opposite things. `exhausted` reads as give up on this; `walled` is the outcome this repo
  // exists for and is waiting on an answer. The viewer already ranked walled first, so the
  // terminal and the picture disagreed about the same item.
  //
  // `mapped` is the item whose map proposed work or edges nobody has answered. It is parked the
  // same way a walled item is, and it is printed the same way, so it cannot be mistaken for one
  // that never ran. The bucket is always computed and only printed when there is something in
  // it or mapping is on, so a graph without maps prints exactly what it always did.
  const active = g.work.filter(schedulable);
  const done = active.filter((w) => satisfied(w.id));
  // Answered false is done, and it is the outcome worth a line of its own: a refutation is the
  // result on a question, and it is also why anything that needed the statement is blocked.
  const refutedItems = done.filter((w) => refuted(w.id));
  const parked = active.filter((w) => !satisfied(w.id) && walled(w.id));
  const mapped = active.filter((w) => !satisfied(w.id) && !walled(w.id) && awaitingMap(w.id));
  const dead = active.filter((w) => !satisfied(w.id) && !walled(w.id) && !awaitingMap(w.id) && exhausted(w.id));
  // Gated items are excluded here because they have their own section below: `ready()`
  // does not consult the gate (the launch loop skips them instead), so without this a gated
  // prove prints `ready … not launched yet` above the line that says it never launches.
  const stuck = active.filter((w) => !satisfied(w.id) && !exhausted(w.id) && !walled(w.id) && !awaitingMap(w.id) && !gateBlocks(w));
  // `stuck` mixes two cases the operator acts on differently: items ready to launch that the
  // run stopped before (a budget bound with retries pending, or never launched at all) and
  // items waiting on unsatisfied needs. Printing both as "never ran" sent the operator to ask
  // why a failed-once item never launched, when the answer was one retry away. The split reads
  // the same `ready` the viewer pictures, so the terminal and the picture agree.
  const rs = S.readyIds();
  const readyStuck = stuck.filter((w) => rs.has(w.id));
  const waitStuck = stuck.filter((w) => !rs.has(w.id));
  const showMaps = mappingOn() || mapped.length > 0;

  const walls = g.attempts.filter((a) => a.state === 'walled');
  const maps = g.attempts.filter((a) => kindOf(a) === 'map').length;
  const verifies = g.attempts.filter((a) => kindOf(a) === 'verify').length;
  const claimed = g.attempts.filter((a) => a.state === 'done' && kindOf(a) === 'prove' && !a.result?.check);
  const claimedDry = claimed.filter((a) => a.result?.checkDeclared);
  const claimedWord = claimed.filter((a) => !a.result?.checkDeclared);
  const limited = g.attempts.filter((a) => a.result?.limited);
  // Finished on its branch but absent from the trunk: two finished jobs owned one file and the
  // merge lost. The attempt is still `done` -- it finished -- but a summary that prints only
  // "satisfied" leaves the operator believing the trunk holds work it does not.
  const conflicted = g.attempts.filter((a) => a.state === 'done' && kindOf(a) === 'prove' &&
    (a.result?.conflict ?? []).length > 0 && !a.result?.integrated);
  console.log(`\n  ${done.length} satisfied${refutedItems.length ? ` (${refutedItems.length} answered false)` : ''} · ` +
              `${dead.length} exhausted · ${parked.length} walled · ` +
              `${showMaps ? `${mapped.length} mapped, awaiting you · ` : ''}${readyStuck.length} ready · ${waitStuck.length} waiting`);
  for (const w of refutedItems) {
    console.log(`    refuted    ${w.id}  answered false by ${w.answered_by ?? '?'}: the statement is false, and nothing that needed it true will launch`);
  }
  for (const w of dead) {
    // Which budget ran out. An item with no map that used up its map attempts never got to prove.
    const noMap = mappingOn() && !hasMap(w.id) && mapSpent(w.id) >= mapMax();
    console.log(noMap
      ? `    exhausted  ${w.id}  after ${mapSpent(w.id)} map attempt${mapSpent(w.id) === 1 ? '' : 's'}, no map`
      : `    exhausted  ${w.id}  after ${spent(w.id)} attempts`);
  }
  for (const w of parked) console.log(`    walled     ${w.id}  awaiting the operator on ${openProposals(S.workAttemptsOf(w.id).at(-1)).join(', ')}`);
  for (const w of mapped) console.log(`    mapped     ${w.id}  awaiting the operator on ${openProposals(S.workAttemptsOf(w.id).at(-1)).join(', ')}`);
  for (const w of readyStuck) {
    const n = S.workAttemptsOf(w.id).length;
    console.log(n
      ? `    ready      ${w.id}  ${n} attempt${n === 1 ? '' : 's'} in, retries left`
      : `    ready      ${w.id}  not launched yet`);
  }
  for (const w of waitStuck) {
    const needs = needsOf(w.id).map((n) => (refuted(n) ? `${n} (refuted)` : n));
    // No needs and still not ready means in flight or gated: with no unmet need the only
    // other bars to `ready` are a running attempt and the statement gate, both printed by
    // name rather than as "never became ready", which described the old mixed bucket.
    const why = needs.length ? `needs ${needs.join(', ')}`
      : S.running(w.id) ? 'still in flight'
      : gateBlocks(w) ? 'gated: statement does not elaborate'
      : 'not scheduled';
    console.log(`    waiting    ${w.id}  ${why}`);
  }
  if (mappingOn()) console.log(`  maps: ${active.filter((w) => hasMap(w.id)).length} of ${active.length} active items mapped`);
  console.log(`  ${g.attempts.length} attempts recorded${mappingOn() || verifies ? ` (${maps} map, ${verifies} verify, ${g.attempts.length - maps - verifies} prove)` : ''}, ` +
              `${walls.length} walled and ${g.attempts.filter((a) => a.state === 'failed').length} failed, all kept`);
  // The judge's line. Every number here is one the operator would otherwise have to infer.
  if (claimedWord.length) console.log(`  ${claimedWord.length} done on the agent's word, no check declared: ${claimedWord.map((a) => a.id).join(', ')}`);
  if (claimedDry.length) console.log(`  ${claimedDry.length} done, checks declared but not run in dry mode: ${claimedDry.map((a) => a.id).join(', ')}`);
  if (conflicted.length) console.log(`  ${conflicted.length} done but unmerged, trunk conflict: ${conflicted.map((a) => a.id).join(', ')}`);
  const gated = g.work.filter((w) => statusOf(w) !== 'rejected' && gateBlocks(w));
  if (gated.length) {
    console.log(`  ${gated.length} item(s) whose statement does not elaborate, never launched:`);
    for (const w of gated) console.log(`    ${pad(w.id, 60)} ${String(w.gate.error?.[0] ?? '').slice(0, 100)}`);
  }
  if (judgeOn() || verifies) {
    const ps = [...g.work, ...g.edges].filter((x) => statusOf(x) === 'proposed');
    const ok = ps.filter((x) => x.verdict?.ok === true).length, no = ps.filter((x) => x.verdict?.ok === false).length;
    console.log(`  judge: ${ok} proposal${ok === 1 ? '' : 's'} passed, ${no} failed, ${ps.length - ok - no} unjudged, ${pendingVerify().length} handback${pendingVerify().length === 1 ? '' : 's'} awaiting a verify attempt`);
  }
  if (limited.length) console.log(`  ${limited.length} attempt${limited.length === 1 ? '' : 's'} stopped by the plan window: ${limited.map((a) => a.id).join(', ')}`);

  const proposedWork = g.work.filter((w) => statusOf(w) === 'proposed');
  const proposedEdges = g.edges.filter((e) => e.status === 'proposed');
  if (proposedWork.length || proposedEdges.length) {
    console.log(`\n  proposed, not scheduled, awaiting the operator:`);
    const said = (x) => x.verdict ? `  judge: ${x.verdict.ok ? 'ok' : 'NO'}${x.verdict.why ? `, ${x.verdict.why}` : ''}` : '';
    const provenance = (x) => `found by ${(x.found_by ?? []).join(', ') || 'unrecorded'} on ${x.found_at?.slice(0, 10) ?? 'unrecorded'}`;
    for (const w of proposedWork) console.log(`    ${pad(w.id, 10)} work  ${pad(w.what, 40)} ${provenance(w)}${said(w)}`);
    for (const e of proposedEdges) console.log(`    ${pad(e.id, 10)} edge  ${pad(`${e.from} blocks ${e.to}`, 40)} ${provenance(e)}${said(e)}`);
    console.log(`    confirm with:  node run.mjs ${file} --confirm ${[...proposedWork, ...proposedEdges].map((x) => x.id).join(',')}`);
  }

  // The doctrine's own test, printed every run so it is answerable by reading the file: are the
  // edges arriving from runs, on the days runs happened, or in a batch from somebody reading
  // handbacks? A graph whose edges were all authored is a graph that never learned anything.
  const byRun = g.edges.filter((e) => (e.found_by ?? []).length);
  const days = [...new Set(byRun.map((e) => e.found_at.slice(0, 10)))].sort();
  console.log(`\n  edges: ${g.edges.length} total · ${g.edges.filter((e) => e.status === 'confirmed').length} confirmed · ${byRun.length} found by runs, over ${days.length} day(s)${days.length ? ` (${days.join(', ')})` : ''}`);
  // What it all cost, with the denominator. Attempts that reported no dollar cost are counted and
  // named as such rather than folded in as zero, because zero and unknown are not the same.
  // One accounting path, shared with the budget. A run that stops at a cap and a summary that
  // reports the spend disagreeing about the number would be worse than either alone.
  const s = spendSoFar(g);
  if (s.priced) {
    console.log(`  spent: ${s.output_tokens} output tokens · ${s.input_tokens} input tokens (incl. cache) · $${s.usd.toFixed(2)}` +
                ` · ${Math.round(s.api_ms / 1000)}s of model time, over ${s.priced} attempt${s.priced === 1 ? '' : 's'}` +
                `${s.unpriced ? ` (${s.unpriced} attempt${s.unpriced === 1 ? '' : 's'} reported no dollar cost)` : ''}`);
  } else if (g.attempts.length) {
    console.log(`  spent: ${s.output_tokens} output tokens · ${s.input_tokens} input tokens (incl. cache)` +
                ` · dollars unknown, none of the ${g.attempts.length} attempts reported dollar cost`);
  }
}
