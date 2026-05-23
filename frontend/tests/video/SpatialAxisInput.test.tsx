import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SpatialAxisInput } from '../../src/components/video-editor/SpatialAxisInput';

describe('SpatialAxisInput', () => {
  it('renders a labeled number input with the spatial axis data attribute', () => {
    const { getByLabelText } = render(
      <SpatialAxisInput axis="x" label="Position X" value={100} onValueChange={() => {}} />,
    );

    const input = getByLabelText('Position X') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('100');
    expect(input.dataset.spatialAxis).toBe('x');
  });

  it('passes the numeric value to onValueChange when edited', () => {
    const onValueChange = vi.fn();
    const { getByLabelText } = render(
      <SpatialAxisInput axis="y" label="Position Y" value={50} onValueChange={onValueChange} />,
    );

    fireEvent.change(getByLabelText('Position Y'), { target: { value: '125' } });

    expect(onValueChange).toHaveBeenCalledWith(125);
  });
});
