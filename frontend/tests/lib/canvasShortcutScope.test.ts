import { afterEach, describe, expect, it } from 'vitest';
import { isCanvasShortcutTarget } from '../../src/lib/canvasShortcutScope';

function mount(html: string) {
  document.body.innerHTML = html;
  return (selector: string) => document.querySelector(selector);
}

describe('canvas shortcut scope', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('accepts the canvas, its chrome and an unfocused page', () => {
    const $ = mount(`
      <div class="canvas-wrapper"><div id="node"></div></div>
      <div class="toolbar"><button id="run">Run</button></div>
      <nav class="workspace-rail"><button id="rail">+</button></nav>
      <header class="workspace-header workspace-header--canvas"><button id="tab">Canvas</button></header>`);
    for (const id of ['#node', '#run', '#rail', '#tab']) expect(isCanvasShortcutTarget($(id))).toBe(true);
    expect(isCanvasShortcutTarget(document.body)).toBe(true);
  });

  // The proposal bar and the pin error toast left .canvas-wrapper for the app's
  // notice region (round 2): focus on the bar (Review focuses it) or on a
  // toast's button still leaves Cmd+Z, Shift+1 and Cmd+Enter the canvas's.
  it('accepts the notice region, which keeps no keys of its own, but not a field in it', () => {
    const $ = mount(`
      <div class="notice-region"><div class="notice-region__stack">
        <div class="notice-region__slot" data-notice-slot="proposal">
          <div class="proposal-bar" tabindex="-1" id="bar"><button id="accept">Accept</button></div>
        </div>
        <div class="notice-region__slot" data-notice-slot="pin">
          <div class="canvas-pin-toast" role="alert"><button id="dismiss">Dismiss</button><input id="field" /></div>
        </div>
      </div></div>`);
    for (const id of ['#bar', '#accept', '#dismiss']) expect(isCanvasShortcutTarget($(id))).toBe(true);
    expect(isCanvasShortcutTarget($('#field'))).toBe(false);
  });

  it('yields to text fields, dialogs and other panels', () => {
    const $ = mount(`
      <div class="canvas-wrapper"><textarea id="prompt"></textarea><div id="rich" contenteditable="true"></div></div>
      <div class="toolbar"><section role="dialog"><button id="menu">Load</button></section></div>
      <aside class="chat-panel"><p id="transcript">hello</p></aside>`);
    for (const id of ['#prompt', '#menu', '#transcript']) expect(isCanvasShortcutTarget($(id))).toBe(false);
  });
});
