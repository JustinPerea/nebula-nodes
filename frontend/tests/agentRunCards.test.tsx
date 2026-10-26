import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

/**
 * Done cards (Q125 item 3): the Update Nebula posts when an agent's run
 * ends. GM - Design, 2026-10-25, verbatim: "One button on all of them: Show
 * on canvas. Layout: the agent's colour on the left edge, like the question
 * form. Failure gets the existing error icon by the message, never a red
 * edge. Thumbnail: the last node's first output, below the message, 96 px
 * tall, natural aspect, never cropped, capped at the card's width. Video:
 * its first frame, with the duration in mono in the corner. Text or audio
 * output: no thumbnail."
 */

vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  backendAssetUrlSync: (path: string) => `http://127.0.0.1:8795${path}`,
}));

const { sanitizeNote } = await import('../src/lib/agentNotes');
const { AgentNoteCard } = await import('../src/components/agent-notes/AgentNoteCard');

afterEach(cleanup);

function raw(run: Record<string, unknown>, text = 'Codex finished “Hero shots”.') {
  return {
    id: 'note_1', author: { kind: 'agent', id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false },
    source: 'nebula', about: 'run', at: '2026-10-25T10:00:00Z', text, refs: ['n4'], actions: [],
    readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
    run: { id: 'r1', nodeIds: ['n4'], lastNodeId: 'n4', ...run },
  };
}

const adapter = { keptWith: 'kept with this project', showLabel: () => 'Show on canvas', show: vi.fn(), runAction: vi.fn() };
const hold = { onMouseEnter: () => {}, onMouseLeave: () => {}, onFocus: () => {}, onBlur: () => {} };

function card(note: ReturnType<typeof sanitizeNote>) {
  return render(<AgentNoteCard note={note!} adapter={adapter} leaving={false} cardRef={() => {}} hold={hold}
    onRead={() => {}} onDismiss={() => {}} onAction={() => {}} onShow={() => {}} />);
}

describe('sanitizeNote keeps a done card', () => {
  it('keeps about "run" and its run: outcome and a thumbnail from the output folder only', () => {
    const note = sanitizeNote(raw({ outcome: 'success', thumbnail: { kind: 'image', url: '/api/outputs/a/hero.png', nodeId: 'n4' } }));
    expect(note?.about).toBe('run');
    expect(note?.run).toEqual({ id: 'r1', nodeIds: ['n4'], lastNodeId: 'n4', outcome: 'success',
      thumbnail: { kind: 'image', url: '/api/outputs/a/hero.png', nodeId: 'n4' } });
    for (const url of ['https://cdn.example/x.png?sig=abc', '/etc/passwd', 'javascript:alert(1)']) {
      expect(sanitizeNote(raw({ outcome: 'success', thumbnail: { kind: 'image', url } }))?.run?.thumbnail).toBeUndefined();
    }
    expect(sanitizeNote(raw({ outcome: 'weird' }))?.run?.outcome).toBe('success');
  });
});

describe('the card', () => {
  it("has the agent's colour edge, the message, a thumbnail below it and one Show on canvas button", () => {
    const { container, getAllByRole } = card(sanitizeNote(raw({ outcome: 'success',
      thumbnail: { kind: 'image', url: '/api/outputs/a/hero.png', nodeId: 'n4' } })));
    const root = container.querySelector<HTMLElement>('.agent-note-card')!;
    expect(root.dataset.about).toBe('run');
    expect(root.dataset.outcome).toBe('success');
    expect(container.querySelector('.agent-note-card__text')?.textContent).toBe('Codex finished “Hero shots”.');
    const img = container.querySelector<HTMLImageElement>('.agent-run-thumb img')!;
    expect(img.getAttribute('src')).toBe('http://127.0.0.1:8795/api/outputs/a/hero.png');
    expect(img.getAttribute('alt')).toBe('');
    // Below the message.
    const text = container.querySelector('.agent-note-card__text')!;
    expect(text.compareDocumentPosition(container.querySelector('.agent-run-thumb')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getAllByRole('button').map((button) => button.textContent)).toEqual(['', 'Show on canvas']);
    expect(container.querySelector('.agent-run-icon')).toBeNull();
  });

  it("shows a video's first frame with its duration in the corner", () => {
    const { container } = card(sanitizeNote(raw({ outcome: 'success',
      thumbnail: { kind: 'video', url: '/api/outputs/a/clip.mp4', nodeId: 'n4' } })));
    const video = container.querySelector<HTMLVideoElement>('.agent-run-thumb video')!;
    expect(video.getAttribute('src')).toBe('http://127.0.0.1:8795/api/outputs/a/clip.mp4#t=0.001');
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.muted).toBe(true);
    Object.defineProperty(video, 'duration', { value: 83.4, configurable: true });
    fireEvent.loadedMetadata(video);
    expect(container.querySelector('.agent-run-thumb__duration')?.textContent).toBe('1:23');
  });

  it('a failure has the error icon by the message and no thumbnail', () => {
    const { container } = card(sanitizeNote(raw({ outcome: 'failure' }, "Codex's run of “Hero shots” failed.")));
    expect(container.querySelector('.agent-note-card')?.getAttribute('data-outcome')).toBe('failure');
    const icon = container.querySelector('.agent-run-icon')!;
    // GM - Design, 2026-10-25: aria-hidden, the message already says "failed";
    // the glyph the node's own error state uses (a failed shot's ⚠).
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.hasAttribute('aria-label')).toBe(false);
    expect(icon.hasAttribute('role')).toBe(false);
    expect(icon.textContent).toBe('\u26A0');
    expect(container.querySelector('.agent-run-thumb')).toBeNull();
  });

  it('a thumbnail that fails to load goes away', () => {
    const { container } = card(sanitizeNote(raw({ outcome: 'success',
      thumbnail: { kind: 'image', url: '/api/outputs/a/gone.png', nodeId: 'n4' } })));
    fireEvent.error(container.querySelector('.agent-run-thumb img')!);
    expect(container.querySelector('.agent-run-thumb')).toBeNull();
  });
});
