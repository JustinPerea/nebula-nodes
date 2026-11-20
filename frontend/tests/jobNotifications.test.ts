import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  shouldNotifyFor,
  getNotificationPrefs,
  setNotificationPrefs,
  LONG_JOB_THRESHOLD_SEC,
  notifyJobComplete,
} from '../src/lib/jobNotifications';

describe('shouldNotifyFor', () => {
  it('never notifies when disabled', () => {
    expect(shouldNotifyFor({ hidden: true, durationSec: 999, threshold: 30, enabled: false })).toBe(false);
  });

  it('notifies when the tab is hidden (any duration)', () => {
    expect(shouldNotifyFor({ hidden: true, durationSec: 1, threshold: 30, enabled: true })).toBe(true);
  });

  it('notifies for a long job even when the tab is visible', () => {
    expect(shouldNotifyFor({ hidden: false, durationSec: 45, threshold: 30, enabled: true })).toBe(true);
  });

  it('stays quiet for a short job in a visible tab', () => {
    expect(shouldNotifyFor({ hidden: false, durationSec: 2, threshold: 30, enabled: true })).toBe(false);
  });

  it('uses the documented default threshold', () => {
    expect(LONG_JOB_THRESHOLD_SEC).toBe(30);
  });
});

describe('notification prefs persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to disabled', () => {
    expect(getNotificationPrefs()).toEqual({ enabled: false, sound: false });
  });

  it('round-trips through localStorage', () => {
    setNotificationPrefs({ enabled: true, sound: true });
    expect(getNotificationPrefs()).toEqual({ enabled: true, sound: true });
  });

  it('survives corrupt storage', () => {
    window.localStorage.setItem('nebula:notifications', 'not json');
    expect(getNotificationPrefs()).toEqual({ enabled: false, sound: false });
  });
});

describe('favicon dot colour', () => {
  const fills: string[] = [];

  beforeEach(() => {
    fills.length = 0;
    window.localStorage.clear();
    setNotificationPrefs({ enabled: true, sound: false });
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">';
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        crossOrigin = '';
        set src(_value: string) {
          this.onload?.();
        }
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          beginPath: () => undefined,
          arc: () => undefined,
          fill: () => undefined,
          set fillStyle(value: string) {
            fills.push(value);
          },
        }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.removeProperty('--sr-error');
    document.body.style.removeProperty('--sr-success');
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  const done = (ok: boolean) => notifyJobComplete({ ok, durationSec: 60, nodesExecuted: 3 });

  it('paints a failed job with the error token', () => {
    document.body.style.setProperty('--sr-error', '#123456');
    done(false);
    expect(fills).toEqual(['#123456']);
  });

  it('paints a finished job with the success token', () => {
    document.body.style.setProperty('--sr-success', '#654321');
    done(true);
    expect(fills).toEqual(['#654321']);
  });

  it('falls back to the token values when the page defines none', () => {
    done(false);
    done(true);
    expect(fills).toEqual(['#F5C518', 'rgba(110, 231, 183, 0.90)']);
  });
});
