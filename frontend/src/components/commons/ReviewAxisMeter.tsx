import type { CSSProperties } from 'react';
import { axisLabel, axisValue } from '../../lib/commonsTypes';

/** The end an axis value leans to, named from the same key words the axis-ends row prints. */
function valueText(axis: string, value: number): string {
  const [low, high] = axis.split('_');
  const text = axisValue(value);
  if (value === 0) return `${text}, centred`;
  return `${text}, toward ${value < 0 ? low : high}`;
}

/**
 * A review grade on a centred axis (design): the axes run from -1 to +1, so the fill runs from a centre
 * tick to the value, left for negative and right for positive. Drawn with divs so the track and fill are
 * ours. The value is clamped to [-1, 1] (NaN draws as 0), and a value that prints as 0.00 draws as 0,
 * so the drawing matches the number beside it. The reach is set through the --axis-reach custom
 * property (0 to 1 of a half) and the side through data-side. Spans, since it sits inside a label.
 */
export function ReviewAxisMeter({ axis, value }: { axis: string; value: number }) {
  const clamped = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
  const shown = Number(Math.abs(clamped).toFixed(2)) === 0 ? 0 : clamped;
  const side = shown < 0 ? 'negative' : 'positive';
  return (
    <span className="review-axis-meter" role="meter" aria-label={axisLabel(axis)} aria-valuemin={-1} aria-valuemax={1}
      aria-valuenow={shown} aria-valuetext={valueText(axis, shown)}>
      <span className="review-axis-fill" aria-hidden="true" data-side={side}
        style={{ '--axis-reach': Math.abs(shown) } as CSSProperties} />
      <span className="review-axis-tick" aria-hidden="true" />
    </span>
  );
}
