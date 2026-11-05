import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MoodboardImage } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import { overviewThumbnailUrl } from '../../lib/canvasOverview';
import { storedImageView } from '../../lib/storedImage';
import { FailureLines } from '../failure/FailureLines';
import { AssetProposalStrip } from '../proposals/AssetProposalStrip';
import {
  LOCKED_NO_IMAGES, READ_AGAIN, READ_BUTTON, READING_FAILED_HEADING, READING_HEADING, READING_INTRO, citationMap, copyText,
  elapsed, failureBody, metaLine, routeLine, runningLine, staleLine, staleness, type BoardReadingRun, type Citation,
} from '../../lib/boardReading';
import { parseMarkdown, type Block, type Inline } from '../../lib/readingMarkdown';
import { useBoardReading, useBoardReadingStore } from '../../store/boardReadingStore';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import '../../styles/board-reading.css';

/**
 * Read the board's pane (GM's surface design, 2026-10-31): the Reading part
 * of the Board view's side panel, and the List view's Reading section after
 * Direction. Before the first read, the intro and Read the board; while a
 * read runs, Stop and "Reading 15 images · 0:42"; then the report, Gemini's
 * own markdown with each cited image as a #N chip. Loaded on demand with the
 * markdown reader (lib/readingMarkdown.ts), never in the first load.
 */
export default function BoardReadingPane({ boardId, boardKey, images, selectedImageIds, onShowImage }: {
  /** The saved board (null for a new draft, which can't be read yet). */
  boardId: string | null;
  boardKey: string;
  /** The board as the Studio holds it now, in board order (#N is its place + 1). */
  images: MoodboardImage[];
  /** Images whose tile is selected: their chips take the selected style. */
  selectedImageIds: readonly string[];
  /** A chip clicked: select the tile (Board) or scroll to its row (List). */
  onShowImage: (imageId: string) => void;
}) {
  const headingId = useId();
  const entry = useBoardReading(boardId);
  const start = useBoardReadingStore((state) => state.start);
  const stop = useBoardReadingStore((state) => state.stop);
  const state = entry.state;
  const reading = state?.reading ?? null;
  const run = state?.run ?? null;
  const running = run?.status === 'running';
  const failed = run?.status === 'failed' && (!reading || run.readingId !== reading.id) ? run : null;
  const route = state?.route ?? null;
  const line = route ? routeLine(route) : null;
  const locked = !boardId || !line || line.locked;
  const stale = useMemo(() => (reading ? staleness(reading, images, state?.stale?.replaced ?? []) : null),
    [reading, images, state?.stale?.replaced]);
  const busy = entry.busy !== null;
  // A chip hovered when the pane goes (a tab switch, a board switch) leaves no ring behind.
  useEffect(() => () => useBoardCanvasStore.getState().setCiteHover(null), [boardKey]);

  const readButton = (label: string) => (
    <button type="button" className="board-reading__button board-reading__button--primary"
      disabled={locked || busy} onClick={() => { if (boardId) void start(boardId); }}>{label}</button>
  );

  return (
    <section className="board-reading" aria-labelledby={headingId} data-board-reading={boardId ?? ''}>
      <h3 id={headingId} className="board-reading__heading">{READING_HEADING}</h3>
      {!reading && !running && <p className="board-reading__intro">{READING_INTRO}</p>}

      <div className="board-reading__actions">
        {running ? (
          <button type="button" className="board-reading__button" disabled={busy}
            onClick={() => { if (boardId) void stop(boardId); }}>Stop</button>
        ) : readButton(reading ? READ_AGAIN : READ_BUTTON)}
        {reading && !running && <CopyButton text={() => copyText(reading, images)} />}
      </div>
      {!running && (
        <p className={`board-reading__route${line?.locked || !boardId ? ' board-reading__route--locked' : ''}`}>
          {!boardId ? LOCKED_NO_IMAGES : line?.text ?? ''}
        </p>
      )}
      {running && run && <RunningLine run={run} at={entry.runAt} />}
      {entry.loadError && <p className="board-reading__error" role="alert"><FailureLines failure={entry.loadError} /></p>}
      {entry.actionError && <p className="board-reading__error" role="alert"><FailureLines failure={entry.actionError} /></p>}
      {failed && !running && (
        <Failure run={failed} canUseKey={Boolean(route?.hasKey)} busy={busy}
          onUseKey={() => { if (boardId) void start(boardId, 'gemini_key'); }} />
      )}
      {boardId && <AssetProposalStrip kind="moodboard" targetId={boardId} reads />}

      {reading && (
        <div className="board-reading__report">
          {stale?.stale && !running && (
            <p className="board-reading__stale">
              <span>{staleLine(stale)}</span>{' '}
              <button type="button" className="board-reading__link" disabled={locked || busy}
                onClick={() => { if (boardId) void start(boardId); }}>{READ_AGAIN}</button>
            </p>
          )}
          <p className="board-reading__meta">{metaLine(reading)}</p>
          <p className="board-reading__label">Gemini</p>
          <ReadingBody markdown={reading.markdown} citations={citationMap(reading, images)} boardKey={boardKey}
            images={images} selected={selectedImageIds} onShowImage={onShowImage} />
        </div>
      )}
    </section>
  );
}

/** "Reading 15 images · 0:42", the time in mono, ticking each second. */
function RunningLine({ run, at }: { run: BoardReadingRun; at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="board-reading__running" role="status">
      {runningLine(run.count)}<span className="board-reading__time">{elapsed(run.elapsedMs + Math.max(0, now - at))}</span>
    </p>
  );
}

function Failure({ run, canUseKey, busy, onUseKey }: { run: BoardReadingRun; canUseKey: boolean; busy: boolean;
  onUseKey: () => void }) {
  return (
    <div className="board-reading__failure" role="alert">
      <p className="board-reading__failure-heading">{READING_FAILED_HEADING}</p>
      <p className="board-reading__failure-body">{failureBody(run.cause)}</p>
      {run.cause === 'plan_limit' && canUseKey && (
        <button type="button" className="board-reading__button" disabled={busy} onClick={onUseKey}>Use API key</button>
      )}
    </div>
  );
}

const COPIED_MS = 1600;

function CopyButton({ text }: { text: () => string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <button type="button" className="board-reading__button" onClick={() => {
      void navigator.clipboard?.writeText(text()).then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      }).catch(() => undefined);
    }}>{copied ? 'Copied' : 'Copy'}</button>
  );
}

interface BodyProps {
  citations: Map<string, Citation>;
  boardKey: string;
  images: MoodboardImage[];
  selected: readonly string[];
  onShowImage: (imageId: string) => void;
}

/** Gemini's markdown as React elements: never HTML, never a link out, never an image. */
function ReadingBody({ markdown, ...props }: BodyProps & { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return <div className="board-reading__body">{blocks.map((block, index) => <BlockView key={index} block={block} {...props} />)}</div>;
}

function BlockView({ block, ...props }: BodyProps & { block: Block }) {
  if (block.t === 'rule') return <hr className="board-reading__rule" />;
  if (block.t === 'heading') return <h3 className="board-reading__h">{inlines(block.c, props)}</h3>;
  if (block.t === 'list') {
    const items = block.items.map((item, index) => <li key={index}>{inlines(item, props)}</li>);
    return block.ordered ? <ol className="board-reading__list">{items}</ol> : <ul className="board-reading__list">{items}</ul>;
  }
  return <p className="board-reading__p">{inlines(block.c, props)}</p>;
}

function inlines(pieces: Inline[], props: BodyProps): ReactNode[] {
  return pieces.map((piece, index) => {
    switch (piece.t) {
      case 'text': return piece.v;
      case 'strong': return <strong key={index}>{inlines(piece.c, props)}</strong>;
      case 'em': return <em key={index}>{inlines(piece.c, props)}</em>;
      case 'code': return <code key={index} className="board-reading__code">{piece.v}</code>;
      case 'cite': {
        const cite = props.citations.get(piece.file);
        // A file name the board never sent stays plain text (GM section 3).
        if (!cite) return piece.raw;
        return <Chip key={index} cite={cite} {...props} />;
      }
      default: return null;
    }
  });
}

function Chip({ cite, boardKey, images, selected, onShowImage }: BodyProps & { cite: Citation }) {
  const setCiteHover = useBoardCanvasStore((state) => state.setCiteHover);
  if (!cite.onBoard) {
    return (
      <span className="board-reading__chip board-reading__chip--removed" role="img"
        aria-label={`#${cite.number}, removed from the board`}>#{cite.number}</span>
    );
  }
  const image = images.find((item) => item.id === cite.imageId);
  const view = storedImageView(image?.url ?? cite.url ?? '');
  const thumb = view.src ? backendAssetUrlSync(overviewThumbnailUrl(view.src) ?? view.src) : null;
  const on = () => setCiteHover({ boardKey, imageId: cite.imageId });
  const off = () => {
    const now = useBoardCanvasStore.getState().citeHover;
    if (now?.imageId === cite.imageId) setCiteHover(null);
  };
  const isSelected = selected.includes(cite.imageId);
  return (
    <button type="button" className={`board-reading__chip${isSelected ? ' board-reading__chip--selected' : ''}`}
      aria-label={`#${cite.number}`}
      onPointerEnter={on} onPointerLeave={off} onFocus={on} onBlur={off}
      onClick={() => onShowImage(cite.imageId)}>
      {thumb ? <img className="board-reading__chip-thumb" src={thumb} alt="" draggable={false} />
        : <span className="board-reading__chip-thumb" aria-hidden="true" />}
      #{cite.number}
    </button>
  );
}
