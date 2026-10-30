import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 5, GM - Design's offline ruling: a control disabled
 * because Nebula is offline says "You can <verb> when Nebula reconnects."
 * ("You can generate when Nebula reconnects."), or the generic "This works
 * again when Nebula reconnects." The Cinema studio is locked offline: Generate
 * shot, Generate N, Generate all, + Add shot, Send to motion, the prompt, shot
 * reorder (buttons, Alt + arrow keys, drag), remove, and the scene and shot
 * settings. Each says why.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  backendAssetUrlSync: (url: string) => url,
}));

import { CinemaShotsRail } from '../src/components/cinema-studio/CinemaShotsRail';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { CinemaSharedControls } from '../src/components/cinema-studio/CinemaSharedControls';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { OFFLINE_RECONNECT_FALLBACK, OFFLINE_VERBS, offlineReason, offlineTitle } from '../src/lib/useBackendOffline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useGraphStore } from '../src/store/graphStore';
import type { CinemaSceneSpec, CinemaShot } from '../src/types';

const SCENE: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
  shots: [
    { id: 's1', prompt: 'a', output: { status: 'done', imageUrl: '/a.png' },
      variations: [{ seed: 1, url: '/a.png' }, { seed: 2, url: '/b.png' }], selectedVariation: 0,
      refImageUrls: ['/ref.png'], overrides: { palette: {} } },
    { id: 's2', prompt: 'b', output: { status: 'idle' } },
    { id: 's3', prompt: 'c', output: { status: 'idle' } },
  ] } as CinemaSceneSpec;

const offline = () => act(() => noteBackendConnection('offline'));

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  useGraphStore.setState({ activeRuns: [], nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Scene', definitionId: 'cinema-scene', params: { scene: SCENE }, state: 'idle', outputs: {} } }] } as never);
});
afterEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  useGraphStore.setState({ activeRuns: [] } as never);
});

describe('GM: the offline reason for a disabled action', () => {
  it('"You can <verb> when Nebula reconnects.", the generic line without a verb', () => {
    expect(offlineReason('generate')).toBe('You can generate when Nebula reconnects.');
    expect(offlineReason()).toBe('This works again when Nebula reconnects.');
    expect(OFFLINE_RECONNECT_FALLBACK).toBe('This works again when Nebula reconnects.');
    expect(offlineTitle(true, 'generate', 'Own title')).toBe('You can generate when Nebula reconnects.');
    expect(offlineTitle(false, 'generate', 'Own title')).toBe('Own title');
  });

  it('GM\'s verbs (PR #200 r2 item 4) are named constants', () => {
    expect(Object.values(OFFLINE_VERBS).map((verb) => offlineReason(verb))).toEqual([
      'You can generate when Nebula reconnects.',
      'You can send it to motion when Nebula reconnects.',
      'You can add shots when Nebula reconnects.',
      'You can reorder shots when Nebula reconnects.',
      'You can remove shots when Nebula reconnects.',
      'You can run nodes when Nebula reconnects.',
      'You can ask agents when Nebula reconnects.',
      'You can delete nodes when Nebula reconnects.',
      'You can create projects when Nebula reconnects.',
      'You can see run history when Nebula reconnects.',
      // GM, PR #200 r4 item 2 (PR #198 round 6).
      'You can rerun it when Nebula reconnects.',
      // Run history's Retry and Recover (PR #200 fix round 3, GM's round 3
      // answers), one list since the merge with #200.
      'You can retry it when Nebula reconnects.',
      'You can recover it when Nebula reconnects.',
    ]);
  });
});

function renderStudio(onReorder = vi.fn(), onRemoveShot = vi.fn(), onChangeShot = vi.fn()) {
  render(<>
    <CinemaStudioToolbar cinemaNodeId="n1" />
    <CinemaSharedControls cinemaNodeId="n1" scene={SCENE} connectedRefs={[]} onChange={() => {}} />
    <CinemaShotsRail cinemaNodeId="n1" scene={SCENE} selectedShotId="s2" onSelect={() => {}} onAddShot={() => {}}
      onRemoveShot={onRemoveShot} onReorder={onReorder} />
    <CinemaShotPanel cinemaNodeId="n1" scene={SCENE} shot={SCENE.shots[0] as CinemaShot} onChangeShot={onChangeShot} />
  </>);
  return { onReorder, onRemoveShot, onChangeShot };
}

/** The one fieldset that locks a group of settings. */
function lockOf(label: string): HTMLFieldSetElement {
  const group = label === 'Scene settings' ? screen.getByText(label).closest('details')!
    : screen.getByRole('region', { name: label });
  const lock = group.querySelector('fieldset');
  expect(lock, label).not.toBeNull();
  return lock!;
}

describe('GM: the Cinema studio is locked offline, and each control says why', () => {
  it('Generate shot, Generate 2 and Generate all: "You can generate when Nebula reconnects."', () => {
    offline();
    renderStudio();
    for (const name of ['Generate shot', 'Generate 2', 'Generate all']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'You can generate when Nebula reconnects.');
    }
  });

  it('+ Add shot and Send to motion are disabled and say why', () => {
    offline();
    renderStudio();
    const add = screen.getByRole('button', { name: '+ Add shot' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'You can add shots when Nebula reconnects.');
    const motion = screen.getByRole('button', { name: 'Send to motion' });
    expect(motion).toBeDisabled();
    expect(motion).toHaveAttribute('data-offline-disabled');
    expect(motion).toHaveAttribute('title', 'You can send it to motion when Nebula reconnects.');
  });

  it('the prompt is read-only and marked, with no tooltip (the banner says why)', () => {
    offline();
    const { onChangeShot } = renderStudio();
    const prompt = screen.getByLabelText('Prompt');
    expect(prompt).toHaveAttribute('readonly');
    expect(prompt).toHaveAttribute('data-offline-disabled');
    expect(prompt).not.toHaveAttribute('title');
    fireEvent.change(prompt, { target: { value: 'changed' } });
    expect(onChangeShot).not.toHaveBeenCalled();
  });

  it('reorder: the arrows are disabled and say why; Alt + arrow keys and a drop do nothing', () => {
    offline();
    const { onReorder } = renderStudio();
    for (const name of ['Move Shot 2 earlier', 'Move Shot 2 later']) {
      const button = screen.getByRole('button', { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAttribute('title', 'You can reorder shots when Nebula reconnects.');
    }
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select Shot 2' }), { key: 'ArrowLeft', altKey: true });
    const cards = document.querySelectorAll('.cinema-shots-rail__shot');
    expect(cards[0]).toHaveAttribute('draggable', 'false');
    fireEvent.dragStart(cards[1]);
    fireEvent.drop(cards[0]);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('× remove is disabled and says why', () => {
    offline();
    const { onRemoveShot } = renderStudio();
    const remove = screen.getByRole('button', { name: 'Remove Shot 3' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'You can remove shots when Nebula reconnects.');
    fireEvent.click(remove);
    expect(onRemoveShot).not.toHaveBeenCalled();
  });

  it('a variation pick is disabled, with the generic line', () => {
    offline();
    renderStudio();
    const pick = screen.getByRole('button', { name: 'Variation 2' });
    expect(pick).toBeDisabled();
    expect(pick).toHaveAttribute('title', OFFLINE_RECONNECT_FALLBACK);
  });

  it('the scene settings, the shot references and the shot art direction are disabled, with the generic line', () => {
    offline();
    renderStudio();
    for (const label of ['Scene settings', 'Shot references', 'Shot art direction']) {
      const group = lockOf(label);
      expect(group, label).toBeDisabled();
      expect(group, label).toHaveAttribute('data-offline-disabled');
      expect(group, label).toHaveAttribute('title', OFFLINE_RECONNECT_FALLBACK);
    }
    expect(screen.getByLabelText('Base model')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove composition reference 1' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Override palette' })).toBeDisabled();
  });

  it('online, every control is back with its own title', () => {
    const { onReorder } = renderStudio();
    expect(screen.getByRole('button', { name: 'Generate all' }))
      .toHaveAttribute('title', 'Generate every shot using the current scene settings');
    expect(screen.getByRole('button', { name: 'Move Shot 2 earlier' })).toHaveAttribute('title', 'Move shot earlier');
    expect(screen.getByRole('button', { name: 'Remove Shot 3' })).toHaveAttribute('title', 'Remove shot');
    expect(screen.getByLabelText('Prompt')).not.toHaveAttribute('readonly');
    expect(lockOf('Scene settings')).not.toBeDisabled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select Shot 2' }), { key: 'ArrowLeft', altKey: true });
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});

describe('GM\'s merge check: each locked Cinema control looks locked', () => {
  // PR #198 round 25 (review 23 MEDIUM-1, GM r37 option c): a locked
  // Cinema button looks the same offline as following, the app's one shared
  // rule on GM r33's tokens (the orange Generate shot the grey fill with its
  // dark label, the rest the grey label). Only the text fields keep a
  // Cinema rule: the grey label, the disabled edge, no fill.
  it('the buttons take the shared rule; one Cinema rule for the text fields: the grey label, the disabled edge, no fill, no dimming on top', () => {
    const css = readFileSync(join(__dirname, '../src/styles/cinema-studio.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const offlineRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /data-offline-disabled|\.cinema-offline-lock:disabled/.test(m[1])
      && /color|background|border/.test(m[2]));
    expect(offlineRules).toHaveLength(1);
    const [, selector, rule] = offlineRules[0];
    expect(selector).not.toMatch(/\bbutton\b/);
    expect(selector).toMatch(/textarea\[data-offline-disabled\]/);
    expect(rule).toMatch(/color:\s*var\(--disabled-label, rgba\(255, 255, 255, 0\.55\)\) !important/);
    expect(rule).toMatch(/border-color:\s*var\(--sr-disabled-edge, rgba\(255, 255, 255, 0\.06\)\) !important/);
    expect(rule).toMatch(/background:\s*transparent !important/);
    expect(rule).toMatch(/opacity:\s*1 !important/);
    const shared = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const listOf = (fill: RegExp) => [...shared.matchAll(/:is\(([^)]*)\):is\(:disabled[^{]*\{([^}]*)\}/g)].filter((m) => fill.test(m[2])).map((m) => m[1]).join(' ');
    const filled = listOf(/background:\s*var\(--disabled-fill,/);
    const ghost = listOf(/background:\s*transparent/);
    expect(filled).toMatch(/\.cinema-shot-panel__action--primary\b/);
    for (const name of ['cinema-shot-panel__action', 'cinema-shots-rail__add', 'cinema-shots-rail__move', 'cinema-shots-rail__remove',
      'cinema-shot-panel__reset', 'cinema-reference-upload__retry', 'cinema-upload__remove']) {
      expect(ghost, name).toMatch(new RegExp(`\\.${name}[,\\s]`));
    }
  });

  it('every control GM checks carries the mark the rule reads', () => {
    offline();
    renderStudio();
    for (const name of ['Generate shot', 'Generate 2', 'Generate all', '+ Add shot', 'Send to motion',
      'Move Shot 2 earlier', 'Move Shot 2 later', 'Remove Shot 3']) {
      expect(screen.getByRole('button', { name }), name).toHaveAttribute('data-offline-disabled');
      // :disabled, so the shared rule's look is the one it shows.
      expect(screen.getByRole('button', { name }), name).toBeDisabled();
    }
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('data-offline-disabled');
  });
});
