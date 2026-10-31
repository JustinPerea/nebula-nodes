/**
 * Round 20 of PR #195: GM - Design's lines, byte-exact (gm-item3-r20.md and
 * its follow-up of 2026-10-27).
 */
import { describe, expect, it } from 'vitest';
import { agentClearedLine, handoffFailedLine } from '../src/lib/savingCutOff';
import { openingLine, runWhileFollowingLine, waitToOpenTooltip } from '../src/lib/canvasFollow';
import { deleteNoAnswerLine } from '../src/lib/deleteCopy';

describe("GM 3 and follow-up 4: an agent's clear dropped the person's editing", () => {
  const text = (node: string) => ({ node, setting: 'Text' });
  it('one setting', () => {
    expect(agentClearedLine([text('Hero prompt')], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved.");
  });
  it('two settings on one node', () => {
    expect(agentClearedLine([{ node: 'Hero', setting: 'Prompt' }, { node: 'Hero', setting: 'Seed' }], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Prompt” and “Seed” for “Hero”. Those changes weren’t saved.");
  });
  it('three settings on one node', () => {
    expect(agentClearedLine([{ node: 'Hero', setting: 'Prompt' }, { node: 'Hero', setting: 'Seed' },
      { node: 'Hero', setting: 'Steps' }], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Prompt”, “Seed” and “Steps” for “Hero”. Those changes weren’t saved.");
  });
  it('four settings on one node', () => {
    expect(agentClearedLine(['Prompt', 'Seed', 'Steps', 'Size'].map((setting) => ({ node: 'Hero', setting })), 'Codex'))
      .toBe("Codex cleared the canvas while you were editing 4 settings. Those changes weren’t saved.");
  });
  it('settings across nodes', () => {
    expect(agentClearedLine([text('A'), text('B')], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing 2 settings. Those changes weren’t saved.");
  });
  it('a rename draft counts as "Name"', () => {
    expect(agentClearedLine([{ node: 'Hero', setting: 'Name' }], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Name” for “Hero”. That change wasn’t saved.");
    expect(agentClearedLine([{ node: 'Hero', setting: 'Name' }, { node: 'Hero', setting: 'Text' }], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Name” and “Text” for “Hero”. Those changes weren’t saved.");
  });
  it('the agent unknown: "An agent"', () => {
    expect(agentClearedLine([text('Hero prompt')], null))
      .toBe("An agent cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved.");
  });
  it('the same setting twice counts once', () => {
    expect(agentClearedLine([text('Hero prompt'), text('Hero prompt')], 'Codex'))
      .toBe("Codex cleared the canvas while you were editing “Text” for “Hero prompt”. That change wasn’t saved.");
  });
  it('nothing named: no line', () => {
    expect(agentClearedLine([], 'Codex')).toBeNull();
  });
});

describe('GM follow-up 2: the failed handoff, one line (round 21: non-breaking spaces in the project names)', () => {
  it('one setting', () => {
    expect(handoffFailedLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', 'Claude Code',
      'Glass campaign (recovered)'))
      .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass\u00a0campaign” when Claude Code switched projects. "
        + 'Your edits were saved as a copy, “Glass\u00a0campaign\u00a0(recovered)”.');
  });
  it('several settings: the undo counting', () => {
    expect(handoffFailedLine([{ node: 'A', setting: 'Text' }, { node: 'B', setting: 'Text' }, { node: 'B', setting: 'Name' }],
      'Glass campaign', 'Claude Code', 'Glass campaign (recovered)'))
      .toBe("Couldn’t save 3 changes in “Glass\u00a0campaign” when Claude Code switched projects. "
        + 'Your edits were saved as a copy, “Glass\u00a0campaign\u00a0(recovered)”.');
  });
  it('one change it can\'t name', () => {
    expect(handoffFailedLine([{ node: null, setting: null }], 'Glass campaign', 'Claude Code', 'Glass campaign (recovered)'))
      .toBe("Couldn’t save your last change in “Glass\u00a0campaign” when Claude Code switched projects. "
        + 'Your edits were saved as a copy, “Glass\u00a0campaign\u00a0(recovered)”.');
  });
  it('the agent unknown', () => {
    expect(handoffFailedLine([{ node: 'Hero prompt', setting: 'Text' }], 'Glass campaign', null, 'Glass campaign (recovered)'))
      .toBe("Couldn’t save “Text” for “Hero prompt” in “Glass\u00a0campaign” when an agent switched projects. "
        + 'Your edits were saved as a copy, “Glass\u00a0campaign\u00a0(recovered)”.');
  });
});

describe('GM follow-ups 1 and 3: following an agent\'s switch', () => {
  it('the project bar', () => {
    expect(openingLine('beta')).toBe('Opening “beta”…');
  });
  it("Run's tooltip", () => {
    expect(waitToOpenTooltip('beta')).toBe('Wait for “beta” to open.');
  });
  it('a press that gets through', () => {
    expect(runWhileFollowingLine('Hero prompt', 'Claude Code', 'beta')).toBe("Couldn’t run “Hero prompt”. Claude Code is opening “beta”.");
    expect(runWhileFollowingLine('Hero prompt', null, 'beta')).toBe("Couldn’t run “Hero prompt”. An agent is opening “beta”.");
  });
});

describe('GM 1: a failed delete with no answer', () => {
  const tail = "Nebula isn't answering. Make sure it's running, then try again.";
  it('one node', () => {
    expect(deleteNoAnswerLine(['Nano Banana'])).toBe(`Couldn't delete “Nano Banana”. ${tail}`);
  });
  it('two nodes', () => {
    expect(deleteNoAnswerLine(['A', 'B'])).toBe(`Couldn't delete “A” and “B”. ${tail}`);
  });
  it('three nodes', () => {
    expect(deleteNoAnswerLine(['A', 'B', 'C'])).toBe(`Couldn't delete “A”, “B” and “C”. ${tail}`);
  });
  it('four nodes and up', () => {
    expect(deleteNoAnswerLine(['A', 'B', 'C', 'D'])).toBe(`Couldn't delete 4 nodes. ${tail}`);
    expect(deleteNoAnswerLine(['A', 'B', 'C', 'D', 'E'])).toBe(`Couldn't delete 5 nodes. ${tail}`);
  });
});
