import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { BoardSwatches, ImageColors, SourcesOutdated } from './MoodboardColors';
import { formatShare, sourcesLabel } from './colorSources';
import type { MoodboardAnalysis, MoodboardColor } from '../../types';

const ORANGE: MoodboardColor = {
  hex: '#f06e1e', share: 0.0019, role: 'accent', images: 4,
  sources: [
    { number: 3, id: 'c', share: 0.0035, contribution: 0.0014 },
    { number: 7, id: 'g', share: 0.0026, contribution: 0.0003 },
    { number: 1, id: 'a', share: 0.001, contribution: 0.0001 },
    { number: 9, id: 'i', share: 0.001, contribution: 0.0001 },
  ],
};
const NAVY: MoodboardColor = {
  hex: '#1e285a', share: 0.4, role: 'dominant', images: 1,
  sources: [{ number: 2, id: 'b', share: 1, contribution: 0.4 }],
};

function analysis(overrides: Partial<MoodboardAnalysis> = {}): MoodboardAnalysis {
  return {
    version: 4, sourceHash: 'h', mode: 'look', modeIntent: '', strength: 0.7, summary: '', tasteProfile: '',
    styleBrief: '', negativePrompt: '', keywords: [], avoids: [], palette: ['#1e285a'], accents: ['#f06e1e'],
    colors: [NAVY, ORANGE], lighting: '', composition: '', materials: [], textures: [], motifs: [], subjectBias: [],
    representativeImages: [], providerHints: {},
    images: [{
      number: 2, id: 'b', url: '/b.png', weight: 1, status: 'analyzed',
      colors: [{ hex: '#ebe1cd', share: 0.9965, accent: false }, { hex: '#ef6d1f', share: 0.0035, accent: true }],
    }],
    warnings: [],
    ...overrides,
  };
}

describe('MoodboardColors', () => {
  it('formats shares and names the first source images', () => {
    expect([formatShare(0.4), formatShare(0.052), formatShare(0.0019), formatShare(0)]).toEqual(['40%', '5.2%', '0.19%', '0%']);
    expect(sourcesLabel(ORANGE)).toBe('#3, #7 +2');
    expect(sourcesLabel(NAVY)).toBe('#2');
  });

  it('labels each board colour with hex, share and source images, the full list on focus', () => {
    render(<BoardSwatches label="Accents" role="accent" analysis={analysis()} />);
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('#f06e1e');
    expect(item.textContent).toContain('0.19%');
    expect(item.textContent).toContain('#3, #7 +2');
    expect(item.getAttribute('tabindex')).toBe('0');
    const detail = screen.getByRole('tooltip', { hidden: true });
    expect(item.getAttribute('aria-describedby')).toBe(detail.id);
    expect(within(detail).getAllByText(/^Image #/).map((row) => row.textContent)).toEqual(
      ['Image #3', 'Image #7', 'Image #1', 'Image #9']);
    expect(detail.textContent).toContain('0.35% of the image');
    expect(detail.textContent).toContain('0.14% of the board');
  });

  it('shows an older analysis without sources and says to analyze again', () => {
    const old = analysis({ version: 3, colors: [{ ...NAVY, sources: undefined }, { ...ORANGE, sources: undefined }] });
    render(<><BoardSwatches label="Palette" role="dominant" analysis={old} /><SourcesOutdated analysis={old} /></>);
    expect(screen.getByRole('listitem').textContent).toBe('#1e285a40%');
    expect(screen.getByText('Analyze again to see which images each color comes from.')).toBeTruthy();
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('falls back to plain swatches for an analysis with no colour list', () => {
    render(<BoardSwatches label="Palette" role="dominant" analysis={analysis({ version: 1, colors: undefined })} />);
    expect(screen.getByRole('listitem').getAttribute('title')).toBe('#1e285a');
  });

  it('shows an image card its own colours, and nothing for an image the analysis left out', () => {
    const { container, rerender } = render(<ImageColors analysis={analysis()} imageId="b" />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['100%', '0.35%']);
    expect(items[1].getAttribute('title')).toBe('#ef6d1f · 0.35% of this image · accent');
    rerender(<ImageColors analysis={analysis()} imageId="excluded" />);
    expect(container.innerHTML).toBe('');
    rerender(<ImageColors analysis={null} imageId="b" />);
    expect(container.innerHTML).toBe('');
  });
});
