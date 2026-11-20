import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock('wavesurfer.js', () => ({ default: { create } }));

import { WaveformAudio } from '../src/components/editor/WaveformAudio';

describe('WaveformAudio', () => {
  afterEach(() => {
    create.mockClear();
    document.body.style.removeProperty('--sr-accent');
  });

  it('paints the played part with the accent token', () => {
    document.body.style.setProperty('--sr-accent', '#abcdef');
    render(<WaveformAudio sourceUrl="/a.wav" />);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ progressColor: 'rgba(171, 205, 239, 0.6)' }),
    );
  });

  it('uses the accent value when the page defines no token', () => {
    render(<WaveformAudio sourceUrl="/a.wav" />);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ progressColor: 'rgba(255, 90, 31, 0.6)' }),
    );
  });
});
