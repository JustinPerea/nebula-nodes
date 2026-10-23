/**
 * Error copy round 3e, item 3 (GM - Design): the last "Could not" and
 * developer-worded lines. GM: "Write 'Couldn't {verb} {object}.' then the
 * reason, never 'Could not'"; no "failed:", no internal words ("backend
 * status", "durably", "Run remains locked").
 *
 * The second half is a guard like errorCopy.rawMessageGuard: no string in
 * src/ (outside console lines and comments) says "Could not" / "could not",
 * "failed:" or "Failed to", so the old wording can't come back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_RECONNECTING_NOTE, WORLD_LABS_RECONNECTING_NOTE, WORLD_LABS_RECOVERY_VOLATILE_NOTE, providerRecoveryWarningText,
} from '../src/lib/runHistory';
import { keyReadiness } from '../src/lib/providerReadiness';
import { failureMessage, writtenLine } from '../src/lib/errorCopy';
import { openWorkspace } from '../src/lib/goToCanvas';
import { useProjectStore } from '../src/store/projectStore';

describe('run history notes', () => {
  it('say what happened in words', () => {
    expect(WORLD_LABS_RECOVERY_VOLATILE_NOTE).toBe(
      "World Labs sent back the job's ID, but Nebula couldn't save it. Keep this tab open and copy the ID before you reload.");
    expect(providerRecoveryWarningText({ durable: false })).toBe(WORLD_LABS_RECOVERY_VOLATILE_NOTE);
    expect(WORLD_LABS_RECONNECTING_NOTE).toBe('Reconnecting to this World Labs run. You can\'t run it again until Nebula hears back about it.');
    expect(EXECUTION_RECONNECTING_NOTE).toBe('Reconnecting to this run. It stays active until Nebula hears back about it.');
    for (const note of [WORLD_LABS_RECOVERY_VOLATILE_NOTE, WORLD_LABS_RECONNECTING_NOTE, EXECUTION_RECONNECTING_NOTE]) {
      expect(note).not.toMatch(/backend status|durabl|remains locked|could not/i);
    }
  });
});

describe('provider readiness', () => {
  const cache = { loaded: true, apiKeys: { OPENAI_API_KEY: 'set' } };
  it("a check that didn't run says Couldn't", () => {
    const failed = keyReadiness('OPENAI_API_KEY', cache, { providers: {}, checkedAt: null, loading: false, error: 'x' } as never);
    expect(failed.detail).toBe("OpenAI is configured, but Nebula couldn't check the connections. Use Check connections to try again.");
    const errored = keyReadiness('OPENAI_API_KEY', cache, {
      providers: { OpenAI: { status: 'error', last_checked: new Date().toISOString() } },
      checkedAt: Date.now(), loading: false, error: null,
    } as never);
    expect(errored.detail).toBe("Couldn't check OpenAI. The saved connection is unchanged. Use Check connections to try again.");
  });
});

describe('a step written in the browser', () => {
  // Plain Errors with written lines ("The project didn't open. Try again.")
  // read GM's general line once their catch went through failureMessage; a
  // writtenLine keeps its words and takes no heading.
  it('reads word for word under any catch', () => {
    expect(failureMessage(writtenLine("The project didn't open. Try again."), "Couldn't update the note."))
      .toBe("The project didn't open. Try again.");
    expect(failureMessage(new Error("The project didn't open. Try again."), "Couldn't update the note."))
      .toBe("Couldn't update the note. Try again, or reload if it keeps happening.");
  });

  it('is what the step helpers throw', async () => {
    useProjectStore.setState({ screen: 'home', activeProject: null } as never);
    const error = await openWorkspace().catch((e: unknown) => e);
    expect(failureMessage(error, "Couldn't update the note.")).toBe('Open a project first: Updates are kept with a project.');
  });
});

// -- the guard ---------------------------------------------------------------

const ROOT = join(__dirname, '..', 'src');
// "failed:" inside words ("Backend health failed: 503"), not a `failed:` key.
const OLD_WORDING = /\b[Cc]ould not\b|[A-Za-z] failed: |\bFailed to\b/;

/** file (relative to src/) -> matching lines allowed, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  // isBackendUnavailableError matches a dev proxy's "status failed: 50x" text; not shown.
  'components/panels/ChatPanel.tsx': { count: 4, why: 'classifies a status-check failure, not shown' },
  // The health probe's throw only turns the dot offline; its text is never read.
  'components/BackendConnectionStatus.tsx': { count: 1, why: 'thrown and swallowed by the health probe' },
  // CanvasViewReporter logs it to the console only.
  'lib/canvasView.ts': { count: 1, why: 'console only (CanvasViewReporter)' },
  // TimelineRuler swallows it and shows its placeholder.
  'lib/editor/thumbnailStrip.ts': { count: 1, why: 'swallowed by TimelineRuler, not shown' },
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
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      const code = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(code) || /console\.(warn|error|log|info|debug)/.test(code)) return;
      if (!OLD_WORDING.test(code)) return;
      const file = relative(ROOT, path);
      found.set(file, [...(found.get(file) ?? []), `${file}:${index + 1} ${code}`]);
    });
  }
  return found;
}

describe("no surface says 'Could not' or 'failed:'", () => {
  const found = findings();

  it('every match is reworded or allowed with a reason', () => {
    const unexplained = [...found.entries()]
      .filter(([file, lines]) => lines.length > (ALLOWED[file]?.count ?? 0))
      .flatMap(([, lines]) => lines);
    expect(unexplained, "write \"Couldn't {verb} {object}.\" then the reason (GM)").toEqual([]);
  });

  it('the allowed list stays true', () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(found.get(file)?.length ?? 0, `${file}: lower its ALLOWED count`).toBe(count);
    }
  });
});
