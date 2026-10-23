/**
 * Round 4b review: in the trim editor the transport row publishes its top
 * edge (GM, on #181: "publish the transport's top edge as well, so notices
 * sit over the preview's bottom edge. Cut, Vol and zoom are being used while
 * someone edits."). The preview's bottom edge then carries the notice, so
 * nothing the person reads or uses may live there:
 *
 * - the timecode readout (`.editor-preview__hud`, "00:00:01:12 / 00:00:05:00"
 *   and the "Rendered" tag) sits on the preview's top edge instead;
 * - after Render Preview, the rendered video shows its own native controls on
 *   its bottom edge. The preview then stops the picture above the notice
 *   region's reserved band, the way floating panels do (GM, round 2:
 *   "Floating panels stop above a reserved notice band, whether or not a
 *   notice is showing"), so a notice never covers its scrubber or time.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from '@xyflow/react';
import { VideoPreview } from '../../src/components/editor/VideoPreview';
import { useUIStore } from '../../src/store/uiStore';
import type { NodeData } from '../../src/types';

const INITIAL_UI = useUIStore.getState();
const edit: Node<NodeData> = { id: 'synthetic-edit', position: { x: 0, y: 0 }, data: {
  label: 'Synthetic edit', definitionId: 'video-edit', state: 'idle', outputs: {},
  params: { clips: [{ id: 'c1', start: 0, duration: 5, sourceIn: 0, sourceOut: 5, volume: 1, mute: false }], sourceFps: 30 },
} };

/** The layout rule for a selector in a stylesheet (the first block that names it alone). */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[2];
}

/** The transport (a bottom-bar part) and the notice region's reserved band, as the app has them. */
function mountBarAndBand() {
  const transport = document.createElement('div');
  transport.className = 'editor-transport';
  transport.setAttribute('data-bottom-bar', '');
  const band = document.createElement('div');
  band.className = 'notice-region__band';
  band.setAttribute('data-notice-band', '');
  document.body.append(transport, band);
  return () => { transport.remove(); band.remove(); };
}

let unmountBarAndBand: () => void = () => {};
beforeEach(() => {
  useUIStore.setState({ ...INITIAL_UI, isPlaying: false, renderedPreviewUrl: null, playheadOutputTime: 0 }, true);
  unmountBarAndBand = mountBarAndBand();
  vi.stubGlobal('innerHeight', 800);
});
afterEach(() => {
  cleanup();
  unmountBarAndBand();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUIStore.setState(INITIAL_UI, true);
});

/** Boxes at 1280x800: the preview ends 10 px above the transport (the column's gap); the band is one notice (46) plus its gap (8). */
function layout(boxes: { previewBottom: number; transportTop: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('editor-preview')) return new DOMRect(24, 102, 1232, boxes.previewBottom - 102);
    if (this.classList.contains('editor-transport')) return new DOMRect(24, boxes.transportTop, 1232, 40);
    if (this.classList.contains('notice-region__band')) return new DOMRect(16, boxes.transportTop - 8 - 54, 1248, 54);
    return new DOMRect();
  });
}

describe("the trim editor's preview keeps its own readout and controls clear of the notices", () => {
  it('the timecode readout sits on the preview’s top edge, not its bottom edge', () => {
    const css = readFileSync(join(__dirname, '../../src/components/editor/EditorView.css'), 'utf8');
    const hud = rule(css, '.editor-preview__hud');
    expect(hud).toMatch(/(^|[\s;])top:\s*8px/);
    expect(hud).not.toMatch(/(^|[\s;])bottom:/);
  });

  it('the rendered preview (native controls) stops above the reserved notice band', () => {
    layout({ previewBottom: 466, transportTop: 476 });
    useUIStore.setState({ renderedPreviewUrl: '/api/outputs/rendered.mp4' });
    const view = render(<VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />);
    const video = view.container.querySelector('video')!;
    expect(video.controls).toBe(true);
    // Lowest the picture may end: transport top 476 - 8 gap - 54 band = 414; the preview ends at 466.
    const preview = view.container.querySelector('.editor-preview') as HTMLElement;
    expect(preview.style.getPropertyValue('--notice-band-inset')).toBe('52px');
    // Only the picture reads it: the preview keeps its size, so the transport and timeline never move.
    const css = readFileSync(join(__dirname, '../../src/components/editor/EditorView.css'), 'utf8');
    expect(rule(css, '.editor-preview__video')).toMatch(/max-height:\s*calc\(100% - var\(--notice-band-inset, 0px\)\)/);
    expect(rule(css, '.editor-preview__video')).toMatch(/margin-bottom:\s*var\(--notice-band-inset, 0px\)/);
    expect(rule(css, '.editor-preview')).not.toMatch(/--notice-band-inset/);
  });

  it('the source preview (no native controls) keeps its full height under the notice', () => {
    layout({ previewBottom: 466, transportTop: 476 });
    const view = render(<VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />);
    expect(view.container.querySelector('video')!.controls).toBe(false);
    const preview = view.container.querySelector('.editor-preview') as HTMLElement;
    expect(preview.style.getPropertyValue('--notice-band-inset')).toBe('');
  });

  it('measured again on a resize, and released when the source preview comes back', () => {
    const boxes = { previewBottom: 466, transportTop: 476 };
    layout(boxes);
    useUIStore.setState({ renderedPreviewUrl: '/api/outputs/rendered.mp4' });
    const view = render(<VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />);
    const preview = view.container.querySelector('.editor-preview') as HTMLElement;
    const inset = () => preview.style.getPropertyValue('--notice-band-inset');
    expect(inset()).toBe('52px');
    // A taller window: the preview grows, and its foot moves further from the transport.
    boxes.previewBottom = 560;
    boxes.transportTop = 600;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(inset()).toBe('22px');
    act(() => { useUIStore.setState({ renderedPreviewUrl: null }); });
    expect(inset()).toBe('');
  });
});
