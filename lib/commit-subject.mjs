// Bounded Git commit subjects for cell harness commits.
// Full task prompts belong in the run record, not in `git log --oneline`.

const MAX = 72;

/** Prefer a human label, else the work id. Never the agent prompt (`what`). */
export function commitSubject(a = {}, prefix = '') {
  const raw = String(a.label ?? a.of ?? '').trim().replace(/\s+/g, ' ');
  let body = raw || String(a.of ?? 'work');
  if (body.length > MAX) body = `${body.slice(0, MAX - 1).trimEnd()}…`;
  return `${prefix}${body}`;
}

/** Full harness message: subject, blank line, Attempt/Work trailers. */
export function commitMessage(a = {}, prefix = '') {
  return `${commitSubject(a, prefix)}\n\nAttempt: ${a.id ?? '?'}\nWork: ${a.of ?? '?'}`;
}
