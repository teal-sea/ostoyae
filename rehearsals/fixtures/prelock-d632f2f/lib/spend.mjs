// What the record says was spent, and which budget, if any, is spent.

// What has been spent, over the whole record rather than this run. An attempt whose usage came
// back `_bad` is unknown, not zero: it is left out of the sums and counted separately, because a
// budget enforced against a number nobody has is a budget that lies.
export const hasDollarCost = (a) => a.result?.usage && !a.result.usage._bad &&
  Number.isFinite(a.result.usage.cost_usd) && a.result.usage.cost_usd >= 0;
export const hasOutputTokens = (a) => a.result?.usage && !a.result.usage._bad &&
  Number.isSafeInteger(a.result.usage.output_tokens) && a.result.usage.output_tokens >= 0;
export function spendSoFar(g) {
  const measured = g.attempts.filter((a) => a.result?.usage && !a.result.usage._bad);
  const priced = measured.filter(hasDollarCost);
  const sum = (k) => measured.reduce((t, a) => t +
    (Number.isFinite(a.result.usage[k]) && a.result.usage[k] >= 0 ? a.result.usage[k] : 0), 0);
  return {
    usd: priced.reduce((t, a) => t + a.result.usage.cost_usd, 0),
    output_tokens: sum('output_tokens'),
    token_measured: measured.filter(hasOutputTokens).length,
    input_tokens: sum('input_tokens') + sum('cache_read_input_tokens') + sum('cache_creation_input_tokens'),
    api_ms: sum('api_ms'),
    priced: priced.length,
    unpriced: g.attempts.length - priced.length,
  };
}

// Which budget is spent, in words, or null. Words rather than a boolean so the run can say what
// stopped it: "stopped at the budget" without naming which one is the failure mode this whole
// change is about.
//
// Spend only lands when an attempt settles, so at concurrency N this can overshoot by up to N
// attempts. That is inherent: the cost of a session is not known until it ends. It is why these
// are budgets and not limits.
// What one attempt of this kind has been costing, from the record. Kinds are budgeted apart in
// this engine and they cost differently: a mapper is cents, a prove is dollars, so an average
// over both underestimates the next prove badly.
export function costOfKind(g, kind) {
  const priced = g.attempts.filter((a) => (a.kind ?? 'prove') === kind &&
                                          hasDollarCost(a));
  if (!priced.length) return null;
  return priced.reduce((t, a) => t + (Number(a.result.usage.cost_usd) || 0), 0) / priced.length;
}

// The dearest one attempt of this kind has cost. Not the default reservation, and deliberately
// not: reserving at the worst price seen makes a run refuse cheap work that would have fit,
// which is a policy about how the operator's money gets spent and is the operator's to choose,
// not the engine's to assume. It is what `--reserve-usd` is for, and this is the number to pass
// it when a run must not pass its cap.
//
// The worked example, so the choice can be made on numbers instead of on feel: on 2026-09-04 the
// lean-eval board's proves ranged $0.69 to $35.37 -- a Magnus attempt that thought for forty
// minutes, against definitions that landed in one. The mean was $2.68, six were in flight, and a
// $275 cap took $314.40. `--reserve-usd 35` would have held it, and would also have stopped
// launching once the run came within $35 of the cap.
export function dearestOfKind(g, kind) {
  const priced = g.attempts.filter((a) => (a.kind ?? 'prove') === kind &&
                                          hasDollarCost(a));
  if (!priced.length) return null;
  return Math.max(...priced.map((a) => Number(a.result.usage.cost_usd) || 0));
}

// A kind nobody has paid for yet launches ALONE. No estimate can predict a cost it has never
// seen: on 2026-08-31 three proves of unknown price launched together against a budget informed
// only by cheap mappers, and cost $13.97 between them. One attempt of a new kind settles, its
// price enters the record, and the reservation is then real. This bounds first-wave exposure to
// a single attempt instead of to concurrency.
export function unpricedKindBusy(g, kind, RESERVE_USD) {
  if (RESERVE_USD || costOfKind(g, kind) !== null) return false;
  return g.attempts.some((a) => a.state === 'running' && (a.kind ?? 'prove') === kind);
}

// The figure a launch is judged against, so the summary can say what was actually used rather
// than recomputing it and risking a different answer.
export function reserveUsed(g, RESERVE_USD) {
  const s = spendSoFar(g);
  return RESERVE_USD || costOfKind(g, 'prove') || (s.priced ? s.usd / s.priced : 0);
}

export function overBudget(g, { MAX_INVOCATIONS, MAX_USD, MAX_OUTPUT_TOKENS, RESERVE_USD }) {
  // First, because it is the only cap here that does not depend on the executor reporting
  // anything. The dollar and token caps below refuse to bind at all when usage is missing, and
  // say so; this one reads the record itself, so it still holds when an executor tells us
  // nothing. It is also the only one that survives a restart: `launched` is per-invocation,
  // `attempts[]` is the file.
  if (MAX_INVOCATIONS && g.attempts.length >= MAX_INVOCATIONS)
    return `the invocation allowance of ${MAX_INVOCATIONS}, all roles, with ${g.attempts.length} already on the record`;
  const s = spendSoFar(g);
  const unpriced = g.attempts.filter((a) => a.state !== 'running' && !hasDollarCost(a));
  if (MAX_USD && unpriced.length) {
    const provider = unpriced.every((a) => a.result?.usage?.executor === 'codex') ? 'Codex ' : '';
    return `unknown ${provider}dollar cost on ${unpriced.length} attempt(s); --max-usd cannot account for unreported spend`;
  }
  // The attempt about to launch is reserved for too, not just the ones already running: the
  // question a budget answers is "would launching this exceed the cap", and counting only
  // in-flight attempts let a second expensive launch through whose own cost was the one that
  // busted it.
  const running = g.attempts.filter((a) => a.state === 'running').length;
  const reserve = RESERVE_USD || costOfKind(g, 'prove') || (s.priced ? s.usd / s.priced : 0);
  const projected = s.usd + (running + 1) * reserve;
  if (MAX_USD && projected >= MAX_USD)
    return `the $${MAX_USD.toFixed(2)} budget, with $${s.usd.toFixed(2)} spent` +
           (running ? ` and ${running} in flight reserved at $${reserve.toFixed(2)} each` : '');
  if (MAX_OUTPUT_TOKENS) {
    const unknown = g.attempts.filter((a) => a.state !== 'running' && !hasOutputTokens(a));
    if (unknown.length) return `unknown output-token cost on ${unknown.length} attempt(s); --max-output-tokens cannot account for unreported spend`;
    const perAttempt = s.token_measured ? s.output_tokens / s.token_measured : 0;
    if (s.output_tokens + (running + 1) * perAttempt >= MAX_OUTPUT_TOKENS)
      return `the ${MAX_OUTPUT_TOKENS} output-token budget, with ${s.output_tokens} spent` +
             (running ? ` and ${running} in flight reserved at ${Math.round(perAttempt)} each` : '');
  }
  return null;
}
