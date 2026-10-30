/**
 * GM copy batch (2026-10-25, with the Agents panel PR): "Download your edits"
 * (saveEditsToFile) and "Download a copy" (saveProjectCopyToFile) past V8's
 * string cap. JSON.stringify throws RangeError("Invalid string length") for a
 * canvas over 2^29 - 24 characters, the case #190 handles for Save graph
 * ("Couldn't save the graph. It's too big to save in a browser."). GM: the
 * headings stay, and the body is "It's too big to download in a browser.",
 * so the two read as a pair with only the verb changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { failureMessage } from '../src/lib/errorCopy';
import { isStringLengthLimit, saveEditsToFile, saveProjectCopyToFile } from '../src/lib/graphFileShared';
import { UnsavedEditsNotice } from '../src/components/projects/UnsavedEditsNotice';

const SNAPSHOT = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const TOO_BIG = "It's too big to download in a browser.";

/** JSON.stringify of a whole .nebula file throws as V8 does past its string cap. */
function capTheFile(message = 'Invalid string length') {
  const stringify = JSON.stringify;
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: string | number) => {
    if (value && typeof value === 'object' && 'nodes' in value && 'version' in value) throw new RangeError(message);
    return stringify(value, replacer, space);
  }) as typeof JSON.stringify);
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('a download past the browser string cap', () => {
  it('"Download your edits" says it is too big to download in a browser', async () => {
    capTheFile();
    const error = await failure(() => saveEditsToFile(SNAPSHOT, 'Glass campaign'));
    expect(failureMessage(error, "Couldn’t download your edits."))
      .toBe(`Couldn’t download your edits. ${TOO_BIG}`);
  });

  it('"Download a copy" says the same, under its own heading', async () => {
    capTheFile();
    const error = await failure(() => saveProjectCopyToFile(SNAPSHOT, 'Glass campaign'));
    expect(failureMessage(error, "Couldn't download a copy.")).toBe(`Couldn't download a copy. ${TOO_BIG}`);
  });

  it("reuses #190's detection: a stack overflow is not the string cap", async () => {
    expect(isStringLengthLimit(new RangeError('Invalid string length'))).toBe(true);
    expect(isStringLengthLimit(new RangeError('Maximum call stack size exceeded'))).toBe(false);
    capTheFile('Maximum call stack size exceeded');
    const error = await failure(() => saveEditsToFile(SNAPSHOT, 'Glass campaign'));
    expect(error).toBeInstanceOf(RangeError);
    expect(failureMessage(error, "Couldn’t download your edits.")).not.toContain(TOO_BIG);
  });
});

describe('the held edits screen after a download too big for the browser', () => {
  it("shows GM's heading and line, with both choices still there", () => {
    render(<UnsavedEditsNotice reason="Nebula couldn't keep these edits." downloadTooBig busy={false}
      onDownload={() => {}} onContinue={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn’t download your edits.");
    expect(alert.textContent).toContain(TOO_BIG);
    expect(alert.textContent).not.toContain("Nebula couldn't keep these edits.");
    expect(screen.getByRole('button', { name: 'Download your edits' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue without them' })).toBeTruthy();
  });
});
