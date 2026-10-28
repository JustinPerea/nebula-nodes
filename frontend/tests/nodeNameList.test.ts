import { describe, expect, it } from 'vitest';
import { nodeNameList } from '../src/lib/errorCopy';
import { changesNotSavedLine, changesSavedAsCopyLine } from '../src/lib/savingCutOff';
import { deleteNoAnswerLine, deleteServerErrorLine } from '../src/lib/deleteCopy';

/**
 * GM - Design (2026-10-27, the follow-up to PR #195), verbatim: same-title
 * nodes are grouped with a count, "Couldn't save your changes to 2 “Text”
 * nodes."; a mix, "…to “Brief” and 2 “Text” nodes."; the rule counts nodes,
 * not groups, so 4 or more nodes in total read "…to 4 nodes."; no node ids
 * in the person's copy. One shared helper (errorCopy nodeNameList) for every
 * list of names: the failed-save lines and the multi-delete toasts.
 */
describe('nodeNameList', () => {
  it.each([
    [['Hero'], '“Hero”'],
    [['A', 'B'], '“A” and “B”'],
    [['A', 'B', 'C'], '“A”, “B” and “C”'],
    [['Text', 'Text'], '2 “Text” nodes'],
    [['Text', 'Text', 'Text'], '3 “Text” nodes'],
    [['Brief', 'Text', 'Text'], '“Brief” and 2 “Text” nodes'],
    [['Text', 'Brief', 'Text'], '2 “Text” nodes and “Brief”'],
    [['A', 'B', 'C', 'D'], '4 nodes'],
    [['Text', 'Text', 'Text', 'Text'], '4 nodes'],
    [['Text', 'Text', 'Brief', 'Brief', 'Grade'], '5 nodes'],
  ])('%j → %s', (names, expected) => {
    expect(nodeNameList(names)).toBe(expected);
  });
});

describe('the lines that name several nodes use it', () => {
  const on = (nodeId: string, node: string) => ({ nodeId, node, setting: 'Text' });
  it('the failed-save line', () => {
    expect(changesNotSavedLine([on('n1', 'Text'), on('n2', 'Text')])).toBe("Couldn't save your changes to 2 “Text” nodes.");
    expect(changesNotSavedLine([on('n3', 'Brief'), on('n1', 'Text'), on('n2', 'Text')]))
      .toBe("Couldn't save your changes to “Brief” and 2 “Text” nodes.");
    expect(changesNotSavedLine([on('n1', 'Text'), on('n2', 'Text'), on('n3', 'Text'), on('n4', 'Brief')]))
      .toBe("Couldn't save your changes to 4 nodes.");
    expect(changesSavedAsCopyLine([on('n1', 'Text'), on('n2', 'Text')], 'Glass (recovered)'))
      .toBe("Couldn't save your changes to 2 “Text” nodes. Your edits were saved as a copy, “Glass (recovered)”.");
  });
  it('the multi-delete toasts', () => {
    expect(deleteNoAnswerLine(['Text', 'Text'])).toBe(
      "Couldn't delete 2 “Text” nodes. Nebula isn't answering. Make sure it's running, then try again.");
    expect(deleteServerErrorLine(['Brief', 'Text', 'Text'])).toBe(
      "Couldn't delete “Brief” and 2 “Text” nodes. Nebula ran into an error, so they're back on the canvas. Try again, and if it keeps happening, restart Nebula.");
  });
});
