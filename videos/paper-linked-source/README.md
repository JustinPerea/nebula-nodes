# Paper-linked source demo

A 40-second silent, captioned feature demo at 1920×1080 / 30 fps.

The edit uses actual Nebula and Paper desktop captures. It shows the editable
original, source refresh, the earlier output becoming out of date, an explicit
saved-recipe rerun, and both retained history records. Downstream generation
uses the visibly labeled deterministic local fixture. The desktop transition
is an edited sequence; the user confirmed the real desktop link works.

- Movie: `renders/paper-linked-source-demo.mp4` (included delivery render).
- Editable composition: `index.html`; shot plan: `STORYBOARD.md`.
- Capture origins and hashes: `evidence/asset-ledger.json`.
- Real-loop receipts: `evidence/loop-verification.json`.
- Runtime/layout/contrast gate: `evidence/hyperframes-check.json`.
- Encoded movie inspection: `evidence/movie-contact-sheet.jpg`.
- Encoding metadata: `evidence/ffprobe.json`; full decode: `evidence/decode.log`.

The CLI is pinned to HyperFrames 0.8.41. No package was installed or upgraded.
For a render without temporary frame storage, use the supported streaming profile:

```sh
npm run check
npm run render -- --quality delivery --fps 30 --workers 1 --low-memory-mode --no-best-effort --output renders/paper-linked-source-demo.mp4
```

Use the existing local browser through `HYPERFRAMES_BROWSER_PATH` when needed.
The live-loop verification script reads the separately retained
`output/paper-demo` fixture artifacts; it does not mutate the application.

Final delivery: 40.000 seconds, 1,200 frames, H.264 / yuv420p. The complete
movie decodes without errors. The original editable Paper artwork was restored
after capture; the original acceptance graph/history was left intact.
