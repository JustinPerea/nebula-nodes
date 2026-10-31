/**
 * PR #204 round 9, GM r13 (2), verbatim: "The band reserves the tallest single notice (three
 * lines). ... While a capped popover is open, show only the newest notice in the band. The
 * others wait and appear when it's dismissed or the popover closes."
 *
 * Here (jsdom): which items wait, that none is lost (a waiting notice's timer holds), and that
 * every popover that stops at the band holds it. The live check at 1280×800 and 1440×900 shows
 * no notice on a popover's content (scratchpad fu3i shots).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { useCallback, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const { NoticeRegion } = await import('../src/components/NoticeRegion');
const { InNoticeRegion } = await import('../src/components/InNoticeRegion');
const waiting = await import('../src/lib/noticeWaiting');
const { useNoticeHold } = await import('../src/hooks/useNoticeHold');
const { noticeHoldMs } = await import('../src/lib/canvasNoticeHold');

const handles: Record<string, (shown: boolean) => void> = {};
function Toast({ slot, text }: { slot: 'pin' | 'board' | 'asset-trash'; text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { handles[slot] = setShown; }, [slot]);
  return shown ? <InNoticeRegion slot={slot}><div className="toast" data-toast={slot}>{text}</div></InNoticeRegion> : null;
}
const item = (slot: string) => document.querySelector<HTMLElement>(`[data-toast="${slot}"]`)!;
const waits = (slot: string) => item(slot).hasAttribute('data-notice-waiting');
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => waiting.resetNoticeWaitingForTests());
afterEach(() => { cleanup(); waiting.resetNoticeWaitingForTests(); vi.useRealTimers(); });

describe('GM r13 (2): one notice in the band while a capped popover is open', () => {
  it('only the newest shows; the others wait, and appear when it goes or the popover closes', async () => {
    render(<><NoticeRegion screen="home" /><Toast slot="pin" text="Older" /><Toast slot="board" text="Newer" /></>);
    act(() => handles.pin(true));
    await flush();
    act(() => handles.board(true));
    await flush();
    expect(waits('pin') || waits('board')).toBe(false);

    let release = () => {};
    act(() => { release = waiting.holdCappedPopover(); });
    await flush();
    expect(waits('pin')).toBe(true);
    expect(waits('board')).toBe(false);
    expect(waiting.slotWaiting('pin')).toBe(true);
    // A third arrives while it is open: it is the newest now.
    render(<Toast slot="asset-trash" text="Newest" />);
    act(() => handles['asset-trash'](true));
    await flush();
    expect([waits('pin'), waits('board'), waits('asset-trash')]).toEqual([true, true, false]);
    // The newest dismissed: the next newest appears; none is lost.
    act(() => handles['asset-trash'](false));
    await flush();
    expect([waits('pin'), waits('board')]).toEqual([true, false]);
    act(() => release());
    await flush();
    expect([waits('pin'), waits('board')]).toEqual([false, false]);
    expect(waiting.slotWaiting('pin')).toBe(false);
  });

  it('with one notice nothing waits, and two popovers hold it until both close', async () => {
    render(<><NoticeRegion screen="home" /><Toast slot="pin" text="One" /><Toast slot="board" text="Two" /></>);
    act(() => handles.pin(true));
    await flush();
    const first = waiting.holdCappedPopover();
    const second = waiting.holdCappedPopover();
    await flush();
    expect(waits('pin')).toBe(false);
    act(() => handles.board(true));
    await flush();
    expect(waits('pin')).toBe(true);
    act(() => { first(); first(); });
    await flush();
    expect(waits('pin')).toBe(true);
    act(() => second());
    await flush();
    expect(waits('pin')).toBe(false);
  });

  it('the band and the waiting rule are in the region\'s stylesheet', () => {
    const css = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
    expect(css).toMatch(/--notice-tallest-h:\s*\d+px/);
    expect(css).toMatch(/\.notice-region__band \{[^}]*height: calc\(var\(--notice-tallest-h\) \+ var\(--notice-gap\)\)/);
    expect(css).toMatch(/\.notice-region__slot > \[data-notice-waiting\] \{\s*display: none !important;/);
  });
});

describe('GM r13 (2): a waiting notice is never lost', () => {
  it('its hold doesn\'t run while it waits, and a full hold starts when it shows again', async () => {
    vi.useFakeTimers();
    const dismissed = vi.fn();
    const notice = { id: 1, text: 'Couldn’t save the board. Nebula didn’t respond. Try again.' };
    function Held() {
      const isShown = useCallback(() => true, []);
      const dismiss = useCallback(() => dismissed(), []);
      const hold = useNoticeHold(notice, isShown, dismiss, 'message');
      return <InNoticeRegion slot="message"><div {...hold} data-toast="message">{notice.text}</div></InNoticeRegion>;
    }
    render(<><NoticeRegion screen="home" /><Held /><Toast slot="pin" text="Newer" /></>);
    await act(async () => { await Promise.resolve(); });
    act(() => handles.pin(true));
    await act(async () => { await Promise.resolve(); });
    const release = waiting.holdCappedPopover();
    await act(async () => { await Promise.resolve(); });
    expect(waits('message')).toBe(true);
    const ms = noticeHoldMs(notice.text, null);
    act(() => { vi.advanceTimersByTime(ms * 3); });
    expect(dismissed).not.toHaveBeenCalled();
    act(() => release());
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(ms - 50); });
    expect(dismissed).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('every timed notice in the region holds its timer while it waits', () => {
    const SRC = join(__dirname, '../src');
    for (const file of ['components/projects/ProjectSwitchToast.tsx', 'components/moodboard-studio/BoardUndoToast.tsx',
      'components/asset-trash/AssetTrash.tsx', 'components/projects/ProjectHome.tsx']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(/useSlotWaiting\('[\w-]+'\)/);
    }
    for (const file of ['components/projects/SavePausedNotice.tsx', 'components/canvas/CanvasUndoNotice.tsx',
      'components/canvas/CanvasMessageNotice.tsx', 'components/canvas/CanvasLateNotice.tsx']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(/useNoticeHold\([^)]*, '[\w-]+'\)/);
    }
  });
});

const SRC = join(__dirname, '../src');
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

/** What stops at the band but isn't a popover, with why it doesn't hold the band to one notice. */
const NOT_CAPPED: Record<string, string> = {
  'lib/bottomBar.ts': 'defines floatingBottomLimit',
  'lib/noticeWaiting.ts': 'the rule itself',
  'hooks/useNoticeClearance.ts': 'holds it for every modal that reads the clearance (useCappedPopover in the hook)',
  'lib/presetLibraryPlacement.ts': 'Styles\' placement; PresetLibrary holds it',
  'components/editor/VideoPreview.tsx': 'the editor\'s docked preview, always on screen: it sizes the video above the band, not a popover',
  'components/panels/NodeInspectorPopover.tsx': 'the docked Inspector, open whenever a node is selected (GM\'s floating panels, which a rare second line may overlap at its edge); asked of GM',
  'components/projects/ProjectSizePanel.tsx': 'a floating panel the person keeps open while removing things; asked of GM with the Inspector',
};

describe('GM r13 (2): every capped popover holds the band to one notice', () => {
  it('each file that stops at the band (floatingBottomLimit, the clearance, Styles\' placement) holds it while open', () => {
    const missing: string[] = [];
    for (const path of sources()) {
      const file = relative(SRC, path);
      const text = readFileSync(path, 'utf8');
      if (!/\b(?:floatingBottomLimit|useNoticeClearance|presetLibraryPlacement)\(/.test(text)) continue;
      if (file in NOT_CAPPED) continue;
      if (!/\buseCappedPopover\(/.test(text) && !/\buseNoticeClearance\(\)/.test(text)) missing.push(file);
    }
    expect(missing).toEqual([]);
    expect(readFileSync(join(SRC, 'hooks/useNoticeClearance.ts'), 'utf8')).toMatch(/export function useNoticeClearance\(\): CSSProperties \{\s*useCappedPopover\(\);/);
  });

  it('every exception still stops at the band', () => {
    const stale = Object.keys(NOT_CAPPED).filter((file) => !/\b(?:floatingBottomLimit|useNoticeClearance|presetLibraryPlacement|useCappedPopover)\b/
      .test(readFileSync(join(SRC, file), 'utf8')));
    expect(stale).toEqual([]);
  });
});
