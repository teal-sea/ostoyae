// Reserve an OS-selected port and a cross-process claim until its cell finishes.
// The socket is closed just before execution so the cell can bind it. The claim
// prevents another Ostoyae cell choosing it during that gap.
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export async function reservePort() {
  const dir = join(tmpdir(), `ostoyae-cell-ports-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 100; n++) {
    const socket = createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port, file = join(dir, `${port}.json`), token = randomUUID();
    const close = () => new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    try { writeFileSync(file, JSON.stringify({ token, pid: process.pid, created: new Date().toISOString() }), { flag: 'wx' }); }
    catch (e) { await close(); if (e.code === 'EEXIST') continue; throw e; }
    let listening = true;
    return {
      port,
      async activate() { if (listening) { await close(); listening = false; } },
      async release() {
        if (listening) { await close(); listening = false; }
        const record = JSON.parse(readFileSync(file, 'utf8'));
        if (record.token !== token) throw new Error(`port ${port} claim changed; preserved`);
        unlinkSync(file);
      },
    };
  }
  throw new Error('could not reserve a free cell port after 100 attempts');
}
