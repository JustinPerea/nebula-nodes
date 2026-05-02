// Shared helpers used by every section script. Each section is its own
// puppeteer run that produces a zoomed+VO mp4 the user can review in
// isolation; once approved the section mp4s get stitched into the final
// cut. State carries between sections via a JSON snapshot of the graph
// store (nodes + edges + chat) saved at the end of each section and
// loaded at the start of the next.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..', '..', '..');
export const SECTIONS_OUT = join(REPO_ROOT, 'output', 'sections');
export const URL_DEFAULT = 'http://localhost:5173';
// CSS viewport stays at 1920x1080 so page layout (panel positions,
// react-flow camera math, getBoundingClientRect coords) is unchanged.
// deviceScaleFactor = 2 makes Chrome render at 3840x2160 physical pixels.
// CDP screencast captures actual pixels, so frames are 3840x2160 — twice
// the detail. apply-zoom then supersamples the high-res input down to
// INNER 1600x900, and zoompan crops at scale=2 are roughly 1:1 with
// output instead of 2× upscale → much sharper text/edges at zoomed shots.
export const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2 };
const RECORD_W = VIEWPORT.width * (VIEWPORT.deviceScaleFactor ?? 1);
const RECORD_H = VIEWPORT.height * (VIEWPORT.deviceScaleFactor ?? 1);
export const FPS = 30;

export function nowSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function log(name, msg) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false }) +
    '.' + String(new Date().getMilliseconds()).padStart(3, '0');
  console.log(`[${t}] ${name.padEnd(10)} ${msg}`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Launch a fresh puppeteer browser for this section.
export async function launchBrowser(userDataDir) {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: VIEWPORT,
    userDataDir,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--force-device-scale-factor=${VIEWPORT.deviceScaleFactor ?? 1}`,
      '--high-dpi-support=1',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[scripted]') || msg.type() === 'error') {
      log('page', `[${msg.type()}] ${t}`);
    }
  });
  page.on('pageerror', (err) => log('pageerror', err.message));
  return { browser, page };
}

// Open the app and wait for the bridges Canvas/Chat/GraphStore to be ready.
export async function openApp(page, url = URL_DEFAULT) {
  log('nav', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
    try { localStorage.setItem('nebula:daedalus-provider', 'nous'); } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-panel', { timeout: 10000 });
  await page.waitForFunction(
    () => window.__nebulaCanvas && window.__nebulaChat && window.__nebulaGraphStore,
    { timeout: 10000 },
  );
}

// Wipe backend cli_graph + frontend graph + chat. Used for the first
// section (intro) where we want a clean state.
export async function wipeAll(page) {
  await page.evaluate(async () => {
    try { await fetch('http://localhost:8000/api/graph', { method: 'DELETE' }); } catch {}
    window.__nebulaGraphStore.getState().clearGraph();
    window.__nebulaChat.clear();
  });
}

// Save graph state + chat to a snapshot file. Picked up by the next
// section's loadSnapshot() call.
export async function saveSnapshot(page, snapshotPath) {
  const snap = await page.evaluate(() => {
    const gs = window.__nebulaGraphStore.getState();
    const messages = (window.__nebulaChat.getMessages
      ? window.__nebulaChat.getMessages()
      : []);
    return {
      nodes: JSON.parse(JSON.stringify(gs.nodes || [])),
      edges: JSON.parse(JSON.stringify(gs.edges || [])),
      messages: JSON.parse(JSON.stringify(messages || [])),
    };
  });
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snap, null, 2));
  log('snap-out', `${snap.nodes.length} nodes, ${snap.edges.length} edges, ${snap.messages.length} messages → ${snapshotPath}`);
}

// Load a snapshot from a prior section. Re-applies nodes + edges to the
// graph store and re-pushes chat messages.
export async function loadSnapshot(page, snapshotPath) {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    log('snap-in', `no snapshot — starting clean`);
    return null;
  }
  const snap = JSON.parse(await readFile(snapshotPath, 'utf8'));
  await page.evaluate((s) => {
    const gs = window.__nebulaGraphStore.getState();
    gs.clearGraph();
    window.__nebulaChat.clear();
    if (gs.replaceGraph) {
      gs.replaceGraph(s.nodes, s.edges);
    } else if (gs.setNodes && gs.setEdges) {
      gs.setNodes(s.nodes);
      gs.setEdges(s.edges);
    } else {
      // Fallback: zustand setState directly.
      window.__nebulaGraphStore.setState({ nodes: s.nodes, edges: s.edges });
    }
    for (const msg of s.messages || []) {
      if (msg.role === 'user') {
        window.__nebulaChat.pushUser(msg.text || '', msg.meta || {});
      } else if (msg.role === 'assistant') {
        window.__nebulaChat.pushAssistant(msg.text || '');
      }
    }
  }, snap);
  log('snap-in', `${snap.nodes.length} nodes, ${snap.edges.length} edges, ${snap.messages.length} messages ← ${snapshotPath}`);
  return snap;
}

// Inject the virtual cursor — same SVG + ripple as drive.mjs.
export async function injectCursor(page) {
  await page.evaluate(({ vw, vh }) => {
    const cursor = document.createElement('div');
    cursor.id = '__nebula-cursor';
    cursor.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 3 L5 23 L11 18 L13.5 24 L16 23 L13.5 17 L21 17 Z"
              fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>`;
    Object.assign(cursor.style, {
      position: 'fixed', top: '0', left: '0',
      width: '32px', height: '32px', pointerEvents: 'none', zIndex: '99999',
      transform: `translate(${vw / 2 - 5}px, ${vh / 2 - 3}px)`,
      transition: 'transform 1.2s cubic-bezier(0.4, 0, 0.2, 1)',
      willChange: 'transform',
      filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.55))',
    });
    document.body.appendChild(cursor);

    const ripple = document.createElement('div');
    ripple.id = '__nebula-cursor-ripple';
    Object.assign(ripple.style, {
      position: 'fixed', top: '0', left: '0',
      width: '36px', height: '36px', pointerEvents: 'none', zIndex: '99998',
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.85)',
      boxSizing: 'border-box', opacity: '0',
      transform: 'translate(-9999px, -9999px) scale(0.3)',
    });
    document.body.appendChild(ripple);

    let cx = vw / 2, cy = vh / 2;
    window.__nebulaCursor = {
      moveTo: (tx, ty, durationMs = 1200) => {
        cx = tx; cy = ty;
        cursor.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        cursor.style.transform = `translate(${tx - 5}px, ${ty - 3}px)`;
      },
      click: () => {
        const t = cursor.style.transform;
        cursor.style.transition = 'transform 120ms ease-out';
        cursor.style.transform = `${t} scale(0.85)`;
        setTimeout(() => { cursor.style.transform = t; }, 130);
        ripple.style.transition = 'none';
        ripple.style.opacity = '0.9';
        ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(0.3)`;
        void ripple.offsetWidth;
        ripple.style.transition = 'transform 520ms ease-out, opacity 520ms ease-out';
        ripple.style.transform = `translate(${cx - 18}px, ${cy - 18}px) scale(2.6)`;
        ripple.style.opacity = '0';
      },
    };
  }, { vw: VIEWPORT.width, vh: VIEWPORT.height });
}

// Suppress fitView and apply our wide overview camera anchor.
export async function setOverview(page) {
  await page.evaluate(() => {
    window.__nebulaSuppressFitView = true;
    window.__nebulaCanvas.centerOn(-180, 130, 0.55, 0, { x: 880, y: 540 });
  });
}

// Spawn a CDP screencast recorder. CDP screencast emits frames at a
// variable rate (only when the page changes), so we record the wall-clock
// timestamp of each frame and mux via ffmpeg's concat demuxer with
// per-frame `duration` directives. Output mp4 duration matches actual
// wall-clock time. Mirrors scripted-build.mjs's Recorder class.
export async function startRecorder(page, runDir, opts = {}) {
  const framesDir = join(runDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  const fps = opts.fps ?? FPS;
  const quality = opts.quality ?? 80;
  const frames = []; // { filename, ts }
  let frameIdx = 0;

  const session = await page.target().createCDPSession();
  session.on('Page.screencastFrame', async (frame) => {
    const fileName = `f-${String(frameIdx).padStart(6, '0')}.jpg`;
    const fp = join(framesDir, fileName);
    await writeFile(fp, Buffer.from(frame.data, 'base64'));
    frames.push({ filename: fileName, ts: frame.metadata?.timestamp ?? null });
    frameIdx += 1;
    try { await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); } catch {}
  });

  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality,
    everyNthFrame: 1,
  });

  return {
    framesDir,
    stop: async () => {
      try { await session.send('Page.stopScreencast'); } catch {}
      try { await session.detach(); } catch {}
      return {
        frameCount: frames.length,
        firstFrameTs: frames[0]?.ts ?? null,
      };
    },
    mux: async (outPath, opts2 = {}) => {
      if (frames.length < 2) throw new Error(`not enough frames to mux (${frames.length})`);
      // ffconcat playlist with per-frame duration based on actual deltas.
      const lines = ['ffconcat version 1.0'];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const next = frames[i + 1];
        lines.push(`file '${f.filename}'`);
        const dur = next && f.ts != null && next.ts != null
          ? Math.max(0.001, next.ts - f.ts)
          : 1 / fps;
        lines.push(`duration ${dur.toFixed(4)}`);
      }
      lines.push(`file '${frames[frames.length - 1].filename}'`);
      const playlistPath = join(framesDir, 'frames.txt');
      await writeFile(playlistPath, lines.join('\n') + '\n');

      // Two-pass approach. (1) Mux frames at their captured timestamps
      // — output duration equals last frame's wall-clock time. (2) If
      // the caller specified a longer wall-clock target (CDP screencast
      // emits no frames during quiet tails like sleep() with no UI
      // change), pad the tail by cloning the last frame using tpad.
      const intermediate = outPath.replace(/\.mp4$/, '.untrimmed.mp4');
      const baseArgs = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', playlistPath,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-vf', `scale=${RECORD_W}:${RECORD_H}:force_original_aspect_ratio=decrease,pad=${RECORD_W}:${RECORD_H}:(ow-iw)/2:(oh-ih)/2:black`,
        '-preset', 'slow',
        '-crf', '16',
      ];
      const target = opts2.targetDurationSec;
      if (!target) {
        baseArgs.push(outPath);
        await runFfmpeg(baseArgs);
        return outPath;
      }
      // First pass into an intermediate file so we can probe duration.
      baseArgs.push(intermediate);
      await runFfmpeg(baseArgs);
      const actualDur = await probeDurationSec(intermediate);
      const padSec = Math.max(0, target - actualDur);
      if (padSec < 0.05) {
        // Close enough — just rename.
        const { rename } = await import('node:fs/promises');
        await rename(intermediate, outPath);
        return outPath;
      }
      await runFfmpeg([
        '-y',
        '-i', intermediate,
        '-vf', `tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'slow',
        '-crf', '16',
        outPath,
      ]);
      const { unlink } = await import('node:fs/promises');
      await unlink(intermediate).catch(() => {});
      return outPath;
    },
  };
}

export async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

async function probeDurationSec(path) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error(`ffprobe exited ${code}`));
    });
  });
}

// Standard event-capture helpers — same shape derive-zoom expects.
export function makeCaptureHelpers(page, recordStart) {
  const events = [];
  const edges = [];
  return {
    events, edges,
    captureNode: async (nodeId, label) => {
      const bounds = await page.evaluate((id) => {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, nodeId);
      events.push({
        ts: Date.now() - recordStart,
        nodeId,
        nodeLabel: label,
        bounds: bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        kind: 'added',
      });
    },
    captureEdge: async (edgeId, source, target) => {
      edges.push({
        ts: Date.now() - recordStart,
        edgeId, source, target,
        kind: 'edge-added',
      });
    },
  };
}

// Write the events.json file derive-zoom consumes for this section.
export async function writeEvents(runDir, payload) {
  await writeFile(join(runDir, 'events.json'), JSON.stringify(payload, null, 2));
}
