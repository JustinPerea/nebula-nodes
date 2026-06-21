import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldNotifyFor,
  getNotificationPrefs,
  setNotificationPrefs,
  LONG_JOB_THRESHOLD_SEC,
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
