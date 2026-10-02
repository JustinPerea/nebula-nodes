# Demo implementation notes

- Used a separate video project and local dependencies; existing product and
  acceptance graph/history are outside this composition's write scope.
- Real browser captures are 1280 × 720. A crop from roughly (400, 245) to
  (1024, 705), rendered at 1.65×, makes the source controls and connected result
  readable beside large editorial copy. History uses an actual-pixel 1.9× crop
  that shows the retained records and cyan source. Native Paper crops exclude
  the unrelated top tabs and retain the original logo context.
- Orange focus frames point to controls measured by the parent in the actual
  DOM. They are editorial emphasis, not recreated controls or fabricated UI.
- Source refresh and saved-recipe rerun are separate beats, with the stale
  result held long enough to read. Every downstream proof scene labels the
  deterministic fixture, avoiding a claim of live paid generation.
- Open in Paper is shown as an edited source-control/destination sequence. The
  user has confirmed actual desktop launch; the composition does not fabricate
  a continuous recording or bypass blocked browser protocol actions.
- One registered paused GSAP timeline owns all motion. Timed clips are left to
  HyperFrames; only inner wrappers receive opacity/transform animation. State
  captures cut at explicit times. Local GSAP/fonts mean no render-time network.
- Raw screenshot bytes are JPEG, even though the capture helper originally
  used PNG names; the parent retained the bytes and corrected extensions. The
  composition initially used these originals; the native publication plates
  were later cropped to lossless PNGs as recorded below.
- First-pass lint passes with zero errors. Reviewed warnings concern repeated
  static logo/canvas image sources in separate timed scenes and the eight-clip
  single-track layout. No package upgrades. The parent session owns final full
  runtime/layout check, render, visual QC and capture provenance.

- Final review closed the temporary guest Paper browser viewer and recaptured
  the same native pink/cyan artwork states so its remote collaborator cursor
  does not obscure the logo. Restored the original pink once more; no source
  refresh or recipe run was added by this capture cleanup.
- Full check passes at 13 selected times: zero runtime/layout/contrast errors,
  all 38 sampled text contrasts pass. Static repeated-image and single-track
  density warnings were reviewed; every scene is present in inspected frames.
- The initial four-worker render hit its temporary-disk guard before capture.
  Switched to the supported single-worker low-memory streaming profile, keeping
  the 1080p/30fps delivery quality and all source assets. No user files were
  removed to make room. The first-attempt log is preserved separately.
- Delivery render succeeds: 40.000 seconds, 1,200 frames, 1920×1080 / 30fps,
  H.264 / yuv420p, 5,993,316 bytes. Full FFmpeg decode reports no errors. The
  actual encoded movie's nine-shot contact sheet was inspected, including
  control focus, native destination, color edit, stale pause and both histories.
  Capture used hardware GPU screenshots with streaming encode in 39.3 seconds.

- Public GitHub preparation removes the unrelated native Paper tab strip from
  the distributed source plates: FFmpeg crop `(0, 80, 2814, 1694)` from the real
  2814 × 1774 JPEG captures, encoded as lossless PNG. JPEG originals remain
  local and are ignored by this project's `.gitignore`; graph plates and all
  other source assets are unchanged. The asset ledger retains source SHA-256,
  original capture time, crop dimensions and derived PNG hashes.
- Updated only native image paths and their camera offsets: Paper detail
  height 870.8726 px / top -102.8726 px; wide object position 42.03%. These
  compensate for the removed top strip and preserve the logo/context framing.
  The publication crop passed the same full check and was re-rendered.
  Its final encoded movie passed metadata, full decode and contact-sheet review.
