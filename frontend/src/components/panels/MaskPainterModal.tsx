import { useCallback, useEffect, useRef, useState } from 'react';
import { canvasLockNow, refuseTabOnlyEdit, useCanvasLock } from '../../lib/canvasLock';
import { Brush, Eraser, Trash2, X } from 'lucide-react';
import '../../styles/mask-painter.css';
import { useMaskPainterDialog } from './maskPainterDialog';

/** Mask Painter modal — paints WHITE strokes on a transparent canvas over the
 *  upstream image, exported as a white-on-black PNG data URI at the image's
 *  NATURAL resolution (Ideogram rejects masks whose dimensions differ from the
 *  image). Polarity (white-edit vs black-edit) is applied at EXECUTION time by
 *  the backend mask-painter branch — the stored _maskData is always
 *  painted-equals-white, so flipping the polarity param never requires
 *  repainting.
 *
 *  Only the strokes layer is ever exported (toDataURL) — the photo canvas is
 *  display-only, so a cross-origin upstream image can't taint the export. */

interface MaskPainterModalProps {
  imageUrl: string | null;
  initialMask: string | null;
  onSave: (dataUri: string) => void;
  onClose: () => void;
}

const MAX_VIEW_W = 0.82; // fraction of viewport width
const MAX_VIEW_H = 0.68; // fraction of viewport height

export function MaskPainterModal({ imageUrl, initialMask, onSave, onClose }: MaskPainterModalProps) {
  const strokesRef = useRef<HTMLCanvasElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [tool, setTool] = useState<'brush' | 'erase'>('brush');
  const [brushSize, setBrushSize] = useState(48);
  const [hasStrokes, setHasStrokes] = useState(false);
  const drawingRef = useRef(false);
  const dialog = useMaskPainterDialog(onClose);
  const lock = useCanvasLock();
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Load the image to learn its natural size (the canvas paints at full res).
  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setImageFailed(true);
    img.src = imageUrl;
  }, [imageUrl]);

  // Restore a previously painted mask (stored white-on-black) back into the
  // transparent strokes layer: luminance becomes alpha.
  useEffect(() => {
    if (!natural || !initialMask) return;
    const strokes = strokesRef.current;
    if (!strokes) return;
    const img = new Image();
    img.onload = () => {
      const temp = document.createElement('canvas');
      temp.width = natural.w;
      temp.height = natural.h;
      const tctx = temp.getContext('2d');
      if (!tctx) return;
      tctx.drawImage(img, 0, 0, natural.w, natural.h);
      const data = tctx.getImageData(0, 0, natural.w, natural.h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = px[i]; // white-on-black: red channel == luminance
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = lum;
      }
      tctx.putImageData(data, 0, 0);
      const sctx = strokes.getContext('2d');
      if (!sctx) return;
      sctx.clearRect(0, 0, natural.w, natural.h);
      sctx.drawImage(temp, 0, 0);
      setHasStrokes(true);
    };
    img.src = initialMask;
  }, [natural, initialMask]);

  const canvasPoint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = strokesRef.current;
    if (!canvas || !natural) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * natural.w,
      y: ((e.clientY - rect.top) / rect.height) * natural.h,
    };
  }, [natural]);

  const drawSegment = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const ctx = strokesRef.current?.getContext('2d');
      if (!ctx) return;
      ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [tool, brushSize],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // Read-only while following or offline (review 3 LOW-3): no stroke. Kept
    // in this tab (PR #199), a mask is this tab's own, as typing.
    if (refuseTabOnlyEdit()) return;
    const pt = canvasPoint(e);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = pt;
    drawSegment(pt, pt); // dot on click
    setHasStrokes(true);
  }, [canvasPoint, drawSegment]);

  // A stroke under way ends the moment the lock starts (fix round 4 of PR
  // #200, review 4 LOW-2): the next move paints nothing, before React has
  // re-rendered with the lock, and the effect below ends it once it has.
  const endStroke = useCallback((e?: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (e && e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    if (lock.locked) endStroke();
  }, [lock.locked, endStroke]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    if (canvasLockNow().locked) {
      endStroke(e);
      return;
    }
    const pt = canvasPoint(e);
    if (!pt || !lastPointRef.current) return;
    drawSegment(lastPointRef.current, pt);
    lastPointRef.current = pt;
  }, [canvasPoint, drawSegment, endStroke]);

  // Up or leave: the stroke ends, painting nothing more (locked or not).
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => endStroke(e), [endStroke]);

  const clearStrokes = useCallback(() => {
    const canvas = strokesRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStrokes(false);
  }, []);

  const saveMask = useCallback(() => {
    const strokes = strokesRef.current;
    if (!strokes || !natural) return;
    const out = document.createElement('canvas');
    out.width = natural.w;
    out.height = natural.h;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, natural.w, natural.h);
    ctx.drawImage(strokes, 0, 0);
    onSave(out.toDataURL('image/png'));
  }, [natural, onSave]);

  // Fit the natural-res canvas into the viewport while preserving aspect.
  const viewSize = (() => {
    if (!natural) return null;
    const maxW = window.innerWidth * MAX_VIEW_W;
    const maxH = window.innerHeight * MAX_VIEW_H;
    const scale = Math.min(maxW / natural.w, maxH / natural.h, 1);
    return { w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) };
  })();

  return (
    <div {...dialog} className="mask-painter__overlay" role="dialog" aria-modal="true" aria-label="Mask painter">
      <div className="mask-painter__panel">
        <div className="mask-painter__header">
          <span className="mask-painter__title">Paint Mask</span>
          <span className="mask-painter__hint">
            Paint the region to change. Polarity is applied by the node&apos;s
            &ldquo;Painted Area Means&rdquo; setting at run time.
          </span>
          <button type="button" className="mask-painter__icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!imageUrl && (
          <div className="mask-painter__empty">
            Connect an image and run the upstream node first — the mask must match
            its exact dimensions.
          </div>
        )}
        {imageUrl && imageFailed && (
          <div className="mask-painter__empty">Couldn't load the upstream image for painting.</div>
        )}

        {imageUrl && !imageFailed && natural && viewSize && (
          <div
            className="mask-painter__stage"
            style={{ width: viewSize.w, height: viewSize.h }}
          >
            <img src={imageUrl} alt="" className="mask-painter__photo" draggable={false} />
            <canvas
              ref={strokesRef}
              width={natural.w}
              height={natural.h}
              className="mask-painter__strokes"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
          </div>
        )}

        <div className="mask-painter__toolbar">
          {/* Review 3 LOW-3: while following or offline the painter is
              read-only, as the other editors: its tools and strokes lock (the
              project bar or the offline row above the scrim says why). */}
          <button
            type="button"
            className={`mask-painter__tool ${tool === 'brush' ? 'mask-painter__tool--active' : ''}`}
            aria-pressed={tool === 'brush'}
            onClick={() => setTool('brush')}
            {...lock.act({ offline: true, kept: 'live' })}
          >
            <Brush size={14} /> Brush
          </button>
          <button
            type="button"
            className={`mask-painter__tool mask-painter__tool--erase ${tool === 'erase' ? 'mask-painter__tool--active' : ''}`}
            aria-pressed={tool === 'erase'}
            onClick={() => setTool('erase')}
            {...lock.act({ offline: true, kept: 'live' })}
          >
            <Eraser size={14} /> Erase
          </button>
          <label className="mask-painter__size">
            Size
            <input
              type="range"
              min={4}
              max={160}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              {...lock.act({ offline: true, kept: 'live' })}
            />
          </label>
          <button type="button" className="mask-painter__tool mask-painter__tool--clear" onClick={clearStrokes} {...lock.act({ offline: true, kept: 'live' })}>
            <Trash2 size={14} /> Clear
          </button>
          <div className="mask-painter__spacer" />
          <button type="button" className="mask-painter__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="mask-painter__save"
            onClick={saveMask}
            // Saving writes the node's mask (updateNodeData): the canvas lock
            // (fix round 2 of PR #200, review 2 L-5; GM's sweep list).
            {...lock.act({ disabled: !natural || !hasStrokes, offline: true, kept: 'live' })}
          >
            Save Mask
          </button>
        </div>
      </div>
    </div>
  );
}
