/**
 * Round 23 of PR #195: GM - Design's failed-save wording (2026-10-27), verbatim.
 * - One node, 2–3 settings: "Couldn’t save “a” and “b” for “Hero still”." /
 *   "“a”, “b” and “c”".
 * - One node, 4+ settings: "Couldn’t save 4 settings for “Hero still”."
 * - Two or three nodes: "Couldn’t save your changes to “Hero still” and “Hero prompt”."
 * - Four+ nodes: "Couldn’t save your changes to 4 nodes."
 * - None named: "Couldn’t save your last change."
 * - A replacement found after a reconnect or restart, with no agent: no
 *   "when Codex switched projects": "Couldn’t save “Text” for “Hero prompt”.
 *   Your edits were saved as a copy, “Round r20 (recovered)”."
 */
import { describe, expect, it } from 'vitest';
import { changesNotSavedLine, changesSavedAsCopyLine, handoffFailedLine, type CutOffSave } from '../src/lib/savingCutOff';
import { paramSaveFailedLine } from '../src/store/graphStore';

const on = (node: string, ...settings: string[]): CutOffSave[] =>
  settings.map((setting) => ({ nodeId: `id-${node}`, node, setting }));

describe('GM round 23: the failed-save counted forms', () => {
  it('one node, one setting', () => {
    expect(changesNotSavedLine(on('Hero still', 'a'))).toBe("Couldn’t save “a” for “Hero still”.");
  });
  it('one node, 2–3 settings: named', () => {
    expect(changesNotSavedLine(on('Hero still', 'a', 'b'))).toBe("Couldn’t save “a” and “b” for “Hero still”.");
    expect(changesNotSavedLine(on('Hero still', 'a', 'b', 'c'))).toBe("Couldn’t save “a”, “b” and “c” for “Hero still”.");
  });
  it('one node, 4+ settings: counted', () => {
    expect(changesNotSavedLine(on('Hero still', 'a', 'b', 'c', 'd'))).toBe("Couldn’t save 4 settings for “Hero still”.");
  });
  it('two or three nodes: the nodes named', () => {
    expect(changesNotSavedLine([...on('Hero still', 'a', 'b'), ...on('Hero prompt', 'Text')]))
      .toBe("Couldn’t save your changes to “Hero still” and “Hero prompt”.");
    expect(changesNotSavedLine([...on('Hero still', 'a'), ...on('Hero prompt', 'Text'), ...on('Grade', 'Look')]))
      .toBe("Couldn’t save your changes to “Hero still”, “Hero prompt” and “Grade”.");
  });
  it('four+ nodes: counted', () => {
    expect(changesNotSavedLine([...on('A', 'x'), ...on('B', 'x'), ...on('C', 'x'), ...on('D', 'x')]))
      .toBe("Couldn’t save your changes to 4 nodes.");
  });
  it('two nodes with the same title are two nodes, grouped with a count (GM, 2026-10-27)', () => {
    expect(changesNotSavedLine([{ nodeId: 'n1', node: 'Text', setting: 'Text' }, { nodeId: 'n2', node: 'Text', setting: 'Text' }]))
      .toBe("Couldn’t save your changes to 2 “Text” nodes.");
  });
  it('none it can name', () => {
    expect(changesNotSavedLine([{ node: null, setting: null }])).toBe("Couldn’t save your last change.");
  });
  it('the canvas\'s own failed save says the same counted forms (one wording)', () => {
    expect(paramSaveFailedLine(['a', 'b', 'c'], 'Hero still', false)).toBe("Couldn’t save “a”, “b” and “c” for “Hero still”.");
    expect(paramSaveFailedLine(['a', 'b', 'c'], 'Hero still', true))
      .toBe("Couldn’t save “a”, “b” and “c” for “Hero still”. They’re back to their last saved values.");
    expect(paramSaveFailedLine(['a', 'b', 'c', 'd'], 'Hero still', false)).toBe("Couldn’t save 4 settings for “Hero still”.");
  });
});

describe('GM round 23: a replacement with no agent, edits saved as a copy', () => {
  it('names what wasn’t saved and the copy, with no "when … switched projects"', () => {
    expect(changesSavedAsCopyLine(on('Hero prompt', 'Text'), 'Round r20 (recovered)'))
      .toBe("Couldn’t save “Text” for “Hero prompt”. Your edits were saved as a copy, “Round r20 (recovered)”.");
  });
  it('the counted forms carry over', () => {
    expect(changesSavedAsCopyLine([...on('Hero still', 'a'), ...on('Hero prompt', 'Text')], 'Round r20 (recovered)'))
      .toBe("Couldn’t save your changes to “Hero still” and “Hero prompt”. Your edits were saved as a copy, “Round r20 (recovered)”.");
    expect(changesSavedAsCopyLine([], 'Glass (recovered)'))
      .toBe("Couldn’t save your last change. Your edits were saved as a copy, “Glass (recovered)”.");
  });
  it('an agent\'s switch keeps its own line', () => {
    expect(handoffFailedLine(on('Hero prompt', 'Text'), 'Glass campaign', 'Codex', 'Glass campaign (recovered)'))
      .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass campaign” when Codex switched projects. "
        + 'Your edits were saved as a copy, “Glass campaign (recovered)”.');
  });
});
