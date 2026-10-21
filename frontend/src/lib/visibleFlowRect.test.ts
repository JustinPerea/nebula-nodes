import { describe, expect, it } from 'vitest';
import { visibleFlowCenter, visibleFlowRect } from './visibleFlowRect';

// The part of a React Flow canvas the person can see, in flow coordinates:
// the main canvas pastes into it, the Board view adds files to its middle.

const wrapper = (box: Partial<DOMRect>) => ({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0,
  width: 0, height: 0, ...box }) }) as unknown as HTMLDivElement;
// A view at zoom 0.5, panned so the screen's (100, 50) is the flow's origin.
const toFlow = ({ x, y }: { x: number; y: number }) => ({ x: (x - 100) * 2, y: (y - 50) * 2 });

describe('visibleFlowRect', () => {
  it('is the wrapper box in flow coordinates', () => {
    expect(visibleFlowRect(wrapper({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 }), toFlow))
      .toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('is undefined before the canvas has a size', () => {
    expect(visibleFlowRect(null, toFlow)).toBeUndefined();
    expect(visibleFlowRect(wrapper({ width: 0, height: 300 }), toFlow)).toBeUndefined();
  });

  it('has a middle', () => {
    expect(visibleFlowCenter(wrapper({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 }), toFlow))
      .toEqual({ x: 600, y: 400 });
    expect(visibleFlowCenter(null, toFlow)).toBeUndefined();
  });
});
