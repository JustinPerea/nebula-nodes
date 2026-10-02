# Paper-linked source verification

Implemented in the managed `paper-linked-source` worktree, branch
`codex/paper-linked-source`, independently of the parent and brand-lab workspaces.
No new packages, copied provider credentials, paid execution, watcher, merge or
deployment are part of this change.

## Current Paper interface

Paper's [official MCP documentation](https://paper.design/docs/mcp) now documents
the installed `paper mcp` CLI over stdio. The adapter uses that existing CLI and
the repository's existing MCP SDK. The actual installed tool listing and seven
relevant schemas are saved in [installed-tools.json](evidence/paper-source/installed-tools.json).
It exposes explicit file/page/node reads, PNG export and `open_file`.

`open_file` supports file navigation. Its schema explicitly leaves the current
page unchanged when the file is already open; the browser/native check also
showed that the existing file tab may need choosing manually. The UI says to
choose the file tab, page and object. No supported object-selection or watcher
tool was observed. Paper's returned `contentHash.tokens` is a token hash, not an
artwork revision. Snapshots describe observed exported bytes, without an
invented Paper revision.

PNG export preserves artwork transparency; the tool has no background-removal
override. Settings record `background: artwork`, and the exported PNG is checked
for actual alpha and transparent pixels. The real nested logo was transparent;
its containing artboard exported with an opaque background.

## Contract and acceptance evidence

Editable Paper objects remain in Paper. Nebula stores a logical source identity,
content-addressed immutable PNGs, SHA-256 hashes, capture times, names, bounds,
pixel dimensions and settings under its configured output root. SQLite sequences
prevent old responses or errors replacing newer state. Refresh has no execution
call or provider credential dependency.

| Check | Evidence |
| --- | --- |
| Export actual A and connect downstream | [A canvas](evidence/paper-source/01-source-a.jpg), [original PNG](evidence/paper-source/source-a.png) |
| Edit Paper, explicit Refresh to B, retain stale A video and edge | [B with stale A](evidence/paper-source/02-source-b-stale-a.jpg), [B PNG](evidence/paper-source/source-b.png), [live checks](evidence/paper-source/live-checks.json) |
| Explicitly rerun saved recipe with latest artwork | Browser history retains original A and B, plus final exact-A and latest-source replays: [final history](evidence/paper-source/06-final-history.jpg), [checks/recipes](evidence/paper-source/final-replay-check.json) |
| Inspect immutable earlier input and output | [Pinned A history](evidence/paper-source/03-history-a-pinned.jpg); per-run input hashes, settings, capture times and saved media are inspectable |
| Source edit during a run | A 25-second fixture run admitted B; Paper refreshed to C while it was running; completion kept C current and B stale: [canvas](evidence/paper-source/04-inflight-c-stale-b.jpg), [receipt](evidence/paper-source/inflight-b-receipt.json), [video](evidence/paper-source/inflight-b-video.mp4), [checks](evidence/paper-source/inflight-check.json) |
| Unchanged refresh, selection change and rename | Real unchanged export retained its snapshot; selecting the containing artboard did not retarget the nested logo; rename updated the readable name without changed artwork |
| Unavailable transport / failed refresh | [Unavailable check](evidence/paper-source/unavailable-check.json): isolated runtime deliberately configured with a nonexistent CLI, retaining last good artwork, time, edge and history; the user's Paper app was kept open |
| Deleted object and explicit reconnect | [Missing-state screenshot](evidence/paper-source/05-deleted-last-good.jpg), [deletion check](evidence/paper-source/deletion-check.json), [reconnect check](evidence/paper-source/reconnect-check.json): same logical source, edge and history; 2× export is 480 × 360 with alpha |
| Late export/error, tampering, malformed pins | Portable tests cover superseded responses, failed reconnect retaining old identity, unchanged hashes, post-export deletion, mismatched pages, cycles, damaged bytes and missing hashes |

Each admitted Paper run writes `paper-inputs.json` before dispatch: exact input
descriptors and a SHA-256 revision of saved nodes, settings and connections.
Frontend history stores its own saved request, input descriptors and output refs.
Freshness compares canonical recipe data as well as source identity/settings/hash;
the display revision is not represented as a Paper revision. Derived video probe
metadata is excluded from recipe freshness. Historical replay sends
`preserveGraphParams`, so saved settings execute while live edits remain intact.
Original source bytes are verified on every execution rather than bypassed by
the generic output cache.

Live acceptance found and fixed two history/recipe problems and an actual Paper
tombstone behavior: a deleted object retained its old ID/name/size and exported
a blank PNG. Exact live page membership now rejects that response. The disposable
fixture retains the earlier blank capture as investigation history rather than
erasing evidence. Existing test captures also retain their earlier transparency
intent metadata; new captures record the actual artwork-background contract.

## Media delivery and proof limits

The browser demonstration uses a visibly labeled **deterministic fixture**. It
reads the exact immutable PNG, composites it over white without redrawing the
logo, then encodes a two-second 30-fps H.264 video. It proves delivery, input
pinning, recipe replay and histories. It does not prove live generative-provider
execution or identical generative motion.

Handler tests verify the actual PNG bytes reach existing OpenAI multipart and
Runway data-URI preparation using intercepted requests. Providers receive bytes
through their existing delivery paths, not a localhost preview URL or local
filesystem path. No paid request was sent.

Source data is local: retain the output-root database and PNGs together when
moving it. No cross-machine/cloud synchronization or authoritative continuous
edit signal is claimed. Exports are observed snapshots; membership/structure
changes during export are rejected, but Paper supplies no artwork revision that
would prove an atomic view of all concurrent style edits.

## Reproduce locally

From this worktree, use an existing Python environment satisfying the pinned
backend requirements and a working Paper Desktop installation:

```sh
/path/to/existing/python scripts/start_paper_acceptance.py --port 8019
```

Then in `frontend`:

```sh
VITE_NEBULA_API_BASE=http://127.0.0.1:8019 npm run dev -- --host 127.0.0.1 --port 5189 --strictPort
```

The script confines all state, output, settings, presets and Commons paths to
`output/paper-acceptance`; it substitutes the deterministic video handler only
in that process and starts with empty API keys. Production handlers/catalogs
retain their ordinary provider behavior. Link a selected object, or inspect
explicit file/page/object identity, then export. Refresh and run are separate
actions.

## Final gates

- Full backend: **2,542 passed**, exit 0; twelve inherited FastAPI startup
  deprecation warnings. Includes 105 Paper checks across lifecycle, mounted
  routes, transport, handler/cache and replay.
- Full frontend: **929 passed** in 97 files. TypeScript, production build and
  initial bundle budget pass; inherited deferred large-chunk warning remains.
- Node contracts: **180 definitions passed**. Model reference regenerated from
  the catalog. Changed-file ESLint, CSS scope/inline guards and diff whitespace
  checks pass. No packages installed or upgraded.
- Three saved MP4 artifacts pass ffprobe and full FFmpeg decode, each two
  seconds / 60 frames / 30 fps: [media checks](evidence/paper-source/media-checks.json).
- Final browser replay used exact A, then explicitly reused that saved recipe
  with the current 2× source. Downstream params and connections in both backend
  receipts are equal. The current source stayed current; seven source snapshots,
  the edge, original A/B records and both new runs survived browser reload.
  The latest result is current and earlier results have their stale reason.

Final receipts and videos: [A receipt](evidence/paper-source/final-replay-a-receipt.json),
[A video](evidence/paper-source/final-replay-a-video.mp4),
[latest receipt](evidence/paper-source/final-latest-source-receipt.json),
[latest video](evidence/paper-source/final-latest-source-video.mp4).
