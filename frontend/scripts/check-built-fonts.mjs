/**
 * Check that a built frontend (dist/ or dist-desktop/) ships its own fonts.
 *
 * Nebula used to load Inter and JetBrains Mono from Google Fonts, so Google saw
 * every start and offline the app fell back to system fonts. The fonts now live
 * in src/assets/fonts/ (Justin, Q103: "Ship them with the app, so it asks no
 * outside server when it opens"). check-build-budget.mjs runs this after every
 * build; it fails when:
 *
 * - index.html, or any built CSS or JS, names a font CDN host;
 * - index.html links anything from another origin (a preconnect, a stylesheet);
 * - a font was inlined as a data: URL (it would bloat the CSS or the JS entry
 *   instead of loading as its own file, and only when used);
 * - an @font-face src is not a local file the build emitted, or (desktop) is
 *   root-absolute, which file:// resolves against the filesystem root;
 * - a family or weight the app uses has no face.
 *
 * Run directly: `node scripts/check-built-fonts.mjs [distDir]`.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Font CDNs the app must never call. */
export const FONT_CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'use.typekit.net',
  'p.typekit.net',
  'fonts.bunny.net',
  'rsms.me',
  'fonts.cdnfonts.com',
];

/** What the old Google Fonts link loaded, and what the app's CSS asks for. */
export const REQUIRED_FACES = [
  { family: 'Inter', weights: [200, 300, 400, 500, 600] },
  { family: 'JetBrains Mono', weights: [400, 500, 600] },
];

// data:font/..., data:application/font-woff2, data:application/x-font-woff, or any
// base64 payload that starts with the WOFF2/WOFF magic ("wOF2"/"wOFF").
const INLINED_FONT = /data:(?:font\/|application\/(?:x-)?font-woff)|base64,d09G[MR]/i;
const REMOTE_LINK = /<link\b[^>]*\bhref\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The @font-face rules in a stylesheet, minified or not.
 * @param {string} css
 * @returns {{ family: string, weight: string, style: string, display: string, unicodeRange: string, urls: string[] }[]}
 */
export function parseFontFaces(css) {
  const faces = [];
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const descriptors = {};
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      descriptors[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
    }
    faces.push({
      family: unquote(descriptors['font-family'] ?? ''),
      weight: (descriptors['font-weight'] ?? '').trim(),
      style: (descriptors['font-style'] ?? '').trim(),
      display: (descriptors['font-display'] ?? '').trim(),
      unicodeRange: (descriptors['unicode-range'] ?? '').trim(),
      urls: [...(descriptors.src ?? '').matchAll(/url\(\s*([^)]*?)\s*\)/g)].map((m) => unquote(m[1])),
    });
  }
  return faces;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }));
  return files.flat();
}

/**
 * @param {string} distDir
 * @param {{ desktop?: boolean }} [options]
 * @returns {Promise<{ faces: number, fontFiles: number, fontBytes: number }>}
 */
export async function checkBuiltFonts(distDir, { desktop = false } = {}) {
  const problems = [];
  const files = await walk(distDir);
  const rel = (file) => path.relative(distDir, file).split(path.sep).join('/');

  const html = await readFile(path.join(distDir, 'index.html'), 'utf8');
  for (const [, href] of html.matchAll(REMOTE_LINK)) problems.push(`index.html links ${href} from another origin`);
  for (const [tag] of html.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/gi)) {
    const href = tag.match(/\bhref="([^"]+)"/)?.[1] ?? '';
    if (!/\scrossorigin[\s/>=]/.test(tag)) problems.push(`index.html preloads ${href} without crossorigin, so the font request cannot use it`);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue; // reported above when remote
    const target = href.startsWith('/') ? path.join(distDir, href) : path.resolve(distDir, href);
    try {
      if ((await readFile(target)).subarray(0, 4).toString('latin1') !== 'wOF2') problems.push(`index.html preloads ${href}, which is not a woff2 file`);
    } catch {
      problems.push(`index.html preloads ${href}, which the build did not emit`);
    }
  }

  const faces = [];
  for (const file of files.filter((name) => /\.(html|css|js|mjs)$/.test(name))) {
    const text = await readFile(file, 'utf8');
    for (const host of FONT_CDN_HOSTS) {
      if (text.includes(host)) problems.push(`${rel(file)} names the font CDN ${host}`);
    }
    if (/\.(css|js|mjs)$/.test(file) && INLINED_FONT.test(text)) problems.push(`${rel(file)} has a font inlined as a data: URL`);
    if (!file.endsWith('.css')) continue;
    for (const face of parseFontFaces(text)) {
      faces.push(face);
      for (const url of face.urls) {
        if (/^data:/i.test(url)) continue; // reported above as inlined
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
          problems.push(`${rel(file)}: ${face.family} ${face.weight} loads ${url}, not a local file`);
          continue;
        }
        if (desktop && url.startsWith('/')) {
          problems.push(`${rel(file)}: ${face.family} ${face.weight} uses the root-absolute ${url}; the desktop build needs relative URLs`);
          continue;
        }
        const clean = url.split(/[?#]/, 1)[0];
        const target = clean.startsWith('/') ? path.join(distDir, clean) : path.resolve(path.dirname(file), clean);
        let head;
        try {
          head = (await readFile(target)).subarray(0, 4).toString('latin1');
        } catch {
          problems.push(`${rel(file)}: ${face.family} ${face.weight} points at ${url}, which the build did not emit`);
          continue;
        }
        if (head !== 'wOF2') problems.push(`${rel(file)}: ${url} is not a woff2 file`);
      }
    }
  }

  for (const { family, weights } of REQUIRED_FACES) {
    for (const weight of weights) {
      const found = faces.some((face) => face.family === family && face.weight === String(weight)
        && face.urls.some((url) => !/^data:/i.test(url)));
      if (!found) problems.push(`no @font-face with a local file for ${family} ${weight}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Bundled font check failed in ${path.basename(distDir)}:\n- ${problems.join('\n- ')}`);
  }

  const fontPaths = files.filter((name) => name.endsWith('.woff2'));
  let fontBytes = 0;
  for (const file of fontPaths) fontBytes += (await readFile(file)).byteLength;
  return { faces: faces.length, fontFiles: fontPaths.length, fontBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const desktop = process.env.NEBULA_DESKTOP_BUILD === '1';
  const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, desktop ? '../dist-desktop' : '../dist'));
  const result = await checkBuiltFonts(distDir, { desktop });
  console.log(`Bundled fonts passed: ${result.faces} @font-face rules, ${result.fontFiles} woff2 files, ${result.fontBytes} bytes.`);
}
