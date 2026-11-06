/**
 * PR #199 round 25, GM r24 (c): a press whose chunk didn't load says GM's
 * line, once, with [Try again] in the neutral notice colour (never the
 * danger box, and never "Try again" in the sentence beside the button).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { PART_LOAD_LINE } from '../src/store/projectStore';

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;
afterEach(cleanup);

describe('GM r24 (c): the chunk-failure box', () => {
  it('says GM’s line verbatim, in the neutral notice, with [Try again] as its only button', () => {
    const onRetry = vi.fn();
    const { container } = render(<ProjectHome {...base} onRetry={onRetry} retry="partLoad" error={PART_LOAD_LINE} />);
    expect(PART_LOAD_LINE).toBe('Nebula couldn’t open the project because part of the app didn’t load. If it keeps happening, reload the page.');
    // Neutral notice colour: the notice box, not the danger-tinted error box.
    expect(container.querySelector('.project-home__error')).toBeNull();
    const box = container.querySelector<HTMLElement>('.project-home__notice')!;
    expect(box.textContent).toContain(PART_LOAD_LINE);
    // "Try again" once: the button's word, not the sentence's.
    expect(box.textContent!.match(/Try again/g)).toHaveLength(1);
    const buttons = box.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
