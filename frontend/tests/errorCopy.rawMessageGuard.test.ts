/**
 * Error copy round 3e, item 5: raw error text can't come back (GM - Design,
 * round 1: "Never show raw error.message strings in UI.").
 *
 * The lightest guard that works is a source check, like the inline-style and
 * Slava CSS scope checks: it reads every file under src/ and fails on the
 * shapes that put an Error's own message where the person reads it:
 *
 * - `err instanceof Error ? err.message : …`, and
 *   `if (err instanceof Error) … err.message` on one line
 * - `(err as Error).message` / `(err as Error)?.message`
 * - `(e: Error) => … e.message`
 * - `String(e)` / `String(err)` / `String(error)` / `String(exc)` /
 *   `String(failure)` / `String(reason)`
 * - `${e}` / `${err.message}` (and error/exc/failure) in a template
 * - `{error.message}` (and e/err/exc/failure) in JSX
 *
 * A line that only logs (console.*) is fine. The fix is lib/errorCopy.ts:
 * `failureMessage(error, "Couldn't {verb} {object}.")` (one line) or
 * `failureCopy(error, { heading })` (two lines), which keep a written
 * failure's heading and reason and give anything else the heading over GM's
 * general line. A line written in the browser is thrown as a FailureNotice,
 * so it survives that mapping. A site whose message is never shown, or is
 * known to be written, goes in ALLOWED with its reason; an entry that no
 * longer matches fails too, so the list stays true. AGENTS.md has the rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'src');

const SHAPES: { name: string; pattern: RegExp }[] = [
  // The ternary and the `if (x instanceof Error) …x.message` forms, on one line.
  { name: 'instanceof Error … x.message', pattern: /\b(\w+) instanceof Error\b.*\b\1\??\.message/ },
  { name: '(x as Error).message', pattern: /\(\s*\w+ as Error\s*\)\??\.message/ },
  { name: '(x: Error) => x.message', pattern: /\(\s*(\w+)\s*:\s*Error\s*\)\s*=>.*\b\1\??\.message/ },
  { name: 'String(error)', pattern: /\bString\(\s*(e|err|error|exc|failure|reason)\s*\)/ },
  { name: '${error}', pattern: /\$\{\s*(e|err|error|exc|failure)(\??\.message)?\s*\}/ },
  { name: '{error.message} in JSX', pattern: /\{\s*(e|err|error|exc|failure)\??\.message\s*\}/ },
];

/** file (relative to src/) -> the number of matching lines allowed, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  // Reads a failed chunk import's message to tell a lost chunk from a
  // render error; it never reaches the screen.
  'lib/lazyWithPreload.ts': { count: 1, why: 'classifies a chunk-load failure, not shown' },
  // isBackendUnavailableError reads a failed status check's message to tell
  // a backend that is down from other failures; the panel shows its own line.
  'components/panels/ChatPanel.tsx': { count: 1, why: 'classifies a status-check failure, not shown' },
  // `{e.message}` there is an agent-log entry's message (the backend's
  // publish_action line, written for the person), not an Error.
  'components/panels/AgentLog.tsx': { count: 1, why: "an agent-log entry's message, not an Error" },
  // `${err.message}` under `err instanceof GraphBundleImportTooLargeError`:
  // a FailureNotice whose reason is a written size line.
  // lib/graphFile.ts left the list in round 3f: its size notice reads failureMessage, not err.message.
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function findings(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of files(ROOT)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/console\.(warn|error|log|info|debug)/.test(line)) return;
      const shape = SHAPES.find(({ pattern }) => pattern.test(line));
      if (!shape) return;
      const file = relative(ROOT, path);
      found.set(file, [...(found.get(file) ?? []), `${file}:${index + 1} (${shape.name}) ${line.trim()}`]);
    });
  }
  return found;
}

describe("no surface renders an Error's own message", () => {
  const found = findings();

  it('every match is converted or allowed with a reason', () => {
    const unexplained = [...found.entries()]
      .filter(([file, lines]) => lines.length > (ALLOWED[file]?.count ?? 0))
      .flatMap(([, lines]) => lines);
    expect(unexplained, 'use failureMessage/failureCopy (lib/errorCopy.ts), or throw a FailureNotice').toEqual([]);
  });

  it('the allowed list stays true', () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(found.get(file)?.length ?? 0, `${file}: lower its ALLOWED count`).toBe(count);
    }
  });

  it('catches the shapes it names', () => {
    const sample = [
      "setError(err instanceof Error ? err.message : 'x');",
      'setError((e as Error).message);',
      '(e: Error) => { setError(e.message); }',
      'setError(String(error));',
      // Round 3e review: the direct shapes the first list missed.
      'return <p role="alert">{error.message}</p>;',
      'catch (err) { if (err instanceof Error) setError(err.message); }',
      'setError(String(e));',
      '.catch((e) => setError(`${e}`));',
      'alert((err as Error)?.message);',
      'setError(`Couldn\'t save. ${err?.message}`);',
    ];
    const missed = sample.filter((line) => !SHAPES.some(({ pattern }) => pattern.test(line)));
    expect(missed).toEqual([]);
    expect(SHAPES.some(({ pattern }) => pattern.test("console.warn('x', String(error))"))).toBe(true);
  });
});
