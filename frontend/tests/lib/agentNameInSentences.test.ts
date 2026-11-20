import { describe, expect, it } from 'vitest';
import { undoNoticeText, editArrivedText, type ForeignEdit } from '../../src/lib/canvasUndo';
import { pendingSkipLine } from '../../src/lib/pendingNodes';
import { agentNameList } from '../../src/lib/errorCopy';
import { decisionLine } from '../../src/lib/canvasProposalsBar';
import { actorLabel } from '../../src/lib/trash';
import { sceneOutpacedLine } from '../../src/lib/sceneSaveCopy';
import { handoffFailedLine, savingCutOffLine } from '../../src/lib/savingCutOff';
import { noteKeptLine } from '../../src/lib/canvasPins';

// Design: "Your Claude" at the start of a label, "your Claude" inside a sentence;
// any other name passes through.
const NAMES: Array<[string, string]> = [
  ['Your Claude', 'your Claude'],
  ['Claude Code', 'Claude Code'],
  ['Claude (your setup)', 'Claude (your setup)'],
];

const edit = (agentName: string): ForeignEdit => ({ kind: 'foreign', agentName, source: 'agent' } as ForeignEdit);

describe.each(NAMES)('%s inside a sentence', (name, mid) => {
  it('undo notice', () => expect(undoNoticeText('undo', edit(name))).toBe(`Undid ${mid}’s edit.`));
  it('arrived line keeps the name first', () => expect(editArrivedText(edit(name))).toBe(`${name} changed the canvas.`));
  it('skip line', () => expect(pendingSkipLine({ count: 2, agents: [name] })).toBe(`Skipped 2 nodes ${mid} is still setting up.`));
  it('decision line', () => expect(decisionLine('accept', name)).toBe(`Accepted the proposal from ${mid}.`));
  it('name list keeps the first, lowers the rest', () => expect(agentNameList([name, name === 'Your Claude' ? 'Your Codex' : 'Hermes'])).toBe(
    `${name} and ${name === 'Your Claude' ? 'your Codex' : 'Hermes'}`));
  it('deleted by', () => expect(actorLabel({ kind: 'agent', name })).toBe(`${mid} (agent)`));
  // The copy sweep's second pass: the same helper at four more sites.
  it('a scene outpaced: starts with the name, then lowers it', () => expect(sceneOutpacedLine('Opening', { kind: 'agent', name } as never))
    .toBe(`${name} kept changing “Opening”, so your changes aren’t saved yet. Nebula will try again when ${mid} stops.`));
  it('a save cut off by a switch', () => expect(savingCutOffLine([], 'Atlas', { kind: 'agent', agent: name } as never))
    .toContain(`It was still saving when ${mid} switched projects.`));
  it('a handoff that failed', () => expect(handoffFailedLine([], 'Atlas', name, 'Recovered Atlas'))
    .toContain(` when ${mid} switched projects. `));
  it('a note kept', () => expect(noteKeptLine({ agent: name, projectName: 'Atlas' }))
    .toBe(`Your note wasn’t sent because ${mid} started opening “Atlas”.`));
});

describe('the fallback words are not names', () => {
  it('say "an agent" as they are', () => {
    expect(noteKeptLine({ agent: null, projectName: 'Atlas' })).toBe('Your note wasn’t sent because an agent started opening “Atlas”.');
    expect(handoffFailedLine([], 'Atlas', null, 'Recovered Atlas')).toContain(' when an agent switched projects. ');
  });
});
