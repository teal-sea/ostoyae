// viewer-layout-probe: reads the real DOM geometry of the shipped page over Chrome DevTools
// Protocol (stdpipes, zero deps) and asserts the viewer-layout invariants it can see.
//
//   node rehearsals/viewer-layout-probe.mjs <boardUrl> <width> <height> <checks> [expectedNodes]
//
// checks is a comma-separated subset of:
//   audit-zero        the page's own `?still&audit` overlap report is empty
//   fit-frames        the page's own fit control leaves every node centre on screen, the cores
//                     inside the canvas, and at least one core big enough to click
//   nodes-drawn       the graph drew exactly [expectedNodes] nodes
//   edgeless-note     the HUD says the board has no dependencies when it has none
//   linked-note-off   the HUD stays quiet when the board does have dependencies
// Exits 0 when every requested check passed, 1 when any failed and 2 on a harness fault
// (the page never settled, the browser could not start). A missing browser is skipped above
// this file: the rehearsal prints an explicit skip line instead of counting a pass.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, w, h, checksArg = '', expectNodes = ''] = process.argv.slice(2);
const checks = new Set(checksArg.split(',').filter(Boolean));
const udd = mkdtempSync(join(tmpdir(), 'viewer-layout-chrome-'));
// Only this probe's own browser and profile: killed and removed on every exit path.
const die = async code => {
  try { chrome.kill('SIGKILL'); } catch {}
  await new Promise(r => { chrome.once('exit', r); setTimeout(r, 2000); });
  try { rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${udd}`, `--window-size=${w},${h}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let id = 0, sessionId = null;
const pending = new Map();
const eventsOnce = [];
const waitEvent = name => new Promise(res => eventsOnce.push([name, res]));
let buf = '';
chrome.stdio[4].on('data', chunk => {
  buf += chunk.toString();
  let zl;
  while ((zl = buf.indexOf('\0')) > -1) {
    const line = buf.slice(0, zl); buf = buf.slice(zl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) {
      const { res, rej, method } = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result);
    } else if (m.method && sessionId && m.sessionId === sessionId) {
      for (let i = eventsOnce.length - 1; i >= 0; i--) if (eventsOnce[i][0] === m.method) eventsOnce.splice(i, 1)[0][1](m.params || {});
    }
  }
});
const send = (method, params = {}) => {
  const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
  chrome.stdio[3].write(JSON.stringify(msg) + '\0');
  return new Promise((res, rej) => pending.set(msg.id, { res, rej, method }));
};
const evalJs = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

// What the checks read, measured on the painted page: the page's own audit JSON, the HUD
// sentence, and every node core as a screen rect. Geometry, never node presence.
const SNAPSHOT = `(() => {
  const svgR = document.getElementById('svg').getBoundingClientRect();
  const nodes = [...document.querySelectorAll('#nodes .node')].map(g => {
    const cr = g.querySelector('.core').getBoundingClientRect();
    return { id: g.dataset.id, core: { w: cr.width, h: cr.height },
      center: { x: cr.x + cr.width / 2, y: cr.y + cr.height / 2 },
      inSvg: cr.left >= svgR.left - 1 && cr.right <= svgR.right + 1 && cr.top >= svgR.top - 1 && cr.bottom <= svgR.bottom + 1 };
  });
  const vw = innerWidth, vh = innerHeight;
  for (const n of nodes) n.onScreen = n.center.x >= 0 && n.center.x <= vw && n.center.y >= 0 && n.center.y <= vh;
  const note = document.getElementById('graphnote');
  return JSON.stringify({
    audit: (() => { const a = document.getElementById('audit'); return a ? JSON.parse(a.textContent) : null; })(),
    noteHidden: note ? note.hidden : null, noteText: note ? note.textContent : '',
    zoom: document.getElementById('zoom').textContent, nodes, vw, vh,
    fit: nodes.length ? nodes.filter(n => n.inSvg).length / nodes.length : 1,
    onScreen: nodes.length ? nodes.filter(n => n.onScreen).length / nodes.length : 1,
    clickable: nodes.filter(n => n.onScreen && n.core.w > 4).length,
    hit: nodes.length ? Math.max(...nodes.map(n => (n.onScreen ? n.core.w : 0))) : 0,
  });
})()`;

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = att.sessionId;
  await send('Page.enable');
  await send('Runtime.enable');
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url });
  await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), 15000))]);

  const ok = await evalJs(`(async () => {
    await new Promise((res, rej) => {
      let n = 0;
      const t = setInterval(() => {
        const name = document.getElementById('name').textContent !== 'connecting';
        const rows = document.querySelectorAll('.row').length > 0;
        const zoom = document.getElementById('zoom').textContent.includes('%');
        if (name && (rows || zoom)) { clearInterval(t); res(); }
        if (++n > 150) { clearInterval(t); rej(new Error('page did not settle')); }
      }, 100);
    });
    return true;
  })()`);
  if (!ok) throw new Error('page did not settle');
  await sleep(700);
  const goods = JSON.parse(await evalJs(SNAPSHOT));

  let fails = 0;
  const check = (name, okd, detail) => { console.log(`${okd ? '  ok    ' : '  FAIL  '}${name}${detail ? ` (${detail})` : ''}`); if (!okd) fails++; };
  const pct = x => `${Math.round(x * 1000) / 10}%`;
  if (checks.has('nodes-drawn')) {
    check('nodes-drawn', goods.nodes.length === Number(expectNodes), `${goods.nodes.length} of ${expectNodes}`);
  }
  if (checks.has('audit-zero')) {
    if (!goods.audit) check('audit-zero', false, 'no audit element');
    else check('audit-zero', (goods.audit.overlaps || []).length === 0,
      `${(goods.audit.overlaps || []).length} overlaps of ${goods.audit.jobs} jobs` + ((goods.audit.overlaps || [])[0] ? ` e.g. ${goods.audit.overlaps[0].join('/')}` : ''));
  }
  if (checks.has('edgeless-note')) {
    if (goods.audit && goods.audit.jobs > 0 && goods.audit.headings === 0) {
      check('edgeless-note', goods.noteHidden === false && /stand alone/.test(goods.noteText)
        && new RegExp(`^no dependencies: ${goods.audit.jobs} jobs`).test(goods.noteText),
        goods.noteHidden ? 'note hidden' : `note: "${goods.noteText}"`);
    } else check('edgeless-note', false, 'this URL is not an edgeless board');
  }
  if (checks.has('linked-note-off')) {
    check('linked-note-off', goods.noteHidden === true, goods.noteHidden === null ? 'no note element' : `note: "${goods.noteText}"`);
  }
  if (checks.has('fit-frames')) {
    // The page's own fit control, pressed with a real pointer at its centre.
    const f = JSON.parse(await evalJs(`(() => { const r=document.getElementById('fit').getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    await click(f.x, f.y);
    await sleep(900);
    const s = JSON.parse(await evalJs(SNAPSHOT));
    check('fit-frames', s.fit >= 0.85 && s.onScreen >= 0.8 && s.clickable > 0,
      `cores in canvas ${pct(s.fit)}, centres on screen ${pct(s.onScreen)}, ` +
      `${s.clickable} clickable cores, widest on-screen core ${Math.round(s.hit)}px, zoom ${s.zoom}`);
  }
  await die(fails ? 1 : 0);
} catch (e) {
  console.error(`  fault  ${e.message}`);
  await die(2);
}
