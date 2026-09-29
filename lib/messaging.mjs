import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const pause = new Int32Array(new SharedArrayBuffer(4));
export const defaults = { max_chars: 2000, max_sends: 20 };

export function limits(value) {
  const result = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  for (const [key, n] of Object.entries(result))
    if (!['max_chars', 'max_sends'].includes(key) || !Number.isSafeInteger(n) || n < 1)
      throw Error(`messaging.${key} needs a positive integer`);
  return result;
}

export function entries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function cursorPath(mailbox, attempt) { return `${mailbox}.${attempt}.cursor`; }
export function reads(mailbox, attempt) {
  try { return JSON.parse(readFileSync(cursorPath(mailbox, attempt), 'utf8')).reads ?? 0; }
  catch { return 0; }
}

export function startCursor(mailbox, attempt) {
  locked(mailbox, () => writeFileSync(cursorPath(mailbox, attempt),
    JSON.stringify({ offset: entries(mailbox).length, reads: 0 }) + '\n'));
}

// A directory lock serializes both append and cursor updates. A line is one appendFileSync
// call, and the lock also makes the send count a hard limit under concurrent writers.
export function locked(mailbox, action) {
  const path = `${mailbox}.lock`;
  const until = Date.now() + 5000;
  while (true) {
    try { mkdirSync(path); break; }
    catch (e) {
      if (e.code !== 'EEXIST' || Date.now() >= until) throw Error('mailbox is busy; retry');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try { return action(); } finally { rmdirSync(path); }
}

export function send(mailbox, from, to, text, cap) {
  if (!text || text.length > cap.max_chars) throw Error(`message must be 1 to ${cap.max_chars} characters`);
  return locked(mailbox, () => {
    const all = entries(mailbox);
    if (all.filter(x => x.from === from).length >= cap.max_sends)
      throw Error(`send limit reached: ${cap.max_sends} messages per attempt`);
    const entry = { id: randomUUID(), at: new Date().toISOString(), from, to, text };
    appendFileSync(mailbox, JSON.stringify(entry) + '\n');
    return entry;
  });
}

// A message from the runner itself, sender `ostoyae`. Not an attempt, so no send budget.
// `extra` rides on the entry so the board can say structurally what the notice was about.
export function notice(mailbox, to, text, extra = {}) {
  return locked(mailbox, () => {
    const entry = { id: randomUUID(), at: new Date().toISOString(), from: 'ostoyae', to, text, ...extra };
    appendFileSync(mailbox, JSON.stringify(entry) + '\n');
    return entry;
  });
}

export function read(mailbox, attempt) {
  return locked(mailbox, () => {
    const all = entries(mailbox);
    let cursor = { offset: 0, reads: 0 };
    try { cursor = JSON.parse(readFileSync(cursorPath(mailbox, attempt), 'utf8')); } catch {}
    const unread = all.slice(cursor.offset).filter(x => x.from !== attempt && (x.to === attempt || x.to === 'all'));
    if (all.length !== cursor.offset) {
      const next = { offset: all.length, reads: (cursor.reads ?? 0) + unread.length };
      writeFileSync(cursorPath(mailbox, attempt), JSON.stringify(next) + '\n');
    }
    return unread;
  });
}
