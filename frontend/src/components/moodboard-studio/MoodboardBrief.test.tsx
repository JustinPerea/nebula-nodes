import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BriefFields, BriefPanel } from './MoodboardBrief';
import { overrideAuthor } from './briefAuthor';
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

  it('says an agent wrote the brief when one did', () => {
    panel({
      brief: brief({ styleBrief: 'Theirs.', override: { active: true, stale: true } }),
      override: { text: 'Theirs.' },
      author: 'agent',
    });
    expect(screen.getByText('Written by an agent')).toBeTruthy();
    expect(screen.queryByText('Written by you')).toBeNull();
    expect(screen.getByText("An agent's brief")).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('since an agent wrote this');
  });

  it('says Generated once the hand-written brief is emptied', () => {
    panel({ override: { text: '  ' } });
    expect(screen.getByText('Generated')).toBeTruthy();
    expect(screen.queryByText('Written by you')).toBeNull();
  });
});

describe('overrideAuthor', () => {
  it("is the agent's only while the text is what the agent saved", () => {
    expect(overrideAuthor({ text: 'Theirs.', by: 'agent' }, { text: 'Theirs. ' })).toBe('agent');
    // The person started editing it: it becomes theirs (the backend stamps it so on save).
    expect(overrideAuthor({ text: 'Theirs.', by: 'agent' }, { text: 'Mine now.' })).toBe('person');
    expect(overrideAuthor({ text: 'Mine.', by: 'person' }, { text: 'Mine.' })).toBe('person');
    // Older boards have no author: they were the person's.
    expect(overrideAuthor({ text: 'Mine.' }, { text: 'Mine.' })).toBe('person');
    expect(overrideAuthor(null, { text: 'New.' })).toBe('person');
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

// -- gap 18: what the brief left out, and the board's clash setting -------------

const BRICK = { hex: '#a6392d', role: 'accent' as const, level: 'conflict' as const, why: 'check' as const,
  reason: 'Avoid: red, orange or pink flowers', reasons: ['Avoid: red, orange or pink flowers'], foundBy: ['words'] };
const BLUE = { hex: '#1c70f2', role: 'palette' as const, level: 'warning' as const, why: 'check' as const,
  reason: 'Direction: silver tonalist palette. Cornflower blue is allowed for the flowers, but this one is more saturated.',
  reasons: [], foundBy: ['words'] };
const PIN = { hex: '#e8593c', role: 'pinned' as const, level: 'conflict' as const, why: 'check' as const,
  reason: 'Avoid: red, orange or pink flowers', reasons: [], foundBy: ['words'] };

function clashPanel(overrides: Partial<MoodboardBrief>) {
  const onColorChoice = vi.fn();
  const onLeaveOutAll = vi.fn();
  panel({ brief: brief({ clashMode: 'leave-out', leftOut: [], mayClash: [], kept: [], pinnedClashes: [],
    paletteClashes: [], notesSent: false, ...overrides }), onColorChoice, onLeaveOutAll });
  return { onColorChoice, onLeaveOutAll };
}

describe('BriefPanel: left out of the brief', () => {
  it('lists each left-out colour with its reason, and Keep anyway puts it back', () => {
    const { onColorChoice } = clashPanel({ leftOut: [BRICK], mayClash: [BLUE], pinnedClashes: [PIN] });
    const left = screen.getByRole('list', { name: 'Left out of the brief' });
    expect(left.textContent).toContain('#a6392d');
    expect(left.textContent).toContain('accent');
    expect(left.textContent).toContain('Avoid: red, orange or pink flowers');
    fireEvent.click(screen.getByRole('button', { name: 'Keep #a6392d anyway' }));
    expect(onColorChoice).toHaveBeenCalledWith('keep', '#a6392d');

    const may = screen.getByRole('list', { name: 'May clash' });
    expect(may.textContent).toContain('Cornflower blue is allowed');
    fireEvent.click(screen.getByRole('button', { name: 'Leave #1c70f2 out' }));
    expect(onColorChoice).toHaveBeenLastCalledWith('leaveOut', '#1c70f2');

    const pinned = screen.getByRole('list', { name: 'Pinned, so it still goes' });
    expect(pinned.textContent).toContain('#e8593c');
    expect(pinned.textContent).toContain('Avoid: red, orange or pink flowers');
  });

  it('shows a kept colour with Undo', () => {
    const { onColorChoice } = clashPanel({ kept: [{ ...BRICK, why: 'choice' }] });
    expect(screen.getByRole('list', { name: 'Kept anyway' }).textContent).toContain('#a6392d');
    fireEvent.click(screen.getByRole('button', { name: 'Undo keeping #a6392d' }));
    expect(onColorChoice).toHaveBeenCalledWith('reset', '#a6392d');
  });

  it('in flag mode shows one Flagged list with Leave out all flagged', () => {
    const { onLeaveOutAll } = clashPanel({ clashMode: 'flag', mayClash: [BRICK, BLUE] });
    expect(screen.getByRole('list', { name: 'Flagged' }).textContent).toContain('#a6392d');
    expect(screen.queryByRole('list', { name: 'May clash' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave out all flagged' }));
    expect(onLeaveOutAll).toHaveBeenCalledWith(['#a6392d', '#1c70f2']);
  });

  it('says the check is off and lists nothing when every color is sent', () => {
    clashPanel({ clashMode: 'keep-all' });
    expect(screen.getByText('Clash check is off for this board.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Left out of the brief' })).toBeNull();
  });

  it('shows nothing extra for an older backend without the lists', () => {
    panel();
    expect(screen.queryByText(/Left out of the brief/)).toBeNull();
    expect(screen.queryByText('Clash check is off for this board.')).toBeNull();
  });
});

describe('BriefFields: advanced', () => {
  it('offers the four clash settings behind Advanced, the default marked', () => {
    const onChange = vi.fn();
    render(<BriefFields direction="" avoid={[]} pinnedColors={{ include: [], exclude: [] }} clashMode="leave-out"
      onChange={onChange} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const group = screen.getByRole('radiogroup', { name: 'When your words clash with a measured color' });
    const options = Array.from(group.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(options.map((option) => option.value)).toEqual(['leave-out', 'flag', 'no-measured', 'keep-all']);
    expect(options[0].checked).toBe(true);
    expect(group.textContent).toContain('Leave clashing colors out');
    expect(group.textContent).toContain('default');
    expect(group.textContent).toContain('Flag clashes, leave nothing out');
    expect(group.textContent).toContain('Send no measured colors');
    expect(group.textContent).toContain('Off: send every measured color');
    fireEvent.click(screen.getByLabelText(/Flag clashes, leave nothing out/));
    expect(onChange).toHaveBeenLastCalledWith({ clashMode: 'flag' });
  });
});
