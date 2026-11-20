import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommonsFilters } from './CommonsFilters';
import { EMPTY_FILTERS } from '../../lib/commonsTypes';

// Design: the Role filter reads words, never the stored value; the values stay raw.
describe('CommonsFilters role select', () => {
  it('shows Attract, Avoid, Evidence and Neutral over the raw values, and keeps "Any (avoid hidden)"', () => {
    render(<CommonsFilters filters={EMPTY_FILTERS} collections={[]} onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Any (avoid hidden)'], ['attract', 'Attract'], ['avoid', 'Avoid'], ['evidence', 'Evidence'], ['neutral', 'Neutral'],
    ]);
  });
});

describe('CommonsFilters keyword input', () => {
  it('asks for a keyword, then Enter', () => {
    render(<CommonsFilters filters={EMPTY_FILTERS} collections={[]} onChange={() => {}} />);
    expect(screen.getByLabelText('Add keyword').getAttribute('placeholder')).toBe('Type a keyword, then press Enter');
  });
});
