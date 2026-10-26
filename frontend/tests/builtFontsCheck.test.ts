// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuiltFonts } from '../scripts/check-built-fonts.mjs';

/**
 * scripts/check-built-fonts.mjs runs after every `vite build` (from
 * check-build-budget.mjs). These feed it small fake dist folders.
 */

const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(60)]);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function face(family: string, weight: number, url: string) {
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(${url}) format("woff2");unicode-range:U+0000-00FF}`;
}

/** A dist like Vite's: index.html, assets/index-*.js, assets/index-*.css and two woff2 files. */
function fakeDist({ html, css, desktop = false }: { html?: string, css?: (prefix: string) => string, desktop?: boolean } = {}) {
  const dist = mkdtempSync(path.join(tmpdir(), 'nebula-fonts-'));
  dirs.push(dist);
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'inter-latin-abc.woff2'), WOFF2);
  writeFileSync(path.join(dist, 'assets', 'jetbrains-mono-latin-def.woff2'), WOFF2);
  writeFileSync(path.join(dist, 'assets', 'index-1.js'), 'console.log(1)');
  const prefix = desktop ? './' : '/assets/';
  const defaultCss = (p: string) => [
    ...[200, 300, 400, 500, 600].map((w) => face('Inter', w, `${p}inter-latin-abc.woff2`)),
    ...[400, 500, 600].map((w) => face('JetBrains Mono', w, `${p}jetbrains-mono-latin-def.woff2`)),
    'body{color:red}',
  ].join('');
  writeFileSync(path.join(dist, 'assets', 'index-2.css'), (css ?? defaultCss)(prefix));
  const assetBase = desktop ? './assets/' : '/assets/';
  writeFileSync(
    path.join(dist, 'index.html'),
    html ?? `<!doctype html><html><head><link rel="stylesheet" href="${assetBase}index-2.css"><script type="module" src="${assetBase}index-1.js"></script></head><body></body></html>`,
  );
  return dist;
}

describe('checkBuiltFonts', () => {
  it('passes a dist whose CSS points at emitted local woff2 files', async () => {
    const result = await checkBuiltFonts(fakeDist());
    expect(result.faces).toBe(8);
    expect(result.fontFiles).toBe(2);
    expect(result.fontBytes).toBe(2 * WOFF2.length);
  });

  it('passes a desktop dist with relative font URLs', async () => {
    await expect(checkBuiltFonts(fakeDist({ desktop: true }), { desktop: true })).resolves.toMatchObject({ faces: 8 });
  });

  it('fails while index.html still links Google Fonts', async () => {
    const html = '<!doctype html><html><head><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
      + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"></head></html>';
    await expect(checkBuiltFonts(fakeDist({ html }))).rejects.toThrow(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('fails when any built CSS or JS names a font CDN', async () => {
    const css = (p: string) => `@import url(https://fonts.googleapis.com/css2?family=Inter);${face('Inter', 400, `${p}inter-latin-abc.woff2`)}`;
    await expect(checkBuiltFonts(fakeDist({ css }))).rejects.toThrow(/fonts\.googleapis\.com/);
  });

  it('fails when a face loads from a remote URL', async () => {
    const css = () => [200, 300, 400, 500, 600].map((w) => face('Inter', w, 'https://example.com/inter.woff2')).join('');
    await expect(checkBuiltFonts(fakeDist({ css }))).rejects.toThrow(/not a local file/);
  });

  it('fails when a font was inlined as a data: URL', async () => {
    const css = (p: string) => `${[200, 300, 400, 500, 600].map((w) => face('Inter', w, `${p}inter-latin-abc.woff2`)).join('')}`
      + [400, 500, 600].map((w) => face('JetBrains Mono', w, 'data:font/woff2;base64,d09GMgABAAAA')).join('');
    await expect(checkBuiltFonts(fakeDist({ css }))).rejects.toThrow(/inlined/);
  });

  it('fails when a face points at a file the build did not emit', async () => {
    const css = (p: string) => [200, 300, 400, 500, 600].map((w) => face('Inter', w, `${p}missing.woff2`)).join('')
      + [400, 500, 600].map((w) => face('JetBrains Mono', w, `${p}jetbrains-mono-latin-def.woff2`)).join('');
    await expect(checkBuiltFonts(fakeDist({ css }))).rejects.toThrow(/missing\.woff2/);
  });

  it('fails when a family or weight is missing', async () => {
    const css = (p: string) => [200, 300, 400, 500].map((w) => face('Inter', w, `${p}inter-latin-abc.woff2`)).join('')
      + [400, 500, 600].map((w) => face('JetBrains Mono', w, `${p}jetbrains-mono-latin-def.woff2`)).join('');
    await expect(checkBuiltFonts(fakeDist({ css }))).rejects.toThrow(/Inter 600/);
  });

  it('accepts a font preload of an emitted file, and fails one the build did not emit or without crossorigin', async () => {
    const page = (links: string) => `<!doctype html><html><head>${links}<link rel="stylesheet" href="/assets/index-2.css"></head></html>`;
    const ok = '<link rel="preload" href="/assets/inter-latin-abc.woff2" as="font" type="font/woff2" crossorigin>';
    await expect(checkBuiltFonts(fakeDist({ html: page(ok) }))).resolves.toMatchObject({ faces: 8 });
    const missing = '<link rel="preload" href="/assets/inter-latin-old.woff2" as="font" type="font/woff2" crossorigin>';
    await expect(checkBuiltFonts(fakeDist({ html: page(missing) }))).rejects.toThrow(/inter-latin-old\.woff2, which the build did not emit/);
    const noCors = '<link rel="preload" href="/assets/inter-latin-abc.woff2" as="font" type="font/woff2">';
    await expect(checkBuiltFonts(fakeDist({ html: page(noCors) }))).rejects.toThrow(/without crossorigin/);
  });

  it('fails a desktop dist whose font URLs are root-absolute (file:// would miss them)', async () => {
    await expect(checkBuiltFonts(fakeDist({ desktop: false }), { desktop: true })).rejects.toThrow(/root-absolute/);
  });
});
