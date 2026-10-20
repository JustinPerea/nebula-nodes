import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

interface ExpandableBlockProps {
  children: ReactNode;
  /** Visible lines while closed (the body's line-height counts one line). */
  lines: number;
  /** Changes when the content does, so the block measures again. */
  contentKey: string;
  /** Whether the content is long enough to need "Read all" where nothing can
   *  be measured (no layout yet, or a test); a measurement overrides it. */
  longHint: boolean;
  /** False draws the content in full, no clamp and no toggle (the Inspector). */
  collapsible?: boolean;
  className?: string;
  /** Tallest the open block grows before it scrolls, in px. */
  openCap?: number;
  /** What the toggle opens ("the brief of Dusk Harbor"), so two cards'
   *  toggles don't both read as a bare "Read all". */
  label?: string;
}

/**
 * Content clamped to a few lines with a "Read all" toggle that opens it in
 * place. Opening and closing ride max-height on the app's sampled spring
 * (styles/structured-preview.css); reduced motion switches at once. Open,
 * the block scrolls inside the card (nowheel) past `openCap`.
 */
export function ExpandableBlock({
  children, lines, contentKey, longHint, collapsible = true, className = '', openCap = 320, label,
}: ExpandableBlockProps) {
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [measured, setMeasured] = useState<{ key: string; overflows: boolean } | null>(null);
  const [openHeight, setOpenHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!collapsible || open || !body || body.clientHeight === 0) return;
    // Against the closed height from the stylesheet, not clientHeight: right
    // after "Show less" the block is still springing shut and as tall as
    // its content, which would read as "fits" and drop the toggle.
    const lineHeight = parseFloat(getComputedStyle(body).getPropertyValue('--expandable-line-height'));
    const closed = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight * lines : body.clientHeight;
    const overflows = body.scrollHeight > closed + 1;
    setMeasured((current) => (current?.key === contentKey && current.overflows === overflows
      ? current : { key: contentKey, overflows }));
  }, [collapsible, contentKey, lines, open]);

  const toggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const body = bodyRef.current;
    if (!open && body) setOpenHeight(body.scrollHeight || null);
    setOpen((value) => !value);
  }, [open]);

  if (!collapsible) {
    return <div className={`structured-expandable structured-expandable--full ${className}`}>{children}</div>;
  }

  const overflows = measured?.key === contentKey ? measured.overflows : longHint;
  const style = {
    '--expandable-lines': lines,
    ...(open && openHeight ? { maxHeight: `${Math.min(openHeight, openCap)}px` } : {}),
    ...(open && !openHeight ? { maxHeight: `${openCap}px` } : {}),
  } as CSSProperties;

  return (
    <div className={`structured-expandable ${open ? 'structured-expandable--open' : ''} ${overflows ? 'structured-expandable--clamped' : ''} ${className}`}>
      <div ref={bodyRef} id={bodyId} className={`structured-expandable__body${open ? ' nodrag nowheel' : ''}`} style={style}>
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="structured-expandable__toggle nodrag"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={label ? `${open ? 'Show less' : 'Read all'}: ${label}` : undefined}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={toggle}
        >
          {open ? 'Show less' : 'Read all'}
        </button>
      )}
    </div>
  );
}

/** Copies `text()` (built on click, so a large value is only serialised when
 *  asked for) and says so for a moment. */
export function CopyValueButton({ text, label = 'Copy' }: { text: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="structured-preview__copy nodrag"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(text()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        }, () => setCopied(false));
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
