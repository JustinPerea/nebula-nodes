#!/usr/bin/env node
/**
 * Copy the built Nebula.app into ~/Applications:
 *
 *   cd desktop && npm run package && npm run install-app
 *
 * Meant to be run by the person, from a terminal. It refuses to run without
 * one (so scripts and agents don't install apps), refuses a validation build,
 * refuses to replace anything at ~/Applications/Nebula.app that isn't a
 * Nebula bundle, and refuses while that copy is running.
 *
 * Your data is not touched: it lives in ~/Library/Application Support/Nebula Nodes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_CONFIG_FILE_NAME } from '../app-repo.mjs';
import { APP_BUNDLE_ID, APP_NAME } from '../packaging/app-identity.mjs';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(DESKTOP_DIR, 'out', `${APP_NAME}-darwin-arm64`, `${APP_NAME}.app`);
const targetDir = join(homedir(), 'Applications');
const target = join(targetDir, `${APP_NAME}.app`);

function die(message) {
  console.error(`install-app: ${message}`);
  process.exit(1);
}

function bundleId(appPath) {
  const result = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
    join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  die('run this yourself from a terminal: cd desktop && npm run install-app');
}
if (!existsSync(source)) {
  die(`${source} does not exist yet. Build it first: npm run package`);
}

let config;
try {
  config = JSON.parse(readFileSync(join(source, 'Contents', 'Resources', 'app', APP_CONFIG_FILE_NAME), 'utf8'));
} catch (err) {
  die(`${source} has no readable ${APP_CONFIG_FILE_NAME} (${err.message}). Rebuild it: npm run package`);
}
if (config.validation === true) {
  die('that is a validation build (test-only). Rebuild without --validation: npm run package');
}
if (bundleId(source) !== APP_BUNDLE_ID) {
  die(`${source} is not a ${APP_BUNDLE_ID} bundle. Rebuild it: npm run package`);
}

if (existsSync(target)) {
  const existing = bundleId(target);
  if (existing !== APP_BUNDLE_ID) {
    die(`${target} exists and is not Nebula (${existing ?? 'no bundle id'}). Move it away first.`);
  }
  const running = spawnSync('pgrep', ['-f', join(target, 'Contents', 'MacOS', APP_NAME)], { encoding: 'utf8' });
  if (running.status === 0 && running.stdout.trim()) {
    die('Nebula is running from ~/Applications. Quit it (Cmd-Q), then run this again.');
  }
}

mkdirSync(targetDir, { recursive: true });
const staging = join(targetDir, `.${APP_NAME}.app.installing`);
rmSync(staging, { recursive: true, force: true });
const copied = spawnSync('ditto', [source, staging], { stdio: 'inherit' });
if (copied.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  die('copy failed');
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
renameSync(staging, target);

console.log(`install-app: installed ${target}`);
console.log(`install-app: it runs the checkout at ${config.repoRoot}`);
console.log('install-app: open it from Finder > Applications (or Spotlight: "Nebula"); to keep it in the Dock,');
console.log('             right-click its Dock icon while it runs > Options > Keep in Dock.');
