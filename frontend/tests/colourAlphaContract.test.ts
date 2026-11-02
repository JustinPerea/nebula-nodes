import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALPHA_MIN, kMeansColors, paletteFromPixels, pixelWeight } from '../src/lib/paletteExtract';

/**
 * Alpha counts the same on both sides (PR #208 round 2). The backend
 * (cinema/color.py, tests/test_colour_alpha.py) and this side read one
 * contract: contracts/fixtures/colour/alpha.json. A pixel under alpha 16 isn't
 * counted; the rest count by alpha / 255. The vision readers' surfaces are
 * the colours this app draws behind those images, checked here against the CSS.
 */

const CONTRACT = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/colour/alpha.json'), 'utf8')) as {
  alphaMin: number;
  weightCases: { alpha: number; weight: number }[];
  readerSurfaces: Record<string, { hex: string; layer: string; under: string }>;
};

const css = (name: string) => readFileSync(resolve(__dirname, '../src/styles', name), 'utf8');

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

/** ``layer`` (rgba white) over ``under`` (#rrggbb), as the browser paints it, rounded. */
function over(layer: string, under: string): string {
  const [r, g, b, a] = layer.match(/[\d.]+/g)!.map(Number);
  const base = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  const mixed = [r, g, b].map((channel, i) => Math.round(channel * a + base[i] * (1 - a)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

describe('the alpha contract', () => {
  it('has the threshold and weights the frontend uses', () => {
    expect(ALPHA_MIN).toBe(CONTRACT.alphaMin);
    for (const { alpha, weight } of CONTRACT.weightCases) expect(pixelWeight(alpha)).toBeCloseTo(weight, 6);
  });

  it('names the surfaces the app draws behind Commons and board images', () => {
    const slava = css('slava-restraint.css');
    expect(slava).toContain(`--sr-canvas: ${CONTRACT.readerSurfaces.commons.under};`);
    expect(slava).toContain(`--sr-node-media-bg: ${CONTRACT.readerSurfaces.commons.layer};`);
    const commons = css('commons.css');
    expect(rule(commons, 'body.app-slava-restraint .commons-tile')).toContain('background: var(--sr-node-media-bg);');
    // Canvas node images (the Vision node's and QC's inputs) sit on the same layer.
    expect(slava).toMatch(
      /body\.app-slava-restraint \.model-node--image-surface \.model-node__preview-image,[^{]*\{[^}]*background: var\(--sr-node-media-bg\);/);
    expect(CONTRACT.readerSurfaces.canvasNode.layer).toBe(CONTRACT.readerSurfaces.commons.layer);
    expect(rule(css('moodboard-board.css'), '.moodboard-card')).toContain(
      `background: ${CONTRACT.readerSurfaces.moodboard.layer};`);
    for (const surface of Object.values(CONTRACT.readerSurfaces)) {
      expect(over(surface.layer, surface.under)).toBe(surface.hex);
    }
  });
});

describe('paletteFromPixels counts alpha as the backend does', () => {
  const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());

  it('leaves out pixels under the threshold and weighs the rest by alpha', () => {
    // One cluster over opaque red and blue at alpha 64: its centre sits a
    // fifth of the way to blue (64 / (255 + 64)), not half way.
    // The clustering is where the weights count (round 8: the swatch shown is
    // then the cluster's own pixel nearest that centre, GM r15).
    const rgba = [[200, 0, 0, 255], [0, 0, 200, 64], [0, 255, 0, ALPHA_MIN - 1]];
    const [centre] = kMeansColors(rgba.map((p) => p.slice(0, 3)), rgba.map((p) => pixelWeight(p[3])), 1);
    expect(centre.rgb.map(Math.round)).toEqual([Math.round(200 * 255 / 319), 0, Math.round(200 * 64 / 319)]);
    expect(paletteFromPixels(px(...rgba), 1)).toMatchObject({ ok: true, colors: ['#c80000'] });
  });

  it('counts a pixel at the threshold, which the old cut (128) left out', () => {
    expect(paletteFromPixels(px([10, 200, 90, ALPHA_MIN]), 1)).toEqual({ ok: true, colors: ['#0ac85a'] });
  });

  it('gives an opaque image the same colours as before', () => {
    // What 1944d052's paletteFromPixels gave for these pixels.
    const data = px([255, 0, 0, 255], [250, 10, 0, 255], [0, 0, 255, 255], [10, 10, 240, 255], [0, 200, 0, 255]);
    const rgb = [[255, 0, 0], [250, 10, 0], [0, 0, 255], [10, 10, 240], [0, 200, 0]];
    const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    expect(kMeansColors(rgb, rgb.map(() => 1), 2).map((c) => hex(c.rgb))).toEqual(['#a84600', '#0505f8']);
    // Shown, each cluster is its own pixel nearest its centre (GM r15).
    expect(paletteFromPixels(data, 2)).toMatchObject({ ok: true, colors: ['#fa0a00', '#0000ff'] });
  });
});
