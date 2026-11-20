import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProjectCounts } from '../src/components/projects/projectFacts';

describe('a project card\'s counts', () => {
  it('keeps each count whole and breaks before the dot', () => {
    const { container } = render(<ProjectCounts project={{ nodeCount: 0, edgeCount: 2 }} />);
    expect(container.textContent).toBe('0 nodes · 2 connections');
  });
  it('says "1 node" and "1 connection" for one', () => {
    const { container } = render(<ProjectCounts project={{ nodeCount: 1, edgeCount: 1 }} />);
    expect(container.textContent).toBe('1 node · 1 connection');
  });
});
