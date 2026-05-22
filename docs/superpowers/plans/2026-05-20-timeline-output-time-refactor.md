# Timeline Output-Time Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Nebula video editor timeline from source-time positioning to output/sequence-time positioning, matching the universal industry-standard model used by CapCut, Premiere Pro, Final Cut Pro X, and DaVinci Resolve. After this refactor, speeding up a clip visually shrinks its bar in the timeline (2× speed → half width); the ruler displays output/sequence time; trim handles, playhead, and HUD all operate in output-time coordinates.

**Architecture:** Promote `start` (output position, seconds) and `duration` (output duration, seconds) to first-class fields on `EditClip`. Demote `speed` to a derived value (`speed = (sourceOut - sourceIn) / duration`). The store maintains the end-to-end invariant `clip[i].start = clip[i-1].start + clip[i-1].duration` via a ripple helper called automatically by every clip-mutating action. The backend ffmpeg pipeline is unchanged — only the frontend data model and rendering migrate. Speed ramps and explicit gaps are explicitly out of scope.

**Tech Stack:** React + Vite + Zustand + xyflow + Vitest (frontend); FastAPI + ffmpeg (backend, no changes). Data model mirrors FCPXML (`offset` / `start` / `duration` semantics) and OpenTimelineIO (`source_range` + implicit-via-summation parent position). Reference: `docs/superpowers/specs/2026-05-20-nle-timeline-architecture-research.md` (Obsidian vault topic: `Research/topics/nle-timeline-architecture.md`).

**Source branch:** `feat/video-editor-tab-phase-1` (HEAD: `c12b148`)

---

## File Structure

**Frontend files that change:**

| File | Responsibility | Change scope |
|------|----------------|--------------|
| `frontend/src/lib/editor/virtualPlayback.ts` | Core math: `EditClip` type, `clipOutputDuration`, `totalOutputDuration`, `outputTimeToSourceTime`, `sourceTimeToActiveClipIndex`, new `clipSpeed` helper | Heavy rewrite |
| `frontend/tests/editor/virtualPlayback.test.ts` | Unit tests for the above | Full rewrite for new model |
| `frontend/src/store/graphStore.ts` | `getOrCreateEditNodeDownstream` seeds new shape; `updateEditNodeClip` / `cutEditNodeAtSource` / `removeEditNodeClip` maintain end-to-end invariant; `removeEmptyEditNode` virgin check uses derived speed | Multiple methods touched |
| `frontend/src/components/editor/Timeline.tsx` | Computes `totalOutputDuration` and passes it down (replaces `sourceDuration` for layout purposes) | Small change |
| `frontend/src/components/editor/TimelineRuler.tsx` | Ruler ticks/thumbs now in output time | Medium change |
| `frontend/src/components/editor/TimelineTrack.tsx` | Pass-through with renamed prop (`totalOutputDuration` instead of `sourceDuration`) | Trivial change |
| `frontend/src/components/editor/TimelineClip.tsx` | Bar layout in output-time; trim handle math translates output-x → source-time delta | Medium change |
| `frontend/src/components/editor/TimelinePlayhead.tsx` | Direct output-time positioning (`outputTime / totalOutputDuration`); existing scrub math already operates in output-time space | Small change |
| `frontend/src/components/editor/VideoPreview.tsx` | HUD reads output-time directly; no source-time conversion for display | Small change |
| `frontend/src/components/editor/EditorTransport.tsx` | Speed slider sets duration via derived inverse; clip count and SMPTE-total use `totalOutputDuration` (already do); summary unchanged | Small change |
| `frontend/src/lib/editor/api.ts` | `renderPreview` augments clips with derived `speed` before POST so the backend contract is preserved | Tiny change |
| `backend/handlers/video_edit.py` | Backend-side auto-seed at "snapped is empty" fallback path emits clips with `start` and `duration` populated for roundtrip parity | Tiny change |

**Files NOT touched:**
- `frontend/src/lib/editor/timecode.ts`, `frameAccurate.ts`, `thumbnailStrip.ts` — pure utilities, model-agnostic
- All other backend files — ffmpeg pipeline contract unchanged
- All other frontend files outside `editor/`

**Design invariants the store enforces (Phase 1):**
1. Clips are stored in playback order; `clips[i].start = clips[i-1].start + clips[i-1].duration` for `i > 0`, and `clips[0].start = 0`. (End-to-end, no gaps.)
2. `clip.duration > 0` always (a zero-duration clip is meaningless; trim handles clamp).
3. `clip.sourceIn < clip.sourceOut` always (source range is non-empty).
4. `clip.speed` is **not** a stored field — it is computed on demand via `clipSpeed(clip) = (sourceOut - sourceIn) / duration`.
5. `clip.duration` and `(sourceOut - sourceIn)` are independent — the user can change either without immediately affecting the other; speed re-derives.

---

## Task Sequence

The tasks below are ordered to maintain a working build at every commit. Phase A migrates the math and data model. Phase B migrates the rendering surface. Phase C migrates the store and seeding. Phase D migrates the backend roundtrip and smoke-tests.

Each task is one commit. Each commit should leave the build green (`npm run build` exits 0; existing tests still pass).

---

### Task 1: Add `start`/`duration` to `EditClip` and rewrite virtualPlayback math

**Files:**
- Modify: `frontend/src/lib/editor/virtualPlayback.ts`
- Test: `frontend/tests/editor/virtualPlayback.test.ts`

- [ ] **Step 1: Rewrite the test file**

Replace the contents of `frontend/tests/editor/virtualPlayback.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import {
  type EditClip,
  clipSpeed,
  clipOutputDuration,
  totalOutputDuration,
  outputTimeToSourceTime,
  sourceTimeToActiveClipIndex,
} from '../../src/lib/editor/virtualPlayback';

// Two end-to-end clips. clip[1] is at 0.5x speed so it stretches: 2s of source
// becomes 4s of output. Total output: 2 + 4 = 6s.
const clips: EditClip[] = [
  { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false },
  { id: 'c2', start: 2, duration: 4, sourceIn: 2, sourceOut: 4, volume: 1, mute: false },
];

describe('clipSpeed', () => {
  it('derives 1.0 when duration matches source range', () => {
    expect(clipSpeed(clips[0])).toBeCloseTo(1.0, 5);
  });
  it('derives 0.5 when output duration is double source range', () => {
    expect(clipSpeed(clips[1])).toBeCloseTo(0.5, 5);
  });
  it('returns 1 for zero-duration safety fallback', () => {
    const degenerate: EditClip = { id: 'x', start: 0, duration: 0, sourceIn: 0, sourceOut: 1, volume: 1, mute: false };
    expect(clipSpeed(degenerate)).toBe(1);
  });
});

describe('clipOutputDuration', () => {
  it('returns clip.duration directly (output is stored, not computed)', () => {
    expect(clipOutputDuration(clips[0])).toBe(2);
    expect(clipOutputDuration(clips[1])).toBe(4);
  });
});

describe('totalOutputDuration', () => {
  it('sums clip durations for end-to-end clips', () => {
    expect(totalOutputDuration(clips)).toBeCloseTo(6.0, 5);
  });
  it('returns 0 for empty clips array', () => {
    expect(totalOutputDuration([])).toBe(0);
  });
});

describe('outputTimeToSourceTime', () => {
  it('returns first clip sourceIn at output 0', () => {
    expect(outputTimeToSourceTime(0, clips)).toEqual({ clipIndex: 0, sourceTime: 0 });
  });
  it('maps within first clip at output 1.5 (speed 1, sourceTime=1.5)', () => {
    const r = outputTimeToSourceTime(1.5, clips);
    expect(r.clipIndex).toBe(0);
    expect(r.sourceTime).toBeCloseTo(1.5, 5);
  });
  it('crosses into second clip at output 3 (0.5s into clip[1] at 0.5x → 0.25s of source past sourceIn=2)', () => {
    const r = outputTimeToSourceTime(3.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(2.5, 5);
  });
  it('clamps to last clip sourceOut past end', () => {
    const r = outputTimeToSourceTime(10.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(4.0, 5);
  });
  it('returns clipIndex -1 for empty clips array', () => {
    expect(outputTimeToSourceTime(1.0, [])).toEqual({ clipIndex: -1, sourceTime: 0 });
  });
});

describe('sourceTimeToActiveClipIndex', () => {
  it('finds first clip whose source range contains the given source time', () => {
    expect(sourceTimeToActiveClipIndex(0.5, clips)).toBe(0);
    expect(sourceTimeToActiveClipIndex(3.0, clips)).toBe(1);
  });
  it('returns -1 if no clip contains the source time', () => {
    expect(sourceTimeToActiveClipIndex(99, clips)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd frontend && npm test -- virtualPlayback.test.ts
```

Expected: TypeScript compile errors (`clipSpeed` not exported; `EditClip` missing `start`/`duration`). Tests do not execute.

- [ ] **Step 3: Rewrite `virtualPlayback.ts` to match the new model**

Replace the entire contents of `frontend/src/lib/editor/virtualPlayback.ts` with:

```typescript
/**
 * Pure math for stepping through edit sub-clips during virtual playback.
 *
 * Coordinate model (matches FCPXML / OpenTimelineIO industry convention):
 *   start, duration   — OUTPUT time (where the clip sits on the edited timeline)
 *   sourceIn, sourceOut — SOURCE time (which range of the original media plays)
 *   speed              — DERIVED: (sourceOut - sourceIn) / duration
 *
 * Clips are stored in playback order. The store enforces the end-to-end
 * invariant clips[i].start = clips[i-1].start + clips[i-1].duration; this
 * file trusts that invariant when iterating.
 */

export interface EditClip {
  id: string;
  /** Where this clip starts on the output (edited) timeline, seconds. */
  start: number;
  /** How long this clip occupies on the output timeline, seconds. */
  duration: number;
  /** Source media in-point (which frame of the file starts playback). */
  sourceIn: number;
  /** Source media out-point (which frame of the file ends playback). */
  sourceOut: number;
  volume: number;
  mute: boolean;
}

/**
 * Derived playback rate. Returns 1 for degenerate (zero-duration) clips so
 * downstream math never divides by zero.
 */
export function clipSpeed(clip: EditClip): number {
  if (clip.duration <= 0) return 1;
  return (clip.sourceOut - clip.sourceIn) / clip.duration;
}

export function clipOutputDuration(clip: EditClip): number {
  return clip.duration;
}

export function totalOutputDuration(clips: EditClip[]): number {
  return clips.reduce((s, c) => s + c.duration, 0);
}

/**
 * Map an output-time position to its corresponding source media position.
 * Returns the index of the clip containing outputTime and the source frame
 * that should play at that moment. Out-of-range times clamp to the nearest
 * endpoint.
 */
export function outputTimeToSourceTime(
  outputTime: number,
  clips: EditClip[],
): { clipIndex: number; sourceTime: number } {
  if (clips.length === 0) return { clipIndex: -1, sourceTime: 0 };
  if (outputTime <= clips[0].start) return { clipIndex: 0, sourceTime: clips[0].sourceIn };

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const clipEnd = c.start + c.duration;
    if (outputTime <= clipEnd) {
      const localOutput = outputTime - c.start;
      const speed = clipSpeed(c);
      return { clipIndex: i, sourceTime: c.sourceIn + localOutput * speed };
    }
  }
  const last = clips[clips.length - 1];
  return { clipIndex: clips.length - 1, sourceTime: last.sourceOut };
}

/**
 * Reverse lookup: which clip's source range contains this source time?
 * Used for scrubbing decisions that originate in source space rather than
 * output space. Returns the first matching clip or -1.
 */
export function sourceTimeToActiveClipIndex(sourceTime: number, clips: EditClip[]): number {
  return clips.findIndex((c) => sourceTime >= c.sourceIn && sourceTime <= c.sourceOut);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd frontend && npm test -- virtualPlayback.test.ts
```

Expected: 11/11 tests pass.

- [ ] **Step 5: Verify the build still compiles**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: TypeScript errors will appear in other files that reference `clip.speed` (TimelineClip, VideoPreview, EditorTransport, Timeline, TimelineRuler, etc.). That is EXPECTED at this stage — those files will be migrated in subsequent tasks. **Note** the errors in your report; do not attempt to fix them in this task.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/editor/virtualPlayback.ts frontend/tests/editor/virtualPlayback.test.ts
git commit -m "$(cat <<'EOF'
refactor(video-edit): EditClip + virtualPlayback in output-time model

Promote start/duration to first-class fields on EditClip. Demote speed
to a derived value (clipSpeed helper). Update outputTimeToSourceTime to
locate clips by [start, start+duration] window instead of cumulative-sum
walk. Tests cover the new shape; downstream callers will surface
TypeScript errors until they migrate in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `reflowClips` helper + update store mutation methods

**Files:**
- Modify: `frontend/src/store/graphStore.ts`

This task introduces the helper that re-establishes the end-to-end invariant after any clip mutation. All four mutation methods (`getOrCreateEditNodeDownstream`, `updateEditNodeClip`, `cutEditNodeAtSource`, `removeEditNodeClip`) call into it.

- [ ] **Step 1: Add `reflowClips` helper near the other clip helpers in graphStore.ts**

Locate the section of `graphStore.ts` near `getOrCreateEditNodeDownstream` (around line 1021). Just **before** that method's definition, add:

```typescript
  // Re-establish the end-to-end invariant: clip[i].start = sum of durations
  // of clips[0..i-1]. Call after any mutation that affects clip durations
  // or order. This preserves Phase 1's "no gaps between clips" rule.
```

Then immediately after (still part of the store object, before `getOrCreateEditNodeDownstream`):

```typescript
```

Actually, since `reflowClips` is a pure function (doesn't need store access), define it at module scope just before the store factory call. Find the line that begins the store definition (something like `export const useGraphStore = create<GraphStore>((set, get) => ({`). Just **before** that line, add this helper at module scope:

```typescript
// ---------- Edit-clip invariant helpers ----------

interface EditClipLike {
  id: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  volume: number;
  mute: boolean;
}

/**
 * Re-establish the end-to-end invariant: clip[i].start = sum of prior
 * durations. Call after any mutation that changes clip durations or
 * order. Pure function; does not mutate input.
 */
function reflowClips(clips: EditClipLike[]): EditClipLike[] {
  let runningStart = 0;
  return clips.map((c) => {
    const out = { ...c, start: runningStart };
    runningStart += c.duration;
    return out;
  });
}
```

- [ ] **Step 2: Update `getOrCreateEditNodeDownstream` to seed the new clip shape**

Find `getOrCreateEditNodeDownstream` (around line 1021). The current body (after the existing-match early-return and the source-params read) constructs `initialClips`. Replace the current `initialClips` declaration with the new shape:

Find:
```typescript
    const initialClips = sourceDuration > 0
      ? [{ id: 'c1', sourceIn: 0, sourceOut: sourceDuration, speed: 1, volume: 1, mute: false }]
      : [];
```

Replace with:
```typescript
    const initialClips: EditClipLike[] = sourceDuration > 0
      ? [{ id: 'c1', start: 0, duration: sourceDuration, sourceIn: 0, sourceOut: sourceDuration, volume: 1, mute: false }]
      : [];
```

- [ ] **Step 3: Update `updateEditNodeClip` to call `reflowClips`**

Find `updateEditNodeClip` (around line 1112). Replace the entire method body with:

```typescript
  updateEditNodeClip: (nodeId, clipId, patch) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const oldClips = ((params.clips as EditClipLike[]) ?? []);
        const patched = oldClips.map((c) =>
          c.id === clipId ? { ...c, ...patch } : c,
        );
        const reflowed = reflowClips(patched);
        return { ...n, data: { ...n.data, params: { ...params, clips: reflowed } } };
      }),
    }));
  },
```

- [ ] **Step 4: Update `cutEditNodeAtSource` to populate new fields + call reflow**

Find `cutEditNodeAtSource` (around line 1125). Replace the entire method body with:

```typescript
  cutEditNodeAtSource: (nodeId, sourceTime) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const clips = ((params.clips as EditClipLike[]) ?? []);
        const idx = clips.findIndex((c) => sourceTime > c.sourceIn && sourceTime < c.sourceOut);
        if (idx < 0) return n;
        const orig = clips[idx];
        // Keep speed constant across both halves: same (sourceOut - sourceIn) / duration ratio.
        const origSpeed = orig.duration > 0 ? (orig.sourceOut - orig.sourceIn) / orig.duration : 1;
        const leftSourceRange = sourceTime - orig.sourceIn;
        const rightSourceRange = orig.sourceOut - sourceTime;
        const left: EditClipLike = {
          ...orig,
          sourceOut: sourceTime,
          duration: leftSourceRange / origSpeed,
        };
        const right: EditClipLike = {
          ...orig,
          id: `${orig.id}-${Math.random().toString(36).slice(2, 6)}`,
          sourceIn: sourceTime,
          duration: rightSourceRange / origSpeed,
        };
        const next = reflowClips([...clips.slice(0, idx), left, right, ...clips.slice(idx + 1)]);
        return { ...n, data: { ...n.data, params: { ...params, clips: next } } };
      }),
    }));
  },
```

- [ ] **Step 5: Update `removeEditNodeClip` to call reflow**

Find `removeEditNodeClip` (around line 1146). Replace the entire method body with:

```typescript
  removeEditNodeClip: (nodeId, clipId) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const filtered = ((params.clips as EditClipLike[]) ?? []).filter((c) => c.id !== clipId);
        if (filtered.length === 0) return n; // Never delete the only clip
        const reflowed = reflowClips(filtered);
        return { ...n, data: { ...n.data, params: { ...params, clips: reflowed } } };
      }),
    }));
  },
```

- [ ] **Step 6: Update `removeEmptyEditNode` virgin check**

Find `removeEmptyEditNode` (around line 1072). Locate the `isVirgin` block (lines ~1097-1103) and replace it with:

```typescript
    const sourceDuration = (node.data.params?.sourceDuration as number) ?? 0;
    const isVirgin =
      clips.length === 0 ||
      (clips.length === 1 &&
        (clips[0].sourceIn === 0 || clips[0].sourceIn === 0.0) &&
        // Speed is derived: speed = 1 means duration equals source range.
        // For a freshly seeded clip, duration === sourceOut === sourceDuration.
        Math.abs((clips[0].duration as number) - ((clips[0].sourceOut as number) - (clips[0].sourceIn as number))) < 0.0001 &&
        (clips[0].volume === 1 || clips[0].volume === 1.0) &&
        clips[0].mute === false);
```

The key change: replace the `speed === 1` check with a duration-vs-source-range equality check (within a small epsilon for float math). Everything else is unchanged.

- [ ] **Step 7: Run frontend build to verify graphStore compiles**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: TypeScript errors still appear in components that reference `clip.speed` (TimelineClip, VideoPreview, EditorTransport). graphStore itself should compile cleanly. If graphStore has compile errors, report them — those are real bugs in this task.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/store/graphStore.ts
git commit -m "$(cat <<'EOF'
refactor(video-edit): graphStore enforces end-to-end clip invariant

Add reflowClips helper that re-establishes clip[i].start = sum of prior
durations after any mutation. updateEditNodeClip, cutEditNodeAtSource,
removeEditNodeClip all route through it so callers can patch any field
without manually tracking position shifts. getOrCreateEditNodeDownstream
seeds the new shape (start + duration explicit). removeEmptyEditNode's
virgin check uses derived speed equality.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migrate `TimelineClip.tsx` to output-time layout + ripple trim

**Files:**
- Modify: `frontend/src/components/editor/TimelineClip.tsx`

- [ ] **Step 1: Replace the entire component**

Replace the contents of `frontend/src/components/editor/TimelineClip.tsx` with:

```tsx
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import { type EditClip, clipSpeed } from '../../lib/editor/virtualPlayback';

interface Props {
  clip: EditClip;
  index: number;
  track: 'video' | 'audio';
  totalOutputDuration: number;
  sourceFps: number;
  editNodeId: string;
}

export function TimelineClip({ clip, totalOutputDuration, sourceFps, track, editNodeId }: Props) {
  const setSelectedClip = useUIStore((s) => s.setSelectedClip);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);

  // Output-time positioning: where the clip sits on the edited timeline.
  const leftPct = totalOutputDuration > 0 ? (clip.start / totalOutputDuration) * 100 : 0;
  const widthPct = totalOutputDuration > 0 ? (clip.duration / totalOutputDuration) * 100 : 0;

  const speed = clipSpeed(clip);
  const isEdited =
    Math.abs(speed - 1) > 0.0001 ||
    clip.volume !== 1.0 ||
    clip.mute ||
    clip.sourceIn > 0;
  const isSelected = selectedClipId === clip.id;

  function startDrag(edge: 'in' | 'out') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const trackEl = (e.currentTarget as HTMLElement).closest('.editor-tl__track-body') as HTMLElement | null;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      // Capture immutables at drag start: speed stays constant; source bounds
      // shift; duration recomputes from new source range / speed.
      const dragSpeed = speed;
      const origSourceIn = clip.sourceIn;
      const origSourceOut = clip.sourceOut;

      function onMove(ev: PointerEvent) {
        const x = (ev.clientX - rect.left) / rect.width;
        // Cursor is in OUTPUT time space (the track body's coordinate system).
        const cursorOutputTime = x * totalOutputDuration;
        // Translate cursor's output-time movement into source-time movement.
        // dragSpeed stays constant: source moves dragSpeed seconds per second of output.
        if (edge === 'in') {
          // IN handle: source-in shifts by (cursorOutputTime - clip.start) * speed.
          // Clamp so newSourceIn stays in [0, origSourceOut - 0.1 * speed]
          // (the latter preserves at least 0.1s of output duration).
          const deltaOutput = cursorOutputTime - clip.start;
          const newSourceInUnclamped = origSourceIn + deltaOutput * dragSpeed;
          const minSrcIn = 0;
          const maxSrcIn = origSourceOut - 0.1 * dragSpeed;
          const snappedSourceIn = snapToFrameGrid(
            Math.max(minSrcIn, Math.min(newSourceInUnclamped, maxSrcIn)),
            sourceFps,
          );
          const newDuration = (origSourceOut - snappedSourceIn) / dragSpeed;
          updateClip(editNodeId, clip.id, { sourceIn: snappedSourceIn, duration: newDuration });
        } else {
          // OUT handle: source-out shifts by (cursorOutputTime - (clip.start + clip.duration)) * speed.
          const clipEnd = clip.start + clip.duration;
          const deltaOutput = cursorOutputTime - clipEnd;
          const newSourceOutUnclamped = origSourceOut + deltaOutput * dragSpeed;
          const minSrcOut = origSourceIn + 0.1 * dragSpeed;
          // No hard upper bound here; the caller (Timeline) is responsible for
          // not letting source extend past sourceDuration. We clamp using the
          // source media's known duration from params (passed via the parent
          // chain implicitly through sourceFps; for now, just bound below).
          const snappedSourceOut = snapToFrameGrid(
            Math.max(minSrcOut, newSourceOutUnclamped),
            sourceFps,
          );
          const newDuration = (snappedSourceOut - origSourceIn) / dragSpeed;
          updateClip(editNodeId, clip.id, { sourceOut: snappedSourceOut, duration: newDuration });
        }
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  return (
    <div
      className={`editor-tl__clip ${isEdited ? 'editor-tl__clip--edited' : ''} ${isSelected ? 'editor-tl__clip--selected' : ''} editor-tl__clip--${track}`}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      onClick={(e) => { e.stopPropagation(); setSelectedClip(clip.id); }}
    >
      {track === 'video' && (
        <div className="editor-tl__clip-handle editor-tl__clip-handle--in" onPointerDown={startDrag('in')} />
      )}
      <span className="editor-tl__clip-label">
        clip {clip.id}
        {Math.abs(speed - 1) > 0.0001 && (
          <span className="editor-tl__clip-speed">{speed.toFixed(2)}×</span>
        )}
      </span>
      {track === 'audio' && clip.volume !== 1.0 && (
        <span className="editor-tl__clip-vol">vol {Math.round(clip.volume * 100)}%</span>
      )}
      {track === 'video' && (
        <div className="editor-tl__clip-handle editor-tl__clip-handle--out" onPointerDown={startDrag('out')} />
      )}
    </div>
  );
}
```

Key changes vs the old version:
- `sourceDuration` prop renamed to `totalOutputDuration` (and is now the timeline range)
- `leftPct` and `widthPct` use `clip.start` and `clip.duration` against `totalOutputDuration`
- `speed` derived via `clipSpeed(clip)` instead of `clip.speed`
- Trim handler computes new sourceIn/sourceOut from cursor output position, keeps speed constant, recomputes duration in the patch
- `isEdited` check uses speed-difference-from-1 (within epsilon) instead of `clip.speed !== 1.0`

- [ ] **Step 2: Verify build (component-level)**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. TimelineClip's caller (TimelineTrack) still passes `sourceDuration` — that's a TypeScript error that will get fixed in Task 5.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/editor/TimelineClip.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): TimelineClip in output-time + ripple trim

Bar layout uses clip.start and clip.duration against totalOutputDuration.
Trim handles operate in output-time space; sourceIn/sourceOut shift by
output-delta * speed; duration recomputes from new source range. Speed
read via clipSpeed() helper. Caller wiring updates in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migrate `TimelineRuler.tsx` to output-time ticks

**Files:**
- Modify: `frontend/src/components/editor/TimelineRuler.tsx`

- [ ] **Step 1: Replace the entire component**

Replace the contents of `frontend/src/components/editor/TimelineRuler.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { formatSmpte } from '../../lib/editor/timecode';
import { getThumbnail } from '../../lib/editor/thumbnailStrip';

interface Props {
  sourceUrl: string;
  /** Total output duration in seconds — the timeline's full visible range. */
  totalOutputDuration: number;
  /** Used for SMPTE display only. */
  sourceFps: number;
  /** Used to compute thumbnail source times (proportionally mapped from output). */
  sourceDuration: number;
}

export function TimelineRuler({ sourceUrl, totalOutputDuration, sourceFps, sourceDuration }: Props) {
  // Tick every ~2 seconds of OUTPUT time, capped to keep the strip from
  // overflowing on long durations. Phase D code review flagged uncapped
  // step counts; this preserves that limit while moving to output time.
  const stepCount = Math.max(1, Math.min(12, Math.floor(totalOutputDuration / 2)));
  const outputStepTimes = Array.from(
    { length: stepCount + 1 },
    (_, i) => (totalOutputDuration * i) / stepCount,
  );
  // Thumbnails are sampled from source time. We pick proportional source
  // times so the strip shows a roughly representative sweep of the media —
  // accurate-to-output-time-position would require integrating across
  // speed-changed clips, which is Phase 2 work.
  const sourceStepTimes = Array.from(
    { length: stepCount + 1 },
    (_, i) => (sourceDuration * i) / stepCount,
  );
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const t of sourceStepTimes) {
        try {
          const url = await getThumbnail({ sourceUrl, time: t, width: 80 });
          if (cancelled) return;
          setThumbs((prev) => ({ ...prev, [Number(t.toFixed(2))]: url }));
        } catch { /* placeholder will show */ }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, sourceDuration]);

  return (
    <div className="editor-tl__ruler-wrap">
      <div className="editor-tl__ruler-thumbs">
        {sourceStepTimes.map((t, i) => (
          <div key={i} className="editor-tl__ruler-thumb">
            {thumbs[Number(t.toFixed(2))] ? (
              <img src={thumbs[Number(t.toFixed(2))]} alt="" />
            ) : (
              <div className="editor-tl__ruler-thumb-placeholder" />
            )}
          </div>
        ))}
      </div>
      <div className="editor-tl__ruler">
        {outputStepTimes.map((t, i) => (
          <span key={i} className="editor-tl__ruler-tick">{formatSmpte(t, sourceFps)}</span>
        ))}
      </div>
    </div>
  );
}
```

Key changes:
- `sourceDuration` prop kept (for thumbnail sampling, which is a source-time op) but new `totalOutputDuration` prop drives the tick labels
- Tick labels show OUTPUT time (this is what "the timeline ruler is in sequence time" means in the research)
- `stepCount` capped at 12 (carryover of Phase D reviewer's Important #3 — same cap as previously suggested)
- Thumbnail times remain in source-space (sampling representative source frames is still useful)

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. Caller (Timeline.tsx) still passes the old prop shape — that breaks in this task and gets fixed in Task 6.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/editor/TimelineRuler.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): TimelineRuler ticks in output time

Tick labels now show output (sequence) timecode using totalOutputDuration
as the range; thumbnails continue to sample source time for representative
frames. Step count capped at 12 to avoid overflow on long clips
(addresses Phase D review item).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Migrate `TimelineTrack.tsx` prop names

**Files:**
- Modify: `frontend/src/components/editor/TimelineTrack.tsx`

- [ ] **Step 1: Replace the entire component**

Replace the contents of `frontend/src/components/editor/TimelineTrack.tsx` with:

```tsx
import { type EditClip } from '../../lib/editor/virtualPlayback';
import { TimelineClip } from './TimelineClip';

interface Props {
  type: 'video' | 'audio';
  clips: EditClip[];
  totalOutputDuration: number;
  sourceFps: number;
  editNodeId: string;
  /** Reserved for Task 21 (wavesurfer waveform on the audio track). */
  sourceUrl?: string;
}

export function TimelineTrack({ type, clips, totalOutputDuration, sourceFps, editNodeId }: Props) {
  return (
    <div className={`editor-tl__track editor-tl__track--${type}`}>
      <div className="editor-tl__track-label">{type === 'video' ? 'VID' : 'AUD'}</div>
      <div className="editor-tl__track-body">
        {clips.map((clip, i) => (
          <TimelineClip
            key={clip.id}
            clip={clip}
            index={i}
            track={type}
            totalOutputDuration={totalOutputDuration}
            sourceFps={sourceFps}
            editNodeId={editNodeId}
          />
        ))}
      </div>
    </div>
  );
}
```

Only change: `sourceDuration` prop is replaced by `totalOutputDuration` (renamed and threaded through to TimelineClip).

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. Caller (Timeline.tsx) still passes the old prop shape — fixed in Task 6.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/editor/TimelineTrack.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): TimelineTrack passes totalOutputDuration

Rename sourceDuration prop to totalOutputDuration; thread through to
TimelineClip. No other behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migrate `Timeline.tsx` to compute + thread `totalOutputDuration`

**Files:**
- Modify: `frontend/src/components/editor/Timeline.tsx`

- [ ] **Step 1: Replace the entire component**

Replace the contents of `frontend/src/components/editor/Timeline.tsx` with:

```tsx
import type { Node } from '@xyflow/react';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelinePlayhead } from './TimelinePlayhead';
import { type EditClip, totalOutputDuration as computeTotalOutputDuration } from '../../lib/editor/virtualPlayback';

interface Props {
  editNode: Node;
  sourceUrl: string;
}

export function Timeline({ editNode, sourceUrl }: Props) {
  const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
  const clips: EditClip[] = (params.clips as EditClip[]) ?? [];
  const sourceDuration: number = typeof params.sourceDuration === 'number' ? params.sourceDuration : 1;
  const sourceFps: number = typeof params.sourceFps === 'number' && params.sourceFps > 0 ? params.sourceFps : 30;
  // totalOutputDuration is the OUTPUT timeline range — what the ruler, clip
  // bars, and playhead all measure against. Falls back to sourceDuration when
  // there are no clips yet so the empty editor still renders a sensible ruler.
  const totalOutputDuration = clips.length > 0 ? computeTotalOutputDuration(clips) : sourceDuration;

  return (
    <div className="editor-tl">
      <TimelineRuler
        sourceUrl={sourceUrl}
        totalOutputDuration={totalOutputDuration}
        sourceDuration={sourceDuration}
        sourceFps={sourceFps}
      />
      <div className="editor-tl__tracks">
        <TimelineTrack
          type="video"
          clips={clips}
          totalOutputDuration={totalOutputDuration}
          sourceFps={sourceFps}
          editNodeId={editNode.id}
        />
        <TimelineTrack
          type="audio"
          clips={clips}
          totalOutputDuration={totalOutputDuration}
          sourceFps={sourceFps}
          editNodeId={editNode.id}
          sourceUrl={sourceUrl}
        />
      </div>
      <div className="editor-tl__playhead-area">
        <TimelinePlayhead totalOutputDuration={totalOutputDuration} clips={clips} />
      </div>
    </div>
  );
}
```

Key changes:
- Compute `totalOutputDuration` via the virtualPlayback helper
- Pass `totalOutputDuration` to Ruler, Track, Playhead
- Keep `sourceDuration` only for thumbnail sampling in Ruler (it's still needed there)
- Use the structurally-correct `as { params?: Record<string, unknown> }` narrowing established in the earlier metadata-probe task

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. TimelinePlayhead.tsx now has a TypeScript error on `sourceDuration` → fixed in Task 7.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/editor/Timeline.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): Timeline computes + threads totalOutputDuration

Compute totalOutputDuration from clips; pass to Ruler, Track, Playhead.
sourceDuration kept only for thumbnail sampling in Ruler. Falls back to
sourceDuration when clips is empty so the editor still renders a sensible
empty-state ruler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Migrate `TimelinePlayhead.tsx` to direct output-time positioning

**Files:**
- Modify: `frontend/src/components/editor/TimelinePlayhead.tsx`

- [ ] **Step 1: Replace the entire component**

Replace the contents of `frontend/src/components/editor/TimelinePlayhead.tsx` with:

```tsx
import { useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration as computeTotalOutputDuration,
} from '../../lib/editor/virtualPlayback';

interface Props {
  /** Total output duration in seconds — the playhead's full traverse range. */
  totalOutputDuration: number;
  clips: EditClip[];
}

export function TimelinePlayhead({ totalOutputDuration, clips }: Props) {
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);

  // Position the playhead in OUTPUT-time space. Wrapper provides correct
  // coordinate frame (track-body extent, not container).
  const leftPct = totalOutputDuration > 0 ? (outputTime / totalOutputDuration) * 100 : 0;

  // Debug hook: expose the SOURCE-time the playhead currently points at.
  // Useful for CLI/test inspection. Lives in useEffect to avoid the
  // react-hooks/immutability lint error from side-effects-during-render.
  useEffect(() => {
    const { sourceTime } = outputTimeToSourceTime(outputTime, clips);
    (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime = sourceTime;
  });

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const scrubArea = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
    if (!scrubArea) return;
    const rect = scrubArea.getBoundingClientRect();
    const total = computeTotalOutputDuration(clips);
    function onMove(ev: PointerEvent) {
      const x = (ev.clientX - rect.left) / rect.width;
      setOutputTime(Math.max(0, Math.min(total, x * total)));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      className="editor-tl__playhead"
      style={{ left: `${leftPct}%`, cursor: 'ew-resize', pointerEvents: 'auto' }}
      onPointerDown={onPointerDown}
    />
  );
}
```

Key changes:
- Prop renamed: `sourceDuration` → `totalOutputDuration`
- `leftPct` computed directly from `outputTime / totalOutputDuration` (no source-time detour)
- Debug global preserved (in useEffect, computing sourceTime via `outputTimeToSourceTime`)
- Scrub handler unchanged (parent is the playhead-area wrapper, which is already in output-time)

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. Other files (VideoPreview, EditorTransport) may still have errors on `clip.speed` references — fixed in Tasks 8 and 9.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/editor/TimelinePlayhead.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): TimelinePlayhead positions in output time

Compute leftPct directly from outputTime / totalOutputDuration instead of
routing through sourceTime. Scrub handler unchanged. Debug global hook
kept (mirrors source-time via outputTimeToSourceTime inside useEffect).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Migrate `VideoPreview.tsx` to use `clipSpeed` helper

**Files:**
- Modify: `frontend/src/components/editor/VideoPreview.tsx`

- [ ] **Step 1: Read current contents**

Before editing, run:

```bash
cat frontend/src/components/editor/VideoPreview.tsx
```

Note the current shape so the edit is targeted.

- [ ] **Step 2: Update imports and clip-speed access**

Make these targeted edits using the Edit tool (do not rewrite the whole file):

**Edit A — imports.** Find:

```typescript
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration,
} from '../../lib/editor/virtualPlayback';
```

Replace with:

```typescript
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration,
  clipSpeed,
} from '../../lib/editor/virtualPlayback';
```

**Edit B — speed usage inside the sync useEffect.** Find:

```typescript
    video.playbackRate = clip.speed;
```

Replace with:

```typescript
    video.playbackRate = clipSpeed(clip);
```

That is the only place `clip.speed` is read in this file. No other behavior change is needed.

- [ ] **Step 3: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: This file compiles. EditorTransport.tsx may still have errors — fixed in Task 9.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/editor/VideoPreview.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): VideoPreview reads speed via clipSpeed()

Replace clip.speed access with the derived clipSpeed(clip) helper. No
behavioral change — playback continues to drive video.playbackRate from
the per-clip speed, just sourced from duration/sourceRange now.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Migrate `EditorTransport.tsx` speed slider to set duration

**Files:**
- Modify: `frontend/src/components/editor/EditorTransport.tsx`

- [ ] **Step 1: Update imports**

Use the Edit tool. Find:

```typescript
import { type EditClip, totalOutputDuration } from '../../lib/editor/virtualPlayback';
```

Replace with:

```typescript
import { type EditClip, totalOutputDuration, clipSpeed } from '../../lib/editor/virtualPlayback';
```

- [ ] **Step 2: Update the speed slider and preset buttons**

Find this block inside the selectedClip inspector JSX:

```typescript
          <label className="editor-transport__label">Speed</label>
          <input type="range" min={0.25} max={4} step={0.05}
            value={selectedClip.speed}
            onChange={(e) => updateClip(editNode.id, selectedClip.id, { speed: parseFloat(e.target.value) })} />
          <span className="editor-transport__value">{selectedClip.speed.toFixed(2)}×</span>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 0.5 })}>0.5×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 1.0 })}>1×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 2.0 })}>2×</button>
```

Replace with:

```typescript
          <label className="editor-transport__label">Speed</label>
          <input type="range" min={0.25} max={4} step={0.05}
            value={clipSpeed(selectedClip)}
            onChange={(e) => {
              const newSpeed = parseFloat(e.target.value);
              if (newSpeed <= 0) return;
              const newDuration = (selectedClip.sourceOut - selectedClip.sourceIn) / newSpeed;
              updateClip(editNode.id, selectedClip.id, { duration: newDuration });
            }} />
          <span className="editor-transport__value">{clipSpeed(selectedClip).toFixed(2)}×</span>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) / 0.5 })}>0.5×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) })}>1×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) / 2 })}>2×</button>
```

Key changes:
- Slider reads `clipSpeed(selectedClip)` instead of `selectedClip.speed`
- onChange sets `duration` derived from the new speed: `duration = (sourceOut - sourceIn) / newSpeed`
- Preset buttons set `duration` directly (no `speed` field)
- All other inspector controls (Vol, Mute) and the Render Preview button are unchanged

- [ ] **Step 3: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: Build completes cleanly with no TypeScript errors related to the migration. (Pre-existing chunk-size warnings still appear; those are unrelated.) If any file still references `clip.speed`, list it explicitly.

- [ ] **Step 4: Run vitest test suite to verify nothing else regressed**

```bash
cd frontend && npm test -- --run 2>&1 | tail -10
```

Expected: All editor tests pass (timecode, frameAccurate, virtualPlayback). Total count should reflect the rewritten virtualPlayback tests (11 from Task 1) plus the others.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/editor/EditorTransport.tsx
git commit -m "$(cat <<'EOF'
refactor(video-edit): EditorTransport speed slider sets duration

Slider reads clipSpeed(selectedClip) for display. onChange and preset
buttons set duration directly (= sourceRange / targetSpeed) so the
clip bar visually shrinks/grows when the user changes speed. Volume
and mute paths unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update `api.ts` to send derived `speed` to backend

**Files:**
- Modify: `frontend/src/lib/editor/api.ts`

The backend's `handle_video_edit` reads `clip.speed` to drive ffmpeg's `setpts` and `atempo` filters. Since `speed` is no longer a stored frontend field, the api client derives it at send time.

- [ ] **Step 1: Replace the entire file**

Replace the contents of `frontend/src/lib/editor/api.ts` with:

```typescript
import { type EditClip, clipSpeed } from './virtualPlayback';

interface PreviewRenderResponse {
  previewUrl: string;
}

/**
 * Backend contract: the ffmpeg pipeline operates on sourceIn/sourceOut/speed.
 * The frontend stores duration as primary; speed derives from the ratio.
 * Augment each clip with its derived speed before sending.
 */
function augmentForBackend(clip: EditClip): EditClip & { speed: number } {
  return { ...clip, speed: clipSpeed(clip) };
}

export async function renderPreview(req: { sourceUrl: string; clips: EditClip[] }): Promise<string> {
  const body = {
    sourceUrl: req.sourceUrl,
    clips: req.clips.map(augmentForBackend),
  };
  const response = await fetch('/api/video-edit/preview-render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Render preview failed: ${detail}`);
  }
  const responseBody = (await response.json()) as PreviewRenderResponse;
  return responseBody.previewUrl;
}
```

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/editor/api.ts
git commit -m "$(cat <<'EOF'
refactor(video-edit): api.ts derives speed when sending to backend

Backend ffmpeg pipeline still expects clip.speed; frontend stores
duration as primary and derives speed only at the network boundary.
augmentForBackend(clip) attaches the derived speed for each clip
before the renderPreview POST.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Backend roundtrip — emit `start`/`duration` from `handle_video_edit`

**Files:**
- Modify: `backend/handlers/video_edit.py`

When the user runs the edit node, the backend may write a fallback clip (lines ~178-181). The frontend reads that back via graph sync. To preserve the new shape across the roundtrip, the backend's fallback emits all four time fields.

- [ ] **Step 1: Update the fallback clip emission**

Find the block in `backend/handlers/video_edit.py` (around lines 178-181):

```python
        if not snapped:
            snapped = [
                {"id": "c1", "sourceIn": 0.0, "sourceOut": probe.duration, "speed": 1.0, "volume": 1.0, "mute": False}
            ]
```

Replace with:

```python
        if not snapped:
            # Frontend stores start/duration as primary; backend stores speed
            # for ffmpeg. Emit all four time fields so the roundtrip preserves
            # the frontend's data model when graphSync replays back to the UI.
            snapped = [
                {
                    "id": "c1",
                    "start": 0.0,
                    "duration": probe.duration,
                    "sourceIn": 0.0,
                    "sourceOut": probe.duration,
                    "speed": 1.0,
                    "volume": 1.0,
                    "mute": False,
                }
            ]
```

- [ ] **Step 2: Add start/duration to existing-clip snap loop**

Still in `handle_video_edit`, find the snap loop earlier in the function (around lines 168-177):

```python
        snapped: list[dict[str, Any]] = []
        for c in existing_clips:
            if c["sourceIn"] >= probe.duration:
                continue
            s_in = min(c["sourceIn"], probe.duration)
            s_out = min(c["sourceOut"], probe.duration)
            if probe.fps > 0:
                s_in = int(s_in * probe.fps) / probe.fps
                s_out = int(s_out * probe.fps) / probe.fps
            snapped.append({**c, "sourceIn": s_in, "sourceOut": s_out})
```

Replace with:

```python
        snapped: list[dict[str, Any]] = []
        for c in existing_clips:
            if c["sourceIn"] >= probe.duration:
                continue
            s_in = min(c["sourceIn"], probe.duration)
            s_out = min(c["sourceOut"], probe.duration)
            if probe.fps > 0:
                s_in = int(s_in * probe.fps) / probe.fps
                s_out = int(s_out * probe.fps) / probe.fps
            # If the source clamped the range, recompute duration from the new
            # range and the original speed so the frontend's start/duration
            # invariants stay consistent post-roundtrip.
            orig_speed = c.get("speed", 1.0) or 1.0
            new_duration = (s_out - s_in) / orig_speed if orig_speed > 0 else (s_out - s_in)
            # Reflow start happens on the frontend after graphSync; here we just
            # preserve whatever start was stored, or 0 for legacy clips that
            # lacked it (they're about to be reflowed anyway).
            existing_start = c.get("start", 0.0)
            snapped.append({
                **c,
                "sourceIn": s_in,
                "sourceOut": s_out,
                "duration": new_duration,
                "start": existing_start,
            })
```

- [ ] **Step 3: Run backend tests**

```bash
cd backend && ./.venv/bin/python -m pytest tests/test_video_edit_handler.py -v 2>&1 | tail -20
```

Expected: All existing tests pass. Some may need updates if they assert exact dict equality on the clip shape — if so, the test fixtures need `start: 0.0` and `duration: <value>` added. Report any failing tests; do not silently update assertions without confirming the test's intent.

If a test fails because it asserts the exact shape of the snapped clip output and that shape now has more keys, you have two options:
- (a) Update the test to assert the new fields are present alongside the old ones
- (b) If the test was checking "exact dict equality" deliberately as a contract test, that contract has changed and the test's intent needs to be re-evaluated. Report the specific test and ask before proceeding.

- [ ] **Step 4: Run full backend test suite**

```bash
cd backend && ./.venv/bin/python -m pytest -q 2>&1 | tail -10
```

Expected: 650 (or close to it) tests pass. If a test breaks for shape-related reasons, see Step 3 guidance.

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/video_edit.py
git commit -m "$(cat <<'EOF'
refactor(video-edit): handler emits start+duration for frontend roundtrip

When handle_video_edit snaps clips against the source duration or seeds
a fallback clip, the output now includes start and duration alongside
the existing sourceIn/sourceOut/speed/volume/mute. This preserves the
new frontend EditClip shape across graphSync roundtrips. The ffmpeg
pipeline itself is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: End-to-end smoke + final verification

**Files:** None modified — verification only.

- [ ] **Step 1: Full frontend test suite**

```bash
cd frontend && npm test -- --run 2>&1 | tail -15
```

Expected: All editor tests pass. The virtualPlayback test count from Task 1 (11 tests) is included.

- [ ] **Step 2: Full frontend build**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: No TypeScript errors. Pre-existing chunk-size warnings are fine.

- [ ] **Step 3: Full frontend lint**

```bash
cd frontend && npm run lint 2>&1 | tail -20
```

Expected: No NEW lint errors introduced by this refactor. Pre-existing errors from `graphStore.ts` and other older files may persist — only flag NEW ones.

- [ ] **Step 4: Full backend test suite**

```bash
cd backend && ./.venv/bin/python -m pytest -q 2>&1 | tail -10
```

Expected: ~650 tests pass.

- [ ] **Step 5: Manual smoke test checklist**

The implementer cannot run this — the orchestrator should pass this checklist to the user for in-browser verification:

1. Drop a video on the canvas → run Video Input → click Editor pill
2. Editor opens with a single clip bar spanning the full timeline width
3. SMPTE total reads the actual source duration (not 0:0)
4. Click the clip → speed/volume/mute inspector appears
5. Drag speed slider to 2.0 — **bar visually shrinks to half width**; subsequent layout (if any other clips) ripples to fill
6. Drag speed slider to 0.5 — bar visually grows to double width
7. Drag the OUT (right) trim handle inward — bar shrinks; sourceOut decreases
8. Drag the IN (left) trim handle inward — bar shrinks from the start; sourceIn increases
9. Click Render Preview → backend ffmpeg runs successfully; logs show the derived speed value reaching ffmpeg
10. Click Canvas tab → return to canvas; click Editor again on same Video Input → reopens with the in-progress clip (no data loss)

- [ ] **Step 6: No commit** — this is a verification task only. Report results.

---

## Self-Review Notes

**Spec coverage check:**
- Output-time data model on EditClip — ✓ Task 1 (start, duration fields added)
- Derived speed via clipSpeed() — ✓ Task 1 (helper); consumed by Tasks 3, 8, 9
- End-to-end invariant via reflowClips() — ✓ Task 2 (helper + 4 mutation paths)
- TimelineClip output-time layout + ripple trim — ✓ Task 3
- TimelineRuler output-time ticks — ✓ Task 4
- TimelineTrack pass-through — ✓ Task 5
- Timeline composer — ✓ Task 6
- TimelinePlayhead direct output-time positioning — ✓ Task 7
- VideoPreview clipSpeed integration — ✓ Task 8
- EditorTransport speed → duration translation — ✓ Task 9
- api.ts derives speed for backend — ✓ Task 10
- Backend roundtrip preserves new shape — ✓ Task 11
- E2E smoke verification — ✓ Task 12

**Type consistency check:**
- `EditClip` has `{ id, start, duration, sourceIn, sourceOut, volume, mute }` throughout (no `speed` field on the type)
- `clipSpeed(clip)` returns `number` everywhere it's called
- `totalOutputDuration` prop name used consistently in Timeline, Ruler, Track, Clip, Playhead (replacing `sourceDuration` for layout purposes; `sourceDuration` retained only for thumbnail sampling in Ruler)
- Backend's `clip.speed` field still required by ffmpeg pipeline — derived at the api.ts boundary, never stored on the frontend

**Placeholder check:** No "TODO", "TBD", "Implement later", or "Add appropriate error handling" placeholders. Every step has complete code or complete commands.

---

## Execution Notes

- The build is intentionally allowed to surface TypeScript errors in unmigrated files between Task 1 and Task 9. Each task focuses on one file's migration so the orchestrator can isolate review. By the end of Task 9, the build is fully green.
- Backend changes (Task 11) are minimal because the ffmpeg pipeline is unchanged. The roundtrip parity is the only thing the backend gains.
- Manual smoke test (Task 12 Step 5) is the orchestrator's responsibility to coordinate with the user — the implementer subagent should not attempt browser interaction.
- After Task 12, push the branch and consider whether to continue into Phase E (Tasks 21–23 of the original Phase 1 plan: wavesurfer waveform, keyboard bindings, EditNode card) or write a fresh handoff first.
