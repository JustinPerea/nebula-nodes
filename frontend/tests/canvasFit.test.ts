import { afterEach, describe, expect, it } from 'vitest';
import { computeCanvasFitPadding } from '../src/lib/canvasFit';

function addChrome(className: string, rect: Partial<DOMRect>) {
  const element = document.createElement('div');
  element.className = className;
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
    ...rect,
  });
  document.body.appendChild(element);
}

describe('computeCanvasFitPadding', () => {
  afterEach(() => {
    document.querySelectorAll('.workspace-rail, .workspace-dock-panel, .chat-panel, .canvas-tabs, .toolbar').forEach((node) => node.remove());
  });

  it('reserves the furthest active left chrome without double counting rail and drawer', () => {
    addChrome('workspace-rail', { left: 16, right: 72, top: 16, bottom: 704, width: 56, height: 688 });
    addChrome('workspace-dock-panel', { left: 84, right: 404, top: 16, bottom: 704, width: 320, height: 688 });

    expect(computeCanvasFitPadding().left).toBe('428px');
  });

  it('keeps fitted nodes below canvas tabs and above the execution toolbar', () => {
    addChrome('canvas-tabs', { left: 400, right: 600, top: 44, bottom: 84, width: 200, height: 40 });
    addChrome('toolbar', { left: 300, right: 700, top: window.innerHeight - 64, bottom: window.innerHeight - 16, width: 400, height: 48 });
    expect(computeCanvasFitPadding().top).toBe('108px');
    expect(computeCanvasFitPadding().bottom).toBe('88px');
  });

  it('reserves an independent right chat panel while keeping base vertical padding', () => {
    addChrome('chat-panel', { left: 900, right: 1264, top: 80, bottom: 680, width: 364, height: 600 });

    expect(computeCanvasFitPadding()).toEqual({
      top: '40px',
      right: '148px',
      bottom: '40px',
      left: '40px',
    });
  });
});
