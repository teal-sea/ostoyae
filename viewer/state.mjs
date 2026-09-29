// Derive board state once for both the runner and viewer, so the picture cannot disagree with scheduling.

import { createHash } from 'node:crypto';

// An attempt is one of three kinds. A prove attempt does the work. A map attempt does not touch
// the work: it says what the item settles, what it costs and what it needs, and hands that back
// as a map. A verify attempt is the judge: it reads what another attempt proposed, a wall or a
// map's tasks and edges, and hands back a verdict on each, and it touches neither the work nor
// the map. Records written before there were maps carry no `kind`, and every one of those was
// a prove.
export function kindOf(a) { return a?.kind ?? 'prove'; }

// What a confirmed edge was confirmed against: the text of both its ends at that moment. A
// downstream task that was confirmed to depend on "vendor the statement of 359" is not
// confirmed to depend on whatever that item says after someone rewrites it. Null when an end
// is not in the graph.
export function fingerprintOf(g, e) {
  const a = g.work.find((w) => w.id === e.from), b = g.work.find((w) => w.id === e.to);
  if (!a || !b) return null;
  // With an ontology the end's identity IS its claim hash, and its text is generated from the
  // claim, so the hash is the thing to remember. Without one, the text is all there is.
  const of = (w) => w.claim_hash ?? w.what ?? '';
  return createHash('sha1').update(`${of(a)}\n--\n${of(b)}`).digest('hex').slice(0, 16);
}

// The operator's rule, in one place, so the runner and anything drawing the graph cannot
// disagree about what a decision does. An edge keeps the status it was given. A work item
// becomes `active`, ordinary work indistinguishable from something a person typed into the
// file, or `rejected`. There is no third kind of work item.
export const LIMIT_RE = /rate[ _-]?limit|usage[ _]limit|session limit|too many requests|\b429\b|plan limit|out of (?:extra )?usage|hit your (?:\w+ )?limit|limit reached|overloaded_error|insufficient_quota|exceeded your current quota|resets \d+\s*(?:am|pm)/i;
// Do not count an immediate zero-cost failure as work attempted; it may only be a launch failure.
const nothingRan = (a) => a?.state === 'failed' && a?.result?.usage?.cost_usd === 0 && Number(a.result.usage.turns ?? 0) <= 1;
export const limited = (a) => !!(a?.result?.limited || (a?.result?.output ?? []).some((l) => LIMIT_RE.test(String(l))) || nothingRan(a));

export function decideOn(x, status, g = null) {
  const isEdge = String(x.id).startsWith('e-');
  x.status = isEdge ? status : (status === 'confirmed' ? 'active' : 'rejected');
  x.decided_at = new Date().toISOString();
  if (isEdge && status === 'confirmed' && g) x.fingerprint = fingerprintOf(g, x);
  return x;
}

export function derive(g, opts = {}) {
  // Looked up live rather than through a Map built once. A run appends proposed work items to
  // `g.work` while it is going, so a snapshot taken at derive() time would answer questions
  // about a graph that no longer exists, and the runner binds these predicates once, at start.
  const idx = !!opts.index;
  const wIdx = idx ? new Map(g.work.map((w) => [w.id, w])) : null;
  const aIdx = idx ? (() => {
    const m = new Map();
    for (const a of g.attempts) { const k = a.of; if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return m;
  })() : null;
  const memo = (f) => {
    if (!idx) return f;
    const m = new Map();
    return (id) => { if (m.has(id)) return m.get(id); const v = f(id); m.set(id, v); return v; };
  };
  const workOf = idx ? ((id) => wIdx.get(id)) : ((id) => g.work.find((w) => w.id === id));
  const isEdgeId = (id) => String(id).startsWith('e-');
  const lookup = (id) => (isEdgeId(id) ? g.edges.find((e) => e.id === id) : workOf(id));
  const statusOf = (x) => x?.status ?? 'active';

  // An edge confirmed against text that has since changed is stale: the yes was given to a
  // different sentence. It schedules nothing until it is confirmed again. An edge with no
  // fingerprint predates fingerprints and is taken as written.
  const fresh = (e) => e.fingerprint == null || e.fingerprint === fingerprintOf(g, e);
  const stale = () => g.edges.filter((e) => e.status === 'confirmed' && !fresh(e));

  // "from blocks to". Only confirmed, fresh edges between two live work items schedule anything.
  const effective = () => g.edges.filter((e) =>
    e.status === 'confirmed' && fresh(e) &&
    statusOf(workOf(e.from)) === 'active' &&
    statusOf(workOf(e.to)) === 'active');

  const needsOf = memo((id) => [...new Set([
    ...(workOf(id)?.needs ?? []),
    ...effective().filter((e) => e.to === id).map((e) => e.from),
  ])]);

  const attemptsOf = idx ? ((id) => aIdx.get(id) ?? []) : ((id) => g.attempts.filter((a) => a.of === id));
  // The attempts that worked on the item, as opposed to the ones that judged another attempt's
  // handback. A verify attempt is filed under the item it concerns, so the record reads in one
  // place, and it must not be the "last attempt" that parks or unparks the item.
  const workAttemptsOf = memo((id) => attemptsOf(id).filter((a) => kindOf(a) !== 'verify'));
  const proveAttemptsOf = memo((id) => attemptsOf(id).filter((a) => kindOf(a) === 'prove'));
  const mapAttemptsOf = (id) => attemptsOf(id).filter((a) => kindOf(a) === 'map');
  const verifyAttemptsOf = (id) => attemptsOf(id).filter((a) => kindOf(a) === 'verify');

  // The judge is on when the graph carries the instruction handed to every verify attempt.
  const judgeOn = () => typeof g.judge?.verify === 'string' && !!g.judge.verify.trim();
  // The proposals an attempt handed back, as the things themselves.
  const proposalsOf = (a) => (a?.result?.found ?? []).map(lookup).filter(Boolean);
  // A settled attempt that proposed something and has not been judged yet. Any kind but verify:
  // a map's tasks, a wall's tasks and a failed attempt's tasks are all claims until judged.
  // A failed verify attempt (no verdicts handed back) is retried, up to `judge.max_attempts`,
  // default 1, counted the way map attempts are: a judge that could not judge is not a verdict.
  const verifyMax = () => g.judge?.max_attempts ?? 1;
  const pendingVerify = () => !judgeOn() ? [] : g.attempts.filter((a) => {
    if (kindOf(a) === 'verify' || a.state === 'running' || !(a.result?.found ?? []).length) return false;
    const vs = g.attempts.filter((v) => kindOf(v) === 'verify' && v.judges === a.id);
    return !vs.some((v) => v.state === 'done' || v.state === 'running') && vs.length < verifyMax();
  });

  // Mapping is on when the graph says so, and off when the key is absent. Its `max_attempts`
  // counts failed map attempts only: a walled map found structure and is not spent, and a done
  // one is the map. An item is mapped when it carries a map, whether a map attempt wrote it or
  // a person typed it in.
  const mappingOn = () => !!g.mapping;
  const mapMax = () => g.mapping?.max_attempts ?? 1;
  // Treat map-proposed work as mapped already so it can proceed to proof after confirmation.
  const bornOfMap = (w) => (w?.found_by ?? []).some((id) => kindOf(g.attempts.find((a) => a.id === id)) === 'map');
  const hasMap = (id) => { const w = workOf(id); const m = w?.map; return (!!m && typeof m === 'object') || bornOfMap(w); };
  const mapSpent = (id) => mapAttemptsOf(id).filter((a) => a.state === 'failed' && !limited(a)).length;

  // Satisfied means proved. A done map attempt is the map, not the work.
  const satisfied = memo((id) => proveAttemptsOf(id).some((a) => a.state === 'done'));
  // Answered, and the answer was no. A question is done either way and its work merges either
  // way; what changes is what may stand on it. An item that needed this one true is not
  // unblocked by its refutation, it is blocked by it, the way an exhausted need blocks, and the
  // status line names the refuted need so the reader is not left with a bare `waiting`.
  const refuted = memo((id) => proveAttemptsOf(id).some((a) => a.state === 'done' && a.result?.answer === false));
  const running = (id) => attemptsOf(id).some((a) => a.state === 'running');
  const spent = (id) => proveAttemptsOf(id).filter((a) => !limited(a)).length;
  // Two budgets, and either one ends the item: the proves are used up, or mapping is on, the
  // item has no map, and the map attempts are used up. An unmapped item never proves while
  // mapping is on, so the second is as final as the first.
  const exhausted = memo((id) => !satisfied(id) && !running(id) &&
    (spent(id) >= g.max_attempts || (mappingOn() && !hasMap(id) && mapSpent(id) >= mapMax())));

  // Include proposals an attempt joined as a second finder, not only new proposals in `result.found`. A duplicate dependency can still park its source.
  const namedOpen = (a) => {
    if (!a) return [];
    const ids = new Set(a.result?.found ?? []);
    for (const x of [...g.work, ...g.edges]) {
      if (statusOf(x) === 'proposed' && (x.found_by ?? []).includes(a.id)) ids.add(x.id);
    }
    return [...ids];
  };

  const openProposals = (a) => namedOpen(a).filter((id) => statusOf(lookup(id)) === 'proposed');

  // Unjudged dependencies hold their source. Refuted edges release it; refuted work needs your decision. Judged side discoveries without a live dependency path stay reviewable without holding the source.
  const liveClaim = (e) => (e.status === 'proposed' || e.status === 'confirmed') && e.verdict?.ok !== false;
  const reachesItem = (fromId, toId) => {
    if (fromId === toId) return true;
    const seen = new Set([fromId]);
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of g.edges) {
        if (!liveClaim(e) || e.from !== cur || seen.has(e.to)) continue;
        if (e.to === toId) return true;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return false;
  };
  const blockingOpen = (id, a) => namedOpen(a).filter((pid) => {
    const x = lookup(pid);
    if (!x || statusOf(x) !== 'proposed') return false;
    if (isEdgeId(pid)) {
      if (x.verdict?.ok === false) return false;
      return x.to === id || reachesItem(x.to, id);
    }
    if (x.verdict?.ok === false) return true;
    if (x.verdict?.ok === true) return reachesItem(pid, id);
    return true;
  });

  function walled(id) {
    const as = workAttemptsOf(id);
    const last = as[as.length - 1];
    return !!last && last.state === 'walled' && blockingOpen(id, last).length > 0;
  }

  // A map with unresolved dependencies parks its source until you answer. Refuted dependencies and judged side discoveries do not hold it.
  function awaitingMap(id) {
    const as = workAttemptsOf(id);
    const last = as[as.length - 1];
    return !!last && kindOf(last) === 'map' && last.state === 'done' && blockingOpen(id, last).length > 0;
  }

  const parked = (id) => walled(id) || awaitingMap(id);

  // What the next attempt at this item would be. With mapping on, an item is mapped before it
  // is proved; with it off, everything is a prove, which is what every graph was before maps.
  const nextKind = (id) => (mappingOn() && !hasMap(id) ? 'map' : 'prove');

  // `path` is the chain being walked right now, not everything ever seen. It has to be copied
  // per branch: sharing one set across siblings makes a diamond read as a cycle. Two jobs that
  // both need a third is a diamond, and it is the shape a scout's handback produces most often.
  function blocked(id, path = new Set()) {
    if (path.has(id)) return true;          // a cycle is a permanent block, not a crash
    const onward = new Set(path).add(id);
    return needsOf(id).some((n) => exhausted(n) || refuted(n) || blocked(n, onward));
  }

  const schedulable = (w) => statusOf(w) === 'active';

  // Rank work by the unsatisfied items it can unlock through confirmed edges; proposed edges cannot spend work before approval.
  const unlocks = (id, seen = new Set()) => {
    for (const e of effective()) {
      if (e.from === id && !seen.has(e.to)) { seen.add(e.to); unlocks(e.to, seen); }
    }
    return seen;
  };
  const leverage = memo((id) => [...unlocks(id)].filter((t) => !satisfied(t)).length);

  // Start ready proves before new maps, each by leverage. Mapping can run before an item's dependencies because it commits no work.
  const ready = () => {
    const rs = g.work
      .filter(schedulable)
      .filter((w) => !satisfied(w.id) && !running(w.id) && !exhausted(w.id) && !blocked(w.id) && !parked(w.id))
      .filter((w) => nextKind(w.id) === 'map' || needsOf(w.id).every((n) => satisfied(n)));
    // Scored once per call, not per comparison. The sort is stable, so a board with no confirmed
    // edges keeps file order exactly, which is what every graph was before the chooser.
    const score = new Map(rs.map((w) => [w.id, leverage(w.id)]));
    const byLeverage = (a, b) => score.get(b.id) - score.get(a.id);
    return [...rs.filter((w) => nextKind(w.id) === 'prove').sort(byLeverage),
            ...rs.filter((w) => nextKind(w.id) === 'map').sort(byLeverage)];
  };

  const inFlight = () => g.attempts.filter((a) => a.state === 'running').length;

  // One word per work item, for the picture. Ordered by precedence, most specific first, and it
  // has to match `ready()` above or the viewer lies: anything `ready()` returns is `ready`, and
  // everything else has a reason it is not.
  const readyIds = () => new Set(ready().map((w) => w.id));
  function stateOf(id, rs = readyIds()) {
    const w = workOf(id);
    const st = statusOf(w);
    if (st === 'proposed') return 'proposed';
    if (st === 'rejected') return 'rejected';
    if (running(id)) return 'running';
    if (satisfied(id)) return 'done';
    if (walled(id)) return 'walled';
    if (awaitingMap(id)) return 'mapped';
    if (exhausted(id)) return 'exhausted';
    if (blocked(id)) return 'blocked';
    if (rs.has(id)) return 'ready';
    return 'waiting';                       // dependencies exist and are not satisfied yet
  }

  // Depth from the roots, for layout. A cycle stops at its first repeat rather than hanging.
  function depth(id, seen = new Set()) {
    if (seen.has(id)) return 0;
    seen.add(id);
    const ns = needsOf(id);
    return ns.length ? 1 + Math.max(...ns.map((n) => depth(n, new Set(seen)))) : 0;
  }

  // The accumulation line, as data. This is the test the whole design is for: edges arriving
  // from runs, spread over the days runs happened. One batch on one day is a person reading
  // handbacks, not a loop closing.
  function accumulation() {
    const byRun = g.edges.filter((e) => e.found_by?.length && e.found_at);
    const days = [...new Set(byRun.map((e) => e.found_at.slice(0, 10)))].sort();
    return {
      total: g.edges.length,
      confirmed: g.edges.filter((e) => e.status === 'confirmed').length,
      byRun: byRun.length,
      days,
    };
  }

  return {
    workOf, lookup, statusOf, needsOf, attemptsOf, satisfied, refuted, running, spent,
    exhausted, walled, blocked, schedulable, ready, inFlight, openProposals, unlocks, leverage,
    stateOf, readyIds, depth, accumulation, effective, fresh, stale,
    kindOf, proveAttemptsOf, mapAttemptsOf, verifyAttemptsOf, workAttemptsOf, mappingOn, mapMax, hasMap, mapSpent,
    awaitingMap, parked, nextKind, decideOn, judgeOn, proposalsOf, pendingVerify, blockingOpen,
  };
}
