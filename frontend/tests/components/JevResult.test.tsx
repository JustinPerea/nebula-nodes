import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../../src/types';
import { JevResultView } from '../../src/components/nodes/JevResult';
import { JevResultDetails } from '../../src/components/panels/JevResultDetails';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { JEV_BOX, JEV_DECIDE, JEV_PICK_BEST, parseJevOutputs, type JevResult } from '../../src/lib/jev';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

type Sample = { name: string; params?: Record<string, unknown>; outputs: Record<string, PortValue> };
const fixture = shared as unknown as {
  decide: Sample[]; pickBest: Sample[]; box: Sample[];
  malformed: (Sample & { definitionId: string })[];
};
const sample = (list: Sample[], name: string) => {
  const found = list.find((s) => s.name.includes(name));
  if (!found) throw new Error(`no fixture sample "${name}"`);
  return found;
};
const parse = (id: string, s: Sample) => parseJevOutputs(id, s.outputs) as JevResult;

afterEach(cleanup);

describe('Jev Decide on the card', () => {
  it('shows a passing yes/no with its meter, question, confidence and model', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    render(<JevResultView result={parse(JEV_DECIDE, s)} params={s.params ?? {}} />);
    const card = screen.getByTestId('jev-result');
    expect(card).toHaveAttribute('data-mode', 'yes_no');
    expect(within(card).getByText('Pass')).toBeInTheDocument();
    expect(within(card).getByText('Yes', { selector: '.jev-result__answer' })).toBeInTheDocument();
    expect(within(card).getByText('Is the product on a plain white background?')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Probability of yes' })).toHaveAttribute('aria-valuenow', '0.93');
    expect(within(card).getByText('86%')).toBeInTheDocument();
    expect(within(card).getByText('jev-1.14.0')).toBeInTheDocument();
    expect(within(card).queryByText('Experimental')).not.toBeInTheDocument();
  });

  it('says Unsure when confidence is under the minimum', () => {
    const s = sample(fixture.decide, 'too close to call');
    render(<JevResultView result={parse(JEV_DECIDE, s)} params={s.params ?? {}} />);
    expect(screen.getByText('Unsure')).toBeInTheDocument();
    expect(screen.getByTestId('jev-result')).toHaveClass('jev-result--unsure');
  });

  it('shows a choice as a bar per option with the winner first', () => {
    const s = sample(fixture.decide, 'choice with a passing option');
    render(<JevResultView result={parse(JEV_DECIDE, s)} params={s.params ?? {}} />);
    const rows = within(screen.getByRole('list', { name: 'Probability of each option' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['Product photo88%', 'Lifestyle shot10%', 'Illustration2%']);
    expect(rows[0]).toHaveClass('jev-result__bar-row--winner');
    expect(screen.getByText('Pass')).toBeInTheDocument();
  });

  it('calls a choice with no passing options "Confident", never "Pass"', () => {
    const s = sample(fixture.decide, 'choice with a passing option');
    render(<JevResultView result={parse(JEV_DECIDE, s)} params={{ ...s.params, pass_when: '' }} />);
    expect(screen.getByText('Confident')).toBeInTheDocument();
    expect(screen.queryByText('Pass')).not.toBeInTheDocument();
  });

  it('shows a score as levels in the saved order, the most likely level as the answer', () => {
    const s = sample(fixture.decide, 'score split between levels');
    const { container } = render(<JevResultView result={parse(JEV_DECIDE, s)} params={s.params ?? {}} />);
    expect(screen.getByRole('meter', { name: 'Score' })).toHaveAttribute('aria-valuenow', '0.715');
    const levels = [...container.querySelectorAll('.jev-result__level')].map((el) => el.getAttribute('title'));
    expect(levels).toEqual(['Off brief: 0%', 'Partly on brief: 57%', 'On brief: 43%']);
    expect(screen.getByText('Partly on brief', { selector: '.jev-result__answer' })).toBeInTheDocument();
  });

  it('badges a result that judged images as experimental', () => {
    const s = structuredClone(sample(fixture.decide, 'yes/no that passes'));
    s.outputs.report.value = `${s.outputs.report.value}\nImages: 2 (experimental)`;
    render(<JevResultView result={parse(JEV_DECIDE, s)} params={{}} />);
    expect(screen.getByText('Experimental')).toBeInTheDocument();
  });
});

describe('Jev Pick Best on the card', () => {
  const candidates = ['/api/outputs/run-7/candidate-a.png', '/api/outputs/run-7/candidate-b.png', '/api/outputs/run-7/candidate-c.png'];

  it('shows each candidate with its share and highlights the winner', () => {
    const s = sample(fixture.pickBest, 'a clear winner');
    render(<JevResultView result={parse(JEV_PICK_BEST, s)} params={{}} inputs={{ candidates }} />);
    expect(screen.getByText('Best of 3')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Probability of each candidate' })).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Candidate 1: 8%', 'Candidate 2: 87%, winner', 'Candidate 3: 5%']);
    expect(items[1]).toHaveClass('jev-result__candidate--winner');
    expect(items[1].querySelector('img')).toHaveAttribute('src', expect.stringContaining('candidate-b.png'));
    expect(screen.getByAltText('Winner, candidate 2')).toBeInTheDocument();
    expect(screen.queryByText(/any of them would do/)).not.toBeInTheDocument();
  });

  it('flags a close call when confidence is under the minimum', () => {
    const s = sample(fixture.pickBest, 'any would do');
    render(<JevResultView result={parse(JEV_PICK_BEST, s)} params={{ min_confidence: 0.5 }} />);
    expect(screen.getByText('Close call')).toBeInTheDocument();
    expect(screen.getByText(/any of them would do/)).toBeInTheDocument();
  });

  it('drops the thumbnails when the wired candidates no longer match the result', () => {
    const s = sample(fixture.pickBest, 'a clear winner');
    const { container } = render(
      <JevResultView result={parse(JEV_PICK_BEST, s)} params={{}} inputs={{ candidates: [candidates[1], candidates[2], candidates[0]] }} />,
    );
    expect(container.querySelectorAll('img.jev-result__thumb')).toHaveLength(0);
    expect(screen.getByText('#2', { selector: '.jev-result__thumb--empty' })).toBeInTheDocument();
  });
});

describe('Jev Box on the card', () => {
  it('draws the found box over the searched image with its confidence', () => {
    const s = sample(fixture.box, 'found with a confident box');
    const { container } = render(<JevResultView result={parse(JEV_BOX, s)} params={{}} inputs={{ image: '/api/outputs/run-8/original.png' }} />);
    expect(screen.getByText('Found')).toBeInTheDocument();
    expect(screen.getByAltText('Searched for the coffee mug')).toHaveAttribute('src', expect.stringContaining('original.png'));
    const frame = container.querySelector('.jev-result__frame') as SVGElement;
    expect(frame.style.left).toBe('44%');
    expect(frame.style.top).toBe('25%');
    expect(screen.getByText('92%', { selector: '.jev-result__box-label' })).toBeInTheDocument();
    expect(container.querySelector('.jev-result__stage')).toHaveStyle({ aspectRatio: '1024 / 768' });
  });

  it('says so when TypeSafe reported no box confidence, never 0%', () => {
    const s = sample(fixture.box, 'not reported');
    render(<JevResultView result={parse(JEV_BOX, s)} params={{}} inputs={{ image: '/api/outputs/x.png' }} />);
    expect(screen.getByText('No confidence reported')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('keeps the unsure guess on screen with a hint', () => {
    const s = sample(fixture.box, 'unsure keeps the guess');
    const { container } = render(<JevResultView result={parse(JEV_BOX, s)} params={{}} inputs={{ image: '/api/outputs/x.png' }} />);
    expect(screen.getByText('Unsure')).toBeInTheDocument();
    expect(container.querySelector('.jev-result__frame')).not.toBeNull();
    expect(screen.getByText(/best guess/)).toBeInTheDocument();
  });

  it('shows a clear Not found state, with or without the image', () => {
    const s = sample(fixture.box, 'not found');
    const { container, unmount } = render(<JevResultView result={parse(JEV_BOX, s)} params={{}} inputs={{ image: '/api/outputs/x.png' }} />);
    expect(screen.getAllByText('Not found')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('a red umbrella');
    expect(container.querySelector('.jev-result__frame')).toBeNull();
    unmount();
    render(<JevResultView result={parse(JEV_BOX, s)} params={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not found');
  });

  it('falls back to the annotated image when no original is wired', () => {
    const s = sample(fixture.box, 'found with a confident box');
    const { container } = render(<JevResultView result={parse(JEV_BOX, s)} params={{}} />);
    expect(container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('annotated.png'));
    expect(container.querySelector('.jev-result__frame')).toBeNull();
  });
});

describe('Jev result in the Inspector', () => {
  it('lists every probability and the facts of the run', () => {
    const s = sample(fixture.decide, 'a moving alias');
    render(<JevResultDetails result={parse(JEV_DECIDE, s)} params={s.params ?? {}} />);
    const table = screen.getByRole('table', { name: 'Probabilities' });
    expect(within(table).getAllByRole('row').map((row) => row.textContent)).toEqual(['AnswerProbability', 'yes0.95', 'no0.05']);
    const details = screen.getByTestId('jev-details');
    expect(within(details).getByText('jev-1.13.0')).toBeInTheDocument();
    expect(within(details).getByText('jev-latest')).toBeInTheDocument();
    expect(within(details).getByText('296')).toBeInTheDocument();
    expect(within(details).getByText('≈ $0.000012')).toBeInTheDocument();
  });

  it('names Pick Best rows by candidate and shows the report notes', () => {
    const s = sample(fixture.pickBest, 'any would do');
    render(<JevResultDetails result={parse(JEV_PICK_BEST, s)} params={{}} />);
    expect(screen.getByText('Close call')).toBeInTheDocument();
    expect(screen.getAllByText('Candidate 1')).toHaveLength(2);
    expect(screen.getByText(/the candidates are close/)).toBeInTheDocument();
  });

  it('shows a Box with no confidence as not reported, and Not found without a table', () => {
    render(<JevResultDetails result={parse(JEV_BOX, sample(fixture.box, 'not reported'))} params={{}} />);
    expect(screen.getByText('not reported')).toBeInTheDocument();
    expect(screen.getByText('411 × 438 px')).toBeInTheDocument();
    cleanup();
    render(<JevResultDetails result={parse(JEV_BOX, sample(fixture.box, 'not found'))} params={{}} />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Jev results inside ModelNode', () => {
  function node(id: string, definitionId: string, outputs: Record<string, PortValue>, params: Record<string, unknown> = {}): Node<NodeData> {
    return { id, type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId, label: id, params, state: 'complete', outputs } };
  }
  const props = (value: Node<NodeData>) => ({ id: value.id, data: value.data, selected: false }) as NodeProps;

  beforeEach(() => {
    useGraphStore.setState({ nodes: [], edges: [], isExecuting: false });
    useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
  });

  it('replaces the generic text preview with the verdict card', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    const { container } = render(<ModelNode {...props(node('n1', JEV_DECIDE, s.outputs, s.params))} />);
    expect(screen.getByTestId('jev-result')).toBeInTheDocument();
    expect(container.querySelector('.model-node__preview-text')).toBeNull();
    expect(container.querySelector('.model-node')).toHaveClass('model-node--jev-surface');
  });

  it.each(fixture.malformed.filter((s) => s.definitionId === JEV_DECIDE).map((s) => [s.name, s] as const))(
    'falls back to the generic preview for a malformed result: %s',
    (_name, s) => {
      const { container } = render(<ModelNode {...props(node('n1', s.definitionId, s.outputs))} />);
      expect(screen.queryByTestId('jev-result')).not.toBeInTheDocument();
      expect(container.querySelector('.model-node__preview-text')).toHaveTextContent('yes');
    },
  );

  it('reads Pick Best candidates from the wired nodes, in edge order', () => {
    // The definition lands with the Pick Best node; borrow a stand-in if it isn't here yet.
    const added = !NODE_DEFINITIONS[JEV_PICK_BEST];
    if (added) {
      NODE_DEFINITIONS[JEV_PICK_BEST] = { ...NODE_DEFINITIONS[JEV_DECIDE], id: JEV_PICK_BEST, inputPorts: [], outputPorts: [] };
    }
    try {
      const s = sample(fixture.pickBest, 'a clear winner');
      const urls = ['/api/outputs/a.png', '/api/outputs/run-7/candidate-b.png', '/api/outputs/c.png'];
      const sources = urls.map((url, i) => node(`g${i}`, 'gpt-image-2-generate', { image: { type: 'Image', value: url } }));
      const pickNode = node('p1', JEV_PICK_BEST, s.outputs);
      useGraphStore.setState({
        nodes: [...sources, pickNode],
        edges: sources.map((src, i) => ({ id: `e${i}`, source: src.id, sourceHandle: 'image', target: 'p1', targetHandle: 'candidates' })),
      });
      const { container } = render(<ModelNode {...props(pickNode)} />);
      const thumbs = [...container.querySelectorAll('img.jev-result__thumb')].map((img) => img.getAttribute('src'));
      expect(thumbs).toEqual(urls.map((url) => expect.stringContaining(url)));
      expect(container.querySelector('.model-node--image-surface')).toBeNull();
    } finally {
      if (added) delete NODE_DEFINITIONS[JEV_PICK_BEST];
    }
  });

  it('renders nothing extra for a node that has not run', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    render(<ModelNode {...props({ ...node('n1', JEV_DECIDE, s.outputs), data: { ...node('n1', JEV_DECIDE, s.outputs).data, state: 'executing' } })} />);
    expect(screen.queryByTestId('jev-result')).not.toBeInTheDocument();
  });
});
