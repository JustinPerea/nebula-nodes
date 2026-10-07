import { describe, it, expect, vi } from 'vitest';
import { buildCommands, filterCommands, type PaletteContext } from '../src/lib/commandPalette';

function ctx(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    addNodeAtCenter: vi.fn(),
    runGraph: vi.fn(),
    save: vi.fn(),
    load: vi.fn(),
    fitView: vi.fn(),
    enterCreateView: vi.fn(),
    togglePanel: vi.fn(),
    startAgentQuery: vi.fn(),
    canRun: true,
    canSave: true,
    canLoad: true,
    canvasNodes: [],
    focusNode: vi.fn(),
    ...overrides,
  };
}

describe('buildCommands — canvas search', () => {
  it('adds a Canvas command per existing node and focuses it on perform', () => {
    const focusNode = vi.fn();
    const cmds = buildCommands(ctx({ canvasNodes: [{ id: 'n3', label: 'GPT Image' }], focusNode }));
    const canvasCmds = cmds.filter((c) => c.group === 'Canvas');
    expect(canvasCmds).toHaveLength(1);
    expect(canvasCmds[0].title).toBe('GPT Image');
    canvasCmds[0].perform();
    expect(focusNode).toHaveBeenCalledWith('n3');
  });

  it('no Canvas commands when the canvas is empty', () => {
    const cmds = buildCommands(ctx({ canvasNodes: [] }));
    expect(cmds.some((c) => c.group === 'Canvas')).toBe(false);
  });

  it('filter matches a canvas node by label', () => {
    const cmds = buildCommands(ctx({ canvasNodes: [{ id: 'n3', label: 'Veo Video' }] }));
    const hit = filterCommands(cmds, 'veo').filter((c) => c.group === 'Canvas');
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe('canvas:n3');
  });

  it('does not expose removed alternate-theme commands', () => {
    expect(buildCommands(ctx()).some((command) => command.id.startsWith('view:skin:'))).toBe(false);
    expect(filterCommands(buildCommands(ctx()), 'theme')).toEqual([]);
  });

  it('disables graph-file commands when their owner cannot safely admit them', () => {
    const commands = buildCommands(ctx({ canSave: false, canLoad: false }));
    expect(commands.find((command) => command.id === 'action:save')?.enabled).toBe(false);
    expect(commands.find((command) => command.id === 'action:load')?.enabled).toBe(false);
  });
});
