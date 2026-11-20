// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewAxisMeter } from '../src/components/commons/ReviewAxisMeter';

afterEach(cleanup);

function draw(value: number, axis = 'quiet_loud') {
  const { container } = render(<ReviewAxisMeter axis={axis} value={value} />);
  const meter = container.querySelector<HTMLElement>('[role="meter"]')!;
  const fill = meter.querySelector<HTMLElement>('.review-axis-fill')!;
  return { meter, fill, reach: fill.style.getPropertyValue('--axis-reach'), side: fill.getAttribute('data-side') };
}

describe('ReviewAxisMeter (design: fill runs from the centre to the value)', () => {
  it.each([
    [-0.4, 'negative', '0.4'],
    [0.5, 'positive', '0.5'],
    [-1, 'negative', '1'],
    [1, 'positive', '1'],
    [0, 'positive', '0'],
    [-3, 'negative', '1'],
    [2.5, 'positive', '1'],
  ])('value %s fills the %s side to %s of its half', (value, side, reach) => {
    const d = draw(value);
    expect(d.side).toBe(side);
    expect(d.reach).toBe(reach);
  });

  it('keeps a centre tick and hides the drawing from assistive tech', () => {
    const { meter, fill } = draw(-0.4);
    expect(meter.querySelector('.review-axis-tick')!.getAttribute('aria-hidden')).toBe('true');
    expect(fill.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes the meter role, range, value, label and the end it leans to', () => {
    const neg = draw(-0.4).meter;
    expect(neg.getAttribute('aria-valuemin')).toBe('-1');
    expect(neg.getAttribute('aria-valuemax')).toBe('1');
    expect(neg.getAttribute('aria-valuenow')).toBe('-0.4');
    expect(neg.getAttribute('aria-label')).toBe('Quiet – Loud');
    expect(neg.getAttribute('aria-valuetext')).toBe('−0.40, toward quiet');
    cleanup();
    expect(draw(0).meter.getAttribute('aria-valuetext')).toBe('0.00, centred');
    cleanup();
    expect(draw(0.5).meter.getAttribute('aria-valuetext')).toBe('0.50, toward loud');
    cleanup();
    const out = draw(5);
    expect(out.meter.getAttribute('aria-valuenow')).toBe('1');
    expect(out.meter.getAttribute('aria-valuetext')).toBe('1.00, toward loud');
  });
});
