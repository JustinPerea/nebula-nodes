import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PlaceholderLine } from '../src/components/nodes/PlaceholderLine';

// GM - Design, 2026-10-25: "Dim only the preview area; header and text stay
// at full contrast. A line in the preview area: “Codex is setting this up.”"

afterEach(cleanup);

describe('PlaceholderLine', () => {
  it("says whose placeholder the node is, in the agent's colour", () => {
    const { container } = render(<PlaceholderLine pending={{ agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false }, at: 1 }} />);
    const line = container.querySelector<HTMLElement>('.model-node__pending')!;
    expect(line.textContent).toBe('Codex is setting this up.');
    expect(line.style.getPropertyValue('--pending-color')).toBe('#F2C14E');
  });

  it('draws nothing for a normal node or a malformed flag', () => {
    expect(render(<PlaceholderLine pending={undefined} />).container.innerHTML).toBe('');
    expect(render(<PlaceholderLine pending={{ agent: 'Codex' }} />).container.innerHTML).toBe('');
  });
});
