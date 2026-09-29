import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { read, send } from './messaging.mjs';

const pause = new Int32Array(new SharedArrayBuffer(4));

// The Muse shell can write its temp root but not the board's sibling mailbox. A request
// crosses that boundary through files in temp; the runner alone performs mailbox writes.
export function request(dir, payload) {
  const id = randomUUID(), input = join(dir, `${id}.request.json`), output = join(dir, `${id}.response.json`);
  writeFileSync(`${input}.partial`, JSON.stringify(payload) + '\n', { flag: 'wx' });
  renameSync(`${input}.partial`, input);
  const until = Date.now() + 10000;
  while (!existsSync(output)) {
    if (Date.now() >= until) throw Error('mail relay did not answer; retry');
    Atomics.wait(pause, 0, 0, 20);
  }
  let result;
  try { result = JSON.parse(readFileSync(output, 'utf8')); }
  finally { rmSync(output, { force: true }); }
  if (result.error) throw Error(result.error);
  return result.value;
}

export function serve(dir, mailbox, board, cap) {
  for (const name of readdirSync(dir).filter(x => x.endsWith('.request.json'))) {
    const input = join(dir, name), output = join(dir, name.replace('.request.json', '.response.json'));
    let result;
    try {
      const q = JSON.parse(readFileSync(input, 'utf8'));
      const state = JSON.parse(readFileSync(board, 'utf8'));
      const running = x => {
        if (x.state !== 'running' || !Number.isSafeInteger(x.cell_pid)) return false;
        try { process.kill(x.cell_pid, 0); return true; } catch { return false; }
      };
      if (q.op === 'send') {
        if (q.to !== 'all' && !state.attempts.some(x => x.id === q.to && running(x))) throw Error(`${q.to} is not running now`);
        result = { value: send(mailbox, q.attempt, q.to, q.text, cap) };
      }
      else if (q.op === 'read') result = { value: read(mailbox, q.attempt) };
      else if (q.op === 'who') result = { value: state.attempts.filter(x => x.id !== q.attempt && running(x)) };
      else throw Error('unknown mail operation');
    } catch (e) { result = { error: e.message }; }
    writeFileSync(`${output}.partial`, JSON.stringify(result) + '\n');
    renameSync(`${output}.partial`, output);
    rmSync(input, { force: true });
  }
}
