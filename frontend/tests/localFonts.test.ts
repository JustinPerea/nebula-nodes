// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_CDN_HOSTS, REQUIRED_FACES, parseFontFaces } from '../scripts/check-built-fonts.mjs';
import { inlineAssetUnlessFont } from '../vite-plugins/assetInline';

/**
 * The app ships its own Inter and JetBrains Mono (Justin, Q103: "Ship them with
 * the app, so it asks no outside server when it opens"). These pin the source
 * side; scripts/check-built-fonts.mjs (run by the build budget step) pins the
 * built dist.
 */

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = path.join(FRONTEND, 'src/assets/fonts');
const FONTS_CSS = path.join(FONTS_DIR, 'fonts.css');
const read = (file: string) => readFileSync(file, 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('index.html asks no outside server for fonts', () => {
  const html = read(path.join(FRONTEND, 'index.html'));

  it('names no font CDN host', () => {
    for (const host of FONT_CDN_HOSTS) expect(html, host).not.toContain(host);
  });

  it('links nothing from another origin (no preconnect, no remote stylesheet)', () => {
    const remoteLinks = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)].map((m) => m[1]);
    expect(remoteLinks).toEqual([]);
  });

  it('links the bundled font stylesheet', () => {
    expect(html).toMatch(/<link\b[^>]*rel="stylesheet"[^>]*href="\/src\/assets\/fonts\/fonts\.css"/);
  });

  it('preloads only the two latin files every start uses, as CORS font requests', () => {
    const preloads = [...html.matchAll(/<link\b[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]);
    expect(preloads.map((tag) => tag.match(/href="([^"]+)"/)?.[1])).toEqual([
      '/src/assets/fonts/inter/inter-latin.woff2',
      '/src/assets/fonts/jetbrains-mono/jetbrains-mono-latin.woff2',
    ]);
    for (const tag of preloads) {
      expect(tag).toContain('as="font"');
      expect(tag).toContain('type="font/woff2"');
      expect(tag).toMatch(/\scrossorigin[\s/>]/); // fonts are fetched in CORS mode; without it the preload is wasted
      expect(existsSync(path.join(FRONTEND, tag.match(/href="([^"]+)"/)![1]))).toBe(true);
    }
  });
});

describe('frontend source', () => {
  it('names no font CDN host anywhere under src/', () => {
    const hits: string[] = [];
    for (const file of walk(path.join(FRONTEND, 'src'))) {
      if (!/\.(css|ts|tsx|js|mjs|html|json|svg)$/.test(file)) continue;
      const text = read(file);
      for (const host of FONT_CDN_HOSTS) if (text.includes(host)) hits.push(`${path.relative(FRONTEND, file)}: ${host}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('bundled fonts.css', () => {
  const css = existsSync(FONTS_CSS) ? read(FONTS_CSS) : '';
  const faces = parseFontFaces(css);

  it('exists and declares @font-face rules', () => {
    expect(existsSync(FONTS_CSS)).toBe(true);
    expect(faces.length).toBeGreaterThan(0);
  });

  it('covers every family and weight the Google link loaded (Inter 200-600, JetBrains Mono 400-600)', () => {
    for (const { family, weights } of REQUIRED_FACES) {
      for (const weight of weights) {
        expect(faces.some((face) => face.family === family && face.weight === String(weight)), `${family} ${weight}`).toBe(true);
      }
    }
  });

  it('keeps Google\'s unicode-range subsets, normal style and font-display: swap on every face', () => {
    for (const face of faces) {
      expect(face.display, `${face.family} ${face.weight}`).toBe('swap');
      expect(face.style).toBe('normal');
      expect(face.unicodeRange, `${face.family} ${face.weight} ${face.urls[0]}`).toMatch(/^U\+/);
    }
    // 7 Inter subsets x 5 weights + 6 JetBrains Mono subsets x 3 weights, as the CSS API served it.
    expect(faces.filter((face) => face.family === 'Inter')).toHaveLength(35);
    expect(faces.filter((face) => face.family === 'JetBrains Mono')).toHaveLength(18);
  });

  it('points every face at a local woff2 file next to it', () => {
    for (const face of faces) {
      expect(face.urls).toHaveLength(1);
      const url = face.urls[0];
      expect(url, 'relative url').toMatch(/^\.\/[a-z0-9/-]+\.woff2$/);
      const file = path.resolve(FONTS_DIR, url);
      expect(existsSync(file), url).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString('latin1'), url).toBe('wOF2');
    }
  });

  it('records the sha256 of every shipped font file in the fonts README', () => {
    const readme = read(path.join(FONTS_DIR, 'README.md'));
    const woff2 = walk(FONTS_DIR).filter((file) => file.endsWith('.woff2'));
    expect(woff2).toHaveLength(13);
    for (const file of woff2) {
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(readme, path.basename(file)).toContain(sha);
    }
  });

  it('ships each font\'s SIL OFL 1.1 license next to its files', () => {
    for (const [dir, copyright] of [['inter', 'The Inter Project Authors'], ['jetbrains-mono', 'The JetBrains Mono Project Authors']]) {
      const license = read(path.join(FONTS_DIR, dir, 'OFL.txt'));
      expect(license).toContain('SIL Open Font License, Version 1.1');
      expect(license).toContain(copyright);
    }
  });
});

describe('build keeps fonts as files', () => {
  it('never inlines a woff2 (or woff) as a data: URL, whatever its size', () => {
    expect(inlineAssetUnlessFont('/x/src/assets/fonts/jetbrains-mono/jetbrains-mono-vietnamese.woff2')).toBe(false);
    expect(inlineAssetUnlessFont('/x/a.woff')).toBe(false);
    expect(inlineAssetUnlessFont('/x/a.WOFF2?url')).toBe(false);
  });

  it('leaves every other asset to Vite\'s default 4 KiB rule', () => {
    expect(inlineAssetUnlessFont('/x/icon.svg')).toBeUndefined();
    expect(inlineAssetUnlessFont('/x/photo.png')).toBeUndefined();
  });
});
