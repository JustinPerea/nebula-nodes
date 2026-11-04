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

/** Frontend test files (relative to frontend/) that read the disk. */
export function discoverFrontend(root = ROOT) {
  const frontend = path.join(root, 'frontend');
  const files = ['src', 'tests'].flatMap((d) =>
    walk(path.join(frontend, d), (n) => /\.test\.tsx?$/.test(n)),
  );
  return files
    .filter((f) => FRONTEND_DISK_PATTERN.test(readFileSync(f, 'utf8')))
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

/** The environment for a backend run: no shard, and HOME and every Nebula path inside `tmp`. */
export function isolatedEnv(base, tmp) {
  const env = { ...base };
  delete env.NEBULA_TEST_SHARD;
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
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, tmp };
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
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
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

function main() {
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
