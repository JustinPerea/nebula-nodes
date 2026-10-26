import { describe, expect, it } from 'vitest';
import { backendAssetUrlSync } from './backend';
import { storedImageView } from './storedImage';

// A Style's or Character's image is drawn only when it is one of Nebula's own
// files; anything else gets the placeholder, and an outside link says so
// (backend services/stored_image_refs.py refuses new ones).
describe('storedImageView', () => {
  it.each([
    '/api/outputs/chat-uploads/a.png',
    '/api/presets/thumbnails/cinematic-noir',
    'http://127.0.0.1:8000/api/outputs/chat-uploads/a.png',
    'http://localhost:8123/api/outputs/run/b.png',
    'http://127.0.0.2:8000/api/outputs/run/b.png',
  ])('draws Nebula’s own file %s through the backend', (value) => {
    const path = value.startsWith('/') ? value : new URL(value).pathname;
    expect(storedImageView(value)).toEqual({ src: backendAssetUrlSync(path), outside: false });
  });

  it('draws an upload’s file path from the output folder as its served URL', () => {
    expect(storedImageView('/Users/me/nebula/output/chat-uploads/a.png'))
      .toEqual({ src: backendAssetUrlSync('/api/outputs/chat-uploads/a.png'), outside: false });
  });

  it.each([
    'https://images.example.com/face.png',
    'http://192.168.1.20/a.png',
    '//images.example.com/a.png',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:https://example.com/123',
    'http://localhost:8000/api/moodboards/x',
    'https://evil.example/api/outputs/a.png',
    // Read as a browser reads them, as the backend's is_outside_link does
    // (backslashes are slashes, tabs and newlines dropped): protocol-relative.
    '/\\images.example.com/a.png',
    '\\\\images.example.com/a.png',
    '/\t/images.example.com/a.png',
    '/\n/images.example.com/a.png',
  ])('never draws %s and calls it an outside link', (value) => {
    expect(storedImageView(value)).toEqual({ src: null, outside: true });
  });

  it.each(['', '   ', null, undefined, 42])('draws nothing for an empty value (%s)', (value) => {
    expect(storedImageView(value)).toEqual({ src: null, outside: false });
  });

  it('still draws a Windows upload path from the output folder', () => {
    expect(storedImageView('C:\\Users\\me\\nebula\\output\\chat-uploads\\a.png'))
      .toEqual({ src: backendAssetUrlSync('/api/outputs/chat-uploads/a.png'), outside: false });
  });

  it('draws nothing for a local path it can’t serve, without calling it outside', () => {
    expect(storedImageView('/Users/me/Desktop/face.png')).toEqual({ src: null, outside: false });
  });
});
