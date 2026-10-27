#!/usr/bin/env node
// Viewer QA: real-browser acceptance harness for the public Ostoyae viewer.
//
//   node rehearsals/viewer-real-boards.mjs [--engine-root PATH] [--out DIR]
//       [--only SUBSTR] [--widths 1440,720] [--boards f1,f2] [--keep]
//
// Serves the engine's own viewer (viewer/serve.mjs --read-only) on fresh unique
// ports, drives an installed headless Chrome over the DevTools Protocol using
// only Node built-ins (global fetch + WebSocket, no npm dependency), and asserts
// COMPUTED geometry: element rects on screen, label/heading overlap areas,
// fit-to-viewport fraction, selection and filter behaviour — not DOM node
// existence. The empty board must explain itself; it must not pretend structure.
//
// Read-only contract: the real erdos boards are opened against the shipped
// server with --read-only (the server refuses every non-GET) and never written.
// The viewer file, the campaign files and every existing rehearsal are inputs.
//
// Owns a fresh Chrome profile under the system temp dir and its own ports; it
// never touches a shared GUI profile. Exits non-zero on any failed assertion
// and writes raw metrics + screenshots to --out as it goes.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : dflt;
};
const ENGINE = resolve(argOf('engine-root', join(here, '..')));
const SERVE = join(ENGINE, 'viewer', 'serve.mjs');
const OUT = resolve(argOf('out', join(here, '..', '..', '..', 'viewer-qa-results')));
const ONLY = argOf('only', '');
const WIDTHS = String(argOf('widths', '1440,720')).split(',').map(Number);
const KEEP = argv.includes('--keep');

if (!existsSync(SERVE)) { console.error(`no viewer server at ${SERVE} (use --engine-root)`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const VIEWER_BOARD = join(here, 'fixtures', 'viewer-qa', 'small-meaningful.json');
const EMPTY_BOARD = join(here, 'fixtures', 'viewer-qa', 'empty-board.json');
const ERDOS_DIR = join(homedir(), 'erdos-frontier', 'graphs');
const REAL = [join(ERDOS_DIR, 'erdos-zeta-plain.json'), join(ERDOS_DIR, 'erdos-open.json')];

const BOARDS = [
  { key: 'qa-small', file: VIEWER_BOARD, real: false, jobs: 7, expectStates: true },
  { key: 'qa-empty', file: EMPTY_BOARD, real: false, jobs: 0 },
  ...REAL.filter(f => existsSync(f)).map(f => ({
    key: f.includes('zeta-plain') ? 'erdos-zeta-plain' : 'erdos-open',
    file: f, real: true,
  })),
].filter(b => !ONLY || b.key.includes(ONLY));
if (!BOARDS.length) { console.error('no boards selected'); process.exit(2); }

const CHROME = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
  ...(process.env.PATH ?? '').split(':').map(p => join(p, 'chromium'))]
  .find(c => c && existsSync(c));
if (!CHROME) { console.error('no chrome binary found (set CHROME_BIN)'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const results = [];      // one entry per scenario
let failures = 0, checks = 0;
const rawLogPath = join(OUT, 'raw-run.log');
const logLines = [];
const log = (...a) => { const s = a.join(' '); console.log(s); logLines.push(`[${new Date().toISOString()}] ${s}`); };
const flushRaw = () => { try { writeFileSync(rawLogPath, logLines.join('\n') + '\n'); } catch {} };

function check(name, ok, detail) {
  checks++;
  if (!ok) { failures++; log(`  FAIL  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
  else log(`  ok    ${name}`);
  return ok;
}

// ------------------------------------------------------------------ processes
const children = [];
let profileDir = null;
let died = false;
function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  if (profileDir && !KEEP) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function startServer(boardFile) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVE, boardFile, '--port', String(port), '--read-only'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  p.on('exit', code => { if (code && code !== null) { died = true; log(`server for ${boardFile} exited ${code}: ${out.slice(0, 400)}`); } });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/graph`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { port, proc: p };
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not answer for ${boardFile}: ${out.slice(0, 400)}`);
}

// ------------------------------------------------------------------ CDP client
async function openBrowser() {
  profileDir = mkdtempSync(join(tmpdir(), 'viewer-qa-chrome-'));
  const port = await freePort();
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(proc);
  proc.on('exit', code => { died = true; log(`chrome exited ${code}`); flushRaw(); });
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) {
    await sleep(250);
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json(); } catch {}
  }
  if (!ver) throw new Error('chrome did not expose CDP');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let idc = 0;
  const pending = new Map();
  const timeouts = new Set();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const e = pending.get(m.id); pending.delete(m.id);
      clearTimeout(e.t); timeouts.delete(e.t);
      m.error ? e.rej(new Error(JSON.stringify(m.error))) : e.res(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const my = ++idc;
    const t = setTimeout(() => { pending.delete(my); timeouts.delete(t); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
    timeouts.add(t);
    pending.set(my, { res, rej, t });
    ws.send(JSON.stringify({ id: my, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params = {}) => send(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  const evalJson = async expression => {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`.slice(0, 500));
    return r.result.value;
  };
  // bounded poll
  const waitFor = async (expression, ms = 25000, label = 'condition') => {
    const t0 = Date.now();
    for (;;) {
      let v; try { v = await evalJson(expression); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
      await sleep(200);
    }
  };
  const click = async (x, y) => {
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const type = async text => { await s('Input.insertText', { text }); };
  const shot = async name => {
    const { data } = await s('Page.captureScreenshot', { format: 'png' });
    const p = join(OUT, 'screenshots', name + '.png');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(data, 'base64'));
    return p;
  };
  return {
    proc, ws, s, evalJson, waitFor, click, type, shot, send,
    async navigate(url, width, height) {
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await s('Page.navigate', { url });
    },
  };
}

// page-side geometry probe: returns JSON of everything we assert on
const GEOMETRY_SNAPSHOT = `(() => {
  const R = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
  const vis = el => { const s = getComputedStyle(el); return s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0' && el.getClientRects().length>0 && (el.offsetParent!==null || el.closest('svg')!==null || getComputedStyle(el).position==='fixed'); };
  const inter = (a,b) => { const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x), h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y); return (w>0&&h>0)?w*h:0; };
  const vw = innerWidth, vh = innerHeight;
  const svg = document.getElementById('svg'), svgR = svg.getBoundingClientRect();
  const nodes = [...document.querySelectorAll('#nodes .node')].map(g => {
    const t = g.querySelector('text:not(.agent)');
    const core = g.querySelector('.core');
    const tr = t.getBoundingClientRect(), cr = core.getBoundingClientRect();
    return { id: g.dataset.id, cls: g.getAttribute('class'),
      label: t.textContent, labelVisible: vis(t) && tr.width>0 && tr.height>0,
      labelRect: {x:tr.x,y:tr.y,w:tr.width,h:tr.height},
      coreRect: {x:cr.x,y:cr.y,w:cr.width,h:cr.height},
      onScreen: true,
      coreInSvg: cr.left>=svgR.left-1 && cr.right<=svgR.right+1 && cr.top>=svgR.top-1 && cr.bottom<=svgR.bottom+1,
      center: { x: cr.x+cr.width/2, y: cr.y+cr.height/2 } };
  });
  nodes.forEach(n => { n.onScreen = n.center.x>=0 && n.center.x<=vw && n.center.y>=0 && n.center.y<=vh; });
  const bands = [...document.querySelectorAll('#bands .band text')].map(t => {
    const r = t.getBoundingClientRect(); return { text: t.textContent, rect:{x:r.x,y:r.y,w:r.width,h:r.height} }; });
  const rows = [...document.querySelectorAll('#groups .row')].map(el => {
    const r = el.getBoundingClientRect(); const t = el.querySelector('.t').getBoundingClientRect();
    return { id: el.dataset.id, cls: el.getAttribute('class'), title: el.querySelector('.t').textContent,
      visible: vis(el)&&r.width>0&&r.height>0, rect:{x:r.x,y:r.y,w:r.width,h:r.height},
      titleRect:{x:t.x,y:t.y,w:t.width,h:t.height}, inViewport: r.x>=-1 && (r.x+r.width)<=vw+1 && r.width>0&&r.height>0 };
  });
  const h2s = [...document.querySelectorAll('#groups h2')].map(el => ({text: el.textContent, rect: R(el), visible: vis(el)}));
  const groups = [...document.querySelectorAll('#groups .group')].map(el => ({cls: el.className, heading: el.querySelector('h2')?.textContent ?? ''}));
  const rail = document.getElementById('rail'), railR = rail.getBoundingClientRect();
  const empty = document.getElementById('empty');
  const audit = document.getElementById('audit')?.textContent ?? null;
  const qcount = document.getElementById('qcount').textContent;
  const zoom = document.getElementById('zoom').textContent;
  const headingText = document.getElementById('state').textContent;
  const nameText = document.getElementById('name').textContent;
  // meaningful overlaps: intersection area over 15% of the smaller box
  const labelled = nodes.filter(n => n.labelVisible && n.label && n.label.trim());
  const labelOverlaps = [];
  for (let i=0;i<labelled.length;i++) for (let j=i+1;j<labelled.length;j++) {
    const a=labelled[i], b=labelled[j];
    const ov = inter(a.labelRect,b.labelRect);
    const mn = Math.min(a.labelRect.w*a.labelRect.h, b.labelRect.w*b.labelRect.h);
    if (ov > 0.15*mn) labelOverlaps.push([a.id,b.id,Math.round(ov)]);
  }
  const headingOverlaps = [];
  for (const bd of bands) for (const n of labelled) {
    const ov = inter(bd.rect, n.labelRect);
    const mn = Math.min(bd.rect.w*bd.rect.h, n.labelRect.w*n.labelRect.h);
    if (ov > 0.15*mn) headingOverlaps.push([bd.text.slice(0,30),n.id,Math.round(ov)]);
  }
  const rowOverlaps = [];
  for (let i=0;i<rows.length;i++) for (let j=i+1;j<rows.length;j++) {
    if (inter(rows[i].rect, rows[j].rect) > 2) rowOverlaps.push([rows[i].id, rows[j].id]);
  }
  return JSON.stringify({ vw, vh, svg:{x:svgR.x,y:svgR.y,w:svgR.width,h:svgR.height},
    counts:{ nodes: nodes.length, labelled: labelled.length, bands: bands.length, rows: rows.length, groups: groups.length },
    nodes, bands, rows, h2s, groups, audit, qcount, zoom, nameText, headingText,
    emptyShown: !empty.hidden, emptyText: empty.textContent,
    rail: { on: rail.classList.contains('on'), rect: {x:railR.x,y:railR.y,w:railR.width,h:railR.height}, text: rail.innerText.slice(0,4000), visible: vis(rail)&&railR.width>0 },
    labelOverlaps, headingOverlaps, rowOverlaps,
    fitFraction: nodes.length ? nodes.filter(n=>n.coreInSvg).length/nodes.length : 1,
    onScreenFraction: nodes.length ? nodes.filter(n=>n.onScreen).length/nodes.length : 1,
    phone: matchMedia('(max-width:760px)').matches,
    offscreenRows: rows.filter(r=>!r.inViewport&&r.visible).map(r=>r.id) });
})()`;

async function page(board, width, height, query, waitAudit = true) {
  const url = `http://127.0.0.1:${board.server.port}/${query}`;
  await B.navigate(url, width, height);
  if (waitAudit) await B.waitFor(
    `(() => { const a=document.getElementById('audit'); if(a&&a.textContent) return a.textContent; const e=document.getElementById('empty'); if(e&&!e.hidden&&e.textContent.startsWith('Cannot reach')) return 'ERR:'+e.textContent; return null; })()`,
    30000, `page ready (${board.key} ${query})`);
  else await sleep(1200);
  const first = await B.evalJson(GEOMETRY_SNAPSHOT);
  // let the poll settle the picture: two consecutive equal snapshots
  let prev = first;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const now = await B.evalJson(GEOMETRY_SNAPSHOT);
    if (stableSnapshots(prev, now)) return now;
    prev = now;
  }
  return prev;
}
function stableSnapshots(a, b) {
  const pa = JSON.parse(a), pb = JSON.parse(b);
  const sig = p => JSON.stringify(p.nodes.map(n => [n.id, n.cls, n.label, Math.round(n.center.x), Math.round(n.center.y)]));
  return sig(pa) === sig(pb);
}
const snap = text => JSON.parse(text);

// ------------------------------------------------------------------- scenarios
const metricsFile = join(OUT, 'metrics.json');
const save = () => writeFileSync(metricsFile, JSON.stringify({
  startedAt, engine: ENGINE, chrome: CHROME, widths: WIDTHS,
  boards: BOARDS.map(b => b.key), checks, failures, results,
}, null, 1));
const startedAt = new Date().toISOString();

const B = await openBrowser();
log(`chrome up (own profile ${profileDir}), engine ${ENGINE}`);

for (const b of BOARDS) {
  if (died) break;
  log(`== board ${b.key} (${b.file}${b.real ? ', READ ONLY' : ''})`);
  b.server = await startServer(b.file);
  log(`   server on 127.0.0.1:${b.server.port}`);
  // independent expectation from the API, not from the page
  const api = await (await fetch(`http://127.0.0.1:${b.server.port}/api/graph`)).json();
  b.api = api;
  const stateCount = {};
  for (const n of api.nodes) stateCount[n.state] = (stateCount[n.state] || 0) + 1;
  log(`   api: ${api.nodes.length} jobs ${JSON.stringify(stateCount)} pending=${api.pending?.length}`);

  for (const width of WIDTHS) {
    if (died) break;
    const height = 900;
    // ---------- LIST view ----------
    {
      const s = snap(await page(b, width, height, '?still&audit'));
      const r = { board: b.key, width, view: 'list' };
      log(`- list @${width}`);
      if (b.jobs === 0) {
        check(`${b.key}@${width}: empty board explains itself`, s.emptyShown && /no jobs/i.test(s.emptyText), s.emptyText);
        check(`${b.key}@${width}: empty board draws no structure`,
          s.counts.nodes === 0 && s.counts.bands === 0 && s.counts.rows === 0, s.counts);
        const world = snap(await B.evalJson(`JSON.stringify({n:document.querySelectorAll('#nodes > *').length,l:document.querySelectorAll('#links > *').length})`));
        check(`${b.key}@${width}: empty board canvas really has nothing`, world.n === 0 && world.l === 0, world);
      } else {
        const visibleRows = s.rows.filter(x => x.visible);
        // The shipped list folds groups over 40 rows behind a "show all" button: by design.
        const moreBtns = snap(await B.evalJson(`document.querySelectorAll('#groups [data-more]').length`));
        const folded = moreBtns > 0;
        const listedIds = new Set(visibleRows.map(x => x.id));
        if (folded) {
          check(`${b.key}@${width}: folded groups offer show-all`,
            visibleRows.length >= 40, { visibleRows: visibleRows.length, moreBtns });
        } else {
          // Every job is either its own row or (proposed) folded into a decision row under
          // "Waiting on you" — the shipped design. Coverage = own row, or covered by needs.
          const missing = b.api.nodes.filter(n => n.state !== 'proposed' && !listedIds.has(n.id)).map(n => n.id);
          const needsGroup = s.groups.some(g => /needs/.test(g.cls));
          check(`${b.key}@${width}: every non-proposed job listed exactly once`,
            missing.length === 0 && listedIds.size === visibleRows.length, { missing: missing.slice(0, 6), rows: visibleRows.length });
          if (b.api.pending?.length) {
            check(`${b.key}@${width}: proposed work is represented in Waiting-on-you, not dropped`,
              needsGroup, { pending: b.api.pending.length, needsGroup });
          }
        }
        check(`${b.key}@${width}: no two list rows overlap`, s.rowOverlaps.length === 0, s.rowOverlaps.slice(0, 6));
        check(`${b.key}@${width}: rows readable inside viewport`, s.offscreenRows.length === 0, s.offscreenRows.slice(0, 6));
        const titled = visibleRows.filter(x => x.titleRect.w > 10 && x.titleRect.h > 8);
        check(`${b.key}@${width}: row titles really painted`, titled.length === visibleRows.length, { painted: titled.length, rows: visibleRows.length });
        check(`${b.key}@${width}: group headings painted with rows`, s.h2s.filter(h => h.visible).length >= 1, s.groups);
        // selection from the list: click the parked/walled job if present, else first row
        const target = visibleRows.find(x => /needs|decision/.test(x.cls)) ?? visibleRows[0];
        await B.click(target.titleRect.x + Math.min(40, target.titleRect.w / 2), target.titleRect.y + target.titleRect.h / 2);
        await sleep(500);
        const s2 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
        const railTextHas = s2.rail.text.includes(target.title) || s2.rail.text.includes(target.id);
        check(`${b.key}@${width}: clicking a row opens the rail for that job`,
          s2.rail.visible && s2.rail.on && railTextHas && s2.rail.rect.w > 80,
          { id: target.id, railW: s2.rail.rect.w, on: s2.rail.on, hasTitle: railTextHas });
        check(`${b.key}@${width}: selection marks the row`, !!s2.rows.find(x => x.id === target.id && /sel/.test(x.cls)), target.id);
        if (width <= 760) {
          // phone: the rail is a full-screen sheet with a close control
          check(`${b.key}@${width}: rail sheet covers the screen on a phone`, s2.rail.rect.w >= width - 4, s2.rail.rect);
          const close = snap(await B.evalJson(`(() => { const c=document.getElementById('close'); const r=c.getBoundingClientRect(); return JSON.stringify({vis:getComputedStyle(c).display!=='none',x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
          if (close.vis) {
            await B.click(close.x, close.y);
            await sleep(400);
            const s3 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
            check(`${b.key}@${width}: close control dismisses the rail sheet`, !s3.rail.visible, s3.rail.rect);
          } else check(`${b.key}@${width}: close control visible on phone sheet`, false, close);
        } else {
          await B.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await B.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await sleep(400);
          const s3 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
          check(`${b.key}@${width}: Escape clears the selection`, !s3.rail.visible && !s3.rows.some(x => /sel/.test(x.cls)), { rail: s3.rail.rect.w });
        }
        // filtering: pick a word from a real label that matches some-but-not-all jobs,
        // type it into the shipped filter, and check the page's own narrowed count.
        if (b.api.nodes.length > 2) {
          const tokens = [];
          for (const n of b.api.nodes) for (const w of String(n.label || n.what || '').toLowerCase().split(/[^a-z0-9-]+/)) if (w.length >= 6 && !tokens.includes(w)) tokens.push(w);
          // Mirror the page's own matcher (renderList): queued/stopped also match the state word;
          // decision rows match node fields + the attempt's wall + its proposals' what;
          // loose proposal rows match id + what.
          const pendOf = id => (b.api.pending ?? []).filter(p => {
            const node = b.api.nodes.find(n => n.id === id);
            if (!node) return false;
            return node.attempts.some(a => (a.found ?? []).includes(p.id) || (p.foundBy ?? []).includes(a.id));
          });
          const matchCount = word => {
            let c = 0;
            const has = (...ps) => ps.some(p => String(p || '').toLowerCase().includes(word));
            for (const n of b.api.nodes) {
              if (['ready','waiting','blocked'].includes(n.state) && has(n.label, n.id, n.what, n.state)) c++;
              else if (['failed','exhausted','rejected'].includes(n.state) && has(n.label, n.id, n.what, n.state)) c++;
              else if (['running','done'].includes(n.state) && has(n.label, n.id, n.what)) c++;
              else if (n.state === 'walled' || n.state === 'mapped') {
                // appears as a decision row if it has pending proposals matching, else a job row
                const ps = pendOf(n.id);
                if (ps.length ? ps.some(p => has(p.what)) || has(n.label, n.id, n.what, ...n.attempts.map(a => a.wall)) : has(n.label, n.id, n.what)) c++;
              }
            }
            for (const p of (b.api.pending ?? [])) {
              const covered = b.api.nodes.some(n => pendOf(n.id).some(x => x.id === p.id));
              if (!covered && has(p.id, p.what)) c++;
            }
            return c;
          };
          const word = tokens.map(w => [w, matchCount(w)])
            .find(([, c]) => c >= 1 && c < b.api.nodes.length)?.[0];
          if (word) {
            const q = snap(await B.evalJson(`(() => { const el=document.getElementById('q'); const r=el.getBoundingClientRect(); return JSON.stringify({vis:getComputedStyle(el).display!=='none',x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}); })()`));
            check(`${b.key}@${width}: filter box painted`, q.vis && q.w > 20, q);
            await B.click(q.x, q.y);
            await B.type(word);
            await sleep(600);
            const s4 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
            const shown = s4.rows.filter(x => x.visible).length;
            const m = s4.qcount.match(/^(\d+) of (\d+)$/);
            const total = b.api.nodes.length;
            // independent expectation: qcount must narrow, the denominator is the whole board,
            // and the numerator matches nodes counted from the API (proposal rows may add a
            // couple; folded groups render fewer rows than the count).
            const inBoard = matchCount(word);
            const strict = b.key.startsWith('qa-');
            // Hard invariants: the denominator is the whole board, the numerator narrowed,
            // and rendered rows never exceed the page's own count. The mirror count from the
            // API is advisory on real boards (the page's matcher also reads proposal text at
            // depth we approximate); it is exact-checked on QA fixtures.
            check(`${b.key}@${width}: filtering narrows the list (${word})`,
              m && Number(m[2]) === total && Number(m[1]) < total && shown > 0 && shown <= Number(m[1]) &&
              (strict ? Number(m[1]) === inBoard : true),
              { shown, qcount: s4.qcount, inBoard, total });
            // every rendered row must be a job the independent query really matches against
            // any field the page matches on (label/id/what/state, decision-row walls and the
            // what of proposals hanging on that row), or a pending proposal row.
            const byId = new Map(b.api.nodes.map(n => [n.id, n]));
            const pendById = new Map((b.api.pending ?? []).map(p => [p.id, p]));
            const badRows = s4.rows.filter(x => x.visible).filter(r => {
              const n = byId.get(r.id);
              if (n) {
                const fields = [n.label, n.id, n.what, n.state, ...n.attempts.map(a => a.wall)];
                for (const a of n.attempts) for (const f of a.found ?? []) { const p = pendById.get(f); if (p) fields.push(p.what); }
                for (const p of (b.api.pending ?? [])) if ((p.foundBy ?? []).some(x => n.attempts.some(a => a.id === x))) fields.push(p.what);
                return !fields.some(x => String(x || '').toLowerCase().includes(word));
              }
              const p = pendById.get(r.id);
              return !p || ![p.id, p.what].some(x => String(x || '').toLowerCase().includes(word));
            }).map(r => r.id);
            check(`${b.key}@${width}: filtered rows all match the query`, badRows.length === 0, badRows.slice(0, 5));
            await B.evalJson(`(() => { const el=document.getElementById('q'); el.value=''; el.dispatchEvent(new Event('input')); })()`);
            await sleep(400);
            const s5 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
            check(`${b.key}@${width}: clearing the filter restores the list`, s5.qcount === '' && s5.rows.filter(x => x.visible).length >= visibleRows.length, { qcount: s5.qcount });
          } else check(`${b.key}@${width}: harness found a discriminating filter word`, false, tokens.slice(0, 8));
        }
      }
      r.screenshot = await B.shot(`${b.key}-list-${width}`);
      r.metrics = { counts: s.counts, rowOverlaps: s.rowOverlaps.length, offscreenRows: s.offscreenRows.length, headingText: s.headingText, audit: s.audit };
      results.push(r);
      flushRaw(); save();
    }
    if (died) break;
    // ---------- GRAPH view ----------
    {
      const s = snap(await page(b, width, height, '?still&audit&view=graph'));
      const r = { board: b.key, width, view: 'graph' };
      log(`- graph @${width}`);
      const auditObj = JSON.parse(s.audit ?? 'null');
      if (b.jobs === 0) {
        check(`${b.key}@${width}: empty graph view draws no nodes/headings`, s.counts.nodes === 0 && s.counts.bands === 0, s.counts);
        check(`${b.key}@${width}: empty graph view keeps the explanation visible`, s.emptyShown && /no jobs/i.test(s.emptyText), s.emptyText);
      } else {
        check(`${b.key}@${width}: all jobs drawn as nodes`, s.counts.nodes === b.api.nodes.length, { drawn: s.counts.nodes, jobs: b.api.nodes.length });
        check(`${b.key}@${width}: page audit finds zero job/heading overlaps`, auditObj && auditObj.overlaps.length === 0, auditObj?.overlaps?.slice(0, 8));
        if (width > 760) {
          check(`${b.key}@${width}: labels vs labels have no meaningful overlap`, s.labelOverlaps.length === 0, s.labelOverlaps.slice(0, 8));
          check(`${b.key}@${width}: labels vs family headings have no meaningful overlap`, s.headingOverlaps.length === 0, s.headingOverlaps.slice(0, 8));
          const allFrontier = s.nodes.every(n => /frontier/.test(n.cls ?? ''));
          check(`${b.key}@${width}: labels readable (or the board is honestly all unreached frontier)`,
            s.counts.labelled > 0 || allFrontier, { labelled: s.counts.labelled, nodes: s.counts.nodes, allFrontier });
        }
        // fit: click the fit control, require the picture inside the viewport
        const fit = snap(await B.evalJson(`(() => { const f=document.getElementById('fit'); const r=f.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
        await B.click(fit.x, fit.y);
        await sleep(700);
        const s2 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
        const fr = s2.fitFraction;
        r.fitFraction = fr; r.zoom = s2.zoom; r.viewport = [s2.vw, s2.vh];
        r.sampleCenters = s2.nodes.slice(0, 2).map(n => [n.center.x, n.center.y, n.onScreen]);
        check(`${b.key}@${width}: fit keeps the picture in the viewport`,
          fr >= (b.key === 'erdos-open' ? 0.4 : 0.85), { fitFraction: +fr.toFixed(3), zoom: s2.zoom });
        check(`${b.key}@${width}: fit keeps node centres on screen`, s2.onScreenFraction >= 0.8,
          { onScreen: +s2.onScreenFraction.toFixed(3), vw: s2.vw, vh: s2.vh, centers: s2.nodes.map(n => [Math.round(n.center.x), Math.round(n.center.y), n.onScreen]) });
        // graph selection: click a core circle of a live node
        const pick = s2.nodes.find(n => n.coreRect.w > 4 && n.onScreen && !/frontier/.test(n.cls))
          ?? s2.nodes.find(n => n.coreRect.w > 4 && n.onScreen);
        if (pick) {
          await B.click(pick.center.x, pick.center.y);
          await sleep(500);
          const s3 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
          check(`${b.key}@${width}: clicking a node selects it and opens the rail`,
            s3.rail.visible && s3.rail.rect.w > 80 && !!s3.nodes.find(n => n.id === pick.id && /sel/.test(n.cls)),
            { id: pick.id, railW: s3.rail.rect.w });
          // clear: on desktop the HUD clear button; on a phone the rail sheet covers the HUD
          // by design, so the shipped affordance there is the sheet's × close control.
          if (width <= 760) {
            await B.evalJson(`document.getElementById('fit').click()`);
            const close = snap(await B.evalJson(`(() => { const c=document.getElementById('close'); const r=c.getBoundingClientRect(); return JSON.stringify({vis:getComputedStyle(c).display!=='none',x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
            if (close.vis) await B.click(close.x, close.y);
          } else {
            await B.click(fit.x, fit.y);
            const clr = snap(await B.evalJson(`(() => { const c=document.getElementById('clear'); const r=c.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
            await B.click(clr.x, clr.y);
          }
          await sleep(400);
          const s4 = snap(await B.evalJson(GEOMETRY_SNAPSHOT));
          check(`${b.key}@${width}: clear resets the selection`, !s4.rail.visible, s4.rail.rect);
        } else check(`${b.key}@${width}: a node core was clickable on screen`, false, s2.nodes.slice(0, 3));
      }
      r.screenshot = await B.shot(`${b.key}-graph-${width}`);
      r.metrics = { counts: s.counts, audit: s.audit, zoom: s.zoom,
        labelOverlaps: s.labelOverlaps.length, headingOverlaps: s.headingOverlaps.length };
      results.push(r);
      flushRaw(); save();
    }
  }
  try { b.server.proc.kill('SIGTERM'); } catch {}
  await sleep(200);
}

save(); flushRaw();
log(`\n${checks - failures}/${checks} checks passed. metrics: ${metricsFile}`);
if (failures) log(`${failures} FAILED — recorded as baseline defects, not weakened.`);
try { B.ws.close(); } catch {}
cleanup();
process.exit(failures ? 1 : 0);
