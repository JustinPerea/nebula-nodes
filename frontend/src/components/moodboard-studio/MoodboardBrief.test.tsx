import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BriefFields, BriefPanel } from './MoodboardBrief';
import { BRIEF_LIMITS } from './briefLimits';
import type { MoodboardBrief } from '../../types';

function brief(overrides: Partial<MoodboardBrief> = {}): MoodboardBrief {
  return {
    styleBrief: 'Use the Nebula moodboard as look direction.',
    generatedStyleBrief: 'Use the Nebula moodboard as look direction.',
    negativePrompt: 'blurry, low-detail artifacts, neon signage',
    avoid: ['neon signage'],
    avoidPrompt: 'Keep these out of the image: neon signage.',
    direction: '',
    pinnedColors: { include: [], exclude: [] },
    palette: [],
    accents: [],
    override: { active: false, stale: false },
    needsAnalysis: false,
    ...overrides,
  };
}

function panel(props: Partial<Parameters<typeof BriefPanel>[0]> = {}) {
  const handlers = { onEdit: vi.fn(), onKeep: vi.fn(), onRegenerate: vi.fn() };
  render(<BriefPanel brief={brief()} override={null} saving={false} busy={false} {...handlers} {...props} />);
  return handlers;
}

describe('BriefPanel', () => {
  it('shows the generated brief and offers to write your own from it', () => {
    const { onEdit } = panel();
    expect(screen.getByText('Use the Nebula moodboard as look direction.')).toBeTruthy();
    expect(screen.getByText('Keep these out of the image: neon signage.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write your own' }));
    expect(onEdit).toHaveBeenCalledWith('Use the Nebula moodboard as look direction.');
  });

  it('flags an override written before the board changed, with Keep and Regenerate', () => {
    const { onKeep, onRegenerate } = panel({
      brief: brief({ styleBrief: 'Mine.', override: { active: true, stale: true } }),
      override: { text: 'Mine.' },
    });
    expect(screen.getByRole('status').textContent).toContain('Board changed since you edited this.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('shows no badge while the override is current', () => {
    panel({ brief: brief({ styleBrief: 'Mine.', override: { active: true, stale: false } }), override: { text: 'Mine.' } });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use the generated brief' })).toBeTruthy();
  });

  it('says Generated once the hand-written brief is emptied', () => {
    panel({ override: { text: '  ' } });
    expect(screen.getByText('Generated')).toBeTruthy();
    expect(screen.queryByText('Written by you')).toBeNull();
  });
});

describe('BriefFields', () => {
  it('adds avoid items once and pins colours in one list only', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <BriefFields direction="" avoid={['neon signage']} pinnedColors={{ include: [], exclude: ['#485caa'] }}
        onChange={onChange} />,
    );
    const input = screen.getByLabelText('Add to the avoid list');
    fireEvent.change(input, { target: { value: 'Neon signage, lens flare' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(onChange).toHaveBeenLastCalledWith({ avoid: ['neon signage', 'lens flare'] });

    const includeHex = screen.getByLabelText('Colors that must appear: hex');
    fireEvent.change(includeHex, { target: { value: '485CAA' } });
    expect(screen.getByText('That color is in the other list.')).toBeTruthy();
    fireEvent.change(includeHex, { target: { value: '#F6E' } });
    fireEvent.keyDown(includeHex, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ pinnedColors: { include: ['#ff66ee'], exclude: ['#485caa'] } });

    rerender(<BriefFields direction="" avoid={['neon signage']} pinnedColors={{ include: [], exclude: ['#485caa'] }}
      onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove #485caa' }));
    expect(onChange).toHaveBeenLastCalledWith({ pinnedColors: { include: [], exclude: [] } });
  });
});

describe('BriefFields limits', () => {
  it('stops at the limits the backend keeps, instead of a refused save', () => {
    const onChange = vi.fn();
    const full = Array.from({ length: BRIEF_LIMITS.avoidItems }, (_, i) => `item ${i}`);
    const pins = Array.from({ length: BRIEF_LIMITS.pinned }, (_, i) => `#0000${(10 + i).toString(16).padStart(2, '0')}`);
    render(<BriefFields direction="" avoid={full} pinnedColors={{ include: pins, exclude: [] }} onChange={onChange} />);
    expect((screen.getByLabelText('Add to the avoid list') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(`This list holds ${BRIEF_LIMITS.pinned} colors. Remove one to add another.`)).toBeTruthy();
    const includeHex = screen.getByLabelText('Colors that must appear: hex');
    fireEvent.change(includeHex, { target: { value: '#ffffff' } });
    fireEvent.keyDown(includeHex, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cuts a long avoid item to the length the backend takes', () => {
    const onChange = vi.fn();
    render(<BriefFields direction="" avoid={[]} pinnedColors={{ include: [], exclude: [] }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Add to the avoid list'), { target: { value: 'x'.repeat(300) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(onChange).toHaveBeenLastCalledWith({ avoid: ['x'.repeat(BRIEF_LIMITS.avoidItem)] });
  });
});
