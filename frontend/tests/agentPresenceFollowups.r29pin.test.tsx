// PR #200.
// - Design: the note dialog's heading names its node, "Note for agents
//   on “Text Input”", by the title its card shows; another node with the same
//   title adds this one's bare id (styled like the card's id chip); a long
//   title stays one line, its full name in the tooltip.
// - Design (the person-only line): a pin delete refused because
//   this tab isn't connected as the person says how to fix it, never "try
//   again in a moment". (Add and delete are the only person-gated pin writes;
//   add already reads the code.)
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RequestFailedError, personRequiredCopy } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');

const node = (id: string, label?: string) => ({ id, type: 'text-input', position: { x: 0, y: 0 },
  data: { definitionId: 'text-input', params: {}, ...(label === undefined ? {} : { label }) } });
const refused = (status: number, code: string | null) => new RequestFailedError("Couldn't delete the pin.", status, { detail: 'x', code });
const heading = () => document.querySelector('.prompt-dialog__heading');
const toast = () => document.querySelector('.canvas-pin-toast--notice')?.firstElementChild?.textContent ?? null;

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    errorPersonGate: false, draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('the note dialog names its node', () => {
  it('a unique title: "Note for agents on “Text Input”", no id', () => {
    useGraphStore.setState({ nodes: [node('n1'), node('n2', 'Sky prompt')] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(document.querySelector('.prompt-dialog__heading-text')?.textContent).toBe('Note for agents on “Text Input”');
    expect(document.querySelector('.prompt-dialog__node-id')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Note for agents on “Text Input”' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Note for agents on “Text Input”' })).toBeTruthy();
  });

  it('a title another node shares: the bare id after it, as the card\'s id chip', () => {
    useGraphStore.setState({ nodes: [node('n1'), node('n4')] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n4' }));
    render(<PinComposer />);
    const id = document.querySelector('.prompt-dialog__node-id');
    expect(id?.textContent).toBe('n4');
    // What shows: the heading, then the chip (design keeps a hidden
    // whole copy for the field's name beside a cut one).
    expect(document.querySelector('.prompt-dialog__heading-text')?.textContent).toBe('Note for agents on “Text Input”');
    expect(heading()?.lastElementChild?.previousElementSibling?.textContent).toBe('n4');
    expect(screen.getByRole('dialog', { name: 'Note for agents on “Text Input” n4' })).toBeTruthy();
    // Styled like the card's id chip: its font, size, colour and edge.
    const css = readFileSync('src/styles/prompt-dialog.css', 'utf8');
    const rule = /body\.app-slava-restraint \.prompt-dialog__node-id \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const decl of ['font-family: var(--sr-mono)', 'font-size: var(--sr-type-meta)', 'color: var(--sr-ink-light)', 'background: transparent', 'border: none'])
      expect(rule, decl).toContain(decl);
  });

  it('a long title: one line, the full name in the tooltip (not laid out here, so whole)', () => {
    const long = 'A very long title for this text node that goes on well past the width of the dialog';
    useGraphStore.setState({ nodes: [node('n1', long)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    const text = document.querySelector('.prompt-dialog__heading-text');
    expect(text?.textContent).toBe(`Note for agents on “${long}”`);
    expect(text?.getAttribute('title')).toBe(`Note for agents on “${long}”`);
    const css = readFileSync('src/styles/prompt-dialog.css', 'utf8');
    const rule = /\.prompt-dialog__heading-text \{([^}]*)\}/.exec(css)?.[1] ?? '';
    // Design: cut in JS by grapheme, never by CSS
    // text-overflow (r30heading tests the cut).
    for (const decl of ['white-space: nowrap', 'overflow: hidden']) expect(rule, decl).toContain(decl);
    expect(rule).not.toContain('text-overflow');
  });
});

describe('a refused pin delete', () => {
  const seed = () => useCanvasPinsStore.setState({ pins: [{ id: 'pin_a', text: 'a note', anchor: { nodeId: 'n1' }, position: null,
    status: 'open', createdAt: '', detached: false, reply: null }] } as never);

  it('not connected as the person (403 person_required): the person-only line, the pin kept', async () => {
    seed();
    api.deletePin.mockRejectedValue(refused(403, 'person_required'));
    render(<PinComposer />);
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    expect(useCanvasPinsStore.getState().error).toBe(personRequiredCopy());
    expect(toast()).toBe(personRequiredCopy());
    expect(toast()).not.toBe(PIN_REFUSAL_COPY.deleteFailed);
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
  });

  it('any other failure keeps "Nebula couldn’t delete this note. Try again in a moment."', async () => {
    seed();
    api.deletePin.mockRejectedValue(refused(500, null));
    render(<PinComposer />);
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    expect(toast()).toBe(PIN_REFUSAL_COPY.deleteFailed);
    // A person_required refusal after it still gets its own line.
    api.deletePin.mockRejectedValue(refused(403, 'person_required'));
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    expect(toast()).toBe(personRequiredCopy());
  });
});
