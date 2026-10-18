import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BriefFields, BriefPanel } from './MoodboardBrief';
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
