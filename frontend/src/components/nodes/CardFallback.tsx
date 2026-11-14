import { memo, useEffect, useReducer, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import { CARD_CHUNK_BY_TYPE } from '../../lib/cardChunks';
import { fallbackSize, heldCardOf, type HeldCard } from '../../lib/cardFallback';
import { handleIds } from '../../lib/cardHandleIds';
import { QuietIcon } from './NodeCardBoundary';
import { NodeTypeIcon } from './NodeTypeIcon';
import '../../styles/node-card-boundary.css';
import '../../styles/card-fallback.css';

/** The line under a card whose chunk could not be fetched, offline (GM - Design, 2026-11-14). */
export const FALLBACK_LINE_OFFLINE = 'Nebula couldn’t load this node because you’re offline. It’ll try again when you’re back online.';
/** The same, online. */
export const FALLBACK_LINE_ONLINE = 'Nebula couldn’t load this node because part of the app didn’t download. Reload the page to try again.';

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

interface FrameProps {
  data: Record<string, unknown>;
  held: HeldCard | null;
  selected?: boolean;
  /** The line under the title; none for a card that is still loading. */
  line?: string | null;
  /** A frame fading out over the real card that replaced it: no handles, no pointer. */
  ghost?: boolean;
}

/** The frame: the card's size, its name as the title, and its ports spread down the sides. */
export function CardFallbackFrame({ data, held, selected, line, ghost }: FrameProps) {
  const label = typeof data.label === 'string' && data.label ? data.label : null;
  const definition = typeof data.definitionId === 'string' ? NODE_DEFINITIONS[data.definitionId] : undefined;
  let ports: { inputs: string[]; outputs: string[] } = { inputs: [], outputs: [] };
  try { ports = handleIds(data); } catch { /* a frame with no handles is still the node */ }
  const size = fallbackSize(held);
  const style = {
    width: size.width,
    minHeight: size.height,
    ['--node-category-color' as string]: (definition && CATEGORY_COLORS[definition.category]) ?? '#424242',
  } as CSSProperties;
  const spread = (ids: string[], type: 'target' | 'source') => ids.map((id, index) => (
    <Handle key={`${type}-${id}`} type={type} position={type === 'target' ? Position.Left : Position.Right} id={id}
      className="node-card-boundary__handle card-fallback__handle"
      style={{ top: `${((index + 1) / (ids.length + 1)) * 100}%` }} />
  ));
  return (
    <div className={`node-card-boundary card-fallback${selected ? ' node-card-boundary--selected' : ''}${ghost ? ' card-fallback--ghost' : ''}`}
      style={style} data-card-fallback={ghost ? 'ghost' : ''} aria-hidden={ghost || undefined}>
      {ghost ? null : spread(ports.inputs, 'target')}
      <div className="node-card-boundary__header">
        {definition ? <QuietIcon><NodeTypeIcon definition={definition} /></QuietIcon> : null}
        <span className="node-card-boundary__label">{label ?? definition?.displayName ?? 'Node'}</span>
      </div>
      {line ? <p className="node-card-boundary__line card-fallback__line">{line}</p> : null}
      {ghost ? null : spread(ports.outputs, 'source')}
    </div>
  );
}

/**
 * A node's card while its chunk is loading (a node added to a canvas that is
 * already on screen) or after it failed to load (lib/cardFallback.ts). The
 * frame draws at once with the node's name and ports, so its wires attach and
 * the person sees the node they added. A failed chunk adds one line in the
 * card's own text colour, worded for being offline or not; the chunk tries
 * again when the window regains focus and when the browser is back online
 * (the DeferredBoundary triggers, which this card takes over because the real
 * card is not mounted). The real card replaces the frame when the chunk
 * arrives (lib/cardHold.ts, components/nodes/withCardSwap.tsx).
 */
function CardFallbackCard({ data, selected }: NodeProps) {
  const held = heldCardOf(data);
  const chunk = held?.type ? CARD_CHUNK_BY_TYPE[held.type] : undefined;
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const failed = chunk !== undefined && chunk.failures() > 0 && !chunk.isLoaded();
  useEffect(() => {
    if (!chunk) return undefined;
    const offSettle = chunk.onSettle(rerender);
    const onOffline = () => rerender();
    const onOnline = () => { rerender(); if (chunk.failures() > 0 && !chunk.isLoaded()) void chunk.retry('online').catch(() => {}); };
    const onFocus = () => { if (chunk.failures() > 0 && !chunk.isLoaded()) void chunk.retry('focus').catch(() => {}); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onFocus);
    // Mounting onto an old failure is an intent to load it (not while offline).
    if (chunk.failures() > 0 && !chunk.isLoaded()) void chunk.retry('mount').catch(() => {});
    return () => {
      offSettle();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
    };
  }, [chunk]);
  return (
    <CardFallbackFrame data={(data ?? {}) as Record<string, unknown>} held={held} selected={selected}
      line={failed ? (isOffline() ? FALLBACK_LINE_OFFLINE : FALLBACK_LINE_ONLINE) : null} />
  );
}

export const CardFallback = memo(CardFallbackCard);
