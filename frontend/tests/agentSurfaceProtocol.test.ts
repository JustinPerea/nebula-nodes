import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_SAY_MAX_CHARS,
  AGENT_SURFACE_PART_LABELS,
  SURFACE_SAY_EXAMPLES,
  surfaceSay,
} from '../src/lib/agentCursorSays';
import { resolveAnchor, type AnchorLookup } from '../src/lib/agentCursorMotion';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

/** Cursor Phase 3 ("Anywhere"), slice 3, the frontend's side of the protocol:
 *  the third anchor form, its validation, and the default says on a surface. */

const SRC = resolve(__dirname, '../src');
const read = (path: string) => readFileSync(resolve(SRC, path), 'utf8');
const AGENT = { id: 'claude', name: 'Claude', color: '#E8825A', verified: true };

function event(target: unknown, extra: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent {
  return { type: 'agentPresence', agent: AGENT, action: 'click', say: '', at: 1, target, ...extra } as AgentPresenceEvent;
}

describe('the surface anchor', () => {
  beforeEach(() => useAgentPresenceStore.setState({ agents: {} }));

  it('is a cursor target like a node or a spot', () => {
    for (const target of [
      { surface: 'moodboard', itemId: 'b1' },
      { surface: 'moodboard', itemId: 'b1/img-3', part: 'note' },
      { surface: 'moodboard', itemId: 'a.b_c-1/x.y_z-2', part: 'weight' },
    ]) {
      useAgentPresenceStore.setState({ agents: {} });
      useAgentPresenceStore.getState().apply(event(target), 1000);
      expect(useAgentPresenceStore.getState().agents.claude?.target).toEqual(target);
    }
  });

  it('is refused when its item is not a board or a board/image of ids', () => {
    for (const bad of [
      { surface: 'moodboard' },
      { surface: 'moodboard', itemId: '' },
      { surface: 'moodboard', itemId: 7 },
      { surface: 'moodboard', itemId: 'b 1' },
      { surface: 'moodboard', itemId: 'b1/i1/x' },
      { surface: 'moodboard', itemId: 'b1/' },
      { surface: 'moodboard', itemId: `${'x'.repeat(65)}` },
      { surface: 'moodboard', itemId: 'b1', part: 3 },
      { surface: 'characters', itemId: 'b1' },
    ]) {
      useAgentPresenceStore.getState().apply(event(bad), 1000);
      expect(useAgentPresenceStore.getState().agents, JSON.stringify(bad)).toEqual({});
    }
  });

  it('keeps its arrival while the anchor is whole the same, and renews it when the part changes', () => {
    const store = useAgentPresenceStore.getState();
    store.apply(event({ surface: 'moodboard', itemId: 'b1/i1', part: 'note' }, { at: 10 }), 1000);
    store.apply(event({ surface: 'moodboard', itemId: 'b1/i1', part: 'note' }, { at: 50 }), 1001);
    expect(useAgentPresenceStore.getState().agents.claude.arrivedAt).toBe(10);
    store.apply(event({ surface: 'moodboard', itemId: 'b1/i1', part: 'weight' }, { at: 90 }), 1002);
    expect(useAgentPresenceStore.getState().agents.claude.arrivedAt).toBe(90);
  });

  it('has no flow point: the canvas has nothing to draw for it', () => {
    const lookup = { get: () => undefined } as unknown as AnchorLookup;
    expect(resolveAnchor({ surface: 'moodboard', itemId: 'b1' }, lookup)).toBeNull();
  });
});

describe('default says on a moodboard (GM - Design r4 item 4)', () => {
  const board = 'Desert light';

  it('are GM’s strings, word for word', () => {
    expect(SURFACE_SAY_EXAMPLES.map(({ action, line }) => `${action}: ${line}`)).toEqual([
      'look: Looking at “Desert light”',
      'look: Looking at image 12 on “Desert light”',
      'look: Looking at the colors of “Desert light”',
      'type: Writing the direction for “Desert light”',
      'type: Changing “Avoid” on “Desert light”',
      'type: Renaming “Desert light”',
      'click: Changing “Colors” on “Desert light”',
      'type: Writing a note on image 12',
      'click: Changing “Weight” on image 12',
      'type: Changing “Desert light”',
    ]);
  });

  it('say nothing for an action with no line of its own on a surface', () => {
    for (const action of ['move', 'think', 'drag', 'run', 'propose', 'wait', 'error'] as const) {
      expect(surfaceSay(action, { board, hasImage: false })).toBeNull();
    }
    expect(surfaceSay('look', { board: null, hasImage: false })).toBeNull();
  });

  it('name an image that has no number yet without inventing one', () => {
    expect(surfaceSay('look', { board, hasImage: true })).toBe('Looking at an image on “Desert light”');
    expect(surfaceSay('type', { board, hasImage: true, part: 'note' })).toBe('Writing a note on an image');
  });

  it('cut a long board name in the middle so the line fits', () => {
    const long = 'A very long board name '.repeat(12);
    for (const part of [null, 'direction', 'avoid', 'name', 'colors']) {
      const line = surfaceSay('type', { board: long, hasImage: false, part }) as string;
      expect(Array.from(line).length, String(part)).toBeLessThanOrEqual(AGENT_SAY_MAX_CHARS);
      expect(line).toContain('…');
    }
  });
});

describe('the part labels', () => {
  it('are the backend’s words (cursor_actions.PART_LABELS)', () => {
    const python = readFileSync(resolve(__dirname, '../../backend/services/cursor_actions.py'), 'utf8');
    const block = /PART_LABELS = \{([^}]*)\}/.exec(python)?.[1] ?? '';
    const backend = Object.fromEntries([...block.matchAll(/"(\w+)":\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
    expect(AGENT_SURFACE_PART_LABELS).toEqual(backend);
  });

  // GM: each label must be the one the Studio shows for that control.
  const studio = (file: string) => read(`components/moodboard-studio/${file}`);

  it('Name, Direction and Avoid are the Studio’s own field labels', () => {
    expect(studio('MoodboardStudioView.tsx')).toContain(`<span>${AGENT_SURFACE_PART_LABELS.name}</span>`);
    expect(studio('MoodboardBrief.tsx')).toContain(`>${AGENT_SURFACE_PART_LABELS.direction}</span>`);
    expect(studio('MoodboardBrief.tsx')).toContain(`<span>${AGENT_SURFACE_PART_LABELS.avoid}</span>`);
  });

  it('Weight is the slider’s label and Colors starts the pinned-colors labels', () => {
    expect(studio('BoardSidePanel.tsx')).toContain(`<span>${AGENT_SURFACE_PART_LABELS.weight} {`);
    expect(studio('MoodboardListView.tsx')).toContain(`<span>${AGENT_SURFACE_PART_LABELS.weight} {`);
    const brief = studio('MoodboardBrief.tsx');
    expect(brief).toContain(`label="${AGENT_SURFACE_PART_LABELS.colors} that must appear"`);
    expect(brief).toContain(`label="${AGENT_SURFACE_PART_LABELS.colors} to keep out"`);
  });

  it('Note is the Studio’s "Image note" field', () => {
    // The Studio's label is "Image note"; GM's list says "Note" (the line for it, "Writing a note on
    // image 12", doesn't use the label). Pinned as what it is, so a rename on either side shows here.
    expect(studio('BoardSidePanel.tsx')).toContain(`<span>Image ${AGENT_SURFACE_PART_LABELS.note.toLowerCase()}</span>`);
  });
});
