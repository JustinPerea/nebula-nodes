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

  it('styles "Not analyzed" with the muted badge rule (the archived one), never the red one', () => {
    const css = readFileSync(join(__dirname, '../../styles/commons.css'), 'utf8');
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector},`);
      return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
    };
    const muted = rule('body.app-slava-restraint .commons-badge--archived');
    expect(muted).toContain('body.app-slava-restraint .commons-badge--not-analyzed');
    expect(muted).toContain('color: var(--sr-ink-faint)');
    expect(rule('body.app-slava-restraint .commons-badge--analysis_failed')).not.toContain('not-analyzed');
  });
});
