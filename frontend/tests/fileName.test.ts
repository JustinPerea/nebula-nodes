import { describe, expect, it } from 'vitest';
import { inputFileName, middleTruncate } from '../src/lib/fileName';

// GM - Design, drop follow-ups (2026-10-24): a long file name is cut in the
// middle so its extension stays, "quarterly-rep….pdf".

describe('middleTruncate', () => {
  it('leaves a short name as it is', () => {
    expect(middleTruncate('tone.wav', 18)).toBe('tone.wav');
    expect(middleTruncate('exactly-eighteen.a', 18)).toBe('exactly-eighteen.a');
  });

  it("keeps a long name's extension (GM's example)", () => {
    expect(middleTruncate('quarterly-report-final-version-2026.pdf', 18)).toBe('quarterly-rep….pdf');
  });

  it('cuts a name without an extension in the middle, keeping its end', () => {
    const cut = middleTruncate('scan-from-the-office-printer-0042', 18);
    expect(cut).toHaveLength(18);
    expect(cut).toMatch(/^scan-from-th.*….*0042$/);
  });

  it('treats a very long "extension" as part of the name', () => {
    expect(middleTruncate('notes.this-is-not-really-an-extension', 18)).toBe('notes.this-i…nsion');
  });

  it('does not count a leading dot as an extension', () => {
    const cut = middleTruncate('.a-very-long-hidden-config-file-name', 18);
    expect(cut).toHaveLength(18);
    expect(cut.startsWith('.a-very')).toBe(true);
  });

  it('counts characters, not UTF-16 units', () => {
    const cut = middleTruncate('🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵.wav', 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut.endsWith('….wav')).toBe(true);
  });

  it('has a default budget for the card', () => {
    expect(middleTruncate('short.pdf')).toBe('short.pdf');
    const cut = middleTruncate('quarterly-report-final-version-2026.pdf');
    expect(cut.endsWith('….pdf')).toBe(true);
    expect(cut.startsWith('quarterly-report')).toBe(true);
  });
});

describe('inputFileName', () => {
  const file = '/out/chat-uploads/3fa94c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f.pdf';
  const stored = '3fa94c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f.pdf';

  it('reads the name an upload kept for that file', () => {
    expect(inputFileName({ filePath: file, _fileName: { file: stored, name: 'report.pdf' } })).toBe('report.pdf');
  });

  it("ignores a kept name that belongs to another file", () => {
    expect(inputFileName({ filePath: '/elsewhere/talk.pdf', _fileName: { file: stored, name: 'report.pdf' } }))
      .toBe('talk.pdf');
  });

  it("uses the file's own name when it isn't a stored hash", () => {
    expect(inputFileName({ filePath: '/Users/me/Music/interview.wav' })).toBe('interview.wav');
    expect(inputFileName({ filePath: 'C:\\Users\\me\\interview.wav' })).toBe('interview.wav');
  });

  it('has no name for a hashed upload saved before names were kept, or no file', () => {
    expect(inputFileName({ filePath: file })).toBeNull();
    expect(inputFileName({ filePath: '' })).toBeNull();
    expect(inputFileName({})).toBeNull();
  });
});
