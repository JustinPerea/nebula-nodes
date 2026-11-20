/**
 * Design: the quiet notice button (canvas-undo-notice__action--quiet: Use theirs, the header's
 * Try again) hovers to its own faint fill, never the filled button's white. Both hover rules
 * have the same weight, so the quiet one has to come later; resolved through the app's own
 * stylesheets (tests/helpers/cssCascade).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cascaded } from './helpers/cssCascade';

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { document.body.innerHTML = ''; document.body.className = ''; });

const hover = (el: Element) => cascaded(el).get(':hover|background')?.value;

describe('the quiet button hover', () => {
  it('a quiet action hovers to the faint fill, and a filled one to white', () => {
    document.body.innerHTML = `
      <div class="canvas-undo-notice">
        <button class="canvas-undo-notice__action canvas-undo-notice__action--quiet" id="quiet">Use theirs</button>
        <button class="canvas-undo-notice__action" id="filled">Keep mine</button>
      </div>
      <div class="project-workspace-controls"><span class="project-workspace-controls__failed">
        <button class="canvas-undo-notice__action canvas-undo-notice__action--quiet project-workspace-controls__retry" id="header">Try again</button>
      </span></div>`;
    const quiet = hover(document.getElementById('quiet')!);
    expect(quiet).toBe('rgb(255 255 255 / 0.08)');
    expect(hover(document.getElementById('header')!)).toBe(quiet);
    expect(hover(document.getElementById('filled')!)).toBe('#fff');
  });
});
