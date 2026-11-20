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
  it('groups a large count by the locale: "1,248 nodes" and "3,102 connections"', () => {
    const { container } = render(<ProjectCounts project={{ nodeCount: 1248, edgeCount: 3102 }} />);
    expect(container.textContent?.replace(/\u00a0/g, ' ')).toBe('1,248 nodes · 3,102 connections');
  });
});
