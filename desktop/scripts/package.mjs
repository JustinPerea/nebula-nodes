#!/usr/bin/env node
/**
 * Build Nebula.app for this Mac (darwin/arm64):
 *
 *   cd desktop && npm run package            -> desktop/out/Nebula-darwin-arm64/Nebula.app
 *   cd desktop && npm run package -- --validation
 *                                            -> desktop/out/validation/Nebula-darwin-arm64/Nebula.app
 *
 * The bundle is a thin launcher. It holds Electron, the app icon, a small
 * bootstrap (packaging/bootstrap.mjs + app-repo.mjs) and nebula-app.json with
 * the absolute path of this checkout. At launch it runs this checkout's
 * desktop/main.mjs, frontend/dist-desktop and backend/.venv, so `git pull`
 * updates the app. Nothing is bundled from Python and nothing is signed with
 * a Developer ID (see desktop/README.md, "Nebula.app"). Electron's fuses are
 * flipped (packaging/fuses.mjs) so the binary can't be run as Node or
 * attached to with --inspect.
 *
 * The renderer is rebuilt first (`npm run build:desktop`) when
 * frontend/dist-desktop is missing or older than the frontend sources; pass
 * --rebuild-renderer to force it.
 *
 * --validation makes a test-only bundle that honours the dev/test launch
 * overrides (NEBULA_DESKTOP_USER_DATA_DIR, _APP_ID, _TEST, _DEBUG_PORT), so
 * validators can launch the real bundle against a throwaway profile.
 * install-app refuses it.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { FuseState, flipFuses, getCurrentFuseWire } from '@electron/fuses';

import { APP_CONFIG_FILE_NAME, REQUIRED_REPO_FILES } from '../app-repo.mjs';
import { APP_BUNDLE_ID, APP_NAME } from '../packaging/app-identity.mjs';
import { NEBULA_FUSES, wantedFuseBits } from '../packaging/fuses.mjs';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DESKTOP_DIR, '..');
const FRONTEND_DIR = join(REPO_ROOT, 'frontend');
const RENDERER_INDEX = join(FRONTEND_DIR, 'dist-desktop', 'index.html');
const RENDERER_STAMP = join(FRONTEND_DIR, 'dist-desktop', 'nebula-build.json');

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--validation', '--rebuild-renderer'].includes(arg)) {
    console.error(`package: unknown option ${arg} (expected --validation, --rebuild-renderer)`);
    process.exit(2);
  }
}
const validation = args.has('--validation');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`package: builds for macOS on Apple silicon only (this is ${process.platform}/${process.arch})`);
  process.exit(1);
}

/** Newest mtime under `path` (files only), skipping node_modules and Finder duplicates. */
function newestMtime(path) {
  let stat;
  try { stat = statSync(path); } catch { return 0; }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || / 2(\.|$)/.test(entry)) continue;
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

function rendererIsStale() {
  if (!existsSync(RENDERER_INDEX)) return 'frontend/dist-desktop is missing';
  // The app refuses a build without its params-version stamp (frontend-build.mjs).
  if (!existsSync(RENDERER_STAMP)) return 'frontend/dist-desktop predates nebula-build.json';
  const built = statSync(RENDERER_INDEX).mtimeMs;
  const inputs = ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts',
    'vite-plugins', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'];
  const newest = Math.max(...inputs.map((p) => newestMtime(join(FRONTEND_DIR, p))));
  return newest > built ? 'frontend sources changed since the last desktop build' : null;
}

// 1. Renderer
const stale = args.has('--rebuild-renderer') ? '--rebuild-renderer' : rendererIsStale();
if (stale) {
  console.log(`package: building the desktop renderer (${stale})`);
  const built = spawnSync('npm', ['run', 'build:desktop'], { cwd: FRONTEND_DIR, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('package: `npm run build:desktop` failed; fix it and run `npm run package` again');
    process.exit(built.status ?? 1);
  }
} else {
  console.log('package: frontend/dist-desktop is up to date');
}

// 2. The checkout must be runnable (the app checks again at every launch).
const python = join(REPO_ROOT, REQUIRED_REPO_FILES.python);
if (!existsSync(python)) {
  console.warn(`package: warning: ${python} is missing; Nebula.app will ask you to create it before it can start`);
}

// 3. Stage the app directory: bootstrap, repo checker, config, package.json.
const electronVersion = JSON.parse(
  readFileSync(join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const desktopPackage = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8'));
const outRoot = join(DESKTOP_DIR, 'out', ...(validation ? ['validation'] : []));
const stage = join(DESKTOP_DIR, 'out', validation ? '.stage-validation' : '.stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(DESKTOP_DIR, 'packaging', 'bootstrap.mjs'), join(stage, 'bootstrap.mjs'));
cpSync(join(DESKTOP_DIR, 'app-repo.mjs'), join(stage, 'app-repo.mjs'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  // No productName: Electron names the profile dir, the single-instance lock
  // and the "<name> Safe Storage" keychain item after `name`, and these must
  // stay `nebula-desktop` so the app and `npm run start` share them.
  name: desktopPackage.name,
  version: desktopPackage.version,
  type: 'module',
  main: 'bootstrap.mjs',
}, null, 2) + '\n');
writeFileSync(join(stage, APP_CONFIG_FILE_NAME), JSON.stringify({
  repoRoot: REPO_ROOT,
  validation,
  electronVersion,
}, null, 2) + '\n');

// 4. Package.
console.log(`package: packaging ${APP_NAME}.app (Electron ${electronVersion}${validation ? ', validation build' : ''})`);
const [appDir] = await packager({
  dir: stage,
  out: outRoot,
  name: APP_NAME,
  platform: 'darwin',
  arch: 'arm64',
  electronVersion,
  appBundleId: APP_BUNDLE_ID,
  appCategoryType: 'public.app-category.graphics-design',
  appVersion: desktopPackage.version,
  icon: join(DESKTOP_DIR, 'build', 'icon.icns'),
  darwinDarkModeSupport: true,
  overwrite: true,
  asar: false,
  prune: false,
  quiet: true,
});
rmSync(stage, { recursive: true, force: true });

const appPath = join(appDir, `${APP_NAME}.app`);
const appBinary = join(appPath, 'Contents', 'MacOS', APP_NAME);

// 5. Harden the Electron binary (packaging/fuses.mjs), then read the wire
// back and stop if any fuse is not what we asked for.
await flipFuses(appBinary, NEBULA_FUSES);
const wire = await getCurrentFuseWire(appBinary);
for (const [index, enabled] of Object.entries(wantedFuseBits())) {
  const want = enabled ? FuseState.ENABLE : FuseState.DISABLE;
  if (wire[index] !== want) {
    console.error(`package: fuse ${index} is ${wire[index]}, expected ${want}`);
    process.exit(1);
  }
}
console.log('package: Electron fuses set (RunAsNode, NODE_OPTIONS and --inspect off)');

// 6. Ad-hoc sign the whole bundle. Packager rewrites Info.plist, the icon
// and (step 5) the fuse wire, which breaks the seal on Electron's prebuilt signature; an ad-hoc
// signature ("-") makes the bundle internally consistent again. It is not a
// Developer ID signature and does not notarize anything.
const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
if (signed.status !== 0) {
  console.error('package: ad-hoc codesign failed');
  process.exit(signed.status ?? 1);
}

console.log(`package: built ${appPath}`);
console.log(`package: runs ${REPO_ROOT}`);
if (validation) {
  console.log('package: validation build: honours dev/test overrides; install-app will refuse it');
} else {
  console.log('package: next: npm run install-app (copies it to ~/Applications)');
}
