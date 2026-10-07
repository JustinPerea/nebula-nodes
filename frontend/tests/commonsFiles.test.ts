import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFiles, saveBlob } from '../src/lib/commonsFiles';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Commons browser files', () => {
  it('returns only selected files and removes the temporary picker', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const pending = pickFiles({ multiple: true, accept: 'image/*,video/*' });
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('image/*,video/*');
    expect(input.multiple).toBe(true);
    const file = new File(['fixture'], 'reference.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(await pending).toEqual([file]);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
  it('resolves a canceled browser picker without files', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const pending = pickFiles();
    document.querySelector('input[type=file]')!.dispatchEvent(new Event('cancel'));
    expect(await pending).toEqual([]);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
  it('starts an export download and defers object URL cleanup', async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:commons-export');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('commons-fixture.zip');
      expect(this.href).toBe('blob:commons-export');
    });
    const blob = new Blob(['synthetic zip']);
    await saveBlob(blob, 'commons-fixture.zip');
    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(revoke).toHaveBeenCalledWith('blob:commons-export');
  });
  it('surfaces a failed download attempt and still releases the URL', async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:commons-export');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('download unavailable'); });
    await expect(saveBlob(new Blob(['fixture']), 'commons-fixture.zip')).rejects.toThrow('download unavailable');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
