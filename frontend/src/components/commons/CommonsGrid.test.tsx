import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SearchRow } from '../../lib/commonsTypes';

vi.mock('../../lib/commonsApi', () => ({ commonsApi: { blob: () => new Promise(() => {}) } }));

const { CommonsGrid } = await import('./CommonsGrid');

const row = (id: string): SearchRow => ({
  id, membership_id: `mem_${id}`, collection_id: 'col_1', collection: 'Open refs', summary: `Reference ${id}`,
  role: 'neutral', media: 'image', made_by: 'unknown', analysis_state: 'ready', in_inbox: false, comment_count: 0,
  matched: [], score: 1, blob_key: `${id}.png`, also_in: [],
});

describe('CommonsGrid', () => {
  it('marks the references an agent proposes to change', () => {
    render(<CommonsGrid rows={[row('ast_1'), row('ast_2')]} selectedId={null} loading={false} emptyHint=""
      onOpen={() => {}} onDropFiles={() => {}} proposed={new Set(['ast_2'])} />);
    const [first, second] = screen.getAllByRole('option');
    expect(first.querySelector('.commons-badge--proposal')).toBeNull();
    expect(second.querySelector('.commons-badge--proposal')?.textContent).toBe('proposal');
    expect(second.querySelector('.commons-badge--proposal')?.getAttribute('aria-label')).toBe('An agent proposes changes');
  });
});
