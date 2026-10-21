import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));

import { CharacterDefinitionPanel } from './CharacterDefinitionPanel';
import type { CharacterDraft } from './CharacterStudioView';

const OUTSIDE = 'https://images.example.com/face.png';

function draft(views: string[]): CharacterDraft {
  return { name: 'Old hero', subjectType: 'human', referenceViews: views, frozenTraitString: '', seed: 0, consistencyStrength: 0.8 };
}

// A Character saved before Nebula checked its images can hold an outside link.
// The Studio keeps it (the person can remove it) but never loads it.
describe('Character Studio reference views', () => {
  it('draws Nebula’s own views and a placeholder with a note for an outside link', () => {
    const { container } = render(<CharacterDefinitionPanel thumbnail={OUTSIDE} onChange={() => {}}
      draft={draft([OUTSIDE, '/api/outputs/chat-uploads/b.png', '/api/outputs/chat-uploads/c.png'])} />);

    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual(['/api/outputs/chat-uploads/b.png', '/api/outputs/chat-uploads/c.png']);
    // The cover (thumbnail) and view 1 both say why they show no picture.
    expect(screen.getAllByText('Image link from outside Nebula')).toHaveLength(2);
    // Still listed, so the person can remove it.
    expect(screen.getAllByRole('button', { name: 'Remove reference view' })).toHaveLength(3);
  });

  it('draws every view when all are Nebula’s own files', () => {
    const views = ['/api/outputs/chat-uploads/a.png', '/api/outputs/chat-uploads/b.png', '/api/outputs/chat-uploads/c.png'];
    const { container } = render(<CharacterDefinitionPanel thumbnail={views[0]} onChange={() => {}} draft={draft(views)} />);

    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([views[0], ...views]);
    expect(screen.queryByText('Image link from outside Nebula')).toBeNull();
  });
});
