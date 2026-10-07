import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySkinBodyClass, DEFAULT_SKIN, loadSkin } from '../../src/lib/skins';

describe('skins', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.className = '';
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses Slava Restraint as the fresh-session default', () => {
    expect(DEFAULT_SKIN).toBe('slava-restraint');
    expect(loadSkin()).toBe('slava-restraint');
    expect(window.localStorage.getItem('nebula:skin')).toBe('slava-restraint');
  });

  it.each(['default', 'hermes', 'slava-wayfinding', 'slava-restraint', 'unknown', ''])(
    'normalizes the saved appearance %j to Slava Restraint', (savedSkin) => {
      window.localStorage.setItem('nebula:skin', savedSkin);
      window.localStorage.setItem('nebula:hermes-tone', 'obsidian');

      expect(loadSkin()).toBe('slava-restraint');
      expect(window.localStorage.getItem('nebula:skin')).toBe('slava-restraint');
      expect(window.localStorage.getItem('nebula:hermes-tone')).toBeNull();
    },
  );

  it('still applies the supported appearance when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is disabled', 'SecurityError');
    });
    expect(loadSkin()).toBe('slava-restraint');
    expect(() => applySkinBodyClass()).not.toThrow();
    expect(document.body.className).toBe('app-slava-restraint');
  });

  it('migrates pre-registry Hermes preferences without restoring Hermes', () => {
    window.localStorage.setItem('nebula:hermes-tone', 'classic');
    expect(loadSkin()).toBe('slava-restraint');
    expect(window.localStorage.getItem('nebula:hermes-tone')).toBeNull();
  });

  it('clears obsolete theme and transition classes while preserving unrelated state', () => {
    document.body.className = 'app-hermes app-slava-wayfinding tone-verdant tone-obsidian chat-bloom-active app-skin-switching-slava unrelated';
    applySkinBodyClass();
    applySkinBodyClass();
    expect([...document.body.classList]).toEqual(['unrelated', 'app-slava-restraint']);
  });
});
