#!/usr/bin/env node
/**
 * Re-render Helix mark assets and export a PNG for the Paper embed.
 * Run after every helixGeometry change: node frontend/scripts/refresh-helix-paper.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const svgPath = resolve(REPO_ROOT, 'docs', 'assets', 'helix-mark.svg');
const pngPath = resolve(REPO_ROOT, 'docs', 'assets', 'helix-phase1-core.png');

execSync(`node "${resolve(__dirname, 'render-brand-assets.mjs')}"`, {
  stdio: 'inherit',
  cwd: resolve(__dirname, '..'),
});

execSync(
  `magick -size 524x360 xc:'#000000' "${svgPath}" -gravity center -composite "${pngPath}"`,
  { stdio: 'inherit' },
);

writeFileSync(
  resolve(REPO_ROOT, 'docs', 'assets', '.helix-paper-stamp'),
  `${Date.now()}\n`,
);
// Also write legacy path for any older Paper embeds
const legacyPng = resolve(REPO_ROOT, 'docs', 'assets', 'helix-mark-paper.png');
execSync(`cp "${pngPath}" "${legacyPng}"`, { stdio: 'inherit' });
console.log(`Paper embed PNG: ${pngPath}`);
