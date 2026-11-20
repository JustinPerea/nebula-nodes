import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// The Inspector's missing-key line is something to do, not a failure: it draws
// in the neutral treatment the node card gives the same line, in both skins,
// never the warning colour or the accent box.

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../src/components/panels/Inspector';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

function rule(file: string, selector: string): string {
  const css = readFileSync(resolve(__dirname, `../src/styles/${file}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, s]) => s.trim() === selector);
  return found?.[2] ?? '';
}

describe("the Inspector's missing-key line", () => {
  it('uses the key notice, not the warning one', () => {
    const missing: Node<NodeData> = { id: 'c1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Claude', definitionId: 'claude-chat', params: {}, state: 'idle', outputs: {}, keyStatus: 'missing' } };
    useGraphStore.setState({ nodes: [missing], edges: [] });
    useUIStore.getState().selectNode('c1');
    const { container } = render(<Inspector embedded />);
    const notice = container.querySelector('.inspector__notice')!;
    expect(notice.textContent).toBe('Add an Anthropic API key in Settings to run this node.');
    expect(notice.classList.contains('inspector__notice--key')).toBe(true);
    expect(notice.classList.contains('inspector__notice--warning')).toBe(false);
  });

  it('draws neutral in the default skin: grey, not amber', () => {
    const key = rule('panels.css', 'body:not(.app-slava-restraint) .inspector__notice--key');
    expect(key).toMatch(/color:\s*#a9a9b0/);
    expect(key).not.toMatch(/c58b3a|197,\s*139,\s*58/i);
  });

  it('draws neutral in the Slava skin: the card\'s ink, not the accent box', () => {
    const key = rule('slava-restraint.css', 'body.app-slava-restraint .inspector__notice--key');
    expect(key).toMatch(/color:\s*var\(--sr-ink-light\)/);
    // Design: a note is a fill alone; the base rule's `border: none` stands.
    expect(key).not.toMatch(/border/);
    expect(rule('slava-restraint.css', 'body.app-slava-restraint .inspector__notice')).toMatch(/border:\s*none/);
    expect(key).not.toMatch(/accent|warning/);
    const card = rule('slava-restraint.css', 'body.app-slava-restraint .model-node__error--key');
    expect(card).toMatch(/color:\s*var\(--sr-ink-light\)/);
  });
});
