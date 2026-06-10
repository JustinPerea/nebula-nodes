#!/usr/bin/env node
/**
 * Render Nebula Nodes brand assets from the locked design (NN-45 Crab).
 *
 * Outputs:
 *   frontend/public/favicon.svg       — rounded-square Crab glyph (32×32)
 *   frontend/public/og-card.svg       — 1200×630 OG / social card
 *   docs/assets/banner.svg            — 1280×420 README hero banner
 *
 * The Crab math here is a direct port of the source in the design bundle
 * (Nebula Nodes Brand Guide → marks.jsx, MarkCrab + rayHalftonePalette).
 * Keep this in sync with frontend/src/components/brand/CrabMark.tsx.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ─── Crab-true palette ─────────────────────────────────────────────
const CRAB_TRUE = [
  { t: 0.0, rgb: [180, 240, 250] },
  { t: 0.32, rgb: [120, 220, 200] },
  { t: 0.62, rgb: [240, 150, 90] },
  { t: 1.0, rgb: [120, 50, 30] },
];

const lerp = (a, b, t) => a + (b - a) * t;
const lerpColor = (a, b, t) =>
  `rgb(${(lerp(a[0], b[0], t) | 0)},${(lerp(a[1], b[1], t) | 0)},${(lerp(a[2], b[2], t) | 0)})`;

function paletteColor(palette, tInput) {
  const t = Math.max(0, Math.min(1, tInput));
  for (let i = 0; i < palette.length - 1; i++) {
    const a = palette[i];
    const b = palette[i + 1];
    if (t >= a.t && t <= b.t) {
      return lerpColor(a.rgb, b.rgb, (t - a.t) / (b.t - a.t));
    }
  }
  return t < palette[0].t
    ? `rgb(${palette[0].rgb.join(',')})`
    : `rgb(${palette[palette.length - 1].rgb.join(',')})`;
}

function crabMask(x, y, a) {
  const dx = x - 100;
  const dy = y - 100;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > 92) return 0;
  const targetR = 56 + Math.cos(a * 2 + 0.4) * 9 + Math.sin(a * 5 + 1.2) * 3;
  const shellWidth = 16;
  const shell =
    Math.exp(-((r - targetR) * (r - targetR)) / (shellWidth * shellWidth)) *
    0.9;
  const interior = Math.exp((-r * r) / (2 * 34 * 34)) * 0.55;
  const filIntensity = Math.pow(Math.abs(Math.cos(a * 5.5)), 8);
  const filMask =
    filIntensity *
    Math.max(0, Math.min(1, (r - 16) / 18)) *
    Math.max(0, 1 - Math.abs(r - targetR) / 30) *
    0.55;
  const patch =
    Math.exp((-((dx + 28) * (dx + 28) + (dy + 18) * (dy + 18))) / 200) * 0.35 +
    Math.exp((-((dx - 22) * (dx - 22) + (dy - 30) * (dy - 30))) / 200) * 0.35 +
    Math.exp((-((dx + 12) * (dx + 12) + (dy - 34) * (dy - 34))) / 220) * 0.3;
  return Math.max(shell + filMask, interior, patch);
}

function renderCrabDots(opts = {}) {
  const {
    palette = CRAB_TRUE,
    step = 6,
    minDot = 0.35,
    maxDot = 3.1,
    rimFalloff = 0.5,
    maxR = 92,
  } = opts;
  const cx = 100;
  const cy = 100;
  const out = [];
  for (let y = 4; y < 200; y += step) {
    for (let x = 4; x < 200; x += step) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > maxR) continue;
      const angle = Math.atan2(dy, dx);
      const t = r / maxR;
      const intensity = Math.max(0, Math.min(1, crabMask(x, y, angle)));
      if (intensity < 0.06) continue;
      const sz =
        (minDot + intensity * (maxDot - minDot)) * (1 - t * rimFalloff);
      if (sz < 0.4) continue;
      const fill = paletteColor(palette, t);
      const op = (0.45 + intensity * 0.55).toFixed(3);
      out.push(
        `<circle cx="${x}" cy="${y}" r="${sz.toFixed(2)}" fill="${fill}" opacity="${op}"/>`,
      );
    }
  }
  return out.join('');
}

function svgCrab({ size = 200, tight = true, ...opts } = {}) {
  const viewBox = tight ? '22 22 156 156' : '0 0 200 200';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}">${renderCrabDots(opts)}</svg>`;
}

// ─── Asset 1 · favicon.svg (32 × 32 rounded square) ────────────────
// Crab collapses below 48px (per brand guide section 8) — use a coarser
// grid + a dark rounded-square ground that still reads at 16px.
function renderFavicon() {
  // 200×200 internal grid, output to a 200×200 viewBox with a rounded
  // square ground so the browser scales it cleanly to any favicon size.
  const dots = renderCrabDots({ step: 9, maxDot: 4.2, rimFalloff: 0.35 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect x="0" y="0" width="200" height="200" rx="42" ry="42" fill="#060607"/>
  ${dots}
</svg>`;
}

// ─── Asset 2 · banner.svg (1280 × 420 README hero) ─────────────────
function renderBanner() {
  const W = 1280;
  const H = 420;
  // Mark — render to a 1:1 sub-svg, place left of center.
  const markSize = 280;
  const markX = 180;
  const markY = (H - markSize) / 2;
  // Dot-field ground
  const dotField = [];
  const grid = 18;
  for (let y = grid; y < H; y += grid) {
    for (let x = grid; x < W; x += grid) {
      dotField.push(
        `<circle cx="${x}" cy="${y}" r="1" fill="rgb(201,202,200)" opacity="0.10"/>`,
      );
    }
  }
  const peak = paletteColor(CRAB_TRUE, 0);
  const warm = paletteColor(CRAB_TRUE, 0.62);
  void peak;

  // Telemetry strip (top + bottom)
  const top = `<g font-family="JetBrains Mono, monospace" font-size="13" fill="rgba(255,255,255,0.45)" letter-spacing="3">
  <text x="40" y="38">NEBULA·NODES</text>
  <text x="${W / 2}" y="38" text-anchor="middle">BRAND · v0.1 · M1 CRAB</text>
  <text x="${W - 40}" y="38" text-anchor="end">NGC 1952 · TAURUS</text>
</g>`;
  const bottom = `<g font-family="JetBrains Mono, monospace" font-size="13" fill="rgba(255,255,255,0.40)" letter-spacing="3">
  <text x="40" y="${H - 28}">PLOTTED WITH LIGHT</text>
  <text x="${W - 40}" y="${H - 28}" text-anchor="end">OPEN SOURCE · MIT</text>
</g>`;

  // Mark sub-svg
  const markSvg = `<svg x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" viewBox="22 22 156 156">${renderCrabDots({ step: 6 })}</svg>`;

  // Wordmark — right of the mark
  const wmX = markX + markSize + 80;
  const wmY = H / 2;
  const wordmark = `<g font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif" letter-spacing="22">
  <text x="${wmX}" y="${wmY - 18}" font-weight="200" font-size="78" fill="#ffffff">NEBULA</text>
  <text x="${wmX}" y="${wmY + 68}" font-weight="300" font-size="78" fill="${warm}">NODES</text>
  <text x="${wmX + 4}" y="${wmY + 120}" font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="400" font-size="18" letter-spacing="0" fill="rgba(255,255,255,0.65)">An open-source canvas for AI graphs.</text>
</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#060607"/>
  ${dotField.join('')}
  ${markSvg}
  ${wordmark}
  ${top}
  ${bottom}
</svg>`;
}

// ─── Asset 3 · og-card.svg (1200 × 630) ────────────────────────────
function renderOgCard() {
  const W = 1200;
  const H = 630;
  const markSize = 340;
  const markX = 100;
  const markY = (H - markSize) / 2;
  const dotField = [];
  const grid = 18;
  for (let y = grid; y < H; y += grid) {
    for (let x = grid; x < W; x += grid) {
      dotField.push(
        `<circle cx="${x}" cy="${y}" r="1" fill="rgb(201,202,200)" opacity="0.12"/>`,
      );
    }
  }
  const warm = paletteColor(CRAB_TRUE, 0.62);
  const markSvg = `<svg x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" viewBox="22 22 156 156">${renderCrabDots({ step: 6 })}</svg>`;

  const tlX = 56;
  const tlY = 56;
  const trX = W - 56;
  const blX = 56;
  const blY = H - 56;
  const brX = W - 56;

  const labels = `<g font-family="JetBrains Mono, monospace" font-size="13" fill="rgba(255,255,255,0.5)" letter-spacing="2">
  <text x="${tlX}" y="${tlY}">nebula·nodes <tspan fill="${warm}">●</tspan> v0.4</text>
  <text x="${trX}" y="${tlY}" text-anchor="end">github.com/JustinPerea/nebula-nodes</text>
  <text x="${blX}" y="${blY}">M1 · CRAB · NGC 1952</text>
  <text x="${brX}" y="${blY}" text-anchor="end">1200 × 630 · OG</text>
</g>`;

  const wmX = markX + markSize + 56;
  const wmY = H / 2 - 60;
  const wordmark = `<g font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif">
  <text x="${wmX}" y="${wmY}" font-weight="200" font-size="74" letter-spacing="20" fill="#ffffff">NEBULA</text>
  <text x="${wmX}" y="${wmY + 78}" font-weight="300" font-size="74" letter-spacing="20" fill="${warm}">NODES</text>
  <text x="${wmX}" y="${wmY + 142}" font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="400" font-size="22" fill="rgba(255,255,255,0.78)">An open-source canvas for AI graphs.</text>
  <text x="${wmX}" y="${wmY + 174}" font-family="Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="300" font-size="18" fill="rgba(255,255,255,0.55)">Wire prompts, models, images and mesh into living pipelines.</text>
</g>`;

  // Three pills bottom-right
  const pillY = H - 110;
  const pillData = [
    { label: 'MIT', accent: false, x: wmX, w: 70 },
    { label: 'REACT · PYTHON', accent: false, x: wmX + 86, w: 180 },
    { label: 'v0.4 · STABLE', accent: true, x: wmX + 282, w: 170 },
  ];
  const pills = pillData
    .map(({ label, accent, x, w }) => {
      const stroke = accent ? warm : 'rgba(255,255,255,0.18)';
      const fill = accent ? warm : 'rgba(255,255,255,0.7)';
      return `<g>
        <rect x="${x}" y="${pillY}" width="${w}" height="34" rx="17" ry="17" fill="none" stroke="${stroke}" stroke-width="1"/>
        <text x="${x + w / 2}" y="${pillY + 22}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="12" letter-spacing="2" fill="${fill}">${label}</text>
      </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#060607"/>
  ${dotField.join('')}
  ${markSvg}
  ${wordmark}
  ${pills}
  ${labels}
</svg>`;
}

// ─── Write outputs ─────────────────────────────────────────────────
const outputs = [
  {
    path: resolve(REPO_ROOT, 'frontend', 'public', 'favicon.svg'),
    content: renderFavicon(),
  },
  {
    path: resolve(REPO_ROOT, 'frontend', 'public', 'og-card.svg'),
    content: renderOgCard(),
  },
  {
    path: resolve(REPO_ROOT, 'docs', 'assets', 'banner.svg'),
    content: renderBanner(),
  },
];

for (const { path, content } of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content + '\n');
  console.log(`wrote ${path} (${content.length.toLocaleString()} bytes)`);
}

// Also stash a copy of the OG SVG under docs/assets/ for the portfolio site.
const docsOg = resolve(REPO_ROOT, 'docs', 'assets', 'og-card.svg');
mkdirSync(dirname(docsOg), { recursive: true });
writeFileSync(docsOg, renderOgCard() + '\n');
console.log(`wrote ${docsOg} (copy of og-card.svg)`);

// Crab mark on its own, no ground — handy for embedding.
const markOnly = resolve(REPO_ROOT, 'docs', 'assets', 'crab-mark.svg');
writeFileSync(markOnly, svgCrab({ size: 480 }) + '\n');
console.log(`wrote ${markOnly} (standalone mark)`);

// ─── Helix — phase 1 core (sync with helixGeometry.ts) ───────────────
const HELIX_CORE = [
  { t: 0.0, rgb: [250, 254, 255] },
  { t: 0.15, rgb: [220, 244, 252] },
  { t: 0.55, rgb: [72, 130, 210] },
  { t: 0.72, rgb: [48, 98, 178] },
  { t: 1.0, rgb: [150, 200, 235] },
];
const HELIX_CORE_R = 34;

function helixMask(x, y) {
  const dx = x - 100;
  const dy = y - 100;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > HELIX_CORE_R) return 0;
  const paleCore = Math.exp(-(r * r) / (2 * 4 * 4)) * 0.62;
  const darkRing = Math.exp(-((r - 18) ** 2) / (2 * 10 * 10)) * 1;
  const outerSoft = Math.exp(-((r - 28) ** 2) / (2 * 7 * 7)) * 0.38;
  const edge = 1 - (Math.max(0, (r - 31) / 3) ** 2);
  return Math.min(1, Math.max(paleCore, darkRing, outerSoft) * edge);
}

function helixColorT(r) {
  if (r < 7) return 0.01 + (r / 7) * 0.06;
  if (r < 29) {
    const ringPeak = Math.exp(-((r - 18) ** 2) / (2 * 8.5 * 8.5));
    return 0.5 + ringPeak * 0.22;
  }
  return 0.22 + ((HELIX_CORE_R - r) / (HELIX_CORE_R - 29)) * 0.12;
}

function renderHelixDots(opts = {}) {
  const { palette = HELIX_CORE, step = 5 } = opts;
  const out = [];
  for (let y = 4; y < 200; y += step) {
    for (let x = 4; x < 200; x += step) {
      const dx = x - 100;
      const dy = y - 100;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > HELIX_CORE_R) continue;
      const intensity = Math.max(0, Math.min(1, helixMask(x, y)));
      if (intensity < 0.05) continue;
      const t = helixColorT(r);
      const minSz = step * 0.14;
      const maxSz = step * 0.46;
      const sz = minSz + intensity * (maxSz - minSz);
      if (sz < step * 0.12) continue;
      const fill = paletteColor(palette, t);
      const op = (r < 7 ? 0.55 + intensity * 0.35 : 0.62 + intensity * 0.36).toFixed(
        3,
      );
      out.push(
        `<circle cx="${x}" cy="${y}" r="${sz.toFixed(2)}" fill="${fill}" opacity="${op}"/>`,
      );
    }
  }
  return out.join('');
}

function svgHelix({ size = 200, tight = true, ...opts } = {}) {
  const viewBox = tight ? '62 62 76 76' : '0 0 200 200';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}">${renderHelixDots(opts)}</svg>`;
}

const helixMark = resolve(REPO_ROOT, 'docs', 'assets', 'helix-mark.svg');
writeFileSync(helixMark, svgHelix({ size: 480 }) + '\n');
console.log(`wrote ${helixMark} (Helix exploratory mark)`);
