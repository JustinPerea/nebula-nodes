import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // GM r6 on #208, item 2: a too-transparent reference isn't a failure, so its
  // tile says "Not analyzed" in the neutral, muted badge; other failures stay red "failed".
  it('gives a too-transparent reference the muted "Not analyzed" badge, not "failed"', () => {
    const clear = { ...row('ast_1'), analysis_state: 'analysis_failed' as const, last_error_kind: 'transparent' };
    const broken = { ...row('ast_2'), analysis_state: 'analysis_failed' as const, last_error_kind: 'unavailable' };
    const older = { ...row('ast_3'), analysis_state: 'analysis_failed' as const };
    render(<CommonsGrid rows={[clear, broken, older]} selectedId={null} loading={false} emptyHint=""
      onOpen={() => {}} onDropFiles={() => {}} />);
    const [first, second, third] = screen.getAllByRole('option');
    const badge = (tile: HTMLElement) => tile.querySelector('.commons-tile__badges .commons-badge')!;
    expect(badge(first).className).toBe('commons-badge commons-badge--not-analyzed');
    expect(badge(first).textContent).toBe('Not analyzed');
    expect(first.querySelector('.commons-badge--analysis_failed')).toBeNull();
    expect(badge(second).className).toBe('commons-badge commons-badge--analysis_failed');
    expect(badge(second).textContent).toBe('failed');
    expect(badge(third).className).toBe('commons-badge commons-badge--analysis_failed');
  });

  // GM r10 on #208 (review 4, M2): the plain neutral badge colour, readable
  // (--sr-ink-light, about 5.7:1), set in one rule of its own: not the faint
  // archived tone (1.9:1), not QUEUED's tint, never the red one.
  it('colours "Not analyzed" in one rule of its own, the plain neutral badge colour', () => {
    const css = readFileSync(join(__dirname, '../../styles/commons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
      selectors: selectors.split(',').map((selector) => selector.trim()),
      body,
    }));
    const naming = rules.filter((rule) => rule.selectors.some((selector) => selector.includes('commons-badge--not-analyzed')));
    expect(naming).toHaveLength(1);
    expect(naming[0].selectors).toEqual(['body.app-slava-restraint .commons-badge--not-analyzed']);
    expect(naming[0].body.trim()).toBe('color: var(--sr-ink-light);');
  });

  // #208 review 4, N2: Chrome reads the badge's CSS capitals into the tile's
  // name ("NOT ANALYZED Lane refs"); the tile names itself with the words as written.
  it('names each tile by its caption, then its badges as written', () => {
    const clear = { ...row('ast_1'), summary: null, collection: 'Lane refs', analysis_state: 'analysis_failed' as const,
      last_error_kind: 'transparent' };
    const busy = { ...row('ast_2'), analysis_state: 'queued' as const, in_inbox: true, comment_count: 2,
      media: 'video' as const };
    render(<CommonsGrid rows={[clear, busy, row('ast_3')]} selectedId={null} loading={false} emptyHint=""
      onOpen={() => {}} onDropFiles={() => {}} proposed={new Set(['ast_2'])} />);
    expect(screen.getByRole('option', { name: 'Lane refs, Not analyzed' })).toBeTruthy();
    expect(screen.getByRole('option', {
      name: 'Reference ast_2, queued, inbox, An agent proposes changes, video, 2 comments',
    })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Reference ast_3' })).toBeTruthy();
    // What shows is unchanged: the badges' own words.
    const tile = screen.getByRole('option', { name: 'Lane refs, Not analyzed' });
    expect(tile.querySelector('.commons-badge--not-analyzed')?.textContent).toBe('Not analyzed');
  });
});
