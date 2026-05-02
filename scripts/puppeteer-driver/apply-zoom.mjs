// Reads recording.mp4 + zoom-directives.json from a run dir and produces
// zoomed.mp4 by feeding ffmpeg a single crop+scale pass with piecewise
// time-based expressions (one segment per directive).
//
// Easing functions are inlined in the ffmpeg expr language (cubic only —
// simple closed forms). Crop center is clamped so the window stays inside
// the source frame even when a focus point is near a viewport edge.
//
// Usage:
//   node apply-zoom.mjs <runDir>
// Defaults to most recent run dir.

import { readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RUNS_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver');

// Rendering rules — visual framing applied after zoom is computed.
// The recording sits as a smaller "screen" inside the output frame,
// centered on a gradient backdrop (Screen Studio / OpenScreen style).
// Tune here. Coordinate transforms below derive from these values.
const RENDER_RULES = {
  // Inner "screen" size. Output stays at viewport (1920x1080); the recording
  // is scaled to fit this inner box. Padding is (viewport - inner) / 2 per axis.
  inner: { width: 1600, height: 900 },
  // Rounded corners on the inner recording (subtle, macOS-window-ish).
  cornerRadius: 24,
  // Drop shadow under the inner recording. spread = transparent padding
  // around the silhouette to give the blur room to bleed; blur = boxblur
  // radius; offsetY positive = shadow drops down (light from above).
  shadow: {
    spread: 32,
    blur: 16,
    offsetX: 0,
    offsetY: 14,
    opacity: 0.55,
  },
  // Radial gradient backdrop. c0 = inner color (lighter), c1 = outer (darker).
  // Subtle dark-blue/indigo to complement the Daedalus / Hermes skin without
  // competing with on-screen UI colors.
  gradient: {
    type: 'radial',
    c0: '0x1a1f3a',
    c1: '0x0a0e1a',
  },
};

// Asset cache for pre-rendered polish PNGs. Keyed by geometry+radius so
// changing RENDER_RULES regenerates only what actually changed.
const ASSETS_DIR = join(__dirname, '_assets');

async function main() {
  const runDir = process.argv[2] || (await mostRecentRunDir());
  if (!runDir) {
    console.error('No run dir found.');
    process.exit(1);
  }
  console.log('[apply-zoom] runDir:', runDir);

  const directivesPath = join(runDir, 'zoom-directives.json');
  const data = JSON.parse(await readFile(directivesPath, 'utf8'));
  const { directives, recordingPath, viewport } = data;
  if (!directives.length) throw new Error('no directives to apply');

  const vw = viewport.width;
  const vh = viewport.height;

  // Composition geometry. The recording is scaled into RENDER_RULES.inner
  // and centered on a vw × vh gradient backdrop. The composed frame stays
  // vw × vh, so zoompan clamp math is unchanged — but cx/cy from the
  // directives (in source viewport space) must be transformed into the
  // composed frame's coord space before being fed to zoompan.
  const OUTER_W = vw;
  const OUTER_H = vh;
  const INNER_W = RENDER_RULES.inner.width;
  const INNER_H = RENDER_RULES.inner.height;
  const INSET_X = Math.round((OUTER_W - INNER_W) / 2);
  const INSET_Y = Math.round((OUTER_H - INNER_H) / 2);
  const INNER_SCALE_X = INNER_W / OUTER_W;
  const INNER_SCALE_Y = INNER_H / OUTER_H;
  const INSET_X_FRAC = INSET_X / OUTER_W;
  const INSET_Y_FRAC = INSET_Y / OUTER_H;

  // Build per-axis ffmpeg expressions. zoompan filter evaluates these per
  // frame using `it` (input timestamp). crop won't work — its width/height
  // are init-only by spec, locking the zoom level to directive[0].
  const cxExpr = buildPiecewise(directives, 'cx', 'it');
  const cyExpr = buildPiecewise(directives, 'cy', 'it');
  const scaleExpr = buildPiecewise(directives, 'scale', 'it');

  // Per-directive recording-inset offsets (in pixels). For non-chatbox
  // directives, offset is 0 (recording stays centered). For chatbox-focus
  // directives, offset slides the recording so the chatbox lands at composed
  // center 0.5. Animated using each directive's ease so the slide is in sync
  // with the camera ease-in/out. Built twice — `it` for zoompan, `t` for
  // overlay's per-frame x/y eval.
  //   chatbox offset_x = 0.5*OUTER_W - INSET_X - cx*INNER_W
  //   chatbox offset_y = 0.5*OUTER_H - INSET_Y - cy*INNER_H
  const offsetXExprIt = buildOffsetExpr(directives, 'cx', INSET_X, OUTER_W, INNER_W, 'it');
  const offsetYExprIt = buildOffsetExpr(directives, 'cy', INSET_Y, OUTER_H, INNER_H, 'it');
  const offsetXExprT = buildOffsetExpr(directives, 'cx', INSET_X, OUTER_W, INNER_W, 't');
  const offsetYExprT = buildOffsetExpr(directives, 'cy', INSET_Y, OUTER_H, INNER_H, 't');

  // zoompan now runs on the RAW high-res source (3840×2160 with DPR=2)
  // before the inner-scale step. cx/cy are in [0,1] viewport space and map
  // directly to source pixels. cropX/Y are TOP-LEFT of the crop window in
  // source pixels. crop_w = iw/z, crop_h = ih/z. Clamped inside source.
  // No dynamic inset offset — the cropped region is centered in INNER by
  // zoompan itself, and INNER sits at static INSET_X/Y in OUTER.
  const cropX = `clip((iw*(${cxExpr})) - (iw/(${scaleExpr}))/2, 0, iw - iw/(${scaleExpr}))`;
  const cropY = `clip((ih*(${cyExpr})) - (ih/(${scaleExpr}))/2, 0, ih - ih/(${scaleExpr}))`;

  // Static overlay positions — the inner box is centered in the OUTER
  // gradient frame and stays put.
  const insetXExpr = `${INSET_X}`;
  const insetYExpr = `${INSET_Y}`;
  const shadowXExpr = `${INSET_X - RENDER_RULES.shadow.spread + RENDER_RULES.shadow.offsetX}`;
  const shadowYExpr = `${INSET_Y - RENDER_RULES.shadow.spread + RENDER_RULES.shadow.offsetY}`;

  // recording.mp4 has variable frame durations baked in (concat demuxer
  // playlist with explicit duration per frame). fps=25 first re-times it to
  // true cfr so wall-clock duration is preserved through zoompan. Without
  // this, zoompan emits one output per input frame and a 43s recording
  // becomes ~10s.
  const TARGET_FPS = 25;

  // Pre-render polish assets (rounded-corner alpha mask, drop-shadow PNG).
  // These are cached on disk and only regenerated if RENDER_RULES changes.
  const { maskPath, shadowPath, gradientPath } = await ensurePolishAssets({
    outerW: OUTER_W,
    outerH: OUTER_H,
    innerW: INNER_W,
    innerH: INNER_H,
    cornerRadius: RENDER_RULES.cornerRadius,
    shadow: RENDER_RULES.shadow,
    gradient: RENDER_RULES.gradient,
  });
  // Probe recording duration so we can bound the looped image inputs.
  // alphamerge waits for ALL its inputs to EOF before closing — without a
  // hard duration on the looped mask, it never ends, the inner_rounded
  // stream stays open forever, and the outer overlay's eof_action=endall
  // trigger never fires (encode runs away).
  const recordingDuration = await probeDuration(recordingPath);
  const imageDuration = (recordingDuration + 0.5).toFixed(3);

  // Pass 1: composite recording onto gradient backdrop with rounded corners
  // and drop shadow, then apply zoom.
  //
  //   [0:v] recording → fps, scale-down to inner box, force yuva420p
  //   [1:v] generated radial gradient (lavfi source, infinite duration)
  //   [2:v] rounded-corner alpha mask (looped single PNG frame)
  //   [3:v] drop-shadow RGBA PNG (looped single frame)
  //
  //   alphamerge: copy mask luma into inner alpha → rounded inner
  //   overlay #1: paint shadow onto gradient (offset by spread + drop offset)
  //   overlay #2: paint rounded inner on top, ending stream when recording EOFs
  //   zoompan:    crop+pan over the composed canvas in source-time
  //
  // eof_action=endall on overlay #2 is critical: the gradient + mask + shadow
  // inputs are all infinite, so the output stream needs an explicit end signal
  // tied to the recording (the only finite input). -shortest alone does NOT
  // work for filter_complex outputs.
  const composeFilter = [
    // zoompan operates on raw high-res source first (no pre-downscale to
    // INNER), so zoomed shots crop high-resolution pixels that get
    // supersampled DOWN to INNER size. lanczos on the output for sharper
    // resampling. cropX/Y use iw/ih (raw source dims, e.g. 3840×2160).
    `[0:v]fps=${TARGET_FPS},format=yuva420p,zoompan=z='${scaleExpr}':x='${cropX}':y='${cropY}':d=1:s=${INNER_W}x${INNER_H}:fps=${TARGET_FPS}[inner_pre]`,
    `[2:v]format=gray[mask]`,
    `[3:v]format=rgba[shadow]`,
    `[inner_pre][mask]alphamerge[inner_rounded]`,
    `[1:v][shadow]overlay=x='${shadowXExpr}':y='${shadowYExpr}':eof_action=pass[bg_with_shadow]`,
    `[bg_with_shadow][inner_rounded]overlay=x='${insetXExpr}':y='${insetYExpr}':eof_action=endall:format=auto,setsar=1[out]`,
  ].join(';');
  const zoomedFullPath = join(runDir, 'zoomed-fullspeed.mp4');
  console.log('[apply-zoom] pass 1: gradient + shadow + rounded inset + zoom (filter graph:', composeFilter.length, 'chars)');
  await runFfmpeg([
    '-y',
    '-i', recordingPath,
    '-loop', '1', '-t', imageDuration, '-i', gradientPath,
    '-loop', '1', '-t', imageDuration, '-i', maskPath,
    '-loop', '1', '-t', imageDuration, '-i', shadowPath,
    '-filter_complex', composeFilter,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', '16',
    zoomedFullPath,
  ]);

  // Pass 2: time-remap per-segment using setpts to compress dead-air gaps.
  // Each directive becomes a [trim, setpts] block; the speedFactor controls
  // playback rate (4 = 4x faster). Concat the blocks back together.
  const outPath = join(runDir, 'zoomed.mp4');
  const hasSpeedup = directives.some((d) => (d.speedFactor || 1) !== 1);
  if (!hasSpeedup) {
    // No speed changes — just rename the pass-1 output.
    const { rename } = await import('node:fs/promises');
    await rename(zoomedFullPath, outPath);
    console.log('[apply-zoom] no speedup, wrote', outPath);
    return;
  }

  const segments = [];
  const labels = [];
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    const speed = d.speedFactor || 1;
    const ptsExpr = speed === 1 ? '(PTS-STARTPTS)' : `((PTS-STARTPTS)/${speed})`;
    segments.push(
      `[0:v]trim=start=${d.startSec.toFixed(4)}:end=${d.endSec.toFixed(4)},setpts=${ptsExpr}[s${i}]`,
    );
    labels.push(`[s${i}]`);
  }
  const filterComplex = `${segments.join(';')};${labels.join('')}concat=n=${directives.length}:v=1[out]`;

  console.log(`[apply-zoom] pass 2: speed remap (${directives.length} segments, ${directives.filter(d => (d.speedFactor || 1) > 1).length} sped up)`);
  await runFfmpeg([
    '-y',
    '-i', zoomedFullPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', '16',
    outPath,
  ]);
  // Clean up the intermediate.
  const { unlink } = await import('node:fs/promises');
  await unlink(zoomedFullPath).catch(() => {});
  console.log('[apply-zoom] wrote', outPath);
}

// Build a piecewise ffmpeg expression. For each directive, lerp between
// focusStart[axis] and focusEnd[axis] across [startSec, endSec], applying the
// directive's easing. Returns a chained `if(lt(t, ...), expr, else_expr)`.
// `tVar` is the time variable name in the target filter — `t` for crop,
// `it` for zoompan.
function buildPiecewise(directives, axis, tVar = 't') {
  // Walk in reverse so the innermost else is the last directive's value.
  let expr = String(directives[directives.length - 1].focusEnd[axis]);
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    const a = d.focusStart[axis];
    const b = d.focusEnd[axis];
    const span = Math.max(0.001, d.endSec - d.startSec);
    const alpha = `((${tVar}-${d.startSec.toFixed(4)})/${span.toFixed(4)})`;
    const eased = applyEase(alpha, d.ease);
    const lerp = `(${a}+(${b}-${a})*${eased})`;
    expr = `if(lt(${tVar},${d.endSec.toFixed(4)}),${lerp},${expr})`;
  }
  return expr;
}

// Build a piecewise expression for the per-directive recording-inset offset
// (in pixels). Non-chatbox directives get offset=0 (recording centered).
// Chatbox-focus directives compute the offset that puts the camera target
// at composed center 0.5 — animated using the directive's own ease so the
// inset slide stays in lockstep with the camera transition.
//
// Formula (axis 'cx', mirrored for cy):
//   offset_x = 0.5 * OUTER_W - INSET_X - source_cx * INNER_W
//
// Combined with the composed_cx transform in apply-zoom main(), the source_cx
// term cancels out and composed_cx = 0.5 for all chatbox-focus frames.
// Kinds that ride the inset-offset machinery so the focus target lands at
// composed center 0.5 — chatbox, agentlog, and bloom focus segments. Any
// directive whose kind contains any of these gets the offset; everything
// else (overview, node clusters) stays at offset=0 / centered inset.
const OFFSET_KIND_RE = /chatbox|agentlog|bloom/;

function buildOffsetExpr(directives, axis, INSET, OUTER, INNER, tVar) {
  const K = 0.5 * OUTER - INSET;
  let expr = '0';
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    let segExpr;
    if (d.kind && OFFSET_KIND_RE.test(d.kind)) {
      const a = K - d.focusStart[axis] * INNER;
      const b = K - d.focusEnd[axis] * INNER;
      const span = Math.max(0.001, d.endSec - d.startSec);
      const alpha = `((${tVar}-${d.startSec.toFixed(4)})/${span.toFixed(4)})`;
      const eased = applyEase(alpha, d.ease);
      segExpr = `(${a.toFixed(4)}+(${b.toFixed(4)}-${a.toFixed(4)})*${eased})`;
    } else {
      segExpr = '0';
    }
    expr = `if(lt(${tVar},${d.endSec.toFixed(4)}),${segExpr},${expr})`;
  }
  return expr;
}

function applyEase(alpha, ease) {
  switch (ease) {
    case 'linear':
      return alpha;
    case 'easeOutCubic':
      // 1 - (1-a)^3
      return `(1-pow(1-${alpha},3))`;
    case 'easeInCubic':
      // a^3
      return `(pow(${alpha},3))`;
    case 'easeInOutCubic':
      // a<0.5 ? 4*a^3 : 1 - (-2a+2)^3/2
      return `(if(lt(${alpha},0.5),4*pow(${alpha},3),1-pow(-2*${alpha}+2,3)/2))`;
    default:
      return alpha;
  }
}

function probeDuration(path) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    ff.stdout.on('data', (d) => { stdout += d.toString(); });
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr}`));
      const n = parseFloat(stdout.trim());
      if (!Number.isFinite(n)) return reject(new Error(`ffprobe parse: ${stdout}`));
      resolve(n);
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

// Pre-render the rounded-corner alpha mask + drop-shadow PNG used by pass 1.
// Both are cached on disk under scripts/puppeteer-driver/_assets/, keyed by
// geometry so changing RENDER_RULES regenerates only what actually changed.
//
// The geq filter on a single 1-frame source is slow but only runs once per
// (geometry, radius, shadow) combo, then the cached PNG is reused on every
// subsequent encode.
async function ensurePolishAssets({ outerW, outerH, innerW, innerH, cornerRadius, shadow, gradient }) {
  await mkdir(ASSETS_DIR, { recursive: true });
  const r = cornerRadius;
  const r2 = r * r;

  // --- Static gradient backdrop. The `gradients` lavfi filter animates by
  // default (slow color-point drift) — when pass 2's setpts speed-remap
  // accelerates the video 10x, the gradient rotates noticeably, which reads
  // as background flicker. Pre-rendering a single frame removes the time
  // dimension entirely.
  const gradientKey = `gradient-${outerW}x${outerH}-${gradient.type}-${gradient.c0}-${gradient.c1}.png`;
  const gradientPath = join(ASSETS_DIR, gradientKey);
  if (!existsSync(gradientPath)) {
    console.log('[apply-zoom] pre-rendering', gradientPath.replace(REPO_ROOT + '/', ''));
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `gradients=size=${outerW}x${outerH}:type=${gradient.type}:c0=${gradient.c0}:c1=${gradient.c1}:duration=0.04:rate=25`,
      '-frames:v', '1',
      gradientPath,
    ]);
  }

  // --- Rounded-corner mask: grayscale, white inside rounded rect, black out.
  // alphamerge will copy this image's luma into the inner recording's alpha.
  // Formula uses clip(): for a pixel at (X, Y), find the nearest "safe"
  // interior point — clamped to [r, dim-1-r] per axis — and check if the
  // squared distance is ≤ r². In the corner regions this becomes the standard
  // (X-cornerCenter)² + (Y-cornerCenter)² ≤ r² disk test; everywhere else
  // it reduces to 0 ≤ r² (always inside).
  const maskPath = join(ASSETS_DIR, `mask-${innerW}x${innerH}-r${r}.png`);
  if (!existsSync(maskPath)) {
    console.log('[apply-zoom] pre-rendering', maskPath.replace(REPO_ROOT + '/', ''));
    const maskExpr = `255*lte(pow(X-clip(X,${r},W-1-${r}),2)+pow(Y-clip(Y,${r},H-1-${r}),2),${r2})`;
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `color=black:s=${innerW}x${innerH}:d=1`,
      '-vf', `format=gray,geq=lum='${maskExpr}'`,
      '-frames:v', '1',
      maskPath,
    ]);
  }

  // --- Drop shadow: RGBA, opaque black inside the same rounded silhouette,
  // padded by `spread` on every side so the box-blur can bleed outward
  // without clipping. After blur, the result is a soft halo positioned
  // behind the inner during compositing (offset by RENDER_RULES.shadow.offset).
  const shadowAlpha = Math.round(255 * shadow.opacity);
  const padW = innerW + shadow.spread * 2;
  const padH = innerH + shadow.spread * 2;
  const shadowKey = `shadow-${innerW}x${innerH}-r${r}-sp${shadow.spread}-sb${shadow.blur}-op${shadowAlpha}.png`;
  const shadowPath = join(ASSETS_DIR, shadowKey);
  if (!existsSync(shadowPath)) {
    console.log('[apply-zoom] pre-rendering', shadowPath.replace(REPO_ROOT + '/', ''));
    // Same rounded-rect test, but coordinates are shifted by `spread` so the
    // silhouette sits at the centered offset within the padded canvas.
    const sx = `(X-${shadow.spread})`;
    const sy = `(Y-${shadow.spread})`;
    const shadowExpr = `${shadowAlpha}*lte(pow(${sx}-clip(${sx},${r},${innerW - 1}-${r}),2)+pow(${sy}-clip(${sy},${r},${innerH - 1}-${r}),2),${r2})`;
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `color=black@0:s=${padW}x${padH}:d=1`,
      '-vf', `format=rgba,geq=r=0:g=0:b=0:a='${shadowExpr}',boxblur=${shadow.blur}:1`,
      '-frames:v', '1',
      shadowPath,
    ]);
  }

  return { maskPath, shadowPath, gradientPath };
}

async function mostRecentRunDir() {
  try {
    const entries = await readdir(RUNS_DIR);
    const sorted = entries
      .filter((e) => /^\d{4}-/.test(e) && !e.endsWith('-profile'))
      .sort();
    return sorted.length ? join(RUNS_DIR, sorted[sorted.length - 1]) : null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
