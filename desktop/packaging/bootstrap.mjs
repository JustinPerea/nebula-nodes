/**
 * Entry point of the packaged Nebula.app (copied into the bundle by
 * scripts/package.mjs, next to app-repo.mjs and nebula-app.json).
 *
 * It finds the Nebula checkout the app was built from, checks that it is
 * still complete, and then runs that checkout's desktop/main.mjs. If the
 * checkout or its backend venv is gone, it shows a dialog saying what to do
 * and quits, without creating app data or starting anything.
 */

import { app, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { checkRepo, readAppConfig } from './app-repo.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));

function fail(problem, detail) {
  console.error(`Nebula: ${problem}\n${detail}`);
  // main.mjs never runs on this path, so a validation build would otherwise
  // open Chromium on the person's real profile just to show this dialog.
  const isolatedDir = process.env.NEBULA_DESKTOP_USER_DATA_DIR;
  if (read.ok && read.config.validation && isolatedDir) {
    app.setPath('userData', isolatedDir);
  }
  app.whenReady().then(async () => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Nebula',
      message: problem,
      detail,
      buttons: ['Quit'],
    });
    app.quit();
  });
}

const read = readAppConfig(appDir);
const checked = read.ok ? checkRepo(read.config.repoRoot) : read;

if (!checked.ok) {
  fail(checked.problem, checked.detail);
} else {
  const { repoRoot, validation, electronVersion } = read.config;
  if (electronVersion && electronVersion !== process.versions.electron) {
    console.warn(`Nebula.app was built with Electron ${electronVersion} but is running ${process.versions.electron}`);
  }
  try {
    const wanted = JSON.parse(readFileSync(join(repoRoot, 'desktop', 'package.json'), 'utf8'))
      ?.devDependencies?.electron;
    if (wanted && wanted !== process.versions.electron) {
      console.warn(
        `The checkout now pins Electron ${wanted}; this app bundle runs ${process.versions.electron}. ` +
        'Re-run `cd desktop && npm run package && npm run install-app` to update it.',
      );
    }
  } catch {
    // Only a hint; main.mjs reports anything that actually breaks.
  }

  const desktopDir = join(repoRoot, 'desktop');
  try {
    const { setPackagedLaunch } = await import(pathToFileURL(join(desktopDir, 'packaged-launch.mjs')).href);
    setPackagedLaunch({ validation, bundlePath: process.execPath });
    // Awaited, so main.mjs's pre-ready setup (setPath, setName, command-line
    // switches, the single-instance lock) runs before Electron emits `ready`.
    await import(pathToFileURL(join(desktopDir, 'main.mjs')).href);
  } catch (err) {
    fail(
      'Nebula\'s desktop code failed to load.',
      `${desktopDir} could not be started: ${err?.message ?? err}\n\n` +
        'Check that the checkout is on a working commit (git status), then open Nebula again.',
    );
  }
}
