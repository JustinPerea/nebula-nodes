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

  it('yields to text fields, dialogs and other panels', () => {
    const $ = mount(`
      <div class="canvas-wrapper"><textarea id="prompt"></textarea><div id="rich" contenteditable="true"></div></div>
      <div class="toolbar"><section role="dialog"><button id="menu">Load</button></section></div>
      <aside class="chat-panel"><p id="transcript">hello</p></aside>`);
    for (const id of ['#prompt', '#menu', '#transcript']) expect(isCanvasShortcutTarget($(id))).toBe(false);
  });
});
