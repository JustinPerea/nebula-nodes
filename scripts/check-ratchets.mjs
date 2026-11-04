#!/usr/bin/env node
// check-ratchets: run every test that reads the source tree or the docs from disk, in one command.
//
// A ratchet is a test that scans files and fails on a pattern (straight apostrophes, a banned phrase,
// a forbidden call, wording in SKILL.md). The tests that break sit far from the files a change touches,
// so a changed-files run never picks them up and CI finds them a round later. This finds them by what
// they do, not by name, and runs them: frontend vitest files first, then backend pytest files in an
// isolated environment. Run it from frontend/: `npm run check:ratchets`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A frontend test reads the disk when it uses one of these.
export const FRONTEND_DISK_PATTERN = /readFileSync|readdirSync|\bfs\.|node:fs|import\.meta\.glob|\?raw/;
// A backend test walks the source tree, or reads the agent docs.
export const BACKEND_WALK_PATTERN = /rglob\(|os\.walk\(|\.glob\(["']\*\.py["']\)/;
export const BACKEND_DOCS_PATTERN = /SKILL\.md|MCP-SETUP\.md|docs\/[A-Za-z_-]+\.md/;
// Ratchets whose subject is the test suite itself, so no pattern finds them.
export const BACKEND_FIXED = [
  'tests/test_unprivileged_marker.py',
  'tests/test_ci_shard.py',
  'tests/test_connected_copy_sweep.py',
  'tests/test_round20_fence.py',
];

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/** Helper modules (not tests) under frontend/tests that read the disk: a test importing one reads it too. */
export function diskHelpers(root = ROOT) {
  return walk(path.join(root, 'frontend', 'tests'), (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))
    .filter((f) => FRONTEND_DISK_PATTERN.test(readFileSync(f, 'utf8')))
    .map((f) => path.basename(f).replace(/\.tsx?$/, ''));
}

/** Frontend test files (relative to frontend/) that read the disk, directly or through a disk-reading helper. */
export function discoverFrontend(root = ROOT) {
  const frontend = path.join(root, 'frontend');
  const files = ['src', 'tests'].flatMap((d) =>
    walk(path.join(frontend, d), (n) => /\.test\.tsx?$/.test(n)),
  );
  const helpers = diskHelpers(root);
  const viaHelper = helpers.length
    ? new RegExp(`from\\s+['"][^'"]*/(?:${helpers.join('|')})(?:\\.tsx?)?['"]`)
    : null;
  return files
    .filter((f) => {
      const text = readFileSync(f, 'utf8');
      return FRONTEND_DISK_PATTERN.test(text) || (viaHelper !== null && viaHelper.test(text));
    })
    .map((f) => path.relative(frontend, f).split(path.sep).join('/'))
    .sort();
}

/** Backend test files (relative to backend/) that walk the source or read the agent docs, plus the fixed list. */
export function discoverBackend(root = ROOT) {
  const backend = path.join(root, 'backend');
  const dir = path.join(backend, 'tests');
  const found = new Set();
  for (const f of readdirSync(dir)) {
    if (!/^test_.*\.py$/.test(f)) continue;
    const text = readFileSync(path.join(dir, f), 'utf8');
    if (BACKEND_WALK_PATTERN.test(text) || BACKEND_DOCS_PATTERN.test(text)) found.add(`tests/${f}`);
  }
  for (const f of BACKEND_FIXED) if (existsSync(path.join(backend, f))) found.add(f);
  return [...found].sort();
}

export function pythonFor(root = ROOT) {
  const venv = path.join(root, 'backend', '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

/** The environment for a backend run: no NEBULA_* variable from the caller's shell (no shard, and no
 *  real token file, URL or project from a connected agent's shell), HOME and every Nebula path inside `tmp`. */
export function isolatedEnv(base, tmp) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('NEBULA_')));
  env.HOME = tmp;
  env.NEBULA_SETTINGS_PATH = path.join(tmp, 'settings.json');
  env.NEBULA_STATE_DIR = path.join(tmp, 'state');
  env.NEBULA_OUTPUT_ROOT = path.join(tmp, 'out');
  return env;
}

/** Run pytest on `files` in a fresh temp HOME, delete it afterwards. Returns { status, output, tmp }. */
export function runPytest(files, { cwd, python = pythonFor(), extraEnv = {}, stdio = 'pipe' } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'nebula-ratchets-'));
  try {
    const result = spawnSync(
      python,
      ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-o', 'pythonpath=.', ...files],
      {
        cwd,
        env: { ...isolatedEnv(process.env, tmp), ...extraEnv },
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio,
      },
    );
    const started = result.error ? `could not start ${python}: ${result.error.message}\n` : '';
    return { status: result.status ?? 1, output: `${started}${result.stdout ?? ''}${result.stderr ?? ''}`, tmp };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function tail(output) {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function failures(output, pattern) {
  return output.split('\n').filter((l) => pattern.test(l)).slice(0, 40);
}

function runFrontend(root) {
  const files = discoverFrontend(root);
  if (files.length === 0) return { name: 'frontend', ok: false, line: 'no disk-reading vitest files found', failed: [] };
  const result = spawnSync('npx', ['vitest', 'run', '--maxWorkers=2', ...files], {
    cwd: path.join(root, 'frontend'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32', // npx is npx.cmd there
  });
  const output = `${result.error ? `could not start vitest: ${result.error.message}\n` : ''}${result.stdout ?? ''}${result.stderr ?? ''}`;
  const summary = output.split('\n').filter((l) => /^\s*(Test Files|Tests)\s/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
  const ok = result.status === 0;
  return {
    name: 'frontend',
    ok,
    line: `${files.length} files; ${summary.join('; ') || tail(output)}`,
    failed: ok ? [] : failures(output, /^\s*(FAIL|×)\s/),
    output,
  };
}

function runBackend(root) {
  const files = discoverBackend(root);
  if (files.length === 0) return { name: 'backend', ok: false, line: 'no source-walking pytest files found', failed: [] };
  const { status, output } = runPytest(files, { cwd: path.join(root, 'backend') });
  const ok = status === 0;
  return {
    name: 'backend',
    ok,
    line: `${files.length} files; ${tail(output)}`,
    failed: ok ? [] : failures(output, /^(FAILED|ERROR)\s/),
    output,
  };
}

const USAGE = `Usage: npm run check:ratchets   (or: node scripts/check-ratchets.mjs)

Runs every test that reads the source tree or the docs from disk: frontend vitest files that read the
disk (directly or through a tests/helpers module that does), then backend pytest files that walk the
source or read the agent docs, in a temp HOME with no NEBULA_* variable from your shell. Takes no options.`;

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const help = args.every((a) => a === '--help' || a === '-h');
    (help ? console.log : console.error)(help ? USAGE : `Unknown argument: ${args.join(' ')}\n\n${USAGE}`);
    process.exit(help ? 0 : 2);
  }
  let failedAny = false;
  for (const step of [runFrontend, runBackend]) {
    const started = Date.now();
    const result = step(ROOT);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}: ${result.line} (${secs}s)`);
    if (!result.ok) {
      failedAny = true;
      for (const id of result.failed) console.log(`     ${id}`);
      if (result.failed.length === 0 && result.output) console.log(result.output.split('\n').slice(-30).join('\n'));
    }
  }
  process.exit(failedAny ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
