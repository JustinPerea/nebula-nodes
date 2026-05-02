// Reads a driver run's events.json and writes zoom-directives.json.
//
// Strategy: hold an overview when nothing's happening, zoom-to-node when a
// new node appears (1s ease-in, ~2s hold, 1s ease-out), pop back to overview
// in long gaps. Output is a list of segments with focusStart/focusEnd, easing
// label, and on-recording time bounds. apply-zoom.mjs consumes this to build
// the ffmpeg crop expression.
//
// Usage:
//   node derive-zoom.mjs <runDir>
// Defaults to the most recent run dir if no arg given.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RUNS_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver');

// =============================================================================
// DIRECTOR'S DESIGN RULES
// Centralized tuning for camera composition, pacing, and rhythm. Tweak these
// rather than hardcoding magic numbers throughout the file.
// =============================================================================
const DESIGN_RULES = {
  // --- Subject sizing ---
  // Target subject size as fraction of crop width. Lower = more breathing room.
  subjectFrameRatio: 0.25,
  // Hard zoom caps. Stay under maxZoom to never feel claustrophobic.
  maxZoom: 1.8,
  minZoom: 1.3,
  // Expand subject bounds by this fraction before computing crop, so even tight
  // framing has visible canvas/grid around the subject.
  paddingRatio: 0.5,

  // --- Pacing ---
  // Base hold duration on a focused beat. Eyes need ~2.5s to fixate + parse.
  baseHoldSec: 2.5,
  // Add this per additional subject in a cluster (more nodes = more to read).
  perSubjectHoldSec: 0.4,
  // Cap so we never dwell forever even on a 10-node cluster.
  maxHoldSec: 6.0,
  // Ease-in / ease-out length.
  easeDuration: 1.0,
  // Camera-leads-action: ease-in finishes this much BEFORE the focus event so
  // the camera is settled when content drops in.
  cameraLeadSec: 0.4,
  // Establishing-shot: hold overview for this long before zooming into a
  // cluster, so the viewer sees the "wide" before the "tight".
  establishingShotSec: 1.8,

  // --- Speed dynamics ---
  // Compress dead-air segments by this factor. 4x feels uncanny (too fast for
  // real, too slow for fast-forward). 25x reads as crisp montage when the
  // dead air is the agent-log "thinking..." stream — viewer watches the log
  // entries scroll by quickly without losing the impression of work.
  deadAirSpeedup: 25,
  // Slight speedup while the user types the prompt — keeps the prompt
  // legible but trims the wait. Pass-2 setpts handles this segment-locally
  // so the camera/inset transitions stay in real time.
  typingSpeedup: 1.6,

  // --- Misc ---
  returnToOverviewGap: 3.0, // pop back to overview if next event is >this far
  minRecordingPad: 0.5,
};

// Backward-compat aliases used inside this file.
const EASE_IN_SEC = DESIGN_RULES.easeDuration;
const EASE_OUT_SEC = DESIGN_RULES.easeDuration;
const RETURN_TO_OVERVIEW_GAP = DESIGN_RULES.returnToOverviewGap;
const MIN_RECORDING_PAD = DESIGN_RULES.minRecordingPad;

async function main() {
  const runDir = process.argv[2] || (await mostRecentRunDir());
  if (!runDir) {
    console.error('No run dir found.');
    process.exit(1);
  }
  console.log('[derive-zoom] runDir:', runDir);

  const events = JSON.parse(await readFile(join(runDir, 'events.json'), 'utf8'));
  if (!events.recording) {
    throw new Error('events.json has no recording metadata — was this run captured with recording on?');
  }
  if (!events.anchors) {
    throw new Error('events.json has no anchors — re-record with the v3 driver.');
  }

  const { dateNowAtInstall } = events.anchors;
  const { firstFrameTs, frameCount, fps } = events.recording;
  const recordingDuration = await probeDuration(events.recording.path);
  console.log(`[derive-zoom] recording duration: ${recordingDuration.toFixed(2)}s, ${frameCount} frames`);

  const vw = events.viewport.width;
  const vh = events.viewport.height;

  // Compute the safe zone — the rectangle inside the viewport that is NOT
  // covered by any floating panel. Zoomed crop windows must fit inside this
  // rect so panels never bleed into focused shots.
  const safe = computeSafeZone(events.panels || {}, vw, vh);
  console.log(`[derive-zoom] safe zone: x=${safe.x.toFixed(0)} y=${safe.y.toFixed(0)} w=${safe.w.toFixed(0)} h=${safe.h.toFixed(0)} (panels: ${Object.keys(events.panels || {}).join(', ') || 'none'})`);

  // Map each captured node event onto the recording timeline. Drop any whose
  // recording-time is before zero (observer ts may be slightly older than
  // first-frame ts due to install ordering) or after the recording ended.
  const nodeMoments = events.events
    .map((ev) => ({
      ...ev,
      tRec: (dateNowAtInstall + ev.ts) / 1000 - firstFrameTs,
    }))
    .filter((m) => m.tRec >= 0 && m.tRec <= recordingDuration)
    .sort((a, b) => a.tRec - b.tRec);

  // Coalesce events that landed in the same render tick (within 0.1s) to a
  // single focus moment — Daedalus' graph_apply often batch-renders multiple
  // nodes simultaneously, and zooming through them sequentially looks frantic.
  const moments = [];
  for (const m of nodeMoments) {
    const last = moments[moments.length - 1];
    if (last && m.tRec - last.tRec < 0.1) {
      // merge bounds (use the union — focuses on the cluster)
      const left = Math.min(last.boundsUnion.x, m.bounds.x);
      const top = Math.min(last.boundsUnion.y, m.bounds.y);
      const right = Math.max(last.boundsUnion.x + last.boundsUnion.width, m.bounds.x + m.bounds.width);
      const bottom = Math.max(last.boundsUnion.y + last.boundsUnion.height, m.bounds.y + m.bounds.height);
      last.boundsUnion = { x: left, y: top, width: right - left, height: bottom - top };
      last.labels.push(m.nodeLabel);
      last.nodeIds.push(m.nodeId);
    } else {
      moments.push({
        tRec: m.tRec,
        boundsUnion: { ...m.bounds },
        // Each moment also tracks the running union of EVERY node seen up to
        // this point. Used below to expand cluster N>0 framing so the camera
        // shows the new node alongside its predecessors — this is the "show
        // it connect" moment when the second node lands and Daedalus wires
        // an edge into a prior node.
        connectedUnion: null,
        labels: [m.nodeLabel],
        nodeIds: [m.nodeId],
      });
    }
  }
  console.log(`[derive-zoom] ${nodeMoments.length} node events → ${moments.length} focus moments`);

  // Build directives. The timeline is a sequence of segments; gaps default to
  // overview. Each focus moment expands into ease-in → hold → ease-out around
  // its tRec. Overlapping focus segments cross-fade by chaining endpoints.
  const overview = { cx: 0.5, cy: 0.5, scale: 1.0 };
  const directives = [];

  function pushSegment(seg) {
    if (seg.endSec - seg.startSec < 0.05) return; // drop ultra-short
    directives.push(seg);
  }

  let cursor = 0;
  // Set true when the intro section has already eased the camera onto the
  // first cluster's focus (e.g., agentlog → cluster-1 direct path). Tells
  // the moments loop to skip establishing-shot + ease-in for moments[0]
  // and pick up at the hold beat.
  let firstClusterEasedInIntro = false;

  // Intro phase: bloom hold + chatbox-focus during typing. Only emit if the
  // driver captured phases AND a chatbox focus target. Bloom plays full-frame
  // (no zoom), then ease-in to chatbox at bloom-end, hold through send, ease
  // back to overview.
  const phases = events.phases || {};
  const chatbox = events.focusTargets?.chatbox;
  if (phases.agentSwitch && phases.bloomEnd && phases.send && chatbox) {
    const switchT = phases.agentSwitch / 1000 - firstFrameTs;
    const bloomEndT = phases.bloomEnd / 1000 - firstFrameTs;
    const sendT = phases.send / 1000 - firstFrameTs;

    // noClamp: true → return the chatbox's actual center as cx/cy, even when
    // the resulting crop window would extend past the source viewport edge.
    // apply-zoom compensates by sliding the recording inset within the
    // composed canvas during chatbox-focus segments, which lets the chatbox
    // sit at composed-x=0.5 instead of being slammed against the right edge.
    const chatFocus = boundsToFocus(chatbox, vw, vh, safe, { bypassSafeZone: true, noClamp: true });

    // Bloom-focus target — centered on the Daedalus portrait + sigil that
    // animate inside the chat panel header on agent switch. Hardcoded
    // because the bloom is rendered by Hermes CSS and doesn't have a
    // queryable bounds element; numbers below land roughly on the portrait
    // glow at viewport=1920x1080. The kind tag includes "bloom-chatbox"
    // so apply-zoom's OFFSET_KIND_RE matches and the recording shifts to
    // center the bloom in the output frame instead of pinning it right.
    const bloomFocus = { cx: 0.870, cy: 0.370, scale: 1.45 };

    // Pre-switch overview: just the few hundred ms before the camera
    // starts easing toward the bloom. The cursor begins moving at
    // recording-t ≈ 0.4 (driver sleep(400) before moveTo); this overview
    // segment covers the brief settle-at-center moment.
    const easeToBloomDuration = 1.5;
    const easeToBloomStart = Math.max(0, switchT - easeToBloomDuration);
    if (easeToBloomStart > 0.05) {
      pushSegment({
        startSec: 0,
        endSec: easeToBloomStart,
        focusStart: overview,
        focusEnd: overview,
        ease: 'linear',
        kind: 'overview',
        labels: ['pre-switch'],
      });
    }

    // Camera follows the cursor's trajectory toward the Daedalus button —
    // overview → bloom focus. Lands at bloomFocus right when the click
    // fires, so the bloom animation plays out already framed and zoomed.
    pushSegment({
      startSec: easeToBloomStart,
      endSec: switchT,
      focusStart: overview,
      focusEnd: bloomFocus,
      ease: 'easeInOutCubic',
      kind: 'ease-cursor-to-bloom-chatbox',
      labels: ['bloom'],
    });

    // Hold on the bloom through the animation. The bloom CSS sequence
    // runs ~2.8s; this segment fills it with a steady close-up.
    pushSegment({
      startSec: switchT,
      endSec: bloomEndT,
      focusStart: bloomFocus,
      focusEnd: bloomFocus,
      ease: 'linear',
      kind: 'bloom-hold-chatbox',
      labels: ['bloom'],
    });

    // Ease in to chatbox during the settle pause (driver waits 800ms after
    // bloom-end before typing — perfect window for a 1s ease-in).
    const easeInEnd = Math.min(bloomEndT + EASE_IN_SEC, sendT - 0.1);
    pushSegment({
      startSec: bloomEndT,
      endSec: easeInEnd,
      focusStart: bloomFocus,
      focusEnd: chatFocus,
      ease: 'easeOutCubic',
      kind: 'ease-bloom-to-chatbox',
      labels: ['chatbox'],
    });

    // Hold on chatbox through typing + send + read pause at NORMAL speed.
    const readEnd = sendT + 0.6;
    pushSegment({
      startSec: easeInEnd,
      endSec: readEnd,
      focusStart: chatFocus,
      focusEnd: chatFocus,
      ease: 'linear',
      kind: 'chatbox-hold-typing',
      labels: ['typing'],
      speedFactor: DESIGN_RULES.typingSpeedup,
    });

    // If we have an agentLog focus target, swing the camera over to it for
    // the thinking phase — Daedalus's reasoning streams there, and a static
    // chatbox shot reads as dead air. Without an agentLog target, fall back
    // to holding on the chatbox (legacy behavior).
    const agentLog = events.focusTargets?.agentLog;
    const agentLogFocus = agentLog
      ? boundsToFocus(agentLog, vw, vh, safe, { bypassSafeZone: true, noClamp: true })
      : null;
    const thinkFocus = agentLogFocus || chatFocus;
    const thinkKindHold = agentLogFocus ? 'agentlog-hold-thinking' : 'chatbox-hold-thinking';
    const thinkKindEaseIn = agentLogFocus ? 'ease-chatbox-to-agentlog' : null;
    const thinkKindEaseOut = agentLogFocus ? 'ease-out-agentlog' : 'ease-out-chatbox';

    // When both agentlog focus AND a first node-cluster exist, ease the
    // camera DIRECTLY from agentlog to cluster-1 instead of bouncing through
    // overview. The driver collapses the agent log on first-node detection,
    // and the collapse animation runs ~200ms; pulling the camera back to
    // overview before that finishes catches the agent log mid-fade. Direct
    // ease also avoids a flat establishing-shot on top of the agent log
    // remnant. Without agentlog or without a first cluster, fall back to the
    // legacy ease-out → overview path.
    const firstNodeTRec = moments[0]?.tRec ?? recordingDuration - EASE_OUT_SEC;
    const useDirectEaseToCluster = !!(agentLogFocus && moments[0]);
    const introTailPad = useDirectEaseToCluster
      ? DESIGN_RULES.cameraLeadSec + DESIGN_RULES.easeDuration
      : DESIGN_RULES.cameraLeadSec + 2 * DESIGN_RULES.easeDuration + DESIGN_RULES.establishingShotSec;
    const thinkEnd = Math.max(readEnd, firstNodeTRec - introTailPad);

    // Optional ease from chatbox to agent log right after typing ends. The
    // typing segment already settled at chatFocus; this rides that into the
    // agentlog target before the thinking speedup kicks in.
    let holdStart = readEnd;
    if (agentLogFocus) {
      const handoffEnd = Math.min(readEnd + EASE_IN_SEC, thinkEnd - 0.1);
      if (handoffEnd > readEnd + 0.05) {
        pushSegment({
          startSec: readEnd,
          endSec: handoffEnd,
          focusStart: chatFocus,
          focusEnd: agentLogFocus,
          ease: 'easeInOutCubic',
          kind: thinkKindEaseIn,
          labels: ['chatbox', 'agentlog'],
          speedFactor: 1,
        });
        holdStart = handoffEnd;
      }
    }

    // Hold on the thinking target, sped up so the dead air compresses.
    if (thinkEnd > holdStart + 0.5) {
      pushSegment({
        startSec: holdStart,
        endSec: thinkEnd,
        focusStart: thinkFocus,
        focusEnd: thinkFocus,
        ease: 'linear',
        kind: thinkKindHold,
        labels: ['thinking'],
        speedFactor: DESIGN_RULES.deadAirSpeedup,
      });
    }

    let easeOutEnd;
    if (useDirectEaseToCluster) {
      // Direct ease from agentlog to cluster-1's focus. Lands cameraLead
      // seconds before firstNodeTRec, so when the node renders the camera
      // is already on its mark. Sets a flag so the moments loop skips
      // establishing-shot and ease-in for cluster-1 (we just emitted it).
      // In demo flow (phases.send set), use overview framing for clusters
      // — same override as the moments loop. Without this, the ease lands
      // on the boundsToFocus result (often zoom 1.7 due to safe-zone clamp)
      // and immediately snaps back to overview at the hold beat. Forcing
      // overview here keeps the ease + hold camera scale consistent.
      const cluster0FrameBounds = moments[0].connectedUnion ?? moments[0].boundsUnion;
      const cluster0Focus = phases.send
        ? overview
        : boundsToFocus(cluster0FrameBounds, vw, vh, safe);
      easeOutEnd = firstNodeTRec - DESIGN_RULES.cameraLeadSec;
      pushSegment({
        startSec: thinkEnd,
        endSec: easeOutEnd,
        focusStart: thinkFocus,
        focusEnd: cluster0Focus,
        ease: 'easeInOutCubic',
        kind: 'ease-agentlog-to-cluster',
        labels: ['agentlog', 'cluster'],
        speedFactor: 1,
      });
      firstClusterEasedInIntro = true;
    } else {
      // Legacy path: ease out to overview; node-loop picks up with an
      // establishing shot before zooming on the first cluster.
      easeOutEnd = Math.min(thinkEnd + EASE_OUT_SEC, recordingDuration);
      pushSegment({
        startSec: thinkEnd,
        endSec: easeOutEnd,
        focusStart: thinkFocus,
        focusEnd: overview,
        ease: 'easeInCubic',
        kind: thinkKindEaseOut,
        labels: agentLogFocus ? ['agentlog'] : ['chatbox'],
        speedFactor: 1,
      });
    }

    cursor = easeOutEnd;
    console.log(`[derive-zoom] intro: bloom→${bloomEndT.toFixed(1)}s, chatbox→${easeInEnd.toFixed(1)}s, send@${sendT.toFixed(1)}s, think→${thinkEnd.toFixed(1)}s (${DESIGN_RULES.deadAirSpeedup}x), intro-end ${easeOutEnd.toFixed(1)}s${agentLogFocus ? ' [via agentlog]' : ''}${useDirectEaseToCluster ? ' [direct→cluster]' : ''}`);
  }

  // Build a running union of bounds across moments. For the first moment
  // (e.g., Text Input alone), connectedUnion equals boundsUnion. For each
  // subsequent moment (e.g., GPT Image 2), connectedUnion expands to include
  // every prior moment's nodes — so the "second node lands" beat frames the
  // whole graph instead of just the new node, putting the connecting edge
  // visibly in shot.
  {
    let running = null;
    for (const m of moments) {
      if (!running) {
        running = { ...m.boundsUnion };
      } else {
        const left = Math.min(running.x, m.boundsUnion.x);
        const top = Math.min(running.y, m.boundsUnion.y);
        const right = Math.max(running.x + running.width, m.boundsUnion.x + m.boundsUnion.width);
        const bottom = Math.max(running.y + running.height, m.boundsUnion.y + m.boundsUnion.height);
        running = { x: left, y: top, width: right - left, height: bottom - top };
      }
      m.connectedUnion = { ...running };
    }
  }

  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const next = moments[i + 1];

    // Frame bounds: solo node for the first moment (so the choreographed
    // pull-back beat shows it alone), running connected-union from moment 2
    // onward (so the connection between the new node and prior nodes is in
    // shot — the "show it connect" beat).
    const frameBounds = i === 0 ? m.boundsUnion : m.connectedUnion;
    // In the demo flow (phases.send is set), the driver places nodes at
    // deliberate canvas positions (center-left for Text Input, center-right
    // for GPT Image 2). Forcing overview framing for every cluster keeps
    // both nodes in shot at consistent scale instead of zooming tight on
    // cluster-1's solo Text Input and then snapping back wide for cluster-2.
    const useOverview = !!phases.send;
    const focus = useOverview ? overview : boundsToFocus(frameBounds, vw, vh, safe);

    // Camera-leads-action: ease-in finishes cameraLeadSec BEFORE the event so
    // the camera is settled when content drops in.
    const easeInEnd = m.tRec - DESIGN_RULES.cameraLeadSec;
    const easeInStart = easeInEnd - DESIGN_RULES.easeDuration;

    // Reading-time-aware hold: more subjects → more to read → longer hold.
    const subjectCount = Math.max(1, m.labels.length);
    const holdSec = clamp(
      DESIGN_RULES.baseHoldSec + DESIGN_RULES.perSubjectHoldSec * (subjectCount - 1),
      DESIGN_RULES.baseHoldSec,
      DESIGN_RULES.maxHoldSec,
    );
    const holdEnd = Math.min(
      easeInEnd + holdSec,
      next
        ? next.tRec - DESIGN_RULES.cameraLeadSec - DESIGN_RULES.easeDuration
        : recordingDuration - DESIGN_RULES.easeDuration,
    );
    const easeOutEnd = Math.min(holdEnd + DESIGN_RULES.easeDuration, recordingDuration);

    // Establishing shot: hold overview before zooming on cluster, so the
    // viewer sees the wide layout before the tight close-up. Only insert if
    // we have time AND the camera is currently in overview (not panning from
    // a prior focus). Also skipped for cluster-0 when the intro already
    // eased directly onto its focus (agentlog→cluster path).
    const skipEaseInForFirstCluster = i === 0 && firstClusterEasedInIntro;
    const wantsEstablishing = cursor < easeInStart - 0.1 && !skipEaseInForFirstCluster;
    if (wantsEstablishing) {
      const establishStart = Math.max(cursor, easeInStart - DESIGN_RULES.establishingShotSec);
      // Overview hold from cursor up to establishing start (if any room).
      if (establishStart > cursor + 0.05) {
        pushSegment({
          startSec: cursor,
          endSec: establishStart,
          focusStart: overview,
          focusEnd: overview,
          ease: 'linear',
          kind: 'overview',
          labels: ['overview'],
          speedFactor: 1,
        });
      }
      // The establishing beat itself — same overview focus, but tagged so
      // future iterations could add a slow Ken-Burns drift if we want.
      pushSegment({
        startSec: establishStart,
        endSec: easeInStart,
        focusStart: overview,
        focusEnd: overview,
        ease: 'linear',
        kind: 'establishing',
        labels: ['establishing-shot'],
        speedFactor: 1,
      });
    }

    // Ease in (lands cameraLead before the event). Skipped for cluster-0
    // when the intro already eased onto this cluster's focus directly from
    // agentlog — the camera is already on its mark, just hold from here.
    if (!skipEaseInForFirstCluster) {
      pushSegment({
        startSec: easeInStart,
        endSec: easeInEnd,
        focusStart: overview,
        focusEnd: focus,
        ease: 'easeOutCubic',
        kind: 'ease-in',
        labels: m.labels,
        speedFactor: 1,
      });
    }

    // Hold (reading-time-scaled).
    pushSegment({
      startSec: easeInEnd,
      endSec: holdEnd,
      focusStart: focus,
      focusEnd: focus,
      ease: 'linear',
      kind: 'hold',
      labels: m.labels,
      speedFactor: 1,
    });

    // If the next moment is close, ease directly to its focus instead of
    // bouncing back to overview.
    const gapToNext = next ? next.tRec - holdEnd : Infinity;
    if (next && gapToNext < RETURN_TO_OVERVIEW_GAP) {
      // Use connected-union for the next moment too — keeps the
      // "show the connection" framing consistent when chaining moments
      // close in time.
      const nextFrame = next.connectedUnion ?? next.boundsUnion;
      const nextFocus = boundsToFocus(nextFrame, vw, vh, safe);
      pushSegment({
        startSec: holdEnd,
        endSec: next.tRec - DESIGN_RULES.cameraLeadSec,
        focusStart: focus,
        focusEnd: nextFocus,
        ease: 'easeInOutCubic',
        kind: 'pan',
        labels: [`${m.labels.join('+')} → ${next.labels.join('+')}`],
        speedFactor: 1,
      });
      cursor = next.tRec - DESIGN_RULES.cameraLeadSec;
      continue;
    } else {
      pushSegment({
        startSec: holdEnd,
        endSec: easeOutEnd,
        focusStart: focus,
        focusEnd: overview,
        ease: 'easeInCubic',
        kind: 'ease-out',
        labels: m.labels,
        speedFactor: 1,
      });
      cursor = easeOutEnd;
    }
  }

  // Tail: hold overview to recording end.
  if (cursor < recordingDuration - 0.05) {
    pushSegment({
      startSec: cursor,
      endSec: recordingDuration,
      focusStart: overview,
      focusEnd: overview,
      ease: 'linear',
      kind: 'overview',
      labels: ['overview'],
    });
  }

  // Always start from overview pad if first directive has a gap at zero.
  if (directives.length === 0 || directives[0].startSec > MIN_RECORDING_PAD) {
    directives.unshift({
      startSec: 0,
      endSec: directives[0]?.startSec ?? recordingDuration,
      focusStart: overview,
      focusEnd: overview,
      ease: 'linear',
      kind: 'overview',
      labels: ['overview'],
    });
  }

  const out = {
    runId: events.runId,
    recordingPath: events.recording.path,
    duration: recordingDuration,
    viewport: events.viewport,
    momentCount: moments.length,
    directives,
  };

  const outPath = join(runDir, 'zoom-directives.json');
  await writeFile(outPath, JSON.stringify(out, null, 2));
  console.log(`[derive-zoom] wrote ${directives.length} directives → ${outPath}`);
}

function boundsToFocus(b, vw, vh, safe, opts = {}) {
  // Apply breathing-room padding: expand bounds by paddingRatio on each side
  // BEFORE computing scale, so the resulting crop has visible canvas around
  // the subject instead of cropping right to the edges.
  const pad = opts.paddingRatio ?? DESIGN_RULES.paddingRatio;
  const padded = {
    x: b.x - b.width * pad,
    y: b.y - b.height * pad,
    width: b.width * (1 + 2 * pad),
    height: b.height * (1 + 2 * pad),
  };

  // Active safe zone — full viewport when bypassSafeZone (e.g. focusing on
  // the chat panel itself), otherwise the panel-trimmed rect.
  const sz = opts.bypassSafeZone
    ? { x: 0, y: 0, w: vw, h: vh }
    : safe;

  // SUBJECT-ALREADY-LARGE GUARD: if the subject already spans >40% of either
  // safe-zone dimension, fitView has framed it prominently and any further
  // zoom would feel claustrophobic. Bail out to full overview (scale=1) —
  // viewer sees the whole UI in context with the cluster as the natural
  // focal point. This prevents the "way too close to nodes" issue when
  // small clusters get expanded large by panel-aware fitView.
  if (!opts.bypassSafeZone) {
    const widthRatio = b.width / sz.w;
    const heightRatio = b.height / sz.h;
    if (widthRatio > 0.4 || heightRatio > 0.4) {
      return { cx: 0.5, cy: 0.5, scale: 1.0 };
    }
  }

  // Pick a zoom level that makes the padded subject take subjectFrameRatio of
  // viewport width — lower ratio = more breathing room.
  const targetWidthFraction = opts.targetWidthFraction ?? DESIGN_RULES.subjectFrameRatio;
  const desiredScale = vw / (padded.width / targetWidthFraction);
  let scale = clamp(desiredScale, DESIGN_RULES.minZoom, DESIGN_RULES.maxZoom);

  // Crop window dimensions at this scale.
  let cropW = vw / scale;
  let cropH = vh / scale;

  // If the crop is too large to fit inside the safe zone, increase scale
  // until it fits.
  if (cropW > sz.w) {
    scale = vw / sz.w;
    cropW = vw / scale;
    cropH = vh / scale;
  }
  if (cropH > sz.h) {
    scale = vh / sz.h;
    cropW = vw / scale;
    cropH = vh / scale;
  }

  // Center the crop on the target, then clamp the crop window to the safe
  // zone. If the target sits near a panel, the crop shifts away from the
  // panel — target ends up off-center but the OUTPUT frame is panel-free.
  const targetCenterX = b.x + b.width / 2;
  const targetCenterY = b.y + b.height / 2;
  let cropX = targetCenterX - cropW / 2;
  let cropY = targetCenterY - cropH / 2;
  if (!opts.noClamp) {
    cropX = clamp(cropX, sz.x, sz.x + sz.w - cropW);
    cropY = clamp(cropY, sz.y, sz.y + sz.h - cropH);
  }

  // Recompute normalized cx/cy from the clamped crop center.
  const cx = (cropX + cropW / 2) / vw;
  const cy = (cropY + cropH / 2) / vh;
  return { cx, cy, scale };
}

// Compute the largest axis-aligned rectangle inside the viewport that doesn't
// overlap any panel. We pick the rect by inspecting each panel and inferring
// which edge it sits on (top/bottom/left/right), then trim that edge.
function computeSafeZone(panels, vw, vh) {
  let left = 0, right = vw, top = 0, bottom = vh;
  for (const p of Object.values(panels)) {
    if (!p || p.width === 0 || p.height === 0) continue;
    const pLeft = p.x;
    const pRight = p.x + p.width;
    const pTop = p.y;
    const pBottom = p.y + p.height;
    const pCx = pLeft + p.width / 2;
    const pCy = pTop + p.height / 2;
    // Decide which edge the panel hugs by comparing distances to viewport
    // edges. Whichever distance is smallest determines the edge.
    const dLeft = pLeft;
    const dRight = vw - pRight;
    const dTop = pTop;
    const dBottom = vh - pBottom;
    const minD = Math.min(dLeft, dRight, dTop, dBottom);
    if (minD === dLeft) left = Math.max(left, pRight);
    else if (minD === dRight) right = Math.min(right, pLeft);
    else if (minD === dTop) top = Math.max(top, pBottom);
    else if (minD === dBottom) bottom = Math.min(bottom, pTop);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function probeDuration(mp4Path) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      mp4Path,
    ]);
    let out = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      const sec = parseFloat(out.trim());
      if (!isFinite(sec)) return reject(new Error(`bad duration: ${out}`));
      resolve(sec);
    });
  });
}

async function mostRecentRunDir() {
  try {
    const entries = await readdir(RUNS_DIR);
    // Skip *-profile dirs (Chromium user-data-dirs colocated with run dirs).
    const sorted = entries
      .filter((e) => /^\d{4}-/.test(e) && !e.endsWith('-profile'))
      .sort();
    return sorted.length ? join(RUNS_DIR, sorted[sorted.length - 1]) : null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
