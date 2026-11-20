/**
 * The kept-undo sentences are worded on two sides: one line per kept slice by the backend
 * (services/moodboard_edits.py) and one line for the whole undo by the Studio (undoLines.ts). One shared fixture
 * (backend/tests/fixtures/moodboard_undo_lines.json) pins both, so a join or a quote that drifts on one side fails
 * here or in backend/tests/test_moodboard_undo_lines_parity.py. Where the two are meant to differ, the case keeps
 * both lines.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keptUndoLine, undoneLine } from '../src/components/moodboard-studio/undoLines';

interface Case {
  name: string; label: string; skipped: Record<string, unknown>[]; backendLines: string[]; studioLine: string | null;
}
const shared = JSON.parse(readFileSync(join(__dirname, '../../backend/tests/fixtures/moodboard_undo_lines.json'), 'utf8')) as {
  cases: Case[]; quotes: { label: string; quoted: string }[];
};

describe('the Studio’s kept-undo lines, from the shared cases', () => {
  it.each(shared.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(keptUndoLine(c.label, c.skipped)).toBe(c.studioLine);
  });

  it.each(shared.quotes.map((q) => [q.label, q] as const))('quotes the label %s without nesting', (_label, q) => {
    expect(undoneLine('undo', q.label)).toBe(`Undid ${q.quoted}`);
    expect(undoneLine('redo', q.label)).toBe(`Redid ${q.quoted}`);
  });
});
